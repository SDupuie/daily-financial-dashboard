#!/usr/bin/env node

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { isIsoDate, isIsoDateTime } = require('./calendar_contract');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const {
  createServer: createLocalMarketServer,
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
} = require('./fetch_chart_data');
const { normalizedSummary } = require('./fetch_asset_allocation');
const {
  decodeObjectSeries,
  decodeTupleSeries,
  validateChartPayload,
  validateChartPayloadMetadata
} = require('./chart_payload_contract');
const {
  applyAssetAllocationPortfolio,
  applyAssetAllocationSummary,
  applyWeekAhead,
  buildEarningsNarrativeSidecar,
  calendarRolloverRange,
  earningsCalendarNeedsBuild,
  earningsEditorialRequiredError,
  EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE,
  patchDashboardDataBlock,
  patchWeekAheadRollover,
  applyCryptoQuoteRows,
  applyCryptoStats,
  applyFuturesModule,
  applyScheduledNewsBaseline,
  applyTapeQuoteRows,
  readJsonBlock,
  replaceJsonBlock,
  syncDashboardPricesFromChartData,
  storyIdentity,
  stampDashboardEdition,
  validateScheduledPreflight
} = require('./run_daily_update');
const { normalizeWeekAhead } = require('./week_ahead_contract');
const {
  FIXTURE_NOW,
  createDashboardValidationFixture,
  renderDashboardValidationFixture
} = require('./dashboard_validation_fixture');

const root = path.resolve(__dirname, '..');

