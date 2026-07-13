#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compactChartPayload, deriveQuoteRowsFromSeries, roundChartPayload, validateFuturesPayload } = require('./fetch_chart_data');
const {
  buildEarningsWeekPolicy,
  buildEarningsNarrativeSidecar
} = require('./earnings_week_contract');
const {
  applyEarningsNarrative,
  earningsCalendarNeedsBuild,
  earningsScheduleConfirmationRequiredError,
  pendingEarningsScheduleReviews,
  validateEarningsWeekPayload
} = require('./earnings_week');
const { applyMarketLensDecisions, applyWeekAheadLifecycle, mergeWeekAheadPayload } = require('./week_ahead_contract');
const { addDays } = require('./calendar_contract');
const { REQUIRED_EDITORIAL_SECTIONS, buildEditorialReview, validateReviewManifest } = require('./editorial_review_contract');
const { applyScheduledNewsBaseline } = require('./news_contract');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DASHBOARD = path.join(ROOT, 'daily_financial_news.html');
const GENERATED_DIR = path.join(ROOT, 'generated');
const DEFAULT_CANDIDATE = path.join(GENERATED_DIR, 'daily_financial_news.candidate.html');
const EARNINGS_WEEK_PATH = path.join(GENERATED_DIR, 'earnings_week.json');
const EARNINGS_NARRATIVE_PATH = path.join(GENERATED_DIR, 'earnings_narrative.json');
const EDITORIAL_EARNINGS_NARRATIVE_FILENAME = 'earnings_narrative.json';
const WEEK_AHEAD_PATH = path.join(GENERATED_DIR, 'week_ahead.json');
const SCHEDULED_WINDOWS = {
  morning: { startMinutes: 6 * 60 + 45, endMinutes: 8 * 60 },
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

function validateScheduledPreflight(dashboard, windowMode, now = scheduledNow()) {
  const range = SCHEDULED_WINDOWS[windowMode];
  if (!range) throw new Error('Scheduled preflight requires --morning or --afternoon.');
  const parts = chicagoDateParts(now);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) {
    throw new Error('Scheduled preflight only permits weekday runs in America/Chicago.');
  }
  if (parts.clockMinutes === null || parts.clockMinutes < range.startMinutes || parts.clockMinutes > range.endMinutes) {
    throw new Error(`Scheduled ${windowMode} preflight is outside its America/Chicago update window.`);
  }
  const dashboardData = readJsonBlock(fs.readFileSync(dashboard, 'utf8'), 'dashboard-data');
  const windowId = `${parts.isoDate}:${windowMode}`;
  if (completedScheduledWindow(dashboardData.newsBaseline) === windowId) {
    throw new Error(`Scheduled ${windowMode} preflight refused: ${windowId} already completed.`);
  }
  return windowId;
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
    editorialReviewJson: '',
    prepareEditorialDir: '',
    applyMarketLensJson: '',
    applyEarningsWeekJson: '',
    applyCryptoStatsJson: '',
    applyChartDataJson: '',
    mergeChartDataJson: '',
    refreshNewsBaseline: false,
    syncChartQuotes: false,
    scheduledPreflight: false,
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
    if (arg === '--editorial-review-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--editorial-review-json requires a path.');
      args.editorialReviewJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--prepare-editorial-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--prepare-editorial-dir requires a path.');
      args.prepareEditorialDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-market-lens-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-market-lens-json requires a path.');
      args.applyMarketLensJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-earnings-week-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-earnings-week-json requires a path.');
      args.applyEarningsWeekJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--apply-crypto-stats-json') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--apply-crypto-stats-json requires a path.');
      args.applyCryptoStatsJson = path.resolve(process.cwd(), argv[i + 1]);
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
    if (arg === '--refresh-news-baseline') {
      args.refreshNewsBaseline = true;
      continue;
    }
    if (arg === '--sync-chart-quotes') {
      args.syncChartQuotes = true;
      continue;
    }
    if (arg === '--scheduled-preflight') {
      args.scheduledPreflight = true;
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

  const contentModeCount = [args.applyDashboardDataJson, args.applyMarketLensJson, args.applyEarningsWeekJson, args.applyCryptoStatsJson, args.applyChartDataJson, args.mergeChartDataJson, args.prepareEditorialDir, args.refreshNewsBaseline, args.syncChartQuotes].filter(Boolean).length;
  if (args.scheduledPreflight) {
    if (!args.windowMode || contentModeCount) {
      throw new Error('Use --scheduled-preflight with exactly one of --morning or --afternoon.');
    }
    return args;
  }
  if (!args.windowMode && contentModeCount === 0) {
    throw new Error('You must pass --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-market-lens-json, --apply-earnings-week-json, --apply-crypto-stats-json, --apply-chart-data-json, --merge-chart-data-json, --refresh-news-baseline, or --sync-chart-quotes.');
  }
  const windowAwareContentMode = args.applyDashboardDataJson || args.applyMarketLensJson || args.prepareEditorialDir || args.refreshNewsBaseline;
  if (contentModeCount > 1 || (args.windowMode && contentModeCount && !windowAwareContentMode)) {
    throw new Error('Use only one update mode: --morning, --afternoon, --prepare-editorial-dir, --apply-dashboard-data-json, --apply-market-lens-json, --apply-earnings-week-json, --apply-crypto-stats-json, --apply-chart-data-json, --merge-chart-data-json, --refresh-news-baseline, or --sync-chart-quotes.');
  }
  const scheduledContentMode = args.refreshNewsBaseline || args.applyDashboardDataJson || args.applyMarketLensJson;
  if (args.scheduled && (!scheduledContentMode || !args.windowMode)) {
    throw new Error('--scheduled requires --morning or --afternoon and is valid only with baseline refresh or editorial application.');
  }
  if (args.applyDashboardDataJson && !args.editorialReviewJson) {
    throw new Error('--apply-dashboard-data-json requires --editorial-review-json so every editorial section and Market Lens day is explicitly reviewed.');
  }
  if (args.editorialReviewJson && !args.applyDashboardDataJson) {
    throw new Error('--editorial-review-json is only valid with --apply-dashboard-data-json.');
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
  node scripts/run_daily_update.js --apply-dashboard-data-json PATH --editorial-review-json PATH [--scheduled --morning|--afternoon] [options]
  node scripts/run_daily_update.js --apply-market-lens-json PATH [options]
  node scripts/run_daily_update.js --apply-earnings-week-json PATH [options]
  node scripts/run_daily_update.js --apply-crypto-stats-json PATH [options]
  node scripts/run_daily_update.js --apply-chart-data-json PATH [options]
  node scripts/run_daily_update.js --merge-chart-data-json PATH [options]
  node scripts/run_daily_update.js --refresh-news-baseline [--scheduled --morning|--afternoon] [options]
  node scripts/run_daily_update.js --sync-chart-quotes [options]
  node scripts/run_daily_update.js --scheduled-preflight (--morning | --afternoon) [options]

Options:
  --dashboard PATH                     Canonical dashboard HTML (default: daily_financial_news.html)
  --candidate PATH                     Staged complete candidate (default: generated/daily_financial_news.candidate.html)
  --apply-dashboard-data-json PATH    Safely replace only the embedded dashboard-data block from JSON
  --editorial-review-json PATH        Required full editorial review manifest for dashboard-data application
  --prepare-editorial-dir PATH        Write dashboard-data, Earnings narrative tasks, and review-manifest handoff files
  --apply-market-lens-json PATH       Apply a full review manifest containing one decision for every event day
  --apply-earnings-week-json PATH     Validate and embed a staged earnings-week payload
  --apply-crypto-stats-json PATH      Embed staged crypto stat-card data
  --apply-chart-data-json PATH        Safely replace embedded chart history and derive matching Tape prices from JSON
  --merge-chart-data-json PATH        Merge generated chart series into embedded history and preserve all other series
  --refresh-news-baseline             Recompute only story New-pill flags and newsBaseline
  --sync-chart-quotes                 Rebuild embedded chart quote rows and visible Tape prices from rounded chart history
  --scheduled-preflight               Verify the Chicago-time window and duplicate marker without writing files
  --morning                           Run the pre-open deterministic refresh path
  --afternoon                         Run the after-close deterministic refresh path
  --scheduled                         Atomically advance the News "New" baseline during final editorial application
  --skip-earnings                     Skip earnings week refresh + orchestrated embed
  --skip-futures                      Skip node scripts/fetch_chart_data.js futures and futuresModule patching
  --skip-chart-data                   Skip node scripts/fetch_chart_data.js and chart/quote-row patching
  --skip-crypto-stats                 Skip node scripts/fetch_crypto_stats.js and crypto.stats[] patching
  --skip-asset-allocation-portfolio   Skip Asset Allocation ETF row fetch and patching
  --skip-asset-allocation-summary     Skip Asset Allocation summary refresh/import and patching
  --skip-asset-allocation             Skip both asset-allocation fetchers and patch steps
  --skip-week-ahead                   Skip Week Ahead slate/value refresh and patching
  --help                              Show this help

Scheduled finalization rechecks the weekday/time window and duplicate marker before writing.
Manual finalization is time-unrestricted and preserves the scheduled News baseline.

This orchestrator standardizes the three-phase daily workflow:
  1. refresh deterministic data and edition metadata
  2. prepare dashboard-data, Earnings narrative tasks, and review-manifest files for editorial work
  3. merge editorial work, advance the scheduled baseline, stamp, receipt, validate, and atomically apply

Publish remains a separate explicit step via ./scripts/publish_main.sh.
`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertCandidateMatchesCanonical(args, candidateData) {
  const canonicalData = readJsonBlock(fs.readFileSync(args.dashboard, 'utf8'), 'dashboard-data');
  if (candidateData.editionId !== canonicalData.editionId) {
    throw new Error('Staged dashboard candidate is stale; rerun deterministic preparation before editorial work.');
  }
  return canonicalData;
}

function prepareEditorialWorkspace(args) {
  const html = fs.readFileSync(args.candidate, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  assertCandidateMatchesCanonical(args, dashboardData);
  const baseEditionId = dashboardData.editionId;
  delete dashboardData.editorialReview;
  if (args.windowMode) applyEditionMetadata(dashboardData, args.windowMode);
  delete dashboardData.lede;
  delete dashboardData.renesas;
  const marketLensDecisions = (dashboardData.weekAhead?.days || [])
    .filter((day) => Array.isArray(day?.events) && day.events.length)
    .map((day) => ({ date: day.date, action: null }));
  const reviewManifest = {
    schemaVersion: 1,
    reviewedAt: null,
    baseEditionId,
    sections: [...REQUIRED_EDITORIAL_SECTIONS],
    verifiedClaims: [],
    marketLensDecisions
  };
  fs.mkdirSync(args.prepareEditorialDir, { recursive: true });
  const earningsNarrativePath = path.join(args.prepareEditorialDir, EDITORIAL_EARNINGS_NARRATIVE_FILENAME);
  const existingEarningsNarrative = fs.existsSync(EARNINGS_NARRATIVE_PATH)
    ? readJson(EARNINGS_NARRATIVE_PATH)
    : { rows: [] };
  const earningsNarrative = buildEarningsNarrativeSidecar(dashboardData.earnings?.week || { rows: [] }, existingEarningsNarrative, {
    outputPath: path.relative(ROOT, earningsNarrativePath)
  }).payload;
  writeJson(path.join(args.prepareEditorialDir, 'dashboard-data.json'), dashboardData);
  writeJson(path.join(args.prepareEditorialDir, 'editorial-review.json'), reviewManifest);
  writeJson(earningsNarrativePath, earningsNarrative);
  return { dashboardData, earningsNarrative, reviewManifest };
}

function stageEarningsNarrativeTasks() {
  const week = readJson(EARNINGS_WEEK_PATH);
  const existing = fs.existsSync(EARNINGS_NARRATIVE_PATH)
    ? readJson(EARNINGS_NARRATIVE_PATH)
    : { rows: [] };
  const { payload } = buildEarningsNarrativeSidecar(week, existing, {
    outputPath: EARNINGS_NARRATIVE_PATH
  });
  writeJson(EARNINGS_NARRATIVE_PATH, payload);
  return payload;
}

function readJsonBlock(html, id) {
  const match = html.match(new RegExp(`<script type="application/json" id="${escapeRegExp(id)}">([\\s\\S]*?)<\\/script>`));
  if (!match) {
    throw new Error(`Could not find ${id} JSON block in dashboard HTML.`);
  }
  return JSON.parse(match[1]);
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

function commitDashboardCandidate(args, nextHtml, { requireEditorialReview = false } = {}) {
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

function applyCryptoStats(data, stats) {
  if (!data.crypto || typeof data.crypto !== 'object') {
    throw new Error('dashboard-data crypto payload is missing.');
  }
  if (!Array.isArray(stats) || !stats.length) {
    throw new Error('Generated crypto stats payload is missing stats[].');
  }
  data.crypto.stats = stats;
}

function applyEarningsWeek(data, earningsWeek, { requireNarrative = true } = {}) {
  const canonicalEarningsWeek = {
    ...earningsWeek,
    policy: buildEarningsWeekPolicy()
  };
  delete canonicalEarningsWeek.outputPath;
  const errors = validateEarningsWeekPayload(canonicalEarningsWeek, { requireNarrative });
  if (errors.length) {
    throw new Error(`Generated earnings week payload is invalid: ${errors.join(' ')}`);
  }
  data.earnings = {
    label: 'Earnings · Week Monitor',
    week: canonicalEarningsWeek
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
    futures: futuresPayload.futures
  };
}

function applyAssetAllocationPortfolio(data, portfolioPayload) {
  if (!Array.isArray(portfolioPayload?.rows) || !portfolioPayload.rows.length) {
    throw new Error('Generated asset allocation portfolio payload is missing rows[].');
  }
  data.assetAllocationPortfolio = {
    ...data.assetAllocationPortfolio,
    compiledAt: portfolioPayload.compiledAt,
    source: portfolioPayload.source,
    month: portfolioPayload.month,
    rows: portfolioPayload.rows
  };
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

function syncDashboardPricesFromChartData(data, chartData, { windowMode = '', now = scheduledNow() } = {}) {
  // dashboard-data keeps the visible tape fields, but those values are projections from chart-data.series,
  // not an independent editable truth during scheduled or manual maintenance flows.
  const derivedQuoteRows = deriveQuoteRowsFromSeries(Array.isArray(chartData?.series) ? chartData.series : []);
  chartData.quoteRows = derivedQuoteRows;
  applyTapeQuoteRows(data, derivedQuoteRows.tape);
  applyCryptoQuoteRows(data, derivedQuoteRows.crypto);
  if (data.weekAhead) data.weekAhead = applyWeekAheadLifecycle(data.weekAhead, chartData, { windowMode, now });
}

function patchDashboard(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  let dashboardData = readJsonBlock(html, 'dashboard-data');
  if (dashboardData.earnings?.week) delete dashboardData.earnings.week.outputPath;
  const previousDashboardData = dashboardData;
  let chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  let nextHtml = html;

  if (!args.skipChartData) {
    chartData = roundChartPayload(readJson(path.join(GENERATED_DIR, 'chart_data.json')));
    // chart-data.series is the canonical price history; quoteRows and dashboard tape prices are derived views.
    syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  }

  if (!args.skipFutures) {
    const futuresPayload = readJson(path.join(GENERATED_DIR, 'futures_module.json'));
    applyFuturesModule(dashboardData, futuresPayload, args.windowMode);
  }

  if (!args.skipCryptoStats) {
    const cryptoPayload = readJson(path.join(GENERATED_DIR, 'crypto_stats.json'));
    applyCryptoStats(dashboardData, cryptoPayload.stats);
  }

  if (!args.skipAssetAllocationPortfolio) {
    const portfolioPayload = readJson(path.join(GENERATED_DIR, 'asset_allocation_portfolio.json'));
    applyAssetAllocationPortfolio(dashboardData, portfolioPayload);
  }

  if (!args.skipAssetAllocationSummary) {
    const summaryPayload = readJson(path.join(GENERATED_DIR, 'asset_allocation_summary.json'));
    applyAssetAllocationSummary(dashboardData, summaryPayload);
  }

  if (!args.skipWeekAhead) {
    applyWeekAhead(dashboardData, readJson(WEEK_AHEAD_PATH));
    dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
  }

  if (!args.skipEarnings) {
    applyEarningsWeek(dashboardData, readJson(EARNINGS_WEEK_PATH), { requireNarrative: false });
  }

  applyEditionMetadata(dashboardData, args.windowMode);
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode, now: scheduledNow() });
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

function applyMarketLensJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const previousDashboardData = structuredClone(dashboardData);
  const chartData = readJsonBlock(html, 'chart-data');
  const reviewManifest = { ...readJson(args.applyMarketLensJson), reviewedAt: scheduledNow().toISOString() };
  const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: dashboardData.editionId });
  if (reviewErrors.length) throw new Error(reviewErrors.join(' '));
  applyMarketLensDecisionsData(dashboardData, chartData, reviewManifest.marketLensDecisions);
  dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
  if (args.windowMode) applyEditionMetadata(dashboardData, args.windowMode);
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode, now: scheduledNow() });
  commitEditorialCandidate(args, patchDashboardDataBlock(html, dashboardData, reviewManifest, chartData));
}

function applyEditorialEarningsNarrative(dashboardData, candidateDashboardData, narrativePath) {
  const candidateWeek = candidateDashboardData.earnings?.week;
  if (!candidateWeek) return null;
  const narrativeRequiredErrors = validateEarningsWeekPayload(candidateWeek, { requireNarrative: true });
  let finalWeek = candidateWeek;
  let narrativePayload = null;
  if (fs.existsSync(narrativePath)) {
    narrativePayload = readJson(narrativePath);
    if (Array.isArray(narrativePayload.rows) && narrativePayload.rows.length) {
      finalWeek = applyEarningsNarrative(candidateWeek, narrativePayload, {
        sourceArtifact: 'generated/earnings_week.json',
        narrativeArtifact: path.relative(ROOT, narrativePath)
      });
    }
  } else if (narrativeRequiredErrors.length) {
    throw new Error(`Editorial Earnings narrative not found: ${narrativePath}. Regenerate the editorial workspace.`);
  }
  const errors = validateEarningsWeekPayload(finalWeek, { requireNarrative: true });
  if (errors.length) throw new Error(`Editorial Earnings narrative is incomplete or invalid: ${errors.join(' ')}`);
  dashboardData.earnings = {
    ...candidateDashboardData.earnings,
    week: finalWeek
  };
  return { narrativePayload, week: finalWeek };
}

function applyDashboardDataJson(args) {
  const canonicalHtml = fs.readFileSync(args.dashboard, 'utf8');
  const candidateHtml = fs.readFileSync(args.candidate, 'utf8');
  const candidateDashboardData = readJsonBlock(candidateHtml, 'dashboard-data');
  const previousDashboardData = assertCandidateMatchesCanonical(args, candidateDashboardData);
  const editorialDashboardData = readJson(args.applyDashboardDataJson);
  const reviewManifest = { ...readJson(args.editorialReviewJson), reviewedAt: scheduledNow().toISOString() };
  if (editorialDashboardData.editionId !== candidateDashboardData.editionId) {
    throw new Error('Editorial dashboard-data editionId must match the staged candidate; regenerate the editorial workspace.');
  }
  const dashboardData = structuredClone(candidateDashboardData);
  dashboardData.opening = editorialDashboardData.opening;
  dashboardData.stories = editorialDashboardData.stories;
  dashboardData.futuresModule = {
    ...dashboardData.futuresModule,
    stories: editorialDashboardData.futuresModule?.stories
  };
  dashboardData.crypto = {
    ...dashboardData.crypto,
    notes: editorialDashboardData.crypto?.notes
  };
  const candidateTapeLabel = String(candidateDashboardData.tape?.label || '');
  const editorialTapeLabel = String(editorialDashboardData.tape?.label || '');
  const candidateTapeContextIndex = candidateTapeLabel.indexOf(' · ');
  const editorialTapeContextIndex = editorialTapeLabel.indexOf(' · ');
  dashboardData.tape = {
    ...dashboardData.tape,
    label: `${candidateTapeContextIndex >= 0 ? candidateTapeLabel.slice(0, candidateTapeContextIndex) : candidateTapeLabel}${editorialTapeContextIndex >= 0 ? editorialTapeLabel.slice(editorialTapeContextIndex) : ''}`,
    rows: editorialDashboardData.tape?.rows
  };
  const candidateCompiled = String(candidateDashboardData.footer?.compiled || '');
  const editorialCompiled = String(editorialDashboardData.footer?.compiled || '');
  const candidateFooterContextIndex = candidateCompiled.indexOf(' · ');
  const editorialFooterContextIndex = editorialCompiled.indexOf(' · ');
  dashboardData.footer = {
    ...dashboardData.footer,
    compiled: `${candidateFooterContextIndex >= 0 ? candidateCompiled.slice(0, candidateFooterContextIndex) : candidateCompiled}${editorialFooterContextIndex >= 0 ? editorialCompiled.slice(editorialFooterContextIndex) : ''}`
  };
  const editorialWeekAheadDays = new Map(
    (Array.isArray(editorialDashboardData.weekAhead?.days) ? editorialDashboardData.weekAhead.days : [])
      .filter((day) => typeof day?.date === 'string')
      .map((day) => [day.date, day])
  );
  if (Array.isArray(dashboardData.weekAhead?.days)) {
    dashboardData.weekAhead.days = dashboardData.weekAhead.days.map((day) => {
      const editorialDay = editorialWeekAheadDays.get(day.date);
      if (!editorialDay) return day;
      const next = { ...day };
      if (Object.prototype.hasOwnProperty.call(editorialDay, 'outcome')) next.outcome = editorialDay.outcome;
      else delete next.outcome;
      return next;
    });
  }
  const earningsNarrativePath = path.join(path.dirname(args.applyDashboardDataJson), EDITORIAL_EARNINGS_NARRATIVE_FILENAME);
  const finalizedEarnings = applyEditorialEarningsNarrative(dashboardData, candidateDashboardData, earningsNarrativePath);
  applyEditionMetadata(dashboardData, args.windowMode);
  let reviewChartData;
  let nextHtml = canonicalHtml;
  try {
    const chartData = roundChartPayload(readJsonBlock(candidateHtml, 'chart-data'));
    syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
    const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
    if (reviewErrors.length) throw new Error(reviewErrors.join(' '));
    applyMarketLensDecisionsData(dashboardData, chartData, reviewManifest.marketLensDecisions);
    dashboardData.weekAhead = applyWeekAheadLifecycle(dashboardData.weekAhead, chartData, { windowMode: args.windowMode, now: scheduledNow() });
    reviewChartData = compactChartPayload(chartData);
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(reviewChartData));
  } catch (error) {
    // dashboard-data-only maintenance still works on staging fixtures that omit chart-data.
    if (/chart-data JSON block/.test(String(error?.message || ''))) {
      const reviewErrors = validateReviewManifest(reviewManifest, dashboardData, { expectedBaseEditionId: previousDashboardData.editionId });
      if (reviewErrors.length) throw new Error(reviewErrors.join(' '));
      reviewChartData = { schemaVersion: 1, series: [] };
      applyMarketLensDecisionsData(dashboardData, reviewChartData, reviewManifest.marketLensDecisions);
    } else {
      throw error;
    }
  }
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode, now: scheduledNow() });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData, reviewManifest, reviewChartData);
  commitEditorialCandidate(args, nextHtml);
  if (finalizedEarnings && path.resolve(args.dashboard) === DEFAULT_DASHBOARD) {
    writeJson(EARNINGS_WEEK_PATH, finalizedEarnings.week);
    if (finalizedEarnings.narrativePayload) writeJson(EARNINGS_NARRATIVE_PATH, finalizedEarnings.narrativePayload);
  }
}

function applyChartDataJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const chartData = roundChartPayload(readJson(args.applyChartDataJson));
  syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  commitDashboardCandidate(args, nextHtml);
}

function applyEarningsWeekJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const scheduleReviewPath = path.join(path.dirname(args.applyEarningsWeekJson), 'earnings_schedule_review.json');
  const scheduleReviews = pendingEarningsScheduleReviews(scheduleReviewPath, args.applyEarningsWeekJson);
  if (scheduleReviews.length) throw earningsScheduleConfirmationRequiredError(scheduleReviews);
  applyEarningsWeek(dashboardData, readJson(args.applyEarningsWeekJson));
  commitDashboardCandidate(args, patchDashboardDataBlock(html, dashboardData));
}

function applyCryptoStatsJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const payload = readJson(args.applyCryptoStatsJson);
  applyCryptoStats(dashboardData, payload.stats);
  commitDashboardCandidate(args, patchDashboardDataBlock(html, dashboardData));
}

function mergeChartDataJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const existingChartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  const incomingChartData = roundChartPayload(readJson(args.mergeChartDataJson));
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
  const chartData = {
    ...existingChartData,
    sourceFamilies: Array.from(new Set(series.map((item) => item?.source).filter(Boolean))),
    series
  };
  syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  commitDashboardCandidate(args, nextHtml);
}

function refreshNewsBaseline(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  let nextHtml = html;
  try {
    const chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
    syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  } catch (_error) {
    // Baseline-only fixtures may omit chart-data.
  }
  applyScheduledNewsBaseline(dashboardData, dashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode, now: scheduledNow() });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  commitDashboardCandidate(args, nextHtml);
}

function syncChartQuotes(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  const chartData = roundChartPayload(readJsonBlock(html, 'chart-data'));
  syncDashboardPricesFromChartData(dashboardData, chartData, { windowMode: args.windowMode });
  let nextHtml = replaceJsonBlock(html, 'chart-data', JSON.stringify(compactChartPayload(chartData)));
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  commitDashboardCandidate(args, nextHtml);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  args.calendarRolloverRange = calendarRolloverRange(args.windowMode);
  if (!fs.existsSync(args.dashboard)) {
    throw new Error(`Dashboard file not found: ${args.dashboard}`);
  }
  if (args.applyDashboardDataJson && !fs.existsSync(args.applyDashboardDataJson)) {
    throw new Error(`dashboard-data JSON file not found: ${args.applyDashboardDataJson}`);
  }
  if ((args.prepareEditorialDir || args.applyDashboardDataJson) && !fs.existsSync(args.candidate)) {
    throw new Error(`Staged dashboard candidate not found: ${args.candidate}. Run deterministic preparation first.`);
  }
  if (args.editorialReviewJson && !fs.existsSync(args.editorialReviewJson)) {
    throw new Error(`Editorial review JSON file not found: ${args.editorialReviewJson}`);
  }
  if (args.applyMarketLensJson && !fs.existsSync(args.applyMarketLensJson)) {
    throw new Error(`Market Lens decisions JSON file not found: ${args.applyMarketLensJson}`);
  }
  if (args.applyEarningsWeekJson && !fs.existsSync(args.applyEarningsWeekJson)) {
    throw new Error(`Earnings week JSON file not found: ${args.applyEarningsWeekJson}`);
  }
  if (args.applyCryptoStatsJson && !fs.existsSync(args.applyCryptoStatsJson)) {
    throw new Error(`Crypto stats JSON file not found: ${args.applyCryptoStatsJson}`);
  }
  if (args.applyChartDataJson && !fs.existsSync(args.applyChartDataJson)) {
    throw new Error(`chart-data JSON file not found: ${args.applyChartDataJson}`);
  }
  if (args.mergeChartDataJson && !fs.existsSync(args.mergeChartDataJson)) {
    throw new Error(`chart-data JSON file not found: ${args.mergeChartDataJson}`);
  }

  // Scheduled publication owns the time and duplicate guards. Manual runs use
  // the same edition paths without inheriting scheduler-only restrictions.
  if (args.scheduled) validateScheduledPreflight(args.dashboard, args.windowMode);

  if (args.prepareEditorialDir) {
    const workspace = prepareEditorialWorkspace(args);
    process.stdout.write(`Editorial workspace prepared at ${args.prepareEditorialDir} for ${workspace.reviewManifest.marketLensDecisions.length} event day(s).\n`);
    return;
  }

  if (args.scheduledPreflight) {
    const windowId = validateScheduledPreflight(args.dashboard, args.windowMode);
    process.stdout.write(`Scheduled preflight OK: ${windowId}\n`);
    return;
  }

  if (args.refreshNewsBaseline) {
    refreshNewsBaseline(args);
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

  if (args.applyCryptoStatsJson) {
    applyCryptoStatsJson(args);
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

  if (args.applyMarketLensJson) {
    applyMarketLensJson(args);
    return;
  }

  if (fs.existsSync(args.candidate)) fs.unlinkSync(args.candidate);

  if (!args.skipFutures) {
    const futuresArgs = ['scripts/fetch_chart_data.js', 'futures'];
    if (args.windowMode === 'afternoon') futuresArgs.push('--session');
    runCommand('node', futuresArgs);
  }

  if (!args.skipChartData) {
    runCommand('node', ['scripts/fetch_chart_data.js', '--input', args.dashboard]);
  }

  if (!args.skipCryptoStats) {
    runCommand('node', ['scripts/fetch_crypto_stats.js']);
  }

  if (!args.skipAssetAllocationPortfolio || !args.skipAssetAllocationSummary) {
    const assetAllocationArgs = ['scripts/fetch_asset_allocation.js'];
    if (args.skipAssetAllocationPortfolio) assetAllocationArgs.push('--skip-portfolio');
    if (args.skipAssetAllocationSummary) assetAllocationArgs.push('--skip-summary');
    runCommand('node', assetAllocationArgs);
  }

  if (!args.skipWeekAhead) {
    const weekAheadArgs = ['scripts/fetch_week_ahead.js'];
    if (args.calendarRolloverRange) weekAheadArgs.push('--date', args.calendarRolloverRange.from);
    else weekAheadArgs.push('--refresh-values', '--input', WEEK_AHEAD_PATH);
    runCommand('node', weekAheadArgs);
  }

  if (!args.skipEarnings) {
    if (earningsCalendarNeedsBuild(args.calendarRolloverRange)) {
      runCommand('node', [
        'scripts/earnings_week.js',
        'build',
        '--from', args.calendarRolloverRange.from,
        '--to', args.calendarRolloverRange.to
      ]);
    }
    const scheduleReviews = pendingEarningsScheduleReviews();
    if (scheduleReviews.length) throw earningsScheduleConfirmationRequiredError(scheduleReviews);
    runCommand('node', ['scripts/earnings_week.js', 'refresh']);
    stageEarningsNarrativeTasks();
  }

  stageDashboardCandidate(args, patchDashboard(args));
  process.stdout.write(`Deterministic dashboard candidate staged at ${args.candidate}; canonical dashboard unchanged.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`run_daily_update failed: ${error.message}\n`);
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
  applyMarketLensJson,
  applyChartDataJson,
  mergeChartDataJson,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyEarningsWeek,
  applyFuturesModule,
  applyWeekAhead,
  commitDashboardCandidate,
  applyEditionMetadata,
  chicagoDateParts,
  completedScheduledWindow,
  applyTapeQuoteRows,
  syncDashboardPricesFromChartData,
  patchDashboardDataBlock,
  prepareEditorialWorkspace,
  readJsonBlock,
  replaceJsonBlock,
  refreshNewsBaseline,
  stampDashboardEdition,
  stageDashboardCandidate,
  validateScheduledPreflight
};
