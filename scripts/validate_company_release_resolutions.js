#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DEFAULT_WEEK = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');
const DEFAULT_INPUT = path.resolve(root, 'scripts', 'generated', 'earnings_company_release_resolutions.json');
const STATUSES = new Set(['resolved', 'needs_review', 'unresolved']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);
const TIMINGS = new Set(['bmo', 'amc', 'dmh', 'unknown']);
const REACTION_BASES = new Set(['same_day_close', 'next_session_close', 'during_market_close', 'unavailable']);
const REACTION_STATUSES = new Set(['computed', 'unavailable', 'pending']);
const PCT_TOLERANCE = 0.03;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'generatedAt',
  'sourceArtifact',
  'sourceGeneratedAt',
  'sourceRange',
  'companyReleaseResolutions',
  'summary',
  'outputPath'
]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    week: DEFAULT_WEEK
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--week') {
      args.week = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_WEEK);
      i += 1;
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
  process.stdout.write(`Usage: node scripts/validate_company_release_resolutions.js [options]

Options:
  --input PATH      Company-release resolutions JSON (default: scripts/generated/earnings_company_release_resolutions.json)
  --week PATH       Earnings week JSON with companyReleaseTasks (default: scripts/generated/earnings_week.json)
  --help            Show this help
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

function compareIsoDate(left, right) {
  return String(left).localeCompare(String(right));
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function nullableNumber(value) {
  return value === null || isFiniteNumber(value);
}

function pctChange(from, to) {
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from === 0) return null;
  return (to / from - 1) * 100;
}

function nearlyEqual(left, right, tolerance = PCT_TOLERANCE) {
  return isFiniteNumber(left) && isFiniteNumber(right) && Math.abs(left - right) <= tolerance;
}

function validateSidecarMetadata(errors, data, week, weekPath) {
  for (const field of Object.keys(data)) {
    if (!TOP_LEVEL_FIELDS.has(field)) errors.push(`${field} is not a valid top-level company-release sidecar field.`);
  }

  const expectedSourceArtifact = path.relative(root, weekPath);
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

function validateReaction(errors, item, label) {
  const reaction = item.reaction;
  if (!isObject(reaction)) {
    errors.push(`${label}.reaction must be an object.`);
    return;
  }
  if (!REACTION_BASES.has(reaction.basis)) errors.push(`${label}.reaction.basis is invalid.`);
  if (!nullableNumber(reaction.percent)) errors.push(`${label}.reaction.percent must be numeric or null.`);
  if (!REACTION_STATUSES.has(reaction.status)) errors.push(`${label}.reaction.status is invalid.`);
  if (typeof reaction.note !== 'string') errors.push(`${label}.reaction.note must be a string.`);
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
  const expectedPct = pctChange(reaction.fromClose, reaction.toClose);
  if (expectedPct !== null && !nearlyEqual(reaction.percent, expectedPct)) {
    errors.push(`${label}.reaction.percent must match fromClose/toClose.`);
  }
}

function validateResolution(errors, itemRaw, taskMap, index) {
  const item = isObject(itemRaw) ? itemRaw : {};
  const label = item.symbol || `companyReleaseResolutions[${index}]`;
  const task = taskMap.get(item.taskId);
  if (!task) errors.push(`${label}.taskId must map to companyReleaseTasks.`);
  if (task && item.symbol !== task.symbol) errors.push(`${label}.symbol must match company-release task.`);
  if (task && item.reportDate !== task.reportDate) errors.push(`${label}.reportDate must match company-release task.`);
  if (!STATUSES.has(item.status)) errors.push(`${label}.status is invalid.`);
  if (!CONFIDENCES.has(item.confidence)) errors.push(`${label}.confidence is invalid.`);
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
  if (eps.estimate !== null && eps.estimateSource !== 'earningsapi_company') {
    errors.push(`${label}.fields.eps.estimateSource must be earningsapi_company when eps.estimate is populated.`);
  }
  if (eps.estimate === null && eps.estimateSource) {
    errors.push(`${label}.fields.eps.estimateSource must be blank when eps.estimate is null.`);
  }
  if (revenue.estimate !== null && revenue.estimateSource !== 'earningsapi_company') {
    errors.push(`${label}.fields.revenue.estimateSource must be earningsapi_company when revenue.estimate is populated.`);
  }
  if (item.status === 'resolved') {
    if (item.sourceType !== 'sec_8k_exhibit_99_1') errors.push(`${label}.sourceType must be sec_8k_exhibit_99_1.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(item.sourceUrl)) errors.push(`${label}.sourceUrl must be an SEC URL.`);
    if (!/^https:\/\/www\.sec\.gov\//.test(item.secFilingUrl)) errors.push(`${label}.secFilingUrl must be an SEC URL.`);
    if (!isFiniteNumber(eps.actual)) errors.push(`${label}.fields.eps.actual is required when resolved.`);
    if (!isFiniteNumber(revenue.actual)) errors.push(`${label}.fields.revenue.actual is required when resolved.`);
  }
  if (eps.comparisonSource === 'unreconciled_earningsapi_company' && eps.estimate !== null) {
    errors.push(`${label}.fields.eps.estimate must not be used while EarningsAPI EPS actual is unreconciled.`);
  }
  if (!Array.isArray(item.notes)) errors.push(`${label}.notes must be an array.`);
  validateReaction(errors, item, label);
}

function validateSummary(errors, data) {
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const data = readJson(args.input);
  const week = readJson(args.week);
  const taskMap = new Map((week.companyReleaseTasks || []).map((task) => [task.id, task]));

  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (!isIsoDateTime(data.generatedAt)) errors.push('generatedAt must be an ISO timestamp.');
  validateSidecarMetadata(errors, data, week, args.week);
  if (!Array.isArray(data.companyReleaseResolutions)) {
    errors.push('companyReleaseResolutions must be an array.');
  } else {
    const seen = new Set();
    data.companyReleaseResolutions.forEach((item, index) => {
      if (seen.has(item?.taskId)) errors.push(`${item.taskId} appears more than once.`);
      seen.add(item?.taskId);
      validateResolution(errors, item, taskMap, index);
    });
    for (const task of week.companyReleaseTasks || []) {
      if (!seen.has(task.id)) errors.push(`${task.id} is missing from companyReleaseResolutions.`);
    }
  }
  validateSummary(errors, data);

  if (errors.length) {
    console.error(`Earnings company-release resolution validation failed for ${args.input}:`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(`Earnings company-release validation passed for ${args.input}`);
  console.log(`Resolved: ${data.summary.resolved}`);
  console.log(`Needs review: ${data.summary.needsReview}`);
  console.log(`Unresolved: ${data.summary.unresolved}`);
}

main();
