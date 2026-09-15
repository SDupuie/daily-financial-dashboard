#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chartData = require('./fetch_chart_data');
const cryptoStats = require('./fetch_crypto_stats');
const {
  buildChartDataFallback,
  buildUnavailableChartData,
  compactChartPayload,
  fetchFuture,
  futuresContractCandidates,
  priorFuturesContracts,
  quoteRowFromSeries,
  resolveFuturesContract,
  roundChartPayload,
  validateChartStagingPayload,
  validateFuturesPayload
} = chartData;
const {
  buildAssetAllocationFallback,
  buildAssetAllocationSummaryFallback,
  validateAssetAllocationPortfolioPayload,
  validateAssetAllocationSummaryPayload
} = require('./fetch_asset_allocation');
const {
  buildMarketRefresh,
  isAllowedBrowserOrigin,
  latestEmbeddedChartDate,
  localRefreshChartRows,
  parseArgs: parseLocalMarketServerArgs,
  refreshWindow,
  shouldRefreshChartRow
} = require('./local_market_server');

const temporaryDirectories = new Set();

function makeTemporaryDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(dir);
  return dir;
}

function cleanupTemporaryDirectories() {
  for (const dir of [...temporaryDirectories].reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}

function chartSeries(overrides = {}) {
  return {
    ticker: 'SPX',
    name: 'S&P 500',
    section: 'tape',
    sourceSymbol: '^GSPC',
    quoteRevision: '2026-07-10T21:00:00.000Z',
    source: 'Yahoo Finance Chart API',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: false,
    bars: [
      { time: '2026-07-09', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: '2026-07-10', open: 100, high: 102, low: 99, close: 101, volume: 1100 }
    ],
    ...overrides
  };
}

function futuresChartPayload(symbol, exchangeName, bars, overrides = {}) {
  const last = bars.at(-1);
  return {
    chart: {
      result: [{
        meta: {
          symbol,
          instrumentType: 'FUTURE',
          exchangeName,
          chartPreviousClose: overrides.previousClose ?? bars[0].close,
          regularMarketPrice: overrides.price ?? last.close,
          regularMarketTime: overrides.time ?? last.timestamp
        },
        timestamp: bars.map((bar) => bar.timestamp),
        indicators: {
          quote: [{
            open: bars.map((bar) => bar.open),
            high: bars.map((bar) => bar.high),
            low: bars.map((bar) => bar.low),
            close: bars.map((bar) => bar.close),
            volume: bars.map((bar) => bar.volume ?? 1)
          }]
        }
      }],
      error: null
    }
  };
}

function futuresBars(startIso, prices) {
  const start = Date.parse(startIso) / 1000;
  return prices.map((close, index) => ({
    timestamp: start + index * 300,
    open: close - 0.25,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100 + index
  }));
}

async function testFuturesContractResolutionAndFallback() {
  const spec = {
    symbol: 'ES=F',
    contractRoot: 'ES',
    contractExchange: 'CME',
    label: 'S&P Futures'
  };
  assert.deepEqual(futuresContractCandidates(spec, new Date('2026-01-15T18:00:00Z')), ['ESH26.CME', 'ESM26.CME']);
  assert.deepEqual(futuresContractCandidates(spec, new Date('2026-09-30T18:00:00Z')), ['ESU26.CME', 'ESZ26.CME']);
  assert.deepEqual(futuresContractCandidates(spec, new Date('2026-10-01T18:00:00Z')), ['ESZ26.CME', 'ESH27.CME']);

  const priorOld = futuresBars('2026-07-09T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 112 + index));
  const currentOld = futuresBars('2026-07-10T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 102 + index));
  const priorNext = futuresBars('2026-07-09T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 212 + index));
  const currentNext = futuresBars('2026-07-10T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 202 + index));
  const oldPayload = futuresChartPayload('ESU26.CME', 'CME', [...priorOld, ...currentOld]);
  const nextPayload = futuresChartPayload('ESZ26.CME', 'CME', [...priorNext, ...currentNext]);
  const mixedBars = [
    ...priorOld,
    ...currentOld.slice(0, 11),
    { ...currentOld[11], open: 150, high: 151, low: 149, close: 150 },
    currentNext[12]
  ];
  const mixedAlias = futuresChartPayload('ES=F', 'CME', mixedBars);
  const runAt = new Date('2026-07-10T14:36:00Z');
  const payloads = new Map([
    ['ESU26.CME', oldPayload],
    ['ESZ26.CME', nextPayload]
  ]);
  assert.equal(resolveFuturesContract(mixedAlias, payloads, runAt), '', 'A mixed roll tail must not guess a contract.');

  const responses = new Map([
    ['ES=F|5d', mixedAlias],
    ['ESU26.CME|5d', oldPayload],
    ['ESZ26.CME|5d', nextPayload]
  ]);
  const previousRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(previousRow.raw.contractSymbol, 'ESU26.CME');
  assert.equal(previousRow.raw.price, currentOld.at(-1).close, 'The fallback must use fresh explicit-contract prices.');
  assert.equal(previousRow.raw.referencePrice, priorOld.at(-1).close);

  const malformedAlias = structuredClone(mixedAlias);
  malformedAlias.chart.result[0].timestamp = {};
  responses.set('ES=F|5d', malformedAlias);
  const malformedAliasRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(malformedAliasRow.raw.contractSymbol, 'ESU26.CME', 'Malformed alias bars must use the eligible prior identity.');

  responses.delete('ES=F|5d');
  const aliasFailureRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(aliasFailureRow.raw.contractSymbol, 'ESU26.CME');
  assert.equal(aliasFailureRow.raw.price, currentOld.at(-1).close, 'Alias failure must retain identity while using fresh contract data.');
  const rolledAliasFailureRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESZ26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(rolledAliasFailureRow.raw.contractSymbol, 'ESZ26.CME', 'Alias failure must preserve a previously confirmed next contract.');

  const nextAlias = futuresChartPayload('ES=F', 'CME', [...priorOld, ...currentNext]);
  responses.set('ES=F|5d', nextAlias);
  const matchedRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(matchedRow.raw.contractSymbol, 'ESZ26.CME');
  assert.equal(matchedRow.raw.price, currentNext.at(-1).close);

  const malformedOldPayload = structuredClone(oldPayload);
  malformedOldPayload.chart.result[0].timestamp = {};
  responses.set('ESU26.CME|5d', malformedOldPayload);
  const isolatedCandidateRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, runAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(isolatedCandidateRow.raw.contractSymbol, 'ESZ26.CME', 'One malformed candidate must not discard the valid match.');

  const overnightNext = futuresBars('2026-07-10T07:35:00Z', [301, 302, 303]);
  const overnightOld = futuresBars('2026-07-10T07:35:00Z', [201, 202, 203]);
  assert.equal(resolveFuturesContract(
    futuresChartPayload('ES=F', 'CME', overnightNext),
    new Map([
      ['ESU26.CME', futuresChartPayload('ESU26.CME', 'CME', overnightOld)],
      ['ESZ26.CME', futuresChartPayload('ESZ26.CME', 'CME', overnightNext)]
    ]),
    new Date('2026-07-10T07:55:00Z')
  ), 'ESZ26.CME', 'Overnight bars must resolve without regular-session assumptions.');

  const futuresRows = [
    ['ES=F', 'ESU26.CME', 'CME'],
    ['NQ=F', 'NQU26.CME', 'CME'],
    ['YM=F', 'YMU26.CBT', 'CBT'],
    ['RTY=F', 'RTYU26.CME', 'CME']
  ].map(([symbol, contractSymbol, exchangeName], index) => ({
    ...previousRow,
    symbol,
    label: `Fixture future ${index + 1}`,
    raw: { ...previousRow.raw, contractSymbol, exchangeName }
  }));
  const staging = {
    compiledAt: runAt.toISOString(),
    source: 'Yahoo Finance Chart API',
    mode: 'session',
    futures: futuresRows
  };
  assert.deepEqual(validateFuturesPayload(staging, { expectedMode: 'session' }), []);
  const missingContract = structuredClone(staging);
  delete missingContract.futures[0].raw.contractSymbol;
  assert.match(validateFuturesPayload(missingContract).join('\n'), /contractSymbol/);
}

async function testStaleFuturesContractCannotRetainPriority() {
  const spec = {
    symbol: 'ES=F',
    contractRoot: 'ES',
    contractExchange: 'CME',
    label: 'S&P Futures'
  };
  const stalePrior = futuresBars('2026-09-16T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 90 + index));
  const staleCurrent = futuresBars('2026-09-17T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 100 + index));
  const freshPrior = futuresBars('2026-09-24T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 190 + index));
  const freshCurrent = futuresBars('2026-09-25T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 200 + index));
  const sessionRunAt = new Date('2026-09-25T21:00:00Z');
  const responses = new Map([
    ['ESU26.CME|5d', futuresChartPayload('ESU26.CME', 'CME', [...stalePrior, ...staleCurrent])],
    ['ESZ26.CME|5d', futuresChartPayload('ESZ26.CME', 'CME', [...freshPrior, ...freshCurrent])]
  ]);
  const sessionRow = await fetchFuture(spec, { mode: 'session', delayMs: 0 }, sessionRunAt, 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(sessionRow.raw.contractSymbol, 'ESZ26.CME');
  assert.equal(sessionRow.raw.sessionDate, '2026-09-25');

  const stalePremarket = futuresBars('2026-09-17T10:00:00Z', Array.from({ length: 13 }, (_value, index) => 110 + index));
  const freshPremarket = futuresBars('2026-09-25T10:00:00Z', Array.from({ length: 13 }, (_value, index) => 210 + index));
  responses.set('ESU26.CME|1d', futuresChartPayload('ESU26.CME', 'CME', stalePremarket));
  responses.set('ESZ26.CME|1d', futuresChartPayload('ESZ26.CME', 'CME', freshPremarket, { previousClose: freshPrior.at(-1).close }));
  const premarketRow = await fetchFuture(spec, { mode: 'premarket', delayMs: 0 }, new Date('2026-09-25T12:30:00Z'), 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => responses.get(`${symbol}|${range}`)
  });
  assert.equal(premarketRow.raw.contractSymbol, 'ESZ26.CME');
  assert.equal(new Date(premarketRow.raw.regularMarketTime * 1000).toISOString().slice(0, 10), '2026-09-25');
}

async function testPremarketFuturesUsesOneExplicitContract() {
  const spec = {
    symbol: 'ES=F',
    contractRoot: 'ES',
    contractExchange: 'CME',
    label: 'S&P Futures'
  };
  const oldBars = futuresBars('2026-07-10T10:00:00Z', Array.from({ length: 13 }, (_value, index) => 100 + index));
  const nextBars = futuresBars('2026-07-10T10:00:00Z', Array.from({ length: 13 }, (_value, index) => 200 + index));
  const priorNext = futuresBars('2026-07-09T13:30:00Z', Array.from({ length: 13 }, (_value, index) => 205 + index));
  const responses = new Map([
    ['ES=F|1d', futuresChartPayload('ES=F', 'CME', nextBars)],
    ['ESU26.CME|1d', futuresChartPayload('ESU26.CME', 'CME', oldBars)],
    ['ESZ26.CME|1d', futuresChartPayload('ESZ26.CME', 'CME', nextBars, { previousClose: priorNext.at(-1).close })],
    ['ESZ26.CME|5d', futuresChartPayload('ESZ26.CME', 'CME', [...priorNext, ...nextBars], { previousClose: priorNext.at(-1).close })]
  ]);
  const requests = [];
  const row = await fetchFuture(spec, { mode: 'premarket', delayMs: 0 }, new Date('2026-07-10T12:30:00Z'), 'ESU26.CME', {
    fetchFuturesPayload: async (symbol, range) => {
      requests.push(`${symbol}|${range}`);
      return responses.get(`${symbol}|${range}`);
    }
  });
  assert.equal(row.raw.contractSymbol, 'ESZ26.CME');
  assert.equal(row.raw.referencePrice, priorNext.at(-1).close);
  assert.equal(requests.includes('ESZ26.CME|5d'), true);
  assert.equal(requests.includes('ESU26.CME|5d'), false, 'Premarket must fetch reference history only for the selected contract.');
}

function testPriorFuturesContractIdentity() {
  const dir = makeTemporaryDirectory('dfd-futures-contract-');
  const input = path.join(dir, 'dashboard.html');
  fs.writeFileSync(input, `<script type="application/json" id="dashboard-data">${JSON.stringify({
    futuresModule: {
      futures: [
        { symbol: 'ES=F', raw: { contractSymbol: 'ESZ26.CME' } },
        { symbol: 'YM=F', raw: { contractSymbol: 'invalid' } }
      ]
    }
  })}</script>`);
  const contracts = priorFuturesContracts(input);
  assert.equal(contracts.get('ES=F'), 'ESZ26.CME');
  assert.equal(contracts.get('YM=F'), '');
  assert.deepEqual([...priorFuturesContracts(path.join(dir, 'missing.html')).entries()], []);
}

function assetRows() {
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

function dashboardHtmlForRows(rows, chartData = null) {
  return `<script type="application/json" id="dashboard-data">${JSON.stringify({ tape: { rows } })}</script>
<script type="application/json" id="chart-data">${JSON.stringify(chartData || compactChartPayload({
    schemaVersion: 1,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    series: [chartSeries()]
  }))}</script>`;
}

function testChartSeriesOwnsDerivedQuoteRows() {
  const series = chartSeries();
  const quote = quoteRowFromSeries(series);
  assert.equal(quote.ticker, 'SPX');
  assert.equal(quote.last, '101.00');
  assert.equal(quote.delta, '+1.00');
  assert.equal(quote.pct, '+1.00%');

  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    series: [series]
  };
  assert.deepEqual(validateChartStagingPayload(payload, [{ ticker: 'SPX', sourceSymbol: '^GSPC' }]), []);
  assert.match(
    validateChartStagingPayload({ ...payload, quoteRows: [quote] }, [{ ticker: 'SPX', sourceSymbol: '^GSPC' }]).join('\n'),
    /quoteRows is no longer stored/
  );
}

function testChartStagingFallbackAndIsolation() {
  const valid = chartSeries();
  const malformed = chartSeries({ ticker: 'VCR', sourceSymbol: 'VCR', bars: [{ time: '2026-07-10', open: 1, high: 1, low: 1, close: 1, volume: 1 }] });
  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    availability: {
      status: 'partial',
      reason: 'source_refresh_failed',
      checkedAt: '2026-07-10T21:00:00.000Z',
      failures: [{ ticker: 'VCR', message: 'malformed bars' }]
    },
    series: [
      valid,
      {
        ...malformed,
        availability: {
          status: 'carried_forward',
          reason: 'source_refresh_failed',
          checkedAt: '2026-07-10T21:00:00.000Z'
        }
      }
    ]
  };
  const errors = validateChartStagingPayload(payload, [
    { ticker: 'SPX', sourceSymbol: '^GSPC' },
    { ticker: 'VCR', sourceSymbol: 'VCR' }
  ]);
  assert.match(errors.join('\n'), /VCR.*must contain at least two daily bars/, 'Malformed carried-forward chart series must not pass staging validation.');
  assert.equal(errors.some((error) => /SPX/.test(error)), false, errors.join('\n'));

  const fallback = buildChartDataFallback(payload, new Date('2026-07-10T22:00:00.000Z'));
  assert.equal(fallback.availability.status, 'carried_forward');
  assert.equal(fallback.series.every((item) => item.availability?.status === 'carried_forward'), true);
  assert.deepEqual(buildUnavailableChartData(new Date('2026-07-10T22:00:00.000Z')).series, []);
}

async function testCurrentMarketFailuresStayIsolated() {
  const dir = makeTemporaryDirectory('dfd-current-market-isolation-');
  const chartInput = path.join(dir, 'dashboard.html');
  const chartOutput = path.join(dir, 'chart-data.json');
  const priorChartData = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    series: [
      chartSeries(),
      chartSeries({ ticker: 'VCR', name: 'VCR', sourceSymbol: 'VCR' })
    ]
  };
  fs.writeFileSync(chartInput, dashboardHtmlForRows([
    { group: 'Equities', name: 'S&P 500', ticker: 'SPX', sourceSymbol: '^GSPC' },
    { group: 'Sectors', name: 'VCR', ticker: 'VCR', sourceSymbol: 'VCR' }
  ], priorChartData));

  await chartData.runChart([
    '--input', chartInput,
    '--output', chartOutput,
    '--as-of', '2026-07-10T21:00:00.000Z',
    '--days', '1826',
    '--delay-ms', '0'
  ], {
    now: new Date('2026-07-10T21:05:00.000Z'),
    fetchSeries: async (row) => row.ticker === 'VCR'
      ? chartSeries({ ticker: 'VCR', name: 'VCR', sourceSymbol: 'VCR', bars: [{ time: '2026-07-10', open: 1, high: 1, low: 1, close: 1, volume: 1 }] })
      : chartSeries({ bars: [
        { time: '2026-07-09', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        { time: '2026-07-10', open: 100, high: 105, low: 99, close: 104, volume: 1100 }
      ] })
  });

  const stagedChartData = JSON.parse(fs.readFileSync(chartOutput, 'utf8'));
  assert.deepEqual(validateChartStagingPayload(stagedChartData, [
    { ticker: 'SPX', sourceSymbol: '^GSPC' },
    { ticker: 'VCR', sourceSymbol: 'VCR' }
  ]), []);
  assert.equal(stagedChartData.series.find((series) => series.ticker === 'SPX').bars.at(-1).close, 104);
  assert.equal(stagedChartData.series.find((series) => series.ticker === 'VCR').bars.at(-1).close, 101);
  assert.equal(stagedChartData.series.find((series) => series.ticker === 'VCR').availability.status, 'carried_forward');
  assert.deepEqual(stagedChartData.availability.failures.map((failure) => failure.ticker), ['VCR']);

  const cryptoInput = path.join(dir, 'crypto-dashboard.html');
  fs.writeFileSync(cryptoInput, `<script type="application/json" id="dashboard-data">${JSON.stringify({
    editionId: '2026-07-10T21:00:00.000Z',
    crypto: {
      statsFetchedAt: '2026-07-10T20:00:00.000Z',
      stats: [
        { sym: 'F&G', name: 'Fear & Greed Index', sub: 'Neutral', price: '50', delta: '+1', chg: '+1', dir: 'up' },
        { sym: 'ALTSEASON', name: 'Altcoin Season Index', sub: 'Bitcoin Season', price: '25', delta: '+1', chg: '/100', dir: 'up' },
        { sym: 'TOTAL', name: 'Crypto Market Cap', sub: 'Expanding', price: '$1.00T', delta: '+$0.01T', chg: '+1.00%', dir: 'up' }
      ],
      dominance: { btc: '55.00%', eth: '10.00%', others: '35.00%' }
    }
  })}</script>`);
  const cryptoPayload = await cryptoStats.fetchCryptoStatsPartial({
    input: cryptoInput,
    lookbackDays: 31,
    timeoutMs: 1000
  }, {
    now: new Date('2026-07-10T21:05:00.000Z'),
    collectProvider: async (task) => {
      if (task.key === 'fearGreed') throw new Error('fixture provider failure');
      if (task.key === 'altcoinSeason') {
        return { stat: { sym: 'ALTSEASON', name: 'Altcoin Season Index', sub: 'Altcoin Season', price: '76', delta: '+2', chg: '/100', dir: 'up' } };
      }
      return {
        stat: { sym: 'TOTAL', name: 'Crypto Market Cap', sub: 'Expanding', price: '$1.10T', delta: '+$0.10T', chg: '+10.00%', dir: 'up' },
        dominance: { btc: '54.00%', eth: '11.00%', others: '35.00%' }
      };
    }
  });
  assert.deepEqual(cryptoStats.validateCryptoStatsPayload(cryptoPayload), []);
  assert.equal(cryptoPayload.stats.find((stat) => stat.sym === 'F&G').availability.status, 'carried_forward');
  assert.equal(cryptoPayload.stats.find((stat) => stat.sym === 'ALTSEASON').price, '76');
  assert.equal(cryptoPayload.stats.find((stat) => stat.sym === 'TOTAL').price, '$1.10T');
  assert.deepEqual(cryptoPayload.availability.failures.map((failure) => failure.provider), ['fearGreed']);
}

function testCompactChartBarsStayTupleEncoded() {
  const compact = compactChartPayload({
    schemaVersion: 1,
    generatedAt: '2026-07-10T21:00:00.000Z',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    series: [chartSeries()]
  });
  assert.equal(compact.barEncoding, 'tuple-v1');
  assert.deepEqual(compact.series[0].bars[0], ['2026-07-09', 100, 101, 99, 100, 1000]);
  assert.equal(roundChartPayload(compact).series[0].bars[0].close, 100);
}

function testAssetAllocationStagingContracts() {
  const portfolio = {
    compiledAt: '2026-07-10T21:00:00.000Z',
    source: 'Fixture portfolio',
    month: '2026-07',
    rows: assetRows()
  };
  assert.deepEqual(validateAssetAllocationPortfolioPayload(portfolio), []);
  assert.deepEqual(validateAssetAllocationPortfolioPayload(buildAssetAllocationFallback(portfolio, {
    month: '2026-07',
    asOf: '2026-07-10',
    checkedAt: new Date('2026-07-10T22:00:00.000Z')
  })), []);

  const unavailableSummary = buildAssetAllocationSummaryFallback({
    asOf: '2026-07-10',
    portfolioMtdReturnValue: 0.0123,
    status: 'available',
    stale: false
  }, { asOf: '2026-08-01' });
  assert.deepEqual(validateAssetAllocationSummaryPayload(unavailableSummary), []);
  assert.equal(unavailableSummary.status, 'unavailable');
}

function testLocalRefreshReadsOnlyEligibleRows() {
  assert.equal(shouldRefreshChartRow({ ticker: 'MOVE', sourceSymbol: 'MOVE.INDX' }), false);
  assert.equal(shouldRefreshChartRow({ ticker: 'CURVE', sourceSymbol: 'TREASURY:CURVE' }), false);
  assert.equal(shouldRefreshChartRow({ ticker: 'SPX', sourceSymbol: '^GSPC' }), true);

  const dir = makeTemporaryDirectory('dfd-local-refresh-');
  const input = path.join(dir, 'dashboard.html');
  fs.writeFileSync(input, dashboardHtmlForRows([
    { group: 'Equities', name: 'S&P 500', ticker: 'SPX', sourceSymbol: '^GSPC' },
    { group: 'Volatility', name: 'MOVE', ticker: 'MOVE', sourceSymbol: 'MOVE.INDX' },
    { group: 'Rates & Credit', name: 'Treasury Curve', ticker: 'CURVE', sourceSymbol: 'TREASURY:CURVE' },
    { group: 'Crypto', name: 'Bitcoin', ticker: 'BTC', sourceSymbol: 'BTC-USD' }
  ]));
  assert.deepEqual(localRefreshChartRows(input).map((row) => row.ticker), ['SPX', 'BTC']);

  fs.writeFileSync(input, fs.readFileSync(input, 'utf8')
    .replace('<script type="application/json" id="dashboard-data">', '<script data-fixture="yes" id="dashboard-data" type="application/json">')
    .replace('<script type="application/json" id="chart-data">', '<script id="chart-data" data-fixture="yes" type="application/json">'));
  assert.deepEqual(chartData.readChartableRows(input).map((row) => row.ticker), ['SPX', 'MOVE', 'CURVE', 'BTC']);
  assert.deepEqual(localRefreshChartRows(input).map((row) => row.ticker), ['SPX', 'BTC']);

  const equivalentHtml = fs.readFileSync(input, 'utf8');
  fs.writeFileSync(input, `<div id="dashboard-data">shadow</div>\n${equivalentHtml}`);
  assert.throws(() => chartData.readChartableRows(input), /exactly one active #dashboard-data element; found 2/);
  assert.throws(() => localRefreshChartRows(input), /exactly one active #dashboard-data element; found 2/);

  fs.writeFileSync(input, `<div id="chart-data">shadow</div>\n${equivalentHtml}`);
  assert.equal(latestEmbeddedChartDate(input), '', 'A shadowed embedded chart block must fail open without setting a refresh date.');
}

function testLocalRefreshWindowAndOriginPolicy() {
  assert.equal(isAllowedBrowserOrigin('https://sdupuie.github.io'), true);
  assert.equal(isAllowedBrowserOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedBrowserOrigin('https://example.com'), false);
  assert.equal(isAllowedBrowserOrigin('https://sdupuie.github.io.example.com'), false);

  const dir = makeTemporaryDirectory('dfd-refresh-window-');
  const input = path.join(dir, 'dashboard.html');
  fs.writeFileSync(input, dashboardHtmlForRows([{ group: 'Equities', name: 'S&P 500', ticker: 'SPX', sourceSymbol: '^GSPC' }]));
  const parsed = parseLocalMarketServerArgs(['--input', input, '--days', '5', '--port', '2211']);
  assert.equal(parsed.port, 2211);
  assert.equal(refreshWindow(parsed, new Date('2026-07-20T21:00:00.000Z')).days, 5);
}

async function testBuildMarketRefreshNormalizesAndIsolatesFailures() {
  const dir = makeTemporaryDirectory('dfd-refresh-payload-');
  const input = path.join(dir, 'dashboard.html');
  fs.writeFileSync(input, dashboardHtmlForRows([
    { group: 'Equities', name: 'S&P 500', ticker: 'SPX', sourceSymbol: '^GSPC' },
    { group: 'Equities', name: 'VCR', ticker: 'VCR', sourceSymbol: 'VCR' },
    { group: 'Volatility', name: 'MOVE', ticker: 'MOVE', sourceSymbol: 'MOVE.INDX' }
  ]));

  const originalFetchSeries = chartData.fetchSeries;
  const originalFetchCryptoStats = cryptoStats.fetchCryptoStats;
  try {
    chartData.fetchSeries = async (row) => {
      if (row.ticker === 'VCR') throw new Error('fixture chart failure');
      return chartSeries({
        ticker: row.ticker,
        sourceSymbol: row.sourceSymbol,
        bars: [
          { time: '2026-07-09', open: 100.11119, high: 101.22229, low: 99.33339, close: 100.44449, volume: 1000.4 },
          { time: '2026-07-10', open: 100.55559, high: 102.66669, low: 99.77779, close: 101.88889, volume: 1100.6 }
        ]
      });
    };
    cryptoStats.fetchCryptoStats = async () => {
      throw new Error('fixture crypto failure');
    };

    const payload = await buildMarketRefresh({
      input,
      days: 5,
      concurrency: 2,
      sourceTimeoutMs: 1000
    });

    assert.deepEqual(payload.series.map((series) => series.ticker), ['SPX']);
    assert.equal(payload.series[0].bars[0].open, 100.1112);
    assert.equal(payload.series[0].bars[1].volume, 1101);
    assert.equal(payload.sections.chart.ok, true);
    assert.equal(payload.sections.cryptoStats.ok, false);
    assert.equal(payload.partial, true);
    assert.match(payload.errors.map((error) => error.message).join('\n'), /fixture chart failure/);
    assert.match(payload.errors.map((error) => error.message).join('\n'), /fixture crypto failure/);
  } finally {
    chartData.fetchSeries = originalFetchSeries;
    cryptoStats.fetchCryptoStats = originalFetchCryptoStats;
  }
}

async function main() {
  try {
    await testFuturesContractResolutionAndFallback();
    await testStaleFuturesContractCannotRetainPriority();
    await testPremarketFuturesUsesOneExplicitContract();
    testPriorFuturesContractIdentity();
    testChartSeriesOwnsDerivedQuoteRows();
    testChartStagingFallbackAndIsolation();
    await testCurrentMarketFailuresStayIsolated();
    testCompactChartBarsStayTupleEncoded();
    testAssetAllocationStagingContracts();
    testLocalRefreshReadsOnlyEligibleRows();
    testLocalRefreshWindowAndOriginPolicy();
    await testBuildMarketRefreshNormalizesAndIsolatesFailures();
    process.stdout.write('Market data tests passed.\n');
  } finally {
    cleanupTemporaryDirectories();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
