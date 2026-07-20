#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { atomicWriteJson } = require('./staging_writer');
const {
  EARNINGS_WEEK_SCHEMA_VERSION,
  attachReactions,
  buildCompanyReleaseTasks,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  DISPLAY_MIN_MARKET_CAP,
  earningsApiDayEntry,
  earningsApiUsageDay,
  emptyEarningsApiUsage,
  hasEarningsApiBudget,
  isDisplayEligibleEarningsRow,
  isEarningsApiUsage,
  migrateEarningsApiUsage,
  metricResult,
  normalizeEarningsTiming,
  normalizeFinnhubCalendarFields,
  numberOrNull,
  pctChange,
  recordEarningsApiRequest,
  recordEarningsApiResponse
} = require('./earnings_week_contract');
const {
  addDays,
  compareIsoDate,
  dateFromIso,
  displayDatesForRange,
  isIsoDate,
  isoFromDate,
  isSupportedFiveTradingDayRange
} = require('./calendar_contract');

const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'earnings_week.json');
const DEFAULT_FINNHUB_DELAY_MS = 700;
const DEFAULT_FINNHUB_PROFILE_RETRIES = 3;
const DEFAULT_FINNHUB_METRIC_DELAY_MS = 2000;
const DEFAULT_FINNHUB_METRIC_RETRIES = 3;
const DEFAULT_FINNHUB_PROFILE_CACHE = path.resolve(process.cwd(), 'generated', 'finnhub_profile_cache.json');
const DEFAULT_FINNHUB_US_SYMBOL_CACHE = path.resolve(process.cwd(), 'generated', 'finnhub_us_symbol_cache.json');
const DEFAULT_FINNHUB_METRIC_CACHE = path.resolve(process.cwd(), 'generated', 'finnhub_metric_cache.json');
const DEFAULT_EARNINGSAPI_USAGE = path.resolve(process.cwd(), 'generated', 'earningsapi_usage.json');
const DEFAULT_EARNINGSAPI_DAILY_LIMIT = 100;
const DEFAULT_EARNINGSAPI_RESERVE = 20;
const DEFAULT_SCHEDULE_CONFIRMATIONS = path.resolve(process.cwd(), 'generated', 'earnings_schedule_confirmations.json');
const DEFAULT_SCHEDULE_REVIEW = path.resolve(process.cwd(), 'generated', 'earnings_schedule_review.json');
const SECONDARY_RECOVERY_MIN_MARKET_CAP = DISPLAY_MIN_MARKET_CAP;
const CALENDAR_VERIFICATION_LOOKBACK_DAYS = 7;
const CALENDAR_VERIFICATION_LOOKAHEAD_DAYS = 14;
const REACTION_LOOKBACK_DAYS = 5;
const REACTION_LOOKAHEAD_DAYS = 5;
const ALPHA_VANTAGE_CALENDAR_AUDIT = 'alphaVantageCalendar';

function yahooPeriodSeconds(isoDate) {
  return Math.floor(dateFromIso(isoDate).getTime() / 1000);
}

async function fetchYahooBars(symbol, from, to, args, fetchJson) {
  if (typeof fetchJson !== 'function') throw new TypeError('fetchYahooBars requires a fetchJson function.');
  const start = addDays(from, -REACTION_LOOKBACK_DAYS);
  const endExclusive = addDays(to, REACTION_LOOKAHEAD_DAYS + 1);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${yahooPeriodSeconds(start)}&period2=${yahooPeriodSeconds(endExclusive)}&interval=1d&events=history`;
  const result = await fetchJson(url, args, { Accept: 'application/json,text/plain,*/*' });
  const chart = result.data?.chart;
  const item = chart?.result?.[0];
  const timestamps = Array.isArray(item?.timestamp) ? item.timestamp : [];
  const quote = item?.indicators?.quote?.[0] || {};
  const bars = timestamps.map((timestamp, index) => ({
    date: isoFromDate(new Date(timestamp * 1000)),
    open: numberOrNull(quote.open?.[index]),
    high: numberOrNull(quote.high?.[index]),
    low: numberOrNull(quote.low?.[index]),
    close: numberOrNull(quote.close?.[index]),
    volume: numberOrNull(quote.volume?.[index])
  })).filter((bar) => bar.close !== null);
  return {
    symbol,
    ok: result.ok && bars.length > 0,
    status: result.status,
    responseMs: result.ms,
    bars,
    error: result.ok
      ? ''
      : result.error || result.parseError || result.bodyPreview || chart?.error?.description || `HTTP ${result.status}`
  };
}

async function fetchYahooBarsForRows(rows, args, fetchJson) {
  const output = new Array(rows.length);
  let next = 0;
  async function run() {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index];
      output[index] = await fetchYahooBars(row.symbol, args.from, args.to, args, fetchJson);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, run));
  return output;
}

function needsYahooReactionFetch(row) {
  return row?.reportTiming !== 'unknown'
    && (Number.isFinite(row?.eps?.actual) || Number.isFinite(row?.revenue?.actual));
}

function parseArgs(argv) {
  const args = {
    from: '',
    to: '',
    output: DEFAULT_OUTPUT,
    asOf: new Date().toISOString(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    finnhubDelayMs: DEFAULT_FINNHUB_DELAY_MS,
    finnhubProfileRetries: DEFAULT_FINNHUB_PROFILE_RETRIES,
    finnhubProfileCache: DEFAULT_FINNHUB_PROFILE_CACHE,
    finnhubUsSymbolCache: DEFAULT_FINNHUB_US_SYMBOL_CACHE,
    finnhubMetricDelayMs: DEFAULT_FINNHUB_METRIC_DELAY_MS,
    finnhubMetricRetries: DEFAULT_FINNHUB_METRIC_RETRIES,
    finnhubMetricCache: DEFAULT_FINNHUB_METRIC_CACHE,
    earningsApiUsage: DEFAULT_EARNINGSAPI_USAGE,
    earningsApiDailyLimit: DEFAULT_EARNINGSAPI_DAILY_LIMIT,
    earningsApiReserve: DEFAULT_EARNINGSAPI_RESERVE,
    scheduleConfirmations: DEFAULT_SCHEDULE_CONFIRMATIONS,
    scheduleReview: DEFAULT_SCHEDULE_REVIEW,
    useEarningsApi: false,
    skipEarningsApi: false,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') {
      args.from = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--to') {
      args.to = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--as-of') {
      args.asOf = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--finnhub-delay-ms') {
      args.finnhubDelayMs = Math.max(0, Number(argv[i + 1] || DEFAULT_FINNHUB_DELAY_MS));
      i += 1;
      continue;
    }
    if (arg === '--finnhub-profile-retries') {
      args.finnhubProfileRetries = Math.max(0, Math.floor(Number(argv[i + 1] || DEFAULT_FINNHUB_PROFILE_RETRIES)));
      i += 1;
      continue;
    }
    if (arg === '--finnhub-profile-cache') {
      args.finnhubProfileCache = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_FINNHUB_PROFILE_CACHE);
      i += 1;
      continue;
    }
    if (arg === '--finnhub-us-symbol-cache') {
      args.finnhubUsSymbolCache = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_FINNHUB_US_SYMBOL_CACHE);
      i += 1;
      continue;
    }
    if (arg === '--finnhub-metric-delay-ms') {
      args.finnhubMetricDelayMs = Math.max(0, Number(argv[i + 1] || DEFAULT_FINNHUB_METRIC_DELAY_MS));
      i += 1;
      continue;
    }
    if (arg === '--finnhub-metric-retries') {
      args.finnhubMetricRetries = Math.max(0, Math.floor(Number(argv[i + 1] || DEFAULT_FINNHUB_METRIC_RETRIES)));
      i += 1;
      continue;
    }
    if (arg === '--finnhub-metric-cache') {
      args.finnhubMetricCache = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_FINNHUB_METRIC_CACHE);
      i += 1;
      continue;
    }
    if (arg === '--earningsapi-usage') {
      args.earningsApiUsage = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGSAPI_USAGE);
      i += 1;
      continue;
    }
    if (arg === '--earningsapi-daily-limit') {
      args.earningsApiDailyLimit = Math.max(0, Number(argv[i + 1] || DEFAULT_EARNINGSAPI_DAILY_LIMIT));
      i += 1;
      continue;
    }
    if (arg === '--earningsapi-reserve') {
      args.earningsApiReserve = Math.max(0, Number(argv[i + 1] || DEFAULT_EARNINGSAPI_RESERVE));
      i += 1;
      continue;
    }
    if (arg === '--schedule-confirmations') {
      args.scheduleConfirmations = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_SCHEDULE_CONFIRMATIONS);
      i += 1;
      continue;
    }
    if (arg === '--schedule-review') {
      args.scheduleReview = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_SCHEDULE_REVIEW);
      i += 1;
      continue;
    }
    if (arg === '--use-earningsapi') {
      args.useEarningsApi = true;
      continue;
    }
    if (arg === '--skip-earningsapi') {
      args.skipEarningsApi = true;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!isIsoDate(args.from) || !isIsoDate(args.to)) {
    throw new Error('Both --from and --to are required in YYYY-MM-DD format.');
  }
  if (compareIsoDate(args.from, args.to) > 0) {
    throw new Error('--from must be on or before --to.');
  }
  if (Number.isNaN(Date.parse(args.asOf))) {
    throw new Error('--as-of must be a parseable date/time.');
  }
  if (!isSupportedFiveTradingDayRange(args.from, args.to)) {
    throw new Error('Earnings range must be Monday-Friday or Friday plus next Monday-Thursday.');
  }
  args.displayDates = displayDatesForRange(args.from, args.to);

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --from YYYY-MM-DD            Monday for a Monday-Friday slate, or Friday for the bridge slate
  --to YYYY-MM-DD              Friday for a Monday-Friday slate, or following Thursday for the bridge slate
  --output PATH                Output JSON path (default: generated/earnings_week.json)
  --as-of ISO                  Build lifecycle and reaction state as of this timestamp (default: now)
  --timeout-ms 20000           HTTP timeout in ms per request
  --finnhub-delay-ms 700       Delay between Finnhub profile requests
  --finnhub-profile-retries 3  Retries for Finnhub profile requests that hit HTTP 429
  --finnhub-profile-cache PATH Successful Finnhub profile cache
  --finnhub-us-symbol-cache PATH
                               Successful Finnhub U.S. symbol-directory cache
  --finnhub-metric-delay-ms 2000
                               Delay between Finnhub metric requests and 429 retries
  --finnhub-metric-retries 3   Retries for Finnhub metric requests that hit HTTP 429
  --finnhub-metric-cache PATH  Successful Finnhub metric market-cap cache
  --earningsapi-usage PATH     EarningsAPI daily usage ledger
  --earningsapi-daily-limit    Daily EarningsAPI call cap (default: 100)
  --earningsapi-reserve 20     Calls reserved for result refreshes
  --schedule-confirmations PATH
                               Event-scoped official IR dates for conflicts, complete-response omissions, outages, and recovery rows
  --schedule-review PATH       Generated review queue for rows requiring an official date confirmation
  --use-earningsapi            Permit metered EarningsAPI usage for approved rollover/recovery only
  --skip-earningsapi           Disable secondary-source recovery
  --compact                    Print compact coverage report
  --help                       Show this help

Environment:
  FINNHUB_API_KEY              Read from .env or current environment
  ALPHA_VANTAGE_API_KEY        Used for the free secondary calendar check
  EARNINGSAPI_API_KEY          Used only with --use-earningsapi
`);
}

