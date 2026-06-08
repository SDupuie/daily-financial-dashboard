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

function mutateDashboard(mutator) {
  const marker = '<script type="application/json" id="dashboard-data">';
  const start = original.indexOf(marker);
  if (start < 0) throw new Error('dashboard-data marker not found');
  const jsonStart = start + marker.length;
  const jsonEnd = original.indexOf('</script>', jsonStart);
  if (jsonEnd < 0) throw new Error('dashboard-data closing script not found');

  const data = JSON.parse(original.slice(jsonStart, jsonEnd));
  mutator(data);
  const mutated = `${original.slice(0, jsonStart)}${JSON.stringify(data, null, 2)}\n${original.slice(jsonEnd)}`;
  fs.writeFileSync(dashboardPath, mutated);
}

try {
  mutateDashboard((data) => {
    data.masthead = data.masthead || {};
    data.footer = data.footer || {};
    data.renesas = data.renesas || {};
    data.renesas.stats = Array.isArray(data.renesas.stats) ? data.renesas.stats : [];

    data.masthead.date = 'Monday · June 8 · 2026';
    data.footer.compiled = 'Compiled June 8, 2026 · Alternative.me Crypto Fear & Greed Index';

    for (const stat of data.renesas.stats) {
      if (/6723\.T Close/i.test(String(stat.key || ''))) {
        stat.small = 'Tokyo close (Jun 5)';
      }
      if (/Latest Verified Trade Date/i.test(String(stat.key || ''))) {
        stat.value = 'Jun 5';
        stat.small = 'Verified via fallback';
      }
    }
  });

  const staleRun = spawnSync(process.execPath, ['scripts/validate_dashboard.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_NOW_ISO: '2026-06-08T12:15:00Z' }
  });

  assert(staleRun.status !== 0, 'stale Tokyo close should fail validation after the Tokyo session has ended');
  assert((staleRun.stderr + staleRun.stdout).includes('Renesas must use the latest Tokyo close'), 'stale Renesas failure should mention latest Tokyo close');

  mutateDashboard((data) => {
    for (const stat of data.renesas.stats) {
      if (/6723\.T Close/i.test(String(stat.key || ''))) {
        stat.small = 'Tokyo close (Jun 8)';
      }
      if (/Latest Verified Trade Date/i.test(String(stat.key || ''))) {
        stat.value = 'Jun 8';
        stat.small = 'Verified via fallback';
      }
    }
  });

  const freshRun = spawnSync(process.execPath, ['scripts/validate_dashboard.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, VALIDATE_NOW_ISO: '2026-06-08T12:15:00Z' }
  });

  assert(freshRun.status === 0, `fresh Tokyo close should pass validation\n${freshRun.stderr}\n${freshRun.stdout}`);

  process.stdout.write('validate market-date tests passed\n');
} finally {
  restore();
}
