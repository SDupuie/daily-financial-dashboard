#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { validateEarningsWeekPayload } = require('./validate_earnings_week');
const {
  cryptoQuoteRowFromSeries,
  quoteRowFromSeries
} = require('./fetch_chart_data');

const root = path.resolve(__dirname, '..');
const inputFile = process.argv[2] || 'daily_financial_news.html';
const file = path.resolve(root, inputFile);
// Allow staging copies to be validated while keeping the checker scoped to this repository.
if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
  console.error(`Refusing to validate a file outside this repository: ${inputFile}`);
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');
const dashboardMatch = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
const chartDataMatch = html.match(/<script type="application\/json" id="chart-data">([\s\S]*?)<\/script>/);
const minChartHistoryDays = 1826;
const maxFuturesStoryTagLength = 24;
const requiredYieldCurveComparisonLabels = ['1M ago', '6M ago'];
const recognizedChartSources = new Set([
  'Yahoo Finance Chart API',
  'Yahoo Finance Chart API + Finnhub Quote API',
  'Treasury.gov Daily Treasury Yield Curve Rate Data'
]);

const errors = [];
const warnings = [];
const MONDAY_MORNING_NEWS_START_MINUTES = 6 * 60 + 45;
const MONDAY_MORNING_NEWS_END_MINUTES = 7 * 60 + 30;

function escRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNow() {
  const override = process.env.VALIDATE_NOW_ISO;
  if (!override) return new Date();
  const parsed = new Date(override);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
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
  // Calendar-date freshness stays on explicit local dates; the Saturday exception is limited to the scheduled Monday morning dashboard window.
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

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isIsoDateTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isOffsetBearingIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match || !isIsoDate(match[1])) return false;
  const [, , hour, minute, second = '0', , offsetHour = '0', offsetMinute = '0'] = match;
  return Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && Number(offsetHour) <= 23
    && Number(offsetMinute) <= 59
    && !Number.isNaN(Date.parse(value));
}

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

