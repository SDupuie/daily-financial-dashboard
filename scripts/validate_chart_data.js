#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  cryptoQuoteRowFromSeries,
  quoteRowFromSeries
} = require('./fetch_chart_data');

const root = path.resolve(__dirname, '..');
const defaultDashboard = path.resolve(root, 'daily_financial_news.html');
const defaultChartData = path.resolve(root, 'generated', 'chart_data.json');
const MIN_CHART_HISTORY_DAYS = 1826;
// Treasury skips weekends and holidays, so comparison dates are validated as broad windows rather than exact offsets.
const REQUIRED_YIELD_CURVE_COMPARISONS = [
  { label: '1M ago', minDays: 20, maxDays: 45 },
  { label: '6M ago', minDays: 150, maxDays: 215 }
];
const RECOGNIZED_SERIES_SOURCES = new Set([
  'Yahoo Finance Chart API',
  'Yahoo Finance Chart API + Finnhub Quote API',
  'Treasury.gov Daily Treasury Yield Curve Rate Data'
]);

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
  --dashboard PATH    Dashboard HTML with embedded chartable rows
  --chart-data PATH   Generated chart JSON to validate
  --help              Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readChartableRows(file) {
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find dashboard-data JSON block in ${file}`);
  }
  const data = JSON.parse(match[1]);
  // README Data Contracts make tape.rows the only chartable ticker source; section decides quoteRows shape.
  const tapeRows = Array.isArray(data.tape?.rows)
    ? data.tape.rows
      .filter((row) => String(row?.group ?? '') !== 'Crypto')
      .map((row) => ({ ...row, section: 'tape', ticker: row?.ticker }))
    : [];
  const cryptoTickerRows = Array.isArray(data.tape?.rows)
    ? data.tape.rows
      .filter((row) => String(row?.group ?? '') === 'Crypto' && row?.sourceSymbol)
      .map((row) => ({ ...row, section: 'crypto', ticker: row?.ticker }))
    : [];
  return [...tapeRows, ...cryptoTickerRows];
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function isoDayGap(laterDate, earlierDate) {
  if (!isIsoDate(laterDate) || !isIsoDate(earlierDate)) return null;
  const later = Date.parse(`${laterDate}T00:00:00Z`);
  const earlier = Date.parse(`${earlierDate}T00:00:00Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.round((later - earlier) / 86400000);
}

function yieldCurvePointsKey(points) {
  // Duplicate comparison curves can render as one line even when their labels differ.
  return JSON.stringify(points.map((point) => [
    String(point?.label || ''),
    Number(point?.years),
    Number(point?.value)
  ]));
}

function validateYieldCurvePointSet(errors, label, fieldName, points, referencePoints = null) {
  if (points.length < 2) {
    errors.push(`${label}.${fieldName} must contain a Treasury curve.`);
  }
  if (referencePoints && points.length !== referencePoints.length) {
    errors.push(`${label}.${fieldName} must match the current Treasury curve maturity count.`);
  }
  for (const [pointIndex, pointRaw] of points.entries()) {
    const point = pointRaw && typeof pointRaw === 'object' ? pointRaw : {};
    const referencePoint = referencePoints?.[pointIndex];
    if (typeof point.label !== 'string' || point.label.trim() === '') {
      errors.push(`${label}.${fieldName}[${pointIndex}].label must be populated.`);
    }
    if (referencePoint && point.label !== referencePoint.label) {
      errors.push(`${label}.${fieldName}[${pointIndex}].label must match current curve maturity ${referencePoint.label}.`);
    }
    if (!isFiniteNumber(point.years) || Number(point.years) <= 0) {
      errors.push(`${label}.${fieldName}[${pointIndex}].years must be positive.`);
    }
    if (!isFiniteNumber(point.value)) {
      errors.push(`${label}.${fieldName}[${pointIndex}].value must be numeric.`);
    }
  }
}

