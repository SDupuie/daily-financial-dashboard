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
const { newsAcquisitionPaths } = require('./news_sources');
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
  assert.deepEqual(NEWS_COVERAGE_POLICIES.cryptoNotes, { label: 'crypto.notes', minimum: 6, maximum: 12 });
  assert.deepEqual(NEWS_COVERAGE_POLICIES.futuresStories, { label: 'futuresModule.stories', minimum: 3, maximum: 3 });
  assert.deepEqual(validateNewsCoverageState(undefined, 9, NEWS_COVERAGE_POLICIES.stories), []);
  assert.deepEqual(validateNewsCoverageState(undefined, 6, NEWS_COVERAGE_POLICIES.cryptoNotes), []);
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
    validateNewsCoverageState(undefined, 13, NEWS_COVERAGE_POLICIES.cryptoNotes).join(' '),
    /crypto\.notes must contain no more than 12 items/
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
      title: 'Removed-source prior market card',
      url: 'https://www.investors.com/prior-market',
      publishedOn: '2026-07-10',
      sourceLabel: "Investor's Business Daily",
      tag: 'Prior',
      body: 'This card must not re-enter review after its source is removed.'
    }],
    futuresModule: { stories: [] },
    crypto: { notes: [{
      title: 'Still-fresh prior crypto card',
      url: 'https://www.coindesk.com/prior-crypto',
      publishedOn: '2026-07-10',
      sourceLabel: 'Fixture News',
      tag: 'Prior',
      body: 'Previously reviewed crypto copy.'
    }] }
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
      }, {
        publishedAt: '2026-07-01T20:00:00.000Z',
        title: 'Stale provider fixture',
        url: 'https://www.cnbc.com/2026/07/01/stale-provider-fixture.html'
      }] };
      if (acquisitionPath.id === 'alpha-blockchain') return { items: [{
        publishedAt: '2026-07-10T18:00:00.000Z',
        title: 'Crypto direct duplicate fixture',
        url: 'https://www.coindesk.com/markets/2026/07/10/crypto-fixture'
      }] };
      if (acquisitionPath.id === 'stockfit-market') return { items: [{
        publishedAt: '2026-07-10T19:00:00.000Z',
        title: 'Removed MarketWatch fixture',
        url: 'https://www.marketwatch.com/story/direct-fixture?mod=stockfit'
      }, {
        publishedAt: '2026-07-10T19:30:00.000Z',
        publishedAtVerified: true,
        title: 'Yahoo hosted fixture one',
        url: 'https://finance.yahoo.com/news/validated-fixture.html?.tsrc=stockfit',
        providerSourceName: 'Yahoo Finance'
      }, {
        publishedAt: '2026-07-10T19:15:00.000Z',
        title: 'Yahoo hosted fixture two',
        url: 'https://finance.yahoo.com/news/unresolved-fixture.html',
        providerSourceName: 'Yahoo Finance'
      }] };
      if (acquisitionPath.id === 'cnbc') return { items: [{
        publishedAt: '2026-07-10T20:00:00.000Z',
        title: 'CNBC direct duplicate fixture',
        url: 'https://www.cnbc.com/2026/07/10/direct-fixture.html'
      }] };
      if (acquisitionPath.id === 'coindesk') return { items: [{
        publishedAt: '2026-07-10T18:00:00.000Z',
        title: 'Crypto direct duplicate fixture',
        url: 'https://www.coindesk.com/markets/2026/07/10/crypto-fixture'
      }] };
      if (acquisitionPath.id === 'reuters-public') return { items: [{
        publishedAt: '2026-07-10T18:45:00.000Z',
        publishedAtVerified: true,
        title: 'Reuters direct sitemap fixture',
        url: 'https://www.reuters.com/markets/us/reuters-direct-sitemap-fixture-2026-07-10',
        providerSourceName: 'Reuters'
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

  assert.deepEqual([...calls].sort(), acquisitionPaths.map((entry) => entry.id).sort(), 'Every configured API and direct-feed path must be attempted.');
  assert.deepEqual(artifact.attempts.map((attempt) => attempt.id), acquisitionPaths.map((entry) => entry.id), 'Acquisition attempts must remain in manifest order.');
  assert.ok(
    calls.indexOf('stockfit-market') >= 0 && calls.indexOf('stockfit-market') < calls.indexOf('alpha-blockchain'),
    'Distinct non-Alpha endpoints should not wait for the second paced Alpha call.'
  );
  assert.deepEqual(pauses, [1250], 'The two Alpha Vantage calls must be paced.');
  assert.equal(artifact.generalCandidates.length, 5, 'Direct Reuters, the CNBC duplicate, two Yahoo stories, and the prior card must remain available once each.');
  assert.equal(artifact.cryptoCandidates.length, 2, 'The direct Crypto duplicate and prior Crypto card must both reach editorial review.');
  const cnbc = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'cnbc');
  assert.equal(cnbc.provider, 'rss', 'A direct feed must win deterministic provenance deduplication over an aggregator copy.');
  assert.equal(cnbc.sourceLabel, 'CNBC');
  assert.equal(cnbc.publishedAtVerified, true, 'Article-page review must mark provider timestamps verified after confirmation.');
  assert.deepEqual(cnbc.searchPathIds, ['cnbc', 'alpha-financial-markets']);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Removed MarketWatch fixture'), false);
  const reuters = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'reuters');
  assert.equal(reuters.provider, 'reuters-public');
  assert.equal(reuters.sourceLabel, 'Reuters');
  assert.equal(reuters.url, 'https://www.reuters.com/markets/us/reuters-direct-sitemap-fixture-2026-07-10');
  assert.equal(reuters.publishedAtVerified, true);
  assert.equal(candidateInFuturesPublicationWindow(reuters, {
    start: new Date('2026-07-10T18:30:00.000Z'),
    end: new Date('2026-07-10T19:00:00.000Z')
  }), true, 'A Reuters sitemap timestamp must use the shared exact Futures predicate.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Stale provider fixture'), false);
  const yahooCandidates = artifact.generalCandidates.filter((candidate) => candidate.sourceId === 'yahoo-finance');
  assert.equal(yahooCandidates.length, 2);
  assert.ok(yahooCandidates.every((candidate) => candidate.sourceLabel === 'Yahoo Finance'));
  assert.ok(yahooCandidates.every((candidate) => candidate.url.startsWith('https://finance.yahoo.com/news/')));
  assert.ok(yahooCandidates.every((candidate) => candidate.dateSource === 'hosted_syndication'));
  assert.ok(yahooCandidates.every((candidate) => candidate.publishedAtVerified !== true), 'Yahoo-hosted timestamps must remain provisional even when an upstream item claims verification.');
  const priorMarket = artifact.generalCandidates.find((candidate) => candidate.priorCard);
  assert.equal(priorMarket.sourceLabel, 'Fixture News');
  assert.equal(priorMarket.priorCopy.tag, 'Prior');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Removed-source prior market card'), false);
  assert.equal(artifact.attempts.find((attempt) => attempt.id === 'axios').error, 'fixture provider failure');
  assert.equal(artifact.attempts.find((attempt) => attempt.id === 'coindesk').acceptedCount, 1);
  assert.equal(artifact.articleReview.status, 'complete');
}

