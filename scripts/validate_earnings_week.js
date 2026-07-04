#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultInput = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');

const TIMINGS = new Set(['bmo', 'amc', 'dmh', 'unknown']);
const OUTCOMES = new Set([
  'beat',
  'miss',
  'mixed',
  'met',
  'eps_only_beat',
  'eps_only_miss',
  'pending',
  'unverified'
]);
const METRIC_RESULTS = new Set(['beat', 'miss', 'met', 'not_compared', 'pending']);
const SOURCE_STATUSES = new Set(['verified', 'partial', 'unverified']);
const REACTION_BASES = new Set([
  'same_day_close',
  'next_session_close',
  'during_market_close',
  'unavailable'
]);
const REACTION_STATUSES = new Set(['computed', 'unavailable', 'pending']);
const SECONDARY_RECOVERY_PRIORITIES = new Set(['high', 'normal']);
const SOURCE_SUMMARY_PRIMARIES = new Set(['finnhub', 'earningsApiCompany', 'sec_company_release']);
const NUMBER_TOLERANCE = 0.0001;
const PCT_TOLERANCE = 0.03;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'generatedAt',
  'range',
  'policy',
  'rows',
  'secondaryRecoveryCandidates',
  'companyReleaseTasks',
  'summary',
  'outputPath',
  'companyReleaseApply',
  'narrativeApply'
]);
const ROW_FIELDS = new Set([
  'symbol',
  'company',
  'exchange',
  'country',
  'currency',
  'marketCap',
  'marketCapDisplay',
  'reportDate',
  'reportTiming',
  'fiscalQuarterEnding',
  'fiscalQuarter',
  'fiscalYear',
  'eps',
  'revenue',
  'outcome',
  'reaction',
  'sourceStatus',
  'sourceSummary',
  'sourceAudit'
]);
const FORBIDDEN_ROW_FIELDS = [
  // These flat fields existed during mockup iteration; production rows must
  // stay on the nested eps/revenue/outcome/reaction contract.
  'epsEstimate',
  'epsActual',
  'epsSurprisePct',
  'revenueEstimate',
  'revenueActual',
  'revenueSurprisePct',
  'outcomeDrivers'
];

