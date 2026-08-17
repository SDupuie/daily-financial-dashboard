#!/usr/bin/env node

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chartDataModule = require('./fetch_chart_data');
const cryptoStatsModule = require('./fetch_crypto_stats');
const {
  buildMarketRefresh,
  isAllowedBrowserOrigin,
  parseArgs: parseLocalMarketServerArgs
} = require('./local_market_server');
const { mapConcurrent } = require('./fetch_concurrency');
const {
  acceptedFreshChartTickers,
  buildChartDataFallback,
  buildUnavailableChartData,
  buildUnavailableFuturesPayload,
  compactChartPayload,
  deriveQuoteRowsFromSeries,
  fetchYahooJsonWithRetry,
  isValidMoveDailyChangeReference,
  parseFuture,
  parseArgs: parseFetchChartDataArgs,
  parseYahooSeries,
  quoteRowFromSeries,
  roundChartPayload,
  runChart,
  runFutures,
  validateChartPayloadMetadata,
  validateChartStagingPayload,
  validateFuturesPayload,
} = chartDataModule;
const {
  buildAssetAllocationFallback,
  buildAssetAllocationSummaryFallback,
  fetchHolding,
  fetchPortfolioRows,
  parseHolding,
  validateAssetAllocationPortfolioPayload,
  validateAssetAllocationSummaryPayload
} = require('./fetch_asset_allocation');
const { buildCryptoStatsFallback, fetchCryptoStatsPartial, validateCryptoStatsPayload } = cryptoStatsModule;
const {
  validateDashboardHtml
} = require('./validate_dashboard');
const {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  chartSeriesRevisionErrors,
  manualCalendarRolloverRange,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyEarningsWeek,
  applyEditorialEarningsNarrative,
  applyEditionMetadata,
  commitDashboardCandidate,
  earningsCalendarBuildDecision,
  activeCalendarRange,
  earningsTargetRange,
  applyFuturesModule,
  applyTapeQuoteRows,
  loadDashboardBase,
  mergedChartAvailability,
  patchDashboard,
  patchDashboardDataBlock,
  parseArgs: parseRunDailyUpdateArgs,
  readJsonBlock,
  readCurrentEarningsWeekArtifact,
  readCurrentFuturesModuleArtifact,
  repairMissingZacksBrowserBeforePrepare,
  reportZacksBrowserFallbackWarning,
  requiresUnavailableRolloverRetry,
  runCommand,
  runWithSectionFallback,
  isEmptyEarningsRecoveryWeek,
  weekAheadPreparationCommandArgs,
  stageDashboardCandidate,
  syncDashboardPricesFromChartData
} = require('./run_daily_update');
const {
  applyWeekAheadLifecycle,
  buildWeekAheadPreparationFallback,
  defaultMarketLensForEvents,
  normalizeWeekAhead
} = require('./week_ahead_contract');
const { buildEarningsPreparationFallback } = require('./earnings_week_contract');
const { validateEarningsWeekPayload } = require('./earnings_week');
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

function tradingViewCalendarFixture(rows = []) {
  return { status: 'ok', result: rows };
}

function tradingViewCalendarRow(overrides = {}) {
  return {
    id: 'fixture-retail-sales',
    title: 'Retail Sales MoM',
    country: 'US',
    indicator: 'Retail Sales',
    source: 'U.S. Census Bureau',
    actual: null,
    previous: 0.2,
    forecast: 0.3,
    unit: '%',
    scale: '',
    importance: 1,
    date: '2026-07-13T12:30:00.000Z',
    ...overrides
  };
}

async function testFetchConcurrencyHelperContract() {
  const active = { count: 0, max: 0 };
  const settled = [];
  const sleepCalls = [];
  const result = await mapConcurrent([30, 10, 20, 5], 2, async (delay, index) => {
    active.count += 1;
    active.max = Math.max(active.max, active.count);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active.count -= 1;
    return `item-${index}`;
  }, {
    delayMs: 1,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    onSuccess: (_item, index, value) => {
      settled.push([index, value]);
    }
  });

  assert.deepEqual(result, ['item-0', 'item-1', 'item-2', 'item-3']);
  assert.equal(active.max, 2);
  assert.deepEqual(settled.map(([index]) => index).sort((left, right) => left - right), [0, 1, 2, 3]);
  assert.deepEqual(sleepCalls, [1, 1, 1, 1]);
  await assert.rejects(
    () => mapConcurrent([1], 1, async () => {
      throw new Error('worker failed');
    }),
    /worker failed/
  );
  await assert.rejects(
    () => mapConcurrent([1], 1, async () => 'ok', { delayMs: 1 }),
    /requires options\.sleep/
  );
}

function story(kind, index) {
  const url = `https://www.cnbc.com/fixture/${kind}-${index}`;
  return {
    tag: kind === 'crypto' ? 'Crypto' : 'Markets',
    tone: kind === 'crypto' ? 'crypto' : 'neutral',
    title: `${kind} fixture story ${index}`,
    body: `Fixture reporting item ${index} provides a concise, dated market-development summary for validator coverage.`,
    url,
    publishedOn: '2026-07-10',
    sourceLabel: 'Fixture News'
  };
}

function fixtureFutures() {
  const symbols = ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'];
  const sessionOpen = Date.parse('2026-07-10T13:30:00Z') / 1000;
  const sessionClose = Date.parse('2026-07-10T20:00:00Z') / 1000;
  const series = Array.from({ length: 12 }, (_item, pointIndex) => [
    sessionOpen + ((sessionClose - sessionOpen) * pointIndex) / 11,
    100 + pointIndex / 11
  ]);
  return Array.from({ length: 4 }, (_item, index) => ({
    symbol: symbols[index],
    label: `Fixture future ${index + 1}`,
    value: '+1.00%',
    dir: 'up',
    body: 'Fixture index futures are one percent higher versus the prior 4 PM ET close after a constructive cash session.',
    series: series.map((point) => point.slice()),
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
    monthDivPerShareValue: 0,
    dividends: [],
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

function assetYahooPayload(rows, regularMarketPrice = null) {
  const lastUsableClose = [...rows].reverse().find((row) => Number.isFinite(row.close))?.close;
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: Number.isFinite(regularMarketPrice) ? regularMarketPrice : lastUsableClose
        },
        timestamp: rows.map((row) => Math.floor(Date.parse(`${row.date}T20:00:00Z`) / 1000)),
        indicators: {
          quote: [{
            close: rows.map((row) => row.close)
          }],
          adjclose: [{
            adjclose: rows.map((row) => row.adjclose)
          }]
        },
        events: {
          dividends: {}
        }
      }],
      error: null
    }
  };
}

function fixtureEarningsWeek() {
  return {
    schemaVersion: 2,
    generatedAt: '2026-07-10T12:00:00.000Z',
    range: { from: '2026-07-10', to: '2026-07-16' },
    rows: [],
    secondaryRecoveryCandidates: [],
    summary: {
      counts: {
        total: 0,
        verified: 0,
        partial: 0,
        reactionComputed: 0,
        missingTiming: 0,
        missingRevenue: 0,
        missingMarketCap: 0,
        secondaryRecoveryCandidates: 0
      }
    }
  };
}

function fixtureReportedEarningsRow() {
  return {
    symbol: 'EARN',
    company: 'Earnings Fixture Inc',
    exchange: 'NYSE',
    country: 'US',
    currency: 'USD',
    marketCap: 30000000000,
    marketCapDisplay: '$30.0B',
    reportDate: '2026-07-10',
    reportTiming: 'bmo',
    fiscalQuarterEnding: '2026-06-30',
    fiscalQuarter: 2,
    fiscalYear: 2026,
    eps: { estimate: 1, actual: 1.2, surprisePercent: 20, result: 'beat', basis: 'adjusted', note: '' },
    revenue: { estimate: 1000000000, actual: 1100000000, surprisePercent: 10, result: 'beat', note: '' },
    outcome: {
      overall: 'beat',
      guide: '',
      guidanceDisposition: {
        status: 'not_provided',
        evidenceSource: 'official_company',
        evidenceUrl: 'https://investors.fixture.test/earnings'
      },
      interpretation: 'Prior verified commentary explains the reported earnings driver.',
      interpretationDisposition: { status: 'verified' }
    },
    reaction: {
      basis: 'same_day_close',
      percent: 2,
      status: 'computed',
      note: 'Prior verified reaction commentary explains the move.',
      commentaryDisposition: { status: 'verified' }
    },
    lifecycle: 'close_available',
    sourceStatus: 'verified',
    sourceSummary: { primary: 'finnhub', fallbacks: [], reaction: 'yahoo' },
    sourceAudit: {
      finnhubUsListing: { market: 'US', symbol: 'EARN', mic: 'XNYS' },
      finnhubProfile: { industry: 'Industrials' }
    }
  };
}

function createDashboardValidationFixture() {
  // Keep validator mutations independent of the live edition while still exercising
  // the complete dashboard-to-chart and quote-row contracts.
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  const tapeNote = 'Fixture market positioning remains constructive as breadth improves and investors assess earnings, rates, growth, and liquidity conditions across sessions.';
  const chartSeries = ['SPX', 'VCR', 'UST10Y'].map((ticker, index) => ({
    ticker,
    name: `Fixture ${ticker}`,
    section: 'tape',
    sourceSymbol: ticker,
    quoteRevision,
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
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
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
          tapeNote,
          quoteRevision,
          '2026-07-10T12:30:00.000Z'
        ))
      },
      stories,
      crypto: {
        statsFetchedAt: FIXTURE_NOW,
        dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' },
        stats: [
          { sym: 'TOTAL', name: 'Crypto Market Cap', sub: 'Expanding', price: '$1.00T', delta: '+$0.01T', chg: '+1.00%', dir: 'up' },
          { sym: 'F&G', name: 'Fear & Greed', sub: 'Neutral', price: '50', delta: '+1', chg: '+1', dir: 'up' },
          { sym: 'ALTSEASON', name: 'Altcoin Season Index', price: '25', sub: 'Bitcoin Season', delta: '+1', chg: '/100', dir: 'up' }
        ],
        notes: cryptoNotes
      },
      earnings: { week: fixtureEarningsWeek() },
      weekAhead: normalizeWeekAhead(tradingViewCalendarFixture([
        tradingViewCalendarRow()
      ]), {
        range: { from: '2026-07-10', to: '2026-07-16' },
        now: new Date(FIXTURE_NOW)
      }),
      footer: {
        compiled: 'Compiled Friday, July 10, 2026 at 4:00 PM CDT'
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
  const futuresCandidates = dashboard.futuresModule.stories
    .map(({ title, url, publishedOn, publishedAt, sourceLabel }) => ({
      title,
      url,
      publishedOn,
      sourceLabel,
      publishedAtVerified: true,
      ...(publishedAt ? { publishedAt } : {})
    }));
  const generalCandidates = [...dashboard.stories, ...dashboard.futuresModule.stories]
    .map(({ title, url, publishedOn, publishedAt, sourceLabel }) => ({
      title,
      url,
      publishedOn,
      sourceLabel,
      ...(publishedAt ? { publishedAt } : {})
    }));
  const cryptoCandidates = dashboard.crypto.notes
    .map(({ title, url, publishedOn, sourceLabel }) => ({ title, url, publishedOn, sourceLabel }));
  while (generalCandidates.length < 36) {
    const index = generalCandidates.length + 1;
    generalCandidates.push({
      title: `General candidate ${index}`,
      url: `https://candidate.test/general-${index}`,
      publishedOn: '2026-07-10',
      sourceLabel: 'Fixture News'
    });
  }
  while (cryptoCandidates.length < 12) {
    const index = cryptoCandidates.length + 1;
    cryptoCandidates.push({
      title: `Crypto candidate ${index}`,
      url: `https://candidate.test/crypto-${index}`,
      publishedOn: '2026-07-10',
      sourceLabel: 'Fixture News'
    });
  }
  return { generalCandidates, futuresCandidates, cryptoCandidates };
}

function fixtureNewsSearchArtifact(dashboard, generatedAt = '2026-07-10T21:00:00.000Z') {
  const newsSearch = fixtureNewsSearch(dashboard);
  return {
    schemaVersion: 2,
    generatedAt,
    finishedAt: generatedAt,
    eligibleDates: ['2026-07-09', '2026-07-10'],
    sourceCatalog: [],
    attempts: [],
    articleReview: { status: 'complete' },
    generalCandidates: newsSearch.generalCandidates,
    futuresCandidates: newsSearch.futuresCandidates,
    cryptoCandidates: newsSearch.cryptoCandidates
  };
}

function fixtureNewsSelection(dashboard) {
  const storyFields = ({ url, tag, title, body }) => ({ url, tag, title, body });
  return {
    futures: dashboard.futuresModule.stories.map(storyFields),
    stories: dashboard.stories.map(storyFields),
    crypto: dashboard.crypto.notes.map(storyFields)
  };
}

function writeFixtureNewsCandidates(dashboard, generatedAt = '2026-07-10T21:00:00.000Z') {
  const outputPath = path.join(root, 'generated', 'news_candidates.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixtureNewsSearchArtifact(dashboard, generatedAt), null, 2)}\n`);
}

function renderDashboardValidationFixture(dashboard, chartData) {
  return `<!-- ============ DATA START ============ -->
<script type="application/json" id="dashboard-data">${JSON.stringify(dashboard)}</script>
<!-- ============ DATA END ============ -->
<script type="application/json" id="chart-data">${JSON.stringify(chartData)}</script>
<div class="page" id="app"><div id="mast-edition"></div><div class="right" id="mast-date"><span id="mast-date-value"></span></div><h1 id="hero-headline"></h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>
<script id="dashboard-runtime">const LOCAL_MARKET_REFRESH_URLS = ['https://192.168.2.2:2210/api/market-refresh'];
async function refreshLocalMarketData() {
  if (typeof fetch !== 'function') return;
  for (const url of LOCAL_MARKET_REFRESH_URLS) await fetch(url, { cache: 'no-store' });
}</script>`;
}

function replaceDashboardRuntime(html, runtime) {
  return html.replace(/<script id="dashboard-runtime">[\s\S]*?<\/script>/, `<script id="dashboard-runtime">${runtime}</script>`);
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
  assert.match(publishSource, /Timed out waiting for Pages run to appear/, 'Publishing must distinguish missing Pages runs from incomplete Pages runs.');
  assert.match(publishSource, /wait_rc"\s+-eq\s+3[\s\S]*verify_pages_content/, 'Missing Pages runs must check live content before retriggering.');
  assert.match(publishSource, /LAST_PAGES_CONCLUSION="missing_run"/, 'Missing Pages runs must use the existing empty-commit retrigger path.');
  assert.match(publishSource, /fields\.join\("\\u001f"\)[\s\S]*IFS=\$'\\037' read -r run_id run_status run_conclusion run_url/, 'Pages run parsing must preserve empty conclusion fields.');
  const updaterSource = fs.readFileSync(path.join(scriptsDir, 'run_daily_update.js'), 'utf8');
  assert.equal((updaterSource.match(/\bcommitEditorialCandidate\(/g) || []).length, 2,
    'Only dashboard-data finalization may invoke the canonical editorial commit boundary.');
  assert.equal((updaterSource.match(/\bcommitDashboardCandidate\(/g) || []).length, 2,
    'Canonical replacement must remain behind the single editorial commit boundary.');
  assert.doesNotMatch(updaterSource, /writeJson\(\s*EARNINGS_WEEK_PATH\b/,
    'Apply must not write the publication-normalized earnings week back to staging.');
  const applySource = updaterSource.slice(
    updaterSource.indexOf('function applyDashboardDataJson('),
    updaterSource.indexOf('function assertValidChartStagingPayload(')
  );
  assert.doesNotMatch(
    applySource,
    /validate(?:ChartStaging|Futures|CryptoStats|AssetAllocation|EarningsWeek)Payload|build(?:ChartData|CryptoStats|AssetAllocation|EarningsPreparation|WeekAheadPreparation|UnavailableFutures).*Fallback|normalizePublicationDisplaySections/,
    'Apply must not revalidate or replace Prepare-owned deterministic sections.'
  );
  assert.equal((updaterSource.match(/'--mode', 'published'/g) || []).length, 1,
    'Apply must retain one top-level published-artifact render-safety gate.');

  assert.throws(
    () => parseFetchChartDataArgs(['--embed-compact']),
    /Direct dashboard writes are not supported/
  );
  const prepareArgs = parseRunDailyUpdateArgs(['prepare', '--morning']);
  assert.equal(prepareArgs.prepareEditorialAfterStaging, true);
  assert.equal(prepareArgs.prepareEditorialDir, '');
  assert.equal(prepareArgs.windowMode, 'morning');
  const applyArgs = parseRunDailyUpdateArgs(['apply', '--scheduled']);
  assert.equal(applyArgs.applyDashboardDataJson, path.join(root, 'generated', 'editorial', 'dashboard-data.json'));
  assert.equal(applyArgs.scheduled, true);
  assert.equal(applyArgs.windowMode, '');
  const rolloverArgs = parseRunDailyUpdateArgs(['prepare', '--afternoon', '--rollover-calendar']);
  assert.equal(rolloverArgs.rolloverCalendar, true);
  assert.throws(
    () => parseRunDailyUpdateArgs(['apply', '--rollover-calendar']),
    /--rollover-calendar is valid only with manual deterministic preparation/
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
  assert.equal(chartFallback.availability.status, 'carried_forward');
  assert.ok(chartFallback.series.every((series) => series.availability?.status === 'carried_forward'));

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

  const unavailableAfterBrokenFallback = runWithSectionFallback(
    () => { throw new Error('fixture source failure'); },
    () => { throw new Error('fixture canonical fallback failure'); },
    {
      label: 'Fixture terminal fallback',
      validateFallback: (payload) => payload?.status === 'unavailable' ? [] : ['fixture fallback must be unavailable'],
      buildUnavailable: () => ({ status: 'unavailable' })
    }
  );
  assert.deepEqual(unavailableAfterBrokenFallback.payload, { status: 'unavailable' });
}

function testSectionTimeoutFallback() {
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
  const fallbackPayload = {
    mode: 'carried_forward',
    week: { ...fixtureEarningsWeek(), generatedAt: '2026-07-09T21:05:00.000Z' }
  };
  const freshWeek = {
    ...fixtureEarningsWeek(),
    generatedAt: checkedAt.toISOString(),
    range
  };
  fs.writeFileSync(output, `${JSON.stringify(freshWeek, null, 2)}\n`);

  const result = runWithSectionFallback(
    () => { throw new Error('fixture refresh failure after build'); },
    () => structuredClone(fallbackPayload),
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

  const malformedResult = runWithSectionFallback(
    () => { throw new Error('fixture refresh failure after malformed build'); },
    () => structuredClone(fallbackPayload),
    {
      label: 'Earnings',
      readFreshOnError: () => ({ rows: 'malformed' }),
      validateFresh: validateEarningsWeekPayload,
      validateFallback: (payload) => validateEarningsWeekPayload(payload.week)
    }
  );

  assert.equal(malformedResult.recovered, undefined);
  assert.deepEqual(malformedResult.payload, fallbackPayload);
}

function testFuturesRefreshFailureKeepsCurrentPartialArtifact() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-futures-recovery-');
  const output = path.join(dir, 'futures_module.json');
  const checkedAt = new Date('2026-07-10T21:05:00.000Z');
  const rows = fixtureFutures();
  for (const failedSymbol of rows.map((row) => row.symbol)) {
    const freshPartial = {
      compiledAt: checkedAt.toISOString(),
      source: 'Yahoo Finance Chart API',
      mode: 'session',
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: checkedAt.toISOString(),
        failures: [{ symbol: failedSymbol, message: 'HTTP 400' }]
      },
      futures: rows.map((row) => row.symbol === failedSymbol ? {
        symbol: row.symbol,
        label: row.label,
        value: 'Unavailable',
        dir: 'flat',
        body: 'Current contract data is unavailable; retrying on the next update.',
        series: [],
        raw: {},
        availability: {
          status: 'unavailable',
          reason: 'source_refresh_failed',
          checkedAt: checkedAt.toISOString(),
          message: 'HTTP 400'
        }
      } : row)
    };
    fs.writeFileSync(output, `${JSON.stringify(freshPartial, null, 2)}\n`);

    const result = runWithSectionFallback(
      () => { throw new Error('fixture refresh failure after build'); },
      () => buildUnavailableFuturesPayload('session', checkedAt),
      {
        label: 'Futures',
        readFreshOnError: () => readCurrentFuturesModuleArtifact('session', checkedAt, output),
        validateFresh: (payload) => validateFuturesPayload(payload, { expectedMode: 'session' }),
        validateFallback: (payload) => validateFuturesPayload(payload, { expectedMode: 'session' })
      }
    );

    assert.equal(result.recovered, true);
    assert.equal(result.fallback, null);
    assert.equal(result.payload.availability.status, 'partial');
    assert.equal(result.payload.futures.find((row) => row.symbol === failedSymbol).value, 'Unavailable');
    assert.deepEqual(
      result.payload.futures.filter((row) => row.symbol !== failedSymbol),
      rows.filter((row) => row.symbol !== failedSymbol)
    );
  }
}

function testFuturesAsOfUsesParentRunTimestamp() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-futures-as-of-');
  const output = path.join(dir, 'futures_module.json');
  const rows = fixtureFutures();
  const asOf = '2026-07-10T21:00:00.000Z';

  return runFutures(['--session', '--output', output, '--as-of', asOf], {
    now: new Date('2026-07-10T21:30:00.000Z'),
    fetchFuture: async (spec) => structuredClone(rows.find((row) => row.symbol === spec.symbol))
  }).then(() => {
    const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(payload.compiledAt, asOf);
    assert.deepEqual(validateFuturesPayload(payload, { expectedMode: 'session' }), []);
  });
}

async function testYahooFetchRetriesRateLimits() {
  let calls = 0;
  const delays = [];
  const payload = { chart: { result: [] } };
  const result = await fetchYahooJsonWithRetry(
    'https://query1.finance.yahoo.com/v8/finance/chart/SPY',
    {
      timeoutMs: 1000,
      yahooRateLimitRetries: 1,
      yahooRateLimitDelayMs: 10
    },
    {},
    {
      fetchJson: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('HTTP 429: Too Many Requests');
          error.statusCode = 429;
          error.headers = { 'retry-after': '2' };
          throw error;
        }
        return payload;
      },
      sleep: async (ms) => {
        delays.push(ms);
      }
    }
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(result, payload);
}

async function testFuturesDownloaderStagesProgressSequentially() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-futures-progress-');
  const output = path.join(dir, 'futures_module.json');
  const rows = fixtureFutures();
  for (const failedSymbol of rows.map((row) => row.symbol)) {
    const writes = [];
    const delays = [];
    let active = 0;
    let maxActive = 0;

    await runFutures(['--session', '--output', output, '--delay-ms', '5', '--as-of', '2026-07-10T21:05:00.000Z'], {
      fetchFuture: async (spec) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (spec.symbol === failedSymbol) throw new Error('fixture rate limit');
        return structuredClone(rows.find((row) => row.symbol === spec.symbol));
      },
      writeJson: (_file, payload) => {
        writes.push(structuredClone(payload));
        fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
      },
      sleep: async (ms) => {
        delays.push(ms);
      }
    });

    const finalPayload = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(maxActive, 1);
    assert.ok(writes.length >= 4);
    assert.equal(writes.at(-1).availability.status, 'partial');
    assert.deepEqual(writes.at(-1), finalPayload);
    assert.equal(finalPayload.futures.find((row) => row.symbol === failedSymbol).value, 'Unavailable');
    assert.deepEqual(
      finalPayload.futures.filter((row) => row.symbol !== failedSymbol),
      rows.filter((row) => row.symbol !== failedSymbol)
    );
    assert.deepEqual(validateFuturesPayload(finalPayload, { expectedMode: 'session' }), []);
    assert.deepEqual(delays, [5, 5, 5]);
  }
}

function testEarningsCalendarBuildAuthorization() {
  const canonicalWeek = { range: { from: '2026-07-13', to: '2026-07-17' }, rows: [] };
  const rolloverRange = { from: '2026-07-17', to: '2026-07-23' };
  assert.deepEqual(
    manualCalendarRolloverRange('afternoon', new Date('2026-07-18T17:00:00.000Z')),
    { from: '2026-07-17', to: '2026-07-23' }
  );
  assert.deepEqual(
    manualCalendarRolloverRange('morning', new Date('2026-07-18T17:00:00.000Z')),
    { from: '2026-07-17', to: '2026-07-23' }
  );
  assert.deepEqual(
    manualCalendarRolloverRange('afternoon', new Date('2026-07-19T17:00:00.000Z')),
    { from: '2026-07-20', to: '2026-07-24' }
  );
  assert.deepEqual(
    manualCalendarRolloverRange('morning', new Date('2026-07-19T17:00:00.000Z')),
    { from: '2026-07-20', to: '2026-07-24' }
  );
  assert.deepEqual(
    activeCalendarRange({ scheduled: false, calendarRolloverRange: rolloverRange }, canonicalWeek.range),
    canonicalWeek.range,
    'An ordinary manual Friday-afternoon run must not infer calendar-build authority from its edition.'
  );
  assert.deepEqual(
    activeCalendarRange({ scheduled: true, calendarRolloverRange: rolloverRange }, canonicalWeek.range),
    rolloverRange
  );
  assert.deepEqual(
    activeCalendarRange({ scheduled: false, rolloverCalendar: true, calendarRolloverRange: rolloverRange }, canonicalWeek.range),
    rolloverRange
  );
  assert.deepEqual(
    earningsTargetRange({ scheduled: false, calendarRolloverRange: rolloverRange }, canonicalWeek),
    canonicalWeek.range,
    'Earnings must use the same active calendar range helper as Week Ahead.'
  );
  const decision = (args, overrides = {}) => earningsCalendarBuildDecision({
    scheduled: false,
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
  assert.deepEqual(
    decision({ calendarRolloverRange: rolloverRange }),
    { build: false, blocked: true, reason: 'manual_build_not_authorized' },
    'A manual edition-derived range is not rollover authority without --rollover-calendar.'
  );
  assert.deepEqual(decision({ rolloverCalendar: true, calendarRolloverRange: rolloverRange }), { build: true, blocked: false, reason: 'explicit_manual_rollover', useEarningsApi: true });
  assert.deepEqual(decision({ scheduled: true, calendarRolloverRange: canonicalWeek.range }), { build: true, blocked: false, reason: 'scheduled_rollover', useEarningsApi: true });
  assert.deepEqual(decision({ scheduled: true }, { failedAttemptNeedsRetry: true }), { build: true, blocked: false, reason: 'scheduled_failed_attempt_retry' });
  assert.deepEqual(
    decision({ scheduled: true }, { invalidPersistedArtifact: true, calendarNeedsBuild: false }),
    { build: true, blocked: false, reason: 'schema_repair', skipEarningsApi: true },
    'Malformed staging must authorize a non-metered schema repair build.'
  );
  assert.deepEqual(
    decision({}, { invalidPersistedArtifact: true, calendarNeedsBuild: false }),
    { build: true, blocked: false, reason: 'schema_repair', skipEarningsApi: true },
    'Manual schema repair must rebuild without EarningsAPI instead of carrying stale-shape data.'
  );
  assert.deepEqual(
    decision({ scheduled: true }, { canonicalWeek: { ...canonicalWeek, availability: { status: 'unavailable' } } }),
    { build: true, blocked: false, reason: 'scheduled_unavailable_retry' }
  );
}

function testZacksBrowserFallbackWarningIsSoftNotice() {
  const messages = [];
  const browserFailurePayload = {
    summary: {
      providerMode: 'legacy_backup',
      zacksGate: {
        ok: false,
        failures: [{
          code: 'zacks_eps_table_unavailable',
          message: "browserType.launch: Executable doesn't exist at /Users/Scott/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"
        }]
      }
    }
  };
  assert.equal(reportZacksBrowserFallbackWarning(browserFailurePayload, (message) => messages.push(message)), true);
  assert.deepEqual(messages, ['Zacks Chromium unavailable; Earnings used backup providers. Run npm run install:browsers.\n']);

  const zacksRefreshFailurePayload = {
    summary: {
      providerMode: 'zacks'
    },
    rows: [{
      sourceAudit: {
        resultRefresh: {
          status: 'partial',
          failures: [{
            provider: 'zacks',
            code: 'provider_request_failed',
            message: "browserType.launch: Executable doesn't exist at /Users/Scott/Projects/Daily Financial Dashboard/node_modules/playwright-core/.local-browsers/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          }]
        }
      }
    }]
  };
  assert.equal(reportZacksBrowserFallbackWarning(zacksRefreshFailurePayload, (message) => messages.push(message)), true);
  assert.equal(messages[1], 'Zacks Chromium unavailable; Earnings retained prior Zacks facts. Run npm run install:browsers.\n');

  const startupFailurePayload = {
    summary: {
      providerMode: 'legacy_backup',
      zacksGate: {
        ok: false,
        failures: [{
          code: 'zacks_eps_table_unavailable',
          message: 'browserType.launch: Target page, context or browser has been closed. <launching> /repo/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell FATAL: Permission denied (1100)'
        }]
      }
    }
  };
  assert.equal(reportZacksBrowserFallbackWarning(startupFailurePayload, (message) => messages.push(message)), true);
  assert.match(messages[2], /Run Prepare with escalated local command execution\./);
  assert.match(messages[2], /Permission denied/);

  const ordinaryZacksFailurePayload = {
    summary: {
      providerMode: 'legacy_backup',
      zacksGate: {
        ok: false,
        failures: [{ code: 'zacks_empty_eligible_slate', message: 'Zacks returned no display-eligible rows after market-cap filtering.' }]
      }
    }
  };
  assert.equal(reportZacksBrowserFallbackWarning(ordinaryZacksFailurePayload, (message) => messages.push(message)), false);
  assert.equal(messages.length, 3);
}

async function testZacksBrowserSoftRepairBeforePrepareIsFailOpen() {
  const missingMessages = [];
  let installCalls = 0;
  const missing = await repairMissingZacksBrowserBeforePrepare({
    checkBrowser: async () => ({
      ok: false,
      kind: 'browser_missing',
      message: "Executable doesn't exist at node_modules/playwright-core/.local-browsers/chromium/chrome"
    }),
    installBrowsers: async () => { installCalls += 1; },
    write: (message) => missingMessages.push(message)
  });
  assert.equal(missing.repairAttempted, true);
  assert.equal(missing.repairSucceeded, true);
  assert.equal(installCalls, 1);
  assert.deepEqual(missingMessages, ['Zacks Chromium missing; running npm run install:browsers before Prepare.\n']);

  const failedInstallMessages = [];
  const failedInstall = await repairMissingZacksBrowserBeforePrepare({
    checkBrowser: async () => ({
      ok: false,
      kind: 'browser_missing',
      message: "Executable doesn't exist at node_modules/playwright-core/.local-browsers/chromium/chrome"
    }),
    installBrowsers: async () => { throw new Error('fixture install failure'); },
    write: (message) => failedInstallMessages.push(message)
  });
  assert.equal(failedInstall.repairAttempted, true);
  assert.equal(failedInstall.repairSucceeded, false);
  assert.equal(failedInstall.repairError, 'fixture install failure');
  assert.deepEqual(failedInstallMessages, [
    'Zacks Chromium missing; running npm run install:browsers before Prepare.\n',
    'Zacks Chromium auto-repair failed; continuing Prepare. fixture install failure\n'
  ]);

  const sandboxMessages = [];
  let sandboxInstallCalls = 0;
  const sandbox = await repairMissingZacksBrowserBeforePrepare({
    checkBrowser: async () => ({
      ok: false,
      kind: 'startup_failed',
      message: 'Operation not permitted by the managed sandbox.'
    }),
    installBrowsers: async () => { sandboxInstallCalls += 1; },
    write: (message) => sandboxMessages.push(message)
  });
  assert.equal(sandbox.repairAttempted, false);
  assert.equal(sandboxInstallCalls, 0);
  assert.deepEqual(sandboxMessages, [
    'Zacks Chromium unavailable; continuing Prepare. Run Prepare with escalated local command execution. Diagnostic: Operation not permitted by the managed sandbox.\n'
  ]);

  const dependencyMessages = [];
  let dependencyInstallCalls = 0;
  const dependency = await repairMissingZacksBrowserBeforePrepare({
    checkBrowser: async () => ({
      ok: false,
      kind: 'dependency_missing',
      message: 'Playwright dependency is unavailable for Zacks browser fetch.'
    }),
    installBrowsers: async () => { dependencyInstallCalls += 1; },
    write: (message) => dependencyMessages.push(message)
  });
  assert.equal(dependency.repairAttempted, false);
  assert.equal(dependencyInstallCalls, 0);
  assert.deepEqual(dependencyMessages, [
    'Zacks Chromium unavailable; continuing Prepare. Run npm install, then npm run install:browsers. Diagnostic: Playwright dependency is unavailable for Zacks browser fetch.\n'
  ]);
}

function testWeekAheadPreparationUsesCanonicalRangeForManualRefresh() {
  const canonicalRange = { from: '2026-07-13', to: '2026-07-17' };
  const rolloverRange = { from: '2026-07-17', to: '2026-07-23' };
  const canonicalWeekAhead = normalizeWeekAhead(tradingViewCalendarFixture(), {
    range: canonicalRange,
    now: new Date('2026-07-13T12:00:00Z')
  });

  const manualPreparation = weekAheadPreparationCommandArgs({
    scheduled: false,
    rolloverCalendar: false,
    calendarRolloverRange: rolloverRange
  }, canonicalWeekAhead);
  assert.deepEqual(manualPreparation.targetRange, canonicalWeekAhead.range);
  assert.deepEqual(
    manualPreparation.commandArgs,
    ['scripts/fetch_week_ahead.js', '--date', canonicalRange.from],
    'A normal manual refresh must not reuse a pre-rolled Week Ahead staging artifact.'
  );

  const matchingManualPreparation = weekAheadPreparationCommandArgs({
    scheduled: false,
    rolloverCalendar: false,
    calendarRolloverRange: rolloverRange
  }, canonicalWeekAhead);
  assert.deepEqual(
    matchingManualPreparation.commandArgs,
    ['scripts/fetch_week_ahead.js', '--date', canonicalRange.from],
    'Every Prepare refresh must replace the complete TradingView range.'
  );

  const rolloverPreparation = weekAheadPreparationCommandArgs({
    scheduled: false,
    rolloverCalendar: true,
    calendarRolloverRange: rolloverRange
  }, canonicalWeekAhead);
  assert.deepEqual(rolloverPreparation.targetRange, rolloverRange);
  assert.deepEqual(rolloverPreparation.commandArgs, ['scripts/fetch_week_ahead.js', '--date', rolloverRange.from]);
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
  commitDashboardCandidate({ dashboard: dashboardFile }, nextHtml, {
    refreshLastGood: true,
    lastGoodPath: lastGoodFile
  });
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
  assert.doesNotThrow(() => commitDashboardCandidate(
    { dashboard: dashboardFile },
    committedHtml,
    {
      refreshLastGood: true,
      lastGoodPath: snapshotFile,
      snapshotWriter: () => { throw new Error('fixture synchronization failure'); }
    }
  ));
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), committedHtml, 'Post-commit synchronization failure must not roll back the validated dashboard.');
  assert.equal(fs.existsSync(snapshotFile), false);

  commitDashboardCandidate(
    { dashboard: dashboardFile },
    committedHtml,
    { refreshLastGood: true, lastGoodPath: snapshotFile }
  );
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
        ...(task.key === 'totalMarketCap' ? { dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' } } : {}),
        stat: task.key === 'fearGreed'
          ? { sym: 'F&G', name: task.name, sub: 'Greed', price: '55', delta: '+5', chg: '+5', dir: 'up' }
          : { sym: 'TOTAL', name: task.name, sub: 'Expanding', price: '$2.00T', delta: '+$0.10T', chg: '+5.00%', dir: 'up' }
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
      ...(task.key === 'totalMarketCap' ? { dominance: { btc: '54.00%', eth: '11.00%', others: '35.00%' } } : {}),
      stat: task.key === 'fearGreed'
        ? { sym: 'F&G', name: task.name, sub: 'Greed', price: '56', delta: '+1', chg: '+1', dir: 'up' }
        : task.key === 'altcoinSeason'
          ? { sym: 'ALTSEASON', name: task.name, sub: 'Bitcoin Season', price: '30', delta: '+5', chg: '/100', dir: 'up' }
          : { sym: 'TOTAL', name: task.name, sub: 'Expanding', price: '$2.10T', delta: '+$0.10T', chg: '+5.00%', dir: 'up' }
    })
  });
  assert.equal(recovered.availability, undefined);
  assert.ok(recovered.stats.every((row) => row.availability === undefined));
  assert.deepEqual(recovered.dominance, { btc: '54.00%', eth: '11.00%', others: '35.00%' });
  assert.deepEqual(validateCryptoStatsPayload(recovered), []);

  const totalFailure = await fetchCryptoStatsPartial({ input, timeoutMs: 1000, lookbackDays: 31 }, {
    now: new Date('2026-07-10T21:15:00.000Z'),
    collectProvider: async (task) => {
      if (task.key === 'totalMarketCap') throw new Error('fixture total provider failure');
      return {
        source: 'Fixture provider',
        stat: task.key === 'fearGreed'
          ? { sym: 'F&G', name: task.name, sub: 'Greed', price: '57', delta: '+1', chg: '+1', dir: 'up' }
          : { sym: 'ALTSEASON', name: task.name, sub: 'Bitcoin Season', price: '31', delta: '+1', chg: '/100', dir: 'up' }
      };
    }
  });
  assert.equal(totalFailure.stats.find((row) => row.sym === 'TOTAL').availability.status, 'carried_forward');
  assert.equal(totalFailure.dominance.availability.status, 'carried_forward');
  assert.deepEqual(validateCryptoStatsPayload(totalFailure), []);
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

  const weekendData = dashboardFixture();
  weekendData.footer = { compiled: 'Compiled old run · Market data: Incorrect inherited source list' };
  applyEditionMetadata(weekendData, 'afternoon', new Date('2026-07-19T15:00:00.000Z'));
  assert.equal(weekendData.masthead.edition, 'Weekend Edition');
  assert.equal(weekendData.futuresModule.sectionTitle, 'Session Futures');
  assert.equal(weekendData.footer.compiled, 'Compiled Sunday, July 19, 2026 at 10:00 AM CDT');

  applyAssetAllocationPortfolio(data, {
    compiledAt: '2026-07-06T13:00:00.000Z',
    source: 'fixture',
    month: '2026-07',
    rows: fixturePortfolioRows()
  });
  assert.equal(data.assetAllocationPortfolio.compiledAt, '2026-07-06T13:00:00.000Z');
  assert.equal(data.assetAllocationPortfolio.rows[0].ticker, 'VTI');

  applyAssetAllocationSummary(data, {
    asOf: '2026-07-06',
    portfolioMtdReturnValue: 1.23,
    status: 'available',
    stale: false
  });
  assert.equal(data.assetAllocationPortfolio.portfolioMtdReturnAsOf, '2026-07-06');
  assert.equal(data.assetAllocationPortfolio.portfolioMtdReturnValue, 1.23);
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
  const assetWithoutSectionDiagnostics = structuredClone(partial);
  delete assetWithoutSectionDiagnostics.availability;
  assert.match(validateAssetAllocationPortfolioPayload(assetWithoutSectionDiagnostics).join('\n'), /cannot contain row availability markers/);
  const assetDuplicateFailure = structuredClone(partial);
  assetDuplicateFailure.availability.failures.push(structuredClone(assetDuplicateFailure.availability.failures[0]));
  assert.match(validateAssetAllocationPortfolioPayload(assetDuplicateFailure).join('\n'), /duplicate ticker VTI/);

  for (const [label, malformedRow] of [
    ['null', null],
    ['wrong type', 'malformed'],
    ['invalid dividend', {
      ...structuredClone(rows[0]),
      monthDivPerShareValue: 0,
      dividends: [{ exDate: '2026-07-10', amount: -0.4 }]
    }]
  ]) {
    fs.writeFileSync(input, originalInput);
    const fulfilledMalformed = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
      now: new Date('2026-07-10T21:05:30.000Z'),
      fetchHolding: async (holding) => holding.symbol === 'VTI'
        ? structuredClone(malformedRow)
        : structuredClone(rows.find((row) => row.ticker === holding.symbol))
    });
    assert.equal(fulfilledMalformed.availability.status, 'partial', `${label} fulfilled data must isolate as a partial result.`);
    assert.deepEqual(fulfilledMalformed.availability.failures.map((failure) => failure.ticker), ['VTI']);
    assert.equal(fulfilledMalformed.rows.find((row) => row.ticker === 'VTI').availability.status, 'carried_forward');
    assert.ok(
      fulfilledMalformed.rows.filter((row) => row.ticker !== 'VTI').every((row) => row.availability === undefined),
      `${label} fulfilled data must leave unrelated tickers fresh.`
    );
    assert.deepEqual(validateAssetAllocationPortfolioPayload(fulfilledMalformed), []);
  }

  const priorStateCases = [
    ['carried-forward', (priorDashboard) => {
      priorDashboard.assetAllocationPortfolio.rows[0].availability = {
        status: 'carried_forward',
        reason: 'source_refresh_failed',
        checkedAt: '2026-07-10T20:55:00.000Z',
        lastValidatedAt: '2026-07-10T20:50:00.000Z'
      };
    }, 'carried_forward'],
    ['unavailable', (priorDashboard) => {
      const priorRow = priorDashboard.assetAllocationPortfolio.rows[0];
      for (const key of ['price', 'dailyPriceChange', 'dailyTR', 'mtdPriceChange', 'mtdTR']) priorRow[key] = 'Unavailable';
      priorRow.availability = {
        status: 'unavailable',
        reason: 'source_refresh_failed',
        checkedAt: '2026-07-10T20:55:00.000Z'
      };
    }, 'unavailable'],
    ['malformed', (priorDashboard) => {
      priorDashboard.assetAllocationPortfolio.rows[0].availability = {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: '2026-07-10T20:55:00.000Z'
      };
    }, 'unavailable']
  ];
  for (const [priorLabel, mutatePrior, expectedStatus] of priorStateCases) {
    for (const [freshLabel, failedFreshRow] of [
      ['rejected', null],
      ['fulfilled-malformed', 'malformed']
    ]) {
      const priorDashboard = structuredClone(dashboard);
      mutatePrior(priorDashboard);
      fs.writeFileSync(input, renderDashboardValidationFixture(priorDashboard, chartData));
      const transition = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
        now: new Date('2026-07-10T21:05:40.000Z'),
        fetchHolding: async (holding) => {
          if (holding.symbol !== 'VTI') return structuredClone(rows.find((row) => row.ticker === holding.symbol));
          if (freshLabel === 'rejected') throw new Error('fixture holding failure');
          return failedFreshRow;
        }
      });
      assert.equal(
        transition.rows.find((row) => row.ticker === 'VTI').availability.status,
        expectedStatus,
        `${freshLabel} fresh data with a ${priorLabel} prior row must resolve to ${expectedStatus}.`
      );
      assert.ok(
        transition.rows.filter((row) => row.ticker !== 'VTI').every((row) => row.availability === undefined),
        `${freshLabel} fresh data with a ${priorLabel} prior row must leave unrelated tickers fresh.`
      );
      assert.deepEqual(validateAssetAllocationPortfolioPayload(transition), []);
      if (expectedStatus === 'unavailable') {
        const embeddedTransition = structuredClone(dashboard);
        applyAssetAllocationPortfolio(embeddedTransition, transition);
        for (const validationMode of ['published', 'staged']) {
          const validation = validateDashboardAndChartFixture(embeddedTransition, chartData, validationMode);
          assert.equal(validation.status, 0, `${validationMode} ${freshLabel}/${priorLabel}: ${validation.stderr}`);
        }
      }
    }
  }

  const unavailablePriorDashboard = structuredClone(dashboard);
  priorStateCases[1][1](unavailablePriorDashboard);
  fs.writeFileSync(input, renderDashboardValidationFixture(unavailablePriorDashboard, chartData));
  const freshOverUnavailable = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-07-10T21:05:42.000Z'),
    fetchHolding: async (holding) => structuredClone(rows.find((row) => row.ticker === holding.symbol))
  });
  assert.ok(freshOverUnavailable.rows.every((row) => row.availability === undefined));
  assert.deepEqual(validateAssetAllocationPortfolioPayload(freshOverUnavailable), []);

  const missingPriorDashboard = structuredClone(dashboard);
  missingPriorDashboard.assetAllocationPortfolio.rows = missingPriorDashboard.assetAllocationPortfolio.rows
    .filter((row) => row.ticker !== 'VTI');
  fs.writeFileSync(input, renderDashboardValidationFixture(missingPriorDashboard, chartData));
  const missingPriorPartial = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-07-10T21:05:45.000Z'),
    fetchHolding: async (holding) => {
      if (holding.symbol === 'VTI') throw new Error('fixture holding failure');
      return structuredClone(rows.find((row) => row.ticker === holding.symbol));
    }
  });
  assert.equal(missingPriorPartial.rows.find((row) => row.ticker === 'VTI').availability.status, 'unavailable');
  assert.ok(missingPriorPartial.rows.filter((row) => row.ticker !== 'VTI').every((row) => row.availability === undefined));
  assert.deepEqual(validateAssetAllocationPortfolioPayload(missingPriorPartial), []);

  const staleCanonicalDashboard = structuredClone(dashboard);
  staleCanonicalDashboard.assetAllocationPortfolio.month = '2026-07';
  staleCanonicalDashboard.assetAllocationPortfolio.compiledAt = '2026-07-10T20:55:00.000Z';
  staleCanonicalDashboard.assetAllocationPortfolio.rows[0].availability = {
    status: 'carried_forward',
    reason: 'source_refresh_failed',
    checkedAt: '2026-07-10T20:55:00.000Z',
    lastValidatedAt: '2026-08-01T12:00:00.000Z'
  };
  fs.writeFileSync(input, renderDashboardValidationFixture(staleCanonicalDashboard, chartData));
  const stalePriorPartial = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-07-10T21:06:00.000Z'),
    fetchHolding: async (holding) => {
      if (holding.symbol === 'VTI') throw new Error('fixture holding failure');
      return structuredClone(rows.find((row) => row.ticker === holding.symbol));
    }
  });
  assert.equal(stalePriorPartial.availability.status, 'partial');
  assert.equal(stalePriorPartial.rows.find((row) => row.ticker === 'VTI').availability.status, 'unavailable');
  assert.equal(stalePriorPartial.rows.find((row) => row.ticker === 'VEA').availability, undefined);
  assert.deepEqual(validateAssetAllocationPortfolioPayload(stalePriorPartial), []);
  fs.writeFileSync(input, originalInput);

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

  const edgeObserved = [];
  const edgeRows = await fetchPortfolioRows({ input, timeoutMs: 1000 }, {
    now: new Date('2026-08-01T04:30:00.000Z'),
    fetchHolding: async (holding, _args, period1, period2, monthStart, _now, currentMonthEnd, lookaheadEndExclusive) => {
      if (!edgeObserved.length) {
        edgeObserved.push({
          period1,
          period2,
          monthStart: monthStart.toISOString().slice(0, 10),
          currentMonthEnd: currentMonthEnd.toISOString().slice(0, 10),
          lookaheadEndExclusive: lookaheadEndExclusive.toISOString().slice(0, 10)
        });
      }
      return structuredClone(rows.find((row) => row.ticker === holding.symbol));
    }
  });
  assert.equal(edgeRows.month, '2026-07');
  assert.deepEqual(edgeObserved[0], {
    period1: Math.floor(Date.UTC(2026, 5, 20) / 1000),
    period2: Math.floor(Date.UTC(2026, 8, 1) / 1000),
    monthStart: '2026-07-01',
    currentMonthEnd: '2026-07-31',
    lookaheadEndExclusive: '2026-09-01'
  });
}

