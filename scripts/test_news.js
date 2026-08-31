#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  NEWS_COVERAGE_POLICIES,
  NEWS_COVERAGE_REASON,
  allowedNewsDates,
  applyNewsCoverageState,
  applyScheduledNewsBaseline,
  candidateInFuturesPublicationWindow,
  canonicalStoryUrl,
  dashboardNewsItems,
  normalizeStoryTitle,
  sanitizeNewsBaseline,
  sortedDashboardNewsIds,
  storyIdentity,
  validateNewsCoverageState
} = require('./news_contract');
const {
  ARTICLE_REVIEW_CANDIDATE_LIMIT,
  articleRedirectAllowed,
  collectNewsCandidates,
  extractArticleMetadata,
  fetchAcquisitionPath,
  fetchReutersPublic,
  fetchResponse,
  normalizeProviderCandidate,
  parseApNewsSitemap,
  parseNewsFeed,
  parseNewsTimestamp,
  parseReutersNewsSitemap,
  parseReutersNewsSitemapIndex
} = require('./fetch_news_candidates');
const {
  APPROVED_NEWS_SOURCES,
  DIRECT_NEWS_FEEDS,
  MARKETAUX_TICKER_NEWS_PATHS,
  newsAcquisitionPaths
} = require('./news_sources');
const { validateScheduledFinalization, validateScheduledStart } = require('./run_daily_update');
const temporaryDirectories = new Set();

function makeTemporaryDirectory(parent, prefix) {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.add(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true });
});

function startHttpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function story(title, url, extra = {}) {
  return { title, url, ...extra };
}

function testStoryIdentityContract() {
  assert.equal(
    canonicalStoryUrl(' https://Example.COM/markets/story/?utm_source=mail&b=2&a=1#section '),
    'https://example.com/markets/story?a=1&b=2'
  );
  assert.equal(
    canonicalStoryUrl('https://example.com/?fbclid=tracking'),
    'https://example.com/'
  );
  assert.equal(
    canonicalStoryUrl('https://example.com/story?mod=mw_rss_topstories&.tsrc=rss&keep=yes'),
    'https://example.com/story?keep=yes'
  );
  assert.equal(canonicalStoryUrl('not a URL'), '');
  assert.equal(normalizeStoryTitle('  ＭＡＲＫＥＴＳ — Rally!  '), 'markets rally');
  assert.equal(
    storyIdentity(story('Ignored fallback', 'https://EXAMPLE.com/story/?gclid=x')),
    'url:https://example.com/story'
  );
  assert.equal(storyIdentity(story('Fallback   Headline', '')), 'title:fallback headline');
  assert.equal(storyIdentity({}), '');
}

function testDashboardNewsCollections() {
  const market = story('Market', 'https://example.com/market');
  const crypto = story('Crypto', 'https://example.com/crypto');
  const futures = story('Futures', 'https://example.com/futures');
  const data = {
    stories: [market],
    crypto: { notes: [crypto] },
    futuresModule: { stories: [futures] }
  };
  assert.deepEqual(dashboardNewsItems(data), [market, crypto]);
  assert.deepEqual(sortedDashboardNewsIds(data), [storyIdentity(crypto), storyIdentity(market)].sort());

  data.crypto.notes.push({ ...market });
  assert.deepEqual(sortedDashboardNewsIds(data), [storyIdentity(crypto), storyIdentity(market)].sort());
}

