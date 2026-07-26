#!/usr/bin/env node

const path = require('path');
const https = require('https');
const { atomicWriteJson } = require('./staging_writer');
const { withRetry } = require('./fetch_concurrency');
const {
  normalizeWeekAhead,
  rangeForDate
} = require('./week_ahead_contract');
const { addDays } = require('./calendar_contract');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'week_ahead.json');
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const TRADINGVIEW_ORIGIN = 'https://www.tradingview.com';
const TRADINGVIEW_ENDPOINT = 'https://economic-calendar.tradingview.com/events';

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    date: '',
    timeoutMs: REQUEST_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--output requires a path.');
      args.output = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--date') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--date requires an ISO date.');
      args.date = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      }
      args.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/fetch_week_ahead.js [options]\n\nOptions:\n  --output PATH       Staging payload path (default: generated/week_ahead.json)\n  --date YYYY-MM-DD   Local dashboard date used to select the displayed range\n  --timeout-ms 15000  HTTP timeout in milliseconds\n  --help              Show this help\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function dateFromArg(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T12:00:00Z`);
  const [year, month, day] = value.split('-').map(Number);
  return Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    ? null
    : date;
}

function tradingViewUrl(range) {
  const url = new URL(TRADINGVIEW_ENDPOINT);
  // TradingView timestamps are UTC. The padded UTC window is narrowed to the
  // five Eastern-market dates by the deterministic contract after retrieval.
  url.searchParams.set('from', `${addDays(range.from, -1)}T00:00:00.000Z`);
  url.searchParams.set('to', `${addDays(range.to, 2)}T00:00:00.000Z`);
  url.searchParams.set('countries', 'US');
  return url.toString();
}

function requestText(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        if (status < 200 || status >= 300) {
          const error = new Error(`TradingView calendar request failed with HTTP ${status}.`);
          error.status = status;
          error.headers = response.headers;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
    request.on('timeout', () => {
      const error = new Error('TradingView calendar request timed out.');
      error.transient = true;
      request.destroy(error);
    });
    request.on('error', (error) => {
      error.transient = true;
      reject(error);
    });
  });
}

async function requestTradingViewCalendar(range, timeoutMs, dependencies = {}) {
  const request = dependencies.requestText || requestText;
  const normalize = dependencies.normalizeWeekAhead || normalizeWeekAhead;
  const now = dependencies.now || new Date();
  return withRetry(
    async () => {
      const body = await request(tradingViewUrl(range), timeoutMs, {
        Accept: 'application/json',
        Origin: TRADINGVIEW_ORIGIN
      });
      let response;
      try {
        response = JSON.parse(body);
      } catch (_error) {
        const error = new Error('TradingView calendar returned invalid JSON.');
        error.providerPayload = true;
        throw error;
      }
      try {
        return normalize(response, { range, now });
      } catch (error) {
        error.providerPayload = true;
        throw error;
      }
    },
    {
      retries: REQUEST_RETRIES,
      delayMs: RETRY_DELAY_MS,
      sleep: dependencies.sleep,
      shouldRetryError: isRetryableTradingViewError
    }
  );
}

function isRetryableTradingViewError(error) {
  // Malformed provider payloads are retried here because TradingView is the
  // sole calendar source; a different source cannot repair the contract.
  if (error?.providerPayload === true || error?.transient === true) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status));
}

async function run(args = parseArgs(process.argv.slice(2)), dependencies = {}) {
  const date = args.date ? dateFromArg(args.date) : new Date();
  if (!date) throw new Error('--date must be a valid YYYY-MM-DD value.');
  const range = rangeForDate(date);
  const payload = await requestTradingViewCalendar(range, args.timeoutMs, dependencies);
  (dependencies.writePayload || atomicWriteJson)(args.output, payload);
  process.stdout.write(`Week Ahead fetched from TradingView: ${range.from} to ${range.to}; ${payload.sourceSummary.includedEvents} high/medium events.\n`);
  return payload;
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`fetch_week_ahead failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  REQUEST_RETRIES,
  TRADINGVIEW_ENDPOINT,
  TRADINGVIEW_ORIGIN,
  dateFromArg,
  isRetryableTradingViewError,
  parseArgs,
  requestText,
  requestTradingViewCalendar,
  run,
  tradingViewUrl
};
