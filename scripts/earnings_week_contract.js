const {
  compareIsoDate,
  isIsoDate,
  isIsoDateTime
} = require('./calendar_contract');

const EARNINGS_WEEK_SCHEMA_VERSION = 2;
const DISPLAY_MIN_MARKET_CAP = 10000000000;
const COMMENTARY_DISPOSITION_STATUSES = new Set(['verified', 'commentary_unavailable', 'pending_review']);
const GUIDANCE_DISPOSITION_STATUSES = new Set(['verified', 'not_provided', 'unverified', 'pending_review']);
const EDITORIAL_UNAVAILABLE_REASON = 'not_verified_for_current_run';
const COMPANY_TOKEN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'co',
  'company',
  'corp',
  'corporation',
  'holdings',
  'inc',
  'incorporated',
  'limited',
  'llc',
  'ltd',
  'of',
  'plc',
  'sa',
  'the'
]);
const NARRATIVE_REUSE_FIELDS = Object.freeze([
  // Reset fields independently: a repeated guidance sentence does not make an
  // otherwise company-specific result interpretation or close reaction stale.
  {
    copy: (row) => row?.outcome?.interpretation,
    disposition: (row) => row?.outcome?.interpretationDisposition,
    reset(row) {
      row.outcome.interpretation = '';
      row.outcome.interpretationDisposition = { status: 'pending_review' };
    }
  },
  {
    copy: (row) => row?.outcome?.guide,
    disposition: (row) => row?.outcome?.guidanceDisposition,
    reset(row) {
      row.outcome.guide = '';
      row.outcome.guidanceDisposition = { status: 'pending_review' };
    }
  },
  {
    copy: (row) => row?.reaction?.note,
    disposition: (row) => row?.reaction?.commentaryDisposition,
    reset(row) {
      row.reaction.note = '';
      row.reaction.commentaryDisposition = { status: 'pending_review' };
    }
  }
]);

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

function objectRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validEarningsCommentaryDisposition(disposition, text) {
  if (disposition === undefined) return true;
  if (!objectRecord(disposition)) return false;
  if (disposition.status === 'verified') return Boolean(String(text || '').trim());
  if (disposition.status !== 'commentary_unavailable') return false;
  return !String(text || '').trim()
    && typeof disposition.reason === 'string'
    && disposition.reason.trim()
    && isIsoDateTime(disposition.attemptedAt);
}

function validEarningsGuidanceDisposition(disposition, text, { requireNotProvidedEvidence = true } = {}) {
  if (disposition === undefined) return true;
  if (!objectRecord(disposition)) return false;
  if (disposition.status === 'verified') return Boolean(String(text || '').trim());
  if (disposition.status === 'not_provided') {
    return !String(text || '').trim()
      && (!requireNotProvidedEvidence || (
        disposition.evidenceSource === 'official_company'
        && /^https:\/\//i.test(String(disposition.evidenceUrl || ''))
      ));
  }
  if (disposition.status === 'unverified') {
    return !String(text || '').trim()
      && typeof disposition.reason === 'string'
      && disposition.reason.trim()
      && isIsoDateTime(disposition.attemptedAt);
  }
  return false;
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
  if (row?.outcome?.overall !== 'pending') {
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
  const unavailable = [
    row.outcome?.interpretationDisposition,
    row.outcome?.guidanceDisposition,
    row.reaction?.commentaryDisposition
  ].some((disposition) => ['commentary_unavailable', 'unverified'].includes(disposition?.status)
    && isIsoDateTime(disposition?.attemptedAt)
    && typeof disposition?.reason === 'string'
    && disposition.reason.trim());
  return copy || verified || unavailable;
}

function narrativeEditorialComplete(row, narrative) {
  if (!isDisplayEligibleEarningsRow(row)) return true;
  const interpretation = String(narrative?.outcome?.interpretation || '').trim();
  const interpretationDisposition = narrative?.outcome?.interpretationDisposition;
  if (!(interpretationDisposition?.status === 'verified' && interpretation)) return false;

  if (row?.outcome?.overall !== 'pending') {
    const guide = String(narrative?.outcome?.guide || '').trim();
    const guidanceDisposition = narrative?.outcome?.guidanceDisposition;
    const guidanceComplete = (guidanceDisposition?.status === 'verified' && guide)
      || guidanceDisposition?.status === 'not_provided';
    if (!guidanceComplete) return false;
  }

  if (row?.lifecycle === 'close_available') {
    const reaction = String(narrative?.reaction?.note || '').trim();
    const reactionDisposition = narrative?.reaction?.commentaryDisposition;
    if (!(reactionDisposition?.status === 'verified' && reaction)) return false;
  }
  return true;
}

function normalizeNarrativeReuseText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\b([a-z0-9]+)'s\b/g, '$1')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.%$ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function earningsNarrativeRowTokens(row) {
  const tokens = new Set();
  for (const value of [row?.symbol, row?.company]) {
    const words = normalizeNarrativeReuseText(value).match(/[a-z0-9]+/g) || [];
    for (const word of words) {
      if (word.length >= 2 && !COMPANY_TOKEN_STOPWORDS.has(word)) tokens.add(word);
    }
  }
  return tokens;
}

