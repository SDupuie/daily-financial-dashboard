#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./staging_writer');
const { mapConcurrent } = require('./fetch_concurrency');
const {
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsApiUsageDay,
  earningsCalendarRangeNeedsBuild,
  earningsNarrativeDispositions,
  earningsRowKey: rowKey,
  applyEarningsLifecycle,
  metricResult,
  isDisplayEligibleEarningsRow,
  needsYahooReactionFetch,
  numberOrNull,
  pctChange,
  reportWindowArrived
} = require('./earnings_week_contract');
const {
  buildZacksRows,
  fetchYahooBars,
  fetchZacksCalendar,
  runBuild,
  zacksGate
} = require('./earnings_week_build');
const {
  runValidation,
  validateEarningsWeekPayload
} = require('./earnings_week_validation');
const root = path.resolve(__dirname, '..');
const DEFAULT_EARNINGS_WEEK = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_NARRATIVE = path.resolve(root, 'generated', 'earnings_narrative.json');
const SECONDARY_CALENDAR_SLATES = new Set(['alphaVantageCalendar']);

function isSecondaryCalendarSlate(value) {
  return SECONDARY_CALENDAR_SLATES.has(value);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js <command> [options]

Commands:
  build             Build generated/earnings_week.json
  refresh           Refresh arrived earnings rows in the existing week artifact
  apply-narrative   Apply earnings narrative sidecar to the week artifact
  repair-source-audit  Restore source audit metadata for a manual recovery artifact
  validate          Validate the earnings week artifact

Run node scripts/earnings_week.js <command> --help for command-specific options.
Examples:
  node scripts/earnings_week.js build --from 2026-07-06 --to 2026-07-10
  node scripts/earnings_week.js refresh
  node scripts/earnings_week.js apply-narrative
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Legacy manual-recovery rows may predate sourceAudit; only Finnhub-primary
// rows can be repaired without inventing secondary-source provenance.
function recoveredRowSourceAudit(row) {
  if (row?.sourceAudit?.selectedSources) return row;
  if (row?.sourceAudit) throw new Error(`${row.symbol || 'Earnings row'} has an incomplete sourceAudit; rebuild the artifact from its original sources.`);
  if (row?.sourceSummary?.primary !== 'finnhub') {
    throw new Error(`${row?.symbol || 'Earnings row'} has no sourceAudit and cannot be recovered without a Finnhub primary source.`);
  }
  const sourceFor = (value) => Number.isFinite(value) ? 'finnhub' : 'none';
  return {
    ...row,
    sourceAudit: {
      recoveredFrom: 'manual_schedule_review',
      finnhubUsListing: null,
      finnhubCalendar: {
        reportDate: row.reportDate,
        reportTiming: row.reportTiming,
        fiscalQuarter: row.fiscalQuarter,
        fiscalYear: row.fiscalYear,
        eps: { estimate: row.eps?.estimate ?? null, actual: row.eps?.actual ?? null },
        revenue: { estimate: row.revenue?.estimate ?? null, actual: row.revenue?.actual ?? null }
      },
      finnhubProfile: {
        name: row.company,
        ticker: row.symbol,
        exchange: row.exchange,
        country: row.country,
        currency: row.currency,
        marketCap: row.marketCap
      },
      finnhubMetric: null,
      alphaVantageCalendar: null,
      providerDateConflict: null,
      scheduleVerification: {
        status: 'primary_only',
        primaryDate: row.reportDate,
        secondaryDates: [],
        official: null
      },
      selectedSources: {
        slate: 'finnhub',
        company: 'finnhubProfile',
        marketCap: Number.isFinite(row.marketCap) ? 'finnhubProfile' : 'none',
        timing: row.reportTiming === 'unknown' ? 'none' : 'finnhub',
        eps: { estimate: sourceFor(row.eps?.estimate), actual: sourceFor(row.eps?.actual) },
        revenue: { estimate: sourceFor(row.revenue?.estimate), actual: sourceFor(row.revenue?.actual) },
        reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
      }
    }
  };
}

function repairRecoveredEarningsSourceAudit(source) {
  return {
    ...source,
    rows: (source?.rows || []).map(recoveredRowSourceAudit)
  };
}

function assertRefreshSourceAudit(source) {
  for (const row of source?.rows || []) {
    if (!row?.sourceAudit?.selectedSources) {
      throw new Error(`${row?.symbol || 'Earnings row'} is missing sourceAudit.selectedSources. Run earnings_week.js repair-source-audit before refresh.`);
    }
  }
}

function parseRepairSourceAuditArgs(argv) {
  const args = { input: DEFAULT_EARNINGS_WEEK, output: DEFAULT_EARNINGS_WEEK };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '--output') {
      args[arg.slice(2)] = path.resolve(process.cwd(), argv[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`Unknown repair-source-audit option: ${arg}`);
  }
  return args;
}

function repairSourceAuditCommand(argv) {
  const args = parseRepairSourceAuditArgs(argv);
  const output = repairRecoveredEarningsSourceAudit(readJson(args.input));
  const errors = validateEarningsWeekPayload(output);
  if (errors.length) throw new Error(`Recovered earnings source audit is invalid: ${errors.join(' ')}`);
  atomicWriteJson(args.output, output);
  process.stdout.write(`Repaired source audit for ${output.rows.length} earnings row(s) at ${args.output}\n`);
}

function secondaryCalendarAttemptFailed(week) {
  const attempt = week?.summary?.fetches?.secondaryCalendar;
  if (!attempt || typeof attempt !== 'object') return false;
  const requests = Number(attempt.requests) || 0;
  const ok = Number(attempt.ok) || 0;
  const skipped = Number(attempt.skipped) || 0;
  const rows = Number(attempt.rows) || 0;
  const errors = Array.isArray(attempt.errors) ? attempt.errors : [];
  return requests > 0 && (ok < requests || skipped > 0 || errors.length > 0 || rows === 0);
}

function earningsCalendarNeedsBuild(range, earningsWeekPath = DEFAULT_EARNINGS_WEEK, now = new Date()) {
  if (!fs.existsSync(earningsWeekPath)) return earningsCalendarRangeNeedsBuild(range, null);
  try {
    const week = readJson(earningsWeekPath);
    if (earningsCalendarRangeNeedsBuild(range, week.range)) return true;
    return earningsCalendarFailedAttemptNeedsRetry(range, earningsWeekPath, now);
  } catch (_error) {
    return Boolean(range);
  }
}

function earningsCalendarFailedAttemptNeedsRetry(range, earningsWeekPath = DEFAULT_EARNINGS_WEEK, now = new Date()) {
  if (!fs.existsSync(earningsWeekPath)) return false;
  try {
    const week = readJson(earningsWeekPath);
    if (earningsCalendarRangeNeedsBuild(range, week.range)) return false;
    const primaryOnly = (week.rows || []).some((row) => isDisplayEligibleEarningsRow(row)
      && row.sourceAudit?.scheduleVerification?.status === 'primary_only');
    return primaryOnly
      && secondaryCalendarAttemptFailed(week)
      && earningsApiUsageDay(week.generatedAt) !== earningsApiUsageDay(now);
  } catch (_error) {
    return false;
  }
}

function writeJson(file, payload) {
  atomicWriteJson(file, payload);
}

function parseApplyNarrativeArgs(argv) {
  const args = {
    input: DEFAULT_EARNINGS_WEEK,
    narrative: DEFAULT_NARRATIVE,
    output: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
      i += 1;
      continue;
    }
    if (arg === '--narrative') {
      args.narrative = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_NARRATIVE);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/earnings_week.js apply-narrative [options]

Options:
  --input PATH       Earnings week JSON to update (default: generated/earnings_week.json)
  --narrative PATH   Canonical narrative JSON (default: generated/earnings_narrative.json)
  --output PATH      Output earnings week JSON (default: overwrite --input)
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.output) args.output = args.input;
  return args;
}

