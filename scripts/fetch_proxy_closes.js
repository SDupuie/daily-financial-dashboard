#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const https = require('https');

const DEFAULT_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 10000;
const REDIRECT_LIMIT = 5;

const SYMBOL_CONFIG = {
  IBIT: {
    assetClass: 'etf',
    marketwatchType: 'fund'
  },
  MSTR: {
    assetClass: 'stocks',
    marketwatchType: 'stock'
  }
};

const SOURCE_CHAIN = [
  {
    key: 'yahoo',
    name: 'Yahoo Finance',
    host: 'finance.yahoo.com',
    buildUrl: (symbol) => `https://finance.yahoo.com/quote/${symbol}`,
    parse: parseYahoo
  },
  {
    key: 'nasdaq',
    name: 'Nasdaq',
    host: 'api.nasdaq.com',
    buildUrl: (symbol, cfg) => `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${cfg.assetClass}`,
    parse: parseNasdaq
  },
  {
    key: 'marketwatch',
    name: 'MarketWatch',
    host: 'www.marketwatch.com',
    buildUrl: (symbol, cfg) => `https://www.marketwatch.com/investing/${cfg.marketwatchType}/${symbol.toLowerCase()}`,
    parse: parseMarketWatch
  }
];

function parseArgs(argv) {
  const args = {
    symbols: ['IBIT', 'MSTR'],
    attempts: DEFAULT_ATTEMPTS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    cachePath: path.resolve(process.cwd(), 'scripts', 'proxy_last_verified.json'),
    outputPath: null,
    skipDnsPreflight: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--symbols') {
      const value = argv[i + 1] || '';
      i += 1;
      args.symbols = value
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      continue;
    }
    if (arg === '--attempts') {
      args.attempts = Math.max(1, Number(argv[i + 1] || DEFAULT_ATTEMPTS));
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--cache') {
      args.cachePath = path.resolve(process.cwd(), argv[i + 1] || args.cachePath);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.outputPath = path.resolve(process.cwd(), argv[i + 1] || 'proxy_fetch_result.json');
      i += 1;
      continue;
    }
    if (arg === '--skip-dns-preflight') {
      args.skipDnsPreflight = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (args.symbols.length === 0) {
    throw new Error('No symbols provided.');
  }

  for (const symbol of args.symbols) {
    if (!SYMBOL_CONFIG[symbol]) {
      throw new Error(`Unsupported symbol "${symbol}". Supported: ${Object.keys(SYMBOL_CONFIG).join(', ')}`);
    }
  }

  return args;
}

function printHelp() {
  const text = `Usage: node scripts/fetch_proxy_closes.js [options]

Options:
  --symbols IBIT,MSTR        Comma-separated proxy symbols (default: IBIT,MSTR)
  --attempts 2               Attempts per source in fallback chain (default: 2)
  --timeout-ms 10000         HTTP timeout in ms per request (default: 10000)
  --cache scripts/proxy_last_verified.json
                             Cache file for last verified close fallback
  --output /tmp/result.json  Optional path to write full JSON result
  --skip-dns-preflight       Skip host DNS preflight checks
  --help                     Show this help
`;
  process.stdout.write(text);
}

async function dnsPreflight(hosts) {
  const results = [];
  for (const host of hosts) {
    try {
      const addr = await dns.lookup(host);
      results.push({ host, ok: true, address: addr.address });
    } catch (error) {
      results.push({ host, ok: false, error: normalizeError(error) });
    }
  }
  return results;
}

function normalizeError(error) {
  if (!error) return 'unknown error';
  return String(error.message || error.code || error);
}

function loadJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (error) {
    return { _error: `Failed to parse ${file}: ${normalizeError(error)}` };
  }
}

function saveJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchWithRedirects(url, options, redirectCount = 0) {
  if (redirectCount > REDIRECT_LIMIT) {
    throw new Error(`Too many redirects while fetching ${url}`);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: options.timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CodexDashboardBot/1.0',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'close',
          ...(options.headers || {})
        }
      },
      async (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          try {
            const redirected = await fetchWithRedirects(nextUrl, options, redirectCount + 1);
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status, headers: res.headers, body, url });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`));
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

function parseYahoo(body) {
  const price = extractNumber(body, /"regularMarketPrice"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const pct = extractNumber(body, /"regularMarketChangePercent"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const prevClose = extractNumber(body, /"regularMarketPreviousClose"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const tsRaw = extractNumber(body, /"regularMarketTime"\s*:\s*\{"raw":\s*(\d{9,})/);

  const close = Number.isFinite(price) ? price : prevClose;
  if (!Number.isFinite(close)) {
    throw new Error('Could not parse Yahoo close/price');
  }

  const tradeDate = Number.isFinite(tsRaw)
    ? new Date(tsRaw * 1000).toISOString().slice(0, 10)
    : null;

  return {
    close,
    pctChange: Number.isFinite(pct) ? pct : null,
    tradeDate
  };
}

function parseNasdaq(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Nasdaq response was not valid JSON');
  }

  const data = payload?.data || {};
  const pd = data.primaryData || {};
  const close = parseNumberFromText(pd.lastSalePrice || pd.lastSale || pd.lastTrade || '');
  const pct = parseNumberFromText(pd.percentageChange || pd.changePercent || '');
  const ts = String(pd.lastTradeTimestamp || pd.lastTradeDate || '').trim();

  if (!Number.isFinite(close)) {
    throw new Error('Could not parse Nasdaq close/last sale');
  }

  return {
    close,
    pctChange: Number.isFinite(pct) ? pct : null,
    tradeDate: parseDateLoose(ts)
  };
}

function parseMarketWatch(body) {
  const pricePatterns = [
    /<bg-quote[^>]*class="value"[^>]*>\s*\$?\s*([\d,]+(?:\.\d+)?)\s*<\/bg-quote>/i,
    /"Last"\s*:\s*"\$?\s*([\d,]+(?:\.\d+)?)"/i,
    /"price"\s*:\s*"\$?\s*([\d,]+(?:\.\d+)?)"/i,
    /"last"\s*:\s*"\$?\s*([\d,]+(?:\.\d+)?)"/i
  ];

  const pctPatterns = [
    /<bg-quote[^>]*field="percentChange"[^>]*>\s*([-+]?\d+(?:\.\d+)?)%\s*<\/bg-quote>/i,
    /"percentageChange"\s*:\s*"?([-+]?\d+(?:\.\d+)?)%?"?/i,
    /"percentChange"\s*:\s*"?([-+]?\d+(?:\.\d+)?)%?"?/i
  ];

  let close = NaN;
  for (const pattern of pricePatterns) {
    close = extractNumber(body, pattern);
    if (Number.isFinite(close)) break;
  }

  if (!Number.isFinite(close)) {
    throw new Error('Could not parse MarketWatch last/price');
  }

  let pct = NaN;
  for (const pattern of pctPatterns) {
    pct = extractNumber(body, pattern);
    if (Number.isFinite(pct)) break;
  }

  const dateMatch = body.match(/(?:As of|Last Updated)\s+([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})/i);

  return {
    close,
    pctChange: Number.isFinite(pct) ? pct : null,
    tradeDate: parseDateLoose(dateMatch ? dateMatch[1] : '')
  };
}

function extractNumber(text, regex) {
  const match = text.match(regex);
  if (!match) return NaN;
  return parseNumberFromText(match[1]);
}

function parseNumberFromText(value) {
  const normalized = String(value)
    .replace(/,/g, '')
    .replace(/\$/g, '')
    .replace(/%/g, '')
    .trim();
  const num = Number(normalized);
  return Number.isFinite(num) ? num : NaN;
}

function parseDateLoose(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const cleaned = text
    .replace(/\b(ET|EST|EDT|CT|CST|CDT|PT|PST|PDT|GMT|UTC)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  const fallback = cleaned.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})/);
  if (fallback) {
    const stitched = `${fallback[1]} ${fallback[2]}, ${fallback[3]}`;
    const d = new Date(stitched);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  return null;
}

function formatClose(value) {
  return Number(value).toFixed(2);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return null;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

async function fetchFromSource(symbol, cfg, source, attempts, timeoutMs) {
  const url = source.buildUrl(symbol, cfg);
  const attemptLog = [];

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchWithRedirects(url, {
        timeoutMs,
        headers: source.key === 'nasdaq'
          ? {
              'Accept': 'application/json, text/plain, */*',
              'Origin': 'https://www.nasdaq.com',
              'Referer': 'https://www.nasdaq.com/'
            }
          : {}
      });

      if (res.status < 200 || res.status >= 300) {
        attemptLog.push({ attempt: i, ok: false, status: res.status, error: `HTTP ${res.status}` });
        continue;
      }

      const parsed = source.parse(res.body);
      const result = {
        source: source.name,
        sourceKey: source.key,
        url,
        close: Number(formatClose(parsed.close)),
        pctChange: parsed.pctChange,
        pct: formatPct(parsed.pctChange),
        tradeDate: parsed.tradeDate
      };

      attemptLog.push({ attempt: i, ok: true, status: res.status });
      return { ok: true, result, attempts: attemptLog };
    } catch (error) {
      attemptLog.push({ attempt: i, ok: false, error: normalizeError(error) });
    }
  }

  return {
    ok: false,
    url,
    source: source.name,
    sourceKey: source.key,
    attempts: attemptLog
  };
}

function buildFallbackFromCache(symbol, cacheData) {
  const cached = cacheData?.[symbol];
  if (!cached) return null;

  const close = Number(cached.close);
  if (!Number.isFinite(close)) return null;

  return {
    fromCache: true,
    source: cached.source || 'cached-last-verified',
    close: Number(formatClose(close)),
    pctChange: Number.isFinite(Number(cached.pctChange)) ? Number(cached.pctChange) : null,
    pct: Number.isFinite(Number(cached.pctChange)) ? formatPct(Number(cached.pctChange)) : null,
    tradeDate: cached.tradeDate || null,
    verifiedAt: cached.verifiedAt || null
  };
}

function printSummary(summary) {
  process.stdout.write('\nProxy Quote Chain Summary\n');
  process.stdout.write('=========================\n');
  for (const symbol of Object.keys(summary.symbols)) {
    const row = summary.symbols[symbol];
    if (row.result) {
      process.stdout.write(
        `${symbol}: OK via ${row.result.source} | close ${row.result.close.toFixed(2)} | ` +
        `pct ${row.result.pct || 'n/a'} | tradeDate ${row.result.tradeDate || 'unknown'}\n`
      );
      continue;
    }

    if (row.fallback) {
      process.stdout.write(
        `${symbol}: FALLBACK cache | close ${row.fallback.close.toFixed(2)} | ` +
        `tradeDate ${row.fallback.tradeDate || 'unknown'}\n`
      );
      continue;
    }

    process.stdout.write(`${symbol}: UNRESOLVED\n`);
  }
  process.stdout.write('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  const cacheData = loadJson(args.cachePath);
  const cacheParseError = cacheData._error;

  const hosts = [...new Set(SOURCE_CHAIN.map((s) => s.host))];
  const preflight = args.skipDnsPreflight
    ? hosts.map((host) => ({ host, ok: true, skipped: true }))
    : await dnsPreflight(hosts);

  const dnsFailures = preflight.filter((p) => !p.ok);

  const summary = {
    generatedAt: nowIso,
    config: {
      symbols: args.symbols,
      attemptsPerSource: args.attempts,
      timeoutMs: args.timeoutMs,
      cachePath: args.cachePath,
      skipDnsPreflight: args.skipDnsPreflight
    },
    preflight,
    symbols: {}
  };

  if (cacheParseError) {
    summary.cacheWarning = cacheParseError;
  }

  if (dnsFailures.length > 0) {
    for (const symbol of args.symbols) {
      summary.symbols[symbol] = {
        result: null,
        fallback: buildFallbackFromCache(symbol, cacheData),
        chain: [],
        unresolvedReason: 'dns-preflight-failed'
      };
    }

    if (args.outputPath) {
      saveJson(args.outputPath, summary);
    }

    printSummary(summary);
    process.stderr.write(
      `DNS preflight failed for hosts: ${dnsFailures.map((d) => d.host).join(', ')}\n` +
      'Rerun this command with elevated network permissions immediately.\n'
    );
    process.exit(2);
  }

  const updatedCache = { ...(cacheData._error ? {} : cacheData) };
  let unresolvedCount = 0;

  for (const symbol of args.symbols) {
    const cfg = SYMBOL_CONFIG[symbol];
    const chainLog = [];
    let resolved = null;

    for (const source of SOURCE_CHAIN) {
      const attempt = await fetchFromSource(symbol, cfg, source, args.attempts, args.timeoutMs);
      chainLog.push(attempt);
      if (attempt.ok) {
        resolved = attempt.result;
        break;
      }
    }

    if (resolved) {
      updatedCache[symbol] = {
        close: resolved.close,
        pctChange: Number.isFinite(resolved.pctChange) ? resolved.pctChange : null,
        pct: resolved.pct,
        tradeDate: resolved.tradeDate,
        source: resolved.source,
        verifiedAt: nowIso
      };

      summary.symbols[symbol] = {
        result: resolved,
        fallback: null,
        chain: chainLog,
        unresolvedReason: null
      };
      continue;
    }

    unresolvedCount += 1;
    summary.symbols[symbol] = {
      result: null,
      fallback: buildFallbackFromCache(symbol, cacheData),
      chain: chainLog,
      unresolvedReason: 'all-sources-failed'
    };
  }

  saveJson(args.cachePath, updatedCache);

  if (args.outputPath) {
    saveJson(args.outputPath, summary);
  }

  printSummary(summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (unresolvedCount > 0) {
    process.exit(3);
  }
}

main().catch((error) => {
  process.stderr.write(`fetch_proxy_closes failed: ${normalizeError(error)}\n`);
  process.exit(1);
});
