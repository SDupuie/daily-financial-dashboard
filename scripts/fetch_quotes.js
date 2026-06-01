#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const https = require('https');

const DEFAULT_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 10000;
const REDIRECT_LIMIT = 5;

const DEFAULT_SYMBOLS = [
  'IBIT:etf',
  'MSTR:stock'
];

const EQUITY_TYPES = new Set(['stock', 'etf']);

const SOURCE_CHAIN = [
  {
    key: 'yahoo',
    name: 'Yahoo Finance',
    host: 'finance.yahoo.com',
    buildUrl: (spec) => `https://finance.yahoo.com/quote/${encodeURIComponent(spec.yahooSymbol || spec.symbol)}`,
    parse: parseYahoo
  },
  {
    key: 'nasdaq',
    name: 'Nasdaq',
    host: 'api.nasdaq.com',
    buildUrl: (spec) => `https://api.nasdaq.com/api/quote/${encodeURIComponent(spec.symbol)}/info?assetclass=${spec.nasdaqAssetClass}`,
    parse: parseNasdaq,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.nasdaq.com',
      'Referer': 'https://www.nasdaq.com/'
    }
  },
  {
    key: 'marketwatch',
    name: 'MarketWatch',
    host: 'www.marketwatch.com',
    buildUrl: (spec) => `https://www.marketwatch.com/investing/${spec.marketwatchType}/${spec.symbol.toLowerCase()}`,
    parse: parseMarketWatch
  }
];

