const TIME_ZONE = 'America/Chicago';
const SOURCE_TIME_ZONE = 'America/New_York';
const SCHEMA_VERSION = 2;
// These source labels are serialized into the dashboard, so they are contract
// constants rather than display copy that a fetcher or cache may freely alter.
const FX_MACRO_PROVIDER = 'FXMacroData';
const FX_MACRO_ENDPOINT = '/v1/announcements/{currency}/{indicator} + /v1/predictions/{currency}/{indicator}';
const TIME_INTERPRETATION = 'Official U.S. release schedule times are stored as America/New_York and converted by the dashboard renderer.';
const {
  addDays,
  displayDatesForRange: calendarDisplayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isIsoTime
} = require('./calendar_contract');

const MARKET_CLOSURES = {
  2026: {
    '2026-01-01': 'New Year\'s Day',
    '2026-01-19': 'Martin Luther King Jr. Day',
    '2026-02-16': 'Presidents Day',
    '2026-04-03': 'Good Friday',
    '2026-05-25': 'Memorial Day',
    '2026-06-19': 'Juneteenth National Independence Day',
    '2026-07-03': 'Independence Day (observed)',
    '2026-09-07': 'Labor Day',
    '2026-11-26': 'Thanksgiving Day',
    '2026-12-25': 'Christmas Day'
  },
  2027: {
    '2027-01-01': 'New Year\'s Day',
    '2027-01-18': 'Martin Luther King Jr. Day',
    '2027-02-15': 'Presidents Day',
    '2027-03-26': 'Good Friday',
    '2027-05-31': 'Memorial Day',
    '2027-06-18': 'Juneteenth National Independence Day (observed)',
    '2027-07-05': 'Independence Day (observed)',
    '2027-09-06': 'Labor Day',
    '2027-11-25': 'Thanksgiving Day',
    '2027-12-24': 'Christmas Day (observed)'
  }
};

const LENSES = {
  inflation: {
    title: 'Price pressure is the question',
    body: 'Watch whether the 2Y and dollar treat the release as a genuine shift in the policy path.',
    watchlist: ['2Y', '10Y', 'DXY']
  },
  labor: {
    title: 'Labor sets the growth risk',
    body: 'The useful signal is whether hiring and wage pressure still support a soft landing.',
    watchlist: ['2Y', 'DXY', 'SPX']
  },
  growth: {
    title: 'Demand takes the stage',
    body: 'Focus on whether the release changes the durability of the consumer-led growth story.',
    watchlist: ['SPX', '10Y', 'DXY']
  },
  housing: {
    title: 'Rates meet real activity',
    body: 'Housing data shows whether mortgage costs are changing construction demand and supply.',
    watchlist: ['XHB', 'ITB', '10Y']
  },
  policy: {
    title: 'The reaction function matters',
    body: 'Policy communication matters only if it changes the market\'s expected rate path.',
    watchlist: ['2Y', '10Y', 'DXY']
  },
  energy: {
    title: 'Oil feeds the inflation trade',
    body: 'The signal matters through crude, inflation expectations, and energy-sector leadership.',
    watchlist: ['CL', 'XLE', '10Y']
  },
  quiet: {
    title: 'Quiet calendar',
    body: 'No major release today. Rates, oil, and headlines set the tone.',
    watchlist: []
  }
};

