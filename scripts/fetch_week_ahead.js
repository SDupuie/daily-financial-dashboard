#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const {
  fxMacroValueRequests,
  normalizeWeekAhead,
  rangeForDate,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const {
  BEA_SCHEDULE_URL,
  CENSUS_SCHEDULE_URL,
  buildOfficialSchedule
} = require('./week_ahead_official');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'week_ahead.json');
const REQUEST_TIMEOUT_MS = 15000;
const FX_MACRO_BASE_URL = 'https://api.fxmacrodata.com/v1';

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    date: '',
    timeoutMs: REQUEST_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[index + 1] || DEFAULT_OUTPUT);
      index += 1;
      continue;
    }
    if (arg === '--date') {
      args.date = argv[index + 1] || '';
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
      process.stdout.write(`Usage: node scripts/fetch_week_ahead.js [options]\n\nOptions:\n  --output PATH       Staging payload path (default: generated/week_ahead.json)\n  --date YYYY-MM-DD   Local dashboard date used to select the displayed week\n  --timeout-ms 15000  HTTP timeout in milliseconds\n  --help              Show this help\n`);
      process.exit(0);
    }
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

function requestText(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        if (status < 200 || status >= 300) {
          const error = new Error(`Request to ${new URL(url).hostname} failed with HTTP ${status}.`);
          error.status = status;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
    request.on('timeout', () => {
      const error = new Error(`Request to ${new URL(url).hostname} timed out.`);
      error.transient = true;
      request.destroy(error);
    });
    request.on('error', (error) => {
      // Socket and DNS failures can safely use a validated same-week cache; data
      // parsing and schedule-normalization errors are intentionally untagged.
      error.transient = true;
      reject(error);
    });
  });
}

async function requestJson(url, timeoutMs) {
  const body = await requestText(url, timeoutMs);
  try {
    return JSON.parse(body);
  } catch (_error) {
    throw new Error(`FXMacroData returned invalid JSON for ${new URL(url).pathname}.`);
  }
}

async function requestFxMacroValues(officialSchedule, timeoutMs) {
  const requests = fxMacroValueRequests(officialSchedule);
  const fetchEntries = async (kind, indicators) => {
    const responses = await Promise.all(indicators.map(async (indicator) => [
      indicator,
      await requestJson(`${FX_MACRO_BASE_URL}/${kind}/usd/${indicator}?limit=100`, timeoutMs)
    ]));
    return Object.fromEntries(responses);
  };
  const [announcements, predictions] = await Promise.all([
    fetchEntries('announcements', requests.announcements),
    fetchEntries('predictions', requests.predictions)
  ]);
  return { announcements, predictions };
}

function readCache(output, range, now) {
  if (!fs.existsSync(output)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(output, 'utf8'));
    const errors = validateWeekAheadPayload(cached);
    if (errors.length || cached.range?.from !== range.from || cached.range?.to !== range.to) return null;
    const fetchedAt = Date.parse(cached.source?.fetchedAt || '');
    if (!Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > 96 * 60 * 60 * 1000) return null;
    return {
      ...cached,
      generatedAt: now.toISOString(),
      source: { ...cached.source, status: 'cached' }
    };
  } catch (_error) {
    return null;
  }
}

function isTransient(error) {
  return error?.transient === true || error?.status === 429 || error?.status >= 500;
}

function writePayload(output, payload) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
}

async function run(args = parseArgs(process.argv.slice(2))) {
  const date = args.date ? dateFromArg(args.date) : new Date();
  if (!date) throw new Error('--date must be a valid YYYY-MM-DD value.');
  const range = rangeForDate(date);
  const now = new Date();
  try {
    const [censusHtml, beaHtml] = await Promise.all([
      requestText(CENSUS_SCHEDULE_URL, args.timeoutMs),
      requestText(BEA_SCHEDULE_URL, args.timeoutMs)
    ]);
    const officialSchedule = buildOfficialSchedule(range, { censusHtml, beaHtml, now });
    const valuePayload = await requestFxMacroValues(officialSchedule, args.timeoutMs);
    const payload = normalizeWeekAhead(valuePayload, { range, officialSchedule, now });
    writePayload(args.output, payload);
    process.stdout.write(`Week Ahead fetched: ${range.from} to ${range.to}; ${payload.sourceSummary.includedEvents} covered events.\n`);
    return payload;
  } catch (error) {
    // A fallback must still match the requested range and satisfy the same payload
    // contract; readCache rejects stale or malformed staging data before reuse.
    const cached = isTransient(error) ? readCache(args.output, range, now) : null;
    if (!cached) throw error;
    writePayload(args.output, cached);
    process.stdout.write(`Week Ahead cache used: ${range.from} to ${range.to}; ${cached.sourceSummary.includedEvents} covered events.\n`);
    return cached;
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`fetch_week_ahead failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  dateFromArg,
  isTransient,
  parseArgs,
  readCache,
  requestFxMacroValues,
  requestJson,
  requestText,
  run
};
