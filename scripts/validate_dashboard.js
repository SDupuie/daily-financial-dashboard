#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { displayDatesForRange, isIsoDate, isIsoDateTime } = require('./calendar_contract');
const { validateEarningsWeekPayload } = require('./earnings_week_validation');
const { validateTapeCommentaryDisposition } = require('./editorial_review_contract');
const {
  deriveQuoteRowsFromSeries,
  roundChartPayload,
  validateChartPayloadMetadata,
  validateChartSeriesContract
} = require('./fetch_chart_data');
const { validateWeekAheadPayload } = require('./week_ahead_contract');

const root = path.resolve(__dirname, '..');
const defaultDashboard = path.resolve(root, 'daily_financial_news.html');
const defaultChartData = path.resolve(root, 'generated', 'chart_data.json');
const DASHBOARD_VALIDATION_MODES = new Set(['staged', 'published']);

function normalizedDashboardValidationMode(value) {
  return DASHBOARD_VALIDATION_MODES.has(value) ? value : 'published';
}

function rangesMatch(left, right) {
  return Boolean(left?.from && left?.to && right?.from && right?.to && left.from === right.from && left.to === right.to);
}

function validCalendarSectionRange(errors, label, range) {
  if (!range || typeof range !== 'object' || Array.isArray(range) || !isIsoDate(range.from) || !isIsoDate(range.to)) {
    errors.push(`${label}.range must be an object with ISO from/to dates.`);
    return null;
  }
  if (displayDatesForRange(range.from, range.to).length !== 5) {
    errors.push(`${label}.range must cover Monday-Friday or Friday plus next Monday-Thursday.`);
    return null;
  }
  return range;
}

function validateCalendarSectionRanges(errors, data) {
  // Domain validators own full section schemas; staged contract validation
  // proves the two calendar sections expose the same supported active date range.
  const weekAheadRange = validCalendarSectionRange(errors, 'weekAhead', data?.weekAhead?.range);
  const earningsWeekRange = validCalendarSectionRange(errors, 'earnings.week', data?.earnings?.week?.range);
  if (weekAheadRange && earningsWeekRange && !rangesMatch(weekAheadRange, earningsWeekRange)) {
    errors.push('weekAhead.range must match earnings.week.range.');
  }
}

function validateEmbeddedEarningsWeekContract(errors, data) {
  const earningsErrors = validateEarningsWeekPayload(data?.earnings?.week, { mode: 'published' });
  for (const error of earningsErrors) {
    errors.push(error === 'Earnings week payload must be an object.'
      ? 'earnings.week must be an object.'
      : `earnings.week.${error}`);
  }
}

function validateEmbeddedWeekAheadContract(errors, data) {
  errors.push(...validateWeekAheadPayload(data?.weekAhead, { requireOutcomeDisposition: true }));
}

function validateEmbeddedNewsCardMetadataContract(errors, label, cards, options = {}) {
  if (!Array.isArray(cards)) return;
  // Staged contract validation proves embedded cards kept immutable provenance
  // from Prepare/Apply; it does not re-rank or replace stories.
  cards.forEach((card, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      errors.push(`${itemLabel} must be an object.`);
      return;
    }
    if (typeof card.url !== 'string') {
      errors.push(`${itemLabel}.url must be a string.`);
    } else {
      try {
        if (new URL(card.url).protocol !== 'https:') {
          errors.push(`${itemLabel}.url must be an HTTPS reader-facing URL.`);
        }
      } catch (_error) {
        errors.push(`${itemLabel}.url must be a valid URL.`);
      }
    }
    if (!isIsoDate(card.publishedOn)) {
      errors.push(`${itemLabel}.publishedOn must be an ISO date.`);
    }
    if (options.requirePublishedAt && !isIsoDateTime(card.publishedAt)) {
      errors.push(`${itemLabel}.publishedAt must be an offset-bearing ISO timestamp.`);
    }
    if (typeof card.sourceLabel !== 'string' || !card.sourceLabel.trim()) {
      errors.push(`${itemLabel}.sourceLabel must be populated.`);
    }
  });
}