async function testAssetAllocationYahooMalformedLatestRowRetries() {
  const holding = { symbol: 'VTI', sleeve: 'U.S. total market equity', swatch: 'vti' };
  const monthStart = new Date('2026-07-01T00:00:00.000Z');
  const now = new Date('2026-07-24T21:00:00.000Z');
  const currentMonthEnd = new Date('2026-07-31T00:00:00.000Z');
  const lookaheadEndExclusive = new Date('2026-09-01T00:00:00.000Z');
  const malformedLatest = assetYahooPayload([
    { date: '2026-06-30', close: 99, adjclose: 99 },
    { date: '2026-07-23', close: 100, adjclose: 100 },
    { date: '2026-07-24', close: null, adjclose: null }
  ], 101);
  const repaired = assetYahooPayload([
    { date: '2026-06-30', close: 99, adjclose: 99 },
    { date: '2026-07-23', close: 100, adjclose: 100 },
    { date: '2026-07-24', close: 101, adjclose: 101 }
  ], 101);
  const dividendPayload = structuredClone(repaired);
  dividendPayload.chart.result[0].events.dividends = {
    current: { date: Math.floor(Date.parse('2026-07-10T12:00:00Z') / 1000), amount: 0.4 },
    upcoming: { date: Math.floor(Date.parse('2026-07-30T12:00:00Z') / 1000), amount: 0.5 },
    future: { date: Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000), amount: 0.6 }
  };
  const dividendRow = parseHolding(holding, dividendPayload, monthStart, now, currentMonthEnd, lookaheadEndExclusive);
  assert.deepEqual(dividendRow.dividends, [{ exDate: '2026-07-10', amount: 0.4 }]);
  assert.equal(dividendRow.monthDivPerShareValue, 0.4);
  assert.deepEqual(dividendRow.upcomingCurrentMonthDividendEvents, [{ exDate: '2026-07-30', amount: 0.5 }]);
  assert.equal(dividendRow.upcomingCurrentMonthDividendsValue, 0.5);
  assert.deepEqual(dividendRow.futureMonthDividendEvents, [{ exDate: '2026-08-10', amount: 0.6 }]);
  assert.equal(dividendRow.futureMonthDividendsValue, 0.6);
  assert.equal(dividendRow.monthDivPerShare, undefined);
  assert.equal(dividendRow.upcomingCurrentMonthDividends, undefined);
  assert.equal(dividendRow.futureMonthDividends, undefined);

  assert.throws(
    () => parseHolding(holding, malformedLatest, monthStart, now, currentMonthEnd, lookaheadEndExclusive),
    /latest Yahoo price row for 2026-07-24 is missing usable close or adjusted close/
  );

  let requestCount = 0;
  const delays = [];
  const row = await fetchHolding(holding, {
    timeoutMs: 1000,
    fetchJson: async () => {
      requestCount += 1;
      return requestCount === 1 ? malformedLatest : repaired;
    },
    sleep: async (milliseconds) => delays.push(milliseconds)
  }, 0, 0, monthStart, now, currentMonthEnd, lookaheadEndExclusive);

  assert.equal(requestCount, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(row.ticker, 'VTI');
  assert.equal(row.price, '$101.00');
  assert.equal(row.dailyTR, '+1.00%');
  assert.notEqual(row.dailyTR, '-100.00%');

  let failedRequestCount = 0;
  await assert.rejects(
    () => fetchHolding(holding, {
      timeoutMs: 1000,
      fetchJson: async () => {
        failedRequestCount += 1;
        return malformedLatest;
      },
      sleep: async () => {}
    }, 0, 0, monthStart, now, currentMonthEnd, lookaheadEndExclusive),
    /latest Yahoo price row for 2026-07-24 is missing usable close or adjusted close/
  );
  assert.equal(failedRequestCount, 2);
}

function testAssetAllocationDividendValidation() {
  const valid = {
    compiledAt: '2026-07-24T21:00:00.000Z',
    source: 'Yahoo Finance Chart API',
    month: '2026-07',
    rows: fixturePortfolioRows()
  };
  Object.assign(valid.rows[0], {
    monthDivPerShare: '$0.40',
    monthDivPerShareValue: 0.4,
    dividends: [{ exDate: '2026-07-10', amount: 0.4 }],
    upcomingCurrentMonthDividends: '$0.50',
    upcomingCurrentMonthDividendsValue: 0.5,
    upcomingCurrentMonthDividendEvents: [{ exDate: '2026-07-30', amount: 0.5 }],
    futureMonthDividends: '$0.60',
    futureMonthDividendsValue: 0.6,
    futureMonthDividendEvents: [{ exDate: '2026-08-10', amount: 0.6 }]
  });
  assert.deepEqual(validateAssetAllocationPortfolioPayload(valid), []);

  const carriedForward = structuredClone(valid);
  carriedForward.compiledAt = '2026-07-28T21:00:00.000Z';
  carriedForward.availability = {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt: carriedForward.compiledAt,
    failures: [{ ticker: 'VTI', message: 'fixture holding failure' }]
  };
  carriedForward.rows[0].upcomingCurrentMonthDividendEvents = [{ exDate: '2026-07-25', amount: 0.5 }];
  carriedForward.rows[0].availability = {
    status: 'carried_forward',
    reason: 'source_refresh_failed',
    checkedAt: carriedForward.compiledAt,
    lastValidatedAt: valid.compiledAt
  };
  assert.deepEqual(
    validateAssetAllocationPortfolioPayload(carriedForward),
    [],
    'Carried-forward dividend buckets must use the row lastValidatedAt observation date.'
  );

  const carriedAcrossMonth = structuredClone(carriedForward);
  carriedAcrossMonth.rows[0].availability.lastValidatedAt = '2026-08-01T12:00:00.000Z';
  assert.match(
    validateAssetAllocationPortfolioPayload(carriedAcrossMonth).join('\n'),
    /lastValidatedAt must fall within the dashboard month/,
    'Carried-forward portfolio rows must not validate against a future-month observation date.'
  );

  const futureInCurrent = structuredClone(valid);
  futureInCurrent.rows[0].dividends = [{ exDate: '2026-08-10', amount: 0.6 }];
  futureInCurrent.rows[0].monthDivPerShareValue = 0.6;
  assert.match(validateAssetAllocationPortfolioPayload(futureInCurrent).join('\n'), /does not belong in the current dividend bucket/);

  const currentInFuture = structuredClone(valid);
  currentInFuture.rows[0].futureMonthDividendEvents = [{ exDate: '2026-07-10', amount: 0.4 }];
  currentInFuture.rows[0].futureMonthDividendsValue = 0.4;
  assert.match(validateAssetAllocationPortfolioPayload(currentInFuture).join('\n'), /does not belong in the future dividend bucket/);

  const invalidDate = structuredClone(valid);
  invalidDate.rows[0].dividends[0].exDate = '2026-02-30';
  assert.match(validateAssetAllocationPortfolioPayload(invalidDate).join('\n'), /dividends\[0\]\.exDate must be an ISO date/);

  const negativeAmount = structuredClone(valid);
  negativeAmount.rows[0].dividends[0].amount = -0.4;
  negativeAmount.rows[0].monthDivPerShareValue = 0;
  assert.match(validateAssetAllocationPortfolioPayload(negativeAmount).join('\n'), /amount must be a finite non-negative number/);

  const nonNumericAmount = structuredClone(valid);
  nonNumericAmount.rows[0].dividends[0].amount = '0.4';
  nonNumericAmount.rows[0].monthDivPerShareValue = 0;
  assert.match(validateAssetAllocationPortfolioPayload(nonNumericAmount).join('\n'), /amount must be a finite non-negative number/);

  const inconsistentTotal = structuredClone(valid);
  inconsistentTotal.rows[0].monthDivPerShareValue = 99;
  assert.match(validateAssetAllocationPortfolioPayload(inconsistentTotal).join('\n'), /monthDivPerShareValue must equal the sum of dividends/);

  const missingEvents = structuredClone(valid);
  delete missingEvents.rows[0].upcomingCurrentMonthDividendEvents;
  assert.match(validateAssetAllocationPortfolioPayload(missingEvents).join('\n'), /upcomingCurrentMonthDividendEvents must be an array/);
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
  const preparedFallback = runWithSectionFallback(
    () => shortRoster,
    () => buildUnavailableFuturesPayload('session', FIXTURE_NOW),
    {
      label: 'Futures fixture',
      validateFresh: (payload) => validateFuturesPayload(payload, { expectedMode: 'session' }),
      validateFallback: (payload) => validateFuturesPayload(payload, { expectedMode: 'session' }),
      buildUnavailable: () => buildUnavailableFuturesPayload('session', FIXTURE_NOW)
    }
  );
  applyFuturesModule(fallbackDashboard, preparedFallback.payload, 'afternoon');
  assert.equal(fallbackDashboard.futuresModule.availability.status, 'unavailable');
  assert.deepEqual(fallbackDashboard.futuresModule.futures, []);

  const chartPayload = (timestamps, closes, meta = {}) => ({
    chart: {
      result: [{
        meta: {
          chartPreviousClose: 100,
          regularMarketPrice: 101,
          regularMarketTime: Date.parse('2026-07-19T05:22:14.000Z') / 1000,
          ...meta
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }] }
      }]
    }
  });
  const sessionBars = (isoDate) => {
    const open = Date.parse(`${isoDate}T13:30:00.000Z`) / 1000;
    return Array.from({ length: 13 }, (_item, index) => open + index * 5 * 60);
  };
  const fallbackRow = parseFuture(
    { symbol: 'ES=F', label: 'S&P Futures' },
    chartPayload([], []),
    { mode: 'premarket' },
    chartPayload(
      [
        ...sessionBars('2026-07-16'),
        ...sessionBars('2026-07-17')
      ],
      [
        ...Array.from({ length: 13 }, (_item, index) => 99 + index / 12),
        ...Array.from({ length: 13 }, (_item, index) => 100 + index / 12)
      ]
    ),
    new Date('2026-07-19T05:22:14.000Z')
  );
  assert.equal(fallbackRow.raw.sessionDate, '2026-07-17');
  assert.equal(fallbackRow.raw.referenceDate, '2026-07-16');
  assert.equal(fallbackRow.raw.referenceLabel, '4 PM ET close');
  assert.equal(fallbackRow.series.length, 13);

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
  const futuresWithoutSectionDiagnostics = structuredClone(partial);
  delete futuresWithoutSectionDiagnostics.availability;
  assert.match(validateFuturesPayload(futuresWithoutSectionDiagnostics).join('\n'), /require partial section availability diagnostics/);
  const futuresDuplicateFailure = structuredClone(partial);
  futuresDuplicateFailure.availability.failures.push(structuredClone(futuresDuplicateFailure.availability.failures[0]));
  assert.match(validateFuturesPayload(futuresDuplicateFailure).join('\n'), /duplicate symbol NQ=F/);
  const allUnavailablePartial = structuredClone(partial);
  const unavailableTemplate = partial.futures.find((row) => row.symbol === 'NQ=F');
  allUnavailablePartial.futures = partial.futures.map((row) => ({
    ...structuredClone(unavailableTemplate),
    symbol: row.symbol,
    label: row.label
  }));
  allUnavailablePartial.availability.failures = allUnavailablePartial.futures.map((row) => ({
    symbol: row.symbol,
    message: 'fixture contract failure'
  }));
  assert.match(validateFuturesPayload(allUnavailablePartial).join('\n'), /at least one available current-run row/);
  const { dashboard: partialDashboard, chartData: partialChartData } = createDashboardValidationFixture();
  applyFuturesModule(partialDashboard, partial, 'afternoon');
  assert.equal(validateDashboardAndChartFixture(partialDashboard, partialChartData).status, 0);

  await runFutures(['--session', '--output', output], {
    now: new Date('2026-07-10T21:07:00.000Z'),
    fetchFuture: async () => { throw new Error('fixture contract failure'); },
    sleep: async () => {}
  });
  const unavailable = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(unavailable.availability.status, 'unavailable');
  assert.deepEqual(unavailable.futures, []);
  assert.deepEqual(validateFuturesPayload(unavailable, { expectedMode: 'session' }), []);

  await runFutures(['--session', '--output', output], {
    now: new Date('2026-07-10T21:10:00.000Z'),
    fetchFuture: async (spec) => structuredClone(rows.find((row) => row.symbol === spec.symbol))
  });
  const recovered = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(recovered.availability, undefined);
  assert.deepEqual(recovered.futures, rows);
  assert.deepEqual(validateFuturesPayload(recovered, { expectedMode: 'session' }), []);
}

function testPrepareFallbackAndUnavailableContracts() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const malformedPortfolio = {
    compiledAt: FIXTURE_NOW,
    source: 'Yahoo Finance Chart API',
    month: '2026-07',
    rows: ['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX'].map((ticker) => ({ ticker }))
  };
  const malformedPortfolioErrors = validateAssetAllocationPortfolioPayload(malformedPortfolio);
  assert.match(malformedPortfolioErrors.join('\n'), /rows\[0\]\.sleeve must be a populated string/);
  const duplicatePortfolio = structuredClone(malformedPortfolio);
  duplicatePortfolio.rows = fixturePortfolioRows();
  duplicatePortfolio.rows[7] = structuredClone(duplicatePortfolio.rows[0]);
  const duplicatePortfolioErrors = validateAssetAllocationPortfolioPayload(duplicatePortfolio).join('\n');
  assert.match(duplicatePortfolioErrors, /duplicate ticker VTI/);
  assert.match(duplicatePortfolioErrors, /is missing BOXX/);
  const portfolioResult = runWithSectionFallback(
    () => malformedPortfolio,
    () => buildAssetAllocationFallback(malformedPortfolio, { month: '2026-07', asOf: '2026-07-10', checkedAt: FIXTURE_NOW }),
    {
      label: 'Asset Allocation fixture',
      validateFresh: validateAssetAllocationPortfolioPayload,
      validateFallback: validateAssetAllocationPortfolioPayload,
      buildUnavailable: () => buildAssetAllocationFallback({}, { month: '2026-07', asOf: '2026-07-10', checkedAt: FIXTURE_NOW })
    }
  );
  assert.equal(portfolioResult.payload.availability.status, 'unavailable');
  assert.deepEqual(portfolioResult.payload.rows, []);

  const malformedCrypto = {
    statsFetchedAt: FIXTURE_NOW,
    stats: ['F&G', 'ALTSEASON', 'TOTAL'].map((sym) => ({ sym })),
    dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' }
  };
  assert.match(validateCryptoStatsPayload({ fetchedAt: FIXTURE_NOW, ...malformedCrypto }).join('\n'), /stats\[0\]\.name must be a string/);
  const validCrypto = {
    fetchedAt: FIXTURE_NOW,
    stats: structuredClone(dashboard.crypto.stats),
    dominance: structuredClone(dashboard.crypto.dominance)
  };
  assert.deepEqual(validateCryptoStatsPayload(validCrypto), []);
  const malformedDominance = structuredClone(validCrypto);
  malformedDominance.dominance.btc = '55.00% trailing';
  assert.match(validateCryptoStatsPayload(malformedDominance).join('\n'), /dominance must contain BTC, ETH, and others percentages/);
  const inconsistentCarry = {
    ...structuredClone(validCrypto),
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  };
  assert.match(validateCryptoStatsPayload(inconsistentCarry).join('\n'), /requires an availability marker on every row/);
  const inconsistentUnavailable = {
    fetchedAt: FIXTURE_NOW,
    stats: [],
    dominance: structuredClone(validCrypto.dominance),
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  };
  assert.match(validateCryptoStatsPayload(inconsistentUnavailable).join('\n'), /requires unavailable dominance/);
  const cryptoResult = runWithSectionFallback(
    () => ({ fetchedAt: FIXTURE_NOW, ...malformedCrypto }),
    () => buildCryptoStatsFallback(malformedCrypto, FIXTURE_NOW),
    {
      label: 'Crypto fixture',
      validateFresh: validateCryptoStatsPayload,
      validateFallback: validateCryptoStatsPayload,
      buildUnavailable: () => buildCryptoStatsFallback({}, FIXTURE_NOW)
    }
  );
  assert.equal(cryptoResult.payload.availability.status, 'unavailable');
  assert.deepEqual(cryptoResult.payload.stats, []);

  const chartResult = runWithSectionFallback(
    () => ({ schemaVersion: 1, series: [{ ticker: 'SPX' }] }),
    () => buildChartDataFallback({ schemaVersion: 1, series: [{ ticker: 'SPX' }] }, FIXTURE_NOW),
    {
      label: 'Chart and Tape fixture',
      validateFresh: (payload) => validateChartStagingPayload(payload, dashboard.tape.rows),
      validateFallback: (payload) => validateChartStagingPayload(payload, dashboard.tape.rows),
      buildUnavailable: () => buildUnavailableChartData(FIXTURE_NOW)
    }
  );
  assert.equal(chartResult.payload.availability.status, 'unavailable');
  assert.deepEqual(chartResult.payload.series, []);
  syncDashboardPricesFromChartData(dashboard, chartResult.payload, { now: new Date(FIXTURE_NOW) });
  assert.equal(dashboard.tape.availability.status, 'unavailable');
  assert.deepEqual(dashboard.tape.rows, []);

  const earningsRange = { from: '2026-07-10', to: '2026-07-16' };
  const malformedEarningsWeek = {
    ...fixtureEarningsWeek(),
    range: earningsRange,
    rows: 'malformed'
  };
  const earningsResult = runWithSectionFallback(
    () => malformedEarningsWeek,
    () => buildEarningsPreparationFallback(malformedEarningsWeek, earningsRange, { checkedAt: FIXTURE_NOW }),
    {
      label: 'Earnings fixture',
      validateFresh: validateEarningsWeekPayload,
      validateFallback: (payload) => validateEarningsWeekPayload(payload.week),
      buildUnavailable: () => buildEarningsPreparationFallback(null, earningsRange, { checkedAt: FIXTURE_NOW })
    }
  );
  assert.equal(earningsResult.payload.mode, 'unavailable');
  assert.equal(earningsResult.payload.week.availability.status, 'unavailable');
  assert.deepEqual(validateEarningsWeekPayload(earningsResult.payload.week), []);

  const result = validateDashboardHtml(renderDashboardValidationFixture(dashboard, compactChartPayload(chartResult.payload)), {
    now: new Date(FIXTURE_NOW),
    validationMode: 'staged'
  });
  assert.deepEqual(result.errors, []);

  const datelineOnlyGeneralNews = createDashboardValidationFixture().dashboard;
  delete datelineOnlyGeneralNews.stories[0].publishedAt;
  for (const validationMode of ['staged', 'published']) {
    const datelineOnlyResult = validateDashboardHtml(renderDashboardValidationFixture(datelineOnlyGeneralNews, chartData), {
      now: new Date(FIXTURE_NOW),
      validationMode
    });
    assert.deepEqual(datelineOnlyResult.errors, [], `General News may publish a verified dateline date without fabricating an original timestamp in ${validationMode} mode.`);
  }

  for (const malformedPublishedAt of [null, 42, [], {}, '', 'not-a-time', '2026-07-10', '2026-07-10T13:30:00']) {
    const malformedGeneralNews = createDashboardValidationFixture().dashboard;
    malformedGeneralNews.stories[0].publishedAt = malformedPublishedAt;
    const malformedPublishedAtResult = validateDashboardHtml(renderDashboardValidationFixture(malformedGeneralNews, chartData), {
      now: new Date(FIXTURE_NOW),
      validationMode: 'staged'
    });
    assert.match(
      malformedPublishedAtResult.errors.join('\n'),
      /stories\[0\]\.publishedAt must be an offset-bearing ISO timestamp/,
      'Malformed optional precision must not pass staged validation.'
    );
  }

  const missingSourceLabelDashboard = createDashboardValidationFixture().dashboard;
  delete missingSourceLabelDashboard.stories[0].sourceLabel;
  const missingSourceResult = validateDashboardHtml(renderDashboardValidationFixture(missingSourceLabelDashboard, chartData), {
    now: new Date(FIXTURE_NOW),
    validationMode: 'staged'
  });
  assert.match(missingSourceResult.errors.join('\n'), /stories\[0\]\.sourceLabel must be populated/);
}

