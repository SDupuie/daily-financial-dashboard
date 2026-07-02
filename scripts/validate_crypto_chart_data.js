#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultDashboard = path.resolve(root, 'daily_financial_news.html');
const defaultChartData = path.resolve(root, 'scripts', 'generated', 'crypto_chart_data.json');
const MIN_CHART_HISTORY_DAYS = 1826;
// Keep this map aligned with fetch_crypto_chart_data.js and dashboard crypto rows that should open popups.
const EXPECTED_SOURCE_SYMBOLS = new Map(Object.entries({
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  IBIT: 'IBIT',
  MSTR: 'MSTR'
}));

function parseArgs(argv) {
  const args = {
    dashboard: defaultDashboard,
    chartData: defaultChartData
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dashboard') {
      args.dashboard = path.resolve(process.cwd(), argv[i + 1] || defaultDashboard);
      i += 1;
      continue;
    }
    if (arg === '--chart-data') {
      args.chartData = path.resolve(process.cwd(), argv[i + 1] || defaultChartData);
      i += 1;
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
  process.stdout.write(`Usage: node scripts/validate_crypto_chart_data.js [options]

Options:
  --dashboard PATH    Dashboard HTML with embedded crypto.tape
  --chart-data PATH   Generated crypto chart JSON to validate
  --help              Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCryptoRows(file) {
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${file}`);
  }
  const data = JSON.parse(match[1]);
  return Array.isArray(data.crypto?.tape) ? data.crypto.tape : [];
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const cryptoRows = readCryptoRows(args.dashboard);
  // Only configured crypto tape rows are required; display-only rows should not force generated chart history.
  const expectedTickers = new Set(
    cryptoRows
      .map((row) => String(row?.sym || row?.ticker || '').toUpperCase())
      .filter((ticker) => EXPECTED_SOURCE_SYMBOLS.has(ticker))
  );
  const chartData = readJson(args.chartData);

  if (chartData.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1.');
  }
  if (!Array.isArray(chartData.series)) {
    errors.push('series must be an array.');
  }
  if (!isIsoDate(chartData.range?.startDate) || !isIsoDate(chartData.range?.endDate)) {
    errors.push('range.startDate and range.endDate must be ISO dates.');
  }
  // 1826 calendar days gives the 5Y shortcut enough daily bars after weekends and market holidays.
  if (!Number.isFinite(Number(chartData.range?.days)) || Number(chartData.range.days) < MIN_CHART_HISTORY_DAYS) {
    errors.push(`range.days must be at least ${MIN_CHART_HISTORY_DAYS} so crypto 5Y charts have enough embedded history.`);
  }

  const series = Array.isArray(chartData.series) ? chartData.series : [];
  const seriesByTicker = new Map();
  for (const [index, itemRaw] of series.entries()) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const ticker = String(item.ticker || '').toUpperCase();
    const label = ticker || `series[${index}]`;
    if (!ticker) errors.push(`series[${index}].ticker must be populated.`);
    if (seriesByTicker.has(ticker)) errors.push(`Duplicate generated crypto chart series for ${ticker}.`);
    seriesByTicker.set(ticker, item);

    const expectedSource = EXPECTED_SOURCE_SYMBOLS.get(ticker);
    if (!expectedSource || !expectedTickers.has(ticker)) {
      errors.push(`${label} is not an expected crypto chart ticker.`);
    } else if (item.sourceSymbol !== expectedSource) {
      errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    }
    if (item.source !== 'Yahoo Finance Chart API') {
      errors.push(`${label}.source must be Yahoo Finance Chart API.`);
    }
    if (!['ohlc', 'close'].includes(item.dataKind)) {
      errors.push(`${label}.dataKind must be ohlc or close.`);
    }
    if (typeof item.priceOnly !== 'boolean') {
      errors.push(`${label}.priceOnly must be boolean.`);
    }
    if (typeof item.noVolume !== 'boolean') {
      errors.push(`${label}.noVolume must be boolean.`);
    }
    if (!Array.isArray(item.bars) || item.bars.length < 2) {
      errors.push(`${label}.bars must contain at least two daily bars.`);
      continue;
    }

    let previousTime = '';
    for (const [barIndex, barRaw] of item.bars.entries()) {
      const bar = barRaw && typeof barRaw === 'object' ? barRaw : {};
      const barLabel = `${label}.bars[${barIndex}]`;
      if (!isIsoDate(bar.time)) {
        errors.push(`${barLabel}.time must be an ISO date.`);
      }
      if (previousTime && bar.time <= previousTime) {
        errors.push(`${barLabel}.time must be strictly ascending.`);
      }
      previousTime = bar.time;
      for (const key of ['open', 'high', 'low', 'close']) {
        if (!isFiniteNumber(bar[key])) {
          errors.push(`${barLabel}.${key} must be numeric.`);
        }
      }
      if (bar.volume !== undefined && (!isFiniteNumber(bar.volume) || Number(bar.volume) < 0)) {
        errors.push(`${barLabel}.volume must be a non-negative number when present.`);
      }
    }
  }

  for (const ticker of expectedTickers) {
    if (!seriesByTicker.has(ticker)) {
      errors.push(`Generated crypto chart data is missing ${ticker}.`);
    }
  }

  if (errors.length) {
    console.error('Crypto chart data validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(`Crypto chart data validation OK (${series.length} series)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Crypto chart data validation failed: ${error.message}`);
    process.exit(1);
  }
}
