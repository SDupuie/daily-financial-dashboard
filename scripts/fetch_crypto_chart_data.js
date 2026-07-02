#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'crypto_chart_data.json');
const DEFAULT_DAYS = 1826;
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
// Crypto display tickers are mapped to Yahoo chart symbols so the static popup can use daily OHLC/volume bars.
const CRYPTO_SOURCE_SYMBOLS = new Map(Object.entries({
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  IBIT: 'IBIT',
  MSTR: 'MSTR'
}));

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    days: DEFAULT_DAYS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    delayMs: 250,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--days') {
      args.days = Math.max(5, Number(argv[i + 1] || DEFAULT_DAYS));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--delay-ms') {
      args.delayMs = Math.max(0, Number(argv[i + 1] || 0));
      i += 1;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_crypto_chart_data.js [options]

Options:
  --input PATH        Dashboard HTML to read (default: daily_financial_news.html)
  --output PATH       JSON output path (default: scripts/generated/crypto_chart_data.json)
  --days 1826         Calendar days of daily history to request
  --timeout-ms 15000  HTTP timeout in ms per request
  --delay-ms 250      Delay between source requests
  --compact           Print one-line series summary
  --help              Show this help
`);
}

function readCryptoRows(input) {
  const html = fs.readFileSync(input, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${input}`);
  }
  const data = JSON.parse(match[1]);
  const rows = Array.isArray(data.crypto?.tape) ? data.crypto.tape : [];
  // Only configured rows are exported; validation catches expected crypto popups that are missing history.
  return rows.map((row, index) => {
    const ticker = String(row?.sym || row?.ticker || '').trim().toUpperCase();
    return {
      index,
      ticker,
      name: String(row?.name || ticker).trim(),
      note: String(row?.sub || '').trim(),
      sourceSymbol: CRYPTO_SOURCE_SYMBOLS.get(ticker) || ''
    };
  }).filter((row) => row.ticker && row.sourceSymbol);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDateFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoDateFromEpochSeconds(value) {
  return isoDateFromDate(new Date(value * 1000));
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortBars(bars) {
  return bars.sort((a, b) => a.time.localeCompare(b.time));
}

function uniqueBars(bars) {
  const byDate = new Map();
  for (const bar of bars) byDate.set(bar.time, bar);
  return sortBars([...byDate.values()]);
}

function closeOnlyBar(time, close) {
  return { time, open: close, high: close, low: close, close };
}

function isUsableOhlc(open, high, low, close) {
  if ([open, high, low, close].some((value) => value === null)) return false;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return false;
  return !(close > 0 && [open, high, low].some((value) => value <= 0));
}

function fetchText(url, args) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'DailyFinancialDashboard/1.0'
      },
      timeout: args.timeoutMs
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160).trim()}`));
          return;
        }
        resolve(body);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${args.timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, args) {
  const text = await fetchText(url, args);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function yahooChartUrl(host, symbol, startDate, endDate) {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor((endDate.getTime() + 24 * 60 * 60 * 1000) / 1000);
  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: '1d',
    events: 'history',
    includePrePost: 'false'
  });
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
}

async function fetchYahooSeries(row, args, startDate, endDate) {
  const errors = [];
  // Yahoo's query hosts are equivalent for this endpoint; try both before treating a symbol as unavailable.
  for (const host of YAHOO_HOSTS) {
    try {
      const payload = await fetchJson(yahooChartUrl(host, row.sourceSymbol, startDate, endDate), args);
      return parseYahooSeries(row, payload, host);
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

function parseYahooSeries(row, payload, host) {
  const result = payload?.chart?.result?.[0];
  const chartError = payload?.chart?.error;
  if (!result) {
    throw new Error(chartError?.description || 'response did not include chart data');
  }

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];
  const hasRealVolume = volumes.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const points = timestamps.map((timestamp, index) => {
    const close = asFiniteNumber(quote.close?.[index]);
    if (!Number.isFinite(timestamp) || close === null) return null;

    const open = asFiniteNumber(quote.open?.[index]);
    const high = asFiniteNumber(quote.high?.[index]);
    const low = asFiniteNumber(quote.low?.[index]);
    const volume = asFiniteNumber(volumes[index]);
    return {
      time: isoDateFromEpochSeconds(timestamp),
      open,
      high,
      low,
      close,
      hasOhlc: isUsableOhlc(open, high, low, close),
      volume
    };
  }).filter(Boolean);
  const priceOnly = !points.some((point) => point.hasOhlc);
  // True close-only feeds get synthetic OHLC; mixed Yahoo feeds keep OHLC and drop isolated bad rows.
  const bars = points.map((point) => {
    if (!priceOnly && !point.hasOhlc) return null;
    const bar = priceOnly
      ? closeOnlyBar(point.time, point.close)
      : { time: point.time, open: point.open, high: point.high, low: point.low, close: point.close };
    if (hasRealVolume && point.volume !== null) bar.volume = point.volume;
    return bar;
  }).filter(Boolean);

  if (!bars.length) {
    throw new Error(`${row.sourceSymbol} response did not include usable daily bars`);
  }

  return {
    ticker: row.ticker,
    name: row.name,
    sourceSymbol: row.sourceSymbol,
    note: row.note,
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    fetchedFrom: host,
    dataKind: priceOnly ? 'close' : 'ohlc',
    priceOnly,
    noVolume: !hasRealVolume,
    currency: result.meta?.currency || 'USD',
    exchangeTimezoneName: result.meta?.exchangeTimezoneName || null,
    bars: uniqueBars(bars)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = readCryptoRows(args.input);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const series = [];

  for (const row of inputRows) {
    const item = await fetchYahooSeries(row, args, startDate, endDate);
    series.push(item);
    if (args.delayMs) await sleep(args.delayMs);
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dashboardSource: path.relative(process.cwd(), args.input) || path.basename(args.input),
    range: {
      days: args.days,
      startDate: isoDateFromDate(startDate),
      endDate: isoDateFromDate(endDate)
    },
    sourceFamilies: ['Yahoo Finance Chart API'],
    series
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);

  if (args.compact) {
    process.stdout.write(`${series.map((item) => `${item.ticker}:${item.bars.length}`).join(' | ')}\n`);
  } else {
    process.stdout.write(`${args.output}\n`);
  }
}

// The optional local quote server imports these helpers to keep crypto popup refreshes on the same Yahoo source contract.
module.exports = {
  DEFAULT_DAYS,
  REQUEST_TIMEOUT_MS,
  fetchYahooSeries,
  isoDateFromDate,
  readCryptoRows,
  sleep
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_crypto_chart_data failed: ${error.message}\n`);
    process.exit(1);
  });
}