function validateEmbeddedNewsMetadataContract(errors, data) {
  validateEmbeddedNewsCardMetadataContract(errors, 'stories', data?.stories);
  validateEmbeddedNewsCardMetadataContract(errors, 'futuresModule.stories', data?.futuresModule?.stories, { requirePublishedAt: true });
  validateEmbeddedNewsCardMetadataContract(errors, 'crypto.notes', data?.crypto?.notes);
}

function renderObject(errors, value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object for dashboard rendering.`);
    return false;
  }
  return true;
}

function renderArray(errors, value, label) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array for dashboard rendering.`);
    return false;
  }
  return true;
}

function validateDashboardRenderSurface(errors, data, chartData) {
  // The final publication gate checks only shapes the runtime dereferences at
  // startup. Financial completeness, provenance, and freshness stay in staged
  // contract checks so recoverable content issues do not take the page offline.
  if (!renderObject(errors, data, 'dashboard-data')) return;
  if (chartData === null || !renderObject(errors, chartData, 'chart-data') || !renderArray(errors, chartData.series, 'chart-data.series')) return;
  for (const [seriesIndex, series] of chartData.series.entries()) {
    const label = `chart-data.series[${seriesIndex}]`;
    if (!renderObject(errors, series, label) || !renderArray(errors, series.bars, `${label}.bars`)) continue;
    for (const [barIndex, bar] of series.bars.entries()) {
      if (!Array.isArray(bar)) {
        errors.push(`${label}.bars[${barIndex}] must be an array for dashboard rendering.`);
      }
    }
  }
}

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
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

function validateSeries(errors, series, {
  warnings = errors,
  expectedByTicker,
  expectedSectionByTicker,
  decodeSeries,
  prefix,
  absentMessage,
  duplicateMessage,
  missingMessage,
  volumeDescription,
  closeOnlyPlaceholderSeverity = 'error',
  rangeStartDate = '',
  rangeEndDate = ''
}) {
  const seriesByTicker = new Map();
  const decodedSeries = [];
  for (const [index, rawItem] of series.entries()) {
    const sourceItem = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const ticker = String(sourceItem.ticker || '').toUpperCase();
    const label = ticker || `${prefix}series[${index}]`;
    const item = decodeSeries(errors, sourceItem, label);
    decodedSeries.push(item);
    if (seriesByTicker.has(ticker)) errors.push(`${duplicateMessage} ${ticker}.`);
    seriesByTicker.set(ticker, item);
    const expectedSource = expectedByTicker.get(ticker);
    if (!expectedSource) errors.push(`${label} ${absentMessage}`);
    const expectedSection = expectedSectionByTicker.get(ticker);
    const contract = validateChartSeriesContract(item, expectedSource ? {
      sourceSymbol: expectedSource,
      section: expectedSection
    } : null, {
      label,
      volumeDescription,
      closeOnlyPlaceholderSeverity,
      rangeStartDate,
      rangeEndDate
    });
    errors.push(...contract.errors);
    warnings.push(...contract.warnings);
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
    for (const ticker of carriedTickers) errors.push(`${prefix}carried-forward series ${ticker} requires partial availability diagnostics.`);
    return;
  }
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    errors.push(`${prefix}availability must be an object.`);
    return;
  }
  if (!['partial', 'carried_forward'].includes(availability.status)) errors.push(`${prefix}availability.status must be partial or carried_forward.`);
  if (availability.reason !== 'source_refresh_failed') errors.push(`${prefix}availability.reason must be source_refresh_failed.`);
  if (!isIsoDateTime(availability.checkedAt)) errors.push(`${prefix}availability.checkedAt must be an offset-bearing ISO timestamp.`);
  if (availability.status === 'partial') {
    if (!Array.isArray(availability.failures) || !availability.failures.length) {
      errors.push(`${prefix}partial availability.failures must be a non-empty array.`);
      return;
    }
    const failureTickers = new Set();
    availability.failures.forEach((failure, index) => {
      const ticker = String(failure?.ticker || '').trim().toUpperCase();
      if (!ticker) errors.push(`${prefix}availability.failures[${index}].ticker must be populated.`);
      else if (failureTickers.has(ticker)) errors.push(`${prefix}availability.failures contains duplicate ticker ${ticker}.`);
      else failureTickers.add(ticker);
      if (typeof failure?.message !== 'string' || !failure.message.trim()) errors.push(`${prefix}availability.failures[${index}].message must be populated.`);
      if (ticker && !seriesByTicker.has(ticker)) errors.push(`${prefix}availability failure names unknown ticker ${ticker}.`);
      else if (ticker && !carriedTickers.has(ticker)) errors.push(`${prefix}availability failure ${ticker} must identify a carried_forward series.`);
    });
    for (const ticker of carriedTickers) {
      if (!failureTickers.has(ticker)) errors.push(`${prefix}carried_forward series ${ticker} must have a matching availability failure.`);
    }
  } else {
    if (availability.failures !== undefined) errors.push(`${prefix}carried_forward availability.failures is not allowed.`);
    if (carriedTickers.size !== seriesByTicker.size) errors.push(`${prefix}carried_forward availability requires every series to be marked carried_forward.`);
  }
}

