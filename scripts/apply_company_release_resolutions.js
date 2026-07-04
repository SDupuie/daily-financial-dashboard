#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  combinedOutcome,
  valueOutcome
} = require('./fetch_earnings_week');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');
const DEFAULT_RESOLUTIONS = path.resolve(root, 'scripts', 'generated', 'earnings_company_release_resolutions.json');

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    resolutions: DEFAULT_RESOLUTIONS,
    output: '',
    skipValidation: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--resolutions') {
      args.resolutions = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_RESOLUTIONS);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg === '--skip-validation') {
      args.skipValidation = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!args.output) args.output = args.input;
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/apply_company_release_resolutions.js [options]

Options:
  --input PATH        Earnings week JSON to update (default: scripts/generated/earnings_week.json)
  --resolutions PATH  Company-release resolutions JSON (default: scripts/generated/earnings_company_release_resolutions.json)
  --output PATH       Output earnings week JSON (default: overwrite --input)
  --skip-validation   Do not run validators before/after applying
  --help              Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pctChange(estimate, actual) {
  const left = numberOrNull(estimate);
  const right = numberOrNull(actual);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0) return null;
  return (right / left - 1) * 100;
}

function metricPayload(fields, options = {}) {
  const estimate = numberOrNull(fields?.estimate);
  const actual = numberOrNull(fields?.actual);
  return {
    estimate,
    actual,
    surprisePercent: pctChange(estimate, actual),
    result: Number.isFinite(actual) && Number.isFinite(estimate)
      ? valueOutcome(actual, estimate)
      : Number.isFinite(actual) ? 'not_compared' : 'pending',
    ...options
  };
}

function sourceFromResolution(value, fallback = 'none') {
  if (!value) return fallback;
  if (value === 'earningsapi_company') return 'earningsApiCompany';
  return value;
}

function reactionSource(reaction) {
  return reaction?.status === 'computed' ? 'yahoo' : 'none';
}

function sourceStatus(row) {
  if (row.reportTiming === 'unknown') return 'partial';
  if (!Number.isFinite(row.eps?.estimate) || !Number.isFinite(row.eps?.actual)) return 'partial';
  if (!Number.isFinite(row.revenue?.estimate) || !Number.isFinite(row.revenue?.actual)) return 'partial';
  if (row.reaction?.status !== 'computed') return 'partial';
  return 'verified';
}

function rowKey(item) {
  return `${item.reportDate}:${item.symbol}`;
}

function rowFromTask(task, resolution) {
  const profile = task.sourceAudit?.finnhubProfile || null;
  // Some company-release tasks are for recovered tickers that are not yet in
  // rows[]. Build the canonical row here so the dashboard still consumes one
  // merged earnings_week artifact instead of a runtime sidecar.
  return {
    symbol: resolution.symbol,
    company: profile?.name || resolution.company || task.company || resolution.symbol,
    exchange: profile?.exchange || '',
    country: profile?.country || '',
    currency: profile?.currency || '',
    marketCap: Number.isFinite(profile?.marketCap) ? profile.marketCap : task.marketCap ?? null,
    marketCapDisplay: task.marketCapDisplay || '',
    reportDate: resolution.reportDate,
    reportTiming: resolution.fields.reportTiming,
    fiscalQuarterEnding: task.fiscalQuarterEnding || '',
    fiscalQuarter: null,
    fiscalYear: null,
    eps: null,
    revenue: null,
    outcome: null,
    reaction: null,
    sourceStatus: 'partial',
    sourceSummary: {
      primary: 'sec_company_release',
      fallbacks: ['earningsApiCompany', 'finnhubProfile'].filter((item) => item !== 'finnhubProfile' || profile),
      reaction: 'none'
    },
    sourceAudit: {
      finnhubCalendar: { present: false },
      finnhubProfile: profile,
      earningsApiCalendar: task.sourceAudit?.earningsApiCalendar || null,
      earningsApiCompany: task.sourceAudit?.earningsApiCompany || null,
      selectedSources: {
        slate: 'earningsApiCalendar',
        company: profile?.name ? 'finnhubProfile' : 'earningsApiCompany',
        marketCap: Number.isFinite(profile?.marketCap) ? 'finnhubProfile' : 'none',
        timing: 'none',
        eps: { estimate: 'none', actual: 'none' },
        revenue: { estimate: 'none', actual: 'none' },
        reaction: 'none'
      },
      yahoo: {}
    }
  };
}