function writeChartDataFixture(latestDate, { tuple = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-market-server-'));
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

function requestLocalHttps(port, { path: requestPath = '/health', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
      rejectUnauthorized: false
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
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

function extractDashboardRuntimeFunction(html, name) {
  const functionStart = html.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `Missing dashboard runtime function ${name}`);
  // Preserve async so lifecycle helpers run with the same promise semantics as the browser runtime.
  const start = html.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;

  const parameterStart = html.indexOf('(', functionStart);
  let parameterDepth = 0;
  let bodyStart = -1;
  for (let index = parameterStart; index < html.length; index += 1) {
    if (html[index] === '(') parameterDepth += 1;
    if (html[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        bodyStart = html.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `Missing body for dashboard runtime function ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] === '{') {
      depth += 1;
    } else if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  assert.fail(`Could not extract dashboard runtime function ${name}`);
}

function extractScriptFunction(file, name) {
  return extractDashboardRuntimeFunction(fs.readFileSync(path.join(root, file), 'utf8'), name);
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
  const futures = ['ES', 'NQ', 'YM', 'RTY'].map((ticker) => ({ ticker, last: '1.00' }));

  applyFuturesModule(data, { futures }, 'afternoon');
  assert.equal(data.futuresModule.sectionLabel, 'After The Bell');
  assert.equal(data.futuresModule.sectionTitle, 'Session Futures');
  assert.deepEqual(data.futuresModule.futures.map((row) => row.ticker), ['ES', 'NQ', 'YM', 'RTY']);

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

function testUpdaterWeekAheadPreservesEditorialLens() {
  const data = dashboardFixture();
  const payload = normalizeWeekAhead({
    announcements: {
      retail_sales: { data: [{ announcement_id: 'usd_retail_sales_2026-05-31', announcement_datetime: 1781699400, val: 0.1 }] }
    },
    predictions: {
      retail_sales: { data: [{
        announcement_id: 'usd_retail_sales_2026-06-30',
        announcement_datetime: 1784205000,
        announcement_datetime_local: '2026-07-13T08:30:00-04:00',
        predictions: [{ prediction_type: 'market_consensus', predicted_value: 0.2 }]
      }] }
    }
  }, {
    range: { from: '2026-07-13', to: '2026-07-17' },
    officialSchedule: {
      events: [{
        date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  data.weekAhead = {
    days: [{
      date: '2026-07-13',
      marketLens: { title: 'Custom lens', body: 'Editorial copy stays separate from calendar facts.', watchlist: ['SPX'] },
      marketLensSource: 'editorial'
    }]
  };
  applyWeekAhead(data, payload);
  assert.equal(data.weekAhead.days[0].marketLens.title, 'Custom lens');
  assert.equal(data.weekAhead.days[0].marketLensSource, 'editorial');
  assert.equal(data.weekAhead.days[0].events[0].time, '08:30');
  assert.equal(data.weekAhead.days[0].events[0].forecast, '0.2%');

  const generatedData = dashboardFixture();
  generatedData.weekAhead = {
    days: [{
      date: '2026-07-13',
      marketLens: { title: 'Stale generated lens', body: 'This should not survive a calendar refresh.', watchlist: ['SPX'] }
    }]
  };
  applyWeekAhead(generatedData, payload);
  assert.equal(generatedData.weekAhead.days[0].marketLens.title, 'Demand gets the next vote');
  assert.equal(generatedData.weekAhead.days[0].marketLensSource, 'generated');
}

function testCalendarRolloverRange() {
  assert.deepEqual(calendarRolloverRange('afternoon', new Date('2026-07-10T21:00:00Z')), {
    from: '2026-07-10', to: '2026-07-16'
  });
  assert.deepEqual(calendarRolloverRange('morning', new Date('2026-07-13T12:00:00Z')), {
    from: '2026-07-13', to: '2026-07-17'
  });
  assert.equal(calendarRolloverRange('morning', new Date('2026-07-10T12:00:00Z')), null);
  assert.equal(calendarRolloverRange('afternoon', new Date('2026-07-13T21:00:00Z')), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-calendar-rollover-'));
  const earningsPath = path.join(dir, 'earnings_week.json');
  const fridayBridge = { from: '2026-07-10', to: '2026-07-16' };
  assert.equal(earningsCalendarNeedsBuild(fridayBridge, earningsPath), true);
  fs.writeFileSync(earningsPath, JSON.stringify({ range: fridayBridge }));
  assert.equal(earningsCalendarNeedsBuild(fridayBridge, earningsPath), false);
  assert.equal(earningsCalendarNeedsBuild({ from: '2026-07-13', to: '2026-07-17' }, earningsPath), true);
}

function testWeekAheadRolloverCommitsBeforeEarnings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-week-ahead-rollover-'));
  const dashboardPath = path.join(dir, 'dashboard.html');
  const weekAheadPath = path.join(dir, 'week_ahead.json');
  const payload = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-10', to: '2026-07-16' },
    officialSchedule: {
      events: [{
        date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      }],
      authorities: []
    },
    now: new Date('2026-07-10T21:00:00Z')
  });
  fs.writeFileSync(weekAheadPath, JSON.stringify(payload));
  fs.writeFileSync(dashboardPath, `<script type="application/json" id="dashboard-data">${JSON.stringify({ weekAhead: { days: [] } })}</script>`);

  assert.equal(patchWeekAheadRollover({
    dashboard: dashboardPath,
    calendarRolloverRange: { from: '2026-07-10', to: '2026-07-16' },
    skipWeekAhead: false
  }, weekAheadPath), true);
  const patched = readJsonBlock(fs.readFileSync(dashboardPath, 'utf8'), 'dashboard-data');
  assert.deepEqual(patched.weekAhead.days.map((day) => day.date), [
    '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'
  ]);
}

function testWeekAheadRendererConvertsMarketTime() {
  const instant = extractScriptFunction('daily_financial_news.html', 'weekAheadInstant');
  const label = extractScriptFunction('daily_financial_news.html', 'weekAheadTimeLabel');
  const weekAheadTimeLabel = new Function(`${instant}\n${label}\nreturn weekAheadTimeLabel;`)();
  const rendered = weekAheadTimeLabel(
    { date: '2026-07-14' },
    { time: '08:30' },
    { range: { marketTimeZone: 'America/New_York', timeZone: 'America/Chicago' } }
  );
  assert.equal(rendered, '7:30 AM');
}

function testWeekAheadRendererGroupsReleaseFamilies() {
  const releaseFamily = extractScriptFunction('daily_financial_news.html', 'weekAheadReleaseFamily');
  const familyVariant = extractScriptFunction('daily_financial_news.html', 'weekAheadFamilyVariant');
  const familyEvents = extractScriptFunction('daily_financial_news.html', 'weekAheadFamilyEvents');
  const eventGroups = extractScriptFunction('daily_financial_news.html', 'weekAheadEventGroups');
  const runtime = new Function(`${releaseFamily}\n${familyVariant}\n${familyEvents}\n${eventGroups}\nreturn { weekAheadFamilyEvents, weekAheadEventGroups };`)();
  const event = (name, period, agency = 'BLS', time = '08:30') => ({ name, period, agency, time, impact: 'high' });
  const events = [
    event('Consumer Price Index', 'YoY'),
    event('Core Consumer Price Index', 'YoY'),
    event('Consumer Price Index', 'MoM'),
    event('Core Consumer Price Index', 'MoM'),
    event('Producer Price Index', 'MoM'),
    event('Core Producer Price Index', 'MoM'),
    event('Retail Sales', 'MoM', 'Census'),
    event('Retail Sales Control Group', 'MoM', 'Census'),
    event('Core Retail Sales', 'MoM', 'Census'),
    event('Core PCE Price Index', 'YoY', 'BEA')
  ];
  const groups = runtime.weekAheadEventGroups(events);

  assert.deepEqual(groups.map((group) => group.family?.title || group.events[0].name), [
    'Consumer Price Index',
    'Producer Price Index',
    'Retail Sales',
    'Core PCE Price Index'
  ]);
  assert.deepEqual(
    runtime.weekAheadFamilyEvents(groups[0].events, groups[0].family).map((item) => `${item.name}:${item.period}`),
    [
      'Core Consumer Price Index:MoM',
      'Core Consumer Price Index:YoY',
      'Consumer Price Index:MoM',
      'Consumer Price Index:YoY'
    ]
  );
  assert.deepEqual(
    runtime.weekAheadFamilyEvents(groups[2].events, groups[2].family).map((item) => item.name),
    ['Core Retail Sales', 'Retail Sales', 'Retail Sales Control Group']
  );
  assert.equal(groups[3].family, null, 'A standalone core release must not be collapsed into a family.');
}

function testNewEarningsNarrativeRowsStageAndRequireEditorialCompletion() {
  const week = {
    generatedAt: '2026-07-09T22:00:00.000Z',
    range: { from: '2026-07-06', to: '2026-07-10' },
    rows: [{
      symbol: 'NEW',
      reportDate: '2026-07-09',
      country: 'US',
      exchange: 'NASDAQ',
      marketCap: 2000000000,
      sourceAudit: { finnhubProfile: { industry: 'Technology' } },
      outcome: { overall: 'beat' },
      reaction: { status: 'computed' }
    }]
  };
  const staged = buildEarningsNarrativeSidecar(week, { rows: [] });

  assert.deepEqual(staged.missingRows, [{ symbol: 'NEW', reportDate: '2026-07-09' }]);
  assert.equal(staged.payload.rows.length, 1);
  assert.equal(staged.payload.rows[0].outcome.interpretation, '');
  const error = earningsEditorialRequiredError(staged.missingRows);
  assert.equal(error.exitCode, EARNINGS_EDITORIAL_REQUIRED_EXIT_CODE);
  assert.match(error.message, /NEW \(2026-07-09\)/);

  const staleNarrative = {
    rows: [{
      ...staged.payload.rows[0],
      postReportRefreshRequired: false,
      outcome: { interpretation: 'Pre-report demand assumptions framed the setup.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Pre-report copy should never return after actuals arrive.' }
    }]
  };
  const invalidatedWeek = {
    ...week,
    rows: [{
      ...week.rows[0],
      outcome: { overall: 'mixed', guide: '', interpretation: '' },
      reaction: { status: 'computed', note: '' }
    }]
  };
  const invalidated = buildEarningsNarrativeSidecar(invalidatedWeek, staleNarrative);
  assert.deepEqual(invalidated.missingRows, [{ symbol: 'NEW', reportDate: '2026-07-09' }]);
  assert.equal(invalidated.payload.rows[0].outcome.interpretation, '');
  assert.equal(invalidated.payload.rows[0].postReportRefreshRequired, true);

  const completed = buildEarningsNarrativeSidecar(week, {
    rows: [{
      ...staged.payload.rows[0],
      outcome: { interpretation: 'Demand and margin expansion supported the result.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Demand and margin expansion supported the reaction.' }
    }]
  });
  assert.deepEqual(completed.missingRows, []);

  const refreshed = buildEarningsNarrativeSidecar(invalidatedWeek, {
    rows: [{
      ...invalidated.payload.rows[0],
      outcome: { interpretation: 'Margins and the forward outlook became the post-report focus.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Updated margin and outlook detail drove the post-report read.' }
    }]
  });
  assert.deepEqual(refreshed.missingRows, []);
  assert.equal(refreshed.payload.rows[0].postReportRefreshRequired, undefined);
  assert.equal(refreshed.payload.rows[0].outcome.interpretation, 'Margins and the forward outlook became the post-report focus.');
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

function testScheduledNewsBaselineMarkers() {
  const existingStory = { title: 'Existing Story', url: 'https://Example.com/news/story?utm_source=newsletter#section' };
  const newStory = { title: 'New Story', url: 'https://example.com/news/new-story' };
  const existingCryptoNote = { title: 'Existing Crypto Story', url: 'https://example.com/crypto/existing' };
  const newCryptoNote = { title: 'New Crypto Story', url: 'https://example.com/crypto/new' };
  const previousData = {
    newsBaseline: {
      lastScheduledUpdateAt: '2026-07-05T12:00:00.000Z',
      previousScheduledStoryIds: [],
      currentScheduledStoryIds: [storyIdentity(existingStory), storyIdentity(existingCryptoNote)].sort()
    }
  };

  const manualData = { stories: [existingStory, newStory], crypto: { notes: [existingCryptoNote, newCryptoNote] } };
  applyScheduledNewsBaseline(manualData, previousData, { scheduled: false });

  assert.equal(manualData.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(manualData.stories[1].isNewSinceScheduledUpdate, true);
  assert.equal(manualData.crypto.notes[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(manualData.crypto.notes[1].isNewSinceScheduledUpdate, true);
  assert.deepEqual(manualData.newsBaseline.currentScheduledStoryIds, previousData.newsBaseline.currentScheduledStoryIds);

  const scheduledData = { stories: [existingStory, newStory], crypto: { notes: [existingCryptoNote, newCryptoNote] } };
  applyScheduledNewsBaseline(scheduledData, previousData, {
    scheduled: true,
    scheduledWindow: 'morning',
    now: new Date('2026-07-06T12:00:00.000Z')
  });

  assert.equal(scheduledData.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(scheduledData.stories[1].isNewSinceScheduledUpdate, true);
  assert.equal(scheduledData.crypto.notes[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(scheduledData.crypto.notes[1].isNewSinceScheduledUpdate, true);
  assert.deepEqual(scheduledData.newsBaseline.previousScheduledStoryIds, previousData.newsBaseline.currentScheduledStoryIds);
  assert.deepEqual(scheduledData.newsBaseline.currentScheduledStoryIds, [
    storyIdentity(existingCryptoNote),
    storyIdentity(existingStory),
    storyIdentity(newCryptoNote),
    storyIdentity(newStory)
  ].sort());
  assert.ok(!Number.isNaN(Date.parse(scheduledData.newsBaseline.lastScheduledUpdateAt)));
  assert.equal(scheduledData.newsBaseline.lastScheduledWindow, '2026-07-06:morning');
}

function testRefreshNewsBaselineCliMode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-news-baseline-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const existingStory = {
    tag: 'Markets',
    title: 'Existing Story',
    body: 'Still here.',
    url: 'https://example.com/news/existing',
    publishedOn: '2026-07-06'
  };
  const newStory = {
    tag: 'Markets',
    title: 'New Story',
    body: 'Freshly added.',
    url: 'https://example.com/news/new',
    publishedOn: '2026-07-06'
  };
  const existingCryptoNote = {
    kicker: 'Bitcoin',
    title: 'Existing Crypto Story',
    body: 'Still here.',
    url: 'https://example.com/crypto/existing',
    publishedOn: '2026-07-06'
  };
  const newCryptoNote = {
    kicker: 'Ethereum',
    title: 'New Crypto Story',
    body: 'Fresh crypto note.',
    url: 'https://example.com/crypto/new',
    publishedOn: '2026-07-06'
  };
  const dashboardHtml = [
    '<script type="application/json" id="dashboard-data">',
    JSON.stringify({
      editionId: 'old',
      newsBaseline: {
        lastScheduledUpdateAt: '2026-07-05T12:00:00.000Z',
        previousScheduledStoryIds: [],
        currentScheduledStoryIds: [storyIdentity(existingStory), storyIdentity(existingCryptoNote)].sort()
      },
      stories: [existingStory, newStory],
      crypto: { notes: [existingCryptoNote, newCryptoNote] }
    }),
    '</script>'
  ].join('');
  fs.writeFileSync(dashboardFile, dashboardHtml);

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--refresh-news-baseline',
    '--scheduled',
    '--morning',
    '--skip-validate'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);

  const parsed = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(parsed.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(parsed.stories[1].isNewSinceScheduledUpdate, true);
  assert.equal(parsed.crypto.notes[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(parsed.crypto.notes[1].isNewSinceScheduledUpdate, true);
  assert.deepEqual(parsed.newsBaseline.previousScheduledStoryIds, [storyIdentity(existingCryptoNote), storyIdentity(existingStory)].sort());
  assert.deepEqual(parsed.newsBaseline.currentScheduledStoryIds, [
    storyIdentity(existingCryptoNote),
    storyIdentity(existingStory),
    storyIdentity(newCryptoNote),
    storyIdentity(newStory)
  ].sort());
  assert.match(parsed.newsBaseline.lastScheduledWindow, /^\d{4}-\d{2}-\d{2}:morning$/);
}

function testApplyDashboardDataJsonCliMode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-dashboard-apply-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'dashboard-data.json');
  const dashboardHtml = [
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
    '<script type="application/json" id="dashboard-data">{"editionId":"old","masthead":{"date":"Monday, July 6, 2026"},"footer":{"compiled":"Compiled Monday, July 6, 2026 at 4:00 PM CDT"}}<\/script>',
    '<!-- ============ DATA END ============ -->',
    '<script type="application/json" id="chart-data">{"schemaVersion":1,"series":[]}</script>',
    '<div class="page" id="app"><div id="mast-edition">Loading</div><div class="right" id="mast-date">Loading</div><h1 id="hero-headline">Loading</h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>',
    '<script>(function () {})();</script>'
  ].join('\n');
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(payloadFile, JSON.stringify({
    editionId: 'manual-old',
    masthead: { date: 'Monday, July 6, 2026' },
    footer: { compiled: 'Compiled Monday, July 6, 2026 at 4:00 PM CDT' },
    tape: {
      rows: [{
        ticker: 'SPX',
        group: 'Equities',
        last: 'bad',
        delta: 'bad',
        pct: 'bad',
        dir: 'down',
        asOf: '1999-01-01'
      }]
    },
    price: '$4.54B'
  }));
  const chartData = {
    schemaVersion: 1,
    quoteRows: { tape: [{ ticker: 'SPX', last: 'bad' }], crypto: [] },
    series: [{
      ticker: 'SPX',
      section: 'tape',
      sourceSymbol: 'SPX',
      bars: [
        { time: '2026-07-03', open: 6000, high: 6000, low: 6000, close: 6000 },
        { time: '2026-07-06', open: 6120, high: 6125, low: 6110, close: 6123.45 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, [
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
    '<script type="application/json" id="dashboard-data">{"editionId":"old","masthead":{"date":"Monday, July 6, 2026"},"footer":{"compiled":"Compiled Monday, July 6, 2026 at 4:00 PM CDT"},"tape":{"rows":[{"ticker":"SPX","group":"Equities","last":"stale","delta":"stale","pct":"stale","dir":"flat","asOf":"old"}]}}<\/script>',
    '<!-- ============ DATA END ============ -->',
    `<script type="application/json" id="chart-data">${JSON.stringify(chartData)}<\/script>`,
    '<div class="page" id="app"><div id="mast-edition">Loading</div><div class="right" id="mast-date">Loading</div><h1 id="hero-headline">Loading</h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>',
    '<script>(function () {})();</script>'
  ].join('\n'));
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/run_daily_update.js'),
    '--dashboard', dashboardFile,
    '--apply-dashboard-data-json', payloadFile,
    '--skip-validate'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);

  const parsed = readJsonBlock(fs.readFileSync(dashboardFile, 'utf8'), 'dashboard-data');
  assert.equal(parsed.price, '$4.54B');
  assert.notEqual(parsed.editionId, 'manual-old');
  assert.equal(parsed.tape.rows[0].last, '6,123.45');
  assert.equal(parsed.tape.rows[0].asOf, '2026-07-06');
}

function testApplyChartDataJsonCliMode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-apply-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'chart-data.json');
  const shell = [
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
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
    '--skip-validate'
  ], { cwd: root, encoding: 'utf8' });
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-merge-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const payloadFile = path.join(dir, 'commodity-chart-data.json');
  const shell = [
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
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
    '--skip-validate'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const updatedHtml = fs.readFileSync(dashboardFile, 'utf8');
  const dashboard = readJsonBlock(updatedHtml, 'dashboard-data');
  const chart = readJsonBlock(updatedHtml, 'chart-data');
  assert.deepEqual(chart.series.map((series) => series.ticker), ['SPX', 'HG']);
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'SPX').last, '6,123.45');
  assert.equal(dashboard.tape.rows.find((row) => row.ticker === 'HG').last, '4.60');
}

function testDashboardHtmlShellContract() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const countMatches = (pattern) => [...html.matchAll(pattern)].length;
  const chartDataIndex = html.indexOf('<script type="application/json" id="chart-data">');
  const runtimeScriptIndex = html.indexOf('<script id="dashboard-runtime">');
  const markers = [
    '<div class="page" id="app">',
    '<div id="mast-edition">',
    '<div class="right" id="mast-date">',
    '<h1 id="hero-headline">',
    '<div id="hero-copy"></div>',
    '<main id="content"></main>',
    '<footer id="footer"></footer>'
  ];

  assert.equal(countMatches(/<script type="application\/json" id="dashboard-data">[\s\S]*?<\/script>/g), 1);
  assert.equal(countMatches(/<script type="application\/json" id="chart-data">[\s\S]*?<\/script>/g), 1);
  assert.equal(countMatches(/<script id="dashboard-runtime">[\s\S]*?<\/script>/g), 1);
  assert.notEqual(html.indexOf('<!-- ============ DATA START'), -1);
  assert.notEqual(html.indexOf('<!-- ============ DATA END ============ -->'), -1);
  assert.ok(chartDataIndex > html.indexOf('<!-- ============ DATA END ============ -->'));
  assert.ok(runtimeScriptIndex > chartDataIndex);

  let previousIndex = chartDataIndex;
  for (const marker of markers) {
    const index = html.indexOf(marker);
    assert.notEqual(index, -1, `Missing shell marker ${marker}`);
    assert.ok(index > previousIndex, `Shell marker out of order: ${marker}`);
    assert.ok(index < runtimeScriptIndex, `Shell marker moved into runtime script region: ${marker}`);
    previousIndex = index;
  }
}

function testDashboardValidatorRejectsRemoteRuntimeEndpoint() {
  const dir = fs.mkdtempSync(path.join(root, 'generated', 'dfd-runtime-url-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const { dashboard, chartData } = createDashboardValidationFixture();
  try {
    fs.writeFileSync(dashboardFile, renderDashboardValidationFixture(dashboard, chartData).replace(
      'https://192.168.2.2:2210/api/market-refresh',
      'https://query1.finance.yahoo.com/api/market-refresh'
    ));
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'validate_dashboard.js'),
      dashboardFile
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_NOW_ISO: FIXTURE_NOW }
    });
    assert.notEqual(result.status, 0, 'A remote dashboard runtime endpoint must fail validation.');
    assert.match(result.stderr, /Unexpected runtime URL: https:\/\/query1\.finance\.yahoo\.com\/api\/market-refresh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validateDashboardFixture(data, fixturePrefix) {
  const dir = fs.mkdtempSync(path.join(root, 'generated', fixturePrefix));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const { chartData } = createDashboardValidationFixture();
  try {
    fs.writeFileSync(dashboardFile, renderDashboardValidationFixture(data, chartData));
    return spawnSync(process.execPath, [
      path.join(root, 'scripts', 'validate_dashboard.js'),
      dashboardFile
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_NOW_ISO: FIXTURE_NOW }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validateChartDataFixture(chartData, fixturePrefix) {
  const dir = fs.mkdtempSync(path.join(root, 'generated', fixturePrefix));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  try {
    fs.writeFileSync(dashboardFile, replaceJsonBlock(html, 'chart-data', JSON.stringify(chartData)));
    return spawnSync(process.execPath, [
      path.join(root, 'scripts', 'validate_dashboard.js'),
      dashboardFile
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_NOW_ISO: '2026-07-10T13:30:00Z' }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validateDashboardAndChartFixture(data, chartData, fixturePrefix) {
  const dir = fs.mkdtempSync(path.join(root, 'generated', fixturePrefix));
  const dashboardFile = path.join(dir, 'dashboard.html');
  try {
    fs.writeFileSync(dashboardFile, renderDashboardValidationFixture(data, chartData));
    return spawnSync(process.execPath, [
      path.join(root, 'scripts', 'validate_dashboard.js'),
      dashboardFile
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_NOW_ISO: FIXTURE_NOW }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validationDashboardData() {
  // Contract mutations start from a fixed, self-contained payload; the live artifact has its own smoke test below.
  return createDashboardValidationFixture().dashboard;
}

function testDashboardValidatorRejectsOversizedFuturesStoryTag() {
  const data = validationDashboardData();
  data.futuresModule.stories[0].tag = 'An Editorial Tag That Is Too Long';
  const result = validateDashboardFixture(data, 'dfd-futures-tag-');
  assert.notEqual(result.status, 0, 'An oversized futures tag must fail validation.');
  assert.match(result.stderr, /tag must be 24 characters or fewer to preserve the shared story-label column/);
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

  const result = validateDashboardFixture(data, 'dfd-friday-bridge-');
  assert.equal(result.status, 0, result.stderr);
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
  const precisionResult = validateChartDataFixture(chartData, 'dfd-chart-precision-');
  assert.notEqual(precisionResult.status, 0, 'Embedded OHLC values must be capped at four decimals.');
  assert.match(precisionResult.stderr, /must use at most four decimal places/);

  chartData.series[0].bars[0] = { time: '2021-07-12', open: 1, high: 2, low: 1, close: 2 };
  const shapeResult = validateChartDataFixture(chartData, 'dfd-chart-tuple-');
  assert.notEqual(shapeResult.status, 0, 'Embedded chart bars must use the compact tuple encoding.');
  assert.match(shapeResult.stderr, /must be a \[time, open, high, low, close, volume\] tuple/);

  const noVolumeChart = readJsonBlock(html, 'chart-data');
  noVolumeChart.series.find((item) => item.ticker === 'VIX').noVolume = false;
  const noVolumeResult = validateChartDataFixture(noVolumeChart, 'dfd-chart-no-volume-');
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

  const result = validateDashboardAndChartFixture(data, chartData, 'dfd-dynamic-tape-roster-');
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorAcceptsCurrentEmbeddedDashboard() {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate_dashboard.js'),
    path.join(root, 'daily_financial_news.html')
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorRejectsFuturesStoryWithoutPublishedAt() {
  const data = validationDashboardData();
  delete data.futuresModule.stories[0].publishedAt;
  const result = validateDashboardFixture(data, 'dfd-futures-published-at-');
  assert.notEqual(result.status, 0, 'A futures story without publishedAt must fail validation.');
  assert.match(result.stderr, /publishedAt must be an offset-bearing ISO timestamp/);
}

function testDashboardValidatorRejectsDuplicateFuturesStoryUrl() {
  const data = validationDashboardData();
  data.futuresModule.stories[1].url = data.futuresModule.stories[0].url;
  const result = validateDashboardFixture(data, 'dfd-futures-duplicate-url-');
  assert.notEqual(result.status, 0, 'Duplicate Futures story links must fail validation.');
  assert.match(result.stderr, /futuresModule\.stories\[1\]\.url duplicates futuresModule\.stories\[0\]\.url/);
}

function testDashboardValidatorRejectsImpossibleFuturesDates() {
  const badReferenceDate = validationDashboardData();
  badReferenceDate.masthead.edition = 'Morning Edition';
  badReferenceDate.editionId = '2026-07-09T12:30:00Z';
  badReferenceDate.futuresModule.sectionLabel = 'Before The Open';
  badReferenceDate.futuresModule.sectionTitle = 'Pre-Market Futures';
  for (const future of badReferenceDate.futuresModule.futures) {
    future.raw.referenceDate = '2026-06-31';
    future.raw.referenceCloseEastern = '4:00 PM ET';
  }
  for (const story of badReferenceDate.futuresModule.stories) story.publishedAt = '2026-07-09T11:45:00Z';
  const referenceResult = validateDashboardFixture(badReferenceDate, 'dfd-futures-invalid-reference-date-');
  assert.notEqual(referenceResult.status, 0, 'Impossible prior-close dates must fail validation.');
  assert.match(referenceResult.stderr, /referenceDate must be an ISO date/);

  const badPublishedAt = validationDashboardData();
  badPublishedAt.futuresModule.stories[0].publishedAt = '2026-07-32T12:00:00Z';
  const publishedAtResult = validateDashboardFixture(badPublishedAt, 'dfd-futures-invalid-published-at-');
  assert.notEqual(publishedAtResult.status, 0, 'Impossible publication dates must fail validation.');
  assert.match(publishedAtResult.stderr, /publishedAt must be an offset-bearing ISO timestamp/);

  const badPublishedOn = validationDashboardData();
  badPublishedOn.stories[0].publishedOn = '2026-07-32';
  const publishedOnResult = validateDashboardFixture(badPublishedOn, 'dfd-invalid-published-on-');
  assert.notEqual(publishedOnResult.status, 0, 'Impossible story dates must fail validation.');
  assert.match(publishedOnResult.stderr, /publishedOn must be an ISO date/);
}

function testDashboardValidatorRejectsFuturesStoryOutsideActiveWindow() {
  const data = validationDashboardData();
  data.futuresModule.stories[0].publishedAt = '2026-07-09T19:59:59Z';
  const result = validateDashboardFixture(data, 'dfd-futures-window-');
  assert.notEqual(result.status, 0, 'A futures story published after the regular-session close must fail validation.');
  assert.match(result.stderr, /publishedAt must fall between the current U\.S\. regular-session open/);
}

function testDashboardValidatorAcceptsInWindowFuturesStories() {
  const result = validateDashboardFixture(validationDashboardData(), 'dfd-futures-in-window-');
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorRequiresMatchingFuturesEdition() {
  const morningMismatch = validationDashboardData();
  morningMismatch.masthead.edition = 'Afternoon Edition';
  morningMismatch.futuresModule.sectionLabel = 'Before The Open';
  morningMismatch.futuresModule.sectionTitle = 'Pre-Market Futures';
  const morningResult = validateDashboardFixture(morningMismatch, 'dfd-futures-edition-morning-');
  assert.notEqual(morningResult.status, 0, 'Afternoon masthead must not validate against Pre-Market Futures.');
  assert.match(morningResult.stderr, /masthead\.edition must be Morning Edition when futuresModule is Before The Open\/Pre-Market Futures/);
}

function testDashboardValidatorAcceptsMorningFuturesStoryWindow() {
  const data = validationDashboardData();
  data.masthead.edition = 'Morning Edition';
  data.editionId = '2026-07-10T12:30:00Z';
  data.futuresModule.sectionLabel = 'Before The Open';
  data.futuresModule.sectionTitle = 'Pre-Market Futures';
  for (const future of data.futuresModule.futures) {
    future.raw.referenceDate = '2026-07-09';
    future.raw.referenceCloseEastern = '4:00 PM ET';
  }
  for (const story of data.futuresModule.stories) {
    story.publishedOn = '2026-07-10';
    story.publishedAt = '2026-07-10T11:45:00Z';
  }
  const result = validateDashboardFixture(data, 'dfd-futures-morning-');
  assert.equal(result.status, 0, result.stderr);
}

function testDashboardValidatorRequiresSharedMorningFuturesReferenceDate() {
  const data = validationDashboardData();
  data.masthead.edition = 'Morning Edition';
  data.editionId = '2026-07-10T12:30:00Z';
  data.futuresModule.sectionLabel = 'Before The Open';
  data.futuresModule.sectionTitle = 'Pre-Market Futures';
  for (const future of data.futuresModule.futures) {
    delete future.raw.referenceDate;
    delete future.raw.referenceCloseEastern;
  }
  const result = validateDashboardFixture(data, 'dfd-futures-morning-reference-');
  assert.notEqual(result.status, 0, 'Morning stories must use the fetched prior-close date rather than a guessed weekday.');
  assert.match(result.stderr, /Pre-Market Futures rows must share one valid raw\.referenceDate/);
}

function testMorningFuturesWindowUsesFetchedReferenceDateAcrossHoliday() {
  const sources = [
    'zonedDateParts',
    'zonedDateTime',
    'sharedFuturesReferenceDate',
    'sharedFuturesSessionDate',
    'futuresStoryPublicationWindow'
  ].map((name) => extractScriptFunction('scripts/validate_dashboard.js', name)).join('\n');
  const { futuresStoryPublicationWindow } = Function(
    'isIsoDate',
    'isIsoDateTime',
    `${sources}\nreturn { futuresStoryPublicationWindow };`
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
  const result = validateDashboardFixture(data, 'dfd-reference-page-');
  assert.notEqual(result.status, 0, 'News sections must not accept evergreen-page exceptions.');
  assert.match(result.stderr, /futuresModule\.stories\[0\]\.referencePage is not supported/);
  assert.match(result.stderr, /Story .*\.referencePage is not supported/);
  assert.match(result.stderr, /Crypto note .*\.referencePage is not supported/);
}

function testDashboardValidatorRequiresCryptoNoteDisplayFields() {
  for (const field of ['kicker', 'title', 'body']) {
    const data = validationDashboardData();
    delete data.crypto.notes[0][field];
    const result = validateDashboardFixture(data, `dfd-crypto-note-${field}-`);
    assert.notEqual(result.status, 0, `Crypto notes must require ${field}.`);
    assert.match(result.stderr, new RegExp(`Crypto note ${field} must be populated`));
  }
}

function testScheduledPreflightEnforcesWindowAndDuplicateMarker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-scheduled-preflight-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const baseline = {
    lastScheduledUpdateAt: '2026-07-08T21:00:00.000Z',
    lastScheduledWindow: '2026-07-08:afternoon',
    previousScheduledStoryIds: [],
    currentScheduledStoryIds: []
  };
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
  try {
    assert.equal(
      validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T12:00:00.000Z')),
      '2026-07-09:morning'
    );
    assert.throws(
      () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T14:00:00.000Z')),
      /outside its America\/Chicago update window/
    );
    assert.throws(
      () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-11T12:00:00.000Z')),
      /only permits weekday runs/
    );
    baseline.lastScheduledWindow = '2026-07-09:morning';
    fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
    assert.throws(
      () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T12:00:00.000Z')),
      /already completed/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDashboardEarningsMoneySignContract() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const sources = [
    'formatEarningsCurrency',
    'formatEarningsEps',
    'formatEarningsRevenue'
  ].map((name) => extractDashboardRuntimeFunction(html, name)).join('\n');
  const { formatEarningsEps, formatEarningsRevenue } = Function(`${sources}\nreturn { formatEarningsEps, formatEarningsRevenue };`)();

  assert.equal(formatEarningsEps(-0.73), '-$0.73');
  assert.equal(formatEarningsEps(0.73), '$0.73');
  assert.equal(formatEarningsRevenue(-16500000), '-$16.5M');
  assert.equal(formatEarningsRevenue(16500000), '$16.5M');
}

function testYieldCurveShortEndTenorsStayVisible() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');

  assert.match(html, /\['1M', yieldCurveValueLabel\(byLabel\.get\('1M'\)\?\.value\)\]/);
  assert.match(html, /\['6M', yieldCurveValueLabel\(byLabel\.get\('6M'\)\?\.value\)\]/);
  assert.match(html, /const keyLabels = new Set\(\['1M', '6M', '2Y', '10Y', '30Y'\]\);/);
}

function testEditionStampChangesIdentity() {
  const data = dashboardFixture();
  const stamped = stampDashboardEdition(data);

  assert.notEqual(stamped.editionId, data.editionId);
  assert.ok(!Number.isNaN(Date.parse(stamped.editionId)));
}

function testLocalRefreshIndicatorBehavior() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const sources = [
    'localRefreshIndicatorHtml',
    'setLocalRefreshIndicator'
  ].map((name) => extractDashboardRuntimeFunction(html, name)).join('\n');
  const runtime = Function(`
    let localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
    let rendered = '';
    let indicatorAvailable = true;
    const selectors = [];
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
        return indicatorAvailable ? {
          set outerHTML(value) { rendered = value; }
        } : null;
      }
    };
    ${sources}
    return {
      setLocalRefreshIndicator,
      rendered: () => rendered,
      selectors: () => selectors,
      hideIndicator: () => { indicatorAvailable = false; }
    };
  `)();
  const states = [
    ['checking', 'Checking local refresh'],
    ['live', 'Local refresh 12:34 PM CDT\n44 ticker series'],
    ['cached', 'Cached local data'],
    ['idle', 'Local helper reached; no newer prices'],
    ['error', 'Local refresh unavailable or blocked']
  ];

  for (const [state, message] of states) {
    runtime.setLocalRefreshIndicator(state, message);
    const markup = runtime.rendered();
    assert.match(markup, new RegExp(`data-local-refresh-state="${state}"`));
    assert.match(markup, /role="img"/);
    assert.match(markup, /tabindex="0"/);
    assert.match(markup, /class="local-refresh-indicator-dot" aria-hidden="true"/);
    assert.match(markup, /class="local-refresh-tooltip" role="tooltip"/);
    assert.match(markup, new RegExp(`aria-label="${message.replace('\n', '\\n')}"`));
    assert.doesNotMatch(markup, /\btitle=/);
  }

  runtime.setLocalRefreshIndicator('error', '<Local & "safe">');
  assert.match(runtime.rendered(), /aria-label="&lt;Local &amp; &quot;safe&quot;&gt;"/);
  assert.match(runtime.rendered(), /<span class="local-refresh-tooltip" role="tooltip">&lt;Local &amp; &quot;safe&quot;&gt;<\/span>/);
  assert.deepEqual(runtime.selectors(), Array.from({ length: states.length + 1 }, () => '[data-local-refresh-indicator]'));

  runtime.hideIndicator();
  assert.doesNotThrow(() => runtime.setLocalRefreshIndicator('idle', 'Local helper reached; no newer prices'));
}

async function testLocalRefreshIndicatorLifecycle() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const sources = [
    'localRefreshStatusText',
    'localRefreshTickerCount',
    'tryLocalMarketRefresh'
  ].map((name) => extractDashboardRuntimeFunction(html, name)).join('\n');
  const runtime = Function(`
    let fetch;
    class AbortController { constructor() { this.signal = {}; } abort() {} }
    const LOCAL_MARKET_REFRESH_URLS = ['https://192.168.2.2:2210/api/market-refresh'];
    const LOCAL_MARKET_REFRESH_TIMEOUT_MS = 100;
    const window = { setTimeout: () => 1, clearTimeout: () => {} };
    const states = [];
    const writes = [];
    const renders = [];
    let localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
    let applyResult = false;
    const setLocalRefreshIndicator = (state, message) => {
      localRefreshIndicator = { state, message };
      states.push({ state, message });
    };
    const applyLocalMarketRefresh = () => applyResult;
    const writeCachedLocalMarketRefresh = (_data, payload) => writes.push(payload);
    const render = (data) => renders.push(data);
    ${sources}
    return {
      async run({ fetchImpl, changed }) {
        fetch = fetchImpl;
        applyResult = changed;
        states.length = 0;
        writes.length = 0;
        renders.length = 0;
        localRefreshIndicator = { state: 'checking', message: 'Checking local refresh' };
        await tryLocalMarketRefresh({ editionId: 'fixture' });
        return { states: [...states], writes: [...writes], renders: [...renders] };
      }
    };
  `)();

  const unavailable = await runtime.run({ fetchImpl: undefined, changed: false });
  assert.deepEqual(unavailable.states, [{ state: 'error', message: 'Local refresh unavailable in this browser' }]);

  const payload = {
    generatedAt: '2026-07-10T18:34:00.000Z',
    series: [{ ticker: 'SPX' }, { ticker: 'VIX' }, { ticker: 'SPX' }]
  };
  let refreshRequest;
  const refreshed = await runtime.run({
    fetchImpl: async (url, options) => {
      refreshRequest = { url, options };
      return { ok: true, status: 200, json: async () => payload };
    },
    changed: true
  });
  assert.deepEqual(refreshed.states.map((entry) => entry.state), ['checking', 'live']);
  assert.match(refreshed.states[1].message, /^Local refresh .+\n2 ticker series$/);
  assert.deepEqual(refreshed.writes, [payload]);
  assert.equal(refreshed.renders.length, 1);
  assert.equal(refreshRequest.url, 'https://192.168.2.2:2210/api/market-refresh');
  assert.equal(refreshRequest.options.cache, 'no-store');
  assert.equal(refreshRequest.options.targetAddressSpace, 'local');

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
}

function testLocalRefreshKeepsNewerEmbeddedSeriesProvenance() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const sources = [
    'mergeBars',
    'latestSeriesBarDate',
    'mergeSeriesMap'
  ].map((name) => extractDashboardRuntimeFunction(html, name)).join('\n');
  const { mergeSeriesMap } = Function(`
    ${sources}
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

  assert.equal(mergeSeriesMap(seriesMap, [{
    ticker: 'UNKNOWN',
    bars: [
      { time: '2026-07-06', open: 1, high: 1, low: 1, close: 1 },
      { time: '2026-07-07', open: 2, high: 2, low: 2, close: 2 }
    ]
  }]), false);
  assert.equal(seriesMap.has('UNKNOWN'), false);
}

function testValidateChartDataRejectsQuoteRowsAheadOfSeries() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-validate-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const chartFile = path.join(dir, 'chart_data.json');
  const dashboardHtml = `<script type="application/json" id="dashboard-data">${JSON.stringify({
    tape: {
      rows: [{
        group: 'Materials',
        name: 'Materials',
        ticker: 'VAW',
        last: '231.59',
        delta: '-1.05',
        pct: '-0.45%',
        dir: 'down',
        note: 'Fixture note',
        sourceSymbol: 'VAW',
        asOf: '2026-07-06'
      }]
    }
  })}</script>`;
  const chartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-06T20:00:00.000Z',
    range: {
      days: 1826,
      startDate: '2021-07-06',
      endDate: '2026-07-06'
    },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: {
      tape: [{
        name: 'Materials',
        ticker: 'VAW',
        last: '231.59',
        delta: '-1.05',
        pct: '-0.45%',
        dir: 'down',
        note: 'Fixture note',
        sourceSymbol: 'VAW',
        asOf: '2026-07-06'
      }],
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
        { time: '2026-07-01', open: 227.81, high: 231.15, low: 227.25, close: 228.58, volume: 115000 },
        { time: '2026-07-02', open: 230.58, high: 232.64, low: 230.30, close: 232.64, volume: 60800 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(chartFile, JSON.stringify(chartData));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/validate_chart_data.js'),
    '--dashboard', dashboardFile,
    '--chart-data', chartFile
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, 'stale quoteRows vs series mismatch should fail validate_chart_data');
  assert.match(result.stderr, /must match the latest generated series bar-derived value/);
}

function testStrictCalendarDatesReachChartAndAssetValidation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-strict-calendar-date-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const chartFile = path.join(dir, 'chart_data.json');
  const dashboardHtml = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const chartData = readJsonBlock(dashboardHtml, 'chart-data');
  chartData.series[0].bars[0].time = '2026-02-30';
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(chartFile, JSON.stringify(chartData));

  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'validate_chart_data.js'),
      '--dashboard', dashboardFile,
      '--chart-data', chartFile
    ], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, 'Chart validation must reject impossible ISO-looking bar dates.');
    assert.match(result.stderr, /bars\[0\]\.time must be an ISO date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.throws(
    () => normalizedSummary({
      asOf: '2026-02-30',
      status: 'available',
      portfolioMtdReturnValue: 1.25
    }, false, ''),
    /summary asOf must be YYYY-MM-DD/
  );
}

function testValidateChartDataRejectsLatestOhlcPlaceholder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-placeholder-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const chartFile = path.join(dir, 'chart_data.json');
  const dashboardHtml = `<script type="application/json" id="dashboard-data">${JSON.stringify({
    tape: {
      rows: [{
        group: 'Materials',
        name: 'Materials',
        ticker: 'VAW',
        last: '231.59',
        delta: '-1.05',
        pct: '-0.45%',
        dir: 'down',
        note: 'Fixture note',
        sourceSymbol: 'VAW',
        asOf: '2026-07-06'
      }]
    }
  })}</script>`;
  const chartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-06T20:00:00.000Z',
    range: {
      days: 1826,
      startDate: '2021-07-06',
      endDate: '2026-07-06'
    },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: {
      tape: [{
        name: 'Materials',
        ticker: 'VAW',
        last: '231.59',
        delta: '-1.05',
        pct: '-0.45%',
        dir: 'down',
        note: 'Fixture note',
        sourceSymbol: 'VAW',
        asOf: '2026-07-06'
      }],
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
        { time: '2026-07-06', open: 231.59, high: 231.59, low: 231.59, close: 231.59 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(chartFile, JSON.stringify(chartData));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/validate_chart_data.js'),
    '--dashboard', dashboardFile,
    '--chart-data', chartFile
  ], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'latest quote-only placeholder should fail validate_chart_data for OHLC series');
  assert.match(result.stderr, /do not publish a latest quote-only placeholder in an OHLC series/);

  delete chartData.series[0].bars[0].volume;
  fs.writeFileSync(chartFile, JSON.stringify(chartData));
  const noVolumeResult = spawnSync(process.execPath, [
    path.join(root, 'scripts/validate_chart_data.js'),
    '--dashboard', dashboardFile,
    '--chart-data', chartFile
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notEqual(noVolumeResult.status, 0, 'A generated chart without volume bars must declare noVolume.');
  assert.match(noVolumeResult.stderr, /VAW\.noVolume must be true to match its generated volume bars/);
}

function testValidateChartDataRejectsStaleSourceFamilies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-sources-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const chartFile = path.join(dir, 'chart_data.json');
  const dashboardHtml = `<script type="application/json" id="dashboard-data">${JSON.stringify({
    tape: {
      rows: [{
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
      }]
    }
  })}</script>`;
  const chartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-06T20:00:00.000Z',
    range: {
      days: 1826,
      startDate: '2021-07-06',
      endDate: '2026-07-06'
    },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: {
      tape: [{
        name: 'Materials',
        ticker: 'VAW',
        last: '232.06',
        delta: '-0.58',
        pct: '-0.25%',
        dir: 'down',
        note: 'Fixture note',
        sourceSymbol: 'VAW',
        asOf: '2026-07-06'
      }],
      crypto: []
    },
    series: [{
      ticker: 'VAW',
      name: 'Materials',
      section: 'tape',
      sourceSymbol: 'VAW',
      note: 'Fixture note',
      source: 'Yahoo Finance Chart API + Finnhub Quote API',
      dataKind: 'ohlc',
      priceOnly: false,
      noVolume: false,
      bars: [
        { time: '2026-07-02', open: 230.58, high: 232.64, low: 230.30, close: 232.64, volume: 60800 },
        { time: '2026-07-06', open: 232.3, high: 232.3, low: 229.59, close: 232.06, volume: 50110 }
      ]
    }]
  };
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(chartFile, JSON.stringify(chartData));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/validate_chart_data.js'),
    '--dashboard', dashboardFile,
    '--chart-data', chartFile
  ], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'stale sourceFamilies should fail validate_chart_data');
  assert.match(result.stderr, /sourceFamilies must include Yahoo Finance Chart API \+ Finnhub Quote API/);
}

