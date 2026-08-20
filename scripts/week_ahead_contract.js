const TIME_ZONE = 'America/Chicago';
const SOURCE_TIME_ZONE = 'America/New_York';
const SCHEMA_VERSION = 6;
const TRADINGVIEW_PROVIDER = 'TradingView Economic Calendar';
const TRADINGVIEW_ENDPOINT = 'https://economic-calendar.tradingview.com/events';
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

// Setup lenses deliberately describe ordinary transmission only. Current
// market claims belong in verified editorial copy.
const MARKET_LENS_TEMPLATES = {
  'consumer-inflation': {
    question: 'Will consumer inflation change the expected policy path?',
    title: 'Consumer inflation tests the rate path',
    body: 'The price data will show whether consumer inflation is changing expectations for the Fed\'s next steps. Short rates and the dollar provide the clearest initial reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'UUP', role: 'Dollar-policy reaction' }
    ]
  },
  'producer-inflation': {
    question: 'Are producer costs reinforcing broader inflation pressure?',
    title: 'Producer costs test the inflation signal',
    body: 'The producer-price data will show whether pipeline costs are reinforcing broader inflation pressure. The Treasury curve provides the cleanest initial reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'UST10Y', role: 'Broader inflation-rate reaction' }
    ]
  },
  labor: {
    question: 'Is labor demand changing the balance between inflation and growth?',
    title: 'Labor tests the growth-inflation balance',
    body: 'The labor data will show whether employment conditions are changing the balance between wage pressure and growth risk. Short rates and broad equities provide the clearest reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' },
      { ticker: 'SPX', role: 'Broad growth reaction' }
    ]
  },
  'consumer-demand': {
    question: 'Is household demand strong enough to affect growth and rates?',
    title: 'Household demand tests growth',
    body: 'The consumer data will show whether household demand is sustaining growth strongly enough to affect rates. Discretionary equities and long yields provide the clearest reaction.',
    reactions: [
      { ticker: 'VCR', role: 'Consumer-demand reaction' },
      { ticker: 'UST10Y', role: 'Growth-rate reaction' }
    ]
  },
  'broad-growth': {
    question: 'Is broad economic growth changing the market outlook?',
    title: 'Growth resets the broad outlook',
    body: 'The growth data will test whether the economy is changing the outlook for earnings and rates. Broad equities and long yields provide the clearest reaction.',
    reactions: [
      { ticker: 'SPX', role: 'Broad earnings reaction' },
      { ticker: 'UST10Y', role: 'Growth-rate reaction' }
    ]
  },
  manufacturing: {
    question: 'Is industrial momentum broadening or weakening?',
    title: 'Industry tests the cyclical pulse',
    body: 'The factory data will show whether industrial momentum is broadening or weakening. Industrials and copper provide the clearest cyclical reaction.',
    reactions: [
      { ticker: 'VIS', role: 'Industrial-equity reaction' },
      { ticker: 'HG', role: 'Materials-demand reaction' }
    ]
  },
  services: {
    question: 'Is services activity sustaining growth and price pressure?',
    title: 'Services test growth and price pressure',
    body: 'The services data will show whether activity is sustaining both growth and price pressure. Broad equities and short rates provide the clearest reaction.',
    reactions: [
      { ticker: 'SPX', role: 'Broad growth reaction' },
      { ticker: 'UST2Y', role: 'Expected-policy-path reaction' }
    ]
  },
  housing: {
    question: 'Are financing costs restraining housing activity?',
    title: 'Housing tests the mortgage-rate drag',
    body: 'The housing data will show whether financing costs are restraining activity and supply. Long yields and rate-sensitive real estate provide the clearest reaction.',
    reactions: [
      { ticker: 'UST10Y', role: 'Mortgage-rate reaction' },
      { ticker: 'VNQ', role: 'Rate-sensitive real-estate reaction' }
    ]
  },
  policy: {
    question: 'Has the expected rate path changed?',
    title: 'The expected rate path is the test',
    body: 'The policy communication matters if it changes expectations for the Fed\'s next steps. The front and long ends of the Treasury curve provide the clearest reaction.',
    reactions: [
      { ticker: 'UST2Y', role: 'Near-term policy reaction' },
      { ticker: 'UST10Y', role: 'Longer-term policy reaction' }
    ]
  },
  energy: {
    question: 'Are supply conditions tightening or easing the crude balance?',
    title: 'Supply tests the crude balance',
    body: 'The supply data will show whether oil conditions are tightening or easing. Crude and energy equities provide the clearest reaction.',
    reactions: [
      { ticker: 'CL', role: 'Underlying crude-balance reaction' },
      { ticker: 'VDE', role: 'Energy-equity reaction' }
    ]
  },
  external: {
    question: 'Is the external balance changing the dollar backdrop?',
    title: 'Trade tests the dollar backdrop',
    body: 'The trade data will show whether the external balance is changing the currency backdrop. The dollar provides the most direct dashboard reaction.',
    reactions: [{ ticker: 'UUP', role: 'Dollar reaction' }]
  },
  fiscal: {
    question: 'Is the fiscal position changing Treasury financing pressure?',
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
  'gdp-price-index': 'consumer-inflation',
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

function releaseRule({ key, match, name, agency }) {
  const lensPath = DEFAULT_PATH_BY_EVENT[key];
  if (!MARKET_LENS_TEMPLATES[lensPath]) throw new Error(`Missing Market Lens template for ${key}.`);
  return { key, match, name, agency, lensPath };
}

const EVENT_RULES = [
  // These rules canonicalize familiar families and Market Lens templates. They
  // do not decide inclusion or impact; TradingView owns both of those facts.
  releaseRule({ key: 'core-cpi', match: /core (?:consumer price index|cpi)/i, name: 'Core Consumer Price Index', agency: 'BLS' }),
  releaseRule({ key: 'cpi', match: /(?:consumer price index|\bcpi\b)/i, name: 'Consumer Price Index', agency: 'BLS' }),
  releaseRule({ key: 'core-ppi', match: /core (?:producer price index|ppi)/i, name: 'Core Producer Price Index', agency: 'BLS' }),
  releaseRule({ key: 'ppi', match: /(?:producer price index|\bppi\b)/i, name: 'Producer Price Index', agency: 'BLS' }),
  releaseRule({ key: 'core-pce', match: /core pce/i, name: 'Core PCE Price Index', agency: 'BEA' }),
  releaseRule({ key: 'pce', match: /\bpce (?:price|prices)/i, name: 'PCE Price Index', agency: 'BEA' }),
  releaseRule({ key: 'nonfarm-payrolls', match: /nonfarm payroll/i, name: 'Nonfarm Payrolls', agency: 'BLS' }),
  releaseRule({ key: 'unemployment-rate', match: /unemployment rate/i, name: 'Unemployment Rate', agency: 'BLS' }),
  releaseRule({ key: 'average-hourly-earnings', match: /average hourly earnings/i, name: 'Average Hourly Earnings', agency: 'BLS' }),
  releaseRule({ key: 'adp-employment', match: /\badp employment/i, name: 'ADP Employment Change', agency: 'ADP' }),
  releaseRule({ key: 'jobless-claims', match: /initial jobless claims/i, name: 'Initial Jobless Claims', agency: 'DOL' }),
  releaseRule({ key: 'jolts', match: /jolts.*job openings|job openings.*jolts/i, name: 'JOLTS Job Openings', agency: 'BLS' }),
  releaseRule({ key: 'core-retail-sales', match: /retail sales.*(?:ex autos|excluding autos|control group)/i, name: 'Core Retail Sales', agency: 'Census' }),
  releaseRule({ key: 'retail-sales', match: /\bretail sales\b/i, name: 'Retail Sales', agency: 'Census' }),
  releaseRule({ key: 'gdp-price-index', match: /\bgdp price index\b/i, name: 'GDP Price Index', agency: 'BEA' }),
  releaseRule({ key: 'gdp', match: /\bgdp (?:growth|price|sales)/i, name: 'Gross Domestic Product', agency: 'BEA' }),
  releaseRule({ key: 'durable-goods', match: /durable goods orders ex transp/i, name: 'Core Durable Goods Orders', agency: 'Census' }),
  releaseRule({ key: 'durable-goods', match: /durable goods orders/i, name: 'Durable Goods Orders', agency: 'Census' }),
  releaseRule({ key: 'industrial-production', match: /industrial production/i, name: 'Industrial Production', agency: 'Federal Reserve' }),
  releaseRule({ key: 'factory-orders', match: /factory orders/i, name: 'Factory Orders', agency: 'Census' }),
  releaseRule({ key: 'ism-manufacturing', match: /manufacturing pmi|manufacturing index/i, name: null, agency: null }),
  releaseRule({ key: 'ism-services', match: /services pmi|non-manufacturing pmi/i, name: null, agency: null }),
  releaseRule({ key: 'consumer-confidence', match: /consumer confidence/i, name: 'Consumer Confidence', agency: null }),
  releaseRule({ key: 'michigan-sentiment', match: /michigan consumer sentiment/i, name: 'University of Michigan Sentiment', agency: 'University of Michigan' }),
  releaseRule({ key: 'housing-starts', match: /housing starts/i, name: 'Housing Starts', agency: 'Census' }),
  releaseRule({ key: 'building-permits', match: /building permits/i, name: 'Building Permits', agency: 'Census' }),
  releaseRule({ key: 'existing-home-sales', match: /existing home sales/i, name: 'Existing Home Sales', agency: 'NAR' }),
  releaseRule({ key: 'new-home-sales', match: /new home sales/i, name: 'New Home Sales', agency: 'Census' }),
  releaseRule({ key: 'trade-balance', match: /trade balance/i, name: 'Trade Balance', agency: null }),
  releaseRule({ key: 'federal-budget', match: /federal budget|government budget/i, name: 'Federal Budget Balance', agency: 'Treasury' }),
  releaseRule({ key: 'crude-oil-inventories', match: /(?:eia|api).*?(?:crude oil|oil stock)/i, name: null, agency: null }),
  releaseRule({ key: 'opec-meeting', match: /\bopec\b/i, name: null, agency: 'OPEC' }),
  releaseRule({ key: 'fomc-minutes', match: /fomc.*minutes|fed.*minutes/i, name: 'FOMC Minutes', agency: 'Federal Reserve' }),
  releaseRule({ key: 'fed-rate-decision', match: /fed (?:interest )?rate decision|fomc statement|fed press conference|federal reserve.*(?:speech|speaks|testimony)/i, name: null, agency: 'Federal Reserve' }),
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
    // Same-range carry-forward keeps the event slate but reruns lifecycle so
    // released/awaiting-close states remain current for the publication time.
    const week = applyWeekAheadLifecycle(structuredClone(canonicalWeek), null, { now: new Date(timestamp) });
    if (week.source) {
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
      provider: TRADINGVIEW_PROVIDER,
      endpoint: TRADINGVIEW_ENDPOINT,
      status: 'unavailable',
      fetchedAt: timestamp
    },
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
      highImpactEvents: 0,
      mediumImpactEvents: 0,
      omittedLowImpactEvents: 0
    },
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    }
  };
  return { mode: 'unavailable', week };
}

