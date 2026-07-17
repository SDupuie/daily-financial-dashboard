#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const {
  acceptedFreshChartTickers,
  buildChartDataFallback,
  buildUnavailableFuturesPayload,
  compactChartPayload,
  deriveQuoteRowsFromSeries,
  readChartableRows,
  roundChartPayload,
  validateChartStagingPayload,
  validateFuturesPayload
} = require('./fetch_chart_data');
const { buildCryptoStatsFallback, validateCryptoStatsPayload } = require('./fetch_crypto_stats');
const {
  buildAssetAllocationFallback,
  buildAssetAllocationSummaryFallback,
  validateAssetAllocationPortfolioPayload,
  validateAssetAllocationSummaryPayload
} = require('./fetch_asset_allocation');
const {
  buildEarningsPreparationFallback,
  combinedOutcome,
  computeEarningsWeekCounts,
  mergeUnchangedEarningsNarrative,
  earningsRowKey: earningsNarrativeRowKey
} = require('./earnings_week_contract');
const {
  applyEarningsNarrative,
  earningsCalendarFailedAttemptNeedsRetry,
  earningsCalendarNeedsBuild,
  pendingEarningsScheduleReviews,
  validateEarningsWeekPayload
} = require('./earnings_week');
const {
  applyMarketLensDecisions,
  applyWeekAheadLifecycle,
  buildWeekAheadPreparationFallback,
  finalizeWeekAheadOutcomes,
  mergeWeekAheadPayload,
  normalizeMarketLensDecisions,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const { addDays, isIsoDate, isIsoDateTime } = require('./calendar_contract');
const {
  TAPE_COMMENTARY_UNAVAILABLE_NOTE,
  buildEditorialReview,
  editorialTextEntries,
  reviewedTapeCommentary,
  unavailableTapeCommentary,
  validateReviewManifest,
  validateTapeCommentaryDisposition
} = require('./editorial_review_contract');
const {
  allowedNewsDates,
  applyNewsCoverageState,
  applyScheduledNewsBaseline,
  canonicalStoryUrl,
  futuresStoryPublicationWindow,
  sharedFuturesSessionDate,
  storyIdentity
} = require('./news_contract');
const { priorNewsCandidates } = require('./fetch_news_candidates');
const { APPROVED_NEWS_SOURCES } = require('./news_sources');
const { atomicWriteFile, atomicWriteJson } = require('./staging_writer');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DASHBOARD = path.join(ROOT, 'daily_financial_news.html');
const GENERATED_DIR = path.join(ROOT, 'generated');
const DEFAULT_CANDIDATE = path.join(GENERATED_DIR, 'daily_financial_news.candidate.html');
const LAST_GOOD_DASHBOARD = path.join(GENERATED_DIR, 'daily_financial_news.last_good.html');
const EARNINGS_WEEK_PATH = path.join(GENERATED_DIR, 'earnings_week.json');
const EARNINGS_NARRATIVE_PATH = path.join(GENERATED_DIR, 'earnings_narrative.json');
const WEEK_AHEAD_PATH = path.join(GENERATED_DIR, 'week_ahead.json');
const NEWS_CANDIDATES_PATH = path.join(GENERATED_DIR, 'news_candidates.json');
const SECTION_COMMAND_TIMEOUT_MS = 5 * 60_000;
const NEWS_COMMAND_TIMEOUT_MS = 10 * 60_000;
const EARNINGS_COMMAND_TIMEOUT_MS = 10 * 60_000;
const SCHEDULED_WINDOWS = {
  morning: { startMinutes: 7 * 60 + 45, endMinutes: 9 * 60 },
  afternoon: { startMinutes: 15 * 60 + 45, endMinutes: 17 * 60 }
};
const WINDOW_LABELS = {
  morning: {
    sectionLabel: 'Before The Open',
    sectionTitle: 'Pre-Market Futures'
  },
  afternoon: {
    sectionLabel: 'After The Bell',
    sectionTitle: 'Session Futures'
  }
};
let preparationStatus = null;

function reportPreparationStatus(status, detail = '') {
  preparationStatus = status;
  fs.writeSync(1, `Preparation status: ${status}${detail ? ` — ${detail}` : ''}\n`);
}

function failIncompletePreparation(message) {
  if (preparationStatus !== 'preparing') return false;
  reportPreparationStatus('failed', `candidate not replaced; canonical dashboard unchanged: ${message}`);
  process.exitCode = 1;
  return true;
}

process.on('exit', () => {
  failIncompletePreparation('preparation ended without terminal status');
});

function chicagoDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  return {
    weekday: part('weekday'),
    isoDate: `${part('year')}-${part('month')}-${part('day')}`,
    clockMinutes: Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) * 60 + minute : null
  };
}

function scheduledNow() {
  const override = process.env.SCHEDULED_NOW_ISO;
  const parsed = override ? new Date(override) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function calendarRolloverRange(windowMode, now = scheduledNow()) {
  // Calendar membership changes only at these two handoff windows; all other
  // runs retain the existing five trading dates while refreshing live results.
  const parts = chicagoDateParts(now);
  if (windowMode === 'afternoon' && parts.weekday === 'Fri') {
    return { from: parts.isoDate, to: addDays(parts.isoDate, 6) };
  }
  if (windowMode === 'morning' && parts.weekday === 'Mon') {
    return { from: parts.isoDate, to: addDays(parts.isoDate, 4) };
  }
  return null;
}

function requiresUnavailableRolloverRetry(section) {
  return section?.availability?.status === 'unavailable';
}

function completedScheduledWindow(baseline) {
  const marker = String(baseline?.lastScheduledWindow || '');
  if (/^\d{4}-\d{2}-\d{2}:(morning|afternoon)$/.test(marker)) return marker;
  const timestamp = typeof baseline?.lastScheduledUpdateAt === 'string'
    ? new Date(baseline.lastScheduledUpdateAt)
    : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) return '';
  const parts = chicagoDateParts(timestamp);
  const window = Object.entries(SCHEDULED_WINDOWS).find(([, range]) => (
    parts.clockMinutes !== null
    && parts.clockMinutes >= range.startMinutes
    && parts.clockMinutes <= range.endMinutes
  ));
  return window ? `${parts.isoDate}:${window[0]}` : '';
}

function scheduledWindowId(windowMode, now = scheduledNow()) {
  const range = SCHEDULED_WINDOWS[windowMode];
  if (!range) throw new Error('Scheduled runs require --morning or --afternoon.');
  const parts = chicagoDateParts(now);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) {
    throw new Error('Scheduled runs only permit weekday starts in America/Chicago.');
  }
  if (parts.clockMinutes === null || parts.clockMinutes < range.startMinutes || parts.clockMinutes > range.endMinutes) {
    throw new Error(`Scheduled ${windowMode} start is outside its America/Chicago update window.`);
  }
  return `${parts.isoDate}:${windowMode}`;
}

function assertScheduledWindowAvailable(dashboard, windowId) {
  const dashboardData = readJsonBlock(fs.readFileSync(dashboard, 'utf8'), 'dashboard-data');
  if (completedScheduledWindow(dashboardData.newsBaseline) === windowId) {
    throw new Error(`Scheduled run refused: ${windowId} already completed. Use the manual/on-demand workflow for an intentional same-window rerun.`);
  }
  return windowId;
}

function validateScheduledStart(dashboard, windowMode, now = scheduledNow()) {
  return assertScheduledWindowAvailable(dashboard, scheduledWindowId(windowMode, now));
}

function validateScheduledFinalization(dashboard, windowMode, now = scheduledNow()) {
  if (!SCHEDULED_WINDOWS[windowMode]) throw new Error('Scheduled runs require --morning or --afternoon.');
  const parts = chicagoDateParts(now);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) {
    throw new Error('Scheduled runs only permit weekday finalization in America/Chicago.');
  }
  return assertScheduledWindowAvailable(dashboard, `${parts.isoDate}:${windowMode}`);
}

function stampDashboardEdition(data) {
  return {
    ...data,
    editionId: scheduledNow().toISOString()
  };
}

function chicagoEditionMetadata(windowMode, now = scheduledNow()) {
  const labels = WINDOW_LABELS[windowMode];
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }).format(now);
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  }).formatToParts(now);
  const value = (type) => timeParts.find((part) => part.type === type)?.value || '';
  return {
    date,
    compiledPrefix: `Compiled ${date} at ${value('hour')}:${value('minute')} ${value('dayPeriod')} ${value('timeZoneName')}`,
    ...(labels ? {
      edition: windowMode === 'morning' ? 'Morning Edition' : 'Afternoon Edition',
      sectionLabel: labels.sectionLabel,
      sectionTitle: labels.sectionTitle
    } : {})
  };
}

function applyEditionMetadata(data, windowMode, now = scheduledNow()) {
  const metadata = chicagoEditionMetadata(windowMode, now);
  const compiled = String(data.footer?.compiled || '');
  const sourceContextIndex = compiled.indexOf(' · ');
  const sourceContext = sourceContextIndex >= 0 ? compiled.slice(sourceContextIndex) : '';
  data.footer = { ...data.footer, compiled: `${metadata.compiledPrefix}${sourceContext}` };
  if (!metadata.sectionLabel) return data;
  data.masthead = { ...data.masthead, edition: metadata.edition, date: metadata.date.replace(', ', ' · ') };
  data.futuresModule = { ...data.futuresModule, sectionLabel: metadata.sectionLabel, sectionTitle: metadata.sectionTitle };
  const currentTapeLabel = String(data.tape?.label || '');
  const driverIndex = currentTapeLabel.indexOf(' · ');
  const drivers = driverIndex >= 0 ? currentTapeLabel.slice(driverIndex) : '';
  const sessionDate = data.futuresModule?.futures?.find((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.raw?.sessionDate || '')))?.raw?.sessionDate;
  const sessionWeekday = sessionDate
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${sessionDate}T12:00:00Z`))
    : metadata.date.split(',')[0];
  data.tape = { ...data.tape, label: `${sessionWeekday} ${metadata.sectionLabel}${drivers}` };
  delete data.lede;
  delete data.renesas;
  return data;
}

function parseArgs(argv) {
  const args = {
    dashboard: DEFAULT_DASHBOARD,
    candidate: DEFAULT_CANDIDATE,
    windowMode: '',
    applyDashboardDataJson: '',
    prepareEditorialDir: '',
    applyEarningsWeekJson: '',
    applyChartDataJson: '',
    mergeChartDataJson: '',
    syncChartQuotes: false,
    rebuildEarningsCalendar: false,
    scheduled: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dashboard') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--dashboard requires a path.');
      args.dashboard = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--candidate') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--candidate requires a path.');
      args.candidate = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-dashboard-data-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-dashboard-data-json requires a path.');
      args.applyDashboardDataJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--prepare-editorial-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--prepare-editorial-dir requires a path.');
      args.prepareEditorialDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-earnings-week-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-earnings-week-json requires a path.');
      args.applyEarningsWeekJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-chart-data-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-chart-data-json requires a path.');
      args.applyChartDataJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--merge-chart-data-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--merge-chart-data-json requires a path.');
      args.mergeChartDataJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--sync-chart-quotes') {
      args.syncChartQuotes = true;
      continue;
    }
    if (arg === '--morning') {
      args.windowMode = 'morning';
      continue;
    }
    if (arg === '--afternoon') {
      args.windowMode = 'afternoon';
      continue;
    }
    if (arg === '--scheduled') {
      args.scheduled = true;
      continue;
    }
    if (arg === '--rebuild-earnings-calendar') {
      args.rebuildEarningsCalendar = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const contentModeCount = [args.applyDashboardDataJson, args.applyEarningsWeekJson, args.applyChartDataJson, args.mergeChartDataJson, args.prepareEditorialDir, args.syncChartQuotes].filter(Boolean).length;
  if (!args.windowMode && contentModeCount === 0) {
    throw new Error('You must pass --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-earnings-week-json, --apply-chart-data-json, --merge-chart-data-json, or --sync-chart-quotes.');
  }
  const windowAwareContentMode = args.applyDashboardDataJson || args.prepareEditorialDir;
  if (contentModeCount > 1 || (args.windowMode && contentModeCount && !windowAwareContentMode)) {
    throw new Error('Use only one update mode: --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-earnings-week-json, --apply-chart-data-json, --merge-chart-data-json, or --sync-chart-quotes.');
  }
  const deterministicPreparation = Boolean(args.windowMode && contentModeCount === 0);
  if (args.scheduled && (!args.windowMode || (!deterministicPreparation && !args.applyDashboardDataJson))) {
    throw new Error('--scheduled is valid only with deterministic preparation or final editorial application using --morning or --afternoon.');
  }
  if (args.rebuildEarningsCalendar && !deterministicPreparation) {
    throw new Error('--rebuild-earnings-calendar is valid only with deterministic preparation.');
  }
  if (path.resolve(args.candidate) === path.resolve(args.dashboard)) {
    throw new Error('--candidate must not target the canonical dashboard.');
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run_daily_update.js (--morning | --afternoon) [options]
  node scripts/run_daily_update.js --prepare-editorial-dir PATH [--morning|--afternoon]
  node scripts/run_daily_update.js --apply-dashboard-data-json PATH [--scheduled --morning|--afternoon] [options]
  node scripts/run_daily_update.js --apply-earnings-week-json PATH [options]
  node scripts/run_daily_update.js --apply-chart-data-json PATH [options]
  node scripts/run_daily_update.js --merge-chart-data-json PATH [options]
  node scripts/run_daily_update.js --sync-chart-quotes [options]

Options:
  --dashboard PATH                     Canonical dashboard HTML (default: daily_financial_news.html)
  --candidate PATH                     Staged complete candidate (default: generated/daily_financial_news.candidate.html)
  --apply-dashboard-data-json PATH    Safely replace only the embedded dashboard-data block from JSON
  --prepare-editorial-dir PATH        Download News candidates and write the single dashboard-data editorial handoff
  --apply-earnings-week-json PATH     Stage a validated earnings-week payload in the complete candidate
  --apply-chart-data-json PATH        Stage chart history and derive matching Tape prices from JSON
  --merge-chart-data-json PATH        Stage selected chart series while preserving all other series
  --sync-chart-quotes                 Rebuild embedded chart quote rows and visible Tape prices from rounded chart history
  --morning                           Run the pre-open deterministic refresh path
  --afternoon                         Run the after-close deterministic refresh path
  --scheduled                         Mark scheduler-driven preparation/finalization; enforce its start window and completion marker
  --rebuild-earnings-calendar         Explicitly authorize a metered Earnings calendar rebuild during a manual preparation
  --help                              Show this help

Scheduled preparation checks the weekday/time window and completion marker before fetching. Finalization rechecks only the completion marker, so a run that started correctly may finish after the window closes.
Manual finalization is time-unrestricted and preserves the scheduled News baseline.

This orchestrator standardizes the three-phase daily workflow:
  1. refresh deterministic data and edition metadata
  2. download News candidates and prepare one dashboard-data handoff for editorial work
  3. merge editorial work, advance the scheduled baseline, stamp, receipt, validate, and atomically apply

Publish remains a separate explicit step via ./scripts/publish_main.sh.
`);
}

