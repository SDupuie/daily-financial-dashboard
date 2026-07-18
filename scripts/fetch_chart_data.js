#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { atomicWriteJson } = require('./staging_writer');

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'chart_data.json');
const DEFAULT_DAYS = 1826;
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const FINNHUB_HOST = 'finnhub.io';
const CHART_ROW_CONCURRENCY = 4;
const TREASURY_FIELDS = new Map([
  ['TREASURY:CURVE', 'BC_10YEAR'],
  ['TREASURY:3M', 'BC_3MONTH'],
  ['TREASURY:2Y', 'BC_2YEAR'],
  ['TREASURY:10Y', 'BC_10YEAR'],
  ['TREASURY:30Y', 'BC_30YEAR']
]);
let envLoaded = false;
const TREASURY_CURVE_POINTS = [
  { label: '1M', field: 'BC_1MONTH', years: 1 / 12 },
  { label: '1.5M', field: 'BC_1_5MONTH', years: 1.5 / 12 },
  { label: '2M', field: 'BC_2MONTH', years: 2 / 12 },
  { label: '3M', field: 'BC_3MONTH', years: 3 / 12 },
  { label: '4M', field: 'BC_4MONTH', years: 4 / 12 },
  { label: '6M', field: 'BC_6MONTH', years: 0.5 },
  { label: '1Y', field: 'BC_1YEAR', years: 1 },
  { label: '2Y', field: 'BC_2YEAR', years: 2 },
  { label: '3Y', field: 'BC_3YEAR', years: 3 },
  { label: '5Y', field: 'BC_5YEAR', years: 5 },
  { label: '7Y', field: 'BC_7YEAR', years: 7 },
  { label: '10Y', field: 'BC_10YEAR', years: 10 },
  { label: '20Y', field: 'BC_20YEAR', years: 20 },
  { label: '30Y', field: 'BC_30YEAR', years: 30 }
];

// Intraday index futures use the same Yahoo chart provider but retain their
// separate staging payload and session-comparison rules behind a CLI subcommand.
const futuresModule = (() => {
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'futures_module.json');

// Staging helper only: production reads embedded futuresModule.futures from daily_financial_news.html.
const FUTURES = [
  { symbol: 'ES=F', label: 'S&P Futures', body: 'S&P 500 futures before the cash open.' },
  { symbol: 'NQ=F', label: 'Nasdaq Futures', body: 'Growth and AI tone before the cash open.' },
  { symbol: 'YM=F', label: 'Dow Futures', body: 'Blue-chip and defensive leadership read.' },
  { symbol: 'RTY=F', label: 'Russell Futures', body: 'Small-cap and domestic cyclicals read.' }
];
const FUTURES_MODES = new Set(['premarket', 'session']);

function isOffsetIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateFuturesPayload(payload, { expectedMode = '' } = {}) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Futures staging payload must be an object.'];
  }
  if (!isOffsetIsoTimestamp(payload.compiledAt)) errors.push('Futures staging compiledAt must be an offset-bearing ISO timestamp.');
  if (typeof payload.source !== 'string' || !payload.source.trim()) errors.push('Futures staging source must be populated.');
  if (!FUTURES_MODES.has(payload.mode)) errors.push('Futures staging mode must be premarket or session.');
  if (expectedMode && payload.mode !== expectedMode) errors.push(`Futures staging mode must be ${expectedMode} for this update window.`);
  const unavailable = payload.availability?.status === 'unavailable';
  const partial = payload.availability?.status === 'partial';
  if (payload.availability !== undefined) {
    if (!payload.availability || typeof payload.availability !== 'object' || Array.isArray(payload.availability)) {
      errors.push('Futures staging availability must be an object.');
    } else {
      if (!unavailable && !partial) errors.push('Futures staging availability.status must be partial or unavailable.');
      if (payload.availability.reason !== 'source_refresh_failed') errors.push('Futures staging availability.reason must be source_refresh_failed.');
      if (!isOffsetIsoTimestamp(payload.availability.checkedAt)) errors.push('Futures staging availability.checkedAt must be an offset-bearing ISO timestamp.');
    }
  }
  if (!Array.isArray(payload.futures)) {
    errors.push('Futures staging futures must be an array.');
    return errors;
  }
  if (unavailable) {
    if (payload.futures.length) errors.push('Unavailable Futures staging must contain no rows.');
    return errors;
  }
  if (payload.futures.length !== FUTURES.length) {
    errors.push(`Futures staging payload must contain exactly ${FUTURES.length} rows.`);
  }
  for (const [index, spec] of FUTURES.entries()) {
    const row = payload.futures[index];
    const label = `Futures staging futures[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (row.symbol !== spec.symbol) errors.push(`${label}.symbol must be ${spec.symbol}.`);
    if (row.availability?.status === 'unavailable') {
      if (typeof row.label !== 'string' || !row.label.trim()) errors.push(`${label}.label must be populated.`);
      if (row.value !== 'Unavailable') errors.push(`${label}.value must be Unavailable when the row is unavailable.`);
      if (typeof row.body !== 'string' || !row.body.trim()) errors.push(`${label}.body must explain unavailable data.`);
      continue;
    }
    for (const field of ['label', 'value', 'body']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) errors.push(`${label}.${field} must be populated.`);
    }
    if (!['up', 'down', 'flat'].includes(row.dir)) errors.push(`${label}.dir must be up, down, or flat.`);
    if (!Array.isArray(row.series) || row.series.length < 2) {
      errors.push(`${label}.series must contain at least two chart points.`);
    } else if (row.series.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[1] <= 0)) {
      errors.push(`${label}.series points must contain finite numeric times and positive prices.`);
    }
    if (!row.raw || typeof row.raw !== 'object' || Array.isArray(row.raw)) {
      errors.push(`${label}.raw must be an object.`);
      continue;
    }
    for (const field of ['price', 'regularMarketTime', 'referencePrice', 'previousClose', 'delta', 'pct']) {
      if (!Number.isFinite(row.raw[field])) errors.push(`${label}.raw.${field} must be numeric.`);
    }
    for (const field of ['price', 'referencePrice', 'previousClose']) {
      if (Number.isFinite(row.raw[field]) && row.raw[field] <= 0) errors.push(`${label}.raw.${field} must be positive.`);
    }
    if (payload.mode === 'session' && (!Number.isFinite(row.raw.sessionOpen) || row.raw.sessionOpen <= 0)) {
      errors.push(`${label}.raw.sessionOpen must be positive for Session Futures.`);
    }
    const expectedDir = row.raw.pct > 0 ? 'up' : row.raw.pct < 0 ? 'down' : 'flat';
    if (Number.isFinite(row.raw.pct) && row.dir !== expectedDir) errors.push(`${label}.dir must match raw.pct.`);
  }
  return errors;
}

function buildUnavailableFuturesPayload(mode, checkedAt = new Date()) {
  const timestamp = new Date(checkedAt).toISOString();
  return {
    compiledAt: timestamp,
    source: 'Yahoo Finance Chart API',
    mode,
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    },
    futures: []
  };
}

function unavailableFutureRow(spec, error, checkedAt = new Date()) {
  return {
    symbol: spec.symbol,
    label: spec.label,
    value: 'Unavailable',
    body: 'Current contract data is unavailable; retrying on the next update.',
    dir: 'flat',
    series: [],
    raw: {},
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: new Date(checkedAt).toISOString(),
      message: error?.message || String(error || 'source unavailable')
    }
  };
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    compact: false,
    mode: 'premarket'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--output requires a path.');
      args.output = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 1000) throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
      continue;
    }
    if (arg === '--session') {
      args.mode = 'session';
      continue;
    }
    if (arg === '--premarket') {
      args.mode = 'premarket';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_chart_data.js futures [options]

Options:
  --output PATH       JSON output path (default: generated/futures_module.json)
  --timeout-ms 10000  HTTP timeout in ms per request
  --compact           Print one-line symbol summary
  --session           Scope series to 8:30 AM-3:00 PM Central; store official times as 9:30 AM-4:00 PM Eastern
  --premarket         Use Yahoo's prior-close comparison (default)
  --help              Show this help
`);
}

