#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveQuoteRowsFromSeries } = require('./fetch_chart_data');

const DEFAULT_DASHBOARD = path.resolve(process.cwd(), 'daily_financial_news.html');
const GENERATED_DIR = path.resolve(process.cwd(), 'generated');
const EARNINGS_WEEK_PATH = path.join(GENERATED_DIR, 'earnings_week.json');
const EARNINGS_NARRATIVE_PATH = path.join(GENERATED_DIR, 'earnings_narrative.json');
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
  return {
    lastScheduledUpdateAt,
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

function applyScheduledNewsBaseline(data, previousData, { scheduled = false } = {}) {
  const previousBaseline = sanitizeNewsBaseline(previousData?.newsBaseline ?? data.newsBaseline);
  // Manual runs can highlight stories that are new since the last scheduled run,
  // but only scheduled runs advance the baseline used by tomorrow's comparison.
  const comparisonIds = scheduled
    ? arrayStringSet(previousBaseline.currentScheduledStoryIds)
    : comparisonStoryIdsForManualRun(previousBaseline);

  markStoriesNewSinceBaseline(data, comparisonIds);

  if (scheduled) {
    data.newsBaseline = {
      lastScheduledUpdateAt: new Date().toISOString(),
      previousScheduledStoryIds: [...arrayStringSet(previousBaseline.currentScheduledStoryIds)].sort(),
      currentScheduledStoryIds: sortedDashboardNewsIds(data)
    };
    return;
  }

  data.newsBaseline = previousBaseline;
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
    skipEarnings: false,
    skipFutures: false,
    skipChartData: false,
    skipCryptoStats: false,
    skipAssetAllocationPortfolio: false,
    skipAssetAllocationSummary: false,
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
    if (arg === '--skip-validate') {
      args.skipValidate = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  const modeCount = [args.windowMode, args.applyDashboardDataJson, args.refreshNewsBaseline].filter(Boolean).length;
  if (modeCount === 0) {
    throw new Error('You must pass --morning, --afternoon, --apply-dashboard-data-json, or --refresh-news-baseline.');
  }

  if (modeCount > 1) {
    throw new Error('Use only one update mode: --morning, --afternoon, --apply-dashboard-data-json, or --refresh-news-baseline.');
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run_daily_update.js (--morning | --afternoon) [options]
  node scripts/run_daily_update.js --apply-dashboard-data-json PATH [options]
  node scripts/run_daily_update.js --refresh-news-baseline [--scheduled] [options]

Options:
  --dashboard PATH                     Dashboard HTML to patch (default: daily_financial_news.html)
  --apply-dashboard-data-json PATH    Safely replace only the embedded dashboard-data block from JSON
  --refresh-news-baseline             Recompute only story New-pill flags and newsBaseline
  --morning                           Run the pre-open deterministic refresh path
  --afternoon                         Run the after-close deterministic refresh path
  --scheduled                         Advance the News "New" baseline after a successful scheduled run
  --skip-earnings                     Skip earnings week refresh + embed
  --skip-futures                      Skip node scripts/fetch_futures_module.js and futuresModule patching
  --skip-chart-data                   Skip node scripts/fetch_chart_data.js and chart/quote-row patching
  --skip-crypto-stats                 Skip node scripts/fetch_crypto_stats.js and crypto.stats[] patching
  --skip-asset-allocation-portfolio   Skip Asset Allocation ETF row fetch and patching
  --skip-asset-allocation-summary     Skip Asset Allocation summary refresh/import and patching
  --skip-asset-allocation             Skip both asset-allocation fetchers and patch steps
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

function sentenceCaseCompany(row) {
  return String(row?.company || row?.symbol || 'This company').trim();
}

function fallbackOutcomeInterpretation(row, existingInterpretation = '') {
  const company = sentenceCaseCompany(row);
  const epsResult = String(row?.eps?.result || '').trim();
  const revenueResult = String(row?.revenue?.result || '').trim();
  const overall = String(row?.outcome?.overall || '').trim();
  if (!overall || overall === 'pending') return existingInterpretation;
  if (overall === 'beat') return `${company} beat on both EPS and revenue.`;
  if (overall === 'miss') return `${company} missed on both EPS and revenue.`;
  if (overall === 'mixed') {
    if (epsResult === 'beat' && revenueResult === 'miss') return `${company} beat on EPS but missed on revenue.`;
    if (epsResult === 'miss' && revenueResult === 'beat') return `${company} missed on EPS but beat on revenue.`;
    return `${company} delivered a mixed earnings read versus consensus.`;
  }
  if (overall === 'met') return `${company} came in roughly in line with consensus expectations.`;
  if (overall === 'eps_only_beat') return `${company} beat on EPS while revenue was not comparable against consensus.`;
  if (overall === 'eps_only_miss') return `${company} missed on EPS while revenue was not comparable against consensus.`;
  if (overall === 'unverified') return `${company} reported results, but the source set remains incomplete.`;
  return existingInterpretation;
}

function fallbackReactionNote(row, existingNote = '') {
  if (String(row?.reaction?.status || '').trim() !== 'computed') return '';
  const percent = Number(row?.reaction?.percent);
  if (!Number.isFinite(percent)) return existingNote;
  const company = sentenceCaseCompany(row);
  const direction = percent > 0 ? 'rose' : percent < 0 ? 'fell' : 'finished flat';
  const magnitude = percent === 0 ? '' : ` ${Math.abs(percent).toFixed(1)}%`;
  return `${company} shares ${direction}${magnitude} on the first eligible close after the report.`.replace(/\s+/g, ' ').trim();
}

function syncEarningsNarrativeSidecar() {
  const week = readJson(EARNINGS_WEEK_PATH);
  const existing = fs.existsSync(EARNINGS_NARRATIVE_PATH)
    ? readJson(EARNINGS_NARRATIVE_PATH)
    : { rows: [] };
  const existingByKey = new Map(
    (Array.isArray(existing.rows) ? existing.rows : []).map((row) => [earningsRowKey(row), row])
  );
  const rows = (Array.isArray(week.rows) ? week.rows : [])
    .filter((row) => existingByKey.has(earningsRowKey(row)))
    .map((row) => {
      const prior = existingByKey.get(earningsRowKey(row)) || {};
      return {
        symbol: row.symbol,
        reportDate: row.reportDate,
        eps: {
          note: String(prior.eps?.note || '')
        },
        revenue: {
          note: String(prior.revenue?.note || '')
        },
        outcome: {
          guide: String(prior.outcome?.guide || ''),
          interpretation: fallbackOutcomeInterpretation(row, String(prior.outcome?.interpretation || ''))
        },
        reaction: {
          note: fallbackReactionNote(row, String(prior.reaction?.note || ''))
        }
      };
    });
  if (!rows.length) {
    throw new Error('Cannot sync earnings narrative sidecar because it has no row overlap with the current earnings week.');
  }
  writeJson(EARNINGS_NARRATIVE_PATH, {
    schemaVersion: 1,
    sourceArtifact: 'generated/earnings_week.json',
    sourceGeneratedAt: week.generatedAt,
    sourceRange: week.range,
    rows,
    outputPath: EARNINGS_NARRATIVE_PATH
  });
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

  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled });
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
  applyScheduledNewsBaseline(dashboardData, previousDashboardData, { scheduled: args.scheduled });
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
  applyScheduledNewsBaseline(dashboardData, dashboardData, { scheduled: args.scheduled });
  nextHtml = patchDashboardDataBlock(nextHtml, dashboardData);
  fs.writeFileSync(args.dashboard, nextHtml);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dashboard)) {
    throw new Error(`Dashboard file not found: ${args.dashboard}`);
  }
  if (args.applyDashboardDataJson && !fs.existsSync(args.applyDashboardDataJson)) {
    throw new Error(`dashboard-data JSON file not found: ${args.applyDashboardDataJson}`);
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

  if (!args.skipEarnings) {
    runCommand('node', ['scripts/earnings_week.js', 'refresh']);
    syncEarningsNarrativeSidecar();
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
    process.exit(1);
  }
}

module.exports = {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  applyDashboardDataJson,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyFuturesModule,
  applyScheduledNewsBaseline,
  applyTapeQuoteRows,
  syncDashboardPricesFromChartData,
  patchDashboardDataBlock,
  readJsonBlock,
  replaceJsonBlock,
  refreshNewsBaseline,
  storyIdentity,
  stampDashboardEdition
};
