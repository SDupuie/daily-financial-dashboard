#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveQuoteRowsFromSeries } = require('./fetch_chart_data');
const { isDisplayEligibleEarningsRow } = require('./earnings_week_contract');
const { validateWeekAheadPayload } = require('./week_ahead_contract');
const { addDays } = require('./calendar_contract');

const DEFAULT_DASHBOARD = path.resolve(process.cwd(), 'daily_financial_news.html');
const GENERATED_DIR = path.resolve(process.cwd(), 'generated');
const EARNINGS_WEEK_PATH = path.join(GENERATED_DIR, 'earnings_week.json');
const EARNINGS_NARRATIVE_PATH = path.join(GENERATED_DIR, 'earnings_narrative.json');
const EARNINGS_SCHEDULE_REVIEW_PATH = path.join(GENERATED_DIR, 'earnings_schedule_review.json');
const WEEK_AHEAD_PATH = path.join(GENERATED_DIR, 'week_ahead.json');
const EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE = 2;
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

function normalizeStoryTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalStoryUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function storyIdentity(story) {
  const url = canonicalStoryUrl(story?.url);
  if (url) return `url:${url}`;
  const title = normalizeStoryTitle(story?.title);
  return title ? `title:${title}` : '';
}

function storyIdentitySet(stories) {
  return new Set(
    (Array.isArray(stories) ? stories : [])
      .map(storyIdentity)
      .filter(Boolean)
  );
}

function dashboardNewsItems(data) {
  return [
    ...(Array.isArray(data?.stories) ? data.stories : []),
    ...(Array.isArray(data?.crypto?.notes) ? data.crypto.notes : [])
  ];
}

function sortedDashboardNewsIds(data) {
  return [...storyIdentitySet(dashboardNewsItems(data))].sort();
}

function arrayStringSet(value) {
  return new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item));
}

function sanitizeNewsBaseline(value) {
  const baseline = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const lastScheduledUpdateAt = typeof baseline.lastScheduledUpdateAt === 'string'
    ? baseline.lastScheduledUpdateAt
    : null;
  const lastScheduledWindow = typeof baseline.lastScheduledWindow === 'string'
    ? baseline.lastScheduledWindow
    : null;
  return {
    lastScheduledUpdateAt,
    lastScheduledWindow,
    previousScheduledStoryIds: [...arrayStringSet(baseline.previousScheduledStoryIds)].sort(),
    currentScheduledStoryIds: [...arrayStringSet(baseline.currentScheduledStoryIds)].sort()
  };
}

function comparisonStoryIdsForManualRun(baseline) {
  const previous = arrayStringSet(baseline.previousScheduledStoryIds);
  return previous.size ? previous : arrayStringSet(baseline.currentScheduledStoryIds);
}

function markNewsItemsNewSinceBaseline(items, comparisonIds) {
  const hasComparison = comparisonIds.size > 0;
  return (Array.isArray(items) ? items : []).map((story) => {
    const next = story && typeof story === 'object' ? { ...story } : {};
    const id = storyIdentity(next);
    if (hasComparison && id && !comparisonIds.has(id)) {
      next.isNewSinceScheduledUpdate = true;
    } else {
      delete next.isNewSinceScheduledUpdate;
    }
    return next;
  });
}

function markStoriesNewSinceBaseline(data, comparisonIds) {
  data.stories = markNewsItemsNewSinceBaseline(data.stories, comparisonIds);
  if (data.crypto && typeof data.crypto === 'object' && !Array.isArray(data.crypto)) {
    data.crypto = {
      ...data.crypto,
      notes: markNewsItemsNewSinceBaseline(data.crypto.notes, comparisonIds)
    };
  }
}