function validateYieldCurveComparisons(errors, label, item, curvePoints) {
  const comparisonCurves = Array.isArray(item.comparisonCurves) ? item.comparisonCurves : [];
  if (!Array.isArray(item.comparisonCurves)) {
    errors.push(`${label}.comparisonCurves must include 1M ago and 6M ago Treasury curves.`);
  }
  // The renderer assumes these labels exist and that each comparison shares the current curve maturity order.
  const seenDates = new Map();
  const seenPointSets = new Map();
  for (const expected of REQUIRED_YIELD_CURVE_COMPARISONS) {
    const expectedLabel = expected.label;
    const comparisonIndex = comparisonCurves.findIndex((comparison) => comparison?.label === expectedLabel);
    if (comparisonIndex < 0) {
      errors.push(`${label}.comparisonCurves must include ${expectedLabel}.`);
      continue;
    }
    const comparison = comparisonCurves[comparisonIndex];
    if (!isIsoDate(comparison.date)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be an ISO date.`);
    } else {
      if (seenDates.has(comparison.date)) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be distinct from ${seenDates.get(comparison.date)}.`);
      }
      seenDates.set(comparison.date, expectedLabel);
      const ageDays = isoDayGap(item.curveDate, comparison.date);
      if (ageDays === null || ageDays < expected.minDays || ageDays > expected.maxDays) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be ${expectedLabel} relative to curveDate.`);
      }
    }
    const points = Array.isArray(comparison.points) ? comparison.points : [];
    validateYieldCurvePointSet(errors, label, `comparisonCurves[${comparisonIndex}].points`, points, curvePoints);
    const pointKey = yieldCurvePointsKey(points);
    if (seenPointSets.has(pointKey)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].points must be distinct from ${seenPointSets.get(pointKey)}.`);
    }
    seenPointSets.set(pointKey, expectedLabel);
  }
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