function futuresStoryPublicationWindow(sectionTitle, editionId, now, futures) {
  const runAt = isIsoDateTime(editionId) ? new Date(editionId) : now;
  const eastern = zonedDateParts(runAt, 'America/New_York');
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

function normalizeStoryTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalStoryUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function storyIdentity(story) {
  const url = canonicalStoryUrl(story?.url);
  if (url) return `url:${url}`;
  const title = normalizeStoryTitle(story?.title);
  return title ? `title:${title}` : '';
}

function dashboardNewsItems(data) {
  return [
    ...(Array.isArray(data?.stories) ? data.stories : []),
    ...(Array.isArray(data?.crypto?.notes) ? data.crypto.notes : [])
  ];
}

function dateFromIso(value) {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value, days) {
  const date = dateFromIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isMondayFridayRange(range) {
  if (!range || !isIsoDate(range.from) || !isIsoDate(range.to)) return false;
  return dateFromIso(range.from).getUTCDay() === 1
    && dateFromIso(range.to).getUTCDay() === 5
    && addDays(range.from, 4) === range.to;
}

function validateYieldCurvePointSet(label, fieldName, points, referencePoints = null) {
  if (points.length < 2) {
    errors.push(`${label}.${fieldName} must contain a Treasury curve for the inline chart.`);
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

function validateYieldCurveComparisons(label, item, curvePoints) {
  const comparisonCurves = Array.isArray(item.comparisonCurves) ? item.comparisonCurves : [];
  if (!Array.isArray(item.comparisonCurves)) {
    errors.push(`${label}.comparisonCurves must include 1M ago and 6M ago Treasury curves.`);
  }
  // The renderer assumes these labels exist and that each comparison shares the current curve maturity order.
  for (const expectedLabel of requiredYieldCurveComparisonLabels) {
    const comparisonIndex = comparisonCurves.findIndex((comparison) => comparison?.label === expectedLabel);
    if (comparisonIndex < 0) {
      errors.push(`${label}.comparisonCurves must include ${expectedLabel}.`);
      continue;
    }
    const comparison = comparisonCurves[comparisonIndex];
    if (!isIsoDate(comparison.date)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be an ISO date.`);
    }
    const points = Array.isArray(comparison.points) ? comparison.points : [];
    validateYieldCurvePointSet(label, `comparisonCurves[${comparisonIndex}].points`, points, curvePoints);
  }
}

function numericPercent(value) {
  const match = String(value ?? '').trim().match(/^([+-]?\d+(?:\.\d+)?)%$/);
  return match ? Number(match[1]) : null;
}

function nearlyEqual(left, right, tolerance = 0.01) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
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

// Static guard: the optional live-refresh path must never point the published dashboard at a remote service.
const localRefreshUrls = [...html.matchAll(/https?:\/\/[^'"`\s]+\/api\/market-refresh/g)].map((match) => match[0]);
const allowedLocalRefreshUrls = new Set([
  'http://127.0.0.1:2210/api/market-refresh',
  'http://localhost:2210/api/market-refresh'
]);
if (localRefreshUrls[0] !== 'http://127.0.0.1:2210/api/market-refresh') {
  errors.push('The first local refresh URL must target http://127.0.0.1:2210/api/market-refresh.');
}
for (const url of localRefreshUrls) {
  if (!allowedLocalRefreshUrls.has(url)) {
    errors.push(`Unexpected local refresh URL: ${url}`);
  }
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
const runtimeScriptIndex = html.indexOf('(function () {');

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
  errors.push('Could not find the dashboard runtime bootstrap script.');
}
if (dataStartIndex >= 0 && dataEndIndex >= 0 && dataStartIndex >= dataEndIndex) {
  errors.push('DATA START must appear before DATA END.');
}
if (dataEndIndex >= 0 && chartDataIndex >= 0 && chartDataIndex <= dataEndIndex) {
  errors.push('chart-data must appear after the DATA END marker.');
}
if (chartDataIndex >= 0 && runtimeScriptIndex >= 0 && chartDataIndex >= runtimeScriptIndex) {
  errors.push('chart-data must appear before the dashboard runtime bootstrap script.');
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
    const validateStoryFreshness = (itemRaw, label) => {
      const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
      if (item.referencePage !== undefined) {
        errors.push(`${label}.referencePage is not supported; news items must be dated articles.`);
      }
      requireIsoDate(item.publishedOn, `${label}.publishedOn`);
      const publishedOn = String(item.publishedOn ?? '').trim();
      if (publishedOn && !allowedStoryDates.has(publishedOn)) {
        errors.push(`${label}.publishedOn must follow the local calendar-date freshness rule in America/Chicago (today/yesterday, plus Saturday during the scheduled Monday morning dashboard window).`);
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

    const staleTapeTickers = new Set(['6723.T', 'BZ', 'TOTAL', 'MXEA', 'MXEF', 'FNER', 'GSCI']);
    for (const ticker of tapeRows.map((row) => String(row?.ticker ?? '').toUpperCase())) {
      if (staleTapeTickers.has(ticker)) {
        errors.push(`The Tape should not include stale or duplicated ticker ${ticker}.`);
      }
    }

    const requiredTapeTickers = ['SPX', 'NDX', 'DJI', 'RUT', 'VEA', 'VWO', 'VOX', 'VCR', 'VDC', 'VDE', 'VFH', 'VHT', 'VIS', 'VAW', 'VNQ', 'SMH', 'VGT', 'VPU', 'DBC', 'PDBC', 'XAU', 'XAG', 'CL', 'VIX', 'USYC', 'MOVE', 'UST3M', 'UST10Y', 'UST30Y', 'IEF', 'AGG', 'LQD', 'HYG'];
    const tapeTickerSet = new Set(tapeRows.map((row) => String(row?.ticker ?? '').toUpperCase()));
    for (const ticker of requiredTapeTickers) {
      if (!tapeTickerSet.has(ticker)) {
        errors.push(`The Tape is missing required ticker ${ticker}.`);
      }
    }
    const requiredCryptoTickers = ['BTC', 'ETH', 'SOL', 'XRP', 'IBIT', 'ETHA', 'MSTR'];
    const cryptoTickerSet = new Set(cryptoTickerRows.map((row) => String(row?.ticker ?? '').toUpperCase()));
    for (const ticker of requiredCryptoTickers) {
      if (!cryptoTickerSet.has(ticker)) {
        errors.push(`The Tape Crypto group is missing required ticker ${ticker}.`);
      }
    }
    // Keep this map in lockstep with tape.rows[].sourceSymbol; embedded charts use it as their source contract.
    const expectedTapeSourceSymbols = new Map(Object.entries({
      SPX: '^GSPC',
      NDX: '^NDX',
      DJI: '^DJI',
      RUT: '^RUT',
      VEA: 'VEA',
      VWO: 'VWO',
      VOX: 'VOX',
      VCR: 'VCR',
      VDC: 'VDC',
      VDE: 'VDE',
      VFH: 'VFH',
      VHT: 'VHT',
      VIS: 'VIS',
      VAW: 'VAW',
      VNQ: 'VNQ',
      SMH: 'SMH',
      VGT: 'VGT',
      VPU: 'VPU',
      DBC: 'DBC',
      PDBC: 'PDBC',
      XAU: 'GC=F',
      XAG: 'SI=F',
      CL: 'CL=F',
      VIX: '^VIX',
      USYC: 'TREASURY:CURVE',
      MOVE: '^MOVE',
      UST3M: 'TREASURY:3M',
      UST10Y: 'TREASURY:10Y',
      UST30Y: 'TREASURY:30Y',
      IEF: 'IEF',
      AGG: 'AGG',
      LQD: 'LQD',
      HYG: 'HYG'
    }));
    for (const [index, row] of tapeRows.entries()) {
      const ticker = String(row?.ticker ?? '').toUpperCase();
      requireString(row?.sourceSymbol, `tape.rows[${index}].sourceSymbol`);
      const expectedSource = expectedTapeSourceSymbols.get(ticker);
      if (expectedSource && row.sourceSymbol !== expectedSource) {
        errors.push(`tape.rows[${index}].sourceSymbol for ${ticker} must be ${expectedSource}.`);
      }
    }
    const expectedCryptoSourceSymbols = new Map();
    for (const [index, rowRaw] of cryptoTickerRows.entries()) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const ticker = String(row.ticker ?? '').toUpperCase();
      if (!ticker) continue;
      requireString(row.sourceSymbol, `tape.rows Crypto ${ticker}.sourceSymbol`);
      if (row.sourceSymbol) expectedCryptoSourceSymbols.set(ticker, row.sourceSymbol);
    }
    const expectedChartSourceSymbols = new Map([
      ...expectedTapeSourceSymbols.entries(),
      ...expectedCryptoSourceSymbols.entries()
    ]);

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
        if (chartData.schemaVersion !== 1) {
          errors.push('chart-data.schemaVersion must be 1.');
        }
        if (!Array.isArray(chartData.series)) {
          errors.push('chart-data.series must be an array.');
        }
        if (!Number.isFinite(Number(chartData.range?.days)) || Number(chartData.range.days) < minChartHistoryDays) {
          errors.push(`chart-data.range.days must be at least ${minChartHistoryDays} so the 5Y chart shortcut has enough embedded history.`);
        }
        const chartSeries = Array.isArray(chartData.series) ? chartData.series : [];
        const expectedSourceFamilies = new Set(chartSeries.map((item) => item?.source).filter(Boolean));
        const sourceFamilies = Array.isArray(chartData.sourceFamilies) ? chartData.sourceFamilies : [];
        if (!Array.isArray(chartData.sourceFamilies)) {
          errors.push('chart-data.sourceFamilies must list the source strings used by chart-data.series.');
        }
        for (const source of expectedSourceFamilies) {
          if (!sourceFamilies.includes(source)) errors.push(`chart-data.sourceFamilies must include ${source}.`);
        }
        for (const source of sourceFamilies) {
          if (!expectedSourceFamilies.has(source)) errors.push(`chart-data.sourceFamilies contains unused source ${source}.`);
        }
        const chartSeriesByTicker = new Map();
        for (const [index, itemRaw] of chartSeries.entries()) {
          const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
          const ticker = String(item.ticker || '').toUpperCase();
          const label = ticker || `chart-data.series[${index}]`;
          if (!ticker) errors.push(`chart-data.series[${index}].ticker must be populated.`);
          if (chartSeriesByTicker.has(ticker)) errors.push(`Duplicate embedded chart series for ${ticker}.`);
          chartSeriesByTicker.set(ticker, item);

          const expectedSource = expectedChartSourceSymbols.get(ticker);
          if (!expectedSource) {
            errors.push(`${label} is not a required chart ticker.`);
          } else if (item.sourceSymbol !== expectedSource) {
            errors.push(`${label}.sourceSymbol must be ${expectedSource}.`);
          }
          if (!recognizedChartSources.has(item.source)) {
            errors.push(`${label}.source is not recognized.`);
          }
          if (!Array.isArray(item.bars) || item.bars.length < 2) {
            errors.push(`${label}.bars must contain at least two daily bars for the inline chart.`);
          } else {
            let previousTime = '';
            for (const [barIndex, barRaw] of item.bars.entries()) {
              const bar = barRaw && typeof barRaw === 'object' ? barRaw : {};
              const barLabel = `${label}.bars[${barIndex}]`;
              if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bar.time || ''))) {
                errors.push(`${barLabel}.time must be an ISO date.`);
              }
              if (previousTime && bar.time <= previousTime) {
                errors.push(`${barLabel}.time must be strictly ascending.`);
              }
              previousTime = bar.time;
              for (const field of ['open', 'high', 'low', 'close']) {
                if (!isFiniteNumber(bar[field])) {
                  errors.push(`${barLabel}.${field} must be numeric.`);
                }
              }
              if (!isCoherentOhlc(bar)) {
                errors.push(`${barLabel} has incoherent OHLC values.`);
              }
              if (bar.volume !== undefined && (!isFiniteNumber(bar.volume) || Number(bar.volume) < 0)) {
                errors.push(`${barLabel}.volume must be a non-negative number when present.`);
              }
              // Close-only sources intentionally duplicate close into OHLC so Lightweight Charts can render consistently.
              if (item.priceOnly && !(bar.open === bar.high && bar.high === bar.low && bar.low === bar.close)) {
                errors.push(`${barLabel} must synthesize OHLC from close for priceOnly series.`);
              }
              if (item.noVolume && bar.volume !== undefined) {
                errors.push(`${barLabel}.volume must be omitted when noVolume is true.`);
              }
              // Guard the embedded artifact against quote-only latest bars masquerading as OHLC candles.
              if (!item.priceOnly && item.dataKind === 'ohlc' && barIndex === item.bars.length - 1 && isCloseOnlyPlaceholderBar(bar)) {
                errors.push(`${barLabel} must contain real OHLC data; do not publish a latest quote-only placeholder in an OHLC series.`);
              }
            }
          }
          if (item.sourceSymbol === 'TREASURY:CURVE') {
            const curvePoints = Array.isArray(item.curvePoints) ? item.curvePoints : [];
            validateYieldCurvePointSet(label, 'curvePoints', curvePoints);
            validateYieldCurveComparisons(label, item, curvePoints);
            const curveSpread = item.curveSpread && typeof item.curveSpread === 'object' ? item.curveSpread : {};
            if (curveSpread.label !== '2s10s') {
              errors.push(`${label}.curveSpread.label must be 2s10s so the row does not duplicate the 10Y Treasury quote.`);
            }
            if (!isFiniteNumber(curveSpread.valueBp)) {
              errors.push(`${label}.curveSpread.valueBp must be numeric.`);
            }
          }
        }

        for (const ticker of expectedChartSourceSymbols.keys()) {
          if (!chartSeriesByTicker.has(ticker)) {
            errors.push(`Embedded chart data is missing ${ticker}.`);
          }
        }

        const usycQuoteRow = chartData.quoteRows?.tape?.find((row) => row?.ticker === 'USYC');
        if (usycQuoteRow && !/^2s10s [+-]\d+ bp$/.test(String(usycQuoteRow.last || ''))) {
          errors.push('Embedded chart-data quoteRows.tape USYC.last must show 2s10s spread instead of repeating the 10Y yield.');
        }

        const chartTapeQuoteRows = Array.isArray(chartData.quoteRows?.tape) ? chartData.quoteRows.tape : [];
        const chartCryptoQuoteRows = Array.isArray(chartData.quoteRows?.crypto) ? chartData.quoteRows.crypto : [];
        const chartTapeQuoteByTicker = new Map(chartTapeQuoteRows.map((row) => [String(row?.ticker || '').toUpperCase(), row]));
        const chartCryptoQuoteByTicker = new Map(chartCryptoQuoteRows.map((row) => [String(row?.ticker || row?.sym || '').toUpperCase(), row]));
        for (const [ticker, item] of chartSeriesByTicker.entries()) {
          if (item?.section === 'crypto') {
            const chartRow = chartCryptoQuoteByTicker.get(ticker);
            const expected = cryptoQuoteRowFromSeries(item);
            if (!chartRow || !expected) continue;
            for (const [chartField, expectedField] of [['price', 'price'], ['delta', 'delta'], ['chg', 'chg'], ['dir', 'dir'], ['asOf', 'asOf']]) {
              const actual = String(chartRow?.[chartField] ?? '');
              const derived = String(expected?.[expectedField] ?? '');
              if (actual !== derived) {
                errors.push(`Embedded chart-data quoteRows.crypto ${ticker}.${chartField} must match the latest embedded series bar-derived value "${derived}".`);
              }
            }
            continue;
          }
          const chartRow = chartTapeQuoteByTicker.get(ticker);
          const expected = quoteRowFromSeries(item);
          if (!chartRow || !expected) continue;
          for (const field of ['last', 'delta', 'pct', 'dir', 'asOf']) {
            const actual = String(chartRow?.[field] ?? '');
            const derived = String(expected?.[field] ?? '');
            if (actual !== derived) {
              errors.push(`Embedded chart-data quoteRows.tape ${ticker}.${field} must match the latest embedded series bar-derived value "${derived}".`);
            }
          }
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

        // These sources are price-only or lack usable volume; the UI depends on noVolume for the one-pane chart layout.
        for (const ticker of ['USYC', 'UST3M', 'UST10Y', 'UST30Y', 'VIX', 'MOVE']) {
          const item = chartSeriesByTicker.get(ticker);
          if (item && item.noVolume !== true) {
            errors.push(`Embedded Tape chart data for ${ticker} must mark noVolume true for the chart hint/volume-pane contract.`);
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
      if (!Number.isFinite(Number(future.raw?.previousClose))) {
        errors.push(`futuresModule.futures[${index}].raw.previousClose must be numeric for futures source prior-close provenance.`);
      }
      const referencePrice = Number(future.raw?.referencePrice ?? future.raw?.previousClose);
      if (!Number.isFinite(referencePrice)) {
        errors.push(`futuresModule.futures[${index}].raw reference price must be numeric for the futures chart baseline.`);
      }
      if (!Number.isFinite(Number(future.raw?.price))) {
        errors.push(`futuresModule.futures[${index}].raw.price must be numeric.`);
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
        if (!Number.isFinite(Number(future.raw?.referencePrice))) {
          errors.push(`futuresModule.futures[${index}].raw.referencePrice must be numeric for Session Futures.`);
        }
        if (!Number.isFinite(Number(future.raw?.sessionOpen))) {
          errors.push(`futuresModule.futures[${index}].raw.sessionOpen must be numeric for Session Futures.`);
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
    for (const [index, storyRaw] of futuresModuleStories.entries()) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      requireString(story.tag, `futuresModule.stories[${index}].tag`);
      if (String(story.tag || '').trim().length > maxFuturesStoryTagLength) {
        errors.push(`futuresModule.stories[${index}].tag must be ${maxFuturesStoryTagLength} characters or fewer to preserve the shared story-label column.`);
      }
      requireString(story.title, `futuresModule.stories[${index}].title`);
      requireString(story.body, `futuresModule.stories[${index}].body`);
      requireHttpsUrl(story.url, `futuresModule.stories[${index}]`);
      validateStoryFreshness(story, `futuresModule.stories[${index}]`);
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
      if (row.ticker === 'USYC' && !/^2s10s [+-]\d+ bp$/.test(String(row.last || ''))) {
        errors.push('Tape row USYC.last must show 2s10s spread instead of repeating the 10Y yield.');
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
      for (const error of validateEarningsWeekPayload(earningsWeek, { requireNarrative: true })) {
        errors.push(`earnings.week: ${error}`);
      }
      if (!isMondayFridayRange(earningsWeek.range)) {
        errors.push('earnings.week.range must cover exactly Monday through Friday.');
      }
    } else {
      errors.push('earnings.week is required.');
    }

    const weekRows = Array.isArray(data.weekAhead?.rows) ? data.weekAhead.rows : [];
    if (!weekRows.length) {
      errors.push('weekAhead.rows must contain at least one calendar row.');
    }
    for (const [index, rowRaw] of weekRows.entries()) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      requireString(row.day, `weekAhead.rows[${index}].day`);
      requireString(row.event, `weekAhead.rows[${index}].event`);
      requireString(row.tickers, `weekAhead.rows[${index}].tickers`);
    }
  }
}

if (errors.length) {
  console.error('Dashboard validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (warnings.length) {
  console.warn('Dashboard validation warnings:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log('Dashboard validation OK');