function yahooChartUrl(symbol, args, rangeOverride = '') {
  const range = rangeOverride || (args.mode === 'session' ? '5d' : '1d');
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=5m`;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Daily-Financial-Dashboard/1.0'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function numberFormat(maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits });
}

function signedNumber(value) {
  const formatted = numberFormat(2).format(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function signedPct(value) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'always'
  }).format(value)}%`;
}

function timeText(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return 'Live update';
  return `Updated ${new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short'
  }).format(new Date(epochSeconds * 1000))}`;
}

function chicagoClockMinutes(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(seconds * 1000));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

function chicagoIsoDate(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(seconds * 1000));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function easternIsoDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isRegularSessionPoint(timestamp) {
  const minutes = chicagoClockMinutes(timestamp);
  return minutes !== null && minutes >= 8 * 60 + 30 && minutes <= 15 * 60;
}

function downsample(points, maxPoints = 72) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_value, index) => {
    const sourceIndex = Math.round(index * step);
    return points[sourceIndex];
  });
}

function parsePricePoints(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return timestamps.map((timestamp, index) => {
    const price = Number(closes[index]);
    return Number.isFinite(timestamp) && Number.isFinite(price) && price > 0
      ? [timestamp, price]
      : null;
  }).filter(Boolean);
}

function withLatestQuotePoint(points, quoteTime, quotePrice) {
  const normalized = Array.isArray(points) ? points.slice() : [];
  if (!Number.isFinite(quoteTime) || !Number.isFinite(quotePrice) || quotePrice <= 0) {
    return normalized;
  }
  if (!normalized.length) {
    return [[quoteTime, quotePrice]];
  }

  const lastPoint = normalized[normalized.length - 1];
  const lastTime = Number(lastPoint?.[0]);
  if (!Number.isFinite(lastTime)) {
    normalized.push([quoteTime, quotePrice]);
    return normalized;
  }
  if (quoteTime > lastTime) {
    normalized.push([quoteTime, quotePrice]);
    return normalized;
  }
  if (quoteTime === lastTime) {
    normalized[normalized.length - 1] = [quoteTime, quotePrice];
  }
  return normalized;
}

function easternCashOpen(runAt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(runAt);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const targetUtc = Date.UTC(year, month - 1, day, 9, 30);
  const observed = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(new Date(targetUtc));
  const observedValue = (type) => Number(observed.find((part) => part.type === type)?.value);
  const targetLocalMs = Date.UTC(year, month - 1, day, 9, 30);
  const observedLocalMs = Date.UTC(
    observedValue('year'),
    observedValue('month') - 1,
    observedValue('day'),
    observedValue('hour'),
    observedValue('minute')
  );
  return new Date(targetUtc + targetLocalMs - observedLocalMs);
}

function premarketCutoff(runAt) {
  const runTime = runAt instanceof Date ? runAt : new Date(runAt);
  if (Number.isNaN(runTime.getTime())) throw new Error('Premarket run time must be a valid date.');
  const cashOpen = easternCashOpen(runTime);
  return new Date(Math.min(runTime.getTime(), cashOpen.getTime()));
}

function regularSessionComparison(points, symbol) {
  const sessions = new Map();
  for (const point of points) {
    const [timestamp] = point;
    if (!isRegularSessionPoint(timestamp)) continue;
    const date = chicagoIsoDate(timestamp);
    if (!date) continue;
    if (!sessions.has(date)) sessions.set(date, []);
    sessions.get(date).push(point);
  }

  const sessionDates = [...sessions.keys()].sort().filter((date) => sessions.get(date).length >= 2);
  if (sessionDates.length < 2) {
    throw new Error(`${symbol} response did not include at least two regular-session windows`);
  }

  const sessionDate = sessionDates[sessionDates.length - 1];
  const referenceDate = sessionDates[sessionDates.length - 2];
  const sessionPoints = sessions.get(sessionDate);
  const referencePoint = sessions.get(referenceDate).at(-1);
  if (!sessionPoints?.length || !referencePoint) {
    throw new Error(`${symbol} response did not include usable regular-session comparison points`);
  }

  return {
    sessionDate,
    sessionPoints,
    referenceDate,
    referenceTime: referencePoint[0],
    referencePrice: referencePoint[1]
  };
}

function latestRegularSessionClose(points, symbol, latestTimestamp = Number.POSITIVE_INFINITY, beforeDate = '') {
  const cutoffTimestamp = Number.isFinite(latestTimestamp)
    ? latestTimestamp
    : Number.POSITIVE_INFINITY;
  const sessions = new Map();
  for (const point of points) {
    const [timestamp] = point;
    if (timestamp > cutoffTimestamp) continue;
    if (!isRegularSessionPoint(timestamp)) continue;
    const date = chicagoIsoDate(timestamp);
    if (beforeDate && date >= beforeDate) continue;
    if (!date) continue;
    if (!sessions.has(date)) sessions.set(date, []);
    sessions.get(date).push(point);
  }

  const referenceDate = [...sessions.keys()].sort().at(-1);
  const referencePoint = referenceDate ? sessions.get(referenceDate)?.at(-1) : null;
  if (!referencePoint) {
    throw new Error(`${symbol} response did not include a usable prior regular-session close`);
  }
  return {
    referenceDate,
    referenceTime: referencePoint[0]
  };
}