function testEarningsCommentaryPublicationNormalization() {
  const data = {
    earnings: {
      week: {
        rows: [{
          symbol: 'BAD',
          company: 'Bad Fixture Inc',
          exchange: 'NYSE',
          country: 'US',
          marketCap: 30000000000,
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
            finnhubUsListing: { market: 'US', symbol: 'BAD', mic: 'XNYS' },
            finnhubProfile: { industry: 'Industrials' },
            scheduleVerification: { status: 'primary_only' }
          }
        }, {
          symbol: 'ADR',
          company: 'ADR Fixture PLC',
          exchange: 'LONDON STOCK EXCHANGE',
          country: 'GB',
          marketCap: 30000000000,
          reportDate: '2026-07-10',
          eps: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', basis: 'gaap', note: '' },
          revenue: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', note: '' },
          outcome: { overall: 'beat' },
          reaction: { status: 'computed', percent: 1, note: '' },
          sourceAudit: {
            finnhubUsListing: { market: 'US', symbol: 'ADR', mic: 'XNYS' },
            finnhubProfile: { industry: 'Industrials' }
          }
        }, {
          symbol: 'SMALL',
          company: 'Small Fixture Inc',
          exchange: 'NYSE',
          country: 'US',
          marketCap: 24999999999,
          reportDate: '2026-07-10',
          eps: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', basis: 'gaap', note: '' },
          revenue: { estimate: 1, actual: 2, surprisePercent: 100, result: 'beat', note: '' },
          outcome: { overall: 'beat' },
          reaction: { status: 'computed', percent: 1, note: '' },
          sourceAudit: {
            finnhubUsListing: { market: 'US', symbol: 'SMALL', mic: 'XNYS' },
            finnhubProfile: { industry: 'Industrials' }
          }
        }, {
          symbol: 'DROP',
          reportDate: '2026-07-10',
          outcome: {}
        }],
        secondaryRecoveryCandidates: [{ symbol: 'SMALL', reason: 'fixture_recovery_candidate' }],
        narrativeApply: { appliedAt: FIXTURE_NOW },
        summary: {
          providerMode: 'zacks',
          zacksGate: { ok: true, failures: [] },
          counts: {},
          fetches: { finnhubCalendar: { requests: 1, ok: 1 } }
        }
      }
    }
  };

  const html = '<script type="application/json" id="dashboard-data">{}</script>';
  const centrallyPublished = readJsonBlock(patchDashboardDataBlock(html, data, null, null, {
    stampEdition: false,
    selectEarningsRows: true
  }), 'dashboard-data');
  assert.equal(centrallyPublished.earnings.week.rows.length, 2);
  assert.equal(centrallyPublished.earnings.week.rows[0].symbol, 'BAD');
  assert.equal(centrallyPublished.earnings.week.rows[1].symbol, 'ADR');
  assert.equal(centrallyPublished.earnings.week.rows[1].sourceAudit, undefined);
  assert.equal(Object.hasOwn(centrallyPublished.earnings.week, 'secondaryRecoveryCandidates'), false);
  assert.equal(Object.hasOwn(centrallyPublished.earnings.week, 'companyReleaseTasks'), false);
  assert.equal(Object.hasOwn(centrallyPublished.earnings.week, 'narrativeApply'), false);
  assert.deepEqual(Object.keys(centrallyPublished.earnings.week.summary), ['counts']);
  assert.equal(centrallyPublished.earnings.week.summary.counts.secondaryRecoveryCandidates, 0);
  assert.equal(Object.hasOwn(centrallyPublished.earnings.week.summary.counts, 'companyReleaseTasks'), false);
  assert.equal(centrallyPublished.earnings.week.rows.length, 2);
  const row = centrallyPublished.earnings.week.rows[0];
  assert.equal(row.symbol, 'BAD');
  const outcome = row.outcome;
  assert.equal(row.scheduleVerificationStatus, 'primary_only');
  assert.equal(Object.hasOwn(row, 'companyReleaseStatus'), false);
  assert.equal(outcome.interpretation, '');
  assert.equal(outcome.guide, '');
  assert.equal(outcome.interpretationDisposition, undefined);
  assert.equal(outcome.guidanceDisposition, undefined);

  const published = readJsonBlock(patchDashboardDataBlock(html, data, null, null, {
    stampEdition: false,
    selectEarningsRows: true
  }), 'dashboard-data');
  assert.equal(published.earnings.week.rows[0].sourceAudit, undefined);
  assert.equal(published.earnings.week.rows[0].scheduleVerificationStatus, 'primary_only');
  assert.equal(Object.hasOwn(published.earnings.week.rows[0], 'companyReleaseStatus'), false);
  assert.equal(published.earnings.week.rows[1].symbol, 'ADR');

  const applied = {};
  applyEditorialEarningsNarrative(
    applied,
    { earnings: { week: published.earnings.week } },
    { earnings: { week: { rows: published.earnings.week.rows } } },
    null
  );
  assert.equal(applied.earnings.week.rows.length, 2);
  assert.equal(applied.earnings.week.rows[1].symbol, 'ADR');
  const republished = readJsonBlock(patchDashboardDataBlock(html, applied, null, null, { stampEdition: false }), 'dashboard-data');
  assert.equal(republished.earnings.week.rows.length, 2);
  assert.equal(republished.earnings.week.rows[1].symbol, 'ADR');
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
    verifiedClaims: []
  };
  assert.deepEqual(validateReviewManifest(manifest, data), []);
  assert.match(validateReviewManifest({ ...manifest, baseEditionId: '' }, data).join('\n'), /baseEditionId must identify/);
  assert.match(validateReviewManifest(manifest, data, { expectedBaseEditionId: 'newer-edition' }).join('\n'), /baseEditionId must match/);
  assert.match(
    validateReviewManifest({ ...manifest, marketLensDecisions: [] }, data).join('\n'),
    /marketLensDecisions is no longer supported/
  );
  buildEditorialReview(data, manifest, reviewChartData);
  assert.equal(data.editorialReview.reviewedBaseEditionId, manifest.baseEditionId);
  assert.equal(data.editorialReview.reviewedEditionId, data.editionId);
  assert.equal(data.editorialReview.payloadHash, editorialPayloadHash(data, reviewChartData));
  assert.deepEqual(validateReviewManifest(data.editorialReview, data, { requireEmbedded: true, chartData: reviewChartData }), []);
  assert.match(validateReviewManifest({
    ...data.editorialReview,
    marketLensDecisions: []
  }, data, { requireEmbedded: true, chartData: reviewChartData }).join('\n'), /marketLensDecisions is no longer supported/);
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
  process.env.SCHEDULED_NOW_ISO = '2026-07-10T21:05:00.000Z';
  let preparedHtml;
  try {
    preparedHtml = patchDashboard(args);
    stageDashboardCandidate(args, preparedHtml);
  } finally {
    if (previousScheduledNow === undefined) delete process.env.SCHEDULED_NOW_ISO;
    else process.env.SCHEDULED_NOW_ISO = previousScheduledNow;
  }

  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'Deterministic preparation must not alter the canonical dashboard.');
  assert.equal(fs.existsSync(candidateFile), true);
  const canonicalData = readJsonBlock(originalHtml, 'dashboard-data');
  const candidateData = readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'dashboard-data');
  assert.equal(candidateData.editionId, canonicalData.editionId, 'The staged candidate must retain the canonical base edition binding.');
  assert.equal(candidateData.editorialReview, undefined);
  assert.equal(candidateData.crypto.availability, undefined);

  const weekendArgs = {
    ...args,
    windowMode: 'morning',
    candidate: path.join(dir, 'weekend-dashboard-candidate.html')
  };
  const previousWeekendScheduledNow = process.env.SCHEDULED_NOW_ISO;
  process.env.SCHEDULED_NOW_ISO = '2026-07-19T15:00:00.000Z';
  let weekendHtml;
  try {
    weekendHtml = patchDashboard(weekendArgs);
  } finally {
    if (previousWeekendScheduledNow === undefined) delete process.env.SCHEDULED_NOW_ISO;
    else process.env.SCHEDULED_NOW_ISO = previousWeekendScheduledNow;
  }
  const weekendData = readJsonBlock(weekendHtml, 'dashboard-data');
  assert.equal(weekendData.masthead.edition, 'Weekend Edition');
  assert.equal(weekendData.futuresModule.sectionTitle, 'Session Futures');

  const retainedCandidateFile = path.join(dir, 'retained-dashboard-candidate.html');
  const retainedCandidate = fs.readFileSync(candidateFile, 'utf8');
  fs.writeFileSync(retainedCandidateFile, retainedCandidate);
  const brokenJsonHtml = preparedHtml.replace(
    '<script type="application/json" id="dashboard-data">',
    '<script type="application/json" id="dashboard-data">broken'
  );
  assert.throws(
    () => stageDashboardCandidate({ ...args, candidate: retainedCandidateFile }, brokenJsonHtml),
    /Deterministic candidate failed validation/
  );
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
  const setEarningsSymbol = (row, symbol) => {
    row.symbol = symbol;
    row.sourceAudit.finnhubUsListing.symbol = symbol;
    return row;
  };
  const earningsNeedsReview = fixtureReportedEarningsRow();
  earningsNeedsReview.outcome.interpretation = 'Old result interpretation must not enter editorial handoff.';
  delete earningsNeedsReview.outcome.interpretationDisposition;
  earningsNeedsReview.outcome.guide = 'Old guidance copy must not enter editorial handoff.';
  delete earningsNeedsReview.outcome.guidanceDisposition;
  earningsNeedsReview.reaction.note = 'Old reaction note must not enter editorial handoff.';
  delete earningsNeedsReview.reaction.commentaryDisposition;
  const earningsAwaitingResults = structuredClone(earningsNeedsReview);
  setEarningsSymbol(earningsAwaitingResults, 'WAIT');
  earningsAwaitingResults.eps = { ...earningsAwaitingResults.eps, actual: null, surprisePercent: null, result: 'pending' };
  earningsAwaitingResults.revenue = { ...earningsAwaitingResults.revenue, actual: null, surprisePercent: null, result: 'pending' };
  earningsAwaitingResults.outcome = { overall: 'pending', interpretation: 'Pre-release focus can remain.' };
  earningsAwaitingResults.reaction = { status: 'pending', note: '' };
  earningsAwaitingResults.lifecycle = 'awaiting_actual';
  const earningsOneActual = structuredClone(earningsNeedsReview);
  setEarningsSymbol(earningsOneActual, 'ONEACT');
  earningsOneActual.revenue = {
    ...earningsOneActual.revenue,
    actual: null,
    surprisePercent: null,
    result: 'pending'
  };
  earningsOneActual.reaction = { status: 'awaiting_close', note: '' };
  earningsOneActual.lifecycle = 'released_awaiting_close';
  const earningsNotComparedActual = structuredClone(earningsNeedsReview);
  setEarningsSymbol(earningsNotComparedActual, 'NOCOMP');
  earningsNotComparedActual.eps = {
    ...earningsNotComparedActual.eps,
    estimate: null,
    actual: 1.2,
    surprisePercent: null,
    result: 'not_compared'
  };
  earningsNotComparedActual.revenue = {
    ...earningsNotComparedActual.revenue,
    actual: null,
    surprisePercent: null,
    result: 'pending'
  };
  earningsNotComparedActual.outcome.overall = 'pending';
  earningsNotComparedActual.reaction = { status: 'awaiting_close', note: '' };
  earningsNotComparedActual.lifecycle = 'released_awaiting_close';
  const earningsGuidanceNotProvided = fixtureReportedEarningsRow();
  setEarningsSymbol(earningsGuidanceNotProvided, 'NOGD');
  const earningsVerifiedGuidance = fixtureReportedEarningsRow();
  setEarningsSymbol(earningsVerifiedGuidance, 'VGUID');
  earningsVerifiedGuidance.outcome.guide = 'FY outlook was reaffirmed.';
  earningsVerifiedGuidance.outcome.guidanceDisposition = { status: 'verified' };
  const earningsGuidanceRetry = fixtureReportedEarningsRow();
  setEarningsSymbol(earningsGuidanceRetry, 'GRETRY');
  earningsGuidanceRetry.outcome.interpretation = 'Verified result interpretation can remain.';
  earningsGuidanceRetry.outcome.interpretationDisposition = { status: 'verified' };
  earningsGuidanceRetry.outcome.guide = '';
  earningsGuidanceRetry.outcome.guidanceDisposition = { status: 'pending_review' };
  earningsGuidanceRetry.reaction = { status: 'awaiting_close', note: '' };
  earningsGuidanceRetry.lifecycle = 'released_awaiting_close';
  const earningsCloseReactionOnly = fixtureReportedEarningsRow();
  setEarningsSymbol(earningsCloseReactionOnly, 'RXN');
  earningsCloseReactionOnly.outcome.guide = 'FY outlook was reaffirmed.';
  earningsCloseReactionOnly.outcome.guidanceDisposition = { status: 'verified' };
  earningsCloseReactionOnly.reaction.note = 'Old reaction copy must be refreshed.';
  delete earningsCloseReactionOnly.reaction.commentaryDisposition;
  const duplicatedInterpretationA = fixtureReportedEarningsRow();
  duplicatedInterpretationA.symbol = 'DUPA';
  duplicatedInterpretationA.company = 'Duplicate Alpha Inc';
  duplicatedInterpretationA.sourceAudit.finnhubUsListing.symbol = 'DUPA';
  duplicatedInterpretationA.outcome.interpretation = 'Duplicate Alpha revenue cadence and margin execution remain the key read.';
  duplicatedInterpretationA.outcome.interpretationDisposition = { status: 'verified' };
  duplicatedInterpretationA.outcome.guide = 'Duplicate Alpha raised its full-year operating margin target.';
  duplicatedInterpretationA.outcome.guidanceDisposition = { status: 'verified' };
  duplicatedInterpretationA.reaction.note = 'Duplicate Alpha margin upside drove the stock response.';
  duplicatedInterpretationA.reaction.commentaryDisposition = { status: 'verified' };
  const duplicatedInterpretationB = structuredClone(duplicatedInterpretationA);
  duplicatedInterpretationB.symbol = 'DUPB';
  duplicatedInterpretationB.company = 'Duplicate Beta Inc';
  duplicatedInterpretationB.sourceAudit.finnhubUsListing.symbol = 'DUPB';
  duplicatedInterpretationB.outcome.interpretation = 'Duplicate Beta revenue cadence and margin execution remain the key read.';
  duplicatedInterpretationB.outcome.guide = 'Duplicate Beta kept its quarterly revenue outlook intact.';
  duplicatedInterpretationB.reaction.note = 'Duplicate Beta subscription backlog limited the stock response.';
  candidateDashboard.earnings.week.rows = [
    earningsNeedsReview,
    earningsAwaitingResults,
    earningsOneActual,
    earningsNotComparedActual,
    earningsGuidanceNotProvided,
    earningsVerifiedGuidance,
    earningsGuidanceRetry,
    earningsCloseReactionOnly,
    duplicatedInterpretationA,
    duplicatedInterpretationB
  ];
  const sourceWeekDay = candidateDashboard.weekAhead.days.find((day) => day.events.length);
  const sourceWeekEvent = structuredClone(sourceWeekDay.events[0]);
  const configureWeekDay = (index, { lifecycle, eventStatus, actual, valuesApplicable = true, editorialLens = false, closeReaction = false }) => {
    const day = candidateDashboard.weekAhead.days[index];
    day.events = [{
      ...sourceWeekEvent,
      id: `fixture-week-ahead-${index}`,
      date: day.date,
      status: eventStatus,
      actual,
      valuesApplicable,
      ...(!valuesApplicable ? {
        actual: null,
        forecast: null,
        previous: null,
        forecastType: null
      } : {})
    }];
    day.lifecycle = lifecycle;
    const baseLens = defaultMarketLensForEvents(day.events);
    day.marketLens = editorialLens
      ? {
        ...baseLens,
        status: 'verified',
        copy: {
          question: 'What changed in the current release?',
          title: 'Editorial current lens',
          body: 'Editorial current release interpretation.'
        }
      }
      : baseLens;
    delete day.outcome;
    delete day.marketReaction;
    if (closeReaction) {
      day.marketReaction = {
        window: 'event-day-close-vs-previous-close',
        asOf: day.date,
        rows: [{ ticker: 'UST10Y', role: 'rates response', delta: 0.02, percentChange: 0.2, unit: 'percent_yield' }]
      };
      if (actual) day.outcome = { title: 'Old outcome copy must not enter editorial handoff.', body: 'Old outcome body.' };
    }
    return day;
  };
  let scheduledWeekDay;
  let missingActualsWeekDay;
  let releasedNeedsLensWeekDay;
  let closeCurrentLensWeekDay;
  let releasedNonStatNeedsLensWeekDay;
  candidateChartData.series.find((series) => series.ticker === 'SPX').quoteRevision = FIXTURE_NOW;
  syncDashboardPricesFromChartData(candidateDashboard, candidateChartData, {
    resetCommentary: true,
    commentaryTickers: ['SPX']
  });
  scheduledWeekDay = configureWeekDay(0, { lifecycle: 'scheduled', eventStatus: 'scheduled', actual: null });
  missingActualsWeekDay = configureWeekDay(1, { lifecycle: 'awaiting_actual', eventStatus: 'awaiting_actual', actual: null });
  releasedNeedsLensWeekDay = configureWeekDay(2, { lifecycle: 'released_awaiting_close', eventStatus: 'released', actual: '1.0%' });
  closeCurrentLensWeekDay = configureWeekDay(3, {
    lifecycle: 'close_available',
    eventStatus: 'released',
    actual: '1.0%',
    editorialLens: true,
    closeReaction: true
  });
  releasedNonStatNeedsLensWeekDay = configureWeekDay(4, {
    lifecycle: 'released_awaiting_close',
    eventStatus: 'released',
    actual: null,
    valuesApplicable: false
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
    '--prepare-editorial-dir', editorialDir
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
  assert.deepEqual(fs.readdirSync(editorialDir).sort(), ['dashboard-data.json', 'earnings_week_guidance.json']);
  const handoff = JSON.parse(fs.readFileSync(path.join(editorialDir, 'dashboard-data.json'), 'utf8'));
  const guidanceEvidence = JSON.parse(fs.readFileSync(path.join(editorialDir, 'earnings_week_guidance.json'), 'utf8'));
  assert.equal(handoff.editorialReview.earningsGuidanceEvidence.artifact.endsWith('earnings_week_guidance.json'), true);
  assert.equal(guidanceEvidence.sourceUse, 'editorial_guidance_evidence');
  assert.equal(handoff.editorialReview.earningsChecklist.length, candidateDashboard.earnings.week.rows.length);
  const checklistBySymbol = new Map(handoff.editorialReview.earningsChecklist.map((item) => [item.symbol, item]));
  const assignmentByField = (item, field) => item.assignments.find((assignment) => assignment.field === field);
  const checklistEarningsNeedsReview = checklistBySymbol.get('EARN');
  assert.equal(checklistEarningsNeedsReview.rowIndex, 0);
  assert.equal(checklistEarningsNeedsReview.rowPath, 'earnings.week.rows[0]');
  assert.equal(checklistEarningsNeedsReview.hasActuals, true);
  assert.equal(checklistEarningsNeedsReview.hasComputedReaction, true);
  assert.deepEqual(Object.prototype.hasOwnProperty.call(checklistEarningsNeedsReview, 'eps'), false);
  assert.deepEqual(assignmentByField(checklistEarningsNeedsReview, 'outcome.interpretation'), {
    field: 'outcome.interpretation',
    path: 'earnings.week.rows[0].outcome.interpretation',
    dispositionPath: 'earnings.week.rows[0].outcome.interpretationDisposition',
    status: 'pending_review',
    required: true
  });
  assert.deepEqual(assignmentByField(checklistEarningsNeedsReview, 'outcome.guidance'), {
    field: 'outcome.guidance',
    path: 'earnings.week.rows[0].outcome.guide',
    dispositionPath: 'earnings.week.rows[0].outcome.guidanceDisposition',
    status: 'pending_review',
    required: true,
    evidenceStatus: 'network_disabled',
    documents: 0,
    guidanceSignalCount: 0,
    primaryUrl: '',
    evidenceRef: `${path.relative(root, path.join(editorialDir, 'earnings_week_guidance.json')).replace(/\\/g, '/')}#EARN:2026-07-10`
  });
  assert.deepEqual(assignmentByField(checklistEarningsNeedsReview, 'reaction.note'), {
    field: 'reaction.note',
    path: 'earnings.week.rows[0].reaction.note',
    dispositionPath: 'earnings.week.rows[0].reaction.commentaryDisposition',
    status: 'pending_review',
    required: true
  });
  const checklistAwaitingResults = checklistBySymbol.get('WAIT');
  assert.equal(assignmentByField(checklistAwaitingResults, 'outcome.guidance').status, 'not_required');
  assert.equal(assignmentByField(checklistAwaitingResults, 'outcome.guidance').required, false);
  assert.equal(assignmentByField(checklistAwaitingResults, 'reaction.note').status, 'not_required');
  assert.equal(assignmentByField(checklistAwaitingResults, 'reaction.note').required, false);
  const checklistNotProvided = checklistBySymbol.get('NOGD');
  assert.equal(assignmentByField(checklistNotProvided, 'outcome.guidance').status, 'not_provided');
  assert.equal(assignmentByField(checklistNotProvided, 'outcome.guidance').required, true);
  const checklistVerifiedGuidance = checklistBySymbol.get('VGUID');
  assert.equal(assignmentByField(checklistVerifiedGuidance, 'outcome.guidance').status, 'verified');
  const checklistReactionOnly = checklistBySymbol.get('RXN');
  assert.equal(assignmentByField(checklistReactionOnly, 'reaction.note').status, 'pending_review');
  assert.equal(assignmentByField(checklistReactionOnly, 'reaction.note').required, true);
  assert.equal(handoff.tape.rows[0].noteDisposition.status, 'pending_review');
  assert.equal(handoff.tape.rows[0].note, '');
  const handoffEarningsNeedsReview = handoff.earnings.week.rows.find((row) => row.symbol === 'EARN');
  assert.equal(handoffEarningsNeedsReview.outcome.interpretation, '');
  assert.equal(handoffEarningsNeedsReview.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffEarningsNeedsReview.outcome.guide, '');
  assert.equal(handoffEarningsNeedsReview.outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(handoffEarningsNeedsReview.reaction.note, '');
  assert.equal(handoffEarningsNeedsReview.reaction.commentaryDisposition.status, 'pending_review');
  const handoffEarningsAwaitingResults = handoff.earnings.week.rows.find((row) => row.symbol === 'WAIT');
  assert.equal(handoffEarningsAwaitingResults.outcome.interpretation, '');
  assert.equal(handoffEarningsAwaitingResults.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffEarningsAwaitingResults.outcome.guidanceDisposition, undefined);
  assert.equal(handoffEarningsAwaitingResults.reaction.commentaryDisposition, undefined);
  const handoffEarningsOneActual = handoff.earnings.week.rows.find((row) => row.symbol === 'ONEACT');
  assert.equal(handoffEarningsOneActual.outcome.interpretation, '');
  assert.equal(handoffEarningsOneActual.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffEarningsOneActual.outcome.guide, '');
  assert.equal(handoffEarningsOneActual.outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(handoffEarningsOneActual.reaction.commentaryDisposition, undefined);
  const handoffEarningsNotCompared = handoff.earnings.week.rows.find((row) => row.symbol === 'NOCOMP');
  assert.equal(handoffEarningsNotCompared.outcome.overall, 'pending');
  assert.equal(handoffEarningsNotCompared.outcome.interpretation, '');
  assert.equal(handoffEarningsNotCompared.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffEarningsNotCompared.outcome.guide, '');
  assert.equal(handoffEarningsNotCompared.outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(handoffEarningsNotCompared.reaction.commentaryDisposition, undefined);
  const handoffEarningsGuidanceNotProvided = handoff.earnings.week.rows.find((row) => row.symbol === 'NOGD');
  assert.equal(handoffEarningsGuidanceNotProvided.outcome.guidanceDisposition.status, 'not_provided');
  const handoffEarningsVerifiedGuidance = handoff.earnings.week.rows.find((row) => row.symbol === 'VGUID');
  assert.equal(handoffEarningsVerifiedGuidance.outcome.guide, 'FY outlook was reaffirmed.');
  assert.equal(handoffEarningsVerifiedGuidance.outcome.guidanceDisposition.status, 'verified');
  const handoffEarningsGuidanceRetry = handoff.earnings.week.rows.find((row) => row.symbol === 'GRETRY');
  assert.equal(handoffEarningsGuidanceRetry.outcome.interpretation, 'Verified result interpretation can remain.');
  assert.equal(handoffEarningsGuidanceRetry.outcome.interpretationDisposition.status, 'verified');
  assert.equal(handoffEarningsGuidanceRetry.outcome.guide, '');
  assert.equal(handoffEarningsGuidanceRetry.outcome.guidanceDisposition.status, 'pending_review');
  const handoffEarningsCloseReactionOnly = handoff.earnings.week.rows.find((row) => row.symbol === 'RXN');
  assert.equal(handoffEarningsCloseReactionOnly.outcome.interpretation, earningsCloseReactionOnly.outcome.interpretation);
  assert.equal(handoffEarningsCloseReactionOnly.outcome.guidanceDisposition.status, 'verified');
  assert.equal(handoffEarningsCloseReactionOnly.reaction.note, '');
  assert.equal(handoffEarningsCloseReactionOnly.reaction.commentaryDisposition.status, 'pending_review');
  const handoffDuplicatedInterpretationA = handoff.earnings.week.rows.find((row) => row.symbol === 'DUPA');
  const handoffDuplicatedInterpretationB = handoff.earnings.week.rows.find((row) => row.symbol === 'DUPB');
  assert.equal(handoffDuplicatedInterpretationA.outcome.interpretation, '');
  assert.equal(handoffDuplicatedInterpretationA.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffDuplicatedInterpretationB.outcome.interpretation, '');
  assert.equal(handoffDuplicatedInterpretationB.outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(handoffDuplicatedInterpretationA.outcome.guide, duplicatedInterpretationA.outcome.guide);
  assert.equal(handoffDuplicatedInterpretationA.outcome.guidanceDisposition.status, 'verified');
  assert.equal(handoffDuplicatedInterpretationB.outcome.guide, duplicatedInterpretationB.outcome.guide);
  assert.equal(handoffDuplicatedInterpretationB.outcome.guidanceDisposition.status, 'verified');
  assert.equal(handoffDuplicatedInterpretationA.reaction.note, duplicatedInterpretationA.reaction.note);
  assert.equal(handoffDuplicatedInterpretationA.reaction.commentaryDisposition.status, 'verified');
  assert.equal(handoffDuplicatedInterpretationB.reaction.note, duplicatedInterpretationB.reaction.note);
  assert.equal(handoffDuplicatedInterpretationB.reaction.commentaryDisposition.status, 'verified');
  const handoffWeekDayByDate = new Map(handoff.weekAhead.days.map((day) => [day.date, day]));
  assert.equal(handoffWeekDayByDate.get(scheduledWeekDay.date).marketLens.status, 'pending_review');
  assert.equal(handoffWeekDayByDate.get(scheduledWeekDay.date).marketLens.copy.title, '');
  assert.equal(handoffWeekDayByDate.get(missingActualsWeekDay.date).marketLens.status, 'pending_review');
  assert.equal(handoffWeekDayByDate.get(releasedNeedsLensWeekDay.date).marketLens.copy.title, '');
  assert.equal(handoffWeekDayByDate.get(releasedNeedsLensWeekDay.date).marketLens.copy.body, '');
  assert.equal(handoffWeekDayByDate.get(closeCurrentLensWeekDay.date).marketLens.status, 'verified');
  assert.equal(handoffWeekDayByDate.get(closeCurrentLensWeekDay.date).marketLens.copy.title, 'Editorial current lens');
  assert.equal(handoffWeekDayByDate.get(releasedNonStatNeedsLensWeekDay.date).marketLens.copy.title, '');
  assert.equal(handoffWeekDayByDate.get(releasedNonStatNeedsLensWeekDay.date).marketLens.copy.body, '');
  const handoffCloseWeekDay = handoff.weekAhead.days.find((day) => day.date === closeCurrentLensWeekDay.date);
  assert.deepEqual(handoffCloseWeekDay.outcome, { status: 'pending_review' });
  assert.deepEqual(handoff.tape.rows[1], dashboard.tape.rows[1], 'An unchanged carried quote must retain its complete commentary bundle in the handoff.');
  assert.equal(handoff.storiesCoverage, undefined);
  assert.equal(handoff.futuresModule.storiesCoverage, undefined);
  assert.equal(handoff.crypto.notesCoverage, undefined);
  assert.deepEqual(handoff.futuresModule.stories, []);
  assert.deepEqual(handoff.stories, []);
  assert.deepEqual(handoff.crypto.notes, []);
  assert.equal(handoff.opening.headline, '');
  assert.equal(handoff.opening.deck, '');
  assert.deepEqual(handoff.opening.catalysts, Array.from({ length: 4 }, () => ({ label: '', body: '' })));
  assert.deepEqual(handoff.editorialReview.newsSelection, { futures: [], stories: [], crypto: [] });
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
  assert.equal(handoff.editionId, '2026-07-10T21:01:00.000Z');
  assert.equal(handoff.editorialReview.baseEditionId, dashboard.editionId);
  assert.equal(handoff.editorialReview.preparedAt, '2026-07-10T21:01:00.000Z');
  assert.equal(handoff.editorialReview.openingDecision.action, null);
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

function testUnresolvedMarketLensReviewBecomesUnavailableLens() {
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
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
  };
  fs.writeFileSync(dashboardFile, html);
  fs.writeFileSync(candidateFile, html);
  fs.writeFileSync(payloadFile, JSON.stringify(editorial));
  writeFixtureNewsCandidates(dashboard);
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-13T22:01:00.000Z'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const finalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  const finalizedDay = finalized.weekAhead.days.find((day) => day.events.length);
  assert.equal(finalizedDay.marketLens.status, 'commentary_unavailable');
  assert.deepEqual(finalizedDay.marketLens.copy, { question: '', title: '', body: '' });
  assert.equal(finalized.editorialReview.systemFallbacks.find((item) => item.section === 'market-lens').action, 'commentary_unavailable');
}

function testStageOneFinalizesWeekAheadOutcomeDisposition() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const roundedChartData = roundChartPayload(chartData);
  const eventDay = dashboard.weekAhead.days.find((day) => day.events.length);
  eventDay.events[0].actual = eventDay.events[0].forecast || '1.0%';
  for (const reaction of eventDay.marketLens.reactions) {
    const series = roundedChartData.series.find((item) => item.ticker === reaction.ticker);
    const last = series.bars.at(-1);
    series.bars.push({
      time: eventDay.date,
      open: last.close,
      high: last.close + 1,
      low: last.close - 1,
      close: last.close + 0.5,
      volume: last.volume
    });
  }

  syncDashboardPricesFromChartData(dashboard, roundedChartData, { now: new Date('2026-07-13T22:00:00.000Z') });

  const finalizedDay = dashboard.weekAhead.days.find((day) => day.date === eventDay.date);
  assert.equal(finalizedDay.lifecycle, 'close_available');
  assert.deepEqual(finalizedDay.marketReaction.rows.map((row) => row.ticker), ['VCR', 'UST10Y']);
  assert.deepEqual(finalizedDay.outcome, { status: 'pending_review' });
}

// Boundary regression: Apply must publish the staged Week Ahead lifecycle
// without recomputing it from chart-data.
function testApplyDoesNotOwnWeekAheadLifecycle() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-apply-weekahead-boundary-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const candidate = structuredClone(dashboard);
  const staleDay = candidate.weekAhead.days.find((day) => day.events.length);
  staleDay.lifecycle = 'scheduled';
  staleDay.events[0] = {
    ...staleDay.events[0],
    actual: staleDay.events[0].forecast || '1.0%',
    status: 'scheduled',
    surprise: null
  };
  staleDay.marketReaction = {
    window: 'fixture-apply-must-not-recompute',
    rows: [{ ticker: 'VCR', role: 'candidate-only reaction', delta: 0, percentChange: 0, unit: 'price' }]
  };
  const editorial = structuredClone(candidate);
  editorial.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-13T13:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(candidate, '2026-07-13T13:00:00.000Z'),
    newsSelection: fixtureNewsSelection(candidate),
    openingDecision: { action: 'reviewed' }
  };
  fs.writeFileSync(dashboardFile, renderDashboardValidationFixture(dashboard, chartData));
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(candidate, chartData));
  fs.writeFileSync(payloadFile, JSON.stringify(editorial));
  writeFixtureNewsCandidates(candidate);

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-13T22:01:00.000Z'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const finalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  const finalizedDay = finalized.weekAhead.days.find((day) => day.date === staleDay.date);
  assert.equal(finalizedDay.lifecycle, 'scheduled');
  assert.equal(finalizedDay.events[0].status, 'scheduled');
  assert.equal(finalizedDay.events[0].actual, staleDay.events[0].actual);
  assert.equal(finalizedDay.marketReaction.window, 'fixture-apply-must-not-recompute');
  assert.equal(finalizedDay.marketLens.status, 'setup');
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
    }]
  };

  syncDashboardPricesFromChartData(data, chartData);

  const derived = deriveQuoteRowsFromSeries(chartData.series);
  assert.equal(chartData.quoteRows, undefined);
  assert.equal(derived.tape[0].last, '6,123.45');
  assert.equal(derived.tape[0].asOf, '2026-07-06');
  assert.equal(derived.crypto[0].price, '$61,000');
  assert.equal(derived.crypto[0].asOf, '2026-07-06');
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

