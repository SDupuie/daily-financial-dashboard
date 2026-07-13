#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { atomicWriteJson } = require('./staging_writer');
const path = require('path');
const {
  applyWeekAheadLifecycle,
  displayDatesForRange,
  fxMacroValueRequests,
  normalizeWeekAhead,
  rangeForDate,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const { addDays, isIsoDate } = require('./calendar_contract');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'week_ahead.json');
const REQUEST_TIMEOUT_MS = 15000;
const FX_MACRO_BASE_URL = 'https://api.fxmacrodata.com/v1';
const BLS_SCHEDULE_URL = 'https://www.bls.gov/schedule/2026/';
const CENSUS_SCHEDULE_URL = 'https://www.census.gov/economic-indicators/calendar-listview.html';
const BEA_SCHEDULE_URL = 'https://www.bea.gov/news/schedule/';
const EIA_SCHEDULE_URL = 'https://www.eia.gov/petroleum/supply/weekly/schedule.php';
const FED_SCHEDULE_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

const AUTHORITIES = {
  bls: {
    id: 'bls-2026',
    name: 'BLS 2026 release schedule',
    url: BLS_SCHEDULE_URL,
    mode: 'maintained'
  },
  census: {
    id: 'census-economic-indicators',
    name: 'Census economic-indicator calendar',
    url: CENSUS_SCHEDULE_URL,
    mode: 'live'
  },
  bea: {
    id: 'bea-release-schedule',
    name: 'BEA release schedule',
    url: BEA_SCHEDULE_URL,
    mode: 'live'
  },
  eia: {
    id: 'eia-wpsr-2026',
    name: 'EIA weekly petroleum schedule',
    url: EIA_SCHEDULE_URL,
    mode: 'maintained'
  },
  fed: {
    id: 'fed-fomc-2026',
    name: 'Federal Reserve FOMC calendar',
    url: FED_SCHEDULE_URL,
    mode: 'maintained'
  }
};

function event(date, time, keys, authority) {
  return {
    date,
    time,
    keys,
    authority: authority.id,
    authorityName: authority.name,
    authorityUrl: authority.url
  };
}

function dates(datesList, time, keys, authority) {
  return datesList.map((dateValue) => event(dateValue, time, keys, authority));
}

// BLS blocks unattended retrieval. These dates are transcribed from its 2026
// release calendar and deliberately expire at year-end rather than silently
// falling back to the provider for the releases that move markets most.
const BLS_2026_EVENTS = [
  ...dates([
    '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10',
    '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10'
  ], '08:30', ['cpi', 'core-cpi'], AUTHORITIES.bls),
  ...dates([
    '2026-01-14', '2026-01-30', '2026-02-27', '2026-03-18', '2026-04-14', '2026-05-13',
    '2026-06-11', '2026-07-15', '2026-08-13', '2026-09-10', '2026-10-15', '2026-11-13', '2026-12-15'
  ], '08:30', ['ppi', 'core-ppi'], AUTHORITIES.bls),
  ...dates([
    '2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05',
    '2026-07-02', '2026-08-07', '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04'
  ], '08:30', ['nonfarm-payrolls', 'unemployment-rate', 'average-hourly-earnings'], AUTHORITIES.bls),
  ...dates([
    '2026-01-07', '2026-02-05', '2026-03-13', '2026-03-31', '2026-05-05', '2026-06-02',
    '2026-06-30', '2026-08-04', '2026-09-01', '2026-09-29', '2026-11-03', '2026-12-01'
  ], '10:00', ['jolts'], AUTHORITIES.bls)
];

const FOMC_2026_EVENTS = dates([
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'
], '14:00', ['fed-rate-decision'], AUTHORITIES.fed);

