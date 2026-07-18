#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isIsoDate, isIsoDateTime } = require('./calendar_contract');
const { validateTapeCommentaryDisposition } = require('./editorial_review_contract');
const { cryptoQuoteRowFromSeries, quoteRowFromSeries } = require('./fetch_chart_data');

const root = path.resolve(__dirname, '..');
const defaultDashboard = path.resolve(root, 'daily_financial_news.html');
const defaultChartData = path.resolve(root, 'generated', 'chart_data.json');
// Chart staging data and the compact embedded payload share this contract.
// It lives here because validate_dashboard owns both full-dashboard and chart-data validation.
const MIN_CHART_HISTORY_DAYS = 1826;
// Treasury skips weekends and holidays, so validate broad comparison windows rather than exact offsets.
const REQUIRED_YIELD_CURVE_COMPARISONS = [
  { label: '1M ago', minDays: 20, maxDays: 45 },
  { label: '6M ago', minDays: 150, maxDays: 215 }
];
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
    const comparisonIndex = comparisonCurves.findIndex((comparison) => comparison?.label === expected.label);
    if (comparisonIndex < 0) {
      errors.push(`${label}.comparisonCurves must include ${expected.label}.`);
      continue;
    }
    const comparison = comparisonCurves[comparisonIndex];
    if (!isIsoDate(comparison.date)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be an ISO date.`);
    } else {
      if (seenDates.has(comparison.date)) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be distinct from ${seenDates.get(comparison.date)}.`);
      }
      seenDates.set(comparison.date, expected.label);
      const ageDays = isoDayGap(item.curveDate, comparison.date);
      if (ageDays === null || ageDays < expected.minDays || ageDays > expected.maxDays) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be ${expected.label} relative to curveDate.`);
      }
    }
    const points = Array.isArray(comparison.points) ? comparison.points : [];
    validateYieldCurvePointSet(errors, label, `comparisonCurves[${comparisonIndex}].points`, points, curvePoints);
    const pointKey = yieldCurvePointsKey(points);
    if (seenPointSets.has(pointKey)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].points must be distinct from ${seenPointSets.get(pointKey)}.`);
    }
    seenPointSets.set(pointKey, expected.label);
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

function validateChartPayloadMetadata(errors, payload, { label = '' } = {}) {
  const prefix = label ? `${label}.` : '';
  if (!isIsoDate(payload?.range?.startDate) || !isIsoDate(payload?.range?.endDate)) {
    errors.push(`${prefix}range.startDate and ${prefix}range.endDate must be ISO dates.`);
  }
  if (!Number.isFinite(Number(payload?.range?.days)) || Number(payload.range.days) < MIN_CHART_HISTORY_DAYS) {
    errors.push(`${prefix}range.days must be at least ${MIN_CHART_HISTORY_DAYS} so the 5Y chart shortcut has enough embedded history.`);
  }
}

// These adapters only bridge storage representation. All market-data semantics live below.
function decodeObjectSeries(_errors, sourceItem) {
  return {
    ...sourceItem,
    bars: Array.isArray(sourceItem.bars)
      ? sourceItem.bars.map((bar) => (bar && typeof bar === 'object' ? bar : {}))
      : sourceItem.bars
  };
}

function decodeTupleSeries(errors, sourceItem, label) {
  const bars = [];
  for (const [barIndex, barRaw] of (Array.isArray(sourceItem.bars) ? sourceItem.bars : []).entries()) {
    const barLabel = `${label}.bars[${barIndex}]`;
    if (!Array.isArray(barRaw) || barRaw.length !== 6) {
      errors.push(`${barLabel} must be a [time, open, high, low, close, volume] tuple.`);
      continue;
    }
    const [time, open, high, low, close, volume] = barRaw;
    for (const [field, value] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
      if (isFiniteNumber(value) && Number(value) !== Number(Number(value).toFixed(4))) {
        errors.push(`${barLabel}.${field} must use at most four decimal places.`);
      }
    }
    bars.push({ time, open, high, low, close, ...(volume === null ? {} : { volume }) });
  }
  return { ...sourceItem, bars };
}