// A late Apply uses the prepared handoff timestamp for Futures URL eligibility,
// not the wall-clock time when the user finally publishes.
function testPreparedEditionIdDrivesFuturesStoryWindow() {
  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-futures-edition-window-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.editionId = '2026-07-10T14:00:00.000Z';
  dashboard.futuresModule.stories = dashboard.futuresModule.stories.map((storyItem, index) => ({
    ...storyItem,
    publishedAt: `2026-07-10T19:3${index}:00.000Z`
  }));
  const html = renderDashboardValidationFixture(dashboard, chartData);
  const editorial = structuredClone(dashboard);
  editorial.editionId = '2026-07-10T21:00:00.000Z';
  editorial.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
  };
  fs.writeFileSync(dashboardFile, html);
  fs.writeFileSync(candidateFile, html);
  fs.writeFileSync(payloadFile, JSON.stringify(editorial));
  writeFixtureNewsCandidates(dashboard);

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--candidate', candidateFile,
    '--apply-dashboard-data-json', payloadFile
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z' } });
  assert.equal(result.status, 0, result.stderr);

  const finalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(finalized.editionId, editorial.editionId);
  assert.equal(finalized.futuresModule.stories.length, 3);
  assert.equal(finalized.futuresModule.stories[0].title, dashboard.futuresModule.stories[0].title);
  assert.equal(finalized.editorialReview.reviewedBaseEditionId, dashboard.editionId);
  assert.equal(finalized.editorialReview.reviewedEditionId, editorial.editionId);
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
  const review = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
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
    '--apply-dashboard-data-json', payloadFile
  ];
  const env = {
    ...process.env,
    SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z'
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
  const pendingEarningsPayload = structuredClone(dashboard);
  pendingEarningsPayload.earnings.week.rows = [fixtureReportedEarningsRow()];
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(pendingEarningsPayload, chartData));
  pendingEarningsPayload.editorialReview = structuredClone(review);
  pendingEarningsPayload.earnings.week.rows[0].outcome.guide = '';
  pendingEarningsPayload.earnings.week.rows[0].outcome.guidanceDisposition = { status: 'pending_review' };
  fs.writeFileSync(payloadFile, JSON.stringify(pendingEarningsPayload));
  const pendingEarningsResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(pendingEarningsResult.status, 0, pendingEarningsResult.stderr);
  assert.match(pendingEarningsResult.stderr, /Earnings editorial fields still pending: EARN outcome\.guidance/);
  const pendingEarningsFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(pendingEarningsFinalized.earnings.week.rows[0].outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(pendingEarningsFinalized.editorialReview.earningsChecklist, undefined);

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, '{');
  const invalidCandidateResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.notEqual(invalidCandidateResult.status, 0, 'A malformed staged candidate must not finalize.');
  assert.match(invalidCandidateResult.stderr, /run_daily_update failed: Could not find dashboard-data JSON block/);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml, 'Failed finalization must leave the canonical dashboard and its completion state untouched.');

  const stagedChart = structuredClone(chartData);
  stagedChart.series[0].bars.at(-1)[4] += 1;
  stagedChart.series[0].quoteRevision = '2026-07-10T13:00:00.000Z';
  const stagedQuoteRow = quoteRowFromSeries(roundChartPayload(stagedChart).series[0]);
  const stagedDashboard = structuredClone(dashboard);
  stagedDashboard.tape.rows[0] = unavailableTapeCommentary({
    ...stagedDashboard.tape.rows[0],
    last: stagedQuoteRow.last,
    delta: stagedQuoteRow.delta,
    pct: stagedQuoteRow.pct,
    dir: stagedQuoteRow.dir,
    asOf: stagedQuoteRow.asOf
  }, stagedChart.series[0].quoteRevision);
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(stagedDashboard, stagedChart));
  const stagedEditorialPayload = structuredClone(stagedDashboard);
  stagedEditorialPayload.opening = structuredClone(pendingOpeningPayload.opening);
  stagedEditorialPayload.editorialReview = structuredClone(pendingOpeningPayload.editorialReview);
  fs.writeFileSync(payloadFile, JSON.stringify(stagedEditorialPayload));
  const stagedChartResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(stagedChartResult.status, 0, stagedChartResult.stderr);
  assert.doesNotMatch(stagedChartResult.stderr, /Staged dashboard candidate chart-data was carried forward/);
  const stagedHtml = fs.readFileSync(dashboardFile, 'utf8');
  const publishedChart = roundChartPayload(readJsonBlock(stagedHtml, 'chart-data'));
  const expectedChart = roundChartPayload(stagedChart);
  assert.equal(
    publishedChart.series.find((series) => series.ticker === 'SPX').bars.at(-1).close,
    expectedChart.series.find((series) => series.ticker === 'SPX').bars.at(-1).close,
    'Apply must publish the staged chart-data block; Prepare owns chart revision validation.'
  );
  const stagedPublishedDashboard = readJsonBlock(stagedHtml, 'dashboard-data');
  assert.equal(
    stagedPublishedDashboard.tape.rows[0].last,
    stagedQuoteRow.last,
    'Apply must preserve the staged dashboard Tape fields produced by Prepare quote synchronization.'
  );
  assert.deepEqual(stagedPublishedDashboard.earnings.week.range, dashboard.earnings.week.range);
  assert.deepEqual(stagedPublishedDashboard.weekAhead.range, dashboard.weekAhead.range);

  fs.writeFileSync(dashboardFile, originalHtml);
  const sameRevisionDashboard = structuredClone(dashboard);
  sameRevisionDashboard.tape.rows[0].name = 'Prepared S&P 500 Name';
  sameRevisionDashboard.masthead.date = 'Prepared deterministic date';
  sameRevisionDashboard.footer.compiled = 'Prepared deterministic compile stamp';
  sameRevisionDashboard.futuresModule.futures[0].value = 'Prepared futures value';
  sameRevisionDashboard.crypto.stats[0].price = 'Prepared crypto value';
  sameRevisionDashboard.assetAllocationPortfolio.rows[0].price = 'Prepared asset value';
  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(sameRevisionDashboard, chartData));
  const sameRevisionEditorial = structuredClone(sameRevisionDashboard);
  sameRevisionEditorial.opening = structuredClone(pendingOpeningPayload.opening);
  sameRevisionEditorial.editorialReview = structuredClone(pendingOpeningPayload.editorialReview);
  fs.writeFileSync(payloadFile, JSON.stringify(sameRevisionEditorial));
  const sameRevisionResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(sameRevisionResult.status, 0, sameRevisionResult.stderr);
  const sameRevisionPublished = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(sameRevisionPublished.tape.rows[0].name, 'Prepared S&P 500 Name',
    'Apply must preserve candidate Tape fields even when the quote revision matches the prior canonical row.');
  assert.equal(sameRevisionPublished.masthead.date, 'Prepared deterministic date');
  assert.equal(sameRevisionPublished.footer.compiled, 'Prepared deterministic compile stamp');
  assert.equal(sameRevisionPublished.futuresModule.futures[0].value, 'Prepared futures value');
  assert.equal(sameRevisionPublished.crypto.stats[0].price, 'Prepared crypto value');
  assert.equal(sameRevisionPublished.assetAllocationPortfolio.rows[0].price, 'Prepared asset value');

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);

  const editorialPayload = structuredClone(dashboard);
  editorialPayload.masthead.date = 'Saturday · January 1, 2000';
  editorialPayload.opening.headline = 'Reviewed fixture headline';
  editorialPayload.editorialReview = structuredClone(review);
  editorialPayload.editorialReview.newsSelection.stories[0].title = 'Reviewed market story';
  editorialPayload.futuresModule.sectionTitle = 'Unauthorized futures title';
  editorialPayload.futuresModule.futures[0].value = '99,999.00';
  editorialPayload.editorialReview.newsSelection.futures[0].title = 'Reviewed futures story';
  editorialPayload.tape.label = 'Unauthorized session label · Reviewed drivers';
  editorialPayload.tape.rows[0].last = '99,999.00';
  editorialPayload.tape.rows[0].note = 'Federal Reserve expectations shaped rates and risk appetite.';
  editorialPayload.crypto.stats[0].price = '$9.99T';
  editorialPayload.editorialReview.newsSelection.crypto[0].title = 'Reviewed crypto story';
  editorialPayload.assetAllocationPortfolio.rows[0].price = '$999.00';
  editorialPayload.footer.compiled = `${dashboard.footer.compiled} · Holiday context: Reviewed. · Market data: Incorrect inherited source list`;
  const editorialEventDay = editorialPayload.weekAhead.days.find((day) => day.events.length);
  editorialEventDay.events[0].forecast = '9.9%';
  editorialEventDay.outcome = {
    status: 'verified',
    source: 'editorial',
    title: 'Reviewed outcome',
    body: 'Reviewed outcome body.'
  };

  const shortSearchPayload = structuredClone(editorialPayload);
  shortSearchPayload.editorialReview.newsSearch.generalCandidates.pop();
  fs.writeFileSync(payloadFile, JSON.stringify(shortSearchPayload));
  const shortSearchResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(shortSearchResult.status, 0, shortSearchResult.stderr);
  let shortSearchFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(shortSearchFinalized.storiesCoverage, undefined, 'Candidate-pool size must not override the accepted final-card count.');

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const emptyNewsPayload = structuredClone(editorialPayload);
  emptyNewsPayload.editorialReview.newsSelection = { futures: [], stories: [], crypto: [] };
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
  mixedNewsPayload.editorialReview.newsSearch.generalCandidates.push({
    title: 'Outside inventory story',
    url: 'https://outside.test/story',
    publishedOn: '2026-07-10',
    sourceLabel: 'Reuters'
  });
  mixedNewsPayload.editorialReview.newsSelection.stories[0] = {
    tag: 'Markets',
    title: 'Outside inventory story',
    body: 'A structurally valid but ungenerated card should be omitted without stopping publication.',
    url: 'https://outside.test/story'
  };
  mixedNewsPayload.editorialReview.newsSelection.stories[1] = structuredClone(mixedNewsPayload.editorialReview.newsSelection.futures[0]);
  const duplicateCryptoTitle = mixedNewsPayload.editorialReview.newsSelection.stories[2].title;
  mixedNewsPayload.editorialReview.newsSelection.crypto[0].title = duplicateCryptoTitle;
  fs.writeFileSync(payloadFile, JSON.stringify(mixedNewsPayload));
  const mixedNewsResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(mixedNewsResult.status, 0, mixedNewsResult.stderr);
  const mixedNewsFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(mixedNewsFinalized.stories.length, 7);
  assert.equal(mixedNewsFinalized.storiesCoverage.status, 'partial');
  assert.equal(mixedNewsFinalized.crypto.notes.length, 6);
  assert.equal(mixedNewsFinalized.crypto.notesCoverage, undefined);
  assert.ok(!mixedNewsFinalized.stories.some((story) => story.url === 'https://outside.test/story'));
  assert.ok(!mixedNewsFinalized.stories.some((story) => story.url === mixedNewsPayload.editorialReview.newsSelection.futures[0].url));
  assert.ok(mixedNewsFinalized.crypto.notes.some((story) => story.title === duplicateCryptoTitle));
  assert.ok(mixedNewsFinalized.editorialReview.systemFallbacks.some((item) => item.reason === 'not_in_candidate_inventory'));
  assert.ok(mixedNewsFinalized.editorialReview.systemFallbacks.some((item) => item.reason === 'promoted_story_duplicate'));

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const missingCandidateSourcePayload = structuredClone(editorialPayload);
  delete missingCandidateSourcePayload.editorialReview.newsSearch.generalCandidates[0].sourceLabel;
  fs.writeFileSync(payloadFile, JSON.stringify(missingCandidateSourcePayload));
  const missingCandidateSourceResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(missingCandidateSourceResult.status, 0, missingCandidateSourceResult.stderr);
  const missingCandidateSourceFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(missingCandidateSourceFinalized.stories.length, 9, 'Editing the handoff inventory must not change sidecar-owned candidate metadata.');
  assert.equal(missingCandidateSourceFinalized.stories[0].sourceLabel, 'Fixture News');

  const newsCandidatesPath = path.join(root, 'generated', 'news_candidates.json');
  const malformedOptionalTimestamp = fixtureNewsSearchArtifact(dashboard);
  const malformedCandidate = malformedOptionalTimestamp.generalCandidates.find(
    (candidate) => candidate.url === editorialPayload.editorialReview.newsSelection.stories[0].url
  );
  malformedCandidate.publishedAt = 'not-a-time';
  malformedCandidate.publishedAtVerified = true;
  fs.writeFileSync(newsCandidatesPath, `${JSON.stringify(malformedOptionalTimestamp, null, 2)}\n`);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(editorialPayload));
  const malformedOptionalTimestampResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(malformedOptionalTimestampResult.status, 0, malformedOptionalTimestampResult.stderr);
  const malformedOptionalTimestampFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(malformedOptionalTimestampFinalized.stories.length, 9);
  assert.equal(Object.hasOwn(malformedOptionalTimestampFinalized.stories[0], 'publishedAt'), false, 'Malformed optional precision must be omitted from the affected general-News card.');
  assert.equal(malformedOptionalTimestampFinalized.futuresModule.stories.length, 3, 'One malformed general timestamp must not degrade verified Futures stories.');
  assert.equal(malformedOptionalTimestampFinalized.futuresModule.stories[0].publishedAt, dashboard.futuresModule.stories[0].publishedAt);

  const uncappedArtifact = fixtureNewsSearchArtifact(dashboard, editorialPayload.editorialReview.preparedAt);
  while (uncappedArtifact.generalCandidates.length < 260) {
    const index = uncappedArtifact.generalCandidates.length;
    uncappedArtifact.generalCandidates.push({
      title: `Uncapped inventory fixture ${index}`,
      url: `https://www.reuters.com/markets/us/uncapped-inventory-fixture-${index}-2026-07-10`,
      publishedOn: '2026-07-10',
      publishedAt: `2026-07-10T${String(12 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
      sourceLabel: 'Reuters',
      publishedAtVerified: true
    });
  }
  const beyondFormerLimit = uncappedArtifact.generalCandidates.at(-1);
  const uncappedPayload = structuredClone(editorialPayload);
  uncappedPayload.editorialReview.newsSearch.generalCandidates = structuredClone(uncappedArtifact.generalCandidates);
  uncappedPayload.editorialReview.newsSelection.stories[0] = {
    url: beyondFormerLimit.url,
    tag: 'Markets',
    title: 'Reviewed candidate beyond the former inventory limit',
    body: 'The complete prepared inventory remains available for editorial selection.'
  };
  fs.writeFileSync(newsCandidatesPath, `${JSON.stringify(uncappedArtifact, null, 2)}\n`);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(uncappedPayload));
  const uncappedResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(uncappedResult.status, 0, uncappedResult.stderr);
  const uncappedFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.ok(
    uncappedFinalized.stories.some((story) => story.url === beyondFormerLimit.url),
    'Apply must accept a sidecar-owned selection beyond the former 250-candidate inventory limit.'
  );

  const limitedArtifact = fixtureNewsSearchArtifact(dashboard, editorialPayload.editorialReview.preparedAt);
  while (limitedArtifact.cryptoCandidates.length < 15) {
    const index = limitedArtifact.cryptoCandidates.length + 1;
    limitedArtifact.cryptoCandidates.push({
      title: `Extra crypto candidate ${index}`,
      url: `https://candidate.test/crypto-extra-${index}`,
      publishedOn: '2026-07-10',
      sourceLabel: 'Fixture News'
    });
  }
  const extraFuturesCandidate = {
    ...limitedArtifact.futuresCandidates[0],
    title: 'Extra futures candidate 4',
    url: 'https://candidate.test/futures-extra-4'
  };
  limitedArtifact.futuresCandidates.push(extraFuturesCandidate);
  const futuresUrls = new Set(limitedArtifact.futuresCandidates.map((candidate) => candidate.url));
  const limitedGeneralCandidates = limitedArtifact.generalCandidates
    .filter((candidate) => !futuresUrls.has(candidate.url))
    .slice(0, 21);
  const selectionFromCandidate = (candidate, index) => ({
    url: candidate.url,
    tag: 'Markets',
    title: candidate.title,
    body: `Reviewed fixture selection ${index + 1}.`
  });
  const limitedPayload = structuredClone(editorialPayload);
  limitedPayload.editorialReview.newsSelection.futures.push({
    ...selectionFromCandidate(extraFuturesCandidate, 3),
    tag: 'Futures'
  });
  limitedPayload.editorialReview.newsSelection.stories = limitedGeneralCandidates.map(selectionFromCandidate);
  limitedPayload.editorialReview.newsSelection.crypto = limitedArtifact.cryptoCandidates.slice(0, 15)
    .map((candidate, index) => ({ ...selectionFromCandidate(candidate, index), tag: 'Crypto' }));
  fs.writeFileSync(newsCandidatesPath, `${JSON.stringify(limitedArtifact, null, 2)}\n`);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(limitedPayload));
  const limitedResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(limitedResult.status, 0, limitedResult.stderr);
  const limitedFinalized = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(limitedFinalized.stories.length, 18, 'Apply must cap General News at eighteen accepted cards.');
  assert.equal(limitedFinalized.crypto.notes.length, 12, 'Apply must cap Crypto at twelve accepted cards.');
  assert.equal(limitedFinalized.futuresModule.stories.length, 3, 'Apply must cap Futures at three accepted cards.');
  assert.equal(
    limitedFinalized.futuresModule.stories.some((storyItem) => storyItem.url === extraFuturesCandidate.url),
    false,
    'The fourth Futures selection must be omitted.'
  );
  assert.equal(limitedFinalized.storiesCoverage, undefined, 'Optional General omissions must not mark a complete primary set partial.');
  assert.equal(limitedFinalized.crypto.notesCoverage, undefined, 'Optional Crypto omissions must not mark a complete primary set partial.');
  const limitFallbacks = limitedFinalized.editorialReview.systemFallbacks
    .filter((item) => item.reason === 'selection_limit_exceeded');
  assert.equal(limitFallbacks.length, 7, 'Apply must record each independently omitted over-limit selection.');
  assert.equal(limitFallbacks.filter((item) => item.section === 'stories').length, 3);
  assert.equal(limitFallbacks.filter((item) => item.section === 'crypto').length, 3);
  assert.deepEqual(limitFallbacks.filter((item) => item.section === 'futures-news'), [{
    section: 'futures-news',
    path: 'editorialReview.newsSelection.futures[3]',
    action: 'omitted',
    reason: 'selection_limit_exceeded'
  }]);

  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  fs.writeFileSync(payloadFile, JSON.stringify(editorialPayload));
  for (const corruptSidecar of [
    () => fs.unlinkSync(newsCandidatesPath),
    () => fs.writeFileSync(newsCandidatesPath, '{'),
    () => {
      const stale = fixtureNewsSearchArtifact(dashboard, '1999-01-01T00:00:00.000Z');
      fs.writeFileSync(newsCandidatesPath, `${JSON.stringify(stale, null, 2)}\n`);
    },
    () => {
      const differentlySpelledTimestamp = fixtureNewsSearchArtifact(dashboard, editorialPayload.editorialReview.preparedAt);
      differentlySpelledTimestamp.generatedAt = differentlySpelledTimestamp.generatedAt.replace(/Z$/, '+00:00');
      fs.writeFileSync(newsCandidatesPath, `${JSON.stringify(differentlySpelledTimestamp, null, 2)}\n`);
    }
  ]) {
    writeFixtureNewsCandidates(dashboard);
    corruptSidecar();
    fs.writeFileSync(dashboardFile, originalHtml);
    fs.writeFileSync(candidateFile, originalHtml);
    const unavailableResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
    assert.equal(unavailableResult.status, 0, unavailableResult.stderr);
    const unavailable = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
    assert.equal(unavailable.stories.length, 0);
    assert.equal(unavailable.futuresModule.stories.length, 0);
    assert.equal(unavailable.crypto.notes.length, 0);
    assert.equal(unavailable.storiesCoverage.status, 'partial');
    assert.equal(unavailable.futuresModule.storiesCoverage.status, 'partial');
    assert.equal(unavailable.crypto.notesCoverage.status, 'partial');
    const newsFallbacks = unavailable.editorialReview.systemFallbacks.filter((item) => ['futures-news', 'stories', 'crypto'].includes(item.section));
    assert.equal(newsFallbacks.length, 18);
    assert.ok(newsFallbacks.every((item) => item.reason === 'not_in_candidate_inventory'));
  }

  writeFixtureNewsCandidates(dashboard);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  const validResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  assert.equal(validResult.status, 0, validResult.stderr);
  const finalizedHtml = fs.readFileSync(dashboardFile, 'utf8');
  assert.notEqual(finalizedHtml, originalHtml);
  const finalized = readJsonBlock(finalizedHtml, 'dashboard-data');
  assert.equal(finalized.editorialReview.reviewedEditionId, finalized.editionId);
  assert.equal(finalized.opening.headline, 'Reviewed fixture headline');
  assert.equal(finalized.stories.length, 9);
  assert.equal(finalized.futuresModule.stories.length, 3);
  assert.equal(finalized.crypto.notes.length, 6);
  assert.equal(finalized.stories[0].title, 'Reviewed market story');
  assert.equal(finalized.stories[0].sourceLabel, 'Fixture News');
  assert.equal(finalized.futuresModule.stories[0].title, 'Reviewed futures story');
  assert.equal(finalized.futuresModule.stories[0].publishedAt, dashboard.futuresModule.stories[0].publishedAt);
  assert.equal(finalized.futuresModule.stories[0].sourceLabel, 'Fixture News');
  assert.equal(finalized.crypto.notes[0].title, 'Reviewed crypto story');
  assert.equal(finalized.crypto.notes[0].tag, 'Crypto');
  assert.equal('kicker' in finalized.crypto.notes[0], false);
  assert.equal(finalized.crypto.notes[0].sourceLabel, 'Fixture News');
  assert.equal(finalized.storiesCoverage, undefined);
  assert.equal(finalized.futuresModule.storiesCoverage, undefined);
  assert.equal(finalized.crypto.notesCoverage, undefined);
  assert.deepEqual(finalized.tape.rows[0], dashboard.tape.rows[0], 'Editorial input cannot alter an unchanged quote bundle.');
  assert.match(finalized.tape.label, /^Friday After The Bell · Reviewed drivers$/);
  assert.equal(finalized.footer.compiled, 'Compiled Friday, July 10, 2026 at 4:00 PM CDT');
  assert.deepEqual(finalized.futuresModule.futures, dashboard.futuresModule.futures);
  assert.deepEqual(finalized.crypto.stats, dashboard.crypto.stats);
  assert.deepEqual(finalized.crypto.dominance, dashboard.crypto.dominance);
  assert.deepEqual(finalized.assetAllocationPortfolio, dashboard.assetAllocationPortfolio);
  assert.deepEqual(finalized.weekAhead.days.map((day) => day.events), dashboard.weekAhead.days.map((day) => day.events));
  const finalizedEventDay = finalized.weekAhead.days.find((day) => day.date === editorialEventDay.date);
  assert.equal(finalizedEventDay.outcome, undefined);
  assert.equal(finalized.masthead.date, 'Friday · July 10, 2026');
  assert.notEqual(finalized.tape.rows[0].last, '99,999.00');
  assert.ok(!(finalized.editorialReview.systemFallbacks || []).some((item) => item.action === 'unavailable_disposition'));
}

