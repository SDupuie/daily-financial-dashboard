#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  earningsCloseAvailable,
  earningsRowKey: rowKey,
  metricResult,
  validEarningsCommentaryDisposition,
  validEarningsGuidanceDisposition
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
const SECONDARY_CALENDAR_SOURCES = new Set(['alphaVantageCalendar']);
const RELEASE_RESOLUTION_STATUSES = new Set(['resolved', 'needs_review', 'unresolved']);
const RELEASE_RESOLUTION_CONFIDENCES = new Set(['high', 'medium', 'low']);
const COMMENTARY_DISPOSITION_STATUSES = new Set(['verified', 'commentary_unavailable', 'pending_review']);
const GUIDANCE_DISPOSITION_STATUSES = new Set(['verified', 'not_provided', 'unverified', 'pending_review']);
const COMMENTARY_UNAVAILABLE_STATUSES = new Set(['commentary_unavailable']);
const GUIDANCE_UNAVAILABLE_STATUSES = new Set(['unverified']);
const EARNINGS_WEEK_VALIDATION_MODES = new Set(['staged', 'published']);
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
  const offset = argv[0] === 'week' ? 1 : 0;
  const args = {
    mode: 'week',
    input: defaultEarningsInput
  };

  for (let i = offset; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || args.input);
      i += 1;
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

