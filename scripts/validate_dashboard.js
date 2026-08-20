#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');
const { displayDatesForRange, isIsoDate, isIsoDateTime } = require('./calendar_contract');
const {
  blocksWithId,
  elementsWithId,
  scanHtml,
  singleScriptBlockById
} = require('./dashboard_script_blocks');
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
const LOCAL_MARKET_REFRESH_URL = 'https://192.168.2.2:2210/api/market-refresh';

function walkJavaScriptAst(node, ancestors, visitor) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) {
      for (const child of value) walkJavaScriptAst(child, nextAncestors, visitor);
    } else {
      walkJavaScriptAst(value, nextAncestors, visitor);
    }
  }
}

function staticStringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? '';
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return typeof left === 'string' && typeof right === 'string' ? left + right : null;
  }
  return null;
}

function memberPropertyName(node) {
  if (node?.type !== 'MemberExpression') return '';
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed) return staticStringValue(node.property) ?? '';
  return '';
}

function containsJavaScriptBinding(node, name) {
  let found = false;
  walkJavaScriptAst(node, [], (candidate) => {
    if (candidate.type === 'VariableDeclarator' && candidate.id?.type === 'Identifier' && candidate.id.name === name) found = true;
    if (candidate.type === 'CatchClause' && candidate.param?.type === 'Identifier' && candidate.param.name === name) found = true;
    if ((candidate.type === 'FunctionDeclaration' || candidate.type === 'FunctionExpression' || candidate.type === 'ArrowFunctionExpression')
      && candidate.params.some((parameter) => parameter?.type === 'Identifier' && parameter.name === name)) found = true;
  });
  return found;
}

function canonicalRuntimeFetchCall(node, ancestors) {
  if (node?.type !== 'CallExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== 'fetch') return false;
  if (node.arguments[0]?.type !== 'Identifier' || node.arguments[0].name !== 'url') return false;
  if (ancestors.at(-1)?.type !== 'AwaitExpression') return false;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor.type !== 'ForOfStatement') continue;
    const declaration = ancestor.left?.type === 'VariableDeclaration' && ancestor.left.kind === 'const'
      ? ancestor.left.declarations[0]
      : null;
    return ancestor.left.declarations?.length === 1
      && declaration?.id?.type === 'Identifier'
      && declaration.id.name === 'url'
      && ancestor.right?.type === 'Identifier'
      && ancestor.right.name === 'LOCAL_MARKET_REFRESH_URLS'
      && !containsJavaScriptBinding(ancestor.body, 'url');
  }
  return false;
}