function testNewsCoverageState() {
  assert.deepEqual(NEWS_COVERAGE_POLICIES.stories, { label: 'stories', minimum: 9, maximum: 18 });
  assert.deepEqual(NEWS_COVERAGE_POLICIES.cryptoNotes, { label: 'crypto.notes', minimum: 9, maximum: 15 });
  assert.deepEqual(NEWS_COVERAGE_POLICIES.futuresStories, { label: 'futuresModule.stories', minimum: 3, maximum: 3 });
  assert.deepEqual(validateNewsCoverageState(undefined, 9, NEWS_COVERAGE_POLICIES.stories), []);
  assert.deepEqual(validateNewsCoverageState(undefined, 9, NEWS_COVERAGE_POLICIES.cryptoNotes), []);
  assert.deepEqual(validateNewsCoverageState(undefined, 3, NEWS_COVERAGE_POLICIES.futuresStories), []);
  assert.deepEqual(
    validateNewsCoverageState(undefined, 0, NEWS_COVERAGE_POLICIES.futuresStories, { allowIncomplete: true }),
    [],
    'Deterministic staging may remain editorially incomplete.'
  );
  const data = { stories: [], crypto: { notes: [] }, futuresModule: { stories: [] } };
  applyNewsCoverageState(data, { now: new Date('2026-07-10T21:00:00.000Z') });
  assert.deepEqual(data.storiesCoverage, {
    status: 'partial',
    reason: NEWS_COVERAGE_REASON,
    checkedAt: '2026-07-10T21:00:00.000Z'
  });
  assert.deepEqual(validateNewsCoverageState(data.storiesCoverage, 0, NEWS_COVERAGE_POLICIES.stories), []);
  assert.match(
    validateNewsCoverageState({ status: 'complete' }, 8, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /storiesCoverage\.status can be complete/
  );
  assert.match(
    validateNewsCoverageState({ status: 'partial' }, 9, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /must not stay partial.*reason.*checkedAt/
  );
  assert.match(
    validateNewsCoverageState(undefined, 2, NEWS_COVERAGE_POLICIES.cryptoNotes).join(' '),
    /crypto\.notesCoverage must record updater-derived partial coverage/
  );
  assert.deepEqual(validateNewsCoverageState(undefined, 10, NEWS_COVERAGE_POLICIES.stories), []);
  assert.match(
    validateNewsCoverageState(undefined, 19, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /stories must contain no more than 18 items/
  );
  assert.match(
    validateNewsCoverageState(undefined, 16, NEWS_COVERAGE_POLICIES.cryptoNotes).join(' '),
    /crypto\.notes must contain no more than 15 items/
  );
}

function testFuturesPublicationTimestampValidation() {
  const futuresWindow = {
    start: new Date('2026-07-10T18:30:00.000Z'),
    end: new Date('2026-07-10T19:00:00.000Z')
  };
  assert.equal(candidateInFuturesPublicationWindow({
    publishedAt: '2026-07-10T18:45:00.000Z',
    publishedAtVerified: true
  }, futuresWindow), true);
  for (const publishedAt of [undefined, null, 42, [], {}, '', 'not-a-time', '2026-07-10', '2026-07-10T18:45:00']) {
    assert.equal(candidateInFuturesPublicationWindow({ publishedAt, publishedAtVerified: true }, futuresWindow), false);
  }
}

function testMondayMorningFreshnessWindow() {
  const saturday = '2026-07-11';
  assert.equal(allowedNewsDates(new Date('2026-07-13T12:44:00.000Z')).has(saturday), false);
  assert.equal(allowedNewsDates(new Date('2026-07-13T12:45:00.000Z')).has(saturday), true);
  assert.equal(allowedNewsDates(new Date('2026-07-13T14:00:00.000Z')).has(saturday), true);
  assert.equal(allowedNewsDates(new Date('2026-07-13T14:01:00.000Z')).has(saturday), false);
}

async function testAlphaVantageProviderErrorRedaction() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const apiKey = 'fixture-alpha-key-123';
  const alphaPath = {
    id: 'alpha-financial-markets',
    provider: 'alpha-vantage',
    pool: 'generalCandidates',
    topic: 'financial_markets'
  };
  const providerMessage = `Alpha Vantage detected ${apiKey}; repeated value ${apiKey}.`;
  const fetchPage = async () => ({ json: async () => ({ Information: providerMessage }) });
  const artifact = await collectNewsCandidates({
    asOf,
    acquisitionPaths: [
      alphaPath,
      { id: 'independent-ap', provider: 'ap-public', pool: 'generalCandidates' }
    ],
    env: { ALPHA_VANTAGE_API_KEY: apiKey },
    clock: () => asOf,
    fetchPath: async (acquisitionPath, options) => {
      if (acquisitionPath.id === alphaPath.id) {
        return fetchAcquisitionPath(acquisitionPath, { ...options, fetchPage });
      }
      return { items: [{
        title: 'Independent AP fixture',
        url: 'https://apnews.com/article/alpha-error-isolation-fixture',
        publishedAt: '2026-07-10T18:30:00.000Z',
        publishedAtVerified: true
      }] };
    },
    fetchArticle: async () => {
      throw new Error('Provider-verified AP candidates must bypass article review.');
    }
  });
  const alphaError = artifact.attempts.find((attempt) => attempt.id === alphaPath.id).error;
  assert.equal(alphaError, 'Alpha Vantage detected [redacted]; repeated value [redacted].');
  assert.equal(alphaError.includes(apiKey), false, 'Persisted Alpha Vantage diagnostics must not contain the configured API key.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.sourceId === 'ap'), true, 'An Alpha Vantage error must not discard unrelated provider candidates.');

  await assert.rejects(
    () => fetchAcquisitionPath(alphaPath, {
      eligibleDates: new Set(['2026-07-10']),
      timeoutMs: 1000,
      env: { ALPHA_VANTAGE_API_KEY: apiKey },
      fetchPage: async () => ({ json: async () => ({ Note: 'Provider warning without a credential.' }) })
    }),
    /Provider warning without a credential\./
  );
  await assert.rejects(
    () => fetchAcquisitionPath(alphaPath, {
      eligibleDates: new Set(['2026-07-10']),
      timeoutMs: 1000,
      env: { ALPHA_VANTAGE_API_KEY: apiKey },
      fetchPage: async () => ({ json: async () => ({ 'Error Message': `Rejected key ${apiKey}.` }) })
    }),
    (error) => {
      assert.equal(error.message, 'Rejected key [redacted].');
      return true;
    }
  );
  assert.deepEqual(await fetchAcquisitionPath(alphaPath, {
    eligibleDates: new Set(['2026-07-10']),
    timeoutMs: 1000,
    env: { ALPHA_VANTAGE_API_KEY: apiKey },
    fetchPage: async () => ({ json: async () => ({ feed: [] }) })
  }), { items: [] });
}

async function testStockfitProviderRequestHeaders() {
  const apiKey = 'fixture-stockfit-key';
  let request;
  const result = await fetchAcquisitionPath({
    id: 'stockfit-market',
    provider: 'stockfit',
    pool: 'generalCandidates',
    limit: 50
  }, {
    timeoutMs: 1000,
    env: { STOCKFIT_API_KEY: apiKey },
    fetchPage: async (url, options) => {
      request = { url: url.toString(), ...options };
      return { json: async () => ({ news: [] }) };
    }
  });

  assert.deepEqual(result, { items: [] });
  assert.equal(request.url, 'https://api.stockfit.io/v1/api/lookup/news/market?limit=50');
  assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(
    request.headers['User-Agent'],
    'Mozilla/5.0 (compatible; DailyFinancialDashboard/1.0; personal news acquisition)'
  );
}

async function testMarketauxTickerAcquisition() {
  const apiKey = 'fixture-marketaux-key';
  const acquisitionPath = MARKETAUX_TICKER_NEWS_PATHS.find((pathEntry) => pathEntry.ticker === 'IBIT');
  const providerItems = [1, 2, 3, 4].map((index) => ({
    title: `IBIT fixture story ${index}`,
    url: `https://financefeeds.com/ibit-fixture-${index}`,
    published_at: '2026-08-19T12:00:00.000Z',
    description: 'Fixture description.',
    source: 'financefeeds.com',
    relevance_score: 40 - index
  }));
  const requests = [];
  const result = await fetchAcquisitionPath(acquisitionPath, {
    eligibleDates: new Set(['2026-08-19']),
    timeoutMs: 1000,
    env: { MARKETAUX_API_KEY: apiKey },
    fetchPage: async (url, options) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requests.push({ url: new URL(url), ...options });
      const data = page === 1 ? providerItems.slice(0, 3) : providerItems.slice(3);
      return { json: async () => ({ meta: { found: 4, returned: data.length, limit: 3, page }, data }) };
    }
  });

  assert.deepEqual(requests.map((request) => request.url.searchParams.get('page')), ['1', '2']);
  assert.ok(requests.every((request) => request.url.searchParams.get('search') === '"IBIT"'));
  assert.ok(requests.every((request) => request.url.searchParams.get('published_after') === '2026-08-19T05:00:00'));
  assert.ok(requests.every((request) => request.headers.Accept === 'application/json'));
  assert.equal(result.items.length, 4);

  const candidate = normalizeProviderCandidate(result.items[0], acquisitionPath, new Set(['2026-08-19']));
  assert.equal(candidate.sourceId, 'marketaux:financefeeds.com');
  assert.equal(candidate.sourceLabel, 'financefeeds.com');
  assert.deepEqual(candidate.tickerSearchSymbols, ['IBIT']);
  const yahooCandidate = normalizeProviderCandidate({
    ...result.items[0],
    url: 'https://finance.yahoo.com/news/approved-marketaux-fixture'
  }, acquisitionPath, new Set(['2026-08-19']));
  assert.equal(yahooCandidate.sourceId, 'yahoo-finance');
  assert.equal(yahooCandidate.sourceLabel, 'Yahoo Finance');

  for (const url of [
    'https://reader:secret@financefeeds.com/ibit-fixture',
    'https://localhost/ibit-fixture',
    'https://127.0.0.1/ibit-fixture',
    'https://financefeeds.com:8443/ibit-fixture',
    'http://financefeeds.com/ibit-fixture'
  ]) {
    assert.equal(normalizeProviderCandidate({ ...result.items[0], url }, acquisitionPath, new Set(['2026-08-19'])), null);
  }

  const partial = await fetchAcquisitionPath(acquisitionPath, {
    eligibleDates: new Set(['2026-08-19']),
    timeoutMs: 1000,
    env: { MARKETAUX_API_KEY: apiKey },
    fetchPage: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 2) throw new Error('fixture second-page failure');
      return { json: async () => ({ meta: { found: 10, returned: 3, limit: 3, page }, data: providerItems.slice(0, 3) }) };
    }
  });
  assert.equal(partial.items.length, 3);
  assert.match(partial.error, /Marketaux IBIT pagination partial/);

  const cappedRequests = [];
  const capped = await fetchAcquisitionPath(acquisitionPath, {
    eligibleDates: new Set(['2026-08-19']),
    timeoutMs: 1000,
    env: { MARKETAUX_API_KEY: apiKey },
    fetchPage: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      cappedRequests.push(page);
      const data = [1, 2, 3].map((item) => ({
        title: `Capped Marketaux fixture ${page}-${item}`,
        url: `https://example.com/capped-marketaux-${page}-${item}`,
        published_at: '2026-08-19T12:00:00.000Z'
      }));
      return { json: async () => ({ meta: { found: 100, returned: 3, limit: 3, page }, data }) };
    }
  });
  assert.deepEqual(cappedRequests, [1, 2, 3, 4, 5]);
  assert.equal(capped.items.length, 15);
  assert.equal(capped.error, undefined);
}

async function testMarketauxTickerPriorCardCarryForward() {
  const asOf = new Date('2026-08-19T13:00:00.000Z');
  const artifact = await collectNewsCandidates({
    asOf,
    acquisitionPaths: [],
    dashboardData: {
      stories: [],
      futuresModule: { stories: [] },
      crypto: { notes: [{
        title: 'Still-fresh IBIT fixture',
        url: 'https://financefeeds.com/still-fresh-ibit-fixture',
        publishedOn: '2026-08-19',
        sourceLabel: 'financefeeds.com',
        tickerSearchSymbols: ['IBIT'],
        tag: 'Crypto',
        body: 'Previously reviewed ticker coverage.'
      }, {
        title: 'Unmarked dynamic fixture',
        url: 'https://unapproved.example/unmarked-fixture',
        publishedOn: '2026-08-19',
        sourceLabel: 'unapproved.example',
        tag: 'Crypto',
        body: 'This must not bypass the ordinary prior-card source gate.'
      }, {
        title: 'Credentialed dynamic fixture',
        url: 'https://reader:secret@unapproved.example/credentialed-fixture',
        publishedOn: '2026-08-19',
        sourceLabel: 'unapproved.example',
        tickerSearchSymbols: ['IBIT'],
        tag: 'Crypto',
        body: 'This must not pass the carried-forward URL gate.'
      }, {
        title: 'Local dynamic fixture',
        url: 'https://localhost/local-fixture',
        publishedOn: '2026-08-19',
        sourceLabel: 'localhost',
        tickerSearchSymbols: ['IBIT'],
        tag: 'Crypto',
        body: 'This must not pass the carried-forward URL gate.'
      }] }
    },
    clock: () => asOf
  });

  assert.equal(artifact.cryptoCandidates.length, 1);
  assert.equal(artifact.cryptoCandidates[0].priorCard, true);
  assert.equal(artifact.cryptoCandidates[0].sourceLabel, 'financefeeds.com');
  assert.deepEqual(artifact.cryptoCandidates[0].tickerSearchSymbols, ['IBIT']);
}

