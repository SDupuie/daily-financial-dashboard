#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const {
  isIsoDateTime,
  sameDateTimeParts,
  validDateTimeParts,
  zonedDateParts,
  zonedTimeToUtc
} = require('./calendar_contract');
const {
  allowedNewsDates,
  candidateInFuturesPublicationWindow,
  canonicalStoryUrl,
  futuresStoryPublicationWindow,
  normalizeStoryTitle
} = require('./news_contract');
const {
  APPROVED_NEWS_SOURCES,
  MARKETAUX_TICKER_NEWS_PATHS,
  newsAcquisitionPaths
} = require('./news_sources');
const { atomicWriteJson } = require('./staging_writer');
const { mapConcurrent } = require('./fetch_concurrency');
const { singleScriptBlockById } = require('./dashboard_script_blocks');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.join(ROOT, 'generated', 'news_candidates.json');
const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const STOCKFIT_URL = 'https://api.stockfit.io/v1/api/lookup/news/market';
const MARKETAUX_URL = 'https://api.marketaux.com/v1/news/all';
const REUTERS_NEWS_SITEMAP_INDEX_URL = 'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml';
const REUTERS_NEWS_SITEMAP_URL = 'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml';
const ARTICLE_BYTE_LIMIT = 1_000_000;
const ARTICLE_EXCERPT_LIMIT = 5000;
const ARTICLE_CONCURRENCY = 8;
const ARTICLE_REVIEW_CANDIDATE_LIMIT = 250;
const REUTERS_SITEMAP_CONCURRENCY = 8;
const REUTERS_SITEMAP_MAX_SLICES = 100;
const REUTERS_SITEMAP_BODY_LIMIT = 2_000_000;
const ALPHA_VANTAGE_PACING_MS = 1250;
const NEWS_HTTP_MAX_HEADER_SIZE = 65536;
const NEWS_HTTP_MAX_REDIRECTS = 5;
const NEWS_HTTP_MAX_COMPRESSED_BODY_BYTES = 8_000_000;
const NEWS_HTTP_MAX_DECODED_BODY_BYTES = 8_000_000;
const PROVENANCE_PRIORITY = Object.freeze({ 'reuters-public': 5, 'ap-public': 4, rss: 3, 'alpha-vantage': 2, marketaux: 1, stockfit: 1 });
const MARKETAUX_TICKERS = new Set(MARKETAUX_TICKER_NEWS_PATHS.map((pathEntry) => pathEntry.ticker));
// Five free-tier pages provide up to 15 candidates per ticker while bounding
// all three configured ticker paths to 15 Marketaux requests per update.
const MARKETAUX_MAX_PAGES = 5;
const REUTERS_UNSUPPORTED_PATHS = new Set(['ar', 'de', 'default', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh']);
const STRICT_CRYPTO_TITLE_PATTERN = /\b(?:bitcoin|crypto(?:currenc(?:y|ies))?|ethereum|ether|stablecoins?|blockchain|digital[- ]assets?)\b/i;
const FIXED_ZONE_OFFSETS = Object.freeze({
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60
});
const GENERIC_ZONE_NAMES = Object.freeze({
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles'
});
const NAMED_ZONE_PATTERN = '(?:UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|ET|CT|MT|PT)';
const MONTH_NAMES = Object.freeze({
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
});

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    asOf: new Date(),
    searchTimeoutMs: 20000,
    articleTimeoutMs: 10000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '--output') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error(`${arg} requires a path.`);
      args[arg.slice(2)] = path.resolve(process.cwd(), argv[++index]);
      continue;
    }
    if (arg === '--as-of') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--as-of requires an ISO timestamp.');
      args.asOf = new Date(argv[++index]);
      if (Number.isNaN(args.asOf.getTime())) throw new Error('--as-of must be a valid ISO timestamp.');
      continue;
    }
    if (arg === '--search-timeout-ms' || arg === '--article-timeout-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${arg} must be a positive integer.`);
      args[arg === '--search-timeout-ms' ? 'searchTimeoutMs' : 'articleTimeoutMs'] = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/fetch_news_candidates.js [options]\n\nOptions:\n  --input PATH                 Dashboard or candidate HTML used for still-fresh prior cards\n  --output PATH                Staging output (default: generated/news_candidates.json)\n  --as-of TIMESTAMP            Fixed run timestamp used for News freshness\n  --search-timeout-ms N        Per-feed/API timeout (default: 20000)\n  --article-timeout-ms N       Per-article timeout (default: 10000)\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnv(file = path.join(ROOT, '.env')) {
  if (process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1' || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2] === '') continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function chicagoIsoDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function chicagoMidnight(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  const observed = zonedDateParts(new Date(guess), 'America/Chicago');
  const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
  return new Date(guess - (observedAsUtc - guess));
}

function alphaTimeFrom(eligibleDates) {
  const date = chicagoMidnight([...eligibleDates].sort()[0]);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

function newsHttpError(error) {
  if (!error) return new Error('HTTP request failed');
  if (error.message && error.code) return new Error(`${error.code}: ${error.message}`);
  if (error.message) return error;
  return new Error(String(error));
}

function responseHeaders(headers) {
  const byName = new Map(Object.entries(headers || {}).map(([key, value]) => [
    key.toLowerCase(),
    Array.isArray(value) ? value.join(', ') : String(value)
  ]));
  return {
    get(name) {
      return byName.get(String(name || '').toLowerCase()) || null;
    }
  };
}

function sameOriginRedirect(nextUrl, currentUrl) {
  return nextUrl.origin === currentUrl.origin;
}

function decodeResponseBody(buffer, encoding, maxDecodedBytes) {
  const normalized = String(encoding || '').toLowerCase().split(',')[0].trim();
  if (!normalized || normalized === 'identity') {
    if (buffer.length > maxDecodedBytes) {
      return Promise.reject(new Error(`HTTP response body exceeded ${maxDecodedBytes} decoded bytes`));
    }
    return Promise.resolve(buffer);
  }
  const options = { maxOutputLength: maxDecodedBytes };
  if (normalized === 'gzip' || normalized === 'x-gzip') {
    return new Promise((resolve, reject) => zlib.gunzip(buffer, options, (error, result) => (error ? reject(error) : resolve(result))));
  }
  if (normalized === 'deflate') {
    return new Promise((resolve, reject) => zlib.inflate(buffer, options, (error, result) => (error ? reject(error) : resolve(result))));
  }
  if (normalized === 'br' && typeof zlib.brotliDecompress === 'function') {
    return new Promise((resolve, reject) => zlib.brotliDecompress(buffer, options, (error, result) => (error ? reject(error) : resolve(result))));
  }
  if (buffer.length > maxDecodedBytes) {
    return Promise.reject(new Error(`HTTP response body exceeded ${maxDecodedBytes} decoded bytes`));
  }
  return Promise.resolve(buffer);
}

function requestNewsResponse(url, { timeoutMs, headers, deadline, maxBodyBytes, maxDecodedBytes, allowRedirect }, redirectCount) {
  const currentUrl = new URL(String(url));
  const client = currentUrl.protocol === 'https:' ? https : currentUrl.protocol === 'http:' ? http : null;
  if (!client) throw new Error(`Unsupported protocol ${currentUrl.protocol}`);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Request timed out after ${timeoutMs}ms`);
  const requestHeaders = { ...headers };
  if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'accept-encoding')) {
    requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let timer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(newsHttpError(error));
    };
    const succeed = (response) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(response);
    };
    const follow = (nextUrl, nextHeaders) => {
      if (settled) return;
      let nextRequest;
      try {
        nextRequest = requestNewsResponse(nextUrl, {
          timeoutMs,
          headers: nextHeaders,
          deadline,
          maxBodyBytes,
          maxDecodedBytes,
          allowRedirect
        }, redirectCount + 1);
      } catch (error) {
        fail(error);
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(nextRequest);
    };

    timer = setTimeout(() => {
      const error = new Error(`Request timed out after ${timeoutMs}ms`);
      if (req) req.destroy(error);
      fail(error);
    }, remainingMs);

    try {
      req = client.request(currentUrl, {
        method: 'GET',
        headers: requestHeaders,
        maxHeaderSize: NEWS_HTTP_MAX_HEADER_SIZE
      }, (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('Redirect response ended before completion')));
          res.resume();
          res.on('end', () => {
            try {
              if (redirectCount >= NEWS_HTTP_MAX_REDIRECTS) {
                fail(new Error(`Too many redirects after ${NEWS_HTTP_MAX_REDIRECTS}`));
                return;
              }
              const nextUrl = new URL(location, currentUrl);
              if (nextUrl.username || nextUrl.password || !allowRedirect(nextUrl, currentUrl)) {
                fail(new Error('Redirect target is outside the request policy.'));
                return;
              }
              const nextHeaders = { ...requestHeaders };
              if (nextUrl.origin !== currentUrl.origin) {
                for (const key of Object.keys(nextHeaders)) {
                  if (key.toLowerCase() === 'authorization') delete nextHeaders[key];
                }
              }
              follow(nextUrl, nextHeaders);
            } catch (error) {
              fail(error);
            }
          });
          return;
        }

        const chunks = [];
        let receivedBytes = 0;
        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBodyBytes) {
            const error = new Error(`HTTP response body exceeded ${maxBodyBytes} compressed bytes`);
            fail(error);
            res.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Response ended before completion')));
        res.on('end', async () => {
          try {
            const compressed = Buffer.concat(chunks);
            const decoded = await decodeResponseBody(compressed, res.headers['content-encoding'], maxDecodedBytes);
            const response = {
              ok: status >= 200 && status < 300,
              status,
              url: currentUrl.toString(),
              headers: responseHeaders(res.headers),
              async text() {
                return decoded.toString('utf8');
              },
              async json() {
                return JSON.parse(decoded.toString('utf8'));
              }
            };
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            succeed(response);
          } catch (error) {
            fail(error);
          }
        });
      });
      req.on('error', fail);
      req.end();
    } catch (error) {
      fail(error);
    }
  });
}

async function fetchResponse(url, {
  timeoutMs,
  headers = {},
  maxBodyBytes = NEWS_HTTP_MAX_COMPRESSED_BODY_BYTES,
  maxDecodedBytes = NEWS_HTTP_MAX_DECODED_BODY_BYTES,
  allowRedirect = sameOriginRedirect
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Request timeout must be a positive number');
  }
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0 || !Number.isFinite(maxDecodedBytes) || maxDecodedBytes <= 0) {
    throw new Error('HTTP body limits must be positive numbers');
  }
  if (typeof allowRedirect !== 'function') {
    throw new Error('HTTP redirect policy must be a function');
  }
  return requestNewsResponse(url, {
    timeoutMs,
    headers,
    deadline: Date.now() + timeoutMs,
    maxBodyBytes,
    maxDecodedBytes,
    allowRedirect
  }, 0);
}

async function fetchAlphaVantage(acquisitionPath, { eligibleDates, timeoutMs, env = process.env, fetchPage = fetchResponse }) {
  const apiKey = String(env.ALPHA_VANTAGE_API_KEY || '').trim();
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not configured.');
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set('function', 'NEWS_SENTIMENT');
  url.searchParams.set('topics', acquisitionPath.topic);
  url.searchParams.set('time_from', alphaTimeFrom(eligibleDates));
  url.searchParams.set('sort', 'LATEST');
  url.searchParams.set('limit', '1000');
  url.searchParams.set('apikey', apiKey);
  const response = await fetchPage(url, { timeoutMs, headers: { Accept: 'application/json' } });
  const payload = await response.json();
  if (payload?.Information || payload?.Note || payload?.['Error Message']) {
    const message = String(payload.Information || payload.Note || payload['Error Message']);
    throw new Error(message.replaceAll(apiKey, '[redacted]'));
  }
  if (!Array.isArray(payload?.feed)) throw new Error('Alpha Vantage response must contain feed[].');
  return { items: payload.feed.map((item) => ({
    title: item.title,
    url: item.url,
    publishedAt: parseAlphaPublishedAt(item.time_published),
    summary: item.summary,
    providerSourceName: item.source
  })) };
}

async function fetchStockfit(acquisitionPath, { timeoutMs, env = process.env, fetchPage = fetchResponse }) {
  const apiKey = String(env.STOCKFIT_API_KEY || '').trim();
  if (!apiKey) throw new Error('STOCKFIT_API_KEY is not configured.');
  const url = new URL(STOCKFIT_URL);
  url.searchParams.set('limit', String(acquisitionPath.limit || 50));
  const response = await fetchPage(url, {
    timeoutMs,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
    }
  });
  const payload = await response.json();
  if (!Array.isArray(payload?.news)) throw new Error('StockFit response must contain news[].');
  return { items: payload.news.map((item) => ({
    title: item.title,
    url: item.link,
    publishedAt: item.publishedAt,
    summary: item.summary,
    providerSourceName: item.source
  })) };
}

async function fetchMarketaux(acquisitionPath, { eligibleDates, timeoutMs, env = process.env, fetchPage = fetchResponse }) {
  const apiKey = String(env.MARKETAUX_API_KEY || '').trim();
  if (!apiKey) throw new Error('MARKETAUX_API_KEY is not configured.');
  const ticker = marketauxTickerForPath(acquisitionPath);
  if (!ticker) throw new Error('Marketaux requests are limited to configured single-ticker paths.');
  const earliestEligibleDate = [...eligibleDates].sort()[0];
  if (!earliestEligibleDate) throw new Error('Marketaux requires at least one eligible News date.');
  const publishedAfter = chicagoMidnight(earliestEligibleDate).toISOString().slice(0, 19);
  const requestPage = async (page) => {
    const url = new URL(MARKETAUX_URL);
    url.searchParams.set('search', `"${ticker}"`);
    url.searchParams.set('language', 'en');
    url.searchParams.set('published_after', publishedAfter);
    url.searchParams.set('sort', 'relevance_score');
    url.searchParams.set('limit', String(acquisitionPath.limit || 3));
    url.searchParams.set('page', String(page));
    url.searchParams.set('api_token', apiKey);
    const response = await fetchPage(url, { timeoutMs, headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (payload?.error) {
      const message = String(payload.error.message || payload.error.code || 'Marketaux request failed.');
      throw new Error(message.replaceAll(apiKey, '[redacted]'));
    }
    if (!Array.isArray(payload?.data)) throw new Error('Marketaux response must contain data[].');
    return payload;
  };
  const firstPayload = await requestPage(1);
  if (Number(firstPayload.meta?.page) !== 1) {
    throw new Error('Marketaux response page metadata did not match requested page 1.');
  }
  const found = Number(firstPayload.meta?.found);
  const pageLimit = Number(firstPayload.meta?.limit);
  if (!Number.isInteger(found) || found < 0 || found > 20_000
    || !Number.isInteger(pageLimit) || pageLimit <= 0) {
    throw new Error('Marketaux response must contain valid bounded meta.found and meta.limit values.');
  }
  const items = [...firstPayload.data];
  const pageErrors = [];
  const reportedPageCount = Math.ceil(found / pageLimit);
  const pageCount = Math.min(reportedPageCount, MARKETAUX_MAX_PAGES);
  for (let page = 2; page <= pageCount; page += 1) {
    try {
      const payload = await requestPage(page);
      if (Number(payload.meta?.page) !== page) {
        throw new Error(`response page metadata did not match requested page ${page}`);
      }
      items.push(...payload.data);
    } catch (error) {
      pageErrors.push(`page ${page}: ${String(error?.message || error)}`);
      break;
    }
  }
  if (!pageErrors.length && reportedPageCount <= MARKETAUX_MAX_PAGES && items.length < found) {
    pageErrors.push(`received ${items.length} of ${found} reported results`);
  }
  return {
    items: items.map((item) => ({
      title: item.title,
      url: item.url,
      publishedAt: item.published_at,
      summary: item.description || item.snippet,
      providerSourceName: item.source,
      providerRelevanceScore: item.relevance_score
    })),
    ...(pageErrors.length ? { error: `Marketaux ${ticker} pagination partial: ${pageErrors.join('; ')}` } : {})
  };
}

async function fetchRss(acquisitionPath, { timeoutMs }) {
  const response = await fetchResponse(acquisitionPath.feedUrl, {
    timeoutMs,
    headers: {
      Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
      'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
    }
  });
  const xml = await response.text();
  if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error('RSS response is not a feed document.');
  const items = parseNewsFeed(xml);
  if (!items.length) throw new Error('RSS response contains no items.');
  return { items };
}

async function fetchApPublic(acquisitionPath, { timeoutMs }) {
  const response = await fetchResponse(acquisitionPath.feedUrl, {
    timeoutMs,
    headers: {
      Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
      'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
    }
  });
  const xml = await response.text();
  if (!/<urlset\b/i.test(xml)) throw new Error('AP news sitemap response is not a urlset document.');
  const items = parseApNewsSitemap(xml);
  if (!items.length) throw new Error('AP news sitemap contains no English article items.');
  return { items };
}

async function fetchAcquisitionPath(acquisitionPath, options) {
  if (acquisitionPath.provider === 'alpha-vantage') return fetchAlphaVantage(acquisitionPath, options);
  if (acquisitionPath.provider === 'stockfit') return fetchStockfit(acquisitionPath, options);
  if (acquisitionPath.provider === 'marketaux') return fetchMarketaux(acquisitionPath, options);
  if (acquisitionPath.provider === 'rss') return fetchRss(acquisitionPath, options);
  if (acquisitionPath.provider === 'ap-public') return fetchApPublic(acquisitionPath, options);
  if (acquisitionPath.provider === 'reuters-public') return fetchReutersPublic(acquisitionPath, options);
  throw new Error(`Unsupported News provider ${acquisitionPath.provider}.`);
}

function parseAlphaPublishedAt(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function hasExplicitTimestampZone(value) {
  if (value instanceof Date) return true;
  const text = String(value || '').trim();
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || new RegExp(`\\b${NAMED_ZONE_PATTERN}\\b`, 'i').test(text);
}

function normalizeMeridiemSpacing(value) {
  return String(value || '').replace(/(\d)(AM|PM)\b/gi, '$1 $2');
}

function adjustedHour(hour, meridiem) {
  if (!meridiem) return hour;
  if (hour < 1 || hour > 12) return 24;
  const upper = meridiem.toUpperCase();
  if (upper === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function structuredTimestampParts(value) {
  // Match only the timestamp shapes this fetcher intentionally supports. A null
  // result lets genuinely unstructured strings reach Date fallback; a matched
  // but invalid result is rejected before Date can roll it to another day.
  const text = normalizeMeridiemSpacing(value).trim();
  let match = text.match(new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:[T\\s](\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}|${NAMED_ZONE_PATTERN}))?)?$`, 'i'));
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] || 0),
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0)
    };
  }
  match = text.match(new RegExp(`^(?:[A-Za-z]{3},\\s*)?(\\d{1,2})\\s+([A-Za-z]{3,9})\\s+(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}|${NAMED_ZONE_PATTERN}))?)?$`, 'i'));
  if (match) {
    const month = MONTH_NAMES[match[2].toLowerCase()];
    if (!month) return null;
    return {
      year: Number(match[3]),
      month,
      day: Number(match[1]),
      hour: adjustedHour(Number(match[4] || 0), match[7]),
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0)
    };
  }
  match = text.match(new RegExp(`^(?:[A-Za-z]{3},\\s*)?([A-Za-z]{3,9})\\s+(\\d{1,2}),\\s*(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}|${NAMED_ZONE_PATTERN}))?)?$`, 'i'));
  if (!match) return null;
  const month = MONTH_NAMES[match[1].toLowerCase()];
  if (!month) return null;
  return {
    year: Number(match[3]),
    month,
    day: Number(match[2]),
    hour: adjustedHour(Number(match[4] || 0), match[7]),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0)
  };
}

