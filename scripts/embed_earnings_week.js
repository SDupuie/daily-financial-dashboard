#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { validateEarningsWeekPayload } = require('./validate_earnings_week');

const root = path.resolve(__dirname, '..');
const DEFAULT_DASHBOARD = path.resolve(root, 'daily_financial_news.html');
const DEFAULT_EARNINGS_WEEK = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');

function parseArgs(argv) {
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
    if (arg === '--earnings-week') {
      args.earningsWeek = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EARNINGS_WEEK);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/embed_earnings_week.js [options]

Options:
  --dashboard PATH      Dashboard HTML to update (default: daily_financial_news.html)
  --earnings-week PATH  Canonical earnings week JSON (default: scripts/generated/earnings_week.json)
  --help               Show this help
`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function dashboardDataRegion(html) {
  const region = html.match(/<!-- Daily refreshes update this quote\/story payload\. Chart history is embedded separately in chart-data below\. -->[\s\S]*?<!-- ============ DATA END ============ -->/);
  if (!region) throw new Error('Could not find the marked dashboard-data region.');
  const data = region[0].match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!data) throw new Error('Could not find dashboard-data JSON inside the marked region.');
  return { region: region[0], dataJson: data[1] };
}

function embedEarningsWeek(html, earningsWeek) {
  // Embedding is the production handoff, so require the fully enriched
  // canonical payload before touching daily_financial_news.html.
  const errors = validateEarningsWeekPayload(earningsWeek, { requireNarrative: true });
  if (errors.length) {
    throw new Error(`Earnings week payload is invalid:\n- ${errors.join('\n- ')}`);
  }

  const { region, dataJson } = dashboardDataRegion(html);
  const dashboardData = JSON.parse(dataJson);
  dashboardData.earnings = {
    label: 'Earnings · Week Monitor',
    week: earningsWeek
  };

  const nextRegion = [
    '<!-- Daily refreshes update this quote/story payload. Chart history is embedded separately in chart-data below. -->',
    '<!-- ============ DATA START — edit this block to update the dashboard ============ -->',
    `<script type="application/json" id="dashboard-data">${JSON.stringify(dashboardData, null, 2)}</script>`,
    '<!-- ============ DATA END ============ -->'
  ].join('\n');

  return html.replace(region, nextRegion);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const html = fs.readFileSync(args.dashboard, 'utf8');
  const earningsWeek = readJson(args.earningsWeek);
  fs.writeFileSync(args.dashboard, embedEarningsWeek(html, earningsWeek));
  process.stdout.write(`Embedded ${earningsWeek.rows.length} earnings row(s) into ${args.dashboard}\n`);
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
  embedEarningsWeek
};