function testCryptoRssSourceManifest() {
  const sources = new Map(APPROVED_NEWS_SOURCES.map((source) => [source.id, source]));
  const feeds = new Map(DIRECT_NEWS_FEEDS.map((feed) => [feed.id, feed]));
  const expected = [{
    id: 'crypto-news',
    displayName: 'Crypto.news',
    domains: ['crypto.news'],
    feedUrl: 'https://crypto.news/feed/',
    articleUrl: 'https://crypto.news/fixture-story/'
  }, {
    id: 'crypto-slate',
    displayName: 'CryptoSlate',
    domains: ['cryptoslate.com'],
    feedUrl: 'https://cryptoslate.com/feed/',
    articleUrl: 'https://cryptoslate.com/fixture-story/'
  }];

  for (const fixture of expected) {
    assert.deepEqual(sources.get(fixture.id), {
      id: fixture.id,
      displayName: fixture.displayName,
      domains: fixture.domains
    });
    const acquisitionPath = feeds.get(fixture.id);
    assert.deepEqual(acquisitionPath, {
      id: fixture.id,
      provider: 'rss',
      pool: 'cryptoCandidates',
      feedUrl: fixture.feedUrl
    });
    const candidate = normalizeProviderCandidate({
      title: `${fixture.displayName} RSS fixture`,
      url: fixture.articleUrl,
      publishedAt: '2026-08-19T12:00:00.000Z'
    }, acquisitionPath, new Set(['2026-08-19']));
    assert.equal(candidate.sourceId, fixture.id);
    assert.equal(candidate.sourceLabel, fixture.displayName);
    assert.equal(candidate.provider, 'rss');
    assert.equal(candidate.pool, 'cryptoCandidates');
  }
}

async function testDeterministicNewsCandidateAcquisition() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const calls = [];
  const pauses = [];
  const acquisitionPaths = newsAcquisitionPaths();
  const dashboardData = {
    stories: [{
      title: 'Still-fresh prior market card',
      url: 'https://www.cnbc.com/prior-market',
      publishedOn: '2026-07-10',
      sourceLabel: 'Fixture News',
      tag: 'Prior',
      body: 'Previously reviewed market copy.'
    }, {
      title: 'Stale misdated prior Reuters card',
      url: 'https://www.reuters.com/markets/us/stale-prior-fixture-2026-07-08',
      publishedOn: '2026-07-10',
      publishedAt: '2026-07-10T18:30:00.000Z',
      sourceLabel: 'Reuters',
      tag: 'Prior',
      body: 'This card must not re-enter through stale stored provenance.'
    }, {
      title: 'Fresh prior Reuters card',
      url: 'https://www.reuters.com/markets/us/fresh-prior-fixture-2026-07-10',
      publishedOn: '2026-07-10',
      publishedAt: '2026-07-11T08:30:00.000Z',
      sourceLabel: 'Reuters',
      tag: 'Prior',
      body: 'This card remains fresh by its URL date without conflicting precision.'
    }],
    futuresModule: { stories: [] },
    crypto: { notes: [] }
  };
  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData,
    acquisitionPaths,
    clock: () => asOf,
    pause: async (milliseconds) => pauses.push(milliseconds),
    fetchPath: async (acquisitionPath) => {
      calls.push(acquisitionPath.id);
      if (acquisitionPath.id === 'axios') throw new Error('fixture provider failure');
      if (acquisitionPath.id === 'alpha-financial-markets') return { items: [{
        publishedAt: '2026-07-10T20:00:00.000Z',
        title: 'CNBC direct duplicate fixture',
        url: 'https://www.cnbc.com/2026/07/10/direct-fixture.html?utm_source=alpha'
      }] };
      if (acquisitionPath.id === 'cnbc') return { items: [{
        publishedAt: '2026-07-10T20:00:00.000Z',
        title: 'CNBC direct duplicate fixture',
        url: 'https://www.cnbc.com/2026/07/10/direct-fixture.html'
      }] };
      if (acquisitionPath.id === 'stockfit-market') return { items: [{
        publishedAt: '2026-07-10T19:30:00.000Z',
        publishedAtVerified: true,
        title: 'Yahoo hosted fixture',
        url: 'https://finance.yahoo.com/news/validated-fixture.html',
        providerSourceName: 'Yahoo Finance'
      }] };
      if (acquisitionPath.id === 'coindesk') return { items: [{
        publishedAt: '2026-07-10T18:00:00.000Z',
        title: 'Crypto direct fixture',
        url: 'https://www.coindesk.com/markets/2026/07/10/crypto-fixture'
      }] };
      return { items: [] };
    },
    fetchArticle: async (candidate) => ({
      finalUrl: candidate.url,
      pageTitle: candidate.title,
      description: 'Fixture description.',
      excerpt: 'Fixture article content.',
      publishedAt: new Date(candidate.publishedAt)
    })
  });

  assert.deepEqual([...calls].sort(), acquisitionPaths.map((entry) => entry.id).sort());
  assert.deepEqual(artifact.attempts.map((attempt) => attempt.id), acquisitionPaths.map((entry) => entry.id));
  assert.deepEqual(pauses, [1250]);
  assert.equal(artifact.attempts.find((attempt) => attempt.id === 'axios').error, 'fixture provider failure');
  assert.equal(artifact.generalCandidates.filter((candidate) => candidate.sourceId === 'cnbc').length, 1);
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.sourceId === 'cnbc').provider, 'rss');
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.sourceId === 'yahoo-finance').publishedAtVerified, undefined);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.priorCard), true);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Stale misdated prior Reuters card'), false);
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.title === 'Fresh prior Reuters card').publishedAt, undefined);
  assert.equal(artifact.cryptoCandidates.find((candidate) => candidate.sourceId === 'coindesk').sourceLabel, 'CoinDesk');
}

async function testFuturesCandidatesUseDisplayedSessionWindow() {
  const asOf = new Date('2026-07-19T17:00:00.000Z');
  const dashboardData = {
    stories: [],
    futuresModule: {
      sectionTitle: 'Session Futures',
      futures: ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'].map((symbol) => ({ symbol, raw: { sessionDate: '2026-07-17' } })),
      stories: []
    },
    crypto: { notes: [] }
  };
  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData,
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items: [{
      publishedAt: '2026-07-17T15:00:00.000Z',
      title: 'Friday session futures fixture',
      url: 'https://www.cnbc.com/2026/07/17/friday-session-futures.html'
    }, {
      publishedAt: '2026-07-18T15:00:00.000Z',
      title: 'Saturday market fixture',
      url: 'https://www.cnbc.com/2026/07/18/saturday-market.html'
    }] }),
    fetchArticle: async (candidate) => ({
      finalUrl: candidate.url,
      pageTitle: candidate.title,
      description: 'Fixture description.',
      excerpt: 'Fixture article content.',
      publishedAt: new Date(candidate.publishedAt)
    })
  });
  assert.deepEqual(artifact.generalCandidates.map((candidate) => candidate.title), ['Saturday market fixture']);
  assert.deepEqual(artifact.futuresCandidates.map((candidate) => candidate.title), ['Friday session futures fixture']);

  const fallbackArtifact = await collectNewsCandidates({
    asOf,
    dashboardData: { ...dashboardData, futuresModule: { sectionTitle: 'Session Futures', futures: [], stories: [] } },
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items: [{
      publishedAt: '2026-07-18T15:00:00.000Z',
      title: 'Saturday market fixture',
      url: 'https://www.cnbc.com/2026/07/18/saturday-market.html'
    }] }),
    fetchArticle: async (candidate) => ({
      finalUrl: candidate.url,
      pageTitle: candidate.title,
      description: 'Fixture description.',
      excerpt: 'Fixture article content.',
      publishedAt: new Date(candidate.publishedAt)
    })
  });
  assert.deepEqual(fallbackArtifact.futuresCandidates.map((candidate) => candidate.title), ['Saturday market fixture']);
}