function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1') return;
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url, args, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Daily-Financial-Dashboard/earnings-week',
        Accept: 'application/json,text/plain,*/*',
        ...headers
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let data = null;
        let parseError = '';
        try {
          data = JSON.parse(body);
        } catch (error) {
          parseError = error.message;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300 && !parseError,
          status: res.statusCode,
          ms: Date.now() - started,
          headers: res.headers || {},
          data,
          parseError,
          bodyPreview: parseError ? body.slice(0, 240) : ''
        });
      });
    });
    req.on('error', (error) => {
      resolve({
        ok: false,
        status: 0,
        ms: Date.now() - started,
        headers: {},
        data: null,
        parseError: error.message,
        bodyPreview: ''
      });
    });
    req.setTimeout(args.timeoutMs, () => req.destroy(new Error('request timeout')));
  });
}

function fetchText(url, args, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Daily-Financial-Dashboard/earnings-week',
        Accept: 'text/csv,text/plain,*/*',
        ...headers
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          ms: Date.now() - started,
          headers: res.headers || {},
          body,
          error: res.statusCode >= 200 && res.statusCode < 300 ? '' : body.slice(0, 240)
        });
      });
    });
    req.on('error', (error) => {
      resolve({
        ok: false,
        status: 0,
        ms: Date.now() - started,
        headers: {},
        body: '',
        error: error.message
      });
    });
    req.setTimeout(args.timeoutMs, () => req.destroy(new Error('request timeout')));
  });
}

function ensureFinnhubPrimaryUsable(finnhubCalendar) {
  if (!finnhubCalendar?.ok) {
    throw new Error(`Finnhub primary calendar is unavailable. ${finnhubCalendar?.error || ''}`.trim());
  }
}

function normalizeFinnhubCalendarRow(row) {
  return {
    ...normalizeFinnhubCalendarFields(row),
    source: {
      provider: 'finnhub',
      row
    }
  };
}

function rowCompletenessScore(row) {
  return [
    row.reportTiming !== 'unknown',
    row.eps?.estimate !== null,
    row.eps?.actual !== null,
    row.revenue?.estimate !== null,
    row.revenue?.actual !== null,
    row.fiscalQuarter !== null,
    row.fiscalYear !== null
  ].filter(Boolean).length;
}

function dedupeCalendarRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.reportDate}:${row.symbol}`;
    const current = byKey.get(key);
    if (!current || rowCompletenessScore(row) > rowCompletenessScore(current)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const dateCompare = left.reportDate.localeCompare(right.reportDate);
    if (dateCompare) return dateCompare;
    return left.symbol.localeCompare(right.symbol);
  });
}

function finnhubCalendarFromResponse(result, args) {
  const hasCalendar = result.ok && Array.isArray(result.data?.earningsCalendar);
  const rawRows = hasCalendar ? result.data.earningsCalendar : [];
  const rows = dedupeCalendarRows(rawRows
    .map(normalizeFinnhubCalendarRow)
    .filter((row) => row.symbol && isIsoDate(row.reportDate))
    .filter((row) => args.displayDates.includes(row.reportDate)));
  return {
    ok: hasCalendar,
    status: result.status,
    responseMs: result.ms,
    rowCount: rows.length,
    rows,
    error: hasCalendar
      ? ''
      : result.ok
        ? 'Finnhub response is missing earningsCalendar[].'
        : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

async function fetchFinnhubCalendar(args, token) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${encodeURIComponent(args.from)}&to=${encodeURIComponent(args.to)}&token=${encodeURIComponent(token)}`;
  return finnhubCalendarFromResponse(await fetchJson(url, args), args);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      field = '';
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((item) => item !== '')) rows.push(row);
  return rows;
}

function csvObjects(text) {
  const rows = parseCsv(String(text || '').trim());
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header || '').trim());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] || '').trim()])));
}

function normalizeAlphaVantageTiming(row) {
  const raw = String(row?.timeOfDay || row?.timeOfTheDay || row?.time || row?.hour || '').trim().toLowerCase();
  if (['bmo', 'before market open', 'before-open', 'pre', 'pre-market', 'premarket'].includes(raw)) return 'bmo';
  if (['amc', 'after market close', 'after-close', 'after', 'after-hours', 'post-market', 'postmarket'].includes(raw)) return 'amc';
  if (['dmh', 'during market hours', 'during-market'].includes(raw)) return 'dmh';
  return 'unknown';
}

function normalizeAlphaVantageCalendarRow(row) {
  const fiscalQuarterEnding = String(row?.fiscalDateEnding || '').trim();
  const fiscalMonth = isIsoDate(fiscalQuarterEnding) ? Number(fiscalQuarterEnding.slice(5, 7)) : null;
  return {
    symbol: String(row?.symbol || '').trim().toUpperCase(),
    company: String(row?.name || '').trim(),
    reportDate: String(row?.reportDate || '').trim(),
    reportTiming: normalizeAlphaVantageTiming(row),
    fiscalQuarterEnding,
    fiscalQuarter: Number.isFinite(fiscalMonth) ? Math.ceil(fiscalMonth / 3) : null,
    fiscalYear: isIsoDate(fiscalQuarterEnding) ? Number(fiscalQuarterEnding.slice(0, 4)) : null,
    eps: {
      estimate: numberOrNull(row?.estimate),
      actual: null
    },
    revenue: {
      estimate: null,
      actual: null
    },
    source: {
      provider: 'alpha_vantage',
      row
    }
  };
}

function alphaVantageCalendarFromResponse(result, args, dates = calendarVerificationDates(args)) {
  const dateSet = new Set(dates);
  const rows = result.ok
    ? dedupeCalendarRows(csvObjects(result.body)
      .map(normalizeAlphaVantageCalendarRow)
      .filter((row) => row.symbol && isIsoDate(row.reportDate) && dateSet.has(row.reportDate)))
    : [];
  const rowsByDate = new Map();
  for (const row of rows) {
    if (!rowsByDate.has(row.reportDate)) rowsByDate.set(row.reportDate, []);
    rowsByDate.get(row.reportDate).push(row);
  }
  const usable = result.ok && (rows.length > 0 || csvObjects(result.body).some((row) => row.reportDate || row.symbol));
  const error = usable
    ? ''
    : result.ok
      ? String(result.body || '').trim().slice(0, 240) || 'Alpha Vantage response is missing usable EARNINGS_CALENDAR CSV rows.'
      : result.error || `HTTP ${result.status}`;
  return dates.map((date) => {
    const dayRows = rowsByDate.get(date) || [];
    return {
      date,
      ok: usable,
      skipped: false,
      status: result.status,
      responseMs: result.ms,
      provider: 'alpha_vantage',
      rowCount: dayRows.length,
      rows: dayRows,
      error
    };
  });
}

async function fetchAlphaVantageCalendar(args, token, dates = calendarVerificationDates(args)) {
  if (!token) {
    return dates.map((date) => ({
      date,
      ok: false,
      skipped: true,
      status: 0,
      responseMs: 0,
      provider: 'alpha_vantage',
      rowCount: 0,
      rows: [],
      error: 'ALPHA_VANTAGE_API_KEY is not configured.'
    }));
  }
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'EARNINGS_CALENDAR');
  url.searchParams.set('horizon', '3month');
  url.searchParams.set('apikey', token);
  return alphaVantageCalendarFromResponse(await fetchText(url.toString(), args), args, dates);
}

function readEarningsApiUsage(file) {
  if (!fs.existsSync(file)) return emptyEarningsApiUsage();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isEarningsApiUsage(data)) return data;
    if (data?.schemaVersion === 1 && data.months && typeof data.months === 'object') {
      return migrateEarningsApiUsage(data);
    }
    throw new Error('unsupported usage-ledger schema');
  } catch (error) {
    throw new Error(`EarningsAPI usage ledger is unreadable: ${file}: ${error.message}`);
  }
}

function writeEarningsApiUsage(file, usage) {
  atomicWriteJson(file, usage);
}

function earningsApiUsageForBuild(args) {
  // Ordinary builds are Finnhub-primary. Touch the paid-source ledger only when
  // the orchestrator has explicitly authorized secondary recovery.
  if (!args.useEarningsApi || args.skipEarningsApi) return emptyEarningsApiUsage();
  const usage = readEarningsApiUsage(args.earningsApiUsage);
  // Persist schema migrations before deciding whether another metered request
  // is permitted; an unreadable ledger must never become an unmetered retry.
  writeEarningsApiUsage(args.earningsApiUsage, usage);
  return usage;
}

