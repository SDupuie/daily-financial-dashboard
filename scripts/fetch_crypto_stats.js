#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { isIsoDateTime } = require('./calendar_contract');
const { atomicWriteJson } = require('./staging_writer');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'crypto_stats.json');
const DEFAULT_INPUT = path.resolve(process.cwd(), 'daily_financial_news.html');
const REQUEST_TIMEOUT_MS = 15000;
const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=2';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const ALTCOIN_SEASON_PAGE_URL = 'https://coinmarketcap.com/charts/altcoin-season-index/';
const ALTCOIN_SEASON_API_URL = 'https://api.coinmarketcap.com/data-api/v3/altcoin-season/chart';
const CRYPTO_STAT_SYMBOLS = ['F&G', 'ALTSEASON', 'TOTAL'];

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

function dominanceFromCoinGecko(payload) {
  const btc = Number(payload?.data?.market_cap_percentage?.btc);
  const eth = Number(payload?.data?.market_cap_percentage?.eth);
  if (![btc, eth].every(Number.isFinite) || btc < 0 || eth < 0 || btc + eth > 100) {
    throw new Error('CoinGecko response was missing valid BTC and ETH market-cap dominance data.');
  }
  const percent = (value) => `${value.toFixed(2)}%`;
  return {
    btc: percent(btc),
    eth: percent(eth),
    others: percent(100 - btc - eth)
  };
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
    previousMarketCapUsd: Number.isFinite(priorMarketCap) ? priorMarketCap : null,
    dominance: dominanceFromCoinGecko(payload)
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

function canonicalCryptoState(input) {
  try {
    const html = fs.readFileSync(input, 'utf8');
    const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
    const data = match ? JSON.parse(match[1]) : null;
    return {
      stats: Array.isArray(data?.crypto?.stats) ? data.crypto.stats : [],
      dominance: data?.crypto?.dominance,
      lastValidatedAt: String(data?.crypto?.statsFetchedAt || data?.editionId || '').trim()
    };
  } catch (_error) {
    return { stats: [], dominance: null, lastValidatedAt: '' };
  }
}

function dominanceValuesValid(dominance) {
  if (!dominance || typeof dominance !== 'object' || Array.isArray(dominance)) return false;
  const values = ['btc', 'eth', 'others'].map((key) => {
    const text = String(dominance[key] || '').trim();
    return /^\d+(?:\.\d+)?%$/.test(text) ? Number(text.slice(0, -1)) : NaN;
  });
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) <= 0.02;
}

function unavailableCryptoDominance(checkedAt, error = null) {
  return {
    availability: {
      status: 'unavailable',
      reason: 'source_refresh_failed',
      checkedAt: new Date(checkedAt).toISOString(),
      ...(error ? { message: error?.message || String(error) } : {})
    }
  };
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
  const canonical = canonicalCryptoState(args.input);
  const priorBySymbol = new Map(canonical.stats.map((row) => [row?.sym, row]));
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
    const lastValidatedAt = String(prior?.availability?.lastValidatedAt || canonical.lastValidatedAt).trim();
    // Partial refresh keeps independent cards fresh while marking only the
    // failed provider's prior card as carried-forward or unavailable.
    const stat = prior
      ? {
        ...prior,
        availability: {
          status: 'carried_forward',
          reason: 'source_refresh_failed',
          checkedAt: checkedAt.toISOString(),
          ...(lastValidatedAt ? { lastValidatedAt } : {})
        }
      }
      : unavailableCryptoStat(task.sym, task.name, checkedAt, result.reason);
    stats.push(stat);
    details[task.key] = { source: 'Unavailable', stat };
  });
  const totalResult = settled[tasks.findIndex((task) => task.key === 'totalMarketCap')];
  let dominance = totalResult?.status === 'fulfilled' && dominanceValuesValid(totalResult.value?.dominance)
    ? totalResult.value.dominance
    : unavailableCryptoDominance(checkedAt, totalResult?.status === 'rejected' ? totalResult.reason : 'dominance unavailable');
  if (totalResult?.status === 'rejected' && dominanceValuesValid(canonical.dominance)) {
    dominance = {
      ...structuredClone(canonical.dominance),
      availability: {
        status: 'carried_forward',
        reason: 'source_refresh_failed',
        checkedAt: checkedAt.toISOString(),
        ...(canonical.lastValidatedAt ? { lastValidatedAt: canonical.lastValidatedAt } : {})
      }
    };
  }
  return {
    fetchedAt: checkedAt.toISOString(),
    stats,
    dominance,
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
    dominance: totalMarketCap.dominance,
    fearGreed,
    altcoinSeason,
    totalMarketCap
  };
  return normalized;
}

