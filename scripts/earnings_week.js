#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildEarningsWeekPolicy,
  combinedOutcome,
  computeEarningsWeekCounts,
  earningsCalendarRangeNeedsBuild,
  earningsRowKey: rowKey,
  applyEarningsLifecycle,
  earningsScheduleConfirmationRequiredError,
  earningsScheduleReviewRows,
  metricResult,
  numberOrNull,
  pctChange,
  reportWindowArrived
} = require('./earnings_week_contract');
const { fetchYahooBars, fetchYahooBarsForRows, runBuild } = require('./earnings_week_build');
const { runValidation, validateEarningsWeekPayload } = require('./earnings_week_validation');
const root = path.resolve(__dirname, '..');
const DEFAULT_EARNINGS_WEEK = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_RESOLUTIONS = path.resolve(root, 'generated', 'earnings_company_release_resolutions.json');
const DEFAULT_NARRATIVE = path.resolve(root, 'generated', 'earnings_narrative.json');
const DEFAULT_SCHEDULE_REVIEW = path.resolve(root, 'generated', 'earnings_schedule_review.json');

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js <command> [options]

Commands:
  build             Build generated/earnings_week.json
  refresh           Refresh arrived earnings rows in the existing week artifact
  resolve           Resolve company-release tasks into the resolution sidecar
  apply-release     Apply company-release resolutions to the week artifact
  apply-narrative   Apply earnings narrative sidecar to the week artifact
  validate          Validate the earnings week artifact
  validate-release  Validate company-release resolution sidecar

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

function earningsCalendarNeedsBuild(range, earningsWeekPath = DEFAULT_EARNINGS_WEEK) {
  if (!fs.existsSync(earningsWeekPath)) return earningsCalendarRangeNeedsBuild(range, null);
  try {
    return earningsCalendarRangeNeedsBuild(range, readJson(earningsWeekPath).range);
  } catch (_error) {
    return Boolean(range);
  }
}

function pendingEarningsScheduleReviews(scheduleReviewPath = DEFAULT_SCHEDULE_REVIEW, earningsWeekPath = DEFAULT_EARNINGS_WEEK) {
  if (!fs.existsSync(scheduleReviewPath)) return [];
  const review = readJson(scheduleReviewPath);
  const week = readJson(earningsWeekPath);
  return earningsScheduleReviewRows(review, week);
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseApplyReleaseArgs(argv) {
  const args = {
    input: DEFAULT_EARNINGS_WEEK,
    resolutions: DEFAULT_RESOLUTIONS,
    output: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
      i += 1;
      continue;
    }
    if (arg === '--resolutions') {
      args.resolutions = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_RESOLUTIONS);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/earnings_week.js apply-release [options]

Options:
  --input PATH        Earnings week JSON to update (default: generated/earnings_week.json)
  --resolutions PATH  Company-release resolutions JSON (default: generated/earnings_company_release_resolutions.json)
  --output PATH       Output earnings week JSON (default: overwrite --input)
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.output) args.output = args.input;
  return args;
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

function metricPayload(fields, options = {}) {
  const estimate = numberOrNull(fields?.estimate);
  const actual = numberOrNull(fields?.actual);
  return {
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate),
    ...options
  };
}

function sourceFromResolution(value, fallback = 'none') {
  if (!value) return fallback;
  if (value === 'earningsapi_company') return 'earningsApiCompany';
  if (value === 'finnhub') return 'finnhub';
  return value;
}

function reactionSource(reaction) {
  return reaction?.status === 'computed' ? 'yahoo' : 'none';
}

function rowFromTask(task, resolution) {
  const profile = task.sourceAudit?.finnhubProfile || null;
  return {
    symbol: resolution.symbol,
    company: profile?.name || resolution.company || task.company || resolution.symbol,
    exchange: profile?.exchange || '',
    country: profile?.country || '',
    currency: profile?.currency || '',
    marketCap: Number.isFinite(profile?.marketCap) ? profile.marketCap : task.marketCap ?? null,
    marketCapDisplay: task.marketCapDisplay || '',
    reportDate: resolution.reportDate,
    reportTiming: resolution.fields.reportTiming,
    fiscalQuarterEnding: task.fiscalQuarterEnding || '',
    fiscalQuarter: null,
    fiscalYear: null,
    eps: null,
    revenue: null,
    outcome: null,
    reaction: null,
    sourceStatus: 'partial',
    sourceSummary: {
      primary: 'sec_company_release',
      fallbacks: ['earningsApiCompany', 'finnhubProfile'].filter((item) => item !== 'finnhubProfile' || profile),
      reaction: 'none'
    },
    sourceAudit: {
      finnhubCalendar: { present: false },
      finnhubProfile: profile,
      earningsApiCalendar: task.sourceAudit?.earningsApiCalendar || null,
      earningsApiCompany: task.sourceAudit?.earningsApiCompany || null,
      selectedSources: {
        slate: 'earningsApiCalendar',
        company: profile?.name ? 'finnhubProfile' : 'earningsApiCompany',
        marketCap: Number.isFinite(profile?.marketCap) ? 'finnhubProfile' : 'none',
        timing: 'none',
        eps: { estimate: 'none', actual: 'none' },
        revenue: { estimate: 'none', actual: 'none' },
        reaction: 'none'
      },
      yahoo: {}
    }
  };
}

