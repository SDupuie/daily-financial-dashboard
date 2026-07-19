#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  EARNINGS_WEEK_SCHEMA_VERSION,
  earningsCloseAvailable,
  earningsRowKey: rowKey,
  earningsRowLifecycle,
  earningsReactionBasis,
  metricResult
} = require('./earnings_week_contract');
const {
  compareIsoDate,
  displayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isSupportedFiveTradingDayRange
} = require('./calendar_contract');

const root = path.resolve(__dirname, '..');
const defaultEarningsInput = path.resolve(root, 'generated', 'earnings_week.json');
const defaultCompanyReleaseInput = path.resolve(root, 'generated', 'earnings_company_release_resolutions.json');

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
const REACTION_STATUSES = new Set(['computed', 'awaiting_close', 'unavailable', 'pending']);
const LIFECYCLES = new Set(['scheduled', 'awaiting_actual', 'released_awaiting_close', 'close_available']);
const SOURCE_SUMMARY_PRIMARIES = new Set(['finnhub', 'earningsApiCompany', 'sec_company_release']);
const RELEASE_RESOLUTION_STATUSES = new Set(['resolved', 'needs_review', 'unresolved']);
const RELEASE_RESOLUTION_CONFIDENCES = new Set(['high', 'medium', 'low']);
const COMMENTARY_DISPOSITION_STATUSES = new Set(['verified', 'commentary_unavailable', 'pending_review']);
const GUIDANCE_DISPOSITION_STATUSES = new Set(['verified', 'not_provided', 'unverified', 'pending_review']);
const COMMENTARY_UNAVAILABLE_STATUSES = new Set(['commentary_unavailable']);
const GUIDANCE_UNAVAILABLE_STATUSES = new Set(['unverified']);
const RESULT_REFRESH_PROVIDERS = new Set(['finnhub', 'earningsApiCompany', 'yahoo']);
const RESULT_REFRESH_FAILURE_CODES = new Set([
  'missing_api_key',
  'usage_ledger_unreadable',
  'budget_unavailable',
  'provider_request_failed',
  'provider_row_unavailable'
]);
const NUMBER_TOLERANCE = 0.0001;
const PCT_TOLERANCE = 0.03;
const OUTCOME_NO_GUIDANCE_PATTERN = /\bno\s+(?:(?:formal|updated)\s+)?guidance\b|\bguidance\s+(?:not\s+(?:provided|issued|available)|unverified|none)\b/i;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'generatedAt',
  'range',
  // Accepted only while the current canonical artifact transitions; every updater-owned Earnings write removes it.
  'policy',
  'availability',
  'rows',
  'secondaryRecoveryCandidates',
  'companyReleaseTasks',
  'summary',
  'outputPath',
  'companyReleaseApply',
  'narrativeApply'
]);
const RELEASE_TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'generatedAt',
  'sourceArtifact',
  'sourceGeneratedAt',
  'sourceRange',
  'companyReleaseResolutions',
  'summary',
  'outputPath'
]);
const COMPANY_RELEASE_APPLY_FIELDS = new Set([
  'generatedAt',
  'resolutionArtifact',
  'applied',
  'dispositions'
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
  'lifecycle',
  'sourceStatus',
  'scheduleVerificationStatus',
  'companyReleaseStatus',
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
  const mode = argv[0] === 'release' ? 'release' : 'week';
  const offset = mode === 'release' || argv[0] === 'week' ? 1 : 0;
  const args = {
    mode,
    input: mode === 'release' ? defaultCompanyReleaseInput : defaultEarningsInput,
    week: defaultEarningsInput
  };

  for (let i = offset; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || args.input);
      i += 1;
      continue;
    }
    if (arg === '--week') {
      args.week = path.resolve(process.cwd(), argv[i + 1] || defaultEarningsInput);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp(mode);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp(mode = 'week') {
  if (mode === 'release') {
    process.stdout.write(`Usage: node scripts/earnings_week.js validate-release [options]

Options:
  --input PATH      Company-release resolutions JSON (default: generated/earnings_company_release_resolutions.json)
  --week PATH       Earnings week JSON with companyReleaseTasks (default: generated/earnings_week.json)
  --help            Show this help
`);
    return;
  }

  process.stdout.write(`Usage: node scripts/earnings_week.js validate [options]

Options:
  --input PATH      Generated earnings week JSON (default: generated/earnings_week.json)
  --help           Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRenderableEarningsRow(row) {
  return isObject(row)
    && typeof row.symbol === 'string'
    && row.symbol.trim()
    && typeof row.company === 'string'
    && row.company.trim()
    && isIsoDate(row.reportDate)
    && isObject(row.eps)
    && isObject(row.revenue)
    && isObject(row.outcome)
    && isObject(row.reaction);
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
  if (isIsoDate(range.from) && isIsoDate(range.to) && !isSupportedFiveTradingDayRange(range.from, range.to)) {
    errors.push('range must be Monday-Friday or Friday plus next Monday-Thursday.');
  }
}

function validateSecondaryRecoveryTaskCompanyAudit(errors, task, label) {
  const audit = task.sourceAudit?.earningsApiCompany;
  if (!isObject(audit)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany must be populated.`);
    return;
  }
  if (!isObject(audit.selectedRow)) {
    if (typeof audit.error !== 'string' || !audit.error.trim()) {
      errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow must be populated or carry a retryable provider error.`);
    }
    return;
  }
  if (audit.selectedRow.reportDate !== task.reportDate) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow.reportDate must match task.reportDate.`);
  }
  if (!TIMINGS.has(audit.selectedRow.reportTiming)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow.reportTiming is invalid.`);
  }
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
  const expectedResult = metricResult(metric.actual, metric.estimate, options.metric);
  if (metric.result !== expectedResult) errors.push(`${label}.result must be ${expectedResult}.`);
  if (options.requireBasis && typeof metric.basis !== 'string') errors.push(`${label}.basis must be a string.`);
  if (typeof metric.note !== 'string') errors.push(`${label}.note must be a string.`);
}

function validateSelectedSources(errors, selected, expected, label, row = null, audit = null) {
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
  for (const metric of ['eps', 'revenue']) {
    for (const field of ['estimate', 'actual']) {
      const value = row?.[metric]?.[field];
      const source = selected?.[metric]?.[field];
      if (value === null && source !== 'none') errors.push(`${label}.sourceAudit.selectedSources.${metric}.${field} must be none when ${metric}.${field} is null.`);
      if (value !== null && source === 'none') errors.push(`${label}.sourceAudit.selectedSources.${metric}.${field} must identify a source when ${metric}.${field} is populated.`);
      if (companyReleaseSource(source) && !isObject(audit?.companyReleaseResolution)) {
        errors.push(`${label}.sourceAudit.companyReleaseResolution must be populated when ${metric}.${field} uses a company-release source.`);
      }
    }
  }
}

function companyReleaseSource(value) {
  return String(value || '').startsWith('sec_company_release');
}

function validateCompanyReleaseResolutionEvidence(errors, resolution, label) {
  const epsActual = resolution.fields?.eps?.actual;
  const revenueActual = resolution.fields?.revenue?.actual;
  const hasEps = isFiniteNumber(epsActual);
  const hasRevenue = isFiniteNumber(revenueActual);
  if (resolution.status === 'resolved') {
    if (resolution.confidence !== 'high') errors.push(`${label}.confidence must be high when resolved.`);
    if (!hasEps) errors.push(`${label}.fields.eps.actual is required when resolved.`);
    if (!hasRevenue) errors.push(`${label}.fields.revenue.actual is required when resolved.`);
  } else if (resolution.status === 'needs_review') {
    if (resolution.confidence !== 'medium') errors.push(`${label}.confidence must be medium when needs_review.`);
    if (hasEps && hasRevenue) errors.push(`${label}.status must be resolved when both official actuals are available.`);
  } else if (resolution.status === 'unresolved') {
    if (resolution.confidence !== 'low') errors.push(`${label}.confidence must be low when unresolved.`);
    if (hasEps || hasRevenue) errors.push(`${label}.unresolved disposition must not contain official actuals.`);
  }
  if (['resolved', 'needs_review'].includes(resolution.status)) {
    if (resolution.sourceType !== 'sec_8k_exhibit_99_1') errors.push(`${label}.sourceType must be sec_8k_exhibit_99_1.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(resolution.sourceUrl || '')) errors.push(`${label}.sourceUrl must be an SEC URL.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(resolution.secFilingUrl || '')) errors.push(`${label}.secFilingUrl must be an SEC URL.`);
  }
  if (hasEps && !String(resolution.fields?.eps?.actualSource || '').startsWith('sec_company_release')) {
    errors.push(`${label}.fields.eps.actualSource must identify the SEC/company release when an official EPS actual is populated.`);
  }
}

function validateCompanyReleaseAudit(errors, resolution, row, label) {
  if (!RELEASE_RESOLUTION_STATUSES.has(resolution.status)) {
    errors.push(`${label}.sourceAudit.companyReleaseResolution.status must be resolved, needs_review, or unresolved.`);
    return;
  }
  if (typeof resolution.taskId !== 'string' || !resolution.taskId.trim()) errors.push(`${label}.sourceAudit.companyReleaseResolution.taskId must be populated.`);
  if (resolution.symbol !== row.symbol) errors.push(`${label}.sourceAudit.companyReleaseResolution.symbol must match row.symbol.`);
  if (!isIsoDate(resolution.reportDate)) errors.push(`${label}.sourceAudit.companyReleaseResolution.reportDate must be an ISO date.`);
  if (!RELEASE_RESOLUTION_CONFIDENCES.has(resolution.confidence)) errors.push(`${label}.sourceAudit.companyReleaseResolution.confidence is invalid.`);
  if (!Array.isArray(resolution.notes) || (resolution.status !== 'resolved' && !resolution.notes.length)) {
    errors.push(`${label}.sourceAudit.companyReleaseResolution.notes must record why the task was not resolved.`);
  }
  if (resolution.status !== 'resolved' && row.sourceStatus !== 'partial') {
    errors.push(`${label}.sourceStatus must remain partial for a non-resolved company-release disposition.`);
  }
  if (['resolved', 'needs_review'].includes(resolution.status)) {
    if (resolution.sourceType !== 'sec_8k_exhibit_99_1') errors.push(`${label}.sourceAudit.companyReleaseResolution.sourceType must be sec_8k_exhibit_99_1.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(resolution.sourceUrl || '')) errors.push(`${label}.sourceAudit.companyReleaseResolution.sourceUrl must be an SEC URL.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(resolution.secFilingUrl || '')) errors.push(`${label}.sourceAudit.companyReleaseResolution.secFilingUrl must be an SEC URL.`);
  }
}

function validateFinnhubRowSourceAudit(errors, row, audit, selected, label) {
  const companyReleaseResolution = isObject(audit.companyReleaseResolution) ? audit.companyReleaseResolution : null;
  const promotedEps = companyReleaseSource(selected.eps?.actual);
  const promotedRevenue = companyReleaseSource(selected.revenue?.actual);
  const scheduleVerification = isObject(audit.scheduleVerification) ? audit.scheduleVerification : null;
  if (scheduleVerification) {
    if (!['corroborated', 'official_confirmed', 'primary_only'].includes(scheduleVerification.status)) {
      errors.push(`${label}.sourceAudit.scheduleVerification.status is invalid.`);
    }
    if (!isIsoDate(scheduleVerification.primaryDate)) errors.push(`${label}.sourceAudit.scheduleVerification.primaryDate must be an ISO date.`);
    if (!Array.isArray(scheduleVerification.secondaryDates) || scheduleVerification.secondaryDates.some((date) => !isIsoDate(date))) {
      errors.push(`${label}.sourceAudit.scheduleVerification.secondaryDates must contain ISO dates.`);
    }
    if (scheduleVerification.status === 'official_confirmed') {
      const official = scheduleVerification.official;
      // This proves that published provenance is scoped to the canonical event;
      // it does not prove that the linked IR page's contents were fetched or read.
      if (!isObject(official) || official.symbol !== row.symbol || official.primaryDate !== scheduleVerification.primaryDate || !isIsoDate(official.primaryDate) || !isIsoDate(official.reportDate) || !/^https:\/\//.test(official.sourceUrl || '') || !String(official.sourceName || '').trim()) {
        errors.push(`${label}.sourceAudit.scheduleVerification.official must identify the current symbol and primary date and provide an official ISO report date, HTTPS URL, and source name.`);
      } else if (official.reportDate !== row.reportDate) {
        errors.push(`${label}.reportDate must match the official schedule confirmation.`);
      }
    } else {
      if (scheduleVerification.official !== null) {
        errors.push(`${label}.sourceAudit.scheduleVerification.official must be null unless officially confirmed.`);
      }
    }
  }
  if (!isObject(audit.finnhubCalendar)) {
    errors.push(`${label}.sourceAudit.finnhubCalendar must be populated.`);
  } else {
    const calendar = audit.finnhubCalendar;
    const conflict = isObject(audit.providerDateConflict) ? audit.providerDateConflict : null;
    const conflictSelectedDate = conflict?.selectedDate || '';
    const conflictFinnhubDates = Array.isArray(conflict?.candidates?.finnhub)
      ? conflict.candidates.finnhub.map((item) => item.reportDate)
      : [];
    if (conflict) {
      if (conflict.status !== 'fallback') errors.push(`${label}.providerDateConflict.status must be fallback.`);
      if (conflict.selectedProvider !== 'finnhub') errors.push(`${label}.providerDateConflict.selectedProvider must be finnhub.`);
      if (conflict.selectedDateSource !== 'finnhub_fallback') errors.push(`${label}.providerDateConflict.selectedDateSource must be finnhub_fallback.`);
      if (conflict.reason !== 'provider_date_conflict_finnhub_retained') errors.push(`${label}.providerDateConflict.reason must be provider_date_conflict_finnhub_retained.`);
      const candidateKeys = isObject(conflict.candidates) ? Object.keys(conflict.candidates).sort() : [];
      if (!arraysEqual(candidateKeys, ['earningsApiCalendar', 'finnhub'])) errors.push(`${label}.providerDateConflict.candidates must contain exactly earningsApiCalendar and finnhub.`);
      if (conflictSelectedDate !== calendar.reportDate) errors.push(`${label}.providerDateConflict.selectedDate must match the retained Finnhub calendar date.`);
      if (!conflictFinnhubDates.includes(calendar.reportDate)) errors.push(`${label}.finnhubCalendar.reportDate must match a providerDateConflict Finnhub candidate.`);
    } else if (scheduleVerification?.status === 'official_confirmed') {
      if (calendar.reportDate !== scheduleVerification.primaryDate) errors.push(`${label}.finnhubCalendar.reportDate must match scheduleVerification.primaryDate.`);
    } else if (calendar.reportDate !== row.reportDate) {
      errors.push(`${label}.finnhubCalendar.reportDate must match row.reportDate.`);
    }
    if (!conflict && calendar.reportTiming !== row.reportTiming) errors.push(`${label}.finnhubCalendar.reportTiming must match row.reportTiming.`);
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
  // Mirror buildRows source precedence exactly; this keeps identity recovery
  // explicit instead of accepting broad legacy aliases or oldName || newName drift.
  let expectedSources = {
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
  if (companyReleaseResolution?.status === 'resolved') {
    validateCompanyReleaseAudit(errors, companyReleaseResolution, row, label);
    expectedSources = {
      ...expectedSources,
      timing: row.reportTiming === 'unknown' ? 'none' : 'sec_company_release',
      eps: {
        estimate: selected.eps?.estimate || expectedSources.eps.estimate,
        actual: expectedSource(row.eps?.actual, promotedEps ? selected.eps.actual : 'sec_company_release')
      },
      revenue: {
        estimate: selected.revenue?.estimate || expectedSources.revenue.estimate,
        actual: expectedSource(row.revenue?.actual, promotedRevenue ? selected.revenue.actual : 'sec_company_release')
      }
    };
  } else if (companyReleaseResolution) {
    validateCompanyReleaseAudit(errors, companyReleaseResolution, row, label);
    expectedSources = {
      ...expectedSources,
      eps: {
        ...expectedSources.eps,
        ...(promotedEps ? { actual: selected.eps.actual } : {})
      },
      revenue: {
        ...expectedSources.revenue,
        ...(promotedRevenue ? { actual: selected.revenue.actual } : {})
      }
    };
  }
  validateSelectedSources(errors, selected, expectedSources, label, row, audit);
}

function validateEarningsApiRowSourceAudit(errors, row, audit, selected, label) {
  const scheduleVerification = isObject(audit.scheduleVerification) ? audit.scheduleVerification : null;
  if (scheduleVerification) {
    const official = scheduleVerification.official;
    if (scheduleVerification.status === 'secondary_only') {
      if (!isIsoDate(scheduleVerification.primaryDate)
        || scheduleVerification.primaryDate !== row.reportDate
        || !Array.isArray(scheduleVerification.secondaryDates)
        || scheduleVerification.secondaryDates.length
        || official !== null) {
        errors.push(`${label}.sourceAudit.scheduleVerification must identify an unconfirmed secondary-only date.`);
      }
    } else if (scheduleVerification.status !== 'official_confirmed'
      || !isIsoDate(scheduleVerification.primaryDate)
      || !Array.isArray(scheduleVerification.secondaryDates)
      || !isObject(official)
      || official.symbol !== row.symbol
      || official.primaryDate !== scheduleVerification.primaryDate
      || !isIsoDate(official.primaryDate)
      || !isIsoDate(official.reportDate)
      || official.reportDate !== row.reportDate
      || !/^https:\/\//.test(official.sourceUrl || '')
      || !String(official.sourceName || '').trim()) {
      // Structural validation proves event-bound provenance, not remote source
      // authenticity.
      errors.push(`${label}.sourceAudit.scheduleVerification must be secondary_only or a complete official schedule confirmation.`);
    }
  }
  if (audit.finnhubCalendar?.present !== false) {
    errors.push(`${label}.sourceAudit.finnhubCalendar.present must be false for EarningsAPI-recovered rows.`);
  }
  if (!isObject(audit.earningsApiCalendar)) {
    errors.push(`${label}.sourceAudit.earningsApiCalendar must be populated for EarningsAPI-recovered rows.`);
  }
  if (!isObject(audit.earningsApiCompany?.selectedRow)) {
    errors.push(`${label}.sourceAudit.earningsApiCompany.selectedRow must be populated for EarningsAPI-recovered rows.`);
    return;
  }
  const companyRow = audit.earningsApiCompany.selectedRow;
  const companyReleaseResolution = audit.companyReleaseResolution;
  const promotedEps = companyReleaseSource(selected.eps?.actual);
  const promotedRevenue = companyReleaseSource(selected.revenue?.actual);
  if (companyRow.reportDate !== row.reportDate
    && !(scheduleVerification?.status === 'official_confirmed' && companyRow.reportDate === scheduleVerification.primaryDate)) {
    errors.push(`${label}.earningsApiCompany.reportDate must match row.reportDate.`);
  }
  let expectedSources;
  if (companyReleaseResolution?.status === 'resolved') {
    validateCompanyReleaseAudit(errors, companyReleaseResolution, row, label);
    expectedSources = {
      slate: 'earningsApiCalendar',
      company: audit.finnhubProfile?.name ? 'finnhubProfile' : 'earningsApiCompany',
      marketCap: row.marketCap === null ? 'none' : 'finnhubProfile',
      timing: row.reportTiming === 'unknown' ? 'none' : 'sec_company_release',
      eps: {
        estimate: selected.eps?.estimate || expectedSource(row.eps?.estimate, 'earningsApiCompany'),
        actual: expectedSource(row.eps?.actual, promotedEps ? selected.eps.actual : 'sec_company_release')
      },
      revenue: {
        estimate: selected.revenue?.estimate || expectedSource(row.revenue?.estimate, 'earningsApiCompany'),
        actual: expectedSource(row.revenue?.actual, promotedRevenue ? selected.revenue.actual : 'sec_company_release')
      },
      reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
    };
  } else if (isObject(companyReleaseResolution)) {
    validateCompanyReleaseAudit(errors, companyReleaseResolution, row, label);
    if (companyRow.reportTiming !== row.reportTiming) errors.push(`${label}.earningsApiCompany.reportTiming must match row.reportTiming.`);
    expectedSources = {
      slate: 'earningsApiCalendar',
      company: audit.finnhubProfile?.name ? 'finnhubProfile' : 'earningsApiCompany',
      marketCap: row.marketCap === null ? 'none' : 'finnhubProfile',
      timing: row.reportTiming === 'unknown' ? 'none' : 'earningsApiCompany',
      eps: {
        estimate: expectedSource(row.eps?.estimate, 'earningsApiCompany'),
        actual: promotedEps
          ? selected.eps.actual
          : expectedSource(row.eps?.actual, 'earningsApiCompany')
      },
      revenue: {
        estimate: expectedSource(row.revenue?.estimate, 'earningsApiCompany'),
        actual: promotedRevenue
          ? selected.revenue.actual
          : expectedSource(row.revenue?.actual, 'earningsApiCompany')
      },
      reaction: row.reaction?.status === 'computed' ? 'yahoo' : 'none'
    };
  } else {
    if (companyRow.reportTiming !== row.reportTiming) errors.push(`${label}.earningsApiCompany.reportTiming must match row.reportTiming.`);
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
  validateSelectedSources(errors, selected, expectedSources, label, row, audit);
}

function validateRow(errors, rowRaw, index, range) {
  const row = isObject(rowRaw) ? rowRaw : {};
  const label = row.symbol || `rows[${index}]`;

  if (typeof row.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(row.symbol)) {
    errors.push(`${label}.symbol must be populated and uppercase.`);
  }
  if (typeof row.company !== 'string' || !row.company.trim()) errors.push(`${label}.company must be populated.`);
  if (!nullableNumber(row.marketCap)) errors.push(`${label}.marketCap must be numeric or null.`);
  if (!isIsoDate(row.reportDate)) {
    errors.push(`${label}.reportDate must be an ISO date.`);
  } else if (isObject(range) && isIsoDate(range.from) && isIsoDate(range.to)) {
    if (!displayDatesForRange(range.from, range.to).includes(row.reportDate)) {
      errors.push(`${label}.reportDate must be inside range.`);
    }
  }
  if (!TIMINGS.has(row.reportTiming)) errors.push(`${label}.reportTiming is invalid.`);
  if (!LIFECYCLES.has(row.lifecycle)) errors.push(`${label}.lifecycle is invalid.`);
  if (!nullableNumber(row.fiscalQuarter)) errors.push(`${label}.fiscalQuarter must be numeric or null.`);
  if (!nullableNumber(row.fiscalYear)) errors.push(`${label}.fiscalYear must be numeric or null.`);
  validateMetric(errors, row.eps, `${label}.eps`, { metric: 'eps', requireBasis: true });
  validateMetric(errors, row.revenue, `${label}.revenue`, { metric: 'revenue' });
  if (!isObject(row.outcome)) {
    errors.push(`${label}.outcome must be an object.`);
  } else {
    if (!OUTCOMES.has(row.outcome.overall)) errors.push(`${label}.outcome.overall is invalid.`);
    if (typeof row.outcome.guide !== 'string') errors.push(`${label}.outcome.guide must be a string.`);
    if (typeof row.outcome.interpretation !== 'string') errors.push(`${label}.outcome.interpretation must be a string.`);
  }
  if (!SOURCE_STATUSES.has(row.sourceStatus)) errors.push(`${label}.sourceStatus is invalid.`);
  if (row.scheduleVerificationStatus !== undefined && typeof row.scheduleVerificationStatus !== 'string') {
    errors.push(`${label}.scheduleVerificationStatus must be a string.`);
  }
  if (row.companyReleaseStatus !== undefined && typeof row.companyReleaseStatus !== 'string') {
    errors.push(`${label}.companyReleaseStatus must be a string.`);
  }
  validateReaction(errors, row, label);
  // Source audit is part of the deterministic contract. This proves structured
  // provenance for the row, not that the remote source is still reachable.
  const audit = isObject(row.sourceAudit) ? row.sourceAudit : null;
  const selected = audit?.selectedSources;
  if (!audit) {
    errors.push(`${label}.sourceAudit must be populated.`);
  } else if (!isObject(selected)) {
    errors.push(`${label}.sourceAudit.selectedSources must be populated.`);
  } else if (selected.slate === 'finnhub') {
    validateFinnhubRowSourceAudit(errors, row, audit, selected, label);
  } else if (selected.slate === 'earningsApiCalendar') {
    validateEarningsApiRowSourceAudit(errors, row, audit, selected, label);
  } else {
    errors.push(`${label}.sourceAudit.selectedSources.slate is invalid.`);
  }
}

function validateSummary(errors, data) {
  const counts = data.summary?.counts;
  if (!isObject(data.summary)) {
    errors.push('summary must be an object.');
    return;
  }
  if (!isObject(counts)) {
    errors.push('summary.counts must be an object.');
    return;
  }
  if (Object.prototype.hasOwnProperty.call(data.summary.fetches || {}, 'nasdaqCalendar')) {
    errors.push('summary.fetches.nasdaqCalendar is not part of the canonical Earnings source contract.');
  }
}

function validateAvailability(errors, data) {
  if (data.availability === undefined) return;
  if (!isObject(data.availability)) {
    errors.push('availability must be an object.');
    return;
  }
  const { status } = data.availability;
  if (!['carried_forward', 'unavailable'].includes(status)) errors.push('availability.status is invalid.');
}

function validateCompanyReleaseApply(errors, data, options = {}) {
  const tasks = Array.isArray(data.companyReleaseTasks) ? data.companyReleaseTasks : [];
  if (tasks.length === 0) return;
  if (!isObject(data.companyReleaseApply)) {
    if (options.required) errors.push('companyReleaseApply must be populated when companyReleaseTasks exist.');
    return;
  }
  const apply = data.companyReleaseApply;
  for (const field of Object.keys(apply)) {
    if (!COMPANY_RELEASE_APPLY_FIELDS.has(field)) errors.push(`companyReleaseApply.${field} is not part of the canonical apply contract.`);
  }
  if (!isIsoDateTime(apply.generatedAt)) errors.push('companyReleaseApply.generatedAt must be an ISO timestamp.');
  if (typeof apply.resolutionArtifact !== 'string' || !/earnings_company_release_resolutions\.json$/.test(apply.resolutionArtifact)) {
    errors.push('companyReleaseApply.resolutionArtifact must identify earnings_company_release_resolutions.json.');
  }
  if (!Array.isArray(apply.applied)) errors.push('companyReleaseApply.applied must be an array.');
  if (!Array.isArray(apply.dispositions)) errors.push('companyReleaseApply.dispositions must be an array.');
  const applied = Array.isArray(apply.applied) ? apply.applied : [];
  const dispositions = Array.isArray(apply.dispositions) ? apply.dispositions : [];
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
  const dispositionByTaskId = new Map();
  for (const item of dispositions) {
    if (!isObject(item)) {
      errors.push('companyReleaseApply.dispositions entries must be objects.');
      continue;
    }
    if (typeof item.taskId !== 'string' || !item.taskId.trim()) errors.push('companyReleaseApply.dispositions.taskId must be populated.');
    if (typeof item.symbol !== 'string' || !/^[A-Z0-9.-]+$/.test(item.symbol)) errors.push('companyReleaseApply.dispositions.symbol must be uppercase.');
    if (!RELEASE_RESOLUTION_STATUSES.has(item.status)) errors.push(`${item.taskId || 'companyReleaseApply.dispositions'}.status is invalid.`);
    if (typeof item.reason !== 'string') errors.push(`${item.taskId || 'companyReleaseApply.dispositions'}.reason must be a string.`);
    if (item.status !== 'resolved' && !String(item.reason || '').trim()) errors.push(`${item.taskId || 'companyReleaseApply.dispositions'}.reason is required for a non-resolved disposition.`);
    if (!taskIds.has(item.taskId)) errors.push(`${item.taskId || 'companyReleaseApply.dispositions'} must map to companyReleaseTasks.`);
    if (dispositionByTaskId.has(item.taskId)) errors.push(`companyReleaseApply.dispositions contains duplicate ${item.taskId}.`);
    dispositionByTaskId.set(item.taskId, item);
  }
  for (const task of tasks) {
    const disposition = dispositionByTaskId.get(task.id);
    if (!disposition) errors.push(`${task.id} must be present in companyReleaseApply.dispositions.`);
    if (disposition && disposition.symbol !== task.symbol) errors.push(`${task.id} disposition symbol must match companyReleaseTasks.`);
    if (disposition?.status === 'resolved' && !appliedIds.has(task.id)) errors.push(`${task.id} resolved disposition must be present in companyReleaseApply.applied.`);
    if (disposition && disposition.status !== 'resolved' && appliedIds.has(task.id)) errors.push(`${task.id} non-resolved disposition must not be present in companyReleaseApply.applied.`);
    const row = [...rowsByKey.values()].find((item) => item.sourceAudit?.companyReleaseResolution?.taskId === task.id)
      || rowsByKey.get(rowKey(task));
    if (!row) {
      errors.push(`${task.id} must have a canonical row for its recorded disposition.`);
    } else if (row.sourceAudit?.companyReleaseResolution?.taskId !== task.id) {
      errors.push(`${task.id} must be reflected in row.sourceAudit.companyReleaseResolution.`);
    } else if (disposition && row.sourceAudit.companyReleaseResolution.status !== disposition.status) {
      errors.push(`${task.id} row company-release status must match its recorded disposition.`);
    } else if (disposition && disposition.status !== 'resolved' && row.sourceStatus !== 'partial') {
      errors.push(`${task.id} non-resolved disposition must retain a partial canonical row.`);
    }
  }
  for (const taskId of appliedIds) {
    if (dispositionByTaskId.get(taskId)?.status !== 'resolved') errors.push(`${taskId} may be applied only with a resolved disposition.`);
  }
}

function validateEditorialDisposition(errors, disposition, label, allowedStatuses, copy, unavailableStatuses) {
  const text = String(copy || '').trim();
  if (disposition === undefined) return text ? 'verified' : '';
  if (!isObject(disposition)) {
    errors.push(`${label} must be an object.`);
    return '';
  }
  if (!allowedStatuses.has(disposition.status)) {
    errors.push(`${label}.status is invalid.`);
    return '';
  }
  if (disposition.status === 'pending_review') {
    if (text) errors.push(`${label}.status pending_review must not carry editorial copy.`);
    return disposition.status;
  }
  if (disposition.status === 'verified') {
    if (!text) errors.push(`${label}.status verified requires populated editorial copy.`);
    return disposition.status;
  }
  if (disposition.status === 'not_provided') {
    if (text) errors.push(`${label}.status not_provided must not carry guidance text.`);
    if (disposition.evidenceSource !== 'official_company') errors.push(`${label}.evidenceSource must be official_company when guidance was not provided.`);
    if (typeof disposition.evidenceUrl !== 'string' || !/^https:\/\//.test(disposition.evidenceUrl)) {
      errors.push(`${label}.evidenceUrl must identify the official company evidence.`);
    }
    return disposition.status;
  }
  if (unavailableStatuses.has(disposition.status)) {
    if (text) errors.push(`${label}.status ${disposition.status} must not carry unsupported editorial copy.`);
  }
  return disposition.status;
}

function validateNarrativeApply(errors, data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const requiredRows = rows.filter(isRenderableEarningsRow);

  for (const row of requiredRows) {
    const reportedRow = row.outcome?.overall !== 'pending';
    validateEditorialDisposition(
      errors,
      row.outcome?.interpretationDisposition,
      `${row.symbol}.outcome.interpretationDisposition`,
      COMMENTARY_DISPOSITION_STATUSES,
      row.outcome?.interpretation,
      COMMENTARY_UNAVAILABLE_STATUSES
    );
    const guidanceRequired = reportedRow;
    const guide = String(row.outcome?.guide || '').trim();
    const guidanceStatus = guidanceRequired || row.outcome?.guidanceDisposition !== undefined
      ? validateEditorialDisposition(
          errors,
          row.outcome?.guidanceDisposition,
          `${row.symbol}.outcome.guidanceDisposition`,
          GUIDANCE_DISPOSITION_STATUSES,
          guide,
          GUIDANCE_UNAVAILABLE_STATUSES
        )
      : '';
    if (guidanceRequired) {
      if (guidanceStatus === 'verified' && OUTCOME_NO_GUIDANCE_PATTERN.test(guide)) {
        errors.push(`${row.symbol}.outcome.guidanceDisposition must use not_provided with official company evidence for a no-guidance claim.`);
      }
    }
    const note = String(row.reaction?.note || '').trim();
    if (row.reaction?.status === 'computed' || row.reaction?.commentaryDisposition !== undefined) {
      validateEditorialDisposition(
        errors,
        row.reaction?.commentaryDisposition,
        `${row.symbol}.reaction.commentaryDisposition`,
        COMMENTARY_DISPOSITION_STATUSES,
        note,
        COMMENTARY_UNAVAILABLE_STATUSES
      );
    }
  }
}

function validateSecondaryRecoveryCandidates(errors, data) {
  if (!Array.isArray(data.secondaryRecoveryCandidates)) {
    errors.push('secondaryRecoveryCandidates must be an array.');
  }
}

function validateCompanyReleaseTasks(errors, data) {
  if (!Array.isArray(data.companyReleaseTasks)) {
    errors.push('companyReleaseTasks must be an array.');
  }
}

function validateReleaseSidecarMetadata(errors, data, week, options = {}) {
  for (const field of Object.keys(data)) {
    if (!RELEASE_TOP_LEVEL_FIELDS.has(field)) errors.push(`${field} is not a valid top-level company-release sidecar field.`);
  }

  const expectedSourceArtifact = options.sourceArtifact || path.relative(root, options.weekPath || defaultEarningsInput);
  if (data.sourceArtifact !== expectedSourceArtifact) {
    errors.push(`sourceArtifact must be ${expectedSourceArtifact}.`);
  }
  if (!isIsoDateTime(data.sourceGeneratedAt)) {
    errors.push('sourceGeneratedAt must be an ISO timestamp.');
  } else if (data.sourceGeneratedAt !== week.generatedAt) {
    errors.push('sourceGeneratedAt must match the source earnings week generatedAt.');
  }

  if (!isObject(data.sourceRange)) {
    errors.push('sourceRange must be populated.');
  } else {
    if (!isIsoDate(data.sourceRange.from)) errors.push('sourceRange.from must be an ISO date.');
    if (!isIsoDate(data.sourceRange.to)) errors.push('sourceRange.to must be an ISO date.');
    if (isIsoDate(data.sourceRange.from) && isIsoDate(data.sourceRange.to) && compareIsoDate(data.sourceRange.from, data.sourceRange.to) > 0) {
      errors.push('sourceRange.from must be on or before sourceRange.to.');
    }
    if (data.sourceRange.from !== week.range?.from) errors.push('sourceRange.from must match the source earnings week range.from.');
    if (data.sourceRange.to !== week.range?.to) errors.push('sourceRange.to must match the source earnings week range.to.');
  }

  if (typeof data.outputPath !== 'string' || !data.outputPath.trim()) {
    errors.push('outputPath must be populated.');
  }
}

function validateReleaseReaction(errors, item, label, now) {
  const reaction = item.reaction;
  if (!isObject(reaction)) {
    errors.push(`${label}.reaction must be an object.`);
    return;
  }
  if (!REACTION_BASES.has(reaction.basis)) errors.push(`${label}.reaction.basis is invalid.`);
  if (!nullableNumber(reaction.percent)) errors.push(`${label}.reaction.percent must be numeric or null.`);
  if (!REACTION_STATUSES.has(reaction.status)) errors.push(`${label}.reaction.status is invalid.`);
  if (typeof reaction.note !== 'string') errors.push(`${label}.reaction.note must be a string.`);
  if (reaction.status === 'awaiting_close') {
    if (reaction.basis === 'unavailable') errors.push(`${label}.reaction awaiting_close requires a known reaction basis.`);
    if (reaction.percent !== null || reaction.fromDate || reaction.toDate || reaction.fromClose !== null || reaction.toClose !== null) {
      errors.push(`${label}.reaction close fields must remain empty while awaiting_close.`);
    }
    return;
  }
  if (reaction.basis === 'unavailable') {
    if (reaction.percent !== null) errors.push(`${label}.reaction.percent must be null when unavailable.`);
    return;
  }
  for (const field of ['fromDate', 'toDate']) {
    if (!isIsoDate(reaction[field])) errors.push(`${label}.reaction.${field} must be an ISO date.`);
  }
  for (const field of ['fromClose', 'toClose']) {
    if (!isFiniteNumber(reaction[field])) errors.push(`${label}.reaction.${field} must be numeric.`);
  }
  // Apply the same ordering boundary to the persistent resolution sidecar so
  // it cannot bypass the canonical row validator on a later apply step.
  const reportTiming = item.fields?.reportTiming;
  if (reportTiming === 'amc') {
    if (isIsoDate(reaction.fromDate) && compareIsoDate(reaction.fromDate, item.reportDate) < 0) errors.push(`${label}.reaction.fromDate must be on or after reportDate for amc reports.`);
    if (isIsoDate(reaction.fromDate) && isIsoDate(reaction.toDate) && compareIsoDate(reaction.toDate, reaction.fromDate) <= 0) errors.push(`${label}.reaction.toDate must follow fromDate for amc reports.`);
  } else if (reportTiming === 'bmo' || reportTiming === 'dmh') {
    if (isIsoDate(reaction.fromDate) && compareIsoDate(reaction.fromDate, item.reportDate) >= 0) errors.push(`${label}.reaction.fromDate must precede reportDate for ${reportTiming} reports.`);
    if (isIsoDate(reaction.toDate) && compareIsoDate(reaction.toDate, item.reportDate) < 0) errors.push(`${label}.reaction.toDate must be on or after reportDate for ${reportTiming} reports.`);
  }
  if (!earningsCloseAvailable({ date: reaction.toDate }, now)) {
    errors.push(`${label}.reaction cannot be computed before the required closing response is available.`);
  }
  const expectedPct = pctChange(reaction.fromClose, reaction.toClose);
  if (expectedPct !== null && !nearlyEqual(reaction.percent, expectedPct, PCT_TOLERANCE)) {
    errors.push(`${label}.reaction.percent must match fromClose/toClose.`);
  }
}

function validateReleaseResolution(errors, itemRaw, taskMap, index, now) {
  const item = isObject(itemRaw) ? itemRaw : {};
  const label = item.symbol || `companyReleaseResolutions[${index}]`;
  const task = taskMap.get(item.taskId);
  if (!task) errors.push(`${label}.taskId must map to companyReleaseTasks.`);
  if (task && item.symbol !== task.symbol) errors.push(`${label}.symbol must match company-release task.`);
  if (task && item.reportDate !== task.reportDate && task.trigger !== 'provider_date_conflict_requires_company_release') {
    errors.push(`${label}.reportDate must match company-release task.`);
  }
  if (!RELEASE_RESOLUTION_STATUSES.has(item.status)) errors.push(`${label}.status is invalid.`);
  if (!RELEASE_RESOLUTION_CONFIDENCES.has(item.confidence)) errors.push(`${label}.confidence is invalid.`);
  if (!isObject(item.fields)) {
    errors.push(`${label}.fields must be an object.`);
    return;
  }
  if (!TIMINGS.has(item.fields.reportTiming)) errors.push(`${label}.fields.reportTiming is invalid.`);
  if (!isObject(item.fields.eps)) errors.push(`${label}.fields.eps must be populated.`);
  if (!isObject(item.fields.revenue)) errors.push(`${label}.fields.revenue must be populated.`);
  const eps = isObject(item.fields.eps) ? item.fields.eps : {};
  const revenue = isObject(item.fields.revenue) ? item.fields.revenue : {};
  for (const staleField of ['epsActual', 'revenueActual', 'gaapEpsActual', 'epsEstimate', 'epsEstimateSource', 'revenueEstimate', 'revenueEstimateSource']) {
    if (Object.prototype.hasOwnProperty.call(item.fields, staleField)) {
      errors.push(`${label}.fields.${staleField} must not appear; use eps/revenue nested fields.`);
    }
  }
  if (!nullableNumber(eps.actual)) errors.push(`${label}.fields.eps.actual must be numeric or null.`);
  if (!nullableNumber(revenue.actual)) errors.push(`${label}.fields.revenue.actual must be numeric or null.`);
  if (!nullableNumber(eps.gaapActual)) errors.push(`${label}.fields.eps.gaapActual must be numeric or null.`);
  if (!nullableNumber(eps.estimate)) errors.push(`${label}.fields.eps.estimate must be numeric or null.`);
  if (!nullableNumber(revenue.estimate)) errors.push(`${label}.fields.revenue.estimate must be numeric or null.`);
  const estimateSource = task?.trigger === 'provider_date_conflict_requires_company_release' ? 'finnhub' : 'earningsapi_company';
  if (eps.estimate !== null && eps.estimateSource !== estimateSource) {
    errors.push(`${label}.fields.eps.estimateSource must be ${estimateSource} when eps.estimate is populated.`);
  }
  if (eps.estimate === null && eps.estimateSource) {
    errors.push(`${label}.fields.eps.estimateSource must be blank when eps.estimate is null.`);
  }
  if (revenue.estimate !== null && revenue.estimateSource !== estimateSource) {
    errors.push(`${label}.fields.revenue.estimateSource must be ${estimateSource} when revenue.estimate is populated.`);
  }
  validateCompanyReleaseResolutionEvidence(errors, item, label);
  if (eps.comparisonSource === 'unreconciled_earningsapi_company' && eps.estimate !== null) {
    errors.push(`${label}.fields.eps.estimate must not be used while EarningsAPI EPS actual is unreconciled.`);
  }
  if (!Array.isArray(item.notes)) errors.push(`${label}.notes must be an array.`);
  validateReleaseReaction(errors, item, label, now);
}

function validateReleaseSummary(errors, data) {
  const companyReleaseResolutions = Array.isArray(data.companyReleaseResolutions) ? data.companyReleaseResolutions : [];
  const expected = {
    total: companyReleaseResolutions.length,
    resolved: companyReleaseResolutions.filter((item) => item.status === 'resolved').length,
    needsReview: companyReleaseResolutions.filter((item) => item.status === 'needs_review').length,
    unresolved: companyReleaseResolutions.filter((item) => item.status === 'unresolved').length
  };
  if (!isObject(data.summary)) {
    errors.push('summary must be an object.');
    return;
  }
  for (const [field, value] of Object.entries(expected)) {
    if (data.summary[field] !== value) errors.push(`summary.${field} must be ${value}.`);
  }
}

function validateEarningsWeekPayload(data) {
  const errors = [];

  validateRange(errors, data.range);
  validateAvailability(errors, data);

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

  validateNarrativeApply(errors, data);

  return errors;
}

function validateEarningsWeekReleasePayload(data, week, options = {}) {
  const errors = [];
  const taskMap = new Map((Array.isArray(week.companyReleaseTasks) ? week.companyReleaseTasks : []).map((task) => [task.id, task]));
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date(data.generatedAt);

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (!isIsoDateTime(data.generatedAt)) errors.push('generatedAt must be an ISO timestamp.');
  validateReleaseSidecarMetadata(errors, data, week, options);
  if (!Array.isArray(data.companyReleaseResolutions)) {
    errors.push('companyReleaseResolutions must be an array.');
  } else {
    const seen = new Set();
    data.companyReleaseResolutions.forEach((item, index) => {
      if (seen.has(item?.taskId)) errors.push(`${item.taskId} appears more than once.`);
      seen.add(item?.taskId);
      validateReleaseResolution(errors, item, taskMap, index, now);
    });
    for (const task of Array.isArray(week.companyReleaseTasks) ? week.companyReleaseTasks : []) {
      if (!seen.has(task.id)) errors.push(`${task.id} is missing from companyReleaseResolutions.`);
    }
  }
  validateReleaseSummary(errors, data);

  return errors;
}

function runValidation(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === 'release') {
    const week = readJson(args.week);
    if (!Array.isArray(week.companyReleaseTasks)) {
      throw new Error(`Earnings week validation failed for ${args.week}: companyReleaseTasks must be an array.`);
    }
    if (week.companyReleaseTasks.length === 0) {
      console.log(`Company-release validation not applicable: ${args.week} has no active company-release tasks.`);
      return;
    }
    const data = readJson(args.input);
    const errors = validateEarningsWeekReleasePayload(data, week, { weekPath: args.week });

    if (errors.length) {
      throw new Error(`Earnings company-release resolution validation failed for ${args.input}: ${errors.join(' ')}`);
    }

    console.log(`Earnings company-release validation passed for ${args.input}`);
    console.log(`Resolved: ${data.summary.resolved}`);
    console.log(`Needs review: ${data.summary.needsReview}`);
    console.log(`Unresolved: ${data.summary.unresolved}`);
    return;
  }

  const data = readJson(args.input);
  const errors = validateEarningsWeekPayload(data);

  if (errors.length) {
    throw new Error(`Earnings week validation failed for ${args.input}: ${errors.join(' ')}`);
  }

  console.log(`Earnings week validation passed for ${args.input}`);
  console.log(`Rows: ${data.rows.length}`);
  console.log(`Verified: ${data.rows.filter((row) => row.sourceStatus === 'verified').length}`);
  console.log(`Partial: ${data.rows.filter((row) => row.sourceStatus === 'partial').length}`);
}

if (require.main === module) {
  process.stderr.write('earnings_week_validation.js is internal; use: node scripts/earnings_week.js validate [options]\n');
  process.exit(1);
}

module.exports = {
  runValidation,
  validateEarningsWeekPayload,
  validateEarningsWeekReleasePayload
};
