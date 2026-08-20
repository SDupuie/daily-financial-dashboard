#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  acceptedFreshChartTickers,
  compactChartPayload,
  quoteRowFromSeries,
  roundChartPayload
} = require('./fetch_chart_data');
const {
  applyDashboardDataJson,
  commitDashboardCandidate,
  patchDashboard,
  readJsonBlock,
  replaceJsonBlock,
  runWithSectionFallback,
  stageDashboardCandidate,
  syncDashboardPricesFromChartData
} = require('./run_daily_update');
const { reviewedTapeCommentary } = require('./editorial_review_contract');
const { chicagoDateParts, scheduledNow } = require('./calendar_contract');
const { normalizeWeekAhead } = require('./week_ahead_contract');
const { chartableRowsFromDashboardHtml, validateDashboardHtml } = require('./validate_dashboard');

const root = path.resolve(__dirname, '..');
const FIXTURE_NOW = '2026-07-10T21:05:00.000Z';
const testTempRoot = path.join(root, 'generated', 'test-tmp');

const temporaryDirectories = new Set();

function makeTemporaryDirectory(prefix) {
  fs.mkdirSync(testTempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testTempRoot, prefix));
  temporaryDirectories.add(dir);
  return dir;
}

function cleanupTemporaryDirectories() {
  for (const dir of [...temporaryDirectories].reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  fs.rmSync(testTempRoot, { recursive: true, force: true });
}

function withScheduledNow(value, callback) {
  const previous = process.env.SCHEDULED_NOW_ISO;
  process.env.SCHEDULED_NOW_ISO = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.SCHEDULED_NOW_ISO;
    else process.env.SCHEDULED_NOW_ISO = previous;
  }
}

function testSharedCalendarClockHelpers() {
  assert.deepEqual(chicagoDateParts(new Date('2026-01-15T06:30:00.000Z')), {
    weekday: 'Thu',
    isoDate: '2026-01-15',
    clockMinutes: 30
  });
  assert.deepEqual(chicagoDateParts(new Date(FIXTURE_NOW)), {
    weekday: 'Fri',
    isoDate: '2026-07-10',
    clockMinutes: 16 * 60 + 5
  });
  withScheduledNow(FIXTURE_NOW, () => assert.equal(scheduledNow().toISOString(), FIXTURE_NOW));
  withScheduledNow('invalid timestamp', () => {
    const before = Date.now();
    const actual = scheduledNow().getTime();
    const after = Date.now();
    assert.equal(actual >= before && actual <= after, true);
  });
}

function story(kind, index, extra = {}) {
  return {
    tag: kind === 'crypto' ? 'Crypto' : kind === 'futures' ? 'Futures' : 'Markets',
    tone: kind === 'crypto' ? 'crypto' : 'neutral',
    title: `${kind} fixture story ${index}`,
    body: `Fixture story ${index} records a dated market development with enough detail for publication validation.`,
    url: `https://www.cnbc.com/fixture/${kind}-${index}`,
    publishedOn: '2026-07-10',
    sourceLabel: 'Fixture News',
    ...extra
  };
}

