const { isIsoDate, isIsoDateTime } = require('./calendar_contract');
const {
  cryptoQuoteRowFromSeries,
  quoteRowFromSeries
} = require('./fetch_chart_data');
const {
  validateYieldCurvePointSet,
  validateYieldCurveComparisons
} = require('./yield_curve_contract');

const MIN_CHART_HISTORY_DAYS = 1826;
const RECOGNIZED_SERIES_SOURCES = new Set([
  'Yahoo Finance Chart API',
  'Yahoo Finance Chart API + Finnhub Quote API',
  'Treasury.gov Daily Treasury Yield Curve Rate Data'
]);

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

module.exports = {
  MIN_CHART_HISTORY_DAYS,
  RECOGNIZED_SERIES_SOURCES,
  decodeObjectSeries,
  decodeTupleSeries,
  validateChartPayload,
  validateChartPayloadMetadata
};
