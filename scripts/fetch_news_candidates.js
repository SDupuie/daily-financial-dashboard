#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { isIsoDateTime } = require('./calendar_contract');
const {
  allowedNewsDates,
  candidateInFuturesPublicationWindow,
  canonicalStoryUrl,
  futuresStoryPublicationWindow,
  normalizeStoryTitle
} = require('./news_contract');
const { APPROVED_NEWS_SOURCES, newsAcquisitionPaths } = require('./news_sources');
const { atomicWriteJson } = require('./staging_writer');
const { mapConcurrent } = require('./fetch_concurrency');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'daily_financial_news.html');
const DEFAULT_OUTPUT = path.join(ROOT, 'generated', 'news_candidates.json');
const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const STOCKFIT_URL = 'https://api.stockfit.io/v1/api/lookup/news/market';
const MSN_CONTENT_DETAIL_URL = 'https://assets.msn.com/content/view/v2/Detail/en-us/';
const MSN_REUTERS_LEGAL_NAME = 'Reuters News & Media Inc.';
const MSN_REUTERS_CATEGORIES = new Set(['money', 'news']);
const ARTICLE_BYTE_LIMIT = 1_000_000;
const ARTICLE_CONCURRENCY = 8;
const ARTICLE_REVIEW_CANDIDATE_LIMIT = 250;
const ALPHA_VANTAGE_PACING_MS = 1250;
const PROVENANCE_PRIORITY = Object.freeze({ 'msn-reuters': 5, 'ap-public': 4, rss: 3, 'alpha-vantage': 2, stockfit: 1 });

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

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour') % 24, minute: value('minute'), second: value('second') };
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