function canUseEarningsApi(args, usage, token) {
  if (!args.useEarningsApi) return false;
  if (args.skipEarningsApi) return false;
  if (!token) return false;
  return hasEarningsApiBudget(usage, args.earningsApiDailyLimit, args.earningsApiReserve);
}

async function fetchEarningsApiJson(pathname, args, token, usage, requestType) {
  if (!canUseEarningsApi(args, usage, token)) {
    return {
      ok: false,
      skipped: true,
      status: 0,
      ms: 0,
      data: null,
      parseError: 'EarningsAPI skipped because the daily budget is unavailable or reserved.',
      bodyPreview: ''
    };
  }
  const url = new URL(pathname, 'https://api.earningsapi.com');
  url.searchParams.set('apikey', token);
  const request = recordEarningsApiRequest(usage, {
    type: requestType,
    path: url.pathname,
    queryKeys: url.searchParams.keys()
  });
  writeEarningsApiUsage(args.earningsApiUsage, usage);
  const result = await fetchJson(url.toString(), args);
  recordEarningsApiResponse(request, result);
  writeEarningsApiUsage(args.earningsApiUsage, usage);
  return result;
}

function normalizeEarningsApiTiming(value, bucket = '') {
  const raw = String(value || bucket || '').trim().toLowerCase();
  if (['bmo', 'before market open', 'before-open', 'pre', 'pre-market', 'time-pre-market'].includes(raw)) return 'bmo';
  if (['amc', 'after market close', 'after-close', 'after', 'after-hours', 'time-after-hours'].includes(raw)) return 'amc';
  if (['dmh', 'during market hours', 'during-market'].includes(raw)) return 'dmh';
  if (bucket === 'pre') return 'bmo';
  if (bucket === 'after') return 'amc';
  return 'unknown';
}

function normalizeEarningsApiRow(row, reportDate, bucket = '') {
  return {
    symbol: String(row?.symbol || row?.ticker || '').trim().toUpperCase(),
    company: String(row?.name || row?.company || '').trim(),
    reportDate: String(row?.date || reportDate || '').trim(),
    reportTiming: normalizeEarningsApiTiming(row?.time, bucket),
    eps: {
      estimate: numberOrNull(row?.epsEstimate ?? row?.epsEstimated),
      actual: numberOrNull(row?.eps ?? row?.epsActual)
    },
    revenue: {
      estimate: numberOrNull(row?.revenueEstimate ?? row?.revenueEstimated),
      actual: numberOrNull(row?.revenue ?? row?.revenueActual)
    },
    source: {
      provider: 'earningsapi',
      bucket,
      row
    }
  };
}