function applyScheduledNewsBaseline(data, previousData, { scheduled = false, scheduledWindow = '', now = new Date() } = {}) {
  const previousBaseline = sanitizeNewsBaseline(previousData?.newsBaseline ?? data.newsBaseline);
  // Manual runs can highlight stories that are new since the last scheduled run,
  // but only scheduled runs advance the baseline used by tomorrow's comparison.
  const comparisonIds = scheduled
    ? arrayStringSet(previousBaseline.currentScheduledStoryIds)
    : comparisonStoryIdsForManualRun(previousBaseline);

  markStoriesNewSinceBaseline(data, comparisonIds);

  if (scheduled) {
    if (!SCHEDULED_WINDOWS[scheduledWindow]) {
      throw new Error('Scheduled baseline refresh requires --morning or --afternoon to record the completed window.');
    }
    data.newsBaseline = {
      lastScheduledUpdateAt: now.toISOString(),
      lastScheduledWindow: `${chicagoDateParts(now).isoDate}:${scheduledWindow}`,
      previousScheduledStoryIds: [...arrayStringSet(previousBaseline.currentScheduledStoryIds)].sort(),
      currentScheduledStoryIds: sortedDashboardNewsIds(data)
    };
    return;
  }

  data.newsBaseline = previousBaseline;
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

function earningsCalendarNeedsBuild(range, earningsWeekPath = EARNINGS_WEEK_PATH) {
  if (!range || !fs.existsSync(earningsWeekPath)) return Boolean(range);
  try {
    // A narrative-completion rerun must reuse the staged slate instead of
    // rebuilding it and invalidating the editorial work it is about to apply.
    const existingRange = readJson(earningsWeekPath).range;
    return existingRange?.from !== range.from || existingRange?.to !== range.to;
  } catch (_error) {
    return true;
  }
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
    editionId: new Date().toISOString()
  };
}