function earningsNarrativeCompanyKey(row) {
  const companyTokens = normalizeNarrativeReuseText(row?.company)
    .match(/[a-z0-9]+/g) || [];
  const specific = companyTokens.filter((word) => word.length >= 2 && !COMPANY_TOKEN_STOPWORDS.has(word));
  return specific.length ? specific.join(' ') : String(row?.symbol || '').trim().toUpperCase();
}

function earningsNarrativeEventKey(row) {
  // Share classes may reuse one issuer's commentary only for the same report;
  // report date and fiscal period prevent that exception leaking into later events.
  return [
    earningsNarrativeCompanyKey(row),
    String(row?.reportDate || '').trim(),
    String(row?.fiscalQuarterEnding || '').trim()
  ].join(':');
}

function narrativeReuseSkeletonKey(row, text) {
  // Company tokens and time-sensitive numbers vary legitimately between rows;
  // remove them to expose a shared editorial template without fuzzy matching.
  const rowTokens = earningsNarrativeRowTokens(row);
  const skeleton = normalizeNarrativeReuseText(text)
    .replace(/\b(?:fy|fiscal\s+year)\s*\d{2,4}\b/g, ' ')
    .replace(/\b(?:q[1-4]|[1-4]q)\s*(?:fy)?\s*\d{2,4}\b/g, ' ')
    .replace(/\$?\b\d+(?:[.,]\d+)*(?:%|bn|b|mn|m)?\b/g, ' ')
    .replace(/\b(?:q[1-4]|fy|fiscal|quarter|full-year|fullyear|year|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\b/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !rowTokens.has(word) && !COMPANY_TOKEN_STOPWORDS.has(word))
    .join(' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return skeleton;
}

function earningsNarrativeReuseKeys(row, text) {
  const exact = normalizeNarrativeReuseText(text);
  const keys = [];
  if (exact) keys.push(`exact:${exact}`);
  const skeleton = narrativeReuseSkeletonKey(row, text);
  if (skeleton && skeleton !== exact) keys.push(`skeleton:${skeleton}`);
  return keys;
}

function resetRepeatedEarningsNarrativeForEditorial(week) {
  const output = structuredClone(week || { rows: [] });
  const rows = Array.isArray(output.rows) ? output.rows : [];
  for (const field of NARRATIVE_REUSE_FIELDS) {
    const grouped = new Map();
    for (const [index, row] of rows.entries()) {
      if (!isDisplayEligibleEarningsRow(row)) continue;
      const text = String(field.copy(row) || '').trim();
      if (!text || field.disposition(row)?.status !== 'verified') continue;
      for (const key of earningsNarrativeReuseKeys(row, text)) {
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(index);
      }
    }
    const repeatedIndexes = new Set();
    for (const indexes of grouped.values()) {
      // Clear every affected row: the contract cannot reliably identify which
      // duplicate was original, and published verified copy must be row-specific.
      // Same-issuer rows can cover multiple share classes tied to one earnings report;
      // reuse across different issuers or earnings events is stale editorial state.
      if (new Set(indexes.map((index) => earningsNarrativeEventKey(rows[index]))).size > 1) {
        indexes.forEach((index) => repeatedIndexes.add(index));
      }
    }
    for (const index of repeatedIndexes) field.reset(rows[index]);
  }
  return output;
}

function earningsResultNarrativeFingerprint(row) {
  return JSON.stringify({
    reportDate: row?.reportDate,
    reportTiming: row?.reportTiming,
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
    overall: row?.outcome?.overall
  });
}

function earningsReactionNarrativeFingerprint(row) {
  return JSON.stringify({
    result: JSON.parse(earningsResultNarrativeFingerprint(row)),
    reaction: {
      basis: row?.reaction?.basis,
      status: row?.reaction?.status,
      percent: row?.reaction?.percent,
      fromDate: row?.reaction?.fromDate,
      fromClose: row?.reaction?.fromClose,
      toDate: row?.reaction?.toDate,
      toClose: row?.reaction?.toClose,
      sessionDate: row?.reaction?.sessionDate,
      closeDate: row?.reaction?.closeDate,
      preClose: row?.reaction?.preClose,
      postClose: row?.reaction?.postClose,
      percentChange: row?.reaction?.percentChange
    }
  });
}

function earningsNarrativeFingerprint(row) {
  return earningsReactionNarrativeFingerprint(row);
}

function clearEarningsNarrative(row) {
  const output = structuredClone(row);
  output.eps = { ...output.eps, note: '' };
  output.revenue = { ...output.revenue, note: '' };
  output.outcome = { ...output.outcome, guide: '', interpretation: '' };
  output.reaction = { ...output.reaction, note: '' };
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

function preserveEarningsNarrativeByField(row, prior) {
  const output = structuredClone(row);
  const resultSame = earningsResultNarrativeFingerprint(prior) === earningsResultNarrativeFingerprint(row);
  const reactionSame = earningsReactionNarrativeFingerprint(prior) === earningsReactionNarrativeFingerprint(row);

  output.eps = { ...output.eps, note: resultSame ? String(prior?.eps?.note || '') : '' };
  output.revenue = { ...output.revenue, note: resultSame ? String(prior?.revenue?.note || '') : '' };
  output.outcome = {
    ...output.outcome,
    guide: resultSame ? String(prior?.outcome?.guide || '') : '',
    interpretation: resultSame ? String(prior?.outcome?.interpretation || '') : ''
  };
  for (const field of ['guidanceDisposition', 'interpretationDisposition']) {
    if (resultSame && prior?.outcome?.[field] !== undefined) output.outcome[field] = structuredClone(prior.outcome[field]);
    else if (row.outcome?.[field]?.status === 'pending_review') output.outcome[field] = structuredClone(row.outcome[field]);
    else delete output.outcome[field];
  }

  output.reaction = {
    ...output.reaction,
    note: reactionSame ? String(prior?.reaction?.note || '') : ''
  };
  if (reactionSame && prior?.reaction?.commentaryDisposition !== undefined) {
    output.reaction.commentaryDisposition = structuredClone(prior.reaction.commentaryDisposition);
  } else if (row.reaction?.commentaryDisposition?.status === 'pending_review') {
    output.reaction.commentaryDisposition = structuredClone(row.reaction.commentaryDisposition);
  } else {
    delete output.reaction.commentaryDisposition;
  }

  return output;
}

function mergeUnchangedEarningsNarrative(previousWeek, nextWeek) {
  const previousByKey = new Map((Array.isArray(previousWeek?.rows) ? previousWeek.rows : [])
    .map((row) => [earningsRowKey(row), row]));
  return {
    ...nextWeek,
    rows: (Array.isArray(nextWeek?.rows) ? nextWeek.rows : []).map((row) => {
      const prior = previousByKey.get(earningsRowKey(row));
      if (!prior) return clearEarningsNarrative(row);
      // A scheduled -> awaiting_actual transition has no new company facts, so
      // pre-release commentary can carry while actuals remain missing.
      const sameUnreportedFacts = prior.outcome?.overall === 'pending'
        && row.outcome?.overall === 'pending'
        && earningsResultNarrativeFingerprint({ ...prior, lifecycle: '' }) === earningsResultNarrativeFingerprint({ ...row, lifecycle: '' });
      return sameUnreportedFacts || earningsResultNarrativeFingerprint(prior) === earningsResultNarrativeFingerprint(row)
        ? preserveEarningsNarrativeByField(row, prior)
        : clearEarningsNarrative(row);
    })
  };
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
  const canonical = { ...canonicalWeek };
  delete canonical.policy;
  const sameRange = canonicalWeek?.range?.from === targetRange?.from
    && canonicalWeek?.range?.to === targetRange?.to;
  if (sameRange) {
    // Same-range fallback preserves the visible slate and advances lifecycle;
    // cross-range failure publishes an explicit unavailable week instead.
    const rows = (canonicalWeek.rows || []).map((row) => applyEarningsLifecycle(row, new Date(checkedAt)));
    const secondaryRecoveryCandidates = canonicalWeek.secondaryRecoveryCandidates || [];
    const companyReleaseTasks = canonicalWeek.companyReleaseTasks || [];
    return {
      mode: 'carried_forward',
      week: {
        ...canonical,
        generatedAt: checkedAt,
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
  const scheduleVerificationStatus = row?.scheduleVerificationStatus || row?.sourceAudit?.scheduleVerification?.status;
  const companyReleaseStatus = row?.companyReleaseStatus || row?.sourceAudit?.companyReleaseResolution?.status;
  if (row?.sourceAudit?.resultRefresh?.status === 'partial') return 'partial';
  if (['needs_review', 'unresolved'].includes(companyReleaseStatus)) return 'partial';
  if (!['corroborated', 'official_confirmed'].includes(scheduleVerificationStatus)) return 'partial';
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
    return Number.isFinite(row?.marketCap) && row.marketCap >= DISPLAY_MIN_MARKET_CAP;
  }
  if (row?.country && row.country !== 'US') return false;
  if (/OTC/i.test(row?.exchange || '')) return false;
  if ((row?.sourceAudit?.finnhubProfile?.industry || '').toUpperCase() === 'N/A') return false;
  return Number.isFinite(row?.marketCap) && row.marketCap >= DISPLAY_MIN_MARKET_CAP;
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

function companyReleaseReason(row) {
  if (!row) return '';
  if (row.sourceAudit?.companyReleaseResolution?.status === 'needs_review') return 'company_release_needs_review';
  if (row.reportTiming === 'unknown') return 'missing_report_timing';
  if (!Number.isFinite(row.eps?.actual)) return 'missing_eps_actual';
  if (!Number.isFinite(row.revenue?.actual)) return 'missing_revenue_actual';
  return '';
}

function companyReleaseTask(row, reason) {
  return {
    id: `${row.reportDate}:${row.symbol}:company-release`,
    symbol: row.symbol,
    company: row.company,
    reportDate: row.reportDate,
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
    instructions: 'Use an official company release to resolve missing timing or actuals. Keep the row\'s deterministic estimates for comparison.',
    sourceAudit: row.sourceAudit
  };
}

function buildCompanyReleaseTasks(rows, asOf = new Date()) {
  return rows.flatMap((row) => {
    if (!isDisplayEligibleEarningsRow(row) || !reportWindowArrived(row, asOf)) return [];
    const reason = companyReleaseReason(row);
    return reason ? [companyReleaseTask(row, reason)] : [];
  });
}

module.exports = {
  EARNINGS_WEEK_SCHEMA_VERSION,
  applyEarningsLifecycle,
  attachReactions,
  buildEarningsNarrativeSidecar,
  buildEarningsPreparationFallback,
  buildCompanyReleaseTasks,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  DISPLAY_MIN_MARKET_CAP,
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
  resetRepeatedEarningsNarrativeForEditorial,
  narrativeEditorialAttempted,
  narrativeEditorialComplete,
  emptyEarningsApiUsage,
  hasEarningsApiBudget,
  isDisplayEligibleEarningsRow,
  isEarningsApiUsage,
  migrateEarningsApiUsage,
  metricResult,
  mergeUnchangedEarningsNarrative,
  narrativeNeedsEditorialCopy,
  normalizeFinnhubCalendarFields,
  normalizeEarningsTiming,
  numberOrNull,
  pctChange,
  reactionWindow,
  recordEarningsApiRequest,
  recordEarningsApiResponse,
  reportWindowArrived,
  validEarningsCommentaryDisposition,
  validEarningsGuidanceDisposition,
  valueOutcome
};