function applyResolution(row, task, resolution) {
  const epsFields = resolution.fields?.eps || {};
  const revenueFields = resolution.fields?.revenue || {};
  const reaction = resolution.reaction || {
    basis: 'unavailable',
    percent: null,
    fromDate: '',
    fromClose: null,
    toDate: '',
    toClose: null,
    status: 'unavailable',
    note: '',
    source: ''
  };
  const eps = metricPayload(epsFields, {
    basis: epsFields.basis || '',
    note: epsFields.adjustment?.note || ''
  });
  const revenue = metricPayload(revenueFields, {
    note: ''
  });
  const selectedSources = {
    ...row.sourceAudit.selectedSources,
    timing: resolution.fields.reportTiming === 'unknown' ? 'none' : 'sec_company_release',
    eps: {
      estimate: sourceFromResolution(epsFields.estimateSource, Number.isFinite(eps.estimate) ? 'earningsApiCompany' : 'none'),
      actual: Number.isFinite(eps.actual) ? (epsFields.actualSource || 'sec_company_release') : 'none'
    },
    revenue: {
      estimate: sourceFromResolution(revenueFields.estimateSource, Number.isFinite(revenue.estimate) ? 'earningsApiCompany' : 'none'),
      actual: Number.isFinite(revenue.actual) ? 'sec_company_release' : 'none'
    },
    reaction: reactionSource(reaction)
  };

  const updated = {
    ...row,
    reportDate: resolution.reportDate,
    company: row.company || resolution.company || task.company,
    reportTiming: resolution.fields.reportTiming,
    eps,
    revenue,
    outcome: {
      overall: combinedOutcome(eps.result, revenue.result),
      guide: '',
      interpretation: ''
    },
    reaction,
    sourceSummary: {
      primary: 'sec_company_release',
      fallbacks: row.sourceAudit?.selectedSources?.slate === 'finnhub'
        ? ['finnhub', ...(['company', 'marketCap'].some((field) => row.sourceAudit?.selectedSources?.[field] === 'providerDateConflict') ? ['providerDateConflict'] : []), ...(row.sourceAudit?.selectedSources?.marketCap === 'finnhubMetric' ? ['finnhubMetric'] : [])]
        : ['earningsApiCompany', 'finnhubProfile'].filter((item) => item !== 'finnhubProfile' || row.sourceAudit?.finnhubProfile),
      reaction: reactionSource(reaction)
    },
    sourceAudit: {
      ...row.sourceAudit,
      companyReleaseResolution: resolution,
      selectedSources,
      yahoo: reaction.sourceAudit || row.sourceAudit?.yahoo || {}
    }
  };
  const resolved = applyEarningsLifecycle(updated);
  // Official actuals preserve the preview while the market response is still
  // pending. The lifecycle transition to close_available clears it instead.
  if (resolved.lifecycle === 'released_awaiting_close' && resolved.reaction?.status === 'awaiting_close') {
    resolved.eps.note = row.eps?.note || '';
    resolved.revenue.note = row.revenue?.note || '';
    resolved.outcome.guide = row.outcome?.guide || '';
    resolved.outcome.interpretation = row.outcome?.interpretation || '';
    resolved.reaction.note = row.reaction?.note || '';
  }
  return resolved;
}

function updateSummary(source) {
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const secondaryRecoveryCandidates = Array.isArray(source.secondaryRecoveryCandidates) ? source.secondaryRecoveryCandidates : [];
  const companyReleaseTasks = Array.isArray(source.companyReleaseTasks) ? source.companyReleaseTasks : [];
  source.summary = {
    ...(source.summary || {}),
    counts: computeEarningsWeekCounts(rows, secondaryRecoveryCandidates, companyReleaseTasks)
  };
}

function applyCompanyReleaseResolutions(source, resolutionPayload) {
  const output = JSON.parse(JSON.stringify(source));
  output.policy = buildEarningsWeekPolicy();
  const taskMap = new Map((output.companyReleaseTasks || []).map((task) => [task.id, task]));
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];
  const skipped = [];

  for (const resolution of resolutionPayload.companyReleaseResolutions || []) {
    if (resolution.status !== 'resolved') {
      skipped.push({ taskId: resolution.taskId, reason: resolution.status || 'not_resolved' });
      continue;
    }
    const task = taskMap.get(resolution.taskId);
    if (!task) throw new Error(`${resolution.taskId} does not map to companyReleaseTasks.`);
    if (task.symbol !== resolution.symbol) throw new Error(`${resolution.taskId} symbol does not match resolution.`);
    if (task.reportDate !== resolution.reportDate && task.trigger !== 'provider_date_conflict_requires_company_release') {
      throw new Error(`${resolution.taskId} reportDate does not match resolution.`);
    }

    const key = rowKey(resolution);
    const existing = rowsByKey.get(key) || rowsByKey.get(rowKey(task));
    const baseRow = existing?.row || rowFromTask(task, resolution);
    const updated = applyResolution(baseRow, task, resolution);
    if (existing) {
      output.rows[existing.index] = updated;
    } else {
      output.rows.push(updated);
      rowsByKey.set(key, { row: updated, index: output.rows.length - 1 });
    }
    applied.push({ taskId: resolution.taskId, symbol: resolution.symbol });
  }

  output.rows.sort((left, right) => {
    const dateCompare = left.reportDate.localeCompare(right.reportDate);
    if (dateCompare) return dateCompare;
    return left.symbol.localeCompare(right.symbol);
  });
  output.companyReleaseApply = {
    generatedAt: new Date().toISOString(),
    resolutionArtifact: resolutionPayload.outputPath || '',
    applied,
    skipped
  };
  updateSummary(output);
  return output;
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
  output.policy = buildEarningsWeekPolicy();
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];

  for (const item of narrativePayload.rows || []) {
    const key = rowKey(item);
    const target = rowsByKey.get(key);
    if (!target) throw new Error(`${key} narrative does not match a canonical earnings row.`);
    const row = target.row;
    output.rows[target.index] = {
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
    applied.push({ symbol: item.symbol, reportDate: item.reportDate });
  }

  output.narrativeApply = {
    generatedAt: new Date().toISOString(),
    narrativeArtifact: options.narrativeArtifact || narrativePayload.outputPath || '',
    applied
  };
  return output;
}

function validateWeek(file, requireNarrative = false) {
  const command = ['--input', file];
  if (requireNarrative) command.push('--require-narrative');
  runValidation(command);
}

