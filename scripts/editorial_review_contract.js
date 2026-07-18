const crypto = require('crypto');

const EDITORIAL_REVIEW_SCHEMA_VERSION = 1;
const EDITORIAL_SECTION_NAMES = Object.freeze([
  'opening',
  'futures-news',
  'tape-commentary',
  'stories',
  'crypto',
  'earnings',
  'market-lens'
]);
const SUPERLATIVE_PATTERN = /\b(?:record(?:\s+(?:closes?|highs?|lows?|sales?))?|all[- ]time|fresh highs?|new highs?)\b/gi;
const TAPE_COMMENTARY_UNAVAILABLE_NOTE = '';

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function editorialPayloadHash(data, chartData) {
  // Hash the JSON representation that is actually embedded; object-only
  // properties with undefined values do not survive serialization.
  const dashboardData = JSON.parse(JSON.stringify(data));
  delete dashboardData.editorialReview;
  const embeddedChartData = JSON.parse(JSON.stringify(chartData));
  return crypto.createHash('sha256').update(stableJson({ dashboardData, chartData: embeddedChartData })).digest('hex');
}

function unavailableTapeCommentary(row, quoteRevision) {
  if (!isIsoTimestamp(quoteRevision)) throw new Error('Tape commentary quoteRevision must be an offset-bearing ISO timestamp.');
  return {
    ...row,
    note: TAPE_COMMENTARY_UNAVAILABLE_NOTE,
    noteDisposition: {
      status: 'commentary_unavailable',
      quoteRevision
    }
  };
}

function reviewedTapeCommentary(row, note, quoteRevision, reviewedAt) {
  if (!isIsoTimestamp(quoteRevision)) throw new Error('Tape commentary quoteRevision must be an offset-bearing ISO timestamp.');
  if (!isIsoTimestamp(reviewedAt)) throw new Error('Tape commentary reviewedAt must be an offset-bearing ISO timestamp.');
  return {
    ...row,
    note: String(note || '').trim(),
    noteDisposition: {
      status: 'reviewed',
      quoteRevision,
      reviewedAt
    }
  };
}

function validateTapeCommentaryDisposition(row) {
  const errors = [];
  const disposition = row?.noteDisposition;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
    return ['noteDisposition must bind commentary to the accepted quote revision.'];
  }
  if (!isIsoTimestamp(disposition.quoteRevision)) {
    errors.push('noteDisposition.quoteRevision must be an offset-bearing ISO timestamp.');
  }
  if (disposition.status === 'reviewed') {
    if (!isIsoTimestamp(disposition.reviewedAt)) {
      errors.push('reviewed Tape commentary must include an offset-bearing reviewedAt timestamp.');
    }
    if (!String(row?.note || '').trim()) {
      errors.push('reviewed Tape commentary must include commentary text.');
    }
    if (Object.prototype.hasOwnProperty.call(disposition, 'attemptedAt') || Object.prototype.hasOwnProperty.call(disposition, 'reason')) {
      errors.push('reviewed Tape commentary cannot retain unavailable-disposition fields.');
    }
  } else if (disposition.status === 'commentary_unavailable') {
    if (String(row?.note || '').trim()) {
      errors.push('unavailable Tape commentary must leave note blank.');
    }
    if (Object.prototype.hasOwnProperty.call(disposition, 'reviewedAt')) {
      errors.push('unavailable Tape commentary cannot retain reviewedAt.');
    }
  } else {
    errors.push('noteDisposition.status must be reviewed or commentary_unavailable.');
  }
  return errors;
}

