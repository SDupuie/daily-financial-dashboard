#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');
const DEFAULT_NARRATIVE = path.resolve(root, 'scripts', 'generated', 'earnings_narrative.json');

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    narrative: DEFAULT_NARRATIVE,
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
      printHelp();
      process.exit(0);
    }
  }

  if (!args.output) args.output = args.input;
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/apply_earnings_narrative.js [options]

Options:
  --input PATH       Earnings week JSON to update (default: scripts/generated/earnings_week.json)
  --narrative PATH   Canonical narrative JSON (default: scripts/generated/earnings_narrative.json)
  --output PATH      Output earnings week JSON (default: overwrite --input)
  --skip-validation  Do not run validate_earnings_week.js after applying
  --help             Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rowKey(item) {
  return `${item.reportDate}:${item.symbol}`;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function sourceRangeMatches(left, right) {
  return left?.from === right?.from && left?.to === right?.to;
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

  // Narrative is the only AI-authored earnings layer; numeric facts must
  // already be present in the canonical row before this script runs.
  for (const item of narrativePayload.rows || []) {
    const key = rowKey(item);
    const target = rowsByKey.get(key);
    if (!target) throw new Error(`${key} narrative does not match a canonical earnings row.`);
    const row = target.row;
    const updated = {
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
    output.rows[target.index] = updated;
    applied.push({ symbol: item.symbol, reportDate: item.reportDate });
  }

  output.narrativeApply = {
    generatedAt: new Date().toISOString(),
    narrativeArtifact: options.narrativeArtifact || narrativePayload.outputPath || '',
    applied
  };
  return output;
}

function validateWeek(file) {
  execFileSync(process.execPath, [
    path.resolve(root, 'scripts', 'validate_earnings_week.js'),
    '--input',
    file,
    '--require-narrative'
  ], { stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = readJson(args.input);
  const narrative = readJson(args.narrative);
  const output = applyEarningsNarrative(source, narrative, {
    sourceArtifact: path.relative(root, args.input),
    narrativeArtifact: path.relative(root, args.narrative)
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
  if (!args.skipValidation) validateWeek(args.output);
  process.stdout.write(`Applied ${output.narrativeApply.applied.length} earnings narrative row(s) to ${args.output}\n`);
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
  applyEarningsNarrative
};
