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
  ['TREASURY:CURVE', 'BC_10YEAR'],
  ['TREASURY:3M', 'BC_3MONTH'],
  ['TREASURY:10Y', 'BC_10YEAR'],
  ['TREASURY:30Y', 'BC_30YEAR']
]);
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
  --output PATH       Unified chart JSON output path (default: scripts/generated/chart_data.json)
  --days 1826         Calendar days of daily history to request
  --timeout-ms 15000  HTTP timeout in ms per request
  --delay-ms 250      Delay between source requests
  --compact           Print one-line series summary
  --help              Show this help
`);
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
  return rows.map((row, index) => ({
    index,
    section: 'tape',
    quoteShape: 'tape',
    name: String(row?.name || '').trim(),
    ticker: String(row?.ticker || '').trim().toUpperCase(),
    sourceSymbol: String(row?.sourceSymbol || '').trim(),
    note: String(row?.note || '').trim()
  })).filter((row) => row.ticker && row.sourceSymbol);
}

function readCryptoRows(input) {
  const data = readDashboardData(input);
  const rows = Array.isArray(data.crypto?.tape) ? data.crypto.tape : [];
  return rows.map((row, index) => {
    const ticker = String(row?.sym || row?.ticker || '').trim().toUpperCase();
    return {
      index,
      section: 'crypto',
      quoteShape: 'crypto',
      name: String(row?.name || ticker).trim(),
      ticker,
      sourceSymbol: String(row?.sourceSymbol || '').trim(),
      note: String(row?.note || '').trim()
    };
  }).filter((row) => row.ticker && row.sourceSymbol);
}

function readChartableRows(input) {
  return [...readTapeRows(input), ...readCryptoRows(input)];
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
  const previousCurveEntry = row.sourceSymbol === 'TREASURY:CURVE'
    ? treasuryCurveEntryNearMonthAgo(filteredEntries, latestCurveEntry?.time)
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
    series.previousCurveDate = previousCurveEntry?.time || null;
    series.previousCurveLabel = '1M ago';
    series.previousCurvePoints = previousCurveEntry ? treasuryCurvePointsFromEntry(previousCurveEntry) : [];
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

function treasuryCurveEntryNearMonthAgo(entries, latestIsoDate) {
  const targetIsoDate = latestIsoDate ? isoDateMonthsAgo(latestIsoDate, 1) : null;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = readChartableRows(args.input);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
  const treasuryMonthCache = new Map();
  const series = [];

  for (const row of inputRows) {
    const item = await fetchSeries(row, args, startDate, endDate, treasuryMonthCache);
    series.push(item);
    if (args.delayMs) await sleep(args.delayMs);
  }

  const tapeSeries = series.filter((item) => item.section !== 'crypto');
  const cryptoSeries = series.filter((item) => item.section === 'crypto');
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dashboardSource: path.relative(process.cwd(), args.input) || path.basename(args.input),
    range: {
      days: args.days,
      startDate: isoDateFromDate(startDate),
      endDate: isoDateFromDate(endDate)
    },
    sourceFamilies: Array.from(new Set(series.map((item) => item.source).filter(Boolean))),
    // quoteRows are staging output for daily updates; the published dashboard still renders quotes from dashboard-data.
    quoteRows: {
      tape: tapeSeries.map(quoteRowFromSeries),
      crypto: cryptoSeries.map(cryptoQuoteRowFromSeries)
    },
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
  cryptoQuoteRowFromSeries,
  fetchSeries,
  isoDateFromDate,
  quoteRowFromSeries,
  readChartableRows,
  readCryptoRows,
  readTapeRows,
  sleep
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_chart_data failed: ${error.message}\n`);
    process.exit(1);
  });
}