function runCommand(command, args, { timeoutMs = SECTION_COMMAND_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  });
  if (result.error?.code === 'ETIMEDOUT') {
    const error = new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`);
    error.exitCode = 1;
    throw error;
  }
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr, result.error?.message]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
    const error = new Error(`Command failed (${result.status || 1}): ${command} ${args.join(' ')}${detail ? ` — ${detail}` : ''}`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

function runWithSectionFallback(runFresh, buildFallback, options = {}) {
  try {
    const commandResult = runFresh();
    const payload = options.readFresh ? options.readFresh(commandResult) : commandResult;
    const errors = options.validateFresh ? options.validateFresh(payload) : [];
    if (errors?.length) throw new Error(`${options.label || 'Section'} staging payload is invalid: ${errors.join(' ')}`);
    return { error: null, fallback: null, payload };
  } catch (error) {
    if (options.readFreshOnError) {
      try {
        const payload = options.readFreshOnError(error);
        const errors = options.validateFresh ? options.validateFresh(payload) : [];
        if (!errors?.length) return { error, fallback: null, payload, recovered: true };
      } catch (_recoveryError) {
        // Continue to the section fallback when the latest staged artifact is absent or invalid.
      }
    }
    const fallback = buildFallback(error);
    const fallbackErrors = options.validateFallback ? options.validateFallback(fallback) : [];
    if (fallbackErrors?.length) {
      process.stderr.write(`${options.label || 'Section'} fallback warning after ${error.message}: ${fallbackErrors.join(' ')}\n`);
    }
    return { error, fallback, payload: fallback };
  }
}

function reportSectionFallback(section, mode, error) {
  process.stderr.write(`${section} preparation failed; continuing with ${mode} section fallback: ${error.message}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function earningsStagingNeedsRebuild(filePath = EARNINGS_WEEK_PATH, now = scheduledNow()) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const payload = readJson(filePath);
    return validateEarningsWeekPayload(payload, { now })?.length > 0;
  } catch (_error) {
    return true;
  }
}

function readCurrentEarningsWeekArtifact(targetRange, checkedAt, filePath = EARNINGS_WEEK_PATH) {
  const payload = readJson(filePath);
  if (payload?.generatedAt !== checkedAt.toISOString()) {
    throw new Error('Earnings staging artifact does not belong to this preparation run.');
  }
  if (payload?.range?.from !== targetRange?.from || payload?.range?.to !== targetRange?.to) {
    throw new Error('Earnings staging artifact does not match the target range.');
  }
  return payload;
}

function earningsTargetRange(args, canonicalWeek) {
  const rolloverRange = args.scheduled || args.rebuildEarningsCalendar
    ? args.calendarRolloverRange
    : null;
  return rolloverRange || canonicalWeek?.range;
}

function earningsCalendarBuildDecision(args, {
  canonicalWeek,
  invalidPersistedArtifact,
  calendarNeedsBuild,
  failedAttemptNeedsRetry
}) {
  const unavailableRetry = requiresUnavailableRolloverRetry(canonicalWeek);
  const buildNeeded = unavailableRetry || invalidPersistedArtifact || calendarNeedsBuild;
  if (!buildNeeded) return { build: false, blocked: false, reason: '' };
  if (args.rebuildEarningsCalendar) return { build: true, blocked: false, reason: 'explicit_manual_rebuild' };
  if (!args.scheduled) return { build: false, blocked: true, reason: 'manual_build_not_authorized' };
  if (args.calendarRolloverRange) return { build: true, blocked: false, reason: 'scheduled_rollover' };
  if (unavailableRetry) return { build: true, blocked: false, reason: 'scheduled_unavailable_retry' };
  if (failedAttemptNeedsRetry) return { build: true, blocked: false, reason: 'scheduled_failed_attempt_retry' };
  return { build: false, blocked: true, reason: 'scheduled_build_not_authorized' };
}

function weekAheadStagingNeedsRebuild(filePath = WEEK_AHEAD_PATH) {
  if (!fs.existsSync(filePath)) return false;
  try {
    return validateWeekAheadPayload(readJson(filePath))?.length > 0;
  } catch (_error) {
    return true;
  }
}

function readOptionalJson(filePath, fallback, label = path.basename(filePath)) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  try {
    return readJson(filePath);
  } catch (error) {
    process.stderr.write(`${label} could not be read; continuing without optional prior data: ${error.message}\n`);
    return structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  atomicWriteJson(filePath, value);
}

function assertCandidateMatchesCanonical(args, candidateData) {
  let canonicalHtml;
  try {
    canonicalHtml = fs.readFileSync(args.dashboard, 'utf8');
    readJsonBlock(canonicalHtml, 'dashboard-data');
  } catch (error) {
    if (path.resolve(args.dashboard) !== DEFAULT_DASHBOARD) throw error;
    canonicalHtml = loadDashboardBase(args.dashboard).html;
  }
  const canonicalData = readJsonBlock(canonicalHtml, 'dashboard-data');
  if (candidateData.editionId !== canonicalData.editionId) {
    throw new Error('Staged dashboard candidate is stale; rerun deterministic preparation before editorial work.');
  }
  return canonicalData;
}

function prepareTapeCommentaryForEditorial(tape, previousTape) {
  const previousByTicker = new Map((Array.isArray(previousTape?.rows) ? previousTape.rows : [])
    .map((row) => [String(row?.ticker || '').trim().toUpperCase(), row]));
  return {
    ...tape,
    rows: (Array.isArray(tape?.rows) ? tape.rows : []).map((row) => {
      const previous = previousByTicker.get(String(row?.ticker || '').trim().toUpperCase());
      if (previous?.noteDisposition?.quoteRevision === row?.noteDisposition?.quoteRevision) return row;
      return {
        ...row,
        noteDisposition: {
          status: 'pending_review',
          quoteRevision: row.noteDisposition.quoteRevision
        }
      };
    })
  };
}

function pendingNarrativeDisposition(current, verifiedText = '') {
  if (current?.status === 'verified' && String(verifiedText || '').trim()) return structuredClone(current);
  return { status: 'pending_review' };
}

function prepareEarningsForEditorial(earnings) {
  const week = structuredClone(earnings?.week || { rows: [] });
  delete week.narrativeApply;
  week.rows = (Array.isArray(week.rows) ? week.rows : []).map((row) => {
    if (!renderSafePublishedEarningsRow(row)) return row;
    const next = structuredClone(row);
    const resultsAvailable = next.outcome?.overall !== 'pending';
    next.outcome.interpretationDisposition = pendingNarrativeDisposition(
      next.outcome?.interpretationDisposition,
      next.outcome?.interpretation
    );
    if (resultsAvailable) {
      const guidance = next.outcome?.guidanceDisposition;
      const guidanceComplete = (guidance?.status === 'verified' && String(next.outcome?.guide || '').trim())
        || guidance?.status === 'not_provided';
      next.outcome.guidanceDisposition = guidanceComplete
        ? structuredClone(guidance)
        : { status: 'pending_review' };
    }
    if (next.lifecycle === 'close_available' && resultsAvailable) {
      next.reaction.commentaryDisposition = pendingNarrativeDisposition(
        next.reaction?.commentaryDisposition,
        next.reaction?.note
      );
    }
    return next;
  });
  return { ...earnings, week };
}

function prepareWeekAheadForEditorial(weekAhead) {
  return {
    ...weekAhead,
    days: (Array.isArray(weekAhead?.days) ? weekAhead.days : []).map((day) => {
      if (day?.lifecycle !== 'close_available' || day?.outcome?.status === 'verified') return day;
      return { ...day, outcome: { status: 'pending_review' } };
    })
  };
}

function emptyNewsCandidateArtifact(asOf, error, dashboardData = null) {
  const eligibleDates = allowedNewsDates(asOf);
  const prior = priorNewsCandidates(dashboardData, eligibleDates);
  return {
    schemaVersion: 2,
    generatedAt: asOf.toISOString(),
    finishedAt: asOf.toISOString(),
    eligibleDates: [...eligibleDates].sort(),
    sourceCatalog: APPROVED_NEWS_SOURCES,
    attempts: [{
      id: 'news-worker',
      provider: 'news-acquisition',
      phase: 'worker',
      pool: 'all',
      attemptedAt: asOf.toISOString(),
      resultCount: 0,
      acceptedCount: 0,
      error: String(error?.message || error || 'News worker failed.')
    }],
    generalCandidates: prior.generalCandidates,
    cryptoCandidates: prior.cryptoCandidates
  };
}

function validNewsCandidateArtifact(artifact, asOf) {
  return artifact?.schemaVersion === 2
    && artifact.generatedAt === asOf.toISOString()
    && Array.isArray(artifact.attempts)
    && Array.isArray(artifact.generalCandidates)
    && Array.isArray(artifact.cryptoCandidates);
}

function partialNewsCandidateArtifact(asOf, error) {
  try {
    const artifact = readJson(NEWS_CANDIDATES_PATH);
    if (!validNewsCandidateArtifact(artifact, asOf)) return null;
    return {
      ...artifact,
      finishedAt: scheduledNow().toISOString(),
      attempts: [
        ...artifact.attempts,
        {
          id: 'news-worker',
          provider: 'news-acquisition',
          phase: 'worker',
          pool: 'all',
          attemptedAt: scheduledNow().toISOString(),
          resultCount: 0,
          acceptedCount: 0,
          error: String(error?.message || error || 'News worker did not finish.')
        }
      ],
      articleReview: {
        ...(artifact.articleReview || {}),
        status: artifact.articleReview?.status === 'complete' ? 'complete' : 'partial',
        error: String(error?.message || error || 'News worker did not finish.')
      }
    };
  } catch (_readError) {
    return null;
  }
}

