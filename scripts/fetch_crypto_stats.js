#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { atomicWriteJson } = require('./staging_writer');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'crypto_stats.json');
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const REQUEST_TIMEOUT_MS = 15000;
const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=2';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const ALTCOIN_SEASON_PAGE_URL = 'https://coinmarketcap.com/charts/altcoin-season-index/';
const ALTCOIN_SEASON_API_URL = 'https://api.coinmarketcap.com/data-api/v3/altcoin-season/chart';

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    input: DEFAULT_INPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lookbackDays: 31,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--output requires a path.');
      args.output = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--input') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--input requires a path.');
      args.input = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--dashboard') {
      throw new Error('Direct dashboard writes are not supported; deterministic preparation consumes the staged Crypto payload.');
    }

    if (arg === '--timeout-ms') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 1000) throw new Error('--timeout-ms must be a finite number of at least 1000 milliseconds.');
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--lookback-days') {
      if (!Number.isFinite(Number(argv[i + 1])) || Number(argv[i + 1]) < 7) throw new Error('--lookback-days must be a finite number of at least 7 days.');
      args.lookbackDays = Number(argv[i + 1]);
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/fetch_crypto_stats.js [options]

Options:
  --input PATH            Canonical dashboard used for per-card carry-forward
  --output PATH           JSON output path (default: generated/crypto_stats.json)
  --timeout-ms 15000      HTTP timeout in ms
  --lookback-days 31      Altcoin Season history window requested from CoinMarketCap
  --compact               Print one-line stat summary
  --help                  Show this help
`);
}

function fetchJson(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Daily-Financial-Dashboard/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'close',
        ...headers
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160).trim()}`));
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

function chicagoIsoDate(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(seconds * 1000));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function chicagoMonthDay(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric'
  }).format(new Date(seconds * 1000));
}

function signedIntegerText(value) {
  if (value === 0) return 'Unchanged';
  return value > 0 ? `+${value}` : String(value);
}

function signedPct(value, digits = 2) {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: 'always'
  }).format(value)}%`;
}

function toneForDelta(value) {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function formatUsdCompact(value) {
  const abs = Math.abs(value);
  let formatted;
  if (abs >= 1e12) {
    formatted = `${(value / 1e12).toFixed(2)}T`;
  } else if (abs >= 1e9) {
    formatted = `${(value / 1e9).toFixed(2)}B`;
  } else if (abs >= 1e6) {
    formatted = `${(value / 1e6).toFixed(2)}M`;
  } else {
    formatted = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2
    }).format(value);
  }
  return formatted.replace(/\.00([TMB])$/, '$1');
}

function signedUsdCompact(value) {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${prefix}$${formatUsdCompact(Math.abs(value))}`;
}

function classifyFearGreed(score, fallbackClassification = '') {
  const direct = String(fallbackClassification || '').trim();
  if (direct) return direct;
  if (score <= 24) return 'Extreme Fear';
  if (score <= 49) return 'Fear';
  if (score <= 54) return 'Neutral';
  if (score <= 74) return 'Greed';
  return 'Extreme Greed';
}

function classifyAltcoinSeason(score, dialConfigs, fallbackName = '') {
  const direct = String(fallbackName || '').trim();
  if (direct) return direct;

  const matched = Array.isArray(dialConfigs)
    ? dialConfigs.find((config) => {
      const start = Number(config?.start);
      const end = Number(config?.end);
      return Number.isFinite(start) && Number.isFinite(end) && score >= start && score <= end;
    })
    : null;

  const matchedName = String(matched?.name || '').trim();
  if (matchedName) return matchedName;
  if (score <= 25) return 'Bitcoin Season';
  if (score >= 75) return 'Altcoin Season';
  return 'Neutral';
}

function classifyMarketCap(pctChange) {
  if (pctChange >= 1) return 'Expanding';
  if (pctChange <= -1) return 'Contracting';
  return 'Digesting';
}

function buildAltcoinSeasonApiUrl(lookbackDays) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - lookbackDays * 24 * 60 * 60;
  // CoinMarketCap exposes yesterday/last-week comparisons from this chart endpoint, not from the public page HTML.
  return `${ALTCOIN_SEASON_API_URL}?start=${start}&end=${end}`;
}

function normalizeFearGreed(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const current = rows[0];
  const previous = rows[1];
  const currentValue = Number(current?.value);
  const previousValue = Number(previous?.value);
  if (!Number.isFinite(currentValue)) {
    throw new Error('Alternative.me response was missing the current Fear & Greed reading.');
  }

  let deltaText = 'n/a';
  let deltaDir = 'flat';
  let changeValue = null;
  if (Number.isFinite(previousValue)) {
    changeValue = currentValue - previousValue;
    deltaText = signedIntegerText(changeValue);
    deltaDir = toneForDelta(changeValue);
  }

  return {
    source: 'Alternative.me',
    sourceUrl: 'https://alternative.me/crypto/fear-and-greed-index/#api',
    asOf: chicagoIsoDate(current?.timestamp),
    stat: {
      sym: 'F&G',
      name: 'Fear & Greed Index',
      sub: classifyFearGreed(currentValue, current?.value_classification),
      price: String(Math.round(currentValue)),
      delta: deltaText,
      chg: deltaText,
      dir: deltaDir
    },
    currentValue: Math.round(currentValue),
    previousValue: Number.isFinite(previousValue) ? Math.round(previousValue) : null
  };
}