function fixtureFutures() {
  const symbols = ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'];
  const sessionOpen = Date.parse('2026-07-10T13:30:00Z') / 1000;
  const sessionClose = Date.parse('2026-07-10T20:00:00Z') / 1000;
  const points = Array.from({ length: 12 }, (_item, index) => [
    sessionOpen + ((sessionClose - sessionOpen) * index) / 11,
    100 + index / 11
  ]);
  return symbols.map((symbol, index) => ({
    symbol,
    label: `Fixture future ${index + 1}`,
    value: '+1.00%',
    dir: 'up',
    body: 'Fixture futures are higher versus the prior close after a constructive cash session.',
    series: points.map((point) => point.slice()),
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

function tradingViewCalendarFixture() {
  return {
    status: 'ok',
    result: [{
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
      date: '2026-07-13T12:30:00.000Z'
    }]
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

function chartSeriesFixture() {
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  return ['SPX', 'VCR', 'UST10Y'].map((ticker, index) => ({
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
}

function createDashboardValidationFixture() {
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  const chartSeries = chartSeriesFixture();
  const chartData = compactChartPayload({
    schemaVersion: 1,
    generatedAt: quoteRevision,
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    series: chartSeries
  });
  const quotes = chartSeries.map(quoteRowFromSeries);
  const stories = Array.from({ length: 9 }, (_item, index) => story('market', index + 1));
  const cryptoNotes = Array.from({ length: 9 }, (_item, index) => story('crypto', index + 1));
  const futuresStories = Array.from({ length: 3 }, (_item, index) => story('futures', index + 1, {
    publishedAt: '2026-07-10T18:45:00.000Z'
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
      masthead: { edition: 'Afternoon Edition', date: 'Friday, July 10, 2026' },
      tape: {
        label: 'Friday After The Bell - Fixture drivers',
        rows: quotes.map((quote) => reviewedTapeCommentary(
          { ...quote, group: quote.ticker === 'VCR' ? 'Sectors' : quote.ticker === 'UST10Y' ? 'Rates & Credit' : 'Equities' },
          'Fixture positioning remains constructive as breadth improves and investors assess earnings, rates, growth, and liquidity conditions.',
          quoteRevision,
          '2026-07-10T12:30:00.000Z'
        ))
      },
      stories,
      crypto: {
        statsFetchedAt: '2026-07-10T13:30:00Z',
        dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' },
        stats: [
          { sym: 'TOTAL', name: 'Crypto Market Cap', sub: 'Expanding', price: '$1.00T', delta: '+$0.01T', chg: '+1.00%', dir: 'up' },
          { sym: 'F&G', name: 'Fear & Greed', sub: 'Neutral', price: '50', delta: '+1', chg: '+1', dir: 'up' },
          { sym: 'ALTSEASON', name: 'Altcoin Season Index', price: '25', sub: 'Bitcoin Season', delta: '+1', chg: '/100', dir: 'up' }
        ],
        notes: cryptoNotes
      },
      earnings: { week: fixtureEarningsWeek() },
      weekAhead: normalizeWeekAhead(tradingViewCalendarFixture(), {
        range: { from: '2026-07-10', to: '2026-07-16' },
        now: new Date('2026-07-10T13:30:00Z')
      }),
      footer: { compiled: 'Compiled Friday, July 10, 2026 at 4:00 PM CDT' },
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
  return `<!doctype html>
<!-- ============ DATA START ============ -->
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

function fixtureNewsSearch(dashboard) {
  const cardFields = ({ title, url, publishedOn, publishedAt, sourceLabel }) => ({
    title,
    url,
    publishedOn,
    sourceLabel,
    ...(publishedAt ? { publishedAt, publishedAtVerified: true } : {})
  });
  const generalCandidates = dashboard.stories.map(cardFields);
  const futuresCandidates = dashboard.futuresModule.stories.map(cardFields);
  const cryptoCandidates = dashboard.crypto.notes.map(cardFields);
  while (generalCandidates.length < 18) {
    generalCandidates.push(story('market-candidate', generalCandidates.length + 1));
  }
  while (cryptoCandidates.length < 15) {
    cryptoCandidates.push(story('crypto-candidate', cryptoCandidates.length + 1));
  }
  return { generalCandidates, futuresCandidates, cryptoCandidates };
}

function fixtureNewsSearchArtifact(dashboard, generatedAt = '2026-07-10T21:00:00.000Z') {
  return {
    schemaVersion: 2,
    generatedAt,
    finishedAt: generatedAt,
    eligibleDates: ['2026-07-09', '2026-07-10'],
    sourceCatalog: [],
    attempts: [],
    articleReview: { status: 'complete' },
    ...fixtureNewsSearch(dashboard)
  };
}

function fixtureNewsSelection(dashboard) {
  const selected = ({ url, tag, title, body }) => ({ url, tag, title, body });
  return {
    futures: dashboard.futuresModule.stories.map(selected),
    stories: dashboard.stories.map(selected),
    crypto: dashboard.crypto.notes.map(selected)
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function testArchitectureSingleWriterAndCliBoundaries() {
  const scriptsDir = path.join(root, 'scripts');
  const directWriterPatterns = [
    /fs\.writeFileSync\(\s*args\.dashboard\b/,
    /fs\.renameSync\([^,]+,\s*args\.dashboard\b/,
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
  assert.match(fs.readFileSync(path.join(scriptsDir, 'publish_main.sh'), 'utf8'), /node scripts\/validate_dashboard\.js readiness/);
}

function testPreparationStagesWithoutCanonicalWrite() {
  const dir = makeTemporaryDirectory('dfd-stage-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);

  const nextHtml = withScheduledNow(FIXTURE_NOW, () => patchDashboard({
    dashboard: dashboardFile,
    candidate: candidateFile,
    windowMode: 'afternoon',
    baseDashboardHtml: originalHtml,
    chartDataPayload: roundChartPayload(chartData),
    futuresPayload: {
      compiledAt: FIXTURE_NOW,
      source: 'Fixture Futures',
      mode: 'session',
      futures: dashboard.futuresModule.futures
    },
    cryptoStatsPayload: {
      fetchedAt: FIXTURE_NOW,
      stats: dashboard.crypto.stats
    },
    assetAllocationPortfolioPayload: {
      compiledAt: FIXTURE_NOW,
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
  }));
  withScheduledNow(FIXTURE_NOW, () => stageDashboardCandidate({
    dashboard: dashboardFile,
    candidate: candidateFile
  }, nextHtml));

  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.equal(fs.existsSync(candidateFile), true);
  assert.equal(readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'dashboard-data').editorialReview, undefined);
}

function testCommitValidatesBeforeReplace() {
  const dir = makeTemporaryDirectory('dfd-commit-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);

  assert.throws(
    () => commitDashboardCandidate({ dashboard: dashboardFile }, originalHtml.replace('<script type="application/json" id="dashboard-data">', '<script type="application/json" id="dashboard-data">{'), {
      validationStdio: 'pipe'
    }),
    /failed render-safety validation/
  );
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);

  const nextDashboard = structuredClone(dashboard);
  nextDashboard.opening.headline = 'Reviewed fixture headline';
  const nextHtml = renderDashboardValidationFixture(nextDashboard, chartData);
  commitDashboardCandidate({ dashboard: dashboardFile }, nextHtml, { validationStdio: 'pipe' });
  assert.equal(readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data').opening.headline, 'Reviewed fixture headline');
}

function testApplyUsesIsolatedNewsSidecarAndKeepsCandidateFacts() {
  const dir = makeTemporaryDirectory('dfd-apply-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const newsCandidatesPath = path.join(dir, 'news_candidates.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  writeJson(newsCandidatesPath, fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'));

  const editorialPayload = structuredClone(dashboard);
  editorialPayload.editionId = '2026-07-10T21:00:00.000Z';
  editorialPayload.opening.headline = 'Reviewed fixture headline';
  editorialPayload.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
  };
  writeJson(payloadFile, editorialPayload);

  withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson({
    dashboard: dashboardFile,
    candidate: candidateFile,
    applyDashboardDataJson: payloadFile,
    newsCandidatesPath,
    validationStdio: 'pipe'
  }));
  const published = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(published.opening.headline, 'Reviewed fixture headline');
  assert.equal(published.stories.length, 9);

  const invalidCases = [
    { name: 'missing', write: () => {} },
    { name: 'unparsable', write: (file) => fs.writeFileSync(file, '{') },
    {
      name: 'timestamp mismatch',
      write: (file) => writeJson(file, fixtureNewsSearchArtifact(dashboard, '2026-07-10T20:59:59.000Z'))
    },
    {
      name: 'malformed',
      write: (file) => writeJson(file, { generatedAt: '2026-07-10T21:00:00.000Z', generalCandidates: 'bad' })
    },
    {
      name: 'outside inventory',
      write: (file) => writeJson(file, {
        ...fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
        generalCandidates: [],
        futuresCandidates: [],
        cryptoCandidates: []
      })
    }
  ];

  for (const testCase of invalidCases) {
    const caseDir = makeTemporaryDirectory(`dfd-news-sidecar-${testCase.name.replace(/\W+/g, '-')}-`);
    const caseDashboardFile = path.join(caseDir, 'dashboard.html');
    const caseCandidateFile = path.join(caseDir, 'dashboard-candidate.html');
    const casePayloadFile = path.join(caseDir, 'dashboard-data.json');
    const caseNewsCandidatesPath = path.join(caseDir, 'news_candidates.json');
    fs.writeFileSync(caseDashboardFile, originalHtml);
    fs.writeFileSync(caseCandidateFile, originalHtml);
    writeJson(casePayloadFile, editorialPayload);
    testCase.write(caseNewsCandidatesPath);
    withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson({
      dashboard: caseDashboardFile,
      candidate: caseCandidateFile,
      applyDashboardDataJson: casePayloadFile,
      newsCandidatesPath: caseNewsCandidatesPath,
      validationStdio: 'pipe'
    }));
    const casePublished = readJsonBlock(fs.readFileSync(caseDashboardFile, 'utf8'), 'dashboard-data');
    assert.equal(casePublished.stories.length, 0, `General News must fail open for ${testCase.name} sidecar.`);
    assert.equal(casePublished.crypto.notes.length, 0, `Crypto News must fail open for ${testCase.name} sidecar.`);
    assert.equal(casePublished.futuresModule.stories.length, 0, `Futures News must fail open for ${testCase.name} sidecar.`);
  }
}

function testRefreshedQuoteCannotReusePriorCommentary() {
  const dir = makeTemporaryDirectory('dfd-refreshed-quote-commentary-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const newsCandidatesPath = path.join(dir, 'news_candidates.json');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalRows = structuredClone(dashboard.tape.rows);
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);

  const refreshedRevision = '2026-07-10T21:05:00.000Z';
  const refreshedChartData = roundChartPayload(chartData);
  refreshedChartData.generatedAt = refreshedRevision;
  for (const series of refreshedChartData.series) {
    if (series.ticker === 'VCR') {
      series.availability = {
        status: 'carried_forward',
        reason: 'source_refresh_failed',
        checkedAt: refreshedRevision
      };
      continue;
    }
    series.quoteRevision = refreshedRevision;
  }
  const refreshedSpx = refreshedChartData.series.find((series) => series.ticker === 'SPX');
  refreshedSpx.bars.at(-1).high = 105;
  refreshedSpx.bars.at(-1).close = 104;
  refreshedChartData.availability = {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt: refreshedRevision,
    failures: [{ ticker: 'VCR', message: 'fixture source failure' }]
  };

  const candidateDashboard = structuredClone(dashboard);
  syncDashboardPricesFromChartData(candidateDashboard, refreshedChartData, {
    now: new Date(refreshedRevision),
    resetCommentary: true,
    commentaryTickers: acceptedFreshChartTickers(refreshedChartData)
  });
  const candidateSpx = candidateDashboard.tape.rows.find((row) => row.ticker === 'SPX');
  const candidateVcr = candidateDashboard.tape.rows.find((row) => row.ticker === 'VCR');
  assert.equal(candidateSpx.last, '104.00');
  assert.equal(candidateSpx.note, '');
  assert.deepEqual(candidateSpx.noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: refreshedRevision
  });
  assert.deepEqual(candidateVcr, originalRows.find((row) => row.ticker === 'VCR'));

  fs.writeFileSync(candidateFile, renderDashboardValidationFixture(candidateDashboard, refreshedChartData));
  writeJson(newsCandidatesPath, fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'));
  const editorialPayload = structuredClone(candidateDashboard);
  editorialPayload.editionId = '2026-07-10T21:00:00.000Z';
  editorialPayload.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: candidateDashboard.editionId,
    verifiedClaims: [],
    newsSearch: fixtureNewsSearchArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
    newsSelection: fixtureNewsSelection(dashboard),
    openingDecision: { action: 'reviewed' }
  };
  writeJson(payloadFile, editorialPayload);

  withScheduledNow('2026-07-10T21:06:00.000Z', () => applyDashboardDataJson({
    dashboard: dashboardFile,
    candidate: candidateFile,
    applyDashboardDataJson: payloadFile,
    newsCandidatesPath,
    validationStdio: 'pipe'
  }));
  const published = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  const publishedSpx = published.tape.rows.find((row) => row.ticker === 'SPX');
  assert.equal(publishedSpx.note, '');
  assert.notEqual(publishedSpx.note, originalRows.find((row) => row.ticker === 'SPX').note);
  assert.deepEqual(publishedSpx.noteDisposition, {
    status: 'commentary_unavailable',
    quoteRevision: refreshedRevision
  });
  assert.deepEqual(
    published.tape.rows.find((row) => row.ticker === 'VCR'),
    originalRows.find((row) => row.ticker === 'VCR')
  );
}

function testPublishedGateAllowsRecoverableSectionsButBlocksStartupShell() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const validHtml = renderDashboardValidationFixture(dashboard, chartData);
  assert.deepEqual(validateDashboardHtml(validHtml).errors, []);

  const recoverable = structuredClone(dashboard);
  recoverable.opening = null;
  recoverable.weekAhead = null;
  recoverable.tape.rows = [null, 'malformed', ...recoverable.tape.rows];
  assert.deepEqual(validateDashboardHtml(renderDashboardValidationFixture(recoverable, chartData)).errors, []);

  const strict = structuredClone(dashboard);
  const strictEventDay = strict.weekAhead.days.find((day) => Array.isArray(day.events) && day.events.length);
  strictEventDay.marketLens.status = 'verified';
  strictEventDay.marketLens.copy = { question: '', title: '', body: '' };
  assert.match(
    validateDashboardHtml(renderDashboardValidationFixture(strict, chartData), { validationMode: 'staged' }).errors.join('\n'),
    /copy\.title must be populated when status is verified/
  );

  const missingShell = validHtml.replace('<span id="mast-date-value"></span>', '');
  assert.match(validateDashboardHtml(missingShell).errors.join('\n'), /Missing required dashboard shell marker/);

  const equivalentShell = validHtml
    .replace('<div class="page" id="app">', '<div data-fixture="yes" id="app" class="extra page">')
    .replace('<div class="right" id="mast-date">', '<div id="mast-date" data-fixture="yes" class="right"/>');
  assert.deepEqual(validateDashboardHtml(equivalentShell).errors, []);

  const nestedDirectChild = validHtml.replace(
    '<span id="mast-date-value"></span>',
    '<em><span id="mast-date-value"></span></em>'
  );
  assert.match(validateDashboardHtml(nestedDirectChild).errors.join('\n'), /mast-date-value must be directly inside #mast-date/);

  const duplicateShellId = validHtml.replace('<main id="content">', '<div id="hero-copy"></div><main id="content">');
  assert.match(validateDashboardHtml(duplicateShellId).errors.join('\n'), /exactly 1 real dashboard shell id #hero-copy; found 2/);

  const inertShell = validHtml.replace('<main id="content">', '<template><div id="shadow-shell"></div></template><main id="content">');
  assert.match(validateDashboardHtml(inertShell).errors.join('\n'), /Unexpected <template> container in the dashboard shell/);

  for (const serialized of ['null', 'false', '0', '""', '[]']) {
    const invalidTopLevel = replaceJsonBlock(validHtml, 'dashboard-data', serialized);
    for (const validationMode of ['published', 'staged']) {
      assert.match(
        validateDashboardHtml(invalidTopLevel, { validationMode }).errors.join('\n'),
        /dashboard-data must be an object for dashboard rendering/,
        `${validationMode} validation must reject top-level dashboard-data ${serialized}.`
      );
    }
  }

  const nullChartData = replaceJsonBlock(validHtml, 'chart-data', 'null');
  for (const validationMode of ['published', 'staged']) {
    assert.match(
      validateDashboardHtml(nullChartData, { validationMode }).errors.join('\n'),
      /chart-data must be an object for dashboard rendering/,
      `${validationMode} validation must reject top-level chart-data null.`
    );
  }
}

function testValidatorUsesBrowserEquivalentScriptIdentity() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const validHtml = renderDashboardValidationFixture(dashboard, chartData);
  const equivalentAttributes = validHtml
    .replace('<script type="application/json" id="dashboard-data">', '<script data-fixture="yes" id="dashboard-data" type="application/json">')
    .replace('<script type="application/json" id="chart-data">', '<script id="chart-data" data-fixture="yes" type="application/json">')
    .replace('<script id="dashboard-runtime">', '<script type="text/javascript" id="dashboard-runtime" data-fixture="yes">');
  assert.deepEqual(validateDashboardHtml(equivalentAttributes).errors, []);

  const duplicateDashboardData = validHtml.replace(
    '<!-- ============ DATA START',
    '<script id="dashboard-data" type="application/json">not json</script>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(duplicateDashboardData).errors.join('\n'), /Expected exactly 1 dashboard-data JSON block; found 2/);

  const duplicateChartData = validHtml.replace(
    '<!-- ============ DATA START',
    '<script id="chart-data" type="application/json">not json</script>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(duplicateChartData).errors.join('\n'), /Expected exactly 1 chart-data JSON block; found 2/);

  const duplicateRuntime = validHtml.replace(
    '<!-- ============ DATA START',
    '<script type="text/javascript" id="dashboard-runtime">fetch("https://evil.example/api")</script>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(duplicateRuntime).errors.join('\n'), /Expected exactly 1 dashboard-runtime script; found 2/);

  const shadowDashboardData = validHtml.replace(
    '<!-- ============ DATA START',
    '<div id="dashboard-data">shadow</div>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(shadowDashboardData).errors.join('\n'), /Expected exactly 1 active #dashboard-data element; found 2/);

  const shadowChartData = validHtml.replace(
    '<!-- ============ DATA START',
    '<div id="chart-data">shadow</div>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(shadowChartData).errors.join('\n'), /Expected exactly 1 active #chart-data element; found 2/);

  const shadowRuntime = validHtml.replace(
    '<!-- ============ DATA START',
    '<div id="dashboard-runtime">shadow</div>\n<!-- ============ DATA START'
  );
  assert.match(validateDashboardHtml(shadowRuntime).errors.join('\n'), /Expected exactly 1 active #dashboard-runtime element; found 2/);

  const runtimeSrc = validHtml.replace('<script id="dashboard-runtime">', '<script id="dashboard-runtime" src="data:text/javascript,">');
  assert.match(validateDashboardHtml(runtimeSrc).errors.join('\n'), /dashboard-runtime script must be inline and must not use src/);

  const runtimeNoModule = validHtml.replace('<script id="dashboard-runtime">', '<script id="dashboard-runtime" nomodule>');
  assert.match(validateDashboardHtml(runtimeNoModule).errors.join('\n'), /dashboard-runtime script must run in supported browsers and must not use nomodule/);

  const runtimeLanguage = validHtml.replace('<script id="dashboard-runtime">', '<script id="dashboard-runtime" language="vbscript">');
  assert.match(validateDashboardHtml(runtimeLanguage).errors.join('\n'), /dashboard-runtime script language must identify JavaScript/);

  const runtimeJavaScriptLanguage = validHtml.replace('<script id="dashboard-runtime">', '<script id="dashboard-runtime" language="JavaScript">');
  assert.deepEqual(validateDashboardHtml(runtimeJavaScriptLanguage).errors, []);

  const runtimeExplicitType = validHtml.replace('<script id="dashboard-runtime">', '<script id="dashboard-runtime" type="text/javascript" language="vbscript">');
  assert.deepEqual(validateDashboardHtml(runtimeExplicitType).errors, []);

  const emptyRuntime = validHtml.replace(/<script id="dashboard-runtime">[\s\S]*?<\/script>/, '<script id="dashboard-runtime"></script>');
  assert.match(validateDashboardHtml(emptyRuntime).errors.join('\n'), /dashboard-runtime script must not be empty/);

  const commentedDashboardData = validHtml.replace(
    /<script type="application\/json" id="dashboard-data">[\s\S]*?<\/script>/,
    '<!-- <script type="application/json" id="dashboard-data">{"tape":{"rows":[]}}</script> -->'
  );
  assert.match(validateDashboardHtml(commentedDashboardData).errors.join('\n'), /Expected exactly 1 dashboard-data JSON block; found 0/);

  const templatedDashboardData = validHtml.replace(
    /<script type="application\/json" id="dashboard-data">[\s\S]*?<\/script>/,
    '<template><script type="application/json" id="dashboard-data">{"tape":{"rows":[]}}</script></template>'
  );
  assert.match(validateDashboardHtml(templatedDashboardData).errors.join('\n'), /Expected exactly 1 dashboard-data JSON block; found 0/);

  assert.equal(readJsonBlock(equivalentAttributes, 'dashboard-data').editionId, dashboard.editionId);
  assert.equal(chartableRowsFromDashboardHtml(equivalentAttributes).length, dashboard.tape.rows.length);
  const replaced = replaceJsonBlock(equivalentAttributes, 'dashboard-data', '\n{"tape":{"rows":[]}}\n');
  assert.deepEqual(readJsonBlock(replaced, 'dashboard-data'), { tape: { rows: [] } });
  assert.throws(() => readJsonBlock(commentedDashboardData, 'dashboard-data'), /found 0/);
  assert.throws(() => readJsonBlock(shadowDashboardData, 'dashboard-data'), /exactly one active #dashboard-data element; found 2/);
  assert.throws(() => chartableRowsFromDashboardHtml(shadowDashboardData), /exactly one active #dashboard-data element; found 2/);

}

function testSectionFallbackControllerStateTransitions() {
  const validPayload = { status: 'available' };
  const fallbackPayload = { status: 'carried_forward' };
  const unavailablePayload = { status: 'unavailable' };
  const validateStatus = (payload) => payload?.status ? [] : ['status missing'];

  assert.deepEqual(
    runWithSectionFallback(() => validPayload, () => fallbackPayload, { validateFresh: validateStatus }).payload,
    validPayload
  );

  const malformedFresh = runWithSectionFallback(
    () => ({ bad: true }),
    () => fallbackPayload,
    { label: 'Fixture', validateFresh: validateStatus, validateFallback: validateStatus }
  );
  assert.equal(malformedFresh.payload.status, 'carried_forward');
  assert.equal(malformedFresh.error.message.includes('Fixture staging payload is invalid'), true);

  const recoveredFresh = runWithSectionFallback(
    () => { throw new Error('command failed'); },
    () => fallbackPayload,
    {
      readFreshOnError: () => validPayload,
      validateFresh: validateStatus,
      validateFallback: validateStatus
    }
  );
  assert.equal(recoveredFresh.recovered, true);
  assert.deepEqual(recoveredFresh.payload, validPayload);

  const unavailable = runWithSectionFallback(
    () => { throw new Error('source failed'); },
    () => ({ bad: true }),
    {
      validateFallback: validateStatus,
      buildUnavailable: () => unavailablePayload
    }
  );
  assert.equal(unavailable.payload.status, 'unavailable');

  assert.throws(
    () => runWithSectionFallback(
      () => { throw new Error('source failed'); },
      () => ({ bad: true }),
      { label: 'Fixture', validateFallback: validateStatus }
    ),
    /could not construct a valid unavailable fallback/
  );
}

async function testActualDashboardStartsInBrowser() {
  const previousBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
    async function assertTooltipInteraction(page, wrapperSelector, buttonSelector) {
      const button = page.locator(buttonSelector).first();
      assert.equal(await button.count(), 1, `${buttonSelector} must render for browser interaction coverage.`);
      const isOpen = () => button.evaluate(
        (element, selector) => element.closest(selector)?.classList.contains('is-open') === true,
        wrapperSelector
      );
      const tooltipState = () => button.evaluate((element, selector) => {
        const tooltip = element.closest(selector)?.querySelector('[role="tooltip"]');
        if (!tooltip) return null;
        const bounds = tooltip.getBoundingClientRect();
        const style = window.getComputedStyle(tooltip);
        return {
          bottom: bounds.bottom,
          left: bounds.left,
          opacity: Number(style.opacity),
          right: bounds.right,
          text: tooltip.textContent.trim(),
          top: bounds.top,
          visibility: style.visibility,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth
        };
      }, wrapperSelector);

      await button.click();
      assert.equal(await isOpen(), true);
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      await page.waitForTimeout(150);
      const openTooltip = await tooltipState();
      assert.equal(Boolean(openTooltip?.text), true);
      assert.equal(openTooltip.visibility, 'visible');
      assert.equal(openTooltip.opacity > 0, true, JSON.stringify(openTooltip));
      assert.equal(openTooltip.left >= -1 && openTooltip.right <= openTooltip.viewportWidth + 1, true);
      assert.equal(openTooltip.top >= -1 && openTooltip.bottom <= openTooltip.viewportHeight + 1, true);

      await button.click();
      assert.equal(await isOpen(), false);
      assert.equal(await button.getAttribute('aria-expanded'), 'false');

      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await isOpen(), true);
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(), false);
      assert.equal(await button.getAttribute('aria-expanded'), 'false');

      await button.click();
      await page.locator('#hero-headline').click();
      assert.equal(await isOpen(), false);
      assert.equal(await button.getAttribute('aria-expanded'), 'false');

      await button.hover();
      await page.waitForTimeout(150);
      const hoveredTooltip = await tooltipState();
      assert.equal(hoveredTooltip.visibility, 'visible');
      assert.equal(hoveredTooltip.opacity > 0, true);
      await page.mouse.move(0, 0);
    }

    async function assertTooltipInteractions(page) {
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 820, height: 1000 },
        { width: 1280, height: 900 }
      ]) {
        await page.setViewportSize(viewport);
        await assertTooltipInteraction(page, '[data-local-refresh-indicator]', '[data-local-refresh-toggle]');
        await assertTooltipInteraction(page, '[data-stale-info]', '[data-stale-button]');
        await assertTooltipInteraction(page, '[data-dividend-info]', '[data-dividend-button]');
        await page.locator('[data-tape-chart-button]:not([disabled])').first().click();
        await page.locator('[data-chart-info-button]').first().waitFor();
        await assertTooltipInteraction(page, '[data-chart-info]', '[data-chart-info-button]');
      }
    }

    async function assertDashboardStarts(file, { testTooltips = false } = {}) {
      const errors = [];
      const page = await browser.newPage();
      try {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.route('https://192.168.2.2:2210/api/market-refresh', (route) => {
          route.fulfill({ status: 204, body: '' });
        });
        await page.goto(`file://${file}`);
        await page.locator('#app').waitFor();
        await page.locator('#content').waitFor();
        await page.waitForFunction(() => {
          const headline = document.getElementById('hero-headline')?.textContent?.trim() || '';
          const content = document.getElementById('content');
          const footer = document.getElementById('footer');
          return headline !== 'Dashboard unavailable'
            && !headline.startsWith('Loading')
            && content
            && content.children.length > 0
            && footer
            && footer.textContent.trim().length > 0;
        });
        const more = page.locator('[data-news-more-toggle]').first();
        if (await more.count()) await more.click();
        if (testTooltips) await assertTooltipInteractions(page);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }

    const canonicalDashboard = path.join(root, 'daily_financial_news.html');
    await assertDashboardStarts(canonicalDashboard);

    const recoverableDir = makeTemporaryDirectory('dfd-browser-recoverable-');
    const recoverableFile = path.join(recoverableDir, 'dashboard.html');
    const rootHref = pathToFileURL(`${root}${path.sep}`).href;
    const recoverableHtml = fs.readFileSync(canonicalDashboard, 'utf8')
      .replace('<head>', `<head>\n  <base href="${rootHref}">`);
    const recoverableData = readJsonBlock(recoverableHtml, 'dashboard-data');
    recoverableData.opening = null;
    fs.writeFileSync(recoverableFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(recoverableData)));
    await assertDashboardStarts(recoverableFile);

    const tooltipFile = path.join(recoverableDir, 'dashboard-tooltips.html');
    const tooltipData = readJsonBlock(recoverableHtml, 'dashboard-data');
    const tooltipTapeRow = tooltipData.tape?.rows?.[0];
    if (!tooltipTapeRow) throw new Error('Tooltip browser fixture requires one Tape row.');
    tooltipTapeRow.note = '';
    tooltipTapeRow.noteDisposition = {
      status: 'commentary_unavailable',
      quoteRevision: tooltipTapeRow.noteDisposition?.quoteRevision || tooltipData.editionId
    };
    const tooltipPortfolioRow = tooltipData.assetAllocationPortfolio?.rows?.[0];
    if (!tooltipPortfolioRow) throw new Error('Tooltip browser fixture requires one Asset Allocation row.');
    tooltipPortfolioRow.dividends = [{ exDate: '2026-08-15', amount: 0.25 }];
    tooltipPortfolioRow.monthDivPerShareValue = 0.25;
    fs.writeFileSync(tooltipFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(tooltipData)));
    await assertDashboardStarts(tooltipFile, { testTooltips: true });

    const absentSectionsFile = path.join(recoverableDir, 'dashboard-empty-object.html');
    fs.writeFileSync(absentSectionsFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', '{}'));
    await assertDashboardStarts(absentSectionsFile);

    const legacyJavaScriptFile = path.join(recoverableDir, 'dashboard-language-javascript.html');
    fs.writeFileSync(legacyJavaScriptFile, recoverableHtml.replace(
      '<script id="dashboard-runtime">',
      '<script id="dashboard-runtime" language="JavaScript">'
    ));
    await assertDashboardStarts(legacyJavaScriptFile);
  } finally {
    if (browser) await browser.close();
    if (previousBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserPath;
  }
}

async function main() {
  const testArguments = new Set(process.argv.slice(2));
  for (const argument of testArguments) {
    if (argument !== '--browser') throw new Error(`Unknown test_dashboard.js option: ${argument}`);
  }

  try {
    testSharedCalendarClockHelpers();
    testArchitectureSingleWriterAndCliBoundaries();
    testPreparationStagesWithoutCanonicalWrite();
    testCommitValidatesBeforeReplace();
    testApplyUsesIsolatedNewsSidecarAndKeepsCandidateFacts();
    testRefreshedQuoteCannotReusePriorCommentary();
    testPublishedGateAllowsRecoverableSectionsButBlocksStartupShell();
    testValidatorUsesBrowserEquivalentScriptIdentity();
    testSectionFallbackControllerStateTransitions();
    if (testArguments.has('--browser')) {
      await testActualDashboardStartsInBrowser();
      process.stdout.write('Browser-visible dashboard tests passed.\n');
    }
    process.stdout.write('Dashboard safety tests passed.\n');
  } finally {
    cleanupTemporaryDirectories();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