async function testNewsCandidateReviewCapAndProgress() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const reviewed = [];
  const progressArtifacts = [];
  const itemCount = ARTICLE_REVIEW_CANDIDATE_LIMIT + 10;
  const items = Array.from({ length: itemCount }, (_unused, index) => ({
    publishedAt: new Date(Date.parse('2026-07-10T12:00:00.000Z') + index * 1000).toISOString(),
    title: `Cap fixture ${String(index).padStart(3, '0')}`,
    url: `https://www.cnbc.com/2026/07/10/cap-fixture-${String(index).padStart(3, '0')}.html`
  }));
  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items }),
    fetchArticle: async (candidate) => {
      reviewed.push(candidate.title);
      return {
        finalUrl: candidate.url,
        pageTitle: candidate.title,
        description: 'Fixture description.',
        excerpt: 'Fixture article content.',
        publishedAt: new Date(candidate.publishedAt)
      };
    },
    onProgress: (progressArtifact) => progressArtifacts.push(progressArtifact)
  });

  assert.equal(reviewed.length, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.eligibleDownloadedCount, itemCount);
  assert.equal(artifact.articleReview.reviewCandidateCount, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.reviewedCount, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.skippedCount, 10);
  assert.equal(artifact.generalCandidates.length, itemCount, 'Page-enrichment limits must not truncate the editorial inventory.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap fixture 000'), true);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap fixture 259'), true);
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.title === 'Cap fixture 000').article, undefined);
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.title === 'Cap fixture 259').article.accessible, true);
  assert.ok(
    progressArtifacts.some((progressArtifact) => progressArtifact.articleReview?.status === 'acquiring'
      && progressArtifact.generalCandidates.length === 0),
    'Progress artifacts must not expose unreviewed feed candidates.'
  );
  assert.ok(
    progressArtifacts.some((progressArtifact) => progressArtifact.articleReview?.status === 'reviewing'
      && progressArtifact.generalCandidates.length === itemCount),
    'The complete metadata inventory must be staged before page enrichment finishes.'
  );
}

function testArticleMetadataExtraction() {
  const longParagraph = `This fixture paragraph contains enough article text to be retained by the mechanical page extractor ${'and extended context '.repeat(330)}.`;
  const metadata = extractArticleMetadata(`<!doctype html>
    <meta property="og:title" content="Fixture &amp; Markets">
    <meta name="description" content="A useful fixture description.">
    <script type="application/ld+json">{
      "@type":"NewsArticle",
      "headline":"Fixture & Markets",
      "url":"https://finance.yahoo.com/news/fixture.html",
      "datePublished":"2026-07-10T12:30:00-04:00",
      "provider":{"@type":"Organization","name":"Reuters","url":"https://www.reuters.com/"}
    }</script>
    <p>${longParagraph}</p>`);
  assert.equal(metadata.pageTitle, 'Fixture & Markets');
  assert.equal(metadata.description, 'A useful fixture description.');
  assert.equal(metadata.publishedAt.toISOString(), '2026-07-10T16:30:00.000Z');
  assert.match(metadata.excerpt, /mechanical page extractor/);
  assert.equal(metadata.excerpt.length, 5000);
  assert.equal(Object.hasOwn(metadata, 'text'), false);
  assert.equal(Object.hasOwn(metadata, 'providerName'), false);
  assert.equal(Object.hasOwn(metadata, 'providerUrl'), false);
  assert.equal(Object.hasOwn(metadata, 'structuredNewsArticles'), false);

  const decryptMetadata = extractArticleMetadata(`<!doctype html>
    <meta property="article:published_time" content="2026-07-23T10:24:09">
    <script type="application/ld+json">{"datePublished":"2026-07-23T10:24:09"}</script>
    <time dateTime="2026-07-23T10:24:09Z">Jul 23, 2026</time>
    <p>This fixture paragraph contains enough article text to be retained by the mechanical page extractor.</p>`);
  assert.equal(
    decryptMetadata.publishedAt.toISOString(),
    '2026-07-23T10:24:09.000Z',
    'Offset-bearing page metadata must win over ambiguous datePublished values.'
  );
}

function testNewsTimestampParsing() {
  assert.equal(
    parseNewsTimestamp('2026-07-23 13:49:54').toISOString(),
    '2026-07-23T13:49:54.000Z',
    'Offset-less feed timestamps must be treated as GMT.'
  );
  assert.equal(parseNewsTimestamp('Jul 23, 2026 09:49AM ET').toISOString(), '2026-07-23T13:49:00.000Z');
  assert.equal(parseNewsTimestamp('2026-07-23 10:24:09 CDT').toISOString(), '2026-07-23T15:24:09.000Z');
  assert.equal(parseNewsTimestamp('23 Jul 2026 09:49 ET').toISOString(), '2026-07-23T13:49:00.000Z');
  assert.equal(parseNewsTimestamp('Fri, 10 Jul 2026 3:30 PM CT').toISOString(), '2026-07-10T20:30:00.000Z');
  assert.equal(parseNewsTimestamp('Fri, 10 Jul 2026 20:00:00 GMT').toISOString(), '2026-07-10T20:00:00.000Z');
  assert.equal(parseNewsTimestamp('2026-07-23 25:10:00 GMT'), null);
  assert.equal(parseNewsTimestamp('2026-03-08 02:30:00 ET'), null);
  assert.equal(parseNewsTimestamp('2026-02-31 09:49:00'), null);
  assert.equal(parseNewsTimestamp('2026-02-31 09:49:00 GMT'), null);
  assert.equal(parseNewsTimestamp('2026-02-31T09:49:00Z'), null);
  assert.equal(parseNewsTimestamp('2026-02-31T09:49:00-05:00'), null);
  assert.equal(parseNewsTimestamp('Feb 31, 2026 09:49 GMT'), null);
  assert.equal(parseNewsTimestamp('31 Feb 2026 09:49 ET'), null);

  const candidate = normalizeProviderCandidate({
    title: 'Investing no-zone fixture',
    url: 'https://www.investing.com/news/stock-market-news/no-zone-fixture-123',
    publishedAt: '2026-07-23 13:49:54'
  }, { id: 'investing-market', provider: 'rss', pool: 'generalCandidates' }, new Set(['2026-07-23']));
  assert.equal(candidate.publishedAt, '2026-07-23T13:49:54.000Z');

  assert.equal(normalizeProviderCandidate({
    title: 'Malformed provider timestamp fixture',
    url: 'https://www.investing.com/news/stock-market-news/malformed-date-fixture-123',
    publishedAt: '2026-07-23 25:10:00 GMT',
    publishedAtVerified: true
  }, { id: 'investing-market', provider: 'rss', pool: 'generalCandidates' }, new Set(['2026-07-23', '2026-07-24'])), null);

  assert.equal(normalizeProviderCandidate({
    title: 'Impossible provider date fixture',
    url: 'https://www.investing.com/news/stock-market-news/impossible-date-fixture-123',
    publishedAt: '2026-02-31 09:49:00 GMT',
    publishedAtVerified: true
  }, { id: 'investing-market', provider: 'rss', pool: 'generalCandidates' }, new Set(['2026-03-03'])), null);
}

