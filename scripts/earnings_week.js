#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  computeEarningsSourceStatus,
  computeEarningsWeekCounts
} = require('./earnings_week_contract');
const {
  combinedOutcome,
  valueOutcome
} = require('./earnings_week_build');
const { validateEarningsWeekPayload } = require('./validate_earnings_week');

const root = path.resolve(__dirname, '..');
const DEFAULT_EARNINGS_WEEK = path.resolve(root, 'generated', 'earnings_week.json');
const DEFAULT_RESOLUTIONS = path.resolve(root, 'generated', 'earnings_company_release_resolutions.json');
const DEFAULT_NARRATIVE = path.resolve(root, 'generated', 'earnings_narrative.json');
const DEFAULT_DASHBOARD = path.resolve(root, 'daily_financial_news.html');

function stampDashboardEdition(data) {
  return {
    ...data,
    editionId: new Date().toISOString()
  };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/earnings_week.js <command> [options]

Commands:
  build             Build generated/earnings_week.json
  refresh           Refresh arrived earnings rows in the existing week artifact
  resolve           Resolve company-release tasks into the resolution sidecar
  apply-release     Apply company-release resolutions to the week artifact
  apply-narrative   Apply earnings narrative sidecar to the week artifact
  embed             Embed the validated week artifact into daily_financial_news.html
  validate          Validate the earnings week artifact
  validate-release  Validate company-release resolution sidecar

Run with any command's original options after the command name.
Examples:
  node scripts/earnings_week.js build --from 2026-07-06 --to 2026-07-10
  node scripts/earnings_week.js refresh
  node scripts/earnings_week.js apply-narrative
  node scripts/earnings_week.js embed
`);
}

function runScript(script, argv) {
  const result = spawnSync(process.execPath, [path.resolve(root, 'scripts', script), ...argv], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseApplyReleaseArgs(argv) {
  const args = {
    input: DEFAULT_EARNINGS_WEEK,
    resolutions: DEFAULT_RESOLUTIONS,
    output: '',
    skipValidation: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
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
      process.stdout.write(`Usage: node scripts/earnings_week.js apply-release [options]

Options:
  --input PATH        Earnings week JSON to update (default: generated/earnings_week.json)
  --resolutions PATH  Company-release resolutions JSON (default: generated/earnings_company_release_resolutions.json)
  --output PATH       Output earnings week JSON (default: overwrite --input)
  --skip-validation   Do not run validators before/after applying
`);
      process.exit(0);
    }
  }
  if (!args.output) args.output = args.input;
  return args;
}

function parseApplyNarrativeArgs(argv) {
  const args = {
    input: DEFAULT_EARNINGS_WEEK,
    narrative: DEFAULT_NARRATIVE,
    output: '',
    skipValidation: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
      i += 1;
      continue;
    }
    if (arg === '--narrative') {
      args.narrative = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_NARRATIVE);
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
      process.stdout.write(`Usage: node scripts/earnings_week.js apply-narrative [options]

Options:
  --input PATH       Earnings week JSON to update (default: generated/earnings_week.json)
  --narrative PATH   Canonical narrative JSON (default: generated/earnings_narrative.json)
  --output PATH      Output earnings week JSON (default: overwrite --input)
  --skip-validation  Do not run validate after applying
`);
      process.exit(0);
    }
  }
  if (!args.output) args.output = args.input;
  return args;
}

function parseEmbedArgs(argv) {
  const args = {
    dashboard: DEFAULT_DASHBOARD,
    earningsWeek: DEFAULT_EARNINGS_WEEK
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dashboard') {
      args.dashboard = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_DASHBOARD);
      i += 1;
      continue;
    }
    if (arg === '--earnings-week' || arg === '--input') {
      args.earningsWeek = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/earnings_week.js embed [options]

Options:
  --dashboard PATH      Dashboard HTML to update (default: daily_financial_news.html)
  --earnings-week PATH  Canonical earnings week JSON (default: generated/earnings_week.json)
`);
      process.exit(0);
    }
  }
  return args;
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
  if (value === 'finnhub') return 'finnhub';
  return value;
}

function reactionSource(reaction) {
  return reaction?.status === 'computed' ? 'yahoo' : 'none';
}

function rowKey(item) {
  return `${item.reportDate}:${item.symbol}`;
}

