#!/usr/bin/env node

const http = require('http');
const path = require('path');

const chartData = require('./fetch_chart_data');

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

async function fetchChartPayload(args, startDate, endDate) {
  const rows = chartData.readChartableRows(args.input);
  const treasuryMonthCache = new Map();
  const errors = [];
  const results = await mapLimit(rows, args.concurrency, async (row) => {
    try {
      return await chartData.fetchSeries(row, sourceArgs(args), startDate, endDate, treasuryMonthCache);
    } catch (error) {
      errors.push({ section: row.section || 'chart', ticker: row.ticker, message: error.message });
      return null;
    }
  });
  const series = results.filter(Boolean);
  const quoteRows = {
    tape: [],
    crypto: []
  };
  for (const item of series) {
    try {
      if (item.section === 'crypto') {
        quoteRows.crypto.push(chartData.cryptoQuoteRowFromSeries(item));
      } else {
        quoteRows.tape.push(chartData.quoteRowFromSeries(item));
      }
    } catch (error) {
      errors.push({ section: item.section || 'chart', ticker: item.ticker, message: error.message });
    }
  }
  return { series, quoteRows, errors };
}

async function buildMarketRefresh(args) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const chart = await fetchChartPayload(args, startDate, endDate);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: 'scripts/local_quote_server.js',
    range: {
      days: args.days,
      startDate: chartData.isoDateFromDate(startDate),
      endDate: chartData.isoDateFromDate(endDate)
    },
    sourceFamilies: Array.from(new Set(chart.series
      .map((item) => item.source)
      .filter(Boolean))),
    quoteRows: chart.quoteRows,
    series: chart.series,
    errors: chart.errors
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
        sendJson(res, cachedPayload.ok ? 200 : 502, { ...cachedPayload, cached: true });
        return;
      }

      // Share one upstream refresh among simultaneous browser requests instead of stampeding the free data endpoints.
      inFlight ||= buildMarketRefresh(args).finally(() => {
        inFlight = null;
      });
      const payload = await inFlight;
      const successCount = payload.series.length;
      // Fresh and cached responses share this normalized shape; only the per-request cached flag changes.
      const responsePayload = {
        ...payload,
        ok: Boolean(successCount)
      };
      cachedPayload = responsePayload;
      cachedAt = Date.now();

      sendJson(res, responsePayload.ok ? 200 : 502, {
        ...responsePayload,
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
