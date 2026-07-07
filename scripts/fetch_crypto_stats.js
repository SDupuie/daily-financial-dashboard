#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'generated', 'crypto_stats.json');
const DEFAULT_DASHBOARD = path.resolve(process.cwd(), 'daily_financial_news.html');
const REQUEST_TIMEOUT_MS = 15000;
const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=2';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const ALTCOIN_SEASON_PAGE_URL = 'https://coinmarketcap.com/charts/altcoin-season-index/';
const ALTCOIN_SEASON_API_URL = 'https://api.coinmarketcap.com/data-api/v3/altcoin-season/chart';

function stampDashboardEdition(data) {
  return {
    ...data,
    editionId: new Date().toISOString()
  };
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    dashboard: '',
    timeoutMs: REQUEST_TIMEOUT_MS,
    lookbackDays: 31,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }

    if (arg === '--dashboard') {
      args.dashboard = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_DASHBOARD);
      i += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }

    if (arg === '--lookback-days') {
      args.lookbackDays = Math.max(7, Number(argv[i + 1] || 31));
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
  process.stdout.write(`Usage: node scripts/fetch_crypto_stats.js [options]

Options:
  --output PATH           JSON output path (default: generated/crypto_stats.json)
  --dashboard PATH        Optional dashboard HTML to patch with fetched crypto.stats[] rows
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

function dashboardDataRegion(html) {
  const region = html.match(/<!-- Daily refreshes update this quote\/story payload\. Chart history is embedded separately in chart-data below\. -->[\s\S]*?<!-- ============ DATA END ============ -->/);
  if (!region) {
    throw new Error('Could not find the marked dashboard-data region.');
  }
  const data = region[0].match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!data) {
    throw new Error('Could not find dashboard-data JSON inside the marked region.');
  }
  return { region: region[0], dataJson: data[1] };
}

function patchFooterCompiled(compiled, altcoinSeason) {
  if (typeof compiled !== 'string' || !compiled.trim()) return compiled;
  const replacement = `Altcoin Season uses the latest verified ${altcoinSeason.asOfDisplay} reading with the CoinMarketCap chart API prior-day comparison `;
  if (/Altcoin Season uses[^·]+/.test(compiled)) {
    return compiled.replace(/Altcoin Season uses[^·]+/, replacement);
  }
  return compiled;
}

function patchDashboard(html, normalized) {
  // Manual patch mode is limited to the dashboard-owned JSON region so helper use cannot drift surrounding markup.
  const { region, dataJson } = dashboardDataRegion(html);
  let dashboardData = JSON.parse(dataJson);
  const stats = dashboardData?.crypto?.stats;
  if (!Array.isArray(stats)) {
    throw new Error('dashboard-data crypto.stats is missing or invalid.');
  }

  const mapping = new Map(normalized.stats.map((row) => [row.sym, row]));
  for (const row of stats) {
    const sym = String(row?.sym || '').trim().toUpperCase();
    if (mapping.has(sym)) {
      Object.assign(row, mapping.get(sym));
    }
  }

  if (dashboardData?.footer?.compiled) {
    dashboardData.footer.compiled = patchFooterCompiled(dashboardData.footer.compiled, normalized.altcoinSeason);
  }

  dashboardData = stampDashboardEdition(dashboardData);

  const nextRegion = region.replace(
    /<script type="application\/json" id="dashboard-data">[\s\S]*?<\/script>/,
    `<script type="application/json" id="dashboard-data">${JSON.stringify(dashboardData, null, 2)}</script>`
  );

  return html.replace(region, nextRegion);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const normalized = await fetchCryptoStats(args);

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(normalized, null, 2)}\n`);

  let dashboardMessage = '';
  if (args.dashboard) {
    const html = fs.readFileSync(args.dashboard, 'utf8');
    const nextHtml = patchDashboard(html, normalized);
    fs.writeFileSync(args.dashboard, nextHtml);
    dashboardMessage = `; patched ${args.dashboard}`;
  }

  if (args.compact) {
    process.stdout.write(
      `F&G ${normalized.fearGreed.stat.price} ${normalized.fearGreed.stat.delta} | ` +
      `ALTSEASON ${normalized.altcoinSeason.stat.price} ${normalized.altcoinSeason.stat.delta} | ` +
      `TOTAL ${normalized.totalMarketCap.stat.price} ${normalized.totalMarketCap.stat.chg}${dashboardMessage}\n`
    );
    return;
  }

  process.stdout.write(`Wrote ${args.output}${dashboardMessage}\n`);
}

async function fetchCryptoStats(options = {}) {
  const args = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    lookbackDays: 31,
    ...options
  };
  const altcoinApiUrl = buildAltcoinSeasonApiUrl(args.lookbackDays);
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

module.exports = {
  REQUEST_TIMEOUT_MS,
  fetchCryptoStats,
  patchDashboard
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_crypto_stats failed: ${error.message}\n`);
    process.exit(1);
  });
}