function normalizeTotalMarketCap(payload) {
  const totalMarketCapUsd = Number(payload?.data?.total_market_cap?.usd);
  const changePct = Number(payload?.data?.market_cap_change_percentage_24h_usd);
  const updatedAt = Number(payload?.data?.updated_at);
  if (!Number.isFinite(totalMarketCapUsd) || !Number.isFinite(changePct)) {
    throw new Error('CoinGecko response was missing total market cap USD data.');
  }

  const priorMarketCap = changePct === -100 ? null : totalMarketCapUsd / (1 + changePct / 100);
  const absoluteChange = Number.isFinite(priorMarketCap) ? totalMarketCapUsd - priorMarketCap : null;
  const deltaDir = toneForDelta(changePct);

  return {
    source: 'CoinGecko',
    sourceUrl: 'https://docs.coingecko.com/reference/crypto-global',
    asOf: chicagoIsoDate(updatedAt),
    stat: {
      sym: 'TOTAL',
      name: 'Crypto Market Cap',
      sub: classifyMarketCap(changePct),
      price: formatUsdCompact(totalMarketCapUsd),
      delta: Number.isFinite(absoluteChange) ? signedUsdCompact(absoluteChange) : 'n/a',
      chg: signedPct(changePct),
      dir: deltaDir
    },
    totalMarketCapUsd,
    marketCapChange24hPct: changePct,
    previousMarketCapUsd: Number.isFinite(priorMarketCap) ? priorMarketCap : null
  };
}

function normalizeAltcoinSeason(payload, apiUrl) {
  const historicalValues = payload?.data?.historicalValues;
  const dialConfigs = Array.isArray(payload?.data?.dialConfigs) ? payload.data.dialConfigs : [];
  if (!historicalValues || typeof historicalValues !== 'object') {
    throw new Error('CoinMarketCap response was missing historicalValues.');
  }

  const nowPoint = historicalValues.now;
  const yesterdayPoint = historicalValues.yesterday;
  const currentScore = Number(nowPoint?.altcoinIndex);
  if (!Number.isFinite(currentScore)) {
    throw new Error('CoinMarketCap response was missing the current Altcoin Season reading.');
  }

  const roundedCurrentScore = Math.round(currentScore);
  const roundedYesterdayScore = Number.isFinite(Number(yesterdayPoint?.altcoinIndex))
    ? Math.round(Number(yesterdayPoint.altcoinIndex))
    : null;

  let deltaText = 'n/a';
  let deltaDir = 'flat';
  if (Number.isFinite(roundedYesterdayScore)) {
    const difference = roundedCurrentScore - roundedYesterdayScore;
    deltaText = signedIntegerText(difference);
    deltaDir = toneForDelta(difference);
  }

  return {
    source: 'CoinMarketCap',
    sourceUrl: ALTCOIN_SEASON_PAGE_URL,
    apiUrl,
    asOf: chicagoIsoDate(nowPoint?.timestamp),
    asOfDisplay: chicagoMonthDay(nowPoint?.timestamp),
    stat: {
      sym: 'ALTSEASON',
      name: 'Altcoin Season Index',
      sub: classifyAltcoinSeason(roundedCurrentScore, dialConfigs, nowPoint?.name),
      price: String(roundedCurrentScore),
      delta: deltaText,
      chg: '/100',
      dir: deltaDir
    },
    currentValue: roundedCurrentScore,
    previousValue: Number.isFinite(roundedYesterdayScore) ? roundedYesterdayScore : null,
    historicalValues,
    dialConfigs
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const normalized = await fetchCryptoStatsPartial(args);

  atomicWriteJson(args.output, normalized);

  if (args.compact) {
    process.stdout.write(
      `F&G ${normalized.fearGreed.stat.price} ${normalized.fearGreed.stat.delta} | ` +
      `ALTSEASON ${normalized.altcoinSeason.stat.price} ${normalized.altcoinSeason.stat.delta} | ` +
      `TOTAL ${normalized.totalMarketCap.stat.price} ${normalized.totalMarketCap.stat.chg}\n`
    );
    return;
  }

  process.stdout.write(`Wrote ${args.output}\n`);
}

function canonicalCryptoStats(input) {
  try {
    const html = fs.readFileSync(input, 'utf8');
    const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
    const data = match ? JSON.parse(match[1]) : null;
    return Array.isArray(data?.crypto?.stats) ? data.crypto.stats : [];
  } catch (_error) {
    return [];
  }
}

function unavailableCryptoStat(symbol, name, checkedAt, error) {
  return {
    sym: symbol,
    name,
    sub: 'Unavailable',
    price: 'Unavailable',
    delta: 'Unavailable',
    chg: '',
    dir: 'flat',
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: checkedAt.toISOString(),
      message: error?.message || String(error || 'source unavailable')
    }
  };
}

