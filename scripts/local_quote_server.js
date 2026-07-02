#!/usr/bin/env node

const http = require('http');
const path = require('path');

const chartData = require('./fetch_chart_data');
const cryptoChartData = require('./fetch_crypto_chart_data');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 2210;
// Recent bars are merged into the dashboard's embedded multi-year history, so the local helper only needs a short window.
const DEFAULT_DAYS = 120;
const DEFAULT_SOURCE_TIMEOUT_MS = 7000;
const DEFAULT_CACHE_MS = 60000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INPUT = path.resolve(__dirname, '..', 'daily_financial_news.html');
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true'
};

function numericOption(value, fallback, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be numeric.`);
  }
  const bounded = Math.min(max, Math.max(min, number));
  return integer ? Math.trunc(bounded) : bounded;
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    input: DEFAULT_INPUT,
    days: DEFAULT_DAYS,
    sourceTimeoutMs: DEFAULT_SOURCE_TIMEOUT_MS,
    cacheMs: DEFAULT_CACHE_MS,
    concurrency: DEFAULT_CONCURRENCY
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      args.port = numericOption(argv[i + 1], DEFAULT_PORT, '--port', { min: 1, max: 65535, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--days') {
      args.days = numericOption(argv[i + 1], DEFAULT_DAYS, '--days', { min: 5, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--source-timeout-ms') {
      args.sourceTimeoutMs = numericOption(argv[i + 1], DEFAULT_SOURCE_TIMEOUT_MS, '--source-timeout-ms', { min: 1000, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--cache-ms') {
      args.cacheMs = numericOption(argv[i + 1], DEFAULT_CACHE_MS, '--cache-ms', { min: 0, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--concurrency') {
      args.concurrency = numericOption(argv[i + 1], DEFAULT_CONCURRENCY, '--concurrency', { min: 1, integer: true });
      i += 1;
      continue;
    }
    if (/^\d+$/.test(arg)) {
      args.port = Number(arg);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid port: ${args.port}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/local_quote_server.js [options]

Options:
  --port, -p 2210          Local port to bind on 127.0.0.1
  --input PATH             Dashboard HTML to read for configured rows
  --days 120               Calendar days of recent chart data to refresh
  --source-timeout-ms 7000 HTTP timeout in ms per upstream request
  --cache-ms 60000         In-memory cache duration for refresh responses
  --concurrency 5          Maximum concurrent source requests
  --help                   Show this help
`);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(`${body}\n`);
}

function writeCorsHeaders(res) {
  // GitHub Pages may call this loopback helper from a public HTTPS origin; the private-network header satisfies browser preflights.
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sourceArgs(args) {
  return {
    timeoutMs: args.sourceTimeoutMs,
    delayMs: 0
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function numberFormat(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}

function signedNumber(value) {
  const formatted = numberFormat(Math.abs(value), 2);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return '0.00';
}

function signedPct(value) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'always'
  }).format(value)}%`;
}

function direction(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function formatCryptoPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'Unavailable';
  const decimals = price >= 10000 ? 0 : price >= 2 ? 2 : 4;
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(price)}`;
}

function formatCryptoDelta(delta, price) {
  if (!Number.isFinite(delta)) return 'Unavailable';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const decimals = Math.abs(delta) >= 100 ? 0 : price >= 2 ? 2 : 4;
  return `${sign}$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(Math.abs(delta))}`;
}

function cryptoQuoteRowFromSeries(item) {
  const bars = item.bars || [];
  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  if (!latest || !previous) {
    throw new Error(`${item.ticker} response did not include enough bars for quote fields`);
  }

  const delta = latest.close - previous.close;
  const pct = previous.close ? (delta / previous.close) * 100 : 0;
  return {
    sym: item.ticker,
    ticker: item.ticker,
    name: item.name,
    sub: item.ticker,
    price: formatCryptoPrice(latest.close),
    delta: formatCryptoDelta(delta, latest.close),
    chg: signedPct(pct),
    dir: direction(pct),
    asOf: latest.time
  };
}

