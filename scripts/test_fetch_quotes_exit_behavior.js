#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const script = path.resolve(__dirname, 'fetch_quotes.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-quotes-exit-'));
const cachePath = path.join(tmpDir, 'cache.json');

const symbol = 'ZZZZTESTQUOTE';
const symbolSpec = `${symbol}:stock`;

function run(extraArgs) {
  return spawnSync(process.execPath, [script, ...extraArgs], {
    encoding: 'utf8'
  });
}

// Case 1: unresolved symbol with valid cache fallback should exit 0.
fs.writeFileSync(cachePath, JSON.stringify({
  [symbolSpec]: {
    symbol,
    type: 'stock',
    close: 123.45,
    pctChange: -1.23,
    tradeDate: '2026-05-30',
    source: 'cached-last-verified',
    verifiedAt: '2026-06-01T00:00:00Z'
  }
}, null, 2));

const withFallback = run([
  '--symbols', symbolSpec,
  '--cache', cachePath,
  '--attempts', '1',
  '--timeout-ms', '1',
  '--compact'
]);

assert(withFallback.status === 0, `expected exit 0 with fallback, got ${withFallback.status}\n${withFallback.stderr}`);

// Case 2: unresolved symbol without fallback should be non-zero.
fs.writeFileSync(cachePath, '{}\n');
const withoutFallback = run([
  '--symbols', symbolSpec,
  '--cache', cachePath,
  '--attempts', '1',
  '--timeout-ms', '1',
  '--compact'
]);

assert(withoutFallback.status !== 0, 'expected non-zero exit without fallback cache');

process.stdout.write('fetch_quotes exit-behavior tests passed\n');
