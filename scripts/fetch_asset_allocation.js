#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { isIsoDate } = require('./calendar_contract');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PORTFOLIO_OUTPUT = path.resolve(process.cwd(), 'generated', 'asset_allocation_portfolio.json');
const DEFAULT_SUMMARY_OUTPUT = path.resolve(process.cwd(), 'generated', 'asset_allocation_summary.json');
const DEFAULT_REFRESH_URL = 'http://127.0.0.1:2200/api/asset-market-data';
const DEFAULT_EXPORT_PATH = '/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json';

// Staging helper only: computes instrument-level ETF data and imports one
// sanitized portfolio summary. It never imports tactical allocation logic.
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
    portfolioOutput: DEFAULT_PORTFOLIO_OUTPUT,
    summaryOutput: DEFAULT_SUMMARY_OUTPUT,
    refreshUrl: DEFAULT_REFRESH_URL,
    exportPath: DEFAULT_EXPORT_PATH,
    timeoutMs: REQUEST_TIMEOUT_MS,
    compact: false,
    skipPortfolio: false,
    skipSummary: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--portfolio-output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--portfolio-output requires a path.');
      args.portfolioOutput = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--summary-output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--summary-output requires a path.');
      args.summaryOutput = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--refresh-url') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--refresh-url requires a URL.');
      args.refreshUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--export-path') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--export-path requires a path.');
      args.exportPath = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 1000) throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--skip-portfolio') {
      args.skipPortfolio = true;
      continue;
    }
    if (arg === '--skip-summary') {
      args.skipSummary = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.skipPortfolio && args.skipSummary) {
    throw new Error('At least one of portfolio or summary must be enabled.');
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_asset_allocation.js [options]

Options:
  --portfolio-output PATH  Portfolio rows JSON output (default: generated/asset_allocation_portfolio.json)
  --summary-output PATH    Sanitized summary JSON output (default: generated/asset_allocation_summary.json)
  --refresh-url URL        Local Asset Allocation refresh endpoint
  --export-path PATH       Sanitized Asset Allocation export JSON path
  --timeout-ms 10000       HTTP timeout in ms
  --skip-portfolio         Skip ETF row fetch
  --skip-summary           Skip sanitized portfolio summary refresh/import
  --compact                Print compact summary output
  --help                   Show this help
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

function fetchUrl(urlText, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlText);
    } catch (error) {
      reject(new Error(`Invalid refresh URL: ${error.message}`));
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve();
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

function dateText(date) {
  return date.toISOString().slice(0, 10);
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

function dividendEventsInRange(result, rangeStart, rangeEndExclusive) {
  const events = result?.events?.dividends || {};
  const startMs = rangeStart.getTime();
  const endMs = rangeEndExclusive.getTime();
  return Object.values(events).map((event) => {
    const timestamp = Number(event?.date);
    const amount = Number(event?.amount);
    if (!Number.isFinite(timestamp) || !Number.isFinite(amount)) return null;
    const eventMs = timestamp * 1000;
    if (eventMs < startMs || eventMs >= endMs) return null;
    return {
      exDate: dayText(timestamp),
      amount
    };
  }).filter(Boolean).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

function bucketDividendEvents(events, observationDate, currentMonthEnd) {
  return events.reduce((buckets, event) => {
    if (!event?.exDate) return buckets;
    if (event.exDate <= observationDate) {
      buckets.current.push(event);
    } else if (event.exDate <= currentMonthEnd) {
      buckets.upcoming.push(event);
    } else {
      buckets.future.push(event);
    }
    return buckets;
  }, {
    current: [],
    upcoming: [],
    future: []
  });
}

function sumDividends(events) {
  return events.reduce((sum, event) => {
    const amount = Number(event?.amount);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

function pctChange(current, base) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return null;
  return ((current / base) - 1) * 100;
}

function parseHolding(holding, payload, monthStart, now, currentMonthEnd, lookaheadEndExclusive) {
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
  const dividendBuckets = bucketDividendEvents(
    dividendEventsInRange(result, monthStart, lookaheadEndExclusive),
    dateText(now),
    dateText(currentMonthEnd)
  );
  const dividends = dividendBuckets.current;
  const dailyTRValue = pctChange(latest.price, previous.price);
  const mtdTRValue = pctChange(latest.price, mtdBase.price);
  const dailyPriceChangeValue = latest.close - previous.close;
  const mtdPriceChangeValue = latest.close - mtdBase.close;
  const monthDivPerShareValue = sumDividends(dividends);
  const upcomingCurrentMonthDividendsValue = sumDividends(dividendBuckets.upcoming);
  const futureMonthDividendsValue = sumDividends(dividendBuckets.future);
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
    dividends,
    upcomingCurrentMonthDividends: asMoney(upcomingCurrentMonthDividendsValue),
    upcomingCurrentMonthDividendsValue,
    upcomingCurrentMonthDividendEvents: dividendBuckets.upcoming,
    futureMonthDividends: asMoney(futureMonthDividendsValue),
    futureMonthDividendsValue,
    futureMonthDividendEvents: dividendBuckets.future
  };
}

async function fetchHolding(holding, args, period1, period2, monthStart, now, currentMonthEnd, lookaheadEndExclusive) {
  const payload = await fetchJson(chartUrl(holding.symbol, period1, period2), args.timeoutMs);
  return parseHolding(holding, payload, monthStart, now, currentMonthEnd, lookaheadEndExclusive);
}

async function fetchPortfolioRows(args) {
  const now = new Date();
  const monthStart = utcDate(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const currentMonthEnd = utcDate(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
  const lookaheadEndExclusive = utcDate(now.getUTCFullYear(), now.getUTCMonth() + 2, 1);
  const lookbackStart = utcDate(now.getUTCFullYear(), now.getUTCMonth() - 1, 20);
  const period1 = Math.floor(lookbackStart.getTime() / 1000);
  const period2 = Math.floor(lookaheadEndExclusive.getTime() / 1000);
  const rows = await Promise.all(
    HOLDINGS.map((holding) => fetchHolding(
      holding,
      args,
      period1,
      period2,
      monthStart,
      now,
      currentMonthEnd,
      lookaheadEndExclusive
    ))
  );
  return {
    compiledAt: now.toISOString(),
    source: 'Yahoo Finance Chart API',
    month: monthKey(now),
    rows
  };
}

function normalizedSummary(raw, stale, refreshError) {
  const status = raw?.status === 'available' ? 'available' : 'unavailable';
  const value = Number(raw?.portfolioMtdReturnValue);
  const available = status === 'available' && Number.isFinite(value);

  if (!isIsoDate(raw?.asOf)) {
    throw new Error('Asset Allocation summary asOf must be YYYY-MM-DD.');
  }
  if (status === 'available' && !Number.isFinite(value)) {
    throw new Error('Asset Allocation summary portfolioMtdReturnValue must be finite when status is available.');
  }

  return {
    asOf: raw.asOf,
    portfolioMtdReturnValue: available ? value : null,
    status: available ? 'available' : 'unavailable',
    stale,
    ...(refreshError ? { refreshError } : {})
  };
}

async function fetchPortfolioSummary(args) {
  let stale = false;
  let refreshError = '';

  try {
    // The refresh endpoint updates the separate project's sanitized export file.
    // Its HTTP response is intentionally ignored so display data can only come
    // from the narrow JSON contract below.
    await fetchUrl(args.refreshUrl, args.timeoutMs);
  } catch (error) {
    stale = true;
    refreshError = error.message;
    if (!fs.existsSync(args.exportPath)) {
      throw new Error(`Refresh failed (${refreshError}) and export file does not exist: ${args.exportPath}`);
    }
  }

  const raw = JSON.parse(fs.readFileSync(args.exportPath, 'utf8'));
  return normalizedSummary(raw, stale, refreshError);
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function compactPortfolioText(portfolio) {
  return portfolio.rows
    .map((row) => `${row.ticker} ${row.price} ${row.monthDivPerShare} ${row.dailyPriceChange} ${row.dailyTR} ${row.mtdPriceChange} ${row.mtdTR}`)
    .join(' | ');
}

function compactSummaryText(summary) {
  const display = summary.status === 'available'
    ? `${summary.portfolioMtdReturnValue >= 0 ? '+' : ''}${summary.portfolioMtdReturnValue.toFixed(2)}%`
    : 'Unavailable';
  return `${display} as of ${summary.asOf}${summary.stale ? ' (stale)' : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const messages = [];
  let portfolio = null;
  let summary = null;

  if (!args.skipPortfolio) {
    portfolio = await fetchPortfolioRows(args);
    writeJson(args.portfolioOutput, portfolio);
    messages.push(args.compact ? compactPortfolioText(portfolio) : `Wrote ${args.portfolioOutput}`);
  }

  if (!args.skipSummary) {
    summary = await fetchPortfolioSummary(args);
    writeJson(args.summaryOutput, summary);
    messages.push(args.compact ? compactSummaryText(summary) : `Wrote ${args.summaryOutput}`);
  }

  process.stdout.write(`${messages.join('\n')}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_asset_allocation failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  normalizedSummary
};