function applyResolution(row, task, resolution) {
  const epsFields = resolution.fields?.eps || {};
  const revenueFields = resolution.fields?.revenue || {};
  const reaction = resolution.reaction || {
    basis: 'unavailable',
    percent: null,
    fromDate: '',
    fromClose: null,
    toDate: '',
    toClose: null,
    status: 'unavailable',
    note: '',
    source: ''
  };
  const eps = metricPayload(epsFields, {
    basis: epsFields.basis || '',
    note: epsFields.adjustment?.note || ''
  });
  const revenue = metricPayload(revenueFields, {
    note: ''
  });
  // Company releases can confirm official actuals and timing, but estimates
  // may only carry forward from the vetted EarningsAPI company row.
  const selectedSources = {
    ...row.sourceAudit.selectedSources,
    timing: resolution.fields.reportTiming === 'unknown' ? 'none' : 'sec_company_release',
    eps: {
      estimate: sourceFromResolution(epsFields.estimateSource, Number.isFinite(eps.estimate) ? 'earningsApiCompany' : 'none'),
      actual: Number.isFinite(eps.actual) ? (epsFields.actualSource || 'sec_company_release') : 'none'
    },
    revenue: {
      estimate: sourceFromResolution(revenueFields.estimateSource, Number.isFinite(revenue.estimate) ? 'earningsApiCompany' : 'none'),
      actual: Number.isFinite(revenue.actual) ? 'sec_company_release' : 'none'
    },
    reaction: reactionSource(reaction)
  };

  const updated = {
    ...row,
    company: row.company || resolution.company || task.company,
    reportTiming: resolution.fields.reportTiming,
    eps,
    revenue,
    outcome: {
      overall: combinedOutcome(eps.result, revenue.result),
      guide: '',
      interpretation: ''
    },
    reaction,
    sourceSummary: {
      primary: 'sec_company_release',
      fallbacks: ['earningsApiCompany', 'finnhubProfile'].filter((item) => item !== 'finnhubProfile' || row.sourceAudit?.finnhubProfile),
      reaction: reactionSource(reaction)
    },
    sourceAudit: {
      ...row.sourceAudit,
      companyReleaseResolution: resolution,
      selectedSources,
      yahoo: reaction.sourceAudit || row.sourceAudit?.yahoo || {}
    }
  };
  updated.sourceStatus = sourceStatus(updated);
  return updated;
}

function updateSummary(source) {
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const secondaryRecoveryCandidates = Array.isArray(source.secondaryRecoveryCandidates) ? source.secondaryRecoveryCandidates : [];
  const companyReleaseTasks = Array.isArray(source.companyReleaseTasks) ? source.companyReleaseTasks : [];
  source.summary = {
    ...(source.summary || {}),
    counts: {
      ...(source.summary?.counts || {}),
      total: rows.length,
      verified: rows.filter((row) => row.sourceStatus === 'verified').length,
      partial: rows.filter((row) => row.sourceStatus === 'partial').length,
      reactionComputed: rows.filter((row) => row.reaction?.status === 'computed').length,
      missingTiming: rows.filter((row) => row.reportTiming === 'unknown').length,
      missingRevenue: rows.filter((row) => row.revenue?.estimate === null && row.revenue?.actual === null).length,
      missingMarketCap: rows.filter((row) => row.marketCap === null).length,
      secondaryRecoveryCandidates: secondaryRecoveryCandidates.length,
      companyReleaseTasks: companyReleaseTasks.length
    }
  };
}

function applyCompanyReleaseResolutions(source, resolutionPayload) {
  const output = JSON.parse(JSON.stringify(source));
  const taskMap = new Map((output.companyReleaseTasks || []).map((task) => [task.id, task]));
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];
  const skipped = [];

  // A skipped resolution remains visible in companyReleaseApply so validation
  // can reject dashboard promotion when official-resolution work is unfinished.
  for (const resolution of resolutionPayload.companyReleaseResolutions || []) {
    if (resolution.status !== 'resolved') {
      skipped.push({ taskId: resolution.taskId, reason: resolution.status || 'not_resolved' });
      continue;
    }
    const task = taskMap.get(resolution.taskId);
    if (!task) throw new Error(`${resolution.taskId} does not map to companyReleaseTasks.`);
    if (task.symbol !== resolution.symbol) throw new Error(`${resolution.taskId} symbol does not match resolution.`);
    if (task.reportDate !== resolution.reportDate) throw new Error(`${resolution.taskId} reportDate does not match resolution.`);

    const key = rowKey(resolution);
    const existing = rowsByKey.get(key);
    const baseRow = existing?.row || rowFromTask(task, resolution);
    const updated = applyResolution(baseRow, task, resolution);
    if (existing) {
      output.rows[existing.index] = updated;
    } else {
      output.rows.push(updated);
      rowsByKey.set(key, { row: updated, index: output.rows.length - 1 });
    }
    applied.push({ taskId: resolution.taskId, symbol: resolution.symbol });
  }

  output.rows.sort((left, right) => {
    const dateCompare = left.reportDate.localeCompare(right.reportDate);
    if (dateCompare) return dateCompare;
    return left.symbol.localeCompare(right.symbol);
  });
  output.companyReleaseApply = {
    generatedAt: new Date().toISOString(),
    resolutionArtifact: resolutionPayload.outputPath || '',
    applied,
    skipped
  };
  updateSummary(output);
  return output;
}

function validateWeek(file) {
  execFileSync(process.execPath, [
    path.resolve(root, 'scripts', 'validate_earnings_week.js'),
    '--input',
    file
  ], { stdio: 'inherit' });
}

function validateResolutions(args) {
  execFileSync(process.execPath, [
    path.resolve(root, 'scripts', 'validate_company_release_resolutions.js'),
    '--input',
    args.resolutions,
    '--week',
    args.input
  ], { stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skipValidation) {
    validateWeek(args.input);
    validateResolutions(args);
  }
  const source = readJson(args.input);
  const resolutions = readJson(args.resolutions);
  const output = applyCompanyReleaseResolutions(source, resolutions);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
  if (!args.skipValidation) validateWeek(args.output);
  process.stdout.write(`Applied ${output.companyReleaseApply.applied.length} company-release resolution(s) to ${args.output}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  applyCompanyReleaseResolutions
};