async function fetchEarningsApiCalendarDay(date, args, token, usage) {
  const result = await fetchEarningsApiJson(`/v1/calendar/earnings?date=${encodeURIComponent(date)}`, args, token, usage, 'calendar-day');
  const rows = [];
  if (result.ok && result.data && typeof result.data === 'object') {
    for (const bucket of ['pre', 'after', 'notSupplied']) {
      const items = Array.isArray(result.data[bucket]) ? result.data[bucket] : [];
      rows.push(...items.map((row) => normalizeEarningsApiRow(row, date, bucket)).filter((row) => row.symbol));
    }
  }
  return {
    date,
    ok: result.ok,
    skipped: Boolean(result.skipped),
    status: result.status,
    responseMs: result.ms,
    rowCount: rows.length,
    rows,
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

function calendarVerificationDates(args) {
  const dates = [];
  const first = addDays(args.from, -CALENDAR_VERIFICATION_LOOKBACK_DAYS);
  const last = addDays(args.to, CALENDAR_VERIFICATION_LOOKAHEAD_DAYS);
  for (let date = first; compareIsoDate(date, last) <= 0; date = addDays(date, 1)) dates.push(date);
  return dates;
}

async function fetchEarningsApiCalendar(args, token, usage, dates = args.displayDates, fetchDay = fetchEarningsApiCalendarDay) {
  const days = [];
  for (const date of dates) {
    const day = await fetchDay(date, args, token, usage);
    days.push(day);
    // A quota response applies to the account, not one date. Do not spend the
    // remaining daily allowance proving that every other date is also blocked.
    if (day.status === 429) break;
  }
  return days;
}

async function fetchEarningsApiCompany(symbol, args, token, usage) {
  const result = await fetchEarningsApiJson(`/v1/earnings?symbol=${encodeURIComponent(symbol)}`, args, token, usage, 'company-earnings');
  const rows = result.ok && Array.isArray(result.data)
    ? result.data.map((row) => normalizeEarningsApiRow(row, row?.date || '', '')).filter((row) => row.symbol)
    : [];
  return {
    symbol,
    ok: result.ok,
    skipped: Boolean(result.skipped),
    status: result.status,
    responseMs: result.ms,
    rows,
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

async function fetchEarningsApiCompanies(tasks, args, token, usage) {
  const output = [];
  for (const task of tasks) {
    const company = await fetchEarningsApiCompany(task.symbol, args, token, usage);
    output.push(company);
    // A quota response applies to the whole account, so further company
    // lookups would only consume (or attempt to consume) the same allowance.
    if (company.status === 429) break;
  }
  return output;
}

function profileHasIdentity(profile) {
  return Boolean(profile?.name || profile?.exchange || profile?.country || Number.isFinite(profile?.marketCap));
}

function isEligibleFinnhubUsListing(listing, symbol = listing?.symbol) {
  return Boolean(listing)
    && listing.market === 'US'
    && listing.symbol === symbol
    && Boolean(listing.mic)
    && !/OTC|PIN[XML]/i.test(listing.mic);
}

function profileIsDisplayEligible(profile, listing) {
  if (!profile) return false;
  if (!isEligibleFinnhubUsListing(listing, profile.symbol)) return false;
  if ((profile.industry || '').toUpperCase() === 'N/A') return false;
  return Number.isFinite(profile.marketCap) && profile.marketCap >= SECONDARY_RECOVERY_MIN_MARKET_CAP;
}

function secondaryRecoveryPriority(row, profile) {
  const marketCap = Number.isFinite(profile?.marketCap) ? profile.marketCap : row.marketCap;
  if (Number.isFinite(marketCap) && marketCap >= 10000000000) return 'high';
  return 'normal';
}

function compactCalendarSnapshot(row) {
  return {
    reportDate: row.reportDate,
    reportTiming: row.reportTiming,
    company: row.company || '',
    marketCap: row.marketCap ?? null,
    marketCapDisplay: row.marketCapDisplay || marketCapDisplay(row.marketCap),
    eps: {
      estimate: row.eps?.estimate ?? null,
      actual: row.eps?.actual ?? null
    },
    revenue: {
      estimate: row.revenue?.estimate ?? null,
      actual: row.revenue?.actual ?? null
    }
  };
}

function secondaryCalendarAuditKey(row) {
  if (row?.source?.provider !== 'alpha_vantage') {
    throw new Error('Secondary calendar rows must come from Alpha Vantage.');
  }
  return ALPHA_VANTAGE_CALENDAR_AUDIT;
}

function compactSecondaryCalendarAudit(row) {
  if (!row) return null;
  return {
    reportDate: row.reportDate,
    company: row.company,
    reportTiming: row.reportTiming,
    fiscalQuarterEnding: row.fiscalQuarterEnding || '',
    epsEstimate: row.eps?.estimate ?? null,
    currency: row.source?.row?.currency || ''
  };
}

function cloneCalendarDay(day, rows) {
  return {
    ...day,
    rowCount: rows.length,
    rows
  };
}

function providerDateConflictAudit(symbol, finnhubRows, secondaryRows, selectedDate) {
  const secondaryKey = secondaryCalendarAuditKey(secondaryRows[0]);
  return {
    symbol,
    status: 'fallback',
    selectedDate,
    selectedProvider: 'finnhub',
    selectedDateSource: 'finnhub_fallback',
    reason: 'provider_date_conflict_finnhub_retained',
    candidates: {
      finnhub: finnhubRows.map(compactCalendarSnapshot),
      [secondaryKey]: secondaryRows.map(compactCalendarSnapshot)
    }
  };
}

function resolveProviderDateConflicts(finnhubRows, secondaryCalendarDays) {
  const originalFinnhubRowsBySymbol = new Map();
  for (const row of finnhubRows) {
    if (!originalFinnhubRowsBySymbol.has(row.symbol)) originalFinnhubRowsBySymbol.set(row.symbol, []);
    originalFinnhubRowsBySymbol.get(row.symbol).push({ ...row });
  }

  const secondaryRowsBySymbol = new Map();
  for (const row of secondaryCalendarDays.flatMap((day) => day.rows || [])) {
    if (!secondaryRowsBySymbol.has(row.symbol)) secondaryRowsBySymbol.set(row.symbol, []);
    secondaryRowsBySymbol.get(row.symbol).push(row);
  }

  const conflictsBySymbol = new Map();
  const resolvedFinnhubRows = finnhubRows.map((row) => ({ ...row }));
  for (const row of resolvedFinnhubRows) {
    const secondaryRows = secondaryRowsBySymbol.get(row.symbol) || [];
    const conflictingSecondaryRows = secondaryRows.filter((item) => item.reportDate !== row.reportDate);
    if (conflictingSecondaryRows.length) {
      const finnhubRowsForSymbol = resolvedFinnhubRows.filter((item) => item.symbol === row.symbol);
      const originalFinnhubRowsForSymbol = originalFinnhubRowsBySymbol.get(row.symbol) || finnhubRowsForSymbol;
      const audit = providerDateConflictAudit(
        row.symbol,
        originalFinnhubRowsForSymbol,
        conflictingSecondaryRows,
        row.reportDate
      );
      for (const item of finnhubRowsForSymbol) item.providerDateConflict = audit;
      conflictsBySymbol.set(row.symbol, audit);
      continue;
    }

    const timingFallback = secondaryRows.find((item) =>
      item.reportDate === row.reportDate
      && row.reportTiming === 'unknown'
      && item.reportTiming !== 'unknown'
    );
    if (timingFallback) row.secondaryCalendarTimingFallback = timingFallback;
  }

  const resolvedSecondaryCalendarDays = secondaryCalendarDays.map((day) => {
    const rows = (day.rows || []).filter((row) => !conflictsBySymbol.has(row.symbol));
    return cloneCalendarDay(day, rows);
  });

  return {
    finnhubRows: dedupeCalendarRows(resolvedFinnhubRows),
    secondaryCalendarDays: resolvedSecondaryCalendarDays,
    providerDateConflicts: [...conflictsBySymbol.values()]
  };
}

function readScheduleConfirmations(file) {
  if (!fs.existsSync(file)) return { rows: [], diagnostics: [] };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      rows: [],
      diagnostics: [{ code: 'confirmation_file_invalid_json', message: error.message }]
    };
  }
  if (payload?.schemaVersion !== 2 || !Array.isArray(payload.rows)) {
    return {
      rows: [],
      diagnostics: [{
        code: 'confirmation_file_invalid_contract',
        message: 'earnings_schedule_confirmations.json must contain schemaVersion 2 and event-scoped rows[].'
      }]
    };
  }
  const diagnostics = [];
  const rowsByEvent = new Map();
  payload.rows.forEach((row, index) => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const primaryDate = String(row?.primaryDate || '').trim();
    const reportDate = String(row?.reportDate || '').trim();
    const sourceUrl = String(row?.sourceUrl || '').trim();
    const sourceName = String(row?.sourceName || '').trim();
    if (!/^[A-Z0-9.-]+$/.test(symbol) || !isIsoDate(primaryDate) || !isIsoDate(reportDate) || !/^https:\/\//.test(sourceUrl) || !sourceName) {
      diagnostics.push({
        code: 'confirmation_row_invalid',
        rowIndex: index,
        message: `rows[${index}] must provide symbol, ISO primaryDate, ISO reportDate, sourceName, and HTTPS sourceUrl.`
      });
      return;
    }
    // The provider's original date identifies one earnings event. Symbol-only
    // confirmations would let an old quarter silently affect a later slate.
    const key = `${symbol}:${primaryDate}`;
    if (!rowsByEvent.has(key)) rowsByEvent.set(key, []);
    rowsByEvent.get(key).push({ symbol, primaryDate, reportDate, sourceUrl, sourceName });
  });
  const rows = [];
  for (const [key, candidates] of rowsByEvent) {
    if (candidates.length === 1) rows.push(candidates[0]);
    else diagnostics.push({
      code: 'confirmation_event_duplicate',
      event: key,
      message: `Duplicate confirmations for ${key} were ignored.`
    });
  }
  return { rows, diagnostics };
}

function scheduleAudit(status, row, secondaryDates, official = null) {
  return {
    status,
    primaryDate: row.reportDate,
    secondaryDates,
    official
  };
}

function officialScheduleReview(row, secondaryDates, reason) {
  return {
    symbol: row.symbol,
    company: row.company,
    primaryDate: row.reportDate,
    secondaryDates,
    reason,
    required: 'company_investor_relations_then_sec_date_confirmation',
    sourceOrder: ['company_investor_relations', 'sec_filing']
  };
}

function verifyFinnhubScheduleRows(rows, secondaryCalendarDays, range, confirmations = []) {
  const activeDates = new Set(displayDatesForRange(range.from, range.to));
  const secondaryCalendarComplete = [...activeDates].every((date) =>
    secondaryCalendarDays.some((day) => day.date === date && day.ok)
  );
  const secondaryCalendarUnavailable = secondaryCalendarDays.some((day) => day?.ok === false);
  const secondaryDatesBySymbol = new Map();
  for (const candidate of secondaryCalendarDays.flatMap((day) => day.rows || [])) {
    if (!secondaryDatesBySymbol.has(candidate.symbol)) secondaryDatesBySymbol.set(candidate.symbol, new Set());
    secondaryDatesBySymbol.get(candidate.symbol).add(candidate.reportDate);
  }
  const confirmationsByEvent = new Map(confirmations.map((row) => [`${row.symbol}:${row.primaryDate}`, row]));
  const review = [];
  const verifiedRows = [];

  for (const row of rows) {
    if (!isDisplayEligibleEarningsRow(row)) continue;
    const secondaryDates = [...(secondaryDatesBySymbol.get(row.symbol) || new Set())].sort();
    const confirmation = confirmationsByEvent.get(`${row.symbol}:${row.reportDate}`) || null;
    const datesAgree = secondaryDates.length === 1 && secondaryDates[0] === row.reportDate;
    const hasCrossWeekConflict = secondaryDates.some((date) => !activeDates.has(date));
    const hasInWeekConflict = secondaryDates.length > 0 && !datesAgree && !hasCrossWeekConflict;

    // Provider agreement is sufficient corroboration; IR evidence is a fallback
    // for this event, not a standing ticker-level override.
    if (datesAgree) {
      verifiedRows.push({
        ...row,
        sourceAudit: {
          ...row.sourceAudit,
          scheduleVerification: scheduleAudit('corroborated', row, secondaryDates)
        }
      });
      continue;
    }
    // Consult event-scoped IR only after the secondary attempt did not produce
    // agreement. This covers real conflicts, complete-response omissions, and
    // optional promotion during an outage without making IR a primary source.
    if (confirmation && activeDates.has(confirmation.reportDate)) {
      verifiedRows.push({
        ...row,
        reportDate: confirmation.reportDate,
        sourceAudit: {
          ...row.sourceAudit,
          scheduleVerification: scheduleAudit('official_confirmed', row, secondaryDates, confirmation)
        }
      });
      continue;
    }
    if (confirmation && !activeDates.has(confirmation.reportDate)) continue;
    const reason = secondaryCalendarUnavailable
      ? 'secondary_calendar_unavailable'
      : hasCrossWeekConflict
      ? 'cross_week_calendar_date_conflict'
      : hasInWeekConflict
        ? 'in_week_calendar_date_conflict'
        : 'uncorroborated_primary_calendar_date';
    // A missing or conflicting secondary date is not evidence that Finnhub is
    // wrong. Keep its row as the fail-open primary while retaining actionable
    // review evidence for a later official upgrade or exclusion.
    verifiedRows.push({
      ...row,
      sourceStatus: 'partial',
      sourceAudit: {
        ...row.sourceAudit,
        scheduleVerification: scheduleAudit('primary_only', row, secondaryDates)
      }
    });
    if (secondaryCalendarComplete || secondaryDates.length > 0 || secondaryCalendarUnavailable) {
      review.push(officialScheduleReview(row, secondaryDates, reason));
    }
  }
  return { rows: verifiedRows, review };
}

function verifyEarningsApiRecoveryRows(rows, range, confirmations = [], candidates = []) {
  const activeDates = new Set(displayDatesForRange(range.from, range.to));
  const confirmationsByEvent = new Map(confirmations.map((row) => [`${row.symbol}:${row.primaryDate}`, row]));
  const verifiedRows = [];
  const review = [];
  const rowKeys = new Set(rows.map((row) => `${row.reportDate}:${row.symbol}`));
  for (const row of rows) {
    if (!isDisplayEligibleEarningsRow(row)) continue;
    const confirmation = confirmationsByEvent.get(`${row.symbol}:${row.reportDate}`) || null;
    if (confirmation && activeDates.has(confirmation.reportDate)) {
      verifiedRows.push({
        ...row,
        reportDate: confirmation.reportDate,
        sourceAudit: {
          ...row.sourceAudit,
          scheduleVerification: scheduleAudit('official_confirmed', row, [], confirmation)
        }
      });
      continue;
    }
    if (confirmation) continue;
    // The calendar and company endpoints independently agree on the same event.
    // Publish it with degraded provenance while retaining the IR review request.
    verifiedRows.push({
      ...row,
      sourceStatus: 'partial',
      sourceAudit: {
        ...row.sourceAudit,
        scheduleVerification: scheduleAudit('secondary_only', row, [])
      }
    });
    review.push(officialScheduleReview(row, [], 'uncorroborated_secondary_recovery_date'));
  }
  for (const candidate of candidates) {
    const key = `${candidate.reportDate}:${candidate.symbol}`;
    if (rowKeys.has(key)) continue;
    const confirmation = confirmationsByEvent.get(`${candidate.symbol}:${candidate.reportDate}`) || null;
    if (confirmation && !activeDates.has(confirmation.reportDate)) continue;
    review.push({
      symbol: candidate.symbol,
      company: candidate.company,
      primaryDate: candidate.reportDate,
      secondaryDates: [],
      reason: 'earningsapi_company_date_unavailable',
      required: 'matching_earningsapi_company_date'
    });
  }
  return { rows: verifiedRows, review };
}

function buildSecondaryRecoveryCandidates(finnhubRows, secondaryCalendarDays, profiles, usListings = []) {
  const finnhubKeys = new Set(finnhubRows.map((row) => `${row.reportDate}:${row.symbol}`));
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const usListingsBySymbol = new Map(usListings.map((listing) => [listing.symbol, listing]));
  const seen = new Set();
  const tasks = [];
  for (const row of secondaryCalendarDays.flatMap((day) => day.rows)) {
    const key = `${row.reportDate}:${row.symbol}`;
    if (finnhubKeys.has(key)) continue;
    if (seen.has(key)) continue;
    const profile = profilesBySymbol.get(row.symbol);
    const finnhubUsListing = usListingsBySymbol.get(row.symbol) || null;
    if (!profileIsDisplayEligible(profile, finnhubUsListing)) continue;
    seen.add(key);
    const calendarAuditKey = secondaryCalendarAuditKey(row);
    tasks.push({
      id: `${row.reportDate}:${row.symbol}:earningsapi-recovery`,
      symbol: row.symbol,
      company: profile?.name || row.company || row.symbol,
      reportDate: row.reportDate,
      trigger: `missing_from_finnhub_but_present_in_${calendarAuditKey}`,
      priority: secondaryRecoveryPriority(row, profile),
      marketCap: profile.marketCap,
      marketCapDisplay: marketCapDisplay(profile.marketCap),
      fiscalQuarterEnding: row.fiscalQuarterEnding || '',
      neededFields: [
        'earningsApiCompanyRow',
        'reportTiming',
        'eps.estimate',
        'eps.actual',
        'revenue.estimate',
        'revenue.actual'
      ],
      preferredSources: [
        'EarningsAPI company earnings endpoint'
      ],
      doNotUseForOverrides: ['finnhub_calendar_row'],
      instructions: 'Use EarningsAPI only to recover display-scale events missing from Finnhub after the secondary calendar finds them. Do not override Finnhub rows.',
      permittedUses: [
        'missing_row_discovery',
        'eps_estimate_recovery',
        'eps_actual_recovery',
        'revenue_estimate_recovery',
        'revenue_actual_recovery'
      ],
      sourceAudit: {
        finnhubUsListing,
        [calendarAuditKey]: compactSecondaryCalendarAudit(row),
        finnhubCalendar: {
          present: false
        },
        finnhubProfile: {
          status: profile.status,
          ok: profile.ok,
          name: profile.name,
          ticker: profile.ticker,
          exchange: profile.exchange,
          country: profile.country,
          currency: profile.currency,
          marketCap: profile.marketCap,
          marketCapMillions: profile.marketCapMillions,
          shareOutstanding: profile.shareOutstanding,
          industry: profile.industry,
          cacheHit: Boolean(profile.cacheHit),
          staleProfileFallback: Boolean(profile.staleProfileFallback),
          rateLimited: Boolean(profile.rateLimited),
          attempts: profile.attempts || 1,
          error: profile.error
        }
      }
    });
  }
  return tasks.sort((left, right) => {
    const priorityCompare = (left.priority === 'high' ? 0 : 1) - (right.priority === 'high' ? 0 : 1);
    if (priorityCompare) return priorityCompare;
    const capCompare = (right.marketCap || 0) - (left.marketCap || 0);
    if (capCompare) return capCompare;
    return left.symbol.localeCompare(right.symbol);
  });
}

function normalizeProfile(symbol, result) {
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const marketCapMillions = numberOrNull(data.marketCapitalization);
  return {
    symbol,
    ok: result.ok && Object.keys(data).length > 0,
    status: result.status,
    responseMs: result.ms,
    name: String(data.name || '').trim(),
    ticker: String(data.ticker || '').trim().toUpperCase(),
    exchange: String(data.exchange || '').trim(),
    country: String(data.country || '').trim(),
    currency: String(data.currency || '').trim(),
    marketCap: marketCapMillions === null ? null : marketCapMillions * 1000000,
    marketCapMillions,
    shareOutstanding: numberOrNull(data.shareOutstanding),
    industry: String(data.finnhubIndustry || '').trim(),
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`,
    source: {
      provider: 'finnhub',
      row: data
    }
  };
}

function compactFinnhubUsListing(row) {
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  return {
    market: 'US',
    symbol,
    displaySymbol: String(row?.displaySymbol || symbol).trim().toUpperCase(),
    mic: String(row?.mic || '').trim().toUpperCase(),
    type: String(row?.type || '').trim(),
    currency: String(row?.currency || '').trim().toUpperCase(),
    figi: String(row?.figi || '').trim(),
    shareClassFIGI: String(row?.shareClassFIGI || '').trim()
  };
}

function finnhubUsSymbolsFromResponse(result) {
  const rawRows = result.ok && Array.isArray(result.data) ? result.data : [];
  const bySymbol = new Map();
  for (const row of rawRows) {
    const listing = compactFinnhubUsListing(row);
    if (!listing.symbol) continue;
    const current = bySymbol.get(listing.symbol);
    if (!current || (!isEligibleFinnhubUsListing(current) && isEligibleFinnhubUsListing(listing))) {
      bySymbol.set(listing.symbol, listing);
    }
  }
  const listings = [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    ok: result.ok && Array.isArray(result.data) && listings.length > 0,
    status: result.status,
    responseMs: result.ms,
    cacheHit: false,
    listings,
    error: result.ok
      ? Array.isArray(result.data) ? listings.length ? '' : 'Finnhub U.S. symbol directory is empty.' : 'Finnhub response is not an array.'
      : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

function readFinnhubUsSymbolCache(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache?.schemaVersion !== 1 || !Array.isArray(cache.listings) || !cache.listings.length) return null;
    const listings = cache.listings.map(compactFinnhubUsListing).filter((listing) => listing.symbol);
    return listings.length ? { listings, updatedAt: String(cache.updatedAt || '') } : null;
  } catch {
    return null;
  }
}

function writeFinnhubUsSymbolCache(file, directory) {
  if (!file) return;
  try {
    atomicWriteJson(file, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      listings: directory.listings
    });
  } catch (error) {
    process.stderr.write(`Finnhub U.S. symbol cache could not be refreshed; continuing without the cache update: ${error.message}\n`);
  }
}

async function fetchFinnhubUsSymbols(args, token) {
  const url = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${encodeURIComponent(token)}`;
  let result = await fetchJson(url, args);
  if (result.status >= 300 && result.status < 400 && result.headers?.location) {
    result = await fetchJson(new URL(result.headers.location, url).toString(), args);
  }
  const directory = finnhubUsSymbolsFromResponse(result);
  if (directory.ok) {
    writeFinnhubUsSymbolCache(args.finnhubUsSymbolCache, directory);
    return directory;
  }
  const cached = readFinnhubUsSymbolCache(args.finnhubUsSymbolCache);
  return cached ? {
    ...directory,
    ok: true,
    cacheHit: true,
    listings: cached.listings,
    cacheUpdatedAt: cached.updatedAt
  } : directory;
}

function emptyFinnhubProfileCache() {
  return {
    schemaVersion: 1,
    updatedAt: '',
    profiles: {}
  };
}

function readFinnhubProfileCache(file) {
  if (!file || !fs.existsSync(file)) return emptyFinnhubProfileCache();
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache?.schemaVersion !== 1 || !cache.profiles || typeof cache.profiles !== 'object') {
      return emptyFinnhubProfileCache();
    }
    return cache;
  } catch {
    return emptyFinnhubProfileCache();
  }
}

