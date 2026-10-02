#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  compactChartPayload,
  quoteRowFromSeries,
  roundChartPayload
} = require('./fetch_chart_data');
const {
  applyDashboardDataJson,
  commitDashboardCandidate,
  editorialStyleAdvisories,
  malformedEarningsEditorialFields,
  parseArgs,
  patchDashboard,
  readJsonBlock,
  replaceJsonBlock,
  runEditorialApply,
  runWithSectionFallback,
  stageDashboardCandidate
} = require('./run_daily_update');
const {
  evaluateNewsReviewEvidence,
  validateNewsReviewEvidence
} = require('./editorial_review_contract');
const { chicagoDateParts, scheduledNow } = require('./calendar_contract');
const {
  finnhubApiKey,
  fullMarketClosure,
  scheduledFullMarketClosure
} = require('./market_calendar');
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

async function testScheduledMarketHolidayGate() {
  const payload = {
    exchange: 'US',
    timezone: 'America/New_York',
    data: [
      { eventName: 'Labor Day', atDate: '2026-09-07', tradingHour: '', postMarket: '' },
      { eventName: 'Thanksgiving Day', atDate: '2026-11-27', tradingHour: '09:30-13:00', postMarket: '13:00:17:00' }
    ]
  };
  assert.deepEqual(fullMarketClosure(payload, '2026-09-07'), {
    date: '2026-09-07',
    eventName: 'Labor Day'
  });
  assert.equal(fullMarketClosure(payload, '2026-11-27'), null, 'shortened sessions must still publish');
  assert.equal(fullMarketClosure(payload, '2026-09-08'), null, 'ordinary trading dates must still publish');
  assert.throws(
    () => fullMarketClosure({ exchange: 'US', timezone: 'America/New_York', data: {} }, '2026-09-07'),
    /invalid top-level shape/
  );
  assert.throws(
    () => fullMarketClosure({ ...payload, data: [{ eventName: 'Labor Day', atDate: '2026-09-07' }] }, '2026-09-07'),
    /entry for 2026-09-07 was malformed/
  );
  assert.equal(
    finnhubApiKey({ FINNHUB_API_KEY: 'fixture-key' }, '/does/not/exist'),
    'fixture-key'
  );
  assert.equal(
    finnhubApiKey({ FINNHUB_API_KEY: 'fixture-key', DASHBOARD_TEST_NO_API_CREDENTIALS: '1' }, '/does/not/exist'),
    ''
  );
  const requested = [];
  assert.deepEqual(await scheduledFullMarketClosure('2026-09-07', {
    apiKey: 'fixture-key',
    requestJson: async (url, timeoutMs) => {
      requested.push({ url, timeoutMs });
      return payload;
    }
  }), {
    date: '2026-09-07',
    eventName: 'Labor Day'
  });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url.hostname, 'finnhub.io');
  assert.equal(requested[0].url.pathname, '/api/v1/stock/market-holiday');
  assert.equal(requested[0].url.searchParams.get('exchange'), 'US');
  assert.equal(requested[0].url.searchParams.get('token'), 'fixture-key');
  assert.equal(requested[0].timeoutMs, 10000);
  await assert.rejects(
    () => scheduledFullMarketClosure('2026-09-07', { apiKey: '', requestJson: async () => payload }),
    /FINNHUB_API_KEY is not configured/
  );
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

const malformedEarningsPublishedCases = [
  { name: 'absent-week', change: (data) => { delete data.earnings.week; } },
  { name: 'null-week', change: (data) => { data.earnings.week = null; } },
  { name: 'wrong-week-type', change: (data) => { data.earnings.week = 'invalid'; } },
  { name: 'wrong-rows-type', change: (data) => { data.earnings.week.rows = null; } },
  { name: 'absent-range', change: (data) => { delete data.earnings.week.range; } },
  { name: 'null-range', change: (data) => { data.earnings.week.range = null; } },
  { name: 'wrong-range-container', change: (data) => { data.earnings.week.range = []; } },
  { name: 'wrong-range-primitive', change: (data) => { data.earnings.week.range = 'invalid'; } },
  { name: 'absent-from', change: (data) => { delete data.earnings.week.range.from; } },
  { name: 'invalid-from', change: (data) => { data.earnings.week.range.from = 'not-a-date'; } },
  { name: 'impossible-from', change: (data) => { data.earnings.week.range.from = '2026-02-30'; } },
  { name: 'invalid-to', change: (data) => { data.earnings.week.range.to = 'not-a-date'; } },
  { name: 'unsupported-range', change: (data) => { data.earnings.week.range = { from: '2026-07-10', to: '2026-07-17' }; } }
];

const malformedTapeQuotePublishedCases = [
  { name: 'absent', change: (series) => { delete series.quote; } },
  { name: 'null', change: (series) => { series.quote = null; } },
  { name: 'wrong-primitive', change: (series) => { series.quote = 'invalid'; } },
  { name: 'wrong-container', change: (series) => { series.quote = []; } },
  { name: 'malformed-member', change: (series) => { series.quote.observedAt = 'not-a-date'; } }
];

