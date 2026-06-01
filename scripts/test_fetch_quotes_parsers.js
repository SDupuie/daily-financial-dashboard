#!/usr/bin/env node

const {
  parseYahoo,
  parseYahooChart,
  parseNasdaq,
  parseMarketWatch,
  parseDateLoose,
  parseNumberFromText
} = require('./fetch_quotes');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

// Yahoo HTML fixture
const yahooHtml = `
{"regularMarketPrice":{"raw":151.64},"regularMarketPreviousClose":{"raw":154.20},"regularMarketChangePercent":{"raw":-1.66},"regularMarketTime":{"raw":1780156800}}
`;
const y = parseYahoo(yahooHtml);
assert(isFiniteNumber(y.close), 'parseYahoo close must be numeric');
assert(y.tradeDate === '2026-05-30', 'parseYahoo tradeDate should parse UNIX timestamp (UTC)');

// Yahoo Chart API fixture
const yahooChartJson = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          previousClose: 150,
          regularMarketPrice: 151,
          regularMarketTime: 1780156800,
          regularMarketChangePercent: 0.6667
        },
        timestamp: [1780070400, 1780156800],
        indicators: {
          quote: [{ close: [150.0, 151.0] }]
        }
      }
    ]
  }
});
const yc = parseYahooChart(yahooChartJson);
assert(isFiniteNumber(yc.close), 'parseYahooChart close must be numeric');
assert(yc.tradeDate === '2026-05-30', 'parseYahooChart tradeDate should parse last timestamp');

// Yahoo Chart API fallback fixture: missing previousClose/regularMarketChangePercent
const yahooChartFallbackJson = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 40.53,
          chartPreviousClose: 42.96,
          regularMarketTime: 1780323411
        },
        timestamp: [1780233600],
        indicators: {
          quote: [{ close: [40.53] }]
        }
      }
    ]
  }
});
const ycf = parseYahooChart(yahooChartFallbackJson);
assert(isFiniteNumber(ycf.close), 'parseYahooChart fallback close must be numeric');
assert(isFiniteNumber(ycf.pctChange), 'parseYahooChart should compute pctChange from chartPreviousClose fallback');

// Nasdaq JSON fixture
const nasdaqJson = JSON.stringify({
  data: {
    primaryData: {
      lastSalePrice: '$151.64',
      percentageChange: '-1.66%',
      lastTradeTimestamp: 'May 30, 2026'
    }
  }
});
const n = parseNasdaq(nasdaqJson);
assert(isFiniteNumber(n.close), 'parseNasdaq close must be numeric');
assert(n.tradeDate === '2026-05-30', 'parseNasdaq tradeDate should parse timestamp text');

// MarketWatch HTML fixture
const mwHtml = `
<bg-quote class="value">151.64</bg-quote>
<bg-quote field="percentChange">-1.66%</bg-quote>
As of May 30, 2026
`;
const mw = parseMarketWatch(mwHtml);
assert(isFiniteNumber(mw.close), 'parseMarketWatch close must be numeric');
assert(mw.tradeDate === '2026-05-30', 'parseMarketWatch tradeDate should parse As of date');

assert(parseDateLoose('May 30, 2026 ET') === '2026-05-30', 'parseDateLoose should normalize TZ suffix');
assert(parseNumberFromText('$1,234.56%') === 1234.56, 'parseNumberFromText should normalize money/percent text');

process.stdout.write('fetch_quotes parser tests passed\n');