function prepareNewsCandidatesForEditorial(asOf, args, dashboardData) {
  try {
    runCommand('node', [
      'scripts/fetch_news_candidates.js',
      '--as-of', asOf.toISOString(),
      '--input', args.candidate,
      '--output', NEWS_CANDIDATES_PATH,
      ...(args.windowMode ? [`--${args.windowMode}`] : [])
    ], { timeoutMs: NEWS_COMMAND_TIMEOUT_MS });
    const artifact = readJson(NEWS_CANDIDATES_PATH);
    if (!validNewsCandidateArtifact(artifact, asOf)) {
      throw new Error('News candidate artifact is malformed.');
    }
    return artifact;
  } catch (error) {
    const partial = partialNewsCandidateArtifact(asOf, error);
    if (partial) {
      process.stderr.write(`News candidate acquisition did not finish; continuing with partial staged candidates: ${error.message}\n`);
      writeJson(NEWS_CANDIDATES_PATH, partial);
      return partial;
    }
    process.stderr.write(`News candidate acquisition failed before staging candidates; continuing with still-fresh prior cards: ${error.message}\n`);
    const artifact = emptyNewsCandidateArtifact(asOf, error, dashboardData);
    writeJson(NEWS_CANDIDATES_PATH, artifact);
    return artifact;
  }
}

function prepareEditorialWorkspace(args) {
  const html = fs.readFileSync(args.candidate, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const previousDashboardData = assertCandidateMatchesCanonical(args, dashboardData);
  const baseEditionId = dashboardData.editionId;
  delete dashboardData.editorialReview;
  if (args.windowMode) applyEditionMetadata(dashboardData, args.windowMode);
  delete dashboardData.lede;
  delete dashboardData.renesas;
  const marketLensDecisions = (dashboardData.weekAhead?.days || [])
    .filter((day) => Array.isArray(day?.events) && day.events.length)
    .map((day) => ({ date: day.date, action: null }));
  const preparedAt = scheduledNow();
  const newsSearch = prepareNewsCandidatesForEditorial(preparedAt, args, dashboardData);
  const reviewManifest = {
    schemaVersion: 1,
    preparedAt: preparedAt.toISOString(),
    reviewedAt: null,
    baseEditionId,
    verifiedClaims: [],
    newsSearch,
    openingDecision: { action: null },
    marketLensDecisions
  };
  dashboardData.tape = prepareTapeCommentaryForEditorial(dashboardData.tape, previousDashboardData.tape);
  delete dashboardData.storiesCoverage;
  if (dashboardData.crypto) delete dashboardData.crypto.notesCoverage;
  if (dashboardData.futuresModule) delete dashboardData.futuresModule.storiesCoverage;
  dashboardData.earnings = prepareEarningsForEditorial(dashboardData.earnings);
  dashboardData.weekAhead = prepareWeekAheadForEditorial(dashboardData.weekAhead);
  dashboardData.editorialReview = reviewManifest;
  fs.mkdirSync(args.prepareEditorialDir, { recursive: true });
  for (const staleName of ['editorial-review.json', 'earnings_narrative.json']) {
    const stalePath = path.join(args.prepareEditorialDir, staleName);
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  }
  writeJson(path.join(args.prepareEditorialDir, 'dashboard-data.json'), dashboardData);
  return { dashboardData, reviewManifest };
}

function readJsonBlock(html, id) {
  const match = html.match(new RegExp(`<script type="application/json" id="${escapeRegExp(id)}">([\\s\\S]*?)<\\/script>`));
  if (!match) {
    throw new Error(`Could not find ${id} JSON block in dashboard HTML.`);
  }
  return JSON.parse(match[1]);
}

function validateDashboardBaseHtml(html) {
  readJsonBlock(html, 'dashboard-data');
  readJsonBlock(html, 'chart-data');
  return html;
}

function loadDashboardBase(dashboardPath, { lastGoodPath = LAST_GOOD_DASHBOARD, allowRecovery = path.resolve(dashboardPath) === DEFAULT_DASHBOARD } = {}) {
  try {
    return { html: validateDashboardBaseHtml(fs.readFileSync(dashboardPath, 'utf8')), sourcePath: dashboardPath, recovered: false };
  } catch (canonicalError) {
    if (!allowRecovery || !fs.existsSync(lastGoodPath)) throw canonicalError;
    try {
      const html = validateDashboardBaseHtml(fs.readFileSync(lastGoodPath, 'utf8'));
      process.stderr.write(`Canonical dashboard is unreadable; assembling from the last validated dashboard snapshot: ${canonicalError.message}\n`);
      return { html, sourcePath: lastGoodPath, recovered: true };
    } catch (recoveryError) {
      throw new Error(`Canonical dashboard and last-good snapshot are both unusable: ${canonicalError.message} Recovery: ${recoveryError.message}`);
    }
  }
}

function loadFocusedRepairBase(args) {
  if (!fs.existsSync(args.candidate)) {
    throw new Error(`Staged dashboard candidate not found: ${args.candidate}. Run deterministic preparation first.`);
  }
  const html = validateDashboardBaseHtml(fs.readFileSync(args.candidate, 'utf8'));
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  assertCandidateMatchesCanonical(args, dashboardData);
  return { html, dashboardData };
}

function replaceJsonBlock(html, id, serializedJson) {
  return html.replace(
    new RegExp(`<script type="application/json" id="${escapeRegExp(id)}">([\\s\\S]*?)<\\/script>`),
    // Use a replacer callback so `$` inside serialized prices and copy is not treated as a replacement token.
    () => `<script type="application/json" id="${id}">${serializedJson}</script>`
  );
}

function normalizeTapeCommentaryForPublication(data, chartData) {
  const revisions = new Map((Array.isArray(chartData?.series) ? chartData.series : [])
    .map((series) => [String(series?.ticker || '').toUpperCase(), series?.quoteRevision])
    .filter(([ticker, quoteRevision]) => ticker && isIsoDateTime(quoteRevision)));
  if (!revisions.size || !Array.isArray(data?.tape?.rows)) return;
  data.tape.rows = data.tape.rows.map((row) => {
    const ticker = String(row?.ticker || '').toUpperCase();
    const quoteRevision = revisions.get(ticker);
    if (!quoteRevision || row?.noteDisposition?.quoteRevision === quoteRevision) return row;
    return unavailableTapeCommentary(row, quoteRevision);
  });
}

function patchDashboardDataBlock(html, dashboardData, reviewManifest = null, reviewChartData = null, { stampEdition = true } = {}) {
  const stampedData = structuredClone(stampEdition ? stampDashboardEdition(dashboardData) : dashboardData);
  try {
    normalizeTapeCommentaryForPublication(stampedData, readJsonBlock(html, 'chart-data'));
  } catch (_error) {
    // Broken/missing chart-data is still caught by final validation.
  }
  normalizeEarningsForPublication(stampedData);
  stripPublishedEarningsSourceAudit(stampedData);
  delete stampedData.editorialReview;
  if (reviewManifest) {
    try {
      buildEditorialReview(stampedData, reviewManifest, reviewChartData);
    } catch (error) {
      process.stderr.write(`Editorial review receipt omitted: ${error.message}\n`);
    }
  }
  return replaceJsonBlock(html, 'dashboard-data', `\n${JSON.stringify(stampedData, null, 2)}\n`);
}

function stripSourceAuditFields(value) {
  if (Array.isArray(value)) {
    value.forEach(stripSourceAuditFields);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  delete value.sourceAudit;
  Object.values(value).forEach(stripSourceAuditFields);
  return value;
}

function stripPublishedEarningsSourceAudit(data) {
  const rows = data.earnings?.week?.rows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      row.scheduleVerificationStatus = String(row.scheduleVerificationStatus || row.sourceAudit?.scheduleVerification?.status || '');
      row.companyReleaseStatus = String(row.companyReleaseStatus || row.sourceAudit?.companyReleaseResolution?.status || '');
    }
  }
  stripSourceAuditFields(data.earnings?.week);
  return data;
}

function commitDashboardCandidate(args, nextHtml, {
  refreshLastGood = path.resolve(args.dashboard) === DEFAULT_DASHBOARD,
  lastGoodPath = LAST_GOOD_DASHBOARD,
  snapshotWriter = atomicWriteFile
} = {}) {
  const directory = path.dirname(args.dashboard);
  const candidate = path.join(directory, `.${path.basename(args.dashboard)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(candidate, nextHtml, { mode: fs.statSync(args.dashboard).mode });
    const validationArgs = [path.resolve(__dirname, 'validate_dashboard.js'), candidate];
    const result = spawnSync(process.execPath, validationArgs, {
      cwd: ROOT,
      stdio: 'inherit'
    });
    if (result.status !== 0) throw new Error('Editorial candidate failed validation; the published dashboard was not changed.');
    fs.renameSync(candidate, args.dashboard);
    if (refreshLastGood) {
      try {
        snapshotWriter(lastGoodPath, nextHtml, { mode: fs.statSync(args.dashboard).mode });
      } catch (error) {
        process.stderr.write(`Dashboard committed, but the last-good snapshot could not be refreshed: ${error.message}\n`);
      }
    }
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function commitEditorialCandidate(args, nextHtml) {
  commitDashboardCandidate(args, nextHtml);
}

function stageDashboardCandidate(args, nextHtml) {
  fs.mkdirSync(path.dirname(args.candidate), { recursive: true });
  const temporary = `${args.candidate}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, nextHtml, { mode: fs.statSync(args.dashboard).mode });
    const result = spawnSync(process.execPath, [path.resolve(__dirname, 'validate_dashboard.js'), temporary, '--staging-candidate'], {
      cwd: ROOT,
      stdio: 'inherit'
    });
    if (result.status !== 0) throw new Error('Deterministic candidate failed validation; the canonical dashboard was not changed.');
    fs.renameSync(temporary, args.candidate);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyTapeQuoteRows(data, quoteRows) {
  const byTicker = new Map(
    (Array.isArray(quoteRows) ? quoteRows : []).map((row) => [String(row?.ticker || '').toUpperCase(), row])
  );
  data.tape.rows = data.tape.rows.map((row) => {
    if (String(row?.group || '').trim() === 'Crypto') return row;
    const next = byTicker.get(String(row?.ticker || '').toUpperCase());
    if (!next) return row;
    return {
      ...row,
      last: next.last,
      delta: next.delta,
      pct: next.pct,
      dir: next.dir,
      asOf: next.asOf
    };
  });
}

function applyCryptoQuoteRows(data, quoteRows) {
  const byTicker = new Map(
    (Array.isArray(quoteRows) ? quoteRows : []).map((row) => [String(row?.sym || row?.ticker || '').toUpperCase(), row])
  );
  data.tape.rows = data.tape.rows.map((row) => {
    if (String(row?.group || '').trim() !== 'Crypto') return row;
    const next = byTicker.get(String(row?.ticker || '').toUpperCase());
    if (!next) return row;
    return {
      ...row,
      last: next.price,
      delta: next.delta,
      pct: next.chg,
      dir: next.dir,
      asOf: next.asOf
    };
  });
}

function resetTapeCommentary(data, quoteRevisionByTicker, { tickers = null, systemFallbacks = null } = {}) {
  const targetedTickers = tickers === null
    ? null
    : new Set([...tickers].map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean));
  let resetCount = 0;
  data.tape.rows = data.tape.rows.map((row) => {
    const ticker = String(row?.ticker || '').trim().toUpperCase();
    if (targetedTickers && !targetedTickers.has(ticker)) return row;
    const quoteRevision = quoteRevisionByTicker.get(ticker);
    if (!quoteRevision) throw new Error(`Chart series ${ticker} is missing the canonical quoteRevision required to reset Tape commentary.`);
    resetCount += 1;
    if (Array.isArray(systemFallbacks)) {
      systemFallbacks.push({
        section: 'tape-commentary',
        path: `tape.rows.${ticker}.note`,
        action: 'unavailable_disposition',
        reason: 'editorial_commentary_unavailable'
      });
    }
    return unavailableTapeCommentary(row, quoteRevision);
  });
  return resetCount;
}

function applyCryptoStats(data, payload) {
  if (!data.crypto || typeof data.crypto !== 'object' || Array.isArray(data.crypto)) data.crypto = {};
  const stats = Array.isArray(payload?.stats) ? payload.stats : [];
  const unavailable = payload?.availability?.status === 'unavailable';
  data.crypto.stats = stats;
  if (payload.fetchedAt) data.crypto.statsFetchedAt = payload.fetchedAt;
  if (payload.availability) data.crypto.availability = payload.availability;
  else if (!stats.length || unavailable) data.crypto.availability = { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: scheduledNow().toISOString() };
  else delete data.crypto.availability;
}

