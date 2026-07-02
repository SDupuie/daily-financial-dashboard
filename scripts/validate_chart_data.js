#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultDashboard = path.resolve(root, 'daily_financial_news.html');
const defaultChartData = path.resolve(root, 'scripts', 'generated', 'chart_data.json');
const MIN_CHART_HISTORY_DAYS = 1826;

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
  process.stdout.write(`Usage: node scripts/validate_chart_data.js [options]

Options:
  --dashboard PATH    Dashboard HTML with embedded tape.rows
  --chart-data PATH   Generated chart JSON to validate
  --help              Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readTapeRows(file) {
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${file}`);
  }
  const data = JSON.parse(match[1]);
  return Array.isArray(data.tape?.rows) ? data.tape.rows : [];
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function isCoherentOhlc(bar) {
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  if (![open, high, low, close].every(Number.isFinite)) return false;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return false;
  return !(close > 0 && [open, high, low].some((value) => value <= 0));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const tapeRows = readTapeRows(args.dashboard);
  const chartData = readJson(args.chartData);
  // Generated chart data must track the dashboard's authoritative ticker-to-sourceSymbol map exactly.
  const expectedByTicker = new Map(tapeRows.map((row) => [
    String(row?.ticker || '').toUpperCase(),
    String(row?.sourceSymbol || '')
  ]).filter(([ticker, sourceSymbol]) => ticker && sourceSymbol));

  if (chartData.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1.');
  }
  if (!Array.isArray(chartData.series)) {
    errors.push('series must be an array.');
  }
  if (!Array.isArray(chartData.quoteRows)) {
    errors.push('quoteRows must be an array.');
  }
  if (!isIsoDate(chartData.range?.startDate) || !isIsoDate(chartData.range?.endDate)) {
    errors.push('range.startDate and range.endDate must be ISO dates.');
  }
  if (!Number.isFinite(Number(chartData.range?.days)) || Number(chartData.range.days) < MIN_CHART_HISTORY_DAYS) {
    errors.push(`range.days must be at least ${MIN_CHART_HISTORY_DAYS} so the 5Y chart shortcut has enough embedded history.`);
  }

  const series = Array.isArray(chartData.series) ? chartData.series : [];
  const quoteRows = Array.isArray(chartData.quoteRows) ? chartData.quoteRows : [];
  const seriesByTicker = new Map();
  for (const [index, itemRaw] of series.entries()) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const ticker = String(item.ticker || '').toUpperCase();
    const label = ticker || `series[${index}]`;

    if (!ticker) errors.push(`series[${index}].ticker must be populated.`);
    if (seriesByTicker.has(ticker)) errors.push(`Duplicate generated chart series for ${ticker}.`);
    seriesByTicker.set(ticker, item);

    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) {
      errors.push(`${label} is not present in dashboard tape.rows.`);
    } else if (item.sourceSymbol !== expectedSource) {
      errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    }

    if (!['Yahoo Finance Chart API', 'MSCI index graph endpoint', 'Treasury.gov Daily Treasury Yield Curve Rate Data'].includes(item.source)) {
      errors.push(`${label}.source is not recognized.`);
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
      if (!isCoherentOhlc(bar)) {
        errors.push(`${barLabel} has incoherent OHLC values.`);
      }
      if (bar.volume !== undefined && (!isFiniteNumber(bar.volume) || Number(bar.volume) < 0)) {
        errors.push(`${barLabel}.volume must be a non-negative number when present.`);
      }
      // Close-only sources intentionally duplicate close into OHLC so Lightweight Charts can render candlesticks.
      if (item.priceOnly && !(bar.open === bar.high && bar.high === bar.low && bar.low === bar.close)) {
        errors.push(`${barLabel} must synthesize OHLC from close for priceOnly series.`);
      }
      if (item.noVolume && bar.volume !== undefined) {
        errors.push(`${barLabel}.volume must be omitted when noVolume is true.`);
      }
    }
  }

  for (const ticker of expectedByTicker.keys()) {
    if (!seriesByTicker.has(ticker)) {
      errors.push(`Generated chart data is missing Tape ticker ${ticker}.`);
    }
  }

  const quoteRowsByTicker = new Map();
  for (const [index, rowRaw] of quoteRows.entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row.ticker || '').toUpperCase();
    const label = ticker || `quoteRows[${index}]`;
    if (!ticker) errors.push(`quoteRows[${index}].ticker must be populated.`);
    if (quoteRowsByTicker.has(ticker)) errors.push(`Duplicate generated quote row for ${ticker}.`);
    quoteRowsByTicker.set(ticker, row);

    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) {
      errors.push(`${label} is not present in dashboard tape.rows.`);
    } else if (row.sourceSymbol !== expectedSource) {
      errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    }

    for (const field of ['name', 'last', 'delta', 'pct', 'dir', 'note', 'asOf']) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') {
        errors.push(`${label}.${field} must be populated.`);
      }
    }
    if (!['up', 'down', 'flat'].includes(row.dir)) {
      errors.push(`${label}.dir must be up, down, or flat.`);
    }
    if (!isIsoDate(row.asOf)) {
      errors.push(`${label}.asOf must be an ISO date.`);
    }
  }

  for (const ticker of expectedByTicker.keys()) {
    if (!quoteRowsByTicker.has(ticker)) {
      errors.push(`Generated quote rows are missing Tape ticker ${ticker}.`);
    }
  }

  if (errors.length) {
    console.error('Chart data validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Chart data validation OK (${series.length} series)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Chart data validation failed: ${error.message}`);
    process.exit(1);
  }
}