const EIA_2026_DELAYED_RELEASES = {
  '2026-01-22': '12:00',
  '2026-02-19': '12:00',
  '2026-05-28': '12:00',
  '2026-09-10': '12:00',
  '2026-10-15': '12:00',
  '2026-11-12': '12:00'
};

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDateFromMonthDay(value, year) {
  const text = String(value || '').trim();
  if (!text) return '';
  const input = /\b20\d{2}\b/.test(text) ? text : `${text} ${year}`;
  const date = new Date(`${input} 12:00:00 UTC`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function marketTime(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return '';
  if (hour === 12) hour = 0;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function censusKeys(title) {
  if (/advance monthly sales for retail and food services/i.test(title)) return ['retail-sales', 'core-retail-sales'];
  if (/manufacturers' shipments, inventories and orders/i.test(title)) return ['durable-goods'];
  if (/new residential construction/i.test(title)) return ['housing-starts', 'building-permits'];
  if (/new residential sales/i.test(title)) return ['new-home-sales'];
  return null;
}

function parseCensusSchedule(html) {
  const yearMatch = String(html || '').match(/\b(20\d{2})\s+Economic Indicator(?: Release)? (?:Calendar|Schedule)/i);
  const year = Number(yearMatch?.[1]) || 0;
  if (!year) return [];
  const events = [];
  for (const row of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripHtml(cell[1]));
    if (cells.length < 3) continue;
    const keys = censusKeys(cells[0]);
    const date = isoDateFromMonthDay(cells[1], year);
    const time = marketTime(cells[2]);
    if (!keys || !date || !time) continue;
    events.push(event(date, time, keys, AUTHORITIES.census));
  }
  return events;
}

function beaKeys(title) {
  if (/personal income and outlays/i.test(title)) return ['pce', 'core-pce'];
  if (/^GDP \((Advance|Second|Third) Estimate\)/i.test(title)) return ['gdp'];
  if (/U\.S\. International Trade in Goods and Services/i.test(title)) return ['trade-balance'];
  return null;
}

function parseBeaSchedule(html) {
  const yearMatch = String(html || '').match(/Year\s+(20\d{2})/i);
  const year = Number(yearMatch?.[1]) || 0;
  if (!year) return [];
  const events = [];
  for (const row of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = row[1];
    const date = isoDateFromMonthDay(stripHtml(body.match(/<div class="release-date">([\s\S]*?)<\/div>/i)?.[1]), year);
    const time = marketTime(stripHtml(body.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1]));
    const title = stripHtml(body.match(/class="release-title[^>]*>([\s\S]*?)<\/td>/i)?.[1]);
    const keys = beaKeys(title);
    if (!keys || !date || !time) continue;
    events.push(event(date, time, keys, AUTHORITIES.bea));
  }
  return events;
}

function eiaEventsForRange(range) {
  const events = [];
  for (const date of displayDatesForRange(range)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 3) events.push(event(date, EIA_2026_DELAYED_RELEASES[date] || '10:30', ['crude-oil-inventories'], AUTHORITIES.eia));
  }
  for (const [date, time] of Object.entries(EIA_2026_DELAYED_RELEASES)) {
    if (date >= range.from && date <= range.to) {
      const standardDate = addDays(date, -1);
      const standardIndex = events.findIndex((item) => item.date === standardDate && item.keys.includes('crude-oil-inventories'));
      if (standardIndex >= 0) events.splice(standardIndex, 1);
      events.push(event(date, time, ['crude-oil-inventories'], AUTHORITIES.eia));
    }
  }
  return events;
}

function filterRange(events, range) {
  const targetDates = new Set(displayDatesForRange(range));
  return events.filter((item) => targetDates.has(item.date));
}

function authoritySummary(authority, now, status = authority.mode === 'live' ? 'fresh' : 'maintained') {
  return {
    id: authority.id,
    name: authority.name,
    url: authority.url,
    mode: authority.mode,
    status,
    checkedAt: now.toISOString()
  };
}

function buildOfficialSchedule(range, { censusHtml = '', beaHtml = '', now = new Date(), failures = [] } = {}) {
  if (!isIsoDate(range?.from) || !isIsoDate(range?.to) || displayDatesForRange(range).length !== 5) {
    throw new Error('Official Week Ahead schedule requires a supported five-day display range.');
  }
  const maintainedYearAvailable = range.from.slice(0, 4) === '2026';
  const censusEvents = censusHtml ? parseCensusSchedule(censusHtml) : [];
  const beaEvents = beaHtml ? parseBeaSchedule(beaHtml) : [];
  const unavailableAuthorities = new Set(failures.map((item) => item.authority));
  if (!censusEvents.length) unavailableAuthorities.add('census');
  if (!beaEvents.length) unavailableAuthorities.add('bea');
  if (!maintainedYearAvailable) {
    unavailableAuthorities.add('bls');
    unavailableAuthorities.add('eia');
    unavailableAuthorities.add('fed');
  }
  const events = [
    ...(maintainedYearAvailable ? filterRange(BLS_2026_EVENTS, range) : []),
    ...(maintainedYearAvailable ? filterRange(FOMC_2026_EVENTS, range) : []),
    ...(maintainedYearAvailable ? eiaEventsForRange(range) : []),
    ...filterRange(censusEvents, range),
    ...filterRange(beaEvents, range)
  ].sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) || left.authority.localeCompare(right.authority));
  return {
    events,
    authorities: [
      authoritySummary(AUTHORITIES.bls, now, unavailableAuthorities.has('bls') ? 'unavailable' : 'maintained'),
      authoritySummary(AUTHORITIES.census, now, unavailableAuthorities.has('census') ? 'unavailable' : 'fresh'),
      authoritySummary(AUTHORITIES.bea, now, unavailableAuthorities.has('bea') ? 'unavailable' : 'fresh'),
      authoritySummary(AUTHORITIES.eia, now, unavailableAuthorities.has('eia') ? 'unavailable' : 'maintained'),
      authoritySummary(AUTHORITIES.fed, now, unavailableAuthorities.has('fed') ? 'unavailable' : 'maintained')
    ],
    failures: [
      ...failures,
      ...(!maintainedYearAvailable ? [{ authority: 'maintained_schedules', message: 'Maintained BLS/EIA/FOMC schedules are unavailable for this year.' }] : [])
    ]
  };
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_OUTPUT,
    output: DEFAULT_OUTPUT,
    date: '',
    refreshValues: false,
    timeoutMs: REQUEST_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--output requires a path.');
      args.output = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--input') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--input requires a path.');
      args.input = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--date') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--date requires an ISO date.');
      args.date = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--refresh-values') {
      args.refreshValues = true;
      continue;
    }
    if (arg === '--timeout-ms') {
      const timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
        throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      }
      args.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/fetch_week_ahead.js [options]\n\nOptions:\n  --input PATH        Existing staging payload used by --refresh-values\n  --output PATH       Staging payload path (default: generated/week_ahead.json)\n  --date YYYY-MM-DD   Local dashboard date used to select a new displayed week\n  --refresh-values    Preserve the staged official slate and refresh release values only\n  --timeout-ms 15000  HTTP timeout in milliseconds\n  --help              Show this help\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.refreshValues && args.date) throw new Error('--refresh-values cannot be combined with --date.');
  return args;
}

