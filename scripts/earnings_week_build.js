#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  buildEarningsWeekPolicy,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  isDisplayEligibleEarningsRow,
  normalizeEarningsTiming,
  numberOrNull
} = require('./earnings_week_contract');
const {
  addDays,
  compareIsoDate,
  dateFromIso,
  displayDatesForRange,
  isIsoDate,
  isSupportedFiveTradingDayRange,
  isoFromDate
} = require('./calendar_contract');

const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'earnings_week.json');
const DEFAULT_FINNHUB_DELAY_MS = 700;
const DEFAULT_FINNHUB_PROFILE_RETRIES = 3;
const DEFAULT_FINNHUB_METRIC_DELAY_MS = 2000;
const DEFAULT_FINNHUB_METRIC_RETRIES = 3;
const DEFAULT_FINNHUB_PROFILE_CACHE = path.resolve(process.cwd(), 'generated', 'finnhub_profile_cache.json');
const DEFAULT_FINNHUB_METRIC_CACHE = path.resolve(process.cwd(), 'generated', 'finnhub_metric_cache.json');
const DEFAULT_EARNINGSAPI_USAGE = path.resolve(process.cwd(), 'generated', 'earningsapi_usage.json');
const DEFAULT_EARNINGSAPI_MONTHLY_LIMIT = 1000;
const DEFAULT_EARNINGSAPI_RESERVE = 150;
const DEFAULT_SCHEDULE_CONFIRMATIONS = path.resolve(process.cwd(), 'generated', 'earnings_schedule_confirmations.json');
const DEFAULT_SCHEDULE_REVIEW = path.resolve(process.cwd(), 'generated', 'earnings_schedule_review.json');
const CALENDAR_VERIFICATION_LOOKBACK_DAYS = 7;
const CALENDAR_VERIFICATION_LOOKAHEAD_DAYS = 28;
const REACTION_LOOKBACK_DAYS = 5;
const REACTION_LOOKAHEAD_DAYS = 5;
const SECONDARY_RECOVERY_MIN_MARKET_CAP = 1000000000;

function parseArgs(argv) {
  const args = {
    from: '',
    to: '',
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    finnhubDelayMs: DEFAULT_FINNHUB_DELAY_MS,
    finnhubProfileRetries: DEFAULT_FINNHUB_PROFILE_RETRIES,
    finnhubProfileCache: DEFAULT_FINNHUB_PROFILE_CACHE,
    finnhubMetricDelayMs: DEFAULT_FINNHUB_METRIC_DELAY_MS,
    finnhubMetricRetries: DEFAULT_FINNHUB_METRIC_RETRIES,
    finnhubMetricCache: DEFAULT_FINNHUB_METRIC_CACHE,
    minFinnhubRows: null,
    earningsApiUsage: DEFAULT_EARNINGSAPI_USAGE,
    earningsApiMonthlyLimit: DEFAULT_EARNINGSAPI_MONTHLY_LIMIT,
    earningsApiReserve: DEFAULT_EARNINGSAPI_RESERVE,
    scheduleConfirmations: DEFAULT_SCHEDULE_CONFIRMATIONS,
    scheduleReview: DEFAULT_SCHEDULE_REVIEW,
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
    if (arg === '--min-finnhub-rows') {
      args.minFinnhubRows = Math.max(1, Math.floor(Number(argv[i + 1] || 1)));
      i += 1;
      continue;
    }
    if (arg === '--earningsapi-usage') {
      args.earningsApiUsage = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGSAPI_USAGE);
      i += 1;
      continue;
    }
    if (arg === '--earningsapi-monthly-limit') {
      args.earningsApiMonthlyLimit = Math.max(0, Number(argv[i + 1] || DEFAULT_EARNINGSAPI_MONTHLY_LIMIT));
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
  }

  if (!isIsoDate(args.from) || !isIsoDate(args.to)) {
    throw new Error('Both --from and --to are required in YYYY-MM-DD format.');
  }
  if (compareIsoDate(args.from, args.to) > 0) {
    throw new Error('--from must be on or before --to.');
  }
  if (!isSupportedFiveTradingDayRange(args.from, args.to)) {
    throw new Error('Earnings range must be Monday-Friday or Friday plus next Monday-Thursday.');
  }
  args.displayDates = displayDatesForRange(args.from, args.to);
  if (args.minFinnhubRows === null) {
    args.minFinnhubRows = defaultMinFinnhubRows(args.from, args.to);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --from YYYY-MM-DD            Monday for a Monday-Friday slate, or Friday for the bridge slate
  --to YYYY-MM-DD              Friday for a Monday-Friday slate, or following Thursday for the bridge slate
  --output PATH                Output JSON path (default: generated/earnings_week.json)
  --timeout-ms 20000           HTTP timeout in ms per request
  --finnhub-delay-ms 700       Delay between Finnhub profile requests
  --finnhub-profile-retries 3  Retries for Finnhub profile requests that hit HTTP 429
  --finnhub-profile-cache PATH Successful Finnhub profile cache
  --finnhub-metric-delay-ms 2000
                               Delay between Finnhub metric requests and 429 retries
  --finnhub-metric-retries 3   Retries for Finnhub metric requests that hit HTTP 429
  --finnhub-metric-cache PATH  Successful Finnhub metric market-cap cache
  --min-finnhub-rows N         Minimum usable Finnhub rows before secondary recovery (default: weekdays * 2)
  --earningsapi-usage PATH     EarningsAPI monthly usage ledger
  --earningsapi-monthly-limit  Monthly EarningsAPI call cap (default: 1000)
  --earningsapi-reserve 150    Calls reserved for other dashboard runs
  --schedule-confirmations PATH
                               Official IR date confirmations for uncorroborated/in-week-conflict rows
  --schedule-review PATH       Generated review queue for rows requiring an official date confirmation
  --skip-earningsapi           Disable secondary-source recovery
  --compact                    Print compact coverage report
  --help                       Show this help

Environment:
  FINNHUB_API_KEY              Read from .env or current environment
  EARNINGSAPI_API_KEY          Optional secondary source for Finnhub-missing rows
`);
}

function loadEnv(file = path.resolve(process.cwd(), '.env')) {
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

function defaultMinFinnhubRows(from, to) {
  return Math.max(1, displayDatesForRange(from, to).length * 2);
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

function ensureFinnhubPrimaryUsable(finnhubCalendar, options = {}) {
  if (!finnhubCalendar?.ok) {
    throw new Error(`Finnhub primary calendar failed; refusing to build an EarningsAPI-only slate. ${finnhubCalendar?.error || ''}`.trim());
  }
  const rowCount = Array.isArray(finnhubCalendar.rows) ? finnhubCalendar.rows.length : 0;
  if (rowCount === 0) {
    throw new Error('Finnhub primary calendar returned zero usable rows; refusing to build an EarningsAPI-only slate.');
  }
  const minimumRows = Number.isFinite(options.minFinnhubRows)
    ? Math.max(1, Math.floor(options.minFinnhubRows))
    : defaultMinFinnhubRows(options.from, options.to);
  if (rowCount < minimumRows) {
    throw new Error(`Finnhub primary calendar returned ${rowCount} usable rows, below the minimum ${minimumRows}; refusing to spend EarningsAPI calls backfilling a suspiciously sparse primary slate.`);
  }
}

function marketCapNumber(value) {
  const text = String(value || '').trim();
  if (!text || /^n\/a$/i.test(text)) return null;
  const number = Number(text.replace(/[$,\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function pctChange(from, to) {
  const left = numberOrNull(from);
  const right = numberOrNull(to);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0) return null;
  return (right / left - 1) * 100;
}

function normalizeFinnhubCalendarRow(row) {
  return {
    symbol: String(row?.symbol || '').trim().toUpperCase(),
    reportDate: String(row?.date || '').trim(),
    reportTiming: normalizeEarningsTiming(row?.hour),
    fiscalQuarter: numberOrNull(row?.quarter),
    fiscalYear: numberOrNull(row?.year),
    eps: {
      estimate: numberOrNull(row?.epsEstimate),
      actual: numberOrNull(row?.epsActual)
    },
    revenue: {
      estimate: numberOrNull(row?.revenueEstimate),
      actual: numberOrNull(row?.revenueActual)
    },
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

async function fetchFinnhubCalendar(args, token) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${encodeURIComponent(args.from)}&to=${encodeURIComponent(args.to)}&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url, args);
  const rawRows = result.ok && Array.isArray(result.data?.earningsCalendar) ? result.data.earningsCalendar : [];
  const rows = dedupeCalendarRows(rawRows
    .map(normalizeFinnhubCalendarRow)
    .filter((row) => row.symbol && isIsoDate(row.reportDate))
    .filter((row) => args.displayDates.includes(row.reportDate)));
  return {
    ok: result.ok,
    status: result.status,
    responseMs: result.ms,
    rowCount: rows.length,
    rows,
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

function earningsApiUsageMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function readEarningsApiUsage(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, months: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.schemaVersion === 1 && data.months && typeof data.months === 'object') return data;
  } catch {
    // Ignore a corrupt local ledger and start a fresh one for this run.
  }
  return { schemaVersion: 1, months: {} };
}

function writeEarningsApiUsage(file, usage) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(usage, null, 2)}\n`);
}