function metricPayload(fields, metric, options = {}) {
  const estimate = numberOrNull(fields?.estimate);
  const actual = numberOrNull(fields?.actual);
  return {
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate, metric),
    ...options
  };
}

function sourceRangeMatches(left, right) {
  return left?.from === right?.from && left?.to === right?.to;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function validateNarrativePayload(source, narrativePayload, options = {}) {
  if (!narrativePayload || typeof narrativePayload !== 'object' || Array.isArray(narrativePayload)) {
    throw new Error('Narrative payload must be an object.');
  }
  if (narrativePayload.schemaVersion !== 1) {
    throw new Error('Narrative payload schemaVersion must be 1.');
  }
  if (narrativePayload.sourceArtifact !== options.sourceArtifact) {
    throw new Error(`Narrative payload sourceArtifact must be ${options.sourceArtifact}.`);
  }
  if (narrativePayload.sourceGeneratedAt !== source.generatedAt) {
    throw new Error('Narrative payload sourceGeneratedAt must match the source earnings week generatedAt.');
  }
  if (!sourceRangeMatches(narrativePayload.sourceRange, source.range)) {
    throw new Error('Narrative payload sourceRange must match the source earnings week range.');
  }
  if (!Array.isArray(narrativePayload.rows) || narrativePayload.rows.length === 0) {
    throw new Error('Narrative payload rows must be a non-empty array.');
  }
}

function applyMetricNote(metric, narrativeMetric) {
  if (!narrativeMetric || !Object.prototype.hasOwnProperty.call(narrativeMetric, 'note')) return metric;
  return {
    ...metric,
    note: stringValue(narrativeMetric.note)
  };
}

function applyEarningsNarrative(source, narrativePayload, options = {}) {
  validateNarrativePayload(source, narrativePayload, options);
  const output = JSON.parse(JSON.stringify(source));
  delete output.policy;
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];
  const appliedAt = new Date(options.appliedAt || Date.now()).toISOString();

  for (const item of narrativePayload.rows || []) {
    const key = rowKey(item);
    const target = rowsByKey.get(key);
    if (!target) throw new Error(`${key} narrative does not match a canonical earnings row.`);
    const row = target.row;
    const next = {
      ...row,
      eps: applyMetricNote(row.eps, item.eps),
      revenue: applyMetricNote(row.revenue, item.revenue),
      outcome: {
        ...row.outcome,
        guide: stringValue(item.outcome?.guide ?? row.outcome?.guide),
        interpretation: stringValue(item.outcome?.interpretation ?? row.outcome?.interpretation)
      },
      reaction: {
        ...row.reaction,
        note: stringValue(item.reaction?.note ?? row.reaction?.note)
      }
    };
    const dispositions = earningsNarrativeDispositions(next, {
      outcome: {
        ...next.outcome,
        ...(Object.prototype.hasOwnProperty.call(item.outcome || {}, 'guidanceDisposition')
          ? { guidanceDisposition: item.outcome.guidanceDisposition }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(item.outcome || {}, 'interpretationDisposition')
          ? { interpretationDisposition: item.outcome.interpretationDisposition }
          : {})
      },
      reaction: {
        ...next.reaction,
        ...(Object.prototype.hasOwnProperty.call(item.reaction || {}, 'commentaryDisposition')
          ? { commentaryDisposition: item.reaction.commentaryDisposition }
          : {})
      }
    }, appliedAt);
    next.outcome.interpretationDisposition = dispositions.interpretation;
    if (dispositions.guidance) next.outcome.guidanceDisposition = dispositions.guidance;
    else delete next.outcome.guidanceDisposition;
    if (dispositions.reaction) next.reaction.commentaryDisposition = dispositions.reaction;
    else delete next.reaction.commentaryDisposition;
    output.rows[target.index] = next;
    applied.push({ symbol: item.symbol, reportDate: item.reportDate });
  }

  output.narrativeApply = {
    generatedAt: appliedAt,
    narrativeArtifact: options.narrativeArtifact || narrativePayload.outputPath || '',
    applied
  };
  return output;
}