function isCloseOnlyPlaceholderBar(bar) {
  return bar?.volume === undefined
    && isFiniteNumber(bar?.open)
    && Number(bar.open) === Number(bar.high)
    && Number(bar.high) === Number(bar.low)
    && Number(bar.low) === Number(bar.close);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const chartableRows = readChartableRows(args.dashboard);
  const chartData = readJson(args.chartData);
  // Generated chart data must track the dashboard's authoritative ticker-to-sourceSymbol map exactly.
  const expectedByTicker = new Map(chartableRows.map((row) => [
    String(row?.ticker || '').toUpperCase(),
    String(row?.sourceSymbol || '')
  ]).filter(([ticker, sourceSymbol]) => ticker && sourceSymbol));
  const expectedSectionByTicker = new Map(chartableRows.map((row) => [
    String(row?.ticker || '').toUpperCase(),
    String(row?.section || 'tape')
  ]).filter(([ticker]) => ticker));

  if (chartData.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1.');
  }
  if (!Array.isArray(chartData.series)) {
    errors.push('series must be an array.');
  }
  if (!chartData.quoteRows || typeof chartData.quoteRows !== 'object' || Array.isArray(chartData.quoteRows)) {
    errors.push('quoteRows must be an object with tape and crypto arrays.');
  } else {
    if (!Array.isArray(chartData.quoteRows.tape)) errors.push('quoteRows.tape must be an array.');
    if (!Array.isArray(chartData.quoteRows.crypto)) errors.push('quoteRows.crypto must be an array.');
  }
  if (!isIsoDate(chartData.range?.startDate) || !isIsoDate(chartData.range?.endDate)) {
    errors.push('range.startDate and range.endDate must be ISO dates.');
  }
  if (!Number.isFinite(Number(chartData.range?.days)) || Number(chartData.range.days) < MIN_CHART_HISTORY_DAYS) {
    errors.push(`range.days must be at least ${MIN_CHART_HISTORY_DAYS} so the 5Y chart shortcut has enough embedded history.`);
  }

  const series = Array.isArray(chartData.series) ? chartData.series : [];
  const expectedSourceFamilies = new Set(series.map((item) => item?.source).filter(Boolean));
  const sourceFamilies = Array.isArray(chartData.sourceFamilies) ? chartData.sourceFamilies : [];
  if (!Array.isArray(chartData.sourceFamilies)) {
    errors.push('sourceFamilies must list the source strings used by series[].');
  }
  for (const source of expectedSourceFamilies) {
    if (!sourceFamilies.includes(source)) errors.push(`sourceFamilies must include ${source}.`);
  }
  for (const source of sourceFamilies) {
    if (!expectedSourceFamilies.has(source)) errors.push(`sourceFamilies contains unused source ${source}.`);
  }

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
      errors.push(`${label} is not present in dashboard chartable rows.`);
    } else if (item.sourceSymbol !== expectedSource) {
      errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    }
    const expectedSection = expectedSectionByTicker.get(ticker);
    if (expectedSection && item.section !== expectedSection) {
      errors.push(`${label}.section must be ${expectedSection}.`);
    }

    if (!RECOGNIZED_SERIES_SOURCES.has(item.source)) {
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
    if (item.sourceSymbol === 'TREASURY:CURVE') {
      const curvePoints = Array.isArray(item.curvePoints) ? item.curvePoints : [];
      validateYieldCurvePointSet(errors, label, 'curvePoints', curvePoints);
      validateYieldCurveComparisons(errors, label, item, curvePoints);
      const curveSpread = item.curveSpread && typeof item.curveSpread === 'object' ? item.curveSpread : {};
      if (curveSpread.label !== '2s10s') {
        errors.push(`${label}.curveSpread.label must be 2s10s.`);
      }
      if (!isFiniteNumber(curveSpread.valueBp)) {
        errors.push(`${label}.curveSpread.valueBp must be numeric.`);
      }
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
      // Non-price-only OHLC series must not publish the latest row as a quote-only synthetic candle.
      if (!item.priceOnly && item.dataKind === 'ohlc' && barIndex === item.bars.length - 1 && isCloseOnlyPlaceholderBar(bar)) {
        errors.push(`${barLabel} must contain real OHLC data; do not publish a latest quote-only placeholder in an OHLC series.`);
      }
    }
  }

  for (const ticker of expectedByTicker.keys()) {
    if (!seriesByTicker.has(ticker)) {
      errors.push(`Generated chart data is missing ${ticker}.`);
    }
  }

  const tapeQuoteRows = Array.isArray(chartData.quoteRows?.tape) ? chartData.quoteRows.tape : [];
  const cryptoQuoteRows = Array.isArray(chartData.quoteRows?.crypto) ? chartData.quoteRows.crypto : [];
  const quoteRowsByTicker = new Map();
  for (const [index, rowRaw] of tapeQuoteRows.entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row.ticker || '').toUpperCase();
    const label = ticker || `quoteRows.tape[${index}]`;
    if (!ticker) errors.push(`quoteRows.tape[${index}].ticker must be populated.`);
    if (quoteRowsByTicker.has(ticker)) errors.push(`Duplicate generated quote row for ${ticker}.`);
    quoteRowsByTicker.set(ticker, row);

    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) {
      errors.push(`${label} is not present in dashboard chartable rows.`);
    } else if (row.sourceSymbol !== expectedSource) {
      errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    }
    if (expectedSectionByTicker.get(ticker) !== 'tape') {
      errors.push(`${label} must be generated only for tape rows.`);
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
    const seriesItem = seriesByTicker.get(ticker);
    const expected = seriesItem ? quoteRowFromSeries(seriesItem) : null;
    if (expected) {
      for (const field of ['last', 'delta', 'pct', 'dir', 'asOf']) {
        if (String(row?.[field] ?? '') !== String(expected[field] ?? '')) {
          errors.push(`${label}.${field} must match the latest generated series bar-derived value "${expected[field]}".`);
        }
      }
    }
  }

  for (const [index, rowRaw] of cryptoQuoteRows.entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row.ticker || row.sym || '').toUpperCase();
    const label = ticker || `quoteRows.crypto[${index}]`;
    if (!ticker) errors.push(`quoteRows.crypto[${index}].ticker must be populated.`);
    if (quoteRowsByTicker.has(ticker)) errors.push(`Duplicate generated quote row for ${ticker}.`);
    quoteRowsByTicker.set(ticker, row);

    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) {
      errors.push(`${label} is not present in dashboard chartable rows.`);
    }
    if (expectedSectionByTicker.get(ticker) !== 'crypto') {
      errors.push(`${label} must be generated only for crypto rows.`);
    }

    for (const field of ['name', 'price', 'delta', 'chg', 'dir', 'asOf']) {
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
    const seriesItem = seriesByTicker.get(ticker);
    const expected = seriesItem ? cryptoQuoteRowFromSeries(seriesItem) : null;
    if (expected) {
      for (const [field, expectedField] of [['price', 'price'], ['delta', 'delta'], ['chg', 'chg'], ['dir', 'dir'], ['asOf', 'asOf']]) {
        if (String(row?.[field] ?? '') !== String(expected[expectedField] ?? '')) {
          errors.push(`${label}.${field} must match the latest generated crypto series bar-derived value "${expected[expectedField]}".`);
        }
      }
    }
  }

  for (const [ticker, section] of expectedSectionByTicker.entries()) {
    if (!quoteRowsByTicker.has(ticker)) {
      errors.push(`Generated quote rows are missing ${section} ticker ${ticker}.`);
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