const LENS_BY_EVENT = {
  cpi: {
    title: 'CPI is the rates reset',
    body: 'This is the week\'s cleanest rates catalyst. A surprise will reprice the 2Y, dollar, and rate-sensitive equities.',
    watchlist: ['2Y', 'DXY', 'QQQ']
  },
  'core-cpi': {
    title: 'CPI is the rates reset',
    body: 'This is the week\'s cleanest rates catalyst. A surprise will reprice the 2Y, dollar, and rate-sensitive equities.',
    watchlist: ['2Y', 'DXY', 'QQQ']
  },
  ppi: {
    title: 'PPI tests the inflation signal',
    body: 'Producer costs test whether Tuesday\'s consumer-price signal has pipeline support or starts to fade.',
    watchlist: ['2Y', '10Y', 'XLE']
  },
  'core-ppi': {
    title: 'PPI tests the inflation signal',
    body: 'Producer costs test whether Tuesday\'s consumer-price signal has pipeline support or starts to fade.',
    watchlist: ['2Y', '10Y', 'XLE']
  },
  'retail-sales': {
    title: 'Demand gets the next vote',
    body: 'Retail sales shifts the focus from prices to demand. The core measure is the check on consumer resilience.',
    watchlist: ['SPX', 'XLY', '10Y']
  },
  'core-retail-sales': {
    title: 'Demand gets the next vote',
    body: 'The core retail measure is the cleaner read on whether consumer demand is still carrying growth.',
    watchlist: ['SPX', 'XLY', '10Y']
  },
  'jobless-claims': {
    title: 'Claims are the labor check',
    body: 'A jump would elevate growth concern into the weekend; a steady print keeps the soft-landing case intact.',
    watchlist: ['SPX', '2Y', 'DXY']
  },
  'housing-starts': {
    title: 'Construction tests mortgage drag',
    body: 'Starts show current building activity, while permits signal whether supply can recover from higher mortgage costs.',
    watchlist: ['XHB', 'ITB', '10Y']
  },
  'building-permits': {
    title: 'Construction tests mortgage drag',
    body: 'Permits are the forward-looking read on whether mortgage costs are restraining residential supply.',
    watchlist: ['XHB', 'ITB', '10Y']
  },
  'fed-rate-decision': {
    title: 'The reaction function takes over',
    body: 'The market will trade the policy path, especially any change in the balance between inflation and growth risks.',
    watchlist: ['2Y', '10Y', 'DXY']
  },
  'fomc-minutes': {
    title: 'Fed conviction is on trial',
    body: 'Minutes matter if they change conviction around the path of rates after the latest run of data.',
    watchlist: ['2Y', '10Y', 'DXY']
  },
  'opec-meeting': {
    title: 'Oil supply is the early macro swing',
    body: 'Producer guidance can move crude and inflation expectations before the U.S. data releases arrive.',
    watchlist: ['CL', 'XLE', '10Y']
  },
  'crude-oil-inventories': {
    title: 'Inventory data tests the crude move',
    body: 'The useful read is whether inventories confirm the supply-demand story already priced into oil.',
    watchlist: ['CL', 'XLE', '10Y']
  },
  'empire-state': {
    title: 'Manufacturing gets an early pulse',
    body: 'Empire State matters most if it confirms or contradicts the broader growth signals later in the week.',
    watchlist: ['SPX', '10Y', 'DXY']
  },
  'philly-fed': {
    title: 'Factories close the growth check',
    body: 'Philadelphia Fed is a useful cross-check on whether industrial momentum is broadening or stalling.',
    watchlist: ['SPX', '10Y', 'DXY']
  },
  'industrial-production': {
    title: 'Output tests the cyclical handoff',
    body: 'Industrial production shows whether growth is broadening beyond the consumer and large-cap technology.',
    watchlist: ['SPX', 'XLI', '10Y']
  },
  'michigan-sentiment': {
    title: 'Sentiment tests consumer staying power',
    body: 'The consumer read matters if it confirms or challenges the demand signal from retail sales.',
    watchlist: ['XLY', 'SPX', '10Y']
  }
};

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function releaseRule({ key, names, name, agency, period, impact, lens, variants }) {
  return {
    key,
    names: names.map(normalizeName),
    name,
    agency,
    period,
    impact,
    lens,
    variants: variants || null
  };
}

