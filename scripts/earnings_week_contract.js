const {
  compareIsoDate,
  isIsoDate,
  isIsoDateTime
} = require('./calendar_contract');

const EARNINGS_WEEK_SCHEMA_VERSION = 2;
const COMMENTARY_DISPOSITION_STATUSES = new Set(['verified', 'dropped_after_review']);
const GUIDANCE_DISPOSITION_STATUSES = new Set(['verified', 'not_provided', 'dropped_after_review']);
const EDITORIAL_DROPPED_REASON = 'bounded_editorial_review_exhausted';

function defaultEditorialDisposition(status, attemptedAt) {
  return {
    status,
    reason: EDITORIAL_DROPPED_REASON,
    attemptedAt
  };
}

function suppliedDisposition(value, allowedStatuses) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return allowedStatuses.has(value.status) ? { ...value } : value;
}

function earningsNarrativeDispositions(row, narrative, attemptedAt = '') {
  const interpretation = String(narrative?.outcome?.interpretation || '').trim();
  const guide = String(narrative?.outcome?.guide || '').trim();
  const reactionNote = String(narrative?.reaction?.note || '').trim();
  const guidanceRequired = row?.outcome?.overall !== 'pending';
  const reactionRequired = row?.lifecycle === 'close_available';
  const interpretationDisposition = suppliedDisposition(
    narrative?.outcome?.interpretationDisposition,
    COMMENTARY_DISPOSITION_STATUSES
  ) || (interpretation
    ? { status: 'verified' }
    : defaultEditorialDisposition('dropped_after_review', attemptedAt));
  const guidanceDisposition = suppliedDisposition(
    narrative?.outcome?.guidanceDisposition,
    GUIDANCE_DISPOSITION_STATUSES
  ) || (guide
    ? { status: 'verified' }
    : guidanceRequired ? defaultEditorialDisposition('dropped_after_review', attemptedAt) : null);
  const reactionDisposition = suppliedDisposition(
    narrative?.reaction?.commentaryDisposition,
    COMMENTARY_DISPOSITION_STATUSES
  ) || (reactionNote
    ? { status: 'verified' }
    : reactionRequired ? defaultEditorialDisposition('dropped_after_review', attemptedAt) : null);
  const retryDisposition = (disposition) => attemptedAt && disposition?.status === 'dropped_after_review'
    ? { ...disposition, attemptedAt }
    : disposition;
  return {
    interpretation: retryDisposition(interpretationDisposition),
    guidance: retryDisposition(guidanceDisposition),
    reaction: retryDisposition(reactionDisposition)
  };
}

function narrativeEditorialComplete(row, narrative) {
  if (!isDisplayEligibleEarningsRow(row)) return true;
  const interpretation = String(narrative?.outcome?.interpretation || '').trim();
  const interpretationDisposition = narrative?.outcome?.interpretationDisposition;
  const interpretationComplete = (interpretationDisposition?.status === 'verified' && interpretation)
    || (interpretationDisposition?.status === 'dropped_after_review' && !interpretation);
  if (!interpretationComplete) return false;

  if (row?.outcome?.overall !== 'pending') {
    const guide = String(narrative?.outcome?.guide || '').trim();
    const guidanceDisposition = narrative?.outcome?.guidanceDisposition;
    const guidanceComplete = (guidanceDisposition?.status === 'verified' && guide)
      || guidanceDisposition?.status === 'not_provided'
      || (guidanceDisposition?.status === 'dropped_after_review' && !guide);
    if (!guidanceComplete) return false;
  }

  if (row?.lifecycle === 'close_available') {
    const reaction = String(narrative?.reaction?.note || '').trim();
    const reactionDisposition = narrative?.reaction?.commentaryDisposition;
    const reactionComplete = (reactionDisposition?.status === 'verified' && reaction)
      || (reactionDisposition?.status === 'dropped_after_review' && !reaction);
    if (!reactionComplete) return false;
  }
  return true;
}