function validateBars(errors, label, item, volumeDescription) {
  if (!Array.isArray(item.bars) || item.bars.length < 2) {
    errors.push(`${label}.bars must contain at least two daily bars.`);
    return;
  }
  let previousTime = '';
  for (const [barIndex, bar] of item.bars.entries()) {
    const barLabel = `${label}.bars[${barIndex}]`;
    if (!isIsoDate(bar.time)) errors.push(`${barLabel}.time must be an ISO date.`);
    if (previousTime && bar.time <= previousTime) errors.push(`${barLabel}.time must be strictly ascending.`);
    previousTime = bar.time;
    for (const key of ['open', 'high', 'low', 'close']) {
      if (!isFiniteNumber(bar[key])) errors.push(`${barLabel}.${key} must be numeric.`);
    }
    if (!isCoherentOhlc(bar)) errors.push(`${barLabel} has incoherent OHLC values.`);
    if (bar.volume !== undefined && (!isFiniteNumber(bar.volume) || Number(bar.volume) < 0)) {
      errors.push(`${barLabel}.volume must be a non-negative number when present.`);
    }
    if (item.priceOnly && !(bar.open === bar.high && bar.high === bar.low && bar.low === bar.close)) {
      errors.push(`${barLabel} must synthesize OHLC from close for priceOnly series.`);
    }
    if (item.noVolume && bar.volume !== undefined) {
      errors.push(`${barLabel}.volume must be omitted when noVolume is true.`);
    }
    if (!item.priceOnly && item.dataKind === 'ohlc' && barIndex === item.bars.length - 1 && isCloseOnlyPlaceholderBar(bar)) {
      errors.push(`${barLabel} must contain real OHLC data; do not publish a latest quote-only placeholder in an OHLC series.`);
    }
  }
  const hasVolume = item.bars.some((bar) => bar.volume !== undefined);
  if (typeof item.noVolume === 'boolean' && item.noVolume !== !hasVolume) {
    errors.push(`${label}.noVolume must be ${!hasVolume} to match its ${volumeDescription} volume bars.`);
  }
}

function validateSeries(errors, series, {
  expectedByTicker,
  expectedSectionByTicker,
  decodeSeries,
  prefix,
  absentMessage,
  duplicateMessage,
  missingMessage,
  volumeDescription
}) {
  const seriesByTicker = new Map();
  const decodedSeries = [];
  for (const [index, rawItem] of series.entries()) {
    const sourceItem = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const ticker = String(sourceItem.ticker || '').toUpperCase();
    const label = ticker || `${prefix}series[${index}]`;
    const item = decodeSeries(errors, sourceItem, label);
    decodedSeries.push(item);
    if (!ticker) errors.push(`${prefix}series[${index}].ticker must be populated.`);
    if (seriesByTicker.has(ticker)) errors.push(`${duplicateMessage} ${ticker}.`);
    seriesByTicker.set(ticker, item);
    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) errors.push(`${label} ${absentMessage}`);
    else if (item.sourceSymbol !== expectedSource) errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
    const expectedSection = expectedSectionByTicker.get(ticker);
    if (expectedSection && item.section !== expectedSection) errors.push(`${label}.section must be ${expectedSection}.`);
    if (!isIsoDateTime(item.quoteRevision)) errors.push(`${label}.quoteRevision must be an offset-bearing ISO timestamp.`);
    if (item.availability !== undefined) {
      if (!item.availability || typeof item.availability !== 'object' || Array.isArray(item.availability)) {
        errors.push(`${label}.availability must be an object.`);
      } else {
        if (item.availability.status !== 'carried_forward') errors.push(`${label}.availability.status must be carried_forward.`);
      }
    }
    if (!['ohlc', 'close'].includes(item.dataKind)) errors.push(`${label}.dataKind must be ohlc or close.`);
    if (typeof item.priceOnly !== 'boolean') errors.push(`${label}.priceOnly must be boolean.`);
    if (typeof item.noVolume !== 'boolean') errors.push(`${label}.noVolume must be boolean.`);
    if (item.sourceSymbol === 'TREASURY:CURVE') {
      const curvePoints = Array.isArray(item.curvePoints) ? item.curvePoints : [];
      validateYieldCurvePointSet(errors, label, 'curvePoints', curvePoints);
      validateYieldCurveComparisons(errors, label, item, curvePoints);
      const curveSpread = item.curveSpread && typeof item.curveSpread === 'object' ? item.curveSpread : {};
      if (curveSpread.label !== '2s10s') errors.push(`${label}.curveSpread.label must be 2s10s.`);
      if (!isFiniteNumber(curveSpread.valueBp)) errors.push(`${label}.curveSpread.valueBp must be numeric.`);
    }
    validateBars(errors, label, item, volumeDescription);
  }
  for (const ticker of expectedByTicker.keys()) {
    if (!seriesByTicker.has(ticker)) errors.push(`${missingMessage} ${ticker}.`);
  }
  return { decodedSeries, seriesByTicker };
}