function numberLabel(value, maximumFractionDigits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(numeric);
}

function formatTradingViewValue(value, row) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value).trim() || null;
  const title = String(row?.title || '');
  const unit = String(row?.unit || '').trim()
    || (/\b(?:MoM|YoY|QoQ|WoW)\b|mortgage rate/i.test(title) ? '%' : '');
  const scale = String(row?.scale || '').trim()
    || (/(?:crude oil|gasoline|distillate|heating oil) stocks? change/i.test(title) ? 'M' : '');
  if (unit === '%') {
    const label = numberLabel(numeric, 3);
    return label === null ? null : `${label}%`;
  }
  if (unit === '$') {
    const absolute = Math.abs(numeric);
    const label = numberLabel(absolute, 3);
    if (label === null) return null;
    return `${numeric < 0 ? '-' : ''}$${label}${scale}`;
  }
  const label = numberLabel(numeric, 3);
  return label === null ? null : `${label}${scale}`;
}

function canonicalAgency(row, rule) {
  if (rule?.agency) return rule.agency;
  const source = String(row?.source || '').trim();
  if (/bureau of (?:labou?r )?statistics/i.test(source)) return 'BLS';
  if (/bureau of economic(?:s)? analysis/i.test(source)) return 'BEA';
  if (/census bureau/i.test(source)) return 'Census';
  if (/department of labou?r/i.test(source)) return 'DOL';
  if (/energy information administration/i.test(source)) return 'EIA';
  if (/automatic data processing/i.test(source)) return 'ADP';
  if (/institute for supply management/i.test(source)) return 'ISM';
  if (/federal reserve bank of dallas/i.test(source)) return 'Dallas Fed';
  if (/federal reserve bank of richmond/i.test(source)) return 'Richmond Fed';
  if (/federal reserve/i.test(source)) return 'Federal Reserve';
  if (source) return source;
  if (/consumer confidence/i.test(String(row?.title || ''))) return 'Conference Board';
  return 'Economic calendar';
}

