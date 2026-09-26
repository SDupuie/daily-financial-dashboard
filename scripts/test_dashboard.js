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
  editorialStyleAdvisories,
  malformedEarningsEditorialFields,
  parseArgs,
  patchDashboard,
  readJsonBlock,
  replaceJsonBlock,
  runEditorialApply,
  runWithSectionFallback,
  stageDashboardCandidate,
  syncDashboardPricesFromChartData
} = require('./run_daily_update');
const {
  evaluateNewsReviewEvidence,
  reviewedTapeCommentary,
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
        previousPublishedStoryIds: [],
        currentPublishedStoryIds: scheduledIds
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
    module.exports = { priorNewsCandidates: () => ({ generalCandidates: [], futuresCandidates: [], cryptoCandidates: [] }) };
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
  assert.equal(Object.hasOwn(fresh.editorialReview, 'resumeNotes'), false, 'The AI initializes optional notes after successful Prepare.');
  assert.equal(fresh.editorialReview.reviewEvidence.metadataScanComplete, false);
  assert.deepEqual(fresh.editorialReview.reviewEvidence.deepReviews, []);
  assert.equal(fs.existsSync(path.join(editorialDir, 'review-progress.md')), false);
  assert.equal(fs.readFileSync(dashboardFile, 'utf8'), originalHtml);
  assert.equal(fs.readFileSync(candidateFile, 'utf8'), originalHtml);
  process.stdout.write('Recovery notes: fresh handoff lifecycle check passed.\n');
}

function testApplyFiltersFuturesPublicationMetadataWithoutCrossSectionDamage() {
  const { dashboard, chartData } = createDashboardValidationFixture();

  const applyCase = (name, {
    configureDashboard = () => {},
    configureCandidates = () => {},
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
  const newsCandidates = fixtureNewsCandidatesArtifact(dashboard, '2026-07-10T21:00:00.000Z');
  writeJson(newsCandidatesPath, newsCandidates);
  const editorialPayload = structuredClone(candidateDashboard);
  editorialPayload.editionId = '2026-07-10T21:00:00.000Z';
  const newsSelection = fixtureNewsSelection(dashboard);
  editorialPayload.editorialReview = {
    schemaVersion: 1,
    preparedAt: '2026-07-10T21:00:00.000Z',
    reviewedAt: null,
    baseEditionId: candidateDashboard.editionId,
    verifiedClaims: [],
    reviewEvidence: fixtureReviewEvidence(newsCandidates, newsSelection),
    newsSelection,
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

    async function assertDashboardStarts(file, { testTooltips = false, testWeekAheadImpactFilter = false, earningsState = '' } = {}) {
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
        if (testWeekAheadImpactFilter) await assertWeekAheadImpactFiltering(page);
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
    overlayFixture.dashboard.crypto.stats.find((row) => row.sym === 'F&G').availability = {
      status: 'carried_forward',
      lastValidatedAt: '2026-07-09T21:00:00.000Z'
    };
    fs.writeFileSync(overlayFile, replaceJsonBlock(
      replaceJsonBlock(recoverableHtml, 'dashboard-data', JSON.stringify(overlayFixture.dashboard)),
      'chart-data', JSON.stringify(overlayFixture.chartData)
    ));
    const spxFresh = structuredClone(chartSeriesFixture()[0]);
    spxFresh.quoteRevision = '2026-07-10T21:05:00.000Z';
    spxFresh.bars[1].high = 105;
    spxFresh.bars[1].close = 104;
    const spxOneBar = { ...spxFresh, quoteRevision: '2026-07-10T21:06:00.000Z', bars: [spxFresh.bars[1]] };
    const vcrFresh = structuredClone(chartSeriesFixture()[1]);
    vcrFresh.quoteRevision = '2026-07-10T21:07:00.000Z';
    vcrFresh.bars[1].high = 106;
    vcrFresh.bars[1].close = 105;
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
      const noNewerAtStartup = overlayPage.waitForEvent('console', {
        predicate: (message) => message.text().includes('Local market refresh found no newer prices.')
      });
      await overlayPage.goto(pathToFileURL(overlayFile).href);
      await noNewerAtStartup;
      assert.equal(await indicator.getAttribute('data-local-refresh-state'), 'idle');
      assert.equal(await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2')), null);
      assert.equal(await tapeRow('SPX').locator('.commentary-stale-info').count(), 0);

      overlayPayload = { schemaVersion: 1, generatedAt: spxFresh.quoteRevision, series: [spxFresh] };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'live');
      const spxQuote = await tapeRow('SPX').locator('.quote-last').textContent();
      const spxNote = await tapeRow('SPX').locator('.tape-signal-copy').textContent();
      assert.equal(await tapeRow('SPX').locator('.commentary-stale-info').count(), 1);
      const acceptedCache = await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2'));
      assert.ok(acceptedCache);

      overlayPayload = { schemaVersion: 1, generatedAt: spxOneBar.quoteRevision, series: [spxOneBar] };
      const noNewerPrices = overlayPage.waitForEvent('console', {
        predicate: (message) => message.text().includes('Local market refresh found no newer prices.')
      });
      await overlayPage.reload();
      await noNewerPrices;
      assert.equal(await indicator.getAttribute('data-local-refresh-state'), 'cached');
      assert.equal(await overlayPage.evaluate(() => localStorage.getItem('daily-financial-dashboard:local-market-refresh:v2')), acceptedCache);
      assert.equal(await tapeRow('SPX').locator('.quote-last').textContent(), spxQuote);
      assert.equal(await tapeRow('SPX').locator('.tape-signal-copy').textContent(), spxNote);
      assert.equal(await tapeRow('SPX').locator('.commentary-stale-info').count(), 1);

      const vcrQuote = await tapeRow('VCR').locator('.quote-last').textContent();
      overlayPayload = { schemaVersion: 1, generatedAt: vcrFresh.quoteRevision, series: [vcrFresh, spxOneBar] };
      await overlayPage.reload();
      await overlayPage.waitForFunction(() => document.querySelector('[data-local-refresh-indicator]')?.dataset.localRefreshState === 'live');
      assert.notEqual(await tapeRow('VCR').locator('.quote-last').textContent(), vcrQuote);
      assert.equal(await tapeRow('SPX').locator('.quote-last').textContent(), spxQuote);
      assert.equal(await tapeRow('SPX').locator('.tape-signal-copy').textContent(), spxNote);
      assert.equal(await tapeRow('SPX').locator('.commentary-stale-info').count(), 1);

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
    testRefreshedQuoteCannotReusePriorCommentary();
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