function writeFinnhubProfileCache(file, cache) {
  if (!file) return;
  try {
    atomicWriteJson(file, cache);
  } catch (error) {
    process.stderr.write(`Finnhub profile cache could not be refreshed; continuing without the cache update: ${error.message}\n`);
  }
}

function profileFromCache(symbol, cache, fallback = {}) {
  const cached = cache.profiles?.[symbol];
  if (!cached) return null;
  const marketCapMillions = numberOrNull(cached.marketCapMillions);
  const profile = {
    symbol,
    ok: true,
    status: 200,
    responseMs: 0,
    cacheHit: true,
    staleProfileFallback: Boolean(fallback.rateLimited || fallback.error),
    attempts: fallback.attempts || 0,
    rateLimited: Boolean(fallback.rateLimited),
    name: String(cached.name || '').trim(),
    ticker: String(cached.ticker || symbol).trim().toUpperCase(),
    exchange: String(cached.exchange || '').trim(),
    country: String(cached.country || '').trim(),
    currency: String(cached.currency || '').trim(),
    marketCap: marketCapMillions === null ? null : marketCapMillions * 1000000,
    marketCapMillions,
    shareOutstanding: numberOrNull(cached.shareOutstanding),
    industry: String(cached.industry || '').trim(),
    error: fallback.error || '',
    source: {
      provider: 'finnhub',
      endpoint: 'stock/profile2',
      cacheHit: true,
      fetchedAt: String(cached.fetchedAt || ''),
      row: {
        name: cached.name,
        ticker: cached.ticker,
        exchange: cached.exchange,
        country: cached.country,
        currency: cached.currency,
        marketCapitalization: marketCapMillions,
        shareOutstanding: cached.shareOutstanding,
        finnhubIndustry: cached.industry
      }
    }
  };
  return profileHasIdentity(profile) ? profile : null;
}

function storeProfileInCache(profile, cache) {
  if (!profile?.ok || !profileHasIdentity(profile)) return false;
  const next = {
    name: profile.name,
    ticker: profile.ticker,
    exchange: profile.exchange,
    country: profile.country,
    currency: profile.currency,
    marketCapMillions: profile.marketCapMillions,
    shareOutstanding: profile.shareOutstanding,
    industry: profile.industry,
    fetchedAt: new Date().toISOString()
  };
  const previous = cache.profiles[profile.symbol];
  if (previous && JSON.stringify({ ...previous, fetchedAt: '' }) === JSON.stringify({ ...next, fetchedAt: '' })) return false;
  cache.profiles[profile.symbol] = next;
  cache.updatedAt = new Date().toISOString();
  return true;
}

async function fetchFinnhubProfile(symbol, args, token, cache) {
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  let profile = null;
  for (let attempt = 0; attempt <= args.finnhubProfileRetries; attempt += 1) {
    const result = await fetchJson(url, args);
    profile = normalizeProfile(symbol, result);
    profile.attempts = attempt + 1;
    profile.rateLimited = result.status === 429;
    if (profile.ok || result.status !== 429 || attempt === args.finnhubProfileRetries) break;
    await sleep(retryAfterDelayMs(result.headers, args.finnhubDelayMs));
  }
  if (profile?.ok && profileHasIdentity(profile)) {
    return profile;
  }
  // Cache is deliberately stale-profile fallback, not a quota-avoidance primary.
  // Live profile2 still gets first chance so company identity tracks Finnhub when available.
  const cached = profileFromCache(symbol, cache, {
    attempts: profile?.attempts || 0,
    rateLimited: profile?.rateLimited || false,
    error: profile?.error || ''
  });
  return cached || profile;
}