function validateResolutions(input, resolutions) {
  runValidation([
    'release',
    '--input',
    resolutions,
    '--week',
    input
  ]);
}

function applyReleaseCommand(argv) {
  const args = parseApplyReleaseArgs(argv);
  validateWeek(args.input);
  validateResolutions(args.input, args.resolutions);
  const output = applyCompanyReleaseResolutions(readJson(args.input), readJson(args.resolutions));
  const outputErrors = validateEarningsWeekPayload(output);
  if (outputErrors.length) throw new Error(`Applied earnings week payload is invalid: ${outputErrors.join(' ')}`);
  writeJson(args.output, output);
  process.stdout.write(`Applied ${output.companyReleaseApply.applied.length} company-release resolution(s) to ${args.output}\n`);
}

function applyNarrativeCommand(argv) {
  const args = parseApplyNarrativeArgs(argv);
  const output = applyEarningsNarrative(readJson(args.input), readJson(args.narrative), {
    sourceArtifact: path.relative(root, args.input),
    narrativeArtifact: path.relative(root, args.narrative)
  });
  const outputErrors = validateEarningsWeekPayload(output, { requireNarrative: true });
  if (outputErrors.length) throw new Error(`Narrative-applied earnings week payload is invalid: ${outputErrors.join(' ')}`);
  writeJson(args.output, output);
  process.stdout.write(`Applied ${output.narrativeApply.applied.length} earnings narrative row(s) to ${args.output}\n`);
}

