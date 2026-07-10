#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'futures_module.json');

// Staging helper only: production reads embedded futuresModule.futures from daily_financial_news.html.
const FUTURES = [
  { symbol: 'ES=F', label: 'S&P Futures', body: 'S&P 500 futures before the cash open.' },
  { symbol: 'NQ=F', label: 'Nasdaq Futures', body: 'Growth and AI tone before the cash open.' },
  { symbol: 'YM=F', label: 'Dow Futures', body: 'Blue-chip and defensive leadership read.' },
  { symbol: 'RTY=F', label: 'Russell Futures', body: 'Small-cap and domestic cyclicals read.' }
];

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
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
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
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_futures_module.js [options]

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

function latestRegularSessionClose(points, symbol) {
  const sessions = new Map();
  for (const point of points) {
    const [timestamp] = point;
    if (!isRegularSessionPoint(timestamp)) continue;
    const date = chicagoIsoDate(timestamp);
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

function parseFuture(spec, payload, args, referencePayload = null) {
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
  const premarketReference = args.mode === 'premarket'
    ? latestRegularSessionClose(parsePricePoints(referencePayload), spec.symbol)
    : null;
  const comparisonPoints = sessionComparison
    ? sessionComparison.sessionPoints
    : withLatestQuotePoint(pricePoints, quoteTime, quotePrice);
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
      quotePrice,
      quoteTime: Number.isFinite(quoteTime) ? quoteTime : null,
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

async function fetchFuture(spec, args) {
  const payloadPromise = fetchJson(yahooChartUrl(spec.symbol, args), args.timeoutMs);
  const referencePayloadPromise = args.mode === 'premarket'
    ? fetchJson(yahooChartUrl(spec.symbol, args, '5d'), args.timeoutMs)
    : Promise.resolve(null);
  const [payload, referencePayload] = await Promise.all([payloadPromise, referencePayloadPromise]);
  return parseFuture(spec, payload, args, referencePayload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = await Promise.all(FUTURES.map((spec) => fetchFuture(spec, args)));
  // Output is a staging payload; the published page renders embedded futuresModule.futures only.
  const output = {
    compiledAt: new Date().toISOString(),
    source: 'Yahoo Finance Chart API',
    mode: args.mode,
    futures: results
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);

  if (args.compact) {
    process.stdout.write(results.map((row) => `${row.symbol} ${row.value}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_futures_module failed: ${error.message}\n`);
    process.exit(1);
  });
}