async function fetchFinnhubProfiles(rows, args, token) {
  const symbols = [...new Set(rows.map((row) => row.symbol))];
  const profiles = [];
  const cache = readFinnhubProfileCache(args.finnhubProfileCache);
  let cacheChanged = false;
  for (const [index, symbol] of symbols.entries()) {
    if (index > 0 && args.finnhubDelayMs > 0) await sleep(args.finnhubDelayMs);
    const profile = await fetchFinnhubProfile(symbol, args, token, cache);
    cacheChanged = storeProfileInCache(profile, cache) || cacheChanged;
    profiles.push(profile);
  }
  if (cacheChanged) writeFinnhubProfileCache(args.finnhubProfileCache, cache);
  return profiles;
}

function normalizeFinnhubMetric(symbol, result) {
  const metric = result.data?.metric && typeof result.data.metric === 'object' ? result.data.metric : {};
  const marketCapMillions = numberOrNull(metric.marketCapitalization);
  return {
    symbol,
    ok: result.ok && marketCapMillions !== null,
    status: result.status,
    responseMs: result.ms,
    marketCap: marketCapMillions === null ? null : marketCapMillions * 1000000,
    marketCapMillions,
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`,
    source: {
      provider: 'finnhub',
      endpoint: 'stock/metric',
      row: metric
    }
  };
}

function emptyFinnhubMetricCache() {
  return {
    schemaVersion: 1,
    updatedAt: '',
    metrics: {}
  };
}

function readFinnhubMetricCache(file) {
  if (!file || !fs.existsSync(file)) return emptyFinnhubMetricCache();
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache?.schemaVersion !== 1 || !cache.metrics || typeof cache.metrics !== 'object') {
      return emptyFinnhubMetricCache();
    }
    return cache;
  } catch {
    return emptyFinnhubMetricCache();
  }
}

function writeFinnhubMetricCache(file, cache) {
  if (!file) return;
  try {
    atomicWriteJson(file, cache);
  } catch (error) {
    process.stderr.write(`Finnhub metric cache could not be refreshed; continuing without the cache update: ${error.message}\n`);
  }
}

function metricFromCache(symbol, cache) {
  const cached = cache.metrics?.[symbol];
  const marketCapMillions = numberOrNull(cached?.marketCapMillions);
  if (marketCapMillions === null) return null;
  // Cached metric rows remain Finnhub facts; the cache only avoids repeating
  // rate-limit-prone profile-recovery calls for stable market-cap data.
  return {
    symbol,
    ok: true,
    status: 200,
    responseMs: 0,
    cacheHit: true,
    marketCap: marketCapMillions * 1000000,
    marketCapMillions,
    error: '',
    source: {
      provider: 'finnhub',
      endpoint: 'stock/metric',
      cacheHit: true,
      fetchedAt: String(cached.fetchedAt || ''),
      row: {
        marketCapitalization: marketCapMillions
      }
    }
  };
}

function storeMetricInCache(metric, cache) {
  if (!metric?.ok || !Number.isFinite(metric.marketCapMillions)) return false;
  const previous = cache.metrics[metric.symbol];
  if (previous?.marketCapMillions === metric.marketCapMillions) return false;
  cache.metrics[metric.symbol] = {
    marketCapMillions: metric.marketCapMillions,
    fetchedAt: new Date().toISOString()
  };
  cache.updatedAt = new Date().toISOString();
  return true;
}

function retryAfterDelayMs(headers, fallbackMs) {
  const raw = String(headers?.['retry-after'] || '').trim();
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(fallbackMs, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(fallbackMs, dateMs - Date.now());
  return fallbackMs;
}

async function fetchFinnhubMetric(symbol, args, token, cache) {
  const cached = metricFromCache(symbol, cache);
  if (cached) return cached;

  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(token)}`;
  let metric = null;
  // The metric endpoint is used only for profile-empty Finnhub rows, so retry
  // 429s here instead of letting EarningsAPI become a substitute primary.
  for (let attempt = 0; attempt <= args.finnhubMetricRetries; attempt += 1) {
    const result = await fetchJson(url, args);
    metric = normalizeFinnhubMetric(symbol, result);
    metric.attempts = attempt + 1;
    metric.rateLimited = result.status === 429;
    if (metric.ok || result.status !== 429 || attempt === args.finnhubMetricRetries) break;
    await sleep(retryAfterDelayMs(result.headers, args.finnhubMetricDelayMs));
  }
  return metric;
}

async function fetchFinnhubMetrics(rows, profiles, secondaryCalendarDays, args, token) {
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const secondaryCalendarByKey = secondaryCalendarRowsByKey(secondaryCalendarDays);
  const symbols = [...new Set(rows
    .filter((row) => !profileHasIdentity(profilesBySymbol.get(row.symbol)))
    .filter((row) => secondaryCalendarByKey.get(`${row.reportDate}:${row.symbol}`)?.company)
    .map((row) => row.symbol))];
  const metrics = [];
  const cache = readFinnhubMetricCache(args.finnhubMetricCache);
  let cacheChanged = false;
  for (const [index, symbol] of symbols.entries()) {
    if (index > 0 && args.finnhubMetricDelayMs > 0) await sleep(args.finnhubMetricDelayMs);
    const metric = await fetchFinnhubMetric(symbol, args, token, cache);
    cacheChanged = storeMetricInCache(metric, cache) || cacheChanged;
    metrics.push(metric);
  }
  if (cacheChanged) writeFinnhubMetricCache(args.finnhubMetricCache, cache);
  return metrics;
}

function metricPayload(metric, estimate, actual, options = {}) {
  return {
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate, metric),
    ...options
  };
}