function applyEarningsWeek(data, earningsWeek, { requireNarrative = true } = {}) {
  const canonicalEarningsWeek = mergeUnchangedEarningsNarrative(data.earnings?.week, earningsWeek);
  delete canonicalEarningsWeek.policy;
  delete canonicalEarningsWeek.outputPath;
  if (!requireNarrative) delete canonicalEarningsWeek.narrativeApply;
  data.earnings = {
    label: 'Earnings · Week Monitor',
    week: canonicalEarningsWeek
  };
  normalizeEarningsForPublication(data);
}

function prepareCandidateNews(data, now = scheduledNow()) {
  const allowedDates = allowedNewsDates(now);
  const futuresWindow = futuresStoryPublicationWindow(
    data.futuresModule?.sectionTitle,
    new Date(now).toISOString(),
    now,
    data.futuresModule?.futures
  );
  const retainedFuturesDates = new Set([sharedFuturesSessionDate(data.futuresModule?.futures)].filter(Boolean));
  const retainedStoryIds = new Set();
  const retainedStoryUrls = new Set();
  const retainedStoryTitles = new Set();
  const retainFresh = (items, options = {}) => (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (!structurallyUsableStory(item, {
        allowedDates,
        verifiedClaims: new Set(),
        ...options
      })) return false;
      const identity = storyIdentity(item);
      const url = canonicalStoryUrl(item.url);
      const title = String(item.title || '').trim().toLowerCase();
      if (retainedStoryIds.has(identity) || retainedStoryUrls.has(url) || retainedStoryTitles.has(title)) return false;
      retainedStoryIds.add(identity);
      retainedStoryUrls.add(url);
      retainedStoryTitles.add(title);
      return true;
    });
  const storiesBefore = Array.isArray(data.stories) ? data.stories.length : 0;
  const cryptoBefore = Array.isArray(data.crypto?.notes) ? data.crypto.notes.length : 0;
  const futuresBefore = Array.isArray(data.futuresModule?.stories) ? data.futuresModule.stories.length : 0;

  // Candidate preparation keeps only usable current-session content.
  const futuresStories = retainFresh(data.futuresModule?.stories, {
    futures: true,
    additionalAllowedDates: retainedFuturesDates,
    futuresWindow
  });
  data.stories = retainFresh(data.stories);
  data.crypto = {
    ...data.crypto,
    notes: retainFresh(data.crypto?.notes, { crypto: true })
  };
  data.futuresModule = {
    ...data.futuresModule,
    stories: futuresStories
  };
  delete data.storiesCoverage;
  if (data.crypto) delete data.crypto.notesCoverage;
  if (data.futuresModule) delete data.futuresModule.storiesCoverage;

  return {
    storiesRemoved: storiesBefore - data.stories.length,
    cryptoNotesRemoved: cryptoBefore - data.crypto.notes.length,
    futuresStoriesRemoved: futuresBefore - data.futuresModule.stories.length
  };
}

function applyFuturesModule(data, futuresPayload, windowMode) {
  const expectedMode = windowMode === 'afternoon' ? 'session' : 'premarket';
  const errors = validateFuturesPayload(futuresPayload, { expectedMode });
  if (errors.length) futuresPayload = buildUnavailableFuturesPayload(expectedMode, scheduledNow());
  const labels = WINDOW_LABELS[windowMode];
  data.futuresModule = {
    ...data.futuresModule,
    sectionLabel: labels.sectionLabel,
    sectionTitle: labels.sectionTitle,
    ...(futuresPayload.availability ? { availability: futuresPayload.availability } : {}),
    futures: futuresPayload.futures
  };
  if (!futuresPayload.availability) delete data.futuresModule.availability;
}

function applyAssetAllocationPortfolio(data, portfolioPayload) {
  const unavailable = portfolioPayload?.availability?.status === 'unavailable';
  if (!Array.isArray(portfolioPayload?.rows) || (!portfolioPayload.rows.length && !unavailable)) {
    portfolioPayload = buildAssetAllocationFallback(data.assetAllocationPortfolio, {
      month: chicagoDateParts(scheduledNow()).isoDate.slice(0, 7),
      asOf: chicagoDateParts(scheduledNow()).isoDate,
      checkedAt: scheduledNow()
    });
  }
  data.assetAllocationPortfolio = {
    ...data.assetAllocationPortfolio,
    compiledAt: portfolioPayload.compiledAt,
    source: portfolioPayload.source,
    month: portfolioPayload.month,
    rows: portfolioPayload.rows,
    ...(portfolioPayload.availability ? { availability: portfolioPayload.availability } : {})
  };
  if (!portfolioPayload.availability) delete data.assetAllocationPortfolio.availability;
}

function applyAssetAllocationSummary(data, summaryPayload) {
  data.assetAllocationPortfolio = {
    ...data.assetAllocationPortfolio,
    portfolioMtdReturnAsOf: summaryPayload.asOf,
    portfolioMtdReturnValue: summaryPayload.portfolioMtdReturnValue,
    portfolioMtdReturnStatus: summaryPayload.status,
    portfolioMtdReturnStale: summaryPayload.stale
  };
}

function applyWeekAhead(data, weekAheadPayload) {
  data.weekAhead = mergeWeekAheadPayload(data.weekAhead, weekAheadPayload);
}

function syncDashboardPricesFromChartData(data, chartData, {
  windowMode = '',
  now = scheduledNow(),
  resetCommentary = false,
  commentaryTickers = null,
  systemFallbacks = null
} = {}) {
  // dashboard-data keeps the visible tape fields, but those values are projections from chart-data.series,
  // not an independent editable truth during scheduled or manual maintenance flows.
  const derivedQuoteRows = deriveQuoteRowsFromSeries(Array.isArray(chartData?.series) ? chartData.series : []);
  chartData.quoteRows = derivedQuoteRows;
  applyTapeQuoteRows(data, derivedQuoteRows.tape);
  applyCryptoQuoteRows(data, derivedQuoteRows.crypto);
  let commentaryResetCount = 0;
  if (resetCommentary) {
    const quoteRevisionByTicker = new Map(
      (Array.isArray(chartData?.series) ? chartData.series : []).map((series) => [
        String(series?.ticker || '').trim().toUpperCase(),
        series?.quoteRevision
      ])
    );
    commentaryResetCount = resetTapeCommentary(data, quoteRevisionByTicker, { tickers: commentaryTickers, systemFallbacks });
  }
  if (data.weekAhead) {
    data.weekAhead = applyWeekAheadLifecycle(data.weekAhead, chartData, { windowMode, now });
    normalizeWeekAheadReactionButtons(data, chartData);
  }
  return { commentaryResetCount };
}

function mergedChartAvailability(existingChartData, incomingChartData, series) {
  if (incomingChartData.availability?.status === 'carried_forward') {
    return incomingChartData.availability;
  }

  const incomingTickers = new Set(
    incomingChartData.series.map((item) => String(item?.ticker || '').trim().toUpperCase()).filter(Boolean)
  );
  if (existingChartData.availability?.status === 'carried_forward') {
    const existingTickers = existingChartData.series
      .map((item) => String(item?.ticker || '').trim().toUpperCase())
      .filter(Boolean);
    if (!existingTickers.every((ticker) => incomingTickers.has(ticker))) {
      return existingChartData.availability;
    }
  }

  const messages = new Map();
  for (const payload of [existingChartData, incomingChartData]) {
    for (const failure of payload.availability?.failures || []) {
      const ticker = String(failure?.ticker || '').trim().toUpperCase();
      if (ticker) messages.set(ticker, failure.message);
    }
  }
  const carriedSeries = series.filter((item) => item?.availability?.status === 'carried_forward');
  if (!carriedSeries.length) return null;

  const failures = carriedSeries.map((item) => {
    const ticker = String(item?.ticker || '').trim().toUpperCase();
    const message = messages.get(ticker) || 'Source refresh failed.';
    return { ticker, message };
  });
  const checkedAt = carriedSeries
    .map((item) => item.availability.checkedAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt,
    failures
  };
}

function patchDashboard(args) {
  const html = args.baseDashboardHtml || loadDashboardBase(args.dashboard).html;
  let dashboardData = readJsonBlock(html, 'dashboard-data');
  if (dashboardData.earnings?.week) delete dashboardData.earnings.week.outputPath;
  const previousDashboardData = dashboardData;
  let chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  let nextHtml = html;

  chartData = roundChartPayload(args.chartDataPayload || args.chartDataFallbackPayload || readJson(path.join(GENERATED_DIR, 'chart_data.json')));
  // chart-data.series is the canonical price history; quoteRows and dashboard tape prices are derived views.
  syncDashboardPricesFromChartData(dashboardData, chartData, {
    windowMode: args.windowMode,
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(chartData)
  });
  nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(compactChartPayload(chartData)));

  const futuresPayload = args.futuresPayload || args.futuresFallbackPayload || readJson(path.join(GENERATED_DIR, 'futures_module.json'));
  applyFuturesModule(dashboardData, futuresPayload, args.windowMode);

  const cryptoPayload = args.cryptoStatsPayload || args.cryptoStatsFallbackPayload || readJson(path.join(GENERATED_DIR, 'crypto_stats.json'));
  applyCryptoStats(dashboardData, cryptoPayload);

  const portfolioPayload = args.assetAllocationPortfolioPayload || readJson(path.join(GENERATED_DIR, 'asset_allocation_portfolio.json'));
  applyAssetAllocationPortfolio(dashboardData, portfolioPayload);

  const summaryPayload = args.assetAllocationSummaryPayload || readJson(path.join(GENERATED_DIR, 'asset_allocation_summary.json'));
  applyAssetAllocationSummary(dashboardData, summaryPayload);

  applyWeekAhead(dashboardData, args.weekAheadPayload || args.weekAheadFallbackPayload || readJson(WEEK_AHEAD_PATH));
  dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
  normalizeWeekAheadReactionButtons(dashboardData, chartData);

  if (args.earningsFallbackWeek) {
    applyEarningsWeek(dashboardData, args.earningsFallbackWeek, { requireNarrative: false });
  } else {
    applyEarningsWeek(dashboardData, args.earningsWeekPayload || readJson(EARNINGS_WEEK_PATH), { requireNarrative: false });
  }

  applyEditionMetadata(dashboardData, args.windowMode);
  prepareCandidateNews(dashboardData);
  // Preparation never advances scheduled News state. Only a successful final
  // editorial application records completion and rotates the comparison set.
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: false, scheduledWindow: args.windowMode, now: scheduledNow() });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  return nextHtml;
}

function validateMarketLensDashboardReferences(data, chartData, lens) {
  void data;
  void chartData;
  void lens;
  return [];
}

function normalizeWeekAheadReactionButtons(data, chartData) {
  const tapeTickers = new Set((Array.isArray(data?.tape?.rows) ? data.tape.rows : []).map((row) => String(row?.ticker || '').toUpperCase()));
  const chartTickers = new Set((Array.isArray(chartData?.series) ? chartData.series : []).map((series) => String(series?.ticker || '').toUpperCase()));
  const usable = (row) => tapeTickers.has(String(row?.ticker || '').toUpperCase()) && chartTickers.has(String(row?.ticker || '').toUpperCase());
  for (const day of data?.weekAhead?.days || []) {
    if (Array.isArray(day?.marketLens?.reactions)) day.marketLens.reactions = day.marketLens.reactions.filter(usable);
    if (Array.isArray(day?.marketReaction?.rows)) day.marketReaction.rows = day.marketReaction.rows.filter(usable);
  }
}

function applyMarketLensDecisionsData(data, chartData, payload) {
  data.weekAhead = applyMarketLensDecisions(data.weekAhead, payload, {
    validateEditorialReferences: (lens) => validateMarketLensDashboardReferences(data, chartData, lens)
  });
  return data;
}

function normalizeMarketLensReview(data, chartData, reviewManifest, priorReview = null, systemFallbacks = null) {
  void systemFallbacks;
  void priorReview;
  const submitted = Array.isArray(reviewManifest.marketLensDecisions) ? reviewManifest.marketLensDecisions : [];
  const eventDays = (data.weekAhead?.days || []).filter((day) => Array.isArray(day?.events) && day.events.length);
  const submittedByDate = new Map(submitted.filter((decision) => decision?.date).map((decision) => [decision.date, decision]));
  const normalized = normalizeMarketLensDecisions(data.weekAhead, submitted, {
    validateEditorialReferences: (lens) => validateMarketLensDashboardReferences(data, chartData, lens)
  }).map((decision) => {
    const day = eventDays.find((item) => item.date === decision.date);
    const submittedDecision = submittedByDate.get(decision.date);
    const released = ['released_awaiting_close', 'close_available'].includes(day?.lifecycle);
    if (released && decision.action === 'retain-generated') {
      if (Array.isArray(reviewManifest.systemFallbacks)) {
        reviewManifest.systemFallbacks.push({
          section: 'market-lens',
          path: `weekAhead.days.${decision.date}.marketLens`,
          action: 'unavailable_disposition',
          reason: 'editorial_commentary_unavailable'
        });
      }
      return {
        date: decision.date,
        action: 'commentary-unavailable',
        attemptedAt: scheduledNow().toISOString(),
        reason: 'editorial_commentary_unavailable'
      };
    }
    if (submittedDecision?.action !== decision.action && Array.isArray(reviewManifest.systemFallbacks)) {
      reviewManifest.systemFallbacks.push({
        section: 'market-lens',
        path: `weekAhead.days.${decision.date}.marketLens`,
        action: 'generated_default',
        reason: 'editorial_content_unavailable'
      });
    }
    return decision;
  });
  reviewManifest.marketLensDecisions = normalized;
  return reviewManifest;
}