async function fetchAlphaVantage(acquisitionPath, { eligibleDates, timeoutMs, env = process.env }) {
  const apiKey = String(env.ALPHA_VANTAGE_API_KEY || '').trim();
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not configured.');
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set('function', 'NEWS_SENTIMENT');
  url.searchParams.set('topics', acquisitionPath.topic);
  url.searchParams.set('time_from', alphaTimeFrom(eligibleDates));
  url.searchParams.set('sort', 'LATEST');
  url.searchParams.set('limit', '1000');
  url.searchParams.set('apikey', apiKey);
  const response = await fetchResponse(url, { timeoutMs, headers: { Accept: 'application/json' } });
  const payload = await response.json();
  if (payload?.Information || payload?.Note || payload?.['Error Message']) {
    throw new Error(payload.Information || payload.Note || payload['Error Message']);
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

async function fetchStockfit(acquisitionPath, { timeoutMs, env = process.env }) {
  const apiKey = String(env.STOCKFIT_API_KEY || '').trim();
  if (!apiKey) throw new Error('STOCKFIT_API_KEY is not configured.');
  const url = new URL(STOCKFIT_URL);
  url.searchParams.set('limit', String(acquisitionPath.limit || 50));
  const response = await fetchResponse(url, {
    timeoutMs,
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
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

function msnReutersProvider(provider, providerId) {
  return provider?.id === providerId
    && provider?.name === 'Reuters';
}

function msnReutersReaderUrl(value, contentId = '') {
  try {
    const url = new URL(value);
    const expectedSuffix = contentId ? `/ar-${contentId}` : '';
    if (url.protocol !== 'https:'
      || !['msn.com', 'www.msn.com'].includes(url.hostname.toLowerCase())
      || !/\/ar-AA[A-Za-z0-9]+$/.test(url.pathname)
      || (expectedSuffix && !url.pathname.endsWith(expectedSuffix))) return '';
    url.searchParams.delete('ocid');
    return canonicalStoryUrl(url.toString());
  } catch (_error) {
    return '';
  }
}

function normalizeMsnReutersItem(card, detail, acquisitionPath) {
  if (card?.type !== 'article'
    || !MSN_REUTERS_CATEGORIES.has(card?.category)
    || !msnReutersProvider(card?.provider, acquisitionPath.providerId)
    || detail?.id !== card.id
    || detail?.type !== 'article'
    || !msnReutersProvider(detail?.provider, acquisitionPath.providerId)
    || detail?.provider?.companyLegalName !== MSN_REUTERS_LEGAL_NAME
    || !isIsoDateTime(card?.publishedDateTime)
    || card.publishedDateTime !== detail?.publishedDateTime
    || !/^tag:reuters\.com,\d{4}:newsml_[A-Z0-9]+(?::\d+)?$/.test(String(detail?.sourceId || ''))) return null;
  const url = msnReutersReaderUrl(card.url, card.id);
  const title = plainText(detail.title || card.title);
  const cardTitle = plainText(card.title);
  const articleText = plainText(detail.body);
  if (!url || !title || !cardTitle || !titleEquivalent(title, cardTitle) || articleText.length < 200) return null;
  return {
    title,
    url,
    publishedAt: detail.publishedDateTime,
    publishedAtVerified: true,
    summary: detail.abstract,
    providerSourceName: 'Reuters',
    providerVerified: true,
    publisherStoryId: detail.sourceId,
    article: {
      accessible: true,
      finalUrl: url,
      pageTitle: title,
      description: plainText(detail.abstract),
      excerpt: articleText.slice(0, 1800),
      text: articleText
    }
  };
}

async function fetchMsnReuters(acquisitionPath, { eligibleDates, timeoutMs }) {
  const url = new URL(acquisitionPath.feedUrl);
  url.searchParams.set('$top', String(acquisitionPath.limit || 100));
  url.searchParams.set('responseSchema', 'CardView');
  url.searchParams.set('market', 'en-us');
  url.searchParams.set('contentType', 'article');
  const response = await fetchResponse(url, {
    timeoutMs,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
    }
  });
  const payload = await response.json();
  const cards = payload?.value?.[0]?.subCards;
  if (!Array.isArray(cards)) throw new Error('MSN Reuters response must contain value[0].subCards[].');
  if (eligibleDates instanceof Set && !eligibleDates.size) return { items: [] };
  // Reject stale feed cards before the per-article detail requests; otherwise a
  // stale batch can consume one network timeout for every provider card.
  const providerCards = cards.filter((card) => card?.type === 'article'
    && MSN_REUTERS_CATEGORIES.has(card?.category)
    && msnReutersProvider(card?.provider, acquisitionPath.providerId)
    && isIsoDateTime(card?.publishedDateTime));
  const eligibleCards = eligibleDates instanceof Set
    ? providerCards.filter((card) => eligibleDates.has(chicagoIsoDate(new Date(card.publishedDateTime))))
    : providerCards;
  if (providerCards.length && !eligibleCards.length) return { items: [] };
  const items = Array(eligibleCards.length).fill(null);
  await mapConcurrent(eligibleCards.map((card, index) => ({ card, index })), ARTICLE_CONCURRENCY, async ({ card, index }) => {
    try {
      const detailResponse = await fetchResponse(`${MSN_CONTENT_DETAIL_URL}${encodeURIComponent(card.id)}`, {
        timeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
        }
      });
      const item = normalizeMsnReutersItem(card, await detailResponse.json(), acquisitionPath);
      if (item) items[index] = item;
    } catch (_error) {
      // One malformed or unavailable syndication record must not discard the rest of the Reuters batch.
    }
  });
  const validatedItems = items.filter(Boolean);
  if (!validatedItems.length) throw new Error('MSN Reuters response contains no validated Reuters article items.');
  return { items: validatedItems };
}

async function fetchAcquisitionPath(acquisitionPath, options) {
  if (acquisitionPath.provider === 'alpha-vantage') return fetchAlphaVantage(acquisitionPath, options);
  if (acquisitionPath.provider === 'stockfit') return fetchStockfit(acquisitionPath, options);
  if (acquisitionPath.provider === 'rss') return fetchRss(acquisitionPath, options);
  if (acquisitionPath.provider === 'ap-public') return fetchApPublic(acquisitionPath, options);
  if (acquisitionPath.provider === 'msn-reuters') return fetchMsnReuters(acquisitionPath, options);
  throw new Error(`Unsupported News provider ${acquisitionPath.provider}.`);
}

function parseAlphaPublishedAt(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
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

function normalizeProviderCandidate(item, acquisitionPath, eligibleDates) {
  const url = canonicalStoryUrl(item?.url);
  const source = acquisitionPath.provider === 'msn-reuters' && item?.providerVerified === true
    ? APPROVED_NEWS_SOURCES.find((entry) => entry.id === 'reuters')
    : sourceForUrl(url);
  const publishedAt = new Date(String(item?.publishedAt || '').trim());
  const title = plainText(item?.title);
  if (!url || !source || Number.isNaN(publishedAt.getTime()) || !title) return null;
  if (new URL(url).protocol !== 'https:') return null;
  const publishedOn = chicagoIsoDate(publishedAt);
  if (!eligibleDates.has(publishedOn)) return null;
  return {
    title,
    url,
    publishedOn,
    publishedAt: publishedAt.toISOString(),
    dateSource: 'provider_published',
    ...(item.publishedAtVerified === true ? { publishedAtVerified: true } : {}),
    sourceId: source.id,
    sourceLabel: source.displayName,
    sourceDomain: new URL(url).hostname.toLowerCase(),
    provider: acquisitionPath.provider,
    ...(plainText(item.summary) ? { providerSummary: plainText(item.summary) } : {}),
    ...(plainText(item.providerSourceName) ? { providerSourceName: plainText(item.providerSourceName) } : {}),
    ...(item.publisherStoryId ? { publisherStoryId: item.publisherStoryId } : {}),
    ...(item.article ? { article: item.article } : {}),
    origin: 'downloaded',
    pool: acquisitionPath.pool,
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
  for (const value of values) {
    const date = new Date(String(value || '').trim());
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function canonicalLink(html) {
  const links = [...String(html).matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const canonical = links.find((tag) => /\brel=["'][^"']*canonical[^"']*["']/i.test(tag));
  return decodeHtml(canonical?.match(/\bhref=["']([^"']+)["']/i)?.[1] || '');
}

function explicitPublisherUrls(html) {
  const urls = [];
  for (const match of String(html).matchAll(/["'](?:isBasedOn(?:Url)?|originalUrl|sourceUrl)["']\s*:\s*["'](https:\/\/[^"']+)["']/gi)) {
    urls.push(decodeHtml(match[1].replaceAll('\\/', '/')));
  }
  const sourceMeta = metaContent(html, 'source');
  if (/^https:\/\//i.test(sourceMeta)) urls.push(sourceMeta);
  return [...new Set(urls.map(canonicalStoryUrl).filter(Boolean))];
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
  const publisherName = plainText(String(html).match(/["']publisher["']\s*:\s*\{[\s\S]{0,500}?["']name["']\s*:\s*["']([^"']+)["']/i)?.[1]);
  return {
    pageTitle: metaContent(html, 'og:title') || plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
    excerpt: paragraphs.slice(0, 3).join(' ').slice(0, 1800),
    publishedAt,
    canonicalUrl: canonicalStoryUrl(canonicalLink(html)),
    ogUrl: canonicalStoryUrl(metaContent(html, 'og:url')),
    explicitPublisherUrls: explicitPublisherUrls(html),
    publisherName
  };
}

async function fetchArticlePage(candidate, { timeoutMs }) {
  const response = await fetchResponse(candidate.url, {
    timeoutMs,
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
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`Could not find dashboard-data JSON in ${input}.`);
  return JSON.parse(match[1]);
}

function priorCandidate(item, pool, eligibleDates) {
  const url = canonicalStoryUrl(item?.url);
  const title = String(item?.title || '').trim();
  const publishedOn = String(item?.publishedOn || '');
  const sourceLabel = String(item?.sourceLabel || '').trim();
  // MSN is a validated syndication host, not an approved publisher domain. A
  // previously published Reuters card may re-enter only through its exact MSN
  // article route and preserved updater-owned Reuters label.
  const approvedPriorSource = sourceForUrl(url)
    || (sourceLabel === 'Reuters' && msnReutersReaderUrl(url));
  if (!url || !approvedPriorSource || !title || !sourceLabel || !eligibleDates.has(publishedOn)) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch (_error) {
    return null;
  }
  return {
    title,
    url,
    publishedOn,
    sourceLabel,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    dateSource: 'prior_validated_card',
    publishedAtVerified: true,
    origin: 'prior_card',
    priorCard: true,
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
  return {
    ...other,
    ...preferred,
    ...(preferred.pool === 'cryptoCandidates' || other.pool === 'cryptoCandidates' ? { pool: 'cryptoCandidates' } : {}),
    ...(preferred.priorCard || other.priorCard ? { priorCard: true } : {}),
    ...(preferred.priorCopy || other.priorCopy ? { priorCopy: preferred.priorCopy || other.priorCopy } : {}),
    searchPathIds
  };
}

function deduplicateCandidates(candidates) {
  const selected = [];
  for (const candidate of candidates) {
    const titleKey = normalizeStoryTitle(candidate.title);
    const index = selected.findIndex((item) => item.url === candidate.url
      || (candidate.publisherStoryId && candidate.publisherStoryId === item.publisherStoryId)
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

function titleEquivalent(left, right) {
  const leftWords = new Set(normalizeStoryTitle(left).split(' ').filter((word) => word.length > 2));
  const rightWords = new Set(normalizeStoryTitle(right).split(' ').filter((word) => word.length > 2));
  if (!leftWords.size || !rightWords.size) return false;
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return shared / Math.min(leftWords.size, rightWords.size) >= 0.6;
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

async function reviewArticle(candidate, { eligibleDates, fetchArticle, articleTimeoutMs, clock }) {
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
        candidate.dateSource = 'article_page';
        candidate.publishedAtVerified = true;
      }
    }
  } catch (error) {
    candidate.article = { accessible: false, error: String(error?.message || error) };
  }
  if (candidate.sourceId !== 'yahoo-finance') return;

  const publisherName = plainText(hostedPage?.publisherName);
  const syndicatedPublisherName = ['yahoo', 'yahoo finance'].includes(normalizeStoryTitle(publisherName))
    ? ''
    : publisherName;
  candidate.syndication = {
    status: 'yahoo_hosted',
    hostedUrl: candidate.url,
    ...(syndicatedPublisherName ? { publisherName: syndicatedPublisherName } : {})
  };
  if (!hostedPage) return;
  const urls = [hostedPage.finalUrl, hostedPage.canonicalUrl, hostedPage.ogUrl, ...(hostedPage.explicitPublisherUrls || [])]
    .map(canonicalStoryUrl)
    .filter((url) => url && sourceForUrl(url)?.id !== 'yahoo-finance' && articlePathUrl(url));
  for (const originalUrl of [...new Set(urls)]) {
    const source = sourceForUrl(originalUrl);
    if (!source) continue;
    try {
      const originalPage = await fetchArticle({ ...candidate, url: originalUrl }, { timeoutMs: articleTimeoutMs });
      const originalTitle = plainText(originalPage.pageTitle);
      if (!originalTitle || !titleEquivalent(candidate.title, originalTitle)) continue;
      const originalPublishedAt = firstValidDate([originalPage.publishedAt]);
      if (!originalPublishedAt) continue;
      const originalPublishedOn = chicagoIsoDate(originalPublishedAt);
      if (!eligibleDates.has(originalPublishedOn)) continue;
      const validatedUrl = canonicalStoryUrl(originalPage.finalUrl || originalUrl) || originalUrl;
      const validatedSource = sourceForUrl(validatedUrl);
      if (!validatedSource || validatedSource.id === 'yahoo-finance' || !articlePathUrl(validatedUrl)) continue;
      candidate.url = validatedUrl;
      candidate.sourceId = validatedSource.id;
      candidate.sourceLabel = validatedSource.displayName;
      candidate.sourceDomain = new URL(candidate.url).hostname.toLowerCase();
      candidate.article = articleRecord(originalPage);
      candidate.pagePublishedAt = originalPublishedAt.toISOString();
      candidate.pagePublishedOn = originalPublishedOn;
      candidate.pageDateFresh = true;
      candidate.publishedAt = candidate.pagePublishedAt;
      candidate.publishedOn = originalPublishedOn;
      candidate.dateSource = 'article_page';
      candidate.publishedAtVerified = true;
      candidate.syndication.status = 'original_validated';
      candidate.syndication.originalUrl = candidate.url;
      candidate.syndication.validatedAt = clock().toISOString();
      return;
    } catch (_error) {
      // Keep the truthful Yahoo-hosted URL when the explicit publisher URL cannot be validated.
    }
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
  const verifiedDownloaded = [];
  const reviewedDownloaded = [];
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
      ...verifiedDownloaded,
      ...reviewedDownloaded.filter((candidate) => candidate.pageDateFresh !== false),
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
      cryptoCandidates: candidates.filter((candidate) => candidate.pool === 'cryptoCandidates').sort(candidateOrder)
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
  const verifiedReviewCandidates = reviewCandidates.filter((candidate) => candidate.publishedAtVerified === true);
  const unverifiedReviewCandidates = reviewCandidates.filter((candidate) => candidate.publishedAtVerified !== true);
  verifiedDownloaded.push(...verifiedReviewCandidates);
  const cappedReviewCandidates = unverifiedReviewCandidates.slice(0, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  articleReview.eligibleDownloadedCount = reviewCandidates.length;
  articleReview.reviewCandidateCount = cappedReviewCandidates.length;
  articleReview.skippedCount = Math.max(0, unverifiedReviewCandidates.length - cappedReviewCandidates.length);
  articleReview.status = 'reviewing';
  reportProgress();

  await mapConcurrent(cappedReviewCandidates, ARTICLE_CONCURRENCY, (candidate) => reviewArticle(candidate, {
    eligibleDates: candidate.pool === 'generalCandidates' ? generalAcquisitionDates : eligibleDates,
    fetchArticle,
    articleTimeoutMs,
    clock
  }), {
    onSuccess: (candidate) => {
      reviewedDownloaded.push(candidate);
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
  collectNewsCandidates,
  extractArticleMetadata,
  fetchAcquisitionPath,
  fetchArticlePage,
  fetchMsnReuters,
  msnReutersReaderUrl,
  normalizeMsnReutersItem,
  normalizeProviderCandidate,
  parseApNewsSitemap,
  parseArgs,
  parseNewsFeed,
  priorNewsCandidates,
  sourceForUrl,
  titleEquivalent
};