function scheduledNow() {
  const override = process.env.SCHEDULED_NOW_ISO;
  const parsed = override ? new Date(override) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseFuture(spec, payload, args, referencePayload = null, runAt = new Date()) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const previousClose = Number(meta?.chartPreviousClose);
  const quotePrice = Number(meta?.regularMarketPrice);
  const quoteTime = Number(meta?.regularMarketTime);
  if (!Number.isFinite(quotePrice) || !Number.isFinite(previousClose)) {
    throw new Error(`${spec.symbol} response was missing price metadata`);
  }

  const pricePoints = parsePricePoints(payload);
  const sessionComparison = args.mode === 'session'
    ? regularSessionComparison(pricePoints, spec.symbol)
    : null;
  const cutoff = args.mode === 'premarket' ? premarketCutoff(runAt) : null;
  const premarketReference = args.mode === 'premarket'
    ? latestRegularSessionClose(parsePricePoints(referencePayload), spec.symbol, cutoff?.getTime() / 1000, easternIsoDate(runAt))
    : null;
  const boundedPricePoints = cutoff
    ? pricePoints.filter(([timestamp]) => timestamp <= cutoff.getTime() / 1000)
    : pricePoints;
  const boundedQuoteTime = cutoff && quoteTime > cutoff.getTime() / 1000 ? null : quoteTime;
  const comparisonPoints = sessionComparison
    ? sessionComparison.sessionPoints
    : withLatestQuotePoint(boundedPricePoints, boundedQuoteTime, quotePrice);
  if (comparisonPoints.length < 2) {
    throw new Error(`${spec.symbol} response did not include at least two chart points`);
  }

  const referencePrice = sessionComparison ? sessionComparison.referencePrice : previousClose;
  const price = comparisonPoints.at(-1)[1];
  const regularMarketTime = comparisonPoints.at(-1)[0];
  const referenceLabel = args.mode === 'session' ? 'prior 4 PM ET close' : 'prior close';
  const delta = price - referencePrice;
  const pct = referencePrice ? (delta / referencePrice) * 100 : 0;

  return {
    label: spec.label,
    symbol: spec.symbol,
    value: signedPct(pct),
    dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    body: `${numberFormat(2).format(price)} last · ${signedNumber(delta)} vs ${referenceLabel} · ${timeText(regularMarketTime)}`,
    series: downsample(comparisonPoints),
    raw: {
      instrumentType: meta?.instrumentType || null,
      exchangeName: meta?.exchangeName || null,
      ...(sessionComparison || premarketReference ? {
        marketTimeZone: 'America/New_York'
      } : {}),
      price,
      regularMarketTime: Number(regularMarketTime) || null,
      referencePrice,
      referenceLabel,
      ...(sessionComparison || premarketReference ? {
        referenceDate: sessionComparison?.referenceDate || premarketReference.referenceDate,
        referenceTime: sessionComparison?.referenceTime || premarketReference.referenceTime,
        referenceCloseEastern: '4:00 PM ET'
      } : {}),
      quotePrice: price,
      quoteTime: Number.isFinite(regularMarketTime) ? regularMarketTime : null,
      previousClose,
      ...(sessionComparison ? {
        sessionDate: sessionComparison.sessionDate,
        sessionStartEastern: '9:30 AM ET',
        sessionEndEastern: '4:00 PM ET',
        sessionOpen: comparisonPoints[0][1],
        sessionOpenTime: comparisonPoints[0][0]
      } : {}),
      delta,
      pct
    }
  };
}

async function fetchFuture(spec, args, runAt = new Date()) {
  const payloadPromise = fetchJson(yahooChartUrl(spec.symbol, args), args.timeoutMs);
  const referencePayloadPromise = args.mode === 'premarket'
    ? fetchJson(yahooChartUrl(spec.symbol, args, '5d'), args.timeoutMs)
    : Promise.resolve(null);
  const [payload, referencePayload] = await Promise.all([payloadPromise, referencePayloadPromise]);
  return parseFuture(spec, payload, args, referencePayload, runAt);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const checkedAt = dependencies.now instanceof Date ? dependencies.now : scheduledNow();
  const settled = await Promise.allSettled(FUTURES.map((spec) => (dependencies.fetchFuture || fetchFuture)(spec, args, checkedAt)));
  const failures = [];
  const results = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    failures.push({ symbol: FUTURES[index].symbol, message: result.reason?.message || 'source unavailable' });
    return unavailableFutureRow(FUTURES[index], result.reason, checkedAt);
  });
  // Output is a staging payload; the published page renders embedded futuresModule.futures only.
  const output = {
    compiledAt: checkedAt.toISOString(),
    source: 'Yahoo Finance Chart API',
    mode: args.mode,
    ...(failures.length ? {
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: checkedAt.toISOString(),
        failures
      }
    } : {}),
    futures: results
  };
  const errors = validateFuturesPayload(output, { expectedMode: args.mode });
  if (errors.length) throw new Error(`Generated Futures staging payload is invalid: ${errors.join(' ')}`);

  (dependencies.writeJson || atomicWriteJson)(args.output, output);

  if (args.compact) {
    process.stdout.write(results.map((row) => `${row.symbol} ${row.value}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output}\n`);
  }
}

  return {
    buildUnavailableFuturesPayload,
    easternCashOpen,
    parseArgs,
    parseFuture,
    premarketCutoff,
    run: main,
    scheduledNow,
    validateFuturesPayload
  };
})();

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    days: DEFAULT_DAYS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    delayMs: 250,
    asOf: null,
    tickers: [],
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--input requires a path.');
      args.input = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--output requires a path.');
      args.output = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--days') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 5) throw new Error('--days must be a finite number of at least 5 days.');
      args.days = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 1000) throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--as-of') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--as-of requires an ISO timestamp.');
      args.asOf = new Date(argv[i + 1]);
      if (Number.isNaN(args.asOf.getTime())) throw new Error('--as-of must be a valid ISO timestamp.');
      i += 1;
      continue;
    }
    if (arg === '--delay-ms') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 0) throw new Error('--delay-ms must be a finite nonnegative number.');
      args.delayMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--ticker') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--ticker requires a symbol.');
      args.tickers.push(String(argv[i + 1]).trim().toUpperCase());
      i += 1;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
      continue;
    }
    if (arg === '--embed-compact' || arg === '--embed-source') {
      throw new Error('Direct dashboard writes are not supported; use run_daily_update.js --apply-chart-data-json or --sync-chart-quotes.');
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_chart_data.js [options]
       node scripts/fetch_chart_data.js futures [options]

Options:
  --input PATH        Dashboard HTML to read (default: daily_financial_news.html)
  --output PATH       Unified chart JSON output path (default: generated/chart_data.json)
  --days 1826         Calendar days of daily history to request
  --timeout-ms 15000  HTTP timeout in ms per request
  --as-of TIMESTAMP   Fixed run timestamp used as generatedAt and quoteRevision
  --delay-ms 250      Delay between source requests
  --ticker SYMBOL     Fetch only this dashboard ticker (repeatable)
  --compact           Print one-line series summary
  --help              Show this help
`);
}

function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1') return;
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function readDashboardData(input) {
  const html = fs.readFileSync(input, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${input}`);
  }
  return JSON.parse(match[1]);
}

