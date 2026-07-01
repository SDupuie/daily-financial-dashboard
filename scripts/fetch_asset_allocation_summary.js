#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_REFRESH_URL = 'http://127.0.0.1:2200/api/asset-market-data';
const DEFAULT_EXPORT_PATH = '/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json';
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'scripts', 'generated', 'asset_allocation_summary.json');
const REQUEST_TIMEOUT_MS = 10000;

// This helper is a local daily-update bridge only. The published dashboard must
// never call the Asset Allocation server; it receives only this sanitized result.
function parseArgs(argv) {
  const args = {
    refreshUrl: DEFAULT_REFRESH_URL,
    exportPath: DEFAULT_EXPORT_PATH,
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh-url') {
      args.refreshUrl = argv[i + 1] || DEFAULT_REFRESH_URL;
      i += 1;
      continue;
    }
    if (arg === '--export-path') {
      args.exportPath = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_EXPORT_PATH);
      i += 1;
      continue;
    }
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
  process.stdout.write(`Usage: node scripts/fetch_asset_allocation_summary.js [options]

Options:
  --refresh-url URL       Local Asset Allocation refresh endpoint
  --export-path PATH      Sanitized export JSON path
  --output PATH           JSON output path (default: scripts/generated/asset_allocation_summary.json)
  --timeout-ms 10000      HTTP timeout in ms
  --compact               Print one-line summary
  --help                  Show this help
`);
}

function fetchUrl(urlText, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlText);
    } catch (error) {
      reject(new Error(`Invalid refresh URL: ${error.message}`));
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve();
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizedSummary(raw, stale, refreshError) {
  const status = raw?.status === 'available' ? 'available' : 'unavailable';
  const value = Number(raw?.portfolioMtdReturnValue);
  const available = status === 'available' && Number.isFinite(value);

  if (!isIsoDate(raw?.asOf)) {
    throw new Error('Asset Allocation summary asOf must be YYYY-MM-DD.');
  }
  if (status === 'available' && !Number.isFinite(value)) {
    throw new Error('Asset Allocation summary portfolioMtdReturnValue must be finite when status is available.');
  }

  return {
    asOf: raw.asOf,
    portfolioMtdReturnValue: available ? value : null,
    status: available ? 'available' : 'unavailable',
    stale,
    ...(refreshError ? { refreshError } : {})
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let stale = false;
  let refreshError = '';

  try {
    // The refresh endpoint updates the separate project's sanitized export file.
    // Its HTTP response is intentionally ignored so display data can only come
    // from the narrow JSON contract below.
    await fetchUrl(args.refreshUrl, args.timeoutMs);
  } catch (error) {
    stale = true;
    refreshError = error.message;
    if (!fs.existsSync(args.exportPath)) {
      throw new Error(`Refresh failed (${refreshError}) and export file does not exist: ${args.exportPath}`);
    }
  }

  const raw = JSON.parse(fs.readFileSync(args.exportPath, 'utf8'));
  const summary = normalizedSummary(raw, stale, refreshError);

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(summary, null, 2)}\n`);

  if (args.compact) {
    const display = summary.status === 'available'
      ? `${summary.portfolioMtdReturnValue >= 0 ? '+' : ''}${summary.portfolioMtdReturnValue.toFixed(2)}%`
      : 'Unavailable';
    process.stdout.write(`${display} as of ${summary.asOf}${summary.stale ? ' (stale)' : ''}\n`);
  } else {
    process.stdout.write(`Wrote ${args.output}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_asset_allocation_summary failed: ${error.message}\n`);
    process.exit(1);
  });
}