function testRssParsing() {
  const [item] = parseNewsFeed(`<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[Markets &amp; fixture]]></title>
    <link>https://www.cnbc.com/2026/07/10/rss-fixture.html?utm_source=rss</link>
    <pubDate>Fri, 10 Jul 2026 20:00:00 GMT</pubDate>
    <description><![CDATA[<p>Fixture summary.</p>]]></description>
  </item></channel></rss>`);
  assert.equal(item.title, 'Markets & fixture');
  assert.equal(item.url, 'https://www.cnbc.com/2026/07/10/rss-fixture.html?utm_source=rss');
  assert.equal(item.summary, 'Fixture summary.');

  const [atomItem] = parseNewsFeed(`<?xml version="1.0"?><feed><entry>
    <title>Atom fixture</title>
    <link href="https://www.cnbc.com/2026/07/10/atom-fixture.html" />
    <published>2026-07-10T14:00:00Z</published>
    <updated>2026-07-10T20:00:00Z</updated>
    <summary>Atom summary.</summary>
  </entry></feed>`);
  assert.equal(atomItem.publishedAt, '2026-07-10T14:00:00Z');

  const [updatedOnly] = parseNewsFeed(`<?xml version="1.0"?><feed><entry>
    <title>Updated-only fixture</title>
    <link href="https://www.cnbc.com/2026/07/10/updated-only-fixture.html" />
    <updated>2026-07-10T20:00:00Z</updated>
  </entry></feed>`);
  assert.equal(updatedOnly.publishedAt, '');
}

function testApNewsSitemapParsing() {
  const items = parseApNewsSitemap(`<?xml version="1.0"?>
    <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url>
        <lastmod>2026-07-10T20:00:00-04:00</lastmod>
        <loc>https://apnews.com/article/markets-fixture-123</loc>
        <news:news>
          <news:publication>
            <news:name>Associated Press</news:name>
            <news:language>eng</news:language>
          </news:publication>
          <news:publication_date>2026-07-10T14:30:00-04:00</news:publication_date>
          <news:title>Markets &amp; AP fixture</news:title>
        </news:news>
      </url>
      <url>
        <loc>https://apnews.com/article/mercados-fixture-456</loc>
        <news:news>
          <news:publication><news:name>Associated Press</news:name><news:language>spa</news:language></news:publication>
          <news:publication_date>2026-07-10T14:45:00-04:00</news:publication_date>
          <news:title>Spanish fixture</news:title>
        </news:news>
      </url>
      <url>
        <loc>https://apnews.com/live/markets-live-fixture</loc>
        <news:news>
          <news:publication><news:name>Associated Press</news:name><news:language>eng</news:language></news:publication>
          <news:publication_date>2026-07-10T15:00:00-04:00</news:publication_date>
          <news:title>Live fixture</news:title>
        </news:news>
      </url>
      <url>
        <loc>https://apnews.com/article/missing-date-fixture-789</loc>
        <news:news>
          <news:publication><news:name>Associated Press</news:name><news:language>eng</news:language></news:publication>
          <news:title>Missing date fixture</news:title>
        </news:news>
      </url>
    </urlset>`);
  assert.deepEqual(items, [{
    title: 'Markets & AP fixture',
    url: 'https://apnews.com/article/markets-fixture-123',
    publishedAt: '2026-07-10T18:30:00.000Z',
    language: 'eng',
    publishedAtVerified: true
  }]);
}

function reutersNewsSitemapEntry({
  title = 'Reuters fixture headline',
  url = 'https://www.reuters.com/markets/us/reuters-fixture-2026-07-10/',
  publishedAt = '2026-07-10T18:30:00.000Z',
  publicationName = 'Reuters',
  language = 'en'
} = {}) {
  return `<url>
    <loc>${url}</loc>
    <news:news>
      <news:publication><news:name>${publicationName}</news:name><news:language>${language}</news:language></news:publication>
      <news:publication_date>${publishedAt}</news:publication_date>
      <news:title><![CDATA[${title}]]></news:title>
    </news:news>
  </url>`;
}

function reutersNewsSitemap(entries) {
  return `<?xml version="1.0"?><urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${entries.join('')}</urlset>`;
}

function testReutersNewsSitemapParsing() {
  const index = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap>
    <sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&amp;from=100</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseReutersNewsSitemapIndex(index), [
    'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&size=100',
    'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&size=100&from=100'
  ], 'Reuters sitemap slices must explicitly request 100 rows so index offsets do not skip records.');
  for (const malformed of [
    undefined,
    null,
    42,
    [],
    {},
    '<urlset></urlset>',
    `<root>${index}</root>`
  ]) {
    assert.throws(() => parseReutersNewsSitemapIndex(malformed), /sitemapindex/);
  }
  for (const malformed of [
    '<sitemapindex></sitemapindex>',
    '<sitemapindex><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&amp;from=100</loc></sitemapindex>'
  ]) {
    assert.throws(
      () => parseReutersNewsSitemapIndex(malformed),
      /malformed sitemap entries/,
      'Empty or structurally incomplete Reuters indexes must fail acquisition.'
    );
  }
  assert.throws(
    () => parseReutersNewsSitemapIndex('<sitemapindex><sitemap><loc>https://evil.example/news.xml</loc></sitemap></sitemapindex>'),
    /invalid page URL/,
    'Computed sitemap targets must remain on the fixed Reuters endpoint.'
  );
  for (const malformedOffsets of [
    '<sitemapindex><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap></sitemapindex>',
    '<sitemapindex><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap><sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&amp;from=200</loc></sitemap></sitemapindex>'
  ]) {
    assert.throws(
      () => parseReutersNewsSitemapIndex(malformedOffsets),
      /duplicate or non-contiguous/,
      'Direct Reuters acquisition must not treat duplicate or gapped index offsets as a complete scan.'
    );
  }

  const entries = parseReutersNewsSitemap(reutersNewsSitemap([
    reutersNewsSitemapEntry(),
    reutersNewsSitemapEntry({
      title: 'Reuters modified-date fixture',
      url: 'https://www.reuters.com/markets/us/reuters-modified-date-fixture-2026-07-09/',
      publishedAt: '2026-07-10T18:30:00.000Z'
    }),
    reutersNewsSitemapEntry({ url: 'https://www.reuters.com/fr/affaires/french-fixture-2026-07-10/' }),
    reutersNewsSitemapEntry({ url: 'https://www.reuters.com/default/legacy-fixture-2024-11-11/', title: 'مثال موروث' }),
    reutersNewsSitemapEntry({ url: 'https://evil.example/reuters-fixture', title: 'External fixture' }),
    reutersNewsSitemapEntry({ url: 'https://www.reuters.com/markets/us/undated-fixture/', title: 'Undated fixture' }),
    reutersNewsSitemapEntry({ publishedAt: 'not-a-date', title: 'Malformed date fixture' }),
    reutersNewsSitemapEntry({ publishedAt: '2026-07-10T18:30:00', title: 'Timezone-free date fixture' }),
    reutersNewsSitemapEntry({ publicationName: 'Not Reuters', title: 'Wrong publication fixture' })
  ]));
  assert.deepEqual(entries, [{
    title: 'Reuters fixture headline',
    url: 'https://www.reuters.com/markets/us/reuters-fixture-2026-07-10',
    publishedOn: '2026-07-10',
    publishedAt: '2026-07-10T18:30:00.000Z',
    language: 'en',
    publicationName: 'Reuters',
    providerSourceName: 'Reuters',
    publishedAtVerified: true
  }, {
    title: 'Reuters modified-date fixture',
    url: 'https://www.reuters.com/markets/us/reuters-modified-date-fixture-2026-07-09',
    publishedOn: '2026-07-09',
    language: 'en',
    publicationName: 'Reuters',
    providerSourceName: 'Reuters'
  }], 'Malformed, external, and non-English entries must be isolated without discarding the valid Reuters entry.');

  const matchingCandidate = normalizeProviderCandidate(entries[0], {
    id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates'
  }, new Set(['2026-07-10']));
  assert.equal(matchingCandidate.publishedAtVerified, true);
  assert.equal(matchingCandidate.dateSource, 'provider_published');

  const modifiedCandidate = normalizeProviderCandidate(entries[1], {
    id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates'
  }, new Set(['2026-07-09']));
  assert.equal(modifiedCandidate.publishedOn, '2026-07-09');
  assert.equal(modifiedCandidate.publishedAt, undefined);
  assert.equal(modifiedCandidate.publishedAtVerified, undefined);
  assert.equal(modifiedCandidate.dateSource, 'url_published_date');
  assert.equal(normalizeProviderCandidate({ ...entries[1], publishedAtVerified: true }, {
    id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates'
  }, new Set(['2026-07-09'])).publishedAtVerified, undefined,
  'A date-only candidate must not retain verified status without an exact timestamp.');
  assert.equal(candidateInFuturesPublicationWindow(modifiedCandidate, {
    start: new Date('2026-07-09T00:00:00.000Z'),
    end: new Date('2026-07-11T00:00:00.000Z')
  }), false, 'A conflicting Reuters sitemap timestamp must not qualify for an exact Futures window.');
  assert.equal(normalizeProviderCandidate(entries[1], {
    id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates'
  }, new Set(['2026-07-10'])), null, 'A fresh sitemap modification must not make a stale Reuters URL date eligible.');
  assert.equal(normalizeProviderCandidate({
    title: 'Non-Reuters date-only fixture',
    url: 'https://www.cnbc.com/2026/07/10/date-only-fixture.html',
    publishedOn: '2026-07-10'
  }, {
    id: 'cnbc', provider: 'rss', pool: 'generalCandidates'
  }, new Set(['2026-07-10'])), null, 'Date-only freshness must remain restricted to the Reuters URL contract.');
  for (const malformed of [
    undefined,
    null,
    42,
    [],
    {},
    '<sitemapindex></sitemapindex>',
    `<root>${reutersNewsSitemap([reutersNewsSitemapEntry()])}</root>`
  ]) {
    assert.throws(() => parseReutersNewsSitemap(malformed), /urlset/);
  }
  for (const malformed of [
    '<urlset></urlset>',
    `<urlset>${reutersNewsSitemapEntry().replace('</url>', '')}</urlset>`
  ]) {
    assert.throws(
      () => parseReutersNewsSitemap(malformed),
      /malformed or no URL entries/,
      'Empty or structurally incomplete Reuters slices must not pass as successful empty acquisitions.'
    );
  }
  for (const unusable of [
    reutersNewsSitemap([reutersNewsSitemapEntry().replace('</loc>', '')]),
    reutersNewsSitemap([reutersNewsSitemapEntry({ publicationName: 'Not Reuters' })])
  ]) {
    assert.throws(
      () => parseReutersNewsSitemap(unusable),
      /no valid English article entries/,
      'A Reuters slice with zero usable entries must fail instead of reporting a successful empty acquisition.'
    );
  }

}

