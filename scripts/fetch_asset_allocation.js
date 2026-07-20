#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { isIsoDate } = require('./calendar_contract');
const { atomicWriteJson } = require('./staging_writer');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PORTFOLIO_OUTPUT = path.resolve(process.cwd(), 'generated', 'asset_allocation_portfolio.json');
const DEFAULT_SUMMARY_OUTPUT = path.resolve(process.cwd(), 'generated', 'asset_allocation_summary.json');
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const DEFAULT_REFRESH_URL = 'http://127.0.0.1:2200/api/asset-market-data';
const DEFAULT_EXPORT_PATH = '/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json';
const DASHBOARD_TIME_ZONE = 'America/Chicago';

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
    input: DEFAULT_INPUT,
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
    if (arg === '--input') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--input requires a path.');
      args.input = path.resolve(process.cwd(), argv[i + 1]);
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
  --input PATH             Canonical dashboard used for row-level carry-forward
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

function dashboardDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DASHBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((memo, part) => {
    memo[part.type] = part.value;
    return memo;
  }, {});
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    monthIndex: Number(parts.month) - 1
  };
}

function dashboardIsoDate(date) {
  return dashboardDateParts(date).isoDate;
}

function monthKey(date) {
  return dashboardIsoDate(date).slice(0, 7);
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
  // Fetch one month ahead so upcoming dividend cards can show context, but
  // only ex-dates through observationDate enter current MTD dividend totals.
  const dividendBuckets = bucketDividendEvents(
    dividendEventsInRange(result, monthStart, lookaheadEndExclusive),
    dashboardIsoDate(now),
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

function readCanonicalPortfolio(input) {
  try {
    const html = fs.readFileSync(input, 'utf8');
    const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
    return match ? JSON.parse(match[1])?.assetAllocationPortfolio || null : null;
  } catch (_error) {
    return null;
  }
}

async function fetchPortfolioRows(args, dependencies = {}) {
  const now = dependencies.now instanceof Date ? dependencies.now : new Date();
  const calendar = dashboardDateParts(now);
  const monthStart = utcDate(calendar.year, calendar.monthIndex, 1);
  const currentMonthEnd = utcDate(calendar.year, calendar.monthIndex + 1, 0);
  const lookaheadEndExclusive = utcDate(calendar.year, calendar.monthIndex + 2, 1);
  const lookbackStart = utcDate(calendar.year, calendar.monthIndex - 1, 20);
  const period1 = Math.floor(lookbackStart.getTime() / 1000);
  const period2 = Math.floor(lookaheadEndExclusive.getTime() / 1000);
  const settled = await Promise.allSettled(
    HOLDINGS.map((holding) => (dependencies.fetchHolding || fetchHolding)(
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
  const currentMonth = monthKey(now);
  const canonical = readCanonicalPortfolio(args.input);
  const canonicalLastValidatedAt = String(canonical?.availability?.lastValidatedAt || canonical?.compiledAt || '').trim();
  const priorByTicker = new Map(
    (canonical?.month === currentMonth && Array.isArray(canonical?.rows) ? canonical.rows : [])
      .map((row) => [row?.ticker, row])
  );
  const failures = [];
  const rows = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const holding = HOLDINGS[index];
    failures.push({ ticker: holding.symbol, message: result.reason?.message || 'source unavailable' });
    const prior = priorByTicker.get(holding.symbol);
    if (prior) {
      const lastValidatedAt = String(prior.availability?.lastValidatedAt || canonicalLastValidatedAt).trim();
      // Row-level carry-forward is month-scoped; a new month without a fresh
      // fetch publishes explicit unavailable fields instead of stale MTD math.
      return {
        ...prior,
        availability: {
          status: 'carried_forward',
          reason: 'source_refresh_failed',
          checkedAt: now.toISOString(),
          ...(lastValidatedAt ? { lastValidatedAt } : {})
        }
      };
    }
    return {
      ticker: holding.symbol,
      sleeve: holding.sleeve,
      swatch: holding.swatch,
      price: 'Unavailable',
      monthDivPerShare: 'Unavailable',
      dailyPriceChange: 'Unavailable',
      dailyTR: 'Unavailable',
      mtdPriceChange: 'Unavailable',
      mtdTR: 'Unavailable',
      dividends: [],
      upcomingCurrentMonthDividends: 'Unavailable',
      upcomingCurrentMonthDividendsValue: 0,
      upcomingCurrentMonthDividendEvents: [],
      futureMonthDividends: 'Unavailable',
      futureMonthDividendsValue: 0,
      futureMonthDividendEvents: [],
      availability: {
        status: 'unavailable',
        reason: 'source_refresh_failed',
        checkedAt: now.toISOString()
      }
    };
  });
  return {
    compiledAt: now.toISOString(),
    source: 'Yahoo Finance Chart API',
    month: currentMonth,
    rows,
    ...(failures.length ? {
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: now.toISOString(),
        failures
      }
    } : {})
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

function buildAssetAllocationFallback(canonicalPortfolio, { month, asOf, checkedAt = new Date() } = {}) {
  const timestamp = new Date(checkedAt).toISOString();
  const sameMonth = canonicalPortfolio?.month === month
    && Array.isArray(canonicalPortfolio?.rows)
    && canonicalPortfolio.rows.length === HOLDINGS.length;
  if (sameMonth) {
    const lastValidatedAt = String(canonicalPortfolio?.availability?.lastValidatedAt || canonicalPortfolio?.compiledAt || '').trim();
    return {
      ...structuredClone(canonicalPortfolio),
      portfolioMtdReturnStale: true,
      availability: {
        status: 'carried_forward',
        reason: 'source_refresh_failed',
        checkedAt: timestamp,
        ...(lastValidatedAt ? { lastValidatedAt } : {})
      }
    };
  }
  return {
    ...structuredClone(canonicalPortfolio || {}),
    compiledAt: timestamp,
    source: 'Yahoo Finance Chart API',
    month,
    rows: [],
    portfolioMtdReturnAsOf: asOf,
    portfolioMtdReturnValue: null,
    portfolioMtdReturnStatus: 'unavailable',
    portfolioMtdReturnStale: false,
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    }
  };
}

function buildAssetAllocationSummaryFallback(canonicalPortfolio, { asOf } = {}) {
  const priorAsOf = String(canonicalPortfolio?.portfolioMtdReturnAsOf || '');
  const sameMonth = /^\d{4}-\d{2}-\d{2}$/.test(priorAsOf) && priorAsOf.slice(0, 7) === String(asOf || '').slice(0, 7);
  const priorValue = Number(canonicalPortfolio?.portfolioMtdReturnValue);
  const available = sameMonth
    && canonicalPortfolio?.portfolioMtdReturnStatus === 'available'
    && Number.isFinite(priorValue);
  return {
    asOf: available ? priorAsOf : asOf,
    portfolioMtdReturnValue: available ? priorValue : null,
    status: available ? 'available' : 'unavailable',
    stale: available,
    refreshError: 'Source refresh failed; retrying on the next run.'
  };
}

function validateAssetAllocationPortfolioPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Asset Allocation portfolio staging payload must be an object.'];
  const unavailable = payload.availability?.status === 'unavailable';
  if (!Array.isArray(payload.rows)) return ['Asset Allocation portfolio staging rows must be an array.'];
  if (!unavailable) {
    for (const holding of HOLDINGS) {
      if (!payload.rows.some((row) => row?.ticker === holding.symbol)) errors.push(`Asset Allocation portfolio staging is missing ${holding.symbol}.`);
    }
  } else if (payload.rows.length) {
    errors.push('Unavailable Asset Allocation portfolio staging must contain no rows.');
  }
  return errors;
}

function validateAssetAllocationSummaryPayload(payload) {
  try {
    normalizedSummary(payload, Boolean(payload?.stale), payload?.refreshError || '');
    return [];
  } catch (error) {
    return [error.message];
  }
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
  atomicWriteJson(file, payload);
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
    try {
      summary = await fetchPortfolioSummary(args);
    } catch (error) {
      summary = {
        asOf: dashboardIsoDate(new Date()),
        portfolioMtdReturnValue: null,
        status: 'unavailable',
        stale: false,
        refreshError: error.message
      };
    }
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
  buildAssetAllocationFallback,
  buildAssetAllocationSummaryFallback,
  fetchPortfolioRows,
  normalizedSummary,
  validateAssetAllocationPortfolioPayload,
  validateAssetAllocationSummaryPayload
};
