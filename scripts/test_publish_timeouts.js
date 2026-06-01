#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const file = path.resolve(__dirname, 'publish_main.sh');
const s = fs.readFileSync(file, 'utf8');

assert(s.includes('CURL_CONNECT_TIMEOUT_SECONDS'), 'publish_main.sh must define CURL_CONNECT_TIMEOUT_SECONDS');
assert(s.includes('CURL_MAX_TIME_SECONDS'), 'publish_main.sh must define CURL_MAX_TIME_SECONDS');
assert(s.includes('--connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS"'), 'curl calls must set connect timeout');
assert(s.includes('--max-time "$CURL_MAX_TIME_SECONDS"'), 'curl calls must set max time');

process.stdout.write('publish timeout tests passed\n');