function validateChartAvailabilityCorrespondence(errors, payload, seriesByTicker, prefix) {
  const availability = payload.availability;
  const carriedTickers = new Set(
    [...seriesByTicker.entries()]
      .filter(([, series]) => series?.availability?.status === 'carried_forward')
      .map(([ticker]) => ticker)
  );
  if (availability === undefined) {
    void carriedTickers;
    return;
  }
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    errors.push(`${prefix}availability must be an object.`);
    return;
  }
  if (!['partial', 'carried_forward'].includes(availability.status)) errors.push(`${prefix}availability.status must be partial or carried_forward.`);
  void seriesByTicker;
  void carriedTickers;
}

function validateQuoteRows(errors, payload, { expectedByTicker, expectedSectionByTicker, prefix }, seriesByTicker) {
  const tapeRows = Array.isArray(payload.quoteRows?.tape) ? payload.quoteRows.tape : [];
  const cryptoRows = Array.isArray(payload.quoteRows?.crypto) ? payload.quoteRows.crypto : [];
  const quoteRowsByTicker = new Map();
  const validateRows = (rows, section) => {
    for (const [index, rawRow] of rows.entries()) {
      const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
      const ticker = String(row.ticker || row.sym || '').toUpperCase();
      const label = ticker || `${prefix}quoteRows.${section}[${index}]`;
      if (!ticker) errors.push(`${prefix}quoteRows.${section}[${index}].ticker must be populated.`);
      if (quoteRowsByTicker.has(ticker)) errors.push(`Duplicate generated quote row for ${ticker}.`);
      quoteRowsByTicker.set(ticker, row);
      const expectedSource = expectedByTicker.get(ticker);
      if (!expectedSource) errors.push(`${label} is not present in dashboard chartable rows.`);
      else if (section === 'tape' && row.sourceSymbol !== expectedSource) errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
      if (expectedSectionByTicker.get(ticker) !== section) errors.push(`${label} must be generated only for ${section} rows.`);
      const fields = section === 'tape'
        ? ['name', 'last', 'delta', 'pct', 'dir', 'note', 'asOf']
        : ['name', 'price', 'delta', 'chg', 'dir', 'asOf'];
      for (const field of fields) {
        if (typeof row[field] !== 'string' || row[field].trim() === '') errors.push(`${label}.${field} must be populated.`);
      }
      if (!['up', 'down', 'flat'].includes(row.dir)) errors.push(`${label}.dir must be up, down, or flat.`);
      if (!isIsoDate(row.asOf)) errors.push(`${label}.asOf must be an ISO date.`);
      const item = seriesByTicker.get(ticker);
      // Bar validation already reports malformed or truncated series; do not replace that diagnosis with a quote-derivation exception.
      if (!Array.isArray(item?.bars) || item.bars.length < 2) continue;
      const expected = item ? (section === 'tape' ? quoteRowFromSeries(item) : cryptoQuoteRowFromSeries(item)) : null;
      if (!expected) continue;
      const fieldsToMatch = section === 'tape'
        ? [['last', 'last'], ['delta', 'delta'], ['pct', 'pct'], ['dir', 'dir'], ['asOf', 'asOf']]
        : [['price', 'price'], ['delta', 'delta'], ['chg', 'chg'], ['dir', 'dir'], ['asOf', 'asOf']];
      for (const [field, expectedField] of fieldsToMatch) {
        if (String(row[field] ?? '') !== String(expected[expectedField] ?? '')) {
          errors.push(`${label}.${field} must match the latest generated ${section === 'crypto' ? 'crypto ' : ''}series bar-derived value "${expected[expectedField]}".`);
        }
      }
    }
  };
  validateRows(tapeRows, 'tape');
  validateRows(cryptoRows, 'crypto');
  for (const [ticker, section] of expectedSectionByTicker.entries()) {
    if (!quoteRowsByTicker.has(ticker)) errors.push(`Generated quote rows are missing ${section} ticker ${ticker}.`);
  }
  return { quoteRowsByTicker, tapeRows, cryptoRows };
}

