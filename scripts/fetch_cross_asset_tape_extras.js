#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'cross_asset_tape_extras.json');

// Staging helper only: generated rows must be merged into embedded tape.rows before publish.
const MSCI_INSTRUMENTS = [
  {
    code: '990300',
    ticker: 'MXEA',
    name: 'MSCI EAFE',
    note: 'Developed international equities lagged as global cyclicals absorbed AI fatigue, currency crosscurrents and trade-risk caution.'
  },
  {
    code: '891800',
    ticker: 'MXEF',
    name: 'MSCI EM',
    note: 'Emerging markets reflected risk-off beta, Asia tech sensitivity and dollar-yield uncertainty ahead of U.S. jobs data.'
  }
];

const YAHOO_INSTRUMENTS = [
  {
    symbol: 'IEF',
    ticker: 'IEF',
    name: '7-10Y Treasury ETF',
    note: 'Intermediate Treasuries caught a duration bid as softer inflation and lower oil reduced near-term rate pressure.'
  },
  {
    symbol: 'AGG',
    ticker: 'AGG',
    name: 'U.S. Aggregate Bond',
    note: 'Core bonds firmed with Treasury duration, helped by calmer energy prices and a modest quality bid.'
  },
  {
    symbol: 'LQD',
    ticker: 'LQD',
    name: 'Invest Grade Corp.',
    note: 'Investment-grade credit followed the duration bid while contained spreads signaled caution rather than stress.'
  },
  {
    symbol: 'HYG',
    ticker: 'HYG',
    name: 'High Yield Corp.',
    note: 'High yield stayed steady as lower oil and equity rotation reduced macro stress, but risk appetite remained guarded.'
  },
  {
    symbol: '^FNER',
    ticker: 'FNER',
    name: 'FTSE Nareit',
    note: 'Listed real estate drew support from lower yields, improving the rate-sensitive valuation backdrop.'
  },
  {
    symbol: 'GD=F',
    ticker: 'GSCI',
    name: 'S&P GSCI',
    note: 'The broad commodity basket was held back by the energy washout, with metals strength only partly offsetting crude.'
  },
  {
    symbol: '^MOVE',
    ticker: 'MOVE',
    name: 'MOVE Index',
    note: 'Treasury volatility eased as oil posed less inflation shock, though payrolls kept rates event risk alive.'
  }
];

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
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
  process.stdout.write(`Usage: node scripts/fetch_cross_asset_tape_extras.js [options]

Options:
  --output PATH       JSON output path (default: scripts/generated/cross_asset_tape_extras.json)
  --timeout-ms 10000  HTTP timeout in ms per request
  --compact           Print one-line symbol summary
  --help              Show this help
`);
}

function chartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
}

function msciGraphUrl(code, startDate, endDate) {
  const params = new URLSearchParams({
    currency_symbol: 'USD',
    index_variant: 'STRD',
    index_codes: code,
    start_date: startDate,
    end_date: endDate
  });
  return `https://app2.msci.com/products/service/index/indexmaster/getLevelDataForGraph?${params.toString()}`;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Daily-Financial-Dashboard/1.0',
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://www.msci.com/'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function numberFormat(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}

function signedNumber(value) {
  const formatted = numberFormat(Math.abs(value), 2);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return '0.00';
}

function signedPct(value) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'always'
  }).format(value)}%`;
}

function direction(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function yyyymmdd(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function validCloses(result) {
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return timestamps.map((timestamp, index) => {
    const close = Number(closes[index]);
    return Number.isFinite(timestamp) && Number.isFinite(close)
      ? { timestamp, close }
      : null;
  }).filter(Boolean);
}

function parseInstrument(spec, payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(`${spec.symbol} response did not include chart data`);
  }

  const closes = validCloses(result);
  const meta = result.meta || {};
  const latestClose = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.chartPreviousClose);
  const latest = Number.isFinite(latestClose) ? latestClose : closes[closes.length - 1]?.close;
  const previous = Number.isFinite(previousClose) ? previousClose : closes[closes.length - 2]?.close;
  if (!Number.isFinite(latest) || !Number.isFinite(previous)) {
    throw new Error(`${spec.symbol} response did not include enough price history`);
  }

  const delta = latest - previous;
  const pct = previous ? (delta / previous) * 100 : 0;
  return {
    name: spec.name,
    ticker: spec.ticker,
    last: numberFormat(latest, 2),
    delta: signedNumber(delta),
    pct: signedPct(pct),
    dir: direction(pct),
    note: spec.note,
    sourceSymbol: spec.symbol
  };
}

async function fetchInstrument(spec, args) {
  const payload = await fetchJson(chartUrl(spec.symbol), args.timeoutMs);
  return parseInstrument(spec, payload);
}

function parseMsciInstrument(spec, payload) {
  const levels = payload?.indexes?.INDEX_LEVELS || [];
  const validLevels = levels.map((level) => ({
    date: Number(level?.calc_date),
    value: Number(level?.level_eod)
  })).filter((level) => Number.isFinite(level.date) && Number.isFinite(level.value));
  if (validLevels.length < 2) {
    throw new Error(`${spec.name} response did not include enough MSCI index history`);
  }

  const latest = validLevels[validLevels.length - 1];
  const previous = validLevels[validLevels.length - 2];
  const delta = latest.value - previous.value;
  const pct = previous.value ? (delta / previous.value) * 100 : 0;
  return {
    name: spec.name,
    ticker: spec.ticker,
    last: numberFormat(latest.value, 2),
    delta: signedNumber(delta),
    pct: signedPct(pct),
    dir: direction(pct),
    note: spec.note,
    sourceSymbol: `MSCI:${spec.code}`,
    asOf: String(latest.date)
  };
}

async function fetchMsciInstrument(spec, args, startDate, endDate) {
  const payload = await fetchJson(msciGraphUrl(spec.code, startDate, endDate), args.timeoutMs);
  return parseMsciInstrument(spec, payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
  const rows = [
    ...(await Promise.all(MSCI_INSTRUMENTS.map((spec) => fetchMsciInstrument(spec, args, yyyymmdd(start), yyyymmdd(end))))),
    ...(await Promise.all(YAHOO_INSTRUMENTS.map((spec) => fetchInstrument(spec, args))))
  ];
  // Output is a staging payload; production tape rows must be embedded in daily_financial_news.html.
  const output = {
    compiledAt: new Date().toISOString(),
    source: 'MSCI index graph endpoint and Yahoo Finance Chart API',
    rows
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);

  if (args.compact) {
    process.stdout.write(rows.map((row) => `${row.ticker} ${row.last} ${row.pct}`).join(' | '));
    process.stdout.write('\n');
  } else {
    process.stdout.write(`Wrote ${args.output}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_cross_asset_tape_extras failed: ${error.message}\n`);
    process.exit(1);
  });
}
