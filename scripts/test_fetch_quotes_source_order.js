#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const file = path.resolve(__dirname, 'fetch_quotes.js');
const s = fs.readFileSync(file, 'utf8');

const idxChart = s.indexOf("key: 'yahoo_chart'");
const idxHtml = s.indexOf("key: 'yahoo_html'");
const idxNasdaq = s.indexOf("key: 'nasdaq'");

assert(idxChart >= 0, 'fetch_quotes must include yahoo_chart source');
assert(idxHtml >= 0, 'fetch_quotes must include yahoo_html fallback source');
assert(idxNasdaq >= 0, 'fetch_quotes must include nasdaq source');
assert(idxChart < idxHtml, 'yahoo_chart should run before yahoo_html fallback');
assert(s.includes('function parseYahooChart('), 'parseYahooChart() must exist');
assert(s.includes("Continuing with available sources in chain order."), 'fetch_quotes should continue chain on partial DNS failures');
assert(s.includes('dnsFailures.length === preflight.length'), 'fetch_quotes should only return DNS exit when all hosts fail');
assert(s.includes('dns-preflight-failed'), 'fetch_quotes should mark skipped sources when host preflight fails');

process.stdout.write('fetch_quotes source-order tests passed\n');
