#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const {
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsRowKey: rowKey,
  normalizeEarningsTiming: normalizeTiming,
  numberOrNull
} = require('./earnings_week_contract');
const { compareIsoDate, displayDatesForRange, isIsoDate } = require('./calendar_contract');

const {
  attachReactions,
  buildCompanyReleaseTasks,
  combinedOutcome,
  fetchYahooBarsForRows,
  valueOutcome
} = require('./earnings_week_build');

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
    skipValidation: false,
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
    if (arg === '--skip-validation') {
      args.skipValidation = true;
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
  --skip-validation           Do not run earnings_week validate before/after
  --compact                   Print compact refresh report
  --help                      Show this help

Environment:
  FINNHUB_API_KEY             Required for Finnhub-covered row actuals
  EARNINGSAPI_API_KEY         Required only for previously recovered rows

This result-refresh path never calls the EarningsAPI calendar endpoint.
`);
}

function loadEnv(file = path.resolve(root, '.env')) {
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

function pctChange(estimate, actual) {
  if (!Number.isFinite(estimate) || !Number.isFinite(actual) || estimate === 0) return null;
  return (actual / estimate - 1) * 100;
}

function metricResult(actual, estimate) {
  if (!Number.isFinite(actual)) return 'pending';
  if (!Number.isFinite(estimate)) return 'not_compared';
  return valueOutcome(actual, estimate);
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

function normalizeFinnhubCalendarRow(row) {
  return {
    symbol: String(row?.symbol || '').trim().toUpperCase(),
    reportDate: String(row?.date || '').trim(),
    reportTiming: normalizeTiming(row?.hour),
    fiscalQuarter: numberOrNull(row?.quarter),
    fiscalYear: numberOrNull(row?.year),
    eps: {
      estimate: numberOrNull(row?.epsEstimate),
      actual: numberOrNull(row?.epsActual)
    },
    revenue: {
      estimate: numberOrNull(row?.revenueEstimate),
      actual: numberOrNull(row?.revenueActual)
    }
  };
}

async function fetchFinnhubCalendarRows(args, token, range) {
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&token=${encodeURIComponent(token)}`;
  const result = await fetchJson(url, args);
  if (!result.ok) {
    throw new Error(`Finnhub result refresh failed: ${result.parseError || result.bodyPreview || `HTTP ${result.status}`}`);
  }
  return (Array.isArray(result.data?.earningsCalendar) ? result.data.earningsCalendar : [])
    .map(normalizeFinnhubCalendarRow)
    .filter((row) => row.symbol && isIsoDate(row.reportDate))
    .filter((row) => displayDatesForRange(range.from, range.to).includes(row.reportDate));
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
    // A corrupt local ledger should not turn into silent unmetered calls.
  }
  throw new Error(`EarningsAPI usage ledger is unreadable: ${file}`);
}

function writeEarningsApiUsage(file, usage) {
  writeJson(file, usage);
}

function earningsApiMonthEntry(usage) {
  const month = earningsApiUsageMonth();
  if (!usage.months[month]) usage.months[month] = { calls: 0, requests: [] };
  if (!Array.isArray(usage.months[month].requests)) usage.months[month].requests = [];
  return usage.months[month];
}

function canUseEarningsApi(args, usage, token) {
  if (!token) return false;
  const entry = earningsApiMonthEntry(usage);
  return entry.calls < Math.max(0, args.earningsApiMonthlyLimit - args.earningsApiReserve);
}

async function fetchEarningsApiCompanyRows(symbol, args, token, usage) {
  if (!canUseEarningsApi(args, usage, token)) {
    throw new Error(`EarningsAPI company refresh is required for ${symbol}, but the API key or call budget is unavailable.`);
  }
  const url = new URL('/v1/earnings', 'https://api.earningsapi.com');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', token);
  const entry = earningsApiMonthEntry(usage);
  entry.calls += 1;
  entry.requests.push({
    at: new Date().toISOString(),
    type: 'company-earnings-result-refresh',
    path: url.pathname,
    query: 'symbol'
  });
  if (entry.requests.length > 200) entry.requests = entry.requests.slice(-200);
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

function easternClock(asOfIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(asOfIso)).reduce((map, part) => {
    map[part.type] = part.value;
    return map;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function reportWindowArrived(row, asOfIso) {
  const asOf = easternClock(asOfIso);
  if (!isIsoDate(row.reportDate) || compareIsoDate(row.reportDate, asOf.date) > 0) return false;
  if (compareIsoDate(row.reportDate, asOf.date) < 0) return true;
  if (row.reportTiming === 'bmo') return asOf.minutes >= 8 * 60;
  if (row.reportTiming === 'dmh') return asOf.minutes >= 9 * 60 + 30;
  if (row.reportTiming === 'amc') return asOf.minutes >= 16 * 60;
  return false;
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
  const asOf = options.asOf || new Date().toISOString();
  const targetKeys = new Set(refreshTargetRows(output, asOf).map(rowKey));
  const changedKeys = new Set();
  const finnhubByKey = new Map((refreshData.finnhubRows || []).map((row) => [rowKey(row), row]));
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
    const refreshed = attachReactions(reactionRows, refreshData.yahooFetches)
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
    output.rows = output.rows.map((row) => changedKeys.has(rowKey(row)) ? clearNarrative(row) : row);
    delete output.narrativeApply;
  }

  output.companyReleaseTasks = buildCompanyReleaseTasks(output.secondaryRecoveryCandidates || [], output.rows, {
    shouldEscalateDateConflict: (row) => reportWindowArrived(row, asOf)
  });
  if (output.companyReleaseTasks.length === 0) delete output.companyReleaseApply;
  updateSummary(output);
  output.generatedAt = new Date().toISOString();
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
  }) : [];

  return {
    finnhubRows,
    earningsApiCompanyRowsBySymbol,
    yahooFetches
  };
}

function validateWeek(file, requireNarrative = false) {
  const command = [
    path.resolve(root, 'scripts', 'validate_earnings_week.js'),
    '--input',
    file
  ];
  if (requireNarrative) command.push('--require-narrative');
  execFileSync(process.execPath, command, { stdio: 'inherit' });
}

function printReport(result, outputPath, compact) {
  process.stdout.write(`Earnings Result Refresh
=======================
Rows eligible for refresh: ${result.refreshedRows}
Rows with deterministic changes: ${result.changedRows}
Output: ${outputPath}
`);
  if (!compact && result.changedRows > 0) {
    process.stdout.write('Narrative was invalidated for changed rows; rerun node scripts/earnings_week.js apply-narrative before embedding.\n');
  }
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.skipValidation) validateWeek(args.input);
  const source = readJson(args.input);
  const refreshData = await collectRefreshData(source, args);
  const result = await refreshEarningsResults(source, refreshData, {
    asOf: args.asOf,
    outputPath: args.output
  });
  writeJson(args.output, result.payload);
  if (args.output === DEFAULT_INPUT && removeStaleCompanyReleaseResolutionSidecar(result.payload, DEFAULT_COMPANY_RELEASE_RESOLUTIONS)) {
    process.stdout.write('Removed stale company-release resolution sidecar because the refreshed week has no active tasks.\n');
  }
  if (!args.skipValidation) validateWeek(args.output);
  printReport(result, args.output, args.compact);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  applyEarningsApiCompanyRefresh,
  applyFinnhubRefresh,
  mergeFinnhubConflictCandidates,
  refreshEarningsResults,
  refreshTargetRows,
  removeStaleCompanyReleaseResolutionSidecar,
  reportWindowArrived,
  selectFinnhubRefreshRow
};