function parseArgs(argv) {
  const args = {
    input: defaultInput,
    requireNarrative: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || defaultInput);
      i += 1;
      continue;
    }
    if (arg === '--require-narrative') {
      args.requireNarrative = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/validate_earnings_week.js [options]

Options:
  --input PATH      Generated earnings week JSON (default: scripts/generated/earnings_week.json)
  --require-narrative
                    Require applied narrative for every display-eligible row
  --help           Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoDateTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function dateFromIso(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = dateFromIso(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return isoFromDate(date);
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function nullableNumber(value) {
  return value === null || isFiniteNumber(value);
}

function nearlyEqual(left, right, tolerance = NUMBER_TOLERANCE) {
  return isFiniteNumber(left) && isFiniteNumber(right) && Math.abs(left - right) <= tolerance;
}

function nearlyEqualNullable(left, right, tolerance = NUMBER_TOLERANCE) {
  if (left === null && right === null) return true;
  return nearlyEqual(left, right, tolerance);
}

function pctChange(from, to) {
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from === 0) return null;
  return (to / from - 1) * 100;
}

function compareIsoDate(left, right) {
  return String(left).localeCompare(String(right));
}

function isMondayFridayRange(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return false;
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  return start.getUTCDay() === 1
    && end.getUTCDay() === 5
    && addDays(from, 4) === to;
}

function valueOutcome(actual, estimate) {
  if (!isFiniteNumber(actual) || !isFiniteNumber(estimate)) return 'unknown';
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'met';
}

function expectedMetricResult(actual, estimate) {
  if (!isFiniteNumber(actual)) return 'pending';
  if (!isFiniteNumber(estimate)) return 'not_compared';
  return valueOutcome(actual, estimate);
}

function expectedCombinedOutcome(epsResult, revenueResult) {
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

function validateRange(errors, range) {
  if (!isObject(range)) {
    errors.push('range must be an object.');
    return;
  }
  if (!isIsoDate(range.from)) errors.push('range.from must be an ISO date.');
  if (!isIsoDate(range.to)) errors.push('range.to must be an ISO date.');
  if (isIsoDate(range.from) && isIsoDate(range.to) && compareIsoDate(range.from, range.to) > 0) {
    errors.push('range.from must be on or before range.to.');
  }
  if (isIsoDate(range.from) && isIsoDate(range.to) && !isMondayFridayRange(range.from, range.to)) {
    errors.push('range must be exactly Monday through Friday.');
  }
}

function validatePolicy(errors, policy) {
  if (!isObject(policy)) {
    errors.push('policy must be an object documenting merge rules.');
    return;
  }
  for (const field of ['baseSlate', 'enrichment', 'reaction']) {
    if (typeof policy[field] !== 'string' || !policy[field].trim()) {
      errors.push(`policy.${field} must be populated.`);
    }
  }
  if (!/Finnhub/i.test(policy.baseSlate)) errors.push('policy.baseSlate must identify Finnhub as the primary slate.');
  if (!Array.isArray(policy.sourceHierarchy) || policy.sourceHierarchy.length !== 5) {
    errors.push('policy.sourceHierarchy must list the five canonical source layers.');
  } else {
    const expectedOrder = [/Finnhub/i, /Finnhub metric|profile/i, /EarningsAPI/i, /SEC|company release/i, /Yahoo/i];
    policy.sourceHierarchy.forEach((item, index) => {
      if (typeof item !== 'string' || !expectedOrder[index].test(item)) {
        errors.push(`policy.sourceHierarchy[${index}] must describe the canonical source order.`);
      }
    });
  }
  if (!isObject(policy.fieldPrimaries)) errors.push('policy.fieldPrimaries must be populated.');
  if (!isObject(policy.reactionRules)) errors.push('policy.reactionRules must be populated.');
  if (!isObject(policy.secondaryRecoveryFieldPolicy)) {
    errors.push('policy.secondaryRecoveryFieldPolicy must be populated.');
  } else {
    if (!/EarningsAPI/i.test(policy.secondaryRecoveryFieldPolicy.eps || '')) {
      errors.push('policy.secondaryRecoveryFieldPolicy.eps must identify EarningsAPI as secondary recovery.');
    }
    if (!/EarningsAPI/i.test(policy.secondaryRecoveryFieldPolicy.revenue || '')) {
      errors.push('policy.secondaryRecoveryFieldPolicy.revenue must identify EarningsAPI as secondary recovery.');
    }
  }
}

function validateSecondaryRecoveryTaskPolicy(errors, task, label) {
  const neededFields = Array.isArray(task.neededFields) ? task.neededFields : [];
  const requiredFields = [
    'earningsApiCompanyRow',
    'reportTiming',
    'eps.estimate',
    'eps.actual',
    'revenue.estimate',
    'revenue.actual'
  ];
  for (const field of requiredFields) {
    if (!neededFields.includes(field)) errors.push(`${label}.neededFields must include ${field}.`);
  }
  if (!arraysEqual(neededFields, requiredFields)) {
    errors.push(`${label}.neededFields must exactly match ${requiredFields.join(',')}.`);
  }
}

function validateCompanyReleaseTaskPolicy(errors, task, label) {
  const neededFields = Array.isArray(task.neededFields) ? task.neededFields : [];
  const requiredFields = [
    'reportTiming',
    'fiscalPeriod',
    'eps.actual',
    'revenue.actual',
    'companyReleaseUrl',
    'secFilingUrl'
  ];
  for (const field of requiredFields) {
    if (!neededFields.includes(field)) errors.push(`${label}.neededFields must include ${field}.`);
  }
  if (!arraysEqual(neededFields, requiredFields)) {
    errors.push(`${label}.neededFields must exactly match ${requiredFields.join(',')}.`);
  }
  if (!Array.isArray(task.preferredSources) || task.preferredSources.length === 0) errors.push(`${label}.preferredSources must be populated.`);
  if (!Array.isArray(task.doNotUseForOverrides) || !task.doNotUseForOverrides.includes('finnhub_calendar_row')) {
    errors.push(`${label}.doNotUseForOverrides must include finnhub_calendar_row.`);
  }
  const permittedUses = Array.isArray(task.permittedUses) ? task.permittedUses : [];
  for (const use of ['official_actuals_resolution', 'timing_resolution', 'fiscal_period_resolution', 'eps_basis_resolution']) {
    if (!permittedUses.includes(use)) errors.push(`${label}.permittedUses must include ${use}.`);
  }
  if (typeof task.instructions !== 'string' || !task.instructions.trim()) errors.push(`${label}.instructions must be populated.`);
}

function validateSecondaryRecoveryTaskCompanyAudit(errors, task, label) {
  const audit = task.sourceAudit?.earningsApiCompany;
  if (!isObject(audit)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany must be populated.`);
    return;
  }
  if (!isObject(audit.selectedRow)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow must be populated.`);
    return;
  }
  if (audit.selectedRow.reportDate !== task.reportDate) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow.reportDate must match task.reportDate.`);
  }
  if (!TIMINGS.has(audit.selectedRow.reportTiming)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow.reportTiming is invalid.`);
  }
  validateAuditMetricSnapshot(errors, audit.selectedRow, `${label}.sourceAudit.earningsApiCompany.selectedRow`);
}

function validateReaction(errors, row, label) {
  const reaction = row.reaction;
  if (!isObject(reaction)) {
    errors.push(`${label}.reaction must be an object.`);
    return;
  }
  if (!REACTION_BASES.has(reaction.basis)) errors.push(`${label}.reaction.basis is invalid.`);
  if (!nullableNumber(reaction.percent)) errors.push(`${label}.reaction.percent must be numeric or null.`);
  if (!REACTION_STATUSES.has(reaction.status)) errors.push(`${label}.reaction.status is invalid.`);
  if (typeof reaction.note !== 'string') errors.push(`${label}.reaction.note must be a string.`);
  if (reaction.basis === 'unavailable') {
    if (reaction.percent !== null) errors.push(`${label}.reaction.percent must be null when basis is unavailable.`);
    return;
  }
  for (const field of ['fromDate', 'toDate']) {
    if (!isIsoDate(reaction[field])) errors.push(`${label}.reaction.${field} must be an ISO date.`);
  }
  for (const field of ['fromClose', 'toClose']) {
    if (!isFiniteNumber(reaction[field])) errors.push(`${label}.reaction.${field} must be numeric.`);
  }
  const expectedPct = pctChange(reaction.fromClose, reaction.toClose);
  if (expectedPct !== null && !nearlyEqual(reaction.percent, expectedPct, PCT_TOLERANCE)) {
    errors.push(`${label}.reaction.percent must match fromClose/toClose.`);
  }
  if (reaction.status !== 'computed') errors.push(`${label}.reaction.status must be computed when reaction basis is available.`);
  if (row.reportTiming === 'bmo' && reaction.basis !== 'same_day_close') {
    errors.push(`${label}.reaction.basis must be same_day_close for bmo reports.`);
  }
  if (row.reportTiming === 'amc' && reaction.basis !== 'next_session_close') {
    errors.push(`${label}.reaction.basis must be next_session_close for amc reports.`);
  }
  if (row.reportTiming === 'dmh' && reaction.basis !== 'during_market_close') {
    errors.push(`${label}.reaction.basis must be during_market_close for dmh reports.`);
  }
}