function normalizeVerifiedClaims(data, reviewManifest, priorReview = null) {
  const currentTexts = new Set(editorialTextEntries(data).map((entry) => entry.text));
  const accepted = new Map();
  for (const claim of [
    ...(Array.isArray(reviewManifest.verifiedClaims) ? reviewManifest.verifiedClaims : []),
    ...(Array.isArray(priorReview?.verifiedClaims) ? priorReview.verifiedClaims : [])
  ]) {
    const text = String(claim?.text || '').trim();
    const evidenceUrl = String(claim?.evidenceUrl || '').trim();
    if (currentTexts.has(text) && /^https:\/\//i.test(evidenceUrl)) {
      accepted.set(text, { text, evidenceUrl });
    }
  }
  reviewManifest.verifiedClaims = [...accepted.values()];
}

function earningsNarrativeItem(row) {
  return {
    symbol: row.symbol,
    reportDate: row.reportDate,
    eps: { note: String(row.eps?.note || '') },
    revenue: { note: String(row.revenue?.note || '') },
    outcome: {
      guide: String(row.outcome?.guide || ''),
      interpretation: String(row.outcome?.interpretation || ''),
      ...(row.outcome?.guidanceDisposition ? { guidanceDisposition: row.outcome.guidanceDisposition } : {}),
      ...(row.outcome?.interpretationDisposition ? { interpretationDisposition: row.outcome.interpretationDisposition } : {})
    },
    reaction: {
      note: String(row.reaction?.note || ''),
      ...(row.reaction?.commentaryDisposition ? { commentaryDisposition: row.reaction.commentaryDisposition } : {})
    }
  };
}

function applyEditorialEarningsNarrative(dashboardData, candidateDashboardData, editorialDashboardData, systemFallbacks = null, attemptThreshold = '') {
  const candidateWeek = candidateDashboardData.earnings?.week;
  if (!candidateWeek) return null;
  const editorialRowsByKey = new Map((Array.isArray(editorialDashboardData.earnings?.week?.rows)
    ? editorialDashboardData.earnings.week.rows
    : []).map((row) => [earningsNarrativeRowKey(row), row]));
  const rows = (candidateWeek.rows || [])
    .filter(renderSafePublishedEarningsRow)
    .map((row) => earningsNarrativeItem(editorialRowsByKey.get(earningsNarrativeRowKey(row)) || {
      symbol: row.symbol,
      reportDate: row.reportDate,
      eps: {}, revenue: {}, outcome: {}, reaction: {}
    }));
  const outputPath = 'generated/editorial/dashboard-data.json';
  const narrativePayload = {
    schemaVersion: 1,
    sourceArtifact: 'generated/earnings_week.json',
    sourceGeneratedAt: candidateWeek.generatedAt,
    sourceRange: candidateWeek.range,
    rows,
    outputPath
  };
  let finalWeek = rows.length
    ? applyEarningsNarrative(candidateWeek, narrativePayload, {
        sourceArtifact: 'generated/earnings_week.json',
        narrativeArtifact: outputPath,
        appliedAt: scheduledNow()
      })
    : structuredClone(candidateWeek);
  const finalized = { earnings: { week: finalWeek } };
  normalizeEarningsForPublication(finalized);
  finalWeek = finalized.earnings.week;
  const errors = validateEarningsWeekPayload(finalWeek, { requireNarrative: true });
  if (errors.length) process.stderr.write(`Editorial Earnings narrative warning: ${errors.join(' ')}\n`);
  void systemFallbacks;
  void attemptThreshold;
  dashboardData.earnings = {
    ...candidateDashboardData.earnings,
    week: finalWeek
  };
  return { narrativePayload: rows.length ? narrativePayload : null, week: finalWeek };
}

function safeEditorialText(value, fallback, verifiedClaims, systemFallbacks = null, section = '', pathName = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (Array.isArray(systemFallbacks) && value !== fallback) {
      systemFallbacks.push({
        section,
        path: pathName,
        action: 'retained_candidate',
        reason: 'editorial_content_unavailable'
      });
    }
    return fallback;
  }
  return value;
}

function sanitizeOpening(candidate, editorial, verifiedClaims, systemFallbacks = null) {
  void candidate;
  void verifiedClaims;
  void systemFallbacks;
  const opening = {};
  const headline = typeof editorial?.headline === 'string' ? editorial.headline.trim() : '';
  const deck = typeof editorial?.deck === 'string' ? editorial.deck.trim() : '';
  if (headline) {
    opening.headline = headline;
    if (deck) opening.deck = deck;
  }
  const editorialCatalysts = (Array.isArray(editorial?.catalysts) ? editorial.catalysts : [])
    .map((item) => ({
      label: typeof item?.label === 'string' ? item.label.trim() : '',
      body: typeof item?.body === 'string' ? item.body.trim() : ''
    }))
    .filter((item) => item.label && item.body);
  if (editorialCatalysts.length) opening.catalysts = editorialCatalysts;
  return opening;
}

function finalizeOpeningEditorial(candidate, editorial, reviewManifest, verifiedClaims) {
  void reviewManifest;
  return sanitizeOpening(candidate, editorial, verifiedClaims);
}

function structurallyUsableStory(item, options = {}) {
  const { crypto = false, futures = false } = options;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.referencePage !== undefined) return false;
  const label = crypto ? item.kicker : item.tag;
  if (typeof label !== 'string' || !label.trim() || typeof item.title !== 'string' || !item.title.trim() || typeof item.body !== 'string' || !item.body.trim()) return false;
  if (!isIsoDate(item.publishedOn)) return false;
  if (options.requirePublishedAt && !isIsoDateTime(item.publishedAt)) return false;
  if (options.allowedDates instanceof Set
    && !options.allowedDates.has(item.publishedOn)
    && !options.additionalAllowedDates?.has(item.publishedOn)) return false;
  if (futures && options.futuresWindow) {
    const publishedAt = Date.parse(item.publishedAt);
    if (!Number.isFinite(publishedAt)
      || publishedAt < options.futuresWindow.start.getTime()
      || publishedAt > options.futuresWindow.end.getTime()) return false;
  }
  try {
    if (new URL(item.url).protocol !== 'https:') return false;
  } catch (_error) {
    return false;
  }
  return true;
}

function sanitizeStoryList(editorial, options = {}) {
  if (!Array.isArray(editorial)) {
    if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: options.path, action: 'omitted', reason: 'editorial_content_unavailable' });
    return [];
  }
  const seenUrls = new Set();
  const candidateUrls = options.candidateUrls instanceof Set ? options.candidateUrls : null;
  const blockedUrls = options.blockedUrls instanceof Set ? options.blockedUrls : new Set();
  return editorial.filter((item, index) => {
    if (!structurallyUsableStory(item, options)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'invalid_editorial_item' });
      return false;
    }
    const url = canonicalStoryUrl(item.url);
    if (candidateUrls && !candidateUrls.has(url)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'not_in_candidate_inventory' });
      return false;
    }
    const duplicate = !url || seenUrls.has(url);
    const blockedDuplicate = blockedUrls.has(url);
    if (duplicate || blockedDuplicate) {
      const reason = blockedDuplicate ? options.blockedDuplicateReason || 'duplicate_editorial_item' : 'duplicate_editorial_item';
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason });
      return false;
    }
    seenUrls.add(url);
    return true;
  });
}

function storyBlockSets(...groups) {
  const stories = groups.flatMap((group) => (Array.isArray(group) ? group : []));
  return {
    blockedUrls: new Set(stories.map((story) => canonicalStoryUrl(story?.url)).filter(Boolean))
  };
}

function canonicalCandidateUrl(candidate) {
  return canonicalStoryUrl(candidate?.url);
}

function candidatePublishedOnAllowed(candidate, options = {}) {
  return !(options.allowedDates instanceof Set)
    || options.allowedDates.has(candidate?.publishedOn)
    || options.additionalAllowedDates?.has(candidate?.publishedOn);
}

function candidateEligibleForNewsSection(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (!canonicalCandidateUrl(candidate)) return false;
  if (!candidatePublishedOnAllowed(candidate, options)) return false;
  if (options.futures) {
    if (!options.futuresWindow) return false;
    const publishedAt = Date.parse(candidate.publishedAt);
    if (!Number.isFinite(publishedAt)) return false;
    return publishedAt >= options.futuresWindow.start.getTime()
      && publishedAt <= options.futuresWindow.end.getTime();
  }
  return true;
}

function candidateUrlSet(candidates, options = {}) {
  return new Set((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidateEligibleForNewsSection(candidate, options))
    .map(canonicalCandidateUrl));
}

function readNewsCandidateSource(preparedAt) {
  const generatedAt = new Date(preparedAt);
  if (Number.isNaN(generatedAt.getTime())) {
    return null;
  }
  let artifact;
  try {
    artifact = readJson(NEWS_CANDIDATES_PATH);
  } catch (error) {
    void error;
    return null;
  }
  if (!validNewsCandidateArtifact(artifact, generatedAt)) {
    return null;
  }
  return artifact;
}

function usableTapeCommentary(row, note) {
  void row;
  const text = String(note || '').trim();
  return text !== TAPE_COMMENTARY_UNAVAILABLE_NOTE
    && Boolean(text);
}

function sanitizeTapeRows(candidateRows, editorialRows, previousRows, verifiedClaims, systemFallbacks = null, now = scheduledNow(), attemptThreshold = '') {
  const editorialByTicker = new Map((Array.isArray(editorialRows) ? editorialRows : []).map((row) => [String(row?.ticker || '').toUpperCase(), row]));
  const previousByTicker = new Map((Array.isArray(previousRows) ? previousRows : []).map((row) => [String(row?.ticker || '').toUpperCase(), row]));
  const reviewedAt = new Date(now).toISOString();
  return (Array.isArray(candidateRows) ? candidateRows : []).map((row) => {
    const ticker = String(row?.ticker || '').toUpperCase();
    const editorial = editorialByTicker.get(ticker);
    const previous = previousByTicker.get(ticker);
    const note = safeEditorialText(editorial?.note, row.note, verifiedClaims);
    const text = String(note || '').trim();
    const candidateDispositionValid = validateTapeCommentaryDisposition(row).length === 0;
    const quoteRevision = candidateDispositionValid
      ? row.noteDisposition.quoteRevision
      : previous?.noteDisposition?.quoteRevision || reviewedAt;
    const quoteWasRefreshed = !previous
      || !candidateDispositionValid
      || quoteRevision !== previous?.noteDisposition?.quoteRevision;
    const repeatsPriorCommentary = quoteWasRefreshed && text === String(previous?.note || '').trim();

    if (!quoteWasRefreshed && candidateDispositionValid) return structuredClone(previous);

    if (editorial && usableTapeCommentary(row, text) && !repeatsPriorCommentary) {
      return reviewedTapeCommentary(row, text, quoteRevision, reviewedAt);
    }

    if (Array.isArray(systemFallbacks)) {
      systemFallbacks.push({
        section: 'tape-commentary',
        path: `tape.rows.${ticker}.note`,
        action: 'unavailable_disposition',
        reason: 'editorial_commentary_unavailable'
      });
    }
    return unavailableTapeCommentary(row, quoteRevision);
  });
}

function usableWeekAheadOutcome(outcome, attemptThreshold) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  void attemptThreshold;
  return outcome.status === 'verified'
    && outcome.source === 'editorial'
    && Boolean(String(outcome.title || '').trim() && String(outcome.body || '').trim());
}