function earningsNarrativeFingerprint(row) {
  return JSON.stringify({
    reportDate: row?.reportDate,
    reportTiming: row?.reportTiming,
    lifecycle: row?.lifecycle,
    eps: {
      estimate: row?.eps?.estimate,
      actual: row?.eps?.actual,
      surprisePercent: row?.eps?.surprisePercent,
      result: row?.eps?.result,
      basis: row?.eps?.basis
    },
    revenue: {
      estimate: row?.revenue?.estimate,
      actual: row?.revenue?.actual,
      surprisePercent: row?.revenue?.surprisePercent,
      result: row?.revenue?.result
    },
    overall: row?.outcome?.overall,
    reaction: {
      status: row?.reaction?.status,
      sessionDate: row?.reaction?.sessionDate,
      closeDate: row?.reaction?.closeDate,
      preClose: row?.reaction?.preClose,
      postClose: row?.reaction?.postClose,
      percentChange: row?.reaction?.percentChange
    }
  });
}

function preserveEarningsNarrative(row, prior) {
  const output = structuredClone(row);
  output.eps = { ...output.eps, note: String(prior?.eps?.note || '') };
  output.revenue = { ...output.revenue, note: String(prior?.revenue?.note || '') };
  output.outcome = {
    ...output.outcome,
    guide: String(prior?.outcome?.guide || ''),
    interpretation: String(prior?.outcome?.interpretation || '')
  };
  output.reaction = { ...output.reaction, note: String(prior?.reaction?.note || '') };
  for (const field of ['guidanceDisposition', 'interpretationDisposition']) {
    if (prior?.outcome?.[field] !== undefined) output.outcome[field] = structuredClone(prior.outcome[field]);
    else delete output.outcome[field];
  }
  if (prior?.reaction?.commentaryDisposition !== undefined) {
    output.reaction.commentaryDisposition = structuredClone(prior.reaction.commentaryDisposition);
  } else {
    delete output.reaction.commentaryDisposition;
  }
  return output;
}

function clearEarningsNarrative(row) {
  const output = structuredClone(row);
  output.eps = { ...output.eps, note: '' };
  output.revenue = { ...output.revenue, note: '' };
  output.outcome = { ...output.outcome, guide: '', interpretation: '' };
  output.reaction = { ...output.reaction, note: '' };
  delete output.outcome.guidanceDisposition;
  delete output.outcome.interpretationDisposition;
  delete output.reaction.commentaryDisposition;
  return output;
}

function prepareDeterministicEarningsWeek(previousWeek, nextWeek) {
  const previousByKey = new Map((Array.isArray(previousWeek?.rows) ? previousWeek.rows : [])
    .map((row) => [earningsRowKey(row), row]));
  return {
    ...nextWeek,
    rows: (Array.isArray(nextWeek?.rows) ? nextWeek.rows : []).map((row) => {
      const prior = previousByKey.get(earningsRowKey(row));
      if (!prior) return clearEarningsNarrative(row);
      const sameUnreportedFacts = prior.outcome?.overall === 'pending'
        && row.outcome?.overall === 'pending'
        && earningsNarrativeFingerprint({ ...prior, lifecycle: '' }) === earningsNarrativeFingerprint({ ...row, lifecycle: '' });
      return earningsNarrativeFingerprint(prior) === earningsNarrativeFingerprint(row) || sameUnreportedFacts
        ? preserveEarningsNarrative(row, prior)
        : clearEarningsNarrative(row);
    })
  };
}

function earningsCalendarRangeNeedsBuild(range, existingRange) {
  if (!range) return false;
  return existingRange?.from !== range.from || existingRange?.to !== range.to;
}

function earningsScheduleReviewRows(review, week) {
  if (review?.range?.from !== week?.range?.from || review?.range?.to !== week?.range?.to) return [];
  return Array.isArray(review?.rows) ? review.rows : [];
}

