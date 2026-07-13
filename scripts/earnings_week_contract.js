const {
  compareIsoDate,
  isIsoDate
} = require('./calendar_contract');

const EARNINGS_WEEK_SCHEMA_VERSION = 2;
const COMMENTARY_DISPOSITION_STATUSES = new Set(['verified', 'commentary_unavailable']);
const GUIDANCE_DISPOSITION_STATUSES = new Set(['verified', 'not_provided', 'unverified']);
const EDITORIAL_UNAVAILABLE_REASON = 'not_verified_for_current_run';

function defaultEditorialDisposition(status, attemptedAt) {
  return {
    status,
    reason: EDITORIAL_UNAVAILABLE_REASON,
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
  const responseAvailable = row?.lifecycle === 'close_available' || row?.reaction?.status === 'unavailable';
  const guidanceRequired = responseAvailable && row?.outcome?.overall !== 'pending';
  const reactionRequired = row?.lifecycle === 'close_available';
  const interpretationDisposition = suppliedDisposition(
    narrative?.outcome?.interpretationDisposition,
    COMMENTARY_DISPOSITION_STATUSES
  ) || (interpretation
    ? { status: 'verified' }
    : defaultEditorialDisposition('commentary_unavailable', attemptedAt));
  const guidanceDisposition = suppliedDisposition(
    narrative?.outcome?.guidanceDisposition,
    GUIDANCE_DISPOSITION_STATUSES
  ) || (guide
    ? { status: 'verified' }
    : guidanceRequired ? defaultEditorialDisposition('unverified', attemptedAt) : null);
  const reactionDisposition = suppliedDisposition(
    narrative?.reaction?.commentaryDisposition,
    COMMENTARY_DISPOSITION_STATUSES
  ) || (reactionNote
    ? { status: 'verified' }
    : reactionRequired ? defaultEditorialDisposition('commentary_unavailable', attemptedAt) : null);
  const retryDisposition = (disposition) => attemptedAt && ['commentary_unavailable', 'unverified'].includes(disposition?.status)
    ? { ...disposition, attemptedAt }
    : disposition;
  return {
    interpretation: retryDisposition(interpretationDisposition),
    guidance: retryDisposition(guidanceDisposition),
    reaction: retryDisposition(reactionDisposition)
  };
}

function narrativeNeedsEditorialCopy(row, narrative) {
  if (!isDisplayEligibleEarningsRow(row)) return false;
  const dispositions = earningsNarrativeDispositions(row, narrative);
  if (dispositions.interpretation?.status !== 'verified' || !String(narrative?.outcome?.interpretation || '').trim()) return true;
  const responseAvailable = row?.lifecycle === 'close_available' || row?.reaction?.status === 'unavailable';
  if (responseAvailable && row?.outcome?.overall !== 'pending') {
    const guidanceComplete = dispositions.guidance?.status === 'not_provided'
      || (dispositions.guidance?.status === 'verified' && String(narrative?.outcome?.guide || '').trim());
    if (!guidanceComplete) return true;
  }
  return row?.lifecycle === 'close_available'
    && (dispositions.reaction?.status !== 'verified' || !String(narrative?.reaction?.note || '').trim());
}

function canonicalNarrativeIsEmpty(row) {
  return [
    row?.eps?.note,
    row?.revenue?.note,
    row?.outcome?.guide,
    row?.outcome?.interpretation,
    row?.reaction?.note
  ].every((value) => !String(value || '').trim());
}

function narrativeEditorialAttempted(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.editorialAttempted === true) return true;
  const copy = [
    row.outcome?.interpretation,
    row.outcome?.guide,
    row.reaction?.note
  ].some((value) => String(value || '').trim());
  const verified = [
    row.outcome?.interpretationDisposition?.status,
    row.outcome?.guidanceDisposition?.status,
    row.reaction?.commentaryDisposition?.status
  ].some((status) => status === 'verified');
  return copy || verified;
}

