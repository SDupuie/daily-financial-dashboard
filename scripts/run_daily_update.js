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
  applyEarningsLifecycle,
  combinedOutcome,
  computeEarningsWeekCounts,
  earningsReactionBasis,
  isDisplayEligibleEarningsRow,
  narrativeEditorialComplete,
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
  validateMarketLens,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const { addDays, isIsoDate, isIsoDateTime } = require('./calendar_contract');
const {
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
  candidateInFuturesPublicationWindow,
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
const DEFAULT_EDITORIAL_DIR = path.join(GENERATED_DIR, 'editorial');
const DEFAULT_EDITORIAL_DASHBOARD_DATA = path.join(DEFAULT_EDITORIAL_DIR, 'dashboard-data.json');
const LAST_GOOD_DASHBOARD = path.join(GENERATED_DIR, 'daily_financial_news.last_good.html');
const EARNINGS_WEEK_PATH = path.join(GENERATED_DIR, 'earnings_week.json');
const EARNINGS_NARRATIVE_PATH = path.join(GENERATED_DIR, 'earnings_narrative.json');
const EARNINGS_SCHEDULE_REVIEW_PATH = path.join(GENERATED_DIR, 'earnings_schedule_review.json');
const WEEK_AHEAD_PATH = path.join(GENERATED_DIR, 'week_ahead.json');
const NEWS_CANDIDATES_PATH = path.join(GENERATED_DIR, 'news_candidates.json');
const SECTION_COMMAND_TIMEOUT_MS = 5 * 60_000;
const NEWS_COMMAND_TIMEOUT_MS = 10 * 60_000;
const EARNINGS_COMMAND_TIMEOUT_MS = 20 * 60_000;
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

function windowModeFromDashboard(data) {
  const edition = String(data?.masthead?.edition || '').trim();
  if (edition === 'Morning Edition') return 'morning';
  if (edition === 'Afternoon Edition') return 'afternoon';
  const futuresTitle = String(data?.futuresModule?.sectionTitle || '').trim();
  if (futuresTitle === 'Pre-Market Futures') return 'morning';
  if (futuresTitle === 'Session Futures') return 'afternoon';
  return '';
}

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

function nearestRolloverDate(now, targetWeekday, direction) {
  const weekdayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const parts = chicagoDateParts(now);
  const current = weekdayIndex[parts.weekday];
  const target = weekdayIndex[targetWeekday];
  if (!Number.isInteger(current) || !Number.isInteger(target)) return null;
  const offset = direction === 'backward'
    ? -((current - target + 7) % 7)
    : (target - current + 7) % 7;
  return addDays(parts.isoDate, offset);
}

function manualCalendarRolloverRange(windowMode, now = scheduledNow()) {
  // Manual rollover is an explicit repair lever. Weekend runs infer the intended
  // bridge from the calendar day; weekdays follow the requested edition.
  const parts = chicagoDateParts(now);
  if (parts.weekday === 'Sat') {
    const friday = nearestRolloverDate(now, 'Fri', 'backward');
    return friday ? { from: friday, to: addDays(friday, 6) } : null;
  }
  if (parts.weekday === 'Sun') {
    const monday = nearestRolloverDate(now, 'Mon', 'forward');
    return monday ? { from: monday, to: addDays(monday, 4) } : null;
  }
  if (windowMode === 'afternoon') {
    const friday = nearestRolloverDate(now, 'Fri', 'backward');
    return friday ? { from: friday, to: addDays(friday, 6) } : null;
  }
  if (windowMode === 'morning') {
    const monday = nearestRolloverDate(now, 'Mon', 'forward');
    return monday ? { from: monday, to: addDays(monday, 4) } : null;
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
  if (!SCHEDULED_WINDOWS[windowMode]) throw new Error('Scheduled finalization requires a staged Morning Edition or Afternoon Edition dashboard.');
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
      edition: ['Sat', 'Sun'].includes(chicagoDateParts(now).weekday) ? 'Weekend Edition' : windowMode === 'morning' ? 'Morning Edition' : 'Afternoon Edition',
      sectionLabel: labels.sectionLabel,
      sectionTitle: labels.sectionTitle
    } : {})
  };
}