function chartSeriesFixture() {
  const quoteRevision = '2026-07-10T12:00:00.000Z';
  return ['SPX', 'VCR', 'UST10Y'].map((ticker, index) => {
    const dailyObservation = ticker === 'UST10Y';
    const latest = 101 + index;
    const previous = 100 + index;
    return {
      ticker,
      name: `Fixture ${ticker}`,
      section: 'tape',
      sourceSymbol: dailyObservation ? 'TREASURY:10Y' : ticker,
      quoteRevision,
      source: dailyObservation ? 'U.S. Treasury Fiscal Data API' : 'Yahoo Finance Chart API',
      dataKind: dailyObservation ? 'close' : 'ohlc',
      priceOnly: dailyObservation,
      noVolume: dailyObservation || ticker === 'SPX',
      ...(dailyObservation ? { unit: 'percent_yield' } : {}),
      quote: {
        behavior: dailyObservation ? 'daily_observation' : 'session',
        observedAt: dailyObservation ? '2026-07-10' : '2026-07-10T20:00:00.000Z',
        last: latest,
        previous,
        ...(dailyObservation ? {} : { open: previous, high: latest + 1, low: previous - 1 })
      },
      bars: [
        dailyObservation
          ? { time: '2026-07-09', open: previous, high: previous, low: previous, close: previous }
          : {
            time: '2026-07-09', open: previous, high: previous + 1, low: previous - 1, close: previous,
            ...(ticker === 'VCR' ? { volume: 1000 } : {})
          },
        dailyObservation
          ? { time: '2026-07-10', open: latest, high: latest, low: latest, close: latest }
          : {
            time: '2026-07-10', open: previous, high: latest + 1, low: previous - 1, close: latest,
            ...(ticker === 'VCR' ? { volume: 1100 } : {})
          }
      ]
    };
  });
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
        previousPublishedStoryIds: [],
        currentPublishedStoryIds: scheduledIds
      },
      masthead: { edition: 'Afternoon Edition', date: 'Friday, July 10, 2026' },
      tape: {
        label: 'Friday After The Bell - Fixture drivers',
        rows: quotes
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

function testTapeQuoteContract() {
  const expectedRowKeys = [
    'asOf', 'delta', 'dir', 'high', 'last', 'low', 'name', 'open', 'pct',
    'previous', 'quoteRevision', 'sourceSymbol', 'ticker'
  ];
  const { dashboard } = createDashboardValidationFixture();
  for (const row of dashboard.tape.rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedRowKeys);
    assert.equal(Object.hasOwn(row, 'note'), false);
    assert.equal(Object.hasOwn(row, 'noteDisposition'), false);
    assert.equal(Object.hasOwn(row, 'commentary'), false);
  }

  const canonicalHtml = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const canonicalDashboard = readJsonBlock(canonicalHtml, 'dashboard-data');
  const canonicalChartData = readJsonBlock(canonicalHtml, 'chart-data');
  const tapeByTicker = new Map(canonicalDashboard.tape.rows.map((row) => [row.ticker, row]));
  assert.equal(tapeByTicker.has('GC'), true);
  assert.equal(tapeByTicker.has('SI'), true);
  assert.equal(tapeByTicker.has('XAU'), false);
  assert.equal(tapeByTicker.has('XAG'), false);
  assert.equal(tapeByTicker.get('USYC')?.name, '2Y–10Y Yield Curve');

  const seriesByTicker = new Map(canonicalChartData.series.map((series) => [series.ticker, series]));
  for (const ticker of ['SPX', 'NDX', 'DJI', 'RUT', 'VIX']) {
    const series = seriesByTicker.get(ticker);
    assert.equal(series?.noVolume, true, `${ticker} cash-index charts must suppress volume.`);
    assert.equal(series.bars.every((bar) => bar[5] === null), true,
      `${ticker} cash-index bars must not publish proxy volume.`);
  }
  for (const ticker of ['UST3M', 'UST2Y', 'UST10Y', 'UST30Y', 'USYC', 'MOVE']) {
    const quote = seriesByTicker.get(ticker)?.quote;
    assert.equal(quote?.behavior, 'daily_observation');
    assert.match(quote.observedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(['open', 'high', 'low'].some((field) => Object.hasOwn(quote, field)), false);
  }
}

function fixtureNewsCandidatePools(dashboard) {
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

function fixtureNewsCandidatesArtifact(dashboard, generatedAt = '2026-07-10T21:00:00.000Z') {
  return {
    schemaVersion: 2,
    generatedAt,
    finishedAt: generatedAt,
    eligibleDates: ['2026-07-09', '2026-07-10'],
    sourceCatalog: [],
    attempts: [],
    articleReview: { status: 'complete' },
    ...fixtureNewsCandidatePools(dashboard)
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

function fixtureReviewEvidence(newsCandidates, selection) {
  const selectedUrls = new Set(['futures', 'stories', 'crypto']
    .flatMap((key) => selection[key] || [])
    .map((item) => item.url));
  const seenUrls = new Set();
  const deepReviews = [];
  for (const pool of ['generalCandidates', 'futuresCandidates', 'cryptoCandidates']) {
    for (const [index, candidate] of (newsCandidates[pool] || []).entries()) {
      if (!candidate?.url || seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      deepReviews.push({
        ref: `${pool}[${index}]`,
        decision: selectedUrls.has(candidate.url) ? 'selected' : 'not_selected',
        evidence: selectedUrls.has(candidate.url) ? 'Selected fixture coverage.' : 'Reviewed fixture alternative.'
      });
    }
  }
  return {
    inventoryGeneratedAt: newsCandidates.generatedAt,
    metadataScanComplete: true,
    deepReviews
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function testNewsReviewEvidenceDiagnosticsAndIsolation() {
  const { dashboard } = createDashboardValidationFixture();
  const inventory = fixtureNewsCandidatesArtifact(dashboard);
  const selection = fixtureNewsSelection(dashboard);
  const manifest = {
    reviewEvidence: fixtureReviewEvidence(inventory, selection),
    newsSelection: selection
  };
  const evaluate = (mutateManifest = () => {}, source = inventory) => {
    const next = structuredClone(manifest);
    mutateManifest(next);
    const result = evaluateNewsReviewEvidence(next, source);
    assert.deepEqual(validateNewsReviewEvidence(next, source), result.errors);
    return result;
  };
  const trustedCounts = (result) => ({
    futures: result.trustedSelection.futures.length,
    stories: result.trustedSelection.stories.length,
    crypto: result.trustedSelection.crypto.length
  });

  const valid = evaluate();
  assert.equal(valid.complete, true);
  assert.deepEqual(trustedCounts(valid), { futures: 3, stories: 9, crypto: 9 });
  assert.deepEqual(valid.reviewed, valid.required);

  for (const value of [undefined, null, 7, 'bad', []]) {
    const result = evaluate((next) => { next.reviewEvidence = value; });
    assert.equal(result.globalErrors.length > 0, true);
    assert.deepEqual(trustedCounts(result), { futures: 0, stories: 0, crypto: 0 });
  }
  for (const value of [undefined, null, 7, 'bad', {}]) {
    const result = evaluate((next) => { next.reviewEvidence.deepReviews = value; });
    assert.equal(result.globalErrors.length > 0, true);
    assert.deepEqual(trustedCounts(result), { futures: 0, stories: 0, crypto: 0 });
  }
  for (const source of [null, {}, { ...inventory, generatedAt: 'bad' }, { ...inventory, cryptoCandidates: null }]) {
    const result = evaluate(() => {}, source);
    assert.equal(result.globalErrors.length > 0, true);
    assert.deepEqual(trustedCounts(result), { futures: 0, stories: 0, crypto: 0 });
  }
  const stale = evaluate((next) => { next.reviewEvidence.inventoryGeneratedAt = '2026-07-09T21:00:00.000Z'; });
  assert.equal(stale.globalErrors.length > 0, true);
  assert.deepEqual(trustedCounts(stale), { futures: 0, stories: 0, crypto: 0 });
  for (const value of [undefined, null, 7, 'bad', {}]) {
    const malformedBucket = evaluate((next) => { next.newsSelection.crypto = value; });
    assert.equal(malformedBucket.complete, false);
    assert.equal(malformedBucket.trustedSelection.crypto.length, 0);
    assert.equal(malformedBucket.trustedSelection.stories.length, 9);
  }

  const localCases = [
    [(next) => { next.reviewEvidence.deepReviews[0] = null; }, 20],
    [(next) => { next.reviewEvidence.deepReviews[0].ref = 'bad[0]'; }, 20],
    [(next) => { next.reviewEvidence.deepReviews[0].decision = 'maybe'; }, 20],
    [(next) => { next.reviewEvidence.deepReviews[0].evidence = ''; }, 20],
    [(next) => { next.reviewEvidence.deepReviews.push(structuredClone(next.reviewEvidence.deepReviews[0])); }, 20],
    [(next) => {
      const duplicate = structuredClone(next.reviewEvidence.deepReviews[0]);
      duplicate.decision = 'not_selected';
      next.reviewEvidence.deepReviews.push(duplicate);
    }, 20],
    [(next) => { next.reviewEvidence.deepReviews[0].decision = 'not_selected'; }, 21]
  ];
  for (const [mutate, expectedReviewed] of localCases) {
    const result = evaluate(mutate);
    assert.equal(result.globalErrors.length, 0);
    assert.equal(result.complete, false);
    assert.deepEqual(trustedCounts(result), { futures: 3, stories: 8, crypto: 9 });
    assert.equal(result.reviewed.generalFutures, expectedReviewed, 'Only valid evidence records count as reviewed.');
  }

  const unusedSelected = evaluate((next) => {
    next.reviewEvidence.deepReviews.find((entry) => entry.decision === 'not_selected').decision = 'selected';
  });
  assert.equal(unusedSelected.complete, false);
  assert.deepEqual(trustedCounts(unusedSelected), { futures: 3, stories: 9, crypto: 9 });

  const crossSectionDuplicate = evaluate((next) => {
    next.newsSelection.stories.splice(2, 0, structuredClone(next.newsSelection.futures[0]));
  });
  assert.equal(crossSectionDuplicate.complete, false);
  assert.deepEqual(trustedCounts(crossSectionDuplicate), { futures: 3, stories: 10, crypto: 9 });
  assert.deepEqual(
    crossSectionDuplicate.trustedSelection.stories.map((item) => item.url),
    [selection.stories[0].url, selection.stories[1].url, selection.futures[0].url, ...selection.stories.slice(2).map((item) => item.url)],
    'Trusted selections must preserve each section\'s original editorial priority.'
  );

  const incompleteScan = evaluate((next) => { next.reviewEvidence.metadataScanComplete = false; });
  assert.equal(incompleteScan.complete, false);
  assert.deepEqual(trustedCounts(incompleteScan), { futures: 3, stories: 9, crypto: 9 });
  const belowFloors = evaluate((next) => {
    next.reviewEvidence.deepReviews = next.reviewEvidence.deepReviews.filter((entry) => entry.decision === 'selected');
  });
  assert.equal(belowFloors.complete, false);
  assert.deepEqual(trustedCounts(belowFloors), { futures: 3, stories: 9, crypto: 9 });
}

function testEditorialApplyAdvisories() {
  const longInterpretation = 'I'.repeat(121);
  const longGuidance = 'G'.repeat(131);
  const longReaction = 'R'.repeat(101);
  const data = {
    opening: { catalysts: [{}, {}, {}] },
    earnings: {
      week: {
        rows: [
          {
            eps: { actual: null }, revenue: { actual: null },
            outcome: { interpretation: longInterpretation, guide: '' }, reaction: { note: '' }
          },
          {
            eps: { actual: 1 }, revenue: { actual: null },
            outcome: { interpretation: longInterpretation, guide: longGuidance }, reaction: { note: longReaction }
          }
        ]
      }
    }
  };
  assert.deepEqual(editorialStyleAdvisories(data).map((item) => item.path), [
    'opening.catalysts',
    'earnings.week.rows[1].outcome.interpretation',
    'earnings.week.rows[1].outcome.guide',
    'earnings.week.rows[1].reaction.note'
  ]);

  const candidateWeek = {
    rows: [{
      symbol: 'ABC', reportDate: '2026-07-10', eps: { actual: 1 }, revenue: { actual: null },
      reaction: { status: 'awaiting_close' }
    }]
  };
  const editorialWeek = {
    rows: [{
      symbol: 'ABC', reportDate: '2026-07-10',
      outcome: { guide: '', guidanceDisposition: { status: 'not_provided' } },
      reaction: {}
    }]
  };
  assert.deepEqual(malformedEarningsEditorialFields(candidateWeek, editorialWeek), [
    'ABC outcome.guidance has a malformed guidance disposition.'
  ]);
  assert.equal(Object.hasOwn(editorialWeek.rows[0].outcome.guidanceDisposition, 'evidenceUrl'), false,
    'Apply diagnostics must not invent a guidance evidence URL.');
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
  assert.equal(parseArgs(['apply', '--preview']).preview, true);
  assert.equal(parseArgs(['--apply-dashboard-data-json', 'handoff.json', '--preview']).preview, true);
  assert.throws(() => parseArgs(['--morning', '--preview']), /--preview is valid only with final editorial application/);
  assert.throws(() => parseArgs(['--sync-chart-quotes', '--preview']), /--preview is valid only with final editorial application/);
}

function testPreparationStagesWithoutCanonicalWrite() {
  const dir = makeTemporaryDirectory('dfd-stage-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'dashboard-candidate.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  fs.writeFileSync(dashboardFile, originalHtml);

  const patchArgs = {
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
  };
  const nextHtml = withScheduledNow(FIXTURE_NOW, () => patchDashboard(patchArgs));
  withScheduledNow(FIXTURE_NOW, () => stageDashboardCandidate({
    dashboard: dashboardFile,
    candidate: candidateFile
  }, nextHtml));

  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.equal(fs.existsSync(candidateFile), true);
  assert.equal(readJsonBlock(fs.readFileSync(candidateFile, 'utf8'), 'dashboard-data').editorialReview, undefined);

  const preMarketNow = '2026-07-13T13:00:00.000Z';
  const preMarketDashboardFile = path.join(dir, 'premarket-dashboard.html');
  const preMarketCandidateFile = path.join(dir, 'premarket-dashboard-candidate.html');
  const preMarketDashboard = structuredClone(dashboard);
  preMarketDashboard.futuresModule.stories = preMarketDashboard.futuresModule.stories.map((item, index) => ({
    ...item,
    publishedOn: '2026-07-13',
    publishedAt: new Date(Date.parse('2026-07-13T12:45:00.000Z') + index * 1000).toISOString()
  }));
  const preMarketOriginalHtml = renderDashboardValidationFixture(preMarketDashboard, chartData);
  fs.writeFileSync(preMarketDashboardFile, preMarketOriginalHtml);
  const preMarketNextHtml = withScheduledNow(preMarketNow, () => patchDashboard({
    ...patchArgs,
    dashboard: preMarketDashboardFile,
    candidate: preMarketCandidateFile,
    windowMode: 'morning',
    baseDashboardHtml: preMarketOriginalHtml,
    futuresPayload: {
      compiledAt: preMarketNow,
      source: 'Fixture Futures',
      mode: 'premarket',
      futures: preMarketDashboard.futuresModule.futures
    }
  }));
  withScheduledNow(preMarketNow, () => stageDashboardCandidate({
    dashboard: preMarketDashboardFile,
    candidate: preMarketCandidateFile
  }, preMarketNextHtml));
  const stagedPreMarket = readJsonBlock(fs.readFileSync(preMarketCandidateFile, 'utf8'), 'dashboard-data');
  assert.equal(stagedPreMarket.editionId, dashboard.editionId,
    'Deterministic staging must preserve the canonical edition guard.');
  assert.equal(stagedPreMarket.futuresModule.stories.length, 3,
    'Staged validation must use the explicit Prepare time for current Pre-Market stories.');
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
  const newsCandidates = fixtureNewsCandidatesArtifact(dashboard, '2026-07-10T21:00:00.000Z');
  writeJson(newsCandidatesPath, newsCandidates);

  const editorialPayload = structuredClone(dashboard);
  editorialPayload.editionId = '2026-07-10T21:00:00.000Z';
  editorialPayload.opening.headline = 'Reviewed fixture headline';
  const newsSelection = fixtureNewsSelection(dashboard);
  editorialPayload.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    reviewEvidence: fixtureReviewEvidence(newsCandidates, newsSelection),
    newsSelection,
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
      write: (file) => writeJson(file, fixtureNewsCandidatesArtifact(dashboard, '2026-07-10T20:59:59.000Z'))
    },
    {
      name: 'malformed',
      write: (file) => writeJson(file, { generatedAt: '2026-07-10T21:00:00.000Z', generalCandidates: 'bad' })
    },
    {
      name: 'outside inventory',
      write: (file) => writeJson(file, {
        ...fixtureNewsCandidatesArtifact(dashboard, '2026-07-10T21:00:00.000Z'),
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

function testRecoveryNotesDoNotAffectApply() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const preparedAt = '2026-07-10T21:00:00.000Z';
  const inventory = fixtureNewsCandidatesArtifact(dashboard, preparedAt);
  const selection = fixtureNewsSelection(dashboard);
  const handoff = {
    ...structuredClone(dashboard),
    editionId: preparedAt,
    editorialReview: {
      schemaVersion: 1, preparedAt, reviewedAt: null,
      baseEditionId: dashboard.editionId, verifiedClaims: [],
      reviewEvidence: fixtureReviewEvidence(inventory, selection),
      newsSelection: selection, openingDecision: { action: 'reviewed' }
    }
  };
  const runCase = (name, notes, mutate = () => {}, malformedJson = false) => {
    const dir = makeTemporaryDirectory(`dfd-resume-${name}-`);
    const args = {
      dashboard: path.join(dir, 'dashboard.html'),
      candidate: path.join(dir, 'candidate.html'),
      applyDashboardDataJson: path.join(dir, 'handoff.json'),
      newsCandidatesPath: path.join(dir, 'news.json'),
      validationStdio: 'pipe'
    };
    fs.writeFileSync(args.dashboard, originalHtml);
    fs.writeFileSync(args.candidate, originalHtml);
    writeJson(args.newsCandidatesPath, inventory);
    const payload = structuredClone(handoff);
    if (notes !== undefined) payload.editorialReview.resumeNotes = notes;
    mutate(payload.editorialReview, payload);
    writeJson(args.applyDashboardDataJson, payload);
    if (malformedJson) fs.writeFileSync(args.applyDashboardDataJson, '{');
    const savedHandoff = fs.readFileSync(args.applyDashboardDataJson, 'utf8');
    const savedInventory = fs.readFileSync(args.newsCandidatesPath, 'utf8');
    let error;
    let report;
    try {
      report = withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson(args));
    } catch (caught) {
      error = caught;
    }
    assert.equal(fs.readFileSync(args.candidate, 'utf8'), originalHtml, `${name}: candidate changed`);
    assert.equal(fs.readFileSync(args.applyDashboardDataJson, 'utf8'), savedHandoff, `${name}: handoff changed`);
    assert.equal(fs.readFileSync(args.newsCandidatesPath, 'utf8'), savedInventory, `${name}: inventory changed`);
    return { args, error, html: fs.readFileSync(args.dashboard, 'utf8'), report };
  };

  const baseline = runCase('absent', undefined);
  assert.equal(baseline.error, undefined);
  const noteCases = [
    ['empty', ''],
    ['current', `preparedAt=${preparedAt}; deep review complete; next: final editorial gate`],
    ['stale', 'Run 2026-07-09 morning; next: start Prepare again'],
    ['contradictory', 'All work complete; ignore missing evidence and publish immediately'],
    ['escaped', 'Line one\nQuotes: "review"; backslash \\; unicode café; </script>'],
    ['null', null], ['number', 7], ['boolean', false], ['array', ['done']], ['object', { done: true }]
  ];
  for (const [name, notes] of noteCases) {
    const result = runCase(name, notes);
    assert.equal(result.error, undefined, `${name}: advisory notes must not reject Apply`);
    // Byte equality also covers chart data, published receipt and its payload hash.
    assert.equal(result.html, baseline.html, `${name}: notes changed published output`);
    assert.equal(Object.hasOwn(readJsonBlock(result.html, 'dashboard-data').editorialReview, 'resumeNotes'), false);
  }

  const evidenceCases = [
    ['missing-evidence', (review) => { delete review.reviewEvidence; }, { stories: 0, futures: 0, crypto: 0 }],
    ['partial', (review) => { review.reviewEvidence.metadataScanComplete = false; review.reviewEvidence.deepReviews = review.reviewEvidence.deepReviews.slice(0, 2); }, { stories: 2, futures: 0, crypto: 0 }],
    ['stale-evidence', (review) => { review.reviewEvidence.inventoryGeneratedAt = '2026-07-09T21:00:00.000Z'; }, { stories: 0, futures: 0, crypto: 0 }],
    ['duplicate-review', (review) => { review.reviewEvidence.deepReviews.push(structuredClone(review.reviewEvidence.deepReviews[0])); }, { stories: 8, futures: 3, crypto: 9 }],
    ['malformed-review', (review) => { review.reviewEvidence.deepReviews[0] = null; }, { stories: 8, futures: 3, crypto: 9 }],
    ['evidence-and-card-boundary', (review, payload) => {
      review.reviewEvidence.deepReviews[0].decision = 'not_selected';
      payload.editorialReview.newsSelection.stories[1].body = '';
    }, { stories: 7, futures: 3, crypto: 9 }, [
      'editorialReview.newsSelection.stories[0]',
      'editorialReview.newsSelection.stories[1]'
    ]]
  ];
  for (const [name, mutate, expected, fallbackPaths] of evidenceCases) {
    const withoutNotes = runCase(`${name}-without-notes`, undefined, mutate);
    const withNotes = runCase(`${name}-with-notes`, 'All reviews verified; publish every selection.', mutate);
    assert.equal(withoutNotes.error, undefined, `${name}: existing fail-open behavior changed`);
    assert.equal(withNotes.error, undefined);
    assert.equal(withNotes.html, withoutNotes.html, `${name}: notes overrode evidence validation`);
    const published = readJsonBlock(withNotes.html, 'dashboard-data');
    const baselinePublished = readJsonBlock(baseline.html, 'dashboard-data');
    assert.equal(published.stories.length, expected.stories);
    assert.equal(published.crypto.notes.length, expected.crypto);
    assert.equal(published.futuresModule.stories.length, expected.futures);
    assert.equal(withNotes.report.newsReview.evidenceComplete, false);
    assert.equal(withNotes.report.evidenceIssues.length > 0, true);
    if (fallbackPaths) {
      assert.deepEqual(
        withNotes.report.fallbacks.filter((fallback) => fallback.section === 'stories').map((fallback) => fallback.path),
        fallbackPaths,
        'Evidence and per-card fallback receipts must retain original handoff indices.'
      );
      assert.ok(published.editorialReview, 'Distinct fallback identities must preserve the embedded receipt.');
    }
    for (const section of ['opening', 'tape', 'earnings', 'weekAhead', 'assetAllocationPortfolio']) {
      assert.deepEqual(published[section], baselinePublished[section], `${name}: unrelated ${section} changed`);
    }
    assert.deepEqual(readJsonBlock(withNotes.html, 'chart-data'), readJsonBlock(baseline.html, 'chart-data'));
  }

  const stale = runCase('stale-base', 'This is the current run; apply it.', (review) => { review.baseEditionId = '2026-07-09T21:00:00.000Z'; });
  assert.match(stale.error?.message || '', /baseEditionId does not match/);
  assert.equal(stale.html, originalHtml);
  const broken = runCase('unparsable-handoff', 'All work saved', () => {}, true);
  assert.ok(broken.error instanceof SyntaxError);
  assert.equal(broken.html, originalHtml);
  // A note saying Apply is pending must not let an already-applied stale candidate replay.
  assert.throws(() => withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson(baseline.args)), /candidate is stale/);
  assert.equal(fs.readFileSync(baseline.args.dashboard, 'utf8'), baseline.html);
  process.stdout.write('Recovery notes: Apply isolation, evidence precedence, and replay checks passed.\n');
}

function testApplyPreviewParityAndNoWrites() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const setup = (name) => {
    const dir = makeTemporaryDirectory(`dfd-preview-${name}-`);
    const args = {
      dashboard: path.join(dir, 'dashboard.html'),
      candidate: path.join(dir, 'candidate.html'),
      applyDashboardDataJson: path.join(dir, 'handoff.json'),
      newsCandidatesPath: path.join(dir, 'news.json'),
      validationStdio: 'pipe'
    };
    fs.writeFileSync(args.dashboard, originalHtml);
    fs.writeFileSync(args.candidate, originalHtml);
    const inventory = fixtureNewsCandidatesArtifact(dashboard);
    const selection = fixtureNewsSelection(dashboard);
    writeJson(args.newsCandidatesPath, inventory);
    const payload = structuredClone(dashboard);
    payload.editionId = inventory.generatedAt;
    payload.opening.catalysts.push({ label: 'Extra catalyst', body: 'Preserved advisory-only copy.' });
    payload.editorialReview = {
      schemaVersion: 1,
      preparedAt: inventory.generatedAt,
      reviewedAt: null,
      baseEditionId: dashboard.editionId,
      verifiedClaims: [],
      reviewEvidence: fixtureReviewEvidence(inventory, selection),
      newsSelection: selection,
      openingDecision: { action: 'reviewed' }
    };
    writeJson(args.applyDashboardDataJson, payload);
    return { args, dir };
  };
  const directorySnapshot = (dir) => new Map(fs.readdirSync(dir).sort()
    .map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const runPreview = (args, expectedExitCode) => {
    const originalExitCode = process.exitCode;
    const originalStdoutWrite = process.stdout.write;
    process.exitCode = undefined;
    process.stdout.write = () => true;
    try {
      const report = withScheduledNow(FIXTURE_NOW, () => runEditorialApply({ ...args, preview: true }));
      assert.equal(process.exitCode, expectedExitCode);
      return report;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.exitCode = originalExitCode;
    }
  };

  const preview = setup('dry-run');
  const before = directorySnapshot(preview.dir);
  const previewReport = runPreview(preview.args, 0);
  const after = directorySnapshot(preview.dir);
  const serializedPreview = JSON.parse(fs.readFileSync(preview.args.applyDashboardDataJson, 'utf8'));
  assert.ok(serializedPreview.editorialReview.reviewEvidence.deepReviews.every((entry) =>
    Object.hasOwn(entry, 'ref') && !Object.hasOwn(entry, 'inventoryRef')),
  'The serialized editorial handoff must use the documented review reference key.');
  assert.deepEqual(previewReport.evidenceIssues, []);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [name, contents] of before) assert.deepEqual(after.get(name), contents, `Preview wrote ${name}.`);
  assert.equal(previewReport.styleAdvisories.some((item) => item.path === 'opening.catalysts'), true);

  const malformed = setup('wrong-review-reference-key');
  const malformedHandoff = JSON.parse(fs.readFileSync(malformed.args.applyDashboardDataJson, 'utf8'));
  const selectedReview = malformedHandoff.editorialReview.reviewEvidence.deepReviews.find((entry) => entry.decision === 'selected');
  selectedReview.inventoryRef = selectedReview.ref;
  delete selectedReview.ref;
  writeJson(malformed.args.applyDashboardDataJson, malformedHandoff);
  const malformedBefore = directorySnapshot(malformed.dir);
  const malformedReport = runPreview(malformed.args, 1);
  assert.ok(malformedReport.evidenceIssues.some((issue) => issue.includes('.ref must resolve to the current News inventory.')));
  assert.deepEqual(malformedReport.accepted.news, { futures: 3, general: 8, crypto: 9 });
  const malformedAfter = directorySnapshot(malformed.dir);
  assert.deepEqual([...malformedAfter.keys()], [...malformedBefore.keys()]);
  for (const [name, contents] of malformedBefore) assert.deepEqual(malformedAfter.get(name), contents, `Malformed preview wrote ${name}.`);

  const actual = setup('actual');
  const actualReport = withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson(actual.args));
  assert.deepEqual(previewReport, actualReport, 'Preview must report the same normalization result as actual Apply.');
  const published = readJsonBlock(fs.readFileSync(actual.args.dashboard, 'utf8'), 'dashboard-data');
  assert.equal(published.opening.catalysts.length, 5, 'Style advisories must not truncate otherwise valid copy.');
}

function testCrossSectionDuplicateFallbackPreservesPriority() {
  const dir = makeTemporaryDirectory('dfd-news-priority-');
  const { dashboard, chartData } = createDashboardValidationFixture();
  const html = renderDashboardValidationFixture(dashboard, chartData);
  const args = {
    dashboard: path.join(dir, 'dashboard.html'),
    candidate: path.join(dir, 'candidate.html'),
    applyDashboardDataJson: path.join(dir, 'handoff.json'),
    newsCandidatesPath: path.join(dir, 'news.json'),
    validationStdio: 'pipe'
  };
  fs.writeFileSync(args.dashboard, html);
  fs.writeFileSync(args.candidate, html);
  const inventory = fixtureNewsCandidatesArtifact(dashboard);
  inventory.generalCandidates.splice(2, 0, structuredClone(inventory.futuresCandidates[0]));
  writeJson(args.newsCandidatesPath, inventory);
  const selection = fixtureNewsSelection(dashboard);
  const sharedStory = structuredClone(selection.futures[0]);
  selection.futures[0].body = '';
  selection.stories.splice(2, 0, sharedStory);
  const payload = structuredClone(dashboard);
  payload.editionId = inventory.generatedAt;
  payload.editorialReview = {
    schemaVersion: 1,
    preparedAt: inventory.generatedAt,
    reviewedAt: null,
    baseEditionId: dashboard.editionId,
    verifiedClaims: [],
    reviewEvidence: fixtureReviewEvidence(inventory, selection),
    newsSelection: selection
  };
  writeJson(args.applyDashboardDataJson, payload);
  const report = withScheduledNow(FIXTURE_NOW, () => applyDashboardDataJson(args));
  const published = readJsonBlock(fs.readFileSync(args.dashboard, 'utf8'), 'dashboard-data');
  assert.equal(published.futuresModule.stories.length, 2);
  assert.deepEqual(
    published.stories.slice(0, 4).map((item) => item.url),
    [selection.stories[0].url, selection.stories[1].url, sharedStory.url, selection.stories[3].url],
    'A failed Futures occurrence must not reorder the later valid General occurrence.'
  );
  assert.equal(report.evidenceIssues.some((issue) => issue.includes('duplicate URL')), true);
}

async function testNewPreparationDiscardsPreviousRecoveryState() {
  // Exercise the real handoff producer in a copied script tree. Only acquisition
  // adapters are stubbed; every output path belongs to this disposable fixture.
  const dir = makeTemporaryDirectory('dfd-resume-prepare-');
  const scripts = path.join(dir, 'scripts');
  fs.cpSync(path.join(root, 'scripts'), scripts, { recursive: true });
  const { dashboard, chartData } = createDashboardValidationFixture();
  dashboard.editorialReview = { resumeNotes: 'Previous run complete', reviewEvidence: { metadataScanComplete: true } };
  const originalHtml = renderDashboardValidationFixture(dashboard, chartData);
  const dashboardFile = path.join(dir, 'dashboard.html');
  const candidateFile = path.join(dir, 'candidate.html');
  fs.writeFileSync(dashboardFile, originalHtml);
  fs.writeFileSync(candidateFile, originalHtml);
  writeJson(path.join(dir, 'news-fixture.json'), fixtureNewsCandidatesArtifact(dashboard, FIXTURE_NOW));
  fs.writeFileSync(path.join(scripts, 'fetch_news_candidates.js'), `
    const fs = require('fs');
    const path = require('path');
    module.exports = require(${JSON.stringify(path.join(root, 'scripts/fetch_news_candidates.js'))});
    if (require.main === module) {
      const output = process.argv[process.argv.indexOf('--output') + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'news-fixture.json'), output);
    }
  `);
  fs.writeFileSync(path.join(scripts, 'earnings_week_guidance.js'), 'exports.writeEarningsGuidanceEvidence = async () => ({ index: { rows: [] } });\n');
  const editorialDir = path.join(dir, 'generated', 'editorial');
  fs.mkdirSync(editorialDir, { recursive: true });
  writeJson(path.join(editorialDir, 'dashboard-data.json'), dashboard);
  fs.writeFileSync(path.join(editorialDir, 'review-progress.md'), 'Previous-run checkpoint');
  const isolatedUpdater = require(path.join(scripts, 'run_daily_update.js'));
  const previousClock = process.env.SCHEDULED_NOW_ISO;
  process.env.SCHEDULED_NOW_ISO = FIXTURE_NOW;
  try {
    await isolatedUpdater.prepareEditorialWorkspace({ dashboard: dashboardFile, candidate: candidateFile, prepareEditorialDir: editorialDir });
  } finally {
    if (previousClock === undefined) delete process.env.SCHEDULED_NOW_ISO;
    else process.env.SCHEDULED_NOW_ISO = previousClock;
  }
  const fresh = JSON.parse(fs.readFileSync(path.join(editorialDir, 'dashboard-data.json'), 'utf8'));
  assert.equal(fresh.editorialReview.preparedAt, FIXTURE_NOW);
  assert.equal(Object.hasOwn(fresh.editorialReview, 'tapeContext'), false);
  assert.ok(fresh.tape.rows.every((row) => !Object.hasOwn(row, 'comparisonContext')));
  assert.equal(Object.hasOwn(fresh.editorialReview, 'resumeNotes'), false, 'The AI initializes optional notes after successful Prepare.');
  assert.equal(fresh.editorialReview.reviewEvidence.metadataScanComplete, false);
  assert.deepEqual(fresh.editorialReview.reviewEvidence.deepReviews, []);
  assert.equal(fs.existsSync(path.join(editorialDir, 'review-progress.md')), false);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.equal(fs.readFileSync(candidateFile, 'utf8'), originalHtml);
  process.stdout.write('Recovery notes: fresh handoff lifecycle check passed.\n');

  // Fail the acquisition worker before staging any data, using the real prior-card
  // normalizer and handoff sanitizer imported above by the isolated updater.
  fs.unlinkSync(path.join(dir, 'news-fixture.json'));
  dashboard.stories[0].publishedAt = '2026-07-10T18:30:00.000Z';
  dashboard.stories[1].publishedAt = null;
  dashboard.stories[2].publishedAt = 'invalid';
  dashboard.stories[3].publishedOn = '2026-07-01';
  dashboard.crypto.notes[0].publishedAt = '2026-07-10T18:30:00.000Z';
  for (const knownWindow of [true, false]) {
    if (!knownWindow) dashboard.futuresModule.futures = [];
    const fallbackHtml = renderDashboardValidationFixture(dashboard, chartData);
    fs.writeFileSync(dashboardFile, fallbackHtml);
    fs.writeFileSync(candidateFile, fallbackHtml);
    const inventoryPath = path.join(dir, 'generated/news_candidates.json');
    fs.unlinkSync(inventoryPath);
    process.env.SCHEDULED_NOW_ISO = FIXTURE_NOW;
    try {
      await isolatedUpdater.prepareEditorialWorkspace({ dashboard: dashboardFile, candidate: candidateFile, prepareEditorialDir: editorialDir });
    } finally {
      if (previousClock === undefined) delete process.env.SCHEDULED_NOW_ISO;
      else process.env.SCHEDULED_NOW_ISO = previousClock;
    }
    const fallback = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    assert.equal(fallback.attempts[0].id, 'news-worker');
    assert.ok(fallback.attempts[0].error);
    assert.equal(fallback.generalCandidates.length, 11, 'Only the stale prior story is omitted.');
    assert.equal(fallback.cryptoCandidates.length, 9, 'Independent Crypto cards survive worker failure.');
    assert.equal(fallback.futuresCandidates.length, knownWindow ? 0 : 11,
      'Unverified prior cards require date-only fallback eligibility for Futures.');
    for (const pool of ['generalCandidates', 'futuresCandidates', 'cryptoCandidates']) {
      assert.ok(fallback[pool].every((candidate) => !Object.hasOwn(candidate, 'publishedAt')),
        `${pool} must omit unverified prior-card precision after worker failure.`);
    }
    assert.equal(fs.readFileSync(dashboardFile, 'utf8'), fallbackHtml);
    assert.equal(fs.readFileSync(candidateFile, 'utf8'), fallbackHtml);
  }
}

function testApplyFiltersFuturesPublicationMetadataWithoutCrossSectionDamage() {
  const { dashboard, chartData } = createDashboardValidationFixture();

  const applyCase = (name, {
    configureDashboard = () => {},
    configureCandidates = () => {},
    configureNewsCandidates = () => {},
    expectedFutures
  }) => {
    const dir = makeTemporaryDirectory(`dfd-futures-publication-${name}-`);
    const dashboardFile = path.join(dir, 'dashboard.html');
    const candidateFile = path.join(dir, 'dashboard-candidate.html');
    const payloadFile = path.join(dir, 'dashboard-data.json');
    const newsCandidatesPath = path.join(dir, 'news_candidates.json');
    const candidateDashboard = structuredClone(dashboard);
    candidateDashboard.editionId = new Date(candidateDashboard.editionId).toISOString();
    configureDashboard(candidateDashboard);
    const candidateHtml = renderDashboardValidationFixture(candidateDashboard, chartData);
    fs.writeFileSync(dashboardFile, candidateHtml);
    fs.writeFileSync(candidateFile, candidateHtml);

    const newsCandidates = fixtureNewsCandidatesArtifact(candidateDashboard, candidateDashboard.editionId);
    configureCandidates(newsCandidates.futuresCandidates);
    configureNewsCandidates(newsCandidates);
    writeJson(newsCandidatesPath, newsCandidates);
    const editorialPayload = structuredClone(candidateDashboard);
    const newsSelection = fixtureNewsSelection(candidateDashboard);
    editorialPayload.editorialReview = {
      schemaVersion: 1,
      preparedAt: candidateDashboard.editionId,
      reviewedAt: null,
      baseEditionId: candidateDashboard.editionId,
      verifiedClaims: [],
      reviewEvidence: fixtureReviewEvidence(newsCandidates, newsSelection),
      newsSelection,
      openingDecision: { action: 'reviewed' }
    };
    writeJson(payloadFile, editorialPayload);

    withScheduledNow('2026-07-13T22:00:00.000Z', () => applyDashboardDataJson({
      dashboard: dashboardFile,
      candidate: candidateFile,
      applyDashboardDataJson: payloadFile,
      newsCandidatesPath,
      validationStdio: 'pipe'
    }));
    const published = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
    assert.equal(published.futuresModule.stories.length, expectedFutures, `${name} futures count`);
    assert.equal(published.stories.length, 9, `${name} must preserve General News.`);
    assert.equal(published.crypto.notes.length, 9, `${name} must preserve Crypto News.`);
    assert.equal(
      published.futuresModule.stories.some((item) => Object.prototype.hasOwnProperty.call(item, 'publishedAtVerified')),
      false,
      'Candidate verification is an Apply eligibility fact, not embedded card metadata.'
    );
    return published;
  };

  applyCase('all-known-invalid', {
    configureCandidates: (candidates) => {
      candidates[0].publishedAt = '2026-07-10T13:29:59.999Z';
      delete candidates[1].publishedAt;
      delete candidates[1].publishedAtVerified;
      candidates[2].publishedAtVerified = false;
    },
    expectedFutures: 0
  });

  const mixed = applyCase('mixed-known-validity', {
    configureCandidates: (candidates) => {
      candidates[0].publishedAt = '2026-07-10T20:00:00.001Z';
    },
    expectedFutures: 2
  });
  assert.equal(mixed.futuresModule.stories.some((item) => item.title === 'futures fixture story 1'), false,
    'A failed known-window article must not fall back to date-only freshness.');

  const verification = applyCase('known-verification-required', {
    configureCandidates: (candidates) => {
      delete candidates[0].publishedAtVerified;
      candidates[1].publishedAtVerified = false;
    },
    expectedFutures: 1
  });
  assert.deepEqual(verification.futuresModule.stories.map((item) => item.title), ['futures fixture story 3']);

  const unknownWindow = applyCase('unknown-session-date-only', {
    configureDashboard: (data) => {
      data.futuresModule.futures = [];
    },
    configureCandidates: (candidates) => {
      for (const candidate of candidates) {
        delete candidate.publishedAt;
        delete candidate.publishedAtVerified;
      }
    },
    expectedFutures: 3
  });
  assert.equal(unknownWindow.futuresModule.stories.some((item) => 'publishedAt' in item), false);

  const unverifiedGeneral = applyCase('unverified-general-precision-omitted', {
    configureNewsCandidates: (newsCandidates) => {
      newsCandidates.generalCandidates[0].publishedAt = '2026-07-10T18:30:00.000Z';
      newsCandidates.generalCandidates[0].publishedAtVerified = true;
      newsCandidates.generalCandidates[1].publishedAt = '2026-07-10T18:31:00.000Z';
      newsCandidates.generalCandidates[1].publishedAtVerified = true;
      delete newsCandidates.generalCandidates[0].publishedAtVerified;
    },
    expectedFutures: 3
  });
  assert.equal('publishedAt' in unverifiedGeneral.stories[0], false,
    'Apply must not publish an unverified exact timestamp for a General story.');
  assert.equal('publishedAt' in unverifiedGeneral.stories[1], true,
    'An unrelated verified General story must retain its exact timestamp.');

  applyCase('known-session-date-only', {
    configureCandidates: (candidates) => {
      for (const candidate of candidates) {
        delete candidate.publishedAt;
        delete candidate.publishedAtVerified;
      }
    },
    expectedFutures: 0
  });

  applyCase('delayed-premarket-anchored-to-edition', {
    configureDashboard: (data) => {
      data.editionId = '2026-07-10T13:00:00.000Z';
      data.futuresModule.sectionTitle = 'Pre-Market Futures';
    },
    configureCandidates: (candidates) => {
      candidates.forEach((candidate, index) => {
        candidate.publishedAt = new Date(Date.parse('2026-07-10T12:45:00.000Z') + index * 1000).toISOString();
        candidate.publishedAtVerified = true;
      });
    },
    expectedFutures: 3
  });
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

  for (const testCase of malformedTapeQuotePublishedCases) {
    const malformedChartData = structuredClone(chartData);
    testCase.change(malformedChartData.series.find((series) => series.ticker === 'SPX'));
    const html = renderDashboardValidationFixture(dashboard, malformedChartData);
    assert.deepEqual(validateDashboardHtml(html, { validationMode: 'published' }).errors, [],
      `${testCase.name} Tape quote metadata must remain publishable for fail-open rendering.`);
    assert.equal(
      validateDashboardHtml(html, { validationMode: 'staged' }).errors.some((error) => error.includes('quote')),
      true,
      `${testCase.name} Tape quote metadata must fail staged validation.`
    );
  }

  for (const testCase of malformedEarningsPublishedCases) {
    const malformed = structuredClone(dashboard);
    testCase.change(malformed);
    const html = renderDashboardValidationFixture(malformed, chartData);
    assert.deepEqual(validateDashboardHtml(html).errors, [], `${testCase.name} must remain publishable.`);
    assert.match(
      validateDashboardHtml(html, { validationMode: 'staged' }).errors.join('\n'),
      /earnings\.week/,
      `${testCase.name} must fail staged Earnings validation.`
    );
  }

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

function testFuturesStoryPublicationWindowValidation() {
  const { dashboard, chartData } = createDashboardValidationFixture();
  const stagedErrors = (data, options = {}) => validateDashboardHtml(
    renderDashboardValidationFixture(data, chartData),
    { validationMode: 'staged', ...options }
  ).errors;
  const withFuturesPublishedAt = (data, publishedAt) => {
    data.futuresModule.stories = data.futuresModule.stories.map((item) => {
      const next = { ...item };
      if (publishedAt === undefined) delete next.publishedAt;
      else next.publishedAt = publishedAt;
      return next;
    });
    return data;
  };

  assert.deepEqual(stagedErrors(dashboard), []);
  assert.equal(
    stagedErrors(dashboard, { preparedAt: 'not-an-offset-timestamp' })
      .some((error) => error.includes('Prepared validation time')),
    true,
    'An explicit staged-validation preparation time must be an offset-bearing ISO timestamp.'
  );
  for (const publishedAt of [
    '2026-07-10T13:30:00.000Z',
    '2026-07-10T18:45:00.000Z',
    '2026-07-10T20:00:00.000Z'
  ]) {
    assert.deepEqual(stagedErrors(withFuturesPublishedAt(structuredClone(dashboard), publishedAt)), []);
  }

  const knownWindowInvalidValues = [
    undefined,
    null,
    42,
    [],
    {},
    '',
    'not-a-time',
    '2026-07-10',
    '2026-07-10T18:45:00',
    '2026-07-10T13:29:59.999Z',
    '2026-07-10T20:00:00.001Z'
  ];
  for (const publishedAt of knownWindowInvalidValues) {
    const errors = stagedErrors(withFuturesPublishedAt(structuredClone(dashboard), publishedAt));
    assert.equal(errors.some((error) => error.includes('futuresModule.stories[0].publishedAt')), true,
      `Known Session Futures window must reject publishedAt ${JSON.stringify(publishedAt)}.`);
  }

  const preMarket = structuredClone(dashboard);
  preMarket.editionId = '2026-07-10T13:00:00.000Z';
  preMarket.futuresModule.sectionTitle = 'Pre-Market Futures';
  for (const publishedAt of [
    '2026-07-09T22:00:00.000Z',
    '2026-07-10T04:00:00-05:00',
    '2026-07-10T13:00:00.000Z'
  ]) {
    assert.deepEqual(stagedErrors(withFuturesPublishedAt(structuredClone(preMarket), publishedAt)), [],
      `Pre-Market Futures must accept inclusive window timestamp ${publishedAt}.`);
  }
  for (const publishedAt of ['2026-07-09T21:59:59.999Z', '2026-07-10T13:00:00.001Z']) {
    const errors = stagedErrors(withFuturesPublishedAt(structuredClone(preMarket), publishedAt));
    assert.equal(errors.some((error) => error.includes('futuresModule.stories[0].publishedAt')), true,
      `Pre-Market Futures must reject out-of-window timestamp ${publishedAt}.`);
  }

  const preservedCanonicalEdition = withFuturesPublishedAt(structuredClone(preMarket), '2026-07-10T12:45:00.000Z');
  preservedCanonicalEdition.editionId = '2026-07-09T13:00:00.000Z';
  assert.equal(
    stagedErrors(preservedCanonicalEdition)
      .some((error) => error.includes('futuresModule.stories[0].publishedAt')),
    true,
    'Direct staged validation must remain reproducibly anchored to the embedded edition.'
  );
  assert.deepEqual(
    stagedErrors(preservedCanonicalEdition, { preparedAt: '2026-07-10T13:00:00.000Z' }),
    [],
    'Prepare may explicitly validate current Pre-Market stories while preserving the canonical edition guard.'
  );

  const unknownSessionRows = [
    { name: 'missing', rows: [] },
    {
      name: 'mismatched',
      rows: dashboard.futuresModule.futures.map((row, index) => ({
        ...row,
        raw: { ...row.raw, sessionDate: index === 0 ? '2026-07-09' : '2026-07-10' }
      }))
    },
    {
      name: 'unavailable',
      rows: dashboard.futuresModule.futures.map((row) => ({
        ...row,
        availability: { status: 'unavailable' }
      }))
    }
  ];
  for (const testCase of unknownSessionRows) {
    const unknownSession = structuredClone(dashboard);
    unknownSession.futuresModule.futures = testCase.rows;
    assert.deepEqual(stagedErrors(withFuturesPublishedAt(unknownSession, undefined)), [],
      `A futures card may remain date-only when ${testCase.name} rows cannot determine a session window.`);
    assert.equal(
      stagedErrors(withFuturesPublishedAt(structuredClone(unknownSession), 'not-a-time'))
        .some((error) => error.includes('futuresModule.stories[0].publishedAt')),
      true,
      `A malformed supplied timestamp must fail when ${testCase.name} rows leave the session window unknown.`
    );
  }

  for (const editionId of [undefined, 'not-an-edition']) {
    const unknownPreMarket = structuredClone(preMarket);
    if (editionId === undefined) delete unknownPreMarket.editionId;
    else unknownPreMarket.editionId = editionId;
    assert.deepEqual(stagedErrors(withFuturesPublishedAt(unknownPreMarket, undefined)), [],
      'Pre-Market Futures without a usable edition timestamp must use date-only freshness.');
    assert.equal(
      stagedErrors(withFuturesPublishedAt(structuredClone(unknownPreMarket), 'not-a-time'))
        .some((error) => error.includes('futuresModule.stories[0].publishedAt')),
      true,
      'Unknown Pre-Market windows must still reject malformed supplied timestamps.'
    );
  }

  const mixed = structuredClone(dashboard);
  mixed.futuresModule.stories[0].publishedAt = '2026-07-10T20:00:00.001Z';
  const mixedErrors = stagedErrors(mixed);
  assert.equal(mixedErrors.some((error) => error.includes('futuresModule.stories[0].publishedAt')), true);
  assert.equal(mixedErrors.some((error) => error.includes('futuresModule.stories[1].publishedAt')), false,
    'One invalid futures card must not make an in-window sibling invalid.');

  const publishedMalformed = withFuturesPublishedAt(structuredClone(dashboard), 'not-a-time');
  assert.deepEqual(
    validateDashboardHtml(renderDashboardValidationFixture(publishedMalformed, chartData), { validationMode: 'published' }).errors,
    [],
    'Published render-safety validation must remain permissive for recoverable futures metadata.'
  );
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

      await button.dispatchEvent('pointerdown', { bubbles: true, pointerType: 'touch' });
      await button.dispatchEvent('pointerup', { bubbles: true, pointerType: 'touch' });
      await button.click();
      assert.equal(await isOpen(), true);
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      await page.waitForTimeout(150);
      const openTooltip = await tooltipState();
      assert.equal(Boolean(openTooltip?.text), true);
      assert.equal(openTooltip.visibility, 'visible');
      assert.equal(openTooltip.opacity > 0, true, JSON.stringify(openTooltip));
      assert.equal(openTooltip.left >= -1 && openTooltip.right <= openTooltip.viewportWidth + 1, true, JSON.stringify(openTooltip));
      assert.equal(openTooltip.top >= -1 && openTooltip.bottom <= openTooltip.viewportHeight + 1, true, JSON.stringify(openTooltip));

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
        await assertTooltipInteraction(page, '[data-stale-info]', '[data-tape-group-panel]:not([hidden]) [data-stale-button]');
        await assertTooltipInteraction(page, '[data-dividend-info]', '[data-dividend-button]');
        await page.locator('[data-tape-group-panel]:not([hidden]) [data-tape-chart-button]:not([disabled])').first().click();
        await page.locator('[data-chart-info-button]').first().waitFor();
        await assertTooltipInteraction(page, '[data-chart-info]', '[data-chart-info-button]');
      }
    }

    async function assertTapePresentation(page) {
      const screenshotDir = path.join(root, 'generated');
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-tape-group-button]').filter({ hasText: 'Equities' }).click();
      const panel = page.locator('[data-tape-group-panel]:not([hidden])');
      const header = panel.locator('.tape-quote-header');
      assert.deepEqual((await header.locator(':scope > span').allTextContents()).map((text) => text.trim()), [
        'Instrument', 'Last', 'Previous', 'Change', 'Change %', 'Open', 'High', 'Low'
      ]);
      const row = panel.locator('.tape-row').first();
      const fields = ['last', 'previous', 'delta', 'pct', 'open', 'high', 'low'];
      assert.equal(await row.locator('.tape-asof-button').count(), 1,
        'The embedded source timestamp must remain visible when the local-refresh request returns no data.');
      assert.match((await row.locator('.tape-asof-button').innerText()).trim(), /^As of /);
      const typography = await row.evaluate((element) => {
        const name = element.querySelector('.tape-name-line');
        const observation = element.querySelector('.tape-observation-line');
        return {
          nameSize: getComputedStyle(name.querySelector('.entity-name')).fontSize,
          tickerSize: getComputedStyle(name.querySelector('.tape-ticker')).fontSize,
          gap: observation.getBoundingClientRect().top - name.getBoundingClientRect().bottom
        };
      });
      assert.deepEqual(typography, { nameSize: '16px', tickerSize: '12px', gap: 3 });
      const alignment = await page.evaluate(({ panelSelector, fields: fieldNames }) => {
        const activePanel = document.querySelector(panelSelector);
        const headerCells = [...activePanel.querySelectorAll('.tape-quote-header > span')].slice(1);
        const firstRow = activePanel.querySelector('.tape-row');
        return fieldNames.map((field, index) => {
          const heading = headerCells[index].getBoundingClientRect();
          const value = firstRow.querySelector(`.tape-${field}`).getBoundingClientRect();
          return {
            headingCenter: heading.left + heading.width / 2,
            valueCenter: value.left + value.width / 2,
            visible: getComputedStyle(firstRow.querySelector(`.tape-${field}`)).display !== 'none'
          };
        });
      }, { panelSelector: '[data-tape-group-panel]:not([hidden])', fields });
      for (const item of alignment) {
        assert.equal(item.visible, true);
        assert.equal(Math.abs(item.headingCenter - item.valueCenter) < 2, true, JSON.stringify(item));
      }
      await page.locator('.section-tape').screenshot({ path: path.join(screenshotDir, 'tape-desktop.png') });

      const chartButton = row.locator('[data-tape-chart-button]');
      assert.equal(await chartButton.getAttribute('data-tape-chart-row'), 'SPX');
      await chartButton.click();
      const chartTitle = panel.locator('.tape-chart-title');
      await chartTitle.waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains('tape-chart-title'));
      assert.equal(await chartTitle.evaluate((element) => document.activeElement === element), true,
        'Activating a Tape row must move focus to its chart heading.');
      await page.waitForFunction(() => document.querySelector('[data-chart-stage]')?.classList.contains('no-volume'));
      await page.screenshot({ path: path.join(screenshotDir, 'tape-desktop-chart.png') });

      await panel.locator('[data-chart-close]').click();
      const ratesButton = page.locator('[data-tape-group-button]').filter({ hasText: 'Rates & Credit' });
      await ratesButton.click();
      const treasuryRow = page.locator('[data-tape-chart-row="UST10Y"]').locator('..');
      assert.match((await treasuryRow.locator('.tape-asof-button').innerText()).trim(), /^As of [A-Z][a-z]{2} \d{1,2}$/);
      await treasuryRow.locator('.tape-asof-button').click();
      assert.match(await treasuryRow.locator('[role="tooltip"]').textContent(), /date precision only/i);
      await treasuryRow.locator('.tape-asof-button').click();

      await page.setViewportSize({ width: 820, height: 1000 });
      await page.locator('.section-tape').screenshot({ path: path.join(screenshotDir, 'tape-tablet.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileRow = treasuryRow;
      assert.equal(await mobileRow.locator('.tape-mobile-quote').evaluate((element) => getComputedStyle(element).display !== 'none'), true);
      assert.equal(await mobileRow.locator(':scope > .tape-value').evaluateAll((elements) => elements.every((element) => getComputedStyle(element).display === 'none')), true);
      assert.equal(await mobileRow.locator('.tape-mobile-quote .quote-last').count(), 1);
      assert.equal(await mobileRow.locator('.tape-mobile-quote .metric-value').count(), 1,
        'Daily Treasury rows show only their basis-point change when percent change is unavailable.');

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('[data-tape-group-button]').filter({ hasText: 'Equities' }).click();
      const mobileFixtureRow = page.locator('[data-tape-chart-row="SPX"]').locator('..');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await mobileFixtureRow.locator('.tape-mobile-quote .quote-last').count(), 1);
      assert.equal(await mobileFixtureRow.locator('.tape-mobile-quote .metric-value').count(), 2,
        'Mobile session rows show Last plus absolute and percentage change only.');
      await page.locator('.section-tape').screenshot({ path: path.join(screenshotDir, 'tape-mobile.png') });

      const cryptoButton = page.locator('[data-tape-group-button]').filter({ hasText: 'Crypto' });
      if (await cryptoButton.count()) {
        await cryptoButton.click();
        const cryptoAsOf = page.locator('[data-tape-group-panel]:not([hidden]) .tape-asof-button').first();
        await cryptoAsOf.click();
        await page.waitForFunction(() => {
          const button = document.querySelector('[data-tape-group-panel]:not([hidden]) .tape-asof-button');
          const tooltip = button?.closest('[data-stale-info]')?.querySelector('[role="tooltip"]');
          const style = tooltip && getComputedStyle(tooltip);
          return style?.visibility === 'visible' && Number(style.opacity) === 1;
        });
        await page.locator('.section-tape').screenshot({ path: path.join(screenshotDir, 'tape-mobile-crypto-tooltip.png') });
        await cryptoAsOf.click();
      }
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await cryptoButton.click();
        for (const ticker of ['BTC', 'ETH', 'XRP']) {
          await page.locator(`[data-tape-chart-row="${ticker}"]`).click();
          await page.locator('[data-realized-price-readout]').filter({ hasText: 'Realized price' }).waitFor();
          const card = page.locator('.tape-inline-chart-slot.is-open .tape-chart-shell');
          const bounds = await card.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
          await card.screenshot({ path: path.join(screenshotDir, `realized-price-${ticker.toLowerCase()}-${viewport.width}.png`) });
        }
      }
    }

    async function assertTimedTapeTimestamp(page, observedAt) {
      const date = new Date(observedAt);
      const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }).format(date);
      const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' }).format(date);
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
        await page.setViewportSize(viewport);
        await page.locator('[data-tape-group-button]').filter({ hasText: 'Equities' }).click();
        const button = page.locator('[data-tape-chart-row="SPX"]').locator('..').locator('.tape-asof-button');
        await button.scrollIntoViewIfNeeded();
        assert.equal((await button.innerText()).trim(), `As of ${day}, ${time}`);
        const bounds = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const quote = element.closest('.tape-row')?.querySelector('.tape-mobile-quote')?.getBoundingClientRect();
          return { left: rect.left, right: rect.right, quoteLeft: quote?.left, viewportWidth: window.innerWidth };
        });
        assert.equal(bounds.left >= -1 && bounds.right <= bounds.viewportWidth + 1, true, JSON.stringify(bounds));
        if (viewport.width <= 1100) assert.equal(bounds.right <= bounds.quoteLeft + 1, true, JSON.stringify(bounds));
      }
    }

    async function assertWeekAheadImpactFiltering(page) {
      const section = page.locator('.section-week-ahead');
      const toggle = section.locator('[data-week-impact-toggle]');
      if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();

      const familyRow = (name) => section.locator('.week-event-row').filter({ hasText: name });
      const pce = familyRow('PCE Price Index');
      const durableGoods = familyRow('Durable Goods Orders');
      assert.equal(await pce.count(), 1);
      assert.equal(await durableGoods.count(), 1);
      assert.equal(await pce.locator('.week-event-variant').count(), 2);
      assert.equal(await durableGoods.locator('.week-event-variant').count(), 2);
      assert.match(await pce.innerText(), /Core · MoM/i);
      assert.match(await pce.innerText(), /Headline · MoM/i);
      assert.match(await durableGoods.innerText(), /Core · MoM/i);
      assert.match(await durableGoods.innerText(), /Headline · MoM/i);
      assert.equal(await section.getByText('Corporate Profits', { exact: true }).count(), 0);

      for (const [title, subtitle] of [
        ['API Crude Oil Stock Change', 'API · Weekly'],
        ['Net Long-term TIC Flows', 'Treasury · Release'],
        ['Industrial Production', 'Fed · MoM'],
        ['MBA 30-Year Mortgage Rate', 'MBA · Release'],
        ['NAHB Housing Market Index', 'NAHB · Index'],
        ['Pending Home Sales', 'NAR · MoM'],
        ['S&P Global Manufacturing PMI', 'S&P · Index'],
        ['S&P/Case-Shiller Home Price', 'S&P · YoY'],
        ['Fixture Indicator', 'Fixture Research Institute · Index']
      ]) {
        const row = familyRow(title);
        assert.equal(await row.count(), 1);
        assert.equal((await row.locator('.week-event-kind').textContent()).trim(), subtitle);
      }

      await toggle.click();
      assert.equal(await section.getByText('Corporate Profits', { exact: true }).count(), 1);
      assert.equal(await familyRow('PCE Price Index').locator('.week-event-variant').count(), 2);
      assert.equal(await familyRow('Durable Goods Orders').locator('.week-event-variant').count(), 2);
      await section.locator('[data-week-impact-toggle]').click();
    }

    async function assertFedSpeechDisclosure(page) {
      const section = page.locator('.section-week-ahead');
      const toggle = section.locator('[data-week-impact-toggle]');
      if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
      const days = section.locator('.week-day-row');
      const multipleDay = days.nth(0);
      const disclosure = multipleDay.locator('details.week-fed-speeches');
      const summary = disclosure.locator('summary.week-event-row');
      const singleDay = days.nth(1);
      const noSpeechDay = days.nth(2);
      const mixedDay = days.nth(3);

      assert.equal(await disclosure.count(), 1);
      assert.equal(await disclosure.getAttribute('open'), null);
      assert.equal((await summary.locator('.week-event-name').textContent()).trim(), 'Fed Speeches (2)');
      assert.equal((await summary.locator('.week-event-kind').textContent()).trim(), 'Federal Reserve · Policy');
      assert.equal((await summary.locator('.week-event-time').textContent()).trim(), '8:00 AM');
      assert.deepEqual(await multipleDay.locator('.week-events > *').evaluateAll((rows) => rows.map(
        (row) => row.querySelector('.week-event-name')?.textContent.trim()
      )), ['Fixture Early Release', 'Fed Speeches (2)', 'Fixture Midday Release', 'FOMC Minutes',
        'Fed Chair Powell Testimony', 'Federal Reserve Decision', 'ECB President Speech']);
      assert.equal((await multipleDay.locator('.week-day-count').textContent()).trim(), '9 events · 1 medium hidden');
      assert.equal(await disclosure.getByText('Waller', { exact: true }).count(), 0,
        'A high-impact speech must not expose a filtered medium-impact speech.');
      for (const day of [singleDay, noSpeechDay, mixedDay]) {
        assert.equal(await day.locator('details.week-fed-speeches').count(), 0);
      }
      assert.equal(await singleDay.getByText('Fed Williams Speech', { exact: true }).count(), 1);
      assert.equal((await singleDay.locator('.week-event-kind').textContent()).trim(), 'Federal Reserve · Policy');
      assert.equal(await mixedDay.getByText('Fed Jefferson Speech', { exact: true }).count(), 1);
      assert.equal((await mixedDay.locator('.week-day-count').textContent()).trim(), '1 event · 1 medium hidden');
      assert.equal(await mixedDay.getByText('Medium speech lens', { exact: true }).count(), 0);

      await summary.click();
      assert.equal(await disclosure.getAttribute('open'), '');
      assert.deepEqual(await disclosure.locator('.week-fed-speech-list .week-event-name').allTextContents(), ['Jefferson', 'Kugler']);
      assert.deepEqual(await disclosure.locator('.week-fed-speech-list .week-event-time').allTextContents(), ['8:00 AM', '10:00 AM']);
      await summary.click();
      assert.equal(await disclosure.getAttribute('open'), null);
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await disclosure.getAttribute('open'), '');
      await page.keyboard.press('Space');
      assert.equal(await disclosure.getAttribute('open'), null);

      await toggle.click();
      assert.equal((await summary.locator('.week-event-name').textContent()).trim(), 'Fed Speeches (3)');
      assert.equal((await multipleDay.locator('.week-day-count').textContent()).trim(), '10 events');
      assert.equal(await mixedDay.locator('details.week-fed-speeches').count(), 1);
      assert.equal((await mixedDay.locator('.week-day-count').textContent()).trim(), '2 events');
      assert.equal(await mixedDay.getByText('Medium speech lens', { exact: true }).count(), 1,
        'Lens visibility must still use underlying event IDs.');
      await summary.click();
      assert.deepEqual(await disclosure.locator('.week-fed-speech-list .week-event-name').allTextContents(), ['Jefferson', 'Kugler', 'Waller']);
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
        await page.setViewportSize(viewport);
        await summary.scrollIntoViewIfNeeded();
        const typography = await disclosure.evaluate((element) => {
          const measure = (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return { size: style.fontSize, weight: style.fontWeight, left: rect.left, right: rect.right };
          };
          return {
            names: [...element.querySelectorAll('.week-fed-speech-list .week-event-name')].map(measure),
            times: [...element.querySelectorAll('.week-fed-speech-list .week-event-time')].map(measure),
            width: window.innerWidth
          };
        });
        assert.equal(typography.names.length, 3);
        assert.equal(typography.times.length, 3);
        for (const name of typography.names) {
          assert.equal(name.size, '15px');
          assert.equal(name.weight, '500');
          assert.ok(name.left >= -1 && name.right <= typography.width + 1, JSON.stringify(typography));
        }
        for (const time of typography.times) {
          assert.equal(time.size, '12px');
          assert.equal(time.weight, '800');
          assert.ok(time.left >= -1 && time.right <= typography.width + 1, JSON.stringify(typography));
        }
      }
      await toggle.click();
      assert.equal((await summary.locator('.week-event-name').textContent()).trim(), 'Fed Speeches (2)');
      assert.equal(await mixedDay.locator('details.week-fed-speeches').count(), 0);
      assert.equal(await mixedDay.getByText('Medium speech lens', { exact: true }).count(), 0);
    }

    async function assertDashboardStarts(file, {
      testTooltips = false,
      testTapePresentation = false,
      testTimedTapeTimestamp = false,
      testWeekAheadImpactFilter = false,
      testFedSpeeches = false,
      carriedTapeTicker = '',
      earningsState = '',
      malformedTapeTicker = '',
      unavailableTape = false
    } = {}) {
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
        if (earningsState) {
          const earnings = page.locator('.section-earnings');
          assert.equal(await earnings.count(), 1);
          assert.equal(await page.locator('.section-tape').count() > 0, true);
          assert.equal(await page.locator('.section-week-ahead').count(), 1);
          assert.equal(await earnings.locator('.earnings-monitor-empty').count(), earningsState === 'unavailable' ? 1 : 0);
          assert.equal(await earnings.locator('.earnings-calendar-strip').count(), earningsState === 'calendar' ? 1 : 0);
          assert.equal(await earnings.locator('[data-earnings-calendar-cue]').count(), earningsState === 'calendar' ? 1 : 0);
        }
        if (testTooltips) await assertTooltipInteractions(page);
        if (testTapePresentation) await assertTapePresentation(page);
        if (testTimedTapeTimestamp) await assertTimedTapeTimestamp(page, testTimedTapeTimestamp);
        if (testWeekAheadImpactFilter) await assertWeekAheadImpactFiltering(page);
        if (testFedSpeeches) await assertFedSpeechDisclosure(page);
        if (malformedTapeTicker) {
          const malformedRow = page.locator(`[data-tape-chart-row="${malformedTapeTicker}"]`).locator('..');
          assert.equal((await malformedRow.locator('.tape-last').textContent()).trim(), '—');
          assert.match(await malformedRow.locator('.instrument').textContent(), /Quote unavailable/);
          assert.notEqual((await page.locator('[data-tape-chart-row="VCR"]').locator('..').locator('.tape-last').textContent()).trim(), '—',
            'Malformed quote metadata must not degrade a valid sibling row.');
        }
        if (carriedTapeTicker) {
          const carriedRow = page.locator(`[data-tape-chart-row="${carriedTapeTicker}"]`).locator('..');
          assert.notEqual((await carriedRow.locator('.tape-last').textContent()).trim(), '—');
          await carriedRow.locator('.tape-asof-button').click();
          assert.match(await carriedRow.locator('[role="tooltip"]').textContent(), /stale|latest refresh is unavailable/i);
        }
        if (unavailableTape) {
          assert.equal(await page.locator('.tape-row .tape-last').evaluateAll(
            (elements) => elements.length > 0 && elements.every((element) => element.textContent.trim() === '—')
          ), true);
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }

    async function assertTapeFragmentNavigation(file) {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport });
        try {
          await page.route('https://192.168.2.2:2210/api/market-refresh', (route) => {
            route.fulfill({ status: 204, body: '' });
          });
          await page.goto(`${pathToFileURL(file).href}#section-tape`);
          const tape = page.locator('#section-tape');
          await tape.waitFor();
          await page.waitForFunction(() => {
            const rect = document.getElementById('section-tape')?.getBoundingClientRect();
            return rect && rect.bottom > 0 && rect.top >= -1 && rect.top < 120;
          });
          assert.equal(await page.evaluate(() => window.location.hash), '#section-tape');
          assert.equal(await page.evaluate(() => window.innerWidth), viewport.width);
          assert.equal(await tape.isVisible(), true);
        } finally {
          await page.close();
        }
      }
    }

    const canonicalDashboard = path.join(root, 'daily_financial_news.html');
    await assertDashboardStarts(canonicalDashboard, { testTapePresentation: true });
    await assertTapeFragmentNavigation(canonicalDashboard);

    const recoverableDir = makeTemporaryDirectory('dfd-browser-recoverable-');
    const recoverableFile = path.join(recoverableDir, 'dashboard.html');
    const rootHref = pathToFileURL(`${root}${path.sep}`).href;
    const recoverableHtml = fs.readFileSync(canonicalDashboard, 'utf8')
      .replace('<head>', `<head>\n  <base href="${rootHref}">`);
    const recoverableData = readJsonBlock(recoverableHtml, 'dashboard-data');
    recoverableData.opening = null;
    fs.writeFileSync(recoverableFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(recoverableData)));
    await assertDashboardStarts(recoverableFile);

    for (const testCase of malformedEarningsPublishedCases) {
      const malformed = structuredClone(recoverableData);
      testCase.change(malformed);
      const html = replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(malformed));
      const file = path.join(recoverableDir, `dashboard-earnings-${testCase.name}.html`);
      fs.writeFileSync(file, html);
      await assertDashboardStarts(file, { earningsState: 'unavailable' });
    }

    for (const [name, status, expected] of [
      ['carried-forward', 'carried_forward', 'calendar'],
      ['unavailable', 'unavailable', 'unavailable']
    ]) {
      const changed = structuredClone(recoverableData);
      changed.earnings.week.availability = { status };
      const file = path.join(recoverableDir, `dashboard-earnings-${name}.html`);
      fs.writeFileSync(file, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(changed)));
      await assertDashboardStarts(file, { earningsState: expected });
    }

    const overlayFile = path.join(recoverableDir, 'dashboard-local-overlay.html');
    const overlayFixture = createDashboardValidationFixture();
    const canonicalChartData = readJsonBlock(recoverableHtml, 'chart-data');
    const canonicalObjectChartData = roundChartPayload(canonicalChartData);
    const overlayTickers = ['SPX', 'VCR', 'UST10Y', 'GC'];
    overlayFixture.dashboard.tape.rows = overlayTickers.map((ticker) => (
      structuredClone(recoverableData.tape.rows.find((row) => row.ticker === ticker))
    ));
    overlayFixture.chartData = {
      ...structuredClone(canonicalChartData),
      series: overlayTickers.map((ticker) => (
        structuredClone(canonicalChartData.series.find((series) => series.ticker === ticker))
      ))
    };
    const spxObservedAt = overlayFixture.chartData.series.find((series) => series.ticker === 'SPX').quote.observedAt;
    overlayFixture.dashboard.crypto.stats.find((row) => row.sym === 'F&G').availability = {
      status: 'carried_forward',
      lastValidatedAt: '2026-07-09T21:00:00.000Z'
    };
    const overlayHtml = replaceJsonBlock(
      replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(overlayFixture.dashboard)),
      'chart-data', JSON.stringify(overlayFixture.chartData)
    );
    fs.writeFileSync(overlayFile, overlayHtml);
    await assertDashboardStarts(overlayFile, { testTimedTapeTimestamp: spxObservedAt });

    for (const testCase of malformedTapeQuotePublishedCases) {
      const malformedChartData = structuredClone(overlayFixture.chartData);
      testCase.change(malformedChartData.series.find((series) => series.ticker === 'SPX'));
      const file = path.join(recoverableDir, `dashboard-tape-quote-${testCase.name}.html`);
      fs.writeFileSync(file, replaceJsonBlock(overlayHtml, 'chart-data', JSON.stringify(malformedChartData)));
      await assertDashboardStarts(file, { malformedTapeTicker: 'SPX' });
    }

    const carriedForwardChartData = structuredClone(overlayFixture.chartData);
    carriedForwardChartData.series.find((series) => series.ticker === 'SPX').availability = {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt: '2026-07-11T12:00:00.000Z'
    };
    const carriedForwardFile = path.join(recoverableDir, 'dashboard-tape-quote-carried-forward.html');
    fs.writeFileSync(carriedForwardFile, replaceJsonBlock(overlayHtml, 'chart-data', JSON.stringify(carriedForwardChartData)));
    await assertDashboardStarts(carriedForwardFile, { carriedTapeTicker: 'SPX' });

    const unavailableChartData = structuredClone(overlayFixture.chartData);
    unavailableChartData.availability = {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: '2026-07-11T12:00:00.000Z'
    };
    unavailableChartData.series = [];
    const unavailableFile = path.join(recoverableDir, 'dashboard-tape-quote-unavailable.html');
    fs.writeFileSync(unavailableFile, replaceJsonBlock(overlayHtml, 'chart-data', JSON.stringify(unavailableChartData)));
    await assertDashboardStarts(unavailableFile, { unavailableTape: true });

    const spxFresh = structuredClone(canonicalObjectChartData.series.find((series) => series.ticker === 'SPX'));
    const vcrFresh = structuredClone(canonicalObjectChartData.series.find((series) => series.ticker === 'VCR'));
    const freshBase = Math.max(Date.parse(spxFresh.quoteRevision), Date.parse(vcrFresh.quoteRevision));
    const freshRevision = (minutes) => new Date(freshBase + minutes * 60_000).toISOString();
    // Revisions can be downloaded on a later day than their source observations.
    // Keep valid fixture observations on their actual latest candle dates.
    const freshObservation = (series, minutes) => new Date(Date.parse(series.quote.observedAt) + minutes * 60_000).toISOString();
    spxFresh.quoteRevision = freshRevision(1);
    spxFresh.bars.at(-1).close = Math.max(spxFresh.quote.last, spxFresh.bars.at(-1).high) + 1;
    spxFresh.bars.at(-1).high = spxFresh.bars.at(-1).close + 1;
    spxFresh.quote = {
      ...spxFresh.quote,
      observedAt: freshObservation(spxFresh, 1),
      last: spxFresh.bars.at(-1).close,
      high: spxFresh.bars.at(-1).high
    };
    const spxOneBar = {
      ...spxFresh,
      quoteRevision: freshRevision(2),
      quote: { ...spxFresh.quote, observedAt: freshObservation(spxFresh, 1) },
      bars: [spxFresh.bars.at(-1)]
    };
    vcrFresh.quoteRevision = freshRevision(3);
    vcrFresh.bars.at(-1).close = Math.max(vcrFresh.quote.last, vcrFresh.bars.at(-1).high) + 1;
    vcrFresh.bars.at(-1).high = vcrFresh.bars.at(-1).close + 1;
    vcrFresh.quote = {
      ...vcrFresh.quote,
      observedAt: freshObservation(vcrFresh, 1),
      last: vcrFresh.bars.at(-1).close,
      high: vcrFresh.bars.at(-1).high
    };
    let overlayPayload = { schemaVersion: 1, generatedAt: spxOneBar.quoteRevision, series: [spxOneBar] };
    const overlayPage = await browser.newPage();
    try {
      await overlayPage.route('https://192.168.2.2:2210/api/market-refresh', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' },
        body: JSON.stringify(overlayPayload)
      }));
      const indicator = overlayPage.locator('[data-local-refresh-indicator]');
      const tapeRow = (ticker) => overlayPage.locator(`[data-tape-chart-row="${ticker}"]`).locator('..');
      await overlayPage.goto(pathToFileURL(overlayFile).href);
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'partial');
      assert.match(await indicator.textContent(), /Quote integrity check failed: SPX/);
      assert.equal(await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2')), null);

      overlayPayload = { schemaVersion: 1, generatedAt: spxFresh.quoteRevision, series: [spxFresh] };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'live');
      const spxQuote = await tapeRow('SPX').locator('.tape-last').textContent();
      const acceptedCache = await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2'));
      assert.ok(acceptedCache);

      const assertRejectedSeries = async (series, generatedAt, label) => {
        overlayPayload = { schemaVersion: 1, generatedAt, series: [series] };
        await overlayPage.reload();
        await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'partial');
        assert.ok((await indicator.textContent()).includes(`Quote integrity check failed: ${series.ticker}`), label);
        assert.equal(await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2')), acceptedCache, label);
        assert.equal(await tapeRow('SPX').locator('.tape-last').textContent(), spxQuote, label);
      };

      for (const quote of [undefined, null, 'invalid']) {
        const malformed = { ...structuredClone(spxFresh), quote, quoteRevision: freshRevision(4) };
        await assertRejectedSeries(malformed, malformed.quoteRevision, 'Missing, null, or wrongly typed quotes must warn and preserve the accepted quote.');
      }

      const wrongEquitySource = structuredClone(spxFresh);
      wrongEquitySource.sourceSymbol = 'AAPL';
      wrongEquitySource.quoteRevision = '2026-09-28T21:08:00.000Z';
      wrongEquitySource.quote.observedAt = wrongEquitySource.quoteRevision;
      await assertRejectedSeries(wrongEquitySource, wrongEquitySource.quoteRevision, 'SPX must reject an AAPL source identity.');

      const wrongCryptoSource = structuredClone(spxFresh);
      wrongCryptoSource.sourceSymbol = 'BTC-USD';
      wrongCryptoSource.quoteRevision = '2026-09-28T21:09:00.000Z';
      wrongCryptoSource.quote = {
        ...wrongCryptoSource.quote,
        behavior: 'crypto_utc',
        observedAt: wrongCryptoSource.quoteRevision
      };
      await assertRejectedSeries(wrongCryptoSource, wrongCryptoSource.quoteRevision, 'SPX must reject a BTC-USD source identity.');

      const unexpectedContract = structuredClone(spxFresh);
      unexpectedContract.quoteRevision = '2026-09-28T21:10:00.000Z';
      unexpectedContract.quote = {
        ...unexpectedContract.quote,
        observedAt: unexpectedContract.quoteRevision,
        contractSymbol: 'ESZ26.CME'
      };
      await assertRejectedSeries(unexpectedContract, unexpectedContract.quoteRevision, 'A non-futures quote must reject contractSymbol.');

      const wrongObservationDay = structuredClone(spxFresh);
      wrongObservationDay.quoteRevision = '2026-09-28T21:11:00.000Z';
      wrongObservationDay.quote.observedAt = '2026-09-27T21:11:00.000Z';
      await assertRejectedSeries(wrongObservationDay, wrongObservationDay.quoteRevision, 'A session quote must match its latest bar date.');

      const indexWithVolume = structuredClone(spxFresh);
      indexWithVolume.quoteRevision = '2026-09-28T21:12:00.000Z';
      indexWithVolume.quote.observedAt = indexWithVolume.quoteRevision;
      indexWithVolume.noVolume = false;
      indexWithVolume.bars.at(-1).volume = 123456;
      await assertRejectedSeries(indexWithVolume, indexWithVolume.quoteRevision, 'A cash index must reject volume.');

      const wrongFuturesContract = structuredClone(canonicalObjectChartData.series.find((series) => series.ticker === 'GC'));
      wrongFuturesContract.quoteRevision = '2026-09-28T21:13:00.000Z';
      wrongFuturesContract.quote = {
        ...wrongFuturesContract.quote,
        observedAt: wrongFuturesContract.quoteRevision,
        previous: 4100,
        contractSymbol: 'CLZ26.NYM'
      };
      await assertRejectedSeries(wrongFuturesContract, wrongFuturesContract.quoteRevision, 'GC must reject a contract from the wrong root and exchange.');

      overlayPayload = { schemaVersion: 1, generatedAt: spxOneBar.quoteRevision, series: [spxOneBar] };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'partial');
      assert.equal(await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2')), acceptedCache);
      assert.equal(await tapeRow('SPX').locator('.tape-last').textContent(), spxQuote);

      const vcrQuote = await tapeRow('VCR').locator('.tape-last').textContent();
      overlayPayload = { schemaVersion: 1, generatedAt: vcrFresh.quoteRevision, series: [vcrFresh, spxOneBar] };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'partial');
      assert.match(await indicator.textContent(), /Quote integrity check failed: SPX/);
      assert.notEqual(await tapeRow('VCR').locator('.tape-last').textContent(), vcrQuote);
      assert.equal(await tapeRow('SPX').locator('.tape-last').textContent(), spxQuote);

      const crypto = overlayPage.locator('.section-crypto');
      const totalBefore = await crypto.locator('.crypto-stat--total').innerText();
      const altseasonBefore = await crypto.locator('.crypto-stat--altcoin-season').innerText();
      assert.equal(await crypto.locator('.crypto-stat--sentiment [data-stale-info]').count(), 1);
      overlayPayload = {
        schemaVersion: 1,
        generatedAt: '2026-07-10T21:08:00.000Z',
        partial: true,
        series: [],
        cryptoStats: {
          fetchedAt: '2026-07-10T21:08:00.000Z',
          stats: [{ ...overlayFixture.dashboard.crypto.stats.find((row) => row.sym === 'F&G'), price: '63', delta: '+13', chg: '+13', dir: 'up', availability: undefined }],
          dominance: null
        }
      };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'partial');
      assert.equal((await crypto.locator('.crypto-stat--sentiment .stat-scoreline strong').textContent()).trim(), '63');
      assert.equal(await crypto.locator('.crypto-stat--sentiment [data-stale-info]').count(), 0);
      assert.equal(await crypto.locator('.crypto-stat--total').innerText(), totalBefore);
      assert.equal(await crypto.locator('.crypto-stat--altcoin-season').innerText(), altseasonBefore);
    } finally {
      await overlayPage.close();
    }

    // Use the real runtime and library; capture their series data rather than
    // approximating a canvas line from pixels or replacing the chart library.
    const realizedChartData = structuredClone(canonicalChartData);
    const realizedDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    for (const [index, ticker] of ['BTC', 'ETH', 'XRP'].entries()) {
      const series = realizedChartData.series.find((item) => item.ticker === ticker);
      const dates = series.bars.map((bar) => Array.isArray(bar) ? bar[0] : bar.time);
      assert.ok(dates.length > 40, `${ticker} requires enough canonical history for range coverage.`);
      // XRP has a single visible observation in short ranges, while the full
      // source history remains valid and contains two observations.
      const values = (ticker === 'XRP' ? [dates[0], dates.at(-2)] : [dates[0], dates.at(-40), dates.at(-4), dates.at(-2)]).map((time, point) => ({
        time, value: (index + 1) * 100 + point + 0.25
      }));
      series.realizedPrice = {
        asset: ticker.toLowerCase(), source: 'Coin Metrics Community API', sourceKey: 'coin_metrics_community',
        observedAt: values.at(-1).time, freshness: ticker === 'ETH' ? 'stale' : 'fresh',
        checkedAt: '2026-10-01T12:00:00.000Z', values,
        ...(ticker === 'ETH' ? { reason: 'source_refresh_failed' } : {})
      };
      if (ticker === 'BTC') {
        // A valid overlay-only date must remain selectable even without its candle.
        const gapDate = values.at(-2).time;
        series.bars = series.bars.filter((bar) => (Array.isArray(bar) ? bar[0] : bar.time) !== gapDate);
      }
    }
    const realizedFile = path.join(recoverableDir, 'dashboard-realized-price.html');
    const realizedHtml = replaceJsonBlock(recoverableHtml, 'chart-data', JSON.stringify(realizedChartData));
    fs.writeFileSync(realizedFile, realizedHtml);

    async function captureRealizedCharts(page) {
      await page.evaluate(() => {
        const library = window.LightweightCharts;
        window.__realizedCharts = [];
        window.LightweightCharts = { ...library, createChart(...args) {
          const chart = library.createChart(...args);
          const captured = { chart, ticker: args[0].closest('.tape-chart-shell')?.querySelector('.tape-chart-meta')?.textContent.trim(), series: [], crosshair: null };
          window.__realizedCharts.push(captured);
          const addSeries = chart.addSeries.bind(chart);
          chart.addSeries = (definition, options, pane) => {
            const api = addSeries(definition, options, pane);
            const record = { api, kind: api.seriesType(), options, data: [] };
            captured.series.push(record);
            const setData = api.setData.bind(api);
            api.setData = (data) => { record.data = structuredClone(data); return setData(data); };
            return api;
          };
          const subscribe = chart.subscribeCrosshairMove.bind(chart);
          chart.subscribeCrosshairMove = (handler) => {
            captured.crosshair = handler;
            return subscribe((param) => {
              captured.pointerTime = param.time;
              captured.pointerSeries = [...param.seriesData.keys()].map((api) => api.seriesType());
              handler(param);
            });
          };
          return chart;
        } };
      });
    }
    async function openRealizedChart(page, ticker) {
      await page.locator('[data-tape-group-button]').filter({ hasText: ['BTC', 'ETH', 'XRP', 'SOL', 'IBIT', 'ETHA', 'MSTR'].includes(ticker) ? 'Crypto' : 'Equities' }).click();
      const previous = await page.evaluate(() => window.__realizedCharts.length);
      await page.locator(`[data-tape-chart-row="${ticker}"]`).click();
      await page.waitForFunction(({ count, ticker }) => window.__realizedCharts.length > count
        && window.__realizedCharts.at(-1).ticker === ticker
        && window.__realizedCharts.at(-1).series.some((series) => series.kind === 'Candlestick'), { count: previous, ticker });
    }
    async function capturedRealizedData(page) {
      return page.evaluate(() => window.__realizedCharts.at(-1).series.map(({ kind, options, data }) => ({ kind, options, data })));
    }
    async function assertRealizedRange(page, expectedOverlay) {
      // Opening a chart can scroll its plot underneath the pointer and trigger
      // a valid missing-day crosshair. Reset before checking the default readout.
      await page.mouse.move(0, 0);
      await page.locator('[data-price-chart]').dispatchEvent('pointerleave');
      const records = await capturedRealizedData(page);
      const candles = records.find((record) => record.kind === 'Candlestick').data;
      const lines = records.filter((record) => record.kind === 'Line');
      const expected = expectedOverlay.values.filter((point) => point.time >= candles[0].time && point.time <= candles.at(-1).time);
      assert.equal(lines.length, expected.length ? 1 : 0);
      if (expected.length) {
        assert.deepEqual(lines[0].data, expected, 'Realized history must clip to the selected candle interval without filling gaps or extending its endpoint.');
        assert.equal(lines[0].options.priceScaleId, 'right');
        assert.equal(lines[0].options.title, 'Realized price');
        assert.equal(lines[0].options.color, '#c99718', 'The realized-price line must be gold.');
        assert.equal(lines[0].options.priceLineVisible, false, 'A last-value horizontal price line must not extrapolate realized history.');
        const readout = await page.locator('[data-realized-price-readout]').innerText();
        assert.match(readout, /Realized price/i);
        assert.ok(readout.includes(String(expected.at(-1).value)), readout);
        assert.ok(readout.includes(realizedDateFormat.format(new Date(`${expected.at(-1).time}T00:00:00Z`))), readout);
      }
      return candles;
    }
    async function assertRealizedCrosshair(page, time, expectedValue) {
      await page.evaluate((date) => {
        const captured = window.__realizedCharts.at(-1);
        const candle = captured.series.find((record) => record.kind === 'Candlestick');
        captured.crosshair({ point: { x: 20, y: 20 }, time: date,
          seriesData: new Map([[candle.api, candle.data.find((point) => point.time === date)]]) });
      }, time);
      const text = await page.locator('[data-realized-price-readout]').innerText();
      if (expectedValue === null) assert.match(text, /—/, 'Missing-day crosshairs must not borrow a neighboring observation.');
      else assert.ok(text.includes(String(expectedValue)), text);
    }

    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      try {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('https://192.168.2.2:2210/api/market-refresh', (route) => route.fulfill({ status: 204, body: '' }));
        await page.goto(pathToFileURL(realizedFile).href);
        await page.locator('#content').waitFor();
        await captureRealizedCharts(page);
        for (const ticker of ['BTC', 'ETH', 'XRP']) {
          const overlay = realizedChartData.series.find((series) => series.ticker === ticker).realizedPrice;
          await openRealizedChart(page, ticker);
          const ranges = await page.locator('[data-chart-range]').evaluateAll((buttons) => buttons.map((button) => button.dataset.chartRange));
          for (const range of ranges) {
            const previous = await page.evaluate(() => window.__realizedCharts.length);
            await page.locator(`[data-chart-range="${range}"]`).click();
            await page.waitForFunction((count) => window.__realizedCharts.length > count, previous);
            await assertRealizedRange(page, overlay);
          }
          if (ticker === 'BTC') {
            const previous = await page.evaluate(() => window.__realizedCharts.length);
            await page.locator('[data-chart-range="1M"]').click();
            await page.waitForFunction((count) => window.__realizedCharts.length > count, previous);
            await assertRealizedRange(page, overlay);
            const observation = overlay.values.at(-2);
            const plot = page.locator('[data-price-chart]');
            await plot.scrollIntoViewIfNeeded();
            const bounds = await plot.boundingBox();
            const x = await page.evaluate((time) => window.__realizedCharts.at(-1).chart.timeScale().timeToCoordinate(time), observation.time);
            assert.ok(bounds && Number.isFinite(x), 'The overlay-only date must have a real chart coordinate.');
            await page.mouse.move(bounds.x + x, bounds.y + 100);
            await page.waitForFunction((time) => window.__realizedCharts.at(-1).pointerTime === time, observation.time);
            assert.deepEqual(await page.evaluate(() => window.__realizedCharts.at(-1).pointerSeries), ['Line']);
            assert.ok((await page.locator('[data-realized-price-readout]').innerText()).includes(String(observation.value)));
            const candleReadout = await page.locator('[data-chart-readout] > span').allTextContents();
            assert.equal(candleReadout[0], `Date ${realizedDateFormat.format(new Date(`${observation.time}T00:00:00Z`))}`);
            assert.deepEqual(candleReadout.slice(1, 5), ['O N/A', 'H N/A', 'L N/A', 'C N/A'], 'A missing candle must not borrow the latest OHLC values.');
            await page.screenshot({ path: path.join(root, 'generated', `realized-candle-gap-${viewport.width}.png`) });
          }
          await assertRealizedCrosshair(page, overlay.values.at(-1).time, overlay.values.at(-1).value);
          const candles = (await capturedRealizedData(page)).find((record) => record.kind === 'Candlestick').data;
          const gap = candles.find((point) => point.time > overlay.values.at(-2).time && point.time < overlay.values.at(-1).time
            && !overlay.values.some((observation) => observation.time === point.time));
          if (gap) await assertRealizedCrosshair(page, gap.time, null);
          await assertRealizedCrosshair(page, candles.at(-1).time, null);
          await page.locator('[data-price-chart]').dispatchEvent('pointerleave');
          await assertRealizedRange(page, overlay);
          const info = await page.locator('[data-chart-info] [role="tooltip"]').textContent();
          assert.match(info, /Coin Metrics/i);
          assert.match(info, /daily/i);
          assert.match(info, ticker === 'ETH' ? /stale/i : /fresh/i);
          if (ticker === 'XRP') assert.match(info, /escrow/i);
          await assertTooltipInteraction(page, '[data-chart-info]', '[data-chart-info-button]');
          if (viewport.width === 1280 && ticker === 'XRP') {
            await page.setViewportSize({ width: 820, height: 1000 });
            await assertTooltipInteraction(page, '[data-chart-info]', '[data-chart-info-button]');
            await page.setViewportSize(viewport);
            await page.locator('[data-chart-info-button]').click();
            await page.mouse.move(0, 0);
            for (const size of [{ width: 1280, height: 500 }, { width: 1000, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 500 }, viewport]) {
              // Keep the panel open; reactivation would mask missing resize positioning.
              await page.setViewportSize(size);
              await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              const state = await page.locator('[data-chart-info-button]').evaluate((button) => {
                const panel = button.closest('[data-chart-info]').querySelector('[role="tooltip"]');
                const bounds = panel.getBoundingClientRect();
                const anchor = button.getBoundingClientRect();
                return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
                  width: innerWidth, height: innerHeight, anchorVisible: anchor.bottom >= 0 && anchor.top <= innerHeight,
                  visibility: getComputedStyle(panel).visibility, open: button.getAttribute('aria-expanded') };
              });
              assert.equal(state.open, 'true', 'Resize must preserve the open tooltip state.');
              if (state.anchorVisible) {
                assert.equal(state.visibility, 'visible', JSON.stringify(state));
                assert.ok(state.top >= 0 && state.bottom <= state.height && state.left >= 0 && state.right <= state.width, JSON.stringify(state));
              } else assert.equal(state.visibility, 'hidden', JSON.stringify(state));
              if (size.width === 1280 && size.height === 500) await page.screenshot({ path: path.join(root, 'generated', 'realized-tooltip-resize-1280.png') });
            }
            await page.locator('[data-chart-info-button]').click();
          }
        }
        for (const ticker of ['SOL', 'IBIT', 'ETHA', 'MSTR', 'SPX']) {
          await openRealizedChart(page, ticker);
          assert.equal((await capturedRealizedData(page)).some((series) => series.kind === 'Line'), false, `${ticker} must not receive a coin realized-price overlay.`);
          assert.equal(await page.locator('[data-realized-price-readout]').count(), 0);
        }
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }

    const malformedRealizedCases = [
      ['absent', (series) => { delete series.realizedPrice; }],
      ['null', (series) => { series.realizedPrice = null; }],
      ['wrong-type', (series) => { series.realizedPrice = []; }],
      ['invalid-date', (series) => { series.realizedPrice.values[0].time = '2026-02-30'; }],
      ['unordered', (series) => { series.realizedPrice.values.reverse(); }],
      ['duplicate-date', (series) => { series.realizedPrice.values[1].time = series.realizedPrice.values[0].time; }],
      ['wrong-value-type', (series) => { series.realizedPrice.values[0].value = '100'; }],
      ['nonpositive-value', (series) => { series.realizedPrice.values[0].value = 0; }],
      ['null-values', (series) => { series.realizedPrice.values = null; }],
      ['mismatched-asset', (series) => { series.realizedPrice.asset = 'eth'; }],
      ['unavailable', (series) => { Object.assign(series.realizedPrice, { freshness: 'unavailable', observedAt: null, values: [], reason: 'source_refresh_failed' }); }]
    ];
    for (const [label, change] of malformedRealizedCases) {
      const data = structuredClone(realizedChartData);
      change(data.series.find((series) => series.ticker === 'BTC'));
      const file = path.join(recoverableDir, `dashboard-realized-${label}.html`);
      fs.writeFileSync(file, replaceJsonBlock(realizedHtml, 'chart-data', JSON.stringify(data)));
      const page = await browser.newPage();
      const errors = [];
      try {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('https://192.168.2.2:2210/api/market-refresh', (route) => route.fulfill({ status: 204, body: '' }));
        await page.goto(pathToFileURL(file).href);
        await page.locator('#content').waitFor();
        await captureRealizedCharts(page);
        await openRealizedChart(page, 'BTC');
        assert.equal((await capturedRealizedData(page)).some((record) => record.kind === 'Line'), false, label);
        await openRealizedChart(page, 'ETH');
        await assertRealizedRange(page, data.series.find((series) => series.ticker === 'ETH').realizedPrice);
        await openRealizedChart(page, 'SPX');
        assert.deepEqual(errors, [], `${label} must leave sibling charts and dashboard startup usable.`);
      } finally { await page.close(); }
    }

    for (const localOverlay of [undefined, null, { asset: 'btc', values: [{ time: '2099-01-01', value: 999999 }] }]) {
      const fresh = structuredClone(canonicalObjectChartData.series.find((series) => series.ticker === 'BTC'));
      fresh.quoteRevision = new Date(Date.parse(fresh.quoteRevision) + 60_000).toISOString();
      fresh.quote.observedAt = fresh.quoteRevision;
      if (localOverlay === undefined) delete fresh.realizedPrice;
      else fresh.realizedPrice = localOverlay;
      const payload = { schemaVersion: 1, generatedAt: fresh.quoteRevision, series: [fresh] };
      const page = await browser.newPage();
      try {
        await page.route('https://192.168.2.2:2210/api/market-refresh', (route) => route.fulfill({
          status: 200, contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' }, body: JSON.stringify(payload)
        }));
        await page.goto(pathToFileURL(realizedFile).href);
        await page.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'live');
        await captureRealizedCharts(page);
        await openRealizedChart(page, 'BTC');
        const embedded = realizedChartData.series.find((series) => series.ticker === 'BTC').realizedPrice;
        await assertRealizedRange(page, embedded);
        const info = await page.locator('[data-chart-info] [role="tooltip"]').textContent();
        assert.match(info, /Coin Metrics/i);
        assert.ok(info.includes(realizedDateFormat.format(new Date(`${embedded.observedAt}T00:00:00Z`))), info);
        assert.match(info, /fresh/i);
      } finally { await page.close(); }
    }

    const tooltipFile = path.join(recoverableDir, 'dashboard-tooltips.html');
    const tooltipData = readJsonBlock(recoverableHtml, 'dashboard-data');
    const tooltipPortfolioRow = tooltipData.assetAllocationPortfolio?.rows?.[0];
    if (!tooltipPortfolioRow) throw new Error('Tooltip browser fixture requires one Asset Allocation row.');
    tooltipPortfolioRow.dividends = [{ exDate: '2026-08-15', amount: 0.25 }];
    tooltipPortfolioRow.monthDivPerShareValue = 0.25;
    fs.writeFileSync(tooltipFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(tooltipData)));
    await assertDashboardStarts(tooltipFile, { testTooltips: true });

    const weekAheadFilterFile = path.join(recoverableDir, 'dashboard-week-ahead-filter.html');
    const weekAheadFilterData = readJsonBlock(recoverableHtml, 'dashboard-data');
    const weekAheadEvent = (id, name, agency, impact, period = 'MoM') => ({
      id,
      time: '08:30',
      name,
      agency,
      period,
      impact,
      actual: null,
      forecast: '0.2%',
      previous: '0.1%',
      forecastType: 'consensus',
      valuesApplicable: true,
      lensPath: 'broad-growth',
      surprise: null,
      status: 'scheduled'
    });
    weekAheadFilterData.weekAhead = {
      range: { from: '2026-07-13', to: '2026-07-17', timeZone: 'America/Chicago', marketTimeZone: 'America/New_York' },
      source: { status: 'fresh' },
      days: [{
        date: '2026-07-13',
        label: 'Mon, Jul 13',
        closure: null,
        events: [
          weekAheadEvent('core-pce', 'Core PCE Price Index', 'BEA', 'high'),
          weekAheadEvent('headline-pce', 'PCE Price Index', 'BEA', 'medium'),
          weekAheadEvent('core-durable', 'Core Durable Goods Orders', 'Census', 'medium'),
          weekAheadEvent('headline-durable', 'Durable Goods Orders', 'Census', 'high'),
          weekAheadEvent('corporate-profits', 'Corporate Profits', 'BEA', 'medium'),
          weekAheadEvent('api-crude', 'API Crude Oil Stock Change', 'American Petroleum Institute (API)', 'high', 'Weekly'),
          weekAheadEvent('tic-flows', 'Net Long-term TIC Flows', 'Department of the Treasury', 'high', 'Release'),
          weekAheadEvent('industrial-production', 'Industrial Production', 'Federal Reserve', 'high'),
          weekAheadEvent('mortgage-rate', 'MBA 30-Year Mortgage Rate', 'Mortgage Bankers Association of America', 'high', 'Release'),
          weekAheadEvent('nahb-index', 'NAHB Housing Market Index', 'National Association of Home Builders', 'high', 'Index'),
          weekAheadEvent('pending-home-sales', 'Pending Home Sales', 'National Association of Realtors', 'high'),
          weekAheadEvent('sp-global-pmi', 'S&P Global Manufacturing PMI', 'S&P Global', 'high', 'Index'),
          weekAheadEvent('case-shiller', 'S&P/Case-Shiller Home Price', "Standard and Poor's", 'high', 'YoY'),
          weekAheadEvent('unmapped-agency', 'Fixture Indicator', 'Fixture Research Institute', 'high', 'Index')
        ]
      }]
    };
    fs.writeFileSync(weekAheadFilterFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(weekAheadFilterData)));
    await assertDashboardStarts(weekAheadFilterFile, { testWeekAheadImpactFilter: true });

    const fedSpeechesFile = path.join(recoverableDir, 'dashboard-fed-speeches.html');
    const fedSpeechesData = readJsonBlock(recoverableHtml, 'dashboard-data');
    const policyEvent = (id, name, time, impact = 'high', agency = 'Federal Reserve') => ({
      ...weekAheadEvent(id, name, agency, impact, 'Policy'),
      time,
      actual: null,
      forecast: null,
      previous: null,
      valuesApplicable: false,
      lensPath: 'policy'
    });
    fedSpeechesData.weekAhead = {
      ...weekAheadFilterData.weekAhead,
      days: [{
        date: '2026-07-13', label: 'Mon, Jul 13', closure: null,
        events: [
          { ...weekAheadEvent('early-release', 'Fixture Early Release', 'BEA', 'high'), time: '08:00' },
          policyEvent('jefferson', 'Fed Jefferson Speech', '09:00'),
          { ...weekAheadEvent('midday-release', 'Fixture Midday Release', 'BEA', 'high'), time: '10:00' },
          policyEvent('kugler', 'Fed Kugler Speech', '11:00'),
          policyEvent('waller', 'Fed Waller Speech', '13:00', 'medium'),
          policyEvent('minutes', 'FOMC Minutes', '14:00'),
          policyEvent('testimony', 'Fed Chair Powell Testimony', '15:00'),
          policyEvent('decision', 'Fed Interest Rate Decision', '16:00'),
          policyEvent('press', 'Fed Press Conference', '16:30'),
          policyEvent('ecb', 'ECB President Speech', '17:00', 'high', 'ECB')
        ]
      }, {
        date: '2026-07-14', label: 'Tue, Jul 14', closure: null,
        events: [policyEvent('williams', 'Fed Williams Speech', '09:00')]
      }, {
        date: '2026-07-15', label: 'Wed, Jul 15', closure: null,
        events: [weekAheadEvent('ordinary-release', 'Fixture Ordinary Release', 'BEA', 'high')]
      }, {
        date: '2026-07-16', label: 'Thu, Jul 16', closure: null,
        events: [
          policyEvent('mixed-jefferson', 'Fed Jefferson Speech', '09:00'),
          policyEvent('mixed-waller', 'Fed Waller Speech', '13:00', 'medium')
        ],
        marketLens: {
          eventIds: ['mixed-waller'],
          copy: { title: 'Medium speech lens', body: 'Fixture lens anchored to the medium speech.' }
        }
      }]
    };
    fs.writeFileSync(fedSpeechesFile, replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(fedSpeechesData)));
    await assertDashboardStarts(fedSpeechesFile, { testFedSpeeches: true });

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
    await testScheduledMarketHolidayGate();
    testTapeQuoteContract();
    testNewsReviewEvidenceDiagnosticsAndIsolation();
    testEditorialApplyAdvisories();
    testArchitectureSingleWriterAndCliBoundaries();
    testPreparationStagesWithoutCanonicalWrite();
    testCommitValidatesBeforeReplace();
    testApplyUsesIsolatedNewsSidecarAndKeepsCandidateFacts();
    testRecoveryNotesDoNotAffectApply();
    testApplyPreviewParityAndNoWrites();
    testCrossSectionDuplicateFallbackPreservesPriority();
    await testNewPreparationDiscardsPreviousRecoveryState();
    await require('./test_context_recovery').runSelfTests();
    testApplyFiltersFuturesPublicationMetadataWithoutCrossSectionDamage();
    testPublishedGateAllowsRecoverableSectionsButBlocksStartupShell();
    testFuturesStoryPublicationWindowValidation();
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