function marketCapDisplay(value) {
  if (!Number.isFinite(value)) return '';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function sourceSummary(primary, fallbacks = []) {
  return {
    primary,
    fallbacks,
    reaction: 'none'
  };
}

function secondaryCalendarRowsByKey(secondaryCalendarDays) {
  const byKey = new Map();
  for (const row of secondaryCalendarDays.flatMap((day) => day.rows || [])) {
    const key = `${row.reportDate}:${row.symbol}`;
    const current = byKey.get(key);
    if (!current || rowCompletenessScore(row) > rowCompletenessScore(current)) byKey.set(key, row);
  }
  return byKey;
}

function profileRecoveryForRow(calendarRow, profile, metricsBySymbol, secondaryCalendarByKey) {
  if (profileHasIdentity(profile)) return null;
  const metric = metricsBySymbol.get(calendarRow.symbol);
  const secondaryCalendarRow = secondaryCalendarByKey.get(`${calendarRow.reportDate}:${calendarRow.symbol}`);
  if (!Number.isFinite(metric?.marketCap) || metric.marketCap < SECONDARY_RECOVERY_MIN_MARKET_CAP) return null;
  if (!secondaryCalendarRow?.company) return null;
  // Identity-only recovery: Finnhub remains the source for the earnings row.
  // These fallback fields only decide whether a profile-empty row can be displayed.
  return {
    company: secondaryCalendarRow.company,
    country: '',
    exchange: '',
    currency: '',
    marketCap: metric.marketCap,
    marketCapDisplay: marketCapDisplay(metric.marketCap),
    secondaryCalendar: secondaryCalendarRow,
    calendarAuditKey: secondaryCalendarAuditKey(secondaryCalendarRow),
    finnhubMetric: metric
  };
}

function buildRows(calendarRows, profiles, options = {}) {
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const usListingsBySymbol = new Map((options.usListings || []).map((listing) => [listing.symbol, listing]));
  const metricsBySymbol = new Map((options.finnhubMetrics || []).map((metric) => [metric.symbol, metric]));
  const secondaryCalendarByKey = secondaryCalendarRowsByKey(options.secondaryCalendarDays || []);
  return calendarRows.map((calendarRow) => {
    const profile = profilesBySymbol.get(calendarRow.symbol);
    const profileRecovery = profileRecoveryForRow(calendarRow, profile, metricsBySymbol, secondaryCalendarByKey);
    const providerDateConflict = calendarRow.providerDateConflict || null;
    const auditedFinnhubCalendar = providerDateConflict?.candidates?.finnhub?.[0] || calendarRow;
    const company = profile?.name || profileRecovery?.company || calendarRow.symbol;
    const marketCap = profile?.marketCap ?? profileRecovery?.marketCap ?? null;
    const timingFallback = calendarRow.secondaryCalendarTimingFallback || null;
    const timingFallbackKey = timingFallback ? secondaryCalendarAuditKey(timingFallback) : null;
    const calendarAuditKey = profileRecovery?.calendarAuditKey || timingFallbackKey || null;
    const fallbacks = [
      ...(profileRecovery ? [profileRecovery.calendarAuditKey, 'finnhubMetric'] : []),
      ...(timingFallback && (!profileRecovery || profileRecovery.calendarAuditKey !== timingFallbackKey) ? [timingFallbackKey] : [])
    ];
    const eps = metricPayload('eps', calendarRow.eps.estimate, calendarRow.eps.actual, {
      basis: '',
      note: ''
    });
    const revenue = metricPayload('revenue', calendarRow.revenue.estimate, calendarRow.revenue.actual, {
      note: ''
    });

    return {
      symbol: calendarRow.symbol,
      company,
      exchange: profile?.exchange || profileRecovery?.exchange || '',
      country: profile?.country || profileRecovery?.country || '',
      currency: profile?.currency || profileRecovery?.currency || '',
      marketCap,
      marketCapDisplay: marketCapDisplay(marketCap),
      reportDate: calendarRow.reportDate,
      reportTiming: timingFallback?.reportTiming || calendarRow.reportTiming,
      fiscalQuarterEnding: '',
      fiscalQuarter: calendarRow.fiscalQuarter,
      fiscalYear: calendarRow.fiscalYear,
      eps,
      revenue,
      outcome: {
        overall: combinedOutcome(eps.result, revenue.result),
        guide: '',
        interpretation: ''
      },
      reaction: null,
      sourceStatus: computeEarningsSourceStatus(calendarRow, { requireComputedReaction: false }),
      sourceSummary: sourceSummary('finnhub', fallbacks),
      sourceAudit: {
        finnhubUsListing: usListingsBySymbol.get(calendarRow.symbol) || null,
        finnhubCalendar: {
          reportDate: auditedFinnhubCalendar.reportDate,
          reportTiming: auditedFinnhubCalendar.reportTiming
        },
        finnhubProfile: profile ? {
          status: profile.status,
          ok: profile.ok,
          name: profile.name,
          ticker: profile.ticker,
          exchange: profile.exchange,
          country: profile.country,
          currency: profile.currency,
          marketCap: profile.marketCap,
          marketCapMillions: profile.marketCapMillions,
          shareOutstanding: profile.shareOutstanding,
          industry: profile.industry,
          cacheHit: Boolean(profile.cacheHit),
          staleProfileFallback: Boolean(profile.staleProfileFallback),
          rateLimited: Boolean(profile.rateLimited),
          attempts: profile.attempts || 1,
          error: profile.error
        } : null,
        finnhubMetric: profileRecovery ? {
          status: profileRecovery.finnhubMetric.status,
          ok: profileRecovery.finnhubMetric.ok,
          cacheHit: Boolean(profileRecovery.finnhubMetric.cacheHit),
          marketCap: profileRecovery.finnhubMetric.marketCap,
          marketCapMillions: profileRecovery.finnhubMetric.marketCapMillions,
          error: profileRecovery.finnhubMetric.error
        } : null,
        alphaVantageCalendar: calendarAuditKey === ALPHA_VANTAGE_CALENDAR_AUDIT
          ? compactSecondaryCalendarAudit(profileRecovery?.secondaryCalendar || timingFallback)
          : null,
        providerDateConflict,
        selectedSources: {
          slate: 'finnhub',
          company: profile?.name ? 'finnhubProfile' : profileRecovery?.company ? profileRecovery.calendarAuditKey : 'symbol',
          marketCap: Number.isFinite(profile?.marketCap) ? 'finnhubProfile' : Number.isFinite(profileRecovery?.marketCap) ? 'finnhubMetric' : 'none',
          timing: timingFallback ? timingFallbackKey : calendarRow.reportTiming === 'unknown' ? 'none' : 'finnhub',
          eps: {
            estimate: calendarRow.eps.estimate === null ? 'none' : 'finnhub',
            actual: calendarRow.eps.actual === null ? 'none' : 'finnhub'
          },
          revenue: {
            estimate: calendarRow.revenue.estimate === null ? 'none' : 'finnhub',
            actual: calendarRow.revenue.actual === null ? 'none' : 'finnhub'
          },
          reaction: 'none'
        }
      }
    };
  });
}

function companyRowCompletenessScore(row) {
  return [
    row.reportTiming !== 'unknown',
    row.eps?.estimate !== null,
    row.eps?.actual !== null,
    row.revenue?.estimate !== null,
    row.revenue?.actual !== null
  ].filter(Boolean).length;
}

function selectEarningsApiCompanyRow(fetch, task) {
  return (fetch?.rows || [])
    .filter((row) => row.symbol === task.symbol && row.reportDate === task.reportDate)
    .sort((left, right) => companyRowCompletenessScore(right) - companyRowCompletenessScore(left))[0] || null;
}

function earningsApiCompanyAudit(fetch, companyRow) {
  return {
    status: fetch?.status ?? null,
    ok: Boolean(fetch?.ok),
    selectedRow: companyRow ? {
      reportDate: companyRow.reportDate,
      reportTiming: companyRow.reportTiming
    } : null,
    rowCount: fetch?.rows?.length || 0,
    error: fetch?.error || (!companyRow ? 'No matching EarningsAPI company row was returned; retry is required.' : '')
  };
}

function attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(tasks, companyFetches) {
  const fetchesBySymbol = new Map(companyFetches.map((item) => [item.symbol, item]));
  return tasks.map((task) => {
    const fetch = fetchesBySymbol.get(task.symbol);
    const companyRow = selectEarningsApiCompanyRow(fetch, task);
    return {
      ...task,
      sourceAudit: {
        ...task.sourceAudit,
        earningsApiCompany: earningsApiCompanyAudit(fetch, companyRow)
      }
    };
  });
}

function recoveryCalendarAuditKey(task) {
  if (!task?.sourceAudit?.alphaVantageCalendar) {
    throw new Error(`${task?.symbol || 'Secondary recovery candidate'} is missing Alpha Vantage calendar provenance.`);
  }
  return ALPHA_VANTAGE_CALENDAR_AUDIT;
}

function buildEarningsApiRows(tasks, companyFetches) {
  const fetchesBySymbol = new Map(companyFetches.map((item) => [item.symbol, item]));
  return tasks.map((task) => {
    const fetch = fetchesBySymbol.get(task.symbol);
    const companyRow = selectEarningsApiCompanyRow(fetch, task);
    if (!companyRow) return null;
    const profile = task.sourceAudit.finnhubProfile;
    const calendarAuditKey = recoveryCalendarAuditKey(task);
    const eps = metricPayload('eps', companyRow.eps.estimate, companyRow.eps.actual, {
      basis: '',
      note: ''
    });
    const revenue = metricPayload('revenue', companyRow.revenue.estimate, companyRow.revenue.actual, {
      note: ''
    });
    const sourceRow = {
      reportTiming: companyRow.reportTiming,
      eps: companyRow.eps,
      revenue: companyRow.revenue
    };

    return {
      symbol: task.symbol,
      company: profile?.name || companyRow.company || task.company,
      exchange: profile?.exchange || '',
      country: profile?.country || '',
      currency: profile?.currency || '',
      marketCap: profile?.marketCap ?? task.marketCap ?? null,
      marketCapDisplay: marketCapDisplay(profile?.marketCap ?? task.marketCap),
      reportDate: task.reportDate,
      reportTiming: companyRow.reportTiming,
      fiscalQuarterEnding: task.fiscalQuarterEnding || '',
      fiscalQuarter: null,
      fiscalYear: null,
      eps,
      revenue,
      outcome: {
        overall: combinedOutcome(eps.result, revenue.result),
        guide: '',
        interpretation: ''
      },
      reaction: null,
      sourceStatus: computeEarningsSourceStatus(sourceRow, { requireComputedReaction: false }),
      sourceSummary: sourceSummary('earningsApiCompany', [calendarAuditKey, 'finnhubProfile']),
      sourceAudit: {
        finnhubUsListing: task.sourceAudit.finnhubUsListing,
        finnhubCalendar: {
          present: false
        },
        finnhubProfile: profile || null,
        alphaVantageCalendar: task.sourceAudit.alphaVantageCalendar,
        earningsApiCompany: task.sourceAudit.earningsApiCompany || earningsApiCompanyAudit(fetch, companyRow),
        selectedSources: {
          slate: calendarAuditKey,
          company: profile?.name ? 'finnhubProfile' : 'earningsApiCompany',
          marketCap: Number.isFinite(profile?.marketCap) ? 'finnhubProfile' : 'none',
          timing: companyRow.reportTiming === 'unknown' ? 'none' : 'earningsApiCompany',
          eps: {
            estimate: companyRow.eps.estimate === null ? 'none' : 'earningsApiCompany',
            actual: companyRow.eps.actual === null ? 'none' : 'earningsApiCompany'
          },
          revenue: {
            estimate: companyRow.revenue.estimate === null ? 'none' : 'earningsApiCompany',
            actual: companyRow.revenue.actual === null ? 'none' : 'earningsApiCompany'
          },
          reaction: 'none'
        }
      }
    };
  }).filter(Boolean);
}

function summarize(rows, fetches, secondaryRecoveryCandidates, companyReleaseTasks) {
  const counts = computeEarningsWeekCounts(rows, secondaryRecoveryCandidates, companyReleaseTasks);
  return {
    counts,
    fetches: {
      finnhubCalendar: {
        ok: fetches.finnhubCalendar.ok,
        status: fetches.finnhubCalendar.status,
        rowCount: fetches.finnhubCalendar.rowCount,
        error: fetches.finnhubCalendar.error
      },
      finnhubUsSymbols: {
        ok: fetches.finnhubUsSymbols.ok,
        status: fetches.finnhubUsSymbols.status,
        rows: fetches.finnhubUsSymbols.listings.length,
        cacheHit: Boolean(fetches.finnhubUsSymbols.cacheHit),
        error: fetches.finnhubUsSymbols.error
      },
      finnhubProfiles: {
        requests: fetches.finnhubProfiles.length,
        ok: fetches.finnhubProfiles.filter((item) => item.ok).length,
        cacheHits: fetches.finnhubProfiles.filter((item) => item.cacheHit).length,
        staleProfileFallbacks: fetches.finnhubProfiles.filter((item) => item.staleProfileFallback).length,
        rateLimited: fetches.finnhubProfiles.filter((item) => item.rateLimited).length,
        errors: fetches.finnhubProfiles.filter((item) => !item.ok).map((item) => ({
          symbol: item.symbol,
          status: item.status,
          attempts: item.attempts || 1,
          error: item.error
        }))
      },
      finnhubMetrics: {
        requests: fetches.finnhubMetrics.length,
        ok: fetches.finnhubMetrics.filter((item) => item.ok).length,
        cacheHits: fetches.finnhubMetrics.filter((item) => item.cacheHit).length,
        rateLimited: fetches.finnhubMetrics.filter((item) => item.rateLimited).length,
        errors: fetches.finnhubMetrics.filter((item) => !item.ok).map((item) => ({
          symbol: item.symbol,
          status: item.status,
          attempts: item.attempts || 1,
          error: item.error
        }))
      },
      secondaryCalendar: {
        provider: 'alpha_vantage',
        requests: fetches.secondaryCalendarDays.length ? 1 : 0,
        ok: fetches.secondaryCalendarDays.some((item) => item.ok) ? 1 : 0,
        skipped: fetches.secondaryCalendarDays.some((item) => item.skipped) ? 1 : 0,
        rows: fetches.secondaryCalendarDays.reduce((sum, item) => sum + item.rowCount, 0),
        errors: fetches.secondaryCalendarDays.filter((item) => !item.ok && !item.skipped).map((item) => ({
          date: item.date,
          status: item.status,
          error: item.error
        }))
      },
      earningsApiCompany: {
        requests: fetches.earningsApiCompanyFetches.length,
        ok: fetches.earningsApiCompanyFetches.filter((item) => item.ok).length,
        skipped: fetches.earningsApiCompanyFetches.filter((item) => item.skipped).length,
        errors: fetches.earningsApiCompanyFetches.filter((item) => !item.ok && !item.skipped).map((item) => ({
          symbol: item.symbol,
          status: item.status,
          error: item.error
        }))
      },
      earningsApiBudget: fetches.earningsApiBudget,
      yahoo: {
        requests: fetches.yahooFetches.length,
        ok: fetches.yahooFetches.filter((item) => item.ok).length,
        errors: fetches.yahooFetches.filter((item) => !item.ok).map((item) => ({
          symbol: item.symbol,
          status: item.status,
          error: item.error
        }))
      }
    }
  };
}

function printReport(payload, compact = false) {
  const { counts } = payload.summary;
  process.stdout.write(`Earnings Week Fetch Summary
===========================
Window: ${payload.range.from} to ${payload.range.to}
Rows: ${counts.total}
Verified: ${counts.verified}
Partial: ${counts.partial}
Reactions computed: ${counts.reactionComputed}
Missing timing: ${counts.missingTiming}
Missing revenue: ${counts.missingRevenue}
Missing market cap: ${counts.missingMarketCap}
Secondary recovery candidates: ${counts.secondaryRecoveryCandidates}
Company-release tasks: ${counts.companyReleaseTasks}
Output: ${payload.outputPath}
`);

  if (compact) return;

  process.stdout.write('\nRows\n----\n');
  for (const row of payload.rows) {
    const timing = row.reportTiming.toUpperCase();
    const reaction = row.reaction?.percent === null ? 'reaction n/a' : `${formatSignedPct(row.reaction.percent)} ${row.reaction.basis}`;
    const revenue = row.revenue.actual === null && row.revenue.estimate === null
      ? 'revenue n/a'
      : `rev ${formatMoney(row.revenue.actual)} vs ${formatMoney(row.revenue.estimate)}`;
    process.stdout.write(`${row.reportDate} ${row.symbol} ${timing} ${row.outcome.overall} ${row.sourceStatus} | EPS ${formatNumber(row.eps.actual)} vs ${formatNumber(row.eps.estimate)} | ${revenue} | ${reaction}\n`);
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1000000000) return `$${(value / 1000000000).toFixed(2)}B`;
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}

function formatSignedPct(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

async function runBuild(argv = process.argv.slice(2)) {
  loadEnv();
  const args = parseArgs(argv);
  const token = process.env.FINNHUB_API_KEY;
  const alphaVantageToken = process.env.ALPHA_VANTAGE_API_KEY;
  const earningsApiToken = process.env.EARNINGSAPI_API_KEY;
  if (!token) {
    throw new Error('FINNHUB_API_KEY is required in .env or the environment.');
  }

  const earningsApiUsage = earningsApiUsageForBuild(args);
  const finnhubCalendar = await fetchFinnhubCalendar(args, token);
  ensureFinnhubPrimaryUsable(finnhubCalendar);
  const finnhubUsSymbols = await fetchFinnhubUsSymbols(args, token);
  if (!finnhubUsSymbols.ok) {
    throw new Error(`Finnhub U.S. symbol directory is unavailable. ${finnhubUsSymbols.error || ''}`.trim());
  }

  // The surrounding-date production window catches conflicts while discovery
  // remains limited to the five visible trading dates. Official company IR,
  // then SEC, is the fallback when this secondary check is unavailable or does
  // not corroborate the primary date.
  const secondaryCalendarDays = await fetchAlphaVantageCalendar(
    args,
    alphaVantageToken,
    calendarVerificationDates(args)
  );
  const activeSecondaryCalendarDays = secondaryCalendarDays.filter((day) => args.displayDates.includes(day.date));
  const calendarResolution = resolveProviderDateConflicts(
    finnhubCalendar.rows,
    activeSecondaryCalendarDays
  );
  const secondaryCandidateRows = calendarResolution.secondaryCalendarDays
    .flatMap((day) => day.rows)
    .filter((row) => !calendarResolution.finnhubRows.some((finnhubRow) => finnhubRow.symbol === row.symbol && finnhubRow.reportDate === row.reportDate));
  const profileRows = [...secondaryCandidateRows, ...calendarResolution.finnhubRows];
  const finnhubProfiles = await fetchFinnhubProfiles(profileRows, args, token);
  const finnhubMetrics = await fetchFinnhubMetrics(calendarResolution.finnhubRows, finnhubProfiles, calendarResolution.secondaryCalendarDays, args, token);
  const secondaryRecoveryCandidatesBase = buildSecondaryRecoveryCandidates(
    calendarResolution.finnhubRows,
    calendarResolution.secondaryCalendarDays,
    finnhubProfiles,
    finnhubUsSymbols.listings
  );
  const earningsApiCompanyFetches = await fetchEarningsApiCompanies(secondaryRecoveryCandidatesBase, args, earningsApiToken, earningsApiUsage);
  const secondaryRecoveryCandidates = attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(secondaryRecoveryCandidatesBase, earningsApiCompanyFetches);
  const finnhubRows = buildRows(calendarResolution.finnhubRows, finnhubProfiles, {
    finnhubMetrics,
    secondaryCalendarDays: calendarResolution.secondaryCalendarDays,
    usListings: finnhubUsSymbols.listings
  });
  const scheduleConfirmationInput = readScheduleConfirmations(args.scheduleConfirmations);
  const scheduleVerification = verifyFinnhubScheduleRows(
    finnhubRows,
    secondaryCalendarDays,
    { from: args.from, to: args.to },
    scheduleConfirmationInput.rows
  );
  const earningsApiRows = buildEarningsApiRows(secondaryRecoveryCandidates, earningsApiCompanyFetches);
  const earningsApiScheduleVerification = verifyEarningsApiRecoveryRows(
    earningsApiRows,
    { from: args.from, to: args.to },
    scheduleConfirmationInput.rows,
    secondaryRecoveryCandidates
  );
  atomicWriteJson(args.scheduleReview, {
    schemaVersion: 1,
    generatedAt: args.asOf,
    range: { from: args.from, to: args.to },
    rows: [...scheduleVerification.review, ...earningsApiScheduleVerification.review],
    diagnostics: scheduleConfirmationInput.diagnostics,
    outputPath: args.scheduleReview
  });
  const mergedRows = [...scheduleVerification.rows, ...earningsApiScheduleVerification.rows].sort((left, right) => {
    const dateCompare = left.reportDate.localeCompare(right.reportDate);
    if (dateCompare) return dateCompare;
    return left.symbol.localeCompare(right.symbol);
  });
  const generatedAt = new Date(args.asOf);
  const yahooFetches = await fetchYahooBarsForRows(mergedRows.filter(needsYahooReactionFetch), args, fetchJson);
  const rows = attachReactions(mergedRows, yahooFetches, { asOf: generatedAt });
  const companyReleaseTasks = buildCompanyReleaseTasks(secondaryRecoveryCandidates, rows);
  const earningsApiEntry = earningsApiDayEntry(earningsApiUsage, generatedAt);

  const payload = {
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    range: {
      from: args.from,
      to: args.to
    },
    rows,
    secondaryRecoveryCandidates,
    companyReleaseTasks,
    summary: summarize(rows, {
      finnhubCalendar,
      finnhubUsSymbols,
      finnhubProfiles,
      finnhubMetrics,
      secondaryCalendarDays,
      earningsApiCompanyFetches,
      earningsApiBudget: {
        usageFile: path.relative(process.cwd(), args.earningsApiUsage),
        day: earningsApiUsageDay(generatedAt),
        callsUsed: earningsApiEntry.calls,
        dailyLimit: args.earningsApiDailyLimit,
        reserve: args.earningsApiReserve,
        callsAvailableForThisScript: Math.max(0, args.earningsApiDailyLimit - args.earningsApiReserve - earningsApiEntry.calls),
        skipped: !args.useEarningsApi || args.skipEarningsApi || !earningsApiToken
      },
      yahooFetches
    }, secondaryRecoveryCandidates, companyReleaseTasks),
    outputPath: args.output
  };

  atomicWriteJson(args.output, payload);
  printReport(payload, args.compact);
}

if (require.main === module) {
  process.stderr.write('earnings_week_build.js is internal; use: node scripts/earnings_week.js build [options]\n');
  process.exit(1);
}

module.exports = {
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  buildEarningsApiRows,
  buildSecondaryRecoveryCandidates,
  buildRows,
  calendarVerificationDates,
  ensureFinnhubPrimaryUsable,
  earningsApiUsageForBuild,
  alphaVantageCalendarFromResponse,
  fetchAlphaVantageCalendar,
  fetchEarningsApiCalendar,
  fetchFinnhubUsSymbols,
  finnhubCalendarFromResponse,
  finnhubUsSymbolsFromResponse,
  fetchFinnhubMetrics,
  fetchYahooBars,
  fetchYahooBarsForRows,
  profileFromCache,
  isEligibleFinnhubUsListing,
  readScheduleConfirmations,
  resolveProviderDateConflicts,
  runBuild,
  verifyEarningsApiRecoveryRows,
  verifyFinnhubScheduleRows,
  storeProfileInCache
};