function editorialTextEntries(data) {
  const entries = [];
  const add = (path, value) => {
    if (typeof value === 'string' && value.trim()) entries.push({ path, text: value.trim() });
  };
  add('opening.headline', data?.opening?.headline);
  add('opening.deck', data?.opening?.deck);
  (data?.opening?.catalysts || []).forEach((item, index) => add(`opening.catalysts[${index}].body`, item?.body));
  add('tape.label', data?.tape?.label);
  (data?.tape?.rows || []).forEach((item, index) => add(`tape.rows[${index}].note`, item?.note));
  (data?.futuresModule?.stories || []).forEach((item, index) => {
    add(`futuresModule.stories[${index}].title`, item?.title);
    add(`futuresModule.stories[${index}].body`, item?.body);
  });
  (data?.stories || []).forEach((item, index) => {
    add(`stories[${index}].title`, item?.title);
    add(`stories[${index}].body`, item?.body);
  });
  (data?.crypto?.notes || []).forEach((item, index) => {
    add(`crypto.notes[${index}].title`, item?.title);
    add(`crypto.notes[${index}].body`, item?.body);
  });
  (data?.earnings?.week?.rows || []).forEach((item, index) => {
    add(`earnings.week.rows[${index}].outcome.guide`, item?.outcome?.guide);
    add(`earnings.week.rows[${index}].outcome.interpretation`, item?.outcome?.interpretation);
    add(`earnings.week.rows[${index}].reaction.note`, item?.reaction?.note);
  });
  (data?.weekAhead?.days || []).forEach((day, index) => {
    const lens = day?.marketLens;
    add(`weekAhead.days[${index}].marketLens.question`, lens?.question);
    add(`weekAhead.days[${index}].marketLens.title`, lens?.title);
    add(`weekAhead.days[${index}].marketLens.body`, lens?.body);
    add(`weekAhead.days[${index}].marketLens.setup.statement`, lens?.setup?.statement);
    add(`weekAhead.days[${index}].marketLens.scenarios.reinforces`, lens?.scenarios?.reinforces);
    add(`weekAhead.days[${index}].marketLens.scenarios.challenges`, lens?.scenarios?.challenges);
    add(`weekAhead.days[${index}].outcome.title`, day?.outcome?.title);
    add(`weekAhead.days[${index}].outcome.body`, day?.outcome?.body);
  });
  return entries;
}

function superlativeClaims(data) {
  return editorialTextEntries(data).flatMap(({ path, text }) => {
    const matches = [...text.matchAll(SUPERLATIVE_PATTERN)];
    return matches.map((match) => ({ path, phrase: match[0], text }));
  });
}

