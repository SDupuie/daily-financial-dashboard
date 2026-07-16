const { isDeepStrictEqual } = require('util');
const TIME_ZONE = 'America/Chicago';
const SOURCE_TIME_ZONE = 'America/New_York';
const SCHEMA_VERSION = 4;
// These source labels are serialized into the dashboard, so they are contract
// constants rather than display copy that a fetcher or cache may freely alter.
const FX_MACRO_PROVIDER = 'FXMacroData';
const FX_MACRO_ENDPOINT = '/v1/announcements/{currency}/{indicator} + /v1/predictions/{currency}/{indicator}';
const WEEK_AHEAD_OUTCOME_STATUSES = new Set(['verified', 'dropped_after_review']);
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

const MARKET_LENS_CHANNELS = new Set([
  'policy-path',
  'consumer-inflation',
  'producer-inflation',
  'labor-demand',
  'consumer-demand',
  'broad-growth',
  'industrial-growth',
  'services-activity',
  'housing',
  'energy-balance',
  'external-balance',
  'fiscal-financing'
]);

const MARKET_LENS_REACTIONS_BY_CHANNEL = {
  'policy-path': ['UST2Y', 'UST10Y', 'UUP', 'NDX'],
  'consumer-inflation': ['UST2Y', 'UST10Y', 'UUP', 'NDX'],
  'producer-inflation': ['UST2Y', 'UST10Y', 'VDE'],
  'labor-demand': ['UST2Y', 'SPX', 'HYG', 'UUP'],
  'consumer-demand': ['VCR', 'SPX', 'UST10Y'],
  'broad-growth': ['SPX', 'UST10Y', 'HYG'],
  'industrial-growth': ['VIS', 'HG', 'UST10Y', 'HYG'],
  'services-activity': ['SPX', 'UST2Y', 'UUP'],
  housing: ['UST10Y', 'VNQ', 'HG'],
  'energy-balance': ['CL', 'VDE', 'UST10Y'],
  'external-balance': ['UUP', 'VEA'],
  'fiscal-financing': ['UST10Y', 'UST30Y', 'UUP']
};

// Generated lenses deliberately describe ordinary transmission only. Current
// market claims belong in a validated editorial replacement.
const DEFAULT_MARKET_LENS_PATHS = {
  'consumer-inflation': {
    question: 'Will consumer inflation change the expected policy path?',
    channels: ['consumer-inflation', 'policy-path'],
    title: 'Consumer inflation tests the rate path',
    body: 'The price data will show whether consumer inflation is changing expectations for the Fed\'s next steps. Short rates and the dollar provide the clearest initial reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'UUP', role: 'Dollar-policy reaction' }
    ]
  },
  'producer-inflation': {
    question: 'Are producer costs reinforcing broader inflation pressure?',
    channels: ['producer-inflation', 'policy-path'],
    title: 'Producer costs test the inflation signal',
    body: 'The producer-price data will show whether pipeline costs are reinforcing broader inflation pressure. The Treasury curve provides the cleanest initial reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'UST10Y', role: 'Broader inflation-rate reaction' }
    ]
  },
  labor: {
    question: 'Is labor demand changing the balance between inflation and growth?',
    channels: ['labor-demand', 'policy-path'],
    title: 'Labor tests the growth-inflation balance',
    body: 'The labor data will show whether employment conditions are changing the balance between wage pressure and growth risk. Short rates and broad equities provide the clearest reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'SPX', role: 'Broad growth reaction' }
    ]
  },
  'consumer-demand': {
    question: 'Is household demand strong enough to affect growth and rates?',
    channels: ['consumer-demand', 'broad-growth'],
    title: 'Household demand tests growth',
    body: 'The consumer data will show whether household demand is sustaining growth strongly enough to affect rates. Discretionary equities and long yields provide the clearest reaction.',
    reactions: [
      { ticker: 'VCR', role: 'Consumer-demand reaction' },
      { ticker: 'UST10Y', role: 'Growth-rate reaction' }
    ]
  },
  'broad-growth': {
    question: 'Is broad economic growth changing the market outlook?',
    channels: ['broad-growth'],
    title: 'Growth resets the broad outlook',
    body: 'The growth data will test whether the economy is changing the outlook for earnings and rates. Broad equities and long yields provide the clearest reaction.',
    reactions: [
      { ticker: 'SPX', role: 'Broad earnings reaction' },
      { ticker: 'UST10Y', role: 'Growth-rate reaction' }
    ]
  },
  manufacturing: {
    question: 'Is industrial momentum broadening or weakening?',
    channels: ['industrial-growth'],
    title: 'Industry tests the cyclical pulse',
    body: 'The factory data will show whether industrial momentum is broadening or weakening. Industrials and copper provide the clearest cyclical reaction.',
    reactions: [
      { ticker: 'VIS', role: 'Industrial-equity reaction' },
      { ticker: 'HG', role: 'Materials-demand reaction' }
    ]
  },
  services: {
    question: 'Is services activity sustaining growth and price pressure?',
    channels: ['services-activity', 'policy-path'],
    title: 'Services test growth and price pressure',
    body: 'The services data will show whether activity is sustaining both growth and price pressure. Broad equities and short rates provide the clearest reaction.',
    reactions: [
      { ticker: 'SPX', role: 'Broad growth reaction' },
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' }
    ]
  },
  housing: {
    question: 'Are financing costs restraining housing activity?',
    channels: ['housing'],
    title: 'Housing tests the mortgage-rate drag',
    body: 'The housing data will show whether financing costs are restraining activity and supply. Long yields and rate-sensitive real estate provide the clearest reaction.',
    reactions: [
      { ticker: 'UST10Y', role: 'Mortgage-rate reaction' },
      { ticker: 'VNQ', role: 'Rate-sensitive real-estate reaction' }
    ]
  },
  policy: {
    question: 'Has the expected rate path changed?',
    channels: ['policy-path'],
    title: 'The expected rate path is the test',
    body: 'The policy communication matters if it changes expectations for the Fed\'s next steps. The front and long ends of the Treasury curve provide the clearest reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Near-term policy reaction' },
      { ticker: 'UST10Y', role: 'Longer-term policy reaction' }
    ]
  },
  energy: {
    question: 'Are supply conditions tightening or easing the crude balance?',
    channels: ['energy-balance'],
    title: 'Supply tests the crude balance',
    body: 'The supply data will show whether oil conditions are tightening or easing. Crude and energy equities provide the clearest reaction.',
    reactions: [
      { ticker: 'CL', role: 'Underlying crude-balance reaction' },
      { ticker: 'VDE', role: 'Energy-equity reaction' }
    ]
  },
  external: {
    question: 'Is the external balance changing the dollar backdrop?',
    channels: ['external-balance'],
    title: 'Trade tests the dollar backdrop',
    body: 'The trade data will show whether the external balance is changing the currency backdrop. The dollar provides the most direct dashboard reaction.',
    reactions: [{ ticker: 'UUP', role: 'Dollar reaction' }]
  },
  fiscal: {
    question: 'Is the fiscal position changing Treasury financing pressure?',
    channels: ['fiscal-financing'],
    title: 'The budget tests financing pressure',
    body: 'The budget data provides context for Treasury financing pressure. Long-dated yields provide the most direct dashboard reaction.',
    reactions: [
      { ticker: 'UST10Y', role: 'Treasury-financing reaction' },
      { ticker: 'UST30Y', role: 'Long-duration financing reaction' }
    ]
  }
};