function earningsApiMonthEntry(usage) {
  const month = earningsApiUsageMonth();
  if (!usage.months[month]) usage.months[month] = { calls: 0, requests: [] };
  if (!Array.isArray(usage.months[month].requests)) usage.months[month].requests = [];
  return usage.months[month];
}

function canUseEarningsApi(args, usage, token) {
  if (args.skipEarningsApi) return false;
  if (!token) return false;
  const entry = earningsApiMonthEntry(usage);
  return entry.calls < Math.max(0, args.earningsApiMonthlyLimit - args.earningsApiReserve);
}

async function fetchEarningsApiJson(pathname, args, token, usage, requestType) {
  if (!canUseEarningsApi(args, usage, token)) {
    return {
      ok: false,
      skipped: true,
      status: 0,
      ms: 0,
      data: null,
      parseError: 'EarningsAPI skipped because the monthly budget is unavailable or reserved.',
      bodyPreview: ''
    };
  }
  const url = new URL(pathname, 'https://api.earningsapi.com');
  url.searchParams.set('apikey', token);
  const entry = earningsApiMonthEntry(usage);
  entry.calls += 1;
  entry.requests.push({
    at: new Date().toISOString(),
    type: requestType,
    path: url.pathname,
    query: [...url.searchParams.keys()].filter((key) => key !== 'apikey').sort().join(',')
  });
  if (entry.requests.length > 200) entry.requests = entry.requests.slice(-200);
  writeEarningsApiUsage(args.earningsApiUsage, usage);
  return fetchJson(url.toString(), args);
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

function normalizeNasdaqRow(row, reportDate) {
  const marketCap = marketCapNumber(row?.marketCap);
  return {
    symbol: String(row?.symbol || '').trim().toUpperCase(),
    company: String(row?.name || '').trim(),
    marketCap,
    marketCapDisplay: marketCapDisplay(marketCap),
    reportDate,
    reportTiming: normalizeEarningsApiTiming(row?.time),
    fiscalQuarterEnding: String(row?.fiscalQuarterEnding || '').trim(),
    eps: {
      estimate: numberOrNull(String(row?.epsForecast || '').replace(/[()$,\s]/g, (match) => match === '(' ? '-' : '')),
      actual: null
    },
    revenue: {
      estimate: null,
      actual: null
    },
    source: {
      provider: 'nasdaq',
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

async function fetchEarningsApiCalendar(args, token, usage, dates = args.displayDates) {
  const days = [];
  for (const date of dates) {
    days.push(await fetchEarningsApiCalendarDay(date, args, token, usage));
  }
  return days;
}

async function fetchNasdaqCalendarDay(date, args) {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`;
  const result = await fetchJson(url, args, {
    Referer: 'https://www.nasdaq.com/market-activity/earnings'
  });
  const rawRows = Array.isArray(result.data?.data?.rows) ? result.data.data.rows : [];
  const rows = rawRows.map((row) => normalizeNasdaqRow(row, date)).filter((row) => row.symbol);
  return {
    date,
    ok: result.ok,
    status: result.status,
    responseMs: result.ms,
    rowCount: rows.length,
    rows,
    error: result.ok ? '' : result.parseError || result.bodyPreview || `HTTP ${result.status}`
  };
}

function symbolsWithProviderDateConflicts(finnhubRows, earningsApiCalendarDays) {
  const finnhubDatesBySymbol = new Map();
  for (const row of finnhubRows) {
    if (!finnhubDatesBySymbol.has(row.symbol)) finnhubDatesBySymbol.set(row.symbol, new Set());
    finnhubDatesBySymbol.get(row.symbol).add(row.reportDate);
  }

  const symbols = new Set();
  for (const row of earningsApiCalendarDays.flatMap((day) => day.rows || [])) {
    const finnhubDates = finnhubDatesBySymbol.get(row.symbol);
    if (finnhubDates && !finnhubDates.has(row.reportDate)) symbols.add(row.symbol);
  }
  return symbols;
}

async function fetchNasdaqCalendarForConflicts(finnhubRows, earningsApiCalendarDays, args) {
  if (symbolsWithProviderDateConflicts(finnhubRows, earningsApiCalendarDays).size === 0) return [];
  const days = [];
  for (const date of args.displayDates) {
    days.push(await fetchNasdaqCalendarDay(date, args));
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
    output.push(await fetchEarningsApiCompany(task.symbol, args, token, usage));
  }
  return output;
}

function profileHasIdentity(profile) {
  return Boolean(profile?.name || profile?.exchange || profile?.country || Number.isFinite(profile?.marketCap));
}

function profileIsDisplayEligible(profile) {
  if (!profile) return false;
  if (profile.country && profile.country !== 'US') return false;
  if (/OTC/i.test(profile.exchange || '')) return false;
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

function cloneCalendarDay(day, rows) {
  return {
    ...day,
    rowCount: rows.length,
    rows
  };
}

function providerDateConflictAudit(symbol, finnhubRows, earningsApiRows, nasdaqRows, selectedDate, selectedProvider, selectedDateSource, reason) {
  return {
    symbol,
    status: selectedDateSource === 'nasdaq' ? 'resolved' : 'fallback',
    selectedDate,
    selectedProvider,
    selectedDateSource,
    reason,
    candidates: {
      finnhub: finnhubRows.map(compactCalendarSnapshot),
      earningsApiCalendar: earningsApiRows.map(compactCalendarSnapshot),
      nasdaq: nasdaqRows.map(compactCalendarSnapshot)
    }
  };
}

function resolveProviderDateConflicts(finnhubRows, earningsApiCalendarDays, nasdaqCalendarDays = [], options = {}) {
  // Nasdaq is a strict tie-breaker only: it may confirm one of the provider dates,
  // but it must not introduce a third date or upgrade timing by itself.
  const originalFinnhubRowsBySymbol = new Map();
  for (const row of finnhubRows) {
    if (!originalFinnhubRowsBySymbol.has(row.symbol)) originalFinnhubRowsBySymbol.set(row.symbol, []);
    originalFinnhubRowsBySymbol.get(row.symbol).push({ ...row });
  }

  const nasdaqRowsBySymbol = new Map();
  for (const row of nasdaqCalendarDays.flatMap((day) => day.rows || [])) {
    if (!nasdaqRowsBySymbol.has(row.symbol)) nasdaqRowsBySymbol.set(row.symbol, []);
    nasdaqRowsBySymbol.get(row.symbol).push(row);
  }

  const earningsApiRowsBySymbol = new Map();
  for (const row of earningsApiCalendarDays.flatMap((day) => day.rows || [])) {
    if (!earningsApiRowsBySymbol.has(row.symbol)) earningsApiRowsBySymbol.set(row.symbol, []);
    earningsApiRowsBySymbol.get(row.symbol).push(row);
  }

  const conflictsBySymbol = new Map();
  const resolvedFinnhubRows = finnhubRows.map((row) => ({ ...row }));
  for (const row of resolvedFinnhubRows) {
    const earningsApiRows = earningsApiRowsBySymbol.get(row.symbol) || [];
    const conflictingEarningsApiRows = earningsApiRows.filter((item) => item.reportDate !== row.reportDate);
    if (!conflictingEarningsApiRows.length) continue;

    const finnhubRowsForSymbol = resolvedFinnhubRows.filter((item) => item.symbol === row.symbol);
    const originalFinnhubRowsForSymbol = originalFinnhubRowsBySymbol.get(row.symbol) || finnhubRowsForSymbol;
    const finnhubDates = [...new Set(finnhubRowsForSymbol.map((item) => item.reportDate))];
    const earningsApiDates = [...new Set(conflictingEarningsApiRows.map((item) => item.reportDate))];
    const nasdaqRows = nasdaqRowsBySymbol.get(row.symbol) || [];
    const nasdaqDates = [...new Set(nasdaqRows.map((item) => item.reportDate))];
    let selectedDate = row.reportDate;
    let selectedProvider = 'finnhub';
    let selectedDateSource = 'finnhub_fallback';
    let reason = 'nasdaq_unavailable_or_unmatched_finnhub_symbol_present';

    if (options.allowNasdaqResolution !== false && finnhubDates.length === 1 && earningsApiDates.length === 1 && nasdaqDates.length === 1) {
      if (nasdaqDates[0] === finnhubDates[0]) {
        selectedDate = finnhubDates[0];
        selectedProvider = 'finnhub';
        selectedDateSource = 'nasdaq';
        reason = 'nasdaq_matched_finnhub_date';
      } else if (nasdaqDates[0] === earningsApiDates[0]) {
        const selectedEarningsApiRow = conflictingEarningsApiRows.find((item) => item.reportDate === nasdaqDates[0]);
        const selectedNasdaqRow = nasdaqRows.find((item) => item.reportDate === nasdaqDates[0]);
        selectedDate = earningsApiDates[0];
        selectedProvider = 'earningsApiCalendar';
        selectedDateSource = 'nasdaq';
        reason = 'nasdaq_matched_earningsapi_date';
        row.reportDate = selectedDate;
        row.reportTiming = selectedNasdaqRow?.reportTiming !== 'unknown' && selectedNasdaqRow?.reportTiming === selectedEarningsApiRow?.reportTiming
          ? selectedNasdaqRow.reportTiming
          : 'unknown';
      }
    }

    const audit = providerDateConflictAudit(
      row.symbol,
      originalFinnhubRowsForSymbol,
      conflictingEarningsApiRows,
      nasdaqRows,
      selectedDate,
      selectedProvider,
      selectedDateSource,
      reason
    );
    for (const item of finnhubRowsForSymbol) item.providerDateConflict = audit;
    conflictsBySymbol.set(row.symbol, audit);
  }

  const resolvedEarningsApiCalendarDays = earningsApiCalendarDays.map((day) => {
    const rows = (day.rows || []).filter((row) => !conflictsBySymbol.has(row.symbol));
    return cloneCalendarDay(day, rows);
  });

  return {
    finnhubRows: dedupeCalendarRows(resolvedFinnhubRows),
    earningsApiCalendarDays: resolvedEarningsApiCalendarDays,
    providerDateConflicts: [...conflictsBySymbol.values()]
  };
}

function readScheduleConfirmations(file) {
  if (!fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.rows)) {
    throw new Error('earnings_schedule_confirmations.json must contain schemaVersion 1 and rows[].');
  }
  const seen = new Set();
  return payload.rows.map((row, index) => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const reportDate = String(row?.reportDate || '').trim();
    const sourceUrl = String(row?.sourceUrl || '').trim();
    const sourceName = String(row?.sourceName || '').trim();
    if (!/^[A-Z0-9.-]+$/.test(symbol) || !isIsoDate(reportDate) || !/^https:\/\//.test(sourceUrl) || !sourceName) {
      throw new Error(`earnings_schedule_confirmations.rows[${index}] must provide symbol, ISO reportDate, sourceName, and HTTPS sourceUrl.`);
    }
    if (seen.has(symbol)) throw new Error(`earnings_schedule_confirmations contains duplicate ${symbol}.`);
    seen.add(symbol);
    return { symbol, reportDate, sourceUrl, sourceName };
  });
}

function scheduleAudit(status, row, secondaryDates, official = null) {
  return {
    status,
    primaryDate: row.reportDate,
    secondaryDates,
    official
  };
}

function verifyFinnhubScheduleRows(rows, earningsApiCalendarDays, range, confirmations = []) {
  const activeDates = new Set(displayDatesForRange(range.from, range.to));
  const secondaryDatesBySymbol = new Map();
  for (const candidate of earningsApiCalendarDays.flatMap((day) => day.rows || [])) {
    if (!secondaryDatesBySymbol.has(candidate.symbol)) secondaryDatesBySymbol.set(candidate.symbol, new Set());
    secondaryDatesBySymbol.get(candidate.symbol).add(candidate.reportDate);
  }
  const confirmationsBySymbol = new Map(confirmations.map((row) => [row.symbol, row]));
  const review = [];
  const verifiedRows = [];

  for (const row of rows) {
    if (!isDisplayEligibleEarningsRow(row)) {
      verifiedRows.push(row);
      continue;
    }
    const secondaryDates = [...(secondaryDatesBySymbol.get(row.symbol) || new Set())].sort();
    const confirmation = confirmationsBySymbol.get(row.symbol) || null;
    const datesAgree = secondaryDates.length === 1 && secondaryDates[0] === row.reportDate;
    const hasCrossWeekConflict = secondaryDates.some((date) => !activeDates.has(date));
    const hasInWeekConflict = secondaryDates.length > 0 && !datesAgree && !hasCrossWeekConflict;

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
    const reason = hasCrossWeekConflict
      ? 'cross_week_calendar_date_conflict'
      : hasInWeekConflict
        ? 'in_week_calendar_date_conflict'
        : 'uncorroborated_primary_calendar_date';
    review.push({
      symbol: row.symbol,
      company: row.company,
      primaryDate: row.reportDate,
      secondaryDates,
      reason,
      required: 'official_company_ir_date_confirmation'
    });
  }
  return { rows: verifiedRows, review };
}

function verifyEarningsApiRecoveryRows(rows, range, confirmations = []) {
  const activeDates = new Set(displayDatesForRange(range.from, range.to));
  const confirmationsBySymbol = new Map(confirmations.map((row) => [row.symbol, row]));
  const verifiedRows = [];
  const review = [];
  for (const row of rows) {
    if (!isDisplayEligibleEarningsRow(row)) {
      verifiedRows.push(row);
      continue;
    }
    const confirmation = confirmationsBySymbol.get(row.symbol) || null;
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
    review.push({
      symbol: row.symbol,
      company: row.company,
      primaryDate: row.reportDate,
      secondaryDates: [],
      reason: 'uncorroborated_earningsapi_recovery_date',
      required: 'official_company_ir_date_confirmation'
    });
  }
  return { rows: verifiedRows, review };
}

function buildSecondaryRecoveryCandidates(finnhubRows, earningsApiCalendarDays, profiles) {
  const finnhubKeys = new Set(finnhubRows.map((row) => `${row.reportDate}:${row.symbol}`));
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const seen = new Set();
  const tasks = [];
  for (const row of earningsApiCalendarDays.flatMap((day) => day.rows)) {
    const key = `${row.reportDate}:${row.symbol}`;
    if (finnhubKeys.has(key)) continue;
    if (seen.has(key)) continue;
    const profile = profilesBySymbol.get(row.symbol);
    if (!profileIsDisplayEligible(profile)) continue;
    seen.add(key);
    tasks.push({
      id: `${row.reportDate}:${row.symbol}:earningsapi-recovery`,
      symbol: row.symbol,
      company: profile?.name || row.company || row.symbol,
      reportDate: row.reportDate,
      trigger: 'missing_from_finnhub_but_present_in_earningsapi',
      priority: secondaryRecoveryPriority(row, profile),
      marketCap: profile.marketCap,
      marketCapDisplay: marketCapDisplay(profile.marketCap),
      fiscalQuarterEnding: '',
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
      instructions: 'Use EarningsAPI only to recover display-scale events missing from Finnhub. Do not override Finnhub rows.',
      permittedUses: [
        'missing_row_discovery',
        'eps_estimate_recovery',
        'eps_actual_recovery',
        'revenue_estimate_recovery',
        'revenue_actual_recovery'
      ],
      sourceAudit: {
        earningsApiCalendar: {
          reportDate: row.reportDate,
          company: row.company,
          eps: {
            estimate: row.eps.estimate,
            actual: row.eps.actual
          },
          revenue: {
            estimate: row.revenue.estimate,
            actual: row.revenue.actual
          },
          reportTiming: row.reportTiming,
          bucket: row.source.bucket
        },
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

function companyReleaseReason(row) {
  if (!row) return 'missing_recovered_row';
  if (row.reportTiming === 'unknown') return 'missing_report_timing';
  if (!Number.isFinite(row.eps?.actual)) return 'missing_eps_actual';
  if (!Number.isFinite(row.revenue?.actual)) return 'missing_revenue_actual';
  return '';
}

function companyReleaseTaskFromRecovery(task, row, reason) {
  return {
    id: `${task.reportDate}:${task.symbol}:company-release`,
    recoveryId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    trigger: 'secondary_recovery_requires_company_release',
    reason,
    priority: task.priority,
    marketCap: task.marketCap,
    marketCapDisplay: task.marketCapDisplay,
    fiscalQuarterEnding: task.fiscalQuarterEnding || '',
    neededFields: [
      'reportTiming',
      'fiscalPeriod',
      'eps.actual',
      'revenue.actual',
      'companyReleaseUrl',
      'secFilingUrl'
    ],
    preferredSources: [
      'SEC 8-K Exhibit 99.1',
      'Company investor relations earnings release'
    ],
    doNotUseForOverrides: ['finnhub_calendar_row'],
    permittedUses: [
      'official_actuals_resolution',
      'timing_resolution',
      'fiscal_period_resolution',
      'eps_basis_resolution'
    ],
    instructions: 'Use SEC/company release only when a recovered EarningsAPI row is missing official timing or actuals. Do not override Finnhub rows.',
    sourceAudit: {
      ...task.sourceAudit,
      recoveredRow: {
        reportDate: row?.reportDate || task.reportDate,
        reportTiming: row?.reportTiming || 'unknown',
        eps: {
          estimate: row?.eps?.estimate ?? null,
          actual: row?.eps?.actual ?? null
        },
        revenue: {
          estimate: row?.revenue?.estimate ?? null,
          actual: row?.revenue?.actual ?? null
        },
        sourceStatus: row?.sourceStatus || 'missing'
      }
    }
  };
}

const DATE_CONFLICT_RELEASE_MIN_MARKET_CAP = 250000000;

function companyReleaseTaskFromDateConflict(row, reason) {
  return {
    id: `${row.reportDate}:${row.symbol}:company-release`,
    recoveryId: '',
    symbol: row.symbol,
    company: row.company,
    reportDate: row.reportDate,
    trigger: 'provider_date_conflict_requires_company_release',
    reason,
    priority: Number(row.marketCap) >= 10000000000 ? 'high' : 'normal',
    marketCap: row.marketCap,
    marketCapDisplay: row.marketCapDisplay,
    fiscalQuarterEnding: row.fiscalQuarterEnding || '',
    neededFields: [
      'reportTiming',
      'fiscalPeriod',
      'eps.actual',
      'revenue.actual',
      'companyReleaseUrl',
      'secFilingUrl'
    ],
    preferredSources: [
      'SEC 8-K Exhibit 99.1',
      'Company investor relations earnings release'
    ],
    doNotUseForOverrides: ['finnhub_calendar_row'],
    permittedUses: [
      'official_actuals_resolution',
      'timing_resolution',
      'fiscal_period_resolution',
      'eps_basis_resolution'
    ],
    instructions: 'Use SEC/company release only to resolve actuals and timing after a verified provider-date conflict. Keep Finnhub estimates for comparison.',
    sourceAudit: row.sourceAudit
  };
}

function buildCompanyReleaseTasks(secondaryRecoveryCandidates, rows, options = {}) {
  const rowsByKey = new Map(rows.map((row) => [`${row.reportDate}:${row.symbol}`, row]));
  const recoveryTasks = secondaryRecoveryCandidates.flatMap((task) => {
    const row = rowsByKey.get(`${task.reportDate}:${task.symbol}`);
    const reason = companyReleaseReason(row);
    return reason ? [companyReleaseTaskFromRecovery(task, row, reason)] : [];
  });
  const conflictTasks = rows.flatMap((row) => {
    const conflict = row.sourceAudit?.providerDateConflict;
    if (!conflict || conflict.status !== 'resolved' || conflict.selectedProvider === 'finnhub') return [];
    if (!Number.isFinite(row.marketCap) || row.marketCap < DATE_CONFLICT_RELEASE_MIN_MARKET_CAP) return [];
    if (!options.shouldEscalateDateConflict?.(row)) return [];
    const reason = companyReleaseReason(row);
    return reason ? [companyReleaseTaskFromDateConflict(row, reason)] : [];
  });
  return [...recoveryTasks, ...conflictTasks];
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
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

async function fetchFinnhubMetrics(rows, profiles, earningsApiCalendarDays, args, token) {
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const earningsApiByKey = earningsApiRowsByKey(earningsApiCalendarDays);
  const symbols = [...new Set(rows
    .filter((row) => !profileHasIdentity(profilesBySymbol.get(row.symbol)))
    .filter((row) => earningsApiByKey.get(`${row.reportDate}:${row.symbol}`)?.company)
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

function valueOutcome(actual, estimate) {
  if (!Number.isFinite(actual) || !Number.isFinite(estimate)) return 'unknown';
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'met';
}

function metricResult(actual, estimate) {
  if (!Number.isFinite(actual)) return 'pending';
  if (!Number.isFinite(estimate)) return 'not_compared';
  return valueOutcome(actual, estimate);
}

function combinedOutcome(epsResult, revenueResult) {
  const comparable = [epsResult, revenueResult].filter((item) => ['beat', 'miss', 'met'].includes(item));
  if (comparable.length === 0) return 'pending';
  if (comparable.length === 1) {
    if (epsResult === 'beat' && revenueResult === 'not_compared') return 'eps_only_beat';
    if (epsResult === 'miss' && revenueResult === 'not_compared') return 'eps_only_miss';
    return comparable[0];
  }
  if (comparable.every((item) => item === 'beat' || item === 'met')) return 'beat';
  if (comparable.every((item) => item === 'miss' || item === 'met')) return 'miss';
  return 'mixed';
}

function metricPayload(estimate, actual, options = {}) {
  return {
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate),
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

function earningsApiRowsByKey(earningsApiCalendarDays) {
  const byKey = new Map();
  for (const row of earningsApiCalendarDays.flatMap((day) => day.rows || [])) {
    const key = `${row.reportDate}:${row.symbol}`;
    const current = byKey.get(key);
    if (!current || rowCompletenessScore(row) > rowCompletenessScore(current)) byKey.set(key, row);
  }
  return byKey;
}

function profileRecoveryForRow(calendarRow, profile, metricsBySymbol, earningsApiByKey) {
  if (profileHasIdentity(profile)) return null;
  const metric = metricsBySymbol.get(calendarRow.symbol);
  const earningsApiRow = earningsApiByKey.get(`${calendarRow.reportDate}:${calendarRow.symbol}`);
  if (!Number.isFinite(metric?.marketCap) || metric.marketCap < SECONDARY_RECOVERY_MIN_MARKET_CAP) return null;
  if (!earningsApiRow?.company) return null;
  // Identity-only recovery: Finnhub remains the source for the earnings row.
  // These fallback fields only decide whether a profile-empty row can be displayed.
  return {
    company: earningsApiRow.company,
    country: '',
    exchange: '',
    currency: '',
    marketCap: metric.marketCap,
    marketCapDisplay: marketCapDisplay(metric.marketCap),
    earningsApiCalendar: earningsApiRow,
    finnhubMetric: metric
  };
}

function conflictRecoveryForRow(providerDateConflict, profile) {
  if (!providerDateConflict || profileHasIdentity(profile)) return null;
  const selectedDate = providerDateConflict.selectedDate;
  const earningsApiCandidate = (providerDateConflict.candidates?.earningsApiCalendar || [])
    .find((item) => item.reportDate === selectedDate);
  const nasdaqCandidate = (providerDateConflict.candidates?.nasdaq || [])
    .find((item) => item.reportDate === selectedDate);
  const marketCap = Number.isFinite(nasdaqCandidate?.marketCap) ? nasdaqCandidate.marketCap : null;
  const company = earningsApiCandidate?.company || nasdaqCandidate?.company || '';
  if (!company && !Number.isFinite(marketCap)) return null;
  // Conflict recovery only preserves display identity after a strict date decision.
  // EPS/revenue remain tied to the selected calendar provider above.
  return {
    company,
    country: '',
    exchange: '',
    currency: '',
    marketCap,
    marketCapDisplay: marketCapDisplay(marketCap),
    earningsApiCalendar: earningsApiCandidate || null,
    nasdaqCalendar: nasdaqCandidate || null
  };
}

function buildRows(calendarRows, profiles, options = {}) {
  const profilesBySymbol = new Map(profiles.map((profile) => [profile.symbol, profile]));
  const metricsBySymbol = new Map((options.finnhubMetrics || []).map((metric) => [metric.symbol, metric]));
  const earningsApiByKey = earningsApiRowsByKey(options.earningsApiCalendarDays || []);
  return calendarRows.map((calendarRow) => {
    const profile = profilesBySymbol.get(calendarRow.symbol);
    const profileRecovery = profileRecoveryForRow(calendarRow, profile, metricsBySymbol, earningsApiByKey);
    const providerDateConflict = calendarRow.providerDateConflict || null;
    const conflictRecovery = conflictRecoveryForRow(providerDateConflict, profile);
    const auditedFinnhubCalendar = providerDateConflict?.candidates?.finnhub?.[0] || calendarRow;
    const company = profile?.name || profileRecovery?.company || conflictRecovery?.company || calendarRow.symbol;
    const marketCap = profile?.marketCap ?? profileRecovery?.marketCap ?? conflictRecovery?.marketCap ?? null;
    const fallbacks = profileRecovery
      ? ['earningsApiCalendar', 'finnhubMetric']
      : conflictRecovery ? ['providerDateConflict'] : [];
    const eps = metricPayload(calendarRow.eps.estimate, calendarRow.eps.actual, {
      basis: '',
      note: ''
    });
    const revenue = metricPayload(calendarRow.revenue.estimate, calendarRow.revenue.actual, {
      note: ''
    });

    return {
      symbol: calendarRow.symbol,
      company,
      exchange: profile?.exchange || profileRecovery?.exchange || conflictRecovery?.exchange || '',
      country: profile?.country || profileRecovery?.country || conflictRecovery?.country || '',
      currency: profile?.currency || profileRecovery?.currency || conflictRecovery?.currency || '',
      marketCap,
      marketCapDisplay: marketCapDisplay(marketCap),
      reportDate: calendarRow.reportDate,
      reportTiming: calendarRow.reportTiming,
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
        finnhubCalendar: {
          reportDate: auditedFinnhubCalendar.reportDate,
          reportTiming: auditedFinnhubCalendar.reportTiming,
          fiscalQuarter: calendarRow.fiscalQuarter,
          fiscalYear: calendarRow.fiscalYear,
          eps: {
            estimate: calendarRow.eps.estimate,
            actual: calendarRow.eps.actual
          },
          revenue: {
            estimate: calendarRow.revenue.estimate,
            actual: calendarRow.revenue.actual
          }
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
        earningsApiCalendar: profileRecovery ? {
          reportDate: profileRecovery.earningsApiCalendar.reportDate,
          company: profileRecovery.earningsApiCalendar.company,
          eps: {
            estimate: profileRecovery.earningsApiCalendar.eps.estimate,
            actual: profileRecovery.earningsApiCalendar.eps.actual
          },
          revenue: {
            estimate: profileRecovery.earningsApiCalendar.revenue.estimate,
            actual: profileRecovery.earningsApiCalendar.revenue.actual
          },
          reportTiming: profileRecovery.earningsApiCalendar.reportTiming,
          bucket: profileRecovery.earningsApiCalendar.source.bucket
        } : null,
        providerDateConflict,
        selectedSources: {
          slate: 'finnhub',
          company: profile?.name ? 'finnhubProfile' : profileRecovery?.company ? 'earningsApiCalendar' : conflictRecovery?.company ? 'providerDateConflict' : 'symbol',
          marketCap: Number.isFinite(profile?.marketCap) ? 'finnhubProfile' : Number.isFinite(profileRecovery?.marketCap) ? 'finnhubMetric' : Number.isFinite(conflictRecovery?.marketCap) ? 'providerDateConflict' : 'none',
          timing: calendarRow.reportTiming === 'unknown' ? 'none' : 'finnhub',
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
      reportTiming: companyRow.reportTiming,
      eps: {
        estimate: companyRow.eps.estimate,
        actual: companyRow.eps.actual
      },
      revenue: {
        estimate: companyRow.revenue.estimate,
        actual: companyRow.revenue.actual
      }
    } : null,
    rowCount: fetch?.rows?.length || 0,
    error: fetch?.error || ''
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

function buildEarningsApiRows(tasks, companyFetches) {
  const fetchesBySymbol = new Map(companyFetches.map((item) => [item.symbol, item]));
  return tasks.map((task) => {
    const fetch = fetchesBySymbol.get(task.symbol);
    const companyRow = selectEarningsApiCompanyRow(fetch, task);
    if (!companyRow) return null;
    const profile = task.sourceAudit.finnhubProfile;
    const eps = metricPayload(companyRow.eps.estimate, companyRow.eps.actual, {
      basis: '',
      note: ''
    });
    const revenue = metricPayload(companyRow.revenue.estimate, companyRow.revenue.actual, {
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
      sourceSummary: sourceSummary('earningsApiCompany', ['earningsApiCalendar', 'finnhubProfile']),
      sourceAudit: {
        finnhubCalendar: {
          present: false
        },
        finnhubProfile: profile || null,
        earningsApiCalendar: task.sourceAudit.earningsApiCalendar,
        earningsApiCompany: task.sourceAudit.earningsApiCompany || earningsApiCompanyAudit(fetch, companyRow),
        selectedSources: {
          slate: 'earningsApiCalendar',
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

function yahooPeriodSeconds(isoDate) {
  return Math.floor(dateFromIso(isoDate).getTime() / 1000);
}

async function fetchYahooBars(symbol, from, to, args) {
  const start = addDays(from, -REACTION_LOOKBACK_DAYS);
  const endExclusive = addDays(to, REACTION_LOOKAHEAD_DAYS + 1);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${yahooPeriodSeconds(start)}&period2=${yahooPeriodSeconds(endExclusive)}&interval=1d&events=history`;
  const result = await fetchJson(url, args);
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
    error: result.ok ? '' : result.parseError || result.bodyPreview || chart?.error?.description || `HTTP ${result.status}`
  };
}

async function fetchYahooBarsForRows(rows, args) {
  const output = [];
  for (const row of rows) {
    output.push(await fetchYahooBars(row.symbol, args.from, args.to, args));
  }
  return output;
}

function previousBar(bars, date) {
  return [...bars].filter((bar) => compareIsoDate(bar.date, date) < 0).pop() || null;
}

function barOnOrAfter(bars, date) {
  return bars.find((bar) => compareIsoDate(bar.date, date) >= 0) || null;
}

function barAfter(bars, date) {
  return bars.find((bar) => compareIsoDate(bar.date, date) > 0) || null;
}

function attachReactions(rows, yahooFetches) {
  const yahooBySymbol = new Map(yahooFetches.map((item) => [item.symbol, item]));
  return rows.map((row) => {
    const yahoo = yahooBySymbol.get(row.symbol);
    const bars = yahoo?.bars || [];
    let basis = 'unavailable';
    let fromBar = null;
    let toBar = null;

    if (row.reportTiming === 'bmo' || row.reportTiming === 'dmh') {
      basis = row.reportTiming === 'bmo' ? 'same_day_close' : 'during_market_close';
      fromBar = previousBar(bars, row.reportDate);
      toBar = barOnOrAfter(bars, row.reportDate);
    } else if (row.reportTiming === 'amc') {
      basis = 'next_session_close';
      fromBar = barOnOrAfter(bars, row.reportDate);
      toBar = barAfter(bars, row.reportDate);
    }

    const reactionPct = fromBar && toBar ? pctChange(fromBar.close, toBar.close) : null;
    const hasReportedActual = Number.isFinite(row.eps.actual) || Number.isFinite(row.revenue.actual);
    const reactionStatus = reactionPct !== null ? 'computed' : hasReportedActual ? 'unavailable' : 'pending';
    const output = {
      ...row,
      sourceSummary: {
        ...row.sourceSummary,
        reaction: reactionPct === null ? 'none' : 'yahoo'
      },
      reaction: {
        basis: reactionPct === null ? 'unavailable' : basis,
        percent: reactionPct,
        fromDate: fromBar?.date || '',
        fromClose: fromBar?.close ?? null,
        toDate: toBar?.date || '',
        toClose: toBar?.close ?? null,
        status: reactionStatus,
        note: '',
        source: 'Yahoo Finance Chart API'
      },
      sourceAudit: {
        ...row.sourceAudit,
        selectedSources: {
          ...row.sourceAudit.selectedSources,
          reaction: reactionPct === null ? 'none' : 'yahoo'
        },
        yahoo: {
          status: yahoo?.status ?? null,
          rowCount: bars.length,
          error: yahoo?.error || ''
        }
      }
    };
    return {
      ...output,
      sourceStatus: computeEarningsSourceStatus(output)
    };
  });
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
      earningsApiCalendar: {
        requests: fetches.earningsApiCalendarDays.length,
        ok: fetches.earningsApiCalendarDays.filter((item) => item.ok).length,
        skipped: fetches.earningsApiCalendarDays.filter((item) => item.skipped).length,
        rows: fetches.earningsApiCalendarDays.reduce((sum, item) => sum + item.rowCount, 0),
        errors: fetches.earningsApiCalendarDays.filter((item) => !item.ok && !item.skipped).map((item) => ({
          date: item.date,
          status: item.status,
          error: item.error
        }))
      },
      nasdaqCalendar: {
        requests: fetches.nasdaqCalendarDays.length,
        ok: fetches.nasdaqCalendarDays.filter((item) => item.ok).length,
        rows: fetches.nasdaqCalendarDays.reduce((sum, item) => sum + item.rowCount, 0),
        errors: fetches.nasdaqCalendarDays.filter((item) => !item.ok).map((item) => ({
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

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.FINNHUB_API_KEY;
  const earningsApiToken = process.env.EARNINGSAPI_API_KEY;
  if (!token) {
    throw new Error('FINNHUB_API_KEY is required in .env or the environment.');
  }

  const earningsApiUsage = readEarningsApiUsage(args.earningsApiUsage);
  const finnhubCalendar = await fetchFinnhubCalendar(args, token);
  ensureFinnhubPrimaryUsable(finnhubCalendar, args);

  // The secondary scan intentionally reaches beyond the visible week. This
  // catches a primary-date error that otherwise looks like a missing backup row.
  const earningsApiCalendarDays = await fetchEarningsApiCalendar(
    args,
    earningsApiToken,
    earningsApiUsage,
    calendarVerificationDates(args)
  );
  const activeEarningsApiCalendarDays = earningsApiCalendarDays.filter((day) => args.displayDates.includes(day.date));
  const nasdaqCalendarDays = await fetchNasdaqCalendarForConflicts(finnhubCalendar.rows, activeEarningsApiCalendarDays, args);
  const calendarResolution = resolveProviderDateConflicts(
    finnhubCalendar.rows,
    activeEarningsApiCalendarDays,
    nasdaqCalendarDays,
    { allowNasdaqResolution: false }
  );
  const earningsApiCandidateRows = calendarResolution.earningsApiCalendarDays
    .flatMap((day) => day.rows)
    .filter((row) => !calendarResolution.finnhubRows.some((finnhubRow) => finnhubRow.symbol === row.symbol && finnhubRow.reportDate === row.reportDate));
  const profileRows = [...earningsApiCandidateRows, ...calendarResolution.finnhubRows];
  const finnhubProfiles = await fetchFinnhubProfiles(profileRows, args, token);
  const finnhubMetrics = await fetchFinnhubMetrics(calendarResolution.finnhubRows, finnhubProfiles, calendarResolution.earningsApiCalendarDays, args, token);
  const secondaryRecoveryCandidatesBase = buildSecondaryRecoveryCandidates(calendarResolution.finnhubRows, calendarResolution.earningsApiCalendarDays, finnhubProfiles);
  const earningsApiCompanyFetches = await fetchEarningsApiCompanies(secondaryRecoveryCandidatesBase, args, earningsApiToken, earningsApiUsage);
  const secondaryRecoveryCandidates = attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(secondaryRecoveryCandidatesBase, earningsApiCompanyFetches);
  const finnhubRows = buildRows(calendarResolution.finnhubRows, finnhubProfiles, {
    finnhubMetrics,
    earningsApiCalendarDays: calendarResolution.earningsApiCalendarDays
  });
  const scheduleConfirmations = readScheduleConfirmations(args.scheduleConfirmations);
  const scheduleVerification = verifyFinnhubScheduleRows(
    finnhubRows,
    earningsApiCalendarDays,
    { from: args.from, to: args.to },
    scheduleConfirmations
  );
  const earningsApiRows = buildEarningsApiRows(secondaryRecoveryCandidates, earningsApiCompanyFetches);
  const earningsApiScheduleVerification = verifyEarningsApiRecoveryRows(
    earningsApiRows,
    { from: args.from, to: args.to },
    scheduleConfirmations
  );
  fs.mkdirSync(path.dirname(args.scheduleReview), { recursive: true });
  fs.writeFileSync(args.scheduleReview, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    range: { from: args.from, to: args.to },
    rows: [...scheduleVerification.review, ...earningsApiScheduleVerification.review],
    outputPath: args.scheduleReview
  }, null, 2)}\n`);
  const mergedRows = [...scheduleVerification.rows, ...earningsApiScheduleVerification.rows].sort((left, right) => {
    const dateCompare = left.reportDate.localeCompare(right.reportDate);
    if (dateCompare) return dateCompare;
    return left.symbol.localeCompare(right.symbol);
  });
  const yahooFetches = await fetchYahooBarsForRows(mergedRows, args);
  const rows = attachReactions(mergedRows, yahooFetches);
  const companyReleaseTasks = buildCompanyReleaseTasks(secondaryRecoveryCandidates, rows);
  const earningsApiEntry = earningsApiMonthEntry(earningsApiUsage);

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    range: {
      from: args.from,
      to: args.to
    },
    policy: buildEarningsWeekPolicy(),
    rows,
    secondaryRecoveryCandidates,
    companyReleaseTasks,
    summary: summarize(rows, {
      finnhubCalendar,
      finnhubProfiles,
      finnhubMetrics,
      earningsApiCalendarDays: calendarResolution.earningsApiCalendarDays,
      nasdaqCalendarDays,
      earningsApiCompanyFetches,
      earningsApiBudget: {
        usageFile: path.relative(process.cwd(), args.earningsApiUsage),
        month: earningsApiUsageMonth(),
        callsUsed: earningsApiEntry.calls,
        monthlyLimit: args.earningsApiMonthlyLimit,
        reserve: args.earningsApiReserve,
        callsAvailableForThisScript: Math.max(0, args.earningsApiMonthlyLimit - args.earningsApiReserve - earningsApiEntry.calls),
        skipped: args.skipEarningsApi || !earningsApiToken
      },
      yahooFetches
    }, secondaryRecoveryCandidates, companyReleaseTasks),
    outputPath: args.output
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);
  printReport(payload, args.compact);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  attachReactions,
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  buildEarningsApiRows,
  buildSecondaryRecoveryCandidates,
  buildRows,
  buildCompanyReleaseTasks,
  calendarVerificationDates,
  combinedOutcome,
  ensureFinnhubPrimaryUsable,
  fetchNasdaqCalendarForConflicts,
  fetchFinnhubMetrics,
  fetchYahooBarsForRows,
  profileFromCache,
  resolveProviderDateConflicts,
  verifyEarningsApiRecoveryRows,
  verifyFinnhubScheduleRows,
  storeProfileInCache,
  valueOutcome
};