function applyEditionMetadata(data, windowMode, now = scheduledNow()) {
  const metadata = chicagoEditionMetadata(windowMode, now);
  data.footer = { ...data.footer, compiled: metadata.compiledPrefix };
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
  const dailyCommand = ['prepare', 'apply'].includes(argv[0]) ? argv.shift() : '';
  const args = {
    dailyCommand,
    dashboard: DEFAULT_DASHBOARD,
    candidate: DEFAULT_CANDIDATE,
    windowMode: '',
    applyDashboardDataJson: '',
    prepareEditorialDir: '',
    prepareEditorialAfterStaging: dailyCommand === 'prepare',
    applyEarningsWeekJson: '',
    applyChartDataJson: '',
    mergeChartDataJson: '',
    syncChartQuotes: false,
    rolloverCalendar: false,
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
    if (arg === '--rollover-calendar') {
      args.rolloverCalendar = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (dailyCommand === 'apply' && !args.applyDashboardDataJson) args.applyDashboardDataJson = DEFAULT_EDITORIAL_DASHBOARD_DATA;
  const contentModeCount = [args.applyDashboardDataJson, args.applyEarningsWeekJson, args.applyChartDataJson, args.mergeChartDataJson, args.prepareEditorialDir, args.syncChartQuotes].filter(Boolean).length;
  if (!args.windowMode && contentModeCount === 0) {
    throw new Error('You must pass prepare, apply, --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-earnings-week-json, --apply-chart-data-json, --merge-chart-data-json, or --sync-chart-quotes.');
  }
  if (contentModeCount > 1 || (args.windowMode && contentModeCount)) {
    throw new Error('Use only one update mode: --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-earnings-week-json, --apply-chart-data-json, --merge-chart-data-json, or --sync-chart-quotes.');
  }
  const deterministicPreparation = Boolean(args.windowMode && contentModeCount === 0);
  if (args.scheduled && !(deterministicPreparation || args.applyDashboardDataJson)) {
    throw new Error('--scheduled is valid only with deterministic preparation or final editorial application.');
  }
  if (args.rolloverCalendar && !(dailyCommand === 'prepare' && deterministicPreparation && !args.scheduled)) {
    throw new Error('--rollover-calendar is valid only with manual deterministic preparation.');
  }
  if (path.resolve(args.candidate) === path.resolve(args.dashboard)) {
    throw new Error('--candidate must not target the canonical dashboard.');
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run_daily_update.js prepare (--morning | --afternoon) [--scheduled] [options]
  node scripts/run_daily_update.js apply [--scheduled] [options]
  node scripts/run_daily_update.js (--morning | --afternoon) [options]
  node scripts/run_daily_update.js --prepare-editorial-dir PATH
  node scripts/run_daily_update.js --apply-dashboard-data-json PATH [--scheduled] [options]
  node scripts/run_daily_update.js --apply-earnings-week-json PATH [options]
  node scripts/run_daily_update.js --apply-chart-data-json PATH [options]
  node scripts/run_daily_update.js --merge-chart-data-json PATH [options]
  node scripts/run_daily_update.js --sync-chart-quotes [options]

Options:
  --dashboard PATH                     Canonical dashboard HTML (default: daily_financial_news.html)
  --candidate PATH                     Staged complete candidate (default: generated/daily_financial_news.candidate.html)
  prepare                              Run deterministic preparation, then write generated/editorial/dashboard-data.json
  apply                                Apply generated/editorial/dashboard-data.json to the canonical dashboard
  --apply-dashboard-data-json PATH    Safely replace only the embedded dashboard-data block from JSON
  --prepare-editorial-dir PATH        Download News candidates and write the single dashboard-data editorial handoff
  --apply-earnings-week-json PATH     Stage a validated earnings-week payload in the complete candidate
  --apply-chart-data-json PATH        Stage chart history and derive matching Tape prices from JSON
  --merge-chart-data-json PATH        Stage selected chart series while preserving all other series
  --sync-chart-quotes                 Rebuild visible Tape prices from rounded chart history
  --morning                           Run the pre-open deterministic refresh path
  --afternoon                         Run the after-close deterministic refresh path
  --scheduled                         Mark scheduler-driven preparation/finalization; preparation enforces the start window, finalization derives the window from the staged candidate
  --rollover-calendar                 Manually force the selected edition's calendar rollover during prepare
  --help                              Show this help

Scheduled preparation checks the weekday/time window and completion marker before fetching. Finalization rechecks only the completion marker, so a run that started correctly may finish after the window closes.
Manual finalization is time-unrestricted and preserves the scheduled News baseline.

This orchestrator standardizes the daily workflow:
  1. prepare: refresh deterministic data, download News candidates, and write one dashboard-data handoff
  2. apply: merge editorial work, advance the scheduled baseline, stamp, receipt, validate, and atomically apply

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
    // Fallbacks must validate like fresh payloads because Apply consumes both
    // paths through the same staged-data contract.
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

function earningsStagingNeedsRebuild(filePath = EARNINGS_WEEK_PATH) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const payload = readJson(filePath);
    return validateEarningsWeekPayload(payload)?.length > 0;
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

function readCurrentFuturesModuleArtifact(expectedMode, checkedAt, filePath = path.join(GENERATED_DIR, 'futures_module.json')) {
  const payload = readJson(filePath);
  if (payload?.compiledAt !== checkedAt.toISOString()) {
    throw new Error('Futures staging artifact does not belong to this preparation run.');
  }
  const errors = validateFuturesPayload(payload, { expectedMode });
  if (errors.length) throw new Error(`Futures staging payload is invalid: ${errors.join(' ')}`);
  return payload;
}

function earningsTargetRange(args, canonicalWeek) {
  return activeCalendarRange(args, canonicalWeek?.range);
}

function activeCalendarRange(args, canonicalRange) {
  // Edition windows may compute a rollover range, but only scheduled runs or
  // explicit manual rollover are allowed to replace the canonical active range.
  const rolloverRange = args.scheduled || args.rolloverCalendar
    ? args.calendarRolloverRange
    : null;
  return rolloverRange || canonicalRange || null;
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
  // Only rollover paths are allowed to spend EarningsAPI budget. Schema repair
  // rebuilds the active range from free primary sources instead.
  if (args.rolloverCalendar && args.calendarRolloverRange) return { build: true, blocked: false, reason: 'explicit_manual_rollover', useEarningsApi: true };
  if (args.scheduled && args.calendarRolloverRange) return { build: true, blocked: false, reason: 'scheduled_rollover', useEarningsApi: true };
  if (unavailableRetry) return { build: true, blocked: false, reason: 'scheduled_unavailable_retry' };
  if (failedAttemptNeedsRetry) return { build: true, blocked: false, reason: 'scheduled_failed_attempt_retry' };
  if (invalidPersistedArtifact) return { build: true, blocked: false, reason: 'schema_repair', skipEarningsApi: true };
  if (!args.scheduled) return { build: false, blocked: true, reason: 'manual_build_not_authorized' };
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

function weekAheadStagingMatchesRange(targetRange, filePath = WEEK_AHEAD_PATH) {
  if (!targetRange?.from || !targetRange?.to || !fs.existsSync(filePath)) return false;
  try {
    const payload = readJson(filePath);
    if (validateWeekAheadPayload(payload)?.length > 0) return false;
    return rangesMatch(payload.range, targetRange);
  } catch (_error) {
    return false;
  }
}

function weekAheadPreparationCommandArgs(args, canonicalWeekAhead, { filePath = WEEK_AHEAD_PATH } = {}) {
  const targetRange = activeCalendarRange(args, canonicalWeekAhead?.range);
  if (!targetRange?.from || !targetRange?.to) throw new Error('Week Ahead target range is unavailable.');
  const invalidPersistedWeekAhead = weekAheadStagingNeedsRebuild(filePath);
  const authorizedRollover = Boolean((args.scheduled || args.rolloverCalendar) && args.calendarRolloverRange);
  const unavailableRetry = requiresUnavailableRolloverRetry(canonicalWeekAhead);
  const stagingMatchesTarget = weekAheadStagingMatchesRange(targetRange, filePath);
  const commandArgs = ['scripts/fetch_week_ahead.js'];
  // generated/week_ahead.json is an optimization source, not range authority:
  // reuse it only when it already matches the canonical or authorized target.
  if (authorizedRollover || unavailableRetry || invalidPersistedWeekAhead || !stagingMatchesTarget) {
    commandArgs.push('--date', targetRange.from);
  } else {
    commandArgs.push('--refresh-values', '--input', filePath);
  }
  return {
    commandArgs,
    targetRange,
    invalidPersistedWeekAhead,
    stagingMatchesTarget,
    authorizedRollover,
    unavailableRetry
  };
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
        note: '',
        noteDisposition: {
          status: 'pending_review',
          quoteRevision: row.noteDisposition.quoteRevision
        }
      };
    })
  };
}

function verifiedNarrativeDisposition(current, text = '') {
  return current?.status === 'verified' && Boolean(String(text || '').trim());
}

function markPendingNarrative(target, textField, dispositionField) {
  if (verifiedNarrativeDisposition(target?.[dispositionField], target?.[textField])) return;
  target[textField] = '';
  target[dispositionField] = { status: 'pending_review' };
}

function earningsHasActual(row) {
  return Number.isFinite(row?.eps?.actual) || Number.isFinite(row?.revenue?.actual);
}

function prepareEarningsForEditorial(earnings) {
  const week = structuredClone(earnings?.week || { rows: [] });
  delete week.narrativeApply;
  week.rows = (Array.isArray(week.rows) ? week.rows : []).map((row) => {
    if (!renderSafePublishedEarningsRow(row)) return row;
    const next = structuredClone(row);
    const outcomeOverall = combinedOutcome(next.eps?.result, next.revenue?.result);
    const resultsAvailable = earningsHasActual(next);
    next.outcome.overall = outcomeOverall;
    markPendingNarrative(next.outcome, 'interpretation', 'interpretationDisposition');
    if (resultsAvailable) {
      const guidance = next.outcome?.guidanceDisposition;
      const guidanceComplete = verifiedNarrativeDisposition(guidance, next.outcome?.guide)
        || guidance?.status === 'not_provided';
      if (!guidanceComplete) {
        next.outcome.guide = '';
        next.outcome.guidanceDisposition = { status: 'pending_review' };
      }
    }
    if (next.lifecycle === 'close_available' && resultsAvailable) {
      markPendingNarrative(next.reaction, 'note', 'commentaryDisposition');
    }
    return next;
  });
  return { ...earnings, week };
}

function weekAheadDayHasReleasedActuals(day) {
  return (Array.isArray(day?.events) ? day.events : [])
    .some((event) => event?.status === 'released' && String(event.actual || '').trim());
}

function weekAheadHasCloseReactionRows(day) {
  return Array.isArray(day?.marketReaction?.rows) && day.marketReaction.rows.length > 0;
}

function weekAheadHasCurrentMarketLens(day) {
  return day?.marketLensSource === 'editorial' && validateMarketLens(day.marketLens).length === 0;
}

function weekAheadNeedsMarketLensEditorial(day) {
  return ['released_awaiting_close', 'close_available'].includes(day?.lifecycle)
    && weekAheadDayHasReleasedActuals(day)
    && !weekAheadHasCurrentMarketLens(day);
}

function weekAheadMarketLensDecision(day) {
  if (weekAheadHasCurrentMarketLens(day)) return { date: day.date, action: 'replace', marketLens: day.marketLens };
  if (weekAheadNeedsMarketLensEditorial(day)) return { date: day.date, action: 'pending_review' };
  return { date: day.date, action: 'retain-generated' };
}

function weekAheadNeedsOutcomeEditorial(day) {
  return day?.lifecycle === 'close_available'
    && weekAheadDayHasReleasedActuals(day)
    && weekAheadHasCloseReactionRows(day);
}

function prepareWeekAheadForEditorial(weekAhead) {
  return {
    ...weekAhead,
    days: (Array.isArray(weekAhead?.days) ? weekAhead.days : []).map((day) => {
      if (!weekAheadNeedsOutcomeEditorial(day) || day?.outcome?.status === 'verified') return day;
      return { ...day, outcome: { status: 'pending_review' } };
    })
  };
}

function emptyNewsCandidateArtifact(asOf, error, dashboardData = null) {
  const eligibleDates = allowedNewsDates(asOf);
  const prior = priorNewsCandidates(dashboardData, eligibleDates);
  const futuresWindow = futuresStoryPublicationWindow(
    dashboardData?.futuresModule?.sectionTitle,
    asOf.toISOString(),
    asOf,
    dashboardData?.futuresModule?.futures
  );
  // Worker outages still need a Futures-specific pool; general freshness dates
  // can be newer than the displayed futures session after a weekend or late run.
  const futuresDates = Array.isArray(futuresWindow?.dates) && futuresWindow.dates.length
    ? new Set(futuresWindow.dates)
    : eligibleDates;
  const futuresPrior = futuresWindow ? priorNewsCandidates(dashboardData, futuresDates) : prior;
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
    futuresCandidates: futuresPrior.generalCandidates
      .filter((candidate) => futuresDates.has(candidate.publishedOn)
        && (!futuresWindow || candidateInFuturesPublicationWindow(candidate, futuresWindow))),
    cryptoCandidates: prior.cryptoCandidates
  };
}

