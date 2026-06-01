#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const forwardArgs = process.argv.slice(2);
const script = path.resolve(__dirname, 'fetch_quotes.js');

const passthrough = [];
let hasSymbols = false;
let hasCache = false;
let hasOutput = false;

for (let i = 0; i < forwardArgs.length; i += 1) {
  const arg = forwardArgs[i];
  passthrough.push(arg);

  if (arg === '--symbols') hasSymbols = true;
  if (arg === '--cache') hasCache = true;
  if (arg === '--output') hasOutput = true;

  if (['--symbols', '--cache', '--output', '--attempts', '--timeout-ms'].includes(arg)) {
    i += 1;
    if (i < forwardArgs.length) passthrough.push(forwardArgs[i]);
  }
}

if (!hasSymbols) {
  passthrough.push('--symbols', 'IBIT:etf,MSTR:stock');
}
if (!hasCache) {
  passthrough.push('--cache', path.join('scripts', 'proxy_last_verified.json'));
}
if (!hasOutput) {
  passthrough.push('--output', path.join('/tmp', 'proxy_fetch_result.json'));
}

const res = spawnSync(process.execPath, [script, ...passthrough], {
  stdio: 'inherit',
  env: process.env
});

if (typeof res.status === 'number') {
  process.exit(res.status);
}
process.exit(1);