function parseArgs(argv) {
  const args = {
    dashboard: DEFAULT_DASHBOARD,
    windowMode: '',
    applyDashboardDataJson: '',
    refreshNewsBaseline: false,
    scheduledPreflight: false,
    skipEarnings: false,
    skipFutures: false,
    skipChartData: false,
    skipCryptoStats: false,
    skipAssetAllocationPortfolio: false,
    skipAssetAllocationSummary: false,
    skipWeekAhead: false,
    scheduled: false,
    skipValidate: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dashboard') {
      args.dashboard = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_DASHBOARD);
      i += 1;
      continue;
    }
    if (arg === '--apply-dashboard-data-json') {
      args.applyDashboardDataJson = path.resolve(process.cwd(), argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg === '--refresh-news-baseline') {
      args.refreshNewsBaseline = true;
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
    if (arg === '--skip-validate') {
      args.skipValidate = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  const contentModeCount = [args.applyDashboardDataJson, args.refreshNewsBaseline].filter(Boolean).length;
  if (args.scheduledPreflight) {
    if (!args.windowMode || contentModeCount) {
      throw new Error('Use --scheduled-preflight with exactly one of --morning or --afternoon.');
    }
    return args;
  }
  if (!args.windowMode && contentModeCount === 0) {
    throw new Error('You must pass --morning, --afternoon, --apply-dashboard-data-json, or --refresh-news-baseline.');
  }
  if (contentModeCount > 1 || (args.windowMode && contentModeCount && !(args.scheduled && args.refreshNewsBaseline))) {
    throw new Error('Use only one update mode: --morning, --afternoon, --apply-dashboard-data-json, or --refresh-news-baseline.');
  }
  if (args.scheduled && (!args.refreshNewsBaseline || !args.windowMode)) {
    throw new Error('--scheduled is only valid with --refresh-news-baseline plus --morning or --afternoon.');
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run_daily_update.js (--morning | --afternoon) [options]
  node scripts/run_daily_update.js --apply-dashboard-data-json PATH [options]
  node scripts/run_daily_update.js --refresh-news-baseline [--scheduled --morning|--afternoon] [options]
  node scripts/run_daily_update.js --scheduled-preflight (--morning | --afternoon) [options]

Options:
  --dashboard PATH                     Dashboard HTML to patch (default: daily_financial_news.html)
  --apply-dashboard-data-json PATH    Safely replace only the embedded dashboard-data block from JSON
  --refresh-news-baseline             Recompute only story New-pill flags and newsBaseline
  --scheduled-preflight               Verify the Chicago-time window and duplicate marker without writing files
  --morning                           Run the pre-open deterministic refresh path
  --afternoon                         Run the after-close deterministic refresh path
  --scheduled                         Advance the News "New" baseline for the completed scheduled window
  --skip-earnings                     Skip earnings week refresh + embed
  --skip-futures                      Skip node scripts/fetch_futures_module.js and futuresModule patching
  --skip-chart-data                   Skip node scripts/fetch_chart_data.js and chart/quote-row patching
  --skip-crypto-stats                 Skip node scripts/fetch_crypto_stats.js and crypto.stats[] patching
  --skip-asset-allocation-portfolio   Skip Asset Allocation ETF row fetch and patching
  --skip-asset-allocation-summary     Skip Asset Allocation summary refresh/import and patching
  --skip-asset-allocation             Skip both asset-allocation fetchers and patch steps
  --skip-week-ahead                   Skip Week Ahead calendar refresh and patching
  --skip-validate                     Skip node scripts/validate_dashboard.js
  --help                              Show this help

This orchestrator standardizes the deterministic local daily update flow:
  1. refresh staging fetchers for the selected update window
  2. refresh and embed the canonical earnings week payload
  3. patch embedded dashboard-data and chart-data blocks
  4. validate the dashboard

Publish remains a separate explicit step via ./scripts/publish_main.sh.
`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
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

function earningsRowKey(row) {
  return `${String(row?.symbol || '').trim().toUpperCase()}::${String(row?.reportDate || '').trim()}`;
}

function narrativeNeedsEditorialCopy(row, narrative) {
  if (!isDisplayEligibleEarningsRow(row)) return false;
  if (!String(narrative?.outcome?.interpretation || '').trim()) return true;
  if (row?.outcome?.overall !== 'pending' && !String(narrative?.outcome?.guide || '').trim()) return true;
  return row?.reaction?.status === 'computed' && !String(narrative?.reaction?.note || '').trim();
}

function canonicalNarrativeIsEmpty(row) {
  return [
    row?.eps?.note,
    row?.revenue?.note,
    row?.outcome?.guide,
    row?.outcome?.interpretation,
    row?.reaction?.note
  ].every((value) => !String(value || '').trim());
}

function buildEarningsNarrativeSidecar(week, existing = { rows: [] }) {
  const existingByKey = new Map(
    (Array.isArray(existing.rows) ? existing.rows : []).map((row) => [earningsRowKey(row), row])
  );
  const rows = (Array.isArray(week.rows) ? week.rows : [])
    // Keep prior editorial rows and stage any newly display-eligible row for human enrichment.
    .filter((row) => existingByKey.has(earningsRowKey(row)) || isDisplayEligibleEarningsRow(row))
    .map((row) => {
      const existingPrior = existingByKey.get(earningsRowKey(row));
      const prior = existingPrior || {};
      // earnings_week_refresh clears all narrative fields whenever deterministic
      // report facts change. Do not let this sidecar restore that pre-report copy.
      // The marker survives the first failed run so the editor's replacement copy
      // can be accepted on the rerun without being cleared a second time.
      const sidecarRefreshPending = prior.postReportRefreshRequired === true;
      const stalePriorCopy = Boolean(existingPrior)
        && canonicalNarrativeIsEmpty(row)
        && !sidecarRefreshPending;
      const nextNarrative = stalePriorCopy ? {} : prior;
      const missingEditorialCopy = narrativeNeedsEditorialCopy(row, nextNarrative);
      const postReportRefreshRequired = missingEditorialCopy
        && (sidecarRefreshPending || stalePriorCopy || !existingPrior);
      return {
        symbol: row.symbol,
        reportDate: row.reportDate,
        eps: {
          note: String(nextNarrative.eps?.note || '')
        },
        revenue: {
          note: String(nextNarrative.revenue?.note || '')
        },
        outcome: {
          guide: String(nextNarrative.outcome?.guide || ''),
          // Numeric beat/miss fields are displayed separately. Keep only the
          // editorial thesis and release-backed forward guidance here.
          interpretation: String(nextNarrative.outcome?.interpretation || '')
        },
        reaction: {
          // The calculated percentage already appears in the monitor. Keep only
          // editorial commentary that explains the reaction's likely driver.
          note: String(nextNarrative.reaction?.note || '')
        },
        ...(postReportRefreshRequired ? { postReportRefreshRequired: true } : {})
      };
    });
  const rowsByKey = new Map(rows.map((row) => [earningsRowKey(row), row]));
  const missingRows = (Array.isArray(week.rows) ? week.rows : [])
    .filter((row) => narrativeNeedsEditorialCopy(row, rowsByKey.get(earningsRowKey(row))))
    .map((row) => ({ symbol: row.symbol, reportDate: row.reportDate }));
  return {
    payload: {
      schemaVersion: 1,
      sourceArtifact: 'generated/earnings_week.json',
      sourceGeneratedAt: week.generatedAt,
      sourceRange: week.range,
      rows,
      outputPath: EARNINGS_NARRATIVE_PATH
    },
    missingRows
  };
}

function syncEarningsNarrativeSidecar() {
  const week = readJson(EARNINGS_WEEK_PATH);
  const existing = fs.existsSync(EARNINGS_NARRATIVE_PATH)
    ? readJson(EARNINGS_NARRATIVE_PATH)
    : { rows: [] };
  const { payload, missingRows } = buildEarningsNarrativeSidecar(week, existing);
  const rows = payload.rows;
  if (!rows.length) {
    throw new Error('Cannot sync earnings narrative sidecar because it has no row overlap with the current earnings week.');
  }
  writeJson(EARNINGS_NARRATIVE_PATH, payload);
  return missingRows;
}

function earningsEditorialRequiredError(rows) {
  const labels = rows.map((row) => `${row.symbol} (${row.reportDate})`).join(', ');
  const error = new Error(
    `Earnings editorial enrichment is required before this dashboard can be updated: ${labels}`
  );
  error.exitCode = EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE;
  return error;
}

function pendingEarningsScheduleReviews() {
  if (!fs.existsSync(EARNINGS_SCHEDULE_REVIEW_PATH)) return [];
  const review = readJson(EARNINGS_SCHEDULE_REVIEW_PATH);
  const week = readJson(EARNINGS_WEEK_PATH);
  if (review?.range?.from !== week?.range?.from || review?.range?.to !== week?.range?.to) return [];
  return Array.isArray(review.rows) ? review.rows : [];
}

function earningsScheduleConfirmationRequiredError(rows) {
  const labels = rows.map((row) => `${row.symbol} (${row.primaryDate})`).join(', ');
  const error = new Error(
    `Official company IR date confirmation is required before this dashboard can be updated: ${labels}`
  );
  error.exitCode = EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE;
  return error;
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

function patchDashboardDataBlock(html, dashboardData) {
  const stampedData = stampDashboardEdition(dashboardData);
  return replaceJsonBlock(html, 'dashboard-data', `\n${JSON.stringify(stampedData, null, 2)}\n`);
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

function applyFuturesModule(data, futuresPayload, windowMode) {
  if (!Array.isArray(futuresPayload?.futures) || futuresPayload.futures.length !== 4) {
    throw new Error('Generated futures payload must contain exactly four futures rows.');
  }
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

function hasEditorialMarketLens(day) {
  const value = day?.marketLens;
  return day?.marketLensSource === 'editorial'
    && Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.title === 'string'
    && typeof value.body === 'string'
    && Array.isArray(value.watchlist)
    && value.watchlist.every((item) => typeof item === 'string');
}

function applyWeekAhead(data, weekAheadPayload) {
  const errors = validateWeekAheadPayload(weekAheadPayload);
  if (errors.length) throw new Error(`Generated Week Ahead payload is invalid: ${errors.join(' ')}`);
  // Editorial lenses are the only Week Ahead field that survives a deterministic
  // refresh, and only when its calendar date remains in the refreshed range.
  const existingLenses = new Map(
    (Array.isArray(data.weekAhead?.days) ? data.weekAhead.days : [])
      .filter((day) => typeof day?.date === 'string' && hasEditorialMarketLens(day))
      .map((day) => [day.date, day.marketLens])
  );
  data.weekAhead = {
    ...weekAheadPayload,
    days: weekAheadPayload.days.map((day) => {
      const next = { ...day };
      const editorialLens = existingLenses.get(day.date);
      if (editorialLens && Array.isArray(day.events) && day.events.length > 0) {
        next.marketLens = editorialLens;
        next.marketLensSource = 'editorial';
      }
      return next;
    })
  };
}

function patchWeekAheadRollover(args, weekAheadPath = WEEK_AHEAD_PATH) {
  if (args.skipWeekAhead || !args.calendarRolloverRange) return false;
  // This deliberate partial commit keeps the calendar on schedule when Earnings
  // pauses later for required, section-specific editorial narratives.
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  applyWeekAhead(dashboardData, readJson(weekAheadPath));
  fs.writeFileSync(args.dashboard, patchDashboardDataBlock(html, dashboardData));
  return true;
}

function syncDashboardPricesFromChartData(data, chartData) {
  // dashboard-data keeps the visible tape fields, but those values are projections from chart-data.series,
  // not an independent editable truth during scheduled or manual maintenance flows.
  const derivedQuoteRows = deriveQuoteRowsFromSeries(Array.isArray(chartData?.series) ? chartData.series : []);
  chartData.quoteRows = derivedQuoteRows;
  applyTapeQuoteRows(data, derivedQuoteRows.tape);
  applyCryptoQuoteRows(data, derivedQuoteRows.crypto);
}

function patchDashboard(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  let dashboardData = readJsonBlock(html, 'dashboard-data');
  const previousDashboardData = dashboardData;
  let nextHtml = html;

  if (!args.skipChartData) {
    const chartData = readJson(path.join(GENERATED_DIR, 'chart_data.json'));
    // chart-data.series is the canonical price history; quoteRows and dashboard tape prices are derived views.
    syncDashboardPricesFromChartData(dashboardData, chartData);
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', `\n${JSON.stringify(chartData, null, 2)}\n`);
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

  if (!args.skipWeekAhead && args.calendarRolloverRange) {
    applyWeekAhead(dashboardData, readJson(WEEK_AHEAD_PATH));
  }

  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  fs.writeFileSync(args.dashboard, nextHtml);
}

function applyDashboardDataJson(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const previousDashboardData = readJsonBlock(html, 'dashboard-data');
  const dashboardData = readJson(args.applyDashboardDataJson);
  let nextHtml = html;
  try {
    const chartData = readJsonBlock(html, 'chart-data');
    syncDashboardPricesFromChartData(dashboardData, chartData);
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', `\n${JSON.stringify(chartData, null, 2)}\n`);
  } catch (_error) {
    // dashboard-data-only maintenance still works on staging fixtures that omit chart-data.
  }
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  fs.writeFileSync(args.dashboard, nextHtml);
}

function refreshNewsBaseline(args) {
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const dashboardData = readJsonBlock(html, 'dashboard-data');
  let nextHtml = html;
  try {
    const chartData = readJsonBlock(html, 'chart-data');
    syncDashboardPricesFromChartData(dashboardData, chartData);
    nextHtml = replaceJsonBlock(nextHtml, 'chart-data', `\n${JSON.stringify(chartData, null, 2)}\n`);
  } catch (_error) {
    // Baseline-only fixtures may omit chart-data.
  }
  applyScheduledNewsBaseline(dashboardData, dashboardData, { scheduled: args.scheduled, scheduledWindow: args.windowMode });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  fs.writeFileSync(args.dashboard, nextHtml);
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

  if (args.scheduledPreflight) {
    const windowId = validateScheduledPreflight(args.dashboard, args.windowMode);
    process.stdout.write(`Scheduled preflight OK: ${windowId}\n`);
    return;
  }

  if (args.refreshNewsBaseline) {
    refreshNewsBaseline(args);
    if (!args.skipValidate) {
      runCommand('node', ['scripts/validate_dashboard.js', args.dashboard]);
    }
    return;
  }

  if (args.applyDashboardDataJson) {
    applyDashboardDataJson(args);
    if (!args.skipValidate) {
      runCommand('node', ['scripts/validate_dashboard.js', args.dashboard]);
    }
    return;
  }

  if (!args.skipFutures) {
    const futuresArgs = ['scripts/fetch_futures_module.js'];
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

  if (!args.skipWeekAhead && args.calendarRolloverRange) {
    runCommand('node', ['scripts/fetch_week_ahead.js', '--date', args.calendarRolloverRange.from]);
    // Week Ahead has a valid generated-lens fallback, so its calendar rollover
    // is committed before Earnings can stop for required editorial narratives.
    patchWeekAheadRollover(args);
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
    const missingNarrativeRows = syncEarningsNarrativeSidecar();
    if (missingNarrativeRows.length) {
      // A standalone refresh must never leave an older embedded earnings monitor
      // looking publishable. Codex completes this editorial work on scheduled and
      // manual dashboard runs, then reruns the deterministic path.
      throw earningsEditorialRequiredError(missingNarrativeRows);
    }
    runCommand('node', ['scripts/earnings_week.js', 'apply-narrative']);
    runCommand('node', ['scripts/earnings_week.js', 'embed', '--dashboard', args.dashboard]);
  }

  patchDashboard(args);

  if (!args.skipValidate) {
    runCommand('node', ['scripts/validate_dashboard.js', args.dashboard]);
  }
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
  buildEarningsNarrativeSidecar,
  calendarRolloverRange,
  earningsCalendarNeedsBuild,
  earningsScheduleConfirmationRequiredError,
  earningsEditorialRequiredError,
  EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE,
  applyDashboardDataJson,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyFuturesModule,
  applyWeekAhead,
  patchWeekAheadRollover,
  applyScheduledNewsBaseline,
  chicagoDateParts,
  completedScheduledWindow,
  applyTapeQuoteRows,
  syncDashboardPricesFromChartData,
  patchDashboardDataBlock,
  readJsonBlock,
  replaceJsonBlock,
  refreshNewsBaseline,
  storyIdentity,
  stampDashboardEdition,
  validateScheduledPreflight
};