function quoteRowsByTicker(derivedRows) {
  const byTicker = new Map();
  for (const row of derivedRows.tape || []) {
    byTicker.set(String(row?.ticker || '').toUpperCase(), { section: 'tape', row });
  }
  for (const row of derivedRows.crypto || []) {
    byTicker.set(String(row?.ticker || row?.sym || '').toUpperCase(), { section: 'crypto', row });
  }
  return byTicker;
}

function validateDerivedDashboardQuoteRows(errors, chartableRows, series, prefix) {
  // This proves visible price fields are reproducible from chart-data.series;
  // editorial tape notes remain owned by dashboard-data.tape.rows.
  if (!Array.isArray(chartableRows) || !chartableRows.length) return;
  let derivedRows;
  try {
    derivedRows = deriveQuoteRowsFromSeries(series);
  } catch (error) {
    errors.push(`${prefix}series cannot derive dashboard Tape prices: ${error.message}`);
    return;
  }
  const byTicker = quoteRowsByTicker(derivedRows);
  for (const [index, rowRaw] of chartableRows.entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row?.ticker || '').toUpperCase();
    const section = String(row?.section || 'tape');
    const label = ticker || `dashboard tape.rows[${index}]`;
    const derived = byTicker.get(ticker);
    if (!derived) {
      errors.push(`${label} is missing derived quote fields from ${prefix || 'chart-data.'}series.`);
      continue;
    }
    if (derived.section !== section) {
      errors.push(`${label} must derive from a ${section} chart series.`);
      continue;
    }
    const fieldsToMatch = section === 'crypto'
      ? [['last', 'price'], ['delta', 'delta'], ['pct', 'chg'], ['dir', 'dir'], ['asOf', 'asOf']]
      : [['last', 'last'], ['delta', 'delta'], ['pct', 'pct'], ['dir', 'dir'], ['asOf', 'asOf']];
    for (const [dashboardField, derivedField] of fieldsToMatch) {
      if (String(row[dashboardField] ?? '') !== String(derived.row[derivedField] ?? '')) {
        errors.push(`${label}.${dashboardField} must match the latest ${prefix || 'chart-data.'}series-derived value "${derived.row[derivedField]}".`);
      }
    }
  }
}

function validateDashboardTapeCommentary(errors, data) {
  for (const [index, rowRaw] of (Array.isArray(data?.tape?.rows) ? data.tape.rows : []).entries()) {
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const ticker = String(row?.ticker || '').toUpperCase();
    const label = ticker || `tape.rows[${index}]`;
    for (const error of validateTapeCommentaryDisposition(row)) {
      errors.push(`${label}.${error}`);
    }
  }
}