const DEFAULT_PATH_BY_EVENT = {
  cpi: 'consumer-inflation',
  'core-cpi': 'consumer-inflation',
  pce: 'consumer-inflation',
  'core-pce': 'consumer-inflation',
  ppi: 'producer-inflation',
  'core-ppi': 'producer-inflation',
  'nonfarm-payrolls': 'labor',
  'unemployment-rate': 'labor',
  'average-hourly-earnings': 'labor',
  'adp-employment': 'labor',
  'jobless-claims': 'labor',
  jolts: 'labor',
  'retail-sales': 'consumer-demand',
  'core-retail-sales': 'consumer-demand',
  'consumer-confidence': 'consumer-demand',
  'michigan-sentiment': 'consumer-demand',
  gdp: 'broad-growth',
  'durable-goods': 'manufacturing',
  'industrial-production': 'manufacturing',
  'factory-orders': 'manufacturing',
  'ism-manufacturing': 'manufacturing',
  'empire-state': 'manufacturing',
  'philly-fed': 'manufacturing',
  'ism-services': 'services',
  'housing-starts': 'housing',
  'building-permits': 'housing',
  'existing-home-sales': 'housing',
  'new-home-sales': 'housing',
  'trade-balance': 'external',
  'federal-budget': 'fiscal',
  'crude-oil-inventories': 'energy',
  'opec-meeting': 'energy',
  'fomc-minutes': 'policy',
  'fed-rate-decision': 'policy'
};

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function releaseRule({ key, names, name, agency, period, impact, variants }) {
  const lensPath = DEFAULT_PATH_BY_EVENT[key];
  if (!DEFAULT_MARKET_LENS_PATHS[lensPath]) throw new Error(`Missing default Market Lens path for ${key}.`);
  return {
    key,
    names: names.map(normalizeName),
    name,
    agency,
    period,
    impact,
    lensPath,
    variants: variants || null
  };
}