function testPendingEarningsNarrativeStaysPending() {
  const prior = fixtureReportedEarningsRow();
  const pending = structuredClone(prior);
  pending.outcome = {
    ...pending.outcome,
    guide: '',
    guidanceDisposition: { status: 'pending_review' },
    interpretation: '',
    interpretationDisposition: { status: 'pending_review' }
  };
  pending.reaction = {
    ...pending.reaction,
    note: '',
    commentaryDisposition: { status: 'pending_review' }
  };
  const week = (row) => ({
    schemaVersion: 2,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { from: '2026-07-10', to: '2026-07-16' },
    rows: [row],
    secondaryRecoveryCandidates: [],
    summary: { counts: {} }
  });

  const preActualPending = structuredClone(prior);
  preActualPending.eps = { ...preActualPending.eps, actual: null, surprisePercent: null, result: 'pending' };
  preActualPending.revenue = { ...preActualPending.revenue, actual: null, surprisePercent: null, result: 'pending' };
  preActualPending.outcome = {
    overall: 'pending',
    guide: '',
    interpretation: '',
    interpretationDisposition: { status: 'pending_review' }
  };
  preActualPending.reaction = { ...preActualPending.reaction, percent: null, status: 'pending', note: '' };
  preActualPending.lifecycle = 'awaiting_actual';
  const preActualResult = {};
  applyEditorialEarningsNarrative(
    preActualResult,
    { earnings: { week: week(preActualPending) } },
    { earnings: { week: { rows: [preActualPending] } } }
  );
  assert.equal(preActualResult.earnings.week.rows[0].outcome.interpretation, '');
  assert.equal(preActualResult.earnings.week.rows[0].outcome.interpretationDisposition.status, 'pending_review');

  const unchanged = {};
  applyEditorialEarningsNarrative(
    unchanged,
    { earnings: { week: week(pending) } },
    { earnings: { week: { rows: [pending] } } },
    { earnings: { week: week(prior) } }
  );
  assert.equal(unchanged.earnings.week.rows[0].outcome.interpretation, '');
  assert.equal(unchanged.earnings.week.rows[0].outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(unchanged.earnings.week.rows[0].reaction.note, '');
  assert.equal(unchanged.earnings.week.rows[0].reaction.commentaryDisposition.status, 'pending_review');

  const changedPending = structuredClone(pending);
  changedPending.eps = {
    ...changedPending.eps,
    actual: 1.3,
    surprisePercent: 30
  };
  const changed = {};
  applyEditorialEarningsNarrative(
    changed,
    { earnings: { week: week(changedPending) } },
    { earnings: { week: { rows: [changedPending] } } },
    { earnings: { week: week(prior) } }
  );
  assert.equal(changed.earnings.week.rows[0].outcome.interpretation, '');
  assert.equal(changed.earnings.week.rows[0].outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(changed.earnings.week.rows[0].reaction.note, '');
  assert.equal(changed.earnings.week.rows[0].reaction.commentaryDisposition.status, 'pending_review');

  const partial = structuredClone(changedPending);
  partial.outcome = {
    ...partial.outcome,
    interpretation: 'Verified result interpretation can publish without completed guidance.',
    interpretationDisposition: { status: 'verified' },
    guide: '',
    guidanceDisposition: {
      status: 'unverified',
      reason: 'Official company guidance review was not completed.',
      attemptedAt: '2026-07-10T21:00:00.000Z'
    }
  };
  partial.reaction = {
    ...partial.reaction,
    note: 'Verified reaction commentary can publish without completed guidance.',
    commentaryDisposition: { status: 'verified' }
  };
  const partialResult = {};
  applyEditorialEarningsNarrative(
    partialResult,
    { earnings: { week: week(changedPending) } },
    { earnings: { week: { rows: [partial] } } },
    { earnings: { week: week(prior) } }
  );
  assert.equal(partialResult.earnings.week.rows[0].outcome.interpretation, partial.outcome.interpretation);
  assert.equal(partialResult.earnings.week.rows[0].outcome.guidanceDisposition.status, 'unverified');
  assert.equal(partialResult.earnings.week.rows[0].reaction.note, partial.reaction.note);
}

function testMissingEarningsReactionRepairsInsteadOfDroppingRow() {
  const publish = (...rows) => {
    const data = { earnings: { week: { rows: [] } } };
    applyEarningsWeek(data, {
      schemaVersion: 2,
      generatedAt: '2026-07-10T21:00:00.000Z',
      range: { from: '2026-07-10', to: '2026-07-16' },
      rows,
      secondaryRecoveryCandidates: [],
      summary: { counts: {} }
    }, { requireNarrative: false });
    return data.earnings.week.rows;
  };
  const row = (symbol, overrides = {}) => {
    const output = fixtureReportedEarningsRow();
    output.symbol = symbol;
    output.reaction = null;
    output.sourceStatus = 'partial';
    output.sourceSummary.reaction = 'none';
    Object.assign(output, overrides);
    output.sourceAudit.finnhubUsListing.symbol = output.symbol;
    output.sourceAudit.finnhubProfile.marketCap = output.marketCap;
    output.sourceAudit.finnhubCalendar = { reportDate: output.reportDate, reportTiming: output.reportTiming };
    output.sourceAudit.selectedSources = {
      slate: 'finnhub',
      company: 'finnhubProfile',
      marketCap: 'finnhubProfile',
      timing: output.reportTiming === 'unknown' ? 'none' : 'finnhub',
      eps: { estimate: 'finnhub', actual: output.eps.actual === null ? 'none' : 'finnhub' },
      revenue: { estimate: 'finnhub', actual: output.revenue.actual === null ? 'none' : 'finnhub' },
      reaction: 'none'
    };
    return output;
  };
  const scheduled = row('MISSRX', {
    eps: { estimate: 1, actual: null, surprisePercent: null, result: 'pending', basis: 'adjusted', note: '' },
    revenue: { estimate: 1000000000, actual: null, surprisePercent: null, result: 'pending', note: '' },
    outcome: { overall: 'pending', guide: '', interpretation: '' },
    lifecycle: 'scheduled'
  });
  const awaitingClose = row('WAITRX');
  const unavailable = row('UNKRX', {
    reportTiming: 'unknown',
    lifecycle: 'released_awaiting_close'
  });
  unavailable.sourceAudit.finnhubCalendar.reportTiming = 'unknown';
  unavailable.sourceAudit.selectedSources.timing = 'none';
  const computed = row('GOODRX', {
    reaction: {
      basis: 'same_day_close',
      percent: 2,
      fromDate: '2026-07-09',
      fromClose: 100,
      toDate: '2026-07-10',
      toClose: 102,
      status: 'computed',
      note: 'Computed reaction stays.',
      source: 'Yahoo Finance Chart API'
    },
    sourceStatus: 'verified'
  });
  computed.sourceSummary.reaction = 'yahoo';
  computed.sourceAudit.selectedSources.reaction = 'yahoo';
  const rows = publish(scheduled, awaitingClose, unavailable, computed);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((item) => item.symbol === 'MISSRX').reaction.status, 'pending');
  assert.equal(rows.find((item) => item.symbol === 'WAITRX').reaction.status, 'awaiting_close');
  assert.equal(rows.find((item) => item.symbol === 'UNKRX').reaction.status, 'unavailable');
  assert.equal(rows.find((item) => item.symbol === 'GOODRX').reaction.status, 'computed');
}

function testEmptyEarningsWithEvidenceCarriesForwardPriorWeek() {
  const previousRow = fixtureReportedEarningsRow();
  previousRow.sourceAudit.finnhubProfile.marketCap = previousRow.marketCap;
  previousRow.sourceAudit.finnhubCalendar = { reportDate: previousRow.reportDate, reportTiming: previousRow.reportTiming };
  previousRow.sourceAudit.selectedSources = {
    slate: 'finnhub',
    company: 'finnhubProfile',
    marketCap: 'finnhubProfile',
    timing: 'finnhub',
    eps: { estimate: 'finnhub', actual: 'finnhub' },
    revenue: { estimate: 'finnhub', actual: 'finnhub' },
    reaction: 'yahoo'
  };
  const previousWeek = {
    schemaVersion: 2,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { from: '2026-07-10', to: '2026-07-16' },
    rows: [previousRow],
    secondaryRecoveryCandidates: [],
    summary: { counts: {} }
  };
  const emptyWeek = {
    schemaVersion: 2,
    generatedAt: '2026-07-17T21:00:00.000Z',
    range: { from: '2026-07-17', to: '2026-07-23' },
    rows: [],
    secondaryRecoveryCandidates: [],
    summary: { counts: {} }
  };
  const recovered = { earnings: { week: previousWeek } };
  applyEarningsWeek(recovered, emptyWeek, {
    requireNarrative: false,
    previousWeek,
    checkedAt: '2026-07-17T21:30:00.000Z',
    evidenceRows: true
  });
  assert.equal(recovered.earnings.week.rows.length, 1);
  assert.equal(recovered.earnings.week.rows[0].symbol, previousRow.symbol);
  assert.equal(recovered.earnings.week.availability.status, 'carried_forward');
  assert.equal(recovered.earnings.week.availability.reason, 'empty_earnings_recovery');

  assert.throws(
    () => applyEarningsWeek({ earnings: { week: { rows: [] } } }, emptyWeek, {
      requireNarrative: false,
      previousWeek: { rows: [] },
      evidenceRows: true
    }),
    /no previous non-empty canonical week/
  );
}

function testRecoveredEarningsPublishSkipsRecoverySourceRefresh() {
  assert.equal(isEmptyEarningsRecoveryWeek({
    availability: { status: 'carried_forward', reason: 'empty_earnings_recovery' }
  }), true);

  const dir = makeTemporaryDirectory(path.join(root, 'generated'), 'dfd-recovered-earnings-publish-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const lastGoodFile = path.join(dir, 'dashboard.last-good.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const priorHtml = renderDashboardValidationFixture(dashboard, chartData);
  const recoveredDashboard = structuredClone(dashboard);
  const row = fixtureReportedEarningsRow();
  row.reaction = {
    ...row.reaction,
    fromDate: '2026-07-09',
    fromClose: 100,
    toDate: '2026-07-10',
    toClose: 102,
    source: 'Yahoo Finance Chart API'
  };
  recoveredDashboard.earnings.week = {
    ...recoveredDashboard.earnings.week,
    availability: { status: 'carried_forward', reason: 'empty_earnings_recovery', checkedAt: FIXTURE_NOW },
    rows: [row]
  };
  const recoveredHtml = patchDashboardDataBlock(
    renderDashboardValidationFixture(recoveredDashboard, chartData),
    recoveredDashboard,
    null,
    null,
    { stampEdition: false }
  );
  fs.writeFileSync(dashboardFile, priorHtml);
  fs.writeFileSync(lastGoodFile, priorHtml);
  commitDashboardCandidate({ dashboard: dashboardFile }, recoveredHtml, {
    refreshLastGood: !isEmptyEarningsRecoveryWeek(recoveredDashboard.earnings.week),
    lastGoodPath: lastGoodFile
  });
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), recoveredHtml, 'Recovered earnings are still publishable.');
  assert.equal(fs.readFileSync(lastGoodFile, 'utf8'), priorHtml, 'Recovered earnings must not replace the last-good recovery source.');
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
  editorialDashboard.tape.rows[2].note = '';
  const review = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
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
    '--apply-dashboard-data-json', payloadFile
  ];
  const runOptions = {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SCHEDULED_NOW_ISO: '2026-07-10T21:01:00.000Z'
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

async function testMoveSparseYahooHistoryAndDailyChangeReference() {
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  const moveRow = {
    ticker: 'MOVE',
    name: 'MOVE Index',
    section: 'tape',
    sourceSymbol: '^MOVE'
  };
  const yahooPayload = {
    chart: {
      result: [{
        meta: {
          currency: 'USD',
          exchangeTimezoneName: 'America/New_York',
          regularMarketPrice: 69.5796,
          chartPreviousClose: 69.2283
        },
        timestamp: [Date.parse('2026-07-10T20:00:00Z') / 1000],
        indicators: {
          quote: [{
            open: [null],
            high: [null],
            low: [null],
            close: [69.5796],
            volume: [null]
          }]
        }
      }],
      error: null
    }
  };
  const sparseSeries = parseYahooSeries(moveRow, yahooPayload, 'query1.finance.yahoo.com');
  assert.equal(sparseSeries.bars.length, 1);
  assert.equal(sparseSeries.dataKind, 'close');
  assert.equal(sparseSeries.priceOnly, true);
  assert.deepEqual(sparseSeries.bars[0], {
    time: '2026-07-10',
    open: 69.5796,
    high: 69.5796,
    low: 69.5796,
    close: 69.5796
  });
  assert.deepEqual(sparseSeries.dailyChangeReference, {
    asOf: '2026-07-10',
    previousClose: 69.2283
  });
  assert.equal(isValidMoveDailyChangeReference(sparseSeries), true);

  const priorSeries = {
    ...sparseSeries,
    quoteRevision,
    dataKind: 'ohlc',
    priceOnly: false,
    bars: [
      { time: '2026-07-08', open: 76, high: 77, low: 75, close: 76.5 },
      { time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 }
    ]
  };
  delete priorSeries.dailyChangeReference;
  const { dashboard, chartData } = createDashboardValidationFixture();
  chartData.series.push(compactChartPayload({ series: [priorSeries] }).series[0]);
  const priorQuote = quoteRowFromSeries(priorSeries);
  dashboard.tape.rows.push({
    ...dashboard.tape.rows[0],
    ...priorQuote,
    group: 'Rates & Credit',
    name: moveRow.name,
    ticker: moveRow.ticker,
    sourceSymbol: moveRow.sourceSymbol
  });

  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-move-sparse-');
  const input = path.join(dir, 'input.html');
  const output = path.join(dir, 'chart-data.json');
  fs.writeFileSync(input, renderDashboardValidationFixture(dashboard, chartData));
  await runChart([
    '--input', input,
    '--output', output,
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:00.000Z'),
    fetchSeries: async () => structuredClone(sparseSeries)
  });

  const staged = JSON.parse(fs.readFileSync(output, 'utf8'));
  const merged = staged.series[0];
  assert.equal(staged.availability, undefined);
  assert.equal(merged.bars.length, 3);
  assert.equal(merged.bars.at(-1).time, '2026-07-10');
  assert.equal(merged.bars.at(-1).close, 69.5796);
  assert.equal(merged.dataKind, 'ohlc');
  assert.equal(merged.priceOnly, false);
  assert.deepEqual(merged.bars.slice(0, 2), priorSeries.bars, 'Sparse close-only MOVE must preserve exact historical OHLC.');
  assert.deepEqual(merged.bars.at(-1), sparseSeries.bars[0]);
  assert.deepEqual(merged.dailyChangeReference, sparseSeries.dailyChangeReference);
  assert.deepEqual(validateChartStagingPayload(staged, [moveRow]), []);
  assert.deepEqual(quoteRowFromSeries(merged), {
    name: 'MOVE Index',
    ticker: 'MOVE',
    last: '69.58',
    delta: '+0.35',
    pct: '+0.51%',
    dir: 'up',
    sourceSymbol: '^MOVE',
    asOf: '2026-07-10'
  });
  assert.throws(() => quoteRowFromSeries({
    ...merged,
    ticker: 'SPX',
    sourceSymbol: '^GSPC'
  }), /daily change reference is invalid/);

  const replacementInput = path.join(dir, 'replacement-input.html');
  const replacementOutput = path.join(dir, 'replacement-output.json');
  fs.writeFileSync(replacementInput, renderDashboardValidationFixture({
    ...dashboard,
    tape: {
      ...dashboard.tape,
      rows: dashboard.tape.rows.map((row) => row.ticker === 'MOVE'
        ? { ...row, ...quoteRowFromSeries(merged) }
        : row)
    }
  }, {
    ...chartData,
    series: [compactChartPayload({ series: [merged] }).series[0]]
  }));
  await runChart([
    '--input', replacementInput,
    '--output', replacementOutput,
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:15.000Z'),
    fetchSeries: async () => ({
      ...sparseSeries,
      dataKind: 'ohlc',
      priceOnly: false,
      bars: [{ time: '2026-07-10', open: 69.3, high: 69.8, low: 69.1, close: 69.5796 }]
    })
  });
  const replaced = JSON.parse(fs.readFileSync(replacementOutput, 'utf8')).series[0];
  assert.deepEqual(replaced.bars.slice(0, 2), priorSeries.bars);
  assert.deepEqual(replaced.bars.at(-1), {
    time: '2026-07-10', open: 69.3, high: 69.8, low: 69.1, close: 69.5796
  }, 'Later real OHLC must replace the same-date synthetic placeholder.');
  assert.throws(() => quoteRowFromSeries({
    ...merged,
    source: 'Fixture Provider',
    sourceKey: 'fixture_provider'
  }), /daily change reference is invalid/);

  const malformedPrior = {
    ...priorSeries,
    dailyChangeReference: { asOf: '2026-07-08', previousClose: 77.9153 }
  };
  const malformedPriorInput = path.join(dir, 'malformed-prior-input.html');
  const malformedPriorOutput = path.join(dir, 'malformed-prior-output.json');
  fs.writeFileSync(malformedPriorInput, renderDashboardValidationFixture(dashboard, {
    ...chartData,
    series: [compactChartPayload({ series: [malformedPrior] }).series[0]]
  }));
  let malformedPriorFetches = 0;
  await runChart([
    '--input', malformedPriorInput,
    '--output', malformedPriorOutput,
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:30.000Z'),
    fetchSeries: async () => {
      malformedPriorFetches += 1;
      return structuredClone(sparseSeries);
    }
  });
  const recoveredPrior = JSON.parse(fs.readFileSync(malformedPriorOutput, 'utf8'));
  assert.equal(malformedPriorFetches, 1, 'Malformed prior MOVE reference must not block the fresh sparse fetch.');
  assert.equal(recoveredPrior.availability, undefined);
  assert.equal(recoveredPrior.series[0].bars.length, 3);
  assert.deepEqual(recoveredPrior.series[0].dailyChangeReference, sparseSeries.dailyChangeReference);
  await assert.rejects(() => runChart([
    '--input', malformedPriorInput,
    '--output', path.join(dir, 'malformed-prior-failed-output.json'),
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:45.000Z'),
    fetchSeries: async () => { throw new Error('fixture fresh MOVE failure'); }
  }), /MOVE refresh failed and no validated embedded series is available/);

  const missingReferenceOutput = path.join(dir, 'missing-reference.json');
  await runChart([
    '--input', input,
    '--output', missingReferenceOutput,
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:06:00.000Z'),
    fetchSeries: async () => {
      const series = structuredClone(sparseSeries);
      series.bars.unshift({ time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 });
      delete series.dailyChangeReference;
      return series;
    }
  });
  const missingReference = JSON.parse(fs.readFileSync(missingReferenceOutput, 'utf8'));
  assert.equal(missingReference.availability.status, 'partial');
  assert.equal(missingReference.series[0].availability.status, 'carried_forward');
  assert.match(missingReference.availability.failures[0].message, /sparse Yahoo refresh did not include a valid dailyChangeReference/);

  const fewBarsOutput = path.join(dir, 'few-bars.json');
  await runChart([
    '--input', input,
    '--output', fewBarsOutput,
    '--ticker', 'MOVE',
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:07:00.000Z'),
    fetchSeries: async () => {
      const series = structuredClone(sparseSeries);
      series.bars.unshift({ time: '2026-07-09', open: 77.9153, high: 77.9153, low: 77.9153, close: 77.9153 });
      return series;
    }
  });
  const fewBars = JSON.parse(fs.readFileSync(fewBarsOutput, 'utf8'));
  assert.equal(fewBars.availability, undefined);
  assert.equal(fewBars.series[0].bars.length, 3);
  assert.equal(fewBars.series[0].bars[0].time, '2026-07-08');
  assert.deepEqual(fewBars.series[0].bars[1], priorSeries.bars[1], 'A close-only source window must not flatten overlapping historical OHLC.');
  assert.deepEqual(quoteRowFromSeries(fewBars.series[0]), quoteRowFromSeries(merged));

  const malformedCases = [
    ['null reference', (series) => { series.dailyChangeReference = null; }, /dailyChangeReference must be an object/],
    ['primitive reference', (series) => { series.dailyChangeReference = 1; }, /dailyChangeReference must be an object/],
    ['array reference', (series) => { series.dailyChangeReference = []; }, /dailyChangeReference must be an object/],
    ['malformed member', (series) => { delete series.dailyChangeReference.previousClose; }, /previousClose must be a positive finite JSON number/],
    ['stale date', (series) => { series.dailyChangeReference.asOf = '2026-07-09'; }, /asOf must match the latest bar date/],
    ['non-numeric previous close', (series) => { series.dailyChangeReference.previousClose = '69.2283'; }, /previousClose must be a positive finite JSON number/],
    ['non-positive previous close', (series) => { series.dailyChangeReference.previousClose = 0; }, /previousClose must be a positive finite JSON number/],
    ['wrong provenance', (series) => { delete series.sourceKey; }, /requires Yahoo Finance Chart API provenance/],
    ['wrong ticker', (series) => { series.ticker = 'SPX'; }, /supported only for MOVE from \^MOVE/]
  ];
  for (const [label, mutate, expected] of malformedCases) {
    const payload = structuredClone(staged);
    mutate(payload.series[0]);
    assert.match(validateChartStagingPayload(payload, [moveRow]).join('\n'), expected, label);
  }
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
  const carriedChart = buildChartDataFallback(producerChartData, FIXTURE_NOW);
  assert.deepEqual(validateChartStagingPayload(carriedChart, producerDashboard.tape.rows), []);
  carriedChart.series[0].bars[0].time = '2020-01-01';
  assert.deepEqual(
    validateChartStagingPayload(carriedChart, producerDashboard.tape.rows),
    [],
    'Carried-forward chart history may sit outside the current fetch window without blocking a fallback.'
  );
  delete carriedChart.series[0].availability;
  assert.match(validateChartStagingPayload(carriedChart, producerDashboard.tape.rows).join('\n'), /requires every series to be marked carried_forward/);
  syncDashboardPricesFromChartData(producerDashboard, partial, {
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(partial),
    now: new Date(FIXTURE_NOW)
  });
  assert.equal(producerDashboard.tape.rows.find((row) => row.ticker === 'VCR').noteDisposition.status, 'reviewed');
  const partialValidation = validateDashboardAndChartFixture(producerDashboard, compactChartPayload(partial));
  assert.equal(partialValidation.status, 0, partialValidation.stderr);
  assert.equal(fs.readFileSync(producerInput, 'utf8'), originalProducerInput);

  const queuedDashboard = structuredClone(producerDashboard);
  const queuedChartData = structuredClone(producerChartData);
  const extraTickers = ['VDC', 'VDE', 'VFH'];
  for (const [index, ticker] of extraTickers.entries()) {
    const series = structuredClone(producerChartData.series[0]);
    series.ticker = ticker;
    series.name = `Fixture ${ticker}`;
    series.sourceSymbol = ticker;
    series.bars = series.bars.map((bar) => [bar[0], ...bar.slice(1).map((value, valueIndex) => (
      valueIndex < 4 && Number.isFinite(value) ? value + index + 1 : value
    ))]);
    queuedChartData.series.push(series);
    const tapeRow = structuredClone(producerDashboard.tape.rows[0]);
    tapeRow.ticker = ticker;
    tapeRow.name = `Fixture ${ticker}`;
    tapeRow.sourceSymbol = ticker;
    queuedDashboard.tape.rows.push(tapeRow);
  }
  const queuedInput = path.join(dir, 'queued-input.html');
  const queuedOutput = path.join(dir, 'queued-chart-data.json');
  fs.writeFileSync(queuedInput, renderDashboardValidationFixture(queuedDashboard, queuedChartData));
  let releaseInitialWorkers;
  const initialWorkersBlocked = new Promise((resolve) => { releaseInitialWorkers = resolve; });
  let invalidSeriesReturned = false;
  let queuedTickerStartedAfterInvalid = false;
  const fetchedSeries = (row) => ({
    ticker: row.ticker,
    name: row.name,
    section: row.section,
    sourceSymbol: row.sourceSymbol,
    source: 'Yahoo Finance Chart API',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: false,
    bars: [
      { time: '2026-07-09', open: 6100, high: 6110, low: 6090, close: 6100, volume: 1000 },
      { time: '2026-07-10', open: 6190, high: 6210, low: 6180, close: 6200, volume: 1100 }
    ]
  });
  await runChart([
    '--input', queuedInput,
    '--output', queuedOutput,
    ...['SPX', 'VCR', 'UST10Y', ...extraTickers].flatMap((ticker) => ['--ticker', ticker]),
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:07:00.000Z'),
    fetchSeries: async (row) => {
      if (row.ticker === 'VCR') {
        invalidSeriesReturned = true;
        return { ...fetchedSeries(row), bars: fetchedSeries(row).bars.slice(-1) };
      }
      if (row.ticker === 'VDE') {
        queuedTickerStartedAfterInvalid = invalidSeriesReturned;
        releaseInitialWorkers();
        return fetchedSeries(row);
      }
      if (['SPX', 'UST10Y', 'VDC'].includes(row.ticker)) await initialWorkersBlocked;
      return fetchedSeries(row);
    }
  });
  const isolatedFailure = JSON.parse(fs.readFileSync(queuedOutput, 'utf8'));
  assert.equal(queuedTickerStartedAfterInvalid, true, 'A queued ticker must start after an earlier invalid series is isolated.');
  assert.equal(isolatedFailure.availability.status, 'partial');
  assert.equal(isolatedFailure.availability.failures.length, 1);
  assert.equal(isolatedFailure.availability.failures[0].ticker, 'VCR');
  assert.match(isolatedFailure.availability.failures[0].message, /bars must contain at least two daily bars/);
  assert.equal(isolatedFailure.series.find((row) => row.ticker === 'VCR').availability.status, 'carried_forward');
  assert.ok(isolatedFailure.series.filter((row) => row.ticker !== 'VCR')
    .every((row) => row.quoteRevision === isolatedFailure.generatedAt));
  assert.deepEqual(validateChartStagingPayload(isolatedFailure, queuedDashboard.tape.rows), []);

  const contractDashboard = structuredClone(queuedDashboard);
  const contractChartData = structuredClone(queuedChartData);
  const curveSeries = {
    ticker: 'USTCURVE',
    name: 'Fixture Treasury Curve',
    section: 'tape',
    sourceSymbol: 'TREASURY:CURVE',
    quoteRevision: contractChartData.generatedAt,
    source: 'Treasury.gov Daily Treasury Yield Curve Rate Data',
    dataKind: 'close',
    priceOnly: true,
    noVolume: true,
    bars: [
      { time: '2026-07-09', open: 4.1, high: 4.1, low: 4.1, close: 4.1 },
      { time: '2026-07-10', open: 4.2, high: 4.2, low: 4.2, close: 4.2 }
    ],
    curveDate: '2026-07-10',
    curvePoints: [
      { label: '2Y', years: 2, value: 3.9 },
      { label: '10Y', years: 10, value: 4.2 }
    ],
    comparisonCurves: [
      {
        label: '1M ago',
        date: '2026-06-10',
        points: [
          { label: '2Y', years: 2, value: 3.8 },
          { label: '10Y', years: 10, value: 4.1 }
        ]
      },
      {
        label: '6M ago',
        date: '2026-01-09',
        points: [
          { label: '2Y', years: 2, value: 3.7 },
          { label: '10Y', years: 10, value: 4 }
        ]
      }
    ],
    curveSpread: { label: '2s10s', valueBp: 30, comparison: '1D' }
  };
  contractChartData.series.push(compactChartPayload({ series: [curveSeries] }).series[0]);
  const curveTapeRow = structuredClone(contractDashboard.tape.rows.find((row) => row.ticker === 'UST10Y'));
  Object.assign(curveTapeRow, quoteRowFromSeries(curveSeries), {
    group: 'Rates & Credit',
    name: curveSeries.name,
    sourceSymbol: curveSeries.sourceSymbol
  });
  contractDashboard.tape.rows.push(curveTapeRow);
  const contractInput = path.join(dir, 'contract-input.html');
  fs.writeFileSync(contractInput, renderDashboardValidationFixture(contractDashboard, contractChartData));
  const contractTickers = contractDashboard.tape.rows.map((row) => row.ticker);
  const fetchedContractSeries = (row) => {
    if (row.sourceSymbol !== 'TREASURY:CURVE') return fetchedSeries(row);
    const { quoteRevision: _quoteRevision, ...freshCurve } = structuredClone(curveSeries);
    return freshCurve;
  };
  const malformedSeriesCases = [
    {
      label: 'incoherent older OHLC',
      ticker: 'VCR',
      expected: /incoherent OHLC values/,
      mutate: (series) => { series.bars[0].high = series.bars[0].low - 1; }
    },
    {
      label: 'invalid bar date',
      ticker: 'VCR',
      expected: /time must be an ISO date/,
      mutate: (series) => { series.bars[0].time = 'not-a-date'; }
    },
    {
      label: 'unsorted bar dates',
      ticker: 'VCR',
      expected: /time must be strictly ascending/,
      mutate: (series) => { series.bars[1].time = '2026-07-08'; }
    },
    {
      label: 'bar outside payload range',
      ticker: 'VCR',
      expected: /time must fall within payload range/,
      mutate: (series) => { series.bars[1].time = '2026-07-11'; }
    },
    {
      label: 'negative volume',
      ticker: 'VCR',
      expected: /volume must be a non-negative finite JSON number/,
      mutate: (series) => { series.bars[0].volume = -1; }
    },
    {
      label: 'boolean OHLC',
      ticker: 'VCR',
      expected: /open must be a finite JSON number/,
      mutate: (series) => { series.bars[0].open = true; }
    },
    {
      label: 'numeric-string OHLC',
      ticker: 'VCR',
      expected: /open must be a finite JSON number/,
      mutate: (series) => { series.bars[0].open = String(series.bars[0].open); }
    },
    {
      label: 'boolean volume',
      ticker: 'VCR',
      expected: /volume must be a non-negative finite JSON number/,
      mutate: (series) => { series.bars[0].volume = false; }
    },
    {
      label: 'noVolume mismatch',
      ticker: 'VCR',
      expected: /volume must be omitted when noVolume is true/,
      mutate: (series) => { series.noVolume = true; }
    },
    {
      label: 'wrong source symbol',
      ticker: 'VCR',
      expected: /sourceSymbol must be VCR/,
      mutate: (series) => { series.sourceSymbol = 'WRONG'; }
    },
    {
      label: 'wrong section',
      ticker: 'VCR',
      expected: /section must be tape/,
      mutate: (series) => { series.section = 'crypto'; }
    },
    {
      label: 'invalid data kind',
      ticker: 'VCR',
      expected: /dataKind must be ohlc or close/,
      mutate: (series) => { series.dataKind = 'candles'; }
    },
    {
      label: 'priceOnly mismatch',
      ticker: 'VCR',
      expected: /must synthesize OHLC from close for priceOnly series/,
      mutate: (series) => { series.priceOnly = true; }
    },
    {
      label: 'malformed Treasury comparisons',
      ticker: 'USTCURVE',
      expected: /comparisonCurves must include 1M ago/,
      mutate: (series) => { series.comparisonCurves = []; }
    }
  ];
  for (const [caseIndex, malformedCase] of malformedSeriesCases.entries()) {
    const caseOutput = path.join(dir, `contract-isolation-${caseIndex}.json`);
    await runChart([
      '--input', contractInput,
      '--output', caseOutput,
      ...contractTickers.flatMap((ticker) => ['--ticker', ticker]),
      '--days', '1826',
      '--delay-ms', '0'
    ], {
      now: new Date(`2026-07-10T13:${String(10 + caseIndex).padStart(2, '0')}:00.000Z`),
      fetchSeries: async (row) => {
        const series = fetchedContractSeries(row);
        if (row.ticker === malformedCase.ticker) malformedCase.mutate(series);
        return series;
      }
    });
    const casePayload = JSON.parse(fs.readFileSync(caseOutput, 'utf8'));
    assert.deepEqual(
      casePayload.availability.failures.map((failure) => failure.ticker),
      [malformedCase.ticker],
      `${malformedCase.label} must isolate only its ticker.`
    );
    assert.match(casePayload.availability.failures[0].message, malformedCase.expected);
    assert.deepEqual(
      casePayload.series.filter((series) => series.availability?.status === 'carried_forward').map((series) => series.ticker),
      [malformedCase.ticker],
      `${malformedCase.label} must carry forward only its ticker.`
    );
    assert.ok(
      casePayload.series.filter((series) => series.ticker !== malformedCase.ticker)
        .every((series) => series.quoteRevision === casePayload.generatedAt),
      `${malformedCase.label} must leave every other ticker fresh.`
    );
    assert.deepEqual(validateChartStagingPayload(casePayload, contractDashboard.tape.rows), []);
    const caseDashboard = structuredClone(contractDashboard);
    syncDashboardPricesFromChartData(caseDashboard, casePayload, {
      resetCommentary: true,
      commentaryTickers: acceptedFreshChartTickers(casePayload),
      now: new Date(FIXTURE_NOW)
    });
    const caseValidation = validateDashboardAndChartFixture(caseDashboard, compactChartPayload(casePayload), 'staged');
    assert.equal(caseValidation.status, 0, `${malformedCase.label}: ${caseValidation.stderr}`);
  }

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

function testChartStagingRejectsLatestCloseOnlyPlaceholder() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const payload = roundChartPayload(chartData);
  const series = payload.series[0];
  series.dataKind = 'ohlc';
  series.priceOnly = false;
  const latestIndex = series.bars.length - 1;
  delete series.bars[latestIndex].volume;
  const close = series.bars[latestIndex].close;
  series.bars[latestIndex] = { time: series.bars[latestIndex].time, open: close, high: close, low: close, close };

  assert.match(
    validateChartStagingPayload(payload, dashboard.tape.rows).join('\n'),
    new RegExp(`${series.ticker}\\.bars\\[\\d+\\] contains a latest quote-only placeholder`)
  );
}

function testChartMetadataAndAvailabilityContracts() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const valid = roundChartPayload(chartData);
  assert.deepEqual(validateChartPayloadMetadata(valid), []);

  const metadataCases = [
    ['absent range', (payload) => { delete payload.range; }, /range must be an object/],
    ['null range', (payload) => { payload.range = null; }, /range must be an object/],
    ['wrong-type range', (payload) => { payload.range = 'malformed'; }, /range must be an object/],
    ['invalid date', (payload) => { payload.range.startDate = '2026-02-30'; }, /range\.startDate and range\.endDate must be ISO dates/],
    ['reversed dates', (payload) => { payload.range.startDate = '2026-07-11'; }, /range\.startDate must not be after range\.endDate/],
    ['non-integer days', (payload) => { payload.range.days = 1826.5; }, /range\.days must be an integer/],
    ['short history', (payload) => { payload.range.days = 1825; }, /range\.days must be an integer of at least 1826/],
    ['missing generatedAt', (payload) => { delete payload.generatedAt; }, /generatedAt must be an offset-bearing ISO timestamp/]
  ];
  for (const [label, mutate, expected] of metadataCases) {
    const payload = structuredClone(valid);
    mutate(payload);
    assert.match(validateChartStagingPayload(payload, dashboard.tape.rows).join('\n'), expected, label);
    const staged = validateDashboardAndChartFixture(dashboard, compactChartPayload(payload), 'staged');
    assert.equal(staged.status, 1, `${label} must fail staged embedded validation.`);
    assert.match(staged.stderr, expected);
    const published = validateDashboardAndChartFixture(dashboard, compactChartPayload(payload), 'published');
    assert.equal(published.status, 0, `${label} must remain fail-open after publication: ${published.stderr}`);
  }

  const unavailable = buildUnavailableChartData(FIXTURE_NOW);
  delete unavailable.range;
  assert.deepEqual(validateChartPayloadMetadata(unavailable), []);
  assert.deepEqual(validateChartStagingPayload(unavailable, []), []);

  const availabilityCases = [
    ['missing reason', (series) => { delete series.availability.reason; }, /availability\.reason must be source_refresh_failed/],
    ['null checkedAt', (series) => { series.availability.checkedAt = null; }, /availability\.checkedAt must be an offset-bearing ISO timestamp/],
    ['wrong status', (series) => { series.availability.status = 'stale'; }, /availability\.status must be carried_forward/],
    ['nested failures', (series) => { series.availability.failures = []; }, /availability\.failures is not allowed/]
  ];
  for (const [label, mutate, expected] of availabilityCases) {
    const payload = buildChartDataFallback(valid, FIXTURE_NOW);
    mutate(payload.series[0]);
    assert.match(validateChartStagingPayload(payload, dashboard.tape.rows).join('\n'), expected, label);
    const compact = compactChartPayload(payload);
    const staged = validateDashboardAndChartFixture(dashboard, compact, 'staged');
    assert.equal(staged.status, 1, `${label} must fail staged embedded validation.`);
    assert.match(staged.stderr, expected);
    const published = validateDashboardAndChartFixture(dashboard, compact, 'published');
    assert.equal(published.status, 0, `${label} must remain fail-open after publication: ${published.stderr}`);
  }
}

function chartDataWithLatestCloseOnlyPlaceholder(chartData) {
  const payload = structuredClone(chartData);
  const series = payload.series[0];
  series.dataKind = 'ohlc';
  series.priceOnly = false;
  const latestIndex = series.bars.length - 1;
  const latest = series.bars[latestIndex];
  const close = latest[4];
  series.bars[latestIndex] = [latest[0], close, close, close, close, null];
  return payload;
}

async function testChartRerunUsesExecutionRevision() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-chart-revision-');
  const input = path.join(dir, 'input.html');
  const firstOutput = path.join(dir, 'first.json');
  const secondOutput = path.join(dir, 'second.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  fs.writeFileSync(input, renderDashboardValidationFixture(dashboard, chartData));
  const asOf = '2026-07-10T21:00:00.000Z';

  const build = async (output, executionTime, close) => {
    await runChart([
      '--input', input,
      '--output', output,
      '--ticker', 'SPX',
      '--as-of', asOf,
      '--delay-ms', '0'
    ], {
      now: new Date(executionTime),
      fetchSeries: async (row) => ({
        ticker: row.ticker,
        name: row.name,
        section: row.section,
        sourceSymbol: row.sourceSymbol,
        source: 'Yahoo Finance Chart API',
        dataKind: 'ohlc',
        priceOnly: false,
        noVolume: false,
        bars: [
          { time: '2026-07-09', open: 6100, high: 6110, low: 6090, close: 6100, volume: 1000 },
          { time: '2026-07-10', open: 6190, high: 6210, low: 6180, close, volume: 1100 }
        ]
      })
    });
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };

  const first = await build(firstOutput, '2026-07-18T03:00:00.000Z', 6200);
  const second = await build(secondOutput, '2026-07-18T03:00:01.000Z', 6201);
  assert.equal(first.generatedAt, asOf);
  assert.equal(second.generatedAt, asOf);
  assert.notEqual(first.series[0].quoteRevision, second.series[0].quoteRevision);
  assert.deepEqual(chartSeriesRevisionErrors(first, second), []);
  assert.deepEqual(validateChartStagingPayload(second, dashboard.tape.rows.filter((row) => row.ticker === 'SPX')), []);
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
    range: structuredClone(originalChart.range),
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
    SCHEDULED_NOW_ISO: FIXTURE_NOW
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
  fs.writeFileSync(payloadFile, JSON.stringify({ ...repairPayload, quoteRows: [{ ticker: 'SPX' }] }));
  const staleFieldResult = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(staleFieldResult.status, 0, staleFieldResult.stderr);
  assert.match(staleFieldResult.stderr, /quoteRows is no longer stored/);

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
    '--prepare-editorial-dir', editorialDir
  ], { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(editorialResult.status, 0, editorialResult.stderr);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  const handoff = JSON.parse(fs.readFileSync(path.join(editorialDir, 'dashboard-data.json'), 'utf8'));
  const handoffSpxRow = handoff.tape.rows.find((item) => item.ticker === 'SPX');
  assert.equal(handoffSpxRow.noteDisposition.status, 'pending_review');
  assert.equal(handoffSpxRow.note, '');
  assert.deepEqual(handoff.tape.rows.find((item) => item.ticker === 'VCR'), originalVcrRow);
}