function expectedSource(value, source) {
  return value === null ? 'none' : source;
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function validateMetric(errors, metric, label, options = {}) {
  if (!isObject(metric)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  for (const field of ['estimate', 'actual', 'surprisePercent']) {
    if (!nullableNumber(metric[field])) errors.push(`${label}.${field} must be numeric or null.`);
  }
  if (!METRIC_RESULTS.has(metric.result)) errors.push(`${label}.result is invalid.`);
  const expectedSurprise = pctChange(metric.estimate, metric.actual);
  if (expectedSurprise === null) {
    if (metric.surprisePercent !== null) errors.push(`${label}.surprisePercent must be null when inputs are incomplete.`);
  } else if (!nearlyEqual(metric.surprisePercent, expectedSurprise, PCT_TOLERANCE)) {
    errors.push(`${label}.surprisePercent must match actual/estimate.`);
  }
  const expectedResult = expectedMetricResult(metric.actual, metric.estimate);
  if (metric.result !== expectedResult) errors.push(`${label}.result must be ${expectedResult}.`);
  if (options.requireBasis && typeof metric.basis !== 'string') errors.push(`${label}.basis must be a string.`);
  if (typeof metric.note !== 'string') errors.push(`${label}.note must be a string.`);
}

function validateSelectedSources(errors, selected, expected, label) {
  for (const field of ['slate', 'company', 'marketCap', 'timing', 'reaction']) {
    if (selected[field] !== expected[field]) {
      errors.push(`${label}.sourceAudit.selectedSources.${field} must be ${expected[field]}.`);
    }
  }
  for (const metric of ['eps', 'revenue']) {
    if (!isObject(selected[metric])) {
      errors.push(`${label}.sourceAudit.selectedSources.${metric} must be populated.`);
      continue;
    }
    for (const field of ['estimate', 'actual']) {
      if (selected[metric][field] !== expected[metric][field]) {
        errors.push(`${label}.sourceAudit.selectedSources.${metric}.${field} must be ${expected[metric][field]}.`);
      }
    }
  }
}

function validateAuditMetricSnapshot(errors, snapshot, label) {
  if (!isObject(snapshot.eps)) {
    errors.push(`${label}.eps must be populated.`);
  } else {
    for (const field of ['estimate', 'actual']) {
      if (!nullableNumber(snapshot.eps[field])) errors.push(`${label}.eps.${field} must be numeric or null.`);
    }
  }
  if (!isObject(snapshot.revenue)) {
    errors.push(`${label}.revenue must be populated.`);
  } else {
    for (const field of ['estimate', 'actual']) {
      if (!nullableNumber(snapshot.revenue[field])) errors.push(`${label}.revenue.${field} must be numeric or null.`);
    }
  }
  for (const staleField of ['epsEstimate', 'epsActual', 'revenueEstimate', 'revenueActual']) {
    if (Object.prototype.hasOwnProperty.call(snapshot, staleField)) {
      errors.push(`${label}.${staleField} must not appear; use eps/revenue nested fields.`);
    }
  }
}

function validateFinnhubRowSourceAudit(errors, row, audit, selected, label) {
  if (!isObject(audit.finnhubCalendar)) {
    errors.push(`${label}.sourceAudit.finnhubCalendar must be populated.`);
  } else {
    const calendar = audit.finnhubCalendar;
    if (calendar.reportDate !== row.reportDate) errors.push(`${label}.finnhubCalendar.reportDate must match row.reportDate.`);
    if (calendar.reportTiming !== row.reportTiming) errors.push(`${label}.finnhubCalendar.reportTiming must match row.reportTiming.`);
    validateAuditMetricSnapshot(errors, calendar, `${label}.sourceAudit.finnhubCalendar`);
    if (!nearlyEqualNullable(calendar.eps?.estimate, row.eps?.estimate)) errors.push(`${label}.eps.estimate must match Finnhub calendar.`);
    if (!nearlyEqualNullable(calendar.eps?.actual, row.eps?.actual)) errors.push(`${label}.eps.actual must match Finnhub calendar.`);
    if (!nearlyEqualNullable(calendar.revenue?.estimate, row.revenue?.estimate)) errors.push(`${label}.revenue.estimate must match Finnhub calendar.`);
    if (!nearlyEqualNullable(calendar.revenue?.actual, row.revenue?.actual)) errors.push(`${label}.revenue.actual must match Finnhub calendar.`);
  }
  const profileName = audit.finnhubProfile?.name || '';
  const hasMetricMarketCap = isObject(audit.finnhubMetric) && isFiniteNumber(audit.finnhubMetric.marketCap);
  const hasEarningsApiCompany = isObject(audit.earningsApiCalendar) && typeof audit.earningsApiCalendar.company === 'string' && audit.earningsApiCalendar.company.trim();
  if (selected.company === 'earningsApiCalendar') {
    if (!hasEarningsApiCompany) errors.push(`${label}.sourceAudit.earningsApiCalendar.company must be populated for company-name recovery.`);
    if (row.company !== audit.earningsApiCalendar?.company) errors.push(`${label}.company must match EarningsAPI calendar company when selected.`);
  }
  if (selected.marketCap === 'finnhubMetric') {
    if (!hasMetricMarketCap) errors.push(`${label}.sourceAudit.finnhubMetric.marketCap must be populated for market-cap recovery.`);
    if (!nearlyEqualNullable(audit.finnhubMetric?.marketCap, row.marketCap)) errors.push(`${label}.marketCap must match Finnhub metric marketCap.`);
  }
  const expectedSources = {
    slate: 'finnhub',
    company: profileName ? 'finnhubProfile' : hasEarningsApiCompany ? 'earningsApiCalendar' : 'symbol',
    marketCap: isFiniteNumber(audit.finnhubProfile?.marketCap) ? 'finnhubProfile' : hasMetricMarketCap ? 'finnhubMetric' : 'none',
    timing: row.reportTiming === 'unknown' ? 'none' : 'finnhub',
    eps: {
      estimate: expectedSource(row.eps?.estimate, 'finnhub'),
      actual: expectedSource(row.eps?.actual, 'finnhub')
    },
    revenue: {
      estimate: expectedSource(row.revenue?.estimate, 'finnhub'),
      actual: expectedSource(row.revenue?.actual, 'finnhub')
    },
    reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
  };
  validateSelectedSources(errors, selected, expectedSources, label);
}

function validateEarningsApiRowSourceAudit(errors, row, audit, selected, label) {
  if (audit.finnhubCalendar?.present !== false) {
    errors.push(`${label}.sourceAudit.finnhubCalendar.present must be false for EarningsAPI-recovered rows.`);
  }
  if (!isObject(audit.earningsApiCalendar)) {
    errors.push(`${label}.sourceAudit.earningsApiCalendar must be populated for EarningsAPI-recovered rows.`);
  } else {
    validateAuditMetricSnapshot(errors, audit.earningsApiCalendar, `${label}.sourceAudit.earningsApiCalendar`);
  }
  if (!isObject(audit.earningsApiCompany?.selectedRow)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow must be populated for EarningsAPI-recovered rows.`);
    return;
  }
  const companyRow = audit.earningsApiCompany.selectedRow;
  const companyReleaseResolution = audit.companyReleaseResolution;
  if (companyRow.reportDate !== row.reportDate) errors.push(`${label}.earningsApiCompany.reportDate must match row.reportDate.`);
  validateAuditMetricSnapshot(errors, companyRow, `${label}.sourceAudit.earningsApiCompany.selectedRow`);
  let expectedSources;
  if (isObject(companyReleaseResolution)) {
    const fields = companyReleaseResolution.fields || {};
    const eps = isObject(fields.eps) ? fields.eps : {};
    const revenue = isObject(fields.revenue) ? fields.revenue : {};
    if (companyReleaseResolution.status !== 'resolved') errors.push(`${label}.sourceAudit.companyReleaseResolution must be resolved when applied to a row.`);
    if (companyReleaseResolution.symbol !== row.symbol) errors.push(`${label}.sourceAudit.companyReleaseResolution.symbol must match row.symbol.`);
    if (companyReleaseResolution.reportDate !== row.reportDate) errors.push(`${label}.sourceAudit.companyReleaseResolution.reportDate must match row.reportDate.`);
    if (fields.reportTiming !== row.reportTiming) errors.push(`${label}.reportTiming must match company-release resolution.`);
    if (!nearlyEqualNullable(eps.estimate, row.eps?.estimate)) errors.push(`${label}.eps.estimate must match company-release resolution.`);
    if (!nearlyEqualNullable(eps.actual, row.eps?.actual)) errors.push(`${label}.eps.actual must match company-release resolution.`);
    if (!nearlyEqualNullable(revenue.estimate, row.revenue?.estimate)) errors.push(`${label}.revenue.estimate must match company-release resolution.`);
    if (!nearlyEqualNullable(revenue.actual, row.revenue?.actual)) errors.push(`${label}.revenue.actual must match company-release resolution.`);
    expectedSources = {
      slate: 'earningsApiCalendar',
      company: audit.finnhubProfile?.name ? 'finnhubProfile' : 'earningsApiCompany',
      marketCap: row.marketCap === null ? 'none' : 'finnhubProfile',
      timing: row.reportTiming === 'unknown' ? 'none' : 'sec_company_release',
      eps: {
        estimate: expectedSource(row.eps?.estimate, eps.estimateSource === 'earningsapi_company' ? 'earningsApiCompany' : 'none'),
        actual: expectedSource(row.eps?.actual, eps.actualSource || 'sec_company_release')
      },
      revenue: {
        estimate: expectedSource(row.revenue?.estimate, revenue.estimateSource === 'earningsapi_company' ? 'earningsApiCompany' : 'none'),
        actual: expectedSource(row.revenue?.actual, 'sec_company_release')
      },
      reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
    };
  } else {
    if (companyRow.reportTiming !== row.reportTiming) errors.push(`${label}.earningsApiCompany.reportTiming must match row.reportTiming.`);
    if (!nearlyEqualNullable(companyRow.eps?.estimate, row.eps?.estimate)) errors.push(`${label}.eps.estimate must match EarningsAPI company row.`);
    if (!nearlyEqualNullable(companyRow.eps?.actual, row.eps?.actual)) errors.push(`${label}.eps.actual must match EarningsAPI company row.`);
    if (!nearlyEqualNullable(companyRow.revenue?.estimate, row.revenue?.estimate)) errors.push(`${label}.revenue.estimate must match EarningsAPI company row.`);
    if (!nearlyEqualNullable(companyRow.revenue?.actual, row.revenue?.actual)) errors.push(`${label}.revenue.actual must match EarningsAPI company row.`);
    expectedSources = {
      slate: 'earningsApiCalendar',
      company: audit.finnhubProfile?.name ? 'finnhubProfile' : 'earningsApiCompany',
      marketCap: row.marketCap === null ? 'none' : 'finnhubProfile',
      timing: row.reportTiming === 'unknown' ? 'none' : 'earningsApiCompany',
      eps: {
        estimate: expectedSource(row.eps?.estimate, 'earningsApiCompany'),
        actual: expectedSource(row.eps?.actual, 'earningsApiCompany')
      },
      revenue: {
        estimate: expectedSource(row.revenue?.estimate, 'earningsApiCompany'),
        actual: expectedSource(row.revenue?.actual, 'earningsApiCompany')
      },
      reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
    };
  }
  validateSelectedSources(errors, selected, expectedSources, label);
}

function validateSourceAudit(errors, row, label) {
  const audit = row.sourceAudit;
  if (!isObject(audit)) {
    errors.push(`${label}.sourceAudit must be an object.`);
    return;
  }
  if (audit.finnhubProfile !== null && !isObject(audit.finnhubProfile)) {
    errors.push(`${label}.sourceAudit.finnhubProfile must be an object or null.`);
  }
  if (isObject(audit.finnhubProfile)) {
    if (row.sourceAudit?.selectedSources?.company === 'finnhubProfile' && audit.finnhubProfile.name !== row.company) {
      errors.push(`${label}.company must match Finnhub profile name.`);
    }
    if (row.sourceAudit?.selectedSources?.marketCap === 'finnhubProfile' && !nearlyEqualNullable(audit.finnhubProfile.marketCap, row.marketCap)) {
      errors.push(`${label}.marketCap must match Finnhub profile marketCap.`);
    }
  }
  if (!isObject(audit.selectedSources)) {
    errors.push(`${label}.sourceAudit.selectedSources must be populated.`);
  } else {
    const selected = audit.selectedSources;
    if (selected.slate === 'finnhub') {
      validateFinnhubRowSourceAudit(errors, row, audit, selected, label);
    } else if (selected.slate === 'earningsApiCalendar') {
      validateEarningsApiRowSourceAudit(errors, row, audit, selected, label);
    } else {
      errors.push(`${label}.sourceAudit.selectedSources.slate is invalid.`);
    }
  }
  if (!isObject(audit.yahoo)) errors.push(`${label}.sourceAudit.yahoo must be populated.`);
}

function validateSourceSummary(errors, row, label) {
  const summary = row.sourceSummary;
  if (!isObject(summary)) {
    errors.push(`${label}.sourceSummary must be populated.`);
    return;
  }
  if (!SOURCE_SUMMARY_PRIMARIES.has(summary.primary)) errors.push(`${label}.sourceSummary.primary is invalid.`);
  if (!Array.isArray(summary.fallbacks)) errors.push(`${label}.sourceSummary.fallbacks must be an array.`);
  const expectedReaction = row.reaction?.status === 'computed' ? 'yahoo' : 'none';
  if (summary.reaction !== expectedReaction) errors.push(`${label}.sourceSummary.reaction must be ${expectedReaction}.`);
  const selected = row.sourceAudit?.selectedSources || {};
  let expectedPrimary = '';
  let expectedFallbacks = [];
  if (selected.slate === 'finnhub') {
    expectedPrimary = 'finnhub';
    if (selected.company === 'earningsApiCalendar') expectedFallbacks.push('earningsApiCalendar');
    if (selected.marketCap === 'finnhubMetric') expectedFallbacks.push('finnhubMetric');
  } else if (selected.slate === 'earningsApiCalendar' && isObject(row.sourceAudit?.companyReleaseResolution)) {
    expectedPrimary = 'sec_company_release';
    expectedFallbacks = ['earningsApiCompany'];
    if (row.sourceAudit?.finnhubProfile) expectedFallbacks.push('finnhubProfile');
  } else if (selected.slate === 'earningsApiCalendar') {
    expectedPrimary = 'earningsApiCompany';
    expectedFallbacks = ['earningsApiCalendar'];
    if (row.sourceAudit?.finnhubProfile) expectedFallbacks.push('finnhubProfile');
  }
  if (expectedPrimary && summary.primary !== expectedPrimary) {
    errors.push(`${label}.sourceSummary.primary must be ${expectedPrimary}.`);
  }
  if (expectedPrimary && !arraysEqual(summary.fallbacks, expectedFallbacks)) {
    errors.push(`${label}.sourceSummary.fallbacks must be ${expectedFallbacks.join(',') || 'empty'}.`);
  }
}

function expectedSourceStatus(row) {
  if (row.reportTiming === 'unknown') return 'partial';
  if (!isFiniteNumber(row.eps?.estimate) || !isFiniteNumber(row.eps?.actual)) return 'partial';
  if (!isFiniteNumber(row.revenue?.estimate) || !isFiniteNumber(row.revenue?.actual)) return 'partial';
  if (row.reaction?.status !== 'computed') return 'partial';
  return 'verified';
}

function validateRow(errors, rowRaw, index, range) {
  const row = isObject(rowRaw) ? rowRaw : {};
  const label = row.symbol || `rows[${index}]`;

  for (const field of Object.keys(row)) {
    if (!ROW_FIELDS.has(field)) errors.push(`${label}.${field} is not part of the canonical row contract.`);
  }
  for (const field of FORBIDDEN_ROW_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      errors.push(`${label}.${field} must not appear; use the canonical nested row contract.`);
    }
  }

  if (typeof row.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(row.symbol)) {
    errors.push(`${label}.symbol must be populated and uppercase.`);
  }
  if (typeof row.company !== 'string' || !row.company.trim()) errors.push(`${label}.company must be populated.`);
  if (!nullableNumber(row.marketCap)) errors.push(`${label}.marketCap must be numeric or null.`);
  if (!isIsoDate(row.reportDate)) {
    errors.push(`${label}.reportDate must be an ISO date.`);
  } else if (isObject(range) && isIsoDate(range.from) && isIsoDate(range.to)) {
    if (compareIsoDate(row.reportDate, range.from) < 0 || compareIsoDate(row.reportDate, range.to) > 0) {
      errors.push(`${label}.reportDate must be inside range.`);
    }
  }
  if (!TIMINGS.has(row.reportTiming)) errors.push(`${label}.reportTiming is invalid.`);
  if (!nullableNumber(row.fiscalQuarter)) errors.push(`${label}.fiscalQuarter must be numeric or null.`);
  if (!nullableNumber(row.fiscalYear)) errors.push(`${label}.fiscalYear must be numeric or null.`);
  validateMetric(errors, row.eps, `${label}.eps`, { requireBasis: true });
  validateMetric(errors, row.revenue, `${label}.revenue`);
  if (!isObject(row.outcome)) {
    errors.push(`${label}.outcome must be an object.`);
  } else {
    if (!OUTCOMES.has(row.outcome.overall)) errors.push(`${label}.outcome.overall is invalid.`);
    if (typeof row.outcome.guide !== 'string') errors.push(`${label}.outcome.guide must be a string.`);
    if (typeof row.outcome.interpretation !== 'string') errors.push(`${label}.outcome.interpretation must be a string.`);
  }
  if (!SOURCE_STATUSES.has(row.sourceStatus)) errors.push(`${label}.sourceStatus is invalid.`);
  const expectedStatus = expectedSourceStatus(row);
  if (row.sourceStatus !== expectedStatus) errors.push(`${label}.sourceStatus must be ${expectedStatus}.`);

  const expectedOutcome = expectedCombinedOutcome(row.eps?.result, row.revenue?.result);
  if (row.outcome?.overall !== expectedOutcome) errors.push(`${label}.outcome.overall must be ${expectedOutcome}.`);

  if (row.sourceStatus === 'verified') {
    if (row.reportTiming === 'unknown') errors.push(`${label} is verified but reportTiming is unknown.`);
    if (!isFiniteNumber(row.eps?.estimate) || !isFiniteNumber(row.eps?.actual)) errors.push(`${label} is verified but EPS estimate/actual is incomplete.`);
    if (!isFiniteNumber(row.revenue?.estimate) || !isFiniteNumber(row.revenue?.actual)) errors.push(`${label} is verified but revenue estimate/actual is incomplete.`);
    if (row.reaction?.status !== 'computed') errors.push(`${label} is verified but reaction is unavailable.`);
  }

  validateReaction(errors, row, label);
  validateSourceSummary(errors, row, label);
  validateSourceAudit(errors, row, label);
}

function validateSummary(errors, data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const secondaryRecoveryCandidates = Array.isArray(data.secondaryRecoveryCandidates) ? data.secondaryRecoveryCandidates : [];
  const companyReleaseTasks = Array.isArray(data.companyReleaseTasks) ? data.companyReleaseTasks : [];
  const counts = data.summary?.counts;
  if (!isObject(data.summary)) {
    errors.push('summary must be an object.');
    return;
  }
  if (!isObject(counts)) {
    errors.push('summary.counts must be an object.');
    return;
  }
  const expected = {
    total: rows.length,
    verified: rows.filter((row) => row?.sourceStatus === 'verified').length,
    partial: rows.filter((row) => row?.sourceStatus === 'partial').length,
    reactionComputed: rows.filter((row) => row?.reaction?.status === 'computed').length,
    missingTiming: rows.filter((row) => row?.reportTiming === 'unknown').length,
    missingRevenue: rows.filter((row) => row?.revenue?.estimate === null && row?.revenue?.actual === null).length,
    missingMarketCap: rows.filter((row) => row?.marketCap === null).length,
    secondaryRecoveryCandidates: secondaryRecoveryCandidates.length,
    companyReleaseTasks: companyReleaseTasks.length
  };
  for (const [field, value] of Object.entries(expected)) {
    if (counts[field] !== value) errors.push(`summary.counts.${field} must be ${value}.`);
  }
}

function validateCompanyReleaseApply(errors, data) {
  const tasks = Array.isArray(data.companyReleaseTasks) ? data.companyReleaseTasks : [];
  if (tasks.length === 0) return;
  if (!isObject(data.companyReleaseApply)) {
    errors.push('companyReleaseApply must be populated when companyReleaseTasks exist.');
    return;
  }
  const apply = data.companyReleaseApply;
  if (!isIsoDateTime(apply.generatedAt)) errors.push('companyReleaseApply.generatedAt must be an ISO timestamp.');
  if (typeof apply.resolutionArtifact !== 'string' || !/earnings_company_release_resolutions\.json$/.test(apply.resolutionArtifact)) {
    errors.push('companyReleaseApply.resolutionArtifact must identify earnings_company_release_resolutions.json.');
  }
  if (!Array.isArray(apply.applied)) errors.push('companyReleaseApply.applied must be an array.');
  if (!Array.isArray(apply.skipped)) errors.push('companyReleaseApply.skipped must be an array.');
  const applied = Array.isArray(apply.applied) ? apply.applied : [];
  const skipped = Array.isArray(apply.skipped) ? apply.skipped : [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const rowsByKey = new Map((Array.isArray(data.rows) ? data.rows : []).map((row) => [rowKey(row), row]));
  const appliedIds = new Set();
  for (const item of applied) {
    if (!isObject(item)) {
      errors.push('companyReleaseApply.applied entries must be objects.');
      continue;
    }
    if (typeof item.taskId !== 'string' || !item.taskId.trim()) errors.push('companyReleaseApply.applied.taskId must be populated.');
    if (typeof item.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(item.symbol)) errors.push('companyReleaseApply.applied.symbol must be uppercase.');
    if (!taskIds.has(item.taskId)) errors.push(`${item.taskId || 'companyReleaseApply.applied'} must map to companyReleaseTasks.`);
    if (appliedIds.has(item.taskId)) errors.push(`companyReleaseApply.applied contains duplicate ${item.taskId}.`);
    appliedIds.add(item.taskId);
  }
  for (const item of skipped) {
    const taskId = isObject(item) ? item.taskId : '';
    errors.push(`${taskId || 'companyReleaseApply.skipped'} must not be skipped for dashboard-ready earnings payloads.`);
  }
  for (const task of tasks) {
    if (!appliedIds.has(task.id)) errors.push(`${task.id} must be present in companyReleaseApply.applied.`);
    const row = rowsByKey.get(rowKey(task));
    if (!row) {
      errors.push(`${task.id} must apply to a canonical row.`);
    } else if (row.sourceAudit?.companyReleaseResolution?.taskId !== task.id) {
      errors.push(`${task.id} must be reflected in row.sourceAudit.companyReleaseResolution.`);
    }
  }
}

function rowKey(row) {
  return `${row.reportDate}:${row.symbol}`;
}

function isDisplayEligible(row) {
  // Profile-recovered rows have audited company/market-cap sources but no listing fields.
  // Treat only that explicit source combination as display-eligible without country/exchange.
  const hasProfileRecovery = row.sourceAudit?.selectedSources?.company === 'earningsApiCalendar'
    && row.sourceAudit?.selectedSources?.marketCap === 'finnhubMetric';
  if (hasProfileRecovery) return Number.isFinite(row.marketCap) && row.marketCap >= 1000000000;
  if (row.country && row.country !== 'US') return false;
  if (/OTC/i.test(row.exchange || '')) return false;
  if ((row.sourceAudit?.finnhubProfile?.industry || '').toUpperCase() === 'N/A') return false;
  return Number.isFinite(row.marketCap) && row.marketCap >= 1000000000;
}

function validateNarrativeApply(errors, data, options = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const requiredRows = rows.filter(isDisplayEligible);
  if (!isObject(data.narrativeApply)) {
    if (options.required && requiredRows.length) errors.push('narrativeApply must be populated after narrative enrichment.');
    return;
  }

  const apply = data.narrativeApply;
  if (!isIsoDateTime(apply.generatedAt)) errors.push('narrativeApply.generatedAt must be an ISO timestamp.');
  if (typeof apply.narrativeArtifact !== 'string' || !/earnings_narrative\.json$/.test(apply.narrativeArtifact)) {
    errors.push('narrativeApply.narrativeArtifact must identify earnings_narrative.json.');
  }
  if (!Array.isArray(apply.applied) || apply.applied.length === 0) {
    errors.push('narrativeApply.applied must be a non-empty array.');
    return;
  }

  const rowsByKey = new Map(rows.map((row) => [rowKey(row), row]));
  const appliedKeys = new Set();
  for (const item of apply.applied) {
    if (!isObject(item)) {
      errors.push('narrativeApply.applied entries must be objects.');
      continue;
    }
    if (typeof item.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(item.symbol)) {
      errors.push('narrativeApply.applied.symbol must be uppercase.');
    }
    if (!isIsoDate(item.reportDate)) errors.push(`${item.symbol || 'narrativeApply.applied'}.reportDate must be an ISO date.`);
    const key = rowKey(item);
    if (appliedKeys.has(key)) errors.push(`narrativeApply.applied contains duplicate ${key}.`);
    appliedKeys.add(key);
    if (!rowsByKey.has(key)) errors.push(`narrativeApply.applied ${key} does not match a canonical row.`);
  }

  for (const row of requiredRows) {
    // Narrative is required only for rows the dashboard can actually show.
    // Non-display rows may remain mechanically complete without AI copy.
    const key = rowKey(row);
    if (!appliedKeys.has(key)) {
      errors.push(`${row.symbol} is display-eligible but missing from narrativeApply.applied.`);
      continue;
    }
    if (!row.outcome?.interpretation?.trim()) errors.push(`${row.symbol}.outcome.interpretation must be populated after narrative enrichment.`);
    if (row.reaction?.status === 'computed' && !row.reaction.note.trim()) {
      errors.push(`${row.symbol}.reaction.note must be populated after narrative enrichment.`);
    }
  }
}

function validateSecondaryRecoveryCandidates(errors, data) {
  if (!Array.isArray(data.secondaryRecoveryCandidates)) {
    errors.push('secondaryRecoveryCandidates must be an array.');
    return;
  }
  const seen = new Set();
  data.secondaryRecoveryCandidates.forEach((task, index) => {
    const label = task?.id || `secondaryRecoveryCandidates[${index}]`;
    if (!isObject(task)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (typeof task.id !== 'string' || !task.id.trim()) errors.push(`${label}.id must be populated.`);
    if (seen.has(task.id)) errors.push(`${label}.id must be unique.`);
    seen.add(task.id);
    if (typeof task.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(task.symbol)) errors.push(`${label}.symbol must be uppercase.`);
    if (typeof task.company !== 'string' || !task.company.trim()) errors.push(`${label}.company must be populated.`);
    if (!isIsoDate(task.reportDate)) errors.push(`${label}.reportDate must be an ISO date.`);
    if (task.trigger !== 'missing_from_finnhub_but_present_in_earningsapi') errors.push(`${label}.trigger is invalid.`);
    if (!SECONDARY_RECOVERY_PRIORITIES.has(task.priority)) errors.push(`${label}.priority is invalid.`);
    if (!isFiniteNumber(task.marketCap)) errors.push(`${label}.marketCap must be numeric.`);
    if (!Array.isArray(task.neededFields) || task.neededFields.length === 0) errors.push(`${label}.neededFields must be populated.`);
    validateSecondaryRecoveryTaskPolicy(errors, task, label);
    if (!Array.isArray(task.preferredSources) || task.preferredSources.length === 0) errors.push(`${label}.preferredSources must be populated.`);
    if (!Array.isArray(task.doNotUseForOverrides) || !task.doNotUseForOverrides.includes('finnhub_calendar_row')) {
      errors.push(`${label}.doNotUseForOverrides must include finnhub_calendar_row.`);
    }
    const permittedUses = Array.isArray(task.permittedUses) ? task.permittedUses : [];
    for (const use of ['missing_row_discovery', 'eps_estimate_recovery', 'eps_actual_recovery', 'revenue_estimate_recovery', 'revenue_actual_recovery']) {
      if (!permittedUses.includes(use)) errors.push(`${label}.permittedUses must include ${use}.`);
    }
    if (typeof task.instructions !== 'string' || !task.instructions.trim()) errors.push(`${label}.instructions must be populated.`);
    if (!isObject(task.sourceAudit?.earningsApiCalendar)) {
      errors.push(`${label}.sourceAudit.earningsApiCalendar must be populated.`);
    } else {
      validateAuditMetricSnapshot(errors, task.sourceAudit.earningsApiCalendar, `${label}.sourceAudit.earningsApiCalendar`);
    }
    validateSecondaryRecoveryTaskCompanyAudit(errors, task, label);
    if (task.sourceAudit?.finnhubCalendar?.present !== false) errors.push(`${label}.sourceAudit.finnhubCalendar.present must be false.`);
  });
}

function validateCompanyReleaseTasks(errors, data) {
  if (!Array.isArray(data.companyReleaseTasks)) {
    errors.push('companyReleaseTasks must be an array.');
    return;
  }
  const recoveryIds = new Set((data.secondaryRecoveryCandidates || []).map((task) => task.id));
  const seen = new Set();
  data.companyReleaseTasks.forEach((task, index) => {
    const label = task?.id || `companyReleaseTasks[${index}]`;
    if (!isObject(task)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (typeof task.id !== 'string' || !task.id.trim()) errors.push(`${label}.id must be populated.`);
    if (seen.has(task.id)) errors.push(`${label}.id must be unique.`);
    seen.add(task.id);
    if (typeof task.recoveryId !== 'string' || !recoveryIds.has(task.recoveryId)) errors.push(`${label}.recoveryId must map to secondaryRecoveryCandidates.`);
    if (typeof task.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(task.symbol)) errors.push(`${label}.symbol must be uppercase.`);
    if (typeof task.company !== 'string' || !task.company.trim()) errors.push(`${label}.company must be populated.`);
    if (!isIsoDate(task.reportDate)) errors.push(`${label}.reportDate must be an ISO date.`);
    if (task.trigger !== 'secondary_recovery_requires_company_release') errors.push(`${label}.trigger is invalid.`);
    if (typeof task.reason !== 'string' || !task.reason.trim()) errors.push(`${label}.reason must be populated.`);
    if (!SECONDARY_RECOVERY_PRIORITIES.has(task.priority)) errors.push(`${label}.priority is invalid.`);
    if (!isFiniteNumber(task.marketCap)) errors.push(`${label}.marketCap must be numeric.`);
    validateCompanyReleaseTaskPolicy(errors, task, label);
    if (!isObject(task.sourceAudit?.earningsApiCalendar)) {
      errors.push(`${label}.sourceAudit.earningsApiCalendar must be populated.`);
    } else {
      validateAuditMetricSnapshot(errors, task.sourceAudit.earningsApiCalendar, `${label}.sourceAudit.earningsApiCalendar`);
    }
    validateSecondaryRecoveryTaskCompanyAudit(errors, task, label);
    if (task.sourceAudit?.finnhubCalendar?.present !== false) errors.push(`${label}.sourceAudit.finnhubCalendar.present must be false.`);
  });
}

function validateEarningsWeekPayload(data, options = {}) {
  const errors = [];

  for (const field of Object.keys(data)) {
    if (!TOP_LEVEL_FIELDS.has(field)) errors.push(`${field} is not part of the canonical earnings week contract.`);
  }
  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (!isIsoDateTime(data.generatedAt)) errors.push('generatedAt must be an ISO timestamp.');
  validateRange(errors, data.range);
  validatePolicy(errors, data.policy);

  if (!Array.isArray(data.rows)) {
    errors.push('rows must be an array.');
  } else {
    const seen = new Set();
    data.rows.forEach((row, index) => {
      const key = `${row?.reportDate || index}:${row?.symbol || index}`;
      if (seen.has(key)) errors.push(`Duplicate earnings row ${key}.`);
      seen.add(key);
      validateRow(errors, row, index, data.range);
    });
  }

  validateSecondaryRecoveryCandidates(errors, data);
  validateCompanyReleaseTasks(errors, data);
  validateSummary(errors, data);
  validateCompanyReleaseApply(errors, data);
  validateNarrativeApply(errors, data, { required: options.requireNarrative });

  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = readJson(args.input);
  const errors = validateEarningsWeekPayload(data, { requireNarrative: args.requireNarrative });

  if (errors.length) {
    console.error(`Earnings week validation failed for ${args.input}:`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(`Earnings week validation passed for ${args.input}`);
  console.log(`Rows: ${data.rows.length}`);
  console.log(`Verified: ${data.summary.counts.verified}`);
  console.log(`Partial: ${data.summary.counts.partial}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  validateEarningsWeekPayload
};