function renderSafeFutureRows(rows) {
  const priceAt = (point) => Number(Array.isArray(point) ? point[1] : point?.price ?? point?.value);
  const timeAt = (point) => Number(Array.isArray(point) ? point[0] : point?.time);
  return Array.isArray(rows)
    && rows.length === 4
    && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)
      && typeof row.label === 'string'
      && row.label.trim()
      && typeof row.value === 'string'
      && row.value.trim()
      && typeof row.body === 'string'
      && row.body.trim()
      && ['up', 'down', 'flat'].includes(row.dir)
      && Array.isArray(row.series)
      && row.series.length >= 2
      && row.series.every((point) => Number.isFinite(priceAt(point)) && priceAt(point) > 0 && Number.isFinite(timeAt(point)))
      && row.raw
      && typeof row.raw === 'object'
      && !Array.isArray(row.raw)
      && ['price', 'regularMarketTime', 'referencePrice', 'previousClose', 'delta', 'pct'].every((field) => Number.isFinite(Number(row.raw[field]))));
}

function renderSafeCryptoStats(stats) {
  if (!Array.isArray(stats) || !stats.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return false;
  const unavailable = (row) => row?.availability?.status === 'unavailable';
  const total = stats.find((row) => row.sym === 'TOTAL' || /(?:total )?crypto market cap/i.test(String(row?.name || '')));
  const fng = stats.find((row) => row.sym === 'F&G');
  const altcoin = stats.find((row) => row.sym === 'ALTSEASON' || /altcoin season/i.test(String(row?.name || '')));
  const scoreOk = (row) => unavailable(row) || (/^\d{1,3}$/.test(String(row?.price || '').trim()) && Number(row.price) >= 0 && Number(row.price) <= 100);
  return Boolean(total && fng && altcoin
    && (unavailable(total) || (String(total.price || '').trim() && String(total.delta || '').trim()))
    && scoreOk(fng)
    && scoreOk(altcoin));
}

function renderSafePortfolioRows(rows) {
  const required = new Set(['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX']);
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return false;
  const tickers = new Set(rows.map((row) => String(row.ticker || '').toUpperCase()));
  return [...required].every((ticker) => tickers.has(ticker))
    && rows.every((row) => ['ticker', 'sleeve', 'price', 'monthDivPerShare', 'dailyPriceChange', 'dailyTR', 'mtdPriceChange', 'mtdTR']
      .every((key) => typeof row[key] === 'string'));
}

function normalizePublishedStorySections(data) {
  const futuresStories = sanitizeStoryList(data.futuresModule?.stories, {
    futures: true,
    requirePublishedAt: true,
    path: 'futuresModule.stories'
  });
  data.futuresModule.stories = futuresStories;

  const stories = sanitizeStoryList(data.stories, {
    path: 'stories',
    ...storyBlockSets(futuresStories)
  });
  data.stories = stories;

  data.crypto.notes = sanitizeStoryList(data.crypto?.notes, {
    crypto: true,
    path: 'crypto.notes',
    ...storyBlockSets(futuresStories, stories)
  });
}

function normalizeEarningsForPublication(data) {
  const week = data.earnings?.week;
  if (!week || typeof week !== 'object' || Array.isArray(week)) return;
  if (!Array.isArray(week.rows)) week.rows = [];
  week.rows = week.rows
    .filter(renderSafePublishedEarningsRow)
    .map((row) => normalizeEarningsCommentaryForPublication(row));
  week.secondaryRecoveryCandidates = [];
  week.companyReleaseTasks = [];
  week.summary = {
    ...(week.summary && typeof week.summary === 'object' && !Array.isArray(week.summary) ? week.summary : {}),
    counts: computeEarningsWeekCounts(week.rows, week.secondaryRecoveryCandidates, week.companyReleaseTasks)
  };
  delete week.narrativeApply;
  delete week.companyReleaseApply;
}

function objectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderSafePublishedEarningsRow(row) {
  return objectRecord(row)
    && typeof row.symbol === 'string'
    && row.symbol.trim()
    && typeof row.company === 'string'
    && row.company.trim()
    && isIsoDate(row.reportDate)
    && objectRecord(row.eps)
    && objectRecord(row.revenue)
    && objectRecord(row.outcome)
    && objectRecord(row.reaction);
}

function validEarningsCommentaryDisposition(disposition, text) {
  if (disposition === undefined) return true;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return false;
  if (disposition.status === 'verified') return Boolean(String(text || '').trim());
  if (disposition.status !== 'commentary_unavailable') return false;
  return !String(text || '').trim()
    && typeof disposition.reason === 'string'
    && disposition.reason.trim()
    && isIsoDateTime(disposition.attemptedAt);
}

function validEarningsGuidanceDisposition(disposition, text) {
  if (disposition === undefined) return true;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return false;
  if (disposition.status === 'verified') return Boolean(String(text || '').trim());
  if (disposition.status === 'not_provided') {
    return !String(text || '').trim()
      && disposition.evidenceSource === 'official_company'
      && /^https:\/\//i.test(String(disposition.evidenceUrl || ''));
  }
  if (disposition.status === 'unverified') {
    return !String(text || '').trim()
      && typeof disposition.reason === 'string'
      && disposition.reason.trim()
      && isIsoDateTime(disposition.attemptedAt);
  }
  return false;
}

function normalizeEarningsCommentaryForPublication(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !row.outcome || typeof row.outcome !== 'object' || Array.isArray(row.outcome)) return row;
  const next = structuredClone(row);
  const outcome = next.outcome;
  next.scheduleVerificationStatus = String(next.scheduleVerificationStatus || next.sourceAudit?.scheduleVerification?.status || '');
  next.companyReleaseStatus = String(next.companyReleaseStatus || next.sourceAudit?.companyReleaseResolution?.status || '');
  outcome.overall = combinedOutcome(next.eps?.result, next.revenue?.result);

  if (!validEarningsCommentaryDisposition(outcome.interpretationDisposition, outcome.interpretation)) {
    outcome.interpretation = '';
    delete outcome.interpretationDisposition;
  } else if (outcome.interpretationDisposition?.status === 'commentary_unavailable') {
    outcome.interpretation = '';
  }

  if (!validEarningsGuidanceDisposition(outcome.guidanceDisposition, outcome.guide)) {
    outcome.guide = '';
    delete outcome.guidanceDisposition;
  } else if (['not_provided', 'unverified'].includes(outcome.guidanceDisposition?.status)) {
    outcome.guide = '';
  }

  return next;
}

function normalizePublicationDisplaySections(data, { windowMode = '', now = scheduledNow() } = {}) {
  const checkedAt = new Date(now);
  const asOf = chicagoDateParts(checkedAt).isoDate;
  const month = asOf.slice(0, 7);
  const safeWindowMode = WINDOW_LABELS[windowMode] ? windowMode : 'afternoon';

  if (!Array.isArray(data.stories)) data.stories = [];

  if (!data.futuresModule || typeof data.futuresModule !== 'object' || Array.isArray(data.futuresModule)) {
    data.futuresModule = {};
  }
  if (!Array.isArray(data.futuresModule.stories)) data.futuresModule.stories = [];
  if (!renderSafeFutureRows(data.futuresModule.futures)) {
    applyFuturesModule(
      data,
      buildUnavailableFuturesPayload(safeWindowMode === 'afternoon' ? 'session' : 'premarket', checkedAt),
      safeWindowMode
    );
  }

  if (!data.crypto || typeof data.crypto !== 'object' || Array.isArray(data.crypto)) data.crypto = {};
  if (!data.crypto.dominance || typeof data.crypto.dominance !== 'object' || Array.isArray(data.crypto.dominance)) {
    data.crypto.dominance = {};
  }
  if (!Array.isArray(data.crypto.notes)) data.crypto.notes = [];
  if (!renderSafeCryptoStats(data.crypto.stats)) {
    applyCryptoStats(data, buildCryptoStatsFallback({}, checkedAt));
  }

  if (!data.assetAllocationPortfolio || typeof data.assetAllocationPortfolio !== 'object' || Array.isArray(data.assetAllocationPortfolio)) {
    data.assetAllocationPortfolio = {};
  }
  if (!renderSafePortfolioRows(data.assetAllocationPortfolio.rows)) {
    applyAssetAllocationPortfolio(data, buildAssetAllocationFallback(data.assetAllocationPortfolio, { month, asOf, checkedAt }));
  }

  normalizePublishedStorySections(data);
  normalizeEarningsForPublication(data);
  applyNewsCoverageState(data, { now: checkedAt });
  return data;
}