function parseArgs(argv) {
  const args = {
    symbols: DEFAULT_SYMBOLS,
    attempts: DEFAULT_ATTEMPTS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    cachePath: path.resolve(process.cwd(), 'scripts', 'quotes_last_verified.json'),
    outputPath: null,
    skipDnsPreflight: false,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--symbols') {
      const value = argv[i + 1] || '';
      i += 1;
      args.symbols = value.split(',').map((s) => s.trim()).filter(Boolean);
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
      args.outputPath = path.resolve(process.cwd(), argv[i + 1] || 'quote_fetch_result.json');
      i += 1;
      continue;
    }

    if (arg === '--skip-dns-preflight') {
      args.skipDnsPreflight = true;
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

  const specs = args.symbols.map(parseSymbolSpec);
  if (specs.length === 0) {
    throw new Error('No symbols were provided.');
  }

  for (const spec of specs) {
    if (!EQUITY_TYPES.has(spec.type)) {
      throw new Error(`Unsupported type "${spec.type}" for ${spec.symbol}. Use stock|etf.`);
    }
  }

  return { ...args, symbolSpecs: specs };
}

function parseSymbolSpec(token) {
  const raw = String(token || '').trim();
  const [left, extra] = raw.split('@', 2);
  const [symbolPart, typePart] = left.split(':', 2);

  const symbol = String(symbolPart || '').trim().toUpperCase();
  const type = String(typePart || 'stock').trim().toLowerCase();

  if (!symbol) {
    throw new Error(`Invalid symbol token "${raw}".`);
  }

  const yahooSymbol = extra ? String(extra).trim() : symbol;

  return {
    token: raw,
    symbol,
    type,
    yahooSymbol,
    nasdaqAssetClass: type === 'etf' ? 'etf' : 'stocks',
    marketwatchType: type === 'etf' ? 'fund' : 'stock'
  };
}

function printHelp() {
  const text = `Usage: node scripts/fetch_quotes.js [options]

Options:
  --symbols SYMBOLS          Comma-separated specs (default: IBIT:etf,MSTR:stock)
                             Spec format: SYMBOL[:stock|etf][@YAHOO_SYMBOL]
                             Examples:
                               SPY:etf,QQQ:etf,MSTR:stock
                               SPX:stock@^GSPC,VIX:stock@^VIX
  --attempts 2               Attempts per source in fallback chain (default: 2)
  --timeout-ms 10000         HTTP timeout in ms per request (default: 10000)
  --cache scripts/quotes_last_verified.json
                             Cache file for last verified close fallback
  --output /tmp/result.json  Optional file path for full JSON output
  --skip-dns-preflight       Skip DNS host preflight checks
  --compact                  Print only compact summary output
  --help                     Show this help

Exit codes:
  0  success (all symbols resolved)
  2  DNS preflight failure (rerun with elevated network permissions)
  3  one or more symbols unresolved across full source chain
  1  script/runtime error
`;
  process.stdout.write(text);
}

function normalizeError(error) {
  if (!error) return 'unknown error';
  return String(error.message || error.code || error);
}

async function dnsPreflight(hosts) {
  const results = [];
  for (const host of hosts) {
    try {
      const resolved = await dns.lookup(host);
      results.push({ host, ok: true, address: resolved.address });
    } catch (error) {
      results.push({ host, ok: false, error: normalizeError(error) });
    }
  }
  return results;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchWithRedirects(url, options, depth = 0) {
  if (depth > REDIRECT_LIMIT) {
    throw new Error(`Too many redirects for ${url}`);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: options.timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CodexQuoteFetcher/1.0',
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
            const redirected = await fetchWithRedirects(nextUrl, options, depth + 1);
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`));
    });

    req.on('error', (error) => reject(error));
    req.end();
  });
}

function parseYahoo(body) {
  const price = extractNumber(body, /"regularMarketPrice"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const prevClose = extractNumber(body, /"regularMarketPreviousClose"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const pct = extractNumber(body, /"regularMarketChangePercent"\s*:\s*\{"raw":\s*([-+]?\d+(?:\.\d+)?)/);
  const tsRaw = extractNumber(body, /"regularMarketTime"\s*:\s*\{"raw":\s*(\d{9,})/);

  const close = Number.isFinite(price) ? price : prevClose;
  if (!Number.isFinite(close)) {
    throw new Error('Could not parse Yahoo close');
  }

  return {
    close,
    pctChange: Number.isFinite(pct) ? pct : null,
    tradeDate: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000).toISOString().slice(0, 10) : null
  };
}

function parseNasdaq(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Nasdaq response was not valid JSON');
  }

  const pd = payload?.data?.primaryData || {};
  const close = parseNumberFromText(pd.lastSalePrice || pd.lastSale || pd.lastTrade || '');
  const pct = parseNumberFromText(pd.percentageChange || pd.changePercent || '');
  const ts = String(pd.lastTradeTimestamp || pd.lastTradeDate || '').trim();

  if (!Number.isFinite(close)) {
    throw new Error('Could not parse Nasdaq close');
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
    throw new Error('Could not parse MarketWatch close');
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

  const d = new Date(cleaned);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  const fallback = cleaned.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})/);
  if (fallback) {
    const stitched = `${fallback[1]} ${fallback[2]}, ${fallback[3]}`;
    const d2 = new Date(stitched);
    if (!Number.isNaN(d2.getTime())) {
      return d2.toISOString().slice(0, 10);
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

function cacheKeyFor(spec) {
  return `${spec.symbol}:${spec.type}`;
}

function buildFallback(spec, cacheData) {
  const key = cacheKeyFor(spec);
  const cached = cacheData?.[key] || cacheData?.[spec.symbol] || null;
  if (!cached) return null;

  const close = Number(cached.close);
  if (!Number.isFinite(close)) return null;

  const pctChange = Number(cached.pctChange);
  return {
    fromCache: true,
    source: cached.source || 'cached-last-verified',
    close: Number(formatClose(close)),
    pctChange: Number.isFinite(pctChange) ? pctChange : null,
    pct: Number.isFinite(pctChange) ? formatPct(pctChange) : null,
    tradeDate: cached.tradeDate || null,
    verifiedAt: cached.verifiedAt || null
  };
}

async function fetchSymbol(spec, args) {
  const chain = [];

  for (const source of SOURCE_CHAIN) {
    const sourceResult = {
      source: source.name,
      sourceKey: source.key,
      url: source.buildUrl(spec),
      attempts: []
    };

    for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
      try {
        const res = await fetchWithRedirects(sourceResult.url, {
          timeoutMs: args.timeoutMs,
          headers: source.headers || {}
        });

        if (res.status < 200 || res.status >= 300) {
          sourceResult.attempts.push({ attempt, ok: false, status: res.status, error: `HTTP ${res.status}` });
          continue;
        }

        const parsed = source.parse(res.body);
        sourceResult.attempts.push({ attempt, ok: true, status: res.status });

        chain.push(sourceResult);
        return {
          result: {
            symbol: spec.symbol,
            type: spec.type,
            source: source.name,
            sourceKey: source.key,
            close: Number(formatClose(parsed.close)),
            pctChange: parsed.pctChange,
            pct: formatPct(parsed.pctChange),
            tradeDate: parsed.tradeDate
          },
          chain,
          unresolvedReason: null
        };
      } catch (error) {
        sourceResult.attempts.push({ attempt, ok: false, error: normalizeError(error) });
      }
    }

    chain.push(sourceResult);
  }

  return {
    result: null,
    chain,
    unresolvedReason: 'all-sources-failed'
  };
}

function printSummary(summary, compact) {
  process.stdout.write('\nUnified Quote Fetch Summary\n');
  process.stdout.write('===========================\n');

  for (const key of Object.keys(summary.symbols)) {
    const row = summary.symbols[key];
    if (row.result) {
      process.stdout.write(`${key}: OK via ${row.result.source} | close ${row.result.close.toFixed(2)} | pct ${row.result.pct || 'n/a'} | tradeDate ${row.result.tradeDate || 'unknown'}\n`);
      continue;
    }

    if (row.fallback) {
      process.stdout.write(`${key}: FALLBACK cache | close ${row.fallback.close.toFixed(2)} | tradeDate ${row.fallback.tradeDate || 'unknown'}\n`);
      continue;
    }

    process.stdout.write(`${key}: UNRESOLVED (${row.unresolvedReason})\n`);
  }

  process.stdout.write('\n');
  if (!compact) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  const cacheData = loadJson(args.cachePath);
  const preflight = args.skipDnsPreflight
    ? [...new Set(SOURCE_CHAIN.map((s) => s.host))].map((host) => ({ host, ok: true, skipped: true }))
    : await dnsPreflight([...new Set(SOURCE_CHAIN.map((s) => s.host))]);

  const summary = {
    generatedAt: nowIso,
    config: {
      symbols: args.symbolSpecs.map((s) => `${s.symbol}:${s.type}`),
      attemptsPerSource: args.attempts,
      timeoutMs: args.timeoutMs,
      cachePath: args.cachePath,
      skipDnsPreflight: args.skipDnsPreflight
    },
    preflight,
    symbols: {}
  };

  if (cacheData._error) {
    summary.cacheWarning = cacheData._error;
  }

  const dnsFailures = preflight.filter((x) => !x.ok);
  if (dnsFailures.length > 0) {
    for (const spec of args.symbolSpecs) {
      const key = `${spec.symbol}:${spec.type}`;
      summary.symbols[key] = {
        symbol: spec.symbol,
        type: spec.type,
        result: null,
        fallback: buildFallback(spec, cacheData),
        chain: [],
        unresolvedReason: 'dns-preflight-failed'
      };
    }

    if (args.outputPath) {
      saveJson(args.outputPath, summary);
    }

    printSummary(summary, args.compact);
    process.stderr.write(
      `DNS preflight failed for hosts: ${dnsFailures.map((d) => d.host).join(', ')}\n` +
      'Rerun with elevated network permissions immediately.\n'
    );
    process.exit(2);
  }

  const updatedCache = { ...(cacheData._error ? {} : cacheData) };
  let unresolved = 0;

  for (const spec of args.symbolSpecs) {
    const key = `${spec.symbol}:${spec.type}`;
    const fetched = await fetchSymbol(spec, args);

    if (fetched.result) {
      updatedCache[key] = {
        symbol: spec.symbol,
        type: spec.type,
        close: fetched.result.close,
        pctChange: Number.isFinite(fetched.result.pctChange) ? fetched.result.pctChange : null,
        pct: fetched.result.pct,
        tradeDate: fetched.result.tradeDate,
        source: fetched.result.source,
        verifiedAt: nowIso
      };

      summary.symbols[key] = {
        symbol: spec.symbol,
        type: spec.type,
        result: fetched.result,
        fallback: null,
        chain: fetched.chain,
        unresolvedReason: null
      };
      continue;
    }

    unresolved += 1;
    summary.symbols[key] = {
      symbol: spec.symbol,
      type: spec.type,
      result: null,
      fallback: buildFallback(spec, cacheData),
      chain: fetched.chain,
      unresolvedReason: fetched.unresolvedReason
    };
  }

  saveJson(args.cachePath, updatedCache);

  if (args.outputPath) {
    saveJson(args.outputPath, summary);
  }

  printSummary(summary, args.compact);

  if (unresolved > 0) {
    process.exit(3);
  }
}

main().catch((error) => {
  process.stderr.write(`fetch_quotes failed: ${normalizeError(error)}\n`);
  process.exit(1);
});
