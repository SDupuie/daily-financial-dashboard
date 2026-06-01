#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const script = path.resolve(__dirname, 'fetch_quotes.js');

function hasOption(flag) {
  return args.includes(flag);
}

if (!hasOption('--symbols')) {
  args.push('--symbols', 'IBIT:etf,MSTR:stock');
}
if (!hasOption('--cache')) {
  args.push('--cache', path.join('scripts', 'quotes_last_verified.json'));
}

const res = spawnSync(process.execPath, [script, ...args], {
  stdio: 'inherit',
  env: process.env
});

if (typeof res.status === 'number') {
  process.exit(res.status);
}
process.exit(1);