function dateFromArg(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T12:00:00Z`);
  const [year, month, day] = value.split('-').map(Number);
  return Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    ? null
    : date;
}

function requestText(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        if (status < 200 || status >= 300) {
          const error = new Error(`Request to ${new URL(url).hostname} failed with HTTP ${status}.`);
          error.status = status;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
    request.on('timeout', () => {
      const error = new Error(`Request to ${new URL(url).hostname} timed out.`);
      error.transient = true;
      request.destroy(error);
    });
    request.on('error', (error) => {
      // Socket and DNS failures can safely use a validated same-week cache; data
      // parsing and schedule-normalization errors are intentionally untagged.
      error.transient = true;
      reject(error);
    });
  });
}

async function requestJson(url, timeoutMs) {
  const body = await requestText(url, timeoutMs);
  try {
    return JSON.parse(body);
  } catch (_error) {
    throw new Error(`FXMacroData returned invalid JSON for ${new URL(url).pathname}.`);
  }
}

async function requestFxMacroValues(officialSchedule, timeoutMs, dependencies = {}) {
  const requests = fxMacroValueRequests(officialSchedule);
  const fetchEntries = async (kind, indicators) => {
    const settled = await Promise.allSettled(indicators.map(async (indicator) => [
      indicator,
      await (dependencies.requestJson || requestJson)(`${FX_MACRO_BASE_URL}/${kind}/usd/${indicator}?limit=100`, timeoutMs)
    ]));
    const failures = [];
    const responses = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') responses.push(result.value);
      else failures.push({ kind, indicator: indicators[index], message: result.reason?.message || 'source unavailable' });
    });
    return { values: Object.fromEntries(responses), failures };
  };
  const [announcements, predictions] = await Promise.all([
    fetchEntries('announcements', requests.announcements),
    fetchEntries('predictions', requests.predictions)
  ]);
  return {
    announcements: announcements.values,
    predictions: predictions.values,
    failures: [...announcements.failures, ...predictions.failures]
  };
}

function readCache(output, range, now) {
  if (!fs.existsSync(output)) return null;
  try {
    const cached = applyWeekAheadLifecycle(JSON.parse(fs.readFileSync(output, 'utf8')), null, { now });
    const errors = validateWeekAheadPayload(cached);
    if (errors.length || cached.range?.from !== range.from || cached.range?.to !== range.to) return null;
    const fetchedAt = Date.parse(cached.source?.fetchedAt || '');
    if (!Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > 96 * 60 * 60 * 1000) return null;
    return {
      ...cached,
      generatedAt: now.toISOString(),
      source: { ...cached.source, status: 'cached' }
    };
  } catch (_error) {
    return null;
  }
}

function isTransient(error) {
  return error?.transient === true || error?.status === 429 || error?.status >= 500;
}

function writePayload(output, payload) {
  atomicWriteJson(output, payload);
}

async function run(args = parseArgs(process.argv.slice(2))) {
  const date = args.date ? dateFromArg(args.date) : new Date();
  if (!date) throw new Error('--date must be a valid YYYY-MM-DD value.');
  const now = new Date();
  let range = rangeForDate(date);
  let staged = null;
  if (args.refreshValues) {
    if (!fs.existsSync(args.input)) throw new Error(`Week Ahead staging payload not found: ${args.input}`);
    staged = applyWeekAheadLifecycle(JSON.parse(fs.readFileSync(args.input, 'utf8')), null, { now });
    const errors = validateWeekAheadPayload(staged);
    if (errors.length) throw new Error(`Existing Week Ahead staging payload is invalid: ${errors.join(' ')}`);
    range = staged.range;
  }
  try {
    const officialSchedule = staged?.officialSchedule || await (async () => {
      const settled = await Promise.allSettled([
        requestText(CENSUS_SCHEDULE_URL, args.timeoutMs),
        requestText(BEA_SCHEDULE_URL, args.timeoutMs)
      ]);
      const failures = [];
      if (settled[0].status === 'rejected') failures.push({ authority: 'census', message: settled[0].reason?.message || 'source unavailable' });
      if (settled[1].status === 'rejected') failures.push({ authority: 'bea', message: settled[1].reason?.message || 'source unavailable' });
      return buildOfficialSchedule(range, {
        censusHtml: settled[0].status === 'fulfilled' ? settled[0].value : '',
        beaHtml: settled[1].status === 'fulfilled' ? settled[1].value : '',
        now,
        failures
      });
    })();
    const valuePayload = await requestFxMacroValues(officialSchedule, args.timeoutMs);
    const payload = normalizeWeekAhead(valuePayload, { range, officialSchedule, now });
    writePayload(args.output, payload);
    process.stdout.write(`Week Ahead ${args.refreshValues ? 'values refreshed' : 'fetched'}: ${range.from} to ${range.to}; ${payload.sourceSummary.includedEvents} covered events.\n`);
    return payload;
  } catch (error) {
    // A fallback must still match the requested range and satisfy the same payload
    // contract; readCache rejects stale or malformed staging data before reuse.
    const cached = isTransient(error) ? readCache(args.refreshValues ? args.input : args.output, range, now) : null;
    if (!cached) throw error;
    writePayload(args.output, cached);
    process.stdout.write(`Week Ahead cache used: ${range.from} to ${range.to}; ${cached.sourceSummary.includedEvents} covered events.\n`);
    return cached;
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`fetch_week_ahead failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  AUTHORITIES,
  BEA_SCHEDULE_URL,
  BLS_2026_EVENTS,
  BLS_SCHEDULE_URL,
  CENSUS_SCHEDULE_URL,
  EIA_SCHEDULE_URL,
  FED_SCHEDULE_URL,
  buildOfficialSchedule,
  dateFromArg,
  isTransient,
  parseBeaSchedule,
  parseArgs,
  parseCensusSchedule,
  readCache,
  requestFxMacroValues,
  requestJson,
  requestText,
  run
};