// Command factories keep refresh and resolution helper names private while the
// public earnings CLI and tests share this single implementation file.
function createRefreshCommand() {

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  attachReactions,
  buildCompanyReleaseTasks,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  emptyEarningsApiUsage,
  earningsRowKey: rowKey,
  hasEarningsApiBudget,
  isEarningsApiUsage,
  metricResult,
  normalizeFinnhubCalendarFields,
  normalizeEarningsTiming: normalizeTiming,
  numberOrNull,
  pctChange,
  recordEarningsApiRequest
} = require('./earnings_week_contract');
const { compareIsoDate, displayDatesForRange, isIsoDate } = require('./calendar_contract');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_COMPANY_RELEASE_RESOLUTIONS = path.resolve(root, 'generated', 'earnings_company_release_resolutions.json');
const DEFAULT_EARNINGSAPI_USAGE = path.resolve(root, 'generated', 'earningsapi_usage.json');
const DEFAULT_EARNINGSAPI_MONTHLY_LIMIT = 1000;
const DEFAULT_EARNINGSAPI_RESERVE = 150;
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: '',
    asOf: new Date().toISOString(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    earningsApiUsage: DEFAULT_EARNINGSAPI_USAGE,
    earningsApiMonthlyLimit: DEFAULT_EARNINGSAPI_MONTHLY_LIMIT,
    earningsApiReserve: DEFAULT_EARNINGSAPI_RESERVE,
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
  --earningsapi-usage PATH    EarningsAPI monthly usage ledger
  --earningsapi-monthly-limit Monthly EarningsAPI call cap (default: 1000)
  --earningsapi-reserve 150   Calls reserved for other dashboard runs
  --compact                   Print compact refresh report
  --help                      Show this help

Environment:
  FINNHUB_API_KEY             Required for Finnhub-covered row actuals
  EARNINGSAPI_API_KEY         Required only for previously recovered rows

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function removeStaleCompanyReleaseResolutionSidecar(week, resolutionPath) {
  if (Array.isArray(week.companyReleaseTasks) && week.companyReleaseTasks.length > 0) return false;
  if (!fs.existsSync(resolutionPath)) return false;
  fs.rmSync(resolutionPath);
  return true;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function metricPayload(current, incoming, options = {}) {
  const estimate = numberOrNull(incoming?.estimate);
  const actual = numberOrNull(incoming?.actual);
  return {
    ...current,
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: metricResult(actual, estimate),
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
  return (Array.isArray(result.data?.earningsCalendar) ? result.data.earningsCalendar : [])
    .map(normalizeFinnhubCalendarFields)
    .filter((row) => row.symbol && isIsoDate(row.reportDate))
    .filter((row) => displayDatesForRange(range.from, range.to).includes(row.reportDate));
}

function readEarningsApiUsage(file) {
  if (!fs.existsSync(file)) return emptyEarningsApiUsage();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isEarningsApiUsage(data)) return data;
  } catch {
    // A corrupt local ledger should not turn into silent unmetered calls.
  }
  throw new Error(`EarningsAPI usage ledger is unreadable: ${file}`);
}

function writeEarningsApiUsage(file, usage) {
  writeJson(file, usage);
}

function canUseEarningsApi(args, usage, token) {
  if (!token) return false;
  return hasEarningsApiBudget(usage, args.earningsApiMonthlyLimit, args.earningsApiReserve);
}

async function fetchEarningsApiCompanyRows(symbol, args, token, usage) {
  if (!canUseEarningsApi(args, usage, token)) {
    throw new Error(`EarningsAPI company refresh is required for ${symbol}, but the API key or call budget is unavailable.`);
  }
  const url = new URL('/v1/earnings', 'https://api.earningsapi.com');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', token);
  recordEarningsApiRequest(usage, {
    type: 'company-earnings-result-refresh',
    path: url.pathname,
    queryKeys: url.searchParams.keys()
  });
  writeEarningsApiUsage(args.earningsApiUsage, usage);

  const result = await fetchJson(url.toString(), args);
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

function clearNarrative(row) {
  return {
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
}

function preserveNarrative(row, prior) {
  return {
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
  const eps = metricPayload(row.eps, providerRow.eps, {
    basis: row.eps?.basis || '',
    note: row.eps?.note || ''
  });
  const revenue = metricPayload(row.revenue, providerRow.revenue, {
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
      // A provider-date conflict can move the dashboard row to a date verified
      // by Nasdaq while Finnhub keeps publishing the matching quarter under its
      // original calendar date. Preserve that returned row in the conflict audit
      // so the result refresh remains traceable instead of silently stranding it.
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
  if (!providerRow || isObject(row.sourceAudit?.companyReleaseResolution)) return row;
  const eps = metricPayload(row.eps, providerRow.eps, {
    basis: row.eps?.basis || '',
    note: row.eps?.note || ''
  });
  const revenue = metricPayload(row.revenue, providerRow.revenue, {
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
          reportTiming: providerRow.reportTiming,
          eps: {
            estimate: providerRow.eps.estimate,
            actual: providerRow.eps.actual
          },
          revenue: {
            estimate: providerRow.revenue.estimate,
            actual: providerRow.revenue.actual
          }
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
  const companyReleaseTasks = Array.isArray(output.companyReleaseTasks) ? output.companyReleaseTasks : [];
  output.summary = {
    ...(output.summary || {}),
    counts: computeEarningsWeekCounts(rows, secondaryRecoveryCandidates, companyReleaseTasks)
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
  const exact = rows.find((row) => rowKey(row) === rowKey(target));
  if (exact) return exact;

  const conflict = target.sourceAudit?.providerDateConflict;
  if (!conflict || conflict.selectedProvider === 'finnhub') return null;

  // Once a non-Finnhub date wins a verified calendar conflict, Finnhub can
  // still publish the quarter's actuals under its original (or revised) date.
  // Match only the same reported fiscal period and require an actual so a
  // neighboring estimate-only entry cannot overwrite the dashboard row.
  return rows
    .filter((row) => row.symbol === target.symbol)
    .filter((row) => row.fiscalQuarter === target.fiscalQuarter && row.fiscalYear === target.fiscalYear)
    .filter((row) => Number.isFinite(row.eps?.actual) || Number.isFinite(row.revenue?.actual))
    .sort((left, right) => {
      const leftActuals = Number.isFinite(left.eps?.actual) + Number.isFinite(left.revenue?.actual);
      const rightActuals = Number.isFinite(right.eps?.actual) + Number.isFinite(right.revenue?.actual);
      return rightActuals - leftActuals || right.reportDate.localeCompare(left.reportDate);
    })[0] || null;
}

function unresolvedCompanyReleaseTaskKeys(source) {
  const appliedIds = new Set((source.companyReleaseApply?.applied || [])
    .map((item) => item?.taskId)
    .filter(Boolean));
  return new Set((source.companyReleaseTasks || [])
    .filter((task) => task?.id && !appliedIds.has(task.id))
    .map(rowKey));
}

function refreshTargetRows(source, asOf) {
  const taskKeys = unresolvedCompanyReleaseTaskKeys(source);
  return (Array.isArray(source.rows) ? source.rows : [])
    .filter((row) => reportWindowArrived(row, asOf) || taskKeys.has(rowKey(row)));
}

async function refreshEarningsResults(source, refreshData, options = {}) {
  const output = JSON.parse(JSON.stringify(source));
  output.policy = buildEarningsWeekPolicy();
  const asOf = options.asOf || new Date().toISOString();
  const targetKeys = new Set(refreshTargetRows(output, asOf).map(rowKey));
  const changedKeys = new Set();
  const earningsApiCompanyBySymbol = new Map(Object.entries(refreshData.earningsApiCompanyRowsBySymbol || {}));

  output.rows = output.rows.map((row) => {
    if (!targetKeys.has(rowKey(row))) return row;
    const before = deterministicSnapshot(row);
    let next = row;
    const selectedSlate = row.sourceAudit?.selectedSources?.slate;
    if (selectedSlate === 'finnhub') {
      next = applyFinnhubRefresh(row, selectFinnhubRefreshRow(refreshData.finnhubRows || [], row));
    } else if (selectedSlate === 'earningsApiCalendar') {
      next = applyEarningsApiCompanyRefresh(row, selectCompanyRow(earningsApiCompanyBySymbol.get(row.symbol) || [], row));
    }
    if (deterministicSnapshot(next) !== before) changedKeys.add(rowKey(row));
    return next;
  });

  const reactionRows = output.rows.filter((row) => targetKeys.has(rowKey(row)));
  if (reactionRows.length && refreshData.yahooFetches) {
    const reactionSnapshots = new Map(reactionRows.map((row) => [rowKey(row), deterministicSnapshot(row)]));
    const reactionRowsByKey = new Map(reactionRows.map((row) => [rowKey(row), row]));
    const refreshed = attachReactions(reactionRows, refreshData.yahooFetches, { asOf })
      .map(finalizeRow)
      .map((row) => {
        const key = rowKey(row);
        return deterministicSnapshot(row) === reactionSnapshots.get(key)
          || (row.lifecycle === 'released_awaiting_close' && row.reaction?.status === 'awaiting_close')
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
      && !(row.lifecycle === 'released_awaiting_close' && row.reaction?.status === 'awaiting_close')
      ? clearNarrative(row)
      : row);
    delete output.narrativeApply;
  }

  output.companyReleaseTasks = buildCompanyReleaseTasks(output.secondaryRecoveryCandidates || [], output.rows, {
    shouldEscalateDateConflict: (row) => reportWindowArrived(row, asOf)
  });
  if (output.companyReleaseTasks.length === 0) delete output.companyReleaseApply;
  updateSummary(output);
  output.generatedAt = new Date(asOf).toISOString();
  output.outputPath = options.outputPath || output.outputPath;
  return {
    payload: output,
    refreshedRows: targetKeys.size,
    changedRows: changedKeys.size
  };
}

async function collectRefreshData(source, args) {
  const targetRows = refreshTargetRows(source, args.asOf);
  const needsFinnhub = targetRows.some((row) => row.sourceAudit?.selectedSources?.slate === 'finnhub');
  const needsEarningsApiCompany = targetRows
    .filter((row) => row.sourceAudit?.selectedSources?.slate === 'earningsApiCalendar')
    .filter((row) => !isObject(row.sourceAudit?.companyReleaseResolution));
  const finnhubToken = process.env.FINNHUB_API_KEY;
  const earningsApiToken = process.env.EARNINGSAPI_API_KEY;
  const earningsApiUsage = readEarningsApiUsage(args.earningsApiUsage);

  if (needsFinnhub && !finnhubToken) throw new Error('FINNHUB_API_KEY is required to refresh Finnhub-covered earnings rows.');
  if (needsEarningsApiCompany.length && !earningsApiToken) {
    throw new Error('EARNINGSAPI_API_KEY is required to refresh previously recovered EarningsAPI rows.');
  }

  const finnhubRows = needsFinnhub ? await fetchFinnhubCalendarRows(args, finnhubToken, source.range) : [];
  const earningsApiCompanyRowsBySymbol = {};
  for (const symbol of [...new Set(needsEarningsApiCompany.map((row) => row.symbol))]) {
    earningsApiCompanyRowsBySymbol[symbol] = await fetchEarningsApiCompanyRows(symbol, args, earningsApiToken, earningsApiUsage);
  }
  const yahooFetches = targetRows.length ? await fetchYahooBarsForRows(targetRows, {
    from: source.range.from,
    to: source.range.to,
    timeoutMs: args.timeoutMs
  }, fetchJson) : [];

  return {
    finnhubRows,
    earningsApiCompanyRowsBySymbol,
    yahooFetches
  };
}

function validateWeek(file, requireNarrative = false) {
  const command = ['--input', file];
  if (requireNarrative) command.push('--require-narrative');
  runValidation(command);
}

function printReport(result, outputPath, compact) {
  process.stdout.write(`Earnings Result Refresh
=======================
Rows eligible for refresh: ${result.refreshedRows}
Rows with deterministic changes: ${result.changedRows}
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
  const outputErrors = validateEarningsWeekPayload(result.payload, { now: new Date(args.asOf) });
  if (outputErrors.length) throw new Error(`Refreshed earnings week payload is invalid: ${outputErrors.join(' ')}`);
  writeJson(args.output, result.payload);
  if (args.output === DEFAULT_INPUT && removeStaleCompanyReleaseResolutionSidecar(result.payload, DEFAULT_COMPANY_RELEASE_RESOLUTIONS)) {
    process.stdout.write('Removed stale company-release resolution sidecar because the refreshed week has no active tasks.\n');
  }
  printReport(result, args.output, args.compact);
}


return {
  run,
  applyEarningsApiCompanyRefresh,
    applyFinnhubRefresh,
    mergeFinnhubConflictCandidates,
    refreshEarningsResults,
    refreshTargetRows,
    removeStaleCompanyReleaseResolutionSidecar,
    reportWindowArrived,
    selectFinnhubRefreshRow
};
}

const refreshCommand = createRefreshCommand();

function createResolveCommand() {

const fs = require('fs');
const path = require('path');
const https = require('https');
const { earningsCloseAvailable, numberOrNull, pctChange, reactionWindow } = require('./earnings_week_contract');
const { dateFromIso } = require('./calendar_contract');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_OUTPUT = path.resolve(root, 'generated', 'earnings_company_release_resolutions.json');
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
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
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
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

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js resolve [options]

Options:
  --input PATH        Earnings week JSON with companyReleaseTasks (default: generated/earnings_week.json)
  --output PATH       Company-release resolution JSON output (default: generated/earnings_company_release_resolutions.json)
  --timeout-ms 20000  HTTP timeout in ms per request
  --compact           Print compact report
  --help              Show this help
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
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function requestHeaders(headers = {}) {
  const userAgent = String(process.env.SEC_USER_AGENT || '').trim();
  if (!userAgent) {
    throw new Error('SEC_USER_AGENT is required in .env or the environment for SEC/company-release resolution.');
  }
  // SEC requests require an identifying User-Agent; keep it configurable so
  // local operators can supply contact info without hard-coding it here.
  return {
    'User-Agent': userAgent,
    Accept: 'application/json,text/html,*/*',
    ...headers
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fetchText(url, args, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: requestHeaders(headers)
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        ms: Date.now() - started,
        body,
        error: res.statusCode >= 200 && res.statusCode < 300 ? '' : `HTTP ${res.statusCode}`
      }));
    });
    req.on('error', (error) => resolve({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      body: '',
      error: error.message
    }));
    req.setTimeout(args.timeoutMs, () => req.destroy(new Error('request timeout')));
  });
}

async function fetchJson(url, args, headers = {}) {
  const result = await fetchText(url, args, headers);
  if (!result.ok) return { ...result, data: null, parseError: '' };
  try {
    return { ...result, data: JSON.parse(result.body), parseError: '' };
  } catch (error) {
    return { ...result, ok: false, data: null, parseError: error.message };
  }
}

function roundedCents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function nearlyEqual(left, right, tolerance = 0.03) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function moneyNumber(value, unit) {
  const number = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  const normalizedUnit = String(unit || '').toLowerCase();
  if (normalizedUnit.startsWith('b')) return number * 1000000000;
  if (normalizedUnit.startsWith('m')) return number * 1000000;
  return number;
}

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#58;/g, ':')
    .replace(/&#8226;/g, ' ')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-')
    .replace(/&#47;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadTickerMap(args) {
  const result = await fetchJson('https://www.sec.gov/files/company_tickers.json', args);
  if (!result.ok || !result.data) throw new Error(`Unable to load SEC ticker map: ${result.error || result.parseError}`);
  const map = new Map();
  for (const item of Object.values(result.data)) {
    const ticker = String(item.ticker || '').toUpperCase();
    if (!ticker) continue;
    map.set(ticker, {
      cik: Number(item.cik_str),
      title: String(item.title || '').trim()
    });
  }
  return map;
}

function cikPadded(cik) {
  return String(cik).padStart(10, '0');
}

function cikPath(cik) {
  return String(Number(cik));
}

function daysBetween(left, right) {
  return Math.round((dateFromIso(right).getTime() - dateFromIso(left).getTime()) / 86400000);
}

function chooseEarningsFiling(task, recent) {
  const rows = [];
  for (let index = 0; index < recent.accessionNumber.length; index += 1) {
    const form = recent.form[index];
    const filingDate = recent.filingDate[index];
    const items = String(recent.items?.[index] || '');
    if (form !== '8-K') continue;
    if (!items.includes('2.02')) continue;
    const distance = Math.abs(daysBetween(task.reportDate, filingDate));
    if (distance > 3) continue;
    rows.push({
      accessionNumber: recent.accessionNumber[index],
      primaryDocument: recent.primaryDocument[index],
      filingDate,
      acceptanceDateTime: recent.acceptanceDateTime?.[index] || '',
      items,
      distance
    });
  }
  rows.sort((left, right) => left.distance - right.distance || left.filingDate.localeCompare(right.filingDate));
  return rows[0] || null;
}

async function fetchFilingIndex(cik, accessionNumber, args) {
  const accessionPath = accessionNumber.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${cikPath(cik)}/${accessionPath}/index.json`;
  const result = await fetchJson(url, args);
  return { ...result, url };
}

function chooseExhibit(indexData) {
  const items = Array.isArray(indexData?.directory?.item) ? indexData.directory.item : [];
  const htmlItems = items.filter((item) => /\.html?$/i.test(item.name));
  const exhibit = htmlItems.find((item) => /(?:exhibit|ex-?)?99[\d._-]*.*\.html?$/i.test(item.name) && !/index/i.test(item.name))
    || htmlItems.find((item) => /99/i.test(item.name) && !/index/i.test(item.name))
    || htmlItems.find((item) => /exhibit/i.test(item.name) && !/index/i.test(item.name));
  return exhibit?.name || '';
}

function extractFiscalPeriod(text, reportDate) {
  const year = reportDate.slice(0, 4);
  const lower = text.toLowerCase();
  const fiscalYear = text.match(/fiscal\s+(\d{4})/i)?.[1] || year;
  if (lower.includes('fourth quarter') || /\bq4\b/i.test(text)) return `Fiscal Q4 ${fiscalYear}`;
  if (lower.includes('third quarter') || /\bq3\b/i.test(text)) return `Fiscal Q3 ${fiscalYear}`;
  if (lower.includes('second quarter') || /\bq2\b/i.test(text)) return `Fiscal Q2 ${fiscalYear}`;
  if (lower.includes('first quarter') || /\bq1\b/i.test(text)) return `Fiscal Q1 ${fiscalYear}`;
  return `Fiscal period ending ${reportDate}`;
}

function extractReportTiming(filing) {
  const acceptedDate = new Date(filing.acceptanceDateTime || '');
  if (Number.isNaN(acceptedDate.getTime())) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(acceptedDate);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'unknown';
  const minutes = hour * 60 + minute;
  if (minutes < 9 * 60 + 30) return 'bmo';
  if (minutes >= 16 * 60) return 'amc';
  return 'unknown';
}

function extractEps(text) {
  const patterns = [
    { basis: 'gaap_diluted', regex: /Net loss[\s\S]{0,260}?\(\s*\$\s*([\d.]+)\s*\)\s+per share/i, sign: -1 },
    { basis: 'adjusted_non_gaap', regex: /(?:Adjusted diluted EPS|Adjusted EPS|Non-GAAP diluted earnings per share|Non-GAAP diluted EPS)[^$]{0,220}(?:\(\s*)?\$\s*([\d.]+)\s*\)?/i },
    { basis: 'gaap_diluted', regex: /Diluted earnings per (?:common )?share[^$]{0,220}(?:\(\s*)?\$\s*([\d.]+)\s*\)?/i },
    { basis: 'gaap_diluted', regex: /Diluted EPS[^$]{0,160}(?:\(\s*)?\$\s*([\d.]+)\s*\)?/i }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) return { value: (pattern.sign || (/\(\s*\$/.test(match[0]) ? -1 : 1)) * Number(match[1]), basis: pattern.basis };
  }
  return { value: null, basis: '' };
}

function extractPerShareAdjustment(text, actual) {
  if (!Number.isFinite(actual)) return null;
  const match = text.match(/Diluted earnings per share was\s*\$\s*([\d.]+)[^.]{0,260}?including a\s*\$\s*([\d.]+)\s*(benefit|charge|expense|loss|gain)[^.]{0,220}\./i);
  if (!match) return null;
  const headline = Number(match[1]);
  const amount = Number(match[2]);
  if (!nearlyEqual(headline, actual, 0.005) || !Number.isFinite(amount)) return null;
  const kind = match[3].toLowerCase();
  const isBenefit = kind === 'benefit' || kind === 'gain';
  const comparable = roundedCents(isBenefit ? actual - amount : actual + amount);
  return {
    kind,
    amount,
    comparableEps: comparable,
    note: `GAAP EPS ${moneyText(actual)} includes ${moneyText(amount)} ${kind}.`
  };
}

function moneyText(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '';
}

function earningsApiBackup(task) {
  const coverage = task.sourceAudit?.earningsApiCompany?.selectedRow || {};
  const finnhub = task.sourceAudit?.finnhubCalendar || {};
  const useFinnhub = task.trigger === 'provider_date_conflict_requires_company_release';
  const source = useFinnhub ? 'finnhub' : 'earningsapi_company';
  const backup = useFinnhub ? finnhub : coverage;
  return {
    eps: {
      estimate: numberOrNull(backup.eps?.estimate),
      actual: numberOrNull(backup.eps?.actual),
      estimateSource: Number.isFinite(numberOrNull(backup.eps?.estimate)) ? source : ''
    },
    revenue: {
      estimate: numberOrNull(backup.revenue?.estimate),
      estimateSource: Number.isFinite(numberOrNull(backup.revenue?.estimate)) ? source : ''
    },
    fiscalQuarterEnding: String(backup.fiscalQuarterEnding || '').trim()
  };
}

function resolveComparableEps(secEps, task, text) {
  const backup = earningsApiBackup(task);
  const adjustment = extractPerShareAdjustment(text, secEps.value);
  const result = {
    actual: secEps.value,
    basis: secEps.basis,
    gaapActual: secEps.basis === 'gaap_diluted' ? secEps.value : null,
    gaapBasis: secEps.basis === 'gaap_diluted' ? secEps.basis : '',
    adjustment,
    estimate: backup.eps.estimate,
    estimateSource: backup.eps.estimateSource,
    estimateCount: '',
    actualSource: 'sec_company_release',
    comparisonSource: ''
  };
  if (!Number.isFinite(backup.eps.actual)) return result;
  if (nearlyEqual(secEps.value, backup.eps.actual)) {
    result.actual = secEps.value;
    result.actualSource = 'sec_company_release';
    result.comparisonSource = 'earningsapi_company_eps_estimate';
    return result;
  }
  if (adjustment && nearlyEqual(adjustment.comparableEps, backup.eps.actual)) {
    result.actual = adjustment.comparableEps;
    result.basis = 'comparable_adjusted';
    result.actualSource = 'sec_company_release_adjusted_to_earningsapi_basis';
    result.comparisonSource = 'earningsapi_company_eps_estimate';
    return result;
  }
  result.comparisonSource = 'unreconciled_earningsapi_company';
  result.estimate = null;
  result.estimateSource = '';
  result.estimateCount = '';
  return result;
}

function extractRevenue(text) {
  const patterns = [
    /Fourth quarter revenues were[^$]{0,120}\$\s*([\d,.]+)\s*(billion|million)/i,
    /Revenues? for [^.]{0,120}?(?:were|was)[^$]{0,120}\$\s*([\d,.]+)\s*(billion|million)/i,
    /(?:Revenue|Revenues|Net sales)(?:\s+for [^.]{0,100})?(?:\s+were|\s+was|\s+of|\s+totaled)?[^$]{0,140}\$\s*([\d,.]+)\s*(billion|million)/i
  ];
  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) return moneyNumber(match[1], match[2]);
  }
  return null;
}

async function resolveReaction(task, reportTiming, args) {
  const yahoo = await fetchYahooBars(task.symbol, task.reportDate, task.reportDate, args, fetchJson);
  const bars = yahoo.bars || [];
  const { basis, fromBar, toBar } = reactionWindow(bars, task.reportDate, reportTiming);
  const pct = fromBar && toBar && earningsCloseAvailable(toBar) ? pctChange(fromBar.close, toBar.close) : null;
  const status = pct !== null ? 'computed' : reportTiming === 'unknown' ? 'unavailable' : 'awaiting_close';
  return {
    basis,
    percent: pct,
    fromDate: status === 'computed' ? fromBar.date : '',
    fromClose: status === 'computed' ? fromBar.close : null,
    toDate: status === 'computed' ? toBar.date : '',
    toClose: status === 'computed' ? toBar.close : null,
    status,
    note: '',
    source: 'Yahoo Finance Chart API',
    sourceAudit: {
      status: yahoo.status,
      rowCount: bars.length,
      error: yahoo.error
    }
  };
}

async function resolveTask(task, tickerMap, args) {
  const ticker = tickerMap.get(task.symbol);
  if (!ticker) {
    return unresolved(task, 'ticker_not_found_in_sec_company_tickers');
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded(ticker.cik)}.json`;
  const submissions = await fetchJson(submissionsUrl, args);
  if (!submissions.ok || !submissions.data?.filings?.recent) {
    return unresolved(task, 'sec_submissions_unavailable', { submissionsUrl, status: submissions.status, error: submissions.error || submissions.parseError });
  }

  const filing = chooseEarningsFiling(task, submissions.data.filings.recent);
  if (!filing) {
    return unresolved(task, 'earnings_8k_not_found', { submissionsUrl });
  }

  const filingIndex = await fetchFilingIndex(ticker.cik, filing.accessionNumber, args);
  if (!filingIndex.ok || !filingIndex.data) {
    return unresolved(task, 'filing_index_unavailable', { filingIndexUrl: filingIndex.url, status: filingIndex.status, error: filingIndex.error || filingIndex.parseError });
  }

  const exhibitName = chooseExhibit(filingIndex.data);
  if (!exhibitName) {
    return unresolved(task, 'earnings_exhibit_not_found', { filingIndexUrl: filingIndex.url });
  }

  const accessionPath = filing.accessionNumber.replace(/-/g, '');
  const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${cikPath(ticker.cik)}/${accessionPath}/${exhibitName}`;
  const exhibit = await fetchText(sourceUrl, args);
  if (!exhibit.ok) {
    return unresolved(task, 'earnings_exhibit_unavailable', { sourceUrl, status: exhibit.status, error: exhibit.error });
  }

  const text = cleanText(exhibit.body);
  const eps = extractEps(text);
  // Company releases may report GAAP, adjusted, and special-item EPS in the
  // same exhibit; reconcile to the queued task before classifying beat/miss.
  const comparableEps = resolveComparableEps(eps, task, text);
  const backup = earningsApiBackup(task);
  const revenueActual = extractRevenue(text);
  const reportTiming = extractReportTiming(filing);
  const officialReport = { ...task, reportDate: filing.filingDate };
  const reaction = await resolveReaction(officialReport, reportTiming, args);
  const status = Number.isFinite(comparableEps.actual) && Number.isFinite(revenueActual) ? 'resolved' : 'needs_review';
  const notes = [
    Number.isFinite(comparableEps.estimate)
      ? `${task.trigger === 'provider_date_conflict_requires_company_release' ? 'Finnhub' : 'EarningsAPI company endpoint'} supplied the retained consensus estimates for comparison.`
      : 'Company release supplied reported actuals; consensus estimates remain unavailable unless supplied by another deterministic source.'
  ];
  if (comparableEps.adjustment?.note) notes.push(comparableEps.adjustment.note);
  if (comparableEps.comparisonSource === 'unreconciled_earningsapi_company') {
    notes.push('EarningsAPI EPS actual did not reconcile to the SEC/company-release EPS basis; avoid EPS beat/miss classification without review.');
  }

  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: filing.filingDate,
    status,
    sourceType: 'sec_8k_exhibit_99_1',
    sourceUrl,
    secFilingUrl: `https://www.sec.gov/Archives/edgar/data/${cikPath(ticker.cik)}/${accessionPath}/${filing.primaryDocument}`,
    confidence: status === 'resolved' ? 'high' : 'medium',
    fields: {
      company: task.company,
      fiscalPeriod: extractFiscalPeriod(text, filing.filingDate),
      reportTiming,
      eps: {
        actual: comparableEps.actual,
        basis: comparableEps.basis,
        gaapActual: comparableEps.gaapActual,
        gaapBasis: comparableEps.gaapBasis,
        adjustment: comparableEps.adjustment,
        actualSource: comparableEps.actualSource,
        estimate: comparableEps.estimate,
        estimateSource: comparableEps.estimateSource,
        estimateCount: comparableEps.estimateCount,
        comparisonSource: comparableEps.comparisonSource
      },
      revenue: {
        actual: revenueActual,
        estimate: backup.revenue.estimate,
        estimateSource: backup.revenue.estimateSource
      }
    },
    reaction,
    notes,
    sourceAudit: {
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      filing,
      exhibitName,
      earningsApiCalendar: task.sourceAudit?.earningsApiCalendar || null,
      extractedTextPreview: text.slice(0, 800)
    }
  };
}

function unresolved(task, reason, audit = {}) {
  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status: 'unresolved',
    sourceType: '',
    sourceUrl: '',
    secFilingUrl: '',
    confidence: 'low',
    fields: {
      company: task.company,
      fiscalPeriod: '',
      reportTiming: 'unknown',
      eps: {
        actual: null,
        basis: '',
        gaapActual: null,
        gaapBasis: '',
        adjustment: null,
        actualSource: '',
        estimate: null,
        estimateSource: '',
        estimateCount: '',
        comparisonSource: ''
      },
      revenue: {
        actual: null,
        estimate: null,
        estimateSource: ''
      }
    },
    reaction: {
      basis: 'unavailable',
      percent: null,
      fromDate: '',
      fromClose: null,
      toDate: '',
      toClose: null,
      status: 'unavailable',
      note: '',
      source: '',
      sourceAudit: {}
    },
    notes: [reason],
    sourceAudit: audit
  };
}

async function run(argv) {
  loadEnv();
  const args = parseArgs(argv);
  const source = readJson(args.input);
  const companyReleaseTasks = Array.isArray(source.companyReleaseTasks) ? source.companyReleaseTasks : [];
  const tickerMap = await loadTickerMap(args);
  const companyReleaseResolutions = [];
  for (const task of companyReleaseTasks) {
    companyReleaseResolutions.push(await resolveTask(task, tickerMap, args));
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: source.generatedAt,
    sourceArtifact: path.relative(root, args.input),
    sourceRange: source.range,
    companyReleaseResolutions,
    summary: {
      total: companyReleaseResolutions.length,
      resolved: companyReleaseResolutions.filter((item) => item.status === 'resolved').length,
      needsReview: companyReleaseResolutions.filter((item) => item.status === 'needs_review').length,
      unresolved: companyReleaseResolutions.filter((item) => item.status === 'unresolved').length
    },
    outputPath: args.output
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);

  process.stdout.write(`Earnings Company-Release Resolution Summary
===========================================
Tasks: ${payload.summary.total}
Resolved: ${payload.summary.resolved}
Needs review: ${payload.summary.needsReview}
Unresolved: ${payload.summary.unresolved}
Output: ${args.output}
`);
  if (!args.compact) {
    for (const item of companyReleaseResolutions) {
      process.stdout.write(`${item.symbol} ${item.status} EPS ${item.fields.eps?.actual ?? 'n/a'} revenue ${item.fields.revenue?.actual ?? 'n/a'} ${item.sourceUrl}\n`);
    }
  }
}


return { run };
}

const resolveCommand = createResolveCommand();


async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }
  if (command === 'build') return runBuild(argv);
  if (command === 'refresh') return refreshCommand.run(argv);
  if (command === 'resolve') return resolveCommand.run(argv);
  if (command === 'validate') return runValidation(argv);
  if (command === 'validate-release') return runValidation(['release', ...argv]);
  if (command === 'apply-release') return applyReleaseCommand(argv);
  if (command === 'apply-narrative') return applyNarrativeCommand(argv);
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
  applyCompanyReleaseResolutions,
  applyEarningsNarrative,
  applyEarningsApiCompanyRefresh: refreshCommand.applyEarningsApiCompanyRefresh,
  applyFinnhubRefresh: refreshCommand.applyFinnhubRefresh,
  earningsCalendarNeedsBuild,
  earningsScheduleConfirmationRequiredError,
  mergeFinnhubConflictCandidates: refreshCommand.mergeFinnhubConflictCandidates,
  pendingEarningsScheduleReviews,
  refreshEarningsResults: refreshCommand.refreshEarningsResults,
  refreshTargetRows: refreshCommand.refreshTargetRows,
  removeStaleCompanyReleaseResolutionSidecar: refreshCommand.removeStaleCompanyReleaseResolutionSidecar,
  reportWindowArrived: refreshCommand.reportWindowArrived,
  selectFinnhubRefreshRow: refreshCommand.selectFinnhubRefreshRow,
  validateEarningsWeekPayload
};
