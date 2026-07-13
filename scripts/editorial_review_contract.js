const crypto = require('crypto');

const EDITORIAL_REVIEW_SCHEMA_VERSION = 1;
const REQUIRED_EDITORIAL_SECTIONS = Object.freeze([
  'opening',
  'futures-news',
  'tape-commentary',
  'stories',
  'crypto',
  'earnings',
  'market-lens'
]);
const SUPERLATIVE_PATTERN = /\b(?:record(?:\s+(?:closes?|highs?|lows?|sales?))?|all[- ]time|fresh highs?|new highs?)\b/gi;

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
  if (!requireEmbedded && (typeof manifest.baseEditionId !== 'string' || !manifest.baseEditionId)) {
    errors.push('editorial review baseEditionId must identify the edition being reviewed.');
  }
  if (expectedBaseEditionId && manifest.baseEditionId !== expectedBaseEditionId) {
    errors.push('editorial review baseEditionId must match the dashboard edition being reviewed; regenerate the manifest after every payload rewrite.');
  }
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  const duplicates = sections.filter((section, index) => sections.indexOf(section) !== index);
  const unknown = sections.filter((section) => !REQUIRED_EDITORIAL_SECTIONS.includes(section));
  const missing = REQUIRED_EDITORIAL_SECTIONS.filter((section) => !sections.includes(section));
  if (duplicates.length) errors.push(`editorial review sections contain duplicates: ${[...new Set(duplicates)].join(', ')}.`);
  if (unknown.length) errors.push(`editorial review sections contain unknown values: ${[...new Set(unknown)].join(', ')}.`);
  if (missing.length) errors.push(`editorial review must cover every required section; missing ${missing.join(', ')}.`);

  const decisions = Array.isArray(manifest.marketLensDecisions) ? manifest.marketLensDecisions : null;
  if (!decisions) errors.push('editorial review marketLensDecisions must be an array.');

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
    } else if (data && ![...String(claim?.text || '').matchAll(SUPERLATIVE_PATTERN)].length) {
      errors.push(`editorial review verifiedClaims[${index}] does not contain a gated superlative.`);
    }
  }
  if (data) {
    for (const claim of superlativeClaims(data)) {
      const verified = verifiedClaims.some((item) => item?.text === claim.text && /^https:\/\//i.test(String(item?.evidenceUrl || '')));
      if (!verified) errors.push(`${claim.path} contains unverified superlative claim "${claim.phrase}".`);
    }
  }

  if (requireEmbedded) {
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
      } else if (!['replace', 'retain-generated'].includes(decision.action)) {
        errors.push(`editorial review decision for ${day.date} must use replace or retain-generated.`);
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
    sections: [...manifest.sections].sort(),
    marketLensDecisions: manifest.marketLensDecisions.map(({ date, action }) => ({ date, action })),
    verifiedClaims: (manifest.verifiedClaims || []).map(({ text, evidenceUrl }) => ({ text, evidenceUrl })),
    payloadHash: ''
  };
  data.editorialReview = review;
  review.payloadHash = editorialPayloadHash(data, chartData);
  return review;
}

module.exports = {
  EDITORIAL_REVIEW_SCHEMA_VERSION,
  REQUIRED_EDITORIAL_SECTIONS,
  buildEditorialReview,
  editorialPayloadHash,
  editorialTextEntries,
  stableJson,
  superlativeClaims,
  validateReviewManifest
};