async function testFuturesCandidatesUseDisplayedSessionWindow() {
  const asOf = new Date('2026-07-19T17:00:00.000Z');
  const sessionFuture = (symbol) => ({ symbol, raw: { sessionDate: '2026-07-17' } });
  const dashboardData = {
    stories: [],
    futuresModule: {
      sectionTitle: 'Session Futures',
      futures: ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'].map(sessionFuture),
      stories: []
    },
    crypto: { notes: [] }
  };
  const collect = (futuresModule = dashboardData.futuresModule) => collectNewsCandidates({
    asOf,
    dashboardData: { ...dashboardData, futuresModule },
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items: [{
      publishedAt: '2026-07-17T15:00:00.000Z',
      title: 'Friday session futures fixture',
      url: 'https://www.cnbc.com/2026/07/17/friday-session-futures.html'
    }, {
      publishedAt: '2026-07-17T21:00:00.000Z',
      title: 'Friday after-close fixture',
      url: 'https://www.cnbc.com/2026/07/17/friday-after-close.html'
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

  const artifact = await collect();
  assert.deepEqual(artifact.generalCandidates.map((candidate) => candidate.title), ['Saturday market fixture']);
  assert.deepEqual(artifact.futuresCandidates.map((candidate) => candidate.title), ['Friday session futures fixture']);

  const fallbackArtifact = await collect({ sectionTitle: 'Session Futures', futures: [], stories: [] });
  assert.deepEqual(fallbackArtifact.generalCandidates.map((candidate) => candidate.title), ['Saturday market fixture']);
  assert.deepEqual(fallbackArtifact.futuresCandidates.map((candidate) => candidate.title), ['Saturday market fixture']);

  const premarketAsOf = new Date('2026-07-13T13:00:00.000Z');
  const premarketArtifact = await collectNewsCandidates({
    asOf: premarketAsOf,
    dashboardData: {
      stories: [{
        title: 'Prior Yahoo hosted fixture',
        url: 'https://finance.yahoo.com/news/prior-hosted-fixture.html',
        publishedOn: '2026-07-13',
        publishedAt: '2026-07-13T12:45:00.000Z',
        sourceLabel: 'Yahoo Finance',
        tag: 'Markets',
        body: 'Previously reviewed Yahoo-hosted fixture.'
      }, {
        title: 'Prior malformed timestamp fixture',
        url: 'https://www.cnbc.com/2026/07/13/prior-malformed-time.html',
        publishedOn: '2026-07-13',
        publishedAt: 'not-a-time',
        sourceLabel: 'CNBC',
        tag: 'Markets',
        body: 'Previously reviewed malformed-time fixture.'
      }],
      futuresModule: {
        sectionTitle: 'Pre-Market Futures',
        futures: ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'].map((symbol) => ({ symbol, raw: { referenceDate: '2026-07-10' } })),
        stories: []
      },
      crypto: { notes: [] }
    },
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => premarketAsOf,
    fetchPath: async () => ({ items: [{
      publishedAt: '2026-07-12T21:30:00.000Z',
      title: 'Sunday before futures open fixture',
      url: 'https://www.cnbc.com/2026/07/12/sunday-before-open.html'
    }, {
      publishedAt: '2026-07-12T22:30:00.000Z',
      title: 'Sunday after futures open fixture',
      url: 'https://www.cnbc.com/2026/07/12/sunday-after-open.html'
    }, {
      publishedAt: '2026-07-13T12:55:00.000Z',
      title: 'Monday premarket fixture',
      url: 'https://www.cnbc.com/2026/07/13/monday-premarket.html'
    }, {
      publishedAt: '2026-07-13T12:50:00.000Z',
      title: 'Monday unverified premarket fixture',
      url: 'https://www.cnbc.com/2026/07/13/monday-unverified.html'
    }, {
      publishedAt: '2026-07-13T12:45:00.000Z',
      title: 'Monday Yahoo hosted fixture',
      url: 'https://finance.yahoo.com/news/monday-hosted-fixture.html'
    }, {
      publishedAt: '2026-07-13T13:05:00.000Z',
      title: 'Monday after run fixture',
      url: 'https://www.cnbc.com/2026/07/13/monday-after-run.html'
    }] }),
    fetchArticle: async (candidate) => {
      if (candidate.title === 'Monday unverified premarket fixture') throw new Error('Fixture article unavailable.');
      return {
        finalUrl: candidate.url,
        pageTitle: candidate.title,
        description: 'Fixture description.',
        excerpt: 'Fixture article content.',
        publishedAt: new Date(candidate.publishedAt)
      };
    }
  });
  assert.ok(premarketArtifact.generalCandidates.some((candidate) => candidate.title === 'Monday unverified premarket fixture'));
  const yahooGeneral = premarketArtifact.generalCandidates.filter((candidate) => candidate.url.startsWith('https://finance.yahoo.com/news/'));
  assert.equal(yahooGeneral.length, 2, 'Current and prior Yahoo-hosted stories must remain available to general News while fresh.');
  assert.ok(yahooGeneral.every((candidate) => candidate.publishedAtVerified !== true));
  assert.ok(yahooGeneral.some((candidate) => candidate.dateSource === 'hosted_syndication'));
  assert.ok(yahooGeneral.some((candidate) => candidate.dateSource === 'prior_validated_card'));
  const malformedPrior = premarketArtifact.generalCandidates.find((candidate) => candidate.title === 'Prior malformed timestamp fixture');
  assert.ok(malformedPrior, 'A malformed optional timestamp must not discard an otherwise valid general-News card.');
  assert.equal(Object.hasOwn(malformedPrior, 'publishedAt'), false);
  assert.equal(Object.hasOwn(malformedPrior, 'publishedAtVerified'), false);
  assert.deepEqual(
    premarketArtifact.futuresCandidates.map((candidate) => candidate.title).sort(),
    ['Monday premarket fixture', 'Sunday after futures open fixture']
  );
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

async function testNewsCandidateCapAfterEligibilityAndDedupe() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const validItems = Array.from({ length: ARTICLE_REVIEW_CANDIDATE_LIMIT }, (_unused, index) => ({
    publishedAt: new Date(Date.parse('2026-07-10T12:00:00.000Z') + index * 1000).toISOString(),
    title: `Cap ordering valid fixture ${String(index).padStart(3, '0')}`,
    url: `https://www.cnbc.com/2026/07/10/cap-ordering-valid-${String(index).padStart(3, '0')}.html`
  }));
  const invalidItems = [
    {
      publishedAt: '2026-07-10T23:59:59.000Z',
      title: 'Cap ordering unapproved fixture',
      url: 'https://unapproved.example/cap-ordering-unapproved.html'
    },
    {
      publishedAt: '2026-07-10T23:59:58.000Z',
      title: 'Cap ordering non-HTTPS fixture',
      url: 'http://www.cnbc.com/2026/07/10/cap-ordering-non-https.html'
    },
    {
      publishedAt: '2026-07-10T23:59:57.000Z',
      title: '',
      url: 'https://www.cnbc.com/2026/07/10/cap-ordering-missing-title.html'
    },
    {
      title: 'Cap ordering missing-date fixture',
      url: 'https://www.cnbc.com/2026/07/10/cap-ordering-missing-date.html'
    },
    {
      publishedAt: '2026-07-01T23:59:56.000Z',
      title: 'Cap ordering stale fixture',
      url: 'https://www.cnbc.com/2026/07/01/cap-ordering-stale.html'
    }
  ];
  const duplicateItem = {
    ...validItems[0],
    publishedAt: '2026-07-10T23:59:55.000Z',
    url: `${validItems[0].url}?utm_source=duplicate`
  };
  const reviewed = [];

  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [{ id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({ items: [...invalidItems, duplicateItem, ...validItems] }),
    fetchArticle: async (candidate) => {
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

  assert.equal(reviewed.length, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.eligibleDownloadedCount, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.reviewCandidateCount, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.skippedCount, 0);
  assert.equal(artifact.generalCandidates.length, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap ordering valid fixture 000'), true);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap ordering valid fixture 249'), true);
  assert.equal(artifact.generalCandidates.some((candidate) => /unapproved|non-HTTPS|missing|stale/.test(candidate.title)), false);
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
    reutersNewsSitemapEntry({ url: 'https://www.reuters.com/fr/affaires/french-fixture-2026-07-10/' }),
    reutersNewsSitemapEntry({ url: 'https://www.reuters.com/default/legacy-fixture-2024-11-11/', title: 'مثال موروث' }),
    reutersNewsSitemapEntry({ url: 'https://evil.example/reuters-fixture', title: 'External fixture' }),
    reutersNewsSitemapEntry({ publishedAt: 'not-a-date', title: 'Malformed date fixture' }),
    reutersNewsSitemapEntry({ publicationName: 'Not Reuters', title: 'Wrong publication fixture' })
  ]));
  assert.deepEqual(entries, [{
    title: 'Reuters fixture headline',
    url: 'https://www.reuters.com/markets/us/reuters-fixture-2026-07-10',
    publishedAt: '2026-07-10T18:30:00.000Z',
    language: 'en',
    publicationName: 'Reuters',
    providerSourceName: 'Reuters',
    publishedAtVerified: true
  }], 'Malformed, external, and non-English entries must be isolated without discarding the valid Reuters entry.');
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
  for (const title of [
    'Bitcoin adoption expands',
    'Crypto regulation advances',
    'Cryptocurrencies face new rules',
    'Ethereum upgrade reaches users',
    'Ether funds attract demand',
    'Stablecoin legislation clears committee',
    'Blockchain settlement moves forward',
    'Digital-asset custody rules change'
  ]) {
    const candidate = normalizeProviderCandidate({ ...baseItem, title }, generalPath, eligibleDates);
    assert.equal(candidate.pool, 'cryptoCandidates', `${title} must promote from General to Crypto.`);
    assert.equal(candidate.sourceLabel, 'AP');
    assert.equal(candidate.publishedAtVerified, true, 'Pool promotion must preserve verified timestamp provenance.');
  }
  for (const title of [
    'Token award boosts developer usage',
    'Wallet maker expands retail distribution',
    'Mining company raises production target',
    'Ethernet equipment demand strengthens',
    'Cryptography conference opens registration'
  ]) {
    const candidate = normalizeProviderCandidate({ ...baseItem, title }, generalPath, eligibleDates);
    assert.equal(candidate.pool, 'generalCandidates', `${title} must remain General without a strict Crypto signal.`);
  }

  const explicitCrypto = normalizeProviderCandidate({
    title: 'Artificial intelligence model review',
    url: 'https://www.coindesk.com/tech/2026/07/10/ai-model-review',
    publishedAt: baseItem.publishedAt
  }, { id: 'coindesk', provider: 'rss', pool: 'cryptoCandidates' }, eligibleDates);
  assert.equal(explicitCrypto.pool, 'cryptoCandidates', 'Explicit Crypto acquisition paths must remain Crypto without a title match.');

  const reutersPath = { id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates' };
  const [reutersCryptoTitle] = parseReutersNewsSitemap(reutersNewsSitemap([
    reutersNewsSitemapEntry({
      title: 'Bitcoin market structure shifts',
      url: 'https://www.reuters.com/technology/bitcoin-market-structure-2026-07-10/'
    })
  ]));
  const promotedReuters = normalizeProviderCandidate(reutersCryptoTitle, reutersPath, eligibleDates);
  assert.equal(promotedReuters.pool, 'cryptoCandidates', 'Reuters must use the shared strict-title promotion rule.');
  assert.equal(promotedReuters.sourceLabel, 'Reuters');
  assert.equal(promotedReuters.publishedAtVerified, true);

  const artifact = await collectNewsCandidates({
    asOf: new Date('2026-07-10T19:00:00.000Z'),
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [
      generalPath,
      reutersPath
    ],
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
  assert.deepEqual(
    artifact.generalCandidates.map((candidate) => candidate.title).sort(),
    ['Token award boosts developer usage']
  );
  assert.deepEqual(
    artifact.cryptoCandidates.map((candidate) => candidate.title).sort(),
    ['Bitcoin adoption expands', 'Bitcoin market structure shifts'],
    'The shared strict-title rule must route AP and Reuters candidates into Crypto exclusively.'
  );
  assert.deepEqual(
    artifact.futuresCandidates.map((candidate) => candidate.title).sort(),
    ['Token award boosts developer usage'],
    'Crypto promotion must remove candidates from the General-derived Futures inventory.'
  );
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

async function testReutersNewsSitemapCollectionIntegration() {
  const asOf = new Date('2026-07-10T19:00:00.000Z');
  const reutersItem = parseReutersNewsSitemap(reutersNewsSitemap([reutersNewsSitemapEntry()]))[0];
  const yahooItem = {
    title: 'Yahoo hosted fixture',
    url: 'https://finance.yahoo.com/news/yahoo-hosted-fixture.html',
    publishedAt: '2026-07-10T18:45:00.000Z',
    providerSourceName: 'Yahoo Finance'
  };
  const reutersPath = {
    id: 'reuters-public', provider: 'reuters-public', pool: 'generalCandidates',
    feedUrl: 'https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml'
  };
  const stockfitPath = { id: 'stockfit-market', provider: 'stockfit', pool: 'generalCandidates' };
  const options = {
    asOf,
    dashboardData: {
      stories: [],
      futuresModule: {
        sectionTitle: 'Session Futures',
        stories: [],
        futures: ['ES=F', 'NQ=F', 'YM=F', 'RTY=F'].map((symbol) => ({ symbol, raw: { sessionDate: '2026-07-10' } }))
      },
      crypto: { notes: [] }
    },
    acquisitionPaths: [reutersPath, stockfitPath],
    clock: () => asOf,
    fetchPath: async (pathConfig) => pathConfig.id === 'reuters-public'
      ? {
          items: [reutersItem, { ...reutersItem, title: 'Stale Reuters fixture', publishedAt: '2026-07-01T18:30:00.000Z' }],
          error: 'Reuters News sitemap partial: 1 of 3 slices failed.'
        }
      : { items: [yahooItem] },
    fetchArticle: async (candidate) => ({
      finalUrl: candidate.url,
      pageTitle: candidate.title,
      publishedAt: new Date(candidate.publishedAt),
      publisherName: 'Reuters'
    })
  };
  const artifact = await collectNewsCandidates(options);
  const reuters = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'reuters');
  assert.equal(reuters.provider, 'reuters-public');
  assert.equal(reuters.url, 'https://www.reuters.com/markets/us/reuters-fixture-2026-07-10');
  assert.equal(reuters.publishedAt, '2026-07-10T18:30:00.000Z');
  assert.equal(reuters.publishedAtVerified, true);
  assert.equal(Object.hasOwn(reuters, 'article'), false, 'Verified sitemap candidates must use the shared review-bypass path.');
  assert.equal(artifact.futuresCandidates.some((candidate) => candidate.url === reuters.url), true);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Stale Reuters fixture'), false);
  assert.equal(artifact.attempts.find((attempt) => attempt.id === 'reuters-public').acceptedCount, 1);
  assert.match(artifact.attempts.find((attempt) => attempt.id === 'reuters-public').error, /partial/);
  const yahoo = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'yahoo-finance');
  assert.equal(yahoo.url, yahooItem.url);
  assert.equal(yahoo.sourceLabel, 'Yahoo Finance');
  assert.equal(yahoo.sourceId, 'yahoo-finance', 'Article-page publisher metadata must not replace URL-catalog provenance.');
  assert.equal(artifact.articleReview.reviewCandidateCount, 1, 'Only the unverified Yahoo item should enter shared article review.');

  const fallback = await collectNewsCandidates({
    ...options,
    fetchPath: async (pathConfig) => {
      if (pathConfig.id === 'reuters-public') throw new Error('fixture sitemap unavailable');
      return { items: [{
        title: 'Independent CNBC fixture',
        url: 'https://www.cnbc.com/2026/07/10/independent-fixture.html',
        publishedAt: '2026-07-10T18:40:00.000Z'
      }] };
    }
  });
  assert.match(fallback.attempts.find((attempt) => attempt.id === 'reuters-public').error, /fixture sitemap unavailable/);
  assert.equal(fallback.generalCandidates.some((candidate) => candidate.sourceId === 'reuters'), false);
  assert.equal(fallback.generalCandidates.some((candidate) => candidate.sourceId === 'cnbc'), true, 'Reuters unavailability must not discard unrelated News sources.');
}

function testArticleRedirectPolicy() {
  const candidateUrl = 'https://www.cnbc.com/2026/07/10/fixture.html';
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://api.cnbc.com/article/fixture')), true);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('http://www.cnbc.com/article/fixture')), false);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://cnbc.com.evil.example/article/fixture')), false);
  assert.equal(articleRedirectAllowed(candidateUrl, new URL('https://example.com/article/fixture')), false);
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
    if (url.pathname === '/large-header') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-large-fixture': 'a'.repeat(40000) });
      res.end('large header ok');
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/large-header' });
      res.end();
      return;
    }
    if (url.pathname === '/bad-redirect') {
      res.writeHead(302, { location: 'http://[invalid' });
      res.end();
      return;
    }
    if (url.pathname === '/deadline-redirect') {
      setTimeout(() => {
        res.writeHead(302, { location: '/deadline-final' });
        res.end();
      }, 40);
      return;
    }
    if (url.pathname === '/deadline-final') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('too late');
      }, 40);
      return;
    }
    if (url.pathname === '/cross-origin') {
      res.writeHead(302, { location: `${target.baseUrl}/target` });
      res.end();
      return;
    }
    if (url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('compressed fixture'));
      return;
    }
    if (url.pathname === '/identity-over-limit') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(17));
      return;
    }
    if (url.pathname === '/gzip-over-limit') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('x'.repeat(17)));
      return;
    }
    if (url.pathname === '/deflate-over-limit') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' });
      res.end(zlib.deflateSync('x'.repeat(17)));
      return;
    }
    if (url.pathname === '/br-over-limit' && typeof zlib.brotliCompressSync === 'function') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
      res.end(zlib.brotliCompressSync('x'.repeat(17)));
      return;
    }
    if (url.pathname === '/forbidden') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked');
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 100);
      return;
    }
    if (url.pathname === '/trickle') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let sent = 0;
      const interval = setInterval(() => {
        res.write('x');
        sent += 1;
        if (sent === 10) {
          clearInterval(interval);
          res.end();
        }
      }, 10);
      res.on('close', () => clearInterval(interval));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const large = await fetchResponse(`${server.baseUrl}/large-header`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } });
    assert.equal(await large.text(), 'large header ok');
    assert.equal(large.headers.get('x-large-fixture').length, 40000);

    const redirected = await fetchResponse(`${server.baseUrl}/redirect`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } });
    assert.equal(redirected.url, `${server.baseUrl}/large-header`);
    assert.equal(await redirected.text(), 'large header ok');

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/bad-redirect`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } }),
      /Invalid URL/
    );

    const compressed = await fetchResponse(`${server.baseUrl}/gzip`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } });
    assert.equal(await compressed.text(), 'compressed fixture');

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/identity-over-limit`, { timeoutMs: 1000, maxBodyBytes: 16, headers: { Accept: 'text/plain' } }),
      /exceeded 16 compressed bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/identity-over-limit`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
      /exceeded 16 decoded bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/gzip-over-limit`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
      /unexpected end of file|Cannot create a Buffer larger than 16 bytes|exceeded 16 decoded bytes/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/deflate-over-limit`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
      /Cannot create a Buffer larger than 16 bytes|exceeded 16 decoded bytes/
    );
    if (typeof zlib.brotliCompressSync === 'function') {
      await assert.rejects(
        () => fetchResponse(`${server.baseUrl}/br-over-limit`, { timeoutMs: 1000, maxDecodedBytes: 16, headers: { Accept: 'text/plain' } }),
        /Cannot create a Buffer larger than 16 bytes|exceeded 16 decoded bytes/
      );
    }

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/forbidden`, { timeoutMs: 1000, headers: { Accept: 'text/plain' } }),
      /HTTP 403/
    );

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/cross-origin`, {
        timeoutMs: 1000,
        headers: { Accept: 'text/plain', Authorization: 'Bearer fixture-secret' }
      }),
      /outside the request policy/
    );
    assert.equal(targetRequests.length, 0, 'A rejected redirect must not contact its target.');

    await fetchResponse(`${server.baseUrl}/cross-origin`, {
      timeoutMs: 1000,
      headers: { Accept: 'text/plain', Authorization: 'Bearer fixture-secret' },
      allowRedirect: (nextUrl) => nextUrl.origin === target.baseUrl
    });
    assert.equal(targetRequests[0].authorization, undefined, 'Authorization must not follow a cross-origin redirect.');

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/redirect`, { timeoutMs: 1000, allowRedirect: null }),
      /redirect policy must be a function/
    );

    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/slow`, { timeoutMs: 20, headers: { Accept: 'text/plain' } }),
      /Request timed out/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/trickle`, { timeoutMs: 30, headers: { Accept: 'text/plain' } }),
      /Request timed out/
    );
    await assert.rejects(
      () => fetchResponse(`${server.baseUrl}/deadline-redirect`, { timeoutMs: 60, headers: { Accept: 'text/plain' } }),
      /Request timed out/
    );
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
  testArticleMetadataExtraction();
  testNewsTimestampParsing();
  testRssParsing();
  testApNewsSitemapParsing();
  testReutersNewsSitemapParsing();
  await testSharedCryptoPoolPromotion();
  await testReutersNewsSitemapFetchIsolation();
  await testReutersNewsSitemapCollectionIntegration();
  testArticleRedirectPolicy();
  await testNewsFetchResponseTransport();
  await testNewsTransportFailureIsolation();
  await testApPublicAcquisitionUsesOneSitemapFetch();
  await testVerifiedCandidatesBypassReviewLimitWithoutInventoryCap();
  await testUpdatedOnlyFeedsDoNotCreatePublishedCandidates();
  await testDeterministicNewsCandidateAcquisition();
  await testFuturesCandidatesUseDisplayedSessionWindow();
  await testNewsCandidateReviewCapAndProgress();
  await testNewsCandidateCapAfterEligibilityAndDedupe();
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
