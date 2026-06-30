#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'asset_allocation_portfolio.json');

// Staging helper only: computes instrument-level ETF returns/dividends, never tactical allocation weights.
const HOLDINGS = [
  { symbol: 'VTI', sleeve: 'U.S. total market equity', swatch: 'vti' },
  { symbol: 'VEA', sleeve: 'Developed ex-U.S. equity', swatch: 'vea' },
  { symbol: 'VWO', sleeve: 'Emerging markets equity', swatch: 'vwo' },
  { symbol: 'VNQ', sleeve: 'U.S. real estate', swatch: 'vnq' },
  { symbol: 'DBC', sleeve: 'Broad commodities', swatch: 'dbc' },
  { symbol: 'GLD', sleeve: 'Gold', swatch: 'gld' },
  { symbol: 'IEF', sleeve: '7-10Y U.S. Treasuries', swatch: 'ief' },
  { symbol: 'BOXX', sleeve: 'Cash / T-bill alternative', swatch: 'boxx' }
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
  process.stdout.write(`Usage: node scripts/fetch_asset_allocation_portfolio.js [options]

Options:
  --output PATH       JSON output path (default: scripts/generated/asset_allocation_portfolio.json)
  --timeout-ms 10000  HTTP timeout in ms per request
  --compact           Print one-line symbol summary
  --help              Show this help
`);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function utcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function chartUrl(symbol, period1, period2) {
  const encoded = encodeURIComponent(symbol);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?period1=${period1}&period2=${period2}&interval=1d&events=div`;
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

function asPercent(value) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'always'
  }).format(value)}%`;
}

function asMoney(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (Math.abs(value) < 0.00005) return '$0.00';
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(value)}`;
}

function asSignedMoney(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  const absValue = Math.abs(value);
  if (absValue < 0.005) return '$0.00';
  const sign = value > 0 ? '+' : '-';
  return `${sign}$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(absValue)}`;
}

function asPrice(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)}`;
}

function direction(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function dayText(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function validPriceRows(result) {
  const timestamps = result?.timestamp || [];
  const adjCloses = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return timestamps.map((timestamp, index) => {
    const price = Number(adjCloses[index]);
    const close = Number(closes[index]);
    return Number.isFinite(timestamp) && Number.isFinite(price)
      ? {
        date: dayText(timestamp),
        timestamp,
        price,
        close: Number.isFinite(close) ? close : price
      }
      : null;
  }).filter(Boolean);
}

function dividendsInMonth(result, monthStart, now) {
  const events = result?.events?.dividends || {};
  const startMs = monthStart.getTime();
  const endMs = now.getTime();
  return Object.values(events).map((event) => {
    const timestamp = Number(event?.date);
    const amount = Number(event?.amount);
    if (!Number.isFinite(timestamp) || !Number.isFinite(amount)) return null;
    const eventMs = timestamp * 1000;
    if (eventMs < startMs || eventMs > endMs) return null;
    return {
      exDate: dayText(timestamp),
      amount
    };
  }).filter(Boolean).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

function pctChange(current, base) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return null;
  return ((current / base) - 1) * 100;
}

function parseHolding(holding, payload, monthStart, now) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(`${holding.symbol} response did not include chart data`);
  }

  const prices = validPriceRows(result);
  if (prices.length < 2) {
    throw new Error(`${holding.symbol} response did not include enough adjusted-close history`);
  }

  const latest = prices[prices.length - 1];
  const previous = prices[prices.length - 2];
  const monthStartKey = monthStart.toISOString().slice(0, 10);
  const priorMonthRows = prices.filter((row) => row.date < monthStartKey);
  const currentMonthRows = prices.filter((row) => row.date >= monthStartKey);
  const mtdBase = priorMonthRows[priorMonthRows.length - 1] || currentMonthRows[0] || previous;
  const dividends = dividendsInMonth(result, monthStart, now);
  const dailyTRValue = pctChange(latest.price, previous.price);
  const mtdTRValue = pctChange(latest.price, mtdBase.price);
  const dailyPriceChangeValue = latest.close - previous.close;
  const mtdPriceChangeValue = latest.close - mtdBase.close;
  const monthDivPerShareValue = dividends.reduce((sum, event) => sum + event.amount, 0);
  const metaPrice = Number(result?.meta?.regularMarketPrice);
  const priceValue = Number.isFinite(metaPrice) ? metaPrice : latest.close;

  return {
    ticker: holding.symbol,
    sleeve: holding.sleeve,
    swatch: holding.swatch,
    price: asPrice(priceValue),
    priceValue,
    dailyPriceChange: asSignedMoney(dailyPriceChangeValue),
    dailyPriceChangeValue,
    dailyTR: Number.isFinite(dailyTRValue) ? asPercent(dailyTRValue) : 'Unavailable',
    dailyTRValue,
    dailyDir: direction(dailyTRValue),
    mtdPriceChange: asSignedMoney(mtdPriceChangeValue),
    mtdPriceChangeValue,
    mtdTR: Number.isFinite(mtdTRValue) ? asPercent(mtdTRValue) : 'Unavailable',
    mtdTRValue,
    mtdDir: direction(mtdTRValue),
    monthDivPerShare: asMoney(monthDivPerShareValue),
    monthDivPerShareValue,
    dividends
  };
}

async function fetchHolding(holding, args, period1, period2, monthStart, now) {
  const payload = await fetchJson(chartUrl(holding.symbol, period1, period2), args.timeoutMs);
  return parseHolding(holding, payload, monthStart, now);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const monthStart = utcDate(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lookbackStart = utcDate(now.getUTCFullYear(), now.getUTCMonth() - 1, 20);
  const period1 = Math.floor(lookbackStart.getTime() / 1000);
  const period2 = Math.floor((now.getTime() + 24 * 60 * 60 * 1000) / 1000);
  const rows = await Promise.all(
    HOLDINGS.map((holding) => fetchHolding(holding, args, period1, period2, monthStart, now))
  );
  // Output is a staging payload for manual merge into dashboard-data, not a production runtime dependency.
  const output = {
    compiledAt: now.toISOString(),
    source: 'Yahoo Finance Chart API',
    month: monthKey(now),
    rows
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);

  if (args.compact) {
    process.stdout.write(rows.map((row) => `${row.ticker} ${row.price} ${row.monthDivPerShare} ${row.dailyPriceChange} ${row.dailyTR} ${row.mtdPriceChange} ${row.mtdTR}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_asset_allocation_portfolio failed: ${error.message}\n`);
    process.exit(1);
  });
}