async function testSharedCryptoPoolPromotion() {
  const eligibleDates = new Set(['2026-07-10']);
  const generalPath = { id: 'ap-public', provider: 'ap-public', pool: 'generalCandidates' };
  const baseItem = {
    url: 'https://apnews.com/article/crypto-routing-fixture',
    publishedAt: '2026-07-10T18:30:00.000Z',
    publishedAtVerified: true
  };
  for (const title of ['Bitcoin adoption expands', 'Stablecoin legislation clears committee']) {
    const candidate = normalizeProviderCandidate({ ...baseItem, title }, generalPath, eligibleDates);
    assert.equal(candidate.pool, 'cryptoCandidates');
    assert.equal(candidate.publishedAtVerified, true);
  }
  for (const title of ['Token award boosts developer usage', 'Wallet maker expands retail distribution']) {
    assert.equal(normalizeProviderCandidate({ ...baseItem, title }, generalPath, eligibleDates).pool, 'generalCandidates');
  }

  const reutersPath = { id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates' };
  const [reutersCryptoTitle] = parseReutersNewsSitemap(reutersNewsSitemap([
    reutersNewsSitemapEntry({
      title: 'Bitcoin market structure shifts',
      url: 'https://www.reuters.com/technology/bitcoin-market-structure-2026-07-10/'
    })
  ]));
  const artifact = await collectNewsCandidates({
    asOf: new Date('2026-07-10T19:00:00.000Z'),
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [generalPath, reutersPath],
    clock: () => new Date('2026-07-10T19:00:00.000Z'),
    fetchPath: async (acquisitionPath) => ({
      items: acquisitionPath.id === 'reuters-public' ? [reutersCryptoTitle] : [{
        ...baseItem,
        title: 'Bitcoin adoption expands',
        url: 'https://apnews.com/article/bitcoin-routing-fixture'
      }, {
        ...baseItem,
        title: 'Token award boosts developer usage',
        url: 'https://apnews.com/article/token-routing-fixture'
      }]
    }),
    fetchArticle: async () => {
      throw new Error('Verified fixtures must not require article-page review.');
    }
  });
  assert.deepEqual(artifact.generalCandidates.map((candidate) => candidate.title), ['Token award boosts developer usage']);
  assert.deepEqual(
    artifact.cryptoCandidates.map((candidate) => candidate.title).sort(),
    ['Bitcoin adoption expands', 'Bitcoin market structure shifts']
  );
  assert.deepEqual(artifact.futuresCandidates.map((candidate) => candidate.title), ['Token award boosts developer usage']);
}

async function testReutersNewsSitemapFetchIsolation() {
  const pathConfig = {
    id: 'reuters-public',
    provider: 'reuters-public',
    pool: 'generalCandidates',
    feedUrl: 'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml'
  };
  const requests = [];
  const index = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml</loc></sitemap>
    <sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&amp;from=100</loc></sitemap>
    <sitemap><loc>https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml&amp;from=200</loc></sitemap>
  </sitemapindex>`;
  const result = await fetchAcquisitionPath(pathConfig, {
    timeoutMs: 1000,
    fetchPage: async (url, requestOptions) => {
      requests.push(String(url));
      assert.equal(requestOptions.allowRedirect(new URL(url), new URL(url)), true);
      assert.equal(requestOptions.allowRedirect(new URL('https://evil.example/news.xml'), new URL(url)), false);
      if (String(url).includes('news-sitemap-index')) return { text: async () => index };
      if (String(url).includes('from=100')) {
        return { text: async () => reutersNewsSitemap([reutersNewsSitemapEntry().replace('</loc>', '')]) };
      }
      if (String(url).includes('from=200')) return { url: 'https://evil.example/news.xml', text: async () => reutersNewsSitemap([reutersNewsSitemapEntry()]) };
      return { text: async () => reutersNewsSitemap([reutersNewsSitemapEntry()]) };
    }
  });
  assert.equal(result.pageCount, 3);
  assert.equal(result.failedPageCount, 2);
  assert.match(result.error, /2 of 3 slices failed/);
  assert.equal(result.items.length, 1, 'One unavailable slice must not discard entries from valid Reuters slices.');
  assert.equal(result.items[0].publishedAtVerified, true);
  assert.ok(requests.filter((url) => !url.includes('news-sitemap-index')).every((url) => new URL(url).searchParams.get('size') === '100'));
  await assert.rejects(
    () => fetchReutersPublic({ ...pathConfig, feedUrl: 'https://evil.example/news.xml' }, { timeoutMs: 1000 }),
    /fixed public index URL/,
    'Reuters acquisition must not accept a computed or substituted index target.'
  );
}

function testArticleRedirectPolicy() {
  const candidateUrl = 'https://www.cnbc.com/2026/07/10/fixture.html';
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://api.cnbc.com/article/fixture')), true);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('http://www.cnbc.com/article/fixture')), false);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://www.cnbc.com:8443/article/fixture')), false);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://cnbc.com.evil.example/article/fixture')), false);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://example.com/article/fixture')), false);
  const dynamicUrl = 'https://financefeeds.com/ibit-fixture';
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://www.financefeeds.com/ibit-fixture-final')), true);
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://news.financefeeds.com/ibit-fixture-final')), false);
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://financefeeds.com.evil.example/ibit-fixture-final')), false);
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://reader:secret@financefeeds.com/ibit-fixture-final')), false);
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://financefeeds.com:8443/ibit-fixture-final')), false);
  assert.equal(articleRedirectAllowed(dynamicUrl, new URL('https://127.0.0.1/ibit-fixture-final')), false);
  assert.equal(articleRedirectAllowed('https://127.0.0.1/ibit-fixture', new URL('https://127.0.0.1/ibit-fixture-final')), false);
  const approvedMarketauxUrl = 'https://finance.yahoo.com/news/ibit-fixture';
  assert.equal(articleRedirectAllowed(approvedMarketauxUrl, new URL('https://news.finance.yahoo.com/news/ibit-fixture-final')), true);
}

async function testNewsFetchResponseTransport() {
  const targetRequests = [];
  const target = await startHttpServer((req, res) => {
    targetRequests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('redirect ok');
  });
  const server = await startHttpServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/gzip' });
      res.end();
      return;
    }
    if (url.pathname === '/cross-origin') {
      res.writeHead(302, { location: `${target.baseUrl}/target` });
      res.end();
      return;
    }
    if (url.pathname === '/credential-redirect') {
      res.writeHead(302, { location: `${server.baseUrl.replace('http://', 'http://user:pass@')}/gzip` });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/redirect-loop/')) {
      const count = Number(url.pathname.split('/').pop() || 0);
      res.writeHead(302, { location: `/redirect-loop/${count + 1}` });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/deadline-redirect/')) {
      const count = Number(url.pathname.split('/').pop() || 0);
      setTimeout(() => {
        res.writeHead(302, { location: count < 3 ? `/deadline-redirect/${count + 1}` : '/deadline-final' });
        res.end();
      }, 25);
      return;
    }
    if (url.pathname === '/deadline-final') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('deadline ok');
      return;
    }
    if (url.pathname === '/huge-header') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-fixture': 'x'.repeat(70_000) });
      res.end('header');
      return;
    }
    if (url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('compressed fixture'));
      return;
    }
    if (url.pathname === '/gzip-expanded') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('x'.repeat(1000)));
      return;
    }
    if (url.pathname === '/over-limit') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(17));
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 100);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const redirected = await fetchResponse(`${server.baseUrl}/redirect`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } });
    assert.equal(redirected.url, `${server.baseUrl}/gzip`);
    assert.equal(await redirected.text(), 'compressed fixture');

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/over-limit`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
      /exceeded 16 decoded bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/gzip`, { timeoutMs: 1000, maxBodyBytes: 4, headers: { Accept: 'text/plain' } }),
      /exceeded 4 compressed bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/gzip-expanded`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
      /larger than 16 bytes|unexpected end|decompression failed|exceeded 16 decoded bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/redirect-loop/0`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } }),
      /Too many redirects after 5/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/credential-redirect`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } }),
      /outside the request policy/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/slow`, { timeoutMs: 20, headers: { Accept: 'text/plain' } }),
      /Request timed out/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/deadline-redirect/0`, { timeoutMs: 70, headers: { Accept: 'text/plain' } }),
      /Request timed out/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/huge-header`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } }),
      /Header overflow|Parse Error|HPE_HEADER_OVERFLOW/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/cross-origin`, {
        timeoutMs: 1000,
        headers: { Accept: 'text/plain', Authorization: 'Bearer fixture-secret' }
      }),
      /outside the request policy/
    );
    assert.equal(targetRequests.length, 0);

    await fetchResponse(`${server.baseUrl}/cross-origin`, {
      timeoutMs: 1000,
      headers: { Accept: 'text/plain', Authorization: 'Bearer fixture-secret' },
      allowRedirect: (nextUrl) => nextUrl.origin === target.baseUrl
    });
    assert.equal(targetRequests[0].authorization, undefined);
  } finally {
    await closeHttpServer(server.server);
    await closeHttpServer(target.server);
  }
}