function validateWeek(file) {
  runValidation(['--input', file]);
}

function applyNarrativeCommand(argv) {
  const args = parseApplyNarrativeArgs(argv);
  const output = applyEarningsNarrative(readJson(args.input), readJson(args.narrative), {
    sourceArtifact: path.relative(root, args.input),
    narrativeArtifact: path.relative(root, args.narrative)
  });
  const outputErrors = validateEarningsWeekPayload(output);
  if (outputErrors.length) throw new Error(`Narrative-applied earnings week payload is invalid: ${outputErrors.join(' ')}`);
  writeJson(args.output, output);
  process.stdout.write(`Applied ${output.narrativeApply.applied.length} earnings narrative row(s) to ${args.output}\n`);
}

// Command factories keep refresh helper names private while the public
// earnings CLI and tests share this single implementation file.
function createRefreshCommand() {

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  attachReactions,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  emptyEarningsApiUsage,
  earningsRowKey: rowKey,
  hasEarningsApiBudget,
  isEarningsApiUsage,
  migrateEarningsApiUsage,
  metricResult,
  normalizeFinnhubCalendarFields,
  normalizeEarningsTiming: normalizeTiming,
  numberOrNull,
  pctChange,
  recordEarningsApiRequest,
  recordEarningsApiResponse
} = require('./earnings_week_contract');
const { compareIsoDate, displayDatesForRange, isIsoDate, isIsoDateTime } = require('./calendar_contract');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_EARNINGSAPI_USAGE = path.resolve(root, 'generated', 'earningsapi_usage.json');
const DEFAULT_EARNINGSAPI_DAILY_LIMIT = 100;
// The slate build holds back 20 calls. Result refresh may use that remaining
// capacity, but still stops immediately when the provider returns a 429.
const DEFAULT_EARNINGSAPI_RESERVE = 0;
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: '',
    asOf: new Date().toISOString(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    earningsApiUsage: DEFAULT_EARNINGSAPI_USAGE,
    earningsApiDailyLimit: DEFAULT_EARNINGSAPI_DAILY_LIMIT,
    earningsApiReserve: DEFAULT_EARNINGSAPI_RESERVE,
    useEarningsApi: false,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || '');
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
    if (arg === '--use-earningsapi') {
      args.useEarningsApi = true;
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

  if (!args.output) args.output = args.input;
  if (Number.isNaN(Date.parse(args.asOf))) throw new Error('--as-of must be a parseable date/time.');
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js refresh [options]

Options:
  --input PATH                Existing canonical earnings week JSON
                               (default: generated/earnings_week.json)
  --output PATH               Output earnings week JSON (default: overwrite --input)
  --as-of ISO                 Refresh rows whose report window has arrived
                               (default: now)
  --timeout-ms 20000          HTTP timeout in ms per request
  --earningsapi-usage PATH    EarningsAPI daily usage ledger
  --earningsapi-daily-limit   Daily EarningsAPI call cap (default: 100)
  --earningsapi-reserve 0     Calls excluded from this result-refresh run
  --use-earningsapi           Permit metered EarningsAPI usage for approved rollover/recovery only
  --compact                   Print compact refresh report
  --help                      Show this help

Environment:
  FINNHUB_API_KEY             Used for Finnhub-covered row actuals; absence is
                               recorded on affected rows without aborting refresh
  EARNINGSAPI_API_KEY         Used only with --use-earningsapi for previously
                               recovered rows

This result-refresh path never calls the EarningsAPI calendar endpoint.
`);
}

function loadEnv(file = path.resolve(root, '.env')) {
  if (process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1') return;
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  atomicWriteJson(file, data);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function metricPayload(current, incoming, metric, options = {}) {
  const estimate = numberOrNull(incoming?.estimate);
  const actual = numberOrNull(incoming?.actual);
  return {
    ...current,
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate, metric),
    ...options
  };
}

function sourceFor(value, source) {
  return Number.isFinite(value) ? source : 'none';
}

function fetchJson(url, args, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Daily-Financial-Dashboard/earnings-result-refresh',
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

async function fetchFinnhubCalendarRows(args, token, range) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url, args);
  if (!result.ok) {
    throw new Error(`Finnhub result refresh failed: ${result.parseError || result.bodyPreview || `HTTP ${result.status}`}`);
  }
  if (!Array.isArray(result.data?.earningsCalendar)) {
    throw new Error('Finnhub result refresh response is missing earningsCalendar[].');
  }
  return result.data.earningsCalendar
    .map(normalizeFinnhubCalendarFields)
    .filter((row) => row.symbol && isIsoDate(row.reportDate))
    .filter((row) => displayDatesForRange(range.from, range.to).includes(row.reportDate));
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
  } catch {
    // A corrupt local ledger should not turn into silent unmetered calls.
  }
  throw new Error(`EarningsAPI usage ledger is unreadable: ${file}`);
}

function writeEarningsApiUsage(file, usage) {
  writeJson(file, usage);
}

function canUseEarningsApi(args, usage, token) {
  if (!args.useEarningsApi) return false;
  if (!token) return false;
  return hasEarningsApiBudget(usage, args.earningsApiDailyLimit, args.earningsApiReserve);
}

async function fetchEarningsApiCompanyRows(symbol, args, token, usage) {
  if (!canUseEarningsApi(args, usage, token)) {
    throw new Error(`EarningsAPI company refresh is required for ${symbol}, but the API key or call budget is unavailable.`);
  }
  const url = new URL('/v1/earnings', 'https://api.earningsapi.com');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', token);
  const request = recordEarningsApiRequest(usage, {
    type: 'company-earnings-result-refresh',
    path: url.pathname,
    queryKeys: url.searchParams.keys()
  });
  writeEarningsApiUsage(args.earningsApiUsage, usage);

  const result = await fetchJson(url.toString(), args);
  recordEarningsApiResponse(request, result);
  writeEarningsApiUsage(args.earningsApiUsage, usage);
  if (!result.ok) {
    throw new Error(`EarningsAPI company refresh failed for ${symbol}: ${result.parseError || result.bodyPreview || `HTTP ${result.status}`}`);
  }
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({
    symbol: String(row?.symbol || row?.ticker || '').trim().toUpperCase(),
    reportDate: String(row?.date || '').trim(),
    reportTiming: normalizeTiming(row?.time),
    eps: {
      estimate: numberOrNull(row?.epsEstimate ?? row?.epsEstimated),
      actual: numberOrNull(row?.eps ?? row?.epsActual)
    },
    revenue: {
      estimate: numberOrNull(row?.revenueEstimate ?? row?.revenueEstimated),
      actual: numberOrNull(row?.revenue ?? row?.revenueActual)
    }
  })).filter((row) => row.symbol === symbol && isIsoDate(row.reportDate));
}

function deterministicSnapshot(row) {
  return JSON.stringify({
    actualsObservedAt: row.actualsObservedAt,
    reportTiming: row.reportTiming,
    fiscalQuarter: row.fiscalQuarter,
    fiscalYear: row.fiscalYear,
    eps: {
      estimate: row.eps?.estimate,
      actual: row.eps?.actual,
      surprisePercent: row.eps?.surprisePercent,
      result: row.eps?.result,
      basis: row.eps?.basis
    },
    revenue: {
      estimate: row.revenue?.estimate,
      actual: row.revenue?.actual,
      surprisePercent: row.revenue?.surprisePercent,
      result: row.revenue?.result
    },
    outcomeOverall: row.outcome?.overall,
    reaction: {
      basis: row.reaction?.basis,
      percent: row.reaction?.percent,
      fromDate: row.reaction?.fromDate,
      fromClose: row.reaction?.fromClose,
      toDate: row.reaction?.toDate,
      toClose: row.reaction?.toClose,
      status: row.reaction?.status,
      source: row.reaction?.source
    }
  });
}

function hasActual(row) {
  return Number.isFinite(row?.eps?.actual) || Number.isFinite(row?.revenue?.actual);
}

function actualsObservedAtForRefresh(currentRow, providerRow) {
  if (!hasActual(providerRow)) return '';
  if (hasActual(currentRow) && isIsoDateTime(currentRow.actualsObservedAt)) return currentRow.actualsObservedAt;
  return isIsoDateTime(providerRow.actualsObservedAt) ? providerRow.actualsObservedAt : '';
}

function clearNarrative(row) {
  const output = {
    ...row,
    eps: {
      ...row.eps,
      note: ''
    },
    revenue: {
      ...row.revenue,
      note: ''
    },
    outcome: {
      ...row.outcome,
      guide: '',
      interpretation: ''
    },
    reaction: {
      ...row.reaction,
      note: ''
    }
  };
  for (const field of ['guidanceDisposition', 'interpretationDisposition']) {
    if (row.outcome?.[field]?.status === 'pending_review') output.outcome[field] = structuredClone(row.outcome[field]);
    else delete output.outcome[field];
  }
  if (row.reaction?.commentaryDisposition?.status === 'pending_review') {
    output.reaction.commentaryDisposition = structuredClone(row.reaction.commentaryDisposition);
  } else {
    delete output.reaction.commentaryDisposition;
  }
  return output;
}

function preserveNarrative(row, prior) {
  const output = {
    ...row,
    eps: {
      ...row.eps,
      note: prior.eps?.note || ''
    },
    revenue: {
      ...row.revenue,
      note: prior.revenue?.note || ''
    },
    outcome: {
      ...row.outcome,
      guide: prior.outcome?.guide || '',
      interpretation: prior.outcome?.interpretation || ''
    },
    reaction: {
      ...row.reaction,
      note: prior.reaction?.note || ''
    }
  };
  for (const field of ['guidanceDisposition', 'interpretationDisposition']) {
    if (Object.prototype.hasOwnProperty.call(prior.outcome || {}, field)) output.outcome[field] = structuredClone(prior.outcome[field]);
    else delete output.outcome[field];
  }
  if (Object.prototype.hasOwnProperty.call(prior.reaction || {}, 'commentaryDisposition')) {
    output.reaction.commentaryDisposition = structuredClone(prior.reaction.commentaryDisposition);
  } else {
    delete output.reaction.commentaryDisposition;
  }
  return output;
}

function finalizeRow(row) {
  const output = {
    ...row,
    outcome: {
      ...row.outcome,
      overall: combinedOutcome(row.eps?.result, row.revenue?.result)
    },
    sourceSummary: {
      ...row.sourceSummary,
      reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
    },
    sourceAudit: {
      ...row.sourceAudit,
      selectedSources: {
        ...row.sourceAudit?.selectedSources,
        reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
      }
    }
  };
  output.sourceStatus = computeEarningsSourceStatus(output);
  return output;
}

function applyFinnhubRefresh(row, providerRow) {
  if (!providerRow) return row;
  const eps = metricPayload(row.eps, providerRow.eps, 'eps', {
    basis: row.eps?.basis || '',
    note: row.eps?.note || ''
  });
  const revenue = metricPayload(row.revenue, providerRow.revenue, 'revenue', {
    note: row.revenue?.note || ''
  });
  return finalizeRow({
    ...row,
    reportTiming: providerRow.reportTiming,
    fiscalQuarter: providerRow.fiscalQuarter,
    fiscalYear: providerRow.fiscalYear,
    eps,
    revenue,
    sourceAudit: {
      ...row.sourceAudit,
      finnhubCalendar: {
        reportDate: providerRow.reportDate,
        reportTiming: providerRow.reportTiming,
        fiscalQuarter: providerRow.fiscalQuarter,
        fiscalYear: providerRow.fiscalYear,
        eps: {
          estimate: providerRow.eps.estimate,
          actual: providerRow.eps.actual
        },
        revenue: {
          estimate: providerRow.revenue.estimate,
          actual: providerRow.revenue.actual
        }
      },
      // Official company evidence can move the dashboard row while Finnhub keeps
      // publishing the matching quarter under its original calendar date. Preserve
      // that returned row in the conflict audit so the refresh remains traceable.
      providerDateConflict: row.sourceAudit?.providerDateConflict ? {
        ...row.sourceAudit.providerDateConflict,
        candidates: {
          ...row.sourceAudit.providerDateConflict.candidates,
          finnhub: mergeFinnhubConflictCandidates(
            row.sourceAudit.providerDateConflict.candidates?.finnhub,
            providerRow
          )
        }
      } : row.sourceAudit?.providerDateConflict,
      selectedSources: {
        ...row.sourceAudit?.selectedSources,
        timing: providerRow.reportTiming === 'unknown' ? 'none' : 'finnhub',
        eps: {
          estimate: sourceFor(eps.estimate, 'finnhub'),
          actual: sourceFor(eps.actual, 'finnhub')
        },
        revenue: {
          estimate: sourceFor(revenue.estimate, 'finnhub'),
          actual: sourceFor(revenue.actual, 'finnhub')
        }
      }
    }
  });
}

function applyZacksRefresh(row, providerRow) {
  if (!providerRow) return row;
  const actualsObservedAt = actualsObservedAtForRefresh(row, providerRow);
  const next = {
    ...providerRow,
    outcome: {
      ...providerRow.outcome,
      guide: row.outcome?.guide || '',
      interpretation: row.outcome?.interpretation || ''
    },
    reaction: row.reaction,
    eps: {
      ...providerRow.eps,
      note: row.eps?.note || ''
    },
    revenue: {
      ...providerRow.revenue,
      note: row.revenue?.note || ''
    }
  };
  if (actualsObservedAt) next.actualsObservedAt = actualsObservedAt;
  else delete next.actualsObservedAt;
  return finalizeRow(next);
}

function finnhubConflictCandidate(row) {
  return {
    reportDate: row.reportDate,
    reportTiming: row.reportTiming,
    fiscalQuarter: row.fiscalQuarter,
    fiscalYear: row.fiscalYear,
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

function mergeFinnhubConflictCandidates(candidates, providerRow) {
  const candidate = finnhubConflictCandidate(providerRow);
  const existing = Array.isArray(candidates) ? candidates : [];
  const withoutSameDate = existing.filter((item) => item?.reportDate !== candidate.reportDate);
  return [...withoutSameDate, candidate];
}

function applyEarningsApiCompanyRefresh(row, providerRow) {
  if (!providerRow) return row;
  const eps = metricPayload(row.eps, providerRow.eps, 'eps', {
    basis: row.eps?.basis || '',
    note: row.eps?.note || ''
  });
  const revenue = metricPayload(row.revenue, providerRow.revenue, 'revenue', {
    note: row.revenue?.note || ''
  });
  return finalizeRow({
    ...row,
    reportTiming: providerRow.reportTiming,
    eps,
    revenue,
    sourceAudit: {
      ...row.sourceAudit,
      earningsApiCompany: {
        ...(row.sourceAudit?.earningsApiCompany || {}),
        selectedRow: {
          reportDate: providerRow.reportDate,
          reportTiming: providerRow.reportTiming
        }
      },
      selectedSources: {
        ...row.sourceAudit?.selectedSources,
        timing: providerRow.reportTiming === 'unknown' ? 'none' : 'earningsApiCompany',
        eps: {
          estimate: sourceFor(eps.estimate, 'earningsApiCompany'),
          actual: sourceFor(eps.actual, 'earningsApiCompany')
        },
        revenue: {
          estimate: sourceFor(revenue.estimate, 'earningsApiCompany'),
          actual: sourceFor(revenue.actual, 'earningsApiCompany')
        }
      }
    }
  });
}

function updateSummary(output) {
  const rows = Array.isArray(output.rows) ? output.rows : [];
  const secondaryRecoveryCandidates = Array.isArray(output.secondaryRecoveryCandidates) ? output.secondaryRecoveryCandidates : [];
  output.summary = {
    ...(output.summary || {}),
    counts: computeEarningsWeekCounts(rows, secondaryRecoveryCandidates)
  };
}

function selectCompanyRow(rows, target) {
  return rows
    .filter((row) => row.symbol === target.symbol && row.reportDate === target.reportDate)
    .sort((left, right) => {
      const leftScore = [
        left.reportTiming !== 'unknown',
        Number.isFinite(left.eps?.estimate),
        Number.isFinite(left.eps?.actual),
        Number.isFinite(left.revenue?.estimate),
        Number.isFinite(left.revenue?.actual)
      ].filter(Boolean).length;
      const rightScore = [
        right.reportTiming !== 'unknown',
        Number.isFinite(right.eps?.estimate),
        Number.isFinite(right.eps?.actual),
        Number.isFinite(right.revenue?.estimate),
        Number.isFinite(right.revenue?.actual)
      ].filter(Boolean).length;
      return rightScore - leftScore;
    })[0] || null;
}

function selectFinnhubRefreshRow(rows, target) {
  return rows.find((row) => rowKey(row) === rowKey(target)) || null;
}

function selectZacksRefreshRow(rows, target) {
  return rows.find((row) => rowKey(row) === rowKey(target)) || null;
}

function refreshTargetRows(source, asOf) {
  return (Array.isArray(source.rows) ? source.rows : [])
    .filter((row) => reportWindowArrived(row, asOf));
}

function applyResultRefreshDiagnostics(row, failures, checkedAt) {
  const output = structuredClone(row);
  output.sourceAudit = { ...output.sourceAudit };
  if (failures.length) {
    output.sourceAudit.resultRefresh = {
      status: 'partial',
      checkedAt: new Date(checkedAt).toISOString(),
      failures: failures.map((failure) => ({ ...failure }))
    };
  } else {
    delete output.sourceAudit.resultRefresh;
  }
  output.sourceStatus = computeEarningsSourceStatus(output);
  return output;
}

async function refreshEarningsResults(source, refreshData, options = {}) {
  assertRefreshSourceAudit(source);
  let output = JSON.parse(JSON.stringify(source));
  delete output.policy;
  const asOf = options.asOf || new Date().toISOString();
  const targetKeys = new Set(refreshTargetRows(output, asOf).map(rowKey));
  const changedKeys = new Set();
  const earningsApiCompanyBySymbol = new Map(Object.entries(refreshData.earningsApiCompanyRowsBySymbol || {}));

  output.rows = output.rows.map((row) => {
    if (!targetKeys.has(rowKey(row))) return row;
    const before = deterministicSnapshot(row);
    let next = row;
    const selectedSlate = row.sourceAudit?.selectedSources?.slate;
    if (selectedSlate === 'zacks') {
      next = applyZacksRefresh(row, selectZacksRefreshRow(refreshData.zacksRows || [], row));
    } else if (selectedSlate === 'finnhub') {
      next = applyFinnhubRefresh(row, selectFinnhubRefreshRow(refreshData.finnhubRows || [], row));
    } else if (isSecondaryCalendarSlate(selectedSlate)) {
      next = applyEarningsApiCompanyRefresh(row, selectCompanyRow(earningsApiCompanyBySymbol.get(row.symbol) || [], row));
    }
    if (deterministicSnapshot(next) !== before) changedKeys.add(rowKey(row));
    return next;
  });

  const hasCollectedDiagnostics = Object.prototype.hasOwnProperty.call(refreshData, 'rowDiagnosticsByKey');
  const successfulYahooSymbols = new Set((refreshData.yahooFetches || []).filter((item) => item?.ok).map((item) => item.symbol));
  const reactionRows = output.rows.filter((row) => targetKeys.has(rowKey(row)))
    .filter((row) => !hasCollectedDiagnostics || successfulYahooSymbols.has(row.symbol));
  if (reactionRows.length && refreshData.yahooFetches) {
    const reactionSnapshots = new Map(reactionRows.map((row) => [rowKey(row), deterministicSnapshot(row)]));
    const reactionRowsByKey = new Map(reactionRows.map((row) => [rowKey(row), row]));
    const refreshed = attachReactions(reactionRows, refreshData.yahooFetches, { asOf })
      .map(finalizeRow)
      .map((row) => {
        const key = rowKey(row);
        return deterministicSnapshot(row) === reactionSnapshots.get(key)
          ? preserveNarrative(row, reactionRowsByKey.get(key))
          : row;
      });
    const refreshedByKey = new Map(refreshed.map((row) => [rowKey(row), row]));
    output.rows = output.rows.map((row) => refreshedByKey.get(rowKey(row)) || row);
    for (const row of refreshed) {
      if (deterministicSnapshot(row) !== reactionSnapshots.get(rowKey(row))) {
        changedKeys.add(rowKey(row));
      }
    }
  }

  if (changedKeys.size) {
    output.rows = output.rows.map((row) => changedKeys.has(rowKey(row))
      ? clearNarrative(row)
      : row);
    delete output.narrativeApply;
  }

  const rowDiagnosticsByKey = refreshData.rowDiagnosticsByKey || {};
  output.rows = output.rows.map((row) => targetKeys.has(rowKey(row))
    ? applyResultRefreshDiagnostics(row, rowDiagnosticsByKey[rowKey(row)] || [], asOf)
    : row);

  // Even when every provider retry misses, post-window rows must move
  // from scheduled to awaiting_actual so the dashboard state stays truthful.
  output.rows = output.rows.map((row) => targetKeys.has(rowKey(row))
    ? applyEarningsLifecycle(row, asOf)
    : row);
  updateSummary(output);
  output.generatedAt = new Date(asOf).toISOString();
  output.outputPath = options.outputPath || output.outputPath;
  return {
    payload: output,
    refreshedRows: targetKeys.size,
    changedRows: changedKeys.size,
    failedRows: output.rows.filter((row) => targetKeys.has(rowKey(row)) && row.sourceAudit?.resultRefresh?.status === 'partial').length
  };
}

function refreshFailure(provider, code, message) {
  return {
    provider,
    code,
    message: String(message || 'Source refresh failed.').trim().slice(0, 240)
  };
}

async function collectRefreshData(source, args, dependencies = {}) {
  const targetRows = refreshTargetRows(source, args.asOf);
  const zacksTargets = targetRows.filter((row) => row.sourceAudit?.selectedSources?.slate === 'zacks');
  const finnhubTargets = targetRows.filter((row) => row.sourceAudit?.selectedSources?.slate === 'finnhub');
  const earningsApiTargets = targetRows
    .filter((row) => isSecondaryCalendarSlate(row.sourceAudit?.selectedSources?.slate));
  const environment = dependencies.env || process.env;
  const finnhubToken = environment.FINNHUB_API_KEY;
  const earningsApiToken = environment.EARNINGSAPI_API_KEY;
  const fetchFinnhub = dependencies.fetchFinnhubCalendarRows || fetchFinnhubCalendarRows;
  const fetchEarningsApi = dependencies.fetchEarningsApiCompanyRows || fetchEarningsApiCompanyRows;
  const fetchYahoo = dependencies.fetchYahooBars || fetchYahooBars;
  const loadEarningsApiUsage = dependencies.readEarningsApiUsage || readEarningsApiUsage;
  const rowDiagnostics = new Map();
  const addFailure = (rows, failure) => {
    for (const row of rows) {
      const key = rowKey(row);
      const current = rowDiagnostics.get(key) || [];
      if (!current.some((item) => item.provider === failure.provider)) current.push(failure);
      rowDiagnostics.set(key, current);
    }
  };

  let zacksRows = [];
  if (zacksTargets.length) {
    try {
      const zacksArgs = {
        ...args,
        from: source.range.from,
        to: source.range.to,
        displayDates: displayDatesForRange(source.range.from, source.range.to)
      };
      const zacksDays = await fetchZacksCalendar(zacksArgs);
      const gate = zacksGate(zacksDays, zacksArgs.displayDates);
      if (gate.ok) {
        zacksRows = buildZacksRows(zacksDays, { observedAt: args.asOf });
        for (const row of zacksTargets) {
          if (!selectZacksRefreshRow(zacksRows, row)) {
            addFailure([row], refreshFailure('zacks', 'provider_row_unavailable', 'Zacks returned no matching result row; prior Zacks row facts were retained.'));
          }
        }
      } else {
        addFailure(zacksTargets, refreshFailure('zacks', 'schema_gate_failed', gate.failures.map((failure) => failure.message).join(' ')));
      }
    } catch (error) {
      addFailure(zacksTargets, refreshFailure('zacks', 'provider_request_failed', error.message));
    }
  }

  let finnhubRows = [];
  if (finnhubTargets.length && !finnhubToken) {
    addFailure(finnhubTargets, refreshFailure('finnhub', 'missing_api_key', 'Finnhub API key is unavailable; prior Finnhub row facts were retained.'));
  } else if (finnhubTargets.length) {
    try {
      finnhubRows = await fetchFinnhub(args, finnhubToken, source.range);
      for (const row of finnhubTargets) {
        if (!selectFinnhubRefreshRow(finnhubRows, row)) {
          addFailure([row], refreshFailure('finnhub', 'provider_row_unavailable', 'Finnhub returned no matching result row; prior Finnhub row facts were retained.'));
        }
      }
    } catch (error) {
      addFailure(finnhubTargets, refreshFailure('finnhub', 'provider_request_failed', error.message));
    }
  }

  const earningsApiCompanyRowsBySymbol = {};
  let earningsApiUsage = null;
  // Result refresh keeps prior EarningsAPI-sourced facts unless the caller
  // explicitly opts into spending metered company-result requests.
  if (earningsApiTargets.length && !args.useEarningsApi) {
    addFailure(earningsApiTargets, refreshFailure('earningsApiCompany', 'budget_unavailable', 'EarningsAPI company refresh is opt-in; prior company-result facts were retained.'));
  } else if (earningsApiTargets.length && !earningsApiToken) {
    addFailure(earningsApiTargets, refreshFailure('earningsApiCompany', 'missing_api_key', 'EarningsAPI key is unavailable; prior company-result facts were retained.'));
  } else if (earningsApiTargets.length) {
    try {
      earningsApiUsage = loadEarningsApiUsage(args.earningsApiUsage);
    } catch (_error) {
      addFailure(earningsApiTargets, refreshFailure('earningsApiCompany', 'usage_ledger_unreadable', 'EarningsAPI usage ledger is unreadable; no metered company calls were attempted and prior facts were retained.'));
    }
  }
  if (earningsApiUsage) {
    const symbols = [...new Set(earningsApiTargets.map((row) => row.symbol))];
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index];
      const symbolTargets = earningsApiTargets.filter((row) => row.symbol === symbol);
      if (!canUseEarningsApi(args, earningsApiUsage, earningsApiToken)) {
        addFailure(symbolTargets, refreshFailure('earningsApiCompany', 'budget_unavailable', 'EarningsAPI call budget is unavailable; prior company-result facts were retained.'));
        continue;
      }
      try {
        const rows = await fetchEarningsApi(symbol, args, earningsApiToken, earningsApiUsage);
        earningsApiCompanyRowsBySymbol[symbol] = rows;
        for (const row of symbolTargets) {
          if (!selectCompanyRow(rows, row)) {
            addFailure([row], refreshFailure('earningsApiCompany', 'provider_row_unavailable', 'EarningsAPI returned no matching company result row; prior company-result facts were retained.'));
          }
        }
      } catch (error) {
        const rateLimited = /\bHTTP 429\b/.test(String(error.message));
        addFailure(symbolTargets, refreshFailure('earningsApiCompany', rateLimited ? 'provider_rate_limited' : 'provider_request_failed', error.message));
        if (rateLimited) {
          const remaining = symbols.slice(index + 1)
            .flatMap((remainingSymbol) => earningsApiTargets.filter((row) => row.symbol === remainingSymbol));
          addFailure(remaining, refreshFailure('earningsApiCompany', 'provider_rate_limited', 'EarningsAPI rate-limited the account; remaining company-result calls were not attempted and prior facts were retained.'));
          break;
        }
      }
    }
  }

  const yahooTargets = targetRows
    .map((row) => row.sourceAudit?.selectedSources?.slate === 'zacks'
      ? applyZacksRefresh(row, selectZacksRefreshRow(zacksRows, row))
      : row.sourceAudit?.selectedSources?.slate === 'finnhub'
        ? applyFinnhubRefresh(row, selectFinnhubRefreshRow(finnhubRows, row))
        : isSecondaryCalendarSlate(row.sourceAudit?.selectedSources?.slate)
        ? applyEarningsApiCompanyRefresh(row, selectCompanyRow(earningsApiCompanyRowsBySymbol[row.symbol] || [], row))
        : row)
    .filter(needsYahooReactionFetch);
  // Reaction fetches run only after actual EPS or revenue exists; estimates-only
  // rows keep their pending reaction state and avoid unnecessary Yahoo calls.
  const yahooSymbols = [...new Set(yahooTargets.map((row) => row.symbol))];
  const yahooFetches = await mapConcurrent(yahooSymbols, 4, async (symbol) => {
    const symbolTargets = targetRows.filter((row) => row.symbol === symbol);
    try {
      const result = await fetchYahoo(symbol, source.range.from, source.range.to, { timeoutMs: args.timeoutMs }, fetchJson);
      if (result?.ok) return result;
      addFailure(symbolTargets, refreshFailure('yahoo', 'provider_request_failed', result?.error || `Yahoo Finance returned HTTP ${result?.status || 0}.`));
    } catch (error) {
      addFailure(symbolTargets, refreshFailure('yahoo', 'provider_request_failed', error.message));
    }
    return null;
  });

  return {
    zacksRows,
    finnhubRows,
    earningsApiCompanyRowsBySymbol,
    yahooFetches: yahooFetches.filter(Boolean),
    rowDiagnosticsByKey: Object.fromEntries([...rowDiagnostics.entries()])
  };
}

function validateWeek(file) {
  runValidation(['--input', file]);
}

function printReport(result, outputPath, compact) {
  process.stdout.write(`Earnings Result Refresh
=======================
Rows eligible for refresh: ${result.refreshedRows}
Rows with deterministic changes: ${result.changedRows}
Rows retaining prior values after a source failure: ${result.failedRows}
Output: ${outputPath}
`);
  if (!compact && result.changedRows > 0) {
    process.stdout.write('Narrative was invalidated for changed rows; prepare the common editorial workspace and complete its Earnings narrative tasks before finalization.\n');
  }
}

async function run(argv) {
  loadEnv();
  const args = parseArgs(argv);
  validateWeek(args.input);
  const source = readJson(args.input);
  const refreshData = await collectRefreshData(source, args);
  const result = await refreshEarningsResults(source, refreshData, {
    asOf: args.asOf,
    outputPath: args.output
  });
  const outputErrors = validateEarningsWeekPayload(result.payload);
  if (outputErrors.length) throw new Error(`Refreshed earnings week payload is invalid: ${outputErrors.join(' ')}`);
  writeJson(args.output, result.payload);
  printReport(result, args.output, args.compact);
}


return {
  run,
  applyEarningsApiCompanyRefresh,
  applyFinnhubRefresh,
  collectRefreshData,
  mergeFinnhubConflictCandidates,
  refreshEarningsResults,
  refreshTargetRows,
  reportWindowArrived,
  selectFinnhubRefreshRow
};
}

const refreshCommand = createRefreshCommand();


async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }
  if (command === 'build') return runBuild(argv);
  if (command === 'refresh') return refreshCommand.run(argv);
  if (command === 'validate') return runValidation(argv);
  if (command === 'apply-narrative') return applyNarrativeCommand(argv);
  if (command === 'repair-source-audit') return repairSourceAuditCommand(argv);
  if (command === 'embed') {
    throw new Error('Direct dashboard writes are not supported; use run_daily_update.js --apply-earnings-week-json.');
  }
  throw new Error(`Unknown earnings_week command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  applyEarningsNarrative,
  applyEarningsApiCompanyRefresh: refreshCommand.applyEarningsApiCompanyRefresh,
  applyFinnhubRefresh: refreshCommand.applyFinnhubRefresh,
  collectRefreshData: refreshCommand.collectRefreshData,
  earningsCalendarFailedAttemptNeedsRetry,
  earningsCalendarNeedsBuild,
  mergeFinnhubConflictCandidates: refreshCommand.mergeFinnhubConflictCandidates,
  repairRecoveredEarningsSourceAudit,
  refreshEarningsResults: refreshCommand.refreshEarningsResults,
  refreshTargetRows: refreshCommand.refreshTargetRows,
  reportWindowArrived: refreshCommand.reportWindowArrived,
  selectFinnhubRefreshRow: refreshCommand.selectFinnhubRefreshRow,
  validateEarningsWeekPayload
};