function validateReviewManifest(manifest, data, { requireEmbedded = false, expectedBaseEditionId = '', chartData = null } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['editorial review must be an object.'];
  }
  if (manifest.schemaVersion !== EDITORIAL_REVIEW_SCHEMA_VERSION) {
    errors.push(`editorial review schemaVersion must be ${EDITORIAL_REVIEW_SCHEMA_VERSION}.`);
  }
  if (!isIsoTimestamp(manifest.reviewedAt)) {
    errors.push('editorial review reviewedAt must be an offset-bearing ISO timestamp.');
  }
  if (manifest.preparedAt !== undefined && !isIsoTimestamp(manifest.preparedAt)) {
    errors.push('editorial review preparedAt must be an offset-bearing ISO timestamp when present.');
  }
  if (isIsoTimestamp(manifest.preparedAt) && isIsoTimestamp(manifest.reviewedAt)
    && Date.parse(manifest.reviewedAt) < Date.parse(manifest.preparedAt)) {
    errors.push('editorial review reviewedAt cannot precede preparedAt.');
  }
  if (!requireEmbedded && (typeof manifest.baseEditionId !== 'string' || !manifest.baseEditionId)) {
    errors.push('editorial review baseEditionId must identify the edition being reviewed.');
  }
  if (expectedBaseEditionId && manifest.baseEditionId !== expectedBaseEditionId) {
    errors.push('editorial review baseEditionId must match the dashboard edition being reviewed; regenerate the manifest after every payload rewrite.');
  }
  const decisions = Array.isArray(manifest.marketLensDecisions) ? manifest.marketLensDecisions : null;
  if (!decisions) errors.push('editorial review marketLensDecisions must be an array.');

  if (manifest.newsSelection !== undefined) {
    if (!manifest.newsSelection || typeof manifest.newsSelection !== 'object' || Array.isArray(manifest.newsSelection)) {
      errors.push('editorial review newsSelection must be an object when present.');
    } else {
      for (const key of ['futures', 'stories', 'crypto']) {
        if (!Array.isArray(manifest.newsSelection[key])) errors.push(`editorial review newsSelection.${key} must be an array.`);
      }
    }
  }

  const systemFallbacks = manifest.systemFallbacks === undefined
    ? []
    : Array.isArray(manifest.systemFallbacks) ? manifest.systemFallbacks : null;
  if (!systemFallbacks) {
    errors.push('editorial review systemFallbacks must be an array when present.');
  } else {
    const identities = new Set();
    for (const [index, fallback] of systemFallbacks.entries()) {
      if (!EDITORIAL_SECTION_NAMES.includes(fallback?.section)) errors.push(`editorial review systemFallbacks[${index}].section is invalid.`);
      if (typeof fallback?.path !== 'string' || !fallback.path.trim()) errors.push(`editorial review systemFallbacks[${index}].path must be populated.`);
      if (!['retained_candidate', 'omitted', 'generated_default', 'unavailable_disposition'].includes(fallback?.action)) errors.push(`editorial review systemFallbacks[${index}].action is invalid.`);
      if (typeof fallback?.reason !== 'string' || !fallback.reason.trim()) errors.push(`editorial review systemFallbacks[${index}].reason must be populated.`);
      const identity = `${fallback?.section || ''}:${fallback?.path || ''}:${fallback?.action || ''}`;
      if (identities.has(identity)) errors.push(`editorial review systemFallbacks contains duplicate disposition ${identity}.`);
      identities.add(identity);
    }
  }

  const verifiedClaims = Array.isArray(manifest.verifiedClaims) ? manifest.verifiedClaims : [];
  const editorialTexts = new Set(data ? editorialTextEntries(data).map((entry) => entry.text) : []);
  for (const [index, claim] of verifiedClaims.entries()) {
    if (typeof claim?.text !== 'string' || !claim.text.trim()) errors.push(`editorial review verifiedClaims[${index}].text must be populated.`);
    try {
      const url = new URL(claim?.evidenceUrl);
      if (url.protocol !== 'https:') throw new Error('not HTTPS');
    } catch (_error) {
      errors.push(`editorial review verifiedClaims[${index}].evidenceUrl must be an HTTPS URL.`);
    }
    if (data && !editorialTexts.has(claim?.text)) {
      errors.push(`editorial review verifiedClaims[${index}] does not match current editorial text.`);
    }
  }

  // Embedded receipt validation is diagnostic/test-only; readiness does not require receipts.
  if (requireEmbedded) {
    const unavailableFallbacksByPath = new Map(
      (systemFallbacks || [])
        .filter((fallback) => fallback?.section === 'tape-commentary' && fallback?.action === 'unavailable_disposition')
        .map((fallback) => [fallback.path, fallback])
    );
    const unavailableRowsByPath = new Map();
    for (const row of data?.tape?.rows || []) {
      if (row?.noteDisposition?.status !== 'commentary_unavailable') continue;
      const path = `tape.rows.${String(row?.ticker || '').trim().toUpperCase()}.note`;
      unavailableRowsByPath.set(path, row);
    }
    for (const path of unavailableFallbacksByPath.keys()) {
      if (!unavailableRowsByPath.has(path)) errors.push(`editorial review records an unavailable Tape commentary disposition for ${path}, but the row is not commentary_unavailable.`);
    }
    if (typeof manifest.reviewedBaseEditionId !== 'string' || !manifest.reviewedBaseEditionId) {
      errors.push('editorial review reviewedBaseEditionId must identify the edition that was reviewed.');
    } else if (manifest.reviewedBaseEditionId === data?.editionId) {
      errors.push('editorial review reviewedBaseEditionId must precede the published edition.');
    }
    if (manifest.reviewedEditionId !== data?.editionId) errors.push('editorial review reviewedEditionId must match dashboard-data.editionId.');
    if (!/^[a-f0-9]{64}$/.test(String(manifest.payloadHash || ''))) {
      errors.push('editorial review payloadHash must be a SHA-256 digest.');
    } else if (!chartData) {
      errors.push('editorial review payloadHash cannot be verified without embedded chart-data.');
    } else if (manifest.payloadHash !== editorialPayloadHash(data, chartData)) {
      errors.push('editorial review payloadHash does not match the embedded dashboard-data and chart-data payloads.');
    }
    const eventDays = (data?.weekAhead?.days || []).filter((day) => Array.isArray(day?.events) && day.events.length);
    const decisionByDate = new Map((decisions || []).map((decision) => [decision?.date, decision]));
    if (decisionByDate.size !== (decisions || []).length) errors.push('editorial review marketLensDecisions contain duplicate dates.');
    for (const day of eventDays) {
      const decision = decisionByDate.get(day.date);
      if (!decision) {
        errors.push(`editorial review is missing a Market Lens decision for ${day.date}.`);
      } else if (decision.action === 'replace' && day.marketLensSource !== 'editorial') {
        errors.push(`editorial review decision for ${day.date} says replace but the embedded lens is not editorial.`);
      } else if (decision.action === 'retain-generated' && day.marketLensSource !== 'generated') {
        errors.push(`editorial review decision for ${day.date} says retain-generated but the embedded lens is not generated.`);
      } else if (decision.action === 'commentary-unavailable') {
        if (day.marketLensSource !== 'unavailable') errors.push(`editorial review decision for ${day.date} says commentary-unavailable but the embedded lens is not unavailable.`);
        if (!isIsoTimestamp(decision.attemptedAt) || typeof decision.reason !== 'string' || !decision.reason.trim()) {
          errors.push(`editorial review decision for ${day.date} commentary-unavailable must include attemptedAt and reason.`);
        }
      } else if (!['replace', 'retain-generated', 'commentary-unavailable'].includes(decision.action)) {
        errors.push(`editorial review decision for ${day.date} must use replace, retain-generated, or commentary-unavailable.`);
      }
    }
    for (const decision of decisions || []) {
      if (!eventDays.some((day) => day.date === decision?.date)) errors.push(`editorial review contains a stale Market Lens decision for ${decision?.date || '(missing date)'}.`);
    }
  }
  return errors;
}