async function testNewsTransportFailureIsolation() {
  const server = await startHttpServer((req, res) => {
    if (req.url === '/bad') {
      res.writeHead(302, { location: 'http://[invalid' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0"?>
      <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://apnews.com/article/isolation-fixture-123</loc>
          <news:news>
            <news:publication><news:name>Associated Press</news:name><news:language>eng</news:language></news:publication>
            <news:publication_date>2026-07-10T14:30:00-04:00</news:publication_date>
            <news:title>Isolation fixture</news:title>
          </news:news>
        </url>
      </urlset>`);
  });
  try {
    const asOf = new Date('2026-07-10T21:00:00.000Z');
    const artifact = await collectNewsCandidates({
      asOf,
      acquisitionPaths: [
        { id: 'bad-ap', provider: 'ap-public', pool: 'generalCandidates', feedUrl: `${server.baseUrl}/bad` },
        { id: 'good-ap', provider: 'ap-public', pool: 'generalCandidates', feedUrl: `${server.baseUrl}/good` }
      ],
      searchTimeoutMs: 1000,
      clock: () => asOf,
      fetchArticle: async () => {
        throw new Error('Provider-verified AP candidates must bypass article review.');
      }
    });
    assert.equal(artifact.generalCandidates.length, 1);
    assert.equal(artifact.generalCandidates[0].title, 'Isolation fixture');
    assert.match(artifact.attempts.find((attempt) => attempt.id === 'bad-ap').error, /Invalid URL/);
    assert.equal(artifact.attempts.find((attempt) => attempt.id === 'good-ap').error, null);
  } finally {
    await closeHttpServer(server.server);
  }
}

async function testApPublicAcquisitionUsesOneSitemapFetch() {
  const calls = [];
  const server = await startHttpServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0"?>
      <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://apnews.com/article/markets-fixture-123</loc>
          <news:news>
            <news:publication><news:name>Associated Press</news:name><news:language>eng</news:language></news:publication>
            <news:publication_date>2026-07-10T14:30:00-04:00</news:publication_date>
            <news:title>Markets fixture</news:title>
          </news:news>
        </url>
      </urlset>`);
  });
  try {
    const result = await fetchAcquisitionPath({
      id: 'ap-public',
      provider: 'ap-public',
      pool: 'generalCandidates',
      feedUrl: `${server.baseUrl}/news-sitemap-content.xml`
    }, { timeoutMs: 1000 });
    assert.equal(calls.length, 1, 'AP public acquisition should fetch only the sitemap.');
    assert.deepEqual(result.items, [{
      title: 'Markets fixture',
      url: 'https://apnews.com/article/markets-fixture-123',
      publishedAt: '2026-07-10T18:30:00.000Z',
      language: 'eng',
      publishedAtVerified: true
    }]);
  } finally {
    await closeHttpServer(server.server);
  }
}

async function testVerifiedCandidatesBypassReviewLimitWithoutInventoryCap() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const verifiedItems = Array.from({ length: ARTICLE_REVIEW_CANDIDATE_LIMIT + 10 }, (_unused, index) => ({
    publishedAt: new Date(Date.parse('2026-07-10T12:00:00.000Z') + index * 1000).toISOString(),
    title: `Verified Reuters fixture ${String(index).padStart(3, '0')}`,
    url: `https://www.reuters.com/markets/us/verified-reuters-fixture-${String(index).padStart(3, '0')}-2026-07-10/`,
    publishedAtVerified: true
  }));
  const cryptoItem = {
    publishedAt: '2026-07-10T20:00:00.000Z',
    title: 'Independent crypto fixture',
    url: 'https://www.coindesk.com/markets/2026/07/10/independent-crypto-fixture/'
  };
  const reviewed = [];

  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [
      { id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates' },
      { id: 'coindesk', provider: 'rss', pool: 'cryptoCandidates' }
    ],
    clock: () => asOf,
    fetchPath: async (acquisitionPath) => ({ items: acquisitionPath.id === 'reuters-public' ? verifiedItems : [cryptoItem] }),
    fetchArticle: async (candidate) => {
      assert.equal(candidate.sourceId, 'coindesk', 'Verified Reuters candidates must not spend article-review slots.');
      reviewed.push(candidate.title);
      return {
        finalUrl: candidate.url,
        pageTitle: candidate.title,
        description: 'Fixture description.',
        excerpt: 'Fixture article content.',
        publishedAt: new Date(candidate.publishedAt)
      };
    }
  });

  assert.deepEqual(reviewed, [cryptoItem.title]);
  assert.equal(artifact.articleReview.eligibleDownloadedCount, verifiedItems.length + 1);
  assert.equal(artifact.articleReview.reviewCandidateCount, 1);
  assert.equal(artifact.generalCandidates.length, verifiedItems.length);
  assert.equal(artifact.futuresCandidates.length, verifiedItems.length);
  assert.equal(artifact.cryptoCandidates.length, 1, 'A large Reuters result must not crowd out the independent Crypto pool.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Verified Reuters fixture 000'), true);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Verified Reuters fixture 259'), true);
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.sourceLabel === 'Reuters'));
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.dateSource === 'provider_published'));
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.publishedAtVerified === true));
}