function applyDashboardDataJson(args) {
  const canonicalHtml = loadDashboardBase(args.dashboard).html;
  const candidateHtml = fs.readFileSync(args.candidate, 'utf8');
  const candidateDashboardData = readJsonBlock(candidateHtml, 'dashboard-data');
  if (args.scheduled) validateScheduledFinalization(args.dashboard, args.windowMode);
  const previousDashboardData = assertCandidateMatchesCanonical(args, candidateDashboardData);
  const canonicalChartData = roundChartPayload(readJsonBlock(canonicalHtml, 'chart-data'));
  const candidateChartData = roundChartPayload(readJsonBlock(candidateHtml, 'chart-data'));
  assertChartSeriesRevisions(
    canonicalChartData,
    candidateChartData,
    'Staged dashboard candidate'
  );
  const editorialDashboardData = readJson(args.applyDashboardDataJson);
  let reviewManifest = { ...editorialDashboardData.editorialReview, reviewedAt: scheduledNow().toISOString() };
  reviewManifest.systemFallbacks = [];
  if (editorialDashboardData.editionId !== candidateDashboardData.editionId) {
    throw new Error('Editorial dashboard-data editionId must match the staged candidate; regenerate the editorial handoff.');
  }
  const newsSource = readNewsCandidateSource(reviewManifest.preparedAt);
  const dashboardData = structuredClone(candidateDashboardData);
  const editorialNow = scheduledNow();
  const allNewsCandidates = [
    ...(Array.isArray(newsSource?.generalCandidates) ? newsSource.generalCandidates : []),
    ...(Array.isArray(newsSource?.cryptoCandidates) ? newsSource.cryptoCandidates : [])
  ];
  const newsCandidateSets = {
    allCandidateUrls: newsSource ? candidateUrlSet(allNewsCandidates) : null
  };
  const verifiedClaims = new Set((Array.isArray(reviewManifest.verifiedClaims) ? reviewManifest.verifiedClaims : [])
    .filter((claim) => typeof claim?.text === 'string' && /^https:\/\//i.test(String(claim?.evidenceUrl || '')))
    .map((claim) => claim.text.trim()));
  dashboardData.opening = finalizeOpeningEditorial(
    candidateDashboardData.opening,
    editorialDashboardData.opening,
    reviewManifest,
    verifiedClaims
  );
  dashboardData.futuresModule = {
    ...dashboardData.futuresModule,
    stories: sanitizeStoryList(editorialDashboardData.futuresModule?.stories, {
      futures: true,
      systemFallbacks: reviewManifest.systemFallbacks,
      section: 'futures-news',
      path: 'futuresModule.stories',
      candidateUrls: newsCandidateSets.allCandidateUrls
    })
  };
  dashboardData.stories = sanitizeStoryList(editorialDashboardData.stories, {
    verifiedClaims,
    systemFallbacks: reviewManifest.systemFallbacks,
    section: 'stories',
    path: 'stories',
    candidateUrls: newsCandidateSets.allCandidateUrls,
    ...storyBlockSets(dashboardData.futuresModule.stories),
    blockedDuplicateReason: 'promoted_story_duplicate'
  });
  dashboardData.crypto = {
    ...dashboardData.crypto,
    notes: sanitizeStoryList(editorialDashboardData.crypto?.notes, {
      crypto: true,
      systemFallbacks: reviewManifest.systemFallbacks,
      section: 'crypto',
      path: 'crypto.notes',
      candidateUrls: newsCandidateSets.allCandidateUrls,
      ...storyBlockSets(dashboardData.futuresModule.stories, dashboardData.stories),
      blockedDuplicateReason: 'cross_section_duplicate'
    })
  };
  applyNewsCoverageState(dashboardData, { now: editorialNow });
  const candidateTapeLabel = String(candidateDashboardData.tape?.label || '');
  const editorialTapeLabel = String(editorialDashboardData.tape?.label || '');
  const candidateTapeContextIndex = candidateTapeLabel.indexOf(' · ');
  const editorialTapeContextIndex = editorialTapeLabel.indexOf(' · ');
  const tapeContext = editorialTapeContextIndex >= 0
    ? editorialTapeLabel.slice(editorialTapeContextIndex)
    : candidateTapeContextIndex >= 0 ? candidateTapeLabel.slice(candidateTapeContextIndex) : '';
  dashboardData.tape = {
    ...dashboardData.tape,
    label: `${candidateTapeContextIndex >= 0 ? candidateTapeLabel.slice(0, candidateTapeContextIndex) : candidateTapeLabel}${tapeContext}`,
    rows: sanitizeTapeRows(
      candidateDashboardData.tape?.rows,
      editorialDashboardData.tape?.rows,
      previousDashboardData.tape?.rows,
      verifiedClaims,
      reviewManifest.systemFallbacks,
      editorialNow,
      reviewManifest.preparedAt
    )
  };
  const candidateCompiled = String(candidateDashboardData.footer?.compiled || '');
  const editorialCompiled = String(editorialDashboardData.footer?.compiled || '');
  const candidateFooterContextIndex = candidateCompiled.indexOf(' · ');
  const editorialFooterContextIndex = editorialCompiled.indexOf(' · ');
  const candidateMarketDataIndex = candidateCompiled.indexOf(' · Market data:');
  const editorialMarketDataIndex = editorialCompiled.indexOf(' · Market data:');
  const editorialContext = editorialFooterContextIndex >= 0 && editorialMarketDataIndex > editorialFooterContextIndex
    ? editorialCompiled.slice(editorialFooterContextIndex, editorialMarketDataIndex)
    : '';
  const footerContext = candidateMarketDataIndex >= 0
    ? `${editorialContext}${candidateCompiled.slice(candidateMarketDataIndex)}`
    : candidateFooterContextIndex >= 0 ? candidateCompiled.slice(candidateFooterContextIndex) : '';
  dashboardData.footer = {
    ...dashboardData.footer,
    compiled: `${candidateFooterContextIndex >= 0 ? candidateCompiled.slice(0, candidateFooterContextIndex) : candidateCompiled}${footerContext}`
  };
  const editorialWeekAheadDays = new Map(
    (Array.isArray(editorialDashboardData.weekAhead?.days) ? editorialDashboardData.weekAhead.days : [])
      .filter((day) => typeof day?.date === 'string')
      .map((day) => [day.date, day])
  );
  if (Array.isArray(dashboardData.weekAhead?.days)) {
    const candidateWeekAheadDates = new Set(dashboardData.weekAhead.days.map((day) => day.date));
    for (const date of editorialWeekAheadDays.keys()) {
      if (!candidateWeekAheadDates.has(date)) reviewManifest.systemFallbacks.push({ section: 'market-lens', path: `weekAhead.days.${date}`, action: 'omitted', reason: 'stale_editorial_item' });
    }
    dashboardData.weekAhead.days = dashboardData.weekAhead.days.map((day) => {
      const editorialDay = editorialWeekAheadDays.get(day.date);
      if (!editorialDay) {
        return day;
      }
      const next = { ...day };
      if (usableWeekAheadOutcome(editorialDay.outcome, reviewManifest.preparedAt)) {
        next.outcome = editorialDay.outcome;
      }
      return next;
    });
  }
  const finalizedEarnings = applyEditorialEarningsNarrative(
    dashboardData,
    candidateDashboardData,
    editorialDashboardData,
    reviewManifest.systemFallbacks,
    reviewManifest.preparedAt
  );
  applyEditionMetadata(dashboardData, args.windowMode);
  syncDashboardPricesFromChartData(dashboardData, candidateChartData, { windowMode: args.windowMode });
  normalizePublicationDisplaySections(dashboardData, { windowMode: args.windowMode, now: editorialNow });
  normalizeMarketLensReview(dashboardData, candidateChartData, reviewManifest, previousDashboardData.editorialReview, reviewManifest.systemFallbacks);
  normalizeVerifiedClaims(dashboardData, reviewManifest, previousDashboardData.editorialReview);
  const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
  if (reviewErrors.length) process.stderr.write(`Editorial review receipt will be best-effort: ${reviewErrors.join(' ')}\n`);
  applyMarketLensDecisionsData(dashboardData, candidateChartData, reviewManifest.marketLensDecisions);
  normalizeWeekAheadReactionButtons(dashboardData, candidateChartData);
  dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, candidateChartData, { windowMode: args.windowMode, now: scheduledNow() });
  normalizeWeekAheadReactionButtons(dashboardData, candidateChartData);
  const reviewChartData = compactChartPayload(candidateChartData);
  let nextHtml = replaceJsonBlock(canonicalHtml, 'chart-data', JSON.stringify(reviewChartData));
  dashboardData.weekAhead = finalizeWeekAheadOutcomes(dashboardData.weekAhead, { now: scheduledNow() });
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode, now: scheduledNow() });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, reviewManifest, reviewChartData);
  commitEditorialCandidate(args, nextHtml);
  if (finalizedEarnings && path.resolve(args.dashboard) === DEFAULT_DASHBOARD) {
    try {
      writeJson(EARNINGS_WEEK_PATH, finalizedEarnings.week);
      if (finalizedEarnings.narrativePayload) writeJson(EARNINGS_NARRATIVE_PATH, finalizedEarnings.narrativePayload);
    } catch (error) {
      process.stderr.write(`Dashboard was committed, but Earnings staging synchronization failed and will retry later: ${error.message}\n`);
    }
  }
}

function assertValidChartStagingPayload(payload, expectedRows, label, { requireSeries = false } = {}) {
  const errors = validateChartStagingPayload(payload, expectedRows);
  if (requireSeries && (!Array.isArray(payload?.series) || !payload.series.length)) {
    errors.unshift(`${label} must contain at least one series.`);
  }
  if (errors.length) throw new Error(`${label} is invalid: ${errors.join(' ')}`);
  return payload;
}

function chartSeriesRevisionContent(series) {
  const content = roundChartPayload({ series: [series] }).series[0];
  delete content.quoteRevision;
  delete content.availability;
  delete content.note;
  return content;
}

function chartSeriesRevisionErrors(previousChartData, nextChartData) {
  const previousByTicker = new Map((Array.isArray(previousChartData?.series) ? previousChartData.series : [])
    .map((series) => [String(series?.ticker || '').trim().toUpperCase(), series]));
  const errors = [];
  for (const nextSeries of roundChartPayload(nextChartData).series) {
    const ticker = String(nextSeries?.ticker || '').trim().toUpperCase();
    const previousSeries = previousByTicker.get(ticker);
    if (!previousSeries || previousSeries.quoteRevision !== nextSeries.quoteRevision) continue;
    if (!isDeepStrictEqual(chartSeriesRevisionContent(previousSeries), chartSeriesRevisionContent(nextSeries))) {
      errors.push(`Chart series ${ticker} changed deterministic content but reused quoteRevision ${nextSeries.quoteRevision}.`);
    }
  }
  return errors;
}

function assertChartSeriesRevisions(previousChartData, nextChartData, label) {
  const errors = chartSeriesRevisionErrors(previousChartData, nextChartData);
  if (errors.length) throw new Error(`${label} is invalid: ${errors.join(' ')}`);
}

function applyChartDataJson(args) {
  const { html, dashboardData } = loadFocusedRepairBase(args);
  const currentChartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  let chartData;
  try {
    chartData = roundChartPayload(readJson(args.applyChartDataJson));
    assertValidChartStagingPayload(chartData, dashboardData.tape?.rows || [], 'Chart focused apply input', { requireSeries: true });
    assertChartSeriesRevisions(currentChartData, chartData, 'Chart focused apply input');
  } catch (error) {
    process.stderr.write(`Chart focused apply input was unusable; carrying validated chart data: ${error.message}\n`);
    chartData = buildChartDataFallback(currentChartData, scheduledNow());
  }
  syncDashboardPricesFromChartData(dashboardData, chartData, {
    windowMode: args.windowMode,
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(chartData)
  });
  prepareCandidateNews(dashboardData);
  const embeddedChartData = compactChartPayload(chartData);
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(embeddedChartData));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  stageDashboardCandidate(args, nextHtml);
  reportPreparationStatus('candidate ready', `focused chart repair staged at ${args.candidate}; canonical dashboard unchanged`);
}

function applyEarningsWeekJson(args) {
  const { html, dashboardData } = loadFocusedRepairBase(args);
  let earningsWeek;
  try {
    earningsWeek = readJson(args.applyEarningsWeekJson);
    applyEarningsWeek(dashboardData, earningsWeek, { requireNarrative: false });
  } catch (error) {
    reportPreparationStatus('skipped', `Earnings focused preparation input was unusable; candidate and canonical dashboard unchanged: ${error.message}`);
    return;
  }
  const scheduleReviewPath = path.join(path.dirname(args.applyEarningsWeekJson), 'earnings_schedule_review.json');
  const scheduleReviews = pendingEarningsScheduleReviews(scheduleReviewPath, earningsWeek.range);
  reportPendingEarningsScheduleReviews(scheduleReviews);
  prepareCandidateNews(dashboardData);
  const nextHtml = patchDashboardDataBlock(html, dashboardData, null, null, { stampEdition: false });
  stageDashboardCandidate(args, nextHtml);
  reportPreparationStatus('candidate ready', `focused Earnings repair staged at ${args.candidate}; canonical dashboard unchanged`);
}

function reportPendingEarningsScheduleReviews(result) {
  for (const diagnostic of result.diagnostics || []) {
    process.stderr.write(`Earnings schedule-review warning (${diagnostic.code}): ${diagnostic.message}\n`);
  }
  if (!result.rows?.length) return;
  const labels = result.rows.map((row) => `${row.symbol} (${row.primaryDate})`).join(', ');
  process.stderr.write(`Earnings schedule review remains pending; retain Finnhub primary-only rows and research company investor relations before SEC: ${labels}\n`);
}

function mergeChartDataJson(args) {
  const { html, dashboardData } = loadFocusedRepairBase(args);
  const existingChartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  let incomingChartData;
  let chartData;
  try {
    incomingChartData = roundChartPayload(readJson(args.mergeChartDataJson));
    assertValidChartStagingPayload(incomingChartData, [], 'Chart merge input', { requireSeries: true });
    const incomingByTicker = new Map(incomingChartData.series.map((series) => [String(series?.ticker || '').toUpperCase(), series]));
    const existingTickers = new Set();
    const series = existingChartData.series.map((series) => {
      const ticker = String(series?.ticker || '').toUpperCase();
      existingTickers.add(ticker);
      return incomingByTicker.get(ticker) || series;
    });
    for (const [ticker, item] of incomingByTicker.entries()) {
      if (!existingTickers.has(ticker)) series.push(item);
    }
    chartData = {
      ...existingChartData,
      generatedAt: incomingChartData.generatedAt || scheduledNow().toISOString(),
      sourceFamilies: Array.from(new Set(series.map((item) => item?.source).filter(Boolean))),
      series
    };
    const availability = mergedChartAvailability(existingChartData, incomingChartData, series);
    if (availability) chartData.availability = availability;
    else delete chartData.availability;
    assertValidChartStagingPayload(chartData, dashboardData.tape?.rows || [], 'Completed Chart merge');
    assertChartSeriesRevisions(existingChartData, chartData, 'Completed Chart merge');
  } catch (error) {
    process.stderr.write(`Chart merge input was unusable; retaining validated chart data: ${error.message}\n`);
    incomingChartData = buildChartDataFallback(existingChartData, scheduledNow());
    chartData = incomingChartData;
  }
  syncDashboardPricesFromChartData(dashboardData, chartData, {
    windowMode: args.windowMode,
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(incomingChartData)
  });
  prepareCandidateNews(dashboardData);
  const embeddedChartData = compactChartPayload(chartData);
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(embeddedChartData));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  stageDashboardCandidate(args, nextHtml);
  reportPreparationStatus('candidate ready', `focused chart repair staged at ${args.candidate}; canonical dashboard unchanged`);
}