const EVENT_RULES = [
  releaseRule({
    key: 'cpi', names: ['CPI'], name: 'Consumer Price Index', agency: 'BLS', impact: 'high', lens: 'inflation',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({
    key: 'core-cpi', names: ['Core CPI'], name: 'Core Consumer Price Index', agency: 'BLS', impact: 'high', lens: 'inflation',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({
    key: 'ppi', names: ['PPI'], name: 'Producer Price Index', agency: 'BLS', impact: 'medium', lens: 'inflation',
    variants: [{ key: 'yoy', period: 'YoY' }, { key: 'mom', period: 'MoM' }]
  }),
  releaseRule({
    key: 'core-ppi', names: ['Core PPI'], name: 'Core Producer Price Index', agency: 'BLS', impact: 'medium', lens: 'inflation',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({ key: 'pce', names: ['PCE Price Index'], name: 'PCE Price Index', agency: 'BEA', period: 'YoY', impact: 'high', lens: 'inflation' }),
  releaseRule({ key: 'core-pce', names: ['Core PCE Price Index'], name: 'Core PCE Price Index', agency: 'BEA', period: 'YoY', impact: 'high', lens: 'inflation' }),
  releaseRule({ key: 'nonfarm-payrolls', names: ['Nonfarm Payrolls'], name: 'Nonfarm Payrolls', agency: 'BLS', period: 'Monthly', impact: 'high', lens: 'labor' }),
  releaseRule({ key: 'unemployment-rate', names: ['Unemployment Rate'], name: 'Unemployment Rate', agency: 'BLS', period: 'Monthly', impact: 'high', lens: 'labor' }),
  releaseRule({ key: 'average-hourly-earnings', names: ['Average Hourly Earnings'], name: 'Average Hourly Earnings', agency: 'BLS', period: 'MoM', impact: 'high', lens: 'labor' }),
  releaseRule({ key: 'adp-employment', names: ['ADP Employment Change'], name: 'ADP Employment Change', agency: 'ADP', period: 'Monthly', impact: 'medium', lens: 'labor' }),
  releaseRule({ key: 'jobless-claims', names: ['Initial Jobless Claims'], name: 'Initial Jobless Claims', agency: 'DOL', period: 'Weekly', impact: 'medium', lens: 'labor' }),
  releaseRule({ key: 'jolts', names: ['JOLTs Job Openings', 'JOLTS Job Openings'], name: 'JOLTS Job Openings', agency: 'BLS', period: 'Monthly', impact: 'medium', lens: 'labor' }),
  releaseRule({ key: 'retail-sales', names: ['Retail Sales'], name: 'Retail Sales', agency: 'Census', period: 'MoM', impact: 'high', lens: 'growth' }),
  releaseRule({ key: 'core-retail-sales', names: ['Core Retail Sales'], name: 'Core Retail Sales', agency: 'Census', period: 'MoM', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'gdp', names: ['GDP Growth Rate', 'GDP Price Index'], name: 'Gross Domestic Product', agency: 'BEA', period: 'Quarterly', impact: 'high', lens: 'growth' }),
  releaseRule({ key: 'durable-goods', names: ['Durable Goods Orders'], name: 'Durable Goods Orders', agency: 'Census', period: 'MoM', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'industrial-production', names: ['Industrial Production'], name: 'Industrial Production', agency: 'Federal Reserve', period: 'MoM', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'factory-orders', names: ['Factory Orders'], name: 'Factory Orders', agency: 'Census', period: 'MoM', impact: 'low', lens: 'growth' }),
  releaseRule({ key: 'ism-manufacturing', names: ['ISM Manufacturing PMI'], name: 'ISM Manufacturing', agency: 'ISM', period: 'Index', impact: 'high', lens: 'growth' }),
  releaseRule({ key: 'ism-services', names: ['ISM Non-Manufacturing PMI', 'ISM Services PMI'], name: 'ISM Services', agency: 'ISM', period: 'Index', impact: 'high', lens: 'growth' }),
  releaseRule({ key: 'empire-state', names: ['NY Empire State Manufacturing Index'], name: 'Empire State Manufacturing', agency: 'New York Fed', period: 'Index', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'philly-fed', names: ['Philadelphia Fed Manufacturing Index'], name: 'Philadelphia Fed Manufacturing', agency: 'Philadelphia Fed', period: 'Index', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'consumer-confidence', names: ['CB Consumer Confidence'], name: 'Consumer Confidence', agency: 'Conference Board', period: 'Index', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'michigan-sentiment', names: ['Michigan Consumer Sentiment'], name: 'University of Michigan Sentiment', agency: 'University of Michigan', period: 'Index', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'housing-starts', names: ['Housing Starts'], name: 'Housing Starts', agency: 'Census', period: 'Annualized', impact: 'low', lens: 'housing' }),
  releaseRule({ key: 'building-permits', names: ['Building Permits'], name: 'Building Permits', agency: 'Census', period: 'Annualized', impact: 'low', lens: 'housing' }),
  releaseRule({ key: 'existing-home-sales', names: ['Existing Home Sales'], name: 'Existing Home Sales', agency: 'NAR', period: 'Annualized', impact: 'low', lens: 'housing' }),
  releaseRule({ key: 'new-home-sales', names: ['New Home Sales'], name: 'New Home Sales', agency: 'Census', period: 'Annualized', impact: 'low', lens: 'housing' }),
  releaseRule({ key: 'trade-balance', names: ['Trade Balance'], name: 'Trade Balance', agency: 'Census', period: 'Monthly', impact: 'medium', lens: 'growth' }),
  releaseRule({ key: 'federal-budget', names: ['Federal Budget Balance'], name: 'Federal Budget Balance', agency: 'Treasury', period: 'Monthly', impact: 'low', lens: 'growth' }),
  releaseRule({ key: 'crude-oil-inventories', names: ['Crude Oil Inventories'], name: 'EIA Crude Oil Inventories', agency: 'EIA', period: 'Weekly', impact: 'low', lens: 'energy' }),
  releaseRule({ key: 'opec-meeting', names: ['OPEC Meeting'], name: 'OPEC Meeting', agency: 'OPEC', period: 'Policy', impact: 'medium', lens: 'energy' }),
  releaseRule({ key: 'fomc-minutes', names: ['FOMC Meeting Minutes'], name: 'FOMC Minutes', agency: 'Federal Reserve', period: 'Policy', impact: 'high', lens: 'policy' }),
  releaseRule({ key: 'fed-rate-decision', names: ['Fed Interest Rate Decision', 'FOMC Statement'], name: 'Federal Reserve Decision', agency: 'Federal Reserve', period: 'Policy', impact: 'high', lens: 'policy' })
];

function dateParts(date, timeZone, options = {}) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: options.weekday,
    hour: options.time ? '2-digit' : undefined,
    minute: options.time ? '2-digit' : undefined,
    hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return {
    isoDate: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: part('weekday'),
    hour: Number(part('hour')) % 24,
    minute: Number(part('minute'))
  };
}

function mondayForDate(date = new Date()) {
  const local = dateParts(date, TIME_ZONE, { weekday: 'short' });
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday);
  return addDays(local.isoDate, -((weekdayIndex + 6) % 7));
}

function rangeForDate(date = new Date()) {
  const local = dateParts(date, TIME_ZONE, { weekday: 'short' });
  const monday = mondayForDate(date);
  if (['Fri', 'Sat', 'Sun'].includes(local.weekday)) {
    const friday = addDays(monday, 4);
    return { from: friday, to: addDays(friday, 6) };
  }
  return { from: monday, to: addDays(monday, 4) };
}

function displayDatesForRange(range) {
  return calendarDisplayDatesForRange(range?.from, range?.to);
}

function dayLabel(isoDate) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function variantsForRule(rule) {
  return rule.variants
    ? rule.variants.map((variant) => ({ key: `${rule.key}-${variant.key}`, period: variant.period }))
    : [{ key: rule.key, period: rule.period }];
}

function ruleForKey(key) {
  return EVENT_RULES.find((rule) => rule.key === key) || null;
}

// These mappings are intentionally explicit: an indicator is used only when
// FXMacroData labels both its announcement series and forecast series for the
// exact displayed variant. This prevents row-order guesses for CPI/PPI.
const FX_MACRO_VALUE_RULES = {
  'cpi-yoy': { announcementIndicator: 'inflation', predictionIndicator: 'inflation', field: 'val', unit: 'percent' },
  'cpi-mom': { announcementIndicator: 'inflation', predictionIndicator: 'inflation_mom', field: 'val_mom', unit: 'percent' },
  'core-cpi-yoy': { announcementIndicator: 'core_inflation', predictionIndicator: 'core_inflation', field: 'val', unit: 'percent' },
  'core-cpi-mom': { announcementIndicator: 'core_inflation', predictionIndicator: 'core_inflation_mom', field: 'val_mom', unit: 'percent' },
  'ppi-yoy': { announcementIndicator: 'ppi', predictionIndicator: 'ppi', field: 'val', unit: 'percent' },
  'ppi-mom': { announcementIndicator: 'ppi', predictionIndicator: 'ppi_mom', field: 'val_mom', unit: 'percent' },
  'pce': { announcementIndicator: 'pce', predictionIndicator: 'pce', field: 'val', unit: 'percent' },
  'core-pce': { announcementIndicator: 'core_pce', predictionIndicator: 'core_pce', field: 'val', unit: 'percent' },
  'nonfarm-payrolls': { announcementIndicator: 'non_farm_payrolls', predictionIndicator: 'non_farm_payrolls', field: 'val', unit: 'thousands' },
  'unemployment-rate': { announcementIndicator: 'unemployment', predictionIndicator: 'unemployment', field: 'val', unit: 'percent' },
  'jobless-claims': { announcementIndicator: 'initial_jobless_claims', predictionIndicator: 'initial_jobless_claims', field: 'val', unit: 'thousands' },
  'retail-sales': { announcementIndicator: 'retail_sales', predictionIndicator: 'retail_sales', field: 'val', unit: 'percent' },
  'durable-goods': { announcementIndicator: 'durable_goods_orders', predictionIndicator: 'durable_goods_orders', field: 'val', unit: 'percent' },
  'housing-starts': { announcementIndicator: 'housing_starts', predictionIndicator: 'housing_starts', field: 'val', unit: 'millions' },
  'building-permits': { announcementIndicator: 'building_permits', predictionIndicator: 'building_permits', field: 'val', unit: 'millions' }
};

function numberLabel(value, maximumFractionDigits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(numeric);
}

function formatFxMacroValue(value, unit) {
  if (value === null || value === undefined || value === '') return null;
  if (unit === 'percent') {
    const label = numberLabel(value, 1);
    return label === null ? null : `${label}%`;
  }
  if (unit === 'thousands') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return `${numberLabel(numeric / 1000, 1)}K`;
  }
  if (unit === 'millions') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const label = numberLabel(Math.abs(numeric) >= 100 ? numeric / 1000 : numeric, 3);
    return label === null ? null : `${label}M`;
  }
  return numberLabel(value, 2);
}

function releaseDateTime(release) {
  return `${release.date}T${release.time}`;
}

function localDateTime(row) {
  return String(row?.announcement_datetime_local || '').slice(0, 16);
}

function selectForecast(predictions) {
  if (!Array.isArray(predictions)) return null;
  const consensus = predictions.find((item) => item?.prediction_type === 'market_consensus');
  if (consensus) return { prediction: consensus, type: 'consensus' };
  const centralBankNowcast = predictions.find((item) => item?.prediction_type === 'central_bank_forecast');
  if (centralBankNowcast) return { prediction: centralBankNowcast, type: 'nowcast' };
  const providerModel = predictions.find((item) => item?.prediction_type === 'fxmacrodata');
  return providerModel ? { prediction: providerModel, type: 'model' } : null;
}

function fxMacroValueRequests(officialSchedule) {
  const keys = new Set();
  for (const release of officialSchedule?.events || []) {
    for (const ruleKey of release.keys || []) {
      const rule = ruleForKey(ruleKey);
      if (!rule) continue;
      for (const variant of variantsForRule(rule)) keys.add(variant.key);
    }
  }
  const selected = [...keys].map((key) => FX_MACRO_VALUE_RULES[key]).filter(Boolean);
  return {
    announcements: [...new Set(selected.map((item) => item.announcementIndicator))],
    predictions: [...new Set(selected.map((item) => item.predictionIndicator))]
  };
}

function fxMacroValuesForSchedule(officialSchedule, valuePayload) {
  const announcements = valuePayload?.announcements || {};
  const predictions = valuePayload?.predictions || {};
  const values = new Map();
  for (const release of officialSchedule?.events || []) {
    for (const ruleKey of release.keys || []) {
      const rule = ruleForKey(ruleKey);
      if (!rule) continue;
      for (const variant of variantsForRule(rule)) {
        const spec = FX_MACRO_VALUE_RULES[variant.key];
        if (!spec) continue;
        const predictionRows = Array.isArray(predictions[spec.predictionIndicator]?.data) ? predictions[spec.predictionIndicator].data : [];
        const targetPrediction = predictionRows.find((row) => localDateTime(row) === releaseDateTime(release));
        if (!targetPrediction?.announcement_id) continue;
        const announcementRows = Array.isArray(announcements[spec.announcementIndicator]?.data) ? announcements[spec.announcementIndicator].data : [];
        const targetActual = announcementRows.find((row) => row?.announcement_id === targetPrediction.announcement_id) || null;
        const priorActual = announcementRows
          .filter((row) => Number(row?.announcement_datetime) < Number(targetPrediction.announcement_datetime))
          .sort((left, right) => Number(right.announcement_datetime) - Number(left.announcement_datetime))[0] || null;
        const selectedForecast = selectForecast(targetPrediction.predictions);
        const value = {
          actual: formatFxMacroValue(targetActual?.[spec.field], spec.unit),
          forecast: formatFxMacroValue(selectedForecast?.prediction?.predicted_value, spec.unit),
          forecastType: selectedForecast?.type || null,
          forecastSource: selectedForecast?.prediction?.prediction_source_label || null,
          previous: formatFxMacroValue(priorActual?.[spec.field], spec.unit)
        };
        if (value.actual || value.forecast || value.previous) values.set(`${release.date}:${release.time}:${variant.key}`, value);
      }
    }
  }
  return values;
}

function officialEvent(release, rule, variant, values) {
  return {
    id: `${release.date}:${release.time}:${variant.key}`,
    time: release.time,
    name: rule.name,
    agency: rule.agency,
    period: variant.period,
    impact: rule.impact,
    actual: values?.actual || null,
    forecast: values?.forecast || null,
    forecastType: values?.forecastType || null,
    forecastSource: values?.forecastSource || null,
    previous: values?.previous || null,
    scheduleSource: release.authorityName,
    valueSource: values ? 'FXMacroData' : null,
    verification: values ? 'official-schedule-fxmacrodata-values' : 'official-schedule-values-unavailable'
  };
}

function lensForEvents(events) {
  if (!events.length) return null;
  const weight = { high: 3, medium: 2, low: 1 };
  const selected = [...events].sort((left, right) => (weight[right.impact] - weight[left.impact]))[0];
  const variantKey = String(selected?.id || '').split(':').slice(3).join(':');
  const key = EVENT_RULES.find((rule) => variantKey === rule.key || variantKey.startsWith(`${rule.key}-`))?.key || variantKey;
  return { ...(LENS_BY_EVENT[key] || LENSES[selected?.lens || 'quiet']) };
}

function normalizeWeekAhead(valuePayload, { range = rangeForDate(), officialSchedule, now = new Date() } = {}) {
  const targetDays = displayDatesForRange(range);
  if (targetDays.length !== 5) throw new Error('Week Ahead range must be Monday-Friday or Friday plus next Monday-Thursday.');

  if (!isPlainObject(officialSchedule) || !Array.isArray(officialSchedule.events) || !Array.isArray(officialSchedule.authorities)) {
    throw new Error('Official Week Ahead schedule is required before values can be normalized.');
  }

  const targetDaySet = new Set(targetDays);
  const officialEvents = officialSchedule.events
    .filter((release) => targetDaySet.has(release?.date) && isIsoTime(release?.time) && Array.isArray(release?.keys));
  const valuesById = fxMacroValuesForSchedule({ ...officialSchedule, events: officialEvents }, valuePayload);
  const normalized = [];
  for (const release of officialEvents) {
    for (const key of release.keys) {
      const rule = ruleForKey(key);
      if (!rule) throw new Error(`Official Week Ahead schedule references unknown event key: ${key}.`);
      for (const variant of variantsForRule(rule)) {
        const values = valuesById.get(`${release.date}:${release.time}:${variant.key}`) || null;
        normalized.push({ ...officialEvent(release, rule, variant, values), date: release.date, sortMinutes: Number(release.time.slice(0, 2)) * 60 + Number(release.time.slice(3, 5)), lens: rule.lens });
      }
    }
  }

  const deduped = [];
  const seenIds = new Set();
  for (const item of normalized.sort((left, right) => left.date.localeCompare(right.date) || left.sortMinutes - right.sortMinutes || left.id.localeCompare(right.id))) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    deduped.push(item);
  }

  const days = targetDays.map((date) => {
    const matchedEvents = deduped
      .filter((event) => event.date === date)
      .sort((left, right) => left.sortMinutes - right.sortMinutes || left.id.localeCompare(right.id));
    const events = matchedEvents
      .map(({ date: _date, sortMinutes: _sortMinutes, lens: _lens, ...event }) => event);
    const closureName = MARKET_CLOSURES[Number(date.slice(0, 4))]?.[date] || '';
    const day = {
      date,
      label: dayLabel(date),
      closure: closureName ? { label: 'U.S. Markets Closed', reason: closureName } : null,
      events
    };
    if (matchedEvents.length) {
      day.marketLens = lensForEvents(matchedEvents);
      day.marketLensSource = 'generated';
    }
    return day;
  });

  const result = {
    schemaVersion: SCHEMA_VERSION,
    range: { ...range, timeZone: TIME_ZONE, marketTimeZone: SOURCE_TIME_ZONE },
    generatedAt: now.toISOString(),
    source: {
      provider: FX_MACRO_PROVIDER,
      endpoint: FX_MACRO_ENDPOINT,
      status: 'fresh',
      fetchedAt: now.toISOString(),
      timeInterpretation: TIME_INTERPRETATION
    },
    officialSchedule: {
      events: officialEvents,
      authorities: officialSchedule.authorities
    },
    days,
    sourceSummary: {
      returnedEvents: Object.values(valuePayload?.announcements || {}).reduce((count, response) => count + (Array.isArray(response?.data) ? response.data.length : 0), 0),
      includedEvents: deduped.length,
      officialScheduledEvents: officialEvents.length,
      officialConflicts: 0,
      omittedRecognizedEvents: 0
    }
  };
  const errors = validateWeekAheadPayload(result);
  if (errors.length) throw new Error(`Normalized Week Ahead payload is invalid: ${errors.join(' ')}`);
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateWeekAheadPayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) return ['weekAhead must be an object.'];
  if (payload.schemaVersion !== SCHEMA_VERSION) errors.push(`weekAhead.schemaVersion must be ${SCHEMA_VERSION}.`);
  const displayDates = displayDatesForRange(payload.range);
  if (!isPlainObject(payload.range) || !isIsoDate(payload.range.from) || !isIsoDate(payload.range.to)) {
    errors.push('weekAhead.range must contain ISO from/to dates.');
  } else if (displayDates.length !== 5) {
    errors.push('weekAhead.range must cover Monday-Friday or Friday plus next Monday-Thursday.');
  }
  if (payload.range?.timeZone !== TIME_ZONE) errors.push(`weekAhead.range.timeZone must be ${TIME_ZONE}.`);
  if (payload.range?.marketTimeZone !== SOURCE_TIME_ZONE) errors.push(`weekAhead.range.marketTimeZone must be ${SOURCE_TIME_ZONE}.`);
  if (!isIsoDateTime(payload.generatedAt)) errors.push('weekAhead.generatedAt must be an offset-bearing ISO timestamp.');
  if (!isPlainObject(payload.source) || !['fresh', 'cached'].includes(payload.source.status)) errors.push('weekAhead.source.status must be fresh or cached.');
  if (payload.source?.provider !== FX_MACRO_PROVIDER) errors.push(`weekAhead.source.provider must be ${FX_MACRO_PROVIDER}.`);
  if (payload.source?.endpoint !== FX_MACRO_ENDPOINT) errors.push('weekAhead.source.endpoint must identify the FXMacroData announcement and prediction endpoints.');
  if (payload.source?.timeInterpretation !== TIME_INTERPRETATION) errors.push('weekAhead.source.timeInterpretation must describe official U.S. release schedules stored in Eastern time.');
  if (!isIsoDateTime(payload.source?.fetchedAt)) errors.push('weekAhead.source.fetchedAt must be an offset-bearing ISO timestamp.');
  if (!isPlainObject(payload.officialSchedule) || !Array.isArray(payload.officialSchedule.events) || !Array.isArray(payload.officialSchedule.authorities)) {
    errors.push('weekAhead.officialSchedule must contain events and authorities.');
  }
  if (!Array.isArray(payload.days) || payload.days.length !== 5) {
    errors.push('weekAhead.days must contain exactly five weekdays.');
    return errors;
  }
  const ids = new Set();
  payload.days.forEach((day, dayIndex) => {
    const expectedDate = displayDates[dayIndex] || '';
    if (!isPlainObject(day) || day.date !== expectedDate) errors.push(`weekAhead.days[${dayIndex}] must match the target weekday.`);
    if (typeof day?.label !== 'string' || !day.label) errors.push(`weekAhead.days[${dayIndex}].label is required.`);
    if (day?.closure !== null && day?.closure !== undefined && (!isPlainObject(day.closure) || !day.closure.label || !day.closure.reason)) {
      errors.push(`weekAhead.days[${dayIndex}].closure must be null or a labeled closure.`);
    }
    if (!Array.isArray(day?.events)) {
      errors.push(`weekAhead.days[${dayIndex}].events must be an array.`);
      return;
    }
    const hasEvents = day.events.length > 0;
    const hasMarketLens = day.marketLens !== undefined && day.marketLens !== null;
    if (hasEvents && (!isPlainObject(day.marketLens) || !day.marketLens.title || !day.marketLens.body || !Array.isArray(day.marketLens.watchlist))) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens is incomplete.`);
    }
    if (!hasEvents && hasMarketLens) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens must be omitted when there are no events.`);
    }
    if (hasEvents && !['generated', 'editorial'].includes(day?.marketLensSource)) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensSource must be generated or editorial.`);
    }
    if (!hasEvents && day?.marketLensSource !== undefined) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensSource must be omitted when there are no events.`);
    }
    let previousTime = '';
    day.events.forEach((event, eventIndex) => {
      const prefix = `weekAhead.days[${dayIndex}].events[${eventIndex}]`;
      if (!isPlainObject(event)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      if (typeof event.id !== 'string' || !event.id || ids.has(event.id)) errors.push(`${prefix}.id must be unique.`);
      ids.add(event.id);
      if (!isIsoTime(event.time) || event.time < previousTime) errors.push(`${prefix}.time must be an ordered HH:MM time.`);
      previousTime = event.time || previousTime;
      for (const field of ['name', 'agency', 'period']) {
        if (typeof event[field] !== 'string' || !event[field]) errors.push(`${prefix}.${field} is required.`);
      }
      if (!['high', 'medium', 'low'].includes(event.impact)) errors.push(`${prefix}.impact is invalid.`);
      for (const field of ['actual', 'forecast', 'previous']) {
        if (event[field] !== null && typeof event[field] !== 'string') errors.push(`${prefix}.${field} must be string or null.`);
      }
      if (![null, 'consensus', 'nowcast', 'model'].includes(event.forecastType)) errors.push(`${prefix}.forecastType is invalid.`);
      if (['nowcast', 'model'].includes(event.forecastType) && (typeof event.forecastSource !== 'string' || !event.forecastSource)) {
        errors.push(`${prefix}.forecastSource is required for a qualified forecast.`);
      }
      if (event.forecastType !== null && !event.forecast) errors.push(`${prefix}.forecastType requires a forecast value.`);
      if (typeof event.scheduleSource !== 'string' || !event.scheduleSource) errors.push(`${prefix}.scheduleSource is required.`);
      if (event.valueSource !== null && typeof event.valueSource !== 'string') errors.push(`${prefix}.valueSource must be string or null.`);
      if (!['official-schedule-fxmacrodata-values', 'official-schedule-values-unavailable'].includes(event.verification)) {
        errors.push(`${prefix}.verification is invalid.`);
      }
    });
  });
  for (const release of Array.isArray(payload.officialSchedule?.events) ? payload.officialSchedule.events : []) {
    if (!isIsoDate(release?.date) || !isIsoTime(release?.time) || !Array.isArray(release?.keys) || !release.keys.length) {
      errors.push('weekAhead.officialSchedule.events contains an invalid release.');
      continue;
    }
    for (const ruleKey of release.keys) {
      const rule = ruleForKey(ruleKey);
      if (!rule) {
        errors.push(`weekAhead.officialSchedule references unknown event key ${ruleKey}.`);
        continue;
      }
      for (const variant of variantsForRule(rule)) {
        const id = `${release.date}:${release.time}:${variant.key}`;
        const found = payload.days.flatMap((day) => day.events || []).find((item) => item.id === id);
        if (!found || found.scheduleSource !== release.authorityName) {
          errors.push(`weekAhead official release ${id} must be present at the authority's date and time.`);
        }
      }
    }
  }
  return errors;
}

module.exports = {
  EVENT_RULES,
  FX_MACRO_ENDPOINT,
  FX_MACRO_PROVIDER,
  MARKET_CLOSURES,
  SCHEMA_VERSION,
  SOURCE_TIME_ZONE,
  TIME_INTERPRETATION,
  TIME_ZONE,
  addDays,
  displayDatesForRange,
  formatFxMacroValue,
  fxMacroValueRequests,
  mondayForDate,
  normalizeWeekAhead,
  rangeForDate,
  validateWeekAheadPayload
};