function structuredTimestampIsMalformed(value) {
  const parts = structuredTimestampParts(value);
  return parts ? !validDateTimeParts(parts) : false;
}

function dateForNamedZone(parts, zone) {
  if (!validDateTimeParts(parts)) return null;
  const upperZone = String(zone || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(FIXED_ZONE_OFFSETS, upperZone)) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
      - FIXED_ZONE_OFFSETS[upperZone] * 60000);
  }
  const timeZone = GENERIC_ZONE_NAMES[upperZone];
  if (!timeZone) return null;
  const date = zonedTimeToUtc(parts, timeZone);
  return sameDateTimeParts(parts, zonedDateParts(date, timeZone)) ? date : null;
}

function parseNamedZoneTimestamp(value) {
  const text = normalizeMeridiemSpacing(value).trim();
  const isoMatch = text.match(new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})[T\\s](\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?\\s*(${NAMED_ZONE_PATTERN})$`, 'i'));
  if (isoMatch) {
    return dateForNamedZone({
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
      hour: Number(isoMatch[4]),
      minute: Number(isoMatch[5]),
      second: Number(isoMatch[6] || 0)
    }, isoMatch[7]);
  }
  const rfcDayMonthMatch = text.match(new RegExp(`^(?:[A-Za-z]{3},\\s*)?(\\d{1,2})\\s+([A-Za-z]{3,9})\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?\\s*(${NAMED_ZONE_PATTERN})$`, 'i'));
  if (rfcDayMonthMatch) {
    const month = MONTH_NAMES[rfcDayMonthMatch[2].toLowerCase()];
    if (!month) return null;
    return dateForNamedZone({
      year: Number(rfcDayMonthMatch[3]),
      month,
      day: Number(rfcDayMonthMatch[1]),
      hour: adjustedHour(Number(rfcDayMonthMatch[4]), rfcDayMonthMatch[7]),
      minute: Number(rfcDayMonthMatch[5]),
      second: Number(rfcDayMonthMatch[6] || 0)
    }, rfcDayMonthMatch[8]);
  }
  const monthMatch = text.match(new RegExp(`^(?:[A-Za-z]{3},\\s*)?([A-Za-z]{3,9})\\s+(\\d{1,2}),\\s*(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?\\s*(${NAMED_ZONE_PATTERN})$`, 'i'));
  if (!monthMatch) return null;
  const month = MONTH_NAMES[monthMatch[1].toLowerCase()];
  if (!month) return null;
  return dateForNamedZone({
    year: Number(monthMatch[3]),
    month,
    day: Number(monthMatch[2]),
    hour: adjustedHour(Number(monthMatch[4]), monthMatch[7]),
    minute: Number(monthMatch[5]),
    second: Number(monthMatch[6] || 0)
  }, monthMatch[8]);
}

function parseNewsTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const text = String(value || '').trim();
  if (!text) return null;
  if (structuredTimestampIsMalformed(text)) return null;
  const namedZoneDate = parseNamedZoneTimestamp(text);
  if (namedZoneDate && !Number.isNaN(namedZoneDate.getTime())) return namedZoneDate;
  if (hasExplicitTimestampZone(text)) {
    const explicitDate = new Date(normalizeMeridiemSpacing(text));
    if (!Number.isNaN(explicitDate.getTime())) return explicitDate;
  }
  const isoWithoutZone = text.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/);
  if (isoWithoutZone) {
    const utcDate = new Date(`${isoWithoutZone[1]}T${isoWithoutZone[2]}Z`);
    if (!Number.isNaN(utcDate.getTime())) return utcDate;
  }
  const assumedGmtDate = new Date(`${normalizeMeridiemSpacing(text)} GMT`);
  if (!Number.isNaN(assumedGmtDate.getTime())) return assumedGmtDate;
  return null;
}

function decodeHtml(value) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function plainText(value) {
  return decodeHtml(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function highConfidenceCryptoTitle(value) {
  return STRICT_CRYPTO_TITLE_PATTERN.test(plainText(value));
}

function xmlValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return plainText(block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'))?.[1]);
}

function parseNewsFeed(xml) {
  const rssItems = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const atomItems = [...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  return [...rssItems, ...atomItems].map((block) => {
    const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
    const publishedAt = xmlValue(block, 'pubDate') || xmlValue(block, 'dc:date') || xmlValue(block, 'published');
    return {
      title: xmlValue(block, 'title'),
      url: xmlValue(block, 'link') || decodeHtml(atomLink || ''),
      publishedAt,
      summary: xmlValue(block, 'description') || xmlValue(block, 'summary') || xmlValue(block, 'content:encoded')
    };
  });
}

function parseApNewsSitemap(xml) {
  const urlBlocks = [...String(xml).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map((match) => match[1]);
  return urlBlocks.map((block) => {
    const url = canonicalStoryUrl(xmlValue(block, 'loc'));
    const publishedAt = firstValidDate([xmlValue(block, 'news:publication_date')]);
    return {
      title: xmlValue(block, 'news:title'),
      url,
      publishedAt: publishedAt ? publishedAt.toISOString() : '',
      language: xmlValue(block, 'news:language'),
      publishedAtVerified: true
    };
  }).filter((item) => item.language === 'eng'
    && /^https:\/\/apnews\.com\/article\//.test(item.url)
    && item.title
    && item.publishedAt);
}

function reutersSitemapPageUrl(value) {
  try {
    const sourceUrl = new URL(decodeHtml(value));
    if (sourceUrl.protocol !== 'https:'
      || sourceUrl.hostname !== 'www.reuters.com'
      || sourceUrl.pathname !== '/arc/outboundfeeds/news-sitemap/'
      || sourceUrl.searchParams.get('outputType') !== 'xml') return '';
    const rawOffset = sourceUrl.searchParams.get('from');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isInteger(offset)
      || offset < 0
      || offset > (REUTERS_SITEMAP_MAX_SLICES - 1) * 100
      || offset % 100 !== 0) return '';
    const target = new URL(REUTERS_NEWS_SITEMAP_URL);
    target.searchParams.set('size', '100');
    if (offset) target.searchParams.set('from', String(offset));
    return target.toString();
  } catch (_error) {
    return '';
  }
}

function parseReutersNewsSitemapIndex(xml) {
  if (typeof xml !== 'string'
    || !/^\s*(?:<\?xml\b[^?]*\?>\s*)?<sitemapindex\b[\s\S]*<\/sitemapindex>\s*$/i.test(xml)) {
    throw new Error('Reuters News sitemap index is not a sitemapindex document.');
  }
  const openingCount = [...xml.matchAll(/<sitemap\b[^>]*>/gi)].length;
  const closingCount = [...xml.matchAll(/<\/sitemap\s*>/gi)].length;
  const blocks = [...xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap\s*>/gi)].map((match) => match[1]);
  if (!blocks.length || blocks.length !== openingCount || blocks.length !== closingCount) {
    throw new Error('Reuters News sitemapindex contains malformed sitemap entries.');
  }
  if (blocks.length > REUTERS_SITEMAP_MAX_SLICES) {
    throw new Error(`Reuters News sitemap index exceeds ${REUTERS_SITEMAP_MAX_SLICES} slices.`);
  }
  const urls = blocks.map((block) => reutersSitemapPageUrl(xmlValue(block, 'loc')));
  if (!urls.length || urls.some((url) => !url)) {
    throw new Error('Reuters News sitemap index contains an invalid page URL.');
  }
  const uniqueUrls = [...new Set(urls)];
  const offsets = uniqueUrls.map((url) => Number(new URL(url).searchParams.get('from') || 0)).sort((left, right) => left - right);
  if (uniqueUrls.length !== urls.length
    || offsets.some((offset, index) => offset !== index * 100)) {
    throw new Error('Reuters News sitemap index contains duplicate or non-contiguous page offsets.');
  }
  return [...uniqueUrls].sort((left, right) => Number(new URL(left).searchParams.get('from') || 0)
    - Number(new URL(right).searchParams.get('from') || 0));
}

function englishReutersArticleUrl(value) {
  const url = canonicalStoryUrl(value);
  if (!url || sourceForUrl(url)?.id !== 'reuters' || !articlePathUrl(url)) return '';
  const firstPath = new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
  return REUTERS_UNSUPPORTED_PATHS.has(firstPath) ? '' : url;
}

function parseReutersNewsSitemap(xml) {
  if (typeof xml !== 'string'
    || !/^\s*(?:<\?xml\b[^?]*\?>\s*)?<urlset\b[\s\S]*<\/urlset>\s*$/i.test(xml)) {
    throw new Error('Reuters News sitemap page is not a urlset document.');
  }
  const openingCount = [...xml.matchAll(/<url\b[^>]*>/gi)].length;
  const closingCount = [...xml.matchAll(/<\/url\s*>/gi)].length;
  const blocks = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi)].map((match) => match[1]);
  if (!blocks.length || blocks.length !== openingCount || blocks.length !== closingCount) {
    throw new Error('Reuters News sitemap urlset contains malformed or no URL entries.');
  }
  const entries = blocks.map((block) => {
    const url = englishReutersArticleUrl(xmlValue(block, 'loc'));
    const title = xmlValue(block, 'news:title');
    const publicationName = xmlValue(block, 'news:name');
    const language = xmlValue(block, 'news:language');
    const publishedAt = xmlValue(block, 'news:publication_date');
    return {
      title,
      url,
      publishedAt,
      language,
      publicationName,
      providerSourceName: 'Reuters',
      publishedAtVerified: true
    };
  }).filter((entry) => entry.url
    && entry.title
    && entry.publicationName === 'Reuters'
    && entry.language === 'en'
    && isIsoDateTime(entry.publishedAt));
  if (!entries.length) {
    throw new Error('Reuters News sitemap urlset contains no valid English article entries.');
  }
  return entries;
}

async function fetchReutersPublic(acquisitionPath, { timeoutMs, fetchPage = fetchResponse } = {}) {
  if (acquisitionPath?.feedUrl !== REUTERS_NEWS_SITEMAP_INDEX_URL) {
    throw new Error('Reuters News sitemap acquisition requires its fixed public index URL.');
  }
  const headers = {
    Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
    'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
  };
  const indexResponse = await fetchPage(acquisitionPath.feedUrl, {
    timeoutMs,
    headers,
    maxBodyBytes: REUTERS_SITEMAP_BODY_LIMIT,
    maxDecodedBytes: REUTERS_SITEMAP_BODY_LIMIT,
    allowRedirect: (nextUrl) => nextUrl.toString() === REUTERS_NEWS_SITEMAP_INDEX_URL
  });
  if (indexResponse.url && new URL(indexResponse.url).toString() !== REUTERS_NEWS_SITEMAP_INDEX_URL) {
    throw new Error('Reuters News sitemap index redirected outside its fixed endpoint.');
  }
  const pageUrls = parseReutersNewsSitemapIndex(await indexResponse.text());
  const pages = await mapConcurrent(pageUrls, REUTERS_SITEMAP_CONCURRENCY, async (url) => {
    try {
      const response = await fetchPage(url, {
        timeoutMs,
        headers,
        maxBodyBytes: REUTERS_SITEMAP_BODY_LIMIT,
        maxDecodedBytes: REUTERS_SITEMAP_BODY_LIMIT,
        allowRedirect: (nextUrl) => nextUrl.toString() === url
      });
      if (response.url && new URL(response.url).toString() !== url) {
        throw new Error('Reuters News sitemap page redirected outside its indexed endpoint.');
      }
      return { entries: parseReutersNewsSitemap(await response.text()), error: null };
    } catch (error) {
      return { entries: [], error: String(error?.message || error) };
    }
  });
  const pageErrors = pages.map((page, index) => page.error ? { url: pageUrls[index], error: page.error } : null).filter(Boolean);
  return {
    items: pages.flatMap((page) => page.entries),
    pageCount: pageUrls.length,
    failedPageCount: pageErrors.length,
    ...(pageErrors.length ? { error: `Reuters News sitemap partial: ${pageErrors.length} of ${pageUrls.length} slices failed.` } : {})
  };
}

function sourceForUrl(value) {
  let hostname;
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_error) {
    return null;
  }
  return APPROVED_NEWS_SOURCES.find((source) => source.domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  )) || null;
}

function marketauxTickerForPath(acquisitionPath) {
  const ticker = String(acquisitionPath?.ticker || '').toUpperCase();
  return acquisitionPath?.provider === 'marketaux'
    && MARKETAUX_TICKERS.has(ticker)
    && MARKETAUX_TICKER_NEWS_PATHS.some((pathEntry) => pathEntry.id === acquisitionPath.id && pathEntry.ticker === ticker)
    ? ticker
    : '';
}

function publisherHostname(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const address = hostname.replace(/^\[|\]$/g, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || net.isIP(address)) return '';
    return hostname;
  } catch (_error) {
    return '';
  }
}

function articleRedirectAllowed(candidateUrl, nextUrl) {
  const candidateHostname = publisherHostname(candidateUrl);
  const nextHostname = publisherHostname(nextUrl);
  if (!candidateHostname || !nextHostname) return false;
  const source = sourceForUrl(candidateUrl);
  if (source) {
    return sourceForUrl(nextUrl.toString())?.id === source.id;
  }
  return nextHostname === candidateHostname;
}

function normalizeProviderCandidate(item, acquisitionPath, eligibleDates) {
  const url = canonicalStoryUrl(item?.url);
  const source = sourceForUrl(url);
  const tickerSearchSymbol = marketauxTickerForPath(acquisitionPath);
  // Normalize before the Chicago-date freshness check; malformed structured
  // provider timestamps must be rejected instead of rolling into an eligible day.
  const publishedAt = parseNewsTimestamp(item?.publishedAt);
  const title = plainText(item?.title);
  if (!url || (!source && !tickerSearchSymbol) || !publishedAt || !title) return null;
  const sourceDomain = publisherHostname(url);
  if (!sourceDomain) return null;
  const publishedOn = chicagoIsoDate(publishedAt);
  if (!eligibleDates.has(publishedOn)) return null;
  const pool = acquisitionPath.pool === 'cryptoCandidates'
    || highConfidenceCryptoTitle(title)
    ? 'cryptoCandidates'
    : acquisitionPath.pool;
  return {
    title,
    url,
    publishedOn,
    publishedAt: publishedAt.toISOString(),
    dateSource: source?.id === 'yahoo-finance' ? 'hosted_syndication' : 'provider_published',
    ...(item.publishedAtVerified === true && source?.id !== 'yahoo-finance' ? { publishedAtVerified: true } : {}),
    sourceId: source?.id || `marketaux:${sourceDomain}`,
    sourceLabel: source?.displayName || sourceDomain,
    sourceDomain,
    provider: acquisitionPath.provider,
    ...(plainText(item.summary) ? { providerSummary: plainText(item.summary) } : {}),
    ...(plainText(item.providerSourceName) ? { providerSourceName: plainText(item.providerSourceName) } : {}),
    ...(item.providerRelevanceScore !== null
      && item.providerRelevanceScore !== undefined
      && item.providerRelevanceScore !== ''
      && Number.isFinite(Number(item.providerRelevanceScore))
      ? { providerRelevanceScore: Number(item.providerRelevanceScore) }
      : {}),
    ...(item.article ? { article: item.article } : {}),
    ...(tickerSearchSymbol ? { tickerSearchSymbols: [tickerSearchSymbol] } : {}),
    origin: 'downloaded',
    pool,
    searchPathIds: [acquisitionPath.id]
  };
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return plainText(match[1]);
  }
  return '';
}

function firstValidDate(values) {
  // Page metadata often has several date fields. Prefer offset-bearing values so
  // an ambiguous JSON-LD datePublished cannot override a precise article time.
  const candidates = values.filter((value) => value instanceof Date || String(value || '').trim());
  for (const value of [
    ...candidates.filter(hasExplicitTimestampZone),
    ...candidates.filter((value) => !hasExplicitTimestampZone(value))
  ]) {
    const date = parseNewsTimestamp(value);
    if (date) return date;
  }
  return null;
}

function extractArticleMetadata(html) {
  const jsonDates = [...String(html).matchAll(/["']datePublished["']\s*:\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const timeDates = [...String(html).matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)].map((match) => match[1]);
  const publishedAt = firstValidDate([
    metaContent(html, 'article:published_time'),
    metaContent(html, 'datePublished'),
    ...jsonDates,
    ...timeDates
  ]);
  const paragraphs = [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[1]))
    .filter((value) => value.length >= 40);
  const excerpt = paragraphs.join(' ').slice(0, ARTICLE_EXCERPT_LIMIT);
  return {
    pageTitle: metaContent(html, 'og:title') || plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
    excerpt,
    publishedAt
  };
}

async function fetchArticlePage(candidate, { timeoutMs }) {
  const response = await fetchResponse(candidate.url, {
    timeoutMs,
    maxDecodedBytes: ARTICLE_BYTE_LIMIT,
    allowRedirect: (nextUrl) => articleRedirectAllowed(candidate.url, nextUrl),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
    }
  });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error(`Unsupported content type ${contentType || 'unknown'}`);
  }
  const html = (await response.text()).slice(0, ARTICLE_BYTE_LIMIT);
  return { ...extractArticleMetadata(html), finalUrl: canonicalStoryUrl(response.url || candidate.url) || candidate.url };
}

function readDashboardData(input) {
  if (!input || !fs.existsSync(input)) return null;
  const html = fs.readFileSync(input, 'utf8');
  return JSON.parse(singleScriptBlockById(html, 'dashboard-data', { type: 'application/json' }).content);
}

function priorCandidate(item, pool, eligibleDates) {
  const url = canonicalStoryUrl(item?.url);
  const title = String(item?.title || '').trim();
  const publishedOn = String(item?.publishedOn || '');
  const sourceLabel = String(item?.sourceLabel || '').trim();
  const tickerSearchSymbols = [...new Set((Array.isArray(item?.tickerSearchSymbols) ? item.tickerSearchSymbols : [])
    .map((ticker) => String(ticker || '').toUpperCase())
    .filter((ticker) => MARKETAUX_TICKERS.has(ticker)))];
  if (!url || !publisherHostname(url) || (!sourceForUrl(url) && !tickerSearchSymbols.length)
    || !title || !sourceLabel || !eligibleDates.has(publishedOn)) return null;
  return {
    title,
    url,
    publishedOn,
    sourceLabel,
    ...(isIsoDateTime(item?.publishedAt) ? { publishedAt: item.publishedAt } : {}),
    dateSource: 'prior_validated_card',
    origin: 'prior_card',
    priorCard: true,
    ...(tickerSearchSymbols.length ? { tickerSearchSymbols } : {}),
    priorCollection: pool,
    pool,
    priorCopy: {
      ...(item.tag ? { tag: item.tag } : {}),
      ...(item.body ? { body: item.body } : {})
    },
    searchPathIds: []
  };
}

function priorNewsCandidates(data, eligibleDates) {
  const general = [
    ...(Array.isArray(data?.stories) ? data.stories : []),
    ...(Array.isArray(data?.futuresModule?.stories) ? data.futuresModule.stories : [])
  ].map((item) => priorCandidate(item, 'generalCandidates', eligibleDates)).filter(Boolean);
  const crypto = (Array.isArray(data?.crypto?.notes) ? data.crypto.notes : [])
    .map((item) => priorCandidate(item, 'cryptoCandidates', eligibleDates)).filter(Boolean);
  return { generalCandidates: general, cryptoCandidates: crypto };
}

function candidateProvenancePriority(candidate) {
  return candidate.origin === 'downloaded' ? PROVENANCE_PRIORITY[candidate.provider] || 0 : -1;
}

function combineCandidate(preferred, other) {
  const searchPathIds = [...new Set([...(preferred.searchPathIds || []), ...(other.searchPathIds || [])])];
  const tickerSearchSymbols = [...new Set([...(preferred.tickerSearchSymbols || []), ...(other.tickerSearchSymbols || [])])];
  return {
    ...other,
    ...preferred,
    ...(preferred.pool === 'cryptoCandidates' || other.pool === 'cryptoCandidates' ? { pool: 'cryptoCandidates' } : {}),
    ...(preferred.priorCard || other.priorCard ? { priorCard: true } : {}),
    ...(preferred.priorCopy || other.priorCopy ? { priorCopy: preferred.priorCopy || other.priorCopy } : {}),
    ...(tickerSearchSymbols.length ? { tickerSearchSymbols } : {}),
    searchPathIds
  };
}

function deduplicateCandidates(candidates) {
  const selected = [];
  for (const candidate of candidates) {
    const titleKey = normalizeStoryTitle(candidate.title);
    const index = selected.findIndex((item) => item.url === candidate.url
      || (titleKey && normalizeStoryTitle(item.title) === titleKey));
    if (index < 0) {
      selected.push(candidate);
      continue;
    }
    const existing = selected[index];
    const preferred = candidateProvenancePriority(candidate) > candidateProvenancePriority(existing) ? candidate : existing;
    selected[index] = combineCandidate(preferred, preferred === candidate ? existing : candidate);
  }
  return selected;
}

function candidateOrder(left, right) {
  return String(right.publishedAt || `${right.publishedOn}T00:00:00Z`)
    .localeCompare(String(left.publishedAt || `${left.publishedOn}T00:00:00Z`))
    || left.url.localeCompare(right.url);
}

function articlePathUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname.split('/').filter(Boolean).length > 0;
  } catch (_error) {
    return false;
  }
}

function articleRecord(page) {
  return {
    accessible: true,
    finalUrl: page.finalUrl || '',
    pageTitle: page.pageTitle || '',
    description: page.description || '',
    excerpt: page.excerpt || ''
  };
}

async function reviewArticle(candidate, { eligibleDates, fetchArticle, articleTimeoutMs }) {
  let hostedPage;
  try {
    hostedPage = await fetchArticle(candidate, { timeoutMs: articleTimeoutMs });
    candidate.article = articleRecord(hostedPage);
    if (hostedPage.publishedAt) {
      const publishedOn = chicagoIsoDate(hostedPage.publishedAt);
      candidate.pagePublishedAt = hostedPage.publishedAt.toISOString();
      candidate.pagePublishedOn = publishedOn;
      candidate.pageDateFresh = eligibleDates.has(publishedOn);
      if (candidate.pageDateFresh) {
        candidate.publishedAt = candidate.pagePublishedAt;
        candidate.publishedOn = publishedOn;
        if (candidate.sourceId === 'yahoo-finance') {
          candidate.dateSource = 'hosted_syndication';
          delete candidate.publishedAtVerified;
        } else {
          candidate.dateSource = 'article_page';
          candidate.publishedAtVerified = true;
        }
      }
    }
  } catch (error) {
    candidate.article = { accessible: false, error: String(error?.message || error) };
  }
}

async function collectNewsCandidates({
  asOf = new Date(),
  dashboardData = null,
  acquisitionPaths = newsAcquisitionPaths(),
  searchTimeoutMs = 20000,
  articleTimeoutMs = 10000,
  fetchPath = fetchAcquisitionPath,
  fetchArticle = fetchArticlePage,
  offline = false,
  clock = () => new Date(),
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  env = process.env,
  onProgress = null
} = {}) {
  const eligibleDates = allowedNewsDates(asOf);
  const futuresWindow = futuresStoryPublicationWindow(
    dashboardData?.futuresModule?.sectionTitle,
    asOf.toISOString(),
    asOf,
    dashboardData?.futuresModule?.futures
  );
  // Futures selections follow the displayed session window, while the general
  // story pool keeps the normal News freshness dates.
  const futuresDates = Array.isArray(futuresWindow?.dates) && futuresWindow.dates.length
    ? new Set(futuresWindow.dates)
    : eligibleDates;
  const generalAcquisitionDates = futuresWindow
    ? new Set([...eligibleDates, ...futuresDates])
    : eligibleDates;
  const attemptsByIndex = Array(acquisitionPaths.length).fill(null);
  const downloadedByIndex = Array.from({ length: acquisitionPaths.length }, () => []);
  const normalizedDownloaded = [];
  const articleReview = {
    candidateLimit: ARTICLE_REVIEW_CANDIDATE_LIMIT,
    eligibleDownloadedCount: 0,
    reviewCandidateCount: 0,
    reviewedCount: 0,
    skippedCount: 0,
    concurrency: ARTICLE_CONCURRENCY,
    status: 'not_started'
  };
  const downloadedCandidates = () => downloadedByIndex.flat();
  const buildArtifact = (status = articleReview.status) => {
    const prior = priorNewsCandidates(dashboardData, eligibleDates);
    const futuresPrior = futuresWindow ? priorNewsCandidates(dashboardData, futuresDates) : prior;
    // Prior Futures cards compete only inside the Futures pool; they should not
    // stretch the broad-market freshness window after the displayed session rolls.
    const candidates = deduplicateCandidates([
      ...normalizedDownloaded.filter((candidate) => candidate.pageDateFresh !== false),
      ...prior.generalCandidates,
      ...prior.cryptoCandidates,
      ...futuresPrior.generalCandidates
    ]);
    return {
      schemaVersion: 2,
      generatedAt: asOf.toISOString(),
      finishedAt: clock().toISOString(),
      eligibleDates: [...eligibleDates].sort(),
      sourceCatalog: APPROVED_NEWS_SOURCES,
      attempts: attemptsByIndex.filter(Boolean),
      articleReview: { ...articleReview, status },
      generalCandidates: candidates
        .filter((candidate) => candidate.pool === 'generalCandidates' && eligibleDates.has(candidate.publishedOn))
        .sort(candidateOrder),
      futuresCandidates: candidates
        .filter((candidate) => candidate.pool === 'generalCandidates'
          && futuresDates.has(candidate.publishedOn)
          && (!futuresWindow || candidateInFuturesPublicationWindow(candidate, futuresWindow)))
        .sort(candidateOrder),
      cryptoCandidates: candidates
        .filter((candidate) => candidate.pool === 'cryptoCandidates')
        .sort(candidateOrder)
    };
  };
  const reportProgress = (status = articleReview.status) => {
    if (onProgress) onProgress(buildArtifact(status));
  };

  reportProgress('starting');

  async function fetchOnePath(acquisitionPath, index) {
    const pathEligibleDates = acquisitionPath.pool === 'generalCandidates' ? generalAcquisitionDates : eligibleDates;
    const attempt = {
      id: acquisitionPath.id,
      provider: acquisitionPath.provider,
      pool: acquisitionPath.pool,
      attemptedAt: clock().toISOString(),
      eligibleDates: [...pathEligibleDates].sort(),
      resultCount: 0,
      acceptedCount: 0,
      error: null
    };
    try {
      if (offline) throw new Error('Network disabled for offline test.');
      const result = await fetchPath(acquisitionPath, { eligibleDates: pathEligibleDates, timeoutMs: searchTimeoutMs, env });
      if (!Array.isArray(result?.items)) throw new Error(`${acquisitionPath.provider} result must contain items[].`);
      if (result.error) attempt.error = String(result.error);
      attempt.resultCount = result.items.length;
      for (const item of result.items) {
        const candidate = normalizeProviderCandidate(item, acquisitionPath, pathEligibleDates);
        if (!candidate) continue;
        downloadedByIndex[index].push(candidate);
        attempt.acceptedCount += 1;
      }
    } catch (error) {
      attempt.error = String(error?.message || error);
    }
    attemptsByIndex[index] = attempt;
    reportProgress('acquiring');
  }

  const groups = new Map();
  acquisitionPaths.forEach((acquisitionPath, index) => {
    const key = acquisitionPath.provider === 'alpha-vantage' ? 'provider:alpha-vantage' : `path:${acquisitionPath.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ acquisitionPath, index });
  });

  await Promise.all([...groups.values()].map(async (group) => {
    for (let groupIndex = 0; groupIndex < group.length; groupIndex += 1) {
      if (groupIndex > 0 && group[groupIndex].acquisitionPath.provider === 'alpha-vantage') {
        await pause(ALPHA_VANTAGE_PACING_MS);
      }
      await fetchOnePath(group[groupIndex].acquisitionPath, group[groupIndex].index);
    }
  }));

  const reviewCandidates = deduplicateCandidates(downloadedCandidates()).sort(candidateOrder);
  const unverifiedReviewCandidates = reviewCandidates.filter((candidate) => candidate.publishedAtVerified !== true);
  normalizedDownloaded.push(...reviewCandidates);
  const cappedReviewCandidates = unverifiedReviewCandidates.slice(0, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  articleReview.eligibleDownloadedCount = reviewCandidates.length;
  articleReview.reviewCandidateCount = cappedReviewCandidates.length;
  articleReview.skippedCount = Math.max(0, unverifiedReviewCandidates.length - cappedReviewCandidates.length);
  articleReview.status = 'reviewing';
  reportProgress();

  // Article review enriches provenance and timestamps; search/provider candidates
  // remain the inventory even when the review cap leaves some pages unchecked.
  await mapConcurrent(cappedReviewCandidates, ARTICLE_CONCURRENCY, (candidate) => reviewArticle(candidate, {
    eligibleDates: candidate.pool === 'generalCandidates' ? generalAcquisitionDates : eligibleDates,
    fetchArticle,
    articleTimeoutMs
  }), {
    onSuccess: () => {
      articleReview.reviewedCount += 1;
      if (articleReview.reviewedCount % ARTICLE_CONCURRENCY === 0
        || articleReview.reviewedCount === cappedReviewCandidates.length) {
        reportProgress('reviewing');
      }
    }
  });

  articleReview.status = 'complete';
  return buildArtifact('complete');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const dashboardData = readDashboardData(args.input);
  const artifact = await collectNewsCandidates({
    asOf: args.asOf,
    dashboardData,
    searchTimeoutMs: args.searchTimeoutMs,
    articleTimeoutMs: args.articleTimeoutMs,
    offline: process.env.DASHBOARD_TEST_NO_NETWORK === '1' || process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1',
    onProgress: (progressArtifact) => atomicWriteJson(args.output, progressArtifact)
  });
  atomicWriteJson(args.output, artifact);
  const failures = artifact.attempts.filter((attempt) => attempt.error).length;
  process.stdout.write(`News candidates staged: ${artifact.generalCandidates.length} general, ${artifact.futuresCandidates?.length || 0} Futures, ${artifact.cryptoCandidates.length} Crypto; ${failures} acquisition failure(s).\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_news_candidates failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  ARTICLE_REVIEW_CANDIDATE_LIMIT,
  alphaTimeFrom,
  articleRedirectAllowed,
  collectNewsCandidates,
  extractArticleMetadata,
  fetchAcquisitionPath,
  fetchMarketaux,
  fetchArticlePage,
  fetchReutersPublic,
  fetchResponse,
  normalizeProviderCandidate,
  parseApNewsSitemap,
  parseArgs,
  parseNewsFeed,
  parseNewsTimestamp,
  parseReutersNewsSitemap,
  parseReutersNewsSitemapIndex,
  priorNewsCandidates,
  sourceForUrl
};