// Staged fetch output and the compact published payload share this complete contract;
// callers provide only their storage decoder and dashboard roster boundary.
function validateChartPayload(errors, payload, {
  expectedByTicker,
  expectedSectionByTicker,
  decodeSeries,
  label = '',
  absentMessage = 'is not present in dashboard chartable rows.',
  duplicateMessage = 'Duplicate generated chart series for',
  missingMessage = 'Generated chart data is missing',
  volumeDescription = 'generated'
}) {
  const prefix = label ? `${label}.` : '';
  if (payload.schemaVersion !== 1) errors.push(`${prefix}schemaVersion must be 1.`);
  if (!Array.isArray(payload.series)) errors.push(`${prefix}series must be an array.`);
  if (!payload.quoteRows || typeof payload.quoteRows !== 'object' || Array.isArray(payload.quoteRows)) {
    errors.push(`${prefix}quoteRows must be an object with tape and crypto arrays.`);
  } else {
    if (!Array.isArray(payload.quoteRows.tape)) errors.push(`${prefix}quoteRows.tape must be an array.`);
    if (!Array.isArray(payload.quoteRows.crypto)) errors.push(`${prefix}quoteRows.crypto must be an array.`);
  }
  validateChartPayloadMetadata(errors, payload, { label });
  const series = Array.isArray(payload.series) ? payload.series : [];
  const result = validateSeries(errors, series, {
    expectedByTicker,
    expectedSectionByTicker,
    decodeSeries,
    prefix,
    absentMessage,
    duplicateMessage,
    missingMessage,
    volumeDescription
  });
  validateChartAvailabilityCorrespondence(errors, payload, result.seriesByTicker, prefix);
  return {
    ...result,
    ...validateQuoteRows(errors, payload, { expectedByTicker, expectedSectionByTicker, prefix }, result.seriesByTicker)
  };
}


function parseReadinessArgs(argv) {
  const args = { dashboard: 'daily_financial_news.html', allowedFiles: [], skipTests: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dashboard') {
      args.dashboard = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--allow') {
      args.allowedFiles.push(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--skip-tests') {
      args.skipTests = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/validate_dashboard.js readiness [options]\n\nOptions:\n  --dashboard PATH  Dashboard artifact (default: daily_financial_news.html)\n  --allow PATH      Permit one intentionally changed path; repeat as needed\n  --skip-tests      Skip the full regression suite for a content-only pre-commit check\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.dashboard) throw new Error('--dashboard requires a path.');
  if (args.allowedFiles.some((file) => !file)) throw new Error('--allow requires a path.');
  return args;
}

function runReadinessCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status || 1);
}

function trackedFiles(pattern) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', pattern], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not list ${pattern}.`);
  return result.stdout.split(/\r?\n/).filter(Boolean).filter((file) => fs.existsSync(path.join(root, file)));
}

function runCompleteTestSuite() {
  process.stdout.write('Checking tracked JavaScript syntax...\n');
  for (const file of trackedFiles('scripts/*.js')) runReadinessCommand(process.execPath, ['--check', file]);
  process.stdout.write('Checking tracked shell syntax...\n');
  for (const file of trackedFiles('scripts/*.sh')) runReadinessCommand('bash', ['-n', file]);
  process.stdout.write('Running contract and regression tests...\n');
  const testEnvironment = { ...process.env, DASHBOARD_TEST_NO_API_CREDENTIALS: '1' };
  delete testEnvironment.FINNHUB_API_KEY;
  delete testEnvironment.EARNINGSAPI_API_KEY;
  for (const file of ['test_news.js', 'test_earnings_week.js', 'test_week_ahead.js', 'test_dashboard.js']) {
    runReadinessCommand(process.execPath, [path.join('scripts', file)], { env: testEnvironment });
  }
  process.stdout.write('Validating the canonical dashboard artifact...\n');
  runReadinessCommand(process.execPath, ['scripts/validate_dashboard.js', 'daily_financial_news.html']);
  runReadinessCommand('tidy', ['-q', '-e', 'daily_financial_news.html']);
  runReadinessCommand('git', ['diff', '--check']);
  runReadinessCommand('git', ['diff', '--cached', '--check']);
  process.stdout.write('Complete dashboard test suite passed.\n');
}