function readTapeRows(input) {
  const data = readDashboardData(input);
  const rows = Array.isArray(data.tape?.rows) ? data.tape.rows : [];
  if (!rows.length) {
    throw new Error('dashboard-data tape.rows is empty or missing');
  }
  // sourceSymbol is the single dashboard-owned routing key for quote refreshes and embedded chart history.
  // Crypto tickers share the canonical tape.rows contract, but keep their crypto quoteRows shape below.
  return rows.map((row, index) => ({
    index,
    section: 'tape',
    quoteShape: 'tape',
    group: String(row?.group || '').trim(),
    name: String(row?.name || '').trim(),
    ticker: String(row?.ticker || '').trim().toUpperCase(),
    sourceSymbol: String(row?.sourceSymbol || '').trim(),
    note: String(row?.note || '').trim()
  })).filter((row) => row.ticker && row.sourceSymbol && row.group !== 'Crypto');
}

function readCryptoRows(input) {
  const data = readDashboardData(input);
  const rows = Array.isArray(data.tape?.rows) ? data.tape.rows : [];
  // chart-data.quoteRows.crypto uses price/chg because the crypto refresh formatter predates the Tape merge.
  return rows.map((row, index) => {
    const ticker = String(row?.ticker || '').trim().toUpperCase();
    return {
      index,
      section: 'crypto',
      quoteShape: 'crypto',
      group: String(row?.group || '').trim(),
      name: String(row?.name || ticker).trim(),
      ticker,
      sourceSymbol: String(row?.sourceSymbol || '').trim(),
      note: String(row?.note || '').trim()
    };
  }).filter((row) => row.ticker && row.sourceSymbol && row.group === 'Crypto');
}

function readChartableRows(input) {
  return [...readTapeRows(input), ...readCryptoRows(input)];
}