// Add payload, storage, roster, and derived-quote checks around the shared
// per-series market-data contract owned by fetch_chart_data.
function validateChartPayload(errors, payload, {
  warnings = errors,
  expectedByTicker,
  expectedSectionByTicker,
  decodeSeries,
  label = '',
  dashboardRows = [],
  absentMessage = 'is not present in dashboard chartable rows.',
  duplicateMessage = 'Duplicate generated chart series for',
  missingMessage = 'Generated chart data is missing',
  volumeDescription = 'generated',
  closeOnlyPlaceholderSeverity = 'error'
}) {
  const prefix = label ? `${label}.` : '';
  errors.push(...validateChartPayloadMetadata(payload, { label: label || 'Chart payload' }));
  if (!Array.isArray(payload.series)) errors.push(`${prefix}series must be an array.`);
  if (payload.quoteRows !== undefined) errors.push(`${prefix}quoteRows is no longer published; derive quote rows from ${prefix}series.`);
  if (payload.availability?.status === 'unavailable') {
    if (payload.availability.reason !== 'source_refresh_failed') errors.push(`${prefix}availability.reason must be source_refresh_failed when unavailable.`);
    if (!isIsoDateTime(payload.availability.checkedAt)) errors.push(`${prefix}availability.checkedAt must be an offset-bearing ISO timestamp when unavailable.`);
    if (Array.isArray(payload.series) && payload.series.length) errors.push(`${prefix}series must be empty when chart data is unavailable.`);
    if (expectedByTicker.size) errors.push(`${prefix}unavailable chart data requires an empty dashboard Tape roster.`);
    return { decodedSeries: [], seriesByTicker: new Map() };
  }
  const rangeStartDate = isIsoDate(payload?.range?.startDate) ? payload.range.startDate : '';
  const rangeEndDate = isIsoDate(payload?.range?.endDate) ? payload.range.endDate : '';
  const series = Array.isArray(payload.series) ? payload.series : [];
  const result = validateSeries(errors, series, {
    warnings,
    expectedByTicker,
    expectedSectionByTicker,
    decodeSeries,
    prefix,
    absentMessage,
    duplicateMessage,
    missingMessage,
    volumeDescription,
    closeOnlyPlaceholderSeverity,
    rangeStartDate,
    rangeEndDate
  });
  validateChartAvailabilityCorrespondence(errors, payload, result.seriesByTicker, prefix);
  const roundedSeries = roundChartPayload({ series: result.decodedSeries }).series;
  validateDerivedDashboardQuoteRows(errors, dashboardRows, roundedSeries, prefix);
  return result;
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
  // This aggregate command already runs test_dashboard.js; do not launch a
  // second dashboard-test process beside it unless fixture isolation is added.
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
  // The complete suite already validates/tidies the canonical dashboard and
  // checks diffs; skip duplicate work unless the target is a noncanonical file.
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

function chartableRowsFromDashboardData(data) {
  // The Tape and chart data contract in docs/reference.md makes tape.rows the only chartable ticker source; section decides derived quote shape.
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

function chartableRowsFromDashboardHtml(dashboardHtml) {
  const match = dashboardHtml.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find dashboard-data JSON block.');
  return chartableRowsFromDashboardData(JSON.parse(match[1]));
}

function chartExpectationsFromRows(errors, chartableRows) {
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
  return { expectedByTicker, expectedSectionByTicker };
}

function validateChartDataPayload(chartableRows, chartData) {
  const errors = [];
  // Generated chart data must track the dashboard's authoritative ticker-to-sourceSymbol map exactly.
  const { expectedByTicker, expectedSectionByTicker } = chartExpectationsFromRows(errors, chartableRows);
  const { decodedSeries: series } = validateChartPayload(errors, chartData, {
    expectedByTicker,
    expectedSectionByTicker,
    decodeSeries: decodeObjectSeries,
    dashboardRows: chartableRows
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

function validateDashboardHtml(html, options = {}) {
const validationMode = normalizedDashboardValidationMode(options.validationMode);
const dashboardMatch = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
const chartDataMatch = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
const runtimeScriptMatches = [...html.matchAll(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/g)];
const errors = [];
const warnings = [];

function countMatches(pattern) {
  return [...html.matchAll(pattern)].length;
}

function dashboardShellElements(shell) {
  const elements = [];
  const stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const decodeAttributeValue = (value) => String(value)
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    })
    .replace(/&(amp|quot|apos|lt|gt);/gi, (_match, name) => ({
      amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'
    })[name.toLowerCase()]);
  let cursor = 0;
  while (cursor < shell.length) {
    const openIndex = shell.indexOf('<', cursor);
    if (openIndex < 0) break;
    if (shell.startsWith('<!--', openIndex)) {
      const commentEnd = shell.indexOf('-->', openIndex + 4);
      cursor = commentEnd < 0 ? shell.length : commentEnd + 3;
      continue;
    }
    const closing = shell[openIndex + 1] === '/';
    const nameOffset = openIndex + (closing ? 2 : 1);
    const nameMatch = shell.slice(nameOffset).match(/^([A-Za-z][A-Za-z0-9:-]*)/);
    if (!nameMatch) {
      cursor = openIndex + 1;
      continue;
    }
    let quote = '';
    let closeIndex = -1;
    for (let index = openIndex + 1; index < shell.length; index += 1) {
      const character = shell[index];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        closeIndex = index;
        break;
      }
    }
    if (closeIndex < 0) break;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      const matchingIndex = stack.map((elementIndex) => elements[elementIndex].name).lastIndexOf(name);
      if (matchingIndex >= 0) stack.length = matchingIndex;
      cursor = closeIndex + 1;
      continue;
    }
    const source = shell.slice(openIndex, closeIndex + 1);
    const attributes = {};
    const attributeSource = shell.slice(nameOffset + nameMatch[1].length, closeIndex);
    const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of attributeSource.matchAll(attributePattern)) {
      const attributeName = match[1].toLowerCase();
      if (!(attributeName in attributes)) {
        attributes[attributeName] = decodeAttributeValue(match[2] ?? match[3] ?? match[4] ?? '');
      }
    }
    const element = {
      name,
      source,
      attributes,
      parentIndex: stack.length ? stack[stack.length - 1] : -1
    };
    elements.push(element);
    // HTML ignores self-closing slashes on non-void elements, so the shell
    // stack must do the same to match browser DOM ancestry.
    if (!voidTags.has(name)) stack.push(elements.length - 1);
    cursor = closeIndex + 1;
  }
  return elements;
}

function requireOrderedMarkerSequence(markers, shell) {
  const elements = dashboardShellElements(shell);
  const inertContainer = elements.find((element) => [
    'iframe', 'noembed', 'noscript', 'plaintext', 'script', 'style', 'template', 'textarea', 'title', 'xmp'
  ].includes(element.name));
  if (inertContainer) {
    errors.push(`Unexpected <${inertContainer.name}> container in the dashboard shell.`);
  }
  const hasAncestorId = (element, ancestorId) => {
    let parentIndex = element.parentIndex;
    while (parentIndex >= 0) {
      const parent = elements[parentIndex];
      if (parent.attributes.id === ancestorId) return true;
      parentIndex = parent.parentIndex;
    }
    return false;
  };
  let previousIndex = -1;
  for (const marker of markers) {
    const indexes = elements
      .map((element, index) => element.attributes.id === marker.id ? index : -1)
      .filter((index) => index >= 0);
    if (!indexes.length) {
      errors.push(`Missing required dashboard shell marker: ${marker.label}`);
      continue;
    }
    if (indexes.length > 1) {
      errors.push(`Expected exactly 1 real dashboard shell id #${marker.id}; found ${indexes.length}.`);
    }
    const index = indexes[0];
    const element = elements[index];
    if (element.name !== marker.tag) {
      errors.push(`Dashboard shell #${marker.id} must use <${marker.tag}>; found <${element.name}>.`);
    }
    for (const className of marker.classes || []) {
      const classes = String(element.attributes.class || '').split(/[\t\n\f\r ]+/).filter(Boolean);
      if (!classes.includes(className)) errors.push(`Dashboard shell #${marker.id} must include class ${className}.`);
    }
    if ('hidden' in element.attributes) errors.push(`Dashboard shell #${marker.id} must not be hidden.`);
    if (marker.parentId && elements[element.parentIndex]?.attributes.id !== marker.parentId) {
      errors.push(`Dashboard shell #${marker.id} must be directly inside #${marker.parentId}.`);
    } else if (marker.ancestorId && !hasAncestorId(element, marker.ancestorId)) {
      errors.push(`Dashboard shell #${marker.id} must be inside #${marker.ancestorId}.`);
    }
    if (index <= previousIndex) {
      errors.push(`Dashboard shell marker is out of order: ${marker.label}`);
    }
    previousIndex = index;
  }
}

// This main dashboard runtime block is isolated from generated JSON and the vendored chart bundle, which are not runtime endpoint sources.
if (runtimeScriptMatches.length !== 1) {
  errors.push(`Expected exactly 1 dashboard-runtime script; found ${runtimeScriptMatches.length}.`);
}
const runtimeScript = runtimeScriptMatches.length === 1 ? runtimeScriptMatches[0][1] : '';
if (runtimeScript) {
  try {
    // Compile only: executing the dashboard runtime would touch DOM/browser APIs.
    new Function(runtimeScript);
  } catch (error) {
    errors.push(`dashboard-runtime JavaScript is invalid: ${error.message}`);
  }
}
const runtimeUrls = [...runtimeScript.matchAll(/https?:\/\/[^'"`\s]+/g)].map((match) => match[0]);
const allowedLocalRefreshUrls = new Set([
  'https://192.168.2.2:2210/api/market-refresh'
]);
// The published dashboard may call only the optional read-only LAN overlay;
// deterministic production data still comes from embedded JSON.
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
const chartDataEndIndex = chartDataMatch ? chartDataMatch.index + chartDataMatch[0].length : -1;
const firstScriptAfterChartOffset = chartDataEndIndex >= 0
  ? html.slice(chartDataEndIndex).search(/<script\b/i)
  : -1;
const firstScriptAfterChartIndex = firstScriptAfterChartOffset >= 0
  ? chartDataEndIndex + firstScriptAfterChartOffset
  : -1;

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
  { id: 'app', tag: 'div', classes: ['page'], label: '<div class="page" id="app">' },
  { id: 'mast-edition', tag: 'div', ancestorId: 'app', label: '<div id="mast-edition">' },
  { id: 'mast-date', tag: 'div', classes: ['right'], ancestorId: 'app', label: '<div class="right" id="mast-date">' },
  { id: 'mast-date-value', tag: 'span', parentId: 'mast-date', label: '<span id="mast-date-value">' },
  { id: 'hero-headline', tag: 'h1', ancestorId: 'app', label: '<h1 id="hero-headline">' },
  { id: 'hero-copy', tag: 'div', ancestorId: 'app', label: '<div id="hero-copy">' },
  { id: 'content', tag: 'main', parentId: 'app', label: '<main id="content">' },
  { id: 'footer', tag: 'footer', parentId: 'app', label: '<footer id="footer">' }
], chartDataEndIndex >= 0 && firstScriptAfterChartIndex >= chartDataEndIndex
  ? html.slice(chartDataEndIndex, firstScriptAfterChartIndex)
  : '');

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

    validateDashboardRenderSurface(errors, data, chartData);

    if (validationMode === 'staged') {
      const chartableRows = chartableRowsFromDashboardData(data);
      validateCalendarSectionRanges(errors, data);
      validateEmbeddedWeekAheadContract(errors, data);
      validateEmbeddedEarningsWeekContract(errors, data);
      validateEmbeddedNewsMetadataContract(errors, data);
      validateDashboardTapeCommentary(errors, data);

      const { expectedByTicker, expectedSectionByTicker } = chartExpectationsFromRows(errors, chartableRows);
      if (chartData) {
        validateChartPayload(errors, chartData, {
          warnings,
          expectedByTicker,
          expectedSectionByTicker,
          decodeSeries: decodeTupleSeries,
          label: 'chart-data',
          dashboardRows: chartableRows,
          absentMessage: 'is missing its embedded source mapping.',
          duplicateMessage: 'Duplicate embedded chart series for',
          missingMessage: 'Embedded chart data is missing',
          volumeDescription: 'embedded',
          closeOnlyPlaceholderSeverity: 'error'
        });
      }
    }

  }
}

return { errors, warnings };
}

function runDashboardValidation(argv) {
  let inputFile = '';
  let validationMode = 'published';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const next = argv[index + 1] || '';
      if (!DASHBOARD_VALIDATION_MODES.has(next)) {
        console.error(`--mode must be one of: ${[...DASHBOARD_VALIDATION_MODES].join(', ')}`);
        process.exit(1);
      }
      validationMode = next;
      index += 1;
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
  const { errors, warnings } = validateDashboardHtml(fs.readFileSync(file, 'utf8'), { validationMode });

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
    process.stdout.write('Usage: node scripts/validate_dashboard.js [--mode staged|published] [dashboard.html]\n       node scripts/validate_dashboard.js chart-data [options]\n       node scripts/validate_dashboard.js readiness [options]\n       node scripts/validate_dashboard.js test\n');
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
  changedPaths,
  chartableRowsFromDashboardData,
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
  normalizedDashboardValidationMode
};