function rowFromTask(task, resolution) {
  const profile = task.sourceAudit?.finnhubProfile || null;
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
    reportDate: resolution.reportDate,
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
      fallbacks: row.sourceAudit?.selectedSources?.slate === 'finnhub'
        ? ['finnhub', ...(row.sourceAudit?.providerDateConflict ? ['providerDateConflict'] : []), ...(row.sourceAudit?.selectedSources?.marketCap === 'finnhubMetric' ? ['finnhubMetric'] : [])]
        : ['earningsApiCompany', 'finnhubProfile'].filter((item) => item !== 'finnhubProfile' || row.sourceAudit?.finnhubProfile),
      reaction: reactionSource(reaction)
    },
    sourceAudit: {
      ...row.sourceAudit,
      companyReleaseResolution: resolution,
      selectedSources,
      yahoo: reaction.sourceAudit || row.sourceAudit?.yahoo || {}
    }
  };
  updated.sourceStatus = computeEarningsSourceStatus(updated);
  return updated;
}

function updateSummary(source) {
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const secondaryRecoveryCandidates = Array.isArray(source.secondaryRecoveryCandidates) ? source.secondaryRecoveryCandidates : [];
  const companyReleaseTasks = Array.isArray(source.companyReleaseTasks) ? source.companyReleaseTasks : [];
  source.summary = {
    ...(source.summary || {}),
    counts: computeEarningsWeekCounts(rows, secondaryRecoveryCandidates, companyReleaseTasks)
  };
}

