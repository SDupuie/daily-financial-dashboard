#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateEarningsWeekPayload } = require('./earnings_week');
const { validateWeekAheadPayload } = require('./week_ahead_contract');
const { addDays, isIsoDate, isIsoDateTime } = require('./calendar_contract');
const { superlativeClaims, validateReviewManifest } = require('./editorial_review_contract');
const { cryptoQuoteRowFromSeries, quoteRowFromSeries } = require('./fetch_chart_data');
const { canonicalStoryUrl, dashboardNewsItems, storyIdentity } = require('./news_contract');

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
const RECOGNIZED_SERIES_SOURCES = new Set([
  'Yahoo Finance Chart API',
  'Yahoo Finance Chart API + Finnhub Quote API',
  'Treasury.gov Daily Treasury Yield Curve Rate Data'
]);

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
  if (!isIsoDateTime(payload?.generatedAt)) {
    errors.push(`${prefix}generatedAt must be an offset-bearing ISO timestamp.`);
  }
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

function validateSourceFamilies(errors, payload, series, prefix) {
  const expectedSourceFamilies = new Set(series.map((item) => item?.source).filter(Boolean));
  const sourceFamilies = Array.isArray(payload.sourceFamilies) ? payload.sourceFamilies : [];
  if (!Array.isArray(payload.sourceFamilies)) {
    const seriesLabel = prefix ? `${prefix}series` : 'series[]';
    errors.push(`${prefix}sourceFamilies must list the source strings used by ${seriesLabel}.`);
  }
  for (const source of expectedSourceFamilies) {
    if (!sourceFamilies.includes(source)) errors.push(`${prefix}sourceFamilies must include ${source}.`);
  }
  for (const source of sourceFamilies) {
    if (!expectedSourceFamilies.has(source)) errors.push(`${prefix}sourceFamilies contains unused source ${source}.`);
  }
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
    if (!RECOGNIZED_SERIES_SOURCES.has(item.source)) errors.push(`${label}.source is not recognized.`);
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
  validateSourceFamilies(errors, payload, series, prefix);
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

function assertIndependentTestSuites() {
  const offenders = trackedFiles('scripts/test_*.js').filter((file) =>
    /require\(['"]\.\/test_/.test(fs.readFileSync(path.join(root, file), 'utf8'))
  );
  if (offenders.length) throw new Error(`Test suites must not import other test-suite entry points: ${offenders.join(', ')}.`);
}

function assertContractPurity() {
  // This lexical guard proves contract modules do not directly use the project's
  // known I/O entry points; domain tests still prove the exported behavior is deterministic.
  const forbidden = /require\(['"](?:node:)?(?:fs(?:\/promises)?|https?|child_process)['"]\)|\bfs\.|\b(?:fetch|fetchJson)\s*\(|\bprocess\.(?:argv|env|exit)\b/;
  const offenders = trackedFiles('scripts/*_contract.js').filter((file) =>
    forbidden.test(fs.readFileSync(path.join(root, file), 'utf8'))
  );
  if (offenders.length) throw new Error(`Contract modules must remain deterministic and I/O-free: ${offenders.join(', ')}.`);
}

function runCompleteTestSuite() {
  process.stdout.write('Checking tracked JavaScript syntax...\n');
  for (const file of trackedFiles('scripts/*.js')) runReadinessCommand(process.execPath, ['--check', file]);
  process.stdout.write('Checking tracked shell syntax...\n');
  for (const file of trackedFiles('scripts/*.sh')) runReadinessCommand('bash', ['-n', file]);
  process.stdout.write('Checking LaunchAgent plist...\n');
  runReadinessCommand('plutil', ['-lint', 'launchd/com.scott.daily-financial-dashboard.plist']);
  process.stdout.write('Running contract and regression tests...\n');
  assertIndependentTestSuites();
  assertContractPurity();
  const privateEarningsImports = trackedFiles('scripts/*.js').filter((file) =>
    !file.startsWith('scripts/test_')
    && file !== 'scripts/earnings_week.js'
    && /require\(['"]\.\/earnings_week_(?:build|validation)['"]\)/.test(fs.readFileSync(path.join(root, file), 'utf8'))
  );
  if (privateEarningsImports.length) {
    throw new Error(`Private Earnings implementations must be reached through earnings_week.js: ${privateEarningsImports.join(', ')}.`);
  }
  const testEnvironment = { ...process.env, DASHBOARD_TEST_NO_API_CREDENTIALS: '1' };
  delete testEnvironment.FINNHUB_API_KEY;
  delete testEnvironment.EARNINGSAPI_API_KEY;
  for (const file of ['test_news.js', 'test_earnings_week.js', 'test_week_ahead.js', 'test_dashboard.js']) {
    runReadinessCommand(process.execPath, [path.join('scripts', file)], { env: testEnvironment });
  }
  process.stdout.write('Validating the canonical dashboard artifact...\n');
  const canonicalHtml = fs.readFileSync(defaultDashboard, 'utf8');
  const canonicalDataMatch = canonicalHtml.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  const canonicalEditionId = canonicalDataMatch ? JSON.parse(canonicalDataMatch[1]).editionId : '';
  const priorValidationNow = process.env.VALIDATE_NOW_ISO;
  if (canonicalEditionId) process.env.VALIDATE_NOW_ISO = canonicalEditionId;
  try {
    runReadinessCommand(process.execPath, ['scripts/validate_dashboard.js', 'daily_financial_news.html']);
  } finally {
    if (priorValidationNow === undefined) delete process.env.VALIDATE_NOW_ISO;
    else process.env.VALIDATE_NOW_ISO = priorValidationNow;
  }
  runReadinessCommand('tidy', ['-q', '-e', 'daily_financial_news.html']);
  runReadinessCommand('git', ['diff', '--check']);
  runReadinessCommand('git', ['diff', '--cached', '--check']);
  process.stdout.write('Complete dashboard test suite passed.\n');
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
    runReadinessCommand(process.execPath, ['scripts/validate_dashboard.js', args.dashboard, '--require-editorial-review']);
    runReadinessCommand('tidy', ['-q', '-e', args.dashboard]);
    runReadinessCommand('git', ['diff', '--check']);
    runReadinessCommand('git', ['diff', '--cached', '--check']);
    if (!args.skipTests) runCompleteTestSuite();

    const allowed = new Set(args.allowedFiles.map((file) => path.normalize(file).replaceAll('\\', '/')));
    const unexpected = changedPaths().filter((file) => !allowed.has(file));
    if (unexpected.length) throw new Error(`Unexpected changed files: ${unexpected.join(', ')}.`);
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

function validateDashboardHtml(html, {
  requireEditorialReview = false,
  stagingCandidate = false,
  now: validationNow = new Date()
} = {}) {
const dashboardMatch = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
const chartDataMatch = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
const runtimeScriptMatches = [...html.matchAll(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/g)];
const maxFuturesStoryTagLength = 24;

const errors = [];
const warnings = [];
const MONDAY_MORNING_NEWS_START_MINUTES = 6 * 60 + 45;
const MONDAY_MORNING_NEWS_END_MINUTES = 7 * 60 + 30;

function escRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNow() {
  return validationNow;
}

function chicagoIsoDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function completedWindowCalendarRange(marker, editionId) {
  const match = String(marker || '').match(/^(\d{4}-\d{2}-\d{2}):(morning|afternoon)$/);
  if (!match || !isIsoDate(match[1]) || !isIsoDateTime(editionId)) return null;
  const [, markerDate, windowMode] = match;
  // The completion marker attests the active scheduled edition. A later manual
  // edition retains the marker for New-pill history but does not re-complete it.
  if (chicagoIsoDate(new Date(editionId)) !== markerDate) return null;
  const weekday = new Date(`${markerDate}T00:00:00Z`).getUTCDay();
  if (weekday < 1 || weekday > 5) return null;
  if (weekday === 5 && windowMode === 'afternoon') {
    return { from: markerDate, to: addDays(markerDate, 6) };
  }
  const monday = addDays(markerDate, 1 - weekday);
  return { from: monday, to: addDays(monday, 4) };
}

function validateCompletedWindowCalendarRange(errors, data, marker) {
  const expected = completedWindowCalendarRange(marker, data.editionId);
  if (!expected) return;
  const expectedLabel = `${expected.from} through ${expected.to}`;
  for (const [label, range] of [
    ['earnings.week', data.earnings?.week?.range],
    ['weekAhead', data.weekAhead?.range]
  ]) {
    if (range?.from !== expected.from || range?.to !== expected.to) {
      errors.push(`${label}.range must be ${expectedLabel} before newsBaseline.lastScheduledWindow can record ${marker}.`);
    }
  }
}

function chicagoDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  return {
    weekday: part('weekday'),
    isoDate: `${part('year')}-${part('month')}-${part('day')}`,
    clockMinutes: Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) * 60 + minute : null
  };
}

function chicagoClockMinutes(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(seconds * 1000));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

function allowedNewsDates(now) {
  const current = chicagoDateParts(now);
  const allowed = new Set([
    current.isoDate,
    chicagoIsoDate(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  ]);
  // Article-age freshness is identical for scheduled and manual editions; the
  // Monday-morning allowance reflects the weekend news cycle, not scheduler state.
  if (
    current.weekday === 'Mon' &&
    current.clockMinutes !== null &&
    current.clockMinutes >= MONDAY_MORNING_NEWS_START_MINUTES &&
    current.clockMinutes <= MONDAY_MORNING_NEWS_END_MINUTES
  ) {
    allowed.add(chicagoIsoDate(new Date(now.getTime() - 48 * 60 * 60 * 1000)));
  }
  return allowed;
}

function isOffsetBearingIsoDateTime(value) {
  return isIsoDateTime(value);
}

/* TEST BLOCK START: futures-story-window */
function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') % 24,
    minute: part('minute'),
    second: part('second')
  };
}

function zonedDateTime({ year, month, day, hour, minute }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetParts = zonedDateParts(new Date(utcGuess), timeZone);
  const observedAsUtc = Date.UTC(
    offsetParts.year,
    offsetParts.month - 1,
    offsetParts.day,
    offsetParts.hour,
    offsetParts.minute,
    offsetParts.second
  );
  return new Date(utcGuess - (observedAsUtc - utcGuess));
}

function sharedFuturesReferenceDate(futures) {
  const dates = (Array.isArray(futures) ? futures : [])
    .map((future) => String(future?.raw?.referenceDate || '').trim());
  if (!dates.length || dates.some((date) => !isIsoDate(date))) return '';
  return new Set(dates).size === 1 ? dates[0] : '';
}

function sharedFuturesSessionDate(futures) {
  const dates = (Array.isArray(futures) ? futures : [])
    .map((future) => String(future?.raw?.sessionDate || '').trim());
  if (!dates.length || dates.some((date) => !isIsoDate(date))) return '';
  return new Set(dates).size === 1 ? dates[0] : '';
}

function futuresStoryPublicationWindow(sectionTitle, editionId, now, futures) {
  const runAt = isIsoDateTime(editionId) ? new Date(editionId) : now;
  const sessionDate = sharedFuturesSessionDate(futures);
  const [year, month, day] = sessionDate.split('-').map(Number);
  const eastern = sessionDate
    ? { year, month, day }
    : zonedDateParts(runAt, 'America/New_York');
  if (sectionTitle === 'Pre-Market Futures') {
    const referenceDate = sharedFuturesReferenceDate(futures);
    if (!referenceDate) return null;
    const [year, month, day] = referenceDate.split('-').map(Number);
    return {
      start: zonedDateTime({ year, month, day, hour: 16, minute: 0 }, 'America/New_York'),
      end: runAt,
      description: 'the fetched prior U.S. regular-session close and the dashboard run time'
    };
  }
  if (sectionTitle === 'Session Futures') {
    const start = zonedDateTime({ ...eastern, hour: 9, minute: 30 }, 'America/New_York');
    const marketClose = zonedDateTime({ ...eastern, hour: 16, minute: 0 }, 'America/New_York');
    return {
      start,
      end: new Date(Math.min(runAt.getTime(), marketClose.getTime())),
      description: 'the current U.S. regular-session open and the earlier of the regular-session close or dashboard run time'
    };
  }
  return null;
}
/* TEST BLOCK END: futures-story-window */

function numericPercent(value) {
  const match = String(value ?? '').trim().match(/^([+-]?\d+(?:\.\d+)?)%$/);
  return match ? Number(match[1]) : null;
}

function nearlyEqual(left, right, tolerance = 0.01) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

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
  const dataBlock = dashboardMatch[1];
  // This guard is intentionally scoped to the embedded data block so JS escape helpers do not false-positive.
  const entityMatch = dataBlock.match(/&(amp|lt|gt);/);
  if (entityMatch) {
    errors.push(`Embedded dashboard JSON contains HTML entity "${entityMatch[0]}"; use normal text unless markup is intended.`);
  }

  let data;
  try {
    data = JSON.parse(dataBlock);
  } catch (error) {
    errors.push(`Embedded dashboard JSON is invalid: ${error.message}`);
  }

  if (data) {
    const now = getNow();
    for (const message of validateWeekAheadPayload(data.weekAhead, { now })) {
      errors.push(`weekAhead: ${message}`);
    }
    if (requireEditorialReview) {
      for (const [dayIndex, day] of (data.weekAhead?.days || []).entries()) {
        if (day?.lifecycle === 'close_available' && (!day.outcome?.title?.trim() || !day.outcome?.body?.trim() || day.outcome?.source !== 'editorial')) {
          errors.push(`weekAhead.days[${dayIndex}].outcome requires editorial title and body text before publication.`);
        }
      }
    }
    if (data.editorialReview) {
      let receiptChartData = null;
      try {
        receiptChartData = chartDataMatch ? JSON.parse(chartDataMatch[1]) : null;
      } catch (_error) {
        // The chart contract reports its own parse error below.
      }
      for (const message of validateReviewManifest(data.editorialReview, data, { requireEmbedded: true, chartData: receiptChartData })) {
        errors.push(message);
      }
    } else {
      if (requireEditorialReview) errors.push('dashboard-data.editorialReview is required for publication.');
      for (const claim of superlativeClaims(data)) {
        errors.push(`${claim.path} contains unverified superlative claim "${claim.phrase}".`);
      }
    }
    const tapeRows = data.tape?.rows ?? [];
    // README Data Contracts split chartable crypto tickers from crypto-only section stats.
    const cryptoTickerRows = tapeRows.filter((row) => String(row?.group ?? '') === 'Crypto');
    const cryptoStatRows = data.crypto?.stats ?? [];
    const seenTapeTickers = new Set();
    for (const [index, rowRaw] of tapeRows.entries()) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const ticker = String(row.ticker ?? '').trim().toUpperCase();
      if (!ticker) continue;
      if (seenTapeTickers.has(ticker)) {
        errors.push(`tape.rows[${index}].ticker duplicates ${ticker}; each dashboard row must have a unique ticker.`);
      }
      seenTapeTickers.add(ticker);
    }
    const sourcePattern = /(\bAP\b|Washington Post|Reuters|Investing\.com|Federal Reserve|Yahoo Finance|CoinGecko|\bsource\b|\bsnapshot\b|\brecap\b|\blisting\b)/i;
    const staticTickerNotePattern = /(placeholder|no update|no fresh|unchanged|static|evergreen|same as yesterday|table snapshot showed|historical close datasets showed|held modest gains|quote recap|price recap|latest quote|latest close)/i;
    const requireString = (value, label) => {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${label} must be populated.`);
      }
    };
    if (data.crypto && Object.prototype.hasOwnProperty.call(data.crypto, 'tape')) {
      errors.push('crypto.tape is deprecated; crypto tickers belong in tape.rows and crypto-only stat rows belong in crypto.stats.');
    }
    const validateTickerNote = ({ note, values, label }) => {
      requireString(note, `${label}.note`);
      const text = String(note ?? '').trim();
      if (!text) return;
      if (text.split(/\s+/).length < 12) {
        errors.push(`${label}.note must include substantive daily market context, not a short label.`);
      }
      if (sourcePattern.test(text)) {
        errors.push(`${label}.note contains source/citation or process language.`);
      }
      if (staticTickerNotePattern.test(text)) {
        errors.push(`${label}.note looks static, placeholder-like, or quote-recap-only.`);
      }
      for (const value of values) {
        if (value && value !== '0.00' && text.includes(String(value))) {
          errors.push(`${label}.note repeats row value "${value}".`);
        }
      }
    };
    const requireHttpsUrl = (url, label) => {
      const raw = String(url ?? '').trim();
      let isHttps = false;
      try {
        isHttps = raw.length > 0 && new URL(raw).protocol === 'https:';
      } catch (_error) {
        isHttps = false;
      }
      if (!isHttps) errors.push(`${label} must include an HTTPS url.`);
    };
    const requireIsoDate = (value, label) => {
      if (!isIsoDate(value)) {
        errors.push(`${label} must be an ISO date.`);
      }
    };
    const validateStoryFreshness = (itemRaw, label, additionalAllowedDates = []) => {
      const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
      if (item.referencePage !== undefined) {
        errors.push(`${label}.referencePage is not supported; news items must be dated articles.`);
      }
      requireIsoDate(item.publishedOn, `${label}.publishedOn`);
      const publishedOn = String(item.publishedOn ?? '').trim();
      if (publishedOn && !allowedStoryDates.has(publishedOn) && !additionalAllowedDates.includes(publishedOn)) {
        errors.push(`${label}.publishedOn must follow the local calendar-date freshness rule in America/Chicago (today/yesterday, plus Saturday for a Monday morning edition, or the active futures session date for session-bound news).`);
      }
    };
    const validateDividendEvents = (events, label, { optional = false } = {}) => {
      if (events === undefined && optional) return;
      if (!Array.isArray(events)) {
        errors.push(`${label} must be an array.`);
        return;
      }
      events.forEach((eventRaw, eventIndex) => {
        const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : {};
        requireIsoDate(event.exDate, `${label}[${eventIndex}].exDate`);
        if (!Number.isFinite(Number(event.amount))) {
          errors.push(`${label}[${eventIndex}].amount must be numeric.`);
        }
      });
    };
    const validateRequiredDividendBucket = (row, label, textKey, valueKey, eventsKey) => {
      requireString(row[textKey], `${label}.${textKey}`);
      if (!Number.isFinite(Number(row[valueKey]))) {
        errors.push(`${label}.${valueKey} must be numeric.`);
      }
      validateDividendEvents(row[eventsKey], `${label}.${eventsKey}`);
    };

    // Dashboard dates are a hard contract because automation skip logic relies on them.
    const todayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).formatToParts(now);
    const part = (type) => todayParts.find((p) => p.type === type)?.value || '';
    const expectedDay = part('weekday');
    const expectedMonth = part('month');
    const expectedDate = part('day');
    const expectedYear = part('year');
    const allowedStoryDates = allowedNewsDates(now);
    const mastheadEdition = String(data.masthead?.edition ?? '').trim();
    const mastheadDate = String(data.masthead?.date ?? '');
    const footerCompiled = String(data.footer?.compiled ?? '');
    if (!isIsoDateTime(data.editionId)) {
      errors.push('dashboard-data.editionId must be a populated ISO timestamp.');
    }
    if (!mastheadEdition) {
      errors.push('masthead.edition must be a non-empty string.');
    }
    const dateMsg = `Masthead/footer may be stale: expected ${expectedDay}, ${expectedMonth} ${expectedDate}, ${expectedYear}.`;

    const mastheadLooksFresh = new RegExp(
      `\\b${escRegex(expectedDay)}\\b[\\s\\S]*\\b${escRegex(expectedMonth)}\\b[\\s\\S]*\\b${escRegex(expectedDate)}\\b[\\s\\S]*\\b${escRegex(expectedYear)}\\b`,
      'i'
    ).test(mastheadDate);
    const footerLooksFresh = new RegExp(
      `\\b${escRegex(expectedMonth)}\\b[\\s\\S]*\\b${escRegex(expectedDate)}\\b(?:,)?[\\s\\S]*\\b${escRegex(expectedYear)}\\b`,
      'i'
    ).test(footerCompiled);
    if (!mastheadLooksFresh || !footerLooksFresh) {
      errors.push(dateMsg);
    }

    // Promoted-dashboard schema gates: catch old mockup/legacy sections and missing embedded production data.
    if (data.lede) {
      errors.push('Legacy lede section should not be present in the promoted dashboard data.');
    }
    if (data.renesas) {
      errors.push('Legacy renesas section should not be present in the promoted dashboard data.');
    }

    requireString(data.opening?.headline, 'opening.headline');
    requireString(data.opening?.deck, 'opening.deck');
    const catalysts = Array.isArray(data.opening?.catalysts) ? data.opening.catalysts : [];
    if (catalysts.length !== 4) {
      errors.push('opening.catalysts must contain exactly four catalyst items.');
    }
    for (const [index, catalystRaw] of catalysts.entries()) {
      const catalyst = catalystRaw && typeof catalystRaw === 'object' ? catalystRaw : {};
      requireString(catalyst.label, `opening.catalysts[${index}].label`);
      requireString(catalyst.body, `opening.catalysts[${index}].body`);
    }

    // The editorial Tape roster is intentionally open-ended. Its rows define the
    // chart/source contract for this edition without the validator prescribing symbols.
    const expectedChartSourceSymbols = new Map();
    const expectedChartSections = new Map();
    for (const [index, row] of tapeRows.entries()) {
      const ticker = String(row?.ticker ?? '').toUpperCase();
      requireString(row?.sourceSymbol, `tape.rows[${index}].sourceSymbol`);
      if (ticker && row?.sourceSymbol) {
        expectedChartSourceSymbols.set(ticker, row.sourceSymbol);
        expectedChartSections.set(ticker, String(row?.group ?? '') === 'Crypto' ? 'crypto' : 'tape');
      }
    }

    if (!chartDataMatch) {
      errors.push('Could not find chart-data JSON block; production charts must use embedded generated data.');
    } else {
      let chartData;
      try {
        chartData = JSON.parse(chartDataMatch[1]);
      } catch (error) {
        errors.push(`Embedded chart-data JSON is invalid: ${error.message}`);
      }

      if (chartData) {
        if (chartData.barEncoding !== 'tuple-v1') {
          errors.push('chart-data.barEncoding must be tuple-v1.');
        }
        const {
          decodedSeries: chartSeries,
          seriesByTicker: chartSeriesByTicker,
          tapeRows: chartTapeQuoteRows,
          cryptoRows: chartCryptoQuoteRows
        } = validateChartPayload(errors, chartData, {
          expectedByTicker: expectedChartSourceSymbols,
          expectedSectionByTicker: expectedChartSections,
          decodeSeries: decodeTupleSeries,
          label: 'chart-data',
          absentMessage: 'has no matching dashboard Tape row.',
          duplicateMessage: 'Duplicate embedded chart series for',
          missingMessage: 'Embedded chart data is missing',
          volumeDescription: 'embedded'
        });
        const dashboardStoryUrls = new Set([
          ...(Array.isArray(data.stories) ? data.stories : []),
          ...(Array.isArray(data.crypto?.notes) ? data.crypto.notes : []),
          ...(Array.isArray(data.futuresModule?.stories) ? data.futuresModule.stories : [])
        ].map((story) => String(story?.url || '')).filter(Boolean));
        for (const day of data.weekAhead?.days || []) {
          const lens = day?.marketLens;
          if (!lens) continue;
          for (const reaction of lens.reactions || []) {
            const ticker = String(reaction?.ticker || '').toUpperCase();
            if (!seenTapeTickers.has(ticker)) errors.push(`weekAhead ${day.date} reaction ticker ${ticker} is not present in tape.rows.`);
            if (!chartSeriesByTicker.has(ticker)) errors.push(`weekAhead ${day.date} reaction ticker ${ticker} has no embedded chart series.`);
          }
          for (const reference of lens.setup?.evidence || []) {
            if (reference.kind === 'opening' && !String(data.opening?.[reference.field] || '').trim()) {
              errors.push(`weekAhead ${day.date} opening.${reference.field} evidence is unavailable.`);
            }
            if (reference.kind === 'tape' && !seenTapeTickers.has(reference.ticker)) {
              errors.push(`weekAhead ${day.date} Tape evidence ${reference.ticker} is unavailable.`);
            }
            if (reference.kind === 'story' && !dashboardStoryUrls.has(reference.url)) {
              errors.push(`weekAhead ${day.date} story evidence ${reference.url} is unavailable.`);
            }
          }
          for (const reactionRow of day.marketReaction?.rows || []) {
            // The domain contract validates reaction arithmetic; this
            // cross-section gate proves the published values and unit still
            // come from the embedded chart series that canonically owns them.
            const series = chartSeriesByTicker.get(String(reactionRow?.ticker || '').toUpperCase());
            const eventIndex = (series?.bars || []).findIndex((bar) => bar?.time === day.date);
            const current = eventIndex >= 0 ? series.bars[eventIndex] : null;
            const previous = eventIndex > 0 ? series.bars[eventIndex - 1] : null;
            if (!current || !previous) {
              errors.push(`weekAhead ${day.date} close reaction ${reactionRow?.ticker || '(missing)'} has no matching event-day and previous chart bars.`);
              continue;
            }
            if (Math.abs(Number(reactionRow.close) - Number(current.close)) > 0.0001 || Math.abs(Number(reactionRow.previousClose) - Number(previous.close)) > 0.0001) {
              errors.push(`weekAhead ${day.date} close reaction ${reactionRow.ticker} must match embedded chart-data closes.`);
            }
            if (reactionRow.unit !== (series.unit || 'price')) {
              errors.push(`weekAhead ${day.date} close reaction ${reactionRow.ticker} unit must match embedded chart-data.`);
            }
          }
        }
        const chartTapeQuoteByTicker = new Map(chartTapeQuoteRows.map((row) => [String(row?.ticker || '').toUpperCase(), row]));
        const chartCryptoQuoteByTicker = new Map(chartCryptoQuoteRows.map((row) => [String(row?.ticker || row?.sym || '').toUpperCase(), row]));
        const yieldCurveSeries = chartSeries.find((item) => item?.sourceSymbol === 'TREASURY:CURVE');
        const yieldCurveQuoteRow = yieldCurveSeries
          ? chartTapeQuoteByTicker.get(String(yieldCurveSeries.ticker || '').toUpperCase())
          : null;
        if (yieldCurveQuoteRow && !/^2s10s [+-]\d+ bp$/.test(String(yieldCurveQuoteRow.last || ''))) {
          errors.push('Embedded chart-data yield-curve quote must show the 2s10s spread instead of repeating the 10Y yield.');
        }
        const requireMatchingQuoteFields = ({ dashboardRow, chartRow, fields, label }) => {
          if (!chartRow) {
            errors.push(`Embedded chart-data quoteRows is missing ${label}.`);
            return;
          }
          for (const field of fields) {
            const dashboardValue = String(dashboardRow?.[field] ?? '');
            const chartValue = String(chartRow?.[field] ?? '');
            if (dashboardValue !== chartValue) {
              errors.push(`${label}.${field} must match embedded chart-data quoteRows value "${chartValue}".`);
            }
          }
        };
        for (const row of tapeRows) {
          const ticker = String(row?.ticker ?? '').toUpperCase();
          if (!ticker || String(row?.group ?? '') === 'Crypto') continue;
          requireMatchingQuoteFields({
            dashboardRow: row,
            chartRow: chartTapeQuoteByTicker.get(ticker),
            fields: ['last', 'delta', 'pct', 'dir', 'asOf'],
            label: `tape.rows ${ticker}`
          });
        }
        for (const rowRaw of cryptoTickerRows) {
          const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
          const ticker = String(row.ticker ?? '').toUpperCase();
          if (!ticker) continue;
          const chartRow = chartCryptoQuoteByTicker.get(ticker);
          if (!chartRow) {
            errors.push(`Embedded chart-data quoteRows is missing tape.rows Crypto ${ticker}.`);
            continue;
          }
          const fieldPairs = [
            // chart-data.quoteRows.crypto keeps its formatter names; embedded dashboard rows stay on Tape names.
            ['last', 'price'],
            ['delta', 'delta'],
            ['pct', 'chg'],
            ['dir', 'dir'],
            ['asOf', 'asOf']
          ];
          for (const [dashboardField, chartField] of fieldPairs) {
            const dashboardValue = String(row?.[dashboardField] ?? '');
            const chartValue = String(chartRow?.[chartField] ?? '');
            if (dashboardValue !== chartValue) {
              errors.push(`tape.rows Crypto ${ticker}.${dashboardField} must match embedded chart-data quoteRows.crypto ${chartField} value "${chartValue}".`);
            }
          }
        }
      }
    }

    const futuresModule = data.futuresModule && typeof data.futuresModule === 'object' ? data.futuresModule : {};
    if (!data.futuresModule || typeof data.futuresModule !== 'object') {
      errors.push('futuresModule must be populated.');
    }
    requireString(futuresModule.sectionLabel, 'futuresModule.sectionLabel');
    requireString(futuresModule.sectionTitle, 'futuresModule.sectionTitle');
    const futuresSectionLabel = String(futuresModule.sectionLabel || '').trim();
    const futuresSectionTitle = String(futuresModule.sectionTitle || '').trim();
    const knownFuturesWindow = (
      (futuresSectionLabel === 'Before The Open' && futuresSectionTitle === 'Pre-Market Futures')
      || (futuresSectionLabel === 'After The Bell' && futuresSectionTitle === 'Session Futures')
    );
    if (!knownFuturesWindow) {
      errors.push(`futuresModule section labels must be either Before The Open/Pre-Market Futures or After The Bell/Session Futures, got ${futuresSectionLabel}/${futuresSectionTitle}.`);
    } else {
      const expectedEdition = futuresSectionTitle === 'Pre-Market Futures' ? 'Morning Edition' : 'Afternoon Edition';
      if (mastheadEdition !== expectedEdition) {
        errors.push(`masthead.edition must be ${expectedEdition} when futuresModule is ${futuresSectionLabel}/${futuresSectionTitle}.`);
      }
    }

    // Runtime does not fetch sidecar files; futures-module rows must be embedded and chart-ready.
    const futures = Array.isArray(futuresModule.futures) ? futuresModule.futures : [];
    if (futures.length !== 4) {
      errors.push('futuresModule.futures must contain exactly four index-futures rows.');
    }
    const tapeSessionDate = futures.find((row) => isIsoDate(row?.raw?.sessionDate))?.raw?.sessionDate;
    if (tapeSessionDate && futuresSectionLabel) {
      const tapeSessionWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
        .format(new Date(`${tapeSessionDate}T12:00:00Z`));
      const expectedTapePrefix = `${tapeSessionWeekday} ${futuresSectionLabel}`;
      if (!String(data.tape?.label || '').startsWith(expectedTapePrefix)) {
        errors.push(`tape.label must start with the deterministic session prefix "${expectedTapePrefix}".`);
      }
    }
    const isSessionFutures = futuresSectionTitle === 'Session Futures';
    for (const [index, futureRaw] of futures.entries()) {
      const future = futureRaw && typeof futureRaw === 'object' ? futureRaw : {};
      requireString(future.label, `futuresModule.futures[${index}].label`);
      requireString(future.value, `futuresModule.futures[${index}].value`);
      requireString(future.body, `futuresModule.futures[${index}].body`);
      let firstSeriesPrice = null;
      let lastSeriesPrice = null;
      let lastSeriesTime = null;
      const priceAt = (point) => Number(Array.isArray(point) ? point[1] : point?.price ?? point?.value);
      const timeAt = (point) => Number(Array.isArray(point) ? point[0] : point?.time);
      if (Array.isArray(future.series) && future.series.length) {
        firstSeriesPrice = priceAt(future.series[0]);
        lastSeriesPrice = priceAt(future.series[future.series.length - 1]);
        lastSeriesTime = timeAt(future.series[future.series.length - 1]);
      }
      if (!Array.isArray(future.series) || future.series.length < 2) {
        errors.push(`futuresModule.futures[${index}].series must contain at least two chart points.`);
      } else if (future.series.some((point) => !Number.isFinite(priceAt(point)) || priceAt(point) <= 0)) {
        errors.push(`futuresModule.futures[${index}].series must contain positive prices.`);
      }
      if (isSessionFutures && Array.isArray(future.series)) {
        // Session Futures should be a completed cash-session chart even when the afternoon update runs later.
        for (const point of future.series) {
          const minutes = chicagoClockMinutes(Array.isArray(point) ? point[0] : point?.time);
          if (minutes === null || minutes < 8 * 60 + 30 || minutes > 15 * 60) {
            errors.push(`futuresModule.futures[${index}].series contains a point outside the 8:30 AM-3:00 PM Central Session Futures window.`);
            break;
          }
        }
      }
      // Keep the source prior close available for audit/provenance; Session Futures uses raw.referencePrice as its chart baseline.
      if (!Number.isFinite(Number(future.raw?.previousClose)) || Number(future.raw.previousClose) <= 0) {
        errors.push(`futuresModule.futures[${index}].raw.previousClose must be positive for futures source prior-close provenance.`);
      }
      const referencePrice = Number(future.raw?.referencePrice ?? future.raw?.previousClose);
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        errors.push(`futuresModule.futures[${index}].raw reference price must be positive for the futures chart baseline.`);
      }
      if (!Number.isFinite(Number(future.raw?.price)) || Number(future.raw.price) <= 0) {
        errors.push(`futuresModule.futures[${index}].raw.price must be positive.`);
      } else if (lastSeriesPrice !== null && !nearlyEqual(Number(future.raw?.price), lastSeriesPrice, 0.01)) {
        errors.push(`futuresModule.futures[${index}].raw.price must match the last futures chart point.`);
      }
      if (!Number.isFinite(Number(future.raw?.regularMarketTime))) {
        errors.push(`futuresModule.futures[${index}].raw.regularMarketTime must be numeric.`);
      } else if (lastSeriesTime !== null && Number(future.raw?.regularMarketTime) !== lastSeriesTime) {
        errors.push(`futuresModule.futures[${index}].raw.regularMarketTime must match the last futures chart timestamp.`);
      }
      const expectedDelta = lastSeriesPrice === null ? null : lastSeriesPrice - referencePrice;
      const expectedPct = lastSeriesPrice === null ? null : (referencePrice ? (expectedDelta / referencePrice) * 100 : 0);
      const rawPct = Number(future.raw?.pct);
      const expectedDir = rawPct > 0 ? 'up' : rawPct < 0 ? 'down' : 'flat';
      if (!['up', 'down', 'flat'].includes(future.dir)) {
        errors.push(`futuresModule.futures[${index}].dir must be up, down, or flat.`);
      } else if (Number.isFinite(rawPct) && future.dir !== expectedDir) {
        errors.push(`futuresModule.futures[${index}].dir must match raw.pct.`);
      }
      if (expectedDelta !== null && !nearlyEqual(Number(future.raw?.delta), expectedDelta, 0.01)) {
        errors.push(`futuresModule.futures[${index}].raw.delta must match the futures chart change.`);
      }
      if (expectedPct !== null && !nearlyEqual(Number(future.raw?.pct), expectedPct, 0.001)) {
        errors.push(`futuresModule.futures[${index}].raw.pct must match the futures chart percent change.`);
      }
      const displayedPct = numericPercent(future.value);
      if (displayedPct !== null && expectedPct !== null && !nearlyEqual(displayedPct, expectedPct, 0.01)) {
        errors.push(`futuresModule.futures[${index}].value must match the rounded futures chart percent change.`);
      }
      if (isSessionFutures) {
        if (!Number.isFinite(Number(future.raw?.referencePrice)) || Number(future.raw.referencePrice) <= 0) {
          errors.push(`futuresModule.futures[${index}].raw.referencePrice must be positive for Session Futures.`);
        }
        if (!Number.isFinite(Number(future.raw?.sessionOpen)) || Number(future.raw.sessionOpen) <= 0) {
          errors.push(`futuresModule.futures[${index}].raw.sessionOpen must be positive for Session Futures.`);
        } else if (!nearlyEqual(Number(future.raw.sessionOpen), firstSeriesPrice, 0.001)) {
          errors.push(`futuresModule.futures[${index}].raw.sessionOpen must match the first Session Futures chart point.`);
        }
        requireString(future.raw?.referenceDate, `futuresModule.futures[${index}].raw.referenceDate`);
        requireString(future.raw?.referenceLabel, `futuresModule.futures[${index}].raw.referenceLabel`);
        requireString(future.raw?.marketTimeZone, `futuresModule.futures[${index}].raw.marketTimeZone`);
        requireString(future.raw?.sessionStartEastern, `futuresModule.futures[${index}].raw.sessionStartEastern`);
        requireString(future.raw?.sessionEndEastern, `futuresModule.futures[${index}].raw.sessionEndEastern`);
        requireString(future.raw?.referenceCloseEastern, `futuresModule.futures[${index}].raw.referenceCloseEastern`);
        if (!/prior 4 PM ET close/i.test(String(future.raw?.referenceLabel || ''))) {
          errors.push(`futuresModule.futures[${index}].raw.referenceLabel must store the official prior 4 PM ET close baseline.`);
        }
        if (!/prior 4 PM ET close/i.test(String(future.body || ''))) {
          errors.push(`futuresModule.futures[${index}].body must describe Session Futures change as vs prior 4 PM ET close.`);
        }
        if (future.raw?.marketTimeZone !== 'America/New_York') {
          errors.push(`futuresModule.futures[${index}].raw.marketTimeZone must store official market times in America/New_York.`);
        }
        if (future.raw?.sessionStartEastern !== '9:30 AM ET' || future.raw?.sessionEndEastern !== '4:00 PM ET' || future.raw?.referenceCloseEastern !== '4:00 PM ET') {
          errors.push(`futuresModule.futures[${index}] official Session Futures times must be stored in Eastern time.`);
        }
      }
    }

    const isPreMarketFutures = futuresSectionTitle === 'Pre-Market Futures';
    if (isPreMarketFutures) {
      for (const [index, futureRaw] of futures.entries()) {
        const future = futureRaw && typeof futureRaw === 'object' ? futureRaw : {};
        if (!isIsoDate(future.raw?.referenceDate)) {
          errors.push(`futuresModule.futures[${index}].raw.referenceDate must be an ISO date for Pre-Market Futures.`);
        }
        if (future.raw?.referenceCloseEastern !== '4:00 PM ET') {
          errors.push(`futuresModule.futures[${index}].raw.referenceCloseEastern must store the prior U.S. regular-session close for Pre-Market Futures.`);
        }
      }
      if (!sharedFuturesReferenceDate(futures)) {
        errors.push('Pre-Market Futures rows must share one valid raw.referenceDate from the fetched prior regular-session close.');
      }
    }

    const futuresModuleStories = Array.isArray(futuresModule.stories) ? futuresModule.stories : [];
    const futuresStoryWindow = futuresStoryPublicationWindow(futuresSectionTitle, data.editionId, now, futures);
    if (futuresModuleStories.length !== 3) {
      errors.push('futuresModule.stories must contain exactly three priority stories.');
    }
    const futuresStoryUrls = new Map();
    for (const [index, storyRaw] of futuresModuleStories.entries()) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      requireString(story.tag, `futuresModule.stories[${index}].tag`);
      if (String(story.tag || '').trim().length > maxFuturesStoryTagLength) {
        errors.push(`futuresModule.stories[${index}].tag must be ${maxFuturesStoryTagLength} characters or fewer to preserve the shared story-label column.`);
      }
      requireString(story.title, `futuresModule.stories[${index}].title`);
      requireString(story.body, `futuresModule.stories[${index}].body`);
      requireHttpsUrl(story.url, `futuresModule.stories[${index}]`);
      const canonicalUrl = canonicalStoryUrl(story.url);
      if (canonicalUrl) {
        const earlierIndex = futuresStoryUrls.get(canonicalUrl);
        if (earlierIndex !== undefined) {
          errors.push(`futuresModule.stories[${index}].url duplicates futuresModule.stories[${earlierIndex}].url.`);
        } else {
          futuresStoryUrls.set(canonicalUrl, index);
        }
      }
      // Weekend editions retain the last fetched session's news window; general and crypto news remain bound to the current freshness dates.
      validateStoryFreshness(story, `futuresModule.stories[${index}]`, [sharedFuturesSessionDate(futures)]);
      if (futuresStoryWindow) {
        const publishedAt = String(story.publishedAt ?? '').trim();
        if (!isOffsetBearingIsoDateTime(publishedAt)) {
          errors.push(`futuresModule.stories[${index}].publishedAt must be an offset-bearing ISO timestamp.`);
          continue;
        }
        const publishedAtMs = Date.parse(publishedAt);
        if (publishedAtMs < futuresStoryWindow.start.getTime() || publishedAtMs > futuresStoryWindow.end.getTime()) {
          errors.push(`futuresModule.stories[${index}].publishedAt must fall between ${futuresStoryWindow.description}.`);
        }
      }
    }

    // Portfolio validation is instrument-level only; tactical weights/model outputs are intentionally out of scope here.
    const portfolio = data.assetAllocationPortfolio && typeof data.assetAllocationPortfolio === 'object'
      ? data.assetAllocationPortfolio
      : {};
    const hasPortfolioReturn = portfolio.portfolioMtdReturnStatus !== undefined
      || portfolio.portfolioMtdReturnValue !== undefined
      || portfolio.portfolioMtdReturnAsOf !== undefined
      || portfolio.portfolioMtdReturnStale !== undefined;
    if (hasPortfolioReturn) {
      // This proves only the sanitized display contract. It intentionally does
      // not validate allocation weights, signals, or any source calculation.
      if (!['available', 'unavailable'].includes(portfolio.portfolioMtdReturnStatus)) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnStatus must be available or unavailable.');
      }
      if (portfolio.portfolioMtdReturnStatus === 'available' && !Number.isFinite(Number(portfolio.portfolioMtdReturnValue))) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnValue must be finite when status is available.');
      }
      if (portfolio.portfolioMtdReturnStatus === 'unavailable' && portfolio.portfolioMtdReturnValue !== null) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnValue must be null when status is unavailable.');
      }
      requireIsoDate(portfolio.portfolioMtdReturnAsOf, 'assetAllocationPortfolio.portfolioMtdReturnAsOf');
      if (typeof portfolio.portfolioMtdReturnStale !== 'boolean') {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnStale must be boolean.');
      }
    }
    const portfolioRows = Array.isArray(data.assetAllocationPortfolio?.rows) ? data.assetAllocationPortfolio.rows : [];
    const requiredPortfolioTickers = ['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX'];
    const portfolioTickerSet = new Set(portfolioRows.map((row) => String(row?.ticker ?? '').toUpperCase()));
    for (const ticker of requiredPortfolioTickers) {
      if (!portfolioTickerSet.has(ticker)) {
        errors.push(`assetAllocationPortfolio.rows is missing ${ticker}.`);
      }
    }
    for (const rowRaw of portfolioRows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const label = `assetAllocationPortfolio row ${row.ticker ?? '(unknown)'}`;
      for (const key of ['ticker', 'sleeve', 'price', 'monthDivPerShare', 'dailyPriceChange', 'dailyTR', 'mtdPriceChange', 'mtdTR']) {
        requireString(row[key], `${label}.${key}`);
      }
      validateDividendEvents(row.dividends, `${label}.dividends`, { optional: true });
      // The portfolio fetcher always emits these lookahead buckets; require
      // them so stale pre-lookahead payloads cannot silently pass validation.
      validateRequiredDividendBucket(
        row,
        label,
        'upcomingCurrentMonthDividends',
        'upcomingCurrentMonthDividendsValue',
        'upcomingCurrentMonthDividendEvents'
      );
      validateRequiredDividendBucket(
        row,
        label,
        'futureMonthDividends',
        'futureMonthDividendsValue',
        'futureMonthDividendEvents'
      );
    }

    for (const rowRaw of tapeRows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      validateTickerNote({
        note: row.note,
        values: [row.last, row.delta, row.pct],
        label: `tape.rows ${row.ticker ?? row.name ?? '(unknown)'}`
      });
      if (row.sourceSymbol === 'TREASURY:CURVE' && !/^2s10s [+-]\d+ bp$/.test(String(row.last || ''))) {
        errors.push('The yield-curve Tape row must show the 2s10s spread instead of repeating the 10Y yield.');
      }
    }

    const cryptoNotes = data.crypto?.notes ?? [];
    const fng = cryptoStatRows.find(row => row.sym === 'F&G');
    const altcoinSeason = cryptoStatRows.find(row => row.sym === 'ALTSEASON' || /altcoin season/i.test(String(row?.name ?? '')));
    const staleFngPattern = /(numeric read|pull still failed|F&G ~|unavailable|not retrievable|not extractable)/i;

    for (const rowRaw of cryptoTickerRows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const ticker = String(row.ticker ?? row.name ?? '(unknown)').trim();
      validateTickerNote({
        note: row.note,
        values: [row.last, row.delta, row.pct],
        label: `tape.rows Crypto ${ticker}`
      });
    }

    for (const noteRaw of cryptoNotes) {
      const note = noteRaw && typeof noteRaw === 'object' ? noteRaw : {};
      const text = `${note.kicker ?? ''} ${note.title ?? ''} ${note.body ?? ''}`;
      if (staleFngPattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" contains stale F&G failure/unavailable language.`);
      }
      if (staticTickerNotePattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" looks static, placeholder-like, or quote-recap-only.`);
      }
      for (const rowRaw of cryptoTickerRows) {
        const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
        for (const value of [row.last, row.pct]) {
          if (value && !['Fear'].includes(String(value)) && text.includes(String(value))) {
            errors.push(`Crypto note "${note.title ?? '(untitled)'}" repeats crypto tape value "${value}".`);
          }
        }
      }
    }

    if (!Array.isArray(cryptoNotes) || cryptoNotes.length === 0) {
      errors.push('Crypto notes must include fresh daily crypto stories/items.');
    } else if (cryptoNotes.length > 6) {
      errors.push('Crypto notes must contain no more than six daily stories/items.');
    }

    const cryptoTotal = cryptoStatRows.find(row => row.sym === 'TOTAL' || /(?:total )?crypto market cap/i.test(String(row?.name ?? '')));
    if (!cryptoTotal) {
      errors.push('crypto.stats is missing the Crypto Market Cap stat row.');
    } else {
      requireString(cryptoTotal.price, 'Crypto Market Cap price');
      requireString(cryptoTotal.delta, 'Crypto Market Cap value change');
    }

    if (!fng) {
      errors.push('crypto.stats is missing the F&G row.');
    } else {
      const fngPrice = String(fng.price ?? '').trim();
      const fngChange = String(fng.chg ?? '').trim();

      if (!/^\d{1,3}$/.test(fngPrice)) {
        errors.push('F&G price must be a numeric 0-100 reading, not a placeholder.');
      } else {
        const value = Number(fngPrice);
        if (value < 0 || value > 100) {
          errors.push('F&G price must be between 0 and 100.');
        }
      }

      if (!fngChange || /^unavailable$/i.test(fngChange)) {
        errors.push('F&G change/classification must be populated.');
      }
    }

    if (!altcoinSeason) {
      errors.push('crypto.stats is missing the Altcoin Season Index stat row.');
    } else {
      const altcoinSeasonPrice = String(altcoinSeason.price ?? '').trim();
      const altcoinSeasonRange = String(altcoinSeason.chg ?? '').trim();

      if (!/^\d{1,3}$/.test(altcoinSeasonPrice)) {
        errors.push('Altcoin Season Index price must be a numeric 0-100 reading, not a placeholder.');
      } else {
        const value = Number(altcoinSeasonPrice);
        if (value < 0 || value > 100) {
          errors.push('Altcoin Season Index price must be between 0 and 100.');
        }
      }

      if (!altcoinSeason.sub || /^unavailable$/i.test(String(altcoinSeason.sub))) {
        errors.push('Altcoin Season Index classification must be populated.');
      }
      if (!String(altcoinSeason.delta ?? '').trim()) {
        errors.push('Altcoin Season Index change must be populated for the stat-card value line.');
      }
      if (!/^\/?100$/.test(altcoinSeasonRange)) {
        errors.push('Altcoin Season Index chg must show the /100 range label.');
      }
    }

    if (!/Alternative\.me Crypto Fear & Greed Index/i.test(String(data.footer?.compiled ?? ''))) {
      errors.push('Footer source list must include Alternative.me Crypto Fear & Greed Index when F&G is shown.');
    }
    if (!/CoinMarketCap Altcoin Season Index/i.test(String(data.footer?.compiled ?? ''))) {
      errors.push('Footer source list must include CoinMarketCap Altcoin Season Index when Altcoin Season is shown.');
    }

    const stories = Array.isArray(data.stories) ? data.stories : [];
    if (stories.length !== 9) {
      errors.push('stories must contain exactly 9 fresh market/news items.');
    }
    const trackedNewsItems = dashboardNewsItems(data);
    const storyIds = trackedNewsItems.map(storyIdentity).filter(Boolean);
    if (storyIds.length !== trackedNewsItems.length) {
      errors.push('Each stories[] and crypto.notes[] item must have a usable URL or title for scheduled New-pill tracking.');
    }
    if (new Set(storyIds).size !== storyIds.length) {
      errors.push('stories[] and crypto.notes[] items must have unique scheduled New-pill identities.');
    }
    const newsBaseline = data.newsBaseline && typeof data.newsBaseline === 'object' && !Array.isArray(data.newsBaseline)
      ? data.newsBaseline
      : null;
    if (!newsBaseline) {
      errors.push('newsBaseline must be embedded so scheduled New-pill tracking survives manual updates and fresh checkouts.');
    } else {
      if (newsBaseline.lastScheduledUpdateAt !== null && !isIsoDateTime(newsBaseline.lastScheduledUpdateAt)) {
        errors.push('newsBaseline.lastScheduledUpdateAt must be null or an ISO timestamp.');
      }
      if (newsBaseline.lastScheduledWindow !== null && !/^\d{4}-\d{2}-\d{2}:(morning|afternoon)$/.test(String(newsBaseline.lastScheduledWindow || ''))) {
        errors.push('newsBaseline.lastScheduledWindow must be null or a YYYY-MM-DD:morning/afternoon marker.');
      } else if (newsBaseline.lastScheduledWindow !== null && !isIsoDate(String(newsBaseline.lastScheduledWindow).slice(0, 10))) {
        errors.push('newsBaseline.lastScheduledWindow must use a real calendar date.');
      }
      validateCompletedWindowCalendarRange(errors, data, newsBaseline.lastScheduledWindow);
      for (const key of ['previousScheduledStoryIds', 'currentScheduledStoryIds']) {
        if (!Array.isArray(newsBaseline[key])) {
          errors.push(`newsBaseline.${key} must be an array.`);
          continue;
        }
        const seenIds = new Set();
        for (const [index, id] of newsBaseline[key].entries()) {
          if (typeof id !== 'string' || id.trim() === '') {
            errors.push(`newsBaseline.${key}[${index}] must be a non-empty string.`);
            continue;
          }
          if (seenIds.has(id)) {
            errors.push(`newsBaseline.${key} contains duplicate story id "${id}".`);
          }
          seenIds.add(id);
        }
      }
    }
    const previousScheduledStoryIds = new Set(Array.isArray(newsBaseline?.previousScheduledStoryIds) ? newsBaseline.previousScheduledStoryIds : []);
    const currentScheduledStoryIds = new Set(Array.isArray(newsBaseline?.currentScheduledStoryIds) ? newsBaseline.currentScheduledStoryIds : []);
    const comparisonStoryIds = previousScheduledStoryIds.size ? previousScheduledStoryIds : currentScheduledStoryIds;
    const validateNewPillState = (item, label) => {
      if (item.isNewSinceScheduledUpdate !== undefined && typeof item.isNewSinceScheduledUpdate !== 'boolean') {
        errors.push(`${label}.isNewSinceScheduledUpdate must be boolean when present.`);
      }
      const expectedNew = comparisonStoryIds.size > 0 && !comparisonStoryIds.has(storyIdentity(item));
      if (Boolean(item.isNewSinceScheduledUpdate) !== expectedNew) {
        errors.push(`${label} has stale isNewSinceScheduledUpdate state for the embedded scheduled baseline.`);
      }
    };
    const futuresModuleUrls = new Set(futuresModuleStories.map((story) => String(story?.url ?? '').trim()).filter(Boolean));
    const futuresModuleTitles = new Set(futuresModuleStories.map((story) => String(story?.title ?? '').trim().toLowerCase()).filter(Boolean));
    for (const storyRaw of stories) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      requireString(story.tag, `Story "${story.title ?? '(untitled)'}" tag`);
      requireString(story.title, 'stories[].title');
      requireString(story.body, `Story "${story.title ?? '(untitled)'}" body`);
      requireHttpsUrl(story.url, `Story "${story.title ?? '(untitled)'}"`);
      validateStoryFreshness(story, `Story "${story.title ?? '(untitled)'}"`);
      const storyTag = String(story.tag ?? '').trim().toLowerCase();
      const storyTone = String(story.tone ?? '').trim().toLowerCase();
      if (storyTag === 'crypto' || storyTone === 'crypto') {
        errors.push(`Story "${story.title ?? '(untitled)'}" should live in crypto.notes, not stories[].`);
      }
      validateNewPillState(story, `Story "${story.title ?? '(untitled)'}"`);
      const storyUrl = String(story.url ?? '').trim();
      const storyTitle = String(story.title ?? '').trim().toLowerCase();
      if (storyUrl && futuresModuleUrls.has(storyUrl)) {
        errors.push(`Story "${story.title ?? '(untitled)'}" duplicates a promoted futures-module URL.`);
      }
      if (storyTitle && futuresModuleTitles.has(storyTitle)) {
        errors.push(`Story "${story.title ?? '(untitled)'}" duplicates a promoted futures-module title.`);
      }
    }

    if (cryptoNotes.length < 4 || cryptoNotes.length > 6) {
      errors.push('crypto.notes must contain 4-6 fresh crypto notes/items.');
    }
    for (const noteRaw of cryptoNotes) {
      const note = noteRaw && typeof noteRaw === 'object' ? noteRaw : {};
      requireString(note.kicker, 'Crypto note kicker');
      requireString(note.title, 'Crypto note title');
      requireString(note.body, 'Crypto note body');
      requireHttpsUrl(note.url, `Crypto note "${note.title ?? '(untitled)'}"`);
      validateStoryFreshness(note, `Crypto note "${note.title ?? '(untitled)'}"`);
      validateNewPillState(note, `Crypto note "${note.title ?? '(untitled)'}"`);
    }

    const earningsWeek = data.earnings?.week;
    if (earningsWeek && typeof earningsWeek === 'object' && !Array.isArray(earningsWeek)) {
      if (Object.prototype.hasOwnProperty.call(earningsWeek, 'outputPath')) {
        errors.push('earnings.week.outputPath is staging-only and must not be embedded in the dashboard.');
      }
      for (const error of validateEarningsWeekPayload(earningsWeek, { requireNarrative: !stagingCandidate, now })) {
        errors.push(`earnings.week: ${error}`);
      }
    } else {
      errors.push('earnings.week is required.');
    }

  }
}

return { errors, warnings };
}