async function testUpdatedOnlyFeedsDoNotCreatePublishedCandidates() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [{ id: 'fixture-rss', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items: parseNewsFeed(`<?xml version="1.0"?><feed><entry>
      <title>Updated-only fixture</title>
      <link href="https://www.cnbc.com/2026/07/10/updated-only-fixture.html" />
      <updated>2026-07-10T20:00:00Z</updated>
    </entry></feed>`) }),
    fetchArticle: async () => {
      throw new Error('updated-only candidate should not reach article review');
    }
  });
  assert.equal(artifact.generalCandidates.length, 0, 'Feed updated timestamps must not masquerade as original publication time.');
}

function testBaselineSanitization() {
  assert.deepEqual(sanitizeNewsBaseline(null), {
    lastScheduledUpdateAt: null,
    lastScheduledWindow: null,
    previousScheduledStoryIds: [],
    currentScheduledStoryIds: []
  });
  assert.deepEqual(sanitizeNewsBaseline({
    lastScheduledUpdateAt: 42,
    lastScheduledWindow: '2026-07-06:morning',
    previousScheduledStoryIds: ['url:b', 'url:a', 'url:a', null],
    currentScheduledStoryIds: 'invalid'
  }), {
    lastScheduledUpdateAt: null,
    lastScheduledWindow: '2026-07-06:morning',
    previousScheduledStoryIds: ['url:a', 'url:b'],
    currentScheduledStoryIds: []
  });
}

function testManualBaselineTransition() {
  const previousStory = story('Previous', 'https://example.com/previous');
  const currentStory = story('Current', 'https://example.com/current');
  const incomingStory = story('Incoming', 'https://example.com/incoming');
  const previousData = {
    newsBaseline: {
      lastScheduledUpdateAt: '2026-07-06T12:00:00.000Z',
      lastScheduledWindow: '2026-07-06:morning',
      previousScheduledStoryIds: [storyIdentity(previousStory)],
      currentScheduledStoryIds: [storyIdentity(currentStory)]
    }
  };
  const data = { stories: [previousStory, currentStory, incomingStory], crypto: { notes: [] } };
  applyScheduledNewsBaseline(data, previousData);
  assert.equal(data.stories.some((item) => 'isNewSinceScheduledUpdate' in item), false);
  assert.deepEqual(data.newsBaseline, previousData.newsBaseline);

  const currentFallbackData = { stories: [currentStory, incomingStory], crypto: { notes: [] } };
  applyScheduledNewsBaseline(currentFallbackData, {
    newsBaseline: { ...previousData.newsBaseline, previousScheduledStoryIds: [] }
  });
  assert.equal(currentFallbackData.stories.some((item) => 'isNewSinceScheduledUpdate' in item), false);
}

function testScheduledBaselineTransition() {
  const existingMarket = story('Existing Market', 'https://example.com/market/existing');
  const newMarket = story('New Market', 'https://example.com/market/new');
  const existingCrypto = story('Existing Crypto', 'https://example.com/crypto/existing');
  const newCrypto = story('New Crypto', 'https://example.com/crypto/new');
  const previousIds = [storyIdentity(existingMarket), storyIdentity(existingCrypto)].sort();
  const previousData = {
    newsBaseline: {
      lastScheduledUpdateAt: '2026-07-05T12:00:00.000Z',
      lastScheduledWindow: '2026-07-05:afternoon',
      previousScheduledStoryIds: [],
      currentScheduledStoryIds: previousIds
    }
  };
  const data = {
    stories: [existingMarket, newMarket],
    crypto: { notes: [existingCrypto, newCrypto] }
  };
  applyScheduledNewsBaseline(data, previousData, {
    scheduled: true,
    scheduledWindow: 'morning',
    now: new Date('2026-07-06T12:00:00.000Z')
  });
  assert.equal(data.stories.some((item) => 'isNewSinceScheduledUpdate' in item), false);
  assert.equal(data.crypto.notes.some((item) => 'isNewSinceScheduledUpdate' in item), false);
  assert.deepEqual(data.newsBaseline.previousScheduledStoryIds, previousIds);
  assert.deepEqual(data.newsBaseline.currentScheduledStoryIds, sortedDashboardNewsIds(data));
  assert.equal(data.newsBaseline.lastScheduledUpdateAt, '2026-07-06T12:00:00.000Z');
  assert.equal(data.newsBaseline.lastScheduledWindow, '2026-07-06:morning');

  const afternoon = { stories: [existingMarket], crypto: { notes: [] } };
  applyScheduledNewsBaseline(afternoon, previousData, {
    scheduled: true,
    scheduledWindow: 'afternoon',
    now: new Date('2026-07-07T01:00:00.000Z')
  });
  assert.equal(afternoon.newsBaseline.lastScheduledWindow, '2026-07-06:afternoon');

  assert.throws(
    () => applyScheduledNewsBaseline({ stories: [], crypto: { notes: [] } }, previousData, {
      scheduled: true,
      scheduledWindow: 'overnight',
      now: new Date('2026-07-06T12:00:00.000Z')
    }),
    /requires a staged Morning Edition or Afternoon Edition dashboard/
  );
}

function testScheduledStartAndFinalizationGuards() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-scheduled-guard-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const baseline = {
    lastScheduledUpdateAt: '2026-07-08T21:00:00.000Z',
    lastScheduledWindow: '2026-07-08:afternoon',
    previousScheduledStoryIds: [],
    currentScheduledStoryIds: []
  };
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
  assert.throws(
    () => validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-09T12:44:00.000Z')),
    /outside its America\/Chicago update window/
  );
  assert.equal(
    validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-09T12:45:00.000Z')),
    '2026-07-09:morning'
  );
  assert.equal(
    validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-09T14:00:00.000Z')),
    '2026-07-09:morning'
  );
  assert.throws(
    () => validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-09T14:01:00.000Z')),
    /outside its America\/Chicago update window/
  );
  assert.throws(
    () => validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-11T12:45:00.000Z')),
    /only permit weekday starts/
  );
  assert.equal(
    validateScheduledFinalization(dashboardFile, 'morning', new Date('2026-07-09T14:30:00.000Z')),
    '2026-07-09:morning',
    'A scheduled run that started correctly may finalize after the wall-clock window closes.'
  );
  baseline.lastScheduledWindow = '2026-07-09:morning';
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
  assert.throws(
    () => validateScheduledStart(dashboardFile, 'morning', new Date('2026-07-09T13:00:00.000Z')),
    /Scheduled run refused: 2026-07-09:morning already completed/
  );
  assert.throws(
    () => validateScheduledFinalization(dashboardFile, 'morning', new Date('2026-07-09T14:30:00.000Z')),
    /Scheduled run refused: 2026-07-09:morning already completed/
  );
}


async function main() {
  testStoryIdentityContract();
  testDashboardNewsCollections();
  testNewsCoverageState();
  testFuturesPublicationTimestampValidation();
  testMondayMorningFreshnessWindow();
  await testAlphaVantageProviderErrorRedaction();
  await testStockfitProviderRequestHeaders();
  await testMarketauxTickerAcquisition();
  await testMarketauxTickerPriorCardCarryForward();
  testCryptoRssSourceManifest();
  testArticleMetadataExtraction();
  testNewsTimestampParsing();
  testRssParsing();
  testApNewsSitemapParsing();
  testReutersNewsSitemapParsing();
  await testSharedCryptoPoolPromotion();
  await testReutersNewsSitemapFetchIsolation();
  testArticleRedirectPolicy();
  await testNewsFetchResponseTransport();
  await testNewsTransportFailureIsolation();
  await testApPublicAcquisitionUsesOneSitemapFetch();
  await testVerifiedCandidatesBypassReviewLimitWithoutInventoryCap();
  await testUpdatedOnlyFeedsDoNotCreatePublishedCandidates();
  await testDeterministicNewsCandidateAcquisition();
  await testFuturesCandidatesUseDisplayedSessionWindow();
  await testNewsCandidateReviewCapAndProgress();
  testBaselineSanitization();
  testManualBaselineTransition();
  testScheduledBaselineTransition();
  testScheduledStartAndFinalizationGuards();
  process.stdout.write('News tests passed.\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