async function fetchCryptoStatsPartial(args, dependencies = {}) {
  const checkedAt = dependencies.now instanceof Date ? dependencies.now : new Date();
  const altcoinApiUrl = buildAltcoinSeasonApiUrl(args.lookbackDays);
  const tasks = [
    {
      key: 'fearGreed', sym: 'F&G', name: 'Fear & Greed Index',
      fetch: () => fetchJson(FEAR_GREED_URL, args.timeoutMs, {}),
      normalize: normalizeFearGreed
    },
    {
      key: 'altcoinSeason', sym: 'ALTSEASON', name: 'Altcoin Season Index',
      fetch: () => fetchJson(altcoinApiUrl, args.timeoutMs, { Origin: 'https://coinmarketcap.com', Referer: ALTCOIN_SEASON_PAGE_URL }),
      normalize: (payload) => normalizeAltcoinSeason(payload, altcoinApiUrl)
    },
    {
      key: 'totalMarketCap', sym: 'TOTAL', name: 'Crypto Market Cap',
      fetch: () => fetchJson(COINGECKO_GLOBAL_URL, args.timeoutMs, {}),
      normalize: normalizeTotalMarketCap
    }
  ];
  const priorBySymbol = new Map(canonicalCryptoStats(args.input).map((row) => [row?.sym, row]));
  const settled = await Promise.allSettled(tasks.map(async (task) => (
    dependencies.collectProvider ? dependencies.collectProvider(task) : task.normalize(await task.fetch())
  )));
  const stats = [];
  const details = {};
  const failures = [];
  settled.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === 'fulfilled') {
      details[task.key] = result.value;
      stats.push(result.value.stat);
      return;
    }
    failures.push({ provider: task.key, message: result.reason?.message || 'source unavailable' });
    const prior = priorBySymbol.get(task.sym);
    const stat = prior
      ? {
        ...prior,
        availability: {
          status: 'carried_forward',
          reason: 'source_refresh_failed',
          checkedAt: checkedAt.toISOString()
        }
      }
      : unavailableCryptoStat(task.sym, task.name, checkedAt, result.reason);
    stats.push(stat);
    details[task.key] = { source: 'Unavailable', stat };
  });
  return {
    fetchedAt: checkedAt.toISOString(),
    stats,
    ...details,
    ...(failures.length ? {
      availability: {
        status: 'partial',
        reason: 'source_refresh_failed',
        checkedAt: checkedAt.toISOString(),
        failures
      }
    } : {})
  };
}

async function fetchCryptoStats(options = {}) {
  const args = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    lookbackDays: 31,
    ...options
  };
  const altcoinApiUrl = buildAltcoinSeasonApiUrl(args.lookbackDays);
  // Stat cards share one staging boundary: reject the entire snapshot if any
  // provider cannot be normalized instead of mixing fresh and stale observations.
  const [fearGreedPayload, totalPayload, altcoinPayload] = await Promise.all([
    fetchJson(FEAR_GREED_URL, args.timeoutMs, {}),
    fetchJson(COINGECKO_GLOBAL_URL, args.timeoutMs, {}),
    fetchJson(altcoinApiUrl, args.timeoutMs, {
      'Origin': 'https://coinmarketcap.com',
      'Referer': ALTCOIN_SEASON_PAGE_URL
    })
  ]);

  const fearGreed = normalizeFearGreed(fearGreedPayload);
  const totalMarketCap = normalizeTotalMarketCap(totalPayload);
  const altcoinSeason = normalizeAltcoinSeason(altcoinPayload, altcoinApiUrl);

  const normalized = {
    fetchedAt: new Date().toISOString(),
    stats: [
      fearGreed.stat,
      altcoinSeason.stat,
      totalMarketCap.stat
    ],
    fearGreed,
    altcoinSeason,
    totalMarketCap
  };
  return normalized;
}

function buildCryptoStatsFallback(canonicalCrypto, checkedAt = new Date()) {
  const timestamp = new Date(checkedAt).toISOString();
  const stats = Array.isArray(canonicalCrypto?.stats) ? structuredClone(canonicalCrypto.stats) : [];
  return {
    fetchedAt: timestamp,
    stats,
    availability: {
      status: stats.length ? 'carried_forward' : 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: timestamp
    }
  };
}

function validateCryptoStatsPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Crypto stats staging payload must be an object.'];
  const unavailable = payload.availability?.status === 'unavailable';
  if (!Array.isArray(payload.stats)) return ['Crypto stats staging stats must be an array.'];
  if (!unavailable) {
    for (const symbol of ['F&G', 'ALTSEASON', 'TOTAL']) {
      if (!payload.stats.some((row) => row?.sym === symbol)) errors.push(`Crypto stats staging is missing ${symbol}.`);
    }
  } else if (payload.stats.length) {
    errors.push('Unavailable Crypto stats staging must contain no rows.');
  }
  return errors;
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  buildCryptoStatsFallback,
  fetchCryptoStats,
  fetchCryptoStatsPartial,
  validateCryptoStatsPayload
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_crypto_stats failed: ${error.message}\n`);
    process.exit(1);
  });
}