function testDashboardEmbeddedRuntimeParses() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const runtime = dashboardRuntimeSource(html);
  assert.doesNotThrow(() => new Function(runtime), 'The complete dashboard runtime must parse as JavaScript.');
  assert.match(runtime, /data\?\.tape\?\.availability\?\.status === 'unavailable'[\s\S]*?Market data unavailable for this update\./,
    'The runtime must render the explicit unavailable Chart/Tape state without initializing a chart.');
}

function testNewsMoreDisclosureRendering() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'news-more-disclosure');
  const { renderStoryCollection } = Function(`${source}\nreturn { renderStoryCollection };`)();
  const cards = Array.from({ length: 18 }, (_, index) => `<article data-story="${index + 1}">Story ${index + 1}</article>`);

  const exactGeneral = renderStoryCollection(cards.slice(0, 9), 'story-grid', 9, 'general');
  assert.equal(exactGeneral.actionHtml, '', 'The header button must be absent when General News has no extras.');
  assert.doesNotMatch(exactGeneral.body, /data-news-more/, 'The controlled panel must be absent when General News has no extras.');
  assert.equal((exactGeneral.body.match(/data-story=/g) || []).length, 9);

  const expandedGeneral = renderStoryCollection(cards, 'story-grid', 9, 'general');
  assert.match(expandedGeneral.actionHtml, /<button class="news-more-toggle"[^>]+data-news-more-toggle/);
  assert.match(expandedGeneral.actionHtml, /aria-expanded="false" aria-controls="news-more-general"/);
  assert.match(expandedGeneral.actionHtml, /More stories <span class="news-more-count">9<\/span>/);
  assert.match(expandedGeneral.actionHtml, /<span class="news-more-expanded">Show fewer<\/span>/);
  assert.match(expandedGeneral.body, /class="story-grid news-more-grid" id="news-more-general" data-news-more-panel hidden/);
  assert.ok(
    expandedGeneral.body.indexOf('data-story="9"') < expandedGeneral.body.indexOf('data-news-more-panel')
      && expandedGeneral.body.indexOf('data-story="10"') > expandedGeneral.body.indexOf('data-news-more-panel'),
    'The first nine General cards must remain in the primary grid and the remainder must follow in the controlled panel.'
  );

  const cryptoCards = cards.slice(0, 12).map((card) => card.replace('data-story', 'data-crypto-story'));
  const expandedCrypto = renderStoryCollection(cryptoCards, 'crypto-notes', 6, 'crypto');
  assert.match(expandedCrypto.actionHtml, /More stories <span class="news-more-count">6<\/span>/);
  assert.match(expandedCrypto.actionHtml, /aria-controls="news-more-crypto"/);
  assert.match(expandedCrypto.body, /class="crypto-notes news-more-grid" id="news-more-crypto"/);
  assert.ok(
    expandedCrypto.body.indexOf('data-crypto-story="6"') < expandedCrypto.body.indexOf('data-news-more-panel')
      && expandedCrypto.body.indexOf('data-crypto-story="7"') > expandedCrypto.body.indexOf('data-news-more-panel'),
    'The first six Crypto cards must remain in the primary grid and the remainder must follow in the controlled panel.'
  );
}

function testEmbeddedChartDecoderSkipsMalformedCompactBars() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'chart-payload-load');
  const payload = {
    series: [{
      ticker: 'SPX',
      bars: [[], ['2026-07-10', 1, 2, 0.5, 'not-a-number', null]]
    }, {
      ticker: 'NDX',
      bars: [['2026-07-09', 1, 2, 0.5, 1, null], ['not-a-date', 1, 2, 0.5, 1, null]]
    }, {
      ticker: 'DJI',
      bars: [['2026-07-10', 1, 2, 0.5, 1, null], ['2026-07-09', 1, 2, 0.5, 1, null]]
    }, {
      ticker: 'RUT',
      bars: [['2026-07-09', 1, 2, 0.5, 1, null], ['2026-07-10', true, true, true, true, false]]
    }, {
      ticker: 'VOX',
      bars: [['2026-07-09', 1, 2, 0.5, 1, null], ['2026-07-10', 100, 50, 90, 95, null]]
    }, {
      ticker: 'VDC',
      bars: [['2026-07-09', 1, 2, 0.5, 1, null], ['2026-07-10', 1, 2, 0.5, 1, -1]]
    }, {
      ticker: 'VIX',
      bars: [
        ['2026-07-09', 20, 21, 19, 20.5, null],
        ['2026-07-10', 21, 22, 20, 21.5, null]
      ]
    }, {
      ticker: 'BTC',
      bars: [['2026-07-10', 100, 101, 99, 100.5, null]]
    }]
  };
  const loadFixtureChartData = new Function('payload', `
    let chartSeriesByTicker = new Map();
    let chartAvailability = null;
    let chartDataReferenceDate = '';
    const document = {
      getElementById(id) {
        return id === 'chart-data' ? { textContent: JSON.stringify(payload) } : null;
      }
    };
    function chartPayloadReferenceDate() { return '2026-07-10'; }
    ${source}
    loadChartData();
    return {
      tickers: [...chartSeriesByTicker.keys()],
      vixBars: chartSeriesByTicker.get('VIX').bars,
      chartDataReferenceDate
    };
  `);
  const result = loadFixtureChartData(payload);
  assert.deepEqual(result.tickers, ['VIX'], 'Malformed or too-short compact series must not enter the browser chart map.');
  assert.deepEqual(result.vixBars[0], { time: '2026-07-09', open: 20, high: 21, low: 19, close: 20.5 });
  assert.equal(result.chartDataReferenceDate, '2026-07-10');
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
    reaction: {
      status: 'computed',
      basis: 'next_session_close',
      commentaryDisposition: { status: 'pending_review' }
    }
  }), '');
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

function testTapeChartRoutingPassesFocusOptions() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'tape-chart-routing');
  const runtime = Function(`
    const available = new Set(['SPX', 'BTC']);
    const calls = [];
    let tapeChartIsOpen = false;
    const activeTapeChartTickerByGroup = new Map();
    const chartSeriesForTicker = (ticker) => available.has(ticker) ? { ticker } : null;
    const closeWeekAheadChart = () => calls.push(['close-week']);
    const closeTapeChart = () => {
      calls.push(['close-tape']);
      tapeChartIsOpen = false;
      activeTapeChartTickerByGroup.clear();
    };
    const syncTapeInlineChart = (key, options) => calls.push(['chart', key, activeTapeChartTickerByGroup.get(key), options]);
    const firstTapeChartTickerForGroup = (groupKey) => groupKey === 'Crypto' ? 'BTC' : '';
    ${source}
    return {
      selectTapeChartRow,
      selectFirstTapeChartRow,
      snapshot: () => ({ calls: [...calls] })
    };
  `)();

  runtime.selectFirstTapeChartRow('Crypto', { focusChart: true });
  assert.deepEqual(runtime.snapshot().calls, [
    ['close-week'],
    ['chart', 'Crypto', 'BTC', { focusChart: true }]
  ]);

  runtime.selectTapeChartRow('Indices', 'spx', { scrollIntoView: true, focusChart: true });
  assert.deepEqual(runtime.snapshot().calls.slice(-2), [
    ['close-week'],
    ['chart', 'Indices', 'SPX', { scrollIntoView: true, focusChart: true }]
  ]);

  runtime.selectTapeChartRow('Indices', 'spx', { scrollIntoView: true, focusChart: true });
  assert.deepEqual(runtime.snapshot().calls.slice(-2), [
    ['close-week'],
    ['chart', 'Indices', 'SPX', { scrollIntoView: true, focusChart: true }]
  ], 'Repeated activation must leave the selected Tape chart open.');
}

function validateDashboardFixture(data, now = FIXTURE_NOW) {
  const { chartData } = createDashboardValidationFixture();
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), now);
}

function validateStagedDashboardFixture(data, now = FIXTURE_NOW) {
  const { chartData } = createDashboardValidationFixture();
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), now, 'staged');
}

function validateDashboardAndChartFixture(data, chartData, validationMode = 'published') {
  return dashboardValidationResult(renderDashboardValidationFixture(data, chartData), FIXTURE_NOW, validationMode);
}

function validationResult(errors, warnings = []) {
  return {
    status: errors.length ? 1 : 0,
    stderr: errors.map((error) => `- ${error}`).join('\n'),
    stdout: warnings.map((warning) => `- ${warning}`).join('\n')
  };
}

function dashboardValidationResult(html, now = FIXTURE_NOW, validationMode = 'published') {
  const result = validateDashboardHtml(html, { now: new Date(now), validationMode });
  return validationResult(result.errors, result.warnings);
}

function validationDashboardData() {
  // Contract mutations start from a fixed, self-contained payload; the live artifact has its own smoke test below.
  return createDashboardValidationFixture().dashboard;
}

function testDashboardValidatorRejectsCalendarRangeDivergence() {
  const staleRange = { from: '2026-07-06', to: '2026-07-10' };
  const alignedStaleCalendar = validationDashboardData();
  alignedStaleCalendar.earnings.week.range = staleRange;
  alignedStaleCalendar.weekAhead = normalizeWeekAhead(tradingViewCalendarFixture(), {
    range: staleRange,
    now: new Date('2026-07-10T18:00:00Z')
  });
  const alignedStaleResult = validateStagedDashboardFixture(alignedStaleCalendar);
  assert.equal(alignedStaleResult.status, 0, 'A stale calendar baseline must remain renderable when Week Ahead and Earnings agree.');

  const staleEarnings = validationDashboardData();
  staleEarnings.earnings.week.range = staleRange;
  const staleEarningsResult = validateStagedDashboardFixture(staleEarnings);
  assert.equal(staleEarningsResult.status, 1);
  assert.match(staleEarningsResult.stderr, /weekAhead\.range must match earnings\.week\.range/);

  const staleWeekAhead = validationDashboardData();
  staleWeekAhead.weekAhead = normalizeWeekAhead(tradingViewCalendarFixture(), {
    range: staleRange,
    now: new Date('2026-07-10T18:00:00Z')
  });
  const staleWeekAheadResult = validateStagedDashboardFixture(staleWeekAhead);
  assert.equal(staleWeekAheadResult.status, 1);
  assert.match(staleWeekAheadResult.stderr, /weekAhead\.range must match earnings\.week\.range/);

  const missingWeekAheadRange = validationDashboardData();
  delete missingWeekAheadRange.weekAhead.range;
  const missingWeekAheadRangeResult = validateStagedDashboardFixture(missingWeekAheadRange);
  assert.equal(missingWeekAheadRangeResult.status, 1);
  assert.match(missingWeekAheadRangeResult.stderr, /weekAhead\.range must be an object with ISO from\/to dates/);

  const missingEarningsRange = validationDashboardData();
  delete missingEarningsRange.earnings.week.range;
  const missingEarningsRangeResult = validateStagedDashboardFixture(missingEarningsRange);
  assert.equal(missingEarningsRangeResult.status, 1);
  assert.match(missingEarningsRangeResult.stderr, /earnings\.week\.range must be an object with ISO from\/to dates/);

  const malformedWeekAheadRange = validationDashboardData();
  malformedWeekAheadRange.weekAhead.range = { from: 'bad', to: '2026-07-10' };
  const malformedWeekAheadRangeResult = validateStagedDashboardFixture(malformedWeekAheadRange);
  assert.equal(malformedWeekAheadRangeResult.status, 1);
  assert.match(malformedWeekAheadRangeResult.stderr, /weekAhead\.range must be an object with ISO from\/to dates/);

  const unsupportedEarningsRange = validationDashboardData();
  unsupportedEarningsRange.earnings.week.range = { from: '2026-07-07', to: '2026-07-11' };
  const unsupportedEarningsRangeResult = validateStagedDashboardFixture(unsupportedEarningsRange);
  assert.equal(unsupportedEarningsRangeResult.status, 1);
  assert.match(unsupportedEarningsRangeResult.stderr, /earnings\.week\.range must cover Monday-Friday or Friday plus next Monday-Thursday/);
}

function testStagedDashboardValidatorEnforcesMarketLensContract() {
  const missingLens = validationDashboardData();
  const missingLensDay = missingLens.weekAhead.days.find((day) => day.events.length);
  delete missingLensDay.marketLens;
  const missingLensResult = validateStagedDashboardFixture(missingLens);
  assert.equal(missingLensResult.status, 1);
  assert.match(missingLensResult.stderr, /marketLens is required when events are present/);

  const blankVerifiedLens = validationDashboardData();
  const blankVerifiedDay = blankVerifiedLens.weekAhead.days.find((day) => day.events.length);
  blankVerifiedDay.marketLens.status = 'verified';
  blankVerifiedDay.marketLens.copy = { question: '', title: '', body: '' };
  const blankVerifiedResult = validateStagedDashboardFixture(blankVerifiedLens);
  assert.equal(blankVerifiedResult.status, 1);
  assert.match(blankVerifiedResult.stderr, /copy\.title must be populated when status is verified/);

  const malformedMarketReaction = validationDashboardData();
  const malformedReactionDay = malformedMarketReaction.weekAhead.days.find((day) => day.events.length);
  malformedReactionDay.marketReaction = {
    rows: [null, 'malformed', {},
      { ticker: 'SPX', role: 'String delta', delta: '1', percentChange: 0.5, unit: 'price' },
      { ticker: 'SPX', role: 'Boolean delta', delta: true, percentChange: 0.5, unit: 'price' },
      { ticker: 'SPX', role: 'Missing delta', percentChange: 0.5, unit: 'price' },
      { ticker: 'SPX', role: 'String percent', delta: 1, percentChange: '0.5', unit: 'price' },
      { ticker: 'SPX', role: 'Boolean percent', delta: 1, percentChange: false, unit: 'price' },
      { ticker: 'SPX', role: 'Missing percent', delta: 1, unit: 'price' },
      { ticker: 'SPX', role: 'Broad growth reaction', delta: 0, percentChange: 0, unit: 'price' },
      { ticker: 'UST10Y', role: 'Rate reaction', delta: 0, unit: 'percent_yield' }]
  };
  const publishedMalformedReaction = validateDashboardFixture(malformedMarketReaction);
  assert.equal(publishedMalformedReaction.status, 0, publishedMalformedReaction.stderr);
  const stagedMalformedReaction = validateStagedDashboardFixture(malformedMarketReaction);
  assert.equal(stagedMalformedReaction.status, 1);
  for (let rowIndex = 0; rowIndex <= 8; rowIndex += 1) {
    assert.match(stagedMalformedReaction.stderr, new RegExp(`marketReaction\\.rows\\[${rowIndex}\\] must be a renderable reaction row`));
  }

  const verifiedOutcomeWithoutCopy = validationDashboardData();
  const outcomeDay = verifiedOutcomeWithoutCopy.weekAhead.days.find((day) => day.events.length);
  outcomeDay.events[0].actual = outcomeDay.events[0].forecast || '1.0%';
  outcomeDay.events[0].status = 'released';
  outcomeDay.lifecycle = 'close_available';
  outcomeDay.marketLens.status = 'commentary_unavailable';
  outcomeDay.marketLens.copy = { question: '', title: '', body: '' };
  outcomeDay.marketReaction = { rows: [{ ticker: outcomeDay.marketLens.reactions[0].ticker }] };
  outcomeDay.outcome = { status: 'verified' };
  const verifiedOutcomeResult = validateStagedDashboardFixture(verifiedOutcomeWithoutCopy);
  assert.equal(verifiedOutcomeResult.status, 1);
  assert.match(verifiedOutcomeResult.stderr, /outcome verified status requires populated title and body/);
}

function testDashboardValidatorKeepsPublishedGateToRenderSurface() {
  const valid = validationDashboardData();
  const validResult = validateDashboardFixture(valid);
  assert.equal(validResult.status, 0, validResult.stderr);

  const recoverableSections = validationDashboardData();
  recoverableSections.opening = null;
  recoverableSections.stories = 'malformed';
  recoverableSections.earnings.week.rows = 'malformed';
  recoverableSections.weekAhead = null;
  recoverableSections.footer = null;
  recoverableSections.tape.rows = [null, 'malformed', ...recoverableSections.tape.rows];
  recoverableSections.crypto.stats = [{ name: 'Fear & Greed', sym: 'F&G', price: '', chg: '' }];
  const recoverableSectionsResult = validateDashboardFixture(recoverableSections);
  assert.equal(recoverableSectionsResult.status, 0, recoverableSectionsResult.stderr);

  const recoverableWeekAheadMembers = validationDashboardData();
  recoverableWeekAheadMembers.weekAhead.days[0].events = [
    recoverableWeekAheadMembers.weekAhead.days[0].events[0],
    null,
    'malformed',
    { impact: 'high' }
  ];
  recoverableWeekAheadMembers.weekAhead.days[1] = null;
  const recoverableWeekAheadResult = validateDashboardFixture(recoverableWeekAheadMembers);
  assert.equal(recoverableWeekAheadResult.status, 0, recoverableWeekAheadResult.stderr);

  const stagedRecoverableWeekAheadResult = validateStagedDashboardFixture(recoverableWeekAheadMembers);
  assert.equal(stagedRecoverableWeekAheadResult.status, 1);
  assert.match(stagedRecoverableWeekAheadResult.stderr, /weekAhead\.days\[(?:0|1)\]/);

  const pendingWithCopy = validationDashboardData();
  const reportedRow = fixtureReportedEarningsRow();
  delete reportedRow.sourceAudit;
  reportedRow.outcome.interpretationDisposition = { status: 'pending_review' };
  reportedRow.outcome.interpretation = 'Stale prior interpretation must not survive a pending disposition.';
  pendingWithCopy.earnings.week.rows = [reportedRow];
  const pendingWithCopyResult = validateDashboardFixture(pendingWithCopy);
  assert.equal(pendingWithCopyResult.status, 0, pendingWithCopyResult.stderr);

  const stagedPendingWithCopyResult = validateStagedDashboardFixture(pendingWithCopy);
  assert.equal(stagedPendingWithCopyResult.status, 1);
  assert.match(stagedPendingWithCopyResult.stderr, /earnings\.week\.EARN\.outcome\.interpretationDisposition\.status pending_review must not carry editorial copy/);
}