function readinessExecutionPlan(args) {
  const completeSuiteChecksTargetHtml = path.resolve(root, args.dashboard) === defaultDashboard;
  return {
    tidyTargetBeforeSuite: args.skipTests || !completeSuiteChecksTargetHtml,
    checkDiffsBeforeSuite: args.skipTests,
    runCompleteSuite: !args.skipTests
  };
}

function changedPaths() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not inspect git status.');
  const entries = result.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3).replaceAll('\\', '/'));
    if (/[RC]/.test(status)) {
      index += 1;
      if (entries[index]) paths.push(entries[index].replaceAll('\\', '/'));
    }
  }
  return paths;
}

function runReadinessValidation(argv) {
  try {
    const args = parseReadinessArgs(argv);
    const plan = readinessExecutionPlan(args);
    runReadinessCommand(process.execPath, ['scripts/validate_dashboard.js', args.dashboard]);
    if (plan.tidyTargetBeforeSuite) runReadinessCommand('tidy', ['-q', '-e', args.dashboard]);
    if (plan.checkDiffsBeforeSuite) {
      runReadinessCommand('git', ['diff', '--check']);
      runReadinessCommand('git', ['diff', '--cached', '--check']);
    }
    if (plan.runCompleteSuite) runCompleteTestSuite();

    const allowed = new Set(args.allowedFiles.map((file) => path.normalize(file).replaceAll('\\', '/')));
    const unexpected = changedPaths().filter((file) => !allowed.has(file));
    if (unexpected.length) process.stderr.write(`Readiness warning: unexpected changed files: ${unexpected.join(', ')}.\n`);
    process.stdout.write('Readiness validation passed.\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Dashboard readiness validation failed: ${error.message}\n`);
    process.exit(1);
  }
}

function parseChartDataArgs(argv) {
  const args = { dashboard: defaultDashboard, chartData: defaultChartData };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dashboard') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--dashboard requires a path.');
      args.dashboard = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--chart-data') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--chart-data requires a path.');
      args.chartData = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/validate_dashboard.js chart-data [options]\n\nOptions:\n  --dashboard PATH    Dashboard HTML with embedded chartable rows\n  --chart-data PATH   Generated chart JSON to validate\n  --help              Show this help\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function chartableRowsFromDashboardHtml(dashboardHtml) {
  const match = dashboardHtml.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find dashboard-data JSON block.');
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

function validateChartDataPayload(chartableRows, chartData) {
  const errors = [];
  // Generated chart data must track the dashboard's authoritative ticker-to-sourceSymbol map exactly.
  const expectedByTicker = new Map(chartableRows.map((row) => [
    String(row?.ticker || '').toUpperCase(),
    String(row?.sourceSymbol || '')
  ]).filter(([ticker, sourceSymbol]) => ticker && sourceSymbol));
  const expectedSectionByTicker = new Map(chartableRows.map((row) => [
    String(row?.ticker || '').toUpperCase(),
    String(row?.section || 'tape')
  ]).filter(([ticker]) => ticker));
  const seenChartableTickers = new Set();
  for (const [index, rowRaw] of chartableRows.entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (seenChartableTickers.has(ticker)) {
      errors.push(`dashboard chartable row ${index} duplicates ticker ${ticker}; each chartable row must be unique.`);
    }
    seenChartableTickers.add(ticker);
  }
  const { decodedSeries: series } = validateChartPayload(errors, chartData, {
    expectedByTicker,
    expectedSectionByTicker,
    decodeSeries: decodeObjectSeries
  });
  return { errors, series };
}

function runChartDataValidation(argv) {
  try {
    const args = parseChartDataArgs(argv);
    const chartableRows = chartableRowsFromDashboardHtml(fs.readFileSync(args.dashboard, 'utf8'));
    const chartData = JSON.parse(fs.readFileSync(args.chartData, 'utf8'));
    const { errors, series } = validateChartDataPayload(chartableRows, chartData);
    if (errors.length) {
      console.error('Chart data validation failed:');
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(`Chart data validation OK (${series.length} series)`);
    process.exit(0);
  } catch (error) {
    console.error(`Chart data validation failed: ${error.message}`);
    process.exit(1);
  }
}

function validateDashboardHtml(html) {
const dashboardMatch = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
const chartDataMatch = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
const runtimeScriptMatches = [...html.matchAll(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/g)];
const errors = [];
const warnings = [];

function countMatches(pattern) {
  return [...html.matchAll(pattern)].length;
}

function requireOrderedMarkerSequence(markers, bounds = {}) {
  const { minIndex = -1, maxIndex = Number.POSITIVE_INFINITY } = bounds;
  let previousIndex = minIndex;
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index < 0) {
      errors.push(`Missing required dashboard shell marker: ${marker}`);
      continue;
    }
    if (index <= previousIndex) {
      errors.push(`Dashboard shell marker is out of order: ${marker}`);
    }
    if (index >= maxIndex) {
      errors.push(`Dashboard shell marker appears in the runtime script region: ${marker}`);
    }
    previousIndex = index;
  }
}

// This main dashboard runtime block is isolated from generated JSON and the vendored chart bundle, which are not runtime endpoint sources.
if (runtimeScriptMatches.length !== 1) {
  errors.push(`Expected exactly 1 dashboard-runtime script; found ${runtimeScriptMatches.length}.`);
}
const runtimeScript = runtimeScriptMatches.length === 1 ? runtimeScriptMatches[0][1] : '';
const runtimeUrls = [...runtimeScript.matchAll(/https?:\/\/[^'"`\s]+/g)].map((match) => match[0]);
const allowedLocalRefreshUrls = new Set([
  'https://192.168.2.2:2210/api/market-refresh'
]);
for (const url of runtimeUrls) {
  if (!allowedLocalRefreshUrls.has(url)) {
    errors.push(`Unexpected runtime URL: ${url}`);
  }
}
const expectedRuntimeUrls = [...allowedLocalRefreshUrls];
if (runtimeUrls.length !== expectedRuntimeUrls.length || runtimeUrls.some((url, index) => url !== expectedRuntimeUrls[index])) {
  errors.push('The dashboard runtime must expose only the canonical HTTPS LAN market-refresh URL.');
}

const dashboardDataScriptCount = countMatches(/<script type="application\/json" id="dashboard-data">[\s\S]*?<\/script>/g);
const chartDataScriptCount = countMatches(/<script type="application\/json" id="chart-data">[\s\S]*?<\/script>/g);
if (dashboardDataScriptCount !== 1) {
  errors.push(`Expected exactly 1 dashboard-data JSON block; found ${dashboardDataScriptCount}.`);
}
if (chartDataScriptCount !== 1) {
  errors.push(`Expected exactly 1 chart-data JSON block; found ${chartDataScriptCount}.`);
}

const dataStartIndex = html.indexOf('<!-- ============ DATA START');
const dataEndIndex = html.indexOf('<!-- ============ DATA END ============ -->');
const chartDataIndex = html.indexOf('<script type="application/json" id="chart-data">');
const runtimeScriptIndex = html.indexOf('<script id="dashboard-runtime">');

if (dataStartIndex < 0) {
  errors.push('Could not find the DATA START marker.');
}
if (dataEndIndex < 0) {
  errors.push('Could not find the DATA END marker.');
}
if (chartDataIndex < 0) {
  errors.push('Could not find the chart-data shell position.');
}
if (runtimeScriptIndex < 0) {
  errors.push('Could not find the dashboard-runtime script.');
}
if (dataStartIndex >= 0 && dataEndIndex >= 0 && dataStartIndex >= dataEndIndex) {
  errors.push('DATA START must appear before DATA END.');
}
if (dataEndIndex >= 0 && chartDataIndex >= 0 && chartDataIndex <= dataEndIndex) {
  errors.push('chart-data must appear after the DATA END marker.');
}
if (chartDataIndex >= 0 && runtimeScriptIndex >= 0 && chartDataIndex >= runtimeScriptIndex) {
  errors.push('chart-data must appear before the dashboard-runtime script.');
}

requireOrderedMarkerSequence([
  '<div class="page" id="app">',
  '<div id="mast-edition">',
  '<div class="right" id="mast-date">',
  '<h1 id="hero-headline">',
  '<div id="hero-copy"></div>',
  '<main id="content"></main>',
  '<footer id="footer"></footer>'
], {
  minIndex: chartDataIndex,
  maxIndex: runtimeScriptIndex >= 0 ? runtimeScriptIndex : Number.POSITIVE_INFINITY
});

if (!dashboardMatch) {
  errors.push('Could not find dashboard-data JSON block.');
} else {
  let data;
  try {
    data = JSON.parse(dashboardMatch[1]);
  } catch (error) {
    errors.push(`Embedded dashboard JSON is invalid: ${error.message}`);
  }

  if (data) {
    let chartData = null;

    if (!chartDataMatch) {
      errors.push('Could not find chart-data JSON block; production charts must use embedded generated data.');
    } else {
      try {
        chartData = JSON.parse(chartDataMatch[1]);
      } catch (error) {
        errors.push(`Embedded chart-data JSON is invalid: ${error.message}`);
      }
    }

    if (chartData) {
      const expectedByTicker = new Map((Array.isArray(chartData.series) ? chartData.series : [])
        .map((series) => [String(series?.ticker || '').toUpperCase(), series?.sourceSymbol])
        .filter(([ticker, sourceSymbol]) => ticker && sourceSymbol));
      const expectedSectionByTicker = new Map((Array.isArray(chartData.series) ? chartData.series : [])
        .map((series) => [String(series?.ticker || '').toUpperCase(), String(series?.section || '')])
        .filter(([ticker]) => ticker));
      validateChartPayload(errors, chartData, {
        expectedByTicker,
        expectedSectionByTicker,
        decodeSeries: decodeTupleSeries,
        label: 'chart-data',
        absentMessage: 'is missing its embedded source mapping.',
        duplicateMessage: 'Duplicate embedded chart series for',
        missingMessage: 'Embedded chart data is missing',
        volumeDescription: 'embedded'
      });
    }

  }
}

return { errors, warnings };
}

function runDashboardValidation(argv) {
  let inputFile = '';
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    } else if (inputFile) {
      console.error(`Unexpected second dashboard path: ${arg}`);
      process.exit(1);
    } else {
      inputFile = arg;
    }
  }
  inputFile ||= 'daily_financial_news.html';
  const file = path.resolve(root, inputFile);
  // Allow staging copies to be validated while keeping the checker scoped to this repository.
  if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
    console.error(`Refusing to validate a file outside this repository: ${inputFile}`);
    process.exit(1);
  }
  const { errors, warnings } = validateDashboardHtml(fs.readFileSync(file, 'utf8'));

  if (errors.length) {
    console.error('Dashboard validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  if (warnings.length) {
    console.warn('Dashboard validation warnings:');
    for (const warning of warnings) console.warn(`- ${warning}`);
  }
  console.log('Dashboard validation OK');
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write('Usage: node scripts/validate_dashboard.js [dashboard.html]\n       node scripts/validate_dashboard.js chart-data [options]\n       node scripts/validate_dashboard.js readiness [options]\n       node scripts/validate_dashboard.js test\n');
    return;
  }
  if (argv[0] === 'chart-data') return runChartDataValidation(argv.slice(1));
  if (argv[0] === 'test') {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write('Usage: node scripts/validate_dashboard.js test\n\nRuns syntax, focused domain and update-path tests, canonical dashboard, HTML, and whitespace checks.\n');
      return;
    }
    return runCompleteTestSuite();
  }
  if (argv[0] === 'readiness') return runReadinessValidation(argv.slice(1));
  return runDashboardValidation(argv);
}

if (require.main === module) main();

module.exports = {
  MIN_CHART_HISTORY_DAYS,
  REQUIRED_YIELD_CURVE_COMPARISONS,
  changedPaths,
  chartableRowsFromDashboardHtml,
  decodeObjectSeries,
  decodeTupleSeries,
  parseReadinessArgs,
  readinessExecutionPlan,
  runCompleteTestSuite,
  runDashboardValidation,
  validateChartDataPayload,
  validateChartPayload,
  validateChartPayloadMetadata,
  validateDashboardHtml,
  validateYieldCurveComparisons,
  validateYieldCurvePointSet
};