function buildEarningsNarrativeSidecar(week, existing = { rows: [] }, { outputPath = 'generated/earnings_narrative.json' } = {}) {
  const existingByKey = new Map(
    (Array.isArray(existing.rows) ? existing.rows : []).map((row) => [earningsRowKey(row), row])
  );
  const rows = (Array.isArray(week.rows) ? week.rows : [])
    // Keep prior editorial rows and stage any newly display-eligible row for human enrichment.
    .filter((row) => existingByKey.has(earningsRowKey(row)) || isDisplayEligibleEarningsRow(row))
    .map((row) => {
      const existingPrior = existingByKey.get(earningsRowKey(row));
      const prior = existingPrior || {
        eps: { note: row.eps?.note || '' },
        revenue: { note: row.revenue?.note || '' },
        outcome: {
          guide: row.outcome?.guide || '',
          interpretation: row.outcome?.interpretation || '',
          ...(row.outcome?.guidanceDisposition ? { guidanceDisposition: row.outcome.guidanceDisposition } : {}),
          ...(row.outcome?.interpretationDisposition ? { interpretationDisposition: row.outcome.interpretationDisposition } : {})
        },
        reaction: {
          note: row.reaction?.note || '',
          ...(row.reaction?.commentaryDisposition ? { commentaryDisposition: row.reaction.commentaryDisposition } : {})
        }
      };
      // The earnings refresh command clears all narrative fields whenever deterministic
      // report facts change. Do not let this sidecar restore that pre-report copy.
      // The marker survives the first failed run so the editor's replacement copy
      // can be accepted on the rerun without being cleared a second time.
      const sidecarRefreshPending = prior.postReportRefreshRequired === true;
      const stalePriorCopy = Boolean(existingPrior)
        && canonicalNarrativeIsEmpty(row)
        && !sidecarRefreshPending;
      const nextNarrative = stalePriorCopy ? {} : prior;
      const dispositions = earningsNarrativeDispositions(row, nextNarrative, week.generatedAt);
      const missingEditorialCopy = narrativeNeedsEditorialCopy(row, nextNarrative);
      const editorialAttempted = narrativeEditorialAttempted({
        ...nextNarrative,
        editorialAttempted: existingPrior?.editorialAttempted
      });
      const postReportRefreshRequired = missingEditorialCopy
        && (sidecarRefreshPending || stalePriorCopy || !existingPrior);
      return {
        symbol: row.symbol,
        reportDate: row.reportDate,
        eps: {
          note: String(nextNarrative.eps?.note || '')
        },
        revenue: {
          note: String(nextNarrative.revenue?.note || '')
        },
        outcome: {
          guide: String(nextNarrative.outcome?.guide || ''),
          ...(dispositions.guidance ? { guidanceDisposition: dispositions.guidance } : {}),
          // Numeric beat/miss fields are displayed separately. Keep only the
          // editorial thesis and release-backed forward guidance here.
          interpretation: String(nextNarrative.outcome?.interpretation || ''),
          interpretationDisposition: dispositions.interpretation
        },
        reaction: {
          // The calculated percentage already appears in the monitor. Keep only
          // editorial commentary that explains the reaction's likely driver.
          note: String(nextNarrative.reaction?.note || ''),
          ...(dispositions.reaction ? { commentaryDisposition: dispositions.reaction } : {})
        },
        editorialAttempted,
        ...(postReportRefreshRequired ? { postReportRefreshRequired: true } : {})
      };
    });
  const rowsByKey = new Map(rows.map((row) => [earningsRowKey(row), row]));
  const missingRows = (Array.isArray(week.rows) ? week.rows : [])
    .filter((row) => narrativeNeedsEditorialCopy(row, rowsByKey.get(earningsRowKey(row))))
    .map((row) => ({ symbol: row.symbol, reportDate: row.reportDate }));
  return {
    payload: {
      schemaVersion: 1,
      sourceArtifact: 'generated/earnings_week.json',
      sourceGeneratedAt: week.generatedAt,
      sourceRange: week.range,
      rows,
      outputPath
    },
    missingRows
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
  const sameRange = canonicalWeek?.range?.from === targetRange?.from
    && canonicalWeek?.range?.to === targetRange?.to;
  if (sameRange) {
    const rows = (canonicalWeek.rows || []).map((row) => applyEarningsLifecycle(row, new Date(checkedAt)));
    const secondaryRecoveryCandidates = canonicalWeek.secondaryRecoveryCandidates || [];
    const companyReleaseTasks = canonicalWeek.companyReleaseTasks || [];
    return {
      mode: 'carried_forward',
      week: {
        ...canonicalWeek,
        policy: buildEarningsWeekPolicy(),
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
      policy: buildEarningsWeekPolicy(),
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

function buildEarningsWeekPolicy() {
  return {
    baseSlate: 'Finnhub earnings calendar by date range',
    enrichment: 'A semantically valid Finnhub calendar response is accepted regardless of row count; Finnhub company profiles supply identity and market capitalization; EarningsAPI uses the surrounding corroboration range while discovery remains limited to the five displayed dates; event-scoped official company IR evidence may confirm, move, or exclude an event, while unresolved rows retain degraded provenance; Finnhub metric plus EarningsAPI calendar support identity-only recovery when Finnhub profile is empty; EarningsAPI company endpoint covers display-scale rows missing from Finnhub',
    reaction: 'Yahoo Finance Chart API close-to-close policy',
    sourceHierarchy: [
      'Finnhub primary for every valid calendar row returned by an HTTP-, JSON-, and schema-valid response; row count is diagnostic only.',
      'Finnhub metric endpoint may recover market capitalization when Finnhub profile is empty for a Finnhub-present row.',
      'EarningsAPI secondary corroborates display-eligible Finnhub dates within the active five-day slate and supplies display-scale events missing from Finnhub. After that attempt, current-event official IR evidence may confirm, move, or exclude an event. Without official resolution, retain Finnhub rows as primary-only and admit EarningsAPI-only rows as secondary-only only when the calendar and company endpoints match; both remain partial and under nonblocking review.',
      'SEC/company release resolution for actual revenue, EPS context, fiscal period, report timing, and source verification. Every task records a resolved, needs-review, or unresolved disposition; needs-review independently promotes each official actual it can verify while retaining provider data for the other metric, and all non-resolved dispositions remain partial and nonblocking.',
      'Yahoo Finance Chart API for close-to-close market reaction.'
    ],
    fieldPrimaries: {
      slate: 'Finnhub earnings calendar after active-week date corroboration, explicit primary-only secondary-outage fallback, or official company IR confirmation',
      company: 'Finnhub company profile name, falling back to EarningsAPI calendar company name for profile-empty Finnhub rows, then ticker symbol',
      marketCap: 'Finnhub company profile marketCapitalization converted from millions to dollars, falling back to Finnhub stock metric marketCapitalization for profile-empty Finnhub rows',
      timing: 'Finnhub earnings calendar hour',
      eps: {
        estimate: 'Finnhub earnings calendar EPS estimate',
        actual: 'Finnhub earnings calendar EPS actual'
      },
      revenue: {
        estimate: 'Finnhub earnings calendar revenue estimate',
        actual: 'Finnhub earnings calendar revenue actual'
      }
    },
    reactionRules: {
      bmo: 'report-date close vs previous trading-day close',
      amc: 'next trading-day close vs report-date close',
      dmh: 'report-date close vs previous trading-day close',
      unknown: 'unavailable'
    },
    lifecycleRules: {
      scheduled: 'report window has not arrived and no actual is available',
      awaiting_actual: 'report window has arrived but no actual is available',
      released_awaiting_close: 'an actual is available but the required close reaction is not complete',
      close_available: 'an actual and the required close reaction are both available'
    },
    availabilityRules: {
      carriedForward: 'When same-range Earnings preparation fails, retain the last validated embedded week and continue the dashboard update.',
      unavailable: 'When rollover Earnings preparation fails, publish the active five-date range with no rows and an unavailable source warning.'
    },
    resultRefreshRules: 'Collect Finnhub, each EarningsAPI company symbol, and each Yahoo symbol independently. Apply successful fields and reactions; retain prior validated values only for failed rows, record provider-specific partial diagnostics, and retry those rows on later runs.',
    editorialContinuity: 'Preserve pre-event commentary through released_awaiting_close; invalidate it when close_available is first reached or the reaction window is genuinely unavailable.',
    editorialDispositionRules: 'Publish deterministic facts with verified editorial copy when available; otherwise record retryable commentary_unavailable or unverified dispositions. A not_provided guidance disposition requires official company evidence.',
    secondaryRecoveryFieldPolicy: {
      slate: 'EarningsAPI calendar may queue display-scale events missing from Finnhub. For Finnhub-present display rows, a matching date corroborates the row without consulting IR. Event-scoped official company IR evidence can confirm, move, or exclude a reviewed event. Without official resolution, retain a Finnhub conflict or complete-response omission as primary-only with degraded provenance. Admit an EarningsAPI-only event as secondary-only with degraded provenance only when its calendar and company endpoints match; otherwise omit it from canonical rows and retain it in nonblocking review. An official date outside the active week excludes only the matching event from that week.',
      profileRecovery: 'For Finnhub-present rows with empty Finnhub profile, EarningsAPI calendar may supply company name and Finnhub metric may supply market capitalization; EPS/revenue/timing remain Finnhub.',
      eps: 'EarningsAPI company endpoint may supply EPS estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      revenue: 'EarningsAPI company endpoint may supply revenue estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      timing: 'Finnhub calendar for primary rows; EarningsAPI company endpoint for recovered rows; SEC/company release when still missing.',
      reaction: 'Yahoo Finance Chart API.'
    },
    conflictResolution: {
      officialCompanyIr: 'An event-scoped official company investor-relations schedule record resolves conflicts, complete-response omissions, and secondary outages only after the EarningsAPI attempt. A confirmation outside the active five-trading-day range excludes only its matching primary event from that week.'
    }
  };
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
  // Profile-recovered rows have audited company/market-cap sources but no listing fields.
  // Treat only that explicit source combination as display-eligible without country/exchange.
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
  buildEarningsNarrativeSidecar,
  buildEarningsPreparationFallback,
  buildEarningsWeekPolicy,
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
  narrativeEditorialAttempted,
  emptyEarningsApiUsage,
  hasEarningsApiBudget,
  isDisplayEligibleEarningsRow,
  isEarningsApiUsage,
  migrateEarningsApiUsage,
  metricResult,
  narrativeNeedsEditorialCopy,
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
