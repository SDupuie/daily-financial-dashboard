#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chartData = require('./fetch_chart_data');
const cryptoStats = require('./fetch_crypto_stats');

// Bind the reserved primary-LAN address explicitly; network policy, not this process, keeps guest and WAN clients out.
const DEFAULT_HOST = '192.168.2.2';
const DEFAULT_PORT = 2210;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_REFRESH_FALLBACK_DAYS = 30;
const AUTO_REFRESH_MAX_DAYS = 90;
const AUTO_REFRESH_OVERLAP_DAYS = 7;
const DEFAULT_SOURCE_TIMEOUT_MS = 7000;
const DEFAULT_CACHE_MS = 60000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INPUT = path.resolve(__dirname, '..', 'daily_financial_news.html');
const DEFAULT_CERT = path.join(os.homedir(), '.daily-financial-dashboard', 'tls', 'local-market-cert.pem');
const DEFAULT_KEY = path.join(os.homedir(), '.daily-financial-dashboard', 'tls', 'local-market-key.pem');
const PUBLISHED_DASHBOARD_ORIGIN = 'https://sdupuie.github.io';
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Vary': 'Origin'
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
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    input: DEFAULT_INPUT,
    cert: DEFAULT_CERT,
    key: DEFAULT_KEY,
    days: null,
    sourceTimeoutMs: DEFAULT_SOURCE_TIMEOUT_MS,
    cacheMs: DEFAULT_CACHE_MS,
    concurrency: DEFAULT_CONCURRENCY
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--host requires an address.');
      args.host = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--port requires a number.');
      args.port = numericOption(argv[i + 1], DEFAULT_PORT, '--port', { min: 1, max: 65535, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--input') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--input requires a path.');
      args.input = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--cert') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--cert requires a path.');
      args.cert = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--key') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--key requires a path.');
      args.key = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--days') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--days requires a number.');
      args.days = numericOption(argv[i + 1], AUTO_REFRESH_FALLBACK_DAYS, '--days', { min: 5, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--source-timeout-ms') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--source-timeout-ms requires a number.');
      args.sourceTimeoutMs = numericOption(argv[i + 1], DEFAULT_SOURCE_TIMEOUT_MS, '--source-timeout-ms', { min: 1000, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--cache-ms') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--cache-ms requires a number.');
      args.cacheMs = numericOption(argv[i + 1], DEFAULT_CACHE_MS, '--cache-ms', { min: 0, integer: true });
      i += 1;
      continue;
    }
    if (arg === '--concurrency') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--concurrency requires a number.');
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid port: ${args.port}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/local_market_server.js [options]

Options:
  --host 192.168.2.2       LAN address to bind
  --port, -p 2210          Local port to bind
  --input PATH             Dashboard HTML to read for configured rows
  --cert PATH              TLS certificate for HTTPS
  --key PATH               TLS private key for HTTPS
  --days N                 Force calendar days to refresh instead of auto tail sizing
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

function isAllowedBrowserOrigin(origin) {
  // Origin-less clients remain available for command-line health checks; browser callers must match the narrow allowlist.
  if (!origin) return true;
  if (origin === PUBLISHED_DASHBOARD_ORIGIN) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function writeCorsHeaders(req, res) {
  // The helper is LAN-reachable, but browser reads remain limited to the published dashboard plus local development origins.
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  const origin = String(req.headers.origin || '');
  if (origin && isAllowedBrowserOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
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

function isoDateToUtcMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

function readEmbeddedChartData(input) {
  const html = fs.readFileSync(input, 'utf8');
  const match = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function latestEmbeddedChartDate(input) {
  const payload = readEmbeddedChartData(input);
  let latest = null;
  for (const item of Array.isArray(payload?.series) ? payload.series : []) {
    const bars = Array.isArray(item?.bars) ? item.bars : [];
    for (let index = bars.length - 1; index >= 0; index -= 1) {
      const bar = bars[index];
      const time = String(Array.isArray(bar) ? bar[0] : bar?.time || '').slice(0, 10);
      const ms = isoDateToUtcMs(time);
      if (ms !== null) {
        latest = latest === null ? ms : Math.max(latest, ms);
        break;
      }
    }
  }
  return latest === null ? '' : chartData.isoDateFromDate(new Date(latest));
}

function refreshWindow(args, endDate) {
  const endMs = endDate.getTime();
  if (Number.isInteger(args.days)) {
    const startDate = new Date(endMs - args.days * DAY_MS);
    return {
      mode: 'explicit',
      days: args.days,
      startDate,
      endDate,
      latestEmbeddedDate: ''
    };
  }

  const latestDate = latestEmbeddedChartDate(args.input);
  const latestMs = isoDateToUtcMs(latestDate);
  let mode = 'auto';
  let startMs;

  if (latestMs === null) {
    mode = 'fallback';
    startMs = endMs - AUTO_REFRESH_FALLBACK_DAYS * DAY_MS;
  } else {
    const overlapStartMs = latestMs - AUTO_REFRESH_OVERLAP_DAYS * DAY_MS;
    const maxStartMs = endMs - AUTO_REFRESH_MAX_DAYS * DAY_MS;
    startMs = Math.max(overlapStartMs, maxStartMs);
  }

  const days = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
  return {
    mode,
    days,
    startDate: new Date(startMs),
    endDate,
    latestEmbeddedDate: latestDate
  };
}

function isPartialRefresh(errors, sections) {
  return Boolean(errors.length || !sections.chart.ok || !sections.cryptoStats.ok);
}

function shouldRefreshChartRow(row) {
  // Full-curve comparison context belongs to scheduled chart-data, not the short-tail local refresh.
  return String(row?.sourceSymbol || '') !== 'TREASURY:CURVE';
}

function localRefreshChartRows(input) {
  return chartData.readChartableRows(input).filter(shouldRefreshChartRow);
}

async function fetchChartPayload(args, startDate, endDate) {
  const rows = localRefreshChartRows(args.input);
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
  let quoteRows = { tape: [], crypto: [] };
  try {
    // The local-refresh payload mirrors production: prices are derived from refreshed series
    // so preview data cannot invent a second market-data truth alongside chart history.
    quoteRows = chartData.deriveQuoteRowsFromSeries(series);
  } catch (error) {
    errors.push({ section: 'chart', ticker: 'quoteRows', message: error.message });
  }
  return { series, quoteRows, errors };
}

function sourceFamiliesFromCryptoStats(payload) {
  const keys = ['fearGreed', 'altcoinSeason', 'totalMarketCap'];
  return keys
    .map((key) => String(payload?.[key]?.source || '').trim())
    .filter(Boolean);
}

async function buildMarketRefresh(args) {
  const endDate = new Date();
  const range = refreshWindow(args, endDate);
  // Refresh quote rows, chart bars, and crypto stat cards as one logical snapshot, but keep section failures isolated.
  // The browser overlay receives explicit section status and may retain embedded
  // canonical data for a failed section; this payload never mutates dashboard HTML.
  const [chartResult, cryptoResult] = await Promise.allSettled([
    fetchChartPayload(args, range.startDate, range.endDate),
    cryptoStats.fetchCryptoStats({ timeoutMs: args.sourceTimeoutMs })
  ]);
  const chart = chartResult.status === 'fulfilled'
    ? chartResult.value
    : {
      series: [],
      quoteRows: { tape: [], crypto: [] },
      errors: []
    };
  const crypto = cryptoResult.status === 'fulfilled' ? cryptoResult.value : null;
  const chartError = chartResult.status === 'fulfilled'
    ? ''
    : chartResult.reason?.message || 'Chart refresh failed.';
  const cryptoError = cryptoResult.status === 'fulfilled'
    ? ''
    : cryptoResult.reason?.message || 'Crypto stat refresh failed.';
  const sectionErrors = [];
  if (chartError) sectionErrors.push({ section: 'chart', message: chartError });
  if (cryptoError) sectionErrors.push({ section: 'cryptoStats', message: cryptoError });
  const sections = {
    chart: {
      ok: chartResult.status === 'fulfilled',
      error: chartError
    },
    cryptoStats: {
      ok: cryptoResult.status === 'fulfilled',
      error: cryptoError
    }
  };
  const sourceFamilies = Array.from(new Set([
    ...chart.series.map((item) => item.source).filter(Boolean),
    ...sourceFamiliesFromCryptoStats(crypto)
  ]));

  const errors = [...chart.errors, ...sectionErrors];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: 'scripts/local_market_server.js',
    range: {
      mode: range.mode,
      days: range.days,
      startDate: chartData.isoDateFromDate(range.startDate),
      endDate: chartData.isoDateFromDate(range.endDate),
      latestEmbeddedDate: range.latestEmbeddedDate
    },
    sourceFamilies,
    quoteRows: chart.quoteRows,
    cryptoStats: crypto,
    series: chart.series,
    errors,
    sections,
    partial: isPartialRefresh(errors, sections)
  };
}

function createServer(args) {
  let cachedPayload = null;
  let cachedAt = 0;
  let inFlight = null;
  const tlsOptions = {
    cert: fs.readFileSync(args.cert),
    key: fs.readFileSync(args.key)
  };

  return https.createServer(tlsOptions, async (req, res) => {
    writeCorsHeaders(req, res);

    const origin = String(req.headers.origin || '');
    if (origin && !isAllowedBrowserOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: 'Browser origin is not allowed.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `https://${args.host}:${args.port}`);
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Only GET and OPTIONS are supported.' });
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        host: args.host,
        port: args.port,
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
      // A partial snapshot is still useful locally: keep quote/chart refreshes live even when a secondary section fails.
      const successCount = payload.series.length +
        payload.quoteRows.tape.length +
        payload.quoteRows.crypto.length +
        (Array.isArray(payload.cryptoStats?.stats) ? payload.cryptoStats.stats.length : 0);
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

function listenServer(args, onListening = () => {}) {
  const server = createServer(args);
  server.listen(args.port, args.host, () => {
    const address = server.address();
    if (args.port === 0 && address && typeof address === 'object') args.port = address.port;
    onListening(server);
  });
  return server;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  listenServer(args, () => {
    process.stdout.write(`Local market server listening at https://${args.host}:${args.port}\n`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`local_market_server failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildMarketRefresh,
  createServer,
  isPartialRefresh,
  isAllowedBrowserOrigin,
  latestEmbeddedChartDate,
  listenServer,
  localRefreshChartRows,
  parseArgs,
  refreshWindow,
  shouldRefreshChartRow
};