function buildEarningsPreparationFallback(canonicalWeek, targetRange, options = {}) {
  const checkedAt = new Date(options.checkedAt || Date.now()).toISOString();
  const canonical = { ...canonicalWeek };
  delete canonical.policy;
  const sameRange = canonicalWeek?.range?.from === targetRange?.from
    && canonicalWeek?.range?.to === targetRange?.to;
  if (sameRange) {
    const rows = (canonicalWeek.rows || []).map((row) => applyEarningsLifecycle(row, new Date(checkedAt)));
    const secondaryRecoveryCandidates = canonicalWeek.secondaryRecoveryCandidates || [];
    const companyReleaseTasks = canonicalWeek.companyReleaseTasks || [];
    return {
      mode: 'carried_forward',
      week: {
        ...canonical,
        availability: {
          status: 'carried_forward',
          reason: 'earnings_preparation_failed',
          checkedAt
        },
        rows,
        summary: {
          ...(canonicalWeek.summary || {}),
          counts: computeEarningsWeekCounts(rows, secondaryRecoveryCandidates, companyReleaseTasks)
        }
      }
    };
  }
  return {
    mode: 'unavailable',
    week: {
      schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
      generatedAt: checkedAt,
      range: {
        from: targetRange.from,
        to: targetRange.to
      },
      availability: {
        status: 'unavailable',
        reason: 'earnings_preparation_failed',
        checkedAt
      },
      rows: [],
      secondaryRecoveryCandidates: [],
      companyReleaseTasks: [],
      summary: {
        counts: computeEarningsWeekCounts([])
      }
    }
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pctChange(from, to) {
  const left = numberOrNull(from);
  const right = numberOrNull(to);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0) return null;
  return (right / left - 1) * 100;
}

function valueOutcome(actual, estimate) {
  if (!Number.isFinite(actual) || !Number.isFinite(estimate)) return 'unknown';
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'met';
}

function metricDisplayKey(value, metric) {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (metric === 'eps') return `${sign}${absolute.toFixed(2)}`;
  if (metric !== 'revenue') return '';
  if (absolute >= 1000000000) return `${sign}${(absolute / 1000000000).toFixed(2)}B`;
  if (absolute >= 1000000) return `${sign}${(absolute / 1000000).toFixed(1)}M`;
  return `${sign}${absolute.toFixed(0)}`;
}

function metricResult(actual, estimate, metric = '') {
  if (!Number.isFinite(actual)) return 'pending';
  if (!Number.isFinite(estimate)) return 'not_compared';
  const actualDisplay = metricDisplayKey(actual, metric);
  if (actualDisplay && actualDisplay === metricDisplayKey(estimate, metric)) return 'met';
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
  if (comparable.every((item) => item === 'met')) return 'met';
  if (comparable.every((item) => item === 'beat' || item === 'met')) return 'beat';
  if (comparable.every((item) => item === 'miss' || item === 'met')) return 'miss';
  return 'mixed';
}

function normalizeEarningsTiming(value) {
  const raw = String(value || '').trim().toLowerCase();
  return ['bmo', 'amc', 'dmh'].includes(raw) ? raw : 'unknown';
}

function earningsReactionBasis(reportTiming) {
  if (reportTiming === 'bmo') return 'same_day_close';
  if (reportTiming === 'amc') return 'next_session_close';
  if (reportTiming === 'dmh') return 'during_market_close';
  return 'unavailable';
}

function earningsRowKey(row) {
  return `${row?.reportDate || ''}:${row?.symbol || ''}`;
}

function easternClock(asOf = new Date()) {
  const instant = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(instant).reduce((map, part) => {
    map[part.type] = part.value;
    return map;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute)
  };
}

function reportWindowArrived(row, asOf = new Date()) {
  const clock = easternClock(asOf);
  if (!clock || !isIsoDate(row?.reportDate) || compareIsoDate(row.reportDate, clock.date) > 0) return false;
  if (compareIsoDate(row.reportDate, clock.date) < 0) return true;
  if (row.reportTiming === 'bmo') return clock.minutes >= 8 * 60;
  if (row.reportTiming === 'dmh') return clock.minutes >= 9 * 60 + 30;
  if (row.reportTiming === 'amc') return clock.minutes >= 16 * 60;
  return false;
}

function earningsRowLifecycle(row, asOf = new Date()) {
  const hasActual = Number.isFinite(row?.eps?.actual) || Number.isFinite(row?.revenue?.actual);
  if (hasActual) return row?.reaction?.status === 'computed' ? 'close_available' : 'released_awaiting_close';
  return reportWindowArrived(row, asOf) ? 'awaiting_actual' : 'scheduled';
}

function earningsCloseAvailable(bar, asOf = new Date()) {
  const clock = easternClock(asOf);
  if (!clock || !isIsoDate(bar?.date)) return false;
  const dateOrder = compareIsoDate(bar.date, clock.date);
  return dateOrder < 0 || (dateOrder === 0 && clock.minutes >= 16 * 60);
}

// These counts are embedded in the canonical earnings-week artifact and must
// stay identical anywhere the payload is generated, refreshed, applied, or
// validated.
function computeEarningsWeekCounts(rows, secondaryRecoveryCandidates = [], companyReleaseTasks = []) {
  return {
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
}

// Initial fetch rows are staged before reaction data exists; final artifacts
// and validators must require the computed reaction to mark a row verified.
function computeEarningsSourceStatus(row, options = {}) {
  const requireComputedReaction = options.requireComputedReaction !== false;
  const scheduleVerificationStatus = row?.sourceAudit?.scheduleVerification?.status;
  if (row?.sourceAudit?.resultRefresh?.status === 'partial') return 'partial';
  if (['needs_review', 'unresolved'].includes(row?.sourceAudit?.companyReleaseResolution?.status)) return 'partial';
  if (isDisplayEligibleEarningsRow(row) && !['corroborated', 'official_confirmed'].includes(scheduleVerificationStatus)) return 'partial';
  if (row?.reportTiming === 'unknown') return 'partial';
  if (!Number.isFinite(row?.eps?.estimate) || !Number.isFinite(row?.eps?.actual)) return 'partial';
  if (!Number.isFinite(row?.revenue?.estimate) || !Number.isFinite(row?.revenue?.actual)) return 'partial';
  if (requireComputedReaction && row?.reaction?.status !== 'computed') return 'partial';
  return 'verified';
}

function applyEarningsLifecycle(row, asOf = new Date()) {
  const output = { ...row };
  const hasActual = Number.isFinite(output.eps?.actual) || Number.isFinite(output.revenue?.actual);
  // Providers can expose a dated daily bar before its session has closed.
  // Treat reaction fields as computed only after that bar's required close.
  const computed = hasActual
    && output.reaction?.status === 'computed'
    && Number.isFinite(output.reaction?.percent)
    && Number.isFinite(output.reaction?.fromClose)
    && Number.isFinite(output.reaction?.toClose)
    && earningsCloseAvailable({ date: output.reaction?.toDate }, asOf);
  const status = computed
    ? 'computed'
    : !hasActual ? 'pending' : output.reportTiming === 'unknown' ? 'unavailable' : 'awaiting_close';
  output.reaction = {
    ...(output.reaction || {}),
    basis: earningsReactionBasis(output.reportTiming),
    percent: computed ? output.reaction.percent : null,
    fromDate: computed ? output.reaction.fromDate : '',
    fromClose: computed ? output.reaction.fromClose : null,
    toDate: computed ? output.reaction.toDate : '',
    toClose: computed ? output.reaction.toClose : null,
    status,
    note: output.reaction?.note || '',
    source: output.reaction?.source || ''
  };
  output.lifecycle = earningsRowLifecycle(output, asOf);
  output.sourceSummary = {
    ...output.sourceSummary,
    reaction: computed ? 'yahoo' : 'none'
  };
  output.sourceAudit = {
    ...output.sourceAudit,
    selectedSources: {
      ...output.sourceAudit?.selectedSources,
      reaction: computed ? 'yahoo' : 'none'
    }
  };
  output.sourceStatus = computeEarningsSourceStatus(output);
  return output;
}

function isDisplayEligibleEarningsRow(row) {
  const hasListingEvidence = Object.prototype.hasOwnProperty.call(row?.sourceAudit || {}, 'finnhubUsListing');
  if (hasListingEvidence) {
    const listing = row?.sourceAudit?.finnhubUsListing;
    if (!listing || listing.market !== 'US' || listing.symbol !== row?.symbol) return false;
    if (!listing.mic || /OTC|PIN[XML]/i.test(listing.mic)) return false;
    if ((row?.sourceAudit?.finnhubProfile?.industry || '').toUpperCase() === 'N/A') return false;
    return Number.isFinite(row?.marketCap) && row.marketCap >= 1000000000;
  }
  // Profile-recovered rows have audited company/market-cap sources but no listing fields.
  // Retain the legacy rule only for schema-v2 rows published before U.S.-listing
  // evidence was embedded. Every newly built row carries finnhubUsListing.
  const hasProfileRecovery = row?.sourceAudit?.selectedSources?.company === 'earningsApiCalendar'
    && row?.sourceAudit?.selectedSources?.marketCap === 'finnhubMetric';
  if (hasProfileRecovery) return Number.isFinite(row?.marketCap) && row.marketCap >= 1000000000;
  if (row?.country && row.country !== 'US') return false;
  if (/OTC/i.test(row?.exchange || '')) return false;
  if ((row?.sourceAudit?.finnhubProfile?.industry || '').toUpperCase() === 'N/A') return false;
  return Number.isFinite(row?.marketCap) && row.marketCap >= 1000000000;
}

const EARNINGS_API_USAGE_SCHEMA_VERSION = 2;
const EARNINGS_API_USAGE_TIME_ZONE = 'America/Chicago';
const EARNINGS_API_REQUEST_HISTORY_LIMIT = 200;

function normalizeFinnhubCalendarFields(row) {
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
    }
  };
}