function validNewsCandidateArtifact(artifact, asOf) {
  return artifact?.schemaVersion === 2
    && artifact.generatedAt === asOf.toISOString()
    && Array.isArray(artifact.attempts)
    && Array.isArray(artifact.generalCandidates)
    && Array.isArray(artifact.futuresCandidates)
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
      '--output', NEWS_CANDIDATES_PATH
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
  const preparedAt = scheduledNow();
  const windowMode = windowModeFromDashboard(dashboardData);
  delete dashboardData.editorialReview;
  // The handoff edition timestamp owns review freshness; baseEditionId remains
  // the guard that ties this handoff back to the staged deterministic candidate.
  dashboardData.editionId = preparedAt.toISOString();
  if (windowMode) applyEditionMetadata(dashboardData, windowMode, preparedAt);
  delete dashboardData.lede;
  delete dashboardData.renesas;
  // Opening copy belongs to the current editorial pass; never let prior-run
  // hero text or catalyst cards appear reviewed merely because staging copied them.
  dashboardData.opening = {
    headline: '',
    deck: '',
    catalysts: Array.from({ length: 4 }, () => ({ label: '', body: '' }))
  };
  const newsSearch = prepareNewsCandidatesForEditorial(preparedAt, args, dashboardData);
  const reviewManifest = {
    schemaVersion: 1,
    preparedAt: preparedAt.toISOString(),
    reviewedAt: null,
    baseEditionId,
    verifiedClaims: [],
    newsSearch,
    newsSelection: { futures: [], stories: [], crypto: [] },
    openingDecision: { action: null },
    marketLensDecisions: []
  };
  dashboardData.tape = prepareTapeCommentaryForEditorial(dashboardData.tape, previousDashboardData.tape);
  delete dashboardData.storiesCoverage;
  if (dashboardData.crypto) delete dashboardData.crypto.notesCoverage;
  if (dashboardData.futuresModule) delete dashboardData.futuresModule.storiesCoverage;
  if (dashboardData.futuresModule) dashboardData.futuresModule.stories = [];
  dashboardData.stories = [];
  if (dashboardData.crypto) dashboardData.crypto.notes = [];
  dashboardData.earnings = prepareEarningsForEditorial(dashboardData.earnings);
  dashboardData.weekAhead = prepareWeekAheadForEditorial(dashboardData.weekAhead);
  reviewManifest.marketLensDecisions = (dashboardData.weekAhead?.days || [])
    .filter((day) => Array.isArray(day?.events) && day.events.length)
    .map(weekAheadMarketLensDecision);
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

function patchDashboardDataBlock(html, dashboardData, reviewManifest = null, reviewChartData = null, { stampEdition = true, selectEarningsRows = false } = {}) {
  const stampedData = structuredClone(stampEdition ? stampDashboardEdition(dashboardData) : dashboardData);
  try {
    normalizeTapeCommentaryForPublication(stampedData, readJsonBlock(html, 'chart-data'));
  } catch (_error) {
    // Broken/missing chart-data is still caught by final validation.
  }
  if (selectEarningsRows) prepareEarningsRowsForPublication(stampedData);
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
    const validationArgs = [path.resolve(__dirname, 'validate_dashboard.js'), '--mode', 'published', candidate];
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

function commitEditorialCandidate(args, nextHtml, options = {}) {
  commitDashboardCandidate(args, nextHtml, options);
}

function stageDashboardCandidate(args, nextHtml) {
  fs.mkdirSync(path.dirname(args.candidate), { recursive: true });
  const temporary = `${args.candidate}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, nextHtml, { mode: fs.statSync(args.dashboard).mode });
    const result = spawnSync(process.execPath, [path.resolve(__dirname, 'validate_dashboard.js'), '--mode', 'staged', temporary], {
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

function hasPublishedEarningsRows(week) {
  return Array.isArray(week?.rows) && week.rows.length > 0;
}

function rangesMatch(left, right) {
  return left?.from === right?.from && left?.to === right?.to;
}

function optionalJson(filePath) {
  try {
    return fs.existsSync(filePath) ? readJson(filePath) : null;
  } catch (_error) {
    return null;
  }
}

function emptyEarningsContradicted(sourceWeek, { incomingRows = 0, evidenceRows = false, useSidecarEvidence = false } = {}) {
  if (incomingRows > 0 || evidenceRows) return true;
  if (!useSidecarEvidence) return false;
  const range = sourceWeek?.range;
  if (!range) return false;
  const scheduleReview = optionalJson(EARNINGS_SCHEDULE_REVIEW_PATH);
  if (rangesMatch(scheduleReview?.range, range) && Array.isArray(scheduleReview.rows) && scheduleReview.rows.length > 0) return true;
  const narrative = optionalJson(EARNINGS_NARRATIVE_PATH);
  return rangesMatch(narrative?.sourceRange, range) && Array.isArray(narrative.rows) && narrative.rows.length > 0;
}

function carriedForwardEarningsWeek(previousWeek, checkedAt = scheduledNow()) {
  const asOf = new Date(checkedAt);
  return {
    ...structuredClone(previousWeek),
    generatedAt: asOf.toISOString(),
    availability: {
      status: 'carried_forward',
      reason: 'empty_earnings_recovery',
      checkedAt: asOf.toISOString()
    },
    rows: (Array.isArray(previousWeek?.rows) ? previousWeek.rows : [])
      .map((row) => applyEarningsLifecycle(row, asOf))
  };
}

function recoverEmptyEarningsWeek(data, sourceWeek, previousWeek, options = {}) {
  const week = data.earnings?.week;
  if (hasPublishedEarningsRows(week) || !emptyEarningsContradicted(sourceWeek, options)) return false;
  // If sidecar/review evidence proves the active slate had rows, publishing an
  // empty monitor would hide a deterministic failure; carry forward last good.
  if (!hasPublishedEarningsRows(previousWeek)) {
    throw new Error('Earnings publication produced zero rows despite same-range row evidence, and no previous non-empty canonical week is available to carry forward.');
  }
  data.earnings.week = carriedForwardEarningsWeek(previousWeek, options.checkedAt);
  clearEarningsInternalQueues(data.earnings.week);
  if (!hasPublishedEarningsRows(data.earnings?.week)) {
    throw new Error('Earnings empty-row recovery failed because the previous canonical week did not survive publication handoff.');
  }
  return true;
}

function isEmptyEarningsRecoveryWeek(week) {
  return week?.availability?.status === 'carried_forward'
    && week.availability.reason === 'empty_earnings_recovery';
}

function applyEarningsWeek(data, earningsWeek, { requireNarrative = true, previousWeek = data.earnings?.week, checkedAt = scheduledNow(), evidenceRows = false, useSidecarEvidence = false } = {}) {
  const incomingRows = Array.isArray(earningsWeek?.rows) ? earningsWeek.rows.length : 0;
  const canonicalEarningsWeek = mergeUnchangedEarningsNarrative(data.earnings?.week, earningsWeek);
  delete canonicalEarningsWeek.policy;
  delete canonicalEarningsWeek.outputPath;
  if (!requireNarrative) delete canonicalEarningsWeek.narrativeApply;
  data.earnings = {
    label: 'Earnings · Week Monitor',
    week: canonicalEarningsWeek
  };
  prepareEarningsRowsForPublication(data);
  recoverEmptyEarningsWeek(data, earningsWeek, { ...previousWeek }, { incomingRows, checkedAt, evidenceRows, useSidecarEvidence });
}

function prepareCandidateNews(data, now = scheduledNow()) {
  const allowedDates = allowedNewsDates(now);
  const futuresWindow = futuresStoryPublicationWindow(
    data.futuresModule?.sectionTitle,
    new Date(now).toISOString(),
    now,
    data.futuresModule?.futures
  );
  const retainedFuturesDates = Array.isArray(futuresWindow?.dates) && futuresWindow.dates.length
    ? new Set(futuresWindow.dates)
    : new Set([sharedFuturesSessionDate(data.futuresModule?.futures)].filter(Boolean));
  const retainedStoryIds = new Set();
  const retainedStoryUrls = new Set();
  const retainedStoryTitles = new Set();
  const retainFresh = (items, options = {}) => (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (!structurallyUsableStory(item, {
        allowedDates,
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
  now = scheduledNow(),
  resetCommentary = false,
  commentaryTickers = null,
  systemFallbacks = null
} = {}) {
  // dashboard-data keeps the visible tape fields, but those values are projections from chart-data.series,
  // not an independent editable truth during scheduled or manual maintenance flows.
  const derivedQuoteRows = deriveQuoteRowsFromSeries(Array.isArray(chartData?.series) ? chartData.series : []);
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
    data.weekAhead = applyWeekAheadLifecycle(data.weekAhead, chartData, { now });
    normalizeWeekAheadReactionButtons(data, chartData);
    data.weekAhead = finalizeWeekAheadOutcomes(data.weekAhead, { now });
  }
  return { commentaryResetCount };
}

function mergedChartAvailability(existingChartData, incomingChartData, series) {
  // Preserve whole-payload carry-forward diagnostics until a replacement
  // payload proves it covers every prior ticker.
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
  const checkedAt = scheduledNow();
  const weekendManual = args.windowMode !== 'afternoon' && !args.scheduled && ['Sat', 'Sun'].includes(chicagoDateParts(checkedAt).weekday);
  if (weekendManual) {
    args.windowMode = 'afternoon';
    process.stderr.write('Weekend manual run detected; using latest regular-session futures path and Weekend Edition masthead.\n');
  }
  const html = args.baseDashboardHtml || loadDashboardBase(args.dashboard).html;
  let dashboardData = readJsonBlock(html, 'dashboard-data');
  if (dashboardData.earnings?.week) delete dashboardData.earnings.week.outputPath;
  const previousDashboardData = dashboardData;
  let chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  let nextHtml = html;

  chartData = roundChartPayload(args.chartDataPayload || args.chartDataFallbackPayload || readJson(path.join(GENERATED_DIR, 'chart_data.json')));
  // chart-data.series is the canonical price history; dashboard tape prices are derived from it.
  syncDashboardPricesFromChartData(dashboardData, chartData, {
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
  dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { now: scheduledNow() });
  normalizeWeekAheadReactionButtons(dashboardData, chartData);
  dashboardData.weekAhead = finalizeWeekAheadOutcomes(dashboardData.weekAhead, { now: scheduledNow() });

  const previousEarningsWeek = structuredClone(dashboardData.earnings?.week || null);
  if (args.earningsFallbackWeek) {
    applyEarningsWeek(dashboardData, args.earningsFallbackWeek, { requireNarrative: false, previousWeek: previousEarningsWeek, useSidecarEvidence: true });
  } else {
    applyEarningsWeek(dashboardData, args.earningsWeekPayload || readJson(EARNINGS_WEEK_PATH), { requireNarrative: false, previousWeek: previousEarningsWeek, useSidecarEvidence: true });
  }

  applyEditionMetadata(dashboardData, args.windowMode);
  prepareCandidateNews(dashboardData);
  // Preparation never advances scheduled News state. Only a successful final
  // editorial application records completion and rotates the comparison set.
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: false, now: scheduledNow() });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  return nextHtml;
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

function applyMarketLensDecisionsData(data, payload) {
  data.weekAhead = applyMarketLensDecisions(data.weekAhead, payload);
  return data;
}

function normalizeMarketLensReview(data, reviewManifest) {
  const submitted = Array.isArray(reviewManifest.marketLensDecisions) ? reviewManifest.marketLensDecisions : [];
  const eventDays = (data.weekAhead?.days || []).filter((day) => Array.isArray(day?.events) && day.events.length);
  const submittedByDate = new Map(submitted.filter((decision) => decision?.date).map((decision) => [decision.date, decision]));
  const normalized = normalizeMarketLensDecisions(data.weekAhead, submitted).map((decision) => {
    const day = eventDays.find((item) => item.date === decision.date);
    const submittedDecision = submittedByDate.get(decision.date);
    const released = ['released_awaiting_close', 'close_available'].includes(day?.lifecycle);
    if (released && weekAheadDayHasReleasedActuals(day) && decision.action === 'retain-generated') {
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

function preserveSafePriorEarningsNarrative(finalWeek, previousWeek) {
  const fallbackWeek = mergeUnchangedEarningsNarrative(previousWeek, finalWeek);
  const fallbackRowsByKey = new Map((Array.isArray(fallbackWeek?.rows) ? fallbackWeek.rows : [])
    .map((row) => [earningsNarrativeRowKey(row), row]));
  return {
    ...finalWeek,
    rows: (Array.isArray(finalWeek?.rows) ? finalWeek.rows : []).map((row) => {
      const fallback = fallbackRowsByKey.get(earningsNarrativeRowKey(row));
      if (!fallback || narrativeEditorialComplete(row, row)) return row;
      const output = structuredClone(row);
      if (!validEarningsCommentaryDisposition(output.outcome?.interpretationDisposition, output.outcome?.interpretation)) {
        output.outcome.interpretation = fallback.outcome?.interpretation || '';
        if (fallback.outcome?.interpretationDisposition) output.outcome.interpretationDisposition = structuredClone(fallback.outcome.interpretationDisposition);
        else delete output.outcome.interpretationDisposition;
      }
      if (!validEarningsGuidanceDisposition(output.outcome?.guidanceDisposition, output.outcome?.guide)) {
        output.outcome.guide = fallback.outcome?.guide || '';
        if (fallback.outcome?.guidanceDisposition) output.outcome.guidanceDisposition = structuredClone(fallback.outcome.guidanceDisposition);
        else delete output.outcome.guidanceDisposition;
      }
      if (!validEarningsCommentaryDisposition(output.reaction?.commentaryDisposition, output.reaction?.note)) {
        output.reaction.note = fallback.reaction?.note || '';
        if (fallback.reaction?.commentaryDisposition) output.reaction.commentaryDisposition = structuredClone(fallback.reaction.commentaryDisposition);
        else delete output.reaction.commentaryDisposition;
      }
      return output;
    })
  };
}

function applyEditorialEarningsNarrative(dashboardData, candidateDashboardData, editorialDashboardData, previousDashboardData = null) {
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
  finalWeek = preserveSafePriorEarningsNarrative(finalWeek, previousDashboardData?.earnings?.week);
  const finalized = { earnings: { week: finalWeek } };
  recoverEmptyEarningsWeek(finalized, candidateWeek, previousDashboardData?.earnings?.week, {
    incomingRows: Array.isArray(candidateWeek?.rows) ? candidateWeek.rows.length : 0,
    checkedAt: scheduledNow(),
    useSidecarEvidence: true
  });
  // Apply does not rebuild the slate here. The recovery above only prevents a
  // same-range zero-row publish when staged sidecars prove rows existed.
  finalWeek = finalized.earnings.week;
  if ((finalWeek.rows || []).some((row) => row?.sourceAudit)) {
    const errors = validateEarningsWeekPayload(finalWeek);
    if (errors.length) process.stderr.write(`Editorial Earnings narrative warning: ${errors.join(' ')}\n`);
  }
  dashboardData.earnings = {
    ...candidateDashboardData.earnings,
    week: finalWeek
  };
  return { narrativePayload: rows.length ? narrativePayload : null, week: finalWeek };
}

function safeEditorialText(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? value : fallback;
}

function sanitizeOpening(editorial) {
  // Opening is a handoff-editing target; Apply Handoff salvages valid copy instead of blocking publication.
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

function structurallyUsableStory(item, options = {}) {
  const { crypto = false, futures = false } = options;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.referencePage !== undefined) return false;
  const label = crypto ? item.kicker : item.tag;
  if (typeof label !== 'string' || !label.trim() || typeof item.title !== 'string' || !item.title.trim() || typeof item.body !== 'string' || !item.body.trim()) return false;
  if (options.requireSourceLabel && (typeof item.sourceLabel !== 'string' || !item.sourceLabel.trim())) return false;
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

function storyWithCandidateMetadata(item, candidate, options = {}) {
  const source = candidate || item;
  // Carry source/candidate facts only; display badges are rebuilt from
  // newsBaseline during rendering instead of being stored on story rows.
  const story = {
    ...(options.crypto ? { kicker: item?.kicker } : { tag: item?.tag }),
    ...(typeof item?.tone === 'string' ? { tone: item.tone } : {}),
    title: item?.title,
    body: item?.body,
    url: source?.url,
    publishedOn: source?.publishedOn,
    sourceLabel: storySourceLabel(item, candidate),
    ...(source?.publishedAt ? { publishedAt: source.publishedAt } : {})
  };
  return story;
}

function sanitizeStoryList(editorial, options = {}) {
  if (!Array.isArray(editorial)) {
    if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: options.path, action: 'omitted', reason: 'editorial_content_unavailable' });
    return [];
  }
  // Stage 3 does not search for replacements; candidate maps only prove the
  // selected URLs came from Stage 1's generated inventory.
  const seenUrls = new Set();
  const candidateByUrl = options.candidateByUrl instanceof Map ? options.candidateByUrl : null;
  const blockedUrls = options.blockedUrls instanceof Set ? options.blockedUrls : new Set();
  const selected = [];
  editorial.forEach((item, index) => {
    const candidate = candidateByUrl ? candidateByUrl.get(canonicalStoryUrl(item?.url)) : null;
    if (candidateByUrl && !candidate) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'not_in_candidate_inventory' });
      return;
    }
    const story = storyWithCandidateMetadata(item, candidate, options);
    if (!structurallyUsableStory(story, options)) {
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason: 'invalid_editorial_item' });
      return;
    }
    const url = canonicalStoryUrl(story.url);
    const duplicate = !url || seenUrls.has(url);
    const blockedDuplicate = blockedUrls.has(url);
    if (duplicate || blockedDuplicate) {
      const reason = blockedDuplicate ? options.blockedDuplicateReason || 'duplicate_editorial_item' : 'duplicate_editorial_item';
      if (Array.isArray(options.systemFallbacks)) options.systemFallbacks.push({ section: options.section, path: `${options.path}[${index}]`, action: 'omitted', reason });
      return;
    }
    seenUrls.add(url);
    selected.push(story);
  });
  return selected;
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
    return !options.futuresWindow || candidateInFuturesPublicationWindow(candidate, options.futuresWindow);
  }
  return true;
}

function candidateUrlMap(candidates, options = {}) {
  const entries = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidateEligibleForNewsSection(candidate, options))
    .map((candidate) => [canonicalCandidateUrl(candidate), candidate])
    .filter(([url]) => url);
  return new Map(entries);
}

function storySourceLabel(item, candidate = null) {
  // Candidate inventory owns provenance after Prepare. During Apply, an
  // inventory match with no label must fail validation instead of falling back
  // to editorial text or guessing from the URL.
  if (typeof candidate?.sourceLabel === 'string' && candidate.sourceLabel.trim()) {
    return candidate.sourceLabel.trim();
  }
  if (candidate) return '';
  if (typeof item?.sourceLabel === 'string' && item.sourceLabel.trim()) {
    return item.sourceLabel.trim();
  }
  return '';
}

function newsSelection(manifest, key) {
  const selection = manifest?.newsSelection;
  return Array.isArray(selection?.[key]) ? selection[key] : [];
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

function sanitizeTapeRows(candidateRows, editorialRows, previousRows, systemFallbacks = null, now = scheduledNow(), attemptThreshold = '') {
  const editorialByTicker = new Map((Array.isArray(editorialRows) ? editorialRows : []).map((row) => [String(row?.ticker || '').toUpperCase(), row]));
  const previousByTicker = new Map((Array.isArray(previousRows) ? previousRows : []).map((row) => [String(row?.ticker || '').toUpperCase(), row]));
  const reviewedAt = new Date(now).toISOString();
  return (Array.isArray(candidateRows) ? candidateRows : []).map((row) => {
    const ticker = String(row?.ticker || '').toUpperCase();
    const editorial = editorialByTicker.get(ticker);
    const previous = previousByTicker.get(ticker);
    const note = safeEditorialText(editorial?.note, row.note);
    const text = String(note || '').trim();
    const candidateDispositionValid = validateTapeCommentaryDisposition(row).length === 0;
    // Commentary is bound to the accepted quote revision; refreshed or invalid
    // rows need new review instead of silently reusing prior copy.
    const quoteRevision = candidateDispositionValid
      ? row.noteDisposition.quoteRevision
      : previous?.noteDisposition?.quoteRevision || reviewedAt;
    const quoteWasRefreshed = !previous
      || !candidateDispositionValid
      || quoteRevision !== previous?.noteDisposition?.quoteRevision;

    if (!quoteWasRefreshed && candidateDispositionValid) return structuredClone(previous);

    if (editorial && text) {
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

function usableWeekAheadOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
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
    requireSourceLabel: true,
    path: 'futuresModule.stories'
  });
  data.futuresModule.stories = futuresStories;

  const stories = sanitizeStoryList(data.stories, {
    requireSourceLabel: true,
    path: 'stories',
    ...storyBlockSets(futuresStories)
  });
  data.stories = stories;

  data.crypto.notes = sanitizeStoryList(data.crypto?.notes, {
    crypto: true,
    requireSourceLabel: true,
    path: 'crypto.notes',
    ...storyBlockSets(futuresStories, stories)
  });
}

function clearEarningsInternalQueues(week) {
  if (!week || typeof week !== 'object' || Array.isArray(week)) return;
  if (!Array.isArray(week.rows)) week.rows = [];
  week.secondaryRecoveryCandidates = [];
  week.companyReleaseTasks = [];
  week.summary = {
    ...(week.summary && typeof week.summary === 'object' && !Array.isArray(week.summary) ? week.summary : {}),
    counts: computeEarningsWeekCounts(week.rows, week.secondaryRecoveryCandidates, week.companyReleaseTasks)
  };
  delete week.narrativeApply;
}

function prepareEarningsRowsForPublication(data) {
  const week = data.earnings?.week;
  if (!week || typeof week !== 'object' || Array.isArray(week)) return;
  if (!Array.isArray(week.rows)) week.rows = [];
  week.rows = week.rows
    .map(repairPublishedEarningsReaction)
    .filter(renderSafePublishedEarningsRow)
    .filter(isDisplayEligibleEarningsRow)
    .map((row) => normalizeEarningsCommentaryForPublication(row));
  clearEarningsInternalQueues(week);
}

function objectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validComputedEarningsReaction(reaction) {
  return objectRecord(reaction)
    && reaction.status === 'computed'
    && Number.isFinite(reaction.percent)
    && isIsoDate(reaction.fromDate)
    && isIsoDate(reaction.toDate)
    && Number.isFinite(reaction.fromClose)
    && Number.isFinite(reaction.toClose);
}

function repairPublishedEarningsReaction(row) {
  if (!objectRecord(row)) return row;
  const reaction = objectRecord(row.reaction) ? row.reaction : null;
  if (validComputedEarningsReaction(reaction)) return row;
  const hasActuals = earningsHasActual(row);
  const status = !hasActuals
    ? 'pending'
    : row.reportTiming === 'unknown' ? 'unavailable' : 'awaiting_close';
  return {
    ...row,
    reaction: {
      ...(reaction || {}),
      basis: earningsReactionBasis(row.reportTiming),
      percent: null,
      fromDate: '',
      fromClose: null,
      toDate: '',
      toClose: null,
      status,
      note: typeof reaction?.note === 'string' ? reaction.note : '',
      source: typeof reaction?.source === 'string' ? reaction.source : ''
    }
  };
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

function pendingReviewDisposition(disposition) {
  return Boolean(disposition && typeof disposition === 'object' && !Array.isArray(disposition)
    && disposition.status === 'pending_review');
}

function normalizeEarningsCommentaryForPublication(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !row.outcome || typeof row.outcome !== 'object' || Array.isArray(row.outcome)) return row;
  const next = structuredClone(row);
  const outcome = next.outcome;
  const reaction = next.reaction;
  next.scheduleVerificationStatus = String(next.scheduleVerificationStatus || next.sourceAudit?.scheduleVerification?.status || '');
  next.companyReleaseStatus = String(next.companyReleaseStatus || next.sourceAudit?.companyReleaseResolution?.status || '');
  outcome.overall = combinedOutcome(next.eps?.result, next.revenue?.result);

  if (pendingReviewDisposition(outcome.interpretationDisposition)) {
    outcome.interpretation = '';
  } else if (!validEarningsCommentaryDisposition(outcome.interpretationDisposition, outcome.interpretation)) {
    outcome.interpretation = '';
    delete outcome.interpretationDisposition;
  } else if (outcome.interpretationDisposition?.status === 'commentary_unavailable') {
    outcome.interpretation = '';
  }

  if (pendingReviewDisposition(outcome.guidanceDisposition)) {
    outcome.guide = '';
  } else if (!validEarningsGuidanceDisposition(outcome.guidanceDisposition, outcome.guide)) {
    outcome.guide = '';
    delete outcome.guidanceDisposition;
  } else if (['not_provided', 'unverified'].includes(outcome.guidanceDisposition?.status)) {
    outcome.guide = '';
  }

  if (reaction && typeof reaction === 'object' && !Array.isArray(reaction)) {
    if (pendingReviewDisposition(reaction.commentaryDisposition)) {
      reaction.note = '';
    } else if (!validEarningsCommentaryDisposition(reaction.commentaryDisposition, reaction.note)) {
      reaction.note = '';
      delete reaction.commentaryDisposition;
    } else if (reaction.commentaryDisposition?.status === 'commentary_unavailable') {
      reaction.note = '';
    }
  }

  return next;
}

function normalizePublicationDisplaySections(data, { now = scheduledNow() } = {}) {
  // Publication normalization is render-safety only: keep the static dashboard
  // bootable with explicit degraded sections, without fetching or selecting data.
  const checkedAt = new Date(now);
  const asOf = chicagoDateParts(checkedAt).isoDate;
  const month = asOf.slice(0, 7);
  const safeWindowMode = windowModeFromDashboard(data) || 'afternoon';

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
  applyNewsCoverageState(data, { now: checkedAt });
  return data;
}

function applyDashboardDataJson(args) {
  const canonicalHtml = loadDashboardBase(args.dashboard).html;
  const candidateHtml = fs.readFileSync(args.candidate, 'utf8');
  const candidateDashboardData = readJsonBlock(candidateHtml, 'dashboard-data');
  const windowMode = windowModeFromDashboard(candidateDashboardData);
  if (args.scheduled) validateScheduledFinalization(args.dashboard, windowMode);
  const previousDashboardData = assertCandidateMatchesCanonical(args, candidateDashboardData);
  const candidateChartData = roundChartPayload(readJsonBlock(candidateHtml, 'chart-data'));
  // Apply publishes staged chart-data as-is; Stage 1 and focused chart repairs
  // own revision validation, quote derivation, and Week Ahead lifecycle updates.
  const editorialDashboardData = readJson(args.applyDashboardDataJson);
  let reviewManifest = { ...editorialDashboardData.editorialReview, reviewedAt: scheduledNow().toISOString() };
  reviewManifest.systemFallbacks = [];
  if (reviewManifest.baseEditionId !== candidateDashboardData.editionId) {
    throw new Error('Editorial dashboard-data baseEditionId must match the staged candidate; regenerate the editorial handoff.');
  }
  if (!isIsoDateTime(editorialDashboardData.editionId)) {
    throw new Error('Editorial dashboard-data editionId must be the prepared run edition timestamp; regenerate the editorial handoff.');
  }
  const newsSource = readNewsCandidateSource(reviewManifest.preparedAt);
  const dashboardData = structuredClone(candidateDashboardData);
  // The prepared edition timestamp owns editorial freshness and story windows;
  // wall-clock apply time may drift outside the original handoff window.
  const editorialNow = new Date(editorialDashboardData.editionId);
  dashboardData.editionId = editorialDashboardData.editionId;
  const generalNewsCandidates = Array.isArray(newsSource?.generalCandidates) ? newsSource.generalCandidates : [];
  const futuresNewsCandidates = Array.isArray(newsSource?.futuresCandidates) ? newsSource.futuresCandidates : [];
  const cryptoNewsCandidates = Array.isArray(newsSource?.cryptoCandidates) ? newsSource.cryptoCandidates : [];
  const futuresWindow = futuresStoryPublicationWindow(
    dashboardData.futuresModule?.sectionTitle,
    dashboardData.editionId,
    editorialNow,
    dashboardData.futuresModule?.futures
  );
  const newsCandidateSets = {
    generalCandidateByUrl: candidateUrlMap(generalNewsCandidates),
    cryptoCandidateByUrl: candidateUrlMap(cryptoNewsCandidates),
    futuresCandidateByUrl: candidateUrlMap(futuresNewsCandidates, { futures: true, futuresWindow })
  };
  dashboardData.opening = sanitizeOpening(editorialDashboardData.opening);
  dashboardData.futuresModule = {
    ...dashboardData.futuresModule,
    stories: sanitizeStoryList(newsSelection(reviewManifest, 'futures'), {
      futures: true,
      requireSourceLabel: true,
      systemFallbacks: reviewManifest.systemFallbacks,
      section: 'futures-news',
      path: 'editorialReview.newsSelection.futures',
      candidateByUrl: newsCandidateSets.futuresCandidateByUrl,
      futuresWindow
    })
  };
  dashboardData.stories = sanitizeStoryList(newsSelection(reviewManifest, 'stories'), {
    requireSourceLabel: true,
    systemFallbacks: reviewManifest.systemFallbacks,
    section: 'stories',
    path: 'editorialReview.newsSelection.stories',
    candidateByUrl: newsCandidateSets.generalCandidateByUrl,
    ...storyBlockSets(dashboardData.futuresModule.stories),
    blockedDuplicateReason: 'promoted_story_duplicate'
  });
  dashboardData.crypto = {
    ...dashboardData.crypto,
    notes: sanitizeStoryList(newsSelection(reviewManifest, 'crypto'), {
      crypto: true,
      requireSourceLabel: true,
      systemFallbacks: reviewManifest.systemFallbacks,
      section: 'crypto',
      path: 'editorialReview.newsSelection.crypto',
      candidateByUrl: newsCandidateSets.cryptoCandidateByUrl,
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
      reviewManifest.systemFallbacks,
      editorialNow,
      reviewManifest.preparedAt
    )
  };
  dashboardData.footer = {
    ...dashboardData.footer,
    compiled: String(candidateDashboardData.footer?.compiled || '')
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
  }
  const finalizedEarnings = applyEditorialEarningsNarrative(
    dashboardData,
    candidateDashboardData,
    editorialDashboardData,
    previousDashboardData
  );
  if (windowMode) applyEditionMetadata(dashboardData, windowMode, editorialNow);
  normalizePublicationDisplaySections(dashboardData, { now: editorialNow });
  normalizeMarketLensReview(dashboardData, reviewManifest);
  normalizeVerifiedClaims(dashboardData, reviewManifest, previousDashboardData.editorialReview);
  const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
  if (reviewErrors.length) process.stderr.write(`Editorial review receipt will be best-effort: ${reviewErrors.join(' ')}\n`);
  // Week Ahead facts and lifecycle already belong to the staged candidate; Apply
  // merges only editorial decisions and verified Outcome copy onto that state.
  applyMarketLensDecisionsData(dashboardData, reviewManifest.marketLensDecisions);
  if (Array.isArray(dashboardData.weekAhead?.days)) {
    dashboardData.weekAhead.days = dashboardData.weekAhead.days.map((day) => {
      const editorialDay = editorialWeekAheadDays.get(day.date);
      return usableWeekAheadOutcome(editorialDay?.outcome) ? { ...day, outcome: editorialDay.outcome } : day;
    });
  }
  const reviewChartData = compactChartPayload(candidateChartData);
  let nextHtml = replaceJsonBlock(canonicalHtml, 'chart-data', JSON.stringify(reviewChartData));
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: windowMode, now: editorialNow });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, reviewManifest, reviewChartData, { stampEdition: false });
  const publishingDefaultDashboard = path.resolve(args.dashboard) === DEFAULT_DASHBOARD;
  const recoveredEarningsPublication = isEmptyEarningsRecoveryWeek(finalizedEarnings?.week);
  // A carried-forward Earnings monitor keeps the page safe, but it is not a new
  // known-good deterministic baseline for future empty-row recovery.
  commitEditorialCandidate(args, nextHtml, {
    refreshLastGood: publishingDefaultDashboard && !recoveredEarningsPublication
  });
  if (finalizedEarnings && publishingDefaultDashboard) {
    if (recoveredEarningsPublication) {
      process.stderr.write('Earnings narrative synchronization skipped because the dashboard carried forward the previous non-empty week after empty-row recovery.\n');
      return;
    }
    try {
      if (finalizedEarnings.narrativePayload) writeJson(EARNINGS_NARRATIVE_PATH, finalizedEarnings.narrativePayload);
    } catch (error) {
      process.stderr.write(`Dashboard was committed, but Earnings narrative synchronization failed and will retry later: ${error.message}\n`);
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

function readValidatedChartStagingPayload(file, expectedRows, label, options = {}) {
  const payload = readJson(file);
  assertValidChartStagingPayload(payload, expectedRows, label, options);
  return roundChartPayload(payload);
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
    chartData = readValidatedChartStagingPayload(args.applyChartDataJson, dashboardData.tape?.rows || [], 'Chart focused apply input', { requireSeries: true });
    assertChartSeriesRevisions(currentChartData, chartData, 'Chart focused apply input');
  } catch (error) {
    process.stderr.write(`Chart focused apply input was unusable; carrying validated chart data: ${error.message}\n`);
    chartData = buildChartDataFallback(currentChartData, scheduledNow());
  }
  syncDashboardPricesFromChartData(dashboardData, chartData, {
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
    applyEarningsWeek(dashboardData, earningsWeek, { requireNarrative: false, previousWeek: dashboardData.earnings?.week, useSidecarEvidence: true });
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
    incomingChartData = readValidatedChartStagingPayload(args.mergeChartDataJson, [], 'Chart merge input', { requireSeries: true });
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
  syncDashboardPricesFromChartData(dashboardData, chartData);
  prepareCandidateNews(dashboardData);
  const embeddedChartData = compactChartPayload(chartData);
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(embeddedChartData));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, null, null, { stampEdition: false });
  stageDashboardCandidate(args, nextHtml);
  reportPreparationStatus('candidate ready', `chart quote synchronization staged at ${args.candidate}; canonical dashboard unchanged`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  args.calendarRolloverRange = args.rolloverCalendar
    ? manualCalendarRolloverRange(args.windowMode)
    : calendarRolloverRange(args.windowMode);
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
  const weekendManual = !args.scheduled && ['Sat', 'Sun'].includes(chicagoDateParts(checkedAt).weekday);
  if (weekendManual) {
    args.windowMode = 'afternoon';
    process.stderr.write('Weekend manual run detected; using latest regular-session futures path and Weekend Edition masthead.\n');
  }

  const futuresMode = args.windowMode === 'afternoon' ? 'session' : 'premarket';
  const futuresArgs = ['scripts/fetch_chart_data.js', 'futures', '--as-of', checkedAt.toISOString()];
  if (futuresMode === 'session') futuresArgs.push('--session');
  const futuresPreparation = runWithSectionFallback(
    () => runCommand('node', futuresArgs),
    () => buildUnavailableFuturesPayload(futuresMode, checkedAt),
    {
      label: 'Futures',
      readFresh: () => readJson(path.join(GENERATED_DIR, 'futures_module.json')),
      readFreshOnError: () => readCurrentFuturesModuleArtifact(futuresMode, checkedAt),
      validateFresh: (payload) => validateFuturesPayload(payload, { expectedMode: futuresMode }),
      validateFallback: (payload) => validateFuturesPayload(payload, { expectedMode: futuresMode })
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
  const weekAheadCommand = weekAheadPreparationCommandArgs(args, canonicalWeekAhead);
  const weekAheadRange = weekAheadCommand.targetRange;
  if (weekAheadCommand.invalidPersistedWeekAhead) {
    process.stderr.write('Week Ahead staging artifact is invalid under the current contract; rebuilding the active range.\n');
  }
  const weekAheadPreparation = runWithSectionFallback(
    () => runCommand('node', weekAheadCommand.commandArgs),
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
    const invalidPersistedArtifact = earningsStagingNeedsRebuild(EARNINGS_WEEK_PATH);
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
      throw new Error('Earnings calendar rebuild is not authorized for this run; retaining the validated active-range section.');
    }
    if (buildDecision.build) {
      const buildArgs = [
        'scripts/earnings_week.js',
        'build',
        '--from', earningsRange.from,
        '--to', earningsRange.to,
        '--as-of', checkedAt.toISOString()
      ];
      if (buildDecision.useEarningsApi) buildArgs.push('--use-earningsapi');
      if (buildDecision.skipEarningsApi) buildArgs.push('--skip-earningsapi');
      runCommand('node', buildArgs, { timeoutMs: EARNINGS_COMMAND_TIMEOUT_MS });
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
  if (args.prepareEditorialAfterStaging) {
    reportPreparationStatus('candidate ready', `staged at ${args.candidate}; canonical dashboard unchanged`);
    args.prepareEditorialDir = DEFAULT_EDITORIAL_DIR;
    const workspace = prepareEditorialWorkspace(args);
    process.stdout.write(`Editorial workspace prepared at ${args.prepareEditorialDir} for ${workspace.reviewManifest.marketLensDecisions.length} event day(s).\n`);
    return;
  }
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
  chartSeriesRevisionErrors,
  manualCalendarRolloverRange,
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
  parseArgs,
  prepareEditorialWorkspace,
  normalizePublicationDisplaySections,
  loadDashboardBase,
  readJsonBlock,
  replaceJsonBlock,
  requiresUnavailableRolloverRetry,
  earningsStagingNeedsRebuild,
  readCurrentEarningsWeekArtifact,
  readCurrentFuturesModuleArtifact,
  activeCalendarRange,
  earningsTargetRange,
  earningsCalendarBuildDecision,
  isEmptyEarningsRecoveryWeek,
  weekAheadStagingNeedsRebuild,
  weekAheadStagingMatchesRange,
  weekAheadPreparationCommandArgs,
  runCommand,
  runWithSectionFallback,
  reportPreparationStatus,
  stampDashboardEdition,
  stageDashboardCandidate,
  validateScheduledFinalization,
  validateScheduledStart
};
