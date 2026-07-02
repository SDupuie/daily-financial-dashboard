#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'chart_data.json');
const DEFAULT_DAYS = 1826;
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const TREASURY_FIELDS = new Map([
  ['TREASURY:10Y', 'BC_10YEAR'],
  ['TREASURY:30Y', 'BC_30YEAR']
]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    days: DEFAULT_DAYS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    delayMs: 250,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--days') {
      args.days = Math.max(5, Number(argv[i + 1] || DEFAULT_DAYS));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--delay-ms') {
      args.delayMs = Math.max(0, Number(argv[i + 1] || 0));
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
  process.stdout.write(`Usage: node scripts/fetch_chart_data.js [options]

Options:
  --input PATH        Dashboard HTML to read (default: daily_financial_news.html)
  --output PATH       JSON output path (default: scripts/generated/chart_data.json)
  --days 1826         Calendar days of daily history to request
  --timeout-ms 15000  HTTP timeout in ms per request
  --delay-ms 250      Delay between source requests
  --compact           Print one-line series summary
  --help              Show this help
`);
}

function readTapeRows(input) {
  const html = fs.readFileSync(input, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${input}`);
  }
  const data = JSON.parse(match[1]);
  const rows = Array.isArray(data.tape?.rows) ? data.tape.rows : [];
  if (!rows.length) {
    throw new Error('dashboard-data tape.rows is empty or missing');
  }
  // sourceSymbol is the single dashboard-owned routing key for quote refreshes and popup chart history.
  return rows.map((row, index) => ({
    index,
    name: String(row?.name || '').trim(),
    ticker: String(row?.ticker || '').trim().toUpperCase(),
    sourceSymbol: String(row?.sourceSymbol || '').trim(),
    note: String(row?.note || '').trim()
  })).filter((row) => row.ticker && row.sourceSymbol);
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

function yyyymmdd(date) {
  return isoDateFromDate(date).replaceAll('-', '');
}

function yyyymmToIsoDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
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

function msciGraphUrl(sourceSymbol, startDate, endDate) {
  const code = sourceSymbol.replace(/^MSCI:/, '');
  // MSCI's graph endpoint provides USD standard index levels only; the chart renderer treats them as close-only bars.
  const params = new URLSearchParams({
    currency_symbol: 'USD',
    index_variant: 'STRD',
    index_codes: code,
    start_date: yyyymmdd(startDate),
    end_date: yyyymmdd(endDate)
  });
  return `https://app2.msci.com/products/service/index/indexmaster/getLevelDataForGraph?${params.toString()}`;
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

async function fetchYahooSeries(row, args, startDate, endDate) {
  const errors = [];
  // Yahoo occasionally fails one chart host while the other is healthy, so keep both as equivalent fallbacks.
  for (const host of YAHOO_HOSTS) {
    try {
      const payload = await fetchJson(yahooChartUrl(host, row.sourceSymbol, startDate, endDate), args);
      return parseYahooSeries(row, payload, host);
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(errors.join(' | '));
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

async function fetchMsciSeries(row, args, startDate, endDate) {
  const payload = await fetchJson(msciGraphUrl(row.sourceSymbol, startDate, endDate), args, {
    'Referer': 'https://www.msci.com/'
  });
  const levels = Array.isArray(payload?.indexes?.INDEX_LEVELS) ? payload.indexes.INDEX_LEVELS : [];
  const bars = levels.map((level) => {
    const time = yyyymmToIsoDate(level?.calc_date);
    const close = asFiniteNumber(level?.level_eod);
    return time && close !== null ? closeOnlyBar(time, close) : null;
  }).filter(Boolean);

  if (!bars.length) {
    throw new Error(`${row.sourceSymbol} response did not include usable MSCI levels`);
  }

  return {
    ...seriesBase(row),
    source: 'MSCI index graph endpoint',
    sourceKey: 'msci_graph',
    dataKind: 'close',
    priceOnly: true,
    noVolume: true,
    currency: payload?.ISO_currency_symbol || 'USD',
    exchangeTimezoneName: null,
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

  const bars = monthEntries.map((entry) => {
    const close = asFiniteNumber(entry[field]);
    return entry.time && close !== null ? closeOnlyBar(entry.time, close) : null;
  }).filter((bar) => bar && bar.time >= isoDateFromDate(startDate) && bar.time <= isoDateFromDate(endDate));

  if (!bars.length) {
    throw new Error(`${row.sourceSymbol} response did not include usable Treasury yield history`);
  }

  return {
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
}

function parseTreasuryXml(xml) {
  const entries = [];
  const propertyBlocks = xml.match(/<m:properties>[\s\S]*?<\/m:properties>/g) || [];
  for (const block of propertyBlocks) {
    const time = extractXmlField(block, 'NEW_DATE')?.slice(0, 10) || null;
    entries.push({
      time,
      BC_10YEAR: extractXmlField(block, 'BC_10YEAR'),
      BC_30YEAR: extractXmlField(block, 'BC_30YEAR')
    });
  }
  return entries.filter((entry) => entry.time);
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
    sourceSymbol: row.sourceSymbol,
    note: row.note
  };
}

async function fetchSeries(row, args, startDate, endDate, treasuryMonthCache) {
  if (row.sourceSymbol.startsWith('MSCI:')) {
    return fetchMsciSeries(row, args, startDate, endDate);
  }
  if (row.sourceSymbol.startsWith('TREASURY:')) {
    return fetchTreasurySeries(row, args, startDate, endDate, treasuryMonthCache);
  }
  return fetchYahooSeries(row, args, startDate, endDate);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = readTapeRows(args.input);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const treasuryMonthCache = new Map();
  const series = [];

  for (const row of inputRows) {
    const item = await fetchSeries(row, args, startDate, endDate, treasuryMonthCache);
    series.push(item);
    if (args.delayMs) await sleep(args.delayMs);
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dashboardSource: path.relative(process.cwd(), args.input) || path.basename(args.input),
    range: {
      days: args.days,
      startDate: isoDateFromDate(startDate),
      endDate: isoDateFromDate(endDate)
    },
    sourceFamilies: [
      'Yahoo Finance Chart API',
      'MSCI index graph endpoint',
      'Treasury.gov Daily Treasury Yield Curve Rate Data'
    ],
    // quoteRows are staging output for daily updates; the published dashboard still renders quotes from dashboard-data.
    quoteRows: series.map(quoteRowFromSeries),
    series
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);

  if (args.compact) {
    process.stdout.write(series.map((item) => `${item.ticker}:${item.bars.length}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output} with ${series.length} series\n`);
  }
}

// The optional local quote server imports these helpers to avoid maintaining a second ticker/source routing map.
module.exports = {
  DEFAULT_DAYS,
  REQUEST_TIMEOUT_MS,
  fetchSeries,
  isoDateFromDate,
  quoteRowFromSeries,
  readTapeRows,
  sleep
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_chart_data failed: ${error.message}\n`);
    process.exit(1);
  });
}