function emptyEarningsApiUsage() {
  return { schemaVersion: EARNINGS_API_USAGE_SCHEMA_VERSION, days: {} };
}

function isEarningsApiUsage(value) {
  return Boolean(value)
    && value.schemaVersion === EARNINGS_API_USAGE_SCHEMA_VERSION
    && Boolean(value.days)
    && typeof value.days === 'object';
}

function migrateEarningsApiUsage(value) {
  if (isEarningsApiUsage(value)) return value;
  const migrated = emptyEarningsApiUsage();
  if (value?.schemaVersion !== 1 || !value.months || typeof value.months !== 'object') return migrated;
  for (const month of Object.values(value.months)) {
    for (const request of Array.isArray(month?.requests) ? month.requests : []) {
      const timestamp = new Date(request?.at || '');
      if (Number.isNaN(timestamp.getTime())) continue;
      const entry = earningsApiDayEntry(migrated, timestamp);
      entry.calls += 1;
      entry.requests.push({ ...request });
    }
  }
  return migrated;
}

function earningsApiUsageDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EARNINGS_API_USAGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function earningsApiDayEntry(usage, date = new Date()) {
  const day = earningsApiUsageDay(date);
  if (!usage.days[day] || typeof usage.days[day] !== 'object') {
    usage.days[day] = { calls: 0, requests: [] };
  }
  if (!Number.isFinite(usage.days[day].calls) || usage.days[day].calls < 0) {
    usage.days[day].calls = 0;
  }
  if (!Array.isArray(usage.days[day].requests)) usage.days[day].requests = [];
  return usage.days[day];
}