async function fetchTapePayload(args, startDate, endDate) {
  const rows = chartData.readTapeRows(args.input);
  const treasuryMonthCache = new Map();
  const errors = [];
  const results = await mapLimit(rows, args.concurrency, async (row) => {
    try {
      return await chartData.fetchSeries(row, sourceArgs(args), startDate, endDate, treasuryMonthCache);
    } catch (error) {
      errors.push({ section: 'tape', ticker: row.ticker, message: error.message });
      return null;
    }
  });
  const series = results.filter(Boolean);
  const quoteRows = [];
  for (const item of series) {
    try {
      quoteRows.push(chartData.quoteRowFromSeries(item));
    } catch (error) {
      errors.push({ section: 'tape', ticker: item.ticker, message: error.message });
    }
  }
  return { series, quoteRows, errors };
}

async function fetchCryptoPayload(args, startDate, endDate) {
  const rows = cryptoChartData.readCryptoRows(args.input);
  const errors = [];
  const results = await mapLimit(rows, args.concurrency, async (row) => {
    try {
      return await cryptoChartData.fetchYahooSeries(row, sourceArgs(args), startDate, endDate);
    } catch (error) {
      errors.push({ section: 'crypto', ticker: row.ticker, message: error.message });
      return null;
    }
  });
  const series = results.filter(Boolean);
  const quoteRows = [];
  for (const item of series) {
    try {
      quoteRows.push(cryptoQuoteRowFromSeries(item));
    } catch (error) {
      errors.push({ section: 'crypto', ticker: item.ticker, message: error.message });
    }
  }
  return { series, quoteRows, errors };
}

async function buildMarketRefresh(args) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const [tape, crypto] = await Promise.all([
    fetchTapePayload(args, startDate, endDate),
    fetchCryptoPayload(args, startDate, endDate)
  ]);
  const errors = [...tape.errors, ...crypto.errors];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: 'scripts/local_quote_server.js',
    range: {
      days: args.days,
      startDate: chartData.isoDateFromDate(startDate),
      endDate: chartData.isoDateFromDate(endDate)
    },
    sourceFamilies: [
      'Yahoo Finance Chart API',
      'MSCI index graph endpoint',
      'Treasury.gov Daily Treasury Yield Curve Rate Data'
    ],
    tape: {
      quoteRows: tape.quoteRows,
      series: tape.series
    },
    crypto: {
      quoteRows: crypto.quoteRows,
      series: crypto.series
    },
    errors
  };
}

function createServer(args) {
  let cachedPayload = null;
  let cachedAt = 0;
  let inFlight = null;

  return http.createServer(async (req, res) => {
    writeCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${args.port}`);
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Only GET and OPTIONS are supported.' });
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        host: HOST,
        port: args.port,
        input: args.input,
        generatedAt: new Date().toISOString()
      });
      return;
    }

    if (url.pathname !== '/api/market-refresh') {
      sendJson(res, 404, { ok: false, error: 'Not found.' });
      return;
    }

    try {
      const bypassCache = url.searchParams.get('fresh') === '1';
      const now = Date.now();
      if (!bypassCache && cachedPayload && args.cacheMs && now - cachedAt < args.cacheMs) {
        // Cache only server-side fetch work; browser responses are still no-store so the dashboard can retry after reloads.
        sendJson(res, 200, { ...cachedPayload, cached: true });
        return;
      }

      // Share one upstream refresh among simultaneous browser requests instead of stampeding the free data endpoints.
      inFlight ||= buildMarketRefresh(args).finally(() => {
        inFlight = null;
      });
      const payload = await inFlight;
      cachedPayload = payload;
      cachedAt = Date.now();

      const successCount = payload.tape.series.length + payload.crypto.series.length;
      sendJson(res, successCount ? 200 : 502, {
        ...payload,
        ok: Boolean(successCount),
        cached: false
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        generatedAt: new Date().toISOString(),
        error: error.message
      });
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer(args);
  server.listen(args.port, HOST, () => {
    process.stdout.write(`Local quote server listening at http://${HOST}:${args.port}\n`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`local_quote_server failed: ${error.message}\n`);
    process.exit(1);
  }
}