function readEmbeddedChartPayload(input) {
  try {
    const html = fs.readFileSync(input, 'utf8');
    const match = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
    if (!match) return null;
    const payload = roundChartPayload(JSON.parse(match[1]));
    return Array.isArray(payload.series) ? payload : null;
  } catch (_error) {
    return null;
  }
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

function monthKeysBetween(startDate, endDate) {
  const keys = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const endKey = endDate.getUTCFullYear() * 100 + endDate.getUTCMonth() + 1;
  while ((cursor.getUTCFullYear() * 100 + cursor.getUTCMonth() + 1) <= endKey) {
    keys.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

function fetchText(url, args, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Daily-Financial-Dashboard/1.0',
        'Accept': 'application/json,text/xml,application/xml,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
        ...headers
      }
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

async function fetchJson(url, args, headers) {
  const text = await fetchText(url, args, headers);
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

function finnhubQuoteUrl(symbol, token) {
  const params = new URLSearchParams({
    symbol,
    token
  });
  return `https://${FINNHUB_HOST}/api/v1/quote?${params.toString()}`;
}

function treasuryXmlUrl(monthKey) {
  const params = new URLSearchParams({
    data: 'daily_treasury_yield_curve',
    field_tdr_date_value_month: monthKey
  });
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?${params.toString()}`;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fourDecimalNumber(value) {
  const numeric = asFiniteNumber(value);
  if (numeric === null) return null;
  const scale = 10 ** 4;
  const epsilon = Math.sign(numeric || 1) * Number.EPSILON * Math.max(1, Math.abs(numeric));
  return Math.round((numeric + epsilon) * scale) / scale;
}

function objectBar(bar) {
  if (Array.isArray(bar)) {
    const [time, open, high, low, close, volume] = bar;
    return {
      time,
      open,
      high,
      low,
      close,
      ...(volume === null || volume === undefined ? {} : { volume })
    };
  }
  return bar && typeof bar === 'object' ? bar : {};
}

function compactChartBar(rawBar) {
  const bar = objectBar(rawBar);
  return [
    String(bar.time || ''),
    fourDecimalNumber(bar.open),
    fourDecimalNumber(bar.high),
    fourDecimalNumber(bar.low),
    fourDecimalNumber(bar.close),
    Number.isFinite(Number(bar.volume)) ? Math.round(Number(bar.volume)) : null
  ];
}

function roundChartPayload(payload) {
  return {
    ...payload,
    series: (Array.isArray(payload?.series) ? payload.series : []).map((series) => ({
      ...series,
      bars: (Array.isArray(series?.bars) ? series.bars : []).map((rawBar) => {
        const bar = objectBar(rawBar);
        return {
          time: String(bar.time || ''),
          open: fourDecimalNumber(bar.open),
          high: fourDecimalNumber(bar.high),
          low: fourDecimalNumber(bar.low),
          close: fourDecimalNumber(bar.close),
          ...(Number.isFinite(Number(bar.volume)) ? { volume: Math.round(Number(bar.volume)) } : {})
        };
      })
    }))
  };
}

function compactChartPayload(payload) {
  const rounded = roundChartPayload(payload);
  return {
    ...rounded,
    barEncoding: 'tuple-v1',
    series: rounded.series.map((series) => ({
      ...series,
      bars: series.bars.map(compactChartBar)
    }))
  };
}

function buildChartDataFallback(canonicalChartData, checkedAt = new Date()) {
  const timestamp = new Date(checkedAt).toISOString();
  return {
    ...roundChartPayload(canonicalChartData),
    availability: {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    }
  };
}

function carriedForwardChartSeries(prior, checkedAt) {
  return {
    ...prior,
    availability: {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt
    }
  };
}

function acceptedFreshChartTickers(payload) {
  if (payload?.availability?.status === 'carried_forward') return [];
  return (Array.isArray(payload?.series) ? payload.series : [])
    .filter((series) => !['carried_forward', 'unavailable'].includes(series?.availability?.status))
    .map((series) => String(series?.ticker || '').trim().toUpperCase())
    .filter(Boolean);
}

function isChartQuoteRevision(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateChartStagingPayload(payload, expectedRows = []) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Chart staging payload must be an object.'];
  if (payload.schemaVersion !== 1) errors.push('Chart staging schemaVersion must be 1.');
  if (!Array.isArray(payload.series)) return [...errors, 'Chart staging series must be an array.'];
  const byTicker = new Map();
  for (const [index, item] of payload.series.entries()) {
    const ticker = String(item?.ticker || '').trim().toUpperCase();
    if (!ticker) errors.push(`Chart staging series[${index}].ticker must be populated.`);
    else if (byTicker.has(ticker)) errors.push(`Chart staging series contains duplicate ticker ${ticker}.`);
    else byTicker.set(ticker, item);
    if (!isChartQuoteRevision(item?.quoteRevision)) errors.push(`Chart staging ${ticker || `series[${index}]`}.quoteRevision must be an offset-bearing ISO timestamp.`);
    if (item?.availability !== undefined) {
      if (!item.availability || typeof item.availability !== 'object' || Array.isArray(item.availability)) {
        errors.push(`Chart staging ${ticker || `series[${index}]`}.availability must be an object.`);
      } else {
        if (item.availability.status !== 'carried_forward') errors.push(`Chart staging ${ticker || `series[${index}]`}.availability.status must be carried_forward.`);
        if (item.availability.reason !== 'source_refresh_failed') errors.push(`Chart staging ${ticker || `series[${index}]`}.availability.reason must be source_refresh_failed.`);
        if (!isChartQuoteRevision(item.availability.checkedAt)) errors.push(`Chart staging ${ticker || `series[${index}]`}.availability.checkedAt must be an offset-bearing ISO timestamp.`);
        if (item.availability.failures !== undefined) errors.push(`Chart staging ${ticker || `series[${index}]`}.availability.failures is not allowed.`);
      }
    }
    if (!Array.isArray(item?.bars) || item.bars.length < 2) errors.push(`Chart staging ${ticker || `series[${index}]`} must contain at least two bars.`);
  }
  for (const row of expectedRows) {
    const ticker = String(row?.ticker || '').trim().toUpperCase();
    if (ticker && !byTicker.has(ticker)) errors.push(`Chart staging series is missing ${ticker}.`);
  }
  const availability = payload.availability;
  const carriedTickers = new Set(
    [...byTicker.entries()]
      .filter(([, item]) => item?.availability?.status === 'carried_forward')
      .map(([ticker]) => ticker)
  );
  if (availability === undefined) {
    for (const ticker of carriedTickers) errors.push(`Chart staging carried-forward series ${ticker} requires partial availability diagnostics.`);
  } else if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    errors.push('Chart staging availability must be an object.');
  } else {
    if (!['partial', 'carried_forward'].includes(availability.status)) errors.push('Chart staging availability.status must be partial or carried_forward.');
    if (availability.reason !== 'source_refresh_failed') errors.push('Chart staging availability.reason must be source_refresh_failed.');
    if (!isChartQuoteRevision(availability.checkedAt)) errors.push('Chart staging availability.checkedAt must be an offset-bearing ISO timestamp.');
    if (availability.status === 'partial') {
      if (!Array.isArray(availability.failures) || !availability.failures.length) {
        errors.push('Chart staging partial availability.failures must be a non-empty array.');
      } else {
        const failureTickers = new Set();
        availability.failures.forEach((failure, index) => {
          const ticker = String(failure?.ticker || '').trim().toUpperCase();
          if (!ticker) errors.push(`Chart staging availability.failures[${index}].ticker must be populated.`);
          else if (failureTickers.has(ticker)) errors.push(`Chart staging availability.failures contains duplicate ticker ${ticker}.`);
          else failureTickers.add(ticker);
          if (typeof failure?.message !== 'string' || !failure.message.trim()) errors.push(`Chart staging availability.failures[${index}].message must be populated.`);
          if (ticker && !byTicker.has(ticker)) errors.push(`Chart staging availability failure names unknown ticker ${ticker}.`);
          else if (ticker && !carriedTickers.has(ticker)) errors.push(`Chart staging availability failure ${ticker} must identify a carried_forward series.`);
        });
        for (const ticker of carriedTickers) {
          if (!failureTickers.has(ticker)) errors.push(`Chart staging carried_forward series ${ticker} must have a matching availability failure.`);
        }
      }
    } else if (availability.failures !== undefined) {
      errors.push('Chart staging carried_forward availability.failures is not allowed.');
    }
  }
  try {
    deriveQuoteRowsFromSeries(payload.series);
  } catch (error) {
    errors.push(`Chart staging quote derivation failed: ${error.message}`);
  }
  return errors;
}

function sortBars(bars) {
  return bars.sort((a, b) => a.time.localeCompare(b.time));
}

function uniqueBars(bars) {
  const byDate = new Map();
  for (const bar of bars) {
    byDate.set(bar.time, bar);
  }
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

function supportsFinnhubQuote(row) {
  // Finnhub quote fallback is only for plain U.S. symbols; pseudo-sources, futures, Treasury, and crypto stay on their native fetch paths.
  return row?.section !== 'crypto' && /^[A-Z][A-Z0-9.]*$/.test(String(row?.sourceSymbol || ''));
}

function finnhubQuoteToken() {
  loadEnv();
  return String(process.env.FINNHUB_API_KEY || '').trim();
}

function finnhubQuoteBarFromPayload(payload) {
  const open = asFiniteNumber(payload?.o);
  const high = asFiniteNumber(payload?.h);
  const low = asFiniteNumber(payload?.l);
  const close = asFiniteNumber(payload?.c);
  const timestamp = asFiniteNumber(payload?.t);
  if (!timestamp || !isUsableOhlc(open, high, low, close)) return null;
  return {
    time: isoDateFromEpochSeconds(timestamp),
    open,
    high,
    low,
    close,
    latestQuoteSource: 'Finnhub Quote API'
  };
}

async function fetchFinnhubQuoteBar(row, args) {
  const token = finnhubQuoteToken();
  if (!token || !supportsFinnhubQuote(row)) return null;
  try {
    const payload = await fetchJson(finnhubQuoteUrl(row.sourceSymbol, token), args, {
      'Accept': 'application/json'
    });
    return finnhubQuoteBarFromPayload(payload);
  } catch (_error) {
    return null;
  }
}

function mergeFinnhubQuoteBar(series, quoteBar, volumeByDate = null) {
  if (!quoteBar || !Array.isArray(series?.bars) || series.priceOnly || series.dataKind !== 'ohlc') return series;
  const bars = [...series.bars];
  const lastIndex = bars.length - 1;
  const latest = bars[lastIndex];
  if (!latest || quoteBar.time < latest.time) return series;

  // Finnhub quote repairs OHLC only; keep Yahoo's same-date volume when Yahoo supplied it in the raw payload.
  const yahooVolume = volumeByDate?.get?.(quoteBar.time);
  const existingVolume = quoteBar.time === latest.time ? latest.volume : yahooVolume;
  const mergedQuoteBar = existingVolume === undefined ? quoteBar : { ...quoteBar, volume: existingVolume };
  if (quoteBar.time === latest.time) {
    bars[lastIndex] = mergedQuoteBar;
  } else {
    bars.push(mergedQuoteBar);
  }

  return {
    ...series,
    source: series.source === 'Yahoo Finance Chart API'
      ? 'Yahoo Finance Chart API + Finnhub Quote API'
      : series.source,
    latestQuoteSource: 'Finnhub Quote API',
    bars: uniqueBars(bars)
  };
}

function yahooLatestCloseDate(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close
    : [];
  for (let index = timestamps.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(Number(timestamps[index])) && asFiniteNumber(closes[index]) !== null) {
      return isoDateFromEpochSeconds(timestamps[index]);
    }
  }
  return '';
}

function shouldUseFinnhubQuoteFallback(series, yahooPayload) {
  if (!Array.isArray(series?.bars) || series.priceOnly || series.dataKind !== 'ohlc') return false;
  const seriesLatestDate = String(series.bars.at(-1)?.time || '');
  const yahooLatestDate = yahooLatestCloseDate(yahooPayload);
  // Call Finnhub only when Yahoo exposed a newer close than the usable OHLC bars we could build.
  // This catches malformed latest Yahoo candles without making Finnhub a second quote authority.
  return Boolean(seriesLatestDate && yahooLatestDate && yahooLatestDate > seriesLatestDate);
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

function signedBasisPoints(value) {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded} bp`;
  if (rounded < 0) return `${rounded} bp`;
  return '0 bp';
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

function treasuryCurveSpreadBpFromEntry(entry) {
  const twoYear = asFiniteNumber(entry?.BC_2YEAR);
  const tenYear = asFiniteNumber(entry?.BC_10YEAR);
  return twoYear === null || tenYear === null ? null : (tenYear - twoYear) * 100;
}

function treasuryCurveSpreadMetric(latestEntry, previousEntry, comparisonLabel) {
  const valueBp = treasuryCurveSpreadBpFromEntry(latestEntry);
  if (valueBp === null) return null;
  const previousValueBp = treasuryCurveSpreadBpFromEntry(previousEntry);
  return {
    label: '2s10s',
    valueBp,
    previousValueBp,
    deltaBp: previousValueBp === null ? null : valueBp - previousValueBp,
    comparison: comparisonLabel
  };
}

function quoteRowFromSeries(item) {
  const bars = item.bars || [];
  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  if (!latest || !previous) {
    throw new Error(`${item.ticker} response did not include enough bars for quote fields`);
  }

  const delta = latest.close - previous.close;
  const pct = previous.close ? (delta / previous.close) * 100 : 0;
  const isYield = item.unit === 'percent_yield';
  if (item.sourceSymbol === 'TREASURY:CURVE' && item.curveSpread?.label && Number.isFinite(item.curveSpread.valueBp)) {
    const deltaBp = item.curveSpread.deltaBp;
    return {
      name: item.name,
      ticker: item.ticker,
      last: `${item.curveSpread.label} ${signedBasisPoints(item.curveSpread.valueBp)}`,
      delta: Number.isFinite(deltaBp) ? signedBasisPoints(deltaBp) : 'n/a',
      pct: item.curveSpread.comparison || '1D',
      dir: Number.isFinite(deltaBp) ? direction(deltaBp) : 'flat',
      note: item.note,
      sourceSymbol: item.sourceSymbol,
      asOf: latest.time
    };
  }
  return {
    name: item.name,
    ticker: item.ticker,
    last: isYield ? `${numberFormat(latest.close, 2)}%` : numberFormat(latest.close, 2),
    delta: signedNumber(delta),
    pct: signedPct(pct),
    dir: direction(pct),
    note: item.note,
    sourceSymbol: item.sourceSymbol,
    asOf: latest.time
  };
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

function deriveQuoteRowsFromSeries(series) {
  // Keep every downstream price view reproducible from the canonical series payload rather than
  // letting quoteRows drift into a separately maintained market-data store.
  const tape = [];
  const crypto = [];
  for (const item of Array.isArray(series) ? series : []) {
    if (item?.section === 'crypto') {
      crypto.push(cryptoQuoteRowFromSeries(item));
      continue;
    }
    tape.push(quoteRowFromSeries(item));
  }
  return { tape, crypto };
}

async function fetchYahooSeries(row, args, startDate, endDate) {
  const errors = [];
  // Yahoo occasionally fails one chart host while the other is healthy, so keep both as equivalent fallbacks.
  for (const host of YAHOO_HOSTS) {
    try {
      const payload = await fetchJson(yahooChartUrl(host, row.sourceSymbol, startDate, endDate), args);
      const series = parseYahooSeries(row, payload, host);
      const quoteBar = shouldUseFinnhubQuoteFallback(series, payload)
        ? await fetchFinnhubQuoteBar(row, args)
        : null;
      return mergeFinnhubQuoteBar(series, quoteBar, yahooVolumeByDate(payload));
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

function yahooVolumeByDate(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const volumes = Array.isArray(result?.indicators?.quote?.[0]?.volume)
    ? result.indicators.quote[0].volume
    : [];
  return new Map(timestamps.map((timestamp, index) => {
    const volume = asFiniteNumber(volumes[index]);
    return Number.isFinite(timestamp) && volume !== null
      ? [isoDateFromEpochSeconds(timestamp), volume]
      : null;
  }).filter(Boolean));
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
    if (hasRealVolume && point.volume !== null) {
      bar.volume = point.volume;
    }
    return bar;
  }).filter(Boolean);

  if (!bars.length) {
    throw new Error(`${row.sourceSymbol} response did not include usable daily bars`);
  }

  return {
    ...seriesBase(row),
    source: 'Yahoo Finance Chart API',
    sourceKey: 'yahoo_chart',
    fetchedFrom: host,
    dataKind: priceOnly ? 'close' : 'ohlc',
    priceOnly,
    noVolume: !hasRealVolume,
    currency: result.meta?.currency || null,
    exchangeTimezoneName: result.meta?.exchangeTimezoneName || null,
    bars: uniqueBars(bars)
  };
}

async function fetchTreasurySeries(row, args, startDate, endDate, treasuryMonthCache) {
  const field = TREASURY_FIELDS.get(row.sourceSymbol);
  if (!field) {
    throw new Error(`Unsupported Treasury sourceSymbol ${row.sourceSymbol}`);
  }

  const monthKeys = monthKeysBetween(startDate, endDate);
  const monthEntries = [];
  for (const monthKey of monthKeys) {
    if (!treasuryMonthCache.has(monthKey)) {
      // Treasury serves yield-curve data one month at a time; cache the parsed month for 10Y and 30Y rows.
      const xml = await fetchText(treasuryXmlUrl(monthKey), args);
      treasuryMonthCache.set(monthKey, parseTreasuryXml(xml));
      if (args.delayMs) await sleep(args.delayMs);
    }
    monthEntries.push(...treasuryMonthCache.get(monthKey));
  }

  const filteredEntries = monthEntries.filter((entry) => (
    entry.time && entry.time >= isoDateFromDate(startDate) && entry.time <= isoDateFromDate(endDate)
  )).sort((a, b) => a.time.localeCompare(b.time));
  const bars = filteredEntries.map((entry) => {
    const close = asFiniteNumber(entry[field]);
    return entry.time && close !== null ? closeOnlyBar(entry.time, close) : null;
  }).filter(Boolean);

  if (!bars.length) {
    throw new Error(`${row.sourceSymbol} response did not include usable Treasury yield history`);
  }

  const latestCurveEntry = row.sourceSymbol === 'TREASURY:CURVE' ? filteredEntries.at(-1) : null;
  const previousDailyCurveEntry = row.sourceSymbol === 'TREASURY:CURVE'
    ? filteredEntries.filter((entry) => entry.time && entry.time < latestCurveEntry?.time).at(-1)
    : null;
  // Treasury skips weekends and holidays, so comparison snapshots use the nearest available curve date.
  const comparisonCurveEntries = row.sourceSymbol === 'TREASURY:CURVE'
    ? [
        { label: '1M ago', entry: treasuryCurveEntryNearMonthsAgo(filteredEntries, latestCurveEntry?.time, 1) },
        { label: '6M ago', entry: treasuryCurveEntryNearMonthsAgo(filteredEntries, latestCurveEntry?.time, 6) }
      ].filter((comparison) => comparison.entry)
    : null;
  const curve = latestCurveEntry ? treasuryCurvePointsFromEntry(latestCurveEntry) : [];
  if (row.sourceSymbol === 'TREASURY:CURVE' && curve.length < 2) {
    throw new Error(`${row.sourceSymbol} response did not include usable Treasury curve points`);
  }

  const series = {
    ...seriesBase(row),
    source: 'Treasury.gov Daily Treasury Yield Curve Rate Data',
    sourceKey: 'treasury_yield_curve',
    dataKind: 'close',
    priceOnly: true,
    noVolume: true,
    unit: 'percent_yield',
    exchangeTimezoneName: null,
    bars: uniqueBars(bars)
  };
  if (curve.length) {
    series.curveDate = latestCurveEntry.time;
    series.curvePoints = curve;
    series.comparisonCurves = comparisonCurveEntries.map((comparison) => ({
      label: comparison.label,
      date: comparison.entry.time,
      points: treasuryCurvePointsFromEntry(comparison.entry)
    }));
    series.curveSpread = treasuryCurveSpreadMetric(latestCurveEntry, previousDailyCurveEntry, '1D');
  }
  return series;
}

function isoDateMonthsAgo(isoDate, months) {
  const source = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(source.getTime())) return null;
  const targetMonth = source.getUTCMonth() - months;
  const target = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return isoDateFromDate(target);
}

function treasuryCurveEntryNearMonthsAgo(entries, latestIsoDate, months) {
  const targetIsoDate = latestIsoDate ? isoDateMonthsAgo(latestIsoDate, months) : null;
  if (!targetIsoDate) return null;
  const targetTime = new Date(`${targetIsoDate}T00:00:00Z`).getTime();
  return entries
    .filter((entry) => entry.time && entry.time < latestIsoDate)
    .reduce((best, entry) => {
      const distance = Math.abs(new Date(`${entry.time}T00:00:00Z`).getTime() - targetTime);
      if (!best || distance < best.distance) return { entry, distance };
      if (distance === best.distance && entry.time < best.entry.time) return { entry, distance };
      return best;
    }, null)?.entry || null;
}

function parseTreasuryXml(xml) {
  const entries = [];
  const propertyBlocks = xml.match(/<m:properties>[\s\S]*?<\/m:properties>/g) || [];
  for (const block of propertyBlocks) {
    const time = extractXmlField(block, 'NEW_DATE')?.slice(0, 10) || null;
    const entry = { time };
    for (const point of TREASURY_CURVE_POINTS) {
      entry[point.field] = extractXmlField(block, point.field);
    }
    entries.push(entry);
  }
  return entries.filter((entry) => entry.time);
}

function treasuryCurvePointsFromEntry(entry) {
  return TREASURY_CURVE_POINTS.map((point) => {
    const value = asFiniteNumber(entry[point.field]);
    return value === null ? null : {
      label: point.label,
      years: point.years,
      value
    };
  }).filter(Boolean);
}

function extractXmlField(block, field) {
  const pattern = new RegExp(`<d:${field}(?:\\s[^>]*)?>([^<]*)<\\/d:${field}>`);
  const match = block.match(pattern);
  return match ? match[1] : null;
}

function seriesBase(row) {
  return {
    ticker: row.ticker,
    name: row.name,
    section: row.section || 'tape',
    sourceSymbol: row.sourceSymbol,
    note: row.note
  };
}

async function fetchSeries(row, args, startDate, endDate, treasuryMonthCache) {
  if (row.sourceSymbol.startsWith('TREASURY:')) {
    return fetchTreasurySeries(row, args, startDate, endDate, treasuryMonthCache);
  }
  return fetchYahooSeries(row, args, startDate, endDate);
}

function chartOutput({ args, series, failures, quoteRevision, startDate, endDate }) {
  const quoteRows = deriveQuoteRowsFromSeries(series);
  return {
    schemaVersion: 1,
    generatedAt: quoteRevision,
    dashboardSource: path.relative(process.cwd(), args.input) || path.basename(args.input),
    range: {
      days: args.days,
      startDate: isoDateFromDate(startDate),
      endDate: isoDateFromDate(endDate)
    },
    sourceFamilies: Array.from(new Set(series.map((item) => item.source).filter(Boolean))),
    ...(failures.length ? {
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: quoteRevision,
        failures
      }
    } : {}),
    // quoteRows are staging output for daily updates; the published dashboard still renders quotes from dashboard-data.
    quoteRows,
    series
  };
}

function validateAndWriteChartOutput(output, expectedRows, writeJson, outputPath) {
  const validationErrors = validateChartStagingPayload(output, expectedRows);
  if (validationErrors.length) throw new Error(`Chart staging payload is invalid: ${validationErrors.join(' ')}`);
  writeJson(outputPath, output);
}

async function mapIndexesConcurrent(indexes, concurrency, worker, delayMs, sleepFn) {
  let next = 0;
  async function run() {
    while (next < indexes.length) {
      await worker(indexes[next++]);
      if (delayMs) await sleepFn(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, run));
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const requestedTickers = new Set(args.tickers.filter(Boolean));
  const inputRows = readChartableRows(args.input).filter((row) => !requestedTickers.size || requestedTickers.has(row.ticker));
  if (!inputRows.length) throw new Error('No chartable rows matched the requested --ticker values.');
  const endDate = args.asOf || (dependencies.now instanceof Date ? dependencies.now : new Date());
  const quoteRevision = endDate.toISOString();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const treasuryMonthCache = new Map();
  const canonicalPayload = readEmbeddedChartPayload(args.input);
  const canonicalByTicker = new Map(
    (canonicalPayload?.series || []).map((item) => [String(item?.ticker || '').toUpperCase(), item])
  );
  const seriesByIndex = inputRows.map((row) => {
    const prior = canonicalByTicker.get(String(row.ticker || '').toUpperCase());
    return prior ? carriedForwardChartSeries(prior, quoteRevision) : null;
  });
  const failuresByTicker = new Map(inputRows.map((row) => [
    String(row.ticker || '').toUpperCase(),
    { ticker: row.ticker, message: 'Refresh did not complete before this staging snapshot.' }
  ]));
  const writeJson = dependencies.writeJson || atomicWriteJson;
  const reportProgress = () => {
    const series = seriesByIndex.filter(Boolean);
    if (series.length !== inputRows.length) return;
    const failures = [...failuresByTicker.values()];
    const output = chartOutput({ args, series, failures, quoteRevision, startDate, endDate });
    validateAndWriteChartOutput(output, inputRows, writeJson, args.output);
  };
  const processRow = async (index) => {
    const row = inputRows[index];
    const tickerKey = String(row.ticker || '').toUpperCase();
    try {
      const item = await (dependencies.fetchSeries || fetchSeries)(row, args, startDate, endDate, treasuryMonthCache);
      seriesByIndex[index] = { ...item, quoteRevision };
      failuresByTicker.delete(tickerKey);
    } catch (error) {
      const prior = canonicalByTicker.get(tickerKey);
      failuresByTicker.set(tickerKey, { ticker: row.ticker, message: error.message });
      if (!prior) {
        seriesByIndex[index] = null;
        return;
      }
      seriesByIndex[index] = carriedForwardChartSeries(prior, quoteRevision);
    }
    reportProgress();
  };

  reportProgress();
  const treasuryIndexes = inputRows.map((row, index) => row.sourceSymbol.startsWith('TREASURY:') ? index : null).filter((index) => index !== null);
  const independentIndexes = inputRows.map((row, index) => row.sourceSymbol.startsWith('TREASURY:') ? null : index).filter((index) => index !== null);
  await Promise.all([
    mapIndexesConcurrent(independentIndexes, CHART_ROW_CONCURRENCY, processRow, args.delayMs, dependencies.sleep || sleep),
    mapIndexesConcurrent(treasuryIndexes, 1, processRow, args.delayMs, dependencies.sleep || sleep)
  ]);

  const missingRows = inputRows.filter((row, index) => !seriesByIndex[index]
    && !canonicalByTicker.has(String(row.ticker || '').toUpperCase()));
  if (missingRows.length) {
    throw new Error(`${missingRows.map((row) => row.ticker).join(', ')} refresh failed and no validated embedded series is available.`);
  }
  const series = seriesByIndex.filter(Boolean);
  const failures = [...failuresByTicker.values()];
  const output = chartOutput({ args, series, failures, quoteRevision, startDate, endDate });
  validateAndWriteChartOutput(output, inputRows, writeJson, args.output);

  if (args.compact) {
    process.stdout.write(series.map((item) => `${item.ticker}:${item.bars.length}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output} with ${series.length} series\n`);
  }
}

// The optional local market server imports these helpers to avoid maintaining a second ticker/source routing map.
module.exports = {
  DEFAULT_DAYS,
  REQUEST_TIMEOUT_MS,
  acceptedFreshChartTickers,
  buildChartDataFallback,
  buildUnavailableFuturesPayload: futuresModule.buildUnavailableFuturesPayload,
  CHART_ROW_CONCURRENCY,
    easternCashOpen: futuresModule.easternCashOpen,
  deriveQuoteRowsFromSeries,
  cryptoQuoteRowFromSeries,
  compactChartPayload,
  fetchSeries,
  finnhubQuoteBarFromPayload,
  isoDateFromDate,
  mergeFinnhubQuoteBar,
  quoteRowFromSeries,
  parseArgs,
    parseFuture: futuresModule.parseFuture,
    premarketCutoff: futuresModule.premarketCutoff,
    scheduledNow: futuresModule.scheduledNow,
  runFutures: futuresModule.run,
  roundChartPayload,
  runChart: main,
  validateChartStagingPayload,
  readChartableRows,
  readEmbeddedChartPayload,
  readCryptoRows,
  readTapeRows,
  shouldUseFinnhubQuoteFallback,
  sleep,
  validateFuturesPayload: futuresModule.validateFuturesPayload
};

if (require.main === module) {
  const futuresMode = process.argv[2] === 'futures';
  const command = futuresMode ? futuresModule.run(process.argv.slice(3)) : main();
  command.catch((error) => {
    process.stderr.write(`${futuresMode ? 'fetch_chart_data futures' : 'fetch_chart_data'} failed: ${error.message}\n`);
    process.exit(1);
  });
}