function printHelp(mode = 'week') {
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

function normalizedValidationMode(value) {
  // "published" selects the compact embedded shape for staging/tests; final
  // artifact publication uses validateDashboardRenderSurface instead.
  return EARNINGS_WEEK_VALIDATION_MODES.has(value) ? value : 'staged';
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

function secondaryCalendarAuditSource(value) {
  return SECONDARY_CALENDAR_SOURCES.has(value) ? value : '';
}

function secondaryCalendarAuditForSelected(audit, selectedSource) {
  const source = secondaryCalendarAuditSource(selectedSource);
  return source && isObject(audit?.[source]) ? audit[source] : null;
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
      const secondaryCandidateKeys = candidateKeys.filter((item) => item !== 'finnhub');
      if (!candidateKeys.includes('finnhub') || secondaryCandidateKeys.length !== 1 || !SECONDARY_CALENDAR_SOURCES.has(secondaryCandidateKeys[0])) {
        errors.push(`${label}.providerDateConflict.candidates must contain finnhub and exactly one supported secondary calendar provider.`);
      }
      if (conflictSelectedDate !== calendar.reportDate) errors.push(`${label}.providerDateConflict.selectedDate must match the retained Finnhub calendar date.`);
      if (!conflictFinnhubDates.includes(calendar.reportDate)) errors.push(`${label}.finnhubCalendar.reportDate must match a providerDateConflict Finnhub candidate.`);
    } else if (scheduleVerification?.status === 'official_confirmed') {
      if (calendar.reportDate !== scheduleVerification.primaryDate) errors.push(`${label}.finnhubCalendar.reportDate must match scheduleVerification.primaryDate.`);
    } else if (calendar.reportDate !== row.reportDate) {
      errors.push(`${label}.finnhubCalendar.reportDate must match row.reportDate.`);
    }
    const timingFallbackAudit = secondaryCalendarAuditForSelected(audit, selected.timing);
    if (!conflict && !timingFallbackAudit && calendar.reportTiming !== row.reportTiming) errors.push(`${label}.finnhubCalendar.reportTiming must match row.reportTiming.`);
    if (timingFallbackAudit) {
      if (calendar.reportTiming !== 'unknown') errors.push(`${label}.sourceAudit.selectedSources.timing must use Finnhub unless Finnhub timing is unknown.`);
      if (timingFallbackAudit.reportTiming !== row.reportTiming) errors.push(`${label}.sourceAudit.${selected.timing}.reportTiming must match row.reportTiming when selected.`);
    }
  }
  const profileName = audit.finnhubProfile?.name || '';
  const hasMetricMarketCap = isObject(audit.finnhubMetric) && isFiniteNumber(audit.finnhubMetric.marketCap);
  const selectedCompanyCalendarSource = secondaryCalendarAuditSource(selected.company);
  const selectedCompanyCalendarAudit = secondaryCalendarAuditForSelected(audit, selected.company);
  const hasSecondaryCalendarCompany = Boolean(selectedCompanyCalendarAudit?.company);
  if (selectedCompanyCalendarSource) {
    if (!hasSecondaryCalendarCompany) errors.push(`${label}.sourceAudit.${selected.company}.company must be populated for company-name recovery.`);
    if (row.company !== selectedCompanyCalendarAudit?.company) errors.push(`${label}.company must match the selected secondary calendar company.`);
  }
  if (selected.marketCap === 'finnhubMetric') {
    if (!hasMetricMarketCap) errors.push(`${label}.sourceAudit.finnhubMetric.marketCap must be populated for market-cap recovery.`);
    if (!nearlyEqualNullable(audit.finnhubMetric?.marketCap, row.marketCap)) errors.push(`${label}.marketCap must match Finnhub metric marketCap.`);
  }
  const timingFallbackSource = secondaryCalendarAuditSource(selected.timing);
  // Mirror buildRows source precedence exactly; this keeps identity recovery
  // explicit instead of accepting broad legacy aliases or oldName || newName drift.
  let expectedSources = {
    slate: 'finnhub',
    company: profileName ? 'finnhubProfile' : hasSecondaryCalendarCompany ? selected.company : 'symbol',
    marketCap: isFiniteNumber(audit.finnhubProfile?.marketCap) ? 'finnhubProfile' : hasMetricMarketCap ? 'finnhubMetric' : 'none',
    timing: timingFallbackSource || (row.reportTiming === 'unknown' ? 'none' : 'finnhub'),
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
  const calendarAuditSource = secondaryCalendarAuditSource(selected.slate);
  const calendarAudit = secondaryCalendarAuditForSelected(audit, selected.slate);
  if (!calendarAuditSource) {
    errors.push(`${label}.sourceAudit.selectedSources.slate is invalid.`);
  }
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
  if (!calendarAudit) {
    errors.push(`${label}.sourceAudit.${selected.slate} must be populated for EarningsAPI-recovered rows.`);
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
      slate: calendarAuditSource,
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
      slate: calendarAuditSource,
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
      slate: calendarAuditSource,
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

function validateRow(errors, rowRaw, index, range, options = {}) {
  const validationMode = normalizedValidationMode(options.mode);
  const row = isObject(rowRaw) ? rowRaw : {};
  const label = row.symbol || `rows[${index}]`;

  if (!isObject(rowRaw)) {
    errors.push(`${label} must be an object.`);
  }
  if (validationMode === 'published') {
    for (const field of Object.keys(rowRaw || {})) {
      if (!ROW_FIELDS.has(field)) errors.push(`${label}.${field} is not part of the published Earnings row contract.`);
    }
    for (const field of FORBIDDEN_ROW_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        errors.push(`${label}.${field} must not appear; use eps/revenue/outcome/reaction nested fields.`);
      }
    }
    if (row.sourceAudit !== undefined) {
      errors.push(`${label}.sourceAudit must not be embedded in published dashboard data.`);
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
  if (validationMode === 'staged') {
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
    } else if (SECONDARY_CALENDAR_SOURCES.has(selected.slate)) {
      validateEarningsApiRowSourceAudit(errors, row, audit, selected, label);
    } else {
      errors.push(`${label}.sourceAudit.selectedSources.slate is invalid.`);
    }
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

function validateEditorialDisposition(errors, disposition, label, allowedStatuses, copy, unavailableStatuses, options = {}) {
  const validationMode = normalizedValidationMode(options.mode);
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
    if (validationMode === 'staged') {
      if (disposition.evidenceSource !== 'official_company') errors.push(`${label}.evidenceSource must be official_company when guidance was not provided.`);
      if (typeof disposition.evidenceUrl !== 'string' || !/^https:\/\//.test(disposition.evidenceUrl)) {
        errors.push(`${label}.evidenceUrl must identify the official company evidence.`);
      }
    }
    return disposition.status;
  }
  if (unavailableStatuses.has(disposition.status)) {
    if (text) errors.push(`${label}.status ${disposition.status} must not carry unsupported editorial copy.`);
    const validUnavailable = disposition.status === 'commentary_unavailable'
      ? validEarningsCommentaryDisposition(disposition, text)
      : validEarningsGuidanceDisposition(disposition, text, { requireNotProvidedEvidence: validationMode === 'staged' });
    if (!validUnavailable) {
      errors.push(`${label}.status ${disposition.status} requires blank copy, non-empty reason, and ISO attemptedAt.`);
    }
  }
  return disposition.status;
}

function validateNarrativeApply(errors, data, options = {}) {
  // This validates copy/disposition pair structure, not whether editorial work
  // is complete. Pending and unavailable states remain valid for later handoffs.
  const validationMode = normalizedValidationMode(options.mode);
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
      COMMENTARY_UNAVAILABLE_STATUSES,
      { mode: validationMode }
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
          GUIDANCE_UNAVAILABLE_STATUSES,
          { mode: validationMode }
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
        COMMENTARY_UNAVAILABLE_STATUSES,
        { mode: validationMode }
      );
    }
  }
}

function validatePublishedInternalQueues(errors, data) {
  for (const field of ['secondaryRecoveryCandidates', 'companyReleaseTasks']) {
    if (data[field] === undefined) continue;
    if (!Array.isArray(data[field])) {
      errors.push(`${field} must be an array when present in published dashboard data.`);
    } else if (data[field].length) {
      errors.push(`${field} must be empty in published dashboard data.`);
    }
  }
  if (data.outputPath !== undefined) {
    errors.push('outputPath must not be embedded in published dashboard data.');
  }
}

function validateCompanyReleaseResolutionReaction(errors, item, label, now) {
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
  // Resolution retry may run before the reaction window closes; computed close
  // fields are accepted only once the canonical close boundary has arrived.
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

function companyReleaseEstimateSource(row, metric) {
  return row?.sourceAudit?.selectedSources?.[metric]?.estimate === 'finnhub'
    ? 'finnhub'
    : 'earningsapi_company';
}

function validateCompanyReleaseResolution(errors, itemRaw, taskMap, rowMap, index, now) {
  const item = isObject(itemRaw) ? itemRaw : {};
  const label = item.symbol || `companyReleaseResolutions[${index}]`;
  const task = taskMap.get(item.taskId);
  if (!task) errors.push(`${label}.taskId must map to companyReleaseTasks.`);
  if (task && item.symbol !== task.symbol) errors.push(`${label}.symbol must match company-release task.`);
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
  const row = rowMap.get(`${task?.reportDate || ''}:${task?.symbol || ''}`);
  const epsEstimateSource = companyReleaseEstimateSource(row, 'eps');
  const revenueEstimateSource = companyReleaseEstimateSource(row, 'revenue');
  if (eps.estimate !== null && eps.estimateSource !== epsEstimateSource) {
    errors.push(`${label}.fields.eps.estimateSource must be ${epsEstimateSource} when eps.estimate is populated.`);
  }
  if (eps.estimate === null && eps.estimateSource) {
    errors.push(`${label}.fields.eps.estimateSource must be blank when eps.estimate is null.`);
  }
  if (revenue.estimate !== null && revenue.estimateSource !== revenueEstimateSource) {
    errors.push(`${label}.fields.revenue.estimateSource must be ${revenueEstimateSource} when revenue.estimate is populated.`);
  }
  validateCompanyReleaseResolutionEvidence(errors, item, label);
  if (String(eps.comparisonSource || '').startsWith('unreconciled_') && eps.estimate !== null) {
    errors.push(`${label}.fields.eps.estimate must not be used while the retained EPS actual is unreconciled.`);
  }
  if (!Array.isArray(item.notes)) errors.push(`${label}.notes must be an array.`);
  validateCompanyReleaseResolutionReaction(errors, item, label, now);
}

function validateEarningsWeekPayload(data, options = {}) {
  const errors = [];
  const validationMode = normalizedValidationMode(options.mode);

  if (!isObject(data)) {
    errors.push('Earnings week payload must be an object.');
    return errors;
  }

  for (const field of Object.keys(data || {})) {
    if (!TOP_LEVEL_FIELDS.has(field)) errors.push(`${field} is not part of the canonical Earnings week contract.`);
  }
  validateRange(errors, data.range);
  validateAvailability(errors, data);
  if (validationMode === 'published') validatePublishedInternalQueues(errors, data);

  if (!Array.isArray(data.rows)) {
    errors.push('rows must be an array.');
  } else {
    const seen = new Set();
    data.rows.forEach((row, index) => {
      const key = `${row?.reportDate || index}:${row?.symbol || index}`;
      if (seen.has(key)) errors.push(`Duplicate earnings row ${key}.`);
      seen.add(key);
      validateRow(errors, row, index, data.range, { mode: validationMode });
    });
  }

  validateNarrativeApply(errors, data, { mode: validationMode });

  return errors;
}

function validateCompanyReleaseResolutionsPayload(data, week, options = {}) {
  const errors = [];
  if (!isObject(data)) {
    errors.push('company-release resolution payload must be an object.');
    return errors;
  }
  // Integrated refresh now validates in-memory retry results, not a persistent
  // sidecar, so artifact metadata is optional and partial task coverage is OK.
  const taskMap = new Map((Array.isArray(week.companyReleaseTasks) ? week.companyReleaseTasks : []).map((task) => [task.id, task]));
  const rowMap = new Map((Array.isArray(week.rows) ? week.rows : []).map((row) => [`${row.reportDate}:${row.symbol}`, row]));
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : isIsoDateTime(data.generatedAt) ? new Date(data.generatedAt) : new Date();

  if (data.schemaVersion !== undefined && data.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (data.generatedAt !== undefined && !isIsoDateTime(data.generatedAt)) errors.push('generatedAt must be an ISO timestamp.');
  if (!Array.isArray(data.companyReleaseResolutions)) {
    errors.push('companyReleaseResolutions must be an array.');
  } else {
    const seen = new Set();
    data.companyReleaseResolutions.forEach((item, index) => {
      if (seen.has(item?.taskId)) errors.push(`${item.taskId} appears more than once.`);
      seen.add(item?.taskId);
      validateCompanyReleaseResolution(errors, item, taskMap, rowMap, index, now);
    });
  }

  return errors;
}

function runValidation(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
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
  validateCompanyReleaseResolutionsPayload
};
