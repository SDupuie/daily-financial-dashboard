const { isDeepStrictEqual } = require('util');
const TIME_ZONE = 'America/Chicago';
const SOURCE_TIME_ZONE = 'America/New_York';
const SCHEMA_VERSION = 4;
// These source labels are serialized into the dashboard, so they are contract
// constants rather than display copy that a fetcher or cache may freely alter.
const FX_MACRO_PROVIDER = 'FXMacroData';
const FX_MACRO_ENDPOINT = '/v1/announcements/{currency}/{indicator} + /v1/predictions/{currency}/{indicator}';
const {
  addDays,
  displayDatesForRange: calendarDisplayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isIsoTime,
  zonedTimeToUtc
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
  releaseRule({ key: 'average-hourly-earnings', names: ['Average Hourly Earnings'], name: 'Average Hourly Earnings', agency: 'BLS', period: 'YoY', impact: 'high' }),
  releaseRule({ key: 'adp-employment', names: ['ADP Employment Change'], name: 'ADP Employment Change', agency: 'ADP', period: 'Monthly', impact: 'medium' }),
  releaseRule({ key: 'jobless-claims', names: ['Initial Jobless Claims'], name: 'Initial Jobless Claims', agency: 'DOL', period: 'Weekly', impact: 'medium' }),
  releaseRule({ key: 'jolts', names: ['JOLTs Job Openings', 'JOLTS Job Openings'], name: 'JOLTS Job Openings', agency: 'BLS', period: 'Monthly', impact: 'medium' }),
  releaseRule({ key: 'retail-sales', names: ['Retail Sales'], name: 'Retail Sales', agency: 'Census', period: 'MoM', impact: 'high' }),
  releaseRule({ key: 'core-retail-sales', names: ['Core Retail Sales'], name: 'Core Retail Sales', agency: 'Census', period: 'MoM', impact: 'medium' }),
  releaseRule({
    key: 'gdp', names: ['GDP Growth Rate', 'GDP Price Index'], name: 'Gross Domestic Product', agency: 'BEA', impact: 'high',
    variants: [{ key: 'level', period: 'Level' }, { key: 'growth', period: 'QoQ SAAR' }]
  }),
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
  releaseRule({ key: 'trade-balance', names: ['Trade Balance'], name: 'Trade Balance', agency: 'BEA', period: 'Monthly', impact: 'medium' }),
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
    if (week.source) {
      delete week.source.timeInterpretation;
      week.source.status = 'cached';
    }
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
  'average-hourly-earnings': { announcementIndicator: 'average_hourly_earnings', predictionIndicator: 'average_hourly_earnings', field: 'val', unit: 'percent' },
  'jobless-claims': { announcementIndicator: 'initial_jobless_claims', predictionIndicator: 'initial_jobless_claims', field: 'val', unit: 'thousands' },
  jolts: { announcementIndicator: 'job_openings', predictionIndicator: 'job_openings', field: 'val', unit: 'thousandsAsMillions' },
  'retail-sales': { announcementIndicator: 'retail_sales', predictionIndicator: 'retail_sales', field: 'val', unit: 'percent' },
  'gdp-level': { announcementIndicator: 'gdp', predictionIndicator: 'gdp', field: 'val', unit: 'usdBillions' },
  'gdp-growth': { announcementIndicator: 'gdp_growth_qoq_saar', predictionIndicator: 'gdp_growth_qoq_saar', field: 'val', unit: 'percent' },
  'durable-goods': { announcementIndicator: 'durable_goods_orders', predictionIndicator: 'durable_goods_orders', field: 'val', unit: 'percent' },
  'housing-starts': { announcementIndicator: 'housing_starts', predictionIndicator: 'housing_starts', field: 'val', unit: 'millions' },
  'building-permits': { announcementIndicator: 'building_permits', predictionIndicator: 'building_permits', field: 'val', unit: 'millions' },
  'trade-balance': { announcementIndicator: 'trade_balance', predictionIndicator: 'trade_balance', field: 'val', unit: 'usdMillions' },
  'fed-rate-decision': { announcementIndicator: 'policy_rate_midpoint', predictionIndicator: 'policy_rate_midpoint', field: 'val', unit: 'percent' }
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
  if (unit === 'thousandsAsMillions') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const label = numberLabel(numeric / 1000, 1);
    return label === null ? null : `${label}M`;
  }
  if (unit === 'usdBillions') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const absolute = Math.abs(numeric);
    const label = absolute >= 1000 ? numberLabel(absolute / 1000, 2) : numberLabel(absolute, 1);
    if (label === null) return null;
    return `${numeric < 0 ? '-' : ''}$${label}${absolute >= 1000 ? 'T' : 'B'}`;
  }
  if (unit === 'usdMillions') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const absolute = Math.abs(numeric);
    const label = absolute >= 1000 ? numberLabel(absolute / 1000, 1) : numberLabel(absolute, 0);
    if (label === null) return null;
    return `${numeric < 0 ? '-' : ''}$${label}${absolute >= 1000 ? 'B' : 'M'}`;
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
  return zonedTimeToUtc({ year, month, day, hour, minute }, sourceTimeZone);
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
      if (hasActual && releaseInstant && now < releaseInstant) event.actual = null;
      const hasReleasedActual = event.actual !== null && event.actual !== undefined && event.actual !== '';
      event.status = hasReleasedActual ? 'released' : releaseInstant && now >= releaseInstant ? 'awaiting_actual' : 'scheduled';
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
  const attemptedAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const days = (Array.isArray(week?.days) ? week.days : []).map((day) => {
    const next = { ...day };
    const hasEvents = Array.isArray(next.events) && next.events.length;
    if (hasEvents && validateMarketLens(next.marketLens).length) {
      if (['released_awaiting_close', 'close_available'].includes(next.lifecycle)) {
        next.marketLens = unavailableMarketLensForEvents(next.events);
        next.marketLensSource = 'unavailable';
        next.marketLensDisposition = {
          status: 'commentary_unavailable',
          attemptedAt,
          reason: 'editorial_commentary_unavailable'
        };
      } else {
        next.marketLens = defaultMarketLensForEvents(next.events);
        next.marketLensSource = 'generated';
        delete next.marketLensDisposition;
      }
    }
    if (next?.lifecycle !== 'close_available') return next;
    if (next.outcome === undefined) {
      next.outcome = {
        status: 'pending_review'
      };
      return next;
    }
    if (next.outcome?.status === undefined && next.outcome?.title?.trim() && next.outcome?.body?.trim()) {
      return { ...next, outcome: { ...next.outcome, status: 'verified' } };
    }
    if (next.outcome?.status === 'pending_review') {
      next.outcome = { status: 'pending_review' };
      return next;
    }
    next.outcome = {
      status: 'pending_review'
    };
    return next;
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

function unavailableMarketLensForEvents(events) {
  const fallback = defaultMarketLensForEvents(events);
  if (!fallback) return null;
  return {
    ...fallback,
    question: 'What changed after the release?',
    title: 'Current release commentary unavailable',
    body: 'The release has arrived, but current interpretation could not be verified for this update. The listed assets remain the reaction reference points.'
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

function validateMarketLens(lens, prefix = 'marketLens') {
  const errors = [];
  if (!isPlainObject(lens)) return [`${prefix} must be an object.`];
  if (Array.isArray(lens.reactions)) {
    lens.reactions.forEach((reaction, index) => {
      const reactionPrefix = `${prefix}.reactions[${index}]`;
      if (!isPlainObject(reaction)) {
        errors.push(`${reactionPrefix} must be an object.`);
        return;
      }
      const ticker = String(reaction.ticker || '');
      if (!/^[A-Z0-9]+$/.test(ticker)) errors.push(`${reactionPrefix}.ticker must be a canonical uppercase Tape symbol.`);
    });
  }
  return errors;
}

function validateWeekAheadPayload(payload, { now = null, requireOutcomeDisposition = false } = {}) {
  const errors = [];
  if (!isPlainObject(payload)) return ['weekAhead must be an object.'];
  const displayDates = displayDatesForRange(payload.range);
  if (!isPlainObject(payload.range) || !isIsoDate(payload.range.from) || !isIsoDate(payload.range.to)) {
    errors.push('weekAhead.range must contain ISO from/to dates.');
  } else if (displayDates.length !== 5) {
    errors.push('weekAhead.range must cover Monday-Friday or Friday plus next Monday-Thursday.');
  }
  if (payload.range?.timeZone !== TIME_ZONE) errors.push(`weekAhead.range.timeZone must be ${TIME_ZONE}.`);
  if (payload.range?.marketTimeZone !== SOURCE_TIME_ZONE) errors.push(`weekAhead.range.marketTimeZone must be ${SOURCE_TIME_ZONE}.`);
  if (payload.source !== undefined && (!isPlainObject(payload.source) || !['fresh', 'partial', 'cached', 'unavailable'].includes(payload.source.status))) errors.push('weekAhead.source.status must be fresh, partial, cached, or unavailable.');
  if (payload.availability !== undefined) {
    if (!isPlainObject(payload.availability)) {
      errors.push('weekAhead.availability must be an object.');
    } else {
      if (!['carried_forward', 'partial', 'unavailable'].includes(payload.availability.status)) errors.push('weekAhead.availability.status must be carried_forward, partial, or unavailable.');
      if (payload.availability.reason !== 'source_refresh_failed') errors.push('weekAhead.availability.reason must be source_refresh_failed.');
      if (!isIsoDateTime(payload.availability.checkedAt)) errors.push('weekAhead.availability.checkedAt must be an offset-bearing ISO timestamp.');
      if (payload.availability.status === 'partial' && (!Array.isArray(payload.availability.failures) || !payload.availability.failures.length)) errors.push('weekAhead.availability.failures must be a non-empty array when partial.');
      if (payload.availability.status !== 'partial' && payload.availability.failures !== undefined) errors.push('weekAhead.availability.failures is allowed only when partial.');
      if (Array.isArray(payload.availability.failures)) {
        payload.availability.failures.forEach((failure, index) => {
          for (const field of ['source', 'item', 'message']) {
            if (typeof failure?.[field] !== 'string' || !failure[field].trim()) errors.push(`weekAhead.availability.failures[${index}].${field} must be populated.`);
          }
        });
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
  if (payload.availability?.status === 'partial' && payload.source?.status !== 'partial') {
    errors.push('weekAhead.availability.status partial requires weekAhead.source.status partial.');
  }
  if (payload.source?.status === 'cached' && payload.availability?.status !== 'carried_forward') {
    errors.push('weekAhead.source.status cached requires weekAhead.availability.status carried_forward.');
  }
  if (payload.availability?.status === 'carried_forward' && payload.source?.status !== 'cached') {
    errors.push('weekAhead.availability.status carried_forward requires weekAhead.source.status cached.');
  }
  if (!Array.isArray(payload.days) || payload.days.length !== 5) {
    errors.push('weekAhead.days must contain exactly five weekdays.');
    return errors;
  }
  if (payload.availability?.status === 'unavailable') {
    if (payload.days.some((day) => Array.isArray(day?.events) && day.events.length)) errors.push('Unavailable Week Ahead fallback must contain no events.');
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
    if (hasEvents && isPlainObject(day.marketLens)) errors.push(...validateMarketLens(day.marketLens, `weekAhead.days[${dayIndex}].marketLens`));
    if (!hasEvents && hasMarketLens) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens must be omitted when there are no events.`);
    }
    if (hasEvents && day?.marketLensSource !== undefined && !['generated', 'editorial', 'unavailable'].includes(day?.marketLensSource)) {
      errors.push(`weekAhead.days[${dayIndex}].marketLensSource must be generated, editorial, or unavailable.`);
    }
    if (day?.marketLensSource === 'unavailable') {
      if (day?.marketLensDisposition !== undefined && day?.marketLensDisposition?.status !== 'commentary_unavailable') {
        errors.push(`weekAhead.days[${dayIndex}].marketLensDisposition.status must be commentary_unavailable.`);
      }
    }
    if (hasEvents && !['scheduled', 'awaiting_actual', 'released_awaiting_close', 'close_available'].includes(day?.lifecycle)) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle is invalid.`);
    }
    if (!hasEvents && (day?.lifecycle !== undefined || day?.marketReaction !== undefined || day?.outcome !== undefined)) {
      errors.push(`weekAhead.days[${dayIndex}] without events must omit lifecycle, marketReaction, and outcome.`);
    }
    if (day?.lifecycle === 'close_available') {
      const marketCloseInstant = weekAheadReleaseInstant(day.date, '16:00', payload.range?.marketTimeZone || SOURCE_TIME_ZONE);
      if (now instanceof Date && !Number.isNaN(now.getTime()) && marketCloseInstant && now < marketCloseInstant) {
        errors.push(`weekAhead.days[${dayIndex}].lifecycle close_available cannot precede the event-day market close.`);
      }
    }
    if (requireOutcomeDisposition && day?.lifecycle === 'close_available' && day?.outcome === undefined) {
      errors.push(`weekAhead.days[${dayIndex}].outcome requires an outcome disposition before publication.`);
    }
    if (day?.outcome !== undefined) {
      if (!isPlainObject(day.outcome)) {
        errors.push(`weekAhead.days[${dayIndex}].outcome must be an object.`);
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
      if (![null, 'consensus', 'nowcast', 'model'].includes(event.forecastType)) errors.push(`${prefix}.forecastType is invalid.`);
      if (event.valueSource !== null && typeof event.valueSource !== 'string') errors.push(`${prefix}.valueSource must be string or null.`);
    });
  });
  void ids;
  return errors;
}

function hasEditorialMarketLens(day) {
  return day?.marketLensSource === 'editorial'
    && validateMarketLens(day.marketLens).length === 0;
}

function preserveMissingWeekAheadValues(incomingEvent, priorEvent) {
  // Only partial source refreshes use this path, and stable event identity keeps
  // prior values from leaking into a different release after a schedule change.
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
      if (editorialDay && validateMarketLens(editorialDay.marketLens).length === 0) {
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
    if (decision.action === 'pending_review') continue;
    if (decision.action === 'retain-generated') {
      accepted.set(date, { date, action: 'retain-generated' });
      continue;
    }
    if (decision.action === 'commentary-unavailable'
      && ['released_awaiting_close', 'close_available'].includes(day.lifecycle)
      && isIsoDateTime(decision.attemptedAt)
      && typeof decision.reason === 'string'
      && decision.reason.trim()) {
      accepted.set(date, {
        date,
        action: 'commentary-unavailable',
        attemptedAt: decision.attemptedAt,
        reason: decision.reason
      });
      continue;
    }
    if (decision.action !== 'replace') continue;
    if (day.lifecycle === 'close_available'
      && !isDeepStrictEqual(decision.marketLens?.reactions || [], day.marketLens?.reactions || [])) continue;
    const lensErrors = validateMarketLens(decision.marketLens, `Market Lens decision for ${date}`);
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
      && validateMarketLens(day.marketLens).length === 0) {
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
    if (decision.action === 'commentary-unavailable') {
      day.marketLens = unavailableMarketLensForEvents(day.events);
      day.marketLensSource = 'unavailable';
      day.marketLensDisposition = {
        status: 'commentary_unavailable',
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