function testDashboardValidatorBlocksStartupCrashSurfaces() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const validHtml = renderDashboardValidationFixture(dashboard, chartData);
  assert.equal(dashboardValidationResult(validHtml).status, 0);

  const missingMastDateValueHtml = validHtml.replace('<span id="mast-date-value"></span>', '');
  const missingMastDateValueResult = dashboardValidationResult(missingMastDateValueHtml);
  assert.equal(missingMastDateValueResult.status, 1);
  assert.match(missingMastDateValueResult.stderr, /Missing required dashboard shell marker: <span id="mast-date-value">/);

  const commentedMastDateValueHtml = validHtml.replace('<span id="mast-date-value"></span>', '<!-- <span id="mast-date-value"> -->');
  const commentedMastDateValueResult = dashboardValidationResult(commentedMastDateValueHtml);
  assert.equal(commentedMastDateValueResult.status, 1);
  assert.match(commentedMastDateValueResult.stderr, /Missing required dashboard shell marker: <span id="mast-date-value">/);

  const duplicateMastDateValueHtml = validHtml.replace('<h1 id="hero-headline"></h1>', '<span id="mast-date-value"></span><h1 id="hero-headline"></h1>');
  const duplicateMastDateValueResult = dashboardValidationResult(duplicateMastDateValueHtml);
  assert.equal(duplicateMastDateValueResult.status, 1);
  assert.match(duplicateMastDateValueResult.stderr, /Expected exactly 1 real dashboard shell id #mast-date-value; found 2\./);

  const semanticShellCases = [
    ['harmless attributes', validHtml.replace(
      '<span id="mast-date-value"></span>',
      '<span data-shell-check="allowed" id="mast-date-value"></span>'
    ), 0, null],
    ['encoded harmless class', validHtml.replace(
      '<div class="page" id="app">',
      '<div id="app" class="p&#97;ge">'
    ), 0, null],
    ['different-markup duplicate', validHtml.replace(
      '<main id="content"></main>',
      '<main hidden id="content"></main><main id="content"></main>'
    ), 1, /Expected exactly 1 real dashboard shell id #content; found 2\./],
    ['encoded duplicate id', validHtml.replace(
      '<main id="content"></main>',
      '<main hidden id="cont&#101;nt"></main><main id="content"></main>'
    ), 1, /Expected exactly 1 real dashboard shell id #content; found 2\./],
    ['wrong tag', validHtml.replace('<main id="content"></main>', '<div id="content"></div>'), 1, /#content must use <main>; found <div>/],
    ['hidden required node', validHtml.replace('<main id="content"></main>', '<main hidden id="content"></main>'), 1, /#content must not be hidden/],
    ['wrong nesting', validHtml.replace(
      '<div class="right" id="mast-date"><span id="mast-date-value"></span></div>',
      '<span id="mast-date-value"></span><div class="right" id="mast-date"></div>'
    ), 1, /#mast-date-value must be directly inside #mast-date/],
    ['non-void self-closing syntax', validHtml.replace(
      '<main id="content"></main><footer id="footer"></footer>',
      '<main id="content"/><footer id="footer"></footer>'
    ), 1, /#footer must be directly inside #app/]
  ];
  for (const [label, shellHtml, expectedStatus, expectedError] of semanticShellCases) {
    for (const validationMode of ['published', 'staged']) {
      const result = dashboardValidationResult(shellHtml, FIXTURE_NOW, validationMode);
      assert.equal(result.status, expectedStatus, `${validationMode} ${label}: ${result.stderr}`);
      if (expectedError) assert.match(result.stderr, expectedError, `${validationMode} ${label}`);
    }
  }

  const outOfOrderShellHtml = validHtml.replace(
    '<div id="mast-edition"></div><div class="right" id="mast-date"><span id="mast-date-value"></span></div>',
    '<div class="right" id="mast-date"><span id="mast-date-value"></span></div><div id="mast-edition"></div>'
  );
  const outOfOrderShellResult = dashboardValidationResult(outOfOrderShellHtml);
  assert.equal(outOfOrderShellResult.status, 1);
  assert.match(outOfOrderShellResult.stderr, /Dashboard shell marker is out of order: <div class="right" id="mast-date">/);

  const shellMarkup = '<div class="page" id="app"><div id="mast-edition"></div><div class="right" id="mast-date"><span id="mast-date-value"></span></div><h1 id="hero-headline"></h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>';
  const scriptSpoofHtml = validHtml.replace(shellMarkup, `<script id="shell-spoof">const shellSpoof = ${JSON.stringify(shellMarkup)};</script>`);
  for (const validationMode of ['published', 'staged']) {
    const scriptSpoofResult = dashboardValidationResult(scriptSpoofHtml, FIXTURE_NOW, validationMode);
    assert.equal(scriptSpoofResult.status, 1, `${validationMode} validation must reject shell markers embedded in script text.`);
    assert.match(scriptSpoofResult.stderr, /Missing required dashboard shell marker: <div class="page" id="app">/);
  }

  const templateSpoofResult = dashboardValidationResult(validHtml.replace(shellMarkup, `<template>${shellMarkup}</template>`));
  assert.equal(templateSpoofResult.status, 1);
  assert.match(templateSpoofResult.stderr, /Unexpected <template> container in the dashboard shell/);

  const attributeSpoofHtml = validHtml
    .replace('<span id="mast-date-value"></span>', '')
    .replace('<h1 id="hero-headline">', '<h1 data-shell-spoof=\'<span id="mast-date-value">\' id="hero-headline">');
  const attributeSpoofResult = dashboardValidationResult(attributeSpoofHtml);
  assert.equal(attributeSpoofResult.status, 1);
  assert.match(attributeSpoofResult.stderr, /Missing required dashboard shell marker: <span id="mast-date-value">/);

  const syntaxErrorHtml = replaceDashboardRuntime(validHtml, 'const invalidRuntime = ;');
  const syntaxErrorResult = dashboardValidationResult(syntaxErrorHtml);
  assert.equal(syntaxErrorResult.status, 1);
  assert.match(syntaxErrorResult.stderr, /dashboard-runtime JavaScript is invalid/);

  const missingSeries = structuredClone(chartData);
  missingSeries.series = null;
  const missingSeriesResult = validateDashboardAndChartFixture(dashboard, missingSeries);
  assert.equal(missingSeriesResult.status, 1);
  assert.match(missingSeriesResult.stderr, /chart-data\.series must be an array/);

  const nullSeries = structuredClone(chartData);
  nullSeries.series[0] = null;
  const nullSeriesResult = validateDashboardAndChartFixture(dashboard, nullSeries);
  assert.equal(nullSeriesResult.status, 0, nullSeriesResult.stderr);
  assert.match(nullSeriesResult.stdout, /chart-data\.series\[0\] is not a renderable object and will be skipped/);
  const stagedNullSeriesResult = validateDashboardAndChartFixture(dashboard, nullSeries, 'staged');
  assert.equal(stagedNullSeriesResult.status, 1);
  assert.match(stagedNullSeriesResult.stderr, /chart-data\.series\[0\]\.ticker must be populated/);

  const malformedBars = structuredClone(chartData);
  malformedBars.series[0].bars = 'malformed';
  const malformedBarsResult = validateDashboardAndChartFixture(dashboard, malformedBars);
  assert.equal(malformedBarsResult.status, 0, malformedBarsResult.stderr);
  assert.match(malformedBarsResult.stdout, /chart-data\.series\[0\]\.bars is not an array and will be skipped/);
  const stagedMalformedBarsResult = validateDashboardAndChartFixture(dashboard, malformedBars, 'staged');
  assert.equal(stagedMalformedBarsResult.status, 1);
  assert.match(stagedMalformedBarsResult.stderr, /SPX\.bars must contain at least two daily bars/);

  const objectBar = structuredClone(chartData);
  objectBar.series[0].bars[0] = { time: '2026-07-09', close: 100 };
  const objectBarResult = validateDashboardAndChartFixture(dashboard, objectBar);
  assert.equal(objectBarResult.status, 0, objectBarResult.stderr);
  assert.match(objectBarResult.stdout, /chart-data\.series\[0\]\.bars\[0\] is not a compact bar array and will be skipped/);
  const stagedObjectBarResult = validateDashboardAndChartFixture(dashboard, objectBar, 'staged');
  assert.equal(stagedObjectBarResult.status, 1);
  assert.match(stagedObjectBarResult.stderr, /SPX\.bars\[0\] must be a \[time, open, high, low, close, volume\] tuple/);

  const invalidDateSlot = structuredClone(chartData);
  invalidDateSlot.series[0].bars[1][0] = 'not-a-date';
  const publishedInvalidDateSlotResult = validateDashboardAndChartFixture(dashboard, invalidDateSlot, 'published');
  assert.equal(publishedInvalidDateSlotResult.status, 0, publishedInvalidDateSlotResult.stderr);
  assert.match(publishedInvalidDateSlotResult.stdout, /chart-data\.series\[0\]\.bars\[1\]\.time is not a valid ISO date and will be skipped/);
  const stagedInvalidDateSlotResult = validateDashboardAndChartFixture(dashboard, invalidDateSlot, 'staged');
  assert.equal(stagedInvalidDateSlotResult.status, 1);
  assert.match(stagedInvalidDateSlotResult.stderr, /SPX\.bars\[1\]\.time must be an ISO date/);

  const descendingDateSlot = structuredClone(chartData);
  descendingDateSlot.series[0].bars = [
    ['2026-07-10', 1, 2, 0.5, 1, null],
    ['2026-07-09', 1, 2, 0.5, 1, null]
  ];
  const publishedDescendingDateSlotResult = validateDashboardAndChartFixture(dashboard, descendingDateSlot, 'published');
  assert.equal(publishedDescendingDateSlotResult.status, 0, publishedDescendingDateSlotResult.stderr);
  assert.match(publishedDescendingDateSlotResult.stdout, /chart-data\.series\[0\]\.bars are not strictly ascending/);
  const stagedDescendingDateSlotResult = validateDashboardAndChartFixture(dashboard, descendingDateSlot, 'staged');
  assert.equal(stagedDescendingDateSlotResult.status, 1);
  assert.match(stagedDescendingDateSlotResult.stderr, /SPX\.bars\[1\]\.time must be strictly ascending/);

  const missingVolumeSlot = structuredClone(chartData);
  missingVolumeSlot.series[0].bars[0] = missingVolumeSlot.series[0].bars[0].slice(0, 5);
  const publishedMissingVolumeSlotResult = validateDashboardAndChartFixture(dashboard, missingVolumeSlot, 'published');
  assert.equal(publishedMissingVolumeSlotResult.status, 0, publishedMissingVolumeSlotResult.stderr);
  assert.match(publishedMissingVolumeSlotResult.stdout, /is not a complete \[time, open, high, low, close, volume\] tuple and will be skipped/);
  const stagedMissingVolumeSlotResult = validateDashboardAndChartFixture(dashboard, missingVolumeSlot, 'staged');
  assert.equal(stagedMissingVolumeSlotResult.status, 1);
  assert.match(stagedMissingVolumeSlotResult.stderr, /must be a \[time, open, high, low, close, volume\] tuple/);

  const extraTupleSlot = structuredClone(chartData);
  extraTupleSlot.series[0].bars[0].push('ignored');
  const publishedExtraTupleSlotResult = validateDashboardAndChartFixture(dashboard, extraTupleSlot, 'published');
  assert.equal(publishedExtraTupleSlotResult.status, 0, publishedExtraTupleSlotResult.stderr);
  assert.match(publishedExtraTupleSlotResult.stdout, /is not a complete \[time, open, high, low, close, volume\] tuple and will be skipped/);
  const stagedExtraTupleSlotResult = validateDashboardAndChartFixture(dashboard, extraTupleSlot, 'staged');
  assert.equal(stagedExtraTupleSlotResult.status, 1);
  assert.match(stagedExtraTupleSlotResult.stderr, /must be a \[time, open, high, low, close, volume\] tuple/);

  const emptyTupleSlot = structuredClone(chartData);
  emptyTupleSlot.series[0].bars = [[], []];
  const publishedEmptyTupleSlotResult = validateDashboardAndChartFixture(dashboard, emptyTupleSlot, 'published');
  assert.equal(publishedEmptyTupleSlotResult.status, 0, publishedEmptyTupleSlotResult.stderr);
  assert.match(publishedEmptyTupleSlotResult.stdout, /chart-data\.series\[0\]\.bars\[0\] is not a complete/);
  const stagedEmptyTupleSlotResult = validateDashboardAndChartFixture(dashboard, emptyTupleSlot, 'staged');
  assert.equal(stagedEmptyTupleSlotResult.status, 1);
  assert.match(stagedEmptyTupleSlotResult.stderr, /must be a \[time, open, high, low, close, volume\] tuple/);

  const nullVolumeSlot = structuredClone(chartData);
  nullVolumeSlot.series[0].bars[0][5] = null;
  const nullVolumeSlotResult = validateDashboardAndChartFixture(dashboard, nullVolumeSlot);
  assert.equal(nullVolumeSlotResult.status, 0, nullVolumeSlotResult.stderr);

  const semanticBarCases = [
    {
      label: 'boolean OHLC',
      published: /open is not a finite JSON number/,
      staged: /SPX\.bars\[0\]\.open must be a finite JSON number/,
      mutate: (bar) => { bar[1] = true; }
    },
    {
      label: 'numeric-string OHLC',
      published: /open is not a finite JSON number/,
      staged: /SPX\.bars\[0\]\.open must be a finite JSON number/,
      mutate: (bar) => { bar[1] = String(bar[1]); }
    },
    {
      label: 'incoherent OHLC',
      published: /has incoherent OHLC values and will be skipped/,
      staged: /SPX\.bars\[0\] has incoherent OHLC values/,
      mutate: (bar) => { bar[2] = bar[3] - 1; }
    },
    {
      label: 'negative volume',
      published: /volume is not a non-negative finite JSON number or null/,
      staged: /SPX\.bars\[0\]\.volume must be a non-negative finite JSON number/,
      mutate: (bar) => { bar[5] = -1; }
    },
    {
      label: 'boolean volume',
      published: /volume is not a non-negative finite JSON number or null/,
      staged: /SPX\.bars\[0\]\.volume must be a non-negative finite JSON number/,
      mutate: (bar) => { bar[5] = false; }
    }
  ];
  for (const { label, published, staged, mutate } of semanticBarCases) {
    const malformed = structuredClone(chartData);
    mutate(malformed.series[0].bars[0]);
    const publishedResult = validateDashboardAndChartFixture(dashboard, malformed, 'published');
    assert.equal(publishedResult.status, 0, `${label} must remain fail-open in published validation: ${publishedResult.stderr}`);
    assert.match(publishedResult.stdout, published, label);
    const stagedResult = validateDashboardAndChartFixture(dashboard, malformed, 'staged');
    assert.equal(stagedResult.status, 1, `${label} must fail staged validation.`);
    assert.match(stagedResult.stderr, staged, label);
  }
  const roundedBooleanBar = roundChartPayload({
    series: [{
      ticker: 'SPX',
      bars: [{ time: '2026-07-09', open: true, high: true, low: true, close: true, volume: false }]
    }]
  }).series[0].bars[0];
  assert.deepEqual(
    roundedBooleanBar,
    { time: '2026-07-09', open: null, high: null, low: null, close: null },
    'Rounding must not coerce boolean stored chart values into plausible market data.'
  );
  assert.deepEqual(
    compactChartPayload({ series: [{ ticker: 'SPX', bars: [roundedBooleanBar] }] }).series[0].bars[0],
    ['2026-07-09', null, null, null, null, null],
    'Compaction must preserve malformed numeric fields as unrenderable nulls instead of 1/0.'
  );

  const carriedChartWithoutDiagnostics = compactChartPayload(buildChartDataFallback(chartData, FIXTURE_NOW));
  delete carriedChartWithoutDiagnostics.availability;
  const publishedCarriedWithoutDiagnosticsResult = validateDashboardAndChartFixture(dashboard, carriedChartWithoutDiagnostics);
  assert.equal(
    publishedCarriedWithoutDiagnosticsResult.status,
    0,
    'Published validation should remain limited to render-surface safety for recoverable Chart diagnostics drift.'
  );
  const stagedCarriedWithoutDiagnosticsResult = validateDashboardAndChartFixture(dashboard, carriedChartWithoutDiagnostics, 'staged');
  assert.equal(stagedCarriedWithoutDiagnosticsResult.status, 1);
  assert.match(stagedCarriedWithoutDiagnosticsResult.stderr, /carried-forward series SPX requires partial availability diagnostics/);
}

function testDashboardValidatorEnforcesRuntimeNetworkBoundary() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const validHtml = renderDashboardValidationFixture(dashboard, chartData);
  const canonicalRuntime = validHtml.match(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/)[1];
  for (const validationMode of ['published', 'staged']) {
    const canonicalResult = dashboardValidationResult(validHtml, FIXTURE_NOW, validationMode);
    assert.equal(canonicalResult.status, 0, `${validationMode} canonical runtime: ${canonicalResult.stderr}`);
  }

  const cases = [
    ['direct unexpected URL', `${canonicalRuntime}\nfetch('https://example.com/collect');`, /only the canonical HTTPS LAN market-refresh URL|exactly one canonical await fetch/],
    ['computed unexpected URL', `${canonicalRuntime}\nfetch('https:' + '//example.com/collect');`, /exactly one canonical await fetch/],
    ['fetch alias', `${canonicalRuntime}\nconst externalRequest = fetch; externalRequest('https:' + '//example.com/collect');`, /may reference fetch only/],
    ['computed global fetch', `${canonicalRuntime}\nglobalThis['fe' + 'tch']('https:' + '//example.com/collect');`, /may not access fetch through a member expression/],
    ['mutated endpoint array', canonicalRuntime.replace('for (const url of LOCAL_MARKET_REFRESH_URLS)', "LOCAL_MARKET_REFRESH_URLS[0] = 'https:' + '//example.com/collect';\n  for (const url of LOCAL_MARKET_REFRESH_URLS)"), /may use LOCAL_MARKET_REFRESH_URLS only/],
    ['shadowed loop URL', canonicalRuntime.replace("await fetch(url, { cache: 'no-store' });", "{ const url = 'https:' + '//example.com/collect'; await fetch(url, { cache: 'no-store' }); }"), /exactly one canonical await fetch/],
    ['WebSocket', `${canonicalRuntime}\nnew WebSocket('wss:' + '//example.com/socket');`, /Unexpected dashboard runtime network or dynamic-code API: WebSocket/],
    ['sendBeacon', `${canonicalRuntime}\nnavigator.sendBeacon('/collect', 'data');`, /Unexpected dashboard runtime network or dynamic-code API: sendBeacon/],
    ['dynamic import', `${canonicalRuntime}\nimport('/external-module.js');`, /Unexpected dashboard runtime dynamic import/],
    ['missing endpoint', canonicalRuntime.replace("const LOCAL_MARKET_REFRESH_URLS = ['https://192.168.2.2:2210/api/market-refresh'];", 'const LOCAL_MARKET_REFRESH_URLS = [];'), /must declare exactly one canonical const LOCAL_MARKET_REFRESH_URLS/],
    ['duplicate endpoint', canonicalRuntime.replace("['https://192.168.2.2:2210/api/market-refresh']", "['https://192.168.2.2:2210/api/market-refresh', 'https://192.168.2.2:2210/api/market-refresh']"), /must declare exactly one canonical const LOCAL_MARKET_REFRESH_URLS/]
  ];
  for (const [label, runtime, expectedError] of cases) {
    for (const validationMode of ['published', 'staged']) {
      const result = dashboardValidationResult(replaceDashboardRuntime(validHtml, runtime), FIXTURE_NOW, validationMode);
      assert.equal(result.status, 1, `${validationMode} ${label} must fail validation.`);
      assert.match(result.stderr, expectedError, `${validationMode} ${label}`);
    }
  }
}

function testDashboardValidatorTapeNotesAreModeSpecific() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.tape.rows[0] = unavailableTapeCommentary(
    dashboard.tape.rows[0],
    dashboard.tape.rows[0].noteDisposition.quoteRevision
  );
  const html = renderDashboardValidationFixture(dashboard, chartData);

  const staged = dashboardValidationResult(html, FIXTURE_NOW, 'staged');
  assert.equal(staged.status, 0);
  assert.equal(staged.stdout, '');

  const published = dashboardValidationResult(html, FIXTURE_NOW, 'published');
  assert.equal(published.status, 0);
  assert.equal(published.stdout, '');
}

function testDashboardValidatorCloseOnlyPlaceholderIsStagedOnly() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const html = renderDashboardValidationFixture(dashboard, chartDataWithLatestCloseOnlyPlaceholder(chartData));

  const staged = dashboardValidationResult(html, FIXTURE_NOW, 'staged');
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /SPX\.bars\[1\] contains a latest quote-only placeholder/);

  const published = dashboardValidationResult(html, FIXTURE_NOW, 'published');
  assert.equal(published.status, 0);
  assert.equal(published.stdout, '');
}

function testPrepareNormalizesStaleTapeCommentary() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.tape.rows[0].note = 'Stale commentary that should not survive publication.';
  dashboard.tape.rows[0].noteDisposition = {
    status: 'reviewed',
    quoteRevision: '2026-07-10T11:00:00.000Z',
    reviewedAt: '2026-07-10T11:05:00.000Z'
  };
  const preparedChartData = roundChartPayload(chartData);
  syncDashboardPricesFromChartData(dashboard, preparedChartData, {
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(preparedChartData)
  });
  assert.equal(dashboard.tape.rows[0].note, '');
  assert.deepEqual(dashboard.tape.rows[0].noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: chartData.series[0].quoteRevision
  });
  assert.equal(validateDashboardAndChartFixture(dashboard, chartData).status, 0);
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
      }]
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
  const makeWrap = (buttonSelector, button) => {
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
        : null
    };
  };
  const localButton = makeButton();
  const cryptoButton = makeButton();
  const localWrap = makeWrap('[data-local-refresh-toggle]', localButton);
  const cryptoWrap = makeWrap('[data-stale-button]', cryptoButton);
  const document = {
    querySelectorAll: (selector) => {
      if (selector === '.local-refresh-indicator.is-open') return [localWrap];
      if (selector === '.stale-info.is-open') return [cryptoWrap];
      return [];
    }
  };
  const runtime = Function('document', `${source}\nreturn { routeLocalRefreshTooltipClick, routeStaleInfoTooltipClick, closeTouchTooltipsOnEscape };`)(document);
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
  const cryptoEvent = eventFor('[data-stale-info]', cryptoWrap, '[data-stale-button]', cryptoButton);

  assert.equal(runtime.routeLocalRefreshTooltipClick(localEvent), true);
  assert.equal(localWrap.classList.contains('is-open'), true);
  assert.equal(localButton.attributes['aria-expanded'], 'true');
  assert.equal(runtime.routeLocalRefreshTooltipClick(localEvent), true);
  assert.equal(localWrap.classList.contains('is-open'), false);
  assert.equal(localButton.attributes['aria-expanded'], 'false');
  assert.equal(localButton.blurred, true);

  assert.equal(runtime.routeStaleInfoTooltipClick(cryptoEvent), true);
  assert.equal(cryptoWrap.classList.contains('is-open'), true);
  assert.equal(cryptoButton.attributes['aria-expanded'], 'true');
  runtime.closeTouchTooltipsOnEscape({ key: 'Escape', target: { closest: () => null } });
  assert.equal(cryptoWrap.classList.contains('is-open'), false);
  assert.equal(cryptoButton.attributes['aria-expanded'], 'false');

  assert.match(html, /\.local-refresh-indicator\.is-open \.local-refresh-tooltip/);
  assert.match(html, /\.stale-info\.is-open \.stale-info-tooltip/);
  assert.match(html, /\.stale-info-button\s*\{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/);
  assert.doesNotMatch(html, /week-forecast-(?:qualifier|pill|tooltip)|data-week-forecast/);

  const weekImpactSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-impact-filter');
  const impactEvents = [
    { id: 'high', name: 'High event', impact: 'high' },
    { id: 'medium', name: 'Medium event', impact: 'medium' }
  ];
  const malformedImpactEvents = [null, 'malformed', [], {}, { name: '', impact: 'high' }, { name: 'Bad impact', impact: 'bogus' }, ...impactEvents];
  const highOnlyRuntime = Function(
    'showMediumImpact',
    `${weekImpactSource}\nreturn { renderableWeekAheadItems, renderableWeekAheadEvents, visibleWeekAheadEvents, weekAheadImpactCueHtml };`
  )(false);
  const renderableDay = { date: '2026-07-13' };
  assert.deepEqual(highOnlyRuntime.renderableWeekAheadItems([null, 'malformed', [], renderableDay]), [renderableDay]);
  assert.deepEqual(highOnlyRuntime.renderableWeekAheadEvents(malformedImpactEvents), impactEvents);
  assert.deepEqual(highOnlyRuntime.visibleWeekAheadEvents(malformedImpactEvents), [impactEvents[0]]);
  assert.match(highOnlyRuntime.weekAheadImpactCueHtml(), /aria-pressed="false"/);
  assert.match(highOnlyRuntime.weekAheadImpactCueHtml(), /class="week-impact-check"/);
  assert.match(highOnlyRuntime.weekAheadImpactCueHtml(), /<span data-week-impact-cue-text>Medium impact<\/span>/);
  assert.doesNotMatch(highOnlyRuntime.weekAheadImpactCueHtml(), /Show medium impact|Hide medium impact/);
  const allImpactRuntime = Function(
    'showMediumImpact',
    `${weekImpactSource}\nreturn { visibleWeekAheadEvents, weekAheadImpactCueHtml };`
  )(true);
  assert.deepEqual(allImpactRuntime.visibleWeekAheadEvents(malformedImpactEvents), impactEvents);
  assert.match(allImpactRuntime.weekAheadImpactCueHtml(), /aria-pressed="true"/);
  assert.match(allImpactRuntime.weekAheadImpactCueHtml(), /<span data-week-impact-cue-text>Medium impact<\/span>/);
  assert.match(html, /\.week-impact-cue\[aria-pressed="true"\] \.week-impact-check \{ display: block; \}/);
  assert.match(html, /daily-financial-dashboard:week-medium-impact:v1/);
  assert.match(html, /data-week-impact-toggle/);

  const weekValueSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-values');
  const { weekAheadDisplayValues, weekAheadEventValuesHtml } = Function(
    'esc',
    `${weekValueSource}\nreturn { weekAheadDisplayValues, weekAheadEventValuesHtml };`
  )((value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char])));
  assert.deepEqual(weekAheadDisplayValues({
    previous: '-$105.9B',
    forecast: '-$98B',
    actual: null
  }), {
    previous: '-$105.9B',
    forecast: '-$98.0B',
    actual: null
  });
  assert.deepEqual(weekAheadDisplayValues({
    previous: '0.618M',
    forecast: '0.61M',
    actual: '0.628M'
  }), {
    previous: '0.618M',
    forecast: '0.610M',
    actual: '0.628M'
  });
  assert.deepEqual(weekAheadDisplayValues({
    previous: '-4.3%',
    forecast: '0.61M',
    actual: null
  }), {
    previous: '-4.3%',
    forecast: '0.61M',
    actual: null
  });
  assert.match(weekAheadEventValuesHtml({
    previous: '-$105.9B',
    forecast: '-$98B',
    actual: null
  }), /-\$98\.0B/);

  const weekFamilySource = extractDashboardRuntimeTestBlock(html, 'week-ahead-family');
  const { weekAheadEventGroups } = Function(
    `${weekFamilySource}\nreturn { weekAheadEventGroups };`
  )();
  const rateDecision = { id: 'rate', time: '14:00', name: 'Fed Interest Rate Decision', agency: 'Federal Reserve', impact: 'high' };
  const interveningEvent = { id: 'other', time: '14:15', name: 'Treasury Statement', agency: 'Treasury', impact: 'medium' };
  const pressConference = { id: 'press', time: '14:30', name: 'Fed Press Conference', agency: 'Federal Reserve', impact: 'high' };
  const policyGroups = weekAheadEventGroups(
    [rateDecision, interveningEvent, pressConference],
    [rateDecision, interveningEvent, pressConference]
  );
  assert.equal(policyGroups.length, 2);
  assert.deepEqual(policyGroups[0].events.map((event) => event.id), ['rate', 'press']);
  assert.equal(policyGroups[0].family.title, 'Federal Reserve Decision');

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
  const pendingEditorialMarkup = earningsRowNoticeHtml({ editorialPending: true });
  assert.match(pendingEditorialMarkup, /Editorial commentary was not completed for this update\./);
  assert.match(html, /lastValidatedAt: carriedForwardAt && !sameEditionDate\(carriedForwardAt, dashboardData\?\.editionId\) \? carriedForwardAt : ''/);

  const earningsUnavailableSource = extractDashboardRuntimeTestBlock(html, 'earnings-unavailable');
  const { earningsUnavailableHtml } = Function(
    `${earningsUnavailableSource}\nreturn { earningsUnavailableHtml };`
  )();
  const earningsUnavailableMarkup = earningsUnavailableHtml();
  assert.match(earningsUnavailableMarkup, /<strong>Unavailable<\/strong>/);
  assert.doesNotMatch(earningsUnavailableMarkup, /refresh|calendar source|week data|retry|provider/i);
  assert.doesNotMatch(html, /Earnings refresh unavailable; showing the last validated slate|Earnings calendar source unavailable for this week|Earnings week data unavailable/);
  assert.match(html, /week\.availability\?\.status === 'unavailable'[\s\S]*?return earningsUnavailableHtml\(\)/);

  const weekTimeSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-time');
  const { weekAheadTimeLabel } = Function(
    `${weekTimeSource}\nreturn { weekAheadTimeLabel };`
  )();
  assert.equal(
    weekAheadTimeLabel(
      { date: '2026-07-14' },
      { time: '08:30' }
    ),
    '7:30 AM',
    'Published rendering must use the fixed Eastern source and Central display zones instead of malformed payload zones.'
  );
  assert.equal(weekAheadTimeLabel({ date: 'malformed' }, { time: null }), 'TBD');

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
  assert.match(cachedWeekMarkup, /Week Ahead calendar is carried forward/);
  assert.match(cachedWeekMarkup, /validated calendar is carried forward for the same displayed range/);
  assert.match(cachedWeekMarkup, /Last validated Jul 10, 8:30 AM CT\./);
  const carriedWeek = {
    ...weekStatusFixture,
    source: { ...weekStatusFixture.source, status: 'cached' },
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  };
  assert.equal(weekAheadAvailabilityState(carriedWeek), 'carried_forward', 'Current availability must override retained source provenance.');
  assert.match(weekAheadAvailabilityInfoHtml(carriedWeek), /Week Ahead calendar is carried forward/);
  assert.equal(weekAheadAvailabilityInfoHtml({
    ...weekStatusFixture,
    availability: { status: 'unavailable', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  }), '');
  assert.doesNotMatch(cachedWeekMarkup, /FXMacroData|HTTP|retry/i);

  const weekOutcomeSource = extractDashboardRuntimeTestBlock(html, 'week-ahead-outcome');
  const { weekAheadOutcomeHtml, weekAheadReactionsHtml, weekAheadCloseReactionHtml } = Function(
    'esc',
    'weekReactionButtonHtml',
    `${weekOutcomeSource}\nreturn { weekAheadOutcomeHtml, weekAheadReactionsHtml, weekAheadCloseReactionHtml };`
  )((value) => String(value), (_day, ticker, _role, label = ticker) => `<button>${label}</button>`);
  const filteredSetupReactions = weekAheadReactionsHtml(
    { date: '2026-07-14' },
    {
      reactions: [null, 'malformed', [], {}, { ticker: 'BAD-TICKER', role: 'Bad ticker' }, { ticker: 'SPX', role: '' }, { ticker: 'SPX', role: 'Broad growth reaction' }]
    }
  );
  assert.equal((filteredSetupReactions.match(/<button>/g) || []).length, 1);
  assert.match(filteredSetupReactions, />SPX<\/button>/);
  const filteredCloseReactions = weekAheadCloseReactionHtml({
    date: '2026-07-14',
    marketReaction: {
      rows: [null, 'malformed', {},
        { ticker: 'SPX', role: 'Bad delta', delta: '1', percentChange: 0.5, unit: 'price' },
        { ticker: 'SPX', role: 'Boolean delta', delta: true, percentChange: 0.5, unit: 'price' },
        { ticker: 'SPX', role: 'Bad percent', delta: 1, percentChange: '0.5', unit: 'price' },
        { ticker: 'SPX', role: 'Boolean percent', delta: 1, percentChange: false, unit: 'price' },
        { ticker: 'SPX', role: 'Broad growth reaction', delta: 0, percentChange: 0, unit: 'price' }]
    }
  });
  assert.equal((filteredCloseReactions.match(/<button>/g) || []).length, 1);
  assert.match(filteredCloseReactions, /SPX 0\.00%/);
  assert.doesNotMatch(filteredCloseReactions, /NaN/);
  const unavailableOutcome = weekAheadOutcomeHtml({
    date: '2026-07-15',
    lifecycle: 'close_available',
    outcome: { status: 'pending_review' },
    marketReaction: { rows: [] }
  });
  assert.doesNotMatch(unavailableOutcome, /<strong>(?:Pending|Unavailable)<\/strong>/);
  assert.match(unavailableOutcome, /Outcome commentary was not completed for this update\./);
  assert.match(unavailableOutcome, /data-stale-button/);
  assert.doesNotMatch(unavailableOutcome, /No selected transmission ticker/);
  assert.doesNotMatch(unavailableOutcome, /Post-event commentary unavailable|Released facts/);
  const pendingOutcome = weekAheadOutcomeHtml({
    date: '2026-07-14',
    lifecycle: 'close_available',
    outcome: { status: 'pending_review' },
    marketReaction: { rows: [] }
  });
  assert.doesNotMatch(pendingOutcome, /<strong>(?:Pending|Unavailable)<\/strong>/);
  assert.match(pendingOutcome, /Outcome commentary was not completed for this update\./);
  assert.match(pendingOutcome, /data-stale-button/);
  assert.equal(weekAheadOutcomeHtml({ lifecycle: 'close_available', marketReaction: { rows: [] } }), '');
  const zeroMoveOutcome = weekAheadOutcomeHtml({
    date: '2026-07-14',
    label: 'Tue, Jul 14',
    lifecycle: 'close_available',
    outcome: {
      status: 'verified',
      title: 'The close was unchanged',
      body: 'The selected transmission tickers finished flat.'
    },
    marketReaction: {
      rows: [
        { ticker: 'SPX', role: 'Equity reaction', delta: 0, percentChange: 0, unit: 'price' },
        { ticker: 'UST10Y', role: 'Rate reaction', delta: 0, percentChange: 0, unit: 'percent_yield' }
      ]
    }
  });
  assert.match(zeroMoveOutcome, /SPX 0\.00%/);
  assert.match(zeroMoveOutcome, /UST10Y 0 bp/);
  assert.doesNotMatch(zeroMoveOutcome, /No selected transmission ticker/);

  assert.doesNotMatch(html, /week-ledger-status-dot/);
  assert.match(html, /Market Lens commentary was not completed for this update\./);
  assert.match(html, /lens\?\.status === 'commentary_unavailable'\s*\?\s*weekAheadReactionsHtml\(day, lens, weekAheadPendingMarketLensInfoHtml\(day\)\)/);
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
  const moveDailyChangeSource = extractDashboardRuntimeTestBlock(html, 'move-daily-change-reference');
  const tapeStaleRuntime = Function('esc', `
    const STALE_CHART_WARNING_BUSINESS_DAYS = 2;
    let chartDataReferenceDate = '2026-07-14';
    const isFiniteValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    const isFiniteChartNumber = (value) => typeof value === 'number' && Number.isFinite(value);
    const chartLatestDate = (series) => series?.bars?.at(-1)?.time || '';
    const chartDateLabel = (value) => value;
    ${moveDailyChangeSource}
    ${tapeStaleSource}
    return { chartBusinessDayGap, tapeSeriesIsStale, tapeSeriesHasLatestCloseOnlyPlaceholder, tapeStaleInfo, tapeCommentaryInfo };
  `)((value) => String(value));
  const moveSeries = { ticker: 'MOVE', bars: [{ time: '2026-07-10' }] };
  const moveQuoteOnlySeries = {
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'ohlc',
    priceOnly: false,
    dailyChangeReference: { asOf: '2026-07-14', previousClose: 70.5 },
    bars: [{ time: '2026-07-14', open: 70.8777, high: 70.8777, low: 70.8777, close: 70.8777 }]
  };
  assert.equal(tapeStaleRuntime.chartBusinessDayGap('2026-07-10', '2026-07-13'), 1);
  assert.equal(tapeStaleRuntime.chartBusinessDayGap('2026-07-10', '2026-07-14'), 2);
  assert.equal(tapeStaleRuntime.tapeSeriesIsStale(moveSeries), true);
  assert.equal(tapeStaleRuntime.tapeSeriesHasLatestCloseOnlyPlaceholder(moveQuoteOnlySeries), true);
  assert.equal(tapeStaleRuntime.tapeSeriesHasLatestCloseOnlyPlaceholder({
    ...moveQuoteOnlySeries,
    source: 'Fixture Provider'
  }), false);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveQuoteOnlySeries, { ticker: 'MOVE' }), /MOVE data issue/);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveQuoteOnlySeries, { ticker: 'MOVE' }), /open\/high\/low data for that date was unavailable/);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /MOVE data is stale/);
  assert.match(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /Last valid quote: 2026-07-10\./);
  assert.doesNotMatch(tapeStaleRuntime.tapeStaleInfo(moveSeries, { ticker: 'MOVE' }), /not updated/);
  assert.match(tapeStaleRuntime.tapeCommentaryInfo({
    ticker: 'SPX',
    note: '',
    noteDisposition: { status: 'commentary_unavailable', quoteRevision: FIXTURE_NOW }
  }), /Commentary unavailable for this refreshed quote/);
  assert.equal(tapeStaleRuntime.tapeCommentaryInfo({
    ticker: 'BTC',
    note: 'Reviewed crypto commentary.',
    displayQuoteRevision: FIXTURE_NOW,
    noteDisposition: { status: 'reviewed', quoteRevision: FIXTURE_NOW, reviewedAt: FIXTURE_NOW }
  }), '');
  const staleCommentaryMarkup = tapeStaleRuntime.tapeCommentaryInfo({
    ticker: 'BTC',
    note: 'Reviewed crypto commentary.',
    displayQuoteRevision: '2026-07-10T14:00:00Z',
    noteDisposition: { status: 'reviewed', quoteRevision: FIXTURE_NOW, reviewedAt: FIXTURE_NOW }
  });
  assert.match(staleCommentaryMarkup, /commentary-stale-info/);
  assert.match(staleCommentaryMarkup, /Commentary reviewed Jul 10, 8:30 AM CT; local quote refreshed Jul 10, 9:00 AM CT\./);
  assert.doesNotMatch(staleCommentaryMarkup, /predates|subsequent price move/);
  assert.equal(tapeStaleRuntime.tapeCommentaryInfo({
    ticker: 'BTC',
    note: 'Malformed reviewed commentary.',
    displayQuoteRevision: '2026-07-10T14:00:00Z',
    noteDisposition: { status: 'reviewed', quoteRevision: FIXTURE_NOW }
  }), '', 'Reviewed commentary without a valid review timestamp must not render an incomplete tooltip.');
  const tapeSignalCss = html.match(/\.tape-signal \{([\s\S]*?)\n    \}/)?.[1] || '';
  const tapeSignalCopyCss = html.match(/\.tape-signal-copy \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.match(tapeSignalCss, /display:\s*flex;/);
  assert.match(tapeSignalCss, /overflow:\s*visible;/, 'The commentary tooltip container must not clip its tooltip.');
  assert.doesNotMatch(tapeSignalCss, /-webkit-line-clamp|overflow:\s*hidden/);
  assert.match(tapeSignalCopyCss, /display:\s*-webkit-box;/);
  assert.match(tapeSignalCopyCss, /overflow:\s*hidden;/);
  assert.match(tapeSignalCopyCss, /-webkit-line-clamp:\s*2;/);
  assert.match(
    html,
    /\.tape-row \.stale-info:hover,\s*\.tape-row \.stale-info:focus-within,\s*\.tape-row \.stale-info\.is-open\s*\{\s*z-index:\s*3;/,
    'The active Tape information control must stack above neighboring information controls.'
  );
  assert.match(
    html,
    /<span class="tape-signal">\$\{tapeCommentaryInfo\(row\)\}<span class="tape-signal-copy">\$\{esc\(row\.note\)\}<\/span><\/span>/,
    'Only the commentary text wrapper may own two-line clipping; the tooltip must remain its unclipped sibling.'
  );
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

  const portfolioDividendSource = extractDashboardRuntimeTestBlock(html, 'portfolio-dividend-info');
  const { dividendAmountText } = Function(
    `${portfolioDividendSource}\nreturn { dividendAmountText };`
  )();
  assert.equal(
    dividendAmountText({
      monthDivPerShare: '$99.0000',
      monthDivPerShareValue: 0.4
    }, 'monthDivPerShareValue', [{ exDate: '2026-07-10', amount: 0.4 }]),
    '$0.4000',
    'Visible dividend amounts must be formatted from canonical numeric totals, not stored display strings.'
  );
  assert.equal(
    dividendAmountText({
      upcomingCurrentMonthDividends: '$99.0000'
    }, 'upcomingCurrentMonthDividendsValue', [{ exDate: '2026-07-30', amount: 0.5 }]),
    '$0.5000',
    'Missing numeric totals may fall back to the validated event sum.'
  );
  for (const invalidTotal of [null, undefined, '', '0.4', -1, Number.NaN]) {
    assert.equal(
      dividendAmountText(
        { monthDivPerShareValue: invalidTotal },
        'monthDivPerShareValue',
        [
          { exDate: '2026-07-10', amount: '99' },
          { exDate: '2026-07-11', amount: -1 },
          { exDate: '2026-07-12', amount: 0.4 }
        ]
      ),
      '$0.4000',
      `Invalid raw total ${String(invalidTotal)} must fall back only to valid numeric event amounts.`
    );
  }
  assert.equal(
    dividendAmountText({ monthDivPerShareValue: 0 }, 'monthDivPerShareValue', [{ amount: 0.4 }]),
    '',
    'A canonical numeric zero must remain zero instead of being replaced by the event fallback.'
  );

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
      dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' },
      stats: [{
        sym: 'TOTAL', name: 'Crypto Market Cap', price: '$1.00T',
        availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
      }]
    }
  };
  const carriedDominance = {
    btc: '54.00%', eth: '11.00%', others: '35.00%',
    availability: { status: 'carried_forward', reason: 'source_refresh_failed', checkedAt: FIXTURE_NOW }
  };
  assert.equal(applyLocalCryptoStats(locallyRefreshed, [], carriedDominance), false);
  assert.deepEqual(locallyRefreshed.crypto.dominance, { btc: '55.00%', eth: '10.00%', others: '35.00%' });
  assert.equal(applyLocalCryptoStats(
    locallyRefreshed,
    [{ sym: 'TOTAL', price: '$1.01T' }],
    { btc: '54.00%', eth: '11.00%', others: '35.00%' }
  ), true);
  assert.equal(locallyRefreshed.crypto.availability, undefined);
  assert.equal(locallyRefreshed.crypto.stats[0].availability, undefined);
  assert.deepEqual(locallyRefreshed.crypto.dominance, { btc: '54.00%', eth: '11.00%', others: '35.00%' });

  const moveReferenceSource = extractDashboardRuntimeTestBlock(html, 'move-daily-change-reference');
  const localSeriesMergeSource = extractDashboardRuntimeTestBlock(html, 'local-refresh-series-merge');
  const localQuoteRowsSource = extractDashboardRuntimeTestBlock(html, 'local-refresh-quote-rows');
  const localQuoteRowsRuntime = Function(
    `${moveReferenceSource}\n${localSeriesMergeSource}\n${localQuoteRowsSource}\nreturn { applyTapeQuoteRows, applyCryptoQuoteRows, deriveTapeQuoteRowFromSeries };`
  )();
  const reviewedDisposition = {
    status: 'reviewed',
    quoteRevision: FIXTURE_NOW,
    reviewedAt: FIXTURE_NOW
  };
  const refreshedRevision = '2026-07-18T03:00:01.000Z';
  const baseTapeRow = {
    ticker: 'SPX',
    last: '100',
    delta: '+1',
    pct: '+1.00%',
    dir: 'up',
    asOf: '2026-07-09',
    note: 'Existing equity commentary.',
    noteDisposition: reviewedDisposition
  };
  const baseCryptoRow = {
    ticker: 'BTC',
    last: '$60,000',
    delta: '+$1,000',
    pct: '+2.00%',
    dir: 'up',
    asOf: '2026-07-09',
    note: 'Existing crypto commentary.',
    noteDisposition: reviewedDisposition
  };
  const localQuoteDashboard = {
    tape: {
      rows: [
        null,
        'malformed',
        baseTapeRow,
        { ticker: 'VCR', last: '200', delta: '0.00', pct: '0.00%', dir: 'flat', asOf: '2026-07-09', note: 'Untouched commentary.', noteDisposition: reviewedDisposition },
        baseCryptoRow
      ]
    }
  };
  assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(localQuoteDashboard, [{
    ticker: 'SPX', last: '100', delta: '+1', pct: '+1.00%', dir: 'up', asOf: '2026-07-09', quoteRevision: refreshedRevision
  }]), true);
  assert.equal(localQuoteDashboard.tape.rows[2].note, 'Existing equity commentary.');
  assert.equal(localQuoteDashboard.tape.rows[2].displayQuoteRevision, refreshedRevision);
  assert.deepEqual(localQuoteDashboard.tape.rows[2].noteDisposition, {
    ...reviewedDisposition,
    quoteRevision: refreshedRevision
  });
  assert.deepEqual(localQuoteDashboard.tape.rows[3].noteDisposition, reviewedDisposition);
  assert.equal(localQuoteRowsRuntime.applyCryptoQuoteRows(localQuoteDashboard, [{
    ticker: 'BTC', price: '$60,000', delta: '+$1,000', chg: '+2.00%', dir: 'up', asOf: '2026-07-09', quoteRevision: refreshedRevision
  }]), true);
  assert.equal(localQuoteDashboard.tape.rows[4].note, 'Existing crypto commentary.');
  assert.equal(localQuoteDashboard.tape.rows[4].displayQuoteRevision, refreshedRevision);
  assert.deepEqual(localQuoteDashboard.tape.rows[4].noteDisposition, {
    ...reviewedDisposition,
    quoteRevision: refreshedRevision
  });
  [
    ['last', { last: '101' }],
    ['delta', { delta: '+2' }],
    ['pct', { pct: '+2.00%' }],
    ['dir', { dir: 'down' }],
    ['asOf', { asOf: '2026-07-10' }]
  ].forEach(([field, override]) => {
    const changedQuoteDashboard = { tape: { rows: [structuredClone(baseTapeRow)] } };
    assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(changedQuoteDashboard, [{
      ticker: 'SPX',
      last: '100',
      delta: '+1',
      pct: '+1.00%',
      dir: 'up',
      asOf: '2026-07-09',
      quoteRevision: refreshedRevision,
      ...override
    }]), true, `A changed ${field} field must preserve reviewed commentary as stale.`);
    assert.equal(changedQuoteDashboard.tape.rows[0].note, 'Existing equity commentary.');
    assert.equal(changedQuoteDashboard.tape.rows[0].displayQuoteRevision, refreshedRevision);
    assert.deepEqual(changedQuoteDashboard.tape.rows[0].noteDisposition, reviewedDisposition);
  });
  const repeatedlyRefreshedDashboard = { tape: { rows: [structuredClone(baseCryptoRow)] } };
  assert.equal(localQuoteRowsRuntime.applyCryptoQuoteRows(repeatedlyRefreshedDashboard, [{
    ticker: 'BTC', price: '$60,100', delta: '+$1,100', chg: '+2.10%', dir: 'up', asOf: '2026-07-09', quoteRevision: refreshedRevision
  }]), true);
  const secondRefreshedRevision = '2026-07-18T03:30:01.000Z';
  assert.equal(localQuoteRowsRuntime.applyCryptoQuoteRows(repeatedlyRefreshedDashboard, [{
    ticker: 'BTC', price: '$60,100', delta: '+$1,100', chg: '+2.10%', dir: 'up', asOf: '2026-07-09', quoteRevision: secondRefreshedRevision
  }]), true);
  assert.equal(repeatedlyRefreshedDashboard.tape.rows[0].note, 'Existing crypto commentary.');
  assert.equal(repeatedlyRefreshedDashboard.tape.rows[0].displayQuoteRevision, secondRefreshedRevision);
  assert.deepEqual(repeatedlyRefreshedDashboard.tape.rows[0].noteDisposition, reviewedDisposition);
  [
    ['absent disposition', undefined],
    ['null disposition', null],
    ['primitive disposition', 'reviewed'],
    ['array disposition', []],
    ['missing reviewedAt', { status: 'reviewed', quoteRevision: FIXTURE_NOW }],
    ['unavailable row with stale note', { status: 'commentary_unavailable', quoteRevision: FIXTURE_NOW, note: 'Stale note.' }]
  ].forEach(([label, disposition]) => {
    const malformedRow = structuredClone(baseTapeRow);
    if (label === 'absent disposition') {
      delete malformedRow.noteDisposition;
    } else if (label === 'unavailable row with stale note') {
      malformedRow.noteDisposition = disposition;
      malformedRow.note = disposition.note;
    } else {
      malformedRow.noteDisposition = disposition;
    }
    const malformedDashboard = { tape: { rows: [malformedRow] } };
    assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(malformedDashboard, [{
      ticker: 'SPX', last: '100', delta: '+1', pct: '+1.00%', dir: 'up', asOf: '2026-07-09', quoteRevision: refreshedRevision
    }]), true, `Malformed ${label} must not preserve commentary.`);
    assert.equal(malformedDashboard.tape.rows[0].note, '');
    assert.deepEqual(malformedDashboard.tape.rows[0].noteDisposition, {
      status: 'commentary_unavailable',
      quoteRevision: refreshedRevision
    });
  });
  const unavailableDashboard = {
    tape: {
      rows: [{
        ...baseTapeRow,
        note: '',
        noteDisposition: { status: 'commentary_unavailable', quoteRevision: FIXTURE_NOW }
      }]
    }
  };
  assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(unavailableDashboard, [{
    ticker: 'SPX', last: '100', delta: '+1', pct: '+1.00%', dir: 'up', asOf: '2026-07-09', quoteRevision: refreshedRevision
  }]), true);
  assert.deepEqual(unavailableDashboard.tape.rows[0].noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: refreshedRevision
  });
  const staleQuoteDashboard = { tape: { rows: [structuredClone(baseTapeRow)] } };
  assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(staleQuoteDashboard, [{
    ticker: 'SPX', last: '99', delta: '-1', pct: '-1.00%', dir: 'down', asOf: '2026-07-08', quoteRevision: refreshedRevision
  }]), false, 'A stale local quote must be ignored.');
  assert.deepEqual(staleQuoteDashboard.tape.rows[0], baseTapeRow);
  assert.equal(localQuoteRowsRuntime.applyTapeQuoteRows(localQuoteDashboard, [{
    ticker: 'SPX', last: '999', delta: '+999', pct: '+999.00%', dir: 'up', asOf: '2026-07-12'
  }]), false, 'A local quote without a valid revision must be ignored.');
  assert.equal(localQuoteDashboard.tape.rows[2].last, '100');
  assert.deepEqual(localQuoteRowsRuntime.deriveTapeQuoteRowFromSeries({
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    quoteRevision: refreshedRevision,
    dailyChangeReference: { asOf: '2026-07-10', previousClose: 69.2283 },
    bars: [
      { time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 },
      { time: '2026-07-10', open: 69.2283, high: 69.5796, low: 69.2283, close: 69.5796 }
    ]
  }), {
    ticker: 'MOVE',
    last: '69.58',
    delta: '+0.35',
    pct: '+0.51%',
    dir: 'up',
    asOf: '2026-07-10',
    quoteRevision: refreshedRevision
  });
  assert.deepEqual(localQuoteRowsRuntime.deriveTapeQuoteRowFromSeries({
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Fixture Provider',
    sourceKey: 'fixture_provider',
    quoteRevision: refreshedRevision,
    dailyChangeReference: { asOf: '2026-07-10', previousClose: 69.2283 },
    bars: [
      { time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 },
      { time: '2026-07-10', open: 69.2283, high: 69.5796, low: 69.2283, close: 69.5796 }
    ]
  }), {
    ticker: 'MOVE',
    last: '69.58',
    delta: '-8.34',
    pct: '-10.70%',
    dir: 'down',
    asOf: '2026-07-10',
    quoteRevision: refreshedRevision
  });
  assert.deepEqual(localQuoteRowsRuntime.deriveTapeQuoteRowFromSeries({
    ticker: 'SPX',
    sourceSymbol: '^GSPC',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    quoteRevision: refreshedRevision,
    dailyChangeReference: { asOf: '2026-07-10', previousClose: 1 },
    bars: [
      { time: '2026-07-09', open: 6000, high: 6100, low: 5900, close: 6000 },
      { time: '2026-07-10', open: 6100, high: 6200, low: 6000, close: 6200 }
    ]
  }), {
    ticker: 'SPX',
    last: '6,200.00',
    delta: '+200.00',
    pct: '+3.33%',
    dir: 'up',
    asOf: '2026-07-10',
    quoteRevision: refreshedRevision
  });
  const tapeGroupsSource = extractDashboardRuntimeTestBlock(html, 'tape-groups');
  const tapeGroupsRuntime = Function('TAPE_GROUPS', 'tapeGroupKey', `${tapeGroupsSource}\nreturn { tapeGroupsForData };`)(
    [{ label: 'Equities', tickers: ['SPX', 'NDX'] }],
    (label) => label.toLowerCase()
  );
  assert.deepEqual(tapeGroupsRuntime.tapeGroupsForData(localQuoteDashboard).map((group) => group.rows.map((row) => row.ticker)), [['SPX']]);
  assert.doesNotMatch(html, /Market-driver commentary is temporarily unavailable/);
}

