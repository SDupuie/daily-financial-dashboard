#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { allowedNewsDates, canonicalStoryUrl } = require('./news_contract');
const { APPROVED_NEWS_SOURCES, newsSearchPaths } = require('./news_sources');
const { atomicWriteJson } = require('./staging_writer');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.join(ROOT, 'generated', 'news_candidates.json');
const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const SEARCH_RESULT_LIMIT = 75;
const ARTICLE_BYTE_LIMIT = 1_000_000;
const ARTICLE_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    asOf: new Date(),
    windowMode: '',
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
    if (arg === '--morning' || arg === '--afternoon') {
      if (args.windowMode) throw new Error('Use only one of --morning or --afternoon.');
      args.windowMode = arg.slice(2);
      continue;
    }
    if (arg === '--search-timeout-ms' || arg === '--article-timeout-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${arg} must be a positive integer.`);
      args[arg === '--search-timeout-ms' ? 'searchTimeoutMs' : 'articleTimeoutMs'] = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/fetch_news_candidates.js [options]\n\nOptions:\n  --input PATH                 Dashboard or candidate HTML used for still-fresh prior cards\n  --output PATH                Staging output (default: generated/news_candidates.json)\n  --as-of TIMESTAMP            Fixed run timestamp used for News freshness\n  --morning|--afternoon        Select the configured window-specific Futures query\n  --search-timeout-ms N        Per-search timeout (default: 20000)\n  --article-timeout-ms N       Per-article timeout (default: 10000)\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function chicagoIsoDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function compactDate(isoDate, endOfDay = false) {
  return `${isoDate.replaceAll('-', '')}${endOfDay ? '235959' : '000000'}`;
}

function gdeltSearchUrl(searchPath, eligibleDates) {
  const dates = [...eligibleDates].sort();
  const url = new URL(GDELT_DOC_URL);
  url.searchParams.set('query', searchPath.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', String(SEARCH_RESULT_LIMIT));
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'datedesc');
  url.searchParams.set('startdatetime', compactDate(dates[0]));
  url.searchParams.set('enddatetime', compactDate(dates.at(-1), true));
  return url;
}

async function fetchResponse(url, { timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGdeltSearch(searchPath, { eligibleDates, timeoutMs }) {
  const response = await fetchResponse(gdeltSearchUrl(searchPath, eligibleDates), {
    timeoutMs,
    headers: { Accept: 'application/json' }
  });
  return response.json();
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

function parseGdeltSeenDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeGdeltCandidate(item, eligibleDates) {
  if (item?.language && String(item.language).toLowerCase() !== 'english') return null;
  const url = canonicalStoryUrl(item?.url);
  const source = sourceForUrl(url);
  const seenAt = parseGdeltSeenDate(item?.seendate);
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  if (!url || !source || !seenAt || !title || new URL(url).protocol !== 'https:') return null;
  const publishedOn = chicagoIsoDate(seenAt);
  if (!eligibleDates.has(publishedOn)) return null;
  return {
    title,
    url,
    publishedOn,
    publishedAt: seenAt.toISOString(),
    dateSource: 'provider_seen',
    sourceId: source.id,
    sourceDomain: new URL(url).hostname.toLowerCase(),
    provider: 'gdelt-doc',
    origin: 'downloaded',
    searchPathIds: []
  };
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
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
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
  for (const value of values) {
    const date = new Date(String(value || '').trim());
    if (!Number.isNaN(date.getTime())) return date;
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
  return {
    pageTitle: metaContent(html, 'og:title') || plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
    excerpt: paragraphs.slice(0, 3).join(' ').slice(0, 1800),
    publishedAt
  };
}

async function fetchArticlePage(candidate, { timeoutMs }) {
  const response = await fetchResponse(candidate.url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'DailyFinancialDashboard/1.0 (personal news acquisition)'
    }
  });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error(`Unsupported content type ${contentType || 'unknown'}`);
  }
  const html = (await response.text()).slice(0, ARTICLE_BYTE_LIMIT);
  const metadata = extractArticleMetadata(html);
  return { ...metadata, finalUrl: canonicalStoryUrl(response.url || candidate.url) || candidate.url };
}

function readDashboardData(input) {
  if (!input || !fs.existsSync(input)) return null;
  const html = fs.readFileSync(input, 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`Could not find dashboard-data JSON in ${input}.`);
  return JSON.parse(match[1]);
}

function priorCandidate(item, pool, eligibleDates) {
  const url = canonicalStoryUrl(item?.url);
  const title = String(item?.title || '').trim();
  const publishedOn = String(item?.publishedOn || '');
  if (!url || !title || !eligibleDates.has(publishedOn)) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch (_error) {
    return null;
  }
  return {
    title,
    url,
    publishedOn,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    dateSource: 'prior_validated_card',
    origin: 'prior_card',
    priorCard: true,
    priorCollection: pool,
    priorCopy: {
      ...(item.tag ? { tag: item.tag } : {}),
      ...(item.kicker ? { kicker: item.kicker } : {}),
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

function mergeCandidate(pool, candidate) {
  const existing = pool.get(candidate.url);
  if (!existing) {
    pool.set(candidate.url, candidate);
    return true;
  }
  const paths = new Set([...(existing.searchPathIds || []), ...(candidate.searchPathIds || [])]);
  pool.set(candidate.url, {
    ...existing,
    ...(candidate.origin === 'downloaded' ? candidate : {}),
    ...(existing.priorCard || candidate.priorCard ? { priorCard: true } : {}),
    ...(existing.priorCopy || candidate.priorCopy ? { priorCopy: existing.priorCopy || candidate.priorCopy } : {}),
    searchPathIds: [...paths]
  });
  return false;
}

function candidateOrder(left, right) {
  return String(right.publishedAt || `${right.publishedOn}T00:00:00Z`)
    .localeCompare(String(left.publishedAt || `${left.publishedOn}T00:00:00Z`))
    || left.url.localeCompare(right.url);
}

async function mapConcurrent(items, concurrency, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function collectNewsCandidates({
  asOf = new Date(),
  windowMode = '',
  dashboardData = null,
  searchPaths = newsSearchPaths(windowMode),
  searchTimeoutMs = 20000,
  articleTimeoutMs = 10000,
  fetchSearch = fetchGdeltSearch,
  fetchArticle = fetchArticlePage,
  offline = false,
  clock = () => new Date()
} = {}) {
  const eligibleDates = allowedNewsDates(asOf);
  const pools = { generalCandidates: new Map(), cryptoCandidates: new Map() };
  const attempts = [];
  const prior = priorNewsCandidates(dashboardData, eligibleDates);
  for (const poolName of Object.keys(pools)) {
    for (const candidate of prior[poolName]) mergeCandidate(pools[poolName], candidate);
  }

  for (const searchPath of searchPaths) {
    const attempt = {
      id: searchPath.id,
      provider: 'gdelt-doc',
      phase: searchPath.phase,
      pool: searchPath.pool,
      query: searchPath.query,
      eligibleDates: [...eligibleDates].sort(),
      attemptedAt: clock().toISOString(),
      resultCount: 0,
      acceptedCount: 0,
      error: null
    };
    try {
      if (offline) throw new Error('Network disabled for offline test.');
      const payload = await fetchSearch(searchPath, { eligibleDates, timeoutMs: searchTimeoutMs });
      const articles = Array.isArray(payload?.articles) ? payload.articles : [];
      if (!Array.isArray(payload?.articles)) throw new Error('GDELT DOC response must contain articles[].');
      attempt.resultCount = articles.length;
      for (const item of articles) {
        const candidate = normalizeGdeltCandidate(item, eligibleDates);
        if (!candidate) continue;
        candidate.searchPathIds = [searchPath.id];
        attempt.acceptedCount += 1;
        mergeCandidate(pools[searchPath.pool], candidate);
      }
    } catch (error) {
      attempt.error = String(error?.message || error);
    }
    attempts.push(attempt);
  }

  const downloaded = Object.values(pools).flatMap((pool) => [...pool.values()])
    .filter((candidate) => candidate.origin === 'downloaded');
  await mapConcurrent(downloaded, ARTICLE_CONCURRENCY, async (candidate) => {
    try {
      const page = await fetchArticle(candidate, { timeoutMs: articleTimeoutMs });
      candidate.article = {
        accessible: true,
        finalUrl: page.finalUrl || candidate.url,
        pageTitle: page.pageTitle || '',
        description: page.description || '',
        excerpt: page.excerpt || ''
      };
      if (page.publishedAt) {
        const publishedOn = chicagoIsoDate(page.publishedAt);
        candidate.pagePublishedAt = page.publishedAt.toISOString();
        candidate.pagePublishedOn = publishedOn;
        candidate.pageDateFresh = eligibleDates.has(publishedOn);
        if (candidate.pageDateFresh) {
          candidate.publishedAt = candidate.pagePublishedAt;
          candidate.publishedOn = candidate.pagePublishedOn;
          candidate.dateSource = 'article_page';
        }
      }
    } catch (error) {
      candidate.article = { accessible: false, error: String(error?.message || error) };
    }
  });
  for (const pool of Object.values(pools)) {
    for (const [url, candidate] of pool) {
      if (candidate.pageDateFresh === false) pool.delete(url);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: asOf.toISOString(),
    finishedAt: clock().toISOString(),
    eligibleDates: [...eligibleDates].sort(),
    sourceCatalog: APPROVED_NEWS_SOURCES,
    attempts,
    generalCandidates: [...pools.generalCandidates.values()].sort(candidateOrder),
    cryptoCandidates: [...pools.cryptoCandidates.values()].sort(candidateOrder)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboardData = readDashboardData(args.input);
  const artifact = await collectNewsCandidates({
    asOf: args.asOf,
    windowMode: args.windowMode,
    dashboardData,
    searchTimeoutMs: args.searchTimeoutMs,
    articleTimeoutMs: args.articleTimeoutMs,
    offline: process.env.DASHBOARD_TEST_NO_NETWORK === '1' || process.env.DASHBOARD_TEST_NO_API_CREDENTIALS === '1'
  });
  atomicWriteJson(args.output, artifact);
  const failures = artifact.attempts.filter((attempt) => attempt.error).length;
  process.stdout.write(`News candidates staged: ${artifact.generalCandidates.length} general, ${artifact.cryptoCandidates.length} Crypto; ${failures} search failure(s).\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fetch_news_candidates failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  collectNewsCandidates,
  extractArticleMetadata,
  fetchArticlePage,
  fetchGdeltSearch,
  gdeltSearchUrl,
  normalizeGdeltCandidate,
  parseArgs,
  priorNewsCandidates,
  sourceForUrl
};