function applyCompanyReleaseResolutions(source, resolutionPayload) {
  const output = JSON.parse(JSON.stringify(source));
  const taskMap = new Map((output.companyReleaseTasks || []).map((task) => [task.id, task]));
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];
  const skipped = [];

  for (const resolution of resolutionPayload.companyReleaseResolutions || []) {
    if (resolution.status !== 'resolved') {
      skipped.push({ taskId: resolution.taskId, reason: resolution.status || 'not_resolved' });
      continue;
    }
    const task = taskMap.get(resolution.taskId);
    if (!task) throw new Error(`${resolution.taskId} does not map to companyReleaseTasks.`);
    if (task.symbol !== resolution.symbol) throw new Error(`${resolution.taskId} symbol does not match resolution.`);
    if (task.reportDate !== resolution.reportDate && task.trigger !== 'provider_date_conflict_requires_company_release') {
      throw new Error(`${resolution.taskId} reportDate does not match resolution.`);
    }

    const key = rowKey(resolution);
    const existing = rowsByKey.get(key) || rowsByKey.get(rowKey(task));
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

function sourceRangeMatches(left, right) {
  return left?.from === right?.from && left?.to === right?.to;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function validateNarrativePayload(source, narrativePayload, options = {}) {
  if (!narrativePayload || typeof narrativePayload !== 'object' || Array.isArray(narrativePayload)) {
    throw new Error('Narrative payload must be an object.');
  }
  if (narrativePayload.schemaVersion !== 1) {
    throw new Error('Narrative payload schemaVersion must be 1.');
  }
  if (narrativePayload.sourceArtifact !== options.sourceArtifact) {
    throw new Error(`Narrative payload sourceArtifact must be ${options.sourceArtifact}.`);
  }
  if (narrativePayload.sourceGeneratedAt !== source.generatedAt) {
    throw new Error('Narrative payload sourceGeneratedAt must match the source earnings week generatedAt.');
  }
  if (!sourceRangeMatches(narrativePayload.sourceRange, source.range)) {
    throw new Error('Narrative payload sourceRange must match the source earnings week range.');
  }
  if (!Array.isArray(narrativePayload.rows) || narrativePayload.rows.length === 0) {
    throw new Error('Narrative payload rows must be a non-empty array.');
  }
}

function applyMetricNote(metric, narrativeMetric) {
  if (!narrativeMetric || !Object.prototype.hasOwnProperty.call(narrativeMetric, 'note')) return metric;
  return {
    ...metric,
    note: stringValue(narrativeMetric.note)
  };
}

function applyEarningsNarrative(source, narrativePayload, options = {}) {
  validateNarrativePayload(source, narrativePayload, options);
  const output = JSON.parse(JSON.stringify(source));
  const rowsByKey = new Map((output.rows || []).map((row, index) => [rowKey(row), { row, index }]));
  const applied = [];

  for (const item of narrativePayload.rows || []) {
    const key = rowKey(item);
    const target = rowsByKey.get(key);
    if (!target) throw new Error(`${key} narrative does not match a canonical earnings row.`);
    const row = target.row;
    output.rows[target.index] = {
      ...row,
      eps: applyMetricNote(row.eps, item.eps),
      revenue: applyMetricNote(row.revenue, item.revenue),
      outcome: {
        ...row.outcome,
        guide: stringValue(item.outcome?.guide ?? row.outcome?.guide),
        interpretation: stringValue(item.outcome?.interpretation ?? row.outcome?.interpretation)
      },
      reaction: {
        ...row.reaction,
        note: stringValue(item.reaction?.note ?? row.reaction?.note)
      }
    };
    applied.push({ symbol: item.symbol, reportDate: item.reportDate });
  }

  output.narrativeApply = {
    generatedAt: new Date().toISOString(),
    narrativeArtifact: options.narrativeArtifact || narrativePayload.outputPath || '',
    applied
  };
  return output;
}

function dashboardDataRegion(html) {
  const region = html.match(/<!-- Daily refreshes update this quote\/story payload\. Chart history is embedded separately in chart-data below\. -->[\s\S]*?<!-- ============ DATA END ============ -->/);
  if (!region) throw new Error('Could not find the marked dashboard-data region.');
  const data = region[0].match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!data) throw new Error('Could not find dashboard-data JSON inside the marked region.');
  return { region: region[0], dataJson: data[1] };
}

function embedEarningsWeek(html, earningsWeek) {
  const errors = validateEarningsWeekPayload(earningsWeek, { requireNarrative: true });
  if (errors.length) {
    throw new Error(`Earnings week payload is invalid:\n- ${errors.join('\n- ')}`);
  }

  const { region, dataJson } = dashboardDataRegion(html);
  let dashboardData = JSON.parse(dataJson);
  dashboardData.earnings = {
    label: 'Earnings · Week Monitor',
    week: earningsWeek
  };
  dashboardData = stampDashboardEdition(dashboardData);

  const nextRegion = [
    '<!-- Daily refreshes update this quote/story payload. Chart history is embedded separately in chart-data below. -->',
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
    `<script type="application/json" id="dashboard-data">${JSON.stringify(dashboardData, null, 2)}</script>`,
    '<!-- ============ DATA END ============ -->'
  ].join('\n');

  return html.replace(region, nextRegion);
}

function validateWeek(file, requireNarrative = false) {
  const command = [
    path.resolve(root, 'scripts', 'validate_earnings_week.js'),
    '--input',
    file
  ];
  if (requireNarrative) command.push('--require-narrative');
  execFileSync(process.execPath, command, { stdio: 'inherit' });
}

function validateResolutions(input, resolutions) {
  execFileSync(process.execPath, [
    path.resolve(root, 'scripts', 'validate_earnings_week.js'),
    'release',
    '--input',
    resolutions,
    '--week',
    input
  ], { stdio: 'inherit' });
}

function applyReleaseCommand(argv) {
  const args = parseApplyReleaseArgs(argv);
  if (!args.skipValidation) {
    validateWeek(args.input);
    validateResolutions(args.input, args.resolutions);
  }
  const output = applyCompanyReleaseResolutions(readJson(args.input), readJson(args.resolutions));
  writeJson(args.output, output);
  if (!args.skipValidation) validateWeek(args.output);
  process.stdout.write(`Applied ${output.companyReleaseApply.applied.length} company-release resolution(s) to ${args.output}\n`);
}

function applyNarrativeCommand(argv) {
  const args = parseApplyNarrativeArgs(argv);
  const output = applyEarningsNarrative(readJson(args.input), readJson(args.narrative), {
    sourceArtifact: path.relative(root, args.input),
    narrativeArtifact: path.relative(root, args.narrative)
  });
  writeJson(args.output, output);
  if (!args.skipValidation) validateWeek(args.output, true);
  process.stdout.write(`Applied ${output.narrativeApply.applied.length} earnings narrative row(s) to ${args.output}\n`);
}

function embedCommand(argv) {
  const args = parseEmbedArgs(argv);
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const earningsWeek = readJson(args.earningsWeek);
  fs.writeFileSync(args.dashboard, embedEarningsWeek(html, earningsWeek));
  process.stdout.write(`Embedded ${earningsWeek.rows.length} earnings row(s) into ${args.dashboard}\n`);
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }
  if (command === 'build') return runScript('earnings_week_build.js', argv);
  if (command === 'refresh') return runScript('earnings_week_refresh.js', argv);
  if (command === 'resolve') return runScript('earnings_week_resolve.js', argv);
  if (command === 'validate') return runScript('validate_earnings_week.js', argv);
  if (command === 'validate-release') return runScript('validate_earnings_week.js', ['release', ...argv]);
  if (command === 'apply-release') return applyReleaseCommand(argv);
  if (command === 'apply-narrative') return applyNarrativeCommand(argv);
  if (command === 'embed') return embedCommand(argv);
  throw new Error(`Unknown earnings_week command: ${command}`);
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
  applyCompanyReleaseResolutions,
  applyEarningsNarrative,
  embedEarningsWeek
};
