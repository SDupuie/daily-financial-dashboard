#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(__dirname, '..');
const dashboardPath = path.join(repoRoot, 'daily_financial_news.html');
const original = fs.readFileSync(dashboardPath, 'utf8');

function restore() {
  fs.writeFileSync(dashboardPath, original);
}

try {
  const marker = '<script type="application/json" id="dashboard-data">';
  const start = original.indexOf(marker);
  if (start < 0) throw new Error('dashboard-data marker not found');
  const jsonStart = start + marker.length;
  const jsonEnd = original.indexOf('</script>', jsonStart);
  if (jsonEnd < 0) throw new Error('dashboard-data closing script not found');

  const data = JSON.parse(original.slice(jsonStart, jsonEnd));
  data.masthead = data.masthead || {};
  data.footer = data.footer || {};
  data.masthead.date = 'Monday · January 1 · 2001';
  data.footer.compiled = 'Compiled January 1, 2001 · Alternative.me Crypto Fear & Greed Index';

  const mutated = `${original.slice(0, jsonStart)}${JSON.stringify(data, null, 2)}\n${original.slice(jsonEnd)}`;
  fs.writeFileSync(dashboardPath, mutated);

  const warnRun = spawnSync(process.execPath, ['scripts/validate_dashboard.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env
  });

  assert(warnRun.status === 0, 'non-strict freshness should not fail validation');
  assert((warnRun.stderr + warnRun.stdout).includes('Dashboard validation warnings:'), 'freshness warning should be printed in non-strict mode');

  const strictRun = spawnSync(process.execPath, ['scripts/validate_dashboard.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_STRICT_DATES: '1' }
  });

  assert(strictRun.status !== 0, 'strict freshness mode should fail stale dates');
  assert((strictRun.stderr + strictRun.stdout).includes('Masthead/footer may be stale'), 'strict failure should mention stale date reason');

  process.stdout.write('validate freshness warning tests passed\n');
} finally {
  restore();
}
