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
  isDisplayEligibleEarningsRow,
  mergeUnchangedEarningsNarrative,
  narrativeEditorialComplete,
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
const { addDays, isIsoDateTime } = require('./calendar_contract');
const {
  TAPE_COMMENTARY_UNAVAILABLE_NOTE,
  buildEditorialReview,
  containsTapeCitationSyntax,
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
let preparationInProgress = false;

function reportPreparationStatus(status, detail = '') {
  process.stdout.write(`Preparation status: ${status}${detail ? ` — ${detail}` : ''}\n`);
}

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
    skipEarnings: false,
    skipFutures: false,
    skipChartData: false,
    skipCryptoStats: false,
    skipAssetAllocationPortfolio: false,
    skipAssetAllocationSummary: false,
    skipWeekAhead: false,
    scheduled: false,
    testSkipValidation: false
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
    if (arg === '--skip-earnings') {
      args.skipEarnings = true;
      continue;
    }
    if (arg === '--skip-futures') {
      args.skipFutures = true;
      continue;
    }
    if (arg === '--skip-chart-data') {
      args.skipChartData = true;
      continue;
    }
    if (arg === '--skip-crypto-stats') {
      args.skipCryptoStats = true;
      continue;
    }
    if (arg === '--skip-asset-allocation-portfolio') {
      args.skipAssetAllocationPortfolio = true;
      continue;
    }
    if (arg === '--skip-asset-allocation-summary') {
      args.skipAssetAllocationSummary = true;
      continue;
    }
    if (arg === '--skip-asset-allocation') {
      args.skipAssetAllocationPortfolio = true;
      args.skipAssetAllocationSummary = true;
      continue;
    }
    if (arg === '--skip-week-ahead') {
      args.skipWeekAhead = true;
      continue;
    }
    if (arg === '--test-skip-validation') {
      args.testSkipValidation = true;
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
  if (args.rebuildEarningsCalendar && (!deterministicPreparation || args.skipEarnings)) {
    throw new Error('--rebuild-earnings-calendar is valid only with deterministic preparation when Earnings is enabled.');
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
  --skip-earnings                     Skip earnings week refresh + orchestrated embed
  --skip-futures                      Skip node scripts/fetch_chart_data.js futures and futuresModule patching
  --skip-chart-data                   Skip node scripts/fetch_chart_data.js and chart/quote-row patching
  --skip-crypto-stats                 Skip node scripts/fetch_crypto_stats.js and crypto.stats[] patching
  --skip-asset-allocation-portfolio   Skip Asset Allocation ETF row fetch and patching
  --skip-asset-allocation-summary     Skip Asset Allocation summary refresh/import and patching
  --skip-asset-allocation             Skip both asset-allocation fetchers and patch steps
  --skip-week-ahead                   Skip Week Ahead slate/value refresh and patching
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

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
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
    const fallback = buildFallback(error);
    const fallbackErrors = options.validateFallback ? options.validateFallback(fallback) : [];
    if (fallbackErrors?.length) {
      throw new Error(`${options.label || 'Section'} fallback is invalid after ${error.message}: ${fallbackErrors.join(' ')}`);
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
    if (!isDisplayEligibleEarningsRow(row)) return row;
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
    schemaVersion: 1,
    generatedAt: asOf.toISOString(),
    finishedAt: asOf.toISOString(),
    eligibleDates: [...eligibleDates].sort(),
    sourceCatalog: APPROVED_NEWS_SOURCES,
    attempts: [{
      id: 'news-worker',
      provider: 'gdelt-doc',
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

function prepareNewsCandidatesForEditorial(asOf, args, dashboardData) {
  try {
    runCommand('node', [
      'scripts/fetch_news_candidates.js',
      '--as-of', asOf.toISOString(),
      '--input', args.candidate,
      '--output', NEWS_CANDIDATES_PATH,
      ...(args.windowMode ? [`--${args.windowMode}`] : [])
    ]);
    const artifact = readJson(NEWS_CANDIDATES_PATH);
    if (!Array.isArray(artifact?.attempts)
      || !Array.isArray(artifact?.generalCandidates)
      || !Array.isArray(artifact?.cryptoCandidates)) {
      throw new Error('News candidate artifact is malformed.');
    }
    return artifact;
  } catch (error) {
    process.stderr.write(`News candidate acquisition failed; continuing with still-fresh prior cards: ${error.message}\n`);
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

function patchDashboardDataBlock(html, dashboardData, reviewManifest = null, reviewChartData = null, { stampEdition = true } = {}) {
  const stampedData = stampEdition ? stampDashboardEdition(dashboardData) : { ...dashboardData };
  delete stampedData.editorialReview;
  if (reviewManifest) buildEditorialReview(stampedData, reviewManifest, reviewChartData);
  return replaceJsonBlock(html, 'dashboard-data', `\n${JSON.stringify(stampedData, null, 2)}\n`);
}

function commitDashboardCandidate(args, nextHtml, {
  requireEditorialReview = false,
  refreshLastGood = path.resolve(args.dashboard) === DEFAULT_DASHBOARD,
  lastGoodPath = LAST_GOOD_DASHBOARD,
  snapshotWriter = atomicWriteFile
} = {}) {
  if (args.testSkipValidation && process.env.DASHBOARD_TEST_MODE !== '1') {
    throw new Error('--test-skip-validation requires DASHBOARD_TEST_MODE=1.');
  }
  if (args.testSkipValidation && path.resolve(args.dashboard) === DEFAULT_DASHBOARD) {
    throw new Error('--test-skip-validation cannot target the canonical dashboard.');
  }
  const directory = path.dirname(args.dashboard);
  const candidate = path.join(directory, `.${path.basename(args.dashboard)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(candidate, nextHtml, { mode: fs.statSync(args.dashboard).mode });
    if (!args.testSkipValidation) {
      const validationArgs = [path.resolve(__dirname, 'validate_dashboard.js'), candidate];
      if (requireEditorialReview) validationArgs.push('--require-editorial-review');
      const result = spawnSync(process.execPath, validationArgs, {
        cwd: ROOT,
        stdio: 'inherit'
      });
      if (result.status !== 0) throw new Error('Editorial candidate failed validation; the published dashboard was not changed.');
    }
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
  commitDashboardCandidate(args, nextHtml, { requireEditorialReview: true });
}

function stageDashboardCandidate(args, nextHtml) {
  if (args.testSkipValidation && process.env.DASHBOARD_TEST_MODE !== '1') {
    throw new Error('--test-skip-validation requires DASHBOARD_TEST_MODE=1.');
  }
  if (args.testSkipValidation && path.resolve(args.dashboard) === DEFAULT_DASHBOARD) {
    throw new Error('--test-skip-validation cannot target the canonical dashboard.');
  }
  fs.mkdirSync(path.dirname(args.candidate), { recursive: true });
  const temporary = `${args.candidate}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, nextHtml, { mode: fs.statSync(args.dashboard).mode });
    if (!args.testSkipValidation) {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, 'validate_dashboard.js'), temporary, '--staging-candidate'], {
        cwd: ROOT,
        stdio: 'inherit'
      });
      if (result.status !== 0) throw new Error('Deterministic candidate failed validation; the canonical dashboard was not changed.');
    }
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
  if (!data.crypto || typeof data.crypto !== 'object') {
    throw new Error('dashboard-data crypto payload is missing.');
  }
  const stats = payload?.stats;
  const unavailable = payload?.availability?.status === 'unavailable';
  if (!Array.isArray(stats) || (!stats.length && !unavailable)) {
    throw new Error('Generated crypto stats payload is missing stats[].');
  }
  data.crypto.stats = stats;
  if (payload.availability) data.crypto.availability = payload.availability;
  else delete data.crypto.availability;
}

function applyEarningsWeek(data, earningsWeek, { requireNarrative = true } = {}) {
  const canonicalEarningsWeek = mergeUnchangedEarningsNarrative(data.earnings?.week, earningsWeek);
  delete canonicalEarningsWeek.policy;
  delete canonicalEarningsWeek.outputPath;
  if (!requireNarrative) delete canonicalEarningsWeek.narrativeApply;
  const errors = validateEarningsWeekPayload(canonicalEarningsWeek, { requireNarrative });
  if (errors.length) {
    throw new Error(`Generated earnings week payload is invalid: ${errors.join(' ')}`);
  }
  data.earnings = {
    label: 'Earnings · Week Monitor',
    week: canonicalEarningsWeek
  };
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
  if (errors.length) throw new Error(`Generated Futures staging payload is invalid: ${errors.join(' ')}`);
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
    throw new Error('Generated asset allocation portfolio payload is missing rows[].');
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
  if (data.weekAhead) data.weekAhead = applyWeekAheadLifecycle(data.weekAhead, chartData, { windowMode, now });
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
    const message = messages.get(ticker);
    if (!message) throw new Error(`Merged chart series ${ticker} is carried forward without source failure diagnostics.`);
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

  if (!args.skipChartData) {
    chartData = roundChartPayload(args.chartDataPayload || args.chartDataFallbackPayload || readJson(path.join(GENERATED_DIR, 'chart_data.json')));
    // chart-data.series is the canonical price history; quoteRows and dashboard tape prices are derived views.
    syncDashboardPricesFromChartData(dashboardData, chartData, {
      windowMode: args.windowMode,
      resetCommentary: true,
      commentaryTickers: acceptedFreshChartTickers(chartData)
    });
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  }

  if (!args.skipFutures) {
    const futuresPayload = args.futuresPayload || args.futuresFallbackPayload || readJson(path.join(GENERATED_DIR, 'futures_module.json'));
    applyFuturesModule(dashboardData, futuresPayload, args.windowMode);
  }

  if (!args.skipCryptoStats) {
    const cryptoPayload = args.cryptoStatsPayload || args.cryptoStatsFallbackPayload || readJson(path.join(GENERATED_DIR, 'crypto_stats.json'));
    applyCryptoStats(dashboardData, cryptoPayload);
  } else if (args.windowMode) {
    applyCryptoStats(dashboardData, buildCryptoStatsFallback(dashboardData.crypto, scheduledNow(), 'source_refresh_skipped'));
  }

  if (!args.skipAssetAllocationPortfolio) {
    const portfolioPayload = args.assetAllocationPortfolioPayload || readJson(path.join(GENERATED_DIR, 'asset_allocation_portfolio.json'));
    applyAssetAllocationPortfolio(dashboardData, portfolioPayload);
  }

  if (!args.skipAssetAllocationSummary) {
    const summaryPayload = args.assetAllocationSummaryPayload || readJson(path.join(GENERATED_DIR, 'asset_allocation_summary.json'));
    applyAssetAllocationSummary(dashboardData, summaryPayload);
  }

  if (!args.skipWeekAhead) {
    applyWeekAhead(dashboardData, args.weekAheadPayload || args.weekAheadFallbackPayload || readJson(WEEK_AHEAD_PATH));
    dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
  }

  if (args.earningsFallbackWeek) {
    applyEarningsWeek(dashboardData, args.earningsFallbackWeek, { requireNarrative: false });
  } else if (!args.skipEarnings) {
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
  const tapeTickers = new Set((Array.isArray(data?.tape?.rows) ? data.tape.rows : []).map((row) => String(row?.ticker || '').toUpperCase()));
  const chartTickers = new Set((Array.isArray(chartData?.series) ? chartData.series : []).map((series) => String(series?.ticker || '').toUpperCase()));
  const storyUrls = new Set([
    ...(Array.isArray(data?.stories) ? data.stories : []),
    ...(Array.isArray(data?.crypto?.notes) ? data.crypto.notes : []),
    ...(Array.isArray(data?.futuresModule?.stories) ? data.futuresModule.stories : [])
  ].map((story) => String(story?.url || '')).filter(Boolean));
  const errors = [];
  for (const reaction of lens.reactions || []) {
    if (!tapeTickers.has(reaction.ticker)) errors.push(`reaction ticker ${reaction.ticker} is not present in tape.rows.`);
    if (!chartTickers.has(reaction.ticker)) errors.push(`reaction ticker ${reaction.ticker} has no embedded chart series.`);
  }
  for (const reference of lens.setup?.evidence || []) {
    if (reference.kind === 'opening' && !String(data?.opening?.[reference.field] || '').trim()) errors.push(`opening.${reference.field} evidence is unavailable.`);
    if (reference.kind === 'tape' && !tapeTickers.has(reference.ticker)) errors.push(`Tape evidence ${reference.ticker} is unavailable.`);
    if (reference.kind === 'story' && !storyUrls.has(reference.url)) errors.push(`Story evidence ${reference.url} is unavailable.`);
  }
  return errors;
}

function applyMarketLensDecisionsData(data, chartData, payload) {
  data.weekAhead = applyMarketLensDecisions(data.weekAhead, payload, {
    validateEditorialReferences: (lens) => validateMarketLensDashboardReferences(data, chartData, lens)
  });
  return data;
}

function normalizeMarketLensReview(data, chartData, reviewManifest, priorReview = null, systemFallbacks = null) {
  void systemFallbacks;
  const verifiedTexts = new Set([
    ...(Array.isArray(reviewManifest.verifiedClaims) ? reviewManifest.verifiedClaims : []),
    ...(Array.isArray(priorReview?.verifiedClaims) ? priorReview.verifiedClaims : [])
  ].filter((claim) => /^https:\/\//i.test(String(claim?.evidenceUrl || ''))).map((claim) => String(claim.text || '').trim()));
  const submitted = Array.isArray(reviewManifest.marketLensDecisions) ? reviewManifest.marketLensDecisions : [];
  const eventDays = (data.weekAhead?.days || []).filter((day) => Array.isArray(day?.events) && day.events.length);
  const decisionsByDate = new Map();
  for (const decision of submitted) {
    if (!decision?.date || decisionsByDate.has(decision.date)) {
      throw new Error('Market Lens decisions must contain exactly one decision per event day.');
    }
    decisionsByDate.set(decision.date, decision);
  }
  for (const day of eventDays) {
    const decision = decisionsByDate.get(day.date);
    if (!decision) throw new Error(`Market Lens editorial work is incomplete for ${day.date}.`);
    if (['released_awaiting_close', 'close_available'].includes(day.lifecycle)
      && decision.action !== 'replace') {
      throw new Error(`Released event commentary is incomplete for ${day.date}. Supply current editorial interpretation.`);
    }
    if (!['replace', 'retain-generated'].includes(decision.action)) {
      throw new Error(`Market Lens decision for ${day.date} is incomplete.`);
    }
  }
  if (decisionsByDate.size !== eventDays.length) throw new Error('Market Lens decisions contain stale event days.');
  const requested = submitted.map((decision) => {
    if (decision?.action !== 'replace') return decision;
    const lensTexts = [
      decision.marketLens?.question,
      decision.marketLens?.title,
      decision.marketLens?.body,
      decision.marketLens?.setup?.statement,
      decision.marketLens?.scenarios?.reinforces,
      decision.marketLens?.scenarios?.challenges
    ].filter((value) => typeof value === 'string' && value.trim());
    if (lensTexts.some((value) => EDITORIAL_SUPERLATIVE_PATTERN.test(value) && !verifiedTexts.has(value.trim()))) {
      throw new Error(`Market Lens replacement for ${decision.date} contains an unverified superlative.`);
    }
    return decision;
  });
  const normalized = normalizeMarketLensDecisions(data.weekAhead, requested, {
    validateEditorialReferences: (lens) => validateMarketLensDashboardReferences(data, chartData, lens)
  });
  for (const decision of normalized) {
    if (decision.action !== decisionsByDate.get(decision.date)?.action) {
      throw new Error(`Market Lens decision for ${decision.date} is invalid for the current dashboard payload.`);
    }
  }
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
    if (currentTexts.has(text) && EDITORIAL_SUPERLATIVE_PATTERN.test(text) && /^https:\/\//i.test(evidenceUrl)) {
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
    .filter(isDisplayEligibleEarningsRow)
    .map((row) => earningsNarrativeItem(editorialRowsByKey.get(earningsNarrativeRowKey(row)) || {
      symbol: row.symbol,
      reportDate: row.reportDate,
      eps: {}, revenue: {}, outcome: {}, reaction: {}
    }));
  const candidateRowsByKey = new Map((candidateWeek.rows || []).map((row) => [earningsNarrativeRowKey(row), row]));
  const incomplete = rows.filter((item) => {
    const row = candidateRowsByKey.get(earningsNarrativeRowKey(item));
    return Boolean(row && !narrativeEditorialComplete(row, item));
  });
  if (incomplete.length) {
    const identities = incomplete.map((row) => `${row.symbol} ${row.reportDate}`).join(', ');
    throw new Error(`Earnings editorial work is incomplete for ${incomplete.length} visible row(s): ${identities}. Supply reviewed copy before finalization.`);
  }
  const outputPath = 'generated/editorial/dashboard-data.json';
  const narrativePayload = {
    schemaVersion: 1,
    sourceArtifact: 'generated/earnings_week.json',
    sourceGeneratedAt: candidateWeek.generatedAt,
    sourceRange: candidateWeek.range,
    rows,
    outputPath
  };
  const finalWeek = rows.length
    ? applyEarningsNarrative(candidateWeek, narrativePayload, {
        sourceArtifact: 'generated/earnings_week.json',
        narrativeArtifact: outputPath,
        appliedAt: scheduledNow()
      })
    : structuredClone(candidateWeek);
  const errors = validateEarningsWeekPayload(finalWeek, { requireNarrative: true });
  if (errors.length) throw new Error(`Editorial Earnings narrative is incomplete or invalid: ${errors.join(' ')}`);
  void systemFallbacks;
  void attemptThreshold;
  dashboardData.earnings = {
    ...candidateDashboardData.earnings,
    week: finalWeek
  };
  return { narrativePayload: rows.length ? narrativePayload : null, week: finalWeek };
}

const EDITORIAL_SUPERLATIVE_PATTERN = /\b(?:record(?:\s+(?:closes?|highs?|lows?|sales?))?|all[- ]time|fresh highs?|new highs?)\b/i;

function safeEditorialText(value, fallback, verifiedClaims, systemFallbacks = null, section = '', pathName = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || (EDITORIAL_SUPERLATIVE_PATTERN.test(text) && !verifiedClaims.has(text))) {
    if (Array.isArray(systemFallbacks) && value !== fallback) {
      systemFallbacks.push({
        section,
        path: pathName,
        action: 'retained_candidate',
        reason: text ? 'unsupported_claim' : 'editorial_content_unavailable'
      });
    }
    return fallback;
  }
  return value;
}

function sanitizeOpening(candidate, editorial, verifiedClaims, systemFallbacks = null) {
  const candidateCatalysts = Array.isArray(candidate?.catalysts) ? candidate.catalysts : [];
  const editorialCatalysts = Array.isArray(editorial?.catalysts) ? editorial.catalysts : [];
  if (Array.isArray(systemFallbacks) && editorialCatalysts.length > candidateCatalysts.length) {
    for (let index = candidateCatalysts.length; index < editorialCatalysts.length; index += 1) {
      systemFallbacks.push({ section: 'opening', path: `opening.catalysts[${index}]`, action: 'omitted', reason: 'unsupported_editorial_item' });
    }
  }
  return {
    ...candidate,
    headline: safeEditorialText(editorial?.headline, candidate?.headline, verifiedClaims, systemFallbacks, 'opening', 'opening.headline'),
    deck: safeEditorialText(editorial?.deck, candidate?.deck, verifiedClaims, systemFallbacks, 'opening', 'opening.deck'),
    catalysts: candidateCatalysts.map((prior, index) => {
      const next = editorialCatalysts[index];
      if (!next || typeof next !== 'object') {
        if (Array.isArray(systemFallbacks)) systemFallbacks.push({ section: 'opening', path: `opening.catalysts[${index}]`, action: 'retained_candidate', reason: 'editorial_content_unavailable' });
        return prior;
      }
      return {
        ...prior,
        label: safeEditorialText(next.label, prior?.label, verifiedClaims, systemFallbacks, 'opening', `opening.catalysts[${index}].label`),
        body: safeEditorialText(next.body, prior?.body, verifiedClaims, systemFallbacks, 'opening', `opening.catalysts[${index}].body`)
      };
    })
  };
}

function finalizeOpeningEditorial(candidate, editorial, reviewManifest, verifiedClaims) {
  const decision = reviewManifest.openingDecision;
  if (decision?.action === 'reviewed') {
    const fallbacks = [];
    const opening = sanitizeOpening(candidate, editorial, verifiedClaims, fallbacks);
    if (fallbacks.length) {
      throw new Error('Opening editorial review is incomplete or invalid. Correct the handoff before finalization.');
    }
    return opening;
  }
  throw new Error('Opening editorial work is incomplete. Complete and mark the Opening reviewed before finalization.');
}

function structurallyUsableStory(item, options = {}) {
  const { crypto = false, futures = false, verifiedClaims = new Set() } = options;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.referencePage !== undefined) return false;
  const label = crypto ? item.kicker : item.tag;
  if (typeof label !== 'string' || !label.trim() || typeof item.title !== 'string' || !item.title.trim() || typeof item.body !== 'string' || !item.body.trim()) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.publishedOn || ''))) return false;
  if (options.allowedDates instanceof Set
    && !options.allowedDates.has(item.publishedOn)
    && !options.additionalAllowedDates?.has(item.publishedOn)) return false;
  if (futures && String(item.tag || '').trim().length > 24) return false;
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
  if (!crypto && /^(crypto)$/i.test(String(item.tag || item.tone || '').trim())) return false;
  return ![item.title, item.body].some((text) => EDITORIAL_SUPERLATIVE_PATTERN.test(text) && !verifiedClaims.has(text.trim()));
}

function sanitizeStoryList(editorial, candidate, options = {}) {
  if (!Array.isArray(editorial)) {
    if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: options.path, action: 'retained_candidate', reason: 'editorial_content_unavailable' });
    return structuredClone(Array.isArray(candidate) ? candidate : []);
  }
  const seen = new Set();
  const seenUrls = new Set();
  const seenTitles = new Set();
  return editorial.filter((item, index) => {
    if (!structurallyUsableStory(item, options)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'invalid_editorial_item' });
      return false;
    }
    const identity = storyIdentity(item);
    const url = canonicalStoryUrl(item.url);
    const title = String(item.title || '').trim().toLowerCase();
    if (!identity || seen.has(identity) || seenUrls.has(url) || seenTitles.has(title)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'duplicate_editorial_item' });
      return false;
    }
    if (seen.size >= (options.maximum || Infinity)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'section_limit' });
      return false;
    }
    seen.add(identity);
    seenUrls.add(url);
    seenTitles.add(title);
    return true;
  });
}