function buildCryptoStatsFallback(canonicalCrypto, checkedAt = new Date(), reason = 'source_refresh_failed', legacyLastValidatedAt = '') {
  const timestamp = new Date(checkedAt).toISOString();
  const canonicalLastValidatedAt = String(canonicalCrypto?.statsFetchedAt || legacyLastValidatedAt || '').trim();
  // Whole-section fallback is used by preparation orchestration after the
  // partial fetcher itself cannot run or validate.
  const stats = Array.isArray(canonicalCrypto?.stats)
    ? structuredClone(canonicalCrypto.stats).map((row) => row?.availability?.status === 'unavailable'
      ? row
      : {
        ...row,
        availability: {
          status: 'carried_forward',
          reason,
          checkedAt: timestamp,
          ...(String(row?.availability?.lastValidatedAt || canonicalLastValidatedAt).trim()
            ? { lastValidatedAt: String(row?.availability?.lastValidatedAt || canonicalLastValidatedAt).trim() }
            : {})
        }
      })
    : [];
  const dominance = dominanceValuesValid(canonicalCrypto?.dominance)
    ? {
      ...structuredClone(canonicalCrypto.dominance),
      availability: {
        status: 'carried_forward',
        reason,
        checkedAt: timestamp,
        ...(canonicalLastValidatedAt ? { lastValidatedAt: canonicalLastValidatedAt } : {})
      }
    }
    : unavailableCryptoDominance(timestamp);
  return {
    fetchedAt: timestamp,
    stats,
    dominance,
    availability: {
      status: stats.length ? 'carried_forward' : 'unavailable',
      reason,
      checkedAt: timestamp
    }
  };
}

function validateCryptoStatsPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Crypto stats staging payload must be an object.'];
  const unavailable = payload.availability?.status === 'unavailable';
  const partial = payload.availability?.status === 'partial';
  const carriedForward = payload.availability?.status === 'carried_forward';
  if (!isIsoDateTime(payload.fetchedAt)) errors.push('Crypto stats staging fetchedAt must be an offset-bearing ISO timestamp.');
  if (!Array.isArray(payload.stats)) return ['Crypto stats staging stats must be an array.'];
  if (unavailable) {
    if (payload.stats.length) errors.push('Unavailable Crypto stats staging must contain no rows.');
  } else {
    const seen = new Set();
    if (payload.stats.length !== CRYPTO_STAT_SYMBOLS.length) errors.push(`Crypto stats staging must contain exactly ${CRYPTO_STAT_SYMBOLS.length} rows.`);
    payload.stats.forEach((row, index) => {
      const label = `Crypto stats staging stats[${index}]`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(`${label} must be an object.`);
        return;
      }
      const symbol = String(row.sym || '');
      if (!CRYPTO_STAT_SYMBOLS.includes(symbol)) errors.push(`${label}.sym is unexpected: ${symbol || '(blank)'}.`);
      else if (seen.has(symbol)) errors.push(`Crypto stats staging contains duplicate symbol ${symbol}.`);
      else seen.add(symbol);
      const rowUnavailable = row.availability?.status === 'unavailable';
      for (const field of ['name', 'sub', 'price', 'delta', 'chg']) {
        if (typeof row[field] !== 'string') errors.push(`${label}.${field} must be a string.`);
      }
      for (const field of ['name', 'sub', 'price', 'delta']) {
        if (typeof row[field] === 'string' && !row[field].trim()) errors.push(`${label}.${field} must be populated.`);
      }
      if (!rowUnavailable && typeof row.chg === 'string' && !row.chg.trim()) errors.push(`${label}.chg must be populated.`);
      if (!['up', 'down', 'flat'].includes(row.dir)) errors.push(`${label}.dir must be up, down, or flat.`);
      if (!rowUnavailable && ['F&G', 'ALTSEASON'].includes(symbol)) {
        const score = Number(row.price);
        if (!Number.isFinite(score) || score < 0 || score > 100) errors.push(`${label}.price must be a score from 0 to 100.`);
      }
      if (!rowUnavailable && symbol === 'TOTAL' && ['price', 'delta', 'chg'].some((field) => typeof row[field] !== 'string' || !row[field].trim())) {
        errors.push(`${label} must contain populated price, delta, and chg values.`);
      }
      if (!rowUnavailable) {
        const directionText = symbol === 'TOTAL' ? row.chg : row.delta;
        const directionValue = Number.parseFloat(String(directionText || '').replace(/[^0-9+.-]/g, ''));
        const expectedDirection = Number.isFinite(directionValue)
          ? directionValue > 0 ? 'up' : directionValue < 0 ? 'down' : 'flat'
          : 'flat';
        if (row.dir !== expectedDirection) errors.push(`${label}.dir must match ${symbol === 'TOTAL' ? 'chg' : 'delta'}.`);
      }
      if (row.availability !== undefined) {
        if (!['carried_forward', 'unavailable'].includes(row.availability?.status)) errors.push(`${label}.availability.status must be carried_forward or unavailable.`);
        if (row.availability?.reason !== 'source_refresh_failed') errors.push(`${label}.availability.reason must be source_refresh_failed.`);
        if (!isIsoDateTime(row.availability?.checkedAt)) errors.push(`${label}.availability.checkedAt must be an offset-bearing ISO timestamp.`);
      }
    });
    for (const symbol of CRYPTO_STAT_SYMBOLS) {
      if (!seen.has(symbol)) errors.push(`Crypto stats staging is missing ${symbol}.`);
    }
  }
  if (payload.availability !== undefined) {
    if (!['partial', 'carried_forward', 'unavailable'].includes(payload.availability?.status)) errors.push('Crypto stats staging availability.status must be partial, carried_forward, or unavailable.');
    if (payload.availability?.reason !== 'source_refresh_failed') errors.push('Crypto stats staging availability.reason must be source_refresh_failed.');
    if (!isIsoDateTime(payload.availability?.checkedAt)) errors.push('Crypto stats staging availability.checkedAt must be an offset-bearing ISO timestamp.');
    if (partial && (!Array.isArray(payload.availability.failures) || !payload.availability.failures.length)) errors.push('Partial Crypto stats staging availability.failures must be a non-empty array.');
    if (!partial && payload.availability.failures !== undefined) errors.push('Non-partial Crypto stats staging availability.failures is not allowed.');
  }
  const dominanceUnavailable = payload.dominance?.availability?.status === 'unavailable';
  if (!dominanceUnavailable && !dominanceValuesValid(payload.dominance)) errors.push('Crypto stats staging dominance must contain BTC, ETH, and others percentages totaling 100%.');
  if (payload.dominance?.availability !== undefined) {
    if (!['carried_forward', 'unavailable'].includes(payload.dominance.availability?.status)) errors.push('Crypto stats staging dominance availability.status must be carried_forward or unavailable.');
    if (payload.dominance.availability?.reason !== 'source_refresh_failed') errors.push('Crypto stats staging dominance availability.reason must be source_refresh_failed.');
    if (!isIsoDateTime(payload.dominance.availability?.checkedAt)) errors.push('Crypto stats staging dominance availability.checkedAt must be an offset-bearing ISO timestamp.');
  }
  const degradedRows = payload.stats.filter((row) => row?.availability !== undefined);
  if (payload.availability === undefined) {
    if (degradedRows.length) errors.push('Healthy Crypto stats staging cannot contain row availability markers.');
    if (payload.dominance?.availability !== undefined) errors.push('Healthy Crypto stats staging cannot contain a dominance availability marker.');
  }
  if (carriedForward) {
    if (degradedRows.length !== payload.stats.length) errors.push('Carried-forward Crypto stats staging requires an availability marker on every row.');
    if (payload.dominance?.availability === undefined) errors.push('Carried-forward Crypto stats staging requires a dominance availability marker.');
  }
  if (unavailable && payload.dominance?.availability?.status !== 'unavailable') {
    errors.push('Unavailable Crypto stats staging requires unavailable dominance.');
  }
  if (partial && Array.isArray(payload.availability?.failures)) {
    const symbolByProvider = new Map([['fearGreed', 'F&G'], ['altcoinSeason', 'ALTSEASON'], ['totalMarketCap', 'TOTAL']]);
    const failedSymbols = new Set();
    for (const failure of payload.availability.failures) {
      const symbol = symbolByProvider.get(failure?.provider);
      if (!symbol) errors.push(`Crypto stats staging availability failure names unknown provider ${failure?.provider || '(blank)'}.`);
      else if (failedSymbols.has(symbol)) errors.push(`Crypto stats staging availability contains duplicate provider ${failure.provider}.`);
      else failedSymbols.add(symbol);
      if (typeof failure?.message !== 'string' || !failure.message.trim()) errors.push(`Crypto stats staging availability failure ${failure?.provider || '(blank)'} must include a message.`);
    }
    for (const row of payload.stats) {
      if (Boolean(row?.availability) !== failedSymbols.has(row?.sym)) errors.push(`Crypto stats staging availability failure must correspond to degraded row ${row?.sym || '(blank)'}.`);
    }
    if (Boolean(payload.dominance?.availability) !== failedSymbols.has('TOTAL')) errors.push('Crypto stats staging dominance availability must correspond to the TOTAL provider result.');
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