function syncChartQuotes(args) {
  const { html, dashboardData } = loadFocusedRepairBase(args);
  const chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
  prepareCandidateNews(dashboardData);
  const embeddedChartData = compactChartPayload(chartData);
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(embeddedChartData));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  stageDashboardCandidate(args, nextHtml);
  reportPreparationStatus('candidate ready', `chart quote synchronization staged at ${args.candidate}; canonical dashboard unchanged`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  args.calendarRolloverRange = calendarRolloverRange(args.windowMode);
  if (!fs.existsSync(args.dashboard)) {
    throw new Error(`Dashboard file not found: ${args.dashboard}`);
  }
  if (args.prepareEditorialDir && !fs.existsSync(args.candidate)) {
    throw new Error(`Staged dashboard candidate not found: ${args.candidate}. Run deterministic preparation first.`);
  }

  // Only scheduler-driven preparation owns the wall-clock guard. Finalization
  // rechecks completion without turning the start window into a deadline.
  if (args.scheduled && !args.applyDashboardDataJson) {
    try {
      validateScheduledStart(args.dashboard, args.windowMode);
    } catch (error) {
      reportPreparationStatus('skipped', `${error.message}; canonical dashboard unchanged`);
      return;
    }
  }

  if (args.prepareEditorialDir) {
    const workspace = prepareEditorialWorkspace(args);
    process.stdout.write(`Editorial workspace prepared at ${args.prepareEditorialDir} for ${workspace.reviewManifest.marketLensDecisions.length} event day(s).\n`);
    return;
  }

  if (args.syncChartQuotes) {
    syncChartQuotes(args);
    return;
  }

  if (args.applyEarningsWeekJson) {
    applyEarningsWeekJson(args);
    return;
  }

  if (args.applyChartDataJson) {
    applyChartDataJson(args);
    return;
  }

  if (args.mergeChartDataJson) {
    mergeChartDataJson(args);
    return;
  }

  if (args.applyDashboardDataJson) {
    applyDashboardDataJson(args);
    return;
  }

  reportPreparationStatus('preparing');

  const canonicalBase = loadDashboardBase(args.dashboard);
  args.baseDashboardHtml = canonicalBase.html;
  args.sourceDashboard = canonicalBase.sourcePath;
  const canonicalHtml = canonicalBase.html;
  const canonicalDashboardData = readJsonBlock(canonicalHtml, 'dashboard-data');
  const canonicalChartData = roundChartPayload(readJsonBlock(canonicalHtml, 'chart-data'));
  const checkedAt = scheduledNow();
  const localDate = chicagoDateParts(checkedAt).isoDate;

  const futuresArgs = ['scripts/fetch_chart_data.js', 'futures'];
  if (args.windowMode === 'afternoon') futuresArgs.push('--session');
  const futuresPreparation = runWithSectionFallback(
    () => runCommand('node', futuresArgs),
    () => buildUnavailableFuturesPayload(args.windowMode === 'afternoon' ? 'session' : 'premarket', checkedAt),
    {
      label: 'Futures',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'futures_module.json')),
      validateFresh: (payload) => validateFuturesPayload(payload, { expectedMode: args.windowMode === 'afternoon' ? 'session' : 'premarket' }),
      validateFallback: (payload) => validateFuturesPayload(payload, { expectedMode: args.windowMode === 'afternoon' ? 'session' : 'premarket' })
    }
  );
  args.futuresPayload = futuresPreparation.payload;
  if (futuresPreparation.error) {
    args.futuresFallbackPayload = futuresPreparation.fallback;
    reportSectionFallback('Futures', 'unavailable', futuresPreparation.error);
  }

  const chartCommandArgs = ['scripts/fetch_chart_data.js', '--input', args.sourceDashboard, '--as-of', checkedAt.toISOString()];
  const chartPreparation = runWithSectionFallback(
    () => runCommand('node', chartCommandArgs),
    () => buildChartDataFallback(canonicalChartData, checkedAt),
    {
      label: 'Chart and Tape',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'chart_data.json')),
      readFreshOnError: () => {
        const payload = readJson(path.join(GENERATED_DIR, 'chart_data.json'));
        if (payload?.generatedAt !== checkedAt.toISOString()) {
          throw new Error('Chart staging artifact does not belong to this preparation run.');
        }
        return payload;
      },
      validateFresh: (payload) => [
        ...validateChartStagingPayload(payload, readChartableRows(args.sourceDashboard)),
        ...chartSeriesRevisionErrors(canonicalChartData, payload)
      ],
      validateFallback: (payload) => validateChartStagingPayload(payload, readChartableRows(args.sourceDashboard))
    }
  );
  args.chartDataPayload = chartPreparation.payload;
  if (chartPreparation.error) {
    if (chartPreparation.recovered) {
      process.stderr.write(`Chart and Tape preparation did not finish; continuing with partial staged chart data: ${chartPreparation.error.message}\n`);
    } else {
      args.chartDataFallbackPayload = chartPreparation.fallback;
      reportSectionFallback('Chart and Tape', 'carried_forward', chartPreparation.error);
    }
  }

  const cryptoPreparation = runWithSectionFallback(
    () => runCommand('node', ['scripts/fetch_crypto_stats.js', '--input', args.sourceDashboard]),
    () => buildCryptoStatsFallback(canonicalDashboardData.crypto, checkedAt, 'source_refresh_failed', canonicalDashboardData.editionId),
    {
      label: 'Crypto stats',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'crypto_stats.json')),
      validateFresh: validateCryptoStatsPayload,
      validateFallback: validateCryptoStatsPayload
    }
  );
  args.cryptoStatsPayload = cryptoPreparation.payload;
  if (cryptoPreparation.error) {
    args.cryptoStatsFallbackPayload = cryptoPreparation.fallback;
    reportSectionFallback('Crypto stats', cryptoPreparation.fallback.availability.status, cryptoPreparation.error);
  }

  const portfolioPreparation = runWithSectionFallback(
    () => runCommand('node', ['scripts/fetch_asset_allocation.js', '--input', args.sourceDashboard, '--skip-summary']),
    () => buildAssetAllocationFallback(canonicalDashboardData.assetAllocationPortfolio, {
      month: localDate.slice(0, 7),
      asOf: localDate,
      checkedAt
    }),
    {
      label: 'Asset Allocation portfolio',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'asset_allocation_portfolio.json')),
      validateFresh: validateAssetAllocationPortfolioPayload,
      validateFallback: validateAssetAllocationPortfolioPayload
    }
  );
  args.assetAllocationPortfolioPayload = portfolioPreparation.payload;
  if (portfolioPreparation.error) {
    reportSectionFallback('Asset Allocation portfolio', portfolioPreparation.fallback.availability.status, portfolioPreparation.error);
  }

  const summaryPreparation = runWithSectionFallback(
    () => runCommand('node', ['scripts/fetch_asset_allocation.js', '--input', args.sourceDashboard, '--skip-portfolio']),
    () => buildAssetAllocationSummaryFallback(canonicalDashboardData.assetAllocationPortfolio, { asOf: localDate }),
    {
      label: 'Asset Allocation summary',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'asset_allocation_summary.json')),
      validateFresh: validateAssetAllocationSummaryPayload,
      validateFallback: validateAssetAllocationSummaryPayload
    }
  );
  args.assetAllocationSummaryPayload = summaryPreparation.payload;
  if (summaryPreparation.error) {
    reportSectionFallback('Asset Allocation summary', summaryPreparation.payload.stale ? 'carried_forward' : 'unavailable', summaryPreparation.error);
  }

  const canonicalWeekAhead = canonicalDashboardData.weekAhead || null;
  const weekAheadRange = args.calendarRolloverRange || canonicalWeekAhead?.range;
  const invalidPersistedWeekAhead = weekAheadStagingNeedsRebuild(WEEK_AHEAD_PATH);
  if (invalidPersistedWeekAhead) {
    process.stderr.write('Week Ahead staging artifact is invalid under the current contract; rebuilding the active range.\n');
  }
  const weekAheadArgs = ['scripts/fetch_week_ahead.js'];
  if (args.calendarRolloverRange || requiresUnavailableRolloverRetry(canonicalWeekAhead) || invalidPersistedWeekAhead) weekAheadArgs.push('--date', weekAheadRange.from);
  else weekAheadArgs.push('--refresh-values', '--input', WEEK_AHEAD_PATH);
  const weekAheadPreparation = runWithSectionFallback(
    () => runCommand('node', weekAheadArgs),
    () => buildWeekAheadPreparationFallback(canonicalWeekAhead, weekAheadRange, { checkedAt }),
    {
      label: 'Week Ahead',
      readFresh: () => readJson(WEEK_AHEAD_PATH),
      validateFresh: validateWeekAheadPayload,
      validateFallback: (payload) => validateWeekAheadPayload(payload.week)
    }
  );
  args.weekAheadPayload = weekAheadPreparation.error ? weekAheadPreparation.fallback.week : weekAheadPreparation.payload;
  if (weekAheadPreparation.error) {
    args.weekAheadFallbackPayload = weekAheadPreparation.fallback.week;
    reportSectionFallback('Week Ahead', weekAheadPreparation.fallback.mode, weekAheadPreparation.error);
  }

  const canonicalWeek = canonicalDashboardData.earnings?.week || null;
  const earningsRange = earningsTargetRange(args, canonicalWeek);
  const earningsPreparation = runWithSectionFallback(() => {
    const invalidPersistedArtifact = earningsStagingNeedsRebuild(EARNINGS_WEEK_PATH, checkedAt);
    if (invalidPersistedArtifact) {
      process.stderr.write('Earnings staging artifact is invalid under the current contract; evaluating an authorized rebuild or active-range fallback.\n');
    }
    const calendarNeedsBuild = earningsCalendarNeedsBuild(earningsRange, EARNINGS_WEEK_PATH, checkedAt);
    const failedAttemptNeedsRetry = earningsCalendarFailedAttemptNeedsRetry(earningsRange, EARNINGS_WEEK_PATH, checkedAt);
    const buildDecision = earningsCalendarBuildDecision(args, {
      canonicalWeek,
      invalidPersistedArtifact,
      calendarNeedsBuild,
      failedAttemptNeedsRetry
    });
    if (buildDecision.blocked) {
      throw new Error('Earnings calendar rebuild is not authorized for this run; retaining the validated active-range section. Use --rebuild-earnings-calendar only for an intentional manual rebuild.');
    }
    if (buildDecision.build) {
      runCommand('node', [
        'scripts/earnings_week.js',
        'build',
        '--from', earningsRange.from,
        '--to', earningsRange.to,
        '--as-of', checkedAt.toISOString()
      ], { timeoutMs: EARNINGS_COMMAND_TIMEOUT_MS });
    }
    reportPendingEarningsScheduleReviews(pendingEarningsScheduleReviews(undefined, earningsRange));
    runCommand('node', [
      'scripts/earnings_week.js',
      'refresh',
      '--as-of', checkedAt.toISOString()
    ], { timeoutMs: EARNINGS_COMMAND_TIMEOUT_MS });
  }, () => buildEarningsPreparationFallback(canonicalWeek, earningsRange, { checkedAt }), {
    label: 'Earnings',
    readFresh: () => readJson(EARNINGS_WEEK_PATH),
    readFreshOnError: () => readCurrentEarningsWeekArtifact(earningsRange, checkedAt),
    validateFresh: (payload) => validateEarningsWeekPayload(payload),
    validateFallback: (payload) => validateEarningsWeekPayload(payload.week)
  });
  if (earningsPreparation.error) {
    if (earningsPreparation.recovered) {
      args.earningsWeekPayload = earningsPreparation.payload;
      process.stderr.write(`Earnings preparation did not finish; continuing with staged earnings week: ${earningsPreparation.error.message}\n`);
    } else {
      args.earningsFallbackWeek = earningsPreparation.fallback.week;
      process.stderr.write(`Earnings preparation failed; continuing with ${earningsPreparation.fallback.mode} section fallback: ${earningsPreparation.error.message}\n`);
    }
  } else {
    args.earningsWeekPayload = earningsPreparation.payload;
  }

  stageDashboardCandidate(args, patchDashboard(args));
  reportPreparationStatus('candidate ready', `staged at ${args.candidate}; canonical dashboard unchanged`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (!failIncompletePreparation(error.message)) {
      process.stderr.write(`run_daily_update failed: ${error.message}\n`);
      process.exitCode = error.exitCode || 1;
    }
  }
}

module.exports = {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  calendarRolloverRange,
  applyDashboardDataJson,
  applyEditorialEarningsNarrative,
  applyMarketLensDecisionsData,
  applyChartDataJson,
  mergeChartDataJson,
  mergedChartAvailability,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyEarningsWeek,
  applyFuturesModule,
  applyWeekAhead,
  commitDashboardCandidate,
  applyEditionMetadata,
  chicagoDateParts,
  applyTapeQuoteRows,
  syncDashboardPricesFromChartData,
  patchDashboardDataBlock,
  patchDashboard,
  prepareEditorialWorkspace,
  normalizePublicationDisplaySections,
  loadDashboardBase,
  readJsonBlock,
  replaceJsonBlock,
  requiresUnavailableRolloverRetry,
  earningsStagingNeedsRebuild,
  readCurrentEarningsWeekArtifact,
  earningsTargetRange,
  earningsCalendarBuildDecision,
  weekAheadStagingNeedsRebuild,
  runCommand,
  runWithSectionFallback,
  reportPreparationStatus,
  stampDashboardEdition,
  stageDashboardCandidate,
  validateScheduledFinalization,
  validateScheduledStart
};
