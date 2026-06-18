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
assert(s.includes('GITHUB_REPO="${repo%.git}"'), 'publish_main.sh must strip the optional .git suffix from GitHub remotes');
assert(s.includes('^https?://github\\.com/([^/]+)/([^/]+)$'), 'publish_main.sh must parse HTTPS GitHub remotes without PCRE-only lazy quantifiers');
assert(s.includes('^git@github\\.com:([^/]+)/([^/]+)$'), 'publish_main.sh must parse SSH GitHub remotes without PCRE-only lazy quantifiers');
assert(s.includes('html.match(/<script type="application\\/json" id="dashboard-data">([\\s\\S]*?)<\\/script>/);'), 'publish_main.sh must extract dashboard JSON without requiring newlines around the script contents');

process.stdout.write('publish timeout tests passed\n');