const EVENT_RULES = [
  releaseRule({
    key: 'cpi', names: ['CPI'], name: 'Consumer Price Index', agency: 'BLS', impact: 'high',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({
    key: 'core-cpi', names: ['Core CPI'], name: 'Core Consumer Price Index', agency: 'BLS', impact: 'high',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({
    key: 'ppi', names: ['PPI'], name: 'Producer Price Index', agency: 'BLS', impact: 'medium',
    variants: [{ key: 'yoy', period: 'YoY' }, { key: 'mom', period: 'MoM' }]
  }),
  releaseRule({
    key: 'core-ppi', names: ['Core PPI'], name: 'Core Producer Price Index', agency: 'BLS', impact: 'medium',
    variants: [{ key: 'mom', period: 'MoM' }, { key: 'yoy', period: 'YoY' }]
  }),
  releaseRule({ key: 'pce', names: ['PCE Price Index'], name: 'PCE Price Index', agency: 'BEA', period: 'YoY', impact: 'high' }),
  releaseRule({ key: 'core-pce', names: ['Core PCE Price Index'], name: 'Core PCE Price Index', agency: 'BEA', period: 'YoY', impact: 'high' }),
  releaseRule({ key: 'nonfarm-payrolls', names: ['Nonfarm Payrolls'], name: 'Nonfarm Payrolls', agency: 'BLS', period: 'Monthly', impact: 'high' }),
  releaseRule({ key: 'unemployment-rate', names: ['Unemployment Rate'], name: 'Unemployment Rate', agency: 'BLS', period: 'Monthly', impact: 'high' }),
  releaseRule({ key: 'average-hourly-earnings', names: ['Average Hourly Earnings'], name: 'Average Hourly Earnings', agency: 'BLS', period: 'MoM', impact: 'high' }),
  releaseRule({ key: 'adp-employment', names: ['ADP Employment Change'], name: 'ADP Employment Change', agency: 'ADP', period: 'Monthly', impact: 'medium' }),
  releaseRule({ key: 'jobless-claims', names: ['Initial Jobless Claims'], name: 'Initial Jobless Claims', agency: 'DOL', period: 'Weekly', impact: 'medium' }),
  releaseRule({ key: 'jolts', names: ['JOLTs Job Openings', 'JOLTS Job Openings'], name: 'JOLTS Job Openings', agency: 'BLS', period: 'Monthly', impact: 'medium' }),
  releaseRule({ key: 'retail-sales', names: ['Retail Sales'], name: 'Retail Sales', agency: 'Census', period: 'MoM', impact: 'high' }),
  releaseRule({ key: 'core-retail-sales', names: ['Core Retail Sales'], name: 'Core Retail Sales', agency: 'Census', period: 'MoM', impact: 'medium' }),
  releaseRule({ key: 'gdp', names: ['GDP Growth Rate', 'GDP Price Index'], name: 'Gross Domestic Product', agency: 'BEA', period: 'Quarterly', impact: 'high' }),
  releaseRule({ key: 'durable-goods', names: ['Durable Goods Orders'], name: 'Durable Goods Orders', agency: 'Census', period: 'MoM', impact: 'medium' }),
  releaseRule({ key: 'industrial-production', names: ['Industrial Production'], name: 'Industrial Production', agency: 'Federal Reserve', period: 'MoM', impact: 'medium' }),
  releaseRule({ key: 'factory-orders', names: ['Factory Orders'], name: 'Factory Orders', agency: 'Census', period: 'MoM', impact: 'low' }),
  releaseRule({ key: 'ism-manufacturing', names: ['ISM Manufacturing PMI'], name: 'ISM Manufacturing', agency: 'ISM', period: 'Index', impact: 'high' }),
  releaseRule({ key: 'ism-services', names: ['ISM Non-Manufacturing PMI', 'ISM Services PMI'], name: 'ISM Services', agency: 'ISM', period: 'Index', impact: 'high' }),
  releaseRule({ key: 'empire-state', names: ['NY Empire State Manufacturing Index'], name: 'Empire State Manufacturing', agency: 'New York Fed', period: 'Index', impact: 'medium' }),
  releaseRule({ key: 'philly-fed', names: ['Philadelphia Fed Manufacturing Index'], name: 'Philadelphia Fed Manufacturing', agency: 'Philadelphia Fed', period: 'Index', impact: 'medium' }),
  releaseRule({ key: 'consumer-confidence', names: ['CB Consumer Confidence'], name: 'Consumer Confidence', agency: 'Conference Board', period: 'Index', impact: 'medium' }),
  releaseRule({ key: 'michigan-sentiment', names: ['Michigan Consumer Sentiment'], name: 'University of Michigan Sentiment', agency: 'University of Michigan', period: 'Index', impact: 'medium' }),
  releaseRule({ key: 'housing-starts', names: ['Housing Starts'], name: 'Housing Starts', agency: 'Census', period: 'Annualized', impact: 'low' }),
  releaseRule({ key: 'building-permits', names: ['Building Permits'], name: 'Building Permits', agency: 'Census', period: 'Annualized', impact: 'low' }),
  releaseRule({ key: 'existing-home-sales', names: ['Existing Home Sales'], name: 'Existing Home Sales', agency: 'NAR', period: 'Annualized', impact: 'low' }),
  releaseRule({ key: 'new-home-sales', names: ['New Home Sales'], name: 'New Home Sales', agency: 'Census', period: 'Annualized', impact: 'low' }),
  releaseRule({ key: 'trade-balance', names: ['Trade Balance'], name: 'Trade Balance', agency: 'Census', period: 'Monthly', impact: 'medium' }),
  releaseRule({ key: 'federal-budget', names: ['Federal Budget Balance'], name: 'Federal Budget Balance', agency: 'Treasury', period: 'Monthly', impact: 'low' }),
  releaseRule({ key: 'crude-oil-inventories', names: ['Crude Oil Inventories'], name: 'EIA Crude Oil Inventories', agency: 'EIA', period: 'Weekly', impact: 'low' }),
  releaseRule({ key: 'opec-meeting', names: ['OPEC Meeting'], name: 'OPEC Meeting', agency: 'OPEC', period: 'Policy', impact: 'medium' }),
  releaseRule({ key: 'fomc-minutes', names: ['FOMC Meeting Minutes'], name: 'FOMC Minutes', agency: 'Federal Reserve', period: 'Policy', impact: 'high' }),
  releaseRule({ key: 'fed-rate-decision', names: ['Fed Interest Rate Decision', 'FOMC Statement'], name: 'Federal Reserve Decision', agency: 'Federal Reserve', period: 'Policy', impact: 'high' })
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

function buildWeekAheadPreparationFallback(canonicalWeek, targetRange, { checkedAt = new Date() } = {}) {
  const timestamp = new Date(checkedAt).toISOString();
  const range = {
    ...targetRange,
    timeZone: TIME_ZONE,
    marketTimeZone: SOURCE_TIME_ZONE
  };
  const targetDates = displayDatesForRange(range);
  if (targetDates.length !== 5) throw new Error('Week Ahead fallback range must contain the five displayed dates.');
  const sameRange = canonicalWeek?.range?.from === range.from
    && canonicalWeek?.range?.to === range.to
    && Array.isArray(canonicalWeek?.days)
    && canonicalWeek.days.length === 5;
  if (sameRange) {
    const week = applyWeekAheadLifecycle(structuredClone(canonicalWeek), null, { now: new Date(timestamp) });
    if (week.source) delete week.source.timeInterpretation;
    week.availability = {
      status: 'carried_forward',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    };
    return { mode: 'carried_forward', week };
  }
  const week = {
    schemaVersion: SCHEMA_VERSION,
    range,
    generatedAt: timestamp,
    source: {
      provider: FX_MACRO_PROVIDER,
      endpoint: FX_MACRO_ENDPOINT,
      status: 'unavailable',
      fetchedAt: timestamp
    },
    officialSchedule: { events: [], authorities: [] },
    days: targetDates.map((date) => {
      const closureName = MARKET_CLOSURES[Number(date.slice(0, 4))]?.[date] || '';
      return {
        date,
        label: dayLabel(date),
        closure: closureName ? { label: 'U.S. Markets Closed', reason: closureName } : null,
        events: []
      };
    }),
    sourceSummary: {
      returnedEvents: 0,
      includedEvents: 0,
      officialScheduledEvents: 0,
      officialConflicts: 0,
      omittedRecognizedEvents: 0
    },
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    }
  };
  return { mode: 'unavailable', week };
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
  const actual = values?.actual || null;
  const forecast = values?.forecast || null;
  return {
    id: `${release.date}:${release.time}:${variant.key}`,
    time: release.time,
    name: rule.name,
    agency: rule.agency,
    period: variant.period,
    impact: rule.impact,
    actual,
    forecast,
    forecastType: values?.forecastType || null,
    forecastSource: values?.forecastSource || null,
    previous: values?.previous || null,
    scheduleSource: release.authorityName,
    valueSource: values ? 'FXMacroData' : null,
    verification: values ? 'official-schedule-fxmacrodata-values' : 'official-schedule-values-unavailable',
    surprise: comparableWeekAheadSurprise(actual, forecast)
  };
}

function comparableWeekAheadSurprise(actual, forecast) {
  const parse = (value) => String(value ?? '').trim().match(/^([+-]?\d+(?:\.\d+)?)(%|K|M|B|T)?$/);
  const actualMatch = parse(actual);
  const forecastMatch = parse(forecast);
  if (!actualMatch || !forecastMatch || (actualMatch[2] || '') !== (forecastMatch[2] || '')) return null;
  const delta = Math.round((Number(actualMatch[1]) - Number(forecastMatch[1])) * 10000) / 10000;
  return {
    direction: delta > 0 ? 'above' : delta < 0 ? 'below' : 'in_line',
    delta,
    unit: actualMatch[2] || 'number'
  };
}

function weekAheadReleaseInstant(date, time, sourceTimeZone = SOURCE_TIME_ZONE) {
  if (!isIsoDate(date) || !isIsoTime(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: sourceTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(utcGuess));
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  const observedAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), 0);
  return new Date(utcGuess - (observedAsUtc - utcGuess));
}

function weekAheadDayFingerprint(day) {
  return JSON.stringify((Array.isArray(day?.events) ? day.events : []).map((event) => [
    event.id,
    event.name,
    event.agency,
    event.period,
    event.impact,
    event.actual,
    event.forecast,
    event.previous,
    event.forecastType,
    event.forecastSource,
    event.scheduleSource,
    event.valueSource,
    event.verification
  ]));
}

function applyWeekAheadLifecycle(week, chartData = null, { now = new Date() } = {}) {
  const seriesByTicker = new Map((Array.isArray(chartData?.series) ? chartData.series : []).map((series) => [series.ticker, series]));
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: week?.range?.timeZone || TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const nowPart = (type) => nowParts.find((item) => item.type === type)?.value || '';
  const localNowDate = `${nowPart('year')}-${nowPart('month')}-${nowPart('day')}`;
  const days = (Array.isArray(week?.days) ? week.days : []).map((sourceDay) => {
    const day = { ...sourceDay };
    day.events = (Array.isArray(sourceDay.events) ? sourceDay.events : []).map((sourceEvent) => {
      const event = { ...sourceEvent };
      const releaseInstant = weekAheadReleaseInstant(day.date, event.time, week?.range?.marketTimeZone || SOURCE_TIME_ZONE);
      const hasActual = event.actual !== null && event.actual !== undefined && event.actual !== '';
      event.status = hasActual ? 'released' : releaseInstant && now >= releaseInstant ? 'awaiting_actual' : 'scheduled';
      event.surprise = comparableWeekAheadSurprise(event.actual, event.forecast);
      return event;
    });
    if (!day.events.length) {
      delete day.lifecycle;
      delete day.marketReaction;
      delete day.outcome;
      return day;
    }

    const released = day.events.some((event) => event.status === 'released');
    const reactionSpecs = Array.isArray(day.marketLens?.reactions) ? day.marketLens.reactions : [];
    // A populated event-day bar can arrive before the cash session is final.
    // Gate on the Eastern close itself so an afternoon run cannot publish an
    // incomplete bar as the deterministic closing response.
    const marketCloseInstant = weekAheadReleaseInstant(day.date, '16:00', week?.range?.marketTimeZone || SOURCE_TIME_ZONE);
    const canCalculateClose = day.date < localNowDate || (marketCloseInstant && now >= marketCloseInstant);
    const reactionRows = canCalculateClose && released ? reactionSpecs.flatMap((reaction) => {
      const series = seriesByTicker.get(reaction.ticker);
      const bars = Array.isArray(series?.bars) ? series.bars : [];
      const eventIndex = bars.findIndex((bar) => bar?.time === day.date);
      if (eventIndex < 1) return [];
      const current = bars[eventIndex];
      const previous = bars[eventIndex - 1];
      const close = Number(current.close);
      const previousClose = Number(previous.close);
      if (!Number.isFinite(close) || !Number.isFinite(previousClose)) return [];
      const delta = Math.round((close - previousClose) * 10000) / 10000;
      const percentChange = previousClose === 0 ? 0 : Math.round((delta / previousClose) * 1000000) / 10000;
      return [{
        ticker: reaction.ticker,
        role: reaction.role,
        asOf: day.date,
        close,
        previousClose,
        delta,
        percentChange,
        unit: series.unit || 'price',
        dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      }];
    }) : [];
    if (reactionSpecs.length && reactionRows.length === reactionSpecs.length) {
      const nextMarketReaction = {
        window: 'event-day-close-vs-previous-close',
        asOf: day.date,
        rows: reactionRows
      };
      if (day.outcome && JSON.stringify(sourceDay.marketReaction || null) !== JSON.stringify(nextMarketReaction)) delete day.outcome;
      day.marketReaction = nextMarketReaction;
      day.lifecycle = 'close_available';
    } else {
      delete day.marketReaction;
      day.lifecycle = released
        ? 'released_awaiting_close'
        : day.events.some((event) => event.status === 'awaiting_actual') ? 'awaiting_actual' : 'scheduled';
      delete day.outcome;
    }
    return day;
  });
  return { ...week, days };
}

function finalizeWeekAheadOutcomes(week, { now = new Date() } = {}) {
  void now;
  const days = (Array.isArray(week?.days) ? week.days : []).map((day) => {
    if (day?.lifecycle !== 'close_available') return day;
    if (day.outcome === undefined) return day;
    if (day.outcome?.status === undefined && day.outcome?.title?.trim() && day.outcome?.body?.trim()) {
      return { ...day, outcome: { ...day.outcome, status: 'verified' } };
    }
    if (day.outcome?.status === 'dropped_after_review'
      && day.outcome.source === 'editorial'
      && day.outcome.reason?.trim()
      && !String(day.outcome.title || '').trim()
      && !String(day.outcome.body || '').trim()) {
      return day;
    }
    return day;
  });
  return { ...week, days };
}

function ruleForEventId(id) {
  const variantKey = String(id || '').split(':').slice(3).join(':');
  return EVENT_RULES.find((rule) => variantKey === rule.key || variantKey.startsWith(`${rule.key}-`)) || null;
}

function defaultMarketLensForEvents(events) {
  if (!Array.isArray(events) || !events.length) return null;
  const impactWeight = { high: 3, medium: 2, low: 1 };
  const groups = new Map();
  for (const event of events) {
    const rule = ruleForEventId(event.id);
    if (!rule) continue;
    const group = groups.get(rule.lensPath) || { path: rule.lensPath, events: [] };
    group.events.push(event);
    groups.set(rule.lensPath, group);
  }
  const selected = [...groups.values()].sort((left, right) => {
    const leftImpact = Math.max(...left.events.map((event) => impactWeight[event.impact] || 0));
    const rightImpact = Math.max(...right.events.map((event) => impactWeight[event.impact] || 0));
    const leftTime = left.events.map((event) => event.time).sort()[0] || '';
    const rightTime = right.events.map((event) => event.time).sort()[0] || '';
    return rightImpact - leftImpact || leftTime.localeCompare(rightTime) || left.path.localeCompare(right.path);
  })[0];
  if (!selected) return null;
  const path = DEFAULT_MARKET_LENS_PATHS[selected.path];
  return {
    question: path.question,
    relatedEventIds: selected.events.map((event) => event.id).sort(),
    channels: [...path.channels],
    reactions: path.reactions.map((reaction) => ({ ...reaction })),
    title: path.title,
    body: path.body
  };
}

function droppedMarketLensForEvents(events) {
  const fallback = defaultMarketLensForEvents(events);
  if (!fallback) return null;
  return {
    ...fallback,
    title: '',
    body: ''
  };
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
  const failures = [
    ...(Array.isArray(officialSchedule.failures) ? officialSchedule.failures : []).map((failure) => ({
      source: `official_schedule:${failure.authority || 'unknown'}`,
      item: failure.authority || 'schedule',
      message: String(failure.message || 'Official schedule source unavailable.')
    })),
    ...(Array.isArray(valuePayload?.failures) ? valuePayload.failures : []).map((failure) => ({
      source: `fxmacro:${failure.kind || 'values'}`,
      item: failure.indicator || 'indicator',
      message: String(failure.message || 'Indicator values unavailable.')
    }))
  ];
  for (const release of officialEvents) {
    for (const key of release.keys) {
      const rule = ruleForKey(key);
      if (!rule) {
        failures.push({
          source: `official_schedule:${release.authority || 'unknown'}`,
          item: `${release.date}:${release.time}:${key}`,
          message: `Unknown event key ${key} was omitted.`
        });
        continue;
      }
      for (const variant of variantsForRule(rule)) {
        const values = valuesById.get(`${release.date}:${release.time}:${variant.key}`) || null;
        normalized.push({ ...officialEvent(release, rule, variant, values), date: release.date, sortMinutes: Number(release.time.slice(0, 2)) * 60 + Number(release.time.slice(3, 5)) });
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
      .map(({ date: _date, sortMinutes: _sortMinutes, ...event }) => event);
    const closureName = MARKET_CLOSURES[Number(date.slice(0, 4))]?.[date] || '';
    const day = {
      date,
      label: dayLabel(date),
      closure: closureName ? { label: 'U.S. Markets Closed', reason: closureName } : null,
      events
    };
    if (matchedEvents.length) {
      day.marketLens = defaultMarketLensForEvents(events);
      day.marketLensSource = 'generated';
    }
    return day;
  });

  const result = applyWeekAheadLifecycle({
    schemaVersion: SCHEMA_VERSION,
    range: { ...range, timeZone: TIME_ZONE, marketTimeZone: SOURCE_TIME_ZONE },
    generatedAt: now.toISOString(),
    source: {
      provider: FX_MACRO_PROVIDER,
      endpoint: FX_MACRO_ENDPOINT,
      status: failures.length ? 'partial' : 'fresh',
      fetchedAt: now.toISOString()
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
      omittedRecognizedEvents: failures.filter((failure) => /Unknown event key/.test(failure.message)).length,
      unavailableSources: failures.length
    },
    ...(failures.length ? {
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: now.toISOString(),
        failures
      }
    } : {})
  }, null, { now });
  const errors = validateWeekAheadPayload(result, { now });
  if (errors.length) throw new Error(`Normalized Week Ahead payload is invalid: ${errors.join(' ')}`);
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateMarketLens(lens, day, source, prefix = 'marketLens') {
  const errors = [];
  if (!isPlainObject(lens)) return [`${prefix} must be an object.`];
  if (Object.prototype.hasOwnProperty.call(lens, 'watchlist')) errors.push(`${prefix}.watchlist is deprecated; use reactions[].`);
  const requiredTextFields = source === 'dropped_after_review' ? ['question'] : ['question', 'title', 'body'];
  for (const field of requiredTextFields) {
    if (typeof lens[field] !== 'string' || !lens[field].trim()) errors.push(`${prefix}.${field} is required.`);
  }
  const dayEventIds = new Set((Array.isArray(day?.events) ? day.events : []).map((event) => event.id));
  if (!Array.isArray(lens.relatedEventIds) || !lens.relatedEventIds.length) {
    errors.push(`${prefix}.relatedEventIds must identify at least one release from the day.`);
  } else {
    const seen = new Set();
    for (const id of lens.relatedEventIds) {
      if (typeof id !== 'string' || !dayEventIds.has(id)) errors.push(`${prefix}.relatedEventIds contains an event outside the day.`);
      if (seen.has(id)) errors.push(`${prefix}.relatedEventIds must be unique.`);
      seen.add(id);
    }
  }
  if (!Array.isArray(lens.channels) || !lens.channels.length) {
    errors.push(`${prefix}.channels must contain at least one recognized transmission channel.`);
  } else {
    const seen = new Set();
    for (const channel of lens.channels) {
      if (!MARKET_LENS_CHANNELS.has(channel)) errors.push(`${prefix}.channels contains unknown channel ${channel}.`);
      if (seen.has(channel)) errors.push(`${prefix}.channels must be unique.`);
      seen.add(channel);
    }
    const relatedRules = (Array.isArray(lens.relatedEventIds) ? lens.relatedEventIds : []).map(ruleForEventId).filter(Boolean);
    const compatibleChannels = new Set(relatedRules.flatMap((rule) => DEFAULT_MARKET_LENS_PATHS[rule.lensPath]?.channels || []));
    for (const channel of lens.channels) {
      if (MARKET_LENS_CHANNELS.has(channel) && !compatibleChannels.has(channel)) errors.push(`${prefix}.channels contains ${channel}, which is not supported by its related releases.`);
    }
  }
  if (!Array.isArray(lens.reactions) || lens.reactions.length < 1 || lens.reactions.length > 3) {
    errors.push(`${prefix}.reactions must contain one to three Tape reactions.`);
  } else {
    const seen = new Set();
    const eligibleTickers = new Set((Array.isArray(lens.channels) ? lens.channels : []).flatMap((channel) => MARKET_LENS_REACTIONS_BY_CHANNEL[channel] || []));
    lens.reactions.forEach((reaction, index) => {
      const reactionPrefix = `${prefix}.reactions[${index}]`;
      if (!isPlainObject(reaction)) {
        errors.push(`${reactionPrefix} must be an object.`);
        return;
      }
      const ticker = String(reaction.ticker || '');
      if (!/^[A-Z0-9]+$/.test(ticker)) errors.push(`${reactionPrefix}.ticker must be a canonical uppercase Tape symbol.`);
      else if (!eligibleTickers.has(ticker)) errors.push(`${reactionPrefix}.ticker ${ticker} is not eligible for the selected transmission channels.`);
      if (seen.has(ticker)) errors.push(`${prefix}.reactions tickers must be unique.`);
      seen.add(ticker);
      if (typeof reaction.role !== 'string' || !reaction.role.trim()) errors.push(`${reactionPrefix}.role is required.`);
    });
  }
  if (source === 'editorial') {
    if (!isPlainObject(lens.setup) || typeof lens.setup.statement !== 'string' || !lens.setup.statement.trim() || !Array.isArray(lens.setup.evidence) || !lens.setup.evidence.length) {
      errors.push(`${prefix}.setup must contain a current statement and evidence references.`);
    } else {
      lens.setup.evidence.forEach((reference, index) => {
        const evidencePrefix = `${prefix}.setup.evidence[${index}]`;
        if (!isPlainObject(reference) || !['opening', 'tape', 'story'].includes(reference.kind)) {
          errors.push(`${evidencePrefix} must identify opening, tape, or story evidence.`);
        } else if (reference.kind === 'opening' && !['headline', 'deck'].includes(reference.field)) {
          errors.push(`${evidencePrefix}.field must be headline or deck.`);
        } else if (reference.kind === 'tape' && !/^[A-Z0-9]+$/.test(String(reference.ticker || ''))) {
          errors.push(`${evidencePrefix}.ticker must be a canonical uppercase Tape symbol.`);
        } else if (reference.kind === 'story' && (typeof reference.url !== 'string' || !reference.url.trim())) {
          errors.push(`${evidencePrefix}.url is required.`);
        }
      });
    }
    if (!isPlainObject(lens.scenarios) || typeof lens.scenarios.reinforces !== 'string' || !lens.scenarios.reinforces.trim() || typeof lens.scenarios.challenges !== 'string' || !lens.scenarios.challenges.trim()) {
      errors.push(`${prefix}.scenarios must explain both reinforcing and challenging outcomes.`);
    }
  } else if (source === 'generated') {
    if (lens.setup !== undefined || lens.scenarios !== undefined) errors.push(`${prefix} generated fallback must not claim current setup or scenario analysis.`);
    const expected = defaultMarketLensForEvents(day?.events);
    if (expected && !isDeepStrictEqual(lens, expected)) errors.push(`${prefix} generated fallback must match the canonical default transmission path.`);
  } else if (source === 'dropped_after_review') {
    if (lens.setup !== undefined || lens.scenarios !== undefined) errors.push(`${prefix} dropped commentary must not claim current setup or scenario analysis.`);
    const expected = droppedMarketLensForEvents(day?.events);
    if (expected && !isDeepStrictEqual(lens, expected)) errors.push(`${prefix} dropped commentary must retain only the deterministic transmission map.`);
  }
  return errors;
}

function validateWeekAheadPayload(payload, { now = null, requireOutcomeDisposition = false } = {}) {
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
  if (!isPlainObject(payload.source) || !['fresh', 'partial', 'cached', 'unavailable'].includes(payload.source.status)) errors.push('weekAhead.source.status must be fresh, partial, cached, or unavailable.');
  if (payload.source?.provider !== FX_MACRO_PROVIDER) errors.push(`weekAhead.source.provider must be ${FX_MACRO_PROVIDER}.`);
  if (payload.source?.endpoint !== FX_MACRO_ENDPOINT) errors.push('weekAhead.source.endpoint must identify the FXMacroData announcement and prediction endpoints.');
  if (!isIsoDateTime(payload.source?.fetchedAt)) errors.push('weekAhead.source.fetchedAt must be an offset-bearing ISO timestamp.');
  if (payload.availability !== undefined) {
    if (!isPlainObject(payload.availability)) {
      errors.push('weekAhead.availability must be an object.');
    } else {
      if (!['carried_forward', 'partial', 'unavailable'].includes(payload.availability.status)) errors.push('weekAhead.availability.status must be carried_forward, partial, or unavailable.');
      if (payload.availability.reason !== 'source_refresh_failed') errors.push('weekAhead.availability.reason must be source_refresh_failed.');
      if (!isIsoDateTime(payload.availability.checkedAt)) errors.push('weekAhead.availability.checkedAt must be an offset-bearing ISO timestamp.');
      if (payload.availability.failures !== undefined) {
        if (!Array.isArray(payload.availability.failures) || !payload.availability.failures.length) {
          errors.push('weekAhead.availability.failures must be a non-empty array when present.');
        } else {
          payload.availability.failures.forEach((failure, index) => {
            if (!isPlainObject(failure) || typeof failure.source !== 'string' || !failure.source.trim() || typeof failure.item !== 'string' || !failure.item.trim() || typeof failure.message !== 'string' || !failure.message.trim()) {
              errors.push(`weekAhead.availability.failures[${index}] must contain source, item, and message.`);
            }
          });
        }
      }
    }
  }
  if (payload.source?.status === 'unavailable' && payload.availability?.status !== 'unavailable') {
    errors.push('weekAhead.source.status unavailable requires weekAhead.availability.status unavailable.');
  }
  if (payload.source?.status !== 'unavailable' && payload.availability?.status === 'unavailable') {
    errors.push('weekAhead.availability.status unavailable requires weekAhead.source.status unavailable.');
  }
  if (payload.source?.status === 'partial' && payload.availability?.status !== 'partial') {
    errors.push('weekAhead.source.status partial requires weekAhead.availability.status partial.');
  }
  if (!isPlainObject(payload.officialSchedule) || !Array.isArray(payload.officialSchedule.events) || !Array.isArray(payload.officialSchedule.authorities)) {
    errors.push('weekAhead.officialSchedule must contain events and authorities.');
  }
  if (!Array.isArray(payload.days) || payload.days.length !== 5) {
    errors.push('weekAhead.days must contain exactly five weekdays.');
    return errors;
  }
  if (payload.availability?.status === 'unavailable') {
    if (payload.days.some((day) => Array.isArray(day?.events) && day.events.length)) errors.push('Unavailable Week Ahead fallback must contain no events.');
    if (payload.officialSchedule.events.length || payload.officialSchedule.authorities.length) errors.push('Unavailable Week Ahead fallback must contain no official schedule rows.');
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
    if (hasEvents && isPlainObject(day.marketLens)) errors.push(...validateMarketLens(day.marketLens, day, day.marketLensSource, `weekAhead.days[${dayIndex}].marketLens`));
    else if (hasEvents) errors.push(`weekAhead.days[${dayIndex}].marketLens is incomplete.`);
    if (!hasEvents && hasMarketLens) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens must be omitted when there are no events.`);
    }
    if (hasEvents && !['generated', 'editorial', 'dropped_after_review'].includes(day?.marketLensSource)) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensSource must be generated, editorial, or dropped_after_review.`);
    }
    if (!hasEvents && day?.marketLensSource !== undefined) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensSource must be omitted when there are no events.`);
    }
    if (day?.marketLensSource === 'dropped_after_review') {
      if (!['released_awaiting_close', 'close_available'].includes(day?.lifecycle)) {
        errors.push(`weekAhead.days[${dayIndex}].marketLensSource dropped_after_review is allowed only after a release.`);
      }
      if (day?.marketLensDisposition?.status !== 'dropped_after_review') {
        errors.push(`weekAhead.days[${dayIndex}].marketLensDisposition.status must be dropped_after_review.`);
      }
      if (!isIsoDateTime(day?.marketLensDisposition?.attemptedAt)) {
        errors.push(`weekAhead.days[${dayIndex}].marketLensDisposition.attemptedAt must be an offset-bearing ISO timestamp.`);
      }
      if (typeof day?.marketLensDisposition?.reason !== 'string' || !day.marketLensDisposition.reason.trim()) {
        errors.push(`weekAhead.days[${dayIndex}].marketLensDisposition.reason is required.`);
      }
    } else if (day?.marketLensDisposition !== undefined) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensDisposition is allowed only for dropped commentary.`);
    }
    if (hasEvents && !['scheduled', 'awaiting_actual', 'released_awaiting_close', 'close_available'].includes(day?.lifecycle)) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle is invalid.`);
    }
    const eventStatuses = new Set((day?.events || []).map((event) => event?.status));
    if (day?.lifecycle === 'scheduled' && (eventStatuses.size !== 1 || !eventStatuses.has('scheduled'))) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle scheduled requires every event to remain scheduled.`);
    }
    if (day?.lifecycle === 'awaiting_actual' && !eventStatuses.has('awaiting_actual')) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle awaiting_actual requires a passed event without an actual.`);
    }
    if (['released_awaiting_close', 'close_available'].includes(day?.lifecycle) && !eventStatuses.has('released')) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle ${day.lifecycle} requires at least one released event.`);
    }
    if (!hasEvents && (day?.lifecycle !== undefined || day?.marketReaction !== undefined || day?.outcome !== undefined)) {
      errors.push(`weekAhead.days[${dayIndex}] without events must omit lifecycle, marketReaction, and outcome.`);
    }
    if (day?.lifecycle === 'close_available') {
      const marketCloseInstant = weekAheadReleaseInstant(day.date, '16:00', payload.range?.marketTimeZone || SOURCE_TIME_ZONE);
      if (now instanceof Date && !Number.isNaN(now.getTime()) && marketCloseInstant && now < marketCloseInstant) {
        errors.push(`weekAhead.days[${dayIndex}].lifecycle close_available cannot precede the event-day market close.`);
      }
      if (!isPlainObject(day.marketReaction) || day.marketReaction.window !== 'event-day-close-vs-previous-close' || day.marketReaction.asOf !== day.date || !Array.isArray(day.marketReaction.rows) || !day.marketReaction.rows.length) {
        errors.push(`weekAhead.days[${dayIndex}].marketReaction must contain the event-day close reaction.`);
      } else {
        const expectedTickers = (day.marketLens?.reactions || []).map((reaction) => reaction.ticker);
        const reactionTickers = day.marketReaction.rows.map((row) => row?.ticker);
        if (!isDeepStrictEqual(reactionTickers, expectedTickers)) errors.push(`weekAhead.days[${dayIndex}].marketReaction rows must match the Market Lens reaction tickers.`);
        day.marketReaction.rows.forEach((row, rowIndex) => {
          const rowPrefix = `weekAhead.days[${dayIndex}].marketReaction.rows[${rowIndex}]`;
          const expectedReaction = day.marketLens.reactions[rowIndex];
          if (row?.role !== expectedReaction?.role) errors.push(`${rowPrefix}.role must match the Market Lens transmission role.`);
          if (row?.asOf !== day.date) errors.push(`${rowPrefix}.asOf must match the event day.`);
          if (!['price', 'percent_yield'].includes(row?.unit)) errors.push(`${rowPrefix}.unit is invalid.`);
          if (![row?.close, row?.previousClose, row?.delta, row?.percentChange].every(Number.isFinite)) errors.push(`${rowPrefix} close fields must be finite numbers.`);
          const expectedDelta = Math.round((Number(row.close) - Number(row.previousClose)) * 10000) / 10000;
          const expectedPercent = Number(row.previousClose) === 0 ? 0 : Math.round((expectedDelta / Number(row.previousClose)) * 1000000) / 10000;
          if (row?.delta !== expectedDelta || row?.percentChange !== expectedPercent) errors.push(`${rowPrefix} close changes must derive from close and previousClose.`);
          if (!['up', 'down', 'flat'].includes(row?.dir)) errors.push(`${rowPrefix}.dir is invalid.`);
          if (row?.dir !== (expectedDelta > 0 ? 'up' : expectedDelta < 0 ? 'down' : 'flat')) errors.push(`${rowPrefix}.dir must match the close change.`);
        });
      }
    } else if (day?.marketReaction !== undefined) {
      errors.push(`weekAhead.days[${dayIndex}].marketReaction is allowed only when lifecycle is close_available.`);
    }
    if (requireOutcomeDisposition && day?.lifecycle === 'close_available' && day?.outcome === undefined) {
      errors.push(`weekAhead.days[${dayIndex}].outcome requires a verified or dropped_after_review disposition before publication.`);
    }
    if (day?.outcome !== undefined) {
      if (day.lifecycle !== 'close_available') errors.push(`weekAhead.days[${dayIndex}].outcome is allowed only after the close reaction is available.`);
      if (!isPlainObject(day.outcome)) {
        errors.push(`weekAhead.days[${dayIndex}].outcome must be an object.`);
      } else {
        const legacyVerified = day.outcome.status === undefined && day.outcome.title?.trim() && day.outcome.body?.trim();
        const status = legacyVerified ? 'verified' : day.outcome.status;
        if (!WEEK_AHEAD_OUTCOME_STATUSES.has(status)) {
          errors.push(`weekAhead.days[${dayIndex}].outcome.status must be verified or dropped_after_review.`);
        } else if (status === 'verified') {
          if (typeof day.outcome.title !== 'string' || !day.outcome.title.trim() || typeof day.outcome.body !== 'string' || !day.outcome.body.trim() || day.outcome.source !== 'editorial') {
            errors.push(`weekAhead.days[${dayIndex}].outcome verified status requires editorial title and body text.`);
          }
        } else {
          if (String(day.outcome.title || '').trim() || String(day.outcome.body || '').trim()) {
            errors.push(`weekAhead.days[${dayIndex}].outcome dropped_after_review status must omit editorial copy.`);
          }
          if (day.outcome.source !== 'editorial') errors.push(`weekAhead.days[${dayIndex}].outcome.source must be editorial.`);
          if (typeof day.outcome.reason !== 'string' || !day.outcome.reason.trim()) errors.push(`weekAhead.days[${dayIndex}].outcome.reason is required when commentary is dropped.`);
          if (!isIsoDateTime(day.outcome.attemptedAt)) errors.push(`weekAhead.days[${dayIndex}].outcome.attemptedAt must be an offset-bearing ISO timestamp.`);
        }
      }
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
      if (!['scheduled', 'awaiting_actual', 'released'].includes(event.status)) errors.push(`${prefix}.status is invalid.`);
      const hasActual = event.actual !== null && event.actual !== undefined && event.actual !== '';
      if (hasActual !== (event.status === 'released')) errors.push(`${prefix}.status must agree with actual availability.`);
      if (hasActual && now instanceof Date && !Number.isNaN(now.getTime())) {
        const releaseInstant = weekAheadReleaseInstant(day.date, event.time, payload.range?.marketTimeZone || SOURCE_TIME_ZONE);
        if (releaseInstant && now < releaseInstant) errors.push(`${prefix}.actual cannot be available before its scheduled release time.`);
      }
      if (!hasActual && now instanceof Date && !Number.isNaN(now.getTime())) {
        const releaseInstant = weekAheadReleaseInstant(day.date, event.time, payload.range?.marketTimeZone || SOURCE_TIME_ZONE);
        const expectedStatus = releaseInstant && now >= releaseInstant ? 'awaiting_actual' : 'scheduled';
        if (event.status !== expectedStatus) errors.push(`${prefix}.status is stale for its scheduled release time.`);
      }
      if (!isDeepStrictEqual(event.surprise ?? null, comparableWeekAheadSurprise(event.actual, event.forecast))) {
        errors.push(`${prefix}.surprise must match comparable actual and forecast values.`);
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
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    payload.days.forEach((day, dayIndex) => {
      if (!Array.isArray(day?.events) || !day.events.length) return;
      const expectedLifecycle = day.marketReaction
        ? 'close_available'
        : day.events.some((event) => event.status === 'released')
          ? 'released_awaiting_close'
          : day.events.some((event) => event.status === 'awaiting_actual') ? 'awaiting_actual' : 'scheduled';
      if (day.lifecycle !== expectedLifecycle) errors.push(`weekAhead.days[${dayIndex}].lifecycle is stale for its event states.`);
    });
  }
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

function hasEditorialMarketLens(day) {
  return day?.marketLensSource === 'editorial'
    && validateMarketLens(day.marketLens, day, 'editorial').length === 0;
}

function preserveMissingWeekAheadValues(incomingEvent, priorEvent) {
  if (!priorEvent || incomingEvent?.id !== priorEvent.id) return incomingEvent;
  const next = { ...incomingEvent };
  const missing = (value) => value === null || value === undefined || value === '';
  let preserved = false;
  for (const field of ['actual', 'forecast', 'previous']) {
    if (missing(next[field]) && !missing(priorEvent[field])) {
      next[field] = priorEvent[field];
      preserved = true;
    }
  }
  if (missing(incomingEvent.forecast) && !missing(priorEvent.forecast)) {
    next.forecastType = priorEvent.forecastType ?? null;
    next.forecastSource = priorEvent.forecastSource ?? null;
  }
  if (preserved) {
    next.valueSource = next.valueSource || priorEvent.valueSource || FX_MACRO_PROVIDER;
    next.verification = next.verification === 'official-schedule-values-unavailable'
      ? priorEvent.verification || 'official-schedule-fxmacrodata-values'
      : next.verification;
    next.surprise = comparableWeekAheadSurprise(next.actual, next.forecast);
    if (!missing(next.actual)) next.status = 'released';
  }
  return next;
}

function mergeWeekAheadPayload(existingWeekAhead, payload) {
  const errors = validateWeekAheadPayload(payload);
  if (errors.length) throw new Error(`Generated Week Ahead payload is invalid: ${errors.join(' ')}`);
  const preservePriorValues = payload.availability?.status === 'partial';
  const priorEventsById = new Map(
    (Array.isArray(existingWeekAhead?.days) ? existingWeekAhead.days : [])
      .flatMap((day) => Array.isArray(day?.events) ? day.events : [])
      .filter((event) => typeof event?.id === 'string')
      .map((event) => [event.id, event])
  );
  const existingEditorialDays = new Map(
    (Array.isArray(existingWeekAhead?.days) ? existingWeekAhead.days : [])
      .filter((day) => typeof day?.date === 'string' && hasEditorialMarketLens(day))
      .map((day) => [day.date, day])
  );
  return {
    ...payload,
    days: payload.days.map((day) => {
      const next = {
        ...day,
        events: (Array.isArray(day.events) ? day.events : []).map((event) => (
          preservePriorValues
            ? preserveMissingWeekAheadValues(event, priorEventsById.get(event.id))
            : event
        ))
      };
      if (next.events.some((event) => event.status === 'released')
        && ['scheduled', 'awaiting_actual'].includes(next.lifecycle)) {
        next.lifecycle = 'released_awaiting_close';
      }
      const editorialDay = existingEditorialDays.get(day.date);
      const priorDay = (Array.isArray(existingWeekAhead?.days) ? existingWeekAhead.days : []).find((candidate) => candidate?.date === day.date);
      const deterministicValuesUnchanged = weekAheadDayFingerprint(priorDay) === weekAheadDayFingerprint(next);
      // An arriving actual advances lifecycle state but does not retire a
      // still-valid pre-close thesis; the completed close response does that.
      if (editorialDay && validateMarketLens(editorialDay.marketLens, next, 'editorial').length === 0) {
        next.marketLens = editorialDay.marketLens;
        next.marketLensSource = 'editorial';
      }
      // Post-close copy is bound to the complete deterministic fingerprint,
      // including the reaction bars, and must not survive corrected facts.
      if (deterministicValuesUnchanged && priorDay?.outcome) next.outcome = priorDay.outcome;
      if (deterministicValuesUnchanged && priorDay?.marketReaction) {
        next.marketReaction = priorDay.marketReaction;
        next.lifecycle = priorDay.lifecycle;
      }
      return next;
    })
  };
}

function normalizeMarketLensDecisions(weekAhead, payload, { validateEditorialReferences = () => [] } = {}) {
  const decisions = Array.isArray(payload) ? payload : payload?.decisions;
  const eventDays = (Array.isArray(weekAhead?.days) ? weekAhead.days : [])
    .filter((day) => Array.isArray(day.events) && day.events.length);
  const expectedDates = new Set(eventDays.map((day) => day.date));
  const accepted = new Map();
  const seenDates = new Set();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const date = String(decision?.date || '');
    if (!expectedDates.has(date) || seenDates.has(date)) continue;
    seenDates.add(date);
    const day = eventDays.find((item) => item.date === date);
    if (decision.action === 'retain-generated') {
      accepted.set(date, { date, action: 'retain-generated' });
      continue;
    }
    if (decision.action === 'dropped-after-review'
      && ['released_awaiting_close', 'close_available'].includes(day.lifecycle)
      && isIsoDateTime(decision.attemptedAt)
      && typeof decision.reason === 'string'
      && decision.reason.trim()) {
      accepted.set(date, {
        date,
        action: 'dropped-after-review',
        attemptedAt: decision.attemptedAt,
        reason: decision.reason
      });
      continue;
    }
    if (decision.action !== 'replace') continue;
    if (day.lifecycle === 'close_available'
      && !isDeepStrictEqual(decision.marketLens?.reactions || [], day.marketLens?.reactions || [])) continue;
    const lensErrors = validateMarketLens(decision.marketLens, day, 'editorial', `Market Lens decision for ${date}`);
    let referenceErrors = [];
    if (!lensErrors.length) {
      try {
        referenceErrors = validateEditorialReferences(decision.marketLens, day) || [];
      } catch (_error) {
        referenceErrors = ['Editorial references could not be validated.'];
      }
    }
    if (!lensErrors.length && !referenceErrors.length) accepted.set(date, decision);
  }
  return eventDays.map((day) => {
    if (accepted.has(day.date)) return accepted.get(day.date);
    if (day.lifecycle === 'close_available' && day.marketLensSource === 'editorial'
      && validateMarketLens(day.marketLens, day, 'editorial').length === 0) {
      return { date: day.date, action: 'replace', marketLens: day.marketLens };
    }
    return { date: day.date, action: 'retain-generated' };
  });
}

