#!/usr/bin/env node

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { isIsoDate, isIsoDateTime } = require('./calendar_contract');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isPartialRefresh,
  isAllowedBrowserOrigin,
  latestEmbeddedChartDate,
  localRefreshChartRows,
  parseArgs: parseLocalMarketServerArgs,
  refreshWindow
} = require('./local_market_server');
const {
  compactChartPayload,
  finnhubQuoteBarFromPayload,
  mergeFinnhubQuoteBar,
  parseArgs: parseFetchChartDataArgs,
  quoteRowFromSeries,
  shouldUseFinnhubQuoteFallback,
  validateFuturesPayload,
} = require('./fetch_chart_data');
const { normalizedSummary } = require('./fetch_asset_allocation');
const {
  chartableRowsFromDashboardHtml,
  decodeObjectSeries,
  decodeTupleSeries,
  validateChartDataPayload,
  validateChartPayload,
  validateChartPayloadMetadata,
  validateDashboardHtml
} = require('./validate_dashboard');
const {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  applyEditionMetadata,
  patchDashboardDataBlock,
  applyCryptoQuoteRows,
  applyCryptoStats,
  commitDashboardCandidate,
  applyFuturesModule,
  applyTapeQuoteRows,
  readJsonBlock,
  replaceJsonBlock,
  syncDashboardPricesFromChartData,
  stampDashboardEdition
} = require('./run_daily_update');
const { normalizeWeekAhead } = require('./week_ahead_contract');
const { EARNINGS_USER_ACTION_REQUIRED_EXIT_CODE, buildEarningsWeekPolicy } = require('./earnings_week_contract');
const {
  REQUIRED_EDITORIAL_SECTIONS,
  buildEditorialReview,
  editorialPayloadHash,
  superlativeClaims,
  validateReviewManifest
} = require('./editorial_review_contract');
const root = path.resolve(__dirname, '..');
// Complete synthetic dashboard used as the valid baseline for validator mutation tests.
const FIXTURE_NOW = '2026-07-10T13:30:00Z';

function story(kind, index) {
  const url = `https://fixture.test/${kind}-${index}`;
  return {
    tag: kind === 'crypto' ? 'Crypto' : 'Markets',
    tone: kind === 'crypto' ? 'crypto' : 'neutral',
    kicker: kind === 'crypto' ? 'Digital assets' : undefined,
    title: `${kind} fixture story ${index}`,
    body: `Fixture reporting item ${index} provides a concise, dated market-development summary for validator coverage.`,
    url,
    publishedOn: '2026-07-10',
    isNewSinceScheduledUpdate: false
  };
}

function fixtureFutures() {
  const symbols = ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'];
  const sessionOpen = Date.parse('2026-07-10T13:30:00Z') / 1000;
  const sessionClose = Date.parse('2026-07-10T20:00:00Z') / 1000;
  return Array.from({ length: 4 }, (_item, index) => ({
    symbol: symbols[index],
    label: `Fixture future ${index + 1}`,
    value: '+1.00%',
    dir: 'up',
    body: 'Fixture index futures are one percent higher versus the prior 4 PM ET close after a constructive cash session.',
    series: [[sessionOpen, 100], [sessionClose, 101]],
    raw: {
      previousClose: 100,
      referencePrice: 100,
      price: 101,
      regularMarketTime: sessionClose,
      delta: 1,
      pct: 1,
      sessionOpen: 100,
      sessionDate: '2026-07-10',
      referenceDate: '2026-07-09',
      referenceLabel: 'vs prior 4 PM ET close',
      marketTimeZone: 'America/New_York',
      sessionStartEastern: '9:30 AM ET',
      sessionEndEastern: '4:00 PM ET',
      referenceCloseEastern: '4:00 PM ET'
    }
  }));
}

function fixturePortfolioRows() {
  return ['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX'].map((ticker) => ({
    ticker,
    sleeve: 'Fixture sleeve',
    price: '$100.00',
    monthDivPerShare: '$0.00',
    dailyPriceChange: '+0.00%',
    dailyTR: '+0.00%',
    mtdPriceChange: '+0.00%',
    mtdTR: '+0.00%',
    upcomingCurrentMonthDividends: 'None',
    upcomingCurrentMonthDividendsValue: 0,
    upcomingCurrentMonthDividendEvents: [],
    futureMonthDividends: 'None',
    futureMonthDividendsValue: 0,
    futureMonthDividendEvents: []
  }));
}

function fixtureEarningsWeek() {
  return {
    schemaVersion: 2,
    generatedAt: '2026-07-10T12:00:00.000Z',
    range: { from: '2026-07-10', to: '2026-07-16' },
    policy: buildEarningsWeekPolicy(),
    rows: [],
    secondaryRecoveryCandidates: [],
    companyReleaseTasks: [],
    summary: {
      counts: {
        total: 0,
        verified: 0,
        partial: 0,
        reactionComputed: 0,
        missingTiming: 0,
        missingRevenue: 0,
        missingMarketCap: 0,
        secondaryRecoveryCandidates: 0,
        companyReleaseTasks: 0
      }
    }
  };
}

function createDashboardValidationFixture() {
  // Keep validator mutations independent of the live edition while still exercising
  // the complete dashboard-to-chart and quote-row contracts.
  const chartSeries = ['SPX', 'VCR', 'UST10Y'].map((ticker, index) => ({
    ticker,
    name: `Fixture ${ticker}`,
    section: 'tape',
    sourceSymbol: ticker,
    note: 'Fixture market positioning remains constructive as breadth improves and investors assess earnings, rates, growth, and liquidity conditions across sessions.',
    source: 'Yahoo Finance Chart API',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: false,
    bars: [
      { time: '2026-07-09', open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1000 },
      { time: '2026-07-10', open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: 1100 }
    ]
  }));
  const quotes = chartSeries.map(quoteRowFromSeries);
  const chartData = compactChartPayload({
    schemaVersion: 1,
    generatedAt: '2026-07-10T12:00:00.000Z',
    dashboardSource: 'scripts/test_dashboard.js',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: { tape: quotes, crypto: [] },
    series: chartSeries
  });
  const stories = Array.from({ length: 9 }, (_item, index) => story('market', index + 1));
  const cryptoNotes = Array.from({ length: 4 }, (_item, index) => story('crypto', index + 1));
  const futuresStories = Array.from({ length: 3 }, (_item, index) => ({
    ...story('futures', index + 1),
    tag: 'Futures',
    publishedAt: '2026-07-10T15:00:00Z'
  }));
  const scheduledIds = [...stories, ...cryptoNotes].map((item) => `url:${item.url}`);

  return {
    dashboard: {
      editionId: '2026-07-10T21:00:00Z',
      newsBaseline: {
        lastScheduledUpdateAt: '2026-07-10T12:00:00.000Z',
        lastScheduledWindow: '2026-07-10:afternoon',
        previousScheduledStoryIds: [],
        currentScheduledStoryIds: scheduledIds
      },
      masthead: { edition: 'Afternoon Edition', date: 'Friday · July 10, 2026' },
      tape: {
        label: 'Friday After The Bell · Fixture drivers',
        rows: quotes.map((quote) => ({ ...quote, group: quote.ticker === 'VCR' ? 'Sectors' : quote.ticker === 'UST10Y' ? 'Rates & Credit' : 'Equities' }))
      },
      stories,
      crypto: {
        stats: [
          { sym: 'TOTAL', name: 'Crypto Market Cap', price: '$1.00T', delta: '+$0.01T' },
          { sym: 'F&G', name: 'Fear & Greed', price: '50', chg: 'Neutral' },
          { sym: 'ALTSEASON', name: 'Altcoin Season Index', price: '25', sub: 'Bitcoin Season', delta: '+1', chg: '/100' }
        ],
        notes: cryptoNotes
      },
      earnings: { week: fixtureEarningsWeek() },
      weekAhead: normalizeWeekAhead({ announcements: {}, predictions: {} }, {
        range: { from: '2026-07-10', to: '2026-07-16' },
        officialSchedule: {
          events: [{
            date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
            authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://fixture.test/schedule'
          }],
          authorities: []
        },
        now: new Date(FIXTURE_NOW)
      }),
      footer: {
        compiled: 'Compiled Friday, July 10, 2026 at 4:00 PM CDT · Market data: Alternative.me Crypto Fear & Greed Index, CoinMarketCap Altcoin Season Index'
      },
      opening: {
        headline: 'Fixture headline',
        deck: 'Fixture deck',
        catalysts: Array.from({ length: 4 }, (_item, index) => ({ label: `Catalyst ${index + 1}`, body: 'Fixture catalyst detail.' }))
      },
      futuresModule: {
        sectionLabel: 'After The Bell',
        sectionTitle: 'Session Futures',
        futures: fixtureFutures(),
        stories: futuresStories
      },
      assetAllocationPortfolio: {
        rows: fixturePortfolioRows(),
        portfolioMtdReturnAsOf: '2026-07-10',
        portfolioMtdReturnValue: null,
        portfolioMtdReturnStatus: 'unavailable',
        portfolioMtdReturnStale: true
      }
    },
    chartData
  };
}

function renderDashboardValidationFixture(dashboard, chartData) {
  return `<!-- ============ DATA START ============ -->
<script type="application/json" id="dashboard-data">${JSON.stringify(dashboard)}</script>
<!-- ============ DATA END ============ -->
<script type="application/json" id="chart-data">${JSON.stringify(chartData)}</script>
<div class="page" id="app"><div id="mast-edition"></div><div class="right" id="mast-date"></div><h1 id="hero-headline"></h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>
<script id="dashboard-runtime">const localRefreshUrls = ['https://192.168.2.2:2210/api/market-refresh'];</script>`;
}

// Some fixture paths outlive the helper that creates them, so main() owns one failure-safe cleanup pass for the whole suite.
const temporaryDirectories = new Set();

function makeTemporaryDirectory(parent, prefix) {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.add(dir);
  return dir;
}