function testValidateChartDataRejectsDuplicateYieldCurveComparisons() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-chart-yield-curve-'));
  const dashboardFile = path.join(dir, 'dashboard.html');
  const chartFile = path.join(dir, 'chart_data.json');
  const dashboardRow = {
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
  const duplicateComparisonPoints = [
    { label: '1M', years: 1 / 12, value: 3.71 },
    { label: '2Y', years: 2, value: 4.17 },
    { label: '10Y', years: 10, value: 4.55 },
    { label: '30Y', years: 30, value: 5.01 }
  ];
  const dashboardHtml = `<script type="application/json" id="dashboard-data">${JSON.stringify({
    tape: { rows: [dashboardRow] }
  })}</script>`;
  const chartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-06T20:00:00.000Z',
    range: {
      days: 1826,
      startDate: '2021-07-06',
      endDate: '2026-07-06'
    },
    sourceFamilies: ['Treasury.gov Daily Treasury Yield Curve Rate Data'],
    quoteRows: {
      tape: [dashboardRow],
      crypto: []
    },
    series: [{
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
        points: duplicateComparisonPoints
      }, {
        label: '6M ago',
        date: '2026-06-05',
        points: duplicateComparisonPoints
      }],
      curveSpread: {
        label: '2s10s',
        valueBp: 35,
        previousValueBp: 34,
        deltaBp: 1,
        comparison: '1D'
      }
    }]
  };
  fs.writeFileSync(dashboardFile, dashboardHtml);
  fs.writeFileSync(chartFile, JSON.stringify(chartData));

  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/validate_chart_data.js'),
    '--dashboard', dashboardFile,
    '--chart-data', chartFile
  ], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0, 'duplicate Yield Curve comparison curves should fail validate_chart_data');
  assert.match(result.stderr, /comparisonCurves\[1\]\.date must be distinct from 1M ago/);
  assert.match(result.stderr, /comparisonCurves\[1\]\.points must be distinct from 1M ago/);
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
  const duplicateResult = validateChartDataFixture(duplicateComparison, 'dfd-embedded-yield-curve-duplicate-');
  assert.notEqual(duplicateResult.status, 0, 'Duplicate embedded Yield Curve comparison curves must fail dashboard validation.');
  assert.match(duplicateResult.stderr, /comparisonCurves\[1\]\.date must be distinct from 1M ago/);
  assert.match(duplicateResult.stderr, /comparisonCurves\[1\]\.points must be distinct from 1M ago/);

  const staleComparison = structuredClone(chartData);
  const staleCurve = staleComparison.series.find((series) => series.sourceSymbol === 'TREASURY:CURVE');
  staleCurve.comparisonCurves[0].date = staleCurve.curveDate;
  const staleResult = validateChartDataFixture(staleComparison, 'dfd-embedded-yield-curve-stale-');
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
    const result = validateChartDataFixture(invalidPayload, `dfd-embedded-chart-${field.replace('.', '-')}-`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-market-server-yield-curve-'));
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-market-server-empty-'));
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
}