async function testTapeTooltipStacksAboveNeighboringInfoControlsInBrowser() {
  const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const { chromium } = require('playwright');
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
      <div style="position:fixed;left:24px;top:80px;width:300px;z-index:9999">
        <div class="quote-row tape-row" style="display:block;height:48px;padding:0;border:0">
          <span class="stale-info" id="active-info" style="position:absolute;left:16px;top:20px">
            <button class="stale-info-button" id="active-info-button" type="button">i</button>
            <span class="stale-info-tooltip" id="active-tooltip" role="tooltip">Commentary reviewed Jul 10, 8:30 AM CT; local quote refreshed Jul 10, 9:00 AM CT.</span>
          </span>
        </div>
        <div class="quote-row tape-row" style="display:block;height:48px;padding:0;border:0">
          <span class="stale-info" style="position:absolute;left:16px;top:20px">
            <button class="stale-info-button" id="neighbor-info-button" type="button">i</button>
          </span>
        </div>
      </div>
    </body></html>`);

    const assertTooltipOnTop = async (label) => {
      await page.waitForTimeout(180);
      const result = await page.evaluate(() => {
        const tooltip = document.getElementById('active-tooltip');
        const neighbor = document.getElementById('neighbor-info-button');
        const tooltipRect = tooltip.getBoundingClientRect();
        const neighborRect = neighbor.getBoundingClientRect();
        const left = Math.max(tooltipRect.left, neighborRect.left);
        const right = Math.min(tooltipRect.right, neighborRect.right);
        const top = Math.max(tooltipRect.top, neighborRect.top);
        const bottom = Math.min(tooltipRect.bottom, neighborRect.bottom);
        const x = (left + right) / 2;
        const y = (top + bottom) / 2;
        const topmost = right > left && bottom > top ? document.elementFromPoint(x, y) : null;
        return {
          overlaps: right > left && bottom > top,
          tooltipOnTop: Boolean(topmost && (topmost === tooltip || tooltip.contains(topmost))),
          visible: getComputedStyle(tooltip).visibility === 'visible' && getComputedStyle(tooltip).opacity === '1',
          insideViewport: tooltipRect.left >= 0
            && tooltipRect.top >= 0
            && tooltipRect.right <= window.innerWidth
            && tooltipRect.bottom <= window.innerHeight
        };
      });
      assert.equal(result.overlaps, true, `${label}: fixture must overlap the neighboring information control.`);
      assert.equal(result.visible, true, `${label}: tooltip must be visible.`);
      assert.equal(result.insideViewport, true, `${label}: tooltip must remain inside the viewport.`);
      assert.equal(result.tooltipOnTop, true, `${label}: tooltip must paint above the neighboring information control.`);
    };

    for (const viewport of [
      { width: 390, height: 844, label: 'mobile' },
      { width: 768, height: 1024, label: 'tablet' },
      { width: 1440, height: 900, label: 'desktop' }
    ]) {
      await page.setViewportSize(viewport);
      const activeInfo = page.locator('#active-info');
      const activeButton = page.locator('#active-info-button');

      await activeButton.hover();
      await assertTooltipOnTop(`${viewport.label} hover`);

      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await activeButton.focus();
      await assertTooltipOnTop(`${viewport.label} keyboard focus`);

      await page.evaluate(() => {
        document.activeElement?.blur();
        document.getElementById('active-info').classList.add('is-open');
      });
      await assertTooltipOnTop(`${viewport.label} open state`);
      await activeInfo.evaluate((element) => element.classList.remove('is-open'));
    }
  } finally {
    if (browser) await browser.close();
    if (previousBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
  }
}

async function testNewsMoreDisclosureInBrowser() {
  const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const { chromium } = require('playwright');
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  const source = extractDashboardRuntimeTestBlock(html, 'news-more-disclosure');
  const { renderStoryCollection } = Function(`${source}\nreturn { renderStoryCollection };`)();
  const storyCards = Array.from({ length: 18 }, (_, index) => (
    `<article class="story editorial-card surface card" data-general-story="${index + 1}">General ${index + 1}</article>`
  ));
  const cryptoCards = Array.from({ length: 12 }, (_, index) => (
    `<article class="crypto-note editorial-card surface card" data-crypto-story="${index + 1}">Crypto ${index + 1}</article>`
  ));
  const exactCards = storyCards.slice(0, 9).map((card) => card.replace('data-general-story', 'data-exact-story'));
  const generalCollection = renderStoryCollection(storyCards, 'story-grid', 9, 'general-fixture');
  const cryptoCollection = renderStoryCollection(cryptoCards, 'crypto-notes', 6, 'crypto-fixture');
  const exactCollection = renderStoryCollection(exactCards, 'story-grid', 9, 'exact-fixture');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
      <main style="max-width:1180px;margin:32px auto;padding:0 20px">
        <section id="general-fixture" class="section section-news">
          <div class="section-head"><div><div class="section-label">News Flow</div><h2 class="section-title">What’s Moving Today</h2></div>${generalCollection.actionHtml}</div>
          ${generalCollection.body}
        </section>
        <section id="crypto-fixture" class="section section-crypto">
          <div class="section-head"><div><div class="section-label">Digital Assets</div><h2 class="section-title">Crypto</h2></div>${cryptoCollection.actionHtml}</div>
          <div class="crypto-grid">${cryptoCollection.body}</div>
        </section>
        <section id="exact-fixture" class="section section-news">
          <div class="section-head"><div><div class="section-label">Exact</div><h2 class="section-title">No Extras</h2></div>${exactCollection.actionHtml}</div>
          ${exactCollection.body}
        </section>
      </main>
      <script>${source}
        document.addEventListener('click', (event) => {
          const button = event.target.closest('[data-news-more-toggle]');
          if (button) toggleNewsMore(button);
        });
      <\/script>
    </body></html>`);

    assert.equal(await page.locator('#exact-fixture [data-news-more-toggle]').count(), 0, 'A section without extras must not expose a header button.');

    for (const viewport of [
      { width: 390, height: 844, columns: 1, label: 'mobile' },
      { width: 768, height: 1024, columns: 2, label: 'tablet' },
      { width: 1440, height: 900, columns: 3, label: 'desktop' }
    ]) {
      await page.setViewportSize(viewport);
      const generalButton = page.locator('#general-fixture [data-news-more-toggle]');
      const generalPanel = page.locator('#general-fixture [data-news-more-panel]');
      const cryptoButton = page.locator('#crypto-fixture [data-news-more-toggle]');
      const cryptoPanel = page.locator('#crypto-fixture [data-news-more-panel]');

      assert.equal(await generalButton.getAttribute('aria-expanded'), 'false', `${viewport.label}: General extras must start collapsed.`);
      assert.equal(await generalPanel.getAttribute('hidden'), '', `${viewport.label}: the collapsed General panel must be hidden.`);
      assert.equal(await page.locator('#general-fixture [data-general-story]:visible').count(), 9, `${viewport.label}: nine General cards must be initially visible.`);
      assert.equal(await page.locator('#crypto-fixture [data-crypto-story]:visible').count(), 6, `${viewport.label}: six Crypto cards must be initially visible.`);
      assert.equal(await page.locator('#general-fixture .story-grid').first().evaluate((element) => (
        getComputedStyle(element).gridTemplateColumns.split(' ').length
      )), viewport.columns, `${viewport.label}: the primary General grid must retain its responsive column count.`);
      const headerLayout = await page.locator('#general-fixture').evaluate((section) => {
        const headRect = section.querySelector('.section-head').getBoundingClientRect();
        const titleRect = section.querySelector('.section-head > div:first-child').getBoundingClientRect();
        const buttonRect = section.querySelector('[data-news-more-toggle]').getBoundingClientRect();
        return {
          rightOffset: Math.abs(headRect.right - buttonRect.right),
          bottomOffset: Math.abs(titleRect.bottom - buttonRect.bottom),
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
        };
      });
      assert.ok(headerLayout.rightOffset <= 1, `${viewport.label}: the More stories button must align to the header's right edge.`);
      assert.ok(headerLayout.bottomOffset <= 1, `${viewport.label}: the More stories button must remain on the title row.`);
      assert.ok(headerLayout.overflow <= 0, `${viewport.label}: the header button must not cause horizontal overflow.`);

      await generalButton.click();
      assert.equal(await generalButton.getAttribute('aria-expanded'), 'true', `${viewport.label}: pointer activation must expand General extras.`);
      assert.equal(await generalPanel.getAttribute('hidden'), null, `${viewport.label}: the expanded General panel must be exposed.`);
      assert.equal(await page.locator('#general-fixture [data-general-story]:visible').count(), 18, `${viewport.label}: all eighteen General cards must be visible after expansion.`);
      assert.equal(await generalButton.getByText('Show fewer').isVisible(), true, `${viewport.label}: the expanded label must be visible.`);
      const generalGap = await page.locator('#general-fixture').evaluate((section) => {
        const primaryRect = section.querySelector('.story-grid').getBoundingClientRect();
        const extrasRect = section.querySelector('.news-more-grid').getBoundingClientRect();
        return extrasRect.top - primaryRect.bottom;
      });
      await generalButton.press('Enter');
      assert.equal(await generalButton.getAttribute('aria-expanded'), 'false', `${viewport.label}: keyboard activation must collapse General extras.`);

      await cryptoButton.click();
      assert.equal(await cryptoButton.getAttribute('aria-expanded'), 'true', `${viewport.label}: Crypto extras must expand independently.`);
      assert.equal(await page.locator('#crypto-fixture [data-crypto-story]:visible').count(), 12, `${viewport.label}: all twelve Crypto cards must be visible after expansion.`);
      const cryptoGap = await page.locator('#crypto-fixture').evaluate((section) => {
        const primaryRect = section.querySelector('.crypto-notes').getBoundingClientRect();
        const extrasRect = section.querySelector('.news-more-grid').getBoundingClientRect();
        return extrasRect.top - primaryRect.bottom;
      });
      assert.ok(
        Math.abs(generalGap - cryptoGap) <= 1,
        `${viewport.label}: General and Crypto secondary-card spacing must match.`
      );
      await cryptoButton.press('Enter');
      assert.equal(await cryptoButton.getAttribute('aria-expanded'), 'false', `${viewport.label}: Crypto extras must collapse with the keyboard.`);
    }
  } finally {
    if (browser) await browser.close();
    if (previousBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
  }
}

function testLocalRefreshKeepsNewerEmbeddedSeriesProvenance() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const chartPayloadSource = extractDashboardRuntimeTestBlock(html, 'chart-payload-load');
  const moveReferenceSource = extractDashboardRuntimeTestBlock(html, 'move-daily-change-reference');
  const source = extractDashboardRuntimeTestBlock(html, 'local-refresh-series-merge');
  const { mergeSeriesMap } = Function(`
    ${chartPayloadSource}
    ${moveReferenceSource}
    ${source}
    return { mergeSeriesMap };
  `)();
  const seriesMap = new Map([[
    'VAW',
    {
      ticker: 'VAW',
      source: 'Yahoo Finance Chart API + Finnhub Quote API',
      latestQuoteSource: 'Finnhub Quote API',
      quoteRevision: '2026-07-10T13:30:00.000Z',
      bars: [
        { time: '2026-07-02', open: 231, high: 232, low: 230, close: 231 },
        { time: '2026-07-06', open: 232.3, high: 232.5, low: 229.59, close: 232.06 }
      ]
    }
  ]]);

  const changed = mergeSeriesMap(seriesMap, [{
    ticker: 'VAW',
    source: 'Yahoo Finance Chart API',
    latestQuoteSource: '',
    staleRefreshOnly: true,
    quoteRevision: '2026-07-10T13:31:00.000Z',
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
    quoteRevision: '2026-07-10T13:32:00.000Z',
    bars: [
      { time: '2026-07-06', open: 232.3, high: 232.5, low: 229.59, close: 232.06 },
      { time: '2026-07-07', open: 232.1, high: 233, low: 231, close: 232.5 }
    ]
  }]);

  const currentMerge = seriesMap.get('VAW');
  assert.equal(currentMerge.source, 'Local refreshed chart API');
  assert.equal(currentMerge.latestQuoteSource, 'Local refreshed quote API');
  assert.equal(currentMerge.bars.at(-1).time, '2026-07-07');
  assert.equal(mergeSeriesMap(seriesMap, [structuredClone(currentMerge)]), false);
  const reusedRevision = structuredClone(currentMerge);
  reusedRevision.bars.at(-1).close += 0.1;
  reusedRevision.bars.at(-1).high += 0.1;
  assert.equal(mergeSeriesMap(seriesMap, [reusedRevision]), false, 'Changed local data must not reuse an existing quote revision.');

  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'UNKNOWN',
    bars: [
      { time: '2026-07-06', open: 1, high: 1, low: 1, close: 1 },
      { time: '2026-07-07', open: 2, high: 2, low: 2, close: 2 }
    ]
  }]), false);
  assert.equal(seriesMap.has('UNKNOWN'), false);

  seriesMap.set('MOVE', {
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: true,
    quoteRevision: '2026-07-10T13:30:00.000Z',
    bars: [
      { time: '2026-07-08', open: 76, high: 77, low: 75, close: 76.5 },
      { time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 }
    ]
  });
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'close',
    priceOnly: true,
    noVolume: true,
    quoteRevision: '2026-07-10T13:31:00.000Z',
    dailyChangeReference: { asOf: '2026-07-10', previousClose: 69.2283 },
    bars: [
      { time: '2026-07-10', open: 69.5796, high: 69.5796, low: 69.5796, close: 69.5796 }
    ]
  }]), true);
  const sparseMoveMerge = seriesMap.get('MOVE');
  assert.equal(sparseMoveMerge.bars.length, 3);
  assert.equal(sparseMoveMerge.bars.at(-1).time, '2026-07-10');
  assert.equal(sparseMoveMerge.dataKind, 'ohlc');
  assert.equal(sparseMoveMerge.priceOnly, false);
  assert.deepEqual(sparseMoveMerge.bars.slice(0, 2), [
    { time: '2026-07-08', open: 76, high: 77, low: 75, close: 76.5 },
    { time: '2026-07-09', open: 77, high: 79, low: 76, close: 77.9153 }
  ]);
  assert.deepEqual(sparseMoveMerge.dailyChangeReference, { asOf: '2026-07-10', previousClose: 69.2283 });
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: true,
    quoteRevision: '2026-07-10T13:32:00.000Z',
    dailyChangeReference: { asOf: '2026-07-10', previousClose: 69.2283 },
    bars: [
      { time: '2026-07-10', open: 69.3, high: 69.8, low: 69.1, close: 69.5796 }
    ]
  }]), true);
  assert.deepEqual(seriesMap.get('MOVE').bars.at(-1), {
    time: '2026-07-10', open: 69.3, high: 69.8, low: 69.1, close: 69.5796
  });
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Fixture Provider',
    sourceKey: 'fixture_provider',
    quoteRevision: '2026-07-10T13:33:00.000Z',
    dailyChangeReference: { asOf: '2026-07-11', previousClose: 69.5796 },
    bars: [
      { time: '2026-07-11', open: 69.5796, high: 70, low: 69, close: 70 }
    ]
  }]), false);
  assert.equal(seriesMap.get('MOVE').bars.at(-1).time, '2026-07-10');
  const beforeMalformed = structuredClone(seriesMap.get('MOVE'));
  const malformedBars = [
    null,
    'malformed',
    ['2026-07-11', 69, 70, 68, 69, null],
    { time: '2026-07-11', open: '69', high: 70, low: 68, close: 69 },
    { time: '2026-02-30', open: 69, high: 70, low: 68, close: 69 },
    { time: '2026-07-11', open: 69, high: 68, low: 67, close: 69 },
    { time: '2026-07-11', open: 69, high: 70, low: 68, close: 69, volume: -1 }
  ];
  for (const malformedBar of malformedBars) {
    assert.equal(mergeSeriesMap(seriesMap, [{
      ticker: 'MOVE',
      sourceSymbol: '^MOVE',
      source: 'Yahoo Finance Chart API',
      sourceKey: 'yahoo_chart',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: true,
      quoteRevision: '2026-07-10T13:34:00.000Z',
      dailyChangeReference: { asOf: '2026-07-11', previousClose: 69.5796 },
      bars: [malformedBar]
    }]), false);
    assert.deepEqual(seriesMap.get('MOVE'), beforeMalformed);
  }
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: true,
    quoteRevision: '2026-07-10T13:29:00.000Z',
    dailyChangeReference: { asOf: '2026-07-11', previousClose: 69.5796 },
    bars: [{ time: '2026-07-11', open: 69, high: 70, low: 68, close: 69.5 }]
  }]), false, 'A stale local quote revision must not replace a newer embedded/local series.');
  for (const malformedRevision of [null, 1, {}, [], 'not-a-timestamp']) {
    assert.equal(mergeSeriesMap(seriesMap, [{
      ticker: 'MOVE',
      sourceSymbol: '^MOVE',
      source: 'Yahoo Finance Chart API',
      sourceKey: 'yahoo_chart',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: true,
      quoteRevision: malformedRevision,
      dailyChangeReference: { asOf: '2026-07-11', previousClose: 69.5796 },
      bars: [{ time: '2026-07-11', open: 69, high: 70, low: 68, close: 69.5 }]
    }]), false);
  }
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'MOVE',
    sourceSymbol: '^MOVE',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: true,
    dailyChangeReference: { asOf: '2026-07-11', previousClose: 69.5796 },
    bars: [{ time: '2026-07-11', open: 69, high: 70, low: 68, close: 69.5 }]
  }]), false, 'A local series without quoteRevision must be ignored.');
  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'SPX',
    sourceSymbol: '^GSPC',
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    bars: [
      { time: '2026-07-10', open: 6100, high: 6200, low: 6000, close: 6200 }
    ]
  }]), false);
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

async function testLocalMarketServerNormalizesAllChartSeries() {
  const originalFetchSeries = chartDataModule.fetchSeries;
  const originalFetchCryptoStats = cryptoStatsModule.fetchCryptoStats;
  try {
    chartDataModule.fetchSeries = async (row) => ({
      ...row,
      source: 'Fixture Provider',
      sourceKey: 'fixture_provider',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: false,
      bars: row.ticker === 'XAG' ? [
        {
          time: '2026-08-13',
          open: 64.87300109863281,
          high: 64.87300109863281,
          low: 64.77999877929688,
          close: 64.87300109863281,
          volume: 3
        },
        {
          time: '2026-08-14',
          open: 64.62999725341797,
          high: 65.875,
          low: 63.64500045776367,
          close: 65.10800170898438,
          volume: 31855
        }
      ] : [
        {
          time: '2026-08-13',
          open: 100.123456,
          high: 101.111119,
          low: 99.999994,
          close: 100.123456,
          volume: 1234.6
        },
        {
          time: '2026-08-14',
          open: 100.200006,
          high: 101.222229,
          low: 100.111114,
          close: 100.358456,
          volume: 1235.4
        }
      ]
    });
    cryptoStatsModule.fetchCryptoStats = async () => ({ stats: [], dominance: {} });

    const payload = await buildMarketRefresh(parseLocalMarketServerArgs([
      '--days', '5',
      '--input', path.join(root, 'daily_financial_news.html')
    ]));
    assert.deepEqual(payload.errors, []);
    assert.ok(payload.series.length > 1);
    for (const series of payload.series) {
      for (const bar of series.bars) {
        for (const field of ['open', 'high', 'low', 'close']) {
          assert.equal(bar[field], Number(bar[field].toFixed(4)), `${series.ticker}.${field} must use canonical precision.`);
        }
        assert.ok(Number.isInteger(bar.volume), `${series.ticker}.volume must use canonical whole-number precision.`);
      }
    }

    const silver = payload.series.find((series) => series.ticker === 'XAG');
    assert.deepEqual(silver.bars.map((bar) => bar.close), [64.873, 65.108]);
    const refreshedSilverQuote = quoteRowFromSeries(silver);
    assert.equal(refreshedSilverQuote.delta, '+0.23');
    const embeddedDashboard = readJsonBlock(
      fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8'),
      'dashboard-data'
    );
    const embeddedSilverQuote = embeddedDashboard.tape.rows.find((row) => row.ticker === 'XAG');
    for (const field of ['last', 'delta', 'pct', 'dir', 'asOf']) {
      assert.equal(refreshedSilverQuote[field], embeddedSilverQuote[field], `XAG.${field} must not create a false local change.`);
    }
    const spx = payload.series.find((series) => series.ticker === 'SPX');
    assert.deepEqual(spx.bars[0], {
      time: '2026-08-13',
      open: 100.1235,
      high: 101.1111,
      low: 100,
      close: 100.1235,
      volume: 1235
    });
  } finally {
    chartDataModule.fetchSeries = originalFetchSeries;
    cryptoStatsModule.fetchCryptoStats = originalFetchCryptoStats;
  }
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
  testFetchConcurrencyHelperContract,
  testArchitectureSingleWriterAndCliBoundaries,
  testDeterministicSectionFallbackContracts,
  testSectionTimeoutFallback,
  testEarningsRefreshFailureKeepsFreshBuildArtifact,
  testFuturesRefreshFailureKeepsCurrentPartialArtifact,
  testFuturesAsOfUsesParentRunTimestamp,
  testYahooFetchRetriesRateLimits,
  testFuturesDownloaderStagesProgressSequentially,
  testEarningsCalendarBuildAuthorization,
  testZacksBrowserFallbackWarningIsSoftNotice,
  testZacksBrowserSoftRepairBeforePrepareIsFailOpen,
  testWeekAheadPreparationUsesCanonicalRangeForManualRefresh,
  testLastGoodDashboardRecovery,
  testAtomicCommitKeepsValidatedDashboardWhenSnapshotRefreshFails,
  testArchitecturePreparationLeavesCanonicalUnchanged,
  testPreparationStatusCannotEndIntermediate,
  testScheduledPreparationRefusalSkipsCleanly,
  testEditorialPreparationCreatesOnePendingHandoff,
  testMalformedFocusedEarningsIsNoOp,
  testUnresolvedMarketLensReviewBecomesUnavailableLens,
  testStageOneFinalizesWeekAheadOutcomeDisposition,
  testApplyDoesNotOwnWeekAheadLifecycle,
  testPreparedEditionIdDrivesFuturesStoryWindow,
  testArchitectureFinalizationValidatesBeforeReplace,
  testPendingEarningsNarrativeStaysPending,
  testMissingEarningsReactionRepairsInsteadOfDroppingRow,
  testEmptyEarningsWithEvidenceCarriesForwardPriorWeek,
  testRecoveredEarningsPublishSkipsRecoverySourceRefresh,
  testTapeCommentaryRefreshRequiresNewCopy
]);

const localRefreshIntegrationTests = Object.freeze([
  testLocalRefreshKeepsNewerEmbeddedSeriesProvenance,
  testLocalMarketServerNormalizesAllChartSeries,
  testLocalMarketServerOriginPolicyAndTlsOptions
]);

async function main() {
  const testArguments = new Set(process.argv.slice(2));
  for (const argument of testArguments) {
    if (!['--local-refresh', '--browser'].includes(argument)) throw new Error(`Unknown test_dashboard.js option: ${argument}`);
  }
  const tests = [
    testUpdaterQuoteAndCryptoPatches,
    testUpdaterModulePatches,
    testAssetAllocationYahooMalformedLatestRowRetries,
    testAssetAllocationDividendValidation,
    testPartialDeterministicRowsValidate,
    testFuturesStagingPayloadContract,
    testPrepareFallbackAndUnavailableContracts,
    testEarningsCommentaryPublicationNormalization,
    testEditorialReviewContract,
    testChartSeriesOwnsDerivedQuoteViews,
    testQuoteRefreshInvalidatesTapeCommentaryWithoutBlocking,
    testMoveSparseYahooHistoryAndDailyChangeReference,
    testChartFetcherTickerFilterAndPartialFailure,
    testChartStagingRejectsLatestCloseOnlyPlaceholder,
    testChartMetadataAndAvailabilityContracts,
    testChartRerunUsesExecutionRevision,
    testMergedChartAvailabilityFollowsFinalSeries,
    testChartRepairStagesMixedResultForEditorialReview,
    testDashboardEmbeddedRuntimeParses,
    testNewsMoreDisclosureRendering,
    testEmbeddedChartDecoderSkipsMalformedCompactBars,
    testOpeningRenderingOmitsIncompleteBlocks,
    testEarningsOutcomeLifecycleRendering,
    testMarketLensReactionOpensChartBelowDay,
    testTapeChartRoutingPassesFocusOptions,
    testDashboardValidatorRejectsCalendarRangeDivergence,
    testStagedDashboardValidatorEnforcesMarketLensContract,
    testDashboardValidatorKeepsPublishedGateToRenderSurface,
    testDashboardValidatorBlocksStartupCrashSurfaces,
    testDashboardValidatorEnforcesRuntimeNetworkBoundary,
    testDashboardValidatorTapeNotesAreModeSpecific,
    testDashboardValidatorCloseOnlyPlaceholderIsStagedOnly,
    testPrepareNormalizesStaleTapeCommentary,
    testDashboardValidatorRejectsChartProvenanceMismatches,
    testTouchTooltipControls,
    testExpandedChartScrollsFullyIntoViewport,
    ...(testArguments.has('--browser') ? [
      testTapeTooltipStacksAboveNeighboringInfoControlsInBrowser,
      testNewsMoreDisclosureInBrowser
    ] : []),
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
    if (testArguments.has('--browser')) console.log('Browser-visible dashboard tests passed.');
    if (testArguments.has('--local-refresh')) console.log('Local refresh integration tests passed.');
  } finally {
    cleanupTemporaryDirectories();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