function cleanupTemporaryDirectories() {
  for (const dir of [...temporaryDirectories].reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}

function testArchitecturePolicyOwnershipMatrix() {
  const policy = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const requiredRows = [
    'Envelope: masthead, edition/session labels, compile prefix, scheduled baseline',
    'Opening',
    'Futures',
    'Tape and embedded charts',
    'Crypto',
    'Asset Allocation',
    'News Flow and promoted stories',
    'Week Ahead',
    'Earnings',
    'Editorial review and receipt',
    'Canonical artifact and publication'
  ];
  assert.match(policy, /### Section ownership matrix/);
  for (const row of requiredRows) assert.ok(policy.includes(`| ${row} |`), `AGENTS.md ownership matrix must include ${row}.`);
}

function testArchitectureSingleWriterAndCliBoundaries() {
  const scriptsDir = path.join(root, 'scripts');
  const directWriterPatterns = [
    /fs\.writeFileSync\(\s*args\.dashboard\b/,
    /fs\.writeFileSync\(\s*input\s*,\s*html\b/,
    /fs(?:\.promises)?\.(?:writeFileSync|writeFile|renameSync|rename|copyFileSync|copyFile)\([^;]{0,500}\b(?:html|nextHtml)\b[^;]*\)/
  ];
  const offenders = [];
  for (const name of fs.readdirSync(scriptsDir).filter((item) => item.endsWith('.js') && item !== 'run_daily_update.js' && !item.startsWith('test_'))) {
    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    for (const pattern of directWriterPatterns) {
      if (pattern.test(source)) offenders.push(`${name}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'Only run_daily_update.js may edit dashboard HTML.');
  const publishSource = fs.readFileSync(path.join(scriptsDir, 'publish_main.sh'), 'utf8');
  assert.match(publishSource, /node scripts\/validate_dashboard\.js readiness/, 'Publishing must run the complete readiness entry point.');
  const publishHelp = spawnSync(path.join(scriptsDir, 'publish_main.sh'), ['--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WAKE_LOCK_ENABLED: '0' }
  });
  assert.equal(publishHelp.status, 0, publishHelp.stderr);
  assert.match(publishHelp.stdout, /Usage: \.\/scripts\/publish_main\.sh \[REMOTE \[BRANCH\]\]/);
  const publishUnknown = spawnSync(path.join(scriptsDir, 'publish_main.sh'), ['--typo'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WAKE_LOCK_ENABLED: '0' }
  });
  assert.notEqual(publishUnknown.status, 0);
  assert.match(publishUnknown.stderr, /Unknown argument: --typo/);

  assert.throws(
    () => parseFetchChartDataArgs(['--embed-compact']),
    /Direct dashboard writes are not supported/
  );

  const earningsEmbed = spawnSync(process.execPath, [path.join(scriptsDir, 'earnings_week.js'), 'embed'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(earningsEmbed.status, 0);
  assert.match(earningsEmbed.stderr, /Direct dashboard writes are not supported/);

  const cryptoDashboard = spawnSync(process.execPath, [path.join(scriptsDir, 'fetch_crypto_stats.js'), '--dashboard', 'unused.html'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(cryptoDashboard.status, 0);
  assert.match(cryptoDashboard.stderr, /Direct dashboard writes are not supported/);
}

function testDedicatedDashboardApplyModes() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-dashboard-writer-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const earningsFile = path.join(dir, 'earnings.json');
  const canonical = readJsonBlock(fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8'), 'dashboard-data');
  const initial = {
    editionId: 'old',
    earnings: { label: 'old', week: null },
    crypto: { stats: [{ sym: 'OLD' }] }
  };
  const stalePolicyWeek = structuredClone(canonical.earnings.week);
  stalePolicyWeek.policy.enrichment = 'Finnhub and EarningsAPI are used.';
  fs.writeFileSync(dashboardFile, `<main>preserved</main><script type="application/json" id="dashboard-data">${JSON.stringify(initial)}</script>`);
  fs.writeFileSync(earningsFile, JSON.stringify(stalePolicyWeek));

  const earningsApply = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--apply-earnings-week-json', earningsFile,
    '--test-skip-validation'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, DASHBOARD_TEST_MODE: '1' } });
  assert.equal(earningsApply.status, 0, earningsApply.stderr);
  const html = fs.readFileSync(dashboardFile, 'utf8');
  const data = readJsonBlock(html, 'dashboard-data');
  assert.equal(data.earnings.label, 'Earnings · Week Monitor');
  assert.equal(data.earnings.week.generatedAt, canonical.earnings.week.generatedAt);
  assert.deepEqual(data.earnings.week.policy, buildEarningsWeekPolicy());
  assert.match(html, /<main>preserved<\/main>/);
}

function testFocusedEarningsApplyRejectsPendingScheduleReview() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-earnings-review-gate-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const earningsFile = path.join(dir, 'earnings_week.json');
  const reviewFile = path.join(dir, 'earnings_schedule_review.json');
  const originalHtml = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const week = readJsonBlock(originalHtml, 'dashboard-data').earnings.week;
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(earningsFile, JSON.stringify(week));
  fs.writeFileSync(reviewFile, JSON.stringify({
    schemaVersion: 1,
    range: week.range,
    rows: [{
      symbol: 'REVIEW',
      company: 'Review Corp',
      primaryDate: week.range.from,
      secondaryDates: [],
      reason: 'uncorroborated_primary_calendar_date',
      required: 'official_company_ir_date_confirmation'
    }]
  }));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--apply-earnings-week-json', earningsFile,
    '--test-skip-validation'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, DASHBOARD_TEST_MODE: '1' } });

  assert.equal(result.status, EARNINGS_USER_ACTION_REQUIRED_EXIT_CODE);
  assert.match(result.stderr, /Official company IR date confirmation is required/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
}

function testFocusedApplyValidatesBeforeAtomicReplace() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-atomic-apply-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const cryptoFile = path.join(dir, 'crypto.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(cryptoFile, JSON.stringify({ stats: [] }));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--apply-crypto-stats-json', cryptoFile
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_NOW_ISO: FIXTURE_NOW }
  });
  assert.notEqual(result.status, 0, 'An invalid focused repair candidate must fail validation.');
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'A failed candidate must not replace the dashboard artifact.');
}

function testSkipValidateCannotTargetCanonicalDashboard() {
  const dashboardFile = path.join(root, 'daily_financial_news.html');
  const originalHtml = fs.readFileSync(dashboardFile, 'utf8');
  assert.throws(
    () => commitDashboardCandidate({ dashboard: path.join(os.tmpdir(), 'unused-dashboard.html'), testSkipValidation: true }, ''),
    /requires DASHBOARD_TEST_MODE=1/
  );
  const help = spawnSync(process.execPath, [path.join(root, 'scripts', 'run_daily_update.js'), '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /test-skip-validation/);
  const previousTestMode = process.env.DASHBOARD_TEST_MODE;
  process.env.DASHBOARD_TEST_MODE = '1';
  try {
    assert.throws(
      () => commitDashboardCandidate({ dashboard: dashboardFile, testSkipValidation: true }, 'invalid replacement'),
      /cannot target the canonical dashboard/
    );
  } finally {
    if (previousTestMode === undefined) delete process.env.DASHBOARD_TEST_MODE;
    else process.env.DASHBOARD_TEST_MODE = previousTestMode;
  }
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
}

function writeChartDataFixture(latestDate, { tuple = true } = {}) {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-market-server-');
  const file = path.join(dir, 'dashboard.html');
  const payload = {
    schemaVersion: 1,
    ...(tuple ? { barEncoding: 'tuple-v1' } : {}),
    series: [{
      ticker: 'SPX',
      bars: tuple
        ? [
          ['2026-06-29', 1, 1, 1, 1, null],
          [latestDate, 2, 2, 2, 2, null]
        ]
        : [
          { time: '2026-06-29', close: 1 },
          { time: latestDate, close: 2 }
        ]
    }]
  };
  fs.writeFileSync(file, `<script type="application/json" id="chart-data">${JSON.stringify(payload)}</script>`);
  return file;
}

function dashboardFixture() {
  return {
    editionId: 'fixture-edition',
    tape: {
      rows: [{
        ticker: 'SPX',
        group: 'Equities',
        last: '5,000.00',
        delta: '+0.00',
        pct: '+0.00%',
        dir: 'flat',
        asOf: 'old'
      }, {
        ticker: 'BTC',
        group: 'Crypto',
        last: '$60,000',
        delta: '+$0',
        pct: '+0.00%',
        dir: 'flat',
        asOf: 'old'
      }]
    },
    crypto: {
      stats: [{
        sym: 'FNG',
        value: '50',
        delta: 'n/a'
      }]
    },
    futuresModule: {
      sectionLabel: 'Old',
      sectionTitle: 'Old Futures',
      futures: []
    },
    assetAllocationPortfolio: {
      rows: [],
      portfolioMtdReturnAsOf: '',
      portfolioMtdReturnValue: '',
      portfolioMtdReturnStatus: '',
      portfolioMtdReturnStale: true
    }
  };
}

function extractRuntimeTestBlock(source, name) {
  // Explicit source markers keep tests on the published implementation without pretending this fixture harness is a JavaScript parser.
  const startMarker = `/* TEST BLOCK START: ${name} */`;
  const endMarker = `/* TEST BLOCK END: ${name} */`;
  const startCount = source.split(startMarker).length - 1;
  const endCount = source.split(endMarker).length - 1;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);

  assert.equal(startCount, 1, `Expected one test block start ${name}; found ${startCount}`);
  assert.equal(endCount, 1, `Expected one test block end ${name}; found ${endCount}`);
  assert.ok(start < end, `Test block markers are out of order for ${name}`);

  return source.slice(start + startMarker.length, end);
}

function dashboardRuntimeSource(html) {
  const matches = [...html.matchAll(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/g)];
  assert.equal(matches.length, 1, `Expected one dashboard-runtime script; found ${matches.length}`);
  return matches[0][1];
}

function extractDashboardRuntimeTestBlock(html, name) {
  return extractRuntimeTestBlock(dashboardRuntimeSource(html), name);
}

function testUpdaterQuoteAndCryptoPatches() {
  const data = dashboardFixture();

  applyTapeQuoteRows(data, [{
    ticker: 'SPX',
    last: '6,123.45',
    delta: '+12.34',
    pct: '+0.20%',
    dir: 'up',
    asOf: 'chart-asof'
  }, {
    ticker: 'BTC',
    last: '$999',
    delta: '+$1',
    pct: '+0.01%',
    dir: 'up',
    asOf: 'wrong-section'
  }]);

  assert.equal(data.tape.rows[0].last, '6,123.45');
  assert.equal(data.tape.rows[0].pct, '+0.20%');
  assert.equal(data.tape.rows[1].last, '$60,000', 'Tape quote patch must not update crypto rows.');

  applyCryptoQuoteRows(data, [{
    sym: 'BTC',
    price: '$61,000',
    delta: '+$1,000',
    chg: '+1.67%',
    dir: 'up',
    asOf: 'crypto-asof'
  }]);

  assert.equal(data.tape.rows[1].last, '$61,000');
  assert.equal(data.tape.rows[1].pct, '+1.67%');
  assert.equal(data.tape.rows[1].asOf, 'crypto-asof');

  applyCryptoStats(data, [{
    sym: 'FNG',
    value: '53',
    delta: '+2'
  }, {
    sym: 'ALT',
    value: '53',
    delta: '+2'
  }]);

  assert.deepEqual(data.crypto.stats.map((row) => row.sym), ['FNG', 'ALT']);
}

function testUpdaterModulePatches() {
  const data = dashboardFixture();
  const futures = fixtureFutures();

  applyFuturesModule(data, {
    compiledAt: '2026-07-10T20:00:00.000Z',
    source: 'Yahoo Finance Chart API',
    mode: 'session',
    futures
  }, 'afternoon');
  assert.equal(data.futuresModule.sectionLabel, 'After The Bell');
  assert.equal(data.futuresModule.sectionTitle, 'Session Futures');
  assert.deepEqual(data.futuresModule.futures.map((row) => row.symbol), ['ES=F', 'NQ=F', 'YM=F', 'RTY=F']);

  applyAssetAllocationPortfolio(data, {
    compiledAt: '2026-07-06T13:00:00.000Z',
    source: 'fixture',
    month: '2026-07',
    rows: [{ ticker: 'SPY', last: '600.00' }]
  });
  assert.equal(data.assetAllocationPortfolio.compiledAt, '2026-07-06T13:00:00.000Z');
  assert.equal(data.assetAllocationPortfolio.rows[0].ticker, 'SPY');

  applyAssetAllocationSummary(data, {
    asOf: '2026-07-06',
    portfolioMtdReturnValue: '+1.23%',
    status: 'fresh',
    stale: false
  });
  assert.equal(data.assetAllocationPortfolio.portfolioMtdReturnAsOf, '2026-07-06');
  assert.equal(data.assetAllocationPortfolio.portfolioMtdReturnValue, '+1.23%');
  assert.equal(data.assetAllocationPortfolio.portfolioMtdReturnStale, false);
}

function testFuturesStagingPayloadContract() {
  const valid = {
    compiledAt: '2026-07-10T20:00:00.000Z',
    source: 'Yahoo Finance Chart API',
    mode: 'session',
    futures: fixtureFutures()
  };
  assert.deepEqual(validateFuturesPayload(valid, { expectedMode: 'session' }), []);

  const shortRoster = structuredClone(valid);
  shortRoster.futures.pop();
  assert.match(validateFuturesPayload(shortRoster).join('\n'), /exactly 4 rows/);

  const wrongSymbol = structuredClone(valid);
  wrongSymbol.futures[0].symbol = 'NQ=F';
  assert.match(validateFuturesPayload(wrongSymbol).join('\n'), /futures\[0\]\.symbol must be ES=F/);

  const wrongMode = structuredClone(valid);
  wrongMode.mode = 'premarket';
  assert.match(validateFuturesPayload(wrongMode, { expectedMode: 'session' }).join('\n'), /mode must be session/);

  const badSeries = structuredClone(valid);
  badSeries.futures[0].series[0][1] = null;
  assert.match(validateFuturesPayload(badSeries).join('\n'), /finite numeric times and positive prices/);

  const negativePrice = structuredClone(valid);
  negativePrice.futures[0].series[0][1] = -100;
  assert.match(validateFuturesPayload(negativePrice).join('\n'), /positive prices/);

  const wrongDirection = structuredClone(valid);
  wrongDirection.futures[0].dir = 'down';
  assert.match(validateFuturesPayload(wrongDirection).join('\n'), /dir must match raw\.pct/);

  assert.throws(
    () => applyFuturesModule(dashboardFixture(), shortRoster, 'afternoon'),
    /Generated Futures staging payload is invalid: Futures staging payload must contain exactly 4 rows/
  );
}

function testEditorialReviewContract() {
  const data = dashboardFixture();
  const reviewChartData = { schemaVersion: 1, series: [] };
  data.editionId = '2026-07-11T18:00:00.000Z';
  data.opening = { headline: 'Markets test the outlook', deck: 'The current setup remains in focus.', catalysts: [] };
  data.weekAhead = { days: [] };
  const manifest = {
    schemaVersion: 1,
    reviewedAt: '2026-07-11T17:55:00.000Z',
    baseEditionId: '2026-07-11T17:40:00.000Z',
    sections: [...REQUIRED_EDITORIAL_SECTIONS],
    marketLensDecisions: [],
    verifiedClaims: []
  };
  assert.deepEqual(validateReviewManifest(manifest, data), []);
  assert.match(validateReviewManifest({ ...manifest, baseEditionId: '' }, data).join('\n'), /baseEditionId must identify/);
  assert.match(validateReviewManifest(manifest, data, { expectedBaseEditionId: 'newer-edition' }).join('\n'), /baseEditionId must match/);
  buildEditorialReview(data, manifest, reviewChartData);
  assert.equal(data.editorialReview.reviewedBaseEditionId, manifest.baseEditionId);
  assert.equal(data.editorialReview.reviewedEditionId, data.editionId);
  assert.equal(data.editorialReview.payloadHash, editorialPayloadHash(data, reviewChartData));
  assert.deepEqual(validateReviewManifest(data.editorialReview, data, { requireEmbedded: true, chartData: reviewChartData }), []);
  assert.match(validateReviewManifest(data.editorialReview, data, {
    requireEmbedded: true,
    chartData: { ...reviewChartData, generatedAt: '2026-07-11T18:01:00.000Z' }
  }).join('\n'), /payloadHash does not match/);

  data.opening.headline = 'Stocks reach a new high';
  assert.equal(superlativeClaims(data).length, 1);
  const staleErrors = validateReviewManifest(data.editorialReview, data, { requireEmbedded: true, chartData: reviewChartData }).join('\n');
  assert.match(staleErrors, /unverified superlative claim/);
  assert.match(staleErrors, /payloadHash does not match/);
  assert.deepEqual(validateReviewManifest({
    ...manifest,
    verifiedClaims: [{ text: data.opening.headline, evidenceUrl: 'https://example.com/verified-claim' }]
  }, data), []);
  assert.match(validateReviewManifest({
    ...manifest,
    verifiedClaims: [{ text: 'An obsolete record claim.', evidenceUrl: 'https://example.com/obsolete-claim' }]
  }, data).join('\n'), /does not match current editorial text/);
  assert.match(validateReviewManifest({ ...manifest, sections: manifest.sections.slice(1) }, data).join('\n'), /missing opening/);
}

function testDeterministicEditionMetadata() {
  const data = {
    masthead: {},
    futuresModule: {},
    footer: { compiled: 'Compiled stale date · Market data: Fixture.' },
    tape: { label: 'Old Session · Inflation, Rates, and Earnings' },
    lede: {},
    renesas: {}
  };
  applyEditionMetadata(data, 'morning', new Date('2026-07-13T12:05:00.000Z'));
  assert.deepEqual(data.masthead, { edition: 'Morning Edition', date: 'Monday · July 13, 2026' });
  assert.equal(data.futuresModule.sectionLabel, 'Before The Open');
  assert.equal(data.futuresModule.sectionTitle, 'Pre-Market Futures');
  assert.equal(data.footer.compiled, 'Compiled Monday, July 13, 2026 at 7:05 AM CDT · Market data: Fixture.');
  assert.equal(data.tape.label, 'Monday Before The Open · Inflation, Rates, and Earnings');
  assert.equal(data.lede, undefined);
  assert.equal(data.renesas, undefined);
}

function testArchitectureEditorialWorkspaceHandoff() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-editorial-workspace-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const workspaceDir = path.join(dir, 'workspace');
  const dashboardData = {
    editionId: '2026-07-13T12:00:00.000Z',
    editorialReview: { stale: true },
    masthead: {}, futuresModule: {}, footer: { compiled: '' }, tape: { label: '' },
    lede: {}, renesas: {},
    opening: { headline: 'Staged candidate headline' },
    weekAhead: { days: [{ date: '2026-07-14', events: [{ id: 'event' }] }, { date: '2026-07-15', events: [] }] }
  };
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ ...dashboardData, opening: { headline: 'Canonical headline' } })}</script>`);
  fs.writeFileSync(candidateFile, `<script type="application/json" id="dashboard-data">${JSON.stringify(dashboardData)}</script>`);
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--prepare-editorial-dir', workspaceDir,
    '--morning'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SCHEDULED_NOW_ISO: '2026-07-13T12:05:00.000Z' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(workspaceDir).sort(),
    ['dashboard-data.json', 'earnings_narrative.json', 'editorial-review.json'],
    'The common editorial handoff must contain exactly the policy-owned files.'
  );
  const workspace = {
    dashboardData: JSON.parse(fs.readFileSync(path.join(workspaceDir, 'dashboard-data.json'), 'utf8')),
    earningsNarrative: JSON.parse(fs.readFileSync(path.join(workspaceDir, 'earnings_narrative.json'), 'utf8')),
    reviewManifest: JSON.parse(fs.readFileSync(path.join(workspaceDir, 'editorial-review.json'), 'utf8'))
  };
  assert.equal(workspace.dashboardData.editorialReview, undefined);
  assert.equal(workspace.dashboardData.lede, undefined);
  assert.equal(workspace.dashboardData.opening.headline, 'Staged candidate headline');
  assert.equal(fs.existsSync(path.join(workspaceDir, 'earnings_narrative.json')), true);
  assert.deepEqual(workspace.earningsNarrative.rows, []);
  assert.equal(workspace.dashboardData.masthead.edition, 'Morning Edition');
  assert.deepEqual(workspace.reviewManifest.marketLensDecisions, [{ date: '2026-07-14', action: null }]);
  assert.equal(workspace.reviewManifest.reviewedAt, null);
  assert.equal(workspace.reviewManifest.baseEditionId, dashboardData.editionId);

  const staleWorkspaceDir = path.join(dir, 'stale-workspace');
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ ...dashboardData, editionId: '2026-07-13T12:01:00.000Z' })}</script>`);
  const staleResult = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--prepare-editorial-dir', staleWorkspaceDir,
    '--morning'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SCHEDULED_NOW_ISO: '2026-07-13T12:05:00.000Z' }
  });
  assert.notEqual(staleResult.status, 0);
  assert.match(staleResult.stderr, /Staged dashboard candidate is stale/);
  assert.equal(fs.existsSync(staleWorkspaceDir), false, 'A stale candidate must fail before creating an editorial workspace.');
}

function testArchitecturePreparationLeavesCanonicalUnchanged() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-deterministic-stage-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const originalHtml = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  fs.writeFileSync(dashboardFile, originalHtml);

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--morning',
    '--skip-earnings',
    '--skip-futures',
    '--skip-chart-data',
    '--skip-crypto-stats',
    '--skip-asset-allocation',
    '--skip-week-ahead',
    '--test-skip-validation'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DASHBOARD_TEST_MODE: '1', SCHEDULED_NOW_ISO: '2026-07-13T12:05:00.000Z' }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'Deterministic preparation must not alter the canonical dashboard.');
  assert.equal(fs.existsSync(candidateFile), true);
  assert.match(result.stdout, /canonical dashboard unchanged/);
  const canonicalData = readJsonBlock(originalHtml, 'dashboard-data');
  const candidateData = readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'dashboard-data');
  assert.equal(candidateData.editionId, canonicalData.editionId, 'The staged candidate must retain the canonical base edition binding.');
  assert.equal(candidateData.editorialReview, undefined);
}

function testChartSeriesOwnsDerivedQuoteViews() {
  const data = dashboardFixture();
  data.tape.rows[0] = {
    ...data.tape.rows[0],
    ticker: 'SPX',
    group: 'Equities',
    last: 'stale',
    delta: 'stale',
    pct: 'stale',
    dir: 'flat',
    asOf: 'old'
  };
  data.tape.rows[1] = {
    ...data.tape.rows[1],
    ticker: 'BTC',
    group: 'Crypto',
    last: 'stale',
    delta: 'stale',
    pct: 'stale',
    dir: 'flat',
    asOf: 'old'
  };
  const chartData = {
    series: [{
      ticker: 'SPX',
      section: 'tape',
      sourceSymbol: 'SPX',
      bars: [
        { time: '2026-07-03', open: 6000, high: 6000, low: 6000, close: 6000 },
        { time: '2026-07-06', open: 6120, high: 6125, low: 6110, close: 6123.45 }
      ]
    }, {
      ticker: 'BTC',
      section: 'crypto',
      sourceSymbol: 'BTC-USD',
      bars: [
        { time: '2026-07-03', open: 60000, high: 60000, low: 60000, close: 60000 },
        { time: '2026-07-06', open: 61000, high: 61000, low: 61000, close: 61000 }
      ]
    }],
    quoteRows: {
      tape: [{ ticker: 'SPX', last: 'bad', delta: 'bad', pct: 'bad', dir: 'down', asOf: '2026-07-01' }],
      crypto: [{ ticker: 'BTC', sym: 'BTC', price: 'bad', delta: 'bad', chg: 'bad', dir: 'down', asOf: '2026-07-01' }]
    }
  };

  syncDashboardPricesFromChartData(data, chartData);

  assert.equal(chartData.quoteRows.tape[0].last, '6,123.45');
  assert.equal(chartData.quoteRows.tape[0].asOf, '2026-07-06');
  assert.equal(chartData.quoteRows.crypto[0].price, '$61,000');
  assert.equal(chartData.quoteRows.crypto[0].asOf, '2026-07-06');
  assert.equal(data.tape.rows[0].last, '6,123.45');
  assert.equal(data.tape.rows[0].pct, '+2.06%');
  assert.equal(data.tape.rows[1].last, '$61,000');
  assert.equal(data.tape.rows[1].pct, '+1.67%');
}

function testFinnhubQuoteBarMergesIntoOhlcSeries() {
  const series = {
    ticker: 'VAW',
    name: 'Materials',
    section: 'tape',
    sourceSymbol: 'VAW',
    note: 'Fixture note',
    source: 'Yahoo Finance Chart API',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: false,
    bars: [
      { time: '2026-07-01', open: 227.81, high: 231.15, low: 227.25, close: 228.58, volume: 115000 },
      { time: '2026-07-02', open: 230.58, high: 232.64, low: 230.30, close: 232.64, volume: 60800 }
    ]
  };
  const quoteBar = finnhubQuoteBarFromPayload({
    o: 232.3,
    h: 232.3,
    l: 229.59,
    c: 232.06,
    t: 1783368000
  });

  const merged = mergeFinnhubQuoteBar(series, quoteBar, new Map([['2026-07-06', 50110]]));
  const latest = merged.bars.at(-1);
  const quoteRow = quoteRowFromSeries(merged);

  assert.equal(latest.time, '2026-07-06');
  assert.equal(latest.open, 232.3);
  assert.equal(latest.high, 232.3);
  assert.equal(latest.low, 229.59);
  assert.equal(latest.close, 232.06);
  assert.equal(latest.volume, 50110);
  assert.equal(merged.source, 'Yahoo Finance Chart API + Finnhub Quote API');
  assert.equal(quoteRow.last, '232.06');
  assert.equal(quoteRow.delta, '-0.58');
  assert.equal(quoteRow.pct, '-0.25%');
  assert.equal(quoteRow.dir, 'down');
}

function testFinnhubQuoteFallbackOnlyWhenYahooLatestIsUnusable() {
  const series = {
    ticker: 'VAW',
    sourceSymbol: 'VAW',
    dataKind: 'ohlc',
    priceOnly: false,
    bars: [
      { time: '2026-07-02', open: 230.58, high: 232.64, low: 230.30, close: 232.64, volume: 60800 }
    ]
  };
  const yahooPayloadWithDroppedLatest = {
    chart: {
      result: [{
        timestamp: [
          Date.parse('2026-07-02T00:00:00Z') / 1000,
          Date.parse('2026-07-06T00:00:00Z') / 1000
        ],
        indicators: {
          quote: [{
            close: [232.64, 232.06]
          }]
        }
      }]
    }
  };
  const yahooPayloadMatchingSeries = {
    chart: {
      result: [{
        timestamp: [Date.parse('2026-07-02T00:00:00Z') / 1000],
        indicators: {
          quote: [{
            close: [232.64]
          }]
        }
      }]
    }
  };

  assert.equal(shouldUseFinnhubQuoteFallback(series, yahooPayloadWithDroppedLatest), true);
  assert.equal(shouldUseFinnhubQuoteFallback(series, yahooPayloadMatchingSeries), false);
}

function testJsonBlockPatchKeepsDollarLiterals() {
  const html = '<script type="application/json" id="dashboard-data">{"old":"value"}</script>';
  const payload = JSON.stringify({ price: '$4.54B', replacementLike: '$&' });
  const next = replaceJsonBlock(html, 'dashboard-data', payload);
  const parsed = readJsonBlock(next, 'dashboard-data');

  assert.equal(parsed.price, '$4.54B');
  assert.equal(parsed.replacementLike, '$&');
}

function testPatchDashboardDataBlockKeepsShellAndStampsEdition() {
  const html = [
    '<script type="application/json" id="dashboard-data">{"editionId":"old","price":"$1.00"}</script>',
    '<script type="application/json" id="chart-data">{"schemaVersion":1,"series":[]}</script>',
    '<div class="page" id="app"><div id="mast-edition">Loading</div><div class="right" id="mast-date">Loading</div><h1 id="hero-headline">Loading</h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>',
    '<script>(function () {})();</script>'
  ].join('');
  const next = patchDashboardDataBlock(html, { editionId: 'old', price: '$4.54B', replacementLike: '$&' });
  const parsed = readJsonBlock(next, 'dashboard-data');

  assert.equal(parsed.price, '$4.54B');
  assert.equal(parsed.replacementLike, '$&');
  assert.notEqual(parsed.editionId, 'old');
  assert.match(next, /<div class="page" id="app">/);
  assert.match(next, /<script type="application\/json" id="chart-data">/);
}

function testArchitectureFinalizationValidatesBeforeReplace() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-atomic-editorial-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const reviewFile = path.join(dir, 'editorial-review.json');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const invalidPayload = structuredClone(dashboard);
  invalidPayload.opening.catalysts = [];
  const eventDays = dashboard.weekAhead.days.filter((day) => day.events.length);
  const review = {
    schemaVersion: 1,
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    sections: [...REQUIRED_EDITORIAL_SECTIONS],
    verifiedClaims: [],
    marketLensDecisions: eventDays.map((day) => ({ date: day.date, action: 'retain-generated' }))
  };
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const originalHash = crypto.createHash('sha256').update(originalHtml).digest('hex');
  const originalMtimeMs = fs.statSync(dashboardFile).mtimeMs;
  fs.writeFileSync(payloadFile, JSON.stringify(invalidPayload));
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  const command = [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile,
    '--editorial-review-json', reviewFile,
    '--afternoon'
  ];
  const env = {
    ...process.env,
    SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z',
    VALIDATE_NOW_ISO: FIXTURE_NOW
  };
  const invalidResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.notEqual(invalidResult.status, 0, 'An invalid editorial candidate must fail before replacement.');
  assert.match(invalidResult.stderr, /Editorial candidate failed validation; the published dashboard was not changed/);
  const unchangedHtml = fs.readFileSync(dashboardFile, 'utf8');
  assert.equal(crypto.createHash('sha256').update(unchangedHtml).digest('hex'), originalHash);
  assert.equal(fs.statSync(dashboardFile).mtimeMs, originalMtimeMs);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.dashboard.html.')), false, 'Failed candidate files must be removed.');

  const editorialPayload = structuredClone(dashboard);
  editorialPayload.masthead.date = 'Saturday · January 1, 2000';
  editorialPayload.opening.headline = 'Reviewed fixture headline';
  editorialPayload.stories[0].title = 'Reviewed market story';
  editorialPayload.futuresModule.sectionTitle = 'Unauthorized futures title';
  editorialPayload.futuresModule.futures[0].value = '99,999.00';
  editorialPayload.futuresModule.stories[0].title = 'Reviewed futures story';
  editorialPayload.tape.label = 'Unauthorized session label · Reviewed drivers';
  editorialPayload.tape.rows[0].last = '99,999.00';
  editorialPayload.tape.rows[0].note = 'Reviewed Tape commentary explains the current market drivers without restating the quote.';
  editorialPayload.crypto.stats[0].price = '$9.99T';
  editorialPayload.crypto.notes[0].title = 'Reviewed crypto story';
  editorialPayload.assetAllocationPortfolio.rows[0].price = '$999.00';
  editorialPayload.footer.compiled = dashboard.footer.compiled.replace(' · Market data:', ' · Holiday context: Reviewed. · Market data:');
  const editorialEventDay = editorialPayload.weekAhead.days.find((day) => day.events.length);
  editorialEventDay.events[0].forecast = '9.9%';
  fs.writeFileSync(payloadFile, JSON.stringify(editorialPayload));
  const validResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(validResult.status, 0, validResult.stderr);
  const finalizedHtml = fs.readFileSync(dashboardFile, 'utf8');
  assert.notEqual(finalizedHtml, originalHtml);
  const finalized = readJsonBlock(finalizedHtml, 'dashboard-data');
  assert.equal(finalized.editorialReview.reviewedEditionId, finalized.editionId);
  assert.equal(finalized.opening.headline, 'Reviewed fixture headline');
  assert.equal(finalized.stories[0].title, 'Reviewed market story');
  assert.equal(finalized.futuresModule.stories[0].title, 'Reviewed futures story');
  assert.equal(finalized.crypto.notes[0].title, 'Reviewed crypto story');
  assert.equal(finalized.tape.rows[0].note, 'Reviewed Tape commentary explains the current market drivers without restating the quote.');
  assert.match(finalized.tape.label, /^Friday After The Bell · Reviewed drivers$/);
  assert.match(finalized.footer.compiled, /^Compiled Friday, July 10, 2026 at 4:01 PM CDT · Holiday context: Reviewed\./);
  assert.deepEqual(finalized.futuresModule.futures, dashboard.futuresModule.futures);
  assert.deepEqual(finalized.crypto.stats, dashboard.crypto.stats);
  assert.deepEqual(finalized.assetAllocationPortfolio, dashboard.assetAllocationPortfolio);
  assert.deepEqual(finalized.weekAhead.days.map((day) => day.events), dashboard.weekAhead.days.map((day) => day.events));
  assert.equal(finalized.masthead.date, 'Friday · July 10, 2026');
  assert.notEqual(finalized.tape.rows[0].last, '99,999.00');
}

function testApplyChartDataJsonCliMode() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-chart-apply-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'chart-data.json');
  const shell = [
    '<!-- ============ DATA START — published dashboard payload ============ -->',
    '<script type="application/json" id="dashboard-data">{"editionId":"old","masthead":{"date":"Monday, July 6, 2026"},"footer":{"compiled":"Compiled Monday, July 6, 2026 at 4:00 PM CDT"},"tape":{"rows":[{"ticker":"SPX","group":"Equities","last":"stale","delta":"stale","pct":"stale","dir":"flat","asOf":"old"}]}}<\/script>',
    '<!-- ============ DATA END ============ -->',
    '<script type="application/json" id="chart-data">{"schemaVersion":1,"series":[]}</script>',
    '<div class="page" id="app"><div id="mast-edition">Loading</div><div class="right" id="mast-date">Loading</div><h1 id="hero-headline">Loading</h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>',
    '<script>(function () {})();</script>'
  ].join('\n');
  const chartData = {
    schemaVersion: 1,
    quoteRows: { tape: [], crypto: [] },
    series: [{
      ticker: 'SPX', section: 'tape', sourceSymbol: 'SPX',
      bars: [
        { time: '2026-07-03', open: 6000, high: 6000, low: 6000, close: 6000 },
        { time: '2026-07-06', open: 6120, high: 6125, low: 6110, close: 6123.45 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, shell);
  fs.writeFileSync(payloadFile, JSON.stringify(chartData));
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--apply-chart-data-json', payloadFile,
    '--test-skip-validation'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, DASHBOARD_TEST_MODE: '1' } });
  assert.equal(result.status, 0, result.stderr);

  const updatedHtml = fs.readFileSync(dashboardFile, 'utf8');
  const dashboard = readJsonBlock(updatedHtml, 'dashboard-data');
  const embeddedChart = readJsonBlock(updatedHtml, 'chart-data');
  assert.equal(dashboard.tape.rows[0].last, '6,123.45');
  assert.equal(dashboard.tape.rows[0].asOf, '2026-07-06');
  assert.equal(embeddedChart.barEncoding, 'tuple-v1');
  assert.deepEqual(embeddedChart.series[0].bars.at(-1), ['2026-07-06', 6120, 6125, 6110, 6123.45, null]);
}

function testChartFetcherTickerFilterAndMergeChartDataCliMode() {
  assert.deepEqual(parseFetchChartDataArgs(['--ticker', 'HG', '--ticker', 'NG']).tickers, ['HG', 'NG']);

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-chart-merge-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'commodity-chart-data.json');
  const shell = [
    '<!-- ============ DATA START — published dashboard payload ============ -->',
    '<script type="application/json" id="dashboard-data">{"editionId":"old","masthead":{"date":"Monday, July 6, 2026"},"footer":{"compiled":"Compiled Monday, July 6, 2026 at 4:00 PM CDT"},"tape":{"rows":[{"ticker":"SPX","group":"Equities","last":"stale","delta":"stale","pct":"stale","dir":"flat","asOf":"old"},{"ticker":"HG","group":"Commodities","last":"stale","delta":"stale","pct":"stale","dir":"flat","asOf":"old"}]}}<\/script>',
    '<!-- ============ DATA END ============ -->',
    '<script type="application/json" id="chart-data">{"schemaVersion":1,"barEncoding":"tuple-v1","series":[{"ticker":"SPX","section":"tape","sourceSymbol":"SPX","bars":[["2026-07-03",6000,6000,6000,6000,null],["2026-07-06",6120,6125,6110,6123.45,null]]}]}</script>',
    '<div class="page" id="app"><div id="mast-edition">Loading</div><div class="right" id="mast-date">Loading</div><h1 id="hero-headline">Loading</h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>',
    '<script>(function () {})();</script>'
  ].join('\n');
  const commodityChartData = {
    schemaVersion: 1,
    series: [{
      ticker: 'HG', section: 'tape', sourceSymbol: 'HG=F',
      bars: [
        { time: '2026-07-03', open: 4.5, high: 4.5, low: 4.5, close: 4.5 },
        { time: '2026-07-06', open: 4.6, high: 4.6, low: 4.6, close: 4.6 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, shell);
  fs.writeFileSync(payloadFile, JSON.stringify(commodityChartData));
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--merge-chart-data-json', payloadFile,
    '--test-skip-validation'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, DASHBOARD_TEST_MODE: '1' } });
  assert.equal(result.status, 0, result.stderr);

  const updatedHtml = fs.readFileSync(dashboardFile, 'utf8');
  const dashboard = readJsonBlock(updatedHtml, 'dashboard-data');
  const chart = readJsonBlock(updatedHtml, 'chart-data');
  assert.deepEqual(chart.series.map((series) => series.ticker), ['SPX', 'HG']);
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'SPX').last, '6,123.45');
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'HG').last, '4.60');
}

function testDashboardEmbeddedRuntimeParses() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  assert.doesNotThrow(() => new Function(dashboardRuntimeSource(html)), 'The complete dashboard runtime must parse as JavaScript.');
}

function testExpandedEarningsTimingGroupsPreserveMarketCapOrder() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'earnings-timing-groups');
  const { earningsTimingGroups, earningsTimingHeaderText } = Function(
    'earningsDayCountLabel',
    `${source}\nreturn { earningsTimingGroups, earningsTimingHeaderText };`
  )((count) => `${count} ${count === 1 ? 'Company' : 'Companies'}`);
  const rows = [
    { ticker: 'MSFT', reportTiming: 'bmo' },
    { ticker: 'JPM', reportTiming: 'bmo' },
    { ticker: 'TSLA', reportTiming: 'amc' },
    { ticker: 'AMD', reportTiming: 'dmh' },
    { ticker: 'XYZ', reportTiming: 'unknown' }
  ];

  assert.deepEqual(
    earningsTimingGroups(rows).map((group) => ({ label: group.label, tickers: group.rows.map((row) => row.ticker) })),
    [
      { label: 'Before Open', tickers: ['MSFT', 'JPM'] },
      { label: 'During Market', tickers: ['AMD'] },
      { label: 'After Close', tickers: ['TSLA'] },
      { label: 'Time Unknown', tickers: ['XYZ'] }
    ]
  );
  assert.equal(earningsTimingHeaderText({ rows }), 'Before Open · 2 Companies');
  assert.equal(earningsTimingHeaderText({ rows: [{ ticker: 'TSLA', reportTiming: 'amc' }] }), 'After Close · 1 Company');
}

function testDashboardValidatorRejectsRemoteRuntimeEndpoint() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const html = renderDashboardValidationFixture(dashboard, chartData).replace(
    'https://192.168.2.2:2210/api/market-refresh',
    'https://query1.finance.yahoo.com/api/market-refresh'
  );
  const result = dashboardValidationResult(html);
  assert.notEqual(result.status, 0, 'A remote dashboard runtime endpoint must fail validation.');
  assert.match(result.stderr, /Unexpected runtime URL: https:\/\/query1\.finance\.yahoo\.com\/api\/market-refresh/);
}

function validateDashboardFixture(data, now = FIXTURE_NOW) {
  const { chartData } = createDashboardValidationFixture();
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), now);
}

function validateChartDataFixture(chartData) {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  return dashboardValidationResult(
    replaceJsonBlock(html, 'chart-data', JSON.stringify(chartData)),
    '2026-07-10T13:30:00Z'
  );
}

function validateDashboardAndChartFixture(data, chartData) {
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), FIXTURE_NOW);
}

function validationResult(errors, warnings = []) {
  return {
    status: errors.length ? 1 : 0,
    stderr: errors.map((error) => `- ${error}`).join('\n'),
    stdout: warnings.map((warning) => `- ${warning}`).join('\n')
  };
}

function dashboardValidationResult(html, now = FIXTURE_NOW) {
  const result = validateDashboardHtml(html, { now: new Date(now) });
  return validationResult(result.errors, result.warnings);
}

function chartDataValidationResult(dashboardHtml, chartData) {
  const rows = chartableRowsFromDashboardHtml(dashboardHtml);
  const result = validateChartDataPayload(rows, chartData);
  return validationResult(result.errors);
}

function validationDashboardData() {
  // Contract mutations start from a fixed, self-contained payload; the live artifact has its own smoke test below.
  return createDashboardValidationFixture().dashboard;
}

function testDashboardValidatorAcceptsFridayBridgeCalendars() {
  const data = validationDashboardData();
  data.editionId = '2026-07-10T21:00:00Z';
  data.masthead = { ...data.masthead, date: 'Friday · July 10, 2026' };
  data.footer = {
    ...data.footer,
    compiled: 'Compiled Friday, July 10, 2026 at 4:00 PM CDT · Market data: Alternative.me Crypto Fear & Greed Index, CoinMarketCap Altcoin Season Index'
  };
  data.weekAhead = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-10', to: '2026-07-16' },
    officialSchedule: {
      events: [{
        date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  const earningsWeek = data.earnings.week;
  earningsWeek.range = { from: '2026-07-10', to: '2026-07-16' };
  earningsWeek.rows = [];
  earningsWeek.secondaryRecoveryCandidates = [];
  earningsWeek.companyReleaseTasks = [];
  delete earningsWeek.companyReleaseApply;
  delete earningsWeek.narrativeApply;
  earningsWeek.summary.counts = {
    total: 0,
    verified: 0,
    partial: 0,
    reactionComputed: 0,
    missingTiming: 0,
    missingRevenue: 0,
    missingMarketCap: 0,
    secondaryRecoveryCandidates: 0,
    companyReleaseTasks: 0
  };

  const result = validateDashboardFixture(data);
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorRejectsCompletedFridayWithPartialCalendarRollover() {
  const staleEarnings = validationDashboardData();
  staleEarnings.earnings.week.range = { from: '2026-07-06', to: '2026-07-10' };

  const staleEarningsResult = validateDashboardFixture(staleEarnings);
  assert.notEqual(staleEarningsResult.status, 0, 'A completed Friday window must reject a stale Earnings range.');
  assert.match(
    staleEarningsResult.stderr,
    /earnings\.week\.range must be 2026-07-10 through 2026-07-16 before newsBaseline\.lastScheduledWindow can record 2026-07-10:afternoon/
  );

  const staleWeekAhead = validationDashboardData();
  staleWeekAhead.weekAhead = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-06', to: '2026-07-10' },
    officialSchedule: { events: [], authorities: [] },
    now: new Date('2026-07-10T18:00:00Z')
  });
  const staleWeekAheadResult = validateDashboardFixture(staleWeekAhead);
  assert.notEqual(staleWeekAheadResult.status, 0, 'A completed Friday window must reject a stale Week Ahead range.');
  assert.match(
    staleWeekAheadResult.stderr,
    /weekAhead\.range must be 2026-07-10 through 2026-07-16 before newsBaseline\.lastScheduledWindow can record 2026-07-10:afternoon/
  );
}


function testDashboardValidatorRejectsReferencePagesInAllNewsSections() {
  const data = validationDashboardData();
  data.futuresModule.stories[0] = {
    tag: 'Calendar',
    tone: 'neutral',
    title: 'NYSE market hours and holidays',
    body: 'Use this maintained exchange calendar when a holiday or shortened session affects the market schedule.',
    url: 'https://www.nyse.com/markets/hours-calendars',
    referencePage: true
  };
  data.stories[0].referencePage = true;
  data.crypto.notes[0].referencePage = true;
  const result = validateDashboardFixture(data);
  assert.notEqual(result.status, 0, 'News sections must not accept evergreen-page exceptions.');
  assert.match(result.stderr, /futuresModule\.stories\[0\]\.referencePage is not supported/);
  assert.match(result.stderr, /Story .*\.referencePage is not supported/);
  assert.match(result.stderr, /Crypto note .*\.referencePage is not supported/);
}

function testDashboardValidatorRequiresCryptoNoteDisplayFields() {
  for (const field of ['kicker', 'title', 'body']) {
    const data = validationDashboardData();
    delete data.crypto.notes[0][field];
    const result = validateDashboardFixture(data);
    assert.notEqual(result.status, 0, `Crypto notes must require ${field}.`);
    assert.match(result.stderr, new RegExp(`Crypto note ${field} must be populated`));
  }
}


function testDashboardValidatorRejectsOversizedFuturesStoryTag() {
  const data = validationDashboardData();
  data.futuresModule.stories[0].tag = 'An Editorial Tag That Is Too Long';
  const result = validateDashboardFixture(data);
  assert.notEqual(result.status, 0, 'An oversized futures tag must fail validation.');
  assert.match(result.stderr, /tag must be 24 characters or fewer to preserve the shared story-label column/);
}

function testCompactChartPayloadUsesFourDecimalTuples() {
  const compact = compactChartPayload({
    schemaVersion: 1,
    series: [{
      ticker: 'TEST',
      bars: [{
        time: '2026-07-10',
        open: 1.23456,
        high: 1.98765,
        low: 1.11114,
        close: 1.22225,
        volume: 123.6
      }]
    }]
  });
  assert.equal(compact.barEncoding, 'tuple-v1');
  assert.deepEqual(compact.series[0].bars[0], ['2026-07-10', 1.2346, 1.9877, 1.1111, 1.2223, 124]);
}

function testDashboardValidatorRejectsNonTupleOrOverPreciseEmbeddedBars() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const chartData = readJsonBlock(html, 'chart-data');
  chartData.series[0].bars[0] = ['2021-07-12', 1.23456, 2, 1, 2, null];
  const precisionResult = validateChartDataFixture(chartData);
  assert.notEqual(precisionResult.status, 0, 'Embedded OHLC values must be capped at four decimals.');
  assert.match(precisionResult.stderr, /must use at most four decimal places/);

  chartData.series[0].bars[0] = { time: '2021-07-12', open: 1, high: 2, low: 1, close: 2 };
  const shapeResult = validateChartDataFixture(chartData);
  assert.notEqual(shapeResult.status, 0, 'Embedded chart bars must use the compact tuple encoding.');
  assert.match(shapeResult.stderr, /must be a \[time, open, high, low, close, volume\] tuple/);

  const noVolumeChart = readJsonBlock(html, 'chart-data');
  noVolumeChart.series.find((item) => item.ticker === 'VIX').noVolume = false;
  const noVolumeResult = validateChartDataFixture(noVolumeChart);
  assert.notEqual(noVolumeResult.status, 0, 'A chart without volume bars must declare noVolume.');
  assert.match(noVolumeResult.stderr, /VIX\.noVolume must be true to match its embedded volume bars/);
}

function testDashboardValidatorUsesTheTapeAsItsChartRoster() {
  const data = validationDashboardData();
  const { chartData } = createDashboardValidationFixture();
  const sourceTicker = 'SPX';
  const dashboardRow = data.tape.rows.find((row) => row.ticker === sourceTicker);
  const sourceSeries = chartData.series.find((item) => item.ticker === sourceTicker);
  const sourceQuote = chartData.quoteRows.tape.find((row) => row.ticker === sourceTicker);

  data.tape.rows.push({ ...dashboardRow, ticker: 'TST', name: 'Test Contract', sourceSymbol: 'TEST=F' });
  chartData.series.push({ ...sourceSeries, ticker: 'TST', name: 'Test Contract', sourceSymbol: 'TEST=F' });
  chartData.quoteRows.tape.push({ ...sourceQuote, ticker: 'TST', name: 'Test Contract', sourceSymbol: 'TEST=F' });

  const result = validateDashboardAndChartFixture(data, chartData);
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorCliArguments() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const editionId = readJsonBlock(html, 'dashboard-data').editionId;
  const unknownResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate_dashboard.js'),
    path.join(root, 'daily_financial_news.html'),
    '--typo'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_NOW_ISO: editionId }
  });
  assert.notEqual(unknownResult.status, 0, 'Dashboard validation must reject unknown arguments.');
  assert.match(unknownResult.stderr, /Unknown argument: --typo/);

  const optionOnlyResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate_dashboard.js'),
    '--require-editorial-review'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_NOW_ISO: editionId }
  });
  assert.equal(optionOnlyResult.status, 0, optionOnlyResult.stderr);

  const outsidePathResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate_dashboard.js'),
    path.join(os.tmpdir(), 'outside-dashboard.html')
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(outsidePathResult.status, 0, 'Dashboard validation must reject files outside the repository.');
  assert.match(outsidePathResult.stderr, /Refusing to validate a file outside this repository/);
}

function testDashboardValidatorRejectsMutationCases() {
  const cases = [
    ['published Earnings outputPath', (data) => { data.earnings.week.outputPath = '/Users/example/generated/earnings_week.json'; }, /earnings\.week\.outputPath is staging-only/],
    ['missing Futures publishedAt', (data) => { delete data.futuresModule.stories[0].publishedAt; }, /publishedAt must be an offset-bearing ISO timestamp/],
    ['duplicate Futures URL', (data) => { data.futuresModule.stories[1].url = data.futuresModule.stories[0].url; }, /futuresModule\.stories\[1\]\.url duplicates futuresModule\.stories\[0\]\.url/],
    ['Futures direction mismatch', (data) => { data.futuresModule.futures[0].dir = 'down'; }, /dir must match raw\.pct/],
    ['negative Futures price', (data) => { data.futuresModule.futures[0].series[0][1] = -100; }, /series must contain positive prices/],
    ['invalid Futures reference date', (data) => {
      data.masthead.edition = 'Morning Edition';
      data.editionId = '2026-07-09T12:30:00Z';
      data.futuresModule.sectionLabel = 'Before The Open';
      data.futuresModule.sectionTitle = 'Pre-Market Futures';
      for (const future of data.futuresModule.futures) {
        future.raw.referenceDate = '2026-06-31';
        future.raw.referenceCloseEastern = '4:00 PM ET';
      }
      for (const story of data.futuresModule.stories) story.publishedAt = '2026-07-09T11:45:00Z';
    }, /referenceDate must be an ISO date/],
    ['invalid Futures publishedAt', (data) => { data.futuresModule.stories[0].publishedAt = '2026-07-32T12:00:00Z'; }, /publishedAt must be an offset-bearing ISO timestamp/],
    ['invalid story publishedOn', (data) => { data.stories[0].publishedOn = '2026-07-32'; }, /publishedOn must be an ISO date/],
    ['Futures story outside active session', (data) => { data.futuresModule.stories[0].publishedAt = '2026-07-09T19:59:59Z'; }, /publishedAt must fall between the current U\.S\. regular-session open/],
    ['Futures section and masthead mismatch', (data) => {
      data.masthead.edition = 'Afternoon Edition';
      data.futuresModule.sectionLabel = 'Before The Open';
      data.futuresModule.sectionTitle = 'Pre-Market Futures';
      data.tape.label = 'Friday Before The Open · Fixture drivers';
    }, /masthead\.edition must be Morning Edition when futuresModule is Before The Open\/Pre-Market Futures/],
    ['missing shared morning reference date', (data) => {
      data.masthead.edition = 'Morning Edition';
      data.editionId = '2026-07-10T12:30:00Z';
      data.futuresModule.sectionLabel = 'Before The Open';
      data.futuresModule.sectionTitle = 'Pre-Market Futures';
      data.tape.label = 'Friday Before The Open · Fixture drivers';
      for (const future of data.futuresModule.futures) {
        delete future.raw.referenceDate;
        delete future.raw.referenceCloseEastern;
      }
    }, /Pre-Market Futures rows must share one valid raw\.referenceDate/]
  ];

  for (const [name, mutate, expectedError] of cases) {
    const data = validationDashboardData();
    mutate(data);
    const result = validateDashboardFixture(data);
    assert.notEqual(result.status, 0, `${name} must fail validation.`);
    assert.match(result.stderr, expectedError);
  }
}

function testDashboardValidatorAcceptsInWindowFuturesStories() {
  const result = validateDashboardFixture(validationDashboardData());
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorAcceptsPriorSessionNewsOnWeekend() {
  const data = validationDashboardData();
  data.editionId = '2026-07-12T17:45:00Z';
  data.masthead.date = 'Sunday · July 12, 2026';
  data.footer.compiled = 'Compiled Sunday, July 12, 2026 at 12:45 PM CDT · Market data: Alternative.me Crypto Fear & Greed Index, CoinMarketCap Altcoin Season Index';
  for (const story of data.stories) story.publishedOn = '2026-07-11';
  for (const note of data.crypto.notes) note.publishedOn = '2026-07-11';

  const result = validateDashboardFixture(data, '2026-07-12T17:45:00Z');
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorAcceptsMorningFuturesStoryWindow() {
  const data = validationDashboardData();
  data.masthead.edition = 'Morning Edition';
  data.editionId = '2026-07-10T12:30:00Z';
  data.futuresModule.sectionLabel = 'Before The Open';
  data.futuresModule.sectionTitle = 'Pre-Market Futures';
  data.tape.label = 'Friday Before The Open · Fixture drivers';
  for (const future of data.futuresModule.futures) {
    future.raw.referenceDate = '2026-07-09';
    future.raw.referenceCloseEastern = '4:00 PM ET';
  }
  for (const story of data.futuresModule.stories) {
    story.publishedOn = '2026-07-10';
    story.publishedAt = '2026-07-10T11:45:00Z';
  }
  const result = validateDashboardFixture(data);
  assert.equal(result.status, 0, result.stderr);
}

function testMorningFuturesWindowUsesFetchedReferenceDateAcrossHoliday() {
  const validator = fs.readFileSync(path.join(root, 'scripts', 'validate_dashboard.js'), 'utf8');
  const source = extractRuntimeTestBlock(validator, 'futures-story-window');
  const { futuresStoryPublicationWindow } = Function(
    'isIsoDate',
    'isIsoDateTime',
    `${source}\nreturn { futuresStoryPublicationWindow };`
  )(isIsoDate, isIsoDateTime);
  const futures = Array.from({ length: 4 }, () => ({ raw: { referenceDate: '2026-07-02' } }));
  const window = futuresStoryPublicationWindow(
    'Pre-Market Futures',
    '2026-07-06T12:30:00Z',
    new Date('2026-07-06T12:30:00Z'),
    futures
  );

  assert.equal(window.start.toISOString(), '2026-07-02T20:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-07-06T12:30:00.000Z');

  const sessionWindow = futuresStoryPublicationWindow(
    'Session Futures',
    '2026-07-11T12:30:00Z',
    new Date('2026-07-11T12:30:00Z'),
    Array.from({ length: 4 }, () => ({ raw: { sessionDate: '2026-07-10' } }))
  );
  assert.equal(sessionWindow.start.toISOString(), '2026-07-10T13:30:00.000Z');
  assert.equal(sessionWindow.end.toISOString(), '2026-07-10T20:00:00.000Z');
}

function testEditionStampChangesIdentity() {
  const data = dashboardFixture();
  const stamped = stampDashboardEdition(data);

  assert.notEqual(stamped.editionId, data.editionId);
  assert.ok(!Number.isNaN(Date.parse(stamped.editionId)));
}

function testLocalRefreshIndicatorBehavior() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'local-refresh-indicator');
  const runtime = Function(`
    let localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
    let indicatorAvailable = true;
    const selectors = [];
    const tooltip = { textContent: '' };
    const announcement = { textContent: '' };
    const indicator = {
      dataset: {},
      attributes: {},
      set outerHTML(_value) { throw new Error('The focused indicator must not be replaced.'); },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector(selector) {
        if (selector === '[data-local-refresh-tooltip]') return tooltip;
        if (selector === '[data-local-refresh-announcement]') return announcement;
        return null;
      }
    };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
    const document = {
      querySelector: (selector) => {
        selectors.push(selector);
        return indicatorAvailable ? indicator : null;
      }
    };
    ${source}
    return {
      setLocalRefreshIndicator,
      markup: () => localRefreshIndicatorHtml(),
      snapshot: () => ({
        state: indicator.dataset.localRefreshState,
        label: indicator.attributes['aria-label'],
        tooltip: tooltip.textContent,
        announcement: announcement.textContent
      }),
      selectors: () => selectors,
      hideIndicator: () => { indicatorAvailable = false; }
    };
  `)();
  const states = [
    ['checking', 'Checking local refresh'],
    ['live', 'Local refresh 12:34 PM CDT\n44 ticker series'],
    ['cached', 'Cached local data'],
    ['partial', 'Local refresh 12:34 PM CDT\n43 ticker series\n1 refresh error'],
    ['idle', 'Local helper reached; no newer prices'],
    ['error', 'Local refresh unavailable or blocked']
  ];

  for (const [state, message] of states) {
    runtime.setLocalRefreshIndicator(state, message);
    const markup = runtime.markup();
    assert.deepEqual(runtime.snapshot(), {
      state,
      label: message,
      tooltip: message,
      announcement: message
    });
    assert.match(markup, new RegExp(`data-local-refresh-state="${state}"`));
    assert.match(markup, /role="img"/);
    assert.match(markup, /tabindex="0"/);
    assert.match(markup, /class="local-refresh-indicator-dot" aria-hidden="true"/);
    assert.match(markup, /class="local-refresh-tooltip" data-local-refresh-tooltip role="tooltip"/);
    assert.match(markup, /data-local-refresh-announcement role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(markup, new RegExp(`aria-label="${message.replace('\n', '\\n')}"`));
    assert.doesNotMatch(markup, /\btitle=/);
  }

  runtime.setLocalRefreshIndicator('error', '<Local & "safe">');
  assert.equal(runtime.snapshot().label, '<Local & "safe">');
  assert.match(runtime.markup(), /aria-label="&lt;Local &amp; &quot;safe&quot;&gt;"/);
  assert.match(runtime.markup(), /<span class="local-refresh-tooltip" data-local-refresh-tooltip role="tooltip">&lt;Local &amp; &quot;safe&quot;&gt;<\/span>/);
  assert.deepEqual(runtime.selectors(), Array.from({ length: states.length + 1 }, () => '[data-local-refresh-indicator]'));

  runtime.hideIndicator();
  assert.doesNotThrow(() => runtime.setLocalRefreshIndicator('idle', 'Local helper reached; no newer prices'));
}

function testEmbeddedPayloadLoadErrorsAreDistinct() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = [
    extractDashboardRuntimeTestBlock(html, 'chart-payload-load'),
    extractDashboardRuntimeTestBlock(html, 'dashboard-payload-load')
  ].join('\n');
  const runtime = Function(`
    let chartSeriesByTicker = new Map();
    let chartDataReferenceDate = '';
    const nodes = new Map();
    const document = { getElementById: (id) => nodes.get(id) || null };
    const chartPayloadReferenceDate = () => '2026-07-10';
    ${source}
    return {
      loadChartData,
      loadData,
      setNode: (id, textContent) => nodes.set(id, { textContent }),
      clear: () => nodes.clear()
    };
  `)();

  assert.throws(() => runtime.loadChartData(), /chart-data JSON block was not found/);
  runtime.setNode('chart-data', '{bad json');
  assert.throws(() => runtime.loadChartData(), /JSON/);
  runtime.clear();
  assert.throws(() => runtime.loadData(), /dashboard-data JSON block was not found/);
  runtime.setNode('dashboard-data', '{bad json');
  assert.throws(() => runtime.loadData(), /JSON/);
  assert.match(html, /An embedded dashboard payload could not be loaded\./);
}

async function testLocalRefreshIndicatorLifecycle() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = [
    extractDashboardRuntimeTestBlock(html, 'local-refresh-status'),
    extractDashboardRuntimeTestBlock(html, 'local-refresh-request')
  ].join('\n');
  const runtime = Function(`
    let fetch;
    class AbortController { constructor() { this.signal = {}; } abort() {} }
    const LOCAL_MARKET_REFRESH_URLS = ['https://192.168.2.2:2210/api/market-refresh'];
    const LOCAL_MARKET_REFRESH_TIMEOUT_MS = 100;
    const window = { setTimeout: () => 1, clearTimeout: () => {} };
    const states = [];
    const writes = [];
    const renders = [];
    const focusRestores = [];
    let localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
    let applyResult = false;
    let indicatorFocused = false;
    const document = {
      activeElement: { matches: (selector) => indicatorFocused && selector === '[data-local-refresh-indicator]' },
      querySelector: () => ({ focus: (options) => focusRestores.push(options) })
    };
    const setLocalRefreshIndicator = (state, message) => {
      localRefreshIndicator = { state, message };
      states.push({ state, message });
    };
    const applyLocalMarketRefresh = () => applyResult;
    const writeCachedLocalMarketRefresh = (_data, payload) => writes.push(payload);
    const render = (data) => renders.push(data);
    ${source}
    return {
      async run({ fetchImpl, changed, focused = false }) {
        fetch = fetchImpl;
        applyResult = changed;
        indicatorFocused = focused;
        states.length = 0;
        writes.length = 0;
        renders.length = 0;
        focusRestores.length = 0;
        localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
        await tryLocalMarketRefresh({ editionId: 'fixture' });
        return { states: [...states], writes: [...writes], renders: [...renders], focusRestores: [...focusRestores] };
      }
    };
  `)();

  const unavailable = await runtime.run({ fetchImpl: undefined, changed: false });
  assert.deepEqual(unavailable.states, [{ state: 'error', message: 'Local refresh unavailable in this browser' }]);

  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T18:34:00.000Z',
    series: [{ ticker: 'SPX' }, { ticker: 'VIX' }, { ticker: 'SPX' }]
  };
  let refreshRequest;
  const refreshed = await runtime.run({
    fetchImpl: async (url, options) => {
      refreshRequest = { url, options };
      return { ok: true, status: 200, json: async () => payload };
    },
    changed: true,
    focused: true
  });
  assert.deepEqual(refreshed.states.map((entry) => entry.state), ['checking', 'live']);
  assert.match(refreshed.states[1].message, /^Local refresh .+\n2 ticker series$/);
  assert.deepEqual(refreshed.writes, [payload]);
  assert.equal(refreshed.renders.length, 1);
  assert.deepEqual(refreshed.focusRestores, [{ preventScroll: true }]);
  assert.equal(refreshRequest.url, 'https://192.168.2.2:2210/api/market-refresh');
  assert.equal(refreshRequest.options.cache, 'no-store');
  assert.equal(refreshRequest.options.targetAddressSpace, 'local');

  const partialPayload = {
    ...payload,
    partial: true,
    errors: [{ section: 'tape', ticker: 'MOVE', message: 'failed' }]
  };
  const partial = await runtime.run({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => partialPayload }),
    changed: true
  });
  assert.deepEqual(partial.states.map((entry) => entry.state), ['checking', 'partial']);
  assert.match(partial.states[1].message, /\n2 ticker series\n1 refresh error$/);
  assert.deepEqual(partial.writes, [partialPayload]);
  assert.equal(partial.renders.length, 1);

  const unchangedPartial = await runtime.run({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => partialPayload }),
    changed: false
  });
  assert.deepEqual(unchangedPartial.states.map((entry) => entry.state), ['checking', 'partial']);
  assert.equal(unchangedPartial.writes.length, 0);
  assert.equal(unchangedPartial.renders.length, 0);

  let idleCalls = 0;
  const idle = await runtime.run({
    fetchImpl: async () => {
      idleCalls += 1;
      return { ok: true, status: 200, json: async () => payload };
    },
    changed: false
  });
  assert.equal(idleCalls, 1);
  assert.deepEqual(idle.states.map((entry) => entry.state), ['checking', 'idle']);
  assert.equal(idle.states[1].message, 'Local helper reached; no newer prices');

  const helperError = await runtime.run({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    changed: false
  });
  assert.deepEqual(helperError.states.map((entry) => entry.state), ['checking', 'error']);
  assert.equal(helperError.states[1].message, 'Local helper responded with 503');

  const unsupported = await runtime.run({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ partial: true }) }),
    changed: false
  });
  assert.deepEqual(unsupported.states.map((entry) => entry.state), ['checking', 'error']);
  assert.equal(unsupported.states[1].message, 'Local helper returned unsupported data');
}

function testLocalRefreshKeepsNewerEmbeddedSeriesProvenance() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'local-refresh-series-merge');
  const { mergeSeriesMap } = Function(`
    ${source}
    return { mergeSeriesMap };
  `)();
  const seriesMap = new Map([[
    'VAW',
    {
      ticker: 'VAW',
      source: 'Yahoo Finance Chart API + Finnhub Quote API',
      latestQuoteSource: 'Finnhub Quote API',
      bars: [
        { time: '2026-07-02', open: 231, high: 232, low: 230, close: 231 },
        { time: '2026-07-06', open: 232.3, high: 232.19, low: 229.59, close: 232.06 }
      ]
    }
  ]]);

  const changed = mergeSeriesMap(seriesMap, [{
    ticker: 'VAW',
    source: 'Yahoo Finance Chart API',
    latestQuoteSource: '',
    staleRefreshOnly: true,
    bars: [
      { time: '2026-07-01', open: 229, high: 230, low: 228, close: 229 },
      { time: '2026-07-02', open: 231.5, high: 232.5, low: 230.5, close: 231.5 }
    ]
  }]);

  assert.equal(changed, true);
  const staleMerge = seriesMap.get('VAW');
  assert.equal(staleMerge.source, 'Yahoo Finance Chart API + Finnhub Quote API');
  assert.equal(staleMerge.latestQuoteSource, 'Finnhub Quote API');
  assert.equal(staleMerge.staleRefreshOnly, undefined);
  assert.equal(staleMerge.bars.at(-1).time, '2026-07-06');
  assert.ok(staleMerge.bars.some((bar) => bar.time === '2026-07-01'));

  mergeSeriesMap(seriesMap, [{
    ticker: 'VAW',
    source: 'Local refreshed chart API',
    latestQuoteSource: 'Local refreshed quote API',
    bars: [
      { time: '2026-07-06', open: 232.3, high: 232.19, low: 229.59, close: 232.06 },
      { time: '2026-07-07', open: 232.1, high: 233, low: 231, close: 232.5 }
    ]
  }]);

  const currentMerge = seriesMap.get('VAW');
  assert.equal(currentMerge.source, 'Local refreshed chart API');
  assert.equal(currentMerge.latestQuoteSource, 'Local refreshed quote API');
  assert.equal(currentMerge.bars.at(-1).time, '2026-07-07');
  assert.equal(mergeSeriesMap(seriesMap, [structuredClone(currentMerge)]), false);

  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'UNKNOWN',
    bars: [
      { time: '2026-07-06', open: 1, high: 1, low: 1, close: 1 },
      { time: '2026-07-07', open: 2, high: 2, low: 2, close: 2 }
    ]
  }]), false);
  assert.equal(seriesMap.has('UNKNOWN'), false);
}

function testLocalRefreshIgnoresIdenticalCryptoStats() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = [
    extractDashboardRuntimeTestBlock(html, 'local-refresh-series-merge'),
    extractDashboardRuntimeTestBlock(html, 'local-refresh-crypto-stats')
  ].join('\n');
  const { applyCryptoStats } = Function(`
    ${source}
    return { applyCryptoStats };
  `)();
  const data = {
    crypto: {
      stats: [{ sym: 'F&G', name: 'Fear & Greed', price: '50', chg: 'Neutral' }]
    }
  };
  assert.equal(applyCryptoStats(data, [structuredClone(data.crypto.stats[0])]), false);
  assert.equal(applyCryptoStats(data, [{ ...data.crypto.stats[0], price: '51' }]), true);
  assert.equal(data.crypto.stats[0].price, '51');
}

function chartValidationFixture() {
  const vawQuote = {
    group: 'Materials',
    name: 'Materials',
    ticker: 'VAW',
    last: '232.06',
    delta: '-0.58',
    pct: '-0.25%',
    dir: 'down',
    note: 'Fixture note',
    sourceSymbol: 'VAW',
    asOf: '2026-07-06'
  };
  const curveQuote = {
    group: 'Rates & Credit',
    name: 'Yield Curve',
    ticker: 'USYC',
    last: '2s10s +35 bp',
    delta: '+1 bp',
    pct: '1D',
    dir: 'up',
    note: 'Fixture curve note',
    sourceSymbol: 'TREASURY:CURVE',
    asOf: '2026-07-06'
  };
  const curvePoints = [
    { label: '1M', years: 1 / 12, value: 3.69 },
    { label: '2Y', years: 2, value: 4.13 },
    { label: '10Y', years: 10, value: 4.48 },
    { label: '30Y', years: 30, value: 4.99 }
  ];
  const chartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-06T20:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-06', endDate: '2026-07-06' },
    sourceFamilies: ['Yahoo Finance Chart API', 'Treasury.gov Daily Treasury Yield Curve Rate Data'],
    quoteRows: {
      tape: [
        Object.fromEntries(Object.entries(vawQuote).filter(([field]) => field !== 'group')),
        Object.fromEntries(Object.entries(curveQuote).filter(([field]) => field !== 'group'))
      ],
      crypto: []
    },
    series: [{
      ticker: 'VAW',
      name: 'Materials',
      section: 'tape',
      sourceSymbol: 'VAW',
      note: 'Fixture note',
      source: 'Yahoo Finance Chart API',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: false,
      bars: [
        { time: '2026-07-02', open: 230.58, high: 232.64, low: 230.30, close: 232.64, volume: 60800 },
        { time: '2026-07-06', open: 232.3, high: 232.3, low: 229.59, close: 232.06, volume: 50110 }
      ]
    }, {
      ticker: 'USYC',
      name: 'Yield Curve',
      section: 'tape',
      sourceSymbol: 'TREASURY:CURVE',
      note: 'Fixture curve note',
      source: 'Treasury.gov Daily Treasury Yield Curve Rate Data',
      sourceKey: 'treasury_yield_curve',
      dataKind: 'close',
      priceOnly: true,
      noVolume: true,
      unit: 'percent_yield',
      bars: [
        { time: '2026-07-02', open: 4.47, high: 4.47, low: 4.47, close: 4.47 },
        { time: '2026-07-06', open: 4.48, high: 4.48, low: 4.48, close: 4.48 }
      ],
      curveDate: '2026-07-06',
      curvePoints,
      comparisonCurves: [{
        label: '1M ago',
        date: '2026-06-05',
        points: curvePoints.map((point) => ({ ...point, value: point.value + 0.02 }))
      }, {
        label: '6M ago',
        date: '2026-01-05',
        points: curvePoints.map((point) => ({ ...point, value: point.value + 0.04 }))
      }],
      curveSpread: { label: '2s10s', valueBp: 35, previousValueBp: 34, deltaBp: 1, comparison: '1D' }
    }]
  };
  return {
    dashboardHtml: `<script type="application/json" id="dashboard-data">${JSON.stringify({ tape: { rows: [vawQuote, curveQuote] } })}</script>`,
    chartData
  };
}

function testChartDataValidationMutations() {
  const cases = [
    {
      name: 'rejects quote rows ahead of the series',
      mutate: (payload) => { payload.quoteRows.tape[0].last = '231.59'; },
      expected: [/must match the latest generated series bar-derived value/]
    },
    {
      name: 'rejects impossible bar dates',
      mutate: (payload) => { payload.series[0].bars[0].time = '2026-02-30'; },
      expected: [/bars\[0\]\.time must be an ISO date/]
    },
    {
      name: 'rejects a latest quote-only placeholder',
      mutate: (payload) => { payload.series[0].bars[1] = { time: '2026-07-06', open: 232.06, high: 232.06, low: 232.06, close: 232.06 }; },
      expected: [/do not publish a latest quote-only placeholder in an OHLC series/]
    },
    {
      name: 'requires noVolume when every bar lacks volume',
      mutate: (payload) => { for (const bar of payload.series[0].bars) delete bar.volume; },
      expected: [/VAW\.noVolume must be true to match its generated volume bars/]
    },
    {
      name: 'rejects stale source families',
      mutate: (payload) => { payload.series[0].source = 'Yahoo Finance Chart API + Finnhub Quote API'; },
      expected: [/sourceFamilies must include Yahoo Finance Chart API \+ Finnhub Quote API/]
    },
    {
      name: 'rejects duplicate Yield Curve comparisons',
      mutate: (payload) => {
        const curve = payload.series.find((series) => series.ticker === 'USYC');
        curve.comparisonCurves[1].date = curve.comparisonCurves[0].date;
        curve.comparisonCurves[1].points = structuredClone(curve.comparisonCurves[0].points);
      },
      expected: [/comparisonCurves\[1\]\.date must be distinct from 1M ago/, /comparisonCurves\[1\]\.points must be distinct from 1M ago/]
    }
  ];

  const baseline = chartValidationFixture();
  assert.equal(chartDataValidationResult(baseline.dashboardHtml, baseline.chartData).status, 0);
  for (const { name, mutate, expected } of cases) {
    const payload = structuredClone(baseline.chartData);
    mutate(payload);
    const result = chartDataValidationResult(baseline.dashboardHtml, payload);
    assert.notEqual(result.status, 0, name);
    for (const pattern of expected) assert.match(result.stderr, pattern, name);
  }
}

function testAssetValidationRejectsImpossibleDate() {
  assert.throws(
    () => normalizedSummary({
      asOf: '2026-02-30',
      status: 'available',
      portfolioMtdReturnValue: 1.25
    }, false, ''),
    /summary asOf must be YYYY-MM-DD/
  );
}

function testDashboardValidatorRejectsInvalidYieldCurveComparisons() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const chartData = readJsonBlock(html, 'chart-data');
  const yieldCurve = chartData.series.find((series) => series.sourceSymbol === 'TREASURY:CURVE');
  assert.ok(yieldCurve, 'The embedded chart data must contain the Treasury yield curve.');

  const duplicateComparison = structuredClone(chartData);
  const duplicateCurve = duplicateComparison.series.find((series) => series.sourceSymbol === 'TREASURY:CURVE');
  duplicateCurve.comparisonCurves[1].date = duplicateCurve.comparisonCurves[0].date;
  duplicateCurve.comparisonCurves[1].points = structuredClone(duplicateCurve.comparisonCurves[0].points);
  const duplicateResult = validateChartDataFixture(duplicateComparison);
  assert.notEqual(duplicateResult.status, 0, 'Duplicate embedded Yield Curve comparison curves must fail dashboard validation.');
  assert.match(duplicateResult.stderr, /comparisonCurves\[1\]\.date must be distinct from 1M ago/);
  assert.match(duplicateResult.stderr, /comparisonCurves\[1\]\.points must be distinct from 1M ago/);

  const staleComparison = structuredClone(chartData);
  const staleCurve = staleComparison.series.find((series) => series.sourceSymbol === 'TREASURY:CURVE');
  staleCurve.comparisonCurves[0].date = staleCurve.curveDate;
  const staleResult = validateChartDataFixture(staleComparison);
  assert.notEqual(staleResult.status, 0, 'An out-of-window embedded Yield Curve comparison must fail dashboard validation.');
  assert.match(staleResult.stderr, /comparisonCurves\[0\]\.date must be 1M ago relative to curveDate/);
}

function testChartPayloadMetadataContract() {
  const validPayload = {
    generatedAt: '2026-07-10T21:30:48.913Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' }
  };
  const validErrors = [];
  validateChartPayloadMetadata(validErrors, validPayload, { label: 'chart-data' });
  assert.deepEqual(validErrors, []);

  const invalidGeneratedAt = structuredClone(validPayload);
  invalidGeneratedAt.generatedAt = '2026-07-10T21:30:48';
  const timestampErrors = [];
  validateChartPayloadMetadata(timestampErrors, invalidGeneratedAt, { label: 'chart-data' });
  assert.deepEqual(timestampErrors, ['chart-data.generatedAt must be an offset-bearing ISO timestamp.']);

  const invalidRange = structuredClone(validPayload);
  invalidRange.range.startDate = '2026-02-30';
  invalidRange.range.endDate = '';
  const rangeErrors = [];
  validateChartPayloadMetadata(rangeErrors, invalidRange, { label: 'chart-data' });
  assert.deepEqual(rangeErrors, ['chart-data.range.startDate and chart-data.range.endDate must be ISO dates.']);
}

function testSharedChartPayloadContractAcrossEncodings() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const expectedByTicker = new Map(dashboard.tape.rows.map((row) => [row.ticker, row.sourceSymbol]));
  const expectedSectionByTicker = new Map(dashboard.tape.rows.map((row) => [row.ticker, 'tape']));
  const stagedPayload = structuredClone(chartData);
  stagedPayload.series = stagedPayload.series.map((series) => ({
    ...series,
    bars: series.bars.map(([time, open, high, low, close, volume]) => ({
      time, open, high, low, close, ...(volume === null ? {} : { volume })
    }))
  }));
  const validate = (payload, decodeSeries, volumeDescription) => {
    const errors = [];
    validateChartPayload(errors, payload, {
      expectedByTicker,
      expectedSectionByTicker,
      decodeSeries,
      volumeDescription
    });
    return errors;
  };

  assert.deepEqual(validate(stagedPayload, decodeObjectSeries, 'generated'), []);
  assert.deepEqual(validate(chartData, decodeTupleSeries, 'embedded'), []);

  const truncatedStagedPayload = structuredClone(stagedPayload);
  truncatedStagedPayload.series[0].bars = truncatedStagedPayload.series[0].bars.slice(0, 1);
  const truncatedEmbeddedPayload = structuredClone(chartData);
  truncatedEmbeddedPayload.series[0].bars = [truncatedEmbeddedPayload.series[0].bars[0], {}];
  let truncatedStagedErrors;
  let truncatedEmbeddedErrors;
  assert.doesNotThrow(() => { truncatedStagedErrors = validate(truncatedStagedPayload, decodeObjectSeries, 'generated'); });
  assert.doesNotThrow(() => { truncatedEmbeddedErrors = validate(truncatedEmbeddedPayload, decodeTupleSeries, 'embedded'); });
  assert.match(truncatedStagedErrors.join('\n'), /SPX\.bars must contain at least two daily bars/);
  assert.match(truncatedEmbeddedErrors.join('\n'), /SPX\.bars\[1\] must be a \[time, open, high, low, close, volume\] tuple/);
  assert.match(truncatedEmbeddedErrors.join('\n'), /SPX\.bars must contain at least two daily bars/);

  stagedPayload.series[0].noVolume = true;
  const invalidEmbeddedPayload = structuredClone(chartData);
  invalidEmbeddedPayload.series[0].noVolume = true;
  assert.match(validate(stagedPayload, decodeObjectSeries, 'generated').join('\n'), /SPX\.noVolume must be false to match its generated volume bars/);
  assert.match(validate(invalidEmbeddedPayload, decodeTupleSeries, 'embedded').join('\n'), /SPX\.noVolume must be false to match its embedded volume bars/);
}

function testDashboardValidatorRejectsInvalidChartPayloadMetadata() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const chartData = readJsonBlock(html, 'chart-data');
  const mutations = [
    ['generatedAt', (payload) => { payload.generatedAt = '2026-07-10T21:30:48'; }, /chart-data\.generatedAt must be an offset-bearing ISO timestamp/],
    ['range.startDate', (payload) => { payload.range.startDate = '2026-02-30'; }, /chart-data\.range\.startDate and chart-data\.range\.endDate must be ISO dates/],
    ['range.endDate', (payload) => { payload.range.endDate = ''; }, /chart-data\.range\.startDate and chart-data\.range\.endDate must be ISO dates/]
  ];

  for (const [field, mutate, expectedError] of mutations) {
    const invalidPayload = structuredClone(chartData);
    mutate(invalidPayload);
    const result = validateChartDataFixture(invalidPayload);
    assert.notEqual(result.status, 0, `Invalid embedded chart-data ${field} must fail dashboard validation.`);
    assert.match(result.stderr, expectedError);
  }
}

function testLocalMarketServerAutoRefreshWindow() {
  const input = writeChartDataFixture('2026-07-02');
  const args = parseLocalMarketServerArgs(['--input', input]);
  const window = refreshWindow(args, new Date('2026-07-06T18:00:00Z'));
  const objectInput = writeChartDataFixture('2026-07-03', { tuple: false });

  assert.equal(latestEmbeddedChartDate(input), '2026-07-02');
  assert.equal(latestEmbeddedChartDate(objectInput), '2026-07-03');
  assert.equal(window.mode, 'auto');
  assert.equal(window.latestEmbeddedDate, '2026-07-02');
  assert.equal(window.days, 12);
  assert.equal(window.startDate.toISOString().slice(0, 10), '2026-06-25');
  assert.equal(Object.hasOwn(window, 'overlapDays'), false);
}

function testLocalMarketServerSkipsYieldCurveRefresh() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-market-server-yield-curve-');
  const input = path.join(dir, 'dashboard.html');
  const dashboardData = {
    tape: {
      rows: [{
        name: 'Yield Curve',
        ticker: 'USYC',
        group: 'Rates & Credit',
        sourceSymbol: 'TREASURY:CURVE',
        note: 'Full curve context'
      }, {
        name: '10Y Treasury',
        ticker: 'TNX',
        group: 'Rates & Credit',
        sourceSymbol: 'TREASURY:10Y',
        note: 'Rate level'
      }, {
        name: 'S&P 500',
        ticker: 'SPX',
        group: 'Equities',
        sourceSymbol: '^GSPC',
        note: 'Index level'
      }]
    }
  };
  fs.writeFileSync(input, `<script type="application/json" id="dashboard-data">${JSON.stringify(dashboardData)}</script>`);

  const rows = localRefreshChartRows(input);

  assert.deepEqual(rows.map((row) => row.ticker), ['TNX', 'SPX']);
  assert.ok(!rows.some((row) => row.sourceSymbol === 'TREASURY:CURVE'));
}

function testLocalMarketServerExplicitAndFallbackWindows() {
  const explicit = refreshWindow(
    parseLocalMarketServerArgs(['--days', '15']),
    new Date('2026-07-06T18:00:00Z')
  );
  assert.equal(explicit.mode, 'explicit');
  assert.equal(explicit.days, 15);

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-market-server-empty-');
  const input = path.join(dir, 'dashboard.html');
  fs.writeFileSync(input, '<html></html>');
  const fallback = refreshWindow(
    parseLocalMarketServerArgs(['--input', input]),
    new Date('2026-07-06T18:00:00Z')
  );
  assert.equal(fallback.mode, 'fallback');
  assert.equal(fallback.days, 30);
}

function testLocalMarketServerPartialStatusIncludesRowErrors() {
  const cleanSections = {
    chart: { ok: true, error: '' },
    cryptoStats: { ok: true, error: '' }
  };
  assert.equal(isPartialRefresh([], cleanSections), false);
  assert.equal(isPartialRefresh([{ section: 'tape', ticker: 'VIX', message: 'failed' }], cleanSections), true);
  assert.equal(isPartialRefresh([], { ...cleanSections, cryptoStats: { ok: false, error: 'failed' } }), true);
}

function testExpandedChartScrollsFullyIntoViewport() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'chart-scroll-visibility');
  let rect = { top: 329, bottom: 949, height: 620 };
  const immediateScrolls = [];
  const correctiveScrolls = [];
  const delays = [];
  const slot = {
    getBoundingClientRect: () => rect,
    scrollIntoView: (options) => immediateScrolls.push(options)
  };
  const window = {
    innerHeight: 720,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => {
      delays.push(delay);
      callback();
    },
    scrollBy: (options) => correctiveScrolls.push(options)
  };
  const activeTapeChartRoot = () => slot;
  const scrollActiveTapeChartIntoView = new Function(
    'window',
    'activeTapeChartRoot',
    `${source}\nreturn scrollActiveTapeChartIntoView;`
  )(window, activeTapeChartRoot);

  scrollActiveTapeChartIntoView();
  assert.deepEqual(immediateScrolls, [{ block: 'nearest', inline: 'nearest', behavior: 'smooth' }]);
  assert.deepEqual(delays, [240]);
  assert.deepEqual(correctiveScrolls, [{ top: 245, behavior: 'smooth' }]);

  rect = { top: 40, bottom: 660, height: 620 };
  correctiveScrolls.length = 0;
  scrollActiveTapeChartIntoView();
  assert.deepEqual(correctiveScrolls, [], 'A fully visible chart must not move the page after expansion.');
}

function testLocalMarketServerOriginPolicyAndTlsOptions() {
  assert.equal(isAllowedBrowserOrigin(''), true);
  assert.equal(isAllowedBrowserOrigin('https://sdupuie.github.io'), true);
  assert.equal(isAllowedBrowserOrigin('http://127.0.0.1:8000'), true);
  assert.equal(isAllowedBrowserOrigin('https://localhost:8443'), true);
  assert.equal(isAllowedBrowserOrigin('null'), false);
  assert.equal(isAllowedBrowserOrigin('https://example.com'), false);
  assert.equal(isAllowedBrowserOrigin('https://sdupuie.github.io.example.com'), false);
  assert.equal(parseLocalMarketServerArgs([]).host, '192.168.2.2');

  const args = parseLocalMarketServerArgs([
    '--host', '192.168.2.2',
    '--cert', '/tmp/dashboard-cert.pem',
    '--key', '/tmp/dashboard-key.pem'
  ]);
  assert.equal(args.host, '192.168.2.2');
  assert.equal(args.cert, '/tmp/dashboard-cert.pem');
  assert.equal(args.key, '/tmp/dashboard-key.pem');

  const plist = fs.readFileSync(path.join(root, 'launchd', 'com.scott.daily-financial-dashboard.plist'), 'utf8');
  assert.match(plist, /<string>--host<\/string>\s*<string>192\.168\.2\.2<\/string>/);
}

async function runDashboardTest(test) {
  try {
    await test();
  } catch (error) {
    console.error(`Dashboard test failed: ${test.name}`);
    throw error;
  }
}

const architectureContractTests = Object.freeze([
  testArchitecturePolicyOwnershipMatrix,
  testArchitectureSingleWriterAndCliBoundaries,
  testDedicatedDashboardApplyModes,
  testFocusedEarningsApplyRejectsPendingScheduleReview,
  testFocusedApplyValidatesBeforeAtomicReplace,
  testSkipValidateCannotTargetCanonicalDashboard,
  testArchitecturePreparationLeavesCanonicalUnchanged,
  testArchitectureEditorialWorkspaceHandoff,
  testArchitectureFinalizationValidatesBeforeReplace
]);

async function main() {
  const tests = [
    testUpdaterQuoteAndCryptoPatches,
    testUpdaterModulePatches,
    testFuturesStagingPayloadContract,
    testEditorialReviewContract,
    testDeterministicEditionMetadata,
    testChartSeriesOwnsDerivedQuoteViews,
    testFinnhubQuoteBarMergesIntoOhlcSeries,
    testFinnhubQuoteFallbackOnlyWhenYahooLatestIsUnusable,
    testJsonBlockPatchKeepsDollarLiterals,
    testPatchDashboardDataBlockKeepsShellAndStampsEdition,
    testApplyChartDataJsonCliMode,
    testChartFetcherTickerFilterAndMergeChartDataCliMode,
    testDashboardEmbeddedRuntimeParses,
    testExpandedEarningsTimingGroupsPreserveMarketCapOrder,
    testDashboardValidatorRejectsRemoteRuntimeEndpoint,
    testDashboardValidatorAcceptsFridayBridgeCalendars,
    testDashboardValidatorRejectsCompletedFridayWithPartialCalendarRollover,
    testCompactChartPayloadUsesFourDecimalTuples,
    testDashboardValidatorRejectsNonTupleOrOverPreciseEmbeddedBars,
    testDashboardValidatorUsesTheTapeAsItsChartRoster,
    testDashboardValidatorCliArguments,
    testDashboardValidatorRejectsMutationCases,
    testDashboardValidatorRejectsOversizedFuturesStoryTag,
    testDashboardValidatorAcceptsInWindowFuturesStories,
    testDashboardValidatorAcceptsPriorSessionNewsOnWeekend,
    testDashboardValidatorAcceptsMorningFuturesStoryWindow,
    testMorningFuturesWindowUsesFetchedReferenceDateAcrossHoliday,
    testDashboardValidatorRejectsReferencePagesInAllNewsSections,
    testDashboardValidatorRequiresCryptoNoteDisplayFields,
    testEditionStampChangesIdentity,
    testLocalRefreshIndicatorBehavior,
    testEmbeddedPayloadLoadErrorsAreDistinct,
    testLocalRefreshIndicatorLifecycle,
    testLocalRefreshKeepsNewerEmbeddedSeriesProvenance,
    testLocalRefreshIgnoresIdenticalCryptoStats,
    testAssetValidationRejectsImpossibleDate,
    testChartDataValidationMutations,
    testDashboardValidatorRejectsInvalidYieldCurveComparisons,
    testChartPayloadMetadataContract,
    testSharedChartPayloadContractAcrossEncodings,
    testDashboardValidatorRejectsInvalidChartPayloadMetadata,
    testLocalMarketServerAutoRefreshWindow,
    testLocalMarketServerSkipsYieldCurveRefresh,
    testLocalMarketServerExplicitAndFallbackWindows,
    testLocalMarketServerPartialStatusIncludesRowErrors,
    testExpandedChartScrollsFullyIntoViewport,
    testLocalMarketServerOriginPolicyAndTlsOptions
  ];

  try {
    for (const test of architectureContractTests) {
      await runDashboardTest(test);
    }
    console.log('Architecture contract tests passed.');
    for (const test of tests) {
      await runDashboardTest(test);
    }
    console.log('Dashboard fixture tests passed.');
  } finally {
    cleanupTemporaryDirectories();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