function buildEditorialReview(data, manifest, chartData) {
  const errors = validateReviewManifest(manifest, data);
  if (isIsoTimestamp(manifest?.reviewedAt) && isIsoTimestamp(data?.editionId) && Date.parse(manifest.reviewedAt) > Date.parse(data.editionId)) {
    errors.push('editorial review reviewedAt cannot be later than the edition created from it.');
  }
  if (!chartData || typeof chartData !== 'object') errors.push('editorial review requires the chart-data payload being reviewed.');
  if (errors.length) throw new Error(errors.join(' '));
  const review = {
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    reviewedAt: manifest.reviewedAt,
    reviewedBaseEditionId: manifest.baseEditionId || null,
    reviewedEditionId: data.editionId,
    marketLensDecisions: manifest.marketLensDecisions.map(({ date, action, attemptedAt, reason }) => ({
      date,
      action,
      ...(action === 'commentary-unavailable' ? { attemptedAt, reason } : {})
    })),
    verifiedClaims: (manifest.verifiedClaims || []).map(({ text, evidenceUrl }) => ({ text, evidenceUrl })),
    ...((manifest.systemFallbacks || []).length ? {
      systemFallbacks: manifest.systemFallbacks.map(({ section, path, action, reason }) => ({ section, path, action, reason }))
    } : {}),
    payloadHash: ''
  };
  data.editorialReview = review;
  review.payloadHash = editorialPayloadHash(data, chartData);
  return review;
}

module.exports = {
  EDITORIAL_REVIEW_SCHEMA_VERSION,
  TAPE_COMMENTARY_UNAVAILABLE_NOTE,
  buildEditorialReview,
  editorialPayloadHash,
  editorialTextEntries,
  reviewedTapeCommentary,
  stableJson,
  superlativeClaims,
  unavailableTapeCommentary,
  validateTapeCommentaryDisposition,
  validateReviewManifest
};