function usableTapeCommentary(row, note) {
  const text = String(note || '').trim();
  return text !== TAPE_COMMENTARY_UNAVAILABLE_NOTE
    && Boolean(text)
    && !containsTapeCitationSyntax(text)
    && ![row.last, row.delta, row.pct].some((value) => value && text.includes(String(value)));
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

    throw new Error(`Tape editorial work is incomplete for ${ticker}. Supply current commentary before finalization.`);
  });
}

function usableWeekAheadOutcome(outcome, attemptThreshold) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  void attemptThreshold;
  return outcome.status === 'verified'
    && outcome.source === 'editorial'
    && Boolean(String(outcome.title || '').trim() && String(outcome.body || '').trim());
}

function applyDashboardDataJson(args) {
  const canonicalHtml = loadDashboardBase(args.dashboard).html;
  const candidateHtml = fs.readFileSync(args.candidate, 'utf8');
  const candidateDashboardData = readJsonBlock(candidateHtml, 'dashboard-data');
  if (args.scheduled) validateScheduledFinalization(args.dashboard, args.windowMode);
  const previousDashboardData = assertCandidateMatchesCanonical(args, candidateDashboardData);
  assertChartSeriesRevisions(
    roundChartPayload(readJsonBlock(canonicalHtml, 'chart-data')),
    roundChartPayload(readJsonBlock(candidateHtml, 'chart-data')),
    'Staged dashboard candidate'
  );
  const editorialDashboardData = readJson(args.applyDashboardDataJson);
  let reviewManifest = { ...editorialDashboardData.editorialReview, reviewedAt: scheduledNow().toISOString() };
  reviewManifest.systemFallbacks = [];
  if (editorialDashboardData.editionId !== candidateDashboardData.editionId) {
    throw new Error('Editorial dashboard-data editionId must match the staged candidate; regenerate the editorial handoff.');
  }
  if (!isIsoDateTime(reviewManifest.preparedAt)) {
    throw new Error('Editorial dashboard-data must retain the generated editorialReview.preparedAt timestamp.');
  }
  const dashboardData = structuredClone(candidateDashboardData);
  const editorialNow = scheduledNow();
  const freshStoryDates = allowedNewsDates(editorialNow);
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
    stories: sanitizeStoryList(editorialDashboardData.futuresModule?.stories, candidateDashboardData.futuresModule?.stories, {
      futures: true,
      systemFallbacks: reviewManifest.systemFallbacks,
      section: 'futures-news',
      path: 'futuresModule.stories',
      verifiedClaims,
      allowedDates: freshStoryDates,
      additionalAllowedDates: new Set([sharedFuturesSessionDate(candidateDashboardData.futuresModule?.futures)].filter(Boolean)),
      futuresWindow: futuresStoryPublicationWindow(
        candidateDashboardData.futuresModule?.sectionTitle,
        editorialNow.toISOString(),
        editorialNow,
        candidateDashboardData.futuresModule?.futures
      ),
      maximum: 3
    })
  };
  const promotedStoryIds = new Set(dashboardData.futuresModule.stories.map(storyIdentity));
  const promotedStoryUrls = new Set(dashboardData.futuresModule.stories.map((story) => canonicalStoryUrl(story.url)));
  const promotedStoryTitles = new Set(dashboardData.futuresModule.stories.map((story) => String(story.title || '').trim().toLowerCase()));
  const sanitizedStories = sanitizeStoryList(editorialDashboardData.stories, candidateDashboardData.stories, {
    verifiedClaims,
    systemFallbacks: reviewManifest.systemFallbacks,
    section: 'stories',
    path: 'stories',
    allowedDates: freshStoryDates,
    maximum: 9
  });
  dashboardData.stories = sanitizedStories.filter((story, index) => {
    const duplicate = promotedStoryIds.has(storyIdentity(story))
      || promotedStoryUrls.has(canonicalStoryUrl(story.url))
      || promotedStoryTitles.has(String(story.title || '').trim().toLowerCase());
    if (duplicate) reviewManifest.systemFallbacks.push({ section: 'stories', path: `stories.accepted[${index}]`, action: 'omitted', reason: 'promoted_story_duplicate' });
    return !duplicate;
  });
  const generalStoryIds = new Set(dashboardData.stories.map(storyIdentity));
  const sanitizedCryptoNotes = sanitizeStoryList(editorialDashboardData.crypto?.notes, candidateDashboardData.crypto?.notes, {
    crypto: true,
    systemFallbacks: reviewManifest.systemFallbacks,
    section: 'crypto',
    path: 'crypto.notes',
    verifiedClaims,
    allowedDates: freshStoryDates,
    maximum: 6
  });
  dashboardData.crypto = {
    ...dashboardData.crypto,
    notes: sanitizedCryptoNotes.filter((story, index) => {
      const duplicate = promotedStoryIds.has(storyIdentity(story)) || generalStoryIds.has(storyIdentity(story));
      if (duplicate) reviewManifest.systemFallbacks.push({ section: 'crypto', path: `crypto.notes.accepted[${index}]`, action: 'omitted', reason: 'cross_section_duplicate' });
      return !duplicate;
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
        if (day.lifecycle === 'close_available') throw new Error(`Week Ahead editorial work is incomplete for ${day.date}.`);
        return day;
      }
      const next = { ...day };
      if (usableWeekAheadOutcome(editorialDay.outcome, reviewManifest.preparedAt)) {
        next.outcome = editorialDay.outcome;
      } else if (day.lifecycle === 'close_available') {
        throw new Error(`Week Ahead editorial work is incomplete for ${day.date}. Supply current editorial interpretation.`);
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
  let reviewChartData;
  let nextHtml = canonicalHtml;
  try {
    const chartData = roundChartPayload(readJsonBlock(candidateHtml, 'chart-data'));
    syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
    normalizeMarketLensReview(dashboardData, chartData, reviewManifest, previousDashboardData.editorialReview, reviewManifest.systemFallbacks);
    normalizeVerifiedClaims(dashboardData, reviewManifest, previousDashboardData.editorialReview);
    const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
    if (reviewErrors.length) throw new Error(`Editorial review is incomplete or invalid: ${reviewErrors.join(' ')}`);
    applyMarketLensDecisionsData(dashboardData, chartData, reviewManifest.marketLensDecisions);
    dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
    reviewChartData = compactChartPayload(chartData);
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(reviewChartData));
  } catch (error) {
    // dashboard-data-only maintenance still works on staging fixtures that omit chart-data.
    if (/chart-data JSON block/.test(String(error?.message || ''))) {
      reviewChartData = { schemaVersion: 1, series: [] };
      normalizeMarketLensReview(dashboardData, reviewChartData, reviewManifest, previousDashboardData.editorialReview, reviewManifest.systemFallbacks);
      normalizeVerifiedClaims(dashboardData, reviewManifest, previousDashboardData.editorialReview);
      const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
      if (reviewErrors.length) throw new Error(`Editorial review is incomplete or invalid: ${reviewErrors.join(' ')}`);
      applyMarketLensDecisionsData(dashboardData, reviewChartData, reviewManifest.marketLensDecisions);
    } else {
      throw error;
    }
  }
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
    process.stderr.write(`Earnings focused preparation input was unusable; candidate and canonical dashboard unchanged: ${error.message}\n`);
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
  if (args.scheduled && !args.applyDashboardDataJson) validateScheduledStart(args.dashboard, args.windowMode);

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

  preparationInProgress = true;
  reportPreparationStatus('preparing');

  const canonicalBase = loadDashboardBase(args.dashboard);
  args.baseDashboardHtml = canonicalBase.html;
  args.sourceDashboard = canonicalBase.sourcePath;
  const canonicalHtml = canonicalBase.html;
  const canonicalDashboardData = readJsonBlock(canonicalHtml, 'dashboard-data');
  const canonicalChartData = roundChartPayload(readJsonBlock(canonicalHtml, 'chart-data'));
  const checkedAt = scheduledNow();
  const localDate = chicagoDateParts(checkedAt).isoDate;

  if (!args.skipFutures) {
    const futuresArgs = ['scripts/fetch_chart_data.js', 'futures'];
    if (args.windowMode === 'afternoon') futuresArgs.push('--session');
    const preparation = runWithSectionFallback(
      () => runCommand('node', futuresArgs),
      () => buildUnavailableFuturesPayload(args.windowMode === 'afternoon' ? 'session' : 'premarket', checkedAt),
      {
        label: 'Futures',
        readFresh: () => readJson(path.join(GENERATED_DIR, 'futures_module.json')),
        validateFresh: (payload) => validateFuturesPayload(payload, { expectedMode: args.windowMode === 'afternoon' ? 'session' : 'premarket' }),
        validateFallback: (payload) => validateFuturesPayload(payload, { expectedMode: args.windowMode === 'afternoon' ? 'session' : 'premarket' })
      }
    );
    args.futuresPayload = preparation.payload;
    if (preparation.error) {
      args.futuresFallbackPayload = preparation.fallback;
      reportSectionFallback('Futures', 'unavailable', preparation.error);
    }
  }

  if (!args.skipChartData) {
    const preparation = runWithSectionFallback(
      () => runCommand('node', ['scripts/fetch_chart_data.js', '--input', args.sourceDashboard]),
      () => buildChartDataFallback(canonicalChartData, checkedAt),
      {
        label: 'Chart and Tape',
        readFresh: () => readJson(path.join(GENERATED_DIR, 'chart_data.json')),
        validateFresh: (payload) => [
          ...validateChartStagingPayload(payload, readChartableRows(args.sourceDashboard)),
          ...chartSeriesRevisionErrors(canonicalChartData, payload)
        ],
        validateFallback: (payload) => validateChartStagingPayload(payload, readChartableRows(args.sourceDashboard))
      }
    );
    args.chartDataPayload = preparation.payload;
    if (preparation.error) {
      args.chartDataFallbackPayload = preparation.fallback;
      reportSectionFallback('Chart and Tape', 'carried_forward', preparation.error);
    }
  }

  if (!args.skipCryptoStats) {
    const preparation = runWithSectionFallback(
      () => runCommand('node', ['scripts/fetch_crypto_stats.js', '--input', args.sourceDashboard]),
      () => buildCryptoStatsFallback(canonicalDashboardData.crypto, checkedAt),
      {
        label: 'Crypto stats',
        readFresh: () => readJson(path.join(GENERATED_DIR, 'crypto_stats.json')),
        validateFresh: validateCryptoStatsPayload,
        validateFallback: validateCryptoStatsPayload
      }
    );
    args.cryptoStatsPayload = preparation.payload;
    if (preparation.error) {
      args.cryptoStatsFallbackPayload = preparation.fallback;
      reportSectionFallback('Crypto stats', preparation.fallback.availability.status, preparation.error);
    }
  }

  if (!args.skipAssetAllocationPortfolio) {
    const preparation = runWithSectionFallback(
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
    args.assetAllocationPortfolioPayload = preparation.payload;
    if (preparation.error) {
      reportSectionFallback('Asset Allocation portfolio', preparation.fallback.availability.status, preparation.error);
    }
  }

  if (!args.skipAssetAllocationSummary) {
    const preparation = runWithSectionFallback(
      () => runCommand('node', ['scripts/fetch_asset_allocation.js', '--input', args.sourceDashboard, '--skip-portfolio']),
      () => buildAssetAllocationSummaryFallback(canonicalDashboardData.assetAllocationPortfolio, { asOf: localDate }),
      {
        label: 'Asset Allocation summary',
        readFresh: () => readJson(path.join(GENERATED_DIR, 'asset_allocation_summary.json')),
        validateFresh: validateAssetAllocationSummaryPayload,
        validateFallback: validateAssetAllocationSummaryPayload
      }
    );
    args.assetAllocationSummaryPayload = preparation.payload;
    if (preparation.error) {
      reportSectionFallback('Asset Allocation summary', preparation.payload.stale ? 'carried_forward' : 'unavailable', preparation.error);
    }
  }

  if (!args.skipWeekAhead) {
    const canonicalWeekAhead = canonicalDashboardData.weekAhead || null;
    const targetRange = args.calendarRolloverRange || canonicalWeekAhead?.range;
    const invalidPersistedArtifact = weekAheadStagingNeedsRebuild(WEEK_AHEAD_PATH);
    if (invalidPersistedArtifact) {
      process.stderr.write('Week Ahead staging artifact is invalid under the current contract; rebuilding the active range.\n');
    }
    const weekAheadArgs = ['scripts/fetch_week_ahead.js'];
    if (args.calendarRolloverRange || requiresUnavailableRolloverRetry(canonicalWeekAhead) || invalidPersistedArtifact) weekAheadArgs.push('--date', targetRange.from);
    else weekAheadArgs.push('--refresh-values', '--input', WEEK_AHEAD_PATH);
    const preparation = runWithSectionFallback(
      () => runCommand('node', weekAheadArgs),
      () => buildWeekAheadPreparationFallback(canonicalWeekAhead, targetRange, { checkedAt }),
      {
        label: 'Week Ahead',
        readFresh: () => readJson(WEEK_AHEAD_PATH),
        validateFresh: validateWeekAheadPayload,
        validateFallback: (payload) => validateWeekAheadPayload(payload.week)
      }
    );
    args.weekAheadPayload = preparation.error ? preparation.fallback.week : preparation.payload;
    if (preparation.error) {
      args.weekAheadFallbackPayload = preparation.fallback.week;
      reportSectionFallback('Week Ahead', preparation.fallback.mode, preparation.error);
    }
  }

  if (!args.skipEarnings) {
    const canonicalWeek = canonicalDashboardData.earnings?.week || null;
    const targetRange = earningsTargetRange(args, canonicalWeek);
    const preparation = runWithSectionFallback(() => {
      const invalidPersistedArtifact = earningsStagingNeedsRebuild(EARNINGS_WEEK_PATH, checkedAt);
      if (invalidPersistedArtifact) {
        process.stderr.write('Earnings staging artifact is invalid under the current contract; evaluating an authorized rebuild or active-range fallback.\n');
      }
      const calendarNeedsBuild = earningsCalendarNeedsBuild(targetRange, EARNINGS_WEEK_PATH, checkedAt);
      const failedAttemptNeedsRetry = earningsCalendarFailedAttemptNeedsRetry(targetRange, EARNINGS_WEEK_PATH, checkedAt);
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
          '--from', targetRange.from,
          '--to', targetRange.to,
          '--as-of', checkedAt.toISOString()
        ]);
      }
      reportPendingEarningsScheduleReviews(pendingEarningsScheduleReviews(undefined, targetRange));
      runCommand('node', [
        'scripts/earnings_week.js',
        'refresh',
        '--as-of', checkedAt.toISOString()
      ]);
    }, () => buildEarningsPreparationFallback(canonicalWeek, targetRange, { checkedAt }), {
      label: 'Earnings',
      readFresh: () => readJson(EARNINGS_WEEK_PATH),
      validateFresh: (payload) => validateEarningsWeekPayload(payload),
      validateFallback: (payload) => validateEarningsWeekPayload(payload.week)
    });
    if (preparation.error) {
      args.earningsFallbackWeek = preparation.fallback.week;
      process.stderr.write(`Earnings preparation failed; continuing with ${preparation.fallback.mode} section fallback: ${preparation.error.message}\n`);
    } else {
      args.earningsWeekPayload = preparation.payload;
    }
  }

  stageDashboardCandidate(args, patchDashboard(args));
  preparationInProgress = false;
  reportPreparationStatus('candidate ready', `staged at ${args.candidate}; canonical dashboard unchanged`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (preparationInProgress) {
      reportPreparationStatus('failed', `candidate not replaced; canonical dashboard unchanged: ${error.message}`);
    } else {
      process.stderr.write(`run_daily_update failed: ${error.message}\n`);
    }
    process.exit(error.exitCode || 1);
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
  loadDashboardBase,
  readJsonBlock,
  replaceJsonBlock,
  requiresUnavailableRolloverRetry,
  earningsStagingNeedsRebuild,
  earningsTargetRange,
  earningsCalendarBuildDecision,
  weekAheadStagingNeedsRebuild,
  runWithSectionFallback,
  reportPreparationStatus,
  stampDashboardEdition,
  stageDashboardCandidate,
  validateScheduledFinalization,
  validateScheduledStart
};