function eventRule(row) {
  const haystack = `${row?.title || ''} ${row?.indicator || ''}`;
  return EVENT_RULES.find((rule) => rule.match?.test(haystack)) || null;
}

function canonicalTitle(row, rule) {
  if (rule?.name) return rule.name;
  return String(row?.title || row?.indicator || 'Economic Event')
    .replace(/\s+(?:MoM|YoY|QoQ|WoW)(?:\s+(?:Adv|Prel|Final|Flash))?$/i, '')
    .replace(/\s+(?:Adv|Prel|Final|Flash)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventPeriod(row) {
  const title = String(row?.title || '');
  const measure = title.match(/\b(MoM|YoY|QoQ|WoW)\b/i)?.[1];
  if (measure) return measure[0].toUpperCase() + measure.slice(1);
  if (/weekly|jobless claims|eia |api crude/i.test(title)) return 'Weekly';
  if (/press conference|speech|speaks|testimony|minutes|meeting/i.test(title)) return 'Policy';
  if (/rate decision/i.test(title)) return 'Policy';
  if (/pmi|index|confidence|sentiment/i.test(title)) return 'Index';
  if (row?.scale === 'K' || row?.scale === 'M') return 'Level';
  return 'Release';
}

function inferLensPath(row, rule) {
  if (rule?.lensPath) return rule.lensPath;
  const text = normalizeName(`${row?.title || ''} ${row?.indicator || ''} ${row?.source || ''}`);
  if (/fed|fomc|interest rate|central bank|powell|testimony|speech/.test(text)) return 'policy';
  if (/producer price|\bppi\b/.test(text)) return 'producer-inflation';
  if (/consumer price|\bcpi\b|pce|inflation/.test(text)) return 'consumer-inflation';
  if (/employment|payroll|jobless|jolts|labor|labour|wage/.test(text)) return 'labor';
  if (/retail|personal income|personal spending|consumer confidence|consumer sentiment/.test(text)) return 'consumer-demand';
  if (/manufactur|industrial|factory|durable|regional fed/.test(text)) return 'manufacturing';
  if (/services pmi|non-manufacturing/.test(text)) return 'services';
  if (/housing|home sale|mortgage|building permit/.test(text)) return 'housing';
  if (/eia|api crude|oil stock|gasoline|energy/.test(text)) return 'energy';
  if (/trade balance|imports|exports/.test(text)) return 'external';
  if (/budget|treasury auction|bill auction|note auction|bond auction/.test(text)) return 'fiscal';
  return 'broad-growth';
}

function valuesApplyToEvent(row) {
  return !/press conference|speech|speaks|testimony|hearing|minutes|meeting/i.test(String(row?.title || ''));
}

function tradingViewEvent(row) {
  if (row?.id === null || row?.id === undefined || String(row.id).trim() === '') {
    throw new Error('TradingView calendar event is missing its stable identity.');
  }
  const instant = new Date(String(row?.date || ''));
  if (Number.isNaN(instant.getTime())) throw new Error(`TradingView event ${row?.id || 'unknown'} has an invalid date.`);
  const local = dateParts(instant, SOURCE_TIME_ZONE, { time: true });
  const rule = eventRule(row);
  const actual = formatTradingViewValue(row.actual, row);
  const forecast = formatTradingViewValue(row.forecast, row);
  const previous = formatTradingViewValue(row.previous, row);
  const valuesApplicable = valuesApplyToEvent(row);
  return {
    date: local.isoDate,
    sortMinutes: local.hour * 60 + local.minute,
    id: `tradingview:${String(row.id)}`,
    time: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    name: canonicalTitle(row, rule),
    agency: canonicalAgency(row, rule),
    period: eventPeriod(row),
    impact: row.importance === 1 ? 'high' : 'medium',
    actual: valuesApplicable ? actual : null,
    forecast: valuesApplicable ? forecast : null,
    previous: valuesApplicable ? previous : null,
    forecastType: valuesApplicable && forecast !== null ? 'consensus' : null,
    valuesApplicable,
    lensPath: inferLensPath(row, rule),
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

function weekAheadMarketLensEvents(day) {
  const eventIds = new Set(Array.isArray(day?.marketLens?.eventIds) ? day.marketLens.eventIds : []);
  return (Array.isArray(day?.events) ? day.events : []).filter((event) => eventIds.has(event?.id));
}

function weekAheadMarketLensIsComplete(day) {
  const eventIds = new Set(Array.isArray(day?.marketLens?.eventIds) ? day.marketLens.eventIds : []);
  const events = weekAheadMarketLensEvents(day);
  return eventIds.size > 0
    && events.length === eventIds.size
    && events.every((event) => event?.status === 'released'
      && (event?.valuesApplicable === false || String(event.actual || '').trim()));
}

function weekAheadDayFingerprint(day) {
  return JSON.stringify(weekAheadMarketLensEvents(day).map((event) => [
    event.id,
    event.name,
    event.agency,
    event.period,
    event.impact,
    event.actual,
    event.forecast,
    event.previous,
    event.status,
    event.forecastType,
    event.valuesApplicable,
    event.lensPath
  ]));
}

function weekAheadEditorialContextFingerprint(day) {
  return JSON.stringify(weekAheadMarketLensEvents(day).map((event) => [
    event.id,
    event.name,
    event.agency,
    event.time,
    event.period,
    event.impact,
    event.actual,
    event.forecast,
    event.previous,
    event.status === 'released' ? 'released' : 'pre_release',
    event.forecastType,
    event.valuesApplicable,
    event.lensPath
  ]));
}

function weekAheadHasCloseReactionRows(day) {
  return Array.isArray(day?.marketReaction?.rows) && day.marketReaction.rows.length > 0;
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
    const sourceEvents = Array.isArray(sourceDay.events) ? sourceDay.events : [];
    day.events = sourceEvents.map((sourceEvent) => {
      const event = { ...sourceEvent };
      const releaseInstant = weekAheadReleaseInstant(day.date, event.time, week?.range?.marketTimeZone || SOURCE_TIME_ZONE);
      const hasActual = event.actual !== null && event.actual !== undefined && event.actual !== '';
      if (hasActual && releaseInstant && now < releaseInstant) event.actual = null;
      const hasReleasedActual = event.actual !== null && event.actual !== undefined && event.actual !== '';
      event.status = hasReleasedActual || (event.valuesApplicable === false && releaseInstant && now >= releaseInstant)
        ? 'released'
        : releaseInstant && now >= releaseInstant ? 'awaiting_actual' : 'scheduled';
      event.surprise = comparableWeekAheadSurprise(event.actual, event.forecast);
      return event;
    });
    if (!day.events.length) {
      delete day.lifecycle;
      delete day.marketReaction;
      delete day.outcome;
      return day;
    }
    const priorEventsById = new Map(sourceEvents.map((event) => [event?.id, event]));
    const selectedEvents = weekAheadMarketLensEvents(day);
    const selectedContextComplete = weekAheadMarketLensIsComplete(day);
    const selectedContextJustCompleted = selectedContextComplete
      && selectedEvents.some((event) => priorEventsById.get(event.id)?.status !== 'released');
    if (selectedContextJustCompleted && day.marketLens?.status === 'verified') {
      day.marketLens = defaultMarketLensForEvents(day.events);
    }

    const reactionSpecs = Array.isArray(day.marketLens?.reactions) ? day.marketLens.reactions : [];
    // A populated event-day bar can arrive before the cash session is final.
    // Gate on the Eastern close itself so an afternoon run cannot publish an
    // incomplete bar as the deterministic closing response.
    const marketCloseInstant = weekAheadReleaseInstant(day.date, '16:00', week?.range?.marketTimeZone || SOURCE_TIME_ZONE);
    const canCalculateClose = day.date < localNowDate || (marketCloseInstant && now >= marketCloseInstant);
    const reactionRows = canCalculateClose && selectedContextComplete ? reactionSpecs.flatMap((reaction) => {
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
    if (reactionRows.length) {
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
      day.lifecycle = selectedContextComplete
        ? 'released_awaiting_close'
        : selectedEvents.some((event) => event.status === 'awaiting_actual') ? 'awaiting_actual' : 'scheduled';
      delete day.outcome;
    }
    return day;
  });
  return { ...week, days };
}

function finalizeWeekAheadOutcomes(week) {
  const days = (Array.isArray(week?.days) ? week.days : []).map((day) => {
    const next = { ...day };
    const hasEvents = Array.isArray(next.events) && next.events.length;
    if (hasEvents) {
      const completed = weekAheadMarketLensIsComplete(next);
      const validLens = !validateMarketLens(next.marketLens).length;
      const currentVerifiedLens = next.marketLens?.status === 'verified' && validLens;
      if (completed && !currentVerifiedLens) {
        next.marketLens = unavailableMarketLensForEvents(next.events);
      } else if (!completed && (!validLens || !['setup', 'verified'].includes(next.marketLens?.status))) {
        next.marketLens = defaultMarketLensForEvents(next.events);
      }
    }
    if (!weekAheadNeedsOutcomeEditorial(next)) return next;
    if (next.outcome?.status === 'verified') return next;
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

function defaultMarketLensForEvents(events) {
  if (!Array.isArray(events) || !events.length) return null;
  const impactWeight = { high: 2, medium: 1 };
  const groups = new Map();
  for (const event of events) {
    if (!MARKET_LENS_TEMPLATES[event.lensPath]) continue;
    const group = groups.get(event.lensPath) || { path: event.lensPath, events: [] };
    group.events.push(event);
    groups.set(event.lensPath, group);
  }
  const selected = [...groups.values()].sort((left, right) => {
    const leftImpact = Math.max(...left.events.map((event) => impactWeight[event.impact] || 0));
    const rightImpact = Math.max(...right.events.map((event) => impactWeight[event.impact] || 0));
    const leftTime = left.events.map((event) => event.time).sort()[0] || '';
    const rightTime = right.events.map((event) => event.time).sort()[0] || '';
    return rightImpact - leftImpact || leftTime.localeCompare(rightTime) || left.path.localeCompare(right.path);
  })[0];
  if (!selected) return null;
  const template = MARKET_LENS_TEMPLATES[selected.path];
  return {
    status: 'setup',
    eventIds: selected.events.map((event) => event.id).sort(),
    reactions: template.reactions.map((reaction) => ({ ...reaction })),
    copy: {
      question: template.question,
      title: template.title,
      body: template.body
    }
  };
}

function unavailableMarketLensForEvents(events) {
  const fallback = defaultMarketLensForEvents(events);
  if (!fallback) return null;
  return {
    ...fallback,
    status: 'commentary_unavailable',
    copy: {
      question: '',
      title: '',
      body: ''
    }
  };
}

function normalizeWeekAhead(providerPayload, { range = rangeForDate(), now = new Date() } = {}) {
  const targetDays = displayDatesForRange(range);
  if (targetDays.length !== 5) throw new Error('Week Ahead range must be Monday-Friday or Friday plus next Monday-Thursday.');
  const targetDaySet = new Set(targetDays);
  if (!isPlainObject(providerPayload) || providerPayload.status !== 'ok' || !Array.isArray(providerPayload.result)) {
    throw new Error('TradingView calendar response must contain status "ok" and a result array.');
  }
  const rows = providerPayload.result;
  const malformedImpactRow = rows.find((row) => row?.country === 'US' && ![-1, 0, 1].includes(row?.importance));
  if (malformedImpactRow) {
    throw new Error(`TradingView event ${malformedImpactRow?.id || 'unknown'} has an invalid importance value.`);
  }
  const normalized = rows
    .filter((row) => row?.country === 'US' && [0, 1].includes(row?.importance))
    .map(tradingViewEvent)
    .filter((event) => targetDaySet.has(event.date));
  const deduped = [];
  const seenIds = new Set();
  for (const item of normalized.sort((left, right) => left.date.localeCompare(right.date) || left.sortMinutes - right.sortMinutes || left.id.localeCompare(right.id))) {
    if (seenIds.has(item.id)) throw new Error(`TradingView returned duplicate event identity ${item.id}.`);
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
    }
    return day;
  });

  const result = finalizeWeekAheadOutcomes(applyWeekAheadLifecycle({
    schemaVersion: SCHEMA_VERSION,
    range: { ...range, timeZone: TIME_ZONE, marketTimeZone: SOURCE_TIME_ZONE },
    generatedAt: now.toISOString(),
    source: {
      provider: TRADINGVIEW_PROVIDER,
      endpoint: TRADINGVIEW_ENDPOINT,
      status: 'fresh',
      fetchedAt: now.toISOString()
    },
    days,
    sourceSummary: {
      returnedEvents: rows.length,
      includedEvents: deduped.length,
      highImpactEvents: deduped.filter((event) => event.impact === 'high').length,
      mediumImpactEvents: deduped.filter((event) => event.impact === 'medium').length,
      omittedLowImpactEvents: rows.filter((row) => row?.country === 'US' && row?.importance === -1).length
    }
  }, null, { now }));
  const errors = validateWeekAheadPayload(result, { now });
  if (errors.length) throw new Error(`Normalized Week Ahead payload is invalid: ${errors.join(' ')}`);
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateMarketLens(lens, prefix = 'marketLens', { allowPendingReview = false } = {}) {
  const errors = [];
  if (!isPlainObject(lens)) return [`${prefix} must be an object.`];
  const allowedStatuses = allowPendingReview
    ? ['setup', 'pending_review', 'verified', 'commentary_unavailable']
    : ['setup', 'verified', 'commentary_unavailable'];
  if (lens.status === 'pending_review' && !allowPendingReview) {
    errors.push(`${prefix}.status pending_review is supported only in an editorial handoff.`);
  } else if (!allowedStatuses.includes(lens.status)) {
    errors.push(`${prefix}.status must be ${allowedStatuses.join(', ')}.`);
  }
  const supportedFields = new Set(['status', 'eventIds', 'reactions', 'copy']);
  for (const field of Object.keys(lens)) {
    if (!supportedFields.has(field)) errors.push(`${prefix}.${field} is not supported.`);
  }
  if (!Array.isArray(lens.eventIds) || !lens.eventIds.length) {
    errors.push(`${prefix}.eventIds must contain at least one event ID.`);
  } else {
    const eventIds = new Set();
    lens.eventIds.forEach((eventId, index) => {
      if (typeof eventId !== 'string' || !eventId.trim()) errors.push(`${prefix}.eventIds[${index}] must be populated.`);
      if (eventIds.has(eventId)) errors.push(`${prefix}.eventIds must not contain duplicates.`);
      eventIds.add(eventId);
    });
  }
  if (!Array.isArray(lens.reactions)) {
    errors.push(`${prefix}.reactions must be an array.`);
  } else {
    lens.reactions.forEach((reaction, index) => {
      const reactionPrefix = `${prefix}.reactions[${index}]`;
      if (!isPlainObject(reaction)) {
        errors.push(`${reactionPrefix} must be an object.`);
        return;
      }
      const ticker = String(reaction.ticker || '');
      if (!/^[A-Z0-9]+$/.test(ticker)) errors.push(`${reactionPrefix}.ticker must be a canonical uppercase Tape symbol.`);
      if (typeof reaction.role !== 'string' || !reaction.role.trim()) errors.push(`${reactionPrefix}.role must be populated.`);
    });
  }
  if (!isPlainObject(lens.copy)) {
    errors.push(`${prefix}.copy must be an object.`);
  } else {
    const supportedCopyFields = new Set(EDITORIAL_MARKET_LENS_FIELDS);
    for (const field of Object.keys(lens.copy)) {
      if (!supportedCopyFields.has(field)) errors.push(`${prefix}.copy.${field} is not supported.`);
    }
    for (const field of EDITORIAL_MARKET_LENS_FIELDS) {
      if (typeof lens.copy[field] !== 'string') errors.push(`${prefix}.copy.${field} must be a string.`);
    }
    if (['setup', 'verified'].includes(lens.status)) {
      for (const field of EDITORIAL_MARKET_LENS_FIELDS) {
        if (typeof lens.copy[field] === 'string' && !lens.copy[field].trim()) {
          errors.push(`${prefix}.copy.${field} must be populated when status is ${lens.status}.`);
        }
      }
    }
    if (lens.status === 'commentary_unavailable'
      && EDITORIAL_MARKET_LENS_FIELDS.some((field) => String(lens.copy[field] || '').trim())) {
      errors.push(`${prefix}.copy must be blank when status is commentary_unavailable.`);
    }
  }
  return errors;
}

const EDITORIAL_MARKET_LENS_FIELDS = ['question', 'title', 'body'];

function marketLensHasEditableText(lens) {
  return isPlainObject(lens?.copy)
    && EDITORIAL_MARKET_LENS_FIELDS.every((field) => typeof lens.copy[field] === 'string' && lens.copy[field].trim());
}

function overlayEditableMarketLensText(baseLens, editorialLens) {
  const lens = structuredClone(baseLens);
  lens.status = 'verified';
  for (const field of EDITORIAL_MARKET_LENS_FIELDS) {
    lens.copy[field] = String(editorialLens?.copy?.[field] || '').trim();
  }
  return lens;
}

function clearEditableMarketLensText(baseLens) {
  const lens = structuredClone(baseLens);
  lens.status = 'pending_review';
  for (const field of EDITORIAL_MARKET_LENS_FIELDS) lens.copy[field] = '';
  return lens;
}

function validEditorialMarketLens(lens) {
  return lens?.status === 'verified'
    && marketLensHasEditableText(lens);
}

function validateWeekAheadPayload(payload, {
  now = null,
  requireOutcomeDisposition = false,
  allowPendingMarketLens = false
} = {}) {
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
  if (!isPlainObject(payload.source) || !['fresh', 'cached', 'unavailable'].includes(payload.source.status)) {
    errors.push('weekAhead.source.status must be fresh, cached, or unavailable.');
  } else {
    if (payload.source.provider !== TRADINGVIEW_PROVIDER) errors.push(`weekAhead.source.provider must be ${TRADINGVIEW_PROVIDER}.`);
    if (payload.source.endpoint !== TRADINGVIEW_ENDPOINT) errors.push(`weekAhead.source.endpoint must be ${TRADINGVIEW_ENDPOINT}.`);
    if (!isIsoDateTime(payload.source.fetchedAt)) errors.push('weekAhead.source.fetchedAt must be an offset-bearing ISO timestamp.');
  }
  if (!isPlainObject(payload.sourceSummary)) {
    errors.push('weekAhead.sourceSummary must be an object.');
  } else {
    for (const field of ['returnedEvents', 'includedEvents', 'highImpactEvents', 'mediumImpactEvents', 'omittedLowImpactEvents']) {
      if (!Number.isInteger(payload.sourceSummary[field]) || payload.sourceSummary[field] < 0) {
        errors.push(`weekAhead.sourceSummary.${field} must be a non-negative integer.`);
      }
    }
    if (payload.sourceSummary.includedEvents !== payload.sourceSummary.highImpactEvents + payload.sourceSummary.mediumImpactEvents) {
      errors.push('weekAhead.sourceSummary included count must equal high plus medium counts.');
    }
  }
  if (payload.availability !== undefined) {
    if (!isPlainObject(payload.availability)) {
      errors.push('weekAhead.availability must be an object.');
    } else {
      if (!['carried_forward', 'unavailable'].includes(payload.availability.status)) errors.push('weekAhead.availability.status must be carried_forward or unavailable.');
      if (payload.availability.reason !== 'source_refresh_failed') errors.push('weekAhead.availability.reason must be source_refresh_failed.');
      if (!isIsoDateTime(payload.availability.checkedAt)) errors.push('weekAhead.availability.checkedAt must be an offset-bearing ISO timestamp.');
      if (payload.availability.failures !== undefined) errors.push('weekAhead.availability.failures is not supported for the single-source calendar.');
    }
  }
  if (payload.source?.status === 'unavailable' && payload.availability?.status !== 'unavailable') {
    errors.push('weekAhead.source.status unavailable requires weekAhead.availability.status unavailable.');
  }
  if (payload.source?.status !== 'unavailable' && payload.availability?.status === 'unavailable') {
    errors.push('weekAhead.availability.status unavailable requires weekAhead.source.status unavailable.');
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
    const supportedDayFields = new Set(['date', 'label', 'closure', 'events', 'marketLens', 'lifecycle', 'marketReaction', 'outcome']);
    for (const field of Object.keys(isPlainObject(day) ? day : {})) {
      if (!supportedDayFields.has(field)) errors.push(`weekAhead.days[${dayIndex}].${field} is not supported.`);
    }
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
    if (hasEvents && !hasMarketLens) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens is required when events are present.`);
    } else if (hasEvents) {
      const lensPrefix = `weekAhead.days[${dayIndex}].marketLens`;
      errors.push(...validateMarketLens(day.marketLens, lensPrefix, { allowPendingReview: allowPendingMarketLens }));
      const eventIds = new Set(day.events.map((event) => event?.id));
      for (const eventId of Array.isArray(day.marketLens?.eventIds) ? day.marketLens.eventIds : []) {
        if (!eventIds.has(eventId)) errors.push(`${lensPrefix}.eventIds contains an ID outside this event day.`);
      }
      const completed = weekAheadMarketLensIsComplete(day);
      if (day.marketLens?.status === 'setup' && completed) {
        errors.push(`${lensPrefix}.status setup is not current after the selected event context has completed.`);
      }
      if (day.marketLens?.status === 'commentary_unavailable' && !completed) {
        errors.push(`${lensPrefix}.status commentary_unavailable requires the selected event context to be complete.`);
      }
    }
    if (!hasEvents && hasMarketLens) {
      errors.push(`weekAhead.days[${dayIndex}].marketLens must be omitted when there are no events.`);
    }
    if (hasEvents && !['scheduled', 'awaiting_actual', 'released_awaiting_close', 'close_available'].includes(day?.lifecycle)) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle is invalid.`);
    }
    if (!hasEvents && (day?.lifecycle !== undefined || day?.marketReaction !== undefined || day?.outcome !== undefined)) {
      errors.push(`weekAhead.days[${dayIndex}] without events must omit lifecycle, marketReaction, and outcome.`);
    }
    if (day?.marketReaction !== undefined) {
      const reactionPrefix = `weekAhead.days[${dayIndex}].marketReaction`;
      if (!isPlainObject(day.marketReaction) || !Array.isArray(day.marketReaction.rows)) {
        errors.push(`${reactionPrefix} must be an object with a rows array.`);
      } else {
        day.marketReaction.rows.forEach((row, rowIndex) => {
          if (!isRenderableWeekAheadReactionRow(row)) {
            errors.push(`${reactionPrefix}.rows[${rowIndex}] must be a renderable reaction row.`);
          }
        });
      }
    }
    if (day?.lifecycle === 'close_available') {
      const marketCloseInstant = weekAheadReleaseInstant(day.date, '16:00', payload.range?.marketTimeZone || SOURCE_TIME_ZONE);
      if (now instanceof Date && !Number.isNaN(now.getTime()) && marketCloseInstant && now < marketCloseInstant) {
        errors.push(`weekAhead.days[${dayIndex}].lifecycle close_available cannot precede the event-day market close.`);
      }
    }
    if (['released_awaiting_close', 'close_available'].includes(day?.lifecycle)
      && !weekAheadMarketLensIsComplete(day)) {
      errors.push(`weekAhead.days[${dayIndex}].lifecycle ${day.lifecycle} requires the selected Market Lens event context to be complete.`);
    }
    if (requireOutcomeDisposition && day?.lifecycle === 'close_available' && day?.outcome === undefined) {
      errors.push(`weekAhead.days[${dayIndex}].outcome requires an outcome disposition before publication.`);
    }
    if (day?.outcome !== undefined) {
      if (!isPlainObject(day.outcome)) {
        errors.push(`weekAhead.days[${dayIndex}].outcome must be an object.`);
      } else if (day.lifecycle !== 'close_available') {
        errors.push(`weekAhead.days[${dayIndex}].outcome is supported only when lifecycle is close_available.`);
      } else if (!['pending_review', 'verified'].includes(day.outcome.status)) {
        errors.push(`weekAhead.days[${dayIndex}].outcome.status must be pending_review or verified.`);
      } else if (day.outcome.status === 'verified'
        && (!String(day.outcome.title || '').trim() || !String(day.outcome.body || '').trim())) {
        errors.push(`weekAhead.days[${dayIndex}].outcome verified status requires populated title and body.`);
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
      if (!['high', 'medium'].includes(event.impact)) errors.push(`${prefix}.impact must be high or medium.`);
      for (const field of ['actual', 'forecast', 'previous']) {
        if (event[field] !== null && typeof event[field] !== 'string') errors.push(`${prefix}.${field} must be string or null.`);
      }
      if (!['scheduled', 'awaiting_actual', 'released'].includes(event.status)) errors.push(`${prefix}.status is invalid.`);
      if (![null, 'consensus'].includes(event.forecastType)) errors.push(`${prefix}.forecastType must be consensus or null.`);
      if (typeof event.valuesApplicable !== 'boolean') errors.push(`${prefix}.valuesApplicable must be boolean.`);
      if (!MARKET_LENS_TEMPLATES[event.lensPath]) errors.push(`${prefix}.lensPath is invalid.`);
      if (event.valuesApplicable === false && [event.actual, event.forecast, event.previous].some((value) => value !== null)) {
        errors.push(`${prefix} non-statistical values must be null.`);
      }
    });
  });
  return errors;
}

function hasEditorialMarketLens(day) {
  return validEditorialMarketLens(day?.marketLens);
}

function weekAheadHasCurrentMarketLens(day) {
  return hasEditorialMarketLens(day);
}

function weekAheadNeedsMarketLensEditorial(day) {
  return Array.isArray(day?.events)
    && day.events.length > 0
    && !weekAheadHasCurrentMarketLens(day);
}

function weekAheadNeedsOutcomeEditorial(day) {
  return day?.lifecycle === 'close_available'
    && weekAheadMarketLensIsComplete(day)
    && weekAheadHasCloseReactionRows(day);
}

function prepareWeekAheadForEditorial(weekAhead) {
  return {
    ...weekAhead,
    days: (Array.isArray(weekAhead?.days) ? weekAhead.days : []).map((day) => {
      let next = day;
      if (weekAheadNeedsMarketLensEditorial(day)) {
        const baseLens = defaultMarketLensForEvents(day.events);
        if (baseLens) {
          next = {
            ...next,
            marketLens: clearEditableMarketLensText(baseLens)
          };
        }
      }
      if (!weekAheadNeedsOutcomeEditorial(day) || day?.outcome?.status === 'verified') return next;
      return { ...next, outcome: { status: 'pending_review' } };
    })
  };
}

function reconcileEditorialMarketLens(priorDay, nextDay) {
  if (!hasEditorialMarketLens(priorDay)) return null;
  if (weekAheadEditorialContextFingerprint(priorDay) !== weekAheadEditorialContextFingerprint(nextDay)) return null;
  const baseLens = defaultMarketLensForEvents(nextDay.events);
  return baseLens ? overlayEditableMarketLensText(baseLens, priorDay.marketLens) : null;
}

function mergeWeekAheadPayload(existingWeekAhead, payload) {
  const errors = validateWeekAheadPayload(payload);
  if (errors.length) throw new Error(`Generated Week Ahead payload is invalid: ${errors.join(' ')}`);
  return {
    ...payload,
    days: payload.days.map((day) => {
      const next = { ...day };
      if (weekAheadMarketLensIsComplete(next)
        && ['scheduled', 'awaiting_actual'].includes(next.lifecycle)) {
        next.lifecycle = 'released_awaiting_close';
      }
      const priorDay = (Array.isArray(existingWeekAhead?.days) ? existingWeekAhead.days : []).find((candidate) => candidate?.date === day.date);
      const deterministicValuesUnchanged = weekAheadDayFingerprint(priorDay) === weekAheadDayFingerprint(next);
      const reconciledMarketLens = reconcileEditorialMarketLens(priorDay, next);
      if (reconciledMarketLens) {
        next.marketLens = reconciledMarketLens;
      }
      // Post-close copy and reaction bars remain bound to the selected event
      // facts and must not survive a correction to that context.
      if (deterministicValuesUnchanged && priorDay?.outcome) next.outcome = priorDay.outcome;
      if (deterministicValuesUnchanged && priorDay?.marketReaction) {
        next.marketReaction = priorDay.marketReaction;
        next.lifecycle = priorDay.lifecycle;
      }
      return next;
    })
  };
}

function addWeekAheadEditorialFallback(systemFallbacks, day, action, reason) {
  if (!Array.isArray(systemFallbacks)) return;
  systemFallbacks.push({
    section: 'market-lens',
    path: `weekAhead.days.${day.date}.marketLens`,
    action,
    reason
  });
}

function usableWeekAheadOutcome(outcome) {
  return isPlainObject(outcome)
    && outcome.status === 'verified'
    && Boolean(String(outcome.title || '').trim() && String(outcome.body || '').trim());
}

function editorialWeekAheadOutcome(outcome) {
  if (!usableWeekAheadOutcome(outcome)) return null;
  return {
    status: 'verified',
    source: 'editorial',
    title: String(outcome.title).trim(),
    body: String(outcome.body).trim()
  };
}

function isRenderableWeekAheadReactionRow(row) {
  if (!isPlainObject(row)
    || !/^[A-Z0-9]+$/.test(String(row.ticker || ''))
    || typeof row.role !== 'string'
    || !row.role.trim()
    || typeof row.delta !== 'number'
    || !Number.isFinite(row.delta)) {
    return false;
  }
  return row.unit === 'percent_yield'
    || (typeof row.percentChange === 'number'
      && Number.isFinite(row.percentChange));
}

function applyWeekAheadEditorial(candidateWeekAhead, editorialWeekAhead, { systemFallbacks = null } = {}) {
  const editorialDays = new Map(
    (Array.isArray(editorialWeekAhead?.days) ? editorialWeekAhead.days : [])
      .filter((day) => typeof day?.date === 'string')
      .map((day) => [day.date, day])
  );
  const days = (Array.isArray(candidateWeekAhead?.days) ? candidateWeekAhead.days : []).map((day) => {
    const next = { ...day };
    if (!Array.isArray(next.events) || !next.events.length) return next;
    const editorialDayExists = editorialDays.has(next.date);
    const editorialDay = editorialDays.get(next.date);
    const baseLens = defaultMarketLensForEvents(next.events);
    const editorialLens = editorialDay?.marketLens;
    const submittedValidLens = validEditorialMarketLens(editorialLens);
    if (baseLens && submittedValidLens) {
      // Editorial owns text only; selected event IDs and reaction tickers are
      // rebuilt from the deterministic candidate.
      next.marketLens = overlayEditableMarketLensText(baseLens, editorialLens);
    } else if (weekAheadMarketLensIsComplete(next)) {
      next.marketLens = unavailableMarketLensForEvents(next.events);
      addWeekAheadEditorialFallback(systemFallbacks, next, 'commentary_unavailable', 'editorial_commentary_unavailable');
    } else if (baseLens) {
      next.marketLens = baseLens;
      if (editorialDayExists && isPlainObject(editorialLens) && !submittedValidLens) {
        addWeekAheadEditorialFallback(systemFallbacks, next, 'setup_default', 'editorial_content_unavailable');
      }
    }
    if (weekAheadNeedsOutcomeEditorial(next)) {
      const outcome = editorialWeekAheadOutcome(editorialDay?.outcome);
      next.outcome = outcome || { status: 'pending_review' };
    } else {
      delete next.outcome;
    }
    if (Array.isArray(next.marketReaction?.rows)) {
      next.marketReaction = {
        ...next.marketReaction,
        rows: next.marketReaction.rows.filter(isRenderableWeekAheadReactionRow)
      };
    }
    return next;
  });
  return { ...candidateWeekAhead, schemaVersion: SCHEMA_VERSION, days };
}

module.exports = {
  EVENT_RULES,
  MARKET_CLOSURES,
  MARKET_LENS_TEMPLATES,
  SCHEMA_VERSION,
  SOURCE_TIME_ZONE,
  TIME_ZONE,
  TRADINGVIEW_ENDPOINT,
  TRADINGVIEW_PROVIDER,
  addDays,
  applyWeekAheadEditorial,
  applyWeekAheadLifecycle,
  buildWeekAheadPreparationFallback,
  comparableWeekAheadSurprise,
  defaultMarketLensForEvents,
  displayDatesForRange,
  finalizeWeekAheadOutcomes,
  formatTradingViewValue,
  mondayForDate,
  mergeWeekAheadPayload,
  normalizeWeekAhead,
  prepareWeekAheadForEditorial,
  rangeForDate,
  reconcileEditorialMarketLens,
  validateMarketLens,
  validateWeekAheadPayload,
  weekAheadDayFingerprint,
  weekAheadHasCurrentMarketLens,
  weekAheadNeedsMarketLensEditorial,
  weekAheadNeedsOutcomeEditorial,
  weekAheadReleaseInstant
};