function validateDashboardRuntimeNetworkContract(errors, program) {
  const contractErrors = new Set();
  const endpointDeclarations = [];
  const endpointReferences = [];
  const runtimeUrls = [];
  const fetchCalls = [];
  const forbiddenConstructors = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'Function']);
  const forbiddenCalls = new Set(['importScripts', 'eval', 'Function']);

  walkJavaScriptAst(program, [], (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'LOCAL_MARKET_REFRESH_URLS') {
      endpointDeclarations.push({ node, parent });
    }
    if (node.type === 'Identifier' && node.name === 'LOCAL_MARKET_REFRESH_URLS') {
      endpointReferences.push({ node, parent });
    }
    if (node.type === 'Literal' && typeof node.value === 'string' && /^https?:\/\//.test(node.value)) {
      runtimeUrls.push(node.value);
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      const value = node.quasis[0]?.value?.cooked;
      if (typeof value === 'string' && /^https?:\/\//.test(value)) runtimeUrls.push(value);
    }
    if (node.type === 'MemberExpression') {
      const propertyName = memberPropertyName(node);
      if (propertyName === 'fetch') contractErrors.add('The dashboard runtime may not access fetch through a member expression.');
    }
    if (node.type === 'Identifier' && node.name === 'fetch') {
      const allowedTypeCheck = parent?.type === 'UnaryExpression' && parent.operator === 'typeof' && parent.argument === node;
      const allowedCall = parent?.type === 'CallExpression' && parent.callee === node;
      if (!allowedTypeCheck && !allowedCall) {
        contractErrors.add('The dashboard runtime may reference fetch only in its availability check and canonical request call.');
      }
    }
    if (node.type === 'CallExpression') {
      const calleeName = node.callee?.type === 'Identifier' ? node.callee.name : memberPropertyName(node.callee);
      if (calleeName === 'fetch') fetchCalls.push({ node, ancestors });
      if (calleeName === 'sendBeacon' || forbiddenCalls.has(calleeName)) {
        contractErrors.add(`Unexpected dashboard runtime network or dynamic-code API: ${calleeName}.`);
      }
    }
    if (node.type === 'NewExpression') {
      const constructorName = node.callee?.type === 'Identifier' ? node.callee.name : memberPropertyName(node.callee);
      if (forbiddenConstructors.has(constructorName)) {
        contractErrors.add(`Unexpected dashboard runtime network or dynamic-code API: ${constructorName}.`);
      }
    }
    if (node.type === 'ImportExpression') {
      contractErrors.add('Unexpected dashboard runtime dynamic import.');
    }
  });

  const endpoint = endpointDeclarations[0];
  const endpointIsCanonical = endpointDeclarations.length === 1
    && endpoint.parent?.type === 'VariableDeclaration'
    && endpoint.parent.kind === 'const'
    && endpoint.node.init?.type === 'ArrayExpression'
    && endpoint.node.init.elements.length === 1
    && endpoint.node.init.elements[0]?.type === 'Literal'
    && endpoint.node.init.elements[0].value === LOCAL_MARKET_REFRESH_URL;
  if (!endpointIsCanonical) {
    contractErrors.add('The dashboard runtime must declare exactly one canonical const LOCAL_MARKET_REFRESH_URLS endpoint array.');
  }
  const endpointReferencesAreCanonical = endpointReferences.length === 2
    && endpointReferences.some(({ node, parent }) => parent?.type === 'VariableDeclarator' && parent.id === node)
    && endpointReferences.some(({ node, parent }) => parent?.type === 'ForOfStatement' && parent.right === node);
  if (!endpointReferencesAreCanonical) {
    contractErrors.add('The dashboard runtime may use LOCAL_MARKET_REFRESH_URLS only in its declaration and canonical request loop.');
  }
  if (runtimeUrls.length !== 1 || runtimeUrls[0] !== LOCAL_MARKET_REFRESH_URL) {
    contractErrors.add('The dashboard runtime must contain only the canonical HTTPS LAN market-refresh URL.');
  }
  if (fetchCalls.length !== 1 || !canonicalRuntimeFetchCall(fetchCalls[0]?.node, fetchCalls[0]?.ancestors || [])) {
    contractErrors.add('The dashboard runtime must make exactly one canonical await fetch(url, ...) call inside the LOCAL_MARKET_REFRESH_URLS loop.');
  }

  errors.push(...contractErrors);
}

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
    if ((options.requirePublishedAt || card.publishedAt !== undefined) && !isIsoDateTime(card.publishedAt)) {
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

function publishedChartBarWarning(bar, label) {
  if (!Array.isArray(bar)) return `${label} is not a compact bar array and will be skipped by the dashboard runtime.`;
  if (bar.length !== 6) return `${label} is not a complete [time, open, high, low, close, volume] tuple and will be skipped by the dashboard runtime.`;
  const [time, open, high, low, close, volume] = bar;
  if (!isIsoDate(time)) return `${label}.time is not a valid ISO date and will be skipped by the dashboard runtime.`;
  for (const [field, value] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
    if (!isFiniteNumber(value)) return `${label}.${field} is not a finite JSON number and will be skipped by the dashboard runtime.`;
  }
  if (!coherentChartBar({ open, high, low, close })) return `${label} has incoherent OHLC values and will be skipped by the dashboard runtime.`;
  if (volume !== null && (!isFiniteNumber(volume) || volume < 0)) {
    return `${label}.volume is not a non-negative finite JSON number or null and will be skipped by the dashboard runtime.`;
  }
  return '';
}

function strictlyAscendingTimes(times) {
  let previousTime = '';
  for (const time of times) {
    if (previousTime && time <= previousTime) return false;
    previousTime = time;
  }
  return true;
}

function validateDashboardRenderSurface(errors, warnings, data, chartData) {
  // The final publication gate checks only shapes the runtime dereferences at
  // startup. Financial completeness, provenance, and freshness stay in staged
  // contract checks so recoverable content issues do not take the page offline.
  if (!renderObject(errors, data, 'dashboard-data')) return;
  if (!renderObject(errors, chartData, 'chart-data') || !renderArray(errors, chartData.series, 'chart-data.series')) return;
  for (const [seriesIndex, series] of chartData.series.entries()) {
    const label = `chart-data.series[${seriesIndex}]`;
    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      warnings.push(`${label} is not a renderable object and will be skipped by the dashboard runtime.`);
      continue;
    }
    if (!Array.isArray(series.bars)) {
      warnings.push(`${label}.bars is not an array and will be skipped by the dashboard runtime.`);
      continue;
    }
    const renderableTimes = [];
    for (const [barIndex, bar] of series.bars.entries()) {
      const warning = publishedChartBarWarning(bar, `${label}.bars[${barIndex}]`);
      if (warning) warnings.push(warning);
      else renderableTimes.push(bar[0]);
    }
    if (renderableTimes.length < 2) {
      warnings.push(`${label} has fewer than two renderable bars and will be skipped by the dashboard runtime.`);
    } else if (!strictlyAscendingTimes(renderableTimes)) {
      warnings.push(`${label}.bars are not strictly ascending after malformed bars are skipped; the series will be skipped by the dashboard runtime.`);
    }
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function coherentChartBar({ open, high, low, close }) {
  if (![open, high, low, close].every(isFiniteNumber)) return false;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return false;
  return !(close > 0 && [open, high, low].some((value) => value <= 0));
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
  volumeDescription = 'generated'
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
  delete testEnvironment.EODHD_API_KEY;
  delete testEnvironment.EARNINGSAPI_API_KEY;
  // This aggregate command owns focused test ordering; keep callers from
  // launching duplicate dashboard-test processes beside it.
  for (const file of ['test_news.js', 'test_earnings_week.js', 'test_week_ahead.js', 'test_market_data.js', 'test_dashboard.js']) {
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
  const block = singleScriptBlockById(dashboardHtml, 'dashboard-data', { type: 'application/json' });
  return chartableRowsFromDashboardData(JSON.parse(block.content));
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
const { elements, scripts } = scanHtml(html);
const dashboardDataElements = elementsWithId(elements, 'dashboard-data');
const chartDataElements = elementsWithId(elements, 'chart-data');
const runtimeElements = elementsWithId(elements, 'dashboard-runtime');
const dashboardDataScripts = blocksWithId(scripts, 'dashboard-data');
const chartDataScripts = blocksWithId(scripts, 'chart-data');
const runtimeScripts = blocksWithId(scripts, 'dashboard-runtime');
const dashboardScript = dashboardDataScripts.length === 1 ? dashboardDataScripts[0] : null;
const chartDataScript = chartDataScripts.length === 1 ? chartDataScripts[0] : null;
const runtimeScriptBlock = runtimeScripts.length === 1 ? runtimeScripts[0] : null;
const errors = [];
const warnings = [];

function requireReservedScriptElement(id, elementsForId) {
  if (elementsForId.length !== 1) {
    errors.push(`Expected exactly 1 active #${id} element; found ${elementsForId.length}.`);
    return;
  }
  if (elementsForId[0].name !== 'script') {
    errors.push(`#${id} must be a <script>; found <${elementsForId[0].name}>.`);
  }
}

function requireOrderedMarkerSequence(markers, shell) {
  // Include inert elements so the shell gate can reject containers that would
  // hide required runtime markers from the browser DOM.
  const { elements } = scanHtml(shell, { activeOnly: false });
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
requireReservedScriptElement('dashboard-data', dashboardDataElements);
requireReservedScriptElement('chart-data', chartDataElements);
requireReservedScriptElement('dashboard-runtime', runtimeElements);
if (runtimeScripts.length !== 1) {
  errors.push(`Expected exactly 1 dashboard-runtime script; found ${runtimeScripts.length}.`);
}
if (runtimeScriptBlock && runtimeScriptBlock.type && !['application/javascript', 'text/javascript'].includes(runtimeScriptBlock.type)) {
  errors.push('dashboard-runtime script must be executable JavaScript.');
}
if (runtimeScriptBlock && 'src' in runtimeScriptBlock.attributes) {
  errors.push('dashboard-runtime script must be inline and must not use src.');
}
if (runtimeScriptBlock && 'nomodule' in runtimeScriptBlock.attributes) {
  errors.push('dashboard-runtime script must run in supported browsers and must not use nomodule.');
}
const runtimeLanguage = String(runtimeScriptBlock?.attributes?.language || '').trim().toLowerCase();
if (runtimeScriptBlock && !('type' in runtimeScriptBlock.attributes)
  && runtimeLanguage
  && !/^(?:ecmascript|javascript(?:1\.[0-5])?|jscript|livescript|x-(?:ecmascript|javascript))$/.test(runtimeLanguage)) {
  errors.push('dashboard-runtime script language must identify JavaScript.');
}
const runtimeScript = runtimeScriptBlock ? runtimeScriptBlock.content : '';
if (runtimeScriptBlock && !runtimeScript.trim()) {
  errors.push('dashboard-runtime script must not be empty.');
}
if (runtimeScript.trim()) {
  let runtimeProgram = null;
  try {
    // Compile only: executing the dashboard runtime would touch DOM/browser APIs.
    new Function(runtimeScript);
    runtimeProgram = acorn.parse(runtimeScript, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (error) {
    errors.push(`dashboard-runtime JavaScript is invalid: ${error.message}`);
  }
  if (runtimeProgram) validateDashboardRuntimeNetworkContract(errors, runtimeProgram);
}

if (dashboardDataScripts.length !== 1) {
  errors.push(`Expected exactly 1 dashboard-data JSON block; found ${dashboardDataScripts.length}.`);
} else if (dashboardScript.type !== 'application/json') {
  errors.push('dashboard-data script must use type="application/json".');
}
if (chartDataScripts.length !== 1) {
  errors.push(`Expected exactly 1 chart-data JSON block; found ${chartDataScripts.length}.`);
} else if (chartDataScript.type !== 'application/json') {
  errors.push('chart-data script must use type="application/json".');
}

const dataStartIndex = html.indexOf('<!-- ============ DATA START');
const dataEndIndex = html.indexOf('<!-- ============ DATA END ============ -->');
const chartDataIndex = chartDataScripts[0]?.index ?? -1;
const runtimeScriptIndex = runtimeScripts[0]?.index ?? -1;
const chartDataEndIndex = chartDataScripts[0]?.end ?? -1;
const firstScriptAfterChart = chartDataEndIndex >= 0
  ? scripts.find((block) => block.index >= chartDataEndIndex)
  : null;
const firstScriptAfterChartIndex = firstScriptAfterChart?.index ?? -1;

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

if (!dashboardScript) {
  if (!dashboardDataScripts.length) errors.push('Could not find dashboard-data JSON block.');
} else {
  let data;
  try {
    data = JSON.parse(dashboardScript.content);
  } catch (error) {
    errors.push(`Embedded dashboard JSON is invalid: ${error.message}`);
  }

  if (data !== undefined) {
    let chartData = null;

    if (!chartDataScript) {
      if (!chartDataScripts.length) errors.push('Could not find chart-data JSON block; production charts must use embedded generated data.');
    } else {
      try {
        chartData = JSON.parse(chartDataScript.content);
      } catch (error) {
        errors.push(`Embedded chart-data JSON is invalid: ${error.message}`);
      }
    }

    validateDashboardRenderSurface(errors, warnings, data, chartData);

    if (validationMode === 'staged' && data !== null && typeof data === 'object' && !Array.isArray(data)) {
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
          volumeDescription: 'embedded'
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