function applyMarketLensDecisions(weekAhead, payload, { validateEditorialReferences = () => [] } = {}) {
  const days = (Array.isArray(weekAhead?.days) ? weekAhead.days : []).map((day) => ({ ...day }));
  const eventDays = days.filter((day) => Array.isArray(day.events) && day.events.length);
  const decisions = normalizeMarketLensDecisions(weekAhead, payload, { validateEditorialReferences });
  const decisionByDate = new Map(decisions.map((decision) => [decision.date, decision]));
  for (const day of eventDays) {
    const decision = decisionByDate.get(day.date);
    if (decision.action === 'retain-generated') {
      const generatedLens = defaultMarketLensForEvents(day.events);
      day.marketLens = generatedLens;
      day.marketLensSource = 'generated';
      delete day.marketLensDisposition;
      continue;
    }
    if (decision.action === 'dropped-after-review') {
      const candidateLensRemainsValid = day.marketLensSource === 'editorial'
        || ['scheduled', 'awaiting_actual'].includes(day.lifecycle);
      if (candidateLensRemainsValid) {
        delete day.marketLensDisposition;
        continue;
      }
      day.marketLens = droppedMarketLensForEvents(day.events);
      day.marketLensSource = 'dropped_after_review';
      day.marketLensDisposition = {
        status: 'dropped_after_review',
        attemptedAt: decision.attemptedAt,
        reason: decision.reason
      };
      continue;
    }
    day.marketLens = decision.marketLens;
    day.marketLensSource = 'editorial';
    delete day.marketLensDisposition;
  }
  return { ...weekAhead, days };
}

module.exports = {
  DEFAULT_MARKET_LENS_PATHS,
  EVENT_RULES,
  FX_MACRO_ENDPOINT,
  FX_MACRO_PROVIDER,
  MARKET_CLOSURES,
  MARKET_LENS_CHANNELS,
  MARKET_LENS_REACTIONS_BY_CHANNEL,
  SCHEMA_VERSION,
  SOURCE_TIME_ZONE,
  TIME_ZONE,
  addDays,
  applyWeekAheadLifecycle,
  applyMarketLensDecisions,
  buildWeekAheadPreparationFallback,
  comparableWeekAheadSurprise,
  defaultMarketLensForEvents,
  displayDatesForRange,
  finalizeWeekAheadOutcomes,
  formatFxMacroValue,
  fxMacroValueRequests,
  mondayForDate,
  mergeWeekAheadPayload,
  normalizeMarketLensDecisions,
  normalizeWeekAhead,
  rangeForDate,
  validateMarketLens,
  validateWeekAheadPayload,
  weekAheadDayFingerprint,
  weekAheadReleaseInstant
};