async function testLocalMarketServerHttpsBoundary() {
  // Exercise the real HTTPS handler and response boundary; certificate-chain trust is verified separately by the installed helper checks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-market-server-tls-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const certificateResult = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key,
    '-out', cert,
    '-days', '1',
    '-subj', '/CN=127.0.0.1'
  ], { encoding: 'utf8' });
  assert.equal(certificateResult.status, 0, certificateResult.stderr || 'Could not create the test TLS certificate.');

  const args = parseLocalMarketServerArgs([
    '--host', '127.0.0.1',
    '--cert', cert,
    '--key', key
  ]);
  const server = createLocalMarketServer(args);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    const health = await requestLocalHttps(port);
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    assert.equal(JSON.parse(health.body).host, '127.0.0.1');
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.headers['x-content-type-options'], 'nosniff');

    const allowed = await requestLocalHttps(port, {
      headers: { Origin: 'https://sdupuie.github.io' }
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://sdupuie.github.io');
    assert.equal(allowed.headers.vary, 'Origin');

    const denied = await requestLocalHttps(port, {
      headers: { Origin: 'https://example.com' }
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).ok, false);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);

    const preflight = await requestLocalHttps(port, {
      path: '/api/market-refresh',
      method: 'OPTIONS',
      headers: {
        Origin: 'https://sdupuie.github.io',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://sdupuie.github.io');
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

    const unsupportedMethod = await requestLocalHttps(port, { method: 'POST' });
    assert.equal(unsupportedMethod.statusCode, 405);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function main() {
  testUpdaterQuoteAndCryptoPatches();
  testUpdaterModulePatches();
  testUpdaterWeekAheadPreservesEditorialLens();
  testCalendarRolloverRange();
  testWeekAheadRolloverCommitsBeforeEarnings();
  testWeekAheadRendererConvertsMarketTime();
  testWeekAheadRendererGroupsReleaseFamilies();
  testNewEarningsNarrativeRowsStageAndRequireEditorialCompletion();
  testChartSeriesOwnsDerivedQuoteViews();
  testFinnhubQuoteBarMergesIntoOhlcSeries();
  testFinnhubQuoteFallbackOnlyWhenYahooLatestIsUnusable();
  testJsonBlockPatchKeepsDollarLiterals();
  testPatchDashboardDataBlockKeepsShellAndStampsEdition();
  testScheduledNewsBaselineMarkers();
  testRefreshNewsBaselineCliMode();
  testApplyDashboardDataJsonCliMode();
  testApplyChartDataJsonCliMode();
  testChartFetcherTickerFilterAndMergeChartDataCliMode();
  testDashboardHtmlShellContract();
  testDashboardValidatorRejectsRemoteRuntimeEndpoint();
  testDashboardValidatorAcceptsFridayBridgeCalendars();
  testCompactChartPayloadUsesFourDecimalTuples();
  testDashboardValidatorRejectsNonTupleOrOverPreciseEmbeddedBars();
  testDashboardValidatorUsesTheTapeAsItsChartRoster();
  testDashboardValidatorAcceptsCurrentEmbeddedDashboard();
  testDashboardValidatorRejectsOversizedFuturesStoryTag();
  testDashboardValidatorRejectsFuturesStoryWithoutPublishedAt();
  testDashboardValidatorRejectsDuplicateFuturesStoryUrl();
  testDashboardValidatorRejectsImpossibleFuturesDates();
  testDashboardValidatorRejectsFuturesStoryOutsideActiveWindow();
  testDashboardValidatorAcceptsInWindowFuturesStories();
  testDashboardValidatorRequiresMatchingFuturesEdition();
  testDashboardValidatorAcceptsMorningFuturesStoryWindow();
  testDashboardValidatorRequiresSharedMorningFuturesReferenceDate();
  testMorningFuturesWindowUsesFetchedReferenceDateAcrossHoliday();
  testDashboardValidatorRejectsReferencePagesInAllNewsSections();
  testDashboardValidatorRequiresCryptoNoteDisplayFields();
  testScheduledPreflightEnforcesWindowAndDuplicateMarker();
  testDashboardEarningsMoneySignContract();
  testYieldCurveShortEndTenorsStayVisible();
  testEditionStampChangesIdentity();
  testLocalRefreshIndicatorBehavior();
  await testLocalRefreshIndicatorLifecycle();
  testLocalRefreshKeepsNewerEmbeddedSeriesProvenance();
  testStrictCalendarDatesReachChartAndAssetValidation();
  testValidateChartDataRejectsQuoteRowsAheadOfSeries();
  testValidateChartDataRejectsLatestOhlcPlaceholder();
  testValidateChartDataRejectsStaleSourceFamilies();
  testValidateChartDataRejectsDuplicateYieldCurveComparisons();
  testDashboardValidatorRejectsInvalidYieldCurveComparisons();
  testChartPayloadMetadataContract();
  testSharedChartPayloadContractAcrossEncodings();
  testDashboardValidatorRejectsInvalidChartPayloadMetadata();
  testLocalMarketServerAutoRefreshWindow();
  testLocalMarketServerSkipsYieldCurveRefresh();
  testLocalMarketServerExplicitAndFallbackWindows();
  testLocalMarketServerPartialStatusIncludesRowErrors();
  testLocalMarketServerOriginPolicyAndTlsOptions();
  await testLocalMarketServerHttpsBoundary();
  console.log('Dashboard fixture tests passed.');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
