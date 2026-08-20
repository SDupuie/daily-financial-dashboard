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
  quoteRowFromSeries,
  roundChartPayload,
  validateChartStagingPayload
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
