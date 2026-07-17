#!/usr/bin/env node

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isAllowedBrowserOrigin,
  parseArgs: parseLocalMarketServerArgs
} = require('./local_market_server');
const {
  acceptedFreshChartTickers,
  buildChartDataFallback,
  buildUnavailableFuturesPayload,
  compactChartPayload,
  parseArgs: parseFetchChartDataArgs,
  quoteRowFromSeries,
  roundChartPayload,
  runChart,
  runFutures,
  validateChartStagingPayload,
  validateFuturesPayload,
} = require('./fetch_chart_data');
const {
  buildAssetAllocationFallback,
  buildAssetAllocationSummaryFallback,
  fetchPortfolioRows,
  validateAssetAllocationPortfolioPayload,
  validateAssetAllocationSummaryPayload
} = require('./fetch_asset_allocation');
const { buildCryptoStatsFallback, fetchCryptoStatsPartial, validateCryptoStatsPayload } = require('./fetch_crypto_stats');
const {
  validateDashboardHtml
} = require('./validate_dashboard');
const {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  applyCryptoQuoteRows,
  applyCryptoStats,
  commitDashboardCandidate,
  earningsCalendarBuildDecision,
  earningsTargetRange,
  applyFuturesModule,
  applyTapeQuoteRows,
  loadDashboardBase,
  mergedChartAvailability,
  normalizePublicationDisplaySections,
  patchDashboard,
  patchDashboardDataBlock,
  readJsonBlock,
  readCurrentEarningsWeekArtifact,
  requiresUnavailableRolloverRetry,
  runCommand,
  runWithSectionFallback,
  stageDashboardCandidate,
  syncDashboardPricesFromChartData
} = require('./run_daily_update');
const { applyWeekAheadLifecycle, buildWeekAheadPreparationFallback, normalizeWeekAhead } = require('./week_ahead_contract');
const { validateEarningsWeekPayload } = require('./earnings_week_contract');
const { atomicWriteFile } = require('./staging_writer');
const { newsAcquisitionPaths } = require('./news_sources');
const {
  TAPE_COMMENTARY_UNAVAILABLE_NOTE,
  buildEditorialReview,
  editorialPayloadHash,
  reviewedTapeCommentary,
  superlativeClaims,
  unavailableTapeCommentary,
  validateTapeCommentaryDisposition,
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
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  const chartSeries = ['SPX', 'VCR', 'UST10Y'].map((ticker, index) => ({
    ticker,
    name: `Fixture ${ticker}`,
    section: 'tape',
    sourceSymbol: ticker,
    quoteRevision,
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
    generatedAt: quoteRevision,
    dashboardSource: 'scripts/test_dashboard.js',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: { tape: quotes, crypto: [] },
    series: chartSeries
  });
  const stories = Array.from({ length: 9 }, (_item, index) => story('market', index + 1));
  const cryptoNotes = Array.from({ length: 6 }, (_item, index) => story('crypto', index + 1));
  const futuresStories = Array.from({ length: 3 }, (_item, index) => ({
    ...story('futures', index + 1),
    tag: 'Futures',
    publishedAt: '2026-07-10T13:30:00Z'
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
        rows: quotes.map((quote) => reviewedTapeCommentary(
          { ...quote, group: quote.ticker === 'VCR' ? 'Sectors' : quote.ticker === 'UST10Y' ? 'Rates & Credit' : 'Equities' },
          quote.note,
          quoteRevision,
          '2026-07-10T12:30:00.000Z'
        ))
      },
      stories,
      crypto: {
        statsFetchedAt: FIXTURE_NOW,
        dominance: {},
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

function fixtureNewsSearch(dashboard) {
  const generalCandidates = [...dashboard.stories, ...dashboard.futuresModule.stories]
    .map(({ title, url, publishedOn, publishedAt }) => ({
      title,
      url,
      publishedOn,
      ...(publishedAt ? { publishedAt } : {})
    }));
  const cryptoCandidates = dashboard.crypto.notes
    .map(({ title, url, publishedOn }) => ({ title, url, publishedOn }));
  while (generalCandidates.length < 36) {
    const index = generalCandidates.length + 1;
    generalCandidates.push({
      title: `General candidate ${index}`,
      url: `https://candidate.test/general-${index}`,
      publishedOn: '2026-07-10'
    });
  }
  while (cryptoCandidates.length < 12) {
    const index = cryptoCandidates.length + 1;
    cryptoCandidates.push({
      title: `Crypto candidate ${index}`,
      url: `https://candidate.test/crypto-${index}`,
      publishedOn: '2026-07-10'
    });
  }
  return { generalCandidates, cryptoCandidates };
}

function writeFixtureNewsCandidates(dashboard, generatedAt = '2026-07-10T21:00:00.000Z') {
  const newsSearch = fixtureNewsSearch(dashboard);
  const outputPath = path.join(root, 'generated', 'news_candidates.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 2,
    generatedAt,
    finishedAt: generatedAt,
    eligibleDates: ['2026-07-09', '2026-07-10'],
    sourceCatalog: [],
    attempts: [],
    articleReview: { status: 'complete' },
    generalCandidates: newsSearch.generalCandidates,
    cryptoCandidates: newsSearch.cryptoCandidates
  }, null, 2)}\n`);
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
  const updaterSource = fs.readFileSync(path.join(scriptsDir, 'run_daily_update.js'), 'utf8');
  assert.equal((updaterSource.match(/\bcommitEditorialCandidate\(/g) || []).length, 2,
    'Only dashboard-data finalization may invoke the canonical editorial commit boundary.');
  assert.equal((updaterSource.match(/\bcommitDashboardCandidate\(/g) || []).length, 2,
    'Canonical replacement must remain behind the single editorial commit boundary.');

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

function testDeterministicSectionFallbackContracts() {
  const checkedAt = '2026-07-10T21:05:00.000Z';
  const { dashboard, chartData } = createDashboardValidationFixture();
  const acceptedWeekAhead = structuredClone(dashboard.weekAhead);
  const chartFallback = buildChartDataFallback(chartData, checkedAt);

  applyFuturesModule(dashboard, buildUnavailableFuturesPayload('session', checkedAt), 'afternoon');

  applyCryptoStats(dashboard, buildCryptoStatsFallback(dashboard.crypto, checkedAt));
  assert.equal(dashboard.crypto.availability.status, 'carried_forward');
  assert.ok(dashboard.crypto.stats.every((row) => row.availability?.status === 'carried_forward'));
  assert.ok(dashboard.crypto.stats.every((row) => row.availability?.lastValidatedAt === FIXTURE_NOW));

  const assetFallback = buildAssetAllocationFallback(dashboard.assetAllocationPortfolio, {
    month: '2026-08',
    asOf: '2026-08-03',
    checkedAt
  });
  applyAssetAllocationPortfolio(dashboard, assetFallback);
  assert.equal(dashboard.assetAllocationPortfolio.availability.status, 'unavailable');
  assert.deepEqual(dashboard.assetAllocationPortfolio.rows, []);

  const weekFallback = buildWeekAheadPreparationFallback(dashboard.weekAhead, {
    from: '2026-07-17',
    to: '2026-07-23'
  }, { checkedAt });
  dashboard.weekAhead = weekFallback.week;
  assert.equal(weekFallback.mode, 'unavailable');
  assert.equal(requiresUnavailableRolloverRetry(weekFallback.week), true);
  assert.deepEqual(dashboard.weekAhead.days.map((day) => day.date), [
    '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'
  ]);
  dashboard.weekAhead = buildWeekAheadPreparationFallback(null, {
    from: '2026-07-10',
    to: '2026-07-16'
  }, { checkedAt }).week;

  const result = validateDashboardAndChartFixture(dashboard, compactChartPayload(chartFallback));
  assert.equal(result.status, 0, result.stderr);

  dashboard.weekAhead = acceptedWeekAhead;
  assert.equal(dashboard.weekAhead.availability, undefined, 'A later successful Week Ahead refresh must clear the fallback state.');
  const recoveredResult = validateDashboardAndChartFixture(dashboard, compactChartPayload(chartFallback));
  assert.equal(recoveredResult.status, 0, recoveredResult.stderr);

  const invalidArtifact = runWithSectionFallback(
    () => undefined,
    () => ({ status: 'carried_forward' }),
    {
      label: 'Fixture',
      readFresh: () => ({ malformed: true }),
      validateFresh: () => ['fixture artifact is invalid'],
      validateFallback: () => []
    }
  );
  assert.match(invalidArtifact.error.message, /fixture artifact is invalid/);
  assert.equal(invalidArtifact.payload.status, 'carried_forward');
}

function testSectionCommandTimeoutFallsOpen() {
  const result = runWithSectionFallback(
    () => runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }),
    () => ({ status: 'carried_forward' }),
    {
      label: 'Fixture command',
      validateFallback: () => []
    }
  );
  assert.match(result.error.message, /Command timed out after 100ms/);
  assert.deepEqual(result.payload, { status: 'carried_forward' });
}

function testEarningsRefreshFailureKeepsFreshBuildArtifact() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-earnings-recovery-');
  const output = path.join(dir, 'earnings_week.json');
  const checkedAt = new Date('2026-07-10T21:05:00.000Z');
  const range = { from: '2026-07-10', to: '2026-07-16' };
  const freshWeek = {
    ...fixtureEarningsWeek(),
    generatedAt: checkedAt.toISOString(),
    range
  };
  fs.writeFileSync(output, `${JSON.stringify(freshWeek, null, 2)}\n`);

  const result = runWithSectionFallback(
    () => { throw new Error('fixture refresh failure after build'); },
    () => ({ mode: 'carried_forward', week: { ...fixtureEarningsWeek(), generatedAt: '2026-07-09T21:05:00.000Z' } }),
    {
      label: 'Earnings',
      readFreshOnError: () => readCurrentEarningsWeekArtifact(range, checkedAt, output),
      validateFresh: validateEarningsWeekPayload,
      validateFallback: (payload) => validateEarningsWeekPayload(payload.week)
    }
  );

  assert.equal(result.recovered, true);
  assert.equal(result.fallback, null);
  assert.deepEqual(result.payload, freshWeek);
}

function testEarningsCalendarBuildAuthorization() {
  const canonicalWeek = { range: { from: '2026-07-13', to: '2026-07-17' }, rows: [] };
  const rolloverRange = { from: '2026-07-17', to: '2026-07-23' };
  assert.deepEqual(
    earningsTargetRange({ scheduled: false, rebuildEarningsCalendar: false, calendarRolloverRange: rolloverRange }, canonicalWeek),
    canonicalWeek.range,
    'An ordinary manual Friday-afternoon run must not infer calendar-build authority from its edition.'
  );
  assert.deepEqual(
    earningsTargetRange({ scheduled: true, rebuildEarningsCalendar: false, calendarRolloverRange: rolloverRange }, canonicalWeek),
    rolloverRange
  );
  assert.deepEqual(
    earningsTargetRange({ scheduled: false, rebuildEarningsCalendar: true, calendarRolloverRange: rolloverRange }, canonicalWeek),
    rolloverRange
  );
  const decision = (args, overrides = {}) => earningsCalendarBuildDecision({
    scheduled: false,
    rebuildEarningsCalendar: false,
    calendarRolloverRange: null,
    ...args
  }, {
    canonicalWeek,
    invalidPersistedArtifact: false,
    calendarNeedsBuild: true,
    failedAttemptNeedsRetry: false,
    ...overrides
  });

  assert.deepEqual(decision({}), { build: false, blocked: true, reason: 'manual_build_not_authorized' });
  assert.deepEqual(decision({ rebuildEarningsCalendar: true }), { build: true, blocked: false, reason: 'explicit_manual_rebuild' });
  assert.deepEqual(decision({ scheduled: true, calendarRolloverRange: canonicalWeek.range }), { build: true, blocked: false, reason: 'scheduled_rollover' });
  assert.deepEqual(decision({ scheduled: true }, { failedAttemptNeedsRetry: true }), { build: true, blocked: false, reason: 'scheduled_failed_attempt_retry' });
  assert.deepEqual(
    decision({ scheduled: true }, { invalidPersistedArtifact: true, calendarNeedsBuild: false }),
    { build: false, blocked: true, reason: 'scheduled_build_not_authorized' },
    'Malformed staging alone must not authorize a metered calendar scan outside rollover or audited retry paths.'
  );
  assert.deepEqual(
    decision({ scheduled: true }, { canonicalWeek: { ...canonicalWeek, availability: { status: 'unavailable' } } }),
    { build: true, blocked: false, reason: 'scheduled_unavailable_retry' }
  );
}

function testPartialDeterministicRowsValidate() {
  const checkedAt = '2026-07-10T21:05:00.000Z';
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.futuresModule.availability = {
    status: 'partial', reason: 'source_refresh_failed', checkedAt,
    failures: [{ symbol: 'ES=F', message: 'fixture failure' }]
  };
  dashboard.futuresModule.futures[0] = {
    symbol: 'ES=F', label: 'S&P Futures', value: 'Unavailable',
    body: 'Current contract data is unavailable; retrying on the next update.',
    dir: 'flat', series: [], raw: {},
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt, message: 'fixture failure' }
  };
  dashboard.crypto.availability = {
    status: 'partial', reason: 'source_refresh_failed', checkedAt,
    failures: [{ provider: 'fearGreed', message: 'fixture failure' }]
  };
  const fearGreed = dashboard.crypto.stats.find((row) => row.sym === 'F&G');
  Object.assign(fearGreed, {
    sub: 'Unavailable', price: 'Unavailable', delta: 'Unavailable', chg: '', dir: 'flat',
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt, message: 'fixture failure' }
  });
  dashboard.assetAllocationPortfolio.availability = {
    status: 'partial', reason: 'source_refresh_failed', checkedAt,
    failures: [{ ticker: 'VTI', message: 'fixture failure' }]
  };
  const vti = dashboard.assetAllocationPortfolio.rows.find((row) => row.ticker === 'VTI');
  for (const key of ['price', 'monthDivPerShare', 'dailyPriceChange', 'dailyTR', 'mtdPriceChange', 'mtdTR']) vti[key] = 'Unavailable';
  vti.availability = { status: 'unavailable', reason: 'source_refresh_failed', checkedAt };
  const partialChart = compactChartPayload({
    ...chartData,
    generatedAt: checkedAt,
    availability: {
      status: 'partial', reason: 'source_refresh_failed', checkedAt,
      failures: [{ ticker: 'SPX', message: 'fixture failure' }]
    },
    series: chartData.series.map((series) => series.ticker === 'SPX'
      ? { ...series, availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt } }
      : series)
  });
  const result = validateDashboardAndChartFixture(dashboard, partialChart);
  assert.equal(result.status, 0, result.stderr);
}

function testLastGoodDashboardRecovery() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-last-good-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const lastGoodFile = path.join(dir, 'dashboard.last-good.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const lastGoodHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, '<script type="application/json" id="dashboard-data">{broken}</script>');
  fs.writeFileSync(lastGoodFile, lastGoodHtml);
  const recovered = loadDashboardBase(dashboardFile, { lastGoodPath: lastGoodFile, allowRecovery: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.sourcePath, lastGoodFile);
  assert.equal(readJsonBlock(recovered.html, 'dashboard-data').editionId, dashboard.editionId);
  const nextHtml = recovered.html.replace('Fixture headline', 'Recovered fixture headline');
  const previousValidateNow = process.env.VALIDATE_NOW_ISO;
  process.env.VALIDATE_NOW_ISO = FIXTURE_NOW;
  try {
    commitDashboardCandidate({ dashboard: dashboardFile }, nextHtml, {
      refreshLastGood: true,
      lastGoodPath: lastGoodFile
    });
  } finally {
    if (previousValidateNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = previousValidateNow;
  }
  assert.equal(readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data').opening.headline, 'Recovered fixture headline');
  assert.equal(fs.readFileSync(lastGoodFile, 'utf8'), nextHtml, 'The next successful replacement must refresh the recovery snapshot.');

  fs.writeFileSync(dashboardFile, '<script type="application/json" id="dashboard-data">{broken}</script>');
  fs.writeFileSync(lastGoodFile, '<script type="application/json" id="dashboard-data">{also-broken}</script>');
  const malformedBytes = fs.readFileSync(dashboardFile, 'utf8');
  assert.throws(
    () => loadDashboardBase(dashboardFile, { lastGoodPath: lastGoodFile, allowRecovery: true }),
    /Canonical dashboard and last-good snapshot are both unusable/
  );
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), malformedBytes);
}

function testAtomicCommitKeepsValidatedDashboardWhenSnapshotRefreshFails() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-atomic-apply-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);

  const committedHtml = originalHtml.replace('Fixture headline', 'Committed despite snapshot failure');
  const snapshotFile = path.join(dir, 'dashboard.last-good.html');
  const previousValidateNow = process.env.VALIDATE_NOW_ISO;
  process.env.VALIDATE_NOW_ISO = FIXTURE_NOW;
  try {
    assert.doesNotThrow(() => commitDashboardCandidate(
      { dashboard: dashboardFile },
      committedHtml,
      {
        refreshLastGood: true,
        lastGoodPath: snapshotFile,
        snapshotWriter: () => { throw new Error('fixture synchronization failure'); }
      }
    ));
  } finally {
    if (previousValidateNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = previousValidateNow;
  }
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), committedHtml, 'Post-commit synchronization failure must not roll back the validated dashboard.');
  assert.equal(fs.existsSync(snapshotFile), false);

  process.env.VALIDATE_NOW_ISO = FIXTURE_NOW;
  try {
    commitDashboardCandidate(
      { dashboard: dashboardFile },
      committedHtml,
      { refreshLastGood: true, lastGoodPath: snapshotFile }
    );
  } finally {
    if (previousValidateNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = previousValidateNow;
  }
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), committedHtml, 'A synchronization retry must preserve the committed dashboard.');
  assert.equal(fs.readFileSync(snapshotFile, 'utf8'), committedHtml, 'The next successful run must complete the deferred snapshot synchronization.');

  const stagingFile = path.join(dir, 'staging.json');
  fs.writeFileSync(stagingFile, 'validated prior staging');
  assert.throws(() => atomicWriteFile(stagingFile, 'partial replacement', {}, {
    fs: {
      ...fs,
      renameSync: () => { throw new Error('fixture rename interruption'); }
    }
  }), /fixture rename interruption/);
  assert.equal(fs.readFileSync(stagingFile, 'utf8'), 'validated prior staging');
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.staging.json.')), false, 'Interrupted staging writes must remove temporary files.');

  for (const name of ['daily_financial_news.html', 'index.html']) {
    const publishedFile = path.join(dir, name);
    fs.writeFileSync(publishedFile, 'published fixture');
    assert.throws(
      () => atomicWriteFile(publishedFile, 'unauthorized replacement', {}, { projectRoot: dir }),
      /staging_writer cannot write protected published artifact/
    );
    assert.equal(fs.readFileSync(publishedFile, 'utf8'), 'published fixture');
  }
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

async function testUpdaterQuoteAndCryptoPatches() {
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

  applyCryptoStats(data, { stats: [{
    sym: 'FNG',
    value: '53',
    delta: '+2'
  }, {
    sym: 'ALT',
    value: '53',
    delta: '+2'
  }] });

  assert.deepEqual(data.crypto.stats.map((row) => row.sym), ['FNG', 'ALT']);

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-crypto-partial-');
  const input = path.join(dir, 'dashboard.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalInput = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(input, originalInput);
  const partial = await fetchCryptoStatsPartial({ input, timeoutMs: 1000, lookbackDays: 31 }, {
    now: new Date('2026-07-10T21:05:00.000Z'),
    collectProvider: async (task) => {
      if (task.key === 'altcoinSeason') throw new Error('fixture provider failure');
      return {
        source: 'Fixture provider',
        stat: task.key === 'fearGreed'
          ? { sym: 'F&G', name: task.name, price: '55', delta: '+5', chg: 'Greed', dir: 'up' }
          : { sym: 'TOTAL', name: task.name, price: '$2.00T', delta: '+$0.10T', chg: '+5.00%', dir: 'up' }
      };
    }
  });
  assert.equal(partial.availability.status, 'partial');
  assert.deepEqual(partial.availability.failures, [{ provider: 'altcoinSeason', message: 'fixture provider failure' }]);
  assert.equal(partial.stats.find((row) => row.sym === 'F&G').price, '55');
  assert.equal(partial.stats.find((row) => row.sym === 'TOTAL').price, '$2.00T');
  assert.equal(partial.stats.find((row) => row.sym === 'ALTSEASON').availability.status, 'carried_forward');
  assert.equal(partial.stats.find((row) => row.sym === 'ALTSEASON').availability.lastValidatedAt, FIXTURE_NOW);
  assert.deepEqual(validateCryptoStatsPayload(partial), []);
  applyCryptoStats(dashboard, partial);
  assert.equal(dashboard.crypto.statsFetchedAt, '2026-07-10T21:05:00.000Z');
  assert.equal(validateDashboardAndChartFixture(dashboard, chartData).status, 0);
  assert.equal(fs.readFileSync(input, 'utf8'), originalInput);

  const recovered = await fetchCryptoStatsPartial({ input, timeoutMs: 1000, lookbackDays: 31 }, {
    now: new Date('2026-07-10T21:10:00.000Z'),
    collectProvider: async (task) => ({
      source: 'Fixture provider',
      stat: task.key === 'fearGreed'
        ? { sym: 'F&G', name: task.name, price: '56', delta: '+1', chg: 'Greed', dir: 'up' }
        : task.key === 'altcoinSeason'
          ? { sym: 'ALTSEASON', name: task.name, sub: 'Bitcoin Season', price: '30', delta: '+5', chg: '/100', dir: 'up' }
          : { sym: 'TOTAL', name: task.name, price: '$2.10T', delta: '+$0.10T', chg: '+5.00%', dir: 'up' }
    })
  });
  assert.equal(recovered.availability, undefined);
  assert.ok(recovered.stats.every((row) => row.availability === undefined));
  assert.deepEqual(validateCryptoStatsPayload(recovered), []);
}

async function testUpdaterModulePatches() {
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

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-asset-partial-');
  const input = path.join(dir, 'dashboard.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.assetAllocationPortfolio.compiledAt = '2026-07-10T20:55:00.000Z';
  dashboard.assetAllocationPortfolio.month = '2026-07';
  const originalInput = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(input, originalInput);
  const rows = fixturePortfolioRows();
  const partial = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-07-10T21:05:00.000Z'),
    fetchHolding: async (holding) => {
      if (holding.symbol === 'VTI') throw new Error('fixture holding failure');
      return structuredClone(rows.find((row) => row.ticker === holding.symbol));
    }
  });
  assert.equal(partial.availability.status, 'partial');
  assert.deepEqual(partial.availability.failures, [{ ticker: 'VTI', message: 'fixture holding failure' }]);
  assert.equal(partial.rows.find((row) => row.ticker === 'VTI').availability.status, 'carried_forward');
  assert.equal(partial.rows.find((row) => row.ticker === 'VTI').availability.lastValidatedAt, '2026-07-10T20:55:00.000Z');
  assert.deepEqual(partial.rows.find((row) => row.ticker === 'VEA'), rows.find((row) => row.ticker === 'VEA'));
  assert.deepEqual(validateAssetAllocationPortfolioPayload(partial), []);
  applyAssetAllocationPortfolio(dashboard, partial);
  assert.equal(validateDashboardAndChartFixture(dashboard, chartData).status, 0);
  assert.equal(fs.readFileSync(input, 'utf8'), originalInput);
  const acceptedRows = structuredClone(dashboard.assetAllocationPortfolio.rows);
  const summaryFailure = runWithSectionFallback(
    () => { throw new Error('fixture summary failure'); },
    () => buildAssetAllocationSummaryFallback(dashboard.assetAllocationPortfolio, { asOf: '2026-07-10' }),
    { validateFallback: validateAssetAllocationSummaryPayload }
  );
  applyAssetAllocationSummary(dashboard, summaryFailure.payload);
  assert.deepEqual(dashboard.assetAllocationPortfolio.rows, acceptedRows, 'A summary failure must not discard accepted holding rows.');
  assert.equal(dashboard.assetAllocationPortfolio.portfolioMtdReturnStatus, 'unavailable');
  assert.equal(validateDashboardAndChartFixture(dashboard, chartData).status, 0);

  const recovered = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-07-10T21:10:00.000Z'),
    fetchHolding: async (holding) => structuredClone(rows.find((row) => row.ticker === holding.symbol))
  });
  assert.equal(recovered.availability, undefined);
  assert.ok(recovered.rows.every((row) => row.availability === undefined));
  assert.deepEqual(validateAssetAllocationPortfolioPayload(recovered), []);
  applyAssetAllocationPortfolio(dashboard, recovered);
  applyAssetAllocationSummary(dashboard, {
    asOf: '2026-07-10',
    portfolioMtdReturnValue: 1.23,
    status: 'available',
    stale: false
  });
  assert.equal(dashboard.assetAllocationPortfolio.portfolioMtdReturnStatus, 'available');
  assert.equal(dashboard.assetAllocationPortfolio.portfolioMtdReturnStale, false);
  assert.equal(validateDashboardAndChartFixture(dashboard, chartData).status, 0);
}

async function testFuturesStagingPayloadContract() {
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

  const fallbackDashboard = dashboardFixture();
  applyFuturesModule(fallbackDashboard, shortRoster, 'afternoon');
  assert.equal(fallbackDashboard.futuresModule.availability.status, 'unavailable');
  assert.deepEqual(fallbackDashboard.futuresModule.futures, []);

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-futures-partial-');
  const output = path.join(dir, 'futures.json');
  const rows = fixtureFutures();
  await runFutures(['--session', '--output', output], {
    now: new Date('2026-07-10T21:05:00.000Z'),
    fetchFuture: async (spec) => {
      if (spec.symbol === 'NQ=F') throw new Error('fixture contract failure');
      return structuredClone(rows.find((row) => row.symbol === spec.symbol));
    }
  });
  const partial = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(partial.availability.status, 'partial');
  assert.deepEqual(partial.availability.failures, [{ symbol: 'NQ=F', message: 'fixture contract failure' }]);
  assert.deepEqual(partial.futures.filter((row) => row.symbol !== 'NQ=F'), rows.filter((row) => row.symbol !== 'NQ=F'));
  assert.equal(partial.futures.find((row) => row.symbol === 'NQ=F').value, 'Unavailable');
  assert.deepEqual(validateFuturesPayload(partial, { expectedMode: 'session' }), []);
  const { dashboard: partialDashboard, chartData: partialChartData } = createDashboardValidationFixture();
  applyFuturesModule(partialDashboard, partial, 'afternoon');
  assert.equal(validateDashboardAndChartFixture(partialDashboard, partialChartData).status, 0);

  await runFutures(['--session', '--output', output], {
    now: new Date('2026-07-10T21:10:00.000Z'),
    fetchFuture: async (spec) => structuredClone(rows.find((row) => row.symbol === spec.symbol))
  });
  const recovered = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(recovered.availability, undefined);
  assert.deepEqual(recovered.futures, rows);
  assert.deepEqual(validateFuturesPayload(recovered, { expectedMode: 'session' }), []);
}

function testPublicationDisplaySectionNormalization() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.stories = 'bad';
  dashboard.futuresModule.futures = [];
  dashboard.futuresModule.stories = 'bad';
  dashboard.crypto.stats = 'bad';
  dashboard.crypto.notes = 'bad';
  dashboard.crypto.dominance = null;
  dashboard.assetAllocationPortfolio.rows = 'bad';

  normalizePublicationDisplaySections(dashboard, {
    windowMode: 'afternoon',
    now: new Date(FIXTURE_NOW)
  });

  assert.deepEqual(dashboard.stories, []);
  assert.deepEqual(dashboard.futuresModule.futures, []);
  assert.deepEqual(dashboard.futuresModule.stories, []);
  assert.equal(dashboard.futuresModule.availability.status, 'unavailable');
  assert.deepEqual(dashboard.crypto.stats, []);
  assert.deepEqual(dashboard.crypto.notes, []);
  assert.deepEqual(dashboard.crypto.dominance, {});
  assert.equal(dashboard.crypto.availability.status, 'unavailable');
  assert.deepEqual(dashboard.assetAllocationPortfolio.rows, []);
  assert.equal(dashboard.assetAllocationPortfolio.availability.status, 'unavailable');
  assert.equal(dashboard.storiesCoverage.status, 'partial');
  assert.equal(dashboard.futuresModule.storiesCoverage.status, 'partial');
  assert.equal(dashboard.crypto.notesCoverage.status, 'partial');

  const result = validateDashboardHtml(renderDashboardValidationFixture(dashboard, chartData), {
    now: new Date(FIXTURE_NOW)
  });
  assert.deepEqual(result.errors, []);
}

function testEarningsCommentaryPublicationNormalization() {
  const data = {
    earnings: {
      week: {
        rows: [{
          symbol: 'BAD',
          company: 'Bad Fixture Inc',
          reportDate: '2026-07-10',
          eps: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', basis: 'gaap', note: '' },
          revenue: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', note: '' },
          outcome: {
            overall: 'beat',
            interpretation: '',
            interpretationDisposition: { status: 'verified' },
            guide: 'Unsupported guidance line should not render.',
            guidanceDisposition: {
              status: 'unverified',
              reason: 'fixture_unverified_guidance',
              attemptedAt: FIXTURE_NOW
            }
          },
          reaction: { status: 'computed', percent: 1, note: '' },
          sourceAudit: {
            scheduleVerification: { status: 'primary_only' },
            companyReleaseResolution: { status: 'needs_review' }
          }
        }, {
          symbol: 'DROP',
          reportDate: '2026-07-10',
          outcome: {}
        }]
      }
    }
  };

  const html = '<script type="application/json" id="dashboard-data">{}</script>';
  const centrallyPublished = readJsonBlock(patchDashboardDataBlock(html, data, null, null, { stampEdition: false }), 'dashboard-data');
  assert.equal(centrallyPublished.earnings.week.rows.length, 1);
  assert.equal(centrallyPublished.earnings.week.rows[0].symbol, 'BAD');

  normalizePublicationDisplaySections(data, {
    windowMode: 'afternoon',
    now: new Date(FIXTURE_NOW)
  });

  assert.equal(data.earnings.week.rows.length, 1);
  const row = data.earnings.week.rows[0];
  const outcome = row.outcome;
  assert.equal(row.scheduleVerificationStatus, 'primary_only');
  assert.equal(row.companyReleaseStatus, 'needs_review');
  assert.equal(outcome.interpretation, '');
  assert.equal(outcome.guide, '');
  assert.equal(outcome.interpretationDisposition, undefined);
  assert.equal(outcome.guidanceDisposition, undefined);

  const published = readJsonBlock(patchDashboardDataBlock(html, data, null, null, { stampEdition: false }), 'dashboard-data');
  assert.equal(published.earnings.week.rows[0].sourceAudit, undefined);
  assert.equal(published.earnings.week.rows[0].scheduleVerificationStatus, 'primary_only');
  assert.equal(published.earnings.week.rows[0].companyReleaseStatus, 'needs_review');
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
  assert.doesNotMatch(staleErrors, /unverified superlative claim/);
  assert.match(staleErrors, /payloadHash does not match/);
  assert.deepEqual(validateReviewManifest({
    ...manifest,
    verifiedClaims: [{ text: data.opening.headline, evidenceUrl: 'https://example.com/verified-claim' }]
  }, data), []);
  assert.match(validateReviewManifest({
    ...manifest,
    verifiedClaims: [{ text: 'An obsolete record claim.', evidenceUrl: 'https://example.com/obsolete-claim' }]
  }, data).join('\n'), /does not match current editorial text/);
  const fallbackData = structuredClone(data);
  fallbackData.opening.headline = 'Markets test the outlook';
  const fallbackManifest = {
    ...manifest,
    systemFallbacks: [{
      section: 'opening',
      path: 'opening.headline',
      action: 'retained_candidate',
      reason: 'editorial_content_unavailable'
    }]
  };
  assert.deepEqual(validateReviewManifest(fallbackManifest, fallbackData), []);
  buildEditorialReview(fallbackData, fallbackManifest, reviewChartData);
  assert.deepEqual(fallbackData.editorialReview.systemFallbacks, fallbackManifest.systemFallbacks);
  assert.deepEqual(validateReviewManifest(fallbackData.editorialReview, fallbackData, { requireEmbedded: true, chartData: reviewChartData }), []);
  assert.match(validateReviewManifest({ ...manifest, systemFallbacks: [{ section: 'opening', path: '', action: 'reviewed', reason: '' }] }, data).join('\n'), /path must be populated[\s\S]*action is invalid[\s\S]*reason must be populated/);
}

function testArchitecturePreparationLeavesCanonicalUnchanged() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-deterministic-stage-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);
  const args = {
    dashboard: dashboardFile,
    candidate: candidateFile,
    windowMode: 'afternoon',
    baseDashboardHtml: originalHtml,
    chartDataPayload: chartData,
    futuresPayload: {
      compiledAt: '2026-07-10T21:05:00.000Z',
      source: 'Fixture Futures',
      mode: 'session',
      futures: dashboard.futuresModule.futures
    },
    cryptoStatsPayload: {
      fetchedAt: '2026-07-10T21:05:00.000Z',
      stats: dashboard.crypto.stats
    },
    assetAllocationPortfolioPayload: {
      compiledAt: '2026-07-10T21:05:00.000Z',
      source: 'Fixture portfolio',
      month: '2026-07',
      rows: dashboard.assetAllocationPortfolio.rows
    },
    assetAllocationSummaryPayload: {
      asOf: dashboard.assetAllocationPortfolio.portfolioMtdReturnAsOf,
      portfolioMtdReturnValue: dashboard.assetAllocationPortfolio.portfolioMtdReturnValue,
      status: dashboard.assetAllocationPortfolio.portfolioMtdReturnStatus,
      stale: dashboard.assetAllocationPortfolio.portfolioMtdReturnStale
    },
    weekAheadPayload: dashboard.weekAhead,
    earningsWeekPayload: dashboard.earnings.week
  };
  const previousScheduledNow = process.env.SCHEDULED_NOW_ISO;
  const previousValidateNow = process.env.VALIDATE_NOW_ISO;
  process.env.SCHEDULED_NOW_ISO = '2026-07-10T21:05:00.000Z';
  process.env.VALIDATE_NOW_ISO = FIXTURE_NOW;
  let preparedHtml;
  try {
    preparedHtml = patchDashboard(args);
    stageDashboardCandidate(args, preparedHtml);
  } finally {
    if (previousScheduledNow === undefined) delete process.env.SCHEDULED_NOW_ISO;
    else process.env.SCHEDULED_NOW_ISO = previousScheduledNow;
    if (previousValidateNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = previousValidateNow;
  }

  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'Deterministic preparation must not alter the canonical dashboard.');
  assert.equal(fs.existsSync(candidateFile), true);
  const canonicalData = readJsonBlock(originalHtml, 'dashboard-data');
  const candidateData = readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'dashboard-data');
  assert.equal(candidateData.editionId, canonicalData.editionId, 'The staged candidate must retain the canonical base edition binding.');
  assert.equal(candidateData.editorialReview, undefined);
  assert.equal(candidateData.crypto.availability, undefined);

  const retainedCandidateFile = path.join(dir, 'retained-dashboard-candidate.html');
  const retainedCandidate = fs.readFileSync(candidateFile, 'utf8');
  fs.writeFileSync(retainedCandidateFile, retainedCandidate);
  process.env.VALIDATE_NOW_ISO = FIXTURE_NOW;
  try {
    const brokenJsonHtml = preparedHtml.replace(
      '<script type="application/json" id="dashboard-data">',
      '<script type="application/json" id="dashboard-data">broken'
    );
    assert.throws(
      () => stageDashboardCandidate({ ...args, candidate: retainedCandidateFile }, brokenJsonHtml),
      /Deterministic candidate failed validation/
    );
  } finally {
    if (previousValidateNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = previousValidateNow;
  }
  assert.equal(fs.readFileSync(retainedCandidateFile, 'utf8'), retainedCandidate, 'Failed preparation must preserve the prior candidate byte-for-byte.');
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
}

function testPreparationStatusCannotEndIntermediate() {
  const result = spawnSync(process.execPath, [
    '-e',
    "require('./scripts/run_daily_update').reportPreparationStatus('preparing');"
  ], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Preparation status: preparing/);
  assert.match(result.stdout, /Preparation status: failed .*preparation ended without terminal status/);
}

function testScheduledPreparationRefusalSkipsCleanly() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-scheduled-skip-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  fs.writeFileSync(dashboardFile, renderDashboardValidationFixture(dashboard, chartData));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--scheduled',
    '--afternoon'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-10T13:00:00.000Z'
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Preparation status: skipped .*outside its America\/Chicago update window/);
  assert.equal(fs.existsSync(candidateFile), false);
}

function testEditorialPreparationCreatesOnePendingHandoff() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-editorial-handoff-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const editorialDir = path.join(dir, 'editorial');
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.tape.rows[0] = unavailableTapeCommentary(
    dashboard.tape.rows[0],
    dashboard.tape.rows[0].noteDisposition.quoteRevision
  );
  dashboard.tape.rows[1] = unavailableTapeCommentary(
    dashboard.tape.rows[1],
    dashboard.tape.rows[1].noteDisposition.quoteRevision
  );
  dashboard.stories = dashboard.stories.slice(0, 8);
  const candidateDashboard = structuredClone(dashboard);
  const candidateChartData = roundChartPayload(chartData);
  candidateChartData.series.find((series) => series.ticker === 'SPX').quoteRevision = FIXTURE_NOW;
  syncDashboardPricesFromChartData(candidateDashboard, candidateChartData, {
    resetCommentary: true,
    commentaryTickers: ['SPX']
  });
  const html = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, html);
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(candidateDashboard, candidateChartData));
  fs.mkdirSync(editorialDir, { recursive: true });
  fs.writeFileSync(path.join(editorialDir, 'editorial-review.json'), '{}');
  fs.writeFileSync(path.join(editorialDir, 'earnings_narrative.json'), '{}');

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--prepare-editorial-dir', editorialDir,
    '--afternoon'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DASHBOARD_TEST_NO_NETWORK: '1',
      SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(editorialDir), ['dashboard-data.json']);
  const handoff = JSON.parse(fs.readFileSync(path.join(editorialDir, 'dashboard-data.json'), 'utf8'));
  assert.equal(handoff.tape.rows[0].noteDisposition.status, 'pending_review');
  assert.deepEqual(handoff.tape.rows[1], dashboard.tape.rows[1], 'An unchanged carried quote must retain its complete commentary bundle in the handoff.');
  assert.equal(handoff.storiesCoverage, undefined);
  assert.equal(handoff.futuresModule.storiesCoverage, undefined);
  assert.equal(handoff.crypto.notesCoverage, undefined);
  assert.equal(
    handoff.editorialReview.newsSearch.generalCandidates.length,
    dashboard.stories.length + dashboard.futuresModule.stories.length,
    'Fresh prior general and Futures cards must remain available when all downloads fail.'
  );
  assert.equal(
    handoff.editorialReview.newsSearch.cryptoCandidates.length,
    dashboard.crypto.notes.length,
    'Fresh prior Crypto cards must remain available when all downloads fail.'
  );
  assert.ok(handoff.editorialReview.newsSearch.generalCandidates.every((candidate) => candidate.priorCard));
  assert.ok(handoff.editorialReview.newsSearch.cryptoCandidates.every((candidate) => candidate.priorCard));
  assert.equal(handoff.editorialReview.newsSearch.attempts.length, newsAcquisitionPaths().length);
  assert.ok(handoff.editorialReview.newsSearch.attempts.every((attempt) => /Network disabled/.test(attempt.error)));
  assert.ok(!Number.isNaN(Date.parse(handoff.editorialReview.newsSearch.finishedAt)));
  assert.ok(handoff.editorialReview);
  assert.equal(handoff.editorialReview.preparedAt, '2026-07-10T21:01:00.000Z');
  assert.equal(handoff.editorialReview.openingDecision.action, null);
  assert.ok(handoff.editorialReview.marketLensDecisions.every((decision) => decision.action === null));
}

function testMalformedFocusedEarningsIsNoOp() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-earnings-repair-noop-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'earnings-week.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, '{');

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-earnings-week-json', payloadFile
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, SCHEDULED_NOW_ISO: FIXTURE_NOW } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preparation status: skipped .*candidate and canonical dashboard unchanged/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.equal(fs.readFileSync(candidateFile, 'utf8'), originalHtml);
}

function testReleasedEventRetainGeneratedBecomesUnavailableLens() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-released-event-editorial-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const released = structuredClone(dashboard.weekAhead);
  const eventDay = released.days.find((day) => day.events.length);
  eventDay.events[0].actual = eventDay.events[0].forecast || '1.0%';
  dashboard.weekAhead = applyWeekAheadLifecycle(released, null, { now: new Date('2026-07-13T22:00:00.000Z') });
  const html = renderDashboardValidationFixture(dashboard, chartData);
  const editorial = structuredClone(dashboard);
  editorial.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearch(dashboard),
    openingDecision: { action: 'reviewed' },
    marketLensDecisions: dashboard.weekAhead.days
      .filter((day) => day.events.length)
      .map((day) => ({ date: day.date, action: 'retain-generated' }))
  };
  fs.writeFileSync(dashboardFile, html);
  fs.writeFileSync(candidateFile, html);
  fs.writeFileSync(payloadFile, JSON.stringify(editorial));
  writeFixtureNewsCandidates(dashboard);
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile,
    '--afternoon'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-13T22:01:00.000Z',
      VALIDATE_NOW_ISO: '2026-07-13T22:01:00.000Z'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const finalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  const finalizedDay = finalized.weekAhead.days.find((day) => day.events.length);
  assert.equal(finalizedDay.marketLensSource, 'unavailable');
  assert.equal(finalizedDay.marketLensDisposition.status, 'commentary_unavailable');
  assert.equal(finalized.editorialReview.marketLensDecisions[0].action, 'commentary-unavailable');
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

function testQuoteRefreshInvalidatesTapeCommentaryWithoutBlocking() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const acceptedChartData = roundChartPayload(chartData);
  const oldNotes = dashboard.tape.rows.map((row) => row.note);
  const systemFallbacks = [];
  acceptedChartData.generatedAt = '2026-07-10T13:00:00.000Z';
  for (const series of acceptedChartData.series) {
    if (series.ticker !== 'VCR') series.quoteRevision = acceptedChartData.generatedAt;
  }
  acceptedChartData.availability = {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt: acceptedChartData.generatedAt,
    failures: [{ ticker: 'VCR', message: 'fixture source failure' }]
  };
  acceptedChartData.series.find((series) => series.ticker === 'VCR').availability = {
    status: 'carried_forward',
    reason: 'source_refresh_failed',
    checkedAt: acceptedChartData.generatedAt
  };
  const freshTickers = acceptedFreshChartTickers(acceptedChartData);
  assert.deepEqual(acceptedFreshChartTickers({ ...acceptedChartData, availability: { status: 'carried_forward' } }), []);

  const result = syncDashboardPricesFromChartData(dashboard, acceptedChartData, {
    resetCommentary: true,
    commentaryTickers: freshTickers,
    systemFallbacks
  });

  assert.deepEqual(freshTickers, ['SPX', 'UST10Y']);
  assert.equal(result.commentaryResetCount, dashboard.tape.rows.length - 1);
  assert.equal(systemFallbacks.length, dashboard.tape.rows.length - 1);
  assert.ok(systemFallbacks.every((item) => item.action === 'unavailable_disposition'));
  assert.ok(dashboard.tape.rows.filter((row) => row.ticker !== 'VCR').every((row) => row.note === TAPE_COMMENTARY_UNAVAILABLE_NOTE));
  assert.ok(dashboard.tape.rows.filter((row) => row.ticker !== 'VCR').every((row) => row.noteDisposition.status === 'commentary_unavailable'));
  assert.ok(dashboard.tape.rows.filter((row) => row.ticker !== 'VCR').every((row) => row.noteDisposition.quoteRevision === acceptedChartData.generatedAt));
  assert.ok(dashboard.tape.rows.every((row) => validateTapeCommentaryDisposition(row).length === 0));
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'VCR').note, oldNotes[1], 'A failed quote download must retain its last validated commentary.');
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'VCR').noteDisposition.status, 'reviewed');
  assert.ok(dashboard.tape.rows.filter((row) => row.ticker !== 'VCR').every((row, index) => row.note !== oldNotes[index === 0 ? 0 : 2]));
}

function testArchitectureFinalizationValidatesBeforeReplace() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-atomic-editorial-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const invalidPayload = structuredClone(dashboard);
  invalidPayload.opening.catalysts = [];
  invalidPayload.stories[0].publishedOn = '2000-01-01';
  invalidPayload.stories[1] = structuredClone(invalidPayload.futuresModule.stories[1]);
  invalidPayload.crypto.notes[0].url = 'http://insecure.example/story';
  invalidPayload.tape.rows[0].note = `Reviewed commentary must not repeat the displayed quote ${invalidPayload.tape.rows[0].last}.`;
  const eventDays = dashboard.weekAhead.days.filter((day) => day.events.length);
  const review = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearch(dashboard),
    openingDecision: { action: 'reviewed' },
    marketLensDecisions: eventDays.map((day) => ({ date: day.date, action: 'retain-generated' }))
  };
  invalidPayload.editorialReview = review;
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(invalidPayload));
  writeFixtureNewsCandidates(dashboard);
  const command = [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile,
    '--afternoon'
  ];
  const env = {
    ...process.env,
    SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z',
    VALIDATE_NOW_ISO: FIXTURE_NOW
  };
  const pendingOpeningPayload = structuredClone(dashboard);
  pendingOpeningPayload.opening = { headline: '', deck: 'Deck without a headline should not render.', catalysts: [{ label: 'Valid', body: '' }] };
  pendingOpeningPayload.editorialReview = {
    ...review,
    openingDecision: { action: null }
  };
  pendingOpeningPayload.editorialReview.openingDecision = { action: null };
  fs.writeFileSync(payloadFile, JSON.stringify(pendingOpeningPayload));
  const pendingOpeningResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(pendingOpeningResult.status, 0, pendingOpeningResult.stderr);
  const openingOmitted = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.deepEqual(openingOmitted.opening, {}, 'Incomplete Opening fields are omitted instead of blocking finalization.');

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, '{');
  const invalidCandidateResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.notEqual(invalidCandidateResult.status, 0, 'A malformed staged candidate must not finalize.');
  assert.match(invalidCandidateResult.stderr, /run_daily_update failed: Could not find dashboard-data JSON block/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'Failed finalization must leave the canonical dashboard and its completion state untouched.');

  const reusedRevisionChart = structuredClone(chartData);
  reusedRevisionChart.series[0].bars.at(-1)[4] += 1;
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(dashboard, reusedRevisionChart));
  fs.writeFileSync(payloadFile, JSON.stringify(invalidPayload));
  const reusedRevisionResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.notEqual(reusedRevisionResult.status, 0, 'Finalization must reject changed chart data bound to the prior quote revision.');
  assert.match(reusedRevisionResult.stderr, /Chart series SPX changed deterministic content but reused quoteRevision/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);

  const editorialPayload = structuredClone(dashboard);
  editorialPayload.masthead.date = 'Saturday · January 1, 2000';
  editorialPayload.opening.headline = 'Reviewed fixture headline';
  editorialPayload.stories[0].title = 'Reviewed market story';
  editorialPayload.futuresModule.sectionTitle = 'Unauthorized futures title';
  editorialPayload.futuresModule.futures[0].value = '99,999.00';
  editorialPayload.futuresModule.stories[0].title = 'Reviewed futures story';
  editorialPayload.tape.label = 'Unauthorized session label · Reviewed drivers';
  editorialPayload.tape.rows[0].last = '99,999.00';
  editorialPayload.tape.rows[0].note = 'Federal Reserve expectations shaped rates and risk appetite.';
  editorialPayload.crypto.stats[0].price = '$9.99T';
  editorialPayload.crypto.notes[0].title = 'Reviewed crypto story';
  editorialPayload.editorialReview = review;
  editorialPayload.assetAllocationPortfolio.rows[0].price = '$999.00';
  editorialPayload.footer.compiled = dashboard.footer.compiled.replace(' · Market data:', ' · Holiday context: Reviewed. · Market data:');
  const editorialEventDay = editorialPayload.weekAhead.days.find((day) => day.events.length);
  editorialEventDay.events[0].forecast = '9.9%';

  const shortSearchPayload = structuredClone(editorialPayload);
  shortSearchPayload.editorialReview.newsSearch.generalCandidates.pop();
  fs.writeFileSync(payloadFile, JSON.stringify(shortSearchPayload));
  const shortSearchResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(shortSearchResult.status, 0, shortSearchResult.stderr);
  let shortSearchFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(shortSearchFinalized.storiesCoverage.status, 'complete', 'Candidate-pool size must not override the accepted final-card count.');

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const emptyNewsPayload = structuredClone(editorialPayload);
  emptyNewsPayload.editorialReview.newsSearch = { generalCandidates: [], cryptoCandidates: [] };
  emptyNewsPayload.stories = [];
  emptyNewsPayload.futuresModule.stories = [];
  emptyNewsPayload.crypto.notes = [];
  fs.writeFileSync(payloadFile, JSON.stringify(emptyNewsPayload));
  const emptyNewsResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(emptyNewsResult.status, 0, emptyNewsResult.stderr);
  const emptyNewsFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(emptyNewsFinalized.storiesCoverage.status, 'partial');
  assert.equal(emptyNewsFinalized.futuresModule.storiesCoverage.status, 'partial');
  assert.equal(emptyNewsFinalized.crypto.notesCoverage.status, 'partial');
  assert.equal(emptyNewsFinalized.stories.length, 0);
  assert.equal(emptyNewsFinalized.futuresModule.stories.length, 0);
  assert.equal(emptyNewsFinalized.crypto.notes.length, 0);

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const mixedNewsPayload = structuredClone(editorialPayload);
  mixedNewsPayload.editorialReview.newsSearch = { generalCandidates: [], cryptoCandidates: [] };
  mixedNewsPayload.stories[0] = {
    tag: 'Markets',
    title: 'Outside inventory story',
    body: 'A structurally valid but ungenerated card should be omitted without stopping publication.',
    url: 'https://outside.test/story',
    publishedOn: '2026-07-10'
  };
  mixedNewsPayload.stories[1] = structuredClone(mixedNewsPayload.futuresModule.stories[0]);
  const duplicateCryptoTitle = mixedNewsPayload.stories[2].title;
  mixedNewsPayload.crypto.notes[0].title = duplicateCryptoTitle;
  fs.writeFileSync(payloadFile, JSON.stringify(mixedNewsPayload));
  const mixedNewsResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(mixedNewsResult.status, 0, mixedNewsResult.stderr);
  const mixedNewsFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(mixedNewsFinalized.stories.length, 7);
  assert.equal(mixedNewsFinalized.storiesCoverage.status, 'partial');
  assert.equal(mixedNewsFinalized.crypto.notes.length, 6);
  assert.equal(mixedNewsFinalized.crypto.notesCoverage.status, 'complete');
  assert.ok(!mixedNewsFinalized.stories.some((story) => story.url === 'https://outside.test/story'));
  assert.ok(!mixedNewsFinalized.stories.some((story) => story.url === mixedNewsPayload.futuresModule.stories[0].url));
  assert.ok(mixedNewsFinalized.crypto.notes.some((story) => story.title === duplicateCryptoTitle));
  assert.ok(mixedNewsFinalized.editorialReview.systemFallbacks.some((item) => item.reason === 'not_in_candidate_inventory'));
  assert.ok(mixedNewsFinalized.editorialReview.systemFallbacks.some((item) => item.reason === 'promoted_story_duplicate'));

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
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
  assert.deepEqual(finalized.storiesCoverage, { status: 'complete' });
  assert.deepEqual(finalized.futuresModule.storiesCoverage, { status: 'complete' });
  assert.deepEqual(finalized.crypto.notesCoverage, { status: 'complete' });
  assert.deepEqual(finalized.tape.rows[0], dashboard.tape.rows[0], 'Editorial input cannot alter an unchanged quote bundle.');
  assert.match(finalized.tape.label, /^Friday After The Bell · Reviewed drivers$/);
  assert.match(finalized.footer.compiled, /^Compiled Friday, July 10, 2026 at 4:01 PM CDT · Holiday context: Reviewed\./);
  assert.deepEqual(finalized.futuresModule.futures, dashboard.futuresModule.futures);
  assert.deepEqual(finalized.crypto.stats, dashboard.crypto.stats);
  assert.deepEqual(finalized.assetAllocationPortfolio, dashboard.assetAllocationPortfolio);
  assert.deepEqual(finalized.weekAhead.days.map((day) => day.events), dashboard.weekAhead.days.map((day) => day.events));
  assert.equal(finalized.masthead.date, 'Friday · July 10, 2026');
  assert.notEqual(finalized.tape.rows[0].last, '99,999.00');
  assert.ok(!(finalized.editorialReview.systemFallbacks || []).some((item) => item.action === 'unavailable_disposition'));
}

function testTapeCommentaryRefreshRequiresNewCopy() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-tape-commentary-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.tape.rows[1] = unavailableTapeCommentary(
    dashboard.tape.rows[1],
    dashboard.tape.rows[1].noteDisposition.quoteRevision
  );
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const candidateDashboard = structuredClone(dashboard);
  const candidateChartData = roundChartPayload(chartData);
  candidateChartData.generatedAt = '2026-07-10T13:00:00.000Z';
  for (const series of candidateChartData.series) {
    if (series.ticker !== 'VCR') series.quoteRevision = candidateChartData.generatedAt;
  }
  candidateChartData.availability = {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt: candidateChartData.generatedAt,
    failures: [{ ticker: 'VCR', message: 'fixture source failure' }]
  };
  candidateChartData.series.find((series) => series.ticker === 'VCR').availability = {
    status: 'carried_forward',
    reason: 'source_refresh_failed',
    checkedAt: candidateChartData.generatedAt
  };
  syncDashboardPricesFromChartData(candidateDashboard, candidateChartData, {
    now: new Date(FIXTURE_NOW),
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(candidateChartData)
  });
  const candidateHtml = renderDashboardValidationFixture(candidateDashboard, candidateChartData);
  const editorialDashboard = structuredClone(candidateDashboard);
  editorialDashboard.tape.rows[0].note = 'Fresh review ties this market to shifting rate expectations, earnings breadth, liquidity, positioning, and risk appetite.';
  editorialDashboard.tape.rows[1].noteDisposition = {
    status: 'commentary_unavailable',
    quoteRevision: editorialDashboard.tape.rows[1].noteDisposition.quoteRevision
  };
  editorialDashboard.tape.rows[2].note = dashboard.tape.rows[2].note;
  const review = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearch(dashboard),
    openingDecision: { action: 'reviewed' },
    marketLensDecisions: dashboard.weekAhead.days
      .filter((day) => day.events.length)
      .map((day) => ({ date: day.date, action: 'retain-generated' }))
  };
  editorialDashboard.editorialReview = review;

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, candidateHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(editorialDashboard));
  writeFixtureNewsCandidates(dashboard);
  const command = [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile,
    '--afternoon'
  ];
  const runOptions = {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z',
      VALIDATE_NOW_ISO: FIXTURE_NOW
    }
  };
  const result = spawnSync(process.execPath, command, runOptions);
  assert.equal(result.status, 0, result.stderr);

  const finalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(finalized.tape.rows[0].note, editorialDashboard.tape.rows[0].note);
  assert.equal(finalized.tape.rows[0].noteDisposition.status, 'reviewed');
  assert.equal(finalized.tape.rows[0].noteDisposition.quoteRevision, candidateChartData.generatedAt);
  assert.deepEqual(validateTapeCommentaryDisposition(finalized.tape.rows[0]), []);
  assert.deepEqual(finalized.tape.rows[1], dashboard.tape.rows[1], 'A failed quote download must retain its complete quote-bound row.');
  assert.ok(!(finalized.editorialReview.systemFallbacks || []).some((item) => item.path === `tape.rows.${finalized.tape.rows[1].ticker}.note`),
    'Retaining a failed quote bundle is not a new editorial fallback.');
  assert.equal(finalized.tape.rows[2].note, '');
  assert.deepEqual(finalized.tape.rows[2].noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: candidateChartData.generatedAt
  });
  assert.ok(finalized.editorialReview.systemFallbacks.some((item) => item.path === `tape.rows.${finalized.tape.rows[2].ticker}.note`
    && item.action === 'unavailable_disposition'));
}

async function testChartFetcherTickerFilterAndPartialFailure() {
  assert.deepEqual(parseFetchChartDataArgs(['--ticker', 'HG', '--ticker', 'NG']).tickers, ['HG', 'NG']);

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-chart-merge-');
  const producerInput = path.join(dir, 'producer-input.html');
  const producerOutput = path.join(dir, 'producer-chart-data.json');
  const { dashboard: producerDashboard, chartData: producerChartData } = createDashboardValidationFixture();
  const originalProducerInput = renderDashboardValidationFixture(producerDashboard, producerChartData);
  fs.writeFileSync(producerInput, originalProducerInput);
  const progressWrites = [];
  let activeChartFetches = 0;
  let maxActiveChartFetches = 0;
  await runChart([
    '--input', producerInput,
    '--output', producerOutput,
    '--ticker', 'SPX',
    '--ticker', 'VCR',
    '--ticker', 'UST10Y',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:00.000Z'),
    fetchSeries: async (row) => {
      activeChartFetches += 1;
      maxActiveChartFetches = Math.max(maxActiveChartFetches, activeChartFetches);
      await new Promise((resolve) => setImmediate(resolve));
      activeChartFetches -= 1;
      if (row.ticker === 'VCR') throw new Error('fixture ticker failure');
      return {
        ticker: row.ticker,
        name: row.name,
        section: row.section,
        sourceSymbol: row.sourceSymbol,
        note: row.note,
        source: 'Yahoo Finance Chart API',
        dataKind: 'ohlc',
        priceOnly: false,
        noVolume: false,
        bars: [
          { time: '2026-07-09', open: 6100, high: 6110, low: 6090, close: 6100, volume: 1000 },
          { time: '2026-07-10', open: 6190, high: 6210, low: 6180, close: 6200, volume: 1100 }
        ]
      };
    },
    writeJson: (file, payload) => {
      progressWrites.push(structuredClone(payload));
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    }
  });
  assert.ok(maxActiveChartFetches > 1, 'Chart rows should be fetched with bounded concurrency.');
  assert.ok(progressWrites.length > 1, 'Chart fetcher must stage progress before the final write.');
  assert.equal(progressWrites[0].availability.status, 'partial');
  assert.equal(progressWrites[0].availability.failures.length, 3);
  assert.deepEqual(validateChartStagingPayload(progressWrites[0], producerDashboard.tape.rows), []);
  const partial = JSON.parse(fs.readFileSync(producerOutput, 'utf8'));
  assert.equal(partial.availability.status, 'partial');
  assert.deepEqual(partial.availability.failures, [{ ticker: 'VCR', message: 'fixture ticker failure' }]);
  assert.equal(partial.series.find((row) => row.ticker === 'SPX').bars.at(-1).close, 6200);
  assert.equal(partial.series.find((row) => row.ticker === 'SPX').quoteRevision, partial.generatedAt);
  assert.equal(partial.series.find((row) => row.ticker === 'VCR').availability.status, 'carried_forward');
  assert.equal(partial.series.find((row) => row.ticker === 'VCR').quoteRevision, producerChartData.series.find((row) => row.ticker === 'VCR').quoteRevision);
  assert.deepEqual(validateChartStagingPayload(partial, producerDashboard.tape.rows), []);
  syncDashboardPricesFromChartData(producerDashboard, partial, {
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(partial),
    now: new Date(FIXTURE_NOW)
  });
  assert.equal(producerDashboard.tape.rows.find((row) => row.ticker === 'VCR').noteDisposition.status, 'reviewed');
  const partialValidation = validateDashboardAndChartFixture(producerDashboard, compactChartPayload(partial));
  assert.equal(partialValidation.status, 0, partialValidation.stderr);
  assert.equal(fs.readFileSync(producerInput, 'utf8'), originalProducerInput);

  await runChart([
    '--input', producerInput,
    '--output', producerOutput,
    '--ticker', 'SPX',
    '--ticker', 'VCR',
    '--ticker', 'UST10Y',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:10:00.000Z'),
    fetchSeries: async (row) => ({
      ticker: row.ticker,
      name: row.name,
      section: row.section,
      sourceSymbol: row.sourceSymbol,
      note: row.note,
      source: 'Yahoo Finance Chart API',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: false,
      bars: row.ticker === 'VCR'
        ? [
            { time: '2026-07-09', open: 4.5, high: 4.6, low: 4.4, close: 4.5, volume: 1000 },
            { time: '2026-07-10', open: 4.6, high: 4.8, low: 4.5, close: 4.7, volume: 1100 }
          ]
        : [
            { time: '2026-07-09', open: 6100, high: 6110, low: 6090, close: 6100, volume: 1000 },
            { time: '2026-07-10', open: 6190, high: 6210, low: 6180, close: 6200, volume: 1100 }
          ]
    })
  });
  const recovered = JSON.parse(fs.readFileSync(producerOutput, 'utf8'));
  assert.equal(recovered.availability, undefined);
  assert.ok(recovered.series.every((row) => row.availability === undefined));
  assert.ok(recovered.series.every((row) => row.quoteRevision === recovered.generatedAt));
  assert.deepEqual(validateChartStagingPayload(recovered, producerDashboard.tape.rows), []);
  assert.equal(fs.readFileSync(producerInput, 'utf8'), originalProducerInput);
}

function testMergedChartAvailabilityFollowsFinalSeries() {
  const { chartData: healthy } = createDashboardValidationFixture();
  const failedAt = '2026-07-10T21:05:00.000Z';
  const recoveredAt = '2026-07-10T21:10:00.000Z';
  const failedSeries = {
    ...healthy.series.find((item) => item.ticker === 'VCR'),
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: failedAt }
  };
  const partial = {
    schemaVersion: 1,
    generatedAt: failedAt,
    availability: {
      status: 'partial',
      reason: 'source_refresh_failed',
      checkedAt: failedAt,
      failures: [{ ticker: 'VCR', message: 'fixture source failure' }]
    },
    series: [failedSeries]
  };
  const partialSeries = healthy.series.map((item) => item.ticker === 'VCR' ? failedSeries : item);
  assert.deepEqual(mergedChartAvailability(healthy, partial, partialSeries), partial.availability);

  const recoveredSeries = {
    ...healthy.series.find((item) => item.ticker === 'VCR'),
    quoteRevision: recoveredAt
  };
  const recovery = { schemaVersion: 1, generatedAt: recoveredAt, series: [recoveredSeries] };
  const finalSeries = partialSeries.map((item) => item.ticker === 'VCR' ? recoveredSeries : item);
  assert.equal(mergedChartAvailability({ ...healthy, availability: partial.availability, series: partialSeries }, recovery, finalSeries), null);

  const wholeFallback = buildChartDataFallback(healthy, failedAt);
  assert.deepEqual(
    mergedChartAvailability(wholeFallback, recovery, healthy.series),
    wholeFallback.availability,
    'A focused recovery must not clear a whole-payload fallback for untouched tickers.'
  );
}

function testChartRepairStagesMixedResultForEditorialReview() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-chart-repair-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'chart.json');
  const editorialDir = path.join(dir, 'editorial');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const stagedDashboard = structuredClone(dashboard);
  stagedDashboard.stories[0].headline = 'Candidate-only staged headline survives focused repair';
  const stagedHtml = renderDashboardValidationFixture(stagedDashboard, chartData);
  const originalChart = roundChartPayload(chartData);
  const originalVcrSeries = originalChart.series.find((item) => item.ticker === 'VCR');
  const originalVcrRow = dashboard.tape.rows.find((item) => item.ticker === 'VCR');
  const refreshedAt = FIXTURE_NOW;
  const refreshedSpx = structuredClone(originalChart.series.find((item) => item.ticker === 'SPX'));
  refreshedSpx.quoteRevision = refreshedAt;
  refreshedSpx.bars.at(-1).high += 10;
  refreshedSpx.bars.at(-1).close += 10;
  const carriedVcr = {
    ...structuredClone(originalVcrSeries),
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: refreshedAt }
  };
  const repairPayload = {
    schemaVersion: 1,
    generatedAt: refreshedAt,
    availability: {
      status: 'partial',
      reason: 'source_refresh_failed',
      checkedAt: refreshedAt,
      failures: [{ ticker: 'VCR', message: 'fixture source failure' }]
    },
    series: [refreshedSpx, carriedVcr]
  };

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, stagedHtml);
  const environment = {
    ...process.env,
    SCHEDULED_NOW_ISO: FIXTURE_NOW,
    VALIDATE_NOW_ISO: FIXTURE_NOW
  };
  const command = [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--merge-chart-data-json', payloadFile
  ];
  const changedWithOldRevision = {
    ...structuredClone(refreshedSpx),
    quoteRevision: originalChart.series.find((item) => item.ticker === 'SPX').quoteRevision
  };
  fs.writeFileSync(payloadFile, JSON.stringify({ ...repairPayload, series: [changedWithOldRevision, carriedVcr] }));
  const rejectedResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(rejectedResult.status, 0, rejectedResult.stderr);
  assert.match(rejectedResult.stderr, /Chart series SPX changed deterministic content but reused quoteRevision/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.deepEqual(
    roundChartPayload(readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'chart-data')).series.find((item) => item.ticker === 'SPX').bars,
    originalChart.series.find((item) => item.ticker === 'SPX').bars,
    'A focused repair cannot stage changed series data under the prior quote revision.'
  );

  fs.writeFileSync(candidateFile, stagedHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(repairPayload));
  const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidate ready.*canonical dashboard unchanged/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);

  const candidateHtml = fs.readFileSync(candidateFile, 'utf8');
  const candidateDashboard = readJsonBlock(candidateHtml, 'dashboard-data');
  const candidateChart = roundChartPayload(readJsonBlock(candidateHtml, 'chart-data'));
  const candidateSpxRow = candidateDashboard.tape.rows.find((item) => item.ticker === 'SPX');
  const candidateVcrRow = candidateDashboard.tape.rows.find((item) => item.ticker === 'VCR');
  const candidateVcrSeries = candidateChart.series.find((item) => item.ticker === 'VCR');
  assert.equal(candidateDashboard.editionId, dashboard.editionId);
  assert.equal(candidateDashboard.editorialReview, undefined);
  assert.equal(candidateDashboard.stories[0].headline, stagedDashboard.stories[0].headline);
  assert.equal(candidateSpxRow.last, quoteRowFromSeries(refreshedSpx).last);
  assert.deepEqual(candidateVcrRow, originalVcrRow);
  assert.equal(candidateVcrSeries.quoteRevision, originalVcrSeries.quoteRevision);
  assert.deepEqual(candidateVcrSeries.bars, originalVcrSeries.bars);

  const editorialResult = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--prepare-editorial-dir', editorialDir,
    '--afternoon'
  ], { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(editorialResult.status, 0, editorialResult.stderr);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  const handoff = JSON.parse(fs.readFileSync(path.join(editorialDir, 'dashboard-data.json'), 'utf8'));
  assert.equal(handoff.tape.rows.find((item) => item.ticker === 'SPX').noteDisposition.status, 'pending_review');
  assert.deepEqual(handoff.tape.rows.find((item) => item.ticker === 'VCR'), originalVcrRow);
}

function testDashboardEmbeddedRuntimeParses() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const runtime = dashboardRuntimeSource(html);
  assert.doesNotThrow(() => new Function(runtime), 'The complete dashboard runtime must parse as JavaScript.');
}

function testOpeningRenderingOmitsIncompleteBlocks() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'opening-rendering');
  const elements = new Map([
    ['mast-edition', { textContent: '' }],
    ['mast-date-value', { textContent: '' }],
    ['hero-headline', { hidden: false, innerHTML: '' }],
    ['hero-copy', { innerHTML: '' }]
  ]);
  const runtime = Function('$', 'esc', 'inline', `${source}\nreturn { renderHero };`)(
    (id) => elements.get(id),
    (value) => String(value).replace(/[&<>"']/g, ''),
    (value) => String(value)
  );
  runtime.renderHero({
    masthead: {},
    opening: {
      headline: '',
      deck: 'Deck without a headline should not render.',
      catalysts: [{ label: 'Rates', body: 'Policy repricing led.' }, { label: 'Invalid', body: '' }]
    }
  });
  assert.equal(elements.get('hero-headline').hidden, true);
  assert.equal(elements.get('hero-headline').innerHTML, '');
  assert.doesNotMatch(elements.get('hero-copy').innerHTML, /Deck without a headline/);
  assert.match(elements.get('hero-copy').innerHTML, /Rates/);
  assert.doesNotMatch(elements.get('hero-copy').innerHTML, /Invalid/);

  runtime.renderHero({ masthead: {}, opening: { headline: 'Markets reset', deck: 'Drivers shifted.' } });
  assert.equal(elements.get('hero-headline').hidden, false);
  assert.equal(elements.get('hero-headline').innerHTML, 'Markets reset');
  assert.match(elements.get('hero-copy').innerHTML, /Drivers shifted/);
}

function testEarningsOutcomeLifecycleRendering() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const outcomeSource = extractDashboardRuntimeTestBlock(html, 'earnings-outcome-lifecycle');
  const reactionSource = extractDashboardRuntimeTestBlock(html, 'earnings-reaction-note');
  const { earningsOutcomeInterpretation } = Function(`${outcomeSource}\nreturn { earningsOutcomeInterpretation };`)();
  const { earningsReactionNote } = Function(`${reactionSource}\nreturn { earningsReactionNote };`)();

  assert.equal(earningsOutcomeInterpretation({
    lifecycle: 'scheduled',
    outcome: { interpretation: 'Margin resilience and order demand are the pre-release focus.' }
  }), 'Margin resilience and order demand are the pre-release focus.');
  assert.equal(earningsOutcomeInterpretation({
    lifecycle: 'awaiting_actual',
    outcome: { interpretation: 'Margin resilience and order demand are the pre-release focus.' }
  }), 'Margin resilience and order demand are the pre-release focus.');
  assert.equal(earningsOutcomeInterpretation({
    lifecycle: 'released_awaiting_close',
    outcome: { interpretation: 'Verified released-result interpretation.' }
  }), 'Verified released-result interpretation.');
  assert.equal(earningsOutcomeInterpretation({
    lifecycle: 'released_awaiting_close',
    outcome: { interpretation: '' }
  }), '');
  assert.equal(earningsReactionNote({
    lifecycle: 'close_available',
    reaction: { status: 'computed', note: 'Verified reaction interpretation.' }
  }), 'Verified reaction interpretation.');
  assert.equal(earningsReactionNote({
    lifecycle: 'close_available',
    reaction: { status: 'unavailable', note: '' }
  }), '');
  assert.equal(earningsReactionNote({ lifecycle: 'scheduled', reaction: { status: 'pending' } }), 'Not reported yet');
  assert.equal(earningsReactionNote({ lifecycle: 'awaiting_actual', reaction: { status: 'pending' } }), 'Awaiting results');
  assert.equal(earningsReactionNote({
    lifecycle: 'released_awaiting_close',
    reaction: { status: 'awaiting_close', basis: 'next_session_close' }
  }), 'Awaiting next-session close');
  assert.match(html, /No covered earnings scheduled\./);
  assert.doesNotMatch(html, /Editorial commentary required|Reaction commentary unavailable|Reaction window unavailable|No display-eligible earnings|canonical source may contain smaller rows/);
  const earningsRuntime = html.slice(html.indexOf('function isRenderableEarningsRow'), html.indexOf('function renderEarnings'));
  assert.doesNotMatch(earningsRuntime, /sourceAudit|finnhubUsListing|finnhubProfile|selectedSources/);
}

function testMarketLensReactionOpensChartBelowDay() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'market-lens-routing');
  const runtime = Function(`
    const available = new Set(['UST2Y', 'CL']);
    const calls = [];
    let activeWeekChartDayKey = '';
    let activeWeekChartTicker = '';
    const chartSeriesForTicker = (ticker) => available.has(ticker) ? { ticker } : null;
    const closeTapeChart = () => calls.push(['close-tape']);
    const syncWeekAheadChart = (options) => calls.push(['chart', activeWeekChartDayKey, activeWeekChartTicker, options]);
    ${source}
    return {
      showWeekChartForTicker,
      snapshot: () => ({ activeWeekChartDayKey, activeWeekChartTicker, calls: [...calls] })
    };
  `)();

  runtime.showWeekChartForTicker('2026-07-14', 'ust2y');
  assert.deepEqual(runtime.snapshot(), {
    activeWeekChartDayKey: '2026-07-14',
    activeWeekChartTicker: 'UST2Y',
    calls: [['close-tape'], ['chart', '2026-07-14', 'UST2Y', { scrollIntoView: true, focusChart: true }]]
  });
  runtime.showWeekChartForTicker('2026-07-14', 'UST2Y');
  assert.equal(runtime.snapshot().activeWeekChartTicker, 'UST2Y', 'Repeated activation must keep the chart below that day open.');
  assert.deepEqual(runtime.snapshot().calls.slice(-2), [
    ['close-tape'],
    ['chart', '2026-07-14', 'UST2Y', { scrollIntoView: true, focusChart: true }]
  ]);
  runtime.showWeekChartForTicker('2026-07-15', 'QQQ');
  assert.equal(runtime.snapshot().calls.length, 4, 'An unavailable or noncanonical ticker must not open a chart.');
}

function validateDashboardFixture(data, now = FIXTURE_NOW) {
  const { chartData } = createDashboardValidationFixture();
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), now);
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

function validationDashboardData() {
  // Contract mutations start from a fixed, self-contained payload; the live artifact has its own smoke test below.
  return createDashboardValidationFixture().dashboard;
}

function testDashboardValidatorAllowsCompletedFridayWithPartialCalendarRollover() {
  const staleEarnings = validationDashboardData();
  staleEarnings.earnings.week.range = { from: '2026-07-06', to: '2026-07-10' };

  const staleEarningsResult = validateDashboardFixture(staleEarnings);
  assert.equal(staleEarningsResult.status, 0, 'A stale New-pill baseline must not block a renderable Earnings section.');

  const staleWeekAhead = validationDashboardData();
  staleWeekAhead.weekAhead = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-06', to: '2026-07-10' },
    officialSchedule: { events: [], authorities: [] },
    now: new Date('2026-07-10T18:00:00Z')
  });
  const staleWeekAheadResult = validateDashboardFixture(staleWeekAhead);
  assert.equal(staleWeekAheadResult.status, 0, 'A stale New-pill baseline must not block a renderable Week Ahead section.');
}


function testDashboardWriterNormalizesStaleTapeCommentary() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.tape.rows[0].note = 'Stale commentary that should not survive publication.';
  dashboard.tape.rows[0].noteDisposition = {
    status: 'reviewed',
    quoteRevision: '2026-07-10T11:00:00.000Z',
    reviewedAt: '2026-07-10T11:05:00.000Z'
  };
  const published = readJsonBlock(
    patchDashboardDataBlock(renderDashboardValidationFixture(dashboard, chartData), dashboard, null, null, { stampEdition: false }),
    'dashboard-data'
  );
  assert.equal(published.tape.rows[0].note, '');
  assert.deepEqual(published.tape.rows[0].noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: chartData.series[0].quoteRevision
  });
  assert.equal(validateDashboardAndChartFixture(published, chartData).status, 0);
}

function testDashboardValidatorRejectsChartProvenanceMismatches() {
  {
    const { dashboard, chartData } = createDashboardValidationFixture();
    dashboard.tape.rows[0] = unavailableTapeCommentary(
      dashboard.tape.rows[0],
      dashboard.tape.rows[0].noteDisposition.quoteRevision
    );
    const baseEditionId = dashboard.editionId;
    const manifest = {
      schemaVersion: 1,
      reviewedAt: new Date(FIXTURE_NOW).toISOString(),
      baseEditionId,
      verifiedClaims: [],
      systemFallbacks: [{
        section: 'tape-commentary',
        path: 'tape.rows.SPX.note',
        action: 'unavailable_disposition',
        reason: 'editorial_commentary_unavailable'
      }],
      marketLensDecisions: dashboard.weekAhead.days
        .filter((day) => day.events.length)
        .map((day) => ({ date: day.date, action: 'retain-generated' }))
    };
    dashboard.editionId = '2026-07-10T21:00:01.000Z';
    buildEditorialReview(dashboard, { ...manifest, baseEditionId }, chartData);
  }
}

function testTouchTooltipControls() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const localRefreshStatusSource = extractDashboardRuntimeTestBlock(html, 'local-refresh-status');
  const { localRefreshStatusText, localRefreshResultMessage } = Function(
    `${localRefreshStatusSource}\nreturn { localRefreshStatusText, localRefreshResultMessage };`
  )();
  const localRefreshFixture = { generatedAt: FIXTURE_NOW };
  assert.equal(localRefreshStatusText(localRefreshFixture), '8:30 AM CT');
  assert.equal(localRefreshResultMessage(localRefreshFixture), 'Local market data updated · Checked 8:30 AM CT');
  assert.equal(
    localRefreshResultMessage({ ...localRefreshFixture, partial: true }),
    'Local market data partial · Available updates applied · Checked 8:30 AM CT'
  );
  assert.equal(localRefreshResultMessage(localRefreshFixture, 'cached'), 'Cached local market data shown · Checked 8:30 AM CT');
  assert.equal(localRefreshResultMessage(localRefreshFixture, 'embedded'), 'Embedded market data shown · Checked 8:30 AM CT');
  const source = extractDashboardRuntimeTestBlock(html, 'touch-tooltip-controls');
  const makeButton = () => ({
    attributes: {},
    blurred: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    blur() { this.blurred = true; }
  });
  const makeWrap = (buttonSelector, button, tooltip = null) => {
    const names = new Set();
    return {
      classList: {
        contains: (name) => names.has(name),
        remove: (name) => names.delete(name),
        toggle: (name, enabled) => {
          if (enabled) names.add(name);
          else names.delete(name);
        }
      },
      querySelector: (selector) => selector === buttonSelector
        ? button
        : selector === '.week-forecast-tooltip' ? tooltip : null
    };
  };
  const localButton = makeButton();
  const forecastButton = makeButton();
  const cryptoButton = makeButton();
  const localWrap = makeWrap('[data-local-refresh-toggle]', localButton);
  const cryptoWrap = makeWrap('[data-stale-button]', cryptoButton);
  let forecastShift = 0;
  const forecastTooltip = {
    style: {
      setProperty(name, value) {
        if (name === '--week-forecast-tooltip-shift-x') forecastShift = Number.parseFloat(value);
      }
    },
    getBoundingClientRect: () => ({ left: -15 + forecastShift, right: 245 + forecastShift })
  };
  const forecastWrap = makeWrap('[data-week-forecast-button]', forecastButton, forecastTooltip);
  const document = {
    documentElement: { clientWidth: 390 },
    querySelectorAll: (selector) => {
      if (selector === '.local-refresh-indicator.is-open') return [localWrap];
      if (selector === '.week-forecast-qualifier.is-open') return [forecastWrap];
      if (selector === '.stale-info.is-open') return [cryptoWrap];
      return [];
    }
  };
  const window = { innerWidth: 390 };
  const runtime = Function('document', 'window', `${source}\nreturn { clampWeekForecastTooltip, routeLocalRefreshTooltipClick, routeWeekForecastTooltipClick, routeStaleInfoTooltipClick, closeTouchTooltipsOnEscape };`)(document, window);
  const eventFor = (wrapSelector, wrap, buttonSelector, button) => ({
    target: {
      closest: (selector) => {
        if (selector === wrapSelector) return wrap;
        if (selector === buttonSelector) return button;
        return null;
      }
    }
  });
  const localEvent = eventFor('[data-local-refresh-indicator]', localWrap, '[data-local-refresh-toggle]', localButton);
  const forecastEvent = eventFor('[data-week-forecast-info]', forecastWrap, '[data-week-forecast-button]', forecastButton);
  const cryptoEvent = eventFor('[data-stale-info]', cryptoWrap, '[data-stale-button]', cryptoButton);

  assert.equal(runtime.routeLocalRefreshTooltipClick(localEvent), true);
  assert.equal(localWrap.classList.contains('is-open'), true);
  assert.equal(localButton.attributes['aria-expanded'], 'true');
  assert.equal(runtime.routeLocalRefreshTooltipClick(localEvent), true);
  assert.equal(localWrap.classList.contains('is-open'), false);
  assert.equal(localButton.attributes['aria-expanded'], 'false');
  assert.equal(localButton.blurred, true);

  assert.equal(runtime.routeWeekForecastTooltipClick(forecastEvent), true);
  assert.equal(forecastWrap.classList.contains('is-open'), true);
  assert.equal(forecastButton.attributes['aria-expanded'], 'true');
  assert.deepEqual(runtime.clampWeekForecastTooltip(forecastWrap), { left: 16, right: 276, shift: 31 });
  assert.ok(runtime.clampWeekForecastTooltip(forecastWrap).left >= 16, 'An open mobile forecast tooltip must remain inside the left viewport margin.');
  assert.ok(runtime.clampWeekForecastTooltip(forecastWrap).right <= 374, 'An open mobile forecast tooltip must remain inside the right viewport margin.');
  assert.equal(runtime.routeStaleInfoTooltipClick(cryptoEvent), true);
  assert.equal(cryptoWrap.classList.contains('is-open'), true);
  assert.equal(cryptoButton.attributes['aria-expanded'], 'true');
  runtime.closeTouchTooltipsOnEscape({ key: 'Escape', target: { closest: () => null } });
  assert.equal(forecastWrap.classList.contains('is-open'), false);
  assert.equal(forecastButton.attributes['aria-expanded'], 'false');
  assert.equal(cryptoWrap.classList.contains('is-open'), false);
  assert.equal(cryptoButton.attributes['aria-expanded'], 'false');

  assert.match(html, /\.local-refresh-indicator\.is-open \.local-refresh-tooltip/);
  assert.match(html, /\.week-forecast-qualifier\.is-open \.week-forecast-tooltip/);
  assert.match(html, /\.stale-info\.is-open \.stale-info-tooltip/);
  assert.match(html, /\.stale-info-button\s*\{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/);
  assert.match(html, /transform: translateX\(var\(--week-forecast-tooltip-shift-x, 0px\)\)/);

  const earningsProvenanceSource = extractDashboardRuntimeTestBlock(html, 'earnings-provenance');
  const { earningsRowNoticeHtml } = Function(
    'esc',
    `${earningsProvenanceSource}\nreturn { earningsRowNoticeHtml };`
  )((value) => String(value));
  assert.equal(earningsRowNoticeHtml({ scheduleVerificationStatus: 'corroborated' }), '');
  const retainedEarningsMarkup = earningsRowNoticeHtml({ lastValidatedAt: FIXTURE_NOW });
  assert.match(retainedEarningsMarkup, /Last validated earnings data: Jul 10, 8:30 AM CT\./);
  const unconfirmedEarningsMarkup = earningsRowNoticeHtml({ scheduleVerificationStatus: 'primary_only' });
  assert.match(unconfirmedEarningsMarkup, /Report date is unconfirmed\./);
  assert.doesNotMatch(unconfirmedEarningsMarkup, /Finnhub|EarningsAPI/);
  const combinedEarningsMarkup = earningsRowNoticeHtml({
    lastValidatedAt: FIXTURE_NOW,
    scheduleVerificationStatus: 'secondary_only'
  });
  assert.match(combinedEarningsMarkup, /Last validated earnings data: Jul 10, 8:30 AM CT\. Report date is unconfirmed\./);
  assert.doesNotMatch(combinedEarningsMarkup, /Finnhub|EarningsAPI/);
  assert.match(html, /lastValidatedAt: week\?\.availability\?\.status === 'carried_forward' \? week\.generatedAt : ''/);

  const earningsUnavailableSource = extractDashboardRuntimeTestBlock(html, 'earnings-unavailable');
  const { earningsUnavailableHtml } = Function(
    `${earningsUnavailableSource}\nreturn { earningsUnavailableHtml };`
  )();
  const earningsUnavailableMarkup = earningsUnavailableHtml();
  assert.match(earningsUnavailableMarkup, /<strong>Unavailable<\/strong>/);
  assert.doesNotMatch(earningsUnavailableMarkup, /refresh|calendar source|week data|retry|provider/i);
  assert.doesNotMatch(html, /Earnings refresh unavailable; showing the last validated slate|Earnings calendar source unavailable for this week|Earnings week data unavailable/);
  assert.match(html, /week\.availability\?\.status === 'unavailable'[\s\S]*?return earningsUnavailableHtml\(\)/);

  const weekAvailabilityInfoSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-availability-info');
  const { weekAheadAvailabilityState, weekAheadAvailabilityInfoHtml } = Function(
    'esc',
    `${weekAvailabilityInfoSource}\nreturn { weekAheadAvailabilityState, weekAheadAvailabilityInfoHtml };`
  )((value) => String(value));
  const weekStatusFixture = {
    range: { timeZone: 'America/Chicago' },
    source: { status: 'fresh', fetchedAt: FIXTURE_NOW }
  };
  assert.equal(weekAheadAvailabilityState(weekStatusFixture), 'fresh');
  assert.equal(weekAheadAvailabilityInfoHtml(weekStatusFixture), '');
  const cachedWeekMarkup = weekAheadAvailabilityInfoHtml({
    ...weekStatusFixture,
    source: { ...weekStatusFixture.source, status: 'cached' }
  });
  assert.match(cachedWeekMarkup, /data-stale-button/);
  assert.match(cachedWeekMarkup, /Week Ahead numeric data is stale/);
  assert.match(cachedWeekMarkup, /Last validated Jul 10, 8:30 AM CT\./);
  const carriedWeek = {
    ...weekStatusFixture,
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  };
  assert.equal(weekAheadAvailabilityState(carriedWeek), 'carried_forward', 'Current availability must override retained source provenance.');
  assert.match(weekAheadAvailabilityInfoHtml(carriedWeek), /Week Ahead numeric data is stale/);
  const partialWeekMarkup = weekAheadAvailabilityInfoHtml({
    ...weekStatusFixture,
    availability: { status: 'partial', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  });
  assert.match(partialWeekMarkup, /Week Ahead numeric data is partial/);
  assert.match(partialWeekMarkup, /Last checked Jul 10, 8:30 AM CT\./);
  assert.equal(weekAheadAvailabilityInfoHtml({
    ...weekStatusFixture,
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  }), '');
  assert.doesNotMatch(`${cachedWeekMarkup}${partialWeekMarkup}`, /FXMacroData|HTTP|retry/i);

  const weekOutcomeSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-outcome');
  const { weekAheadOutcomeHtml } = Function(
    'esc',
    'weekReactionButtonHtml',
    `${weekOutcomeSource}\nreturn { weekAheadOutcomeHtml };`
  )((value) => String(value), () => '');
  const unavailableOutcome = weekAheadOutcomeHtml({
    lifecycle: 'close_available',
    outcome: { status: 'commentary_unavailable' },
    marketReaction: { rows: [] }
  });
  assert.match(unavailableOutcome, /<strong>Unavailable<\/strong>/);
  assert.doesNotMatch(unavailableOutcome, /Post-event commentary unavailable|Released facts/);
  const pendingOutcome = weekAheadOutcomeHtml({ lifecycle: 'close_available', marketReaction: { rows: [] } });
  assert.match(pendingOutcome, /<strong>Pending<\/strong>/);
  assert.doesNotMatch(pendingOutcome, /Editorial interpretation pending|afternoon review/);

  assert.doesNotMatch(html, /week-ledger-status-dot/);
  assert.match(html, /week-ahead-stale-info \.stale-info-tooltip\s*\{[\s\S]*?right:\s*0;/);
  assert.match(html, /weekAheadAvailabilityState\(week\) === 'unavailable'/);
  assert.doesNotMatch(html, /Week Ahead data unavailable|Calendar cache in use|Official schedules \+ FXMacroData values/);

  const staleInfoSource = extractDashboardRuntimeTestBlock(html, 'crypto-stale-info');
  const { cryptoStatStaleInfo } = Function('esc', `${staleInfoSource}\nreturn { cryptoStatStaleInfo };`)((value) => String(value));
  assert.equal(cryptoStatStaleInfo({ sym: 'TOTAL', name: 'Crypto Market Cap' }), '');
  const staleMarkup = cryptoStatStaleInfo({
    sym: 'TOTAL',
    name: 'Crypto Market Cap',
    availability: {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt: FIXTURE_NOW,
      lastValidatedAt: FIXTURE_NOW
    }
  });
  assert.match(staleMarkup, /data-stale-button/);
  assert.match(staleMarkup, /Crypto Market Cap data is stale/);
  assert.match(staleMarkup, /Last validated: Jul 10, 8:30 AM CT\./);

  const cryptoPresentationSource = extractDashboardRuntimeTestBlock(html, 'crypto-stat-presentation');
  const { cryptoStatPresentation } = Function(
    `${cryptoPresentationSource}\nreturn { cryptoStatPresentation };`
  )();
  assert.deepEqual(
    cryptoStatPresentation(
      { availability: { status: 'unavailable' } },
      'Unavailable',
      '<strong>Unavailable</strong><span>/100</span><span>Unavailable</span>',
      '<div>Gauge</div>'
    ),
    {
      subText: '',
      valuesHtml: '<strong class="metric-primary">Unavailable</strong>',
      extra: ''
    }
  );

  const tapeStaleSource = extractDashboardRuntimeTestBlock(html, 'tape-stale-info');
  const tapeStaleRuntime = Function('esc', `
    const STALE_CHART_WARNING_BUSINESS_DAYS = 2;
    let chartDataReferenceDate = '2026-07-14';
    const chartLatestDate = (series) => series?.bars?.at(-1)?.time || '';
    const chartDateLabel = (value) => value;
    ${tapeStaleSource}
    return { chartBusinessDayGap, tapeSeriesIsStale, tapeStaleInfo, tapeCommentaryUnavailableInfo };
  `)((value) => String(value));
  const moveSeries = { ticker: 'MOVE', bars: [{ time: '2026-07-10' }] };
  assert.equal(tapeStaleRuntime.chartBusinessDayGap('2026-07-10', '2026-07-13'), 1);
  assert.equal(tapeStaleRuntime.chartBusinessDayGap('2026-07-10', '2026-07-14'), 2);
  assert.equal(tapeStaleRuntime.tapeSeriesIsStale(moveSeries), true);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /MOVE data is stale/);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /Last valid quote: 2026-07-10\./);
  assert.doesNotMatch(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /not updated/);
  assert.match(tapeStaleRuntime.tapeCommentaryUnavailableInfo({
    ticker: 'SPX',
    note: '',
    noteDisposition: { status: 'commentary_unavailable', quoteRevision: FIXTURE_NOW }
  }), /Commentary unavailable for this refreshed quote/);
  assert.doesNotMatch(html, /Data is stale: latest chart bar is/);

  const futuresAvailabilitySource = extractDashboardRuntimeTestBlock(html, 'futures-availability-info');
  const { futuresAvailabilityInfo } = Function(
    'esc',
    `${futuresAvailabilitySource}\nreturn { futuresAvailabilityInfo };`
  )((value) => String(value));
  assert.equal(futuresAvailabilityInfo({ symbol: 'ES=F', label: 'S&P Futures' }), '');
  const unavailableFuturesMarkup = futuresAvailabilityInfo({
    symbol: 'ES=F',
    label: 'S&P Futures',
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  });
  assert.match(unavailableFuturesMarkup, /data-stale-button/);
  assert.match(unavailableFuturesMarkup, /S&amp;P Futures quote status|S&P Futures quote status/);
  assert.match(unavailableFuturesMarkup, /Quote unavailable for this update\./);
  assert.doesNotMatch(unavailableFuturesMarkup, /HTTP|provider|retry/i);
  const retainedFuturesMarkup = futuresAvailabilityInfo({
    symbol: 'NQ=F',
    label: 'Nasdaq Futures',
    raw: { regularMarketTime: Date.parse('2026-07-15T13:30:00.000Z') / 1000 },
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  });
  assert.match(retainedFuturesMarkup, /Last valid quote: Jul 15, 8:30 AM CT\./);
  assert.doesNotMatch(retainedFuturesMarkup, /HTTP|provider|retry/i);

  const portfolioAvailabilitySource = extractDashboardRuntimeTestBlock(html, 'portfolio-availability-info');
  const { portfolioAvailabilityInfo } = Function(
    'esc',
    `${portfolioAvailabilitySource}\nreturn { portfolioAvailabilityInfo };`
  )((value) => String(value));
  const healthyPortfolio = { availability: { status: 'partial', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW } };
  assert.equal(portfolioAvailabilityInfo({ ticker: 'VTI' }, healthyPortfolio, 'VTI'), '');
  const retainedPortfolioMarkup = portfolioAvailabilityInfo({
    ticker: 'IEF',
    availability: {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt: FIXTURE_NOW,
      lastValidatedAt: '2026-07-14T20:00:00.000Z'
    }
  }, healthyPortfolio, 'IEF');
  assert.match(retainedPortfolioMarkup, /data-stale-button/);
  assert.match(retainedPortfolioMarkup, /Last validated market data: Jul 14, 2026\./);
  assert.doesNotMatch(retainedPortfolioMarkup, /HTTP|provider|retry/i);
  const unavailablePortfolioMarkup = portfolioAvailabilityInfo(null, {
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  }, 'VTI');
  assert.match(unavailablePortfolioMarkup, /Market data unavailable for this update\./);
  assert.doesNotMatch(unavailablePortfolioMarkup, /HTTP|provider|retry/i);
  assert.match(html, /portfolioAvailabilityInfo\(row, portfolio, ticker\)\}\$\{portfolioDividendInfo\(row\)\}/);

  const localCryptoSource = extractDashboardRuntimeTestBlock(html, 'local-refresh-crypto-stats');
  const { applyCryptoStats: applyLocalCryptoStats } = Function(
    'sameJsonValue',
    `${localCryptoSource}\nreturn { applyCryptoStats };`
  )((left, right) => JSON.stringify(left) === JSON.stringify(right));
  const locallyRefreshed = {
    crypto: {
      availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW },
      stats: [{
        sym: 'TOTAL', name: 'Crypto Market Cap', price: '$1.00T',
        availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
      }]
    }
  };
  assert.equal(applyLocalCryptoStats(locallyRefreshed, [{ sym: 'TOTAL', price: '$1.01T' }]), true);
  assert.equal(locallyRefreshed.crypto.availability, undefined);
  assert.equal(locallyRefreshed.crypto.stats[0].availability, undefined);

  const localQuoteRowsSource = extractDashboardRuntimeTestBlock(html, 'local-refresh-quote-rows');
  const localQuoteRowsRuntime = Function(
    `${localQuoteRowsSource}\nreturn { applyTapeQuoteRows, applyCryptoQuoteRows };`
  )();
  const reviewedDisposition = {
    status: 'reviewed',
    quoteRevision: FIXTURE_NOW,
    reviewedAt: FIXTURE_NOW
  };
  const localQuoteDashboard = {
    tape: {
      rows: [
        { ticker: 'SPX', last: '100', pct: '+1.00%', asOf: '2026-07-09', note: 'Existing equity commentary.', noteDisposition: reviewedDisposition },
        { ticker: 'BTC', last: '$60,000', pct: '+2.00%', asOf: '2026-07-09', note: 'Existing crypto commentary.', noteDisposition: reviewedDisposition }
      ]
    }
  };
  assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(localQuoteDashboard, [{
    ticker: 'SPX', last: '101', delta: '+1', pct: '+1.01%', dir: 'up', asOf: '2026-07-10'
  }]), true);
  assert.equal(localQuoteDashboard.tape.rows[0].note, 'Existing equity commentary.');
  assert.deepEqual(localQuoteDashboard.tape.rows[0].noteDisposition, reviewedDisposition);
  assert.equal(localQuoteRowsRuntime.applyCryptoQuoteRows(localQuoteDashboard, [{
    ticker: 'BTC', price: '$61,000', delta: '+$1,000', chg: '+1.67%', dir: 'up', asOf: '2026-07-10'
  }]), true);
  assert.equal(localQuoteDashboard.tape.rows[1].note, 'Existing crypto commentary.');
  assert.deepEqual(localQuoteDashboard.tape.rows[1].noteDisposition, reviewedDisposition);
  assert.doesNotMatch(html, /Market-driver commentary is temporarily unavailable/);
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
  testArchitectureSingleWriterAndCliBoundaries,
  testDeterministicSectionFallbackContracts,
  testSectionCommandTimeoutFallsOpen,
  testEarningsRefreshFailureKeepsFreshBuildArtifact,
  testEarningsCalendarBuildAuthorization,
  testLastGoodDashboardRecovery,
  testAtomicCommitKeepsValidatedDashboardWhenSnapshotRefreshFails,
  testArchitecturePreparationLeavesCanonicalUnchanged,
  testPreparationStatusCannotEndIntermediate,
  testScheduledPreparationRefusalSkipsCleanly,
  testEditorialPreparationCreatesOnePendingHandoff,
  testMalformedFocusedEarningsIsNoOp,
  testReleasedEventRetainGeneratedBecomesUnavailableLens,
  testArchitectureFinalizationValidatesBeforeReplace,
  testTapeCommentaryRefreshRequiresNewCopy
]);

const localRefreshIntegrationTests = Object.freeze([
  testLocalRefreshKeepsNewerEmbeddedSeriesProvenance,
  testLocalMarketServerOriginPolicyAndTlsOptions
]);

async function main() {
  const testArguments = new Set(process.argv.slice(2));
  for (const argument of testArguments) {
    if (argument !== '--local-refresh') throw new Error(`Unknown test_dashboard.js option: ${argument}`);
  }
  const tests = [
    testUpdaterQuoteAndCryptoPatches,
    testUpdaterModulePatches,
    testPartialDeterministicRowsValidate,
    testFuturesStagingPayloadContract,
    testPublicationDisplaySectionNormalization,
    testEarningsCommentaryPublicationNormalization,
    testEditorialReviewContract,
    testChartSeriesOwnsDerivedQuoteViews,
    testQuoteRefreshInvalidatesTapeCommentaryWithoutBlocking,
    testChartFetcherTickerFilterAndPartialFailure,
    testMergedChartAvailabilityFollowsFinalSeries,
    testChartRepairStagesMixedResultForEditorialReview,
    testDashboardEmbeddedRuntimeParses,
    testOpeningRenderingOmitsIncompleteBlocks,
    testEarningsOutcomeLifecycleRendering,
    testMarketLensReactionOpensChartBelowDay,
    testDashboardValidatorAllowsCompletedFridayWithPartialCalendarRollover,
    testDashboardWriterNormalizesStaleTapeCommentary,
    testDashboardValidatorRejectsChartProvenanceMismatches,
    testTouchTooltipControls,
    testExpandedChartScrollsFullyIntoViewport,
    ...(testArguments.has('--local-refresh') ? localRefreshIntegrationTests : [])
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
    if (testArguments.has('--local-refresh')) console.log('Local refresh integration tests passed.');
  } finally {
    cleanupTemporaryDirectories();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