function runDashboardValidation(argv) {
  let inputFile = '';
  let requireEditorialReview = false;
  let stagingCandidate = false;
  for (const arg of argv) {
    if (arg === '--require-editorial-review') {
      requireEditorialReview = true;
    } else if (arg === '--staging-candidate') {
      stagingCandidate = true;
    } else if (arg.startsWith('-')) {
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
  const override = process.env.VALIDATE_NOW_ISO;
  const parsedOverride = override ? new Date(override) : null;
  const now = parsedOverride && !Number.isNaN(parsedOverride.getTime()) ? parsedOverride : new Date();
  const { errors, warnings } = validateDashboardHtml(fs.readFileSync(file, 'utf8'), {
    requireEditorialReview,
    stagingCandidate,
    now
  });

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
    process.stdout.write('Usage: node scripts/validate_dashboard.js [dashboard.html] [--require-editorial-review] [--staging-candidate]\n       node scripts/validate_dashboard.js chart-data [options]\n       node scripts/validate_dashboard.js readiness [options]\n       node scripts/validate_dashboard.js test\n');
    return;
  }
  if (argv[0] === 'chart-data') return runChartDataValidation(argv.slice(1));
  if (argv[0] === 'test') {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write('Usage: node scripts/validate_dashboard.js test\n\nRuns syntax, architecture, domain, integration, canonical dashboard, HTML, and whitespace checks.\n');
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
  RECOGNIZED_SERIES_SOURCES,
  changedPaths,
  chartableRowsFromDashboardHtml,
  decodeObjectSeries,
  decodeTupleSeries,
  parseReadinessArgs,
  runCompleteTestSuite,
  runDashboardValidation,
  validateChartDataPayload,
  validateChartPayload,
  validateChartPayloadMetadata,
  validateDashboardHtml,
  validateYieldCurveComparisons,
  validateYieldCurvePointSet
};
