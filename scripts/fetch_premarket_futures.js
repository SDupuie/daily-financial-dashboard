#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'premarket_futures.json');

// Staging helper only: production reads embedded preMarket.futures from daily_financial_news.html.
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
    compact: false
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
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_premarket_futures.js [options]

Options:
  --output PATH       JSON output path (default: scripts/generated/premarket_futures.json)
  --timeout-ms 10000  HTTP timeout in ms per request
  --compact           Print one-line symbol summary
  --help              Show this help
`);
}

function yahooChartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
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

function downsample(points, maxPoints = 72) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_value, index) => {
    const sourceIndex = Math.round(index * step);
    return points[sourceIndex];
  });
}

function parseSeries(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((timestamp, index) => {
    const price = Number(closes[index]);
    return Number.isFinite(timestamp) && Number.isFinite(price) && price > 0
      ? [timestamp, price]
      : null;
  }).filter(Boolean);

  return downsample(points);
}

function parseFuture(spec, payload) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  const previousClose = Number(meta?.chartPreviousClose);
  if (!Number.isFinite(price) || !Number.isFinite(previousClose)) {
    throw new Error(`${spec.symbol} response was missing price metadata`);
  }

  const delta = price - previousClose;
  const pct = previousClose ? (delta / previousClose) * 100 : 0;

  return {
    label: spec.label,
    symbol: spec.symbol,
    value: signedPct(pct),
    dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    body: `${numberFormat(2).format(price)} last · ${signedNumber(delta)} vs prior close · ${timeText(Number(meta?.regularMarketTime))}`,
    series: parseSeries(payload),
    raw: {
      price,
      previousClose,
      delta,
      pct,
      regularMarketTime: Number(meta?.regularMarketTime) || null,
      exchangeName: meta?.exchangeName || null,
      instrumentType: meta?.instrumentType || null
    }
  };
}

async function fetchFuture(spec, args) {
  const payload = await fetchJson(yahooChartUrl(spec.symbol), args.timeoutMs);
  return parseFuture(spec, payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = await Promise.all(FUTURES.map((spec) => fetchFuture(spec, args)));
  // Output is a staging payload; the published page renders embedded preMarket.futures only.
  const output = {
    compiledAt: new Date().toISOString(),
    source: 'Yahoo Finance Chart API',
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
    process.stderr.write(`fetch_premarket_futures failed: ${error.message}\n`);
    process.exit(1);
  });
}