function hasEarningsApiBudget(usage, dailyLimit, reserve, date = new Date()) {
  const entry = earningsApiDayEntry(usage, date);
  return entry.calls < Math.max(0, dailyLimit - reserve);
}

function recordEarningsApiRequest(usage, { at = new Date(), type, path, queryKeys = [] }) {
  const timestamp = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(timestamp.getTime())) throw new Error('EarningsAPI request audit requires a valid timestamp.');
  const entry = earningsApiDayEntry(usage, timestamp);
  entry.calls += 1;
  entry.requests.push({
    at: timestamp.toISOString(),
    type,
    path,
    query: [...queryKeys]
      .filter((key) => key !== 'apikey')
      .sort()
      .join(',')
  });
  if (entry.requests.length > EARNINGS_API_REQUEST_HISTORY_LIMIT) {
    entry.requests = entry.requests.slice(-EARNINGS_API_REQUEST_HISTORY_LIMIT);
  }
  return entry.requests.at(-1);
}

function recordEarningsApiResponse(request, result) {
  if (!request || typeof request !== 'object') return request;
  request.status = Number.isInteger(result?.status) ? result.status : 0;
  request.ok = result?.ok === true;
  const retryAfter = String(result?.headers?.['retry-after'] || '').trim();
  if (retryAfter) request.retryAfter = retryAfter;
  const error = String(result?.error || result?.parseError || '').trim();
  if (error) request.error = error.slice(0, 240);
  return request;
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

function reactionWindow(bars, reportDate, reportTiming) {
  if (reportTiming === 'bmo' || reportTiming === 'dmh') {
    return {
      basis: earningsReactionBasis(reportTiming),
      fromBar: previousBar(bars, reportDate),
      toBar: barOnOrAfter(bars, reportDate)
    };
  }
  if (reportTiming === 'amc') {
    return {
      basis: earningsReactionBasis(reportTiming),
      fromBar: barOnOrAfter(bars, reportDate),
      toBar: barAfter(bars, reportDate)
    };
  }
  return { basis: 'unavailable', fromBar: null, toBar: null };
}

function attachReactions(rows, yahooFetches, { asOf = new Date() } = {}) {
  const yahooBySymbol = new Map(yahooFetches.map((item) => [item.symbol, item]));
  return rows.map((row) => {
    const yahoo = yahooBySymbol.get(row.symbol);
    const bars = yahoo?.bars || [];
    const { basis, fromBar, toBar } = reactionWindow(bars, row.reportDate, row.reportTiming);
    const hasReportedActual = Number.isFinite(row.eps.actual) || Number.isFinite(row.revenue.actual);
    const reactionPct = hasReportedActual && fromBar && toBar && earningsCloseAvailable(toBar, asOf)
      ? pctChange(fromBar.close, toBar.close)
      : null;
    const reactionStatus = reactionPct !== null
      ? 'computed'
      : !hasReportedActual ? 'pending' : row.reportTiming === 'unknown' ? 'unavailable' : 'awaiting_close';
    const computed = reactionStatus === 'computed';
    const output = {
      ...row,
      sourceSummary: {
        ...row.sourceSummary,
        reaction: reactionPct === null ? 'none' : 'yahoo'
      },
      reaction: {
        basis,
        percent: reactionPct,
        fromDate: computed ? fromBar.date : '',
        fromClose: computed ? fromBar.close : null,
        toDate: computed ? toBar.date : '',
        toClose: computed ? toBar.close : null,
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
    output.lifecycle = earningsRowLifecycle(output, asOf);
    return {
      ...output,
      sourceStatus: computeEarningsSourceStatus(output)
    };
  });
}

const DATE_CONFLICT_RELEASE_MIN_MARKET_CAP = 250000000;

function companyReleaseReason(row) {
  // Candidates omitted from the canonical slate stay in schedule review; a
  // post-report release task is meaningful only for an admitted row.
  if (!row) return '';
  if (row.sourceAudit?.companyReleaseResolution?.status === 'needs_review') return 'company_release_needs_review';
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
    instructions: 'Use SEC/company release only to resolve actuals and timing after a verified provider-date conflict or official IR-confirmed redate. Keep Finnhub estimates for comparison.',
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
    const officialSchedule = row.sourceAudit?.scheduleVerification;
    const officiallyRedated = officialSchedule?.status === 'official_confirmed'
      && officialSchedule.primaryDate !== row.reportDate;
    if (!officiallyRedated) return [];
    if (!Number.isFinite(row.marketCap) || row.marketCap < DATE_CONFLICT_RELEASE_MIN_MARKET_CAP) return [];
    if (!options.shouldEscalateDateConflict?.(row)) return [];
    const reason = companyReleaseReason(row);
    return reason ? [companyReleaseTaskFromDateConflict(row, reason)] : [];
  });
  return [...recoveryTasks, ...conflictTasks];
}

module.exports = {
  EARNINGS_WEEK_SCHEMA_VERSION,
  applyEarningsLifecycle,
  attachReactions,
  buildEarningsPreparationFallback,
  buildCompanyReleaseTasks,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsApiDayEntry,
  earningsApiUsageDay,
  earningsCalendarRangeNeedsBuild,
  earningsCloseAvailable,
  earningsRowKey,
  earningsRowLifecycle,
  earningsReactionBasis,
  earningsScheduleReviewRows,
  earningsNarrativeDispositions,
  earningsNarrativeFingerprint,
  narrativeEditorialComplete,
  emptyEarningsApiUsage,
  hasEarningsApiBudget,
  isDisplayEligibleEarningsRow,
  isEarningsApiUsage,
  migrateEarningsApiUsage,
  metricResult,
  prepareDeterministicEarningsWeek,
  normalizeFinnhubCalendarFields,
  normalizeEarningsTiming,
  numberOrNull,
  pctChange,
  reactionWindow,
  recordEarningsApiRequest,
  recordEarningsApiResponse,
  reportWindowArrived,
  valueOutcome
};
