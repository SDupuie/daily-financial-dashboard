#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  NEWS_COVERAGE_POLICIES,
  NEWS_COVERAGE_REASON,
  allowedNewsDates,
  applyNewsCoverageState,
  applyScheduledNewsBaseline,
  canonicalStoryUrl,
  dashboardNewsItems,
  markNewsItemsNewSinceBaseline,
  normalizeStoryTitle,
  sanitizeNewsBaseline,
  sortedDashboardNewsIds,
  storyIdentity,
  validateNewsCoverageState
} = require('./news_contract');
const {
  ARTICLE_REVIEW_CANDIDATE_LIMIT,
  collectNewsCandidates,
  extractArticleMetadata,
  parseNewsFeed
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
    /must be complete.*reason.*checkedAt/
  );
  assert.match(
    validateNewsCoverageState(undefined, 2, NEWS_COVERAGE_POLICIES.cryptoNotes).join(' '),
    /crypto\.notesCoverage must record updater-derived partial coverage/
  );
  assert.deepEqual(validateNewsCoverageState(undefined, 10, NEWS_COVERAGE_POLICIES.stories), []);
}

function testMondayMorningFreshnessWindow() {
  const saturday = '2026-07-11';
  assert.equal(allowedNewsDates(new Date('2026-07-13T12:44:00.000Z')).has(saturday), false);
  assert.equal(allowedNewsDates(new Date('2026-07-13T12:45:00.000Z')).has(saturday), true);
  assert.equal(allowedNewsDates(new Date('2026-07-13T14:00:00.000Z')).has(saturday), true);
  assert.equal(allowedNewsDates(new Date('2026-07-13T14:01:00.000Z')).has(saturday), false);
}

async function testDeterministicNewsCandidateAcquisition() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const calls = [];
  const pauses = [];
  const acquisitionPaths = newsAcquisitionPaths();
  const dashboardData = {
    stories: [{
      title: 'Still-fresh prior market card',
      url: 'https://example.com/prior-market',
      publishedOn: '2026-07-10',
      tag: 'Prior',
      body: 'Previously reviewed market copy.'
    }],
    futuresModule: { stories: [] },
    crypto: { notes: [{
      title: 'Still-fresh prior crypto card',
      url: 'https://example.com/prior-crypto',
      publishedOn: '2026-07-10',
      kicker: 'Prior',
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
        title: 'MarketWatch direct duplicate fixture',
        url: 'https://www.marketwatch.com/story/direct-fixture?mod=stockfit'
      }, {
        publishedAt: '2026-07-10T19:30:00.000Z',
        title: 'Yahoo validated syndication fixture',
        url: 'https://finance.yahoo.com/news/validated-fixture.html?.tsrc=stockfit',
        providerSourceName: 'Yahoo Finance'
      }, {
        publishedAt: '2026-07-10T19:15:00.000Z',
        title: 'Yahoo unresolved syndication fixture',
        url: 'https://finance.yahoo.com/news/unresolved-fixture.html',
        providerSourceName: 'Yahoo Finance'
      }] };
      if (acquisitionPath.id === 'cnbc') return { items: [{
        publishedAt: '2026-07-10T20:00:00.000Z',
        title: 'CNBC direct duplicate fixture',
        url: 'https://www.cnbc.com/2026/07/10/direct-fixture.html'
      }] };
      if (acquisitionPath.id === 'marketwatch') return { items: [{
        publishedAt: '2026-07-10T19:00:00.000Z',
        title: 'MarketWatch direct duplicate fixture',
        url: 'https://www.marketwatch.com/story/direct-fixture?mod=mw_rss_topstories'
      }] };
      if (acquisitionPath.id === 'coindesk') return { items: [{
        publishedAt: '2026-07-10T18:00:00.000Z',
        title: 'Crypto direct duplicate fixture',
        url: 'https://www.coindesk.com/markets/2026/07/10/crypto-fixture'
      }] };
      return { items: [] };
    },
    fetchArticle: async (candidate) => {
      const isOriginalPublisher = candidate.url.startsWith('https://www.reuters.com/');
      return {
        finalUrl: candidate.url,
        pageTitle: candidate.title,
        description: 'Fixture description.',
        excerpt: 'Fixture article content.',
        publishedAt: isOriginalPublisher
          ? new Date('2026-07-10T18:45:00.000Z')
          : new Date(candidate.publishedAt),
        publisherName: candidate.url.includes('validated-fixture.html') ? 'Reuters' : 'Yahoo Finance',
        explicitPublisherUrls: candidate.url.includes('validated-fixture')
          ? ['https://www.reuters.com/markets/validated-fixture']
          : []
      };
    }
  });

  assert.deepEqual([...calls].sort(), acquisitionPaths.map((entry) => entry.id).sort(), 'Every configured API and direct-feed path must be attempted.');
  assert.deepEqual(artifact.attempts.map((attempt) => attempt.id), acquisitionPaths.map((entry) => entry.id), 'Acquisition attempts must remain in manifest order.');
  assert.ok(
    calls.indexOf('stockfit-market') >= 0 && calls.indexOf('stockfit-market') < calls.indexOf('alpha-blockchain'),
    'Distinct non-Alpha endpoints should not wait for the second paced Alpha call.'
  );
  assert.deepEqual(pauses, [1250], 'The two Alpha Vantage calls must be paced.');
  assert.equal(artifact.generalCandidates.length, 5, 'Direct duplicates, two Yahoo stories, and the prior card must remain available once each.');
  assert.equal(artifact.cryptoCandidates.length, 2, 'The direct Crypto duplicate and prior Crypto card must both reach editorial review.');
  const cnbc = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'cnbc');
  assert.equal(cnbc.provider, 'rss', 'A direct feed must win deterministic provenance deduplication over an aggregator copy.');
  assert.deepEqual(cnbc.searchPathIds, ['cnbc', 'alpha-financial-markets']);
  const marketwatch = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'marketwatch');
  assert.equal(marketwatch.provider, 'rss');
  assert.deepEqual(marketwatch.searchPathIds, ['marketwatch', 'stockfit-market']);
  const resolvedYahoo = artifact.generalCandidates.find((candidate) => candidate.syndication?.status === 'original_validated');
  assert.equal(resolvedYahoo.url, 'https://www.reuters.com/markets/validated-fixture');
  assert.equal(resolvedYahoo.syndication.hostedUrl, 'https://finance.yahoo.com/news/validated-fixture.html');
  assert.equal(resolvedYahoo.syndication.publisherName, 'Reuters');
  assert.equal(resolvedYahoo.publishedAt, '2026-07-10T18:45:00.000Z', 'A promoted story must use the original page publication time.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Stale provider fixture'), false);
  const unresolvedYahoo = artifact.generalCandidates.find((candidate) => candidate.syndication?.status === 'yahoo_hosted');
  assert.equal(unresolvedYahoo.url, 'https://finance.yahoo.com/news/unresolved-fixture.html');
  assert.equal(unresolvedYahoo.syndication.publisherName, undefined, 'StockFit Yahoo Finance attribution is the host, not a syndicated publisher.');
  assert.equal(artifact.generalCandidates.find((candidate) => candidate.priorCard).priorCopy.tag, 'Prior');
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
      stories: [],
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
      publishedAt: '2026-07-13T13:05:00.000Z',
      title: 'Monday after run fixture',
      url: 'https://www.cnbc.com/2026/07/13/monday-after-run.html'
    }] }),
    fetchArticle: async (candidate) => ({
      finalUrl: candidate.url,
      pageTitle: candidate.title,
      description: 'Fixture description.',
      excerpt: 'Fixture article content.',
      publishedAt: new Date(candidate.publishedAt)
    })
  });
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
  assert.equal(artifact.generalCandidates.length, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap fixture 000'), false);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Cap fixture 259'), true);
  assert.ok(
    progressArtifacts.some((progressArtifact) => progressArtifact.articleReview?.status === 'acquiring'
      && progressArtifact.generalCandidates.length === 0),
    'Progress artifacts must not expose unreviewed feed candidates.'
  );
  assert.ok(
    progressArtifacts.some((progressArtifact) => progressArtifact.articleReview?.status === 'reviewing'
      && progressArtifact.generalCandidates.length > 0
      && progressArtifact.generalCandidates.length < ARTICLE_REVIEW_CANDIDATE_LIMIT),
    'Progress artifacts should expose reviewed candidates incrementally.'
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

async function testYahooOriginalPromotionValidation() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const cases = [
    ['missing-title', 'Missing title promotion fixture'],
    ['missing-date', 'Missing date promotion fixture'],
    ['stale-date', 'Stale date promotion fixture'],
    ['title-mismatch', 'Title mismatch promotion fixture'],
    ['inaccessible', 'Inaccessible promotion fixture'],
    ['unapproved-domain', 'Unapproved domain promotion fixture'],
    ['unapproved-redirect', 'Unapproved redirect promotion fixture']
  ];
  const originalFetches = [];
  const artifact = await collectNewsCandidates({
    asOf,
    acquisitionPaths: [{ id: 'stockfit-market', provider: 'stockfit', pool: 'generalCandidates' }],
    clock: () => asOf,
    fetchPath: async () => ({
      items: cases.map(([slug, title]) => ({
        title,
        url: `https://finance.yahoo.com/news/${slug}.html`,
        publishedAt: '2026-07-10T19:00:00.000Z',
        providerSourceName: 'Yahoo Finance'
      }))
    }),
    fetchArticle: async (candidate) => {
      const url = new URL(candidate.url);
      const slug = url.pathname.split('/').at(-1).replace(/\.html$/, '');
      if (url.hostname === 'finance.yahoo.com') {
        return {
          finalUrl: candidate.url,
          pageTitle: candidate.title,
          publishedAt: new Date('2026-07-10T19:00:00.000Z'),
          publisherName: 'Yahoo Finance',
          explicitPublisherUrls: [slug === 'unapproved-domain'
            ? `https://unapproved.example/${slug}`
            : `https://www.reuters.com/markets/${slug}`]
        };
      }
      originalFetches.push(candidate.url);
      if (slug === 'inaccessible') throw new Error('fixture article unavailable');
      return {
        finalUrl: slug === 'unapproved-redirect'
          ? `https://unapproved.example/${slug}`
          : candidate.url,
        pageTitle: slug === 'missing-title' ? '' : slug === 'title-mismatch' ? 'Completely unrelated fixture headline' : candidate.title,
        publishedAt: slug === 'missing-date'
          ? null
          : slug === 'stale-date'
            ? new Date('2026-07-01T19:00:00.000Z')
            : new Date('2026-07-10T19:00:00.000Z')
      };
    }
  });

  assert.equal(artifact.generalCandidates.length, cases.length);
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.sourceId === 'yahoo-finance'));
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.syndication?.status === 'yahoo_hosted'));
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.url.startsWith('https://finance.yahoo.com/news/')));
  assert.equal(
    artifact.generalCandidates.find((candidate) => candidate.url.includes('/stale-date.html')).publishedAt,
    '2026-07-10T19:00:00.000Z',
    'A rejected stale original must not replace the Yahoo-hosted timestamp.'
  );
  assert.ok(!originalFetches.some((url) => url.includes('unapproved.example')), 'Unapproved original domains must not be fetched or promoted.');
  assert.ok(originalFetches.some((url) => url.endsWith('/unapproved-redirect')), 'An approved original URL must be fetched before its unapproved redirect is rejected.');
}

function testArticleMetadataExtraction() {
  const metadata = extractArticleMetadata(`<!doctype html>
    <meta property="og:title" content="Fixture &amp; Markets">
    <meta name="description" content="A useful fixture description.">
    <script type="application/ld+json">{"datePublished":"2026-07-10T12:30:00-04:00"}</script>
    <p>This fixture paragraph contains enough article text to be retained by the mechanical page extractor.</p>`);
  assert.equal(metadata.pageTitle, 'Fixture & Markets');
  assert.equal(metadata.description, 'A useful fixture description.');
  assert.equal(metadata.publishedAt.toISOString(), '2026-07-10T16:30:00.000Z');
  assert.match(metadata.excerpt, /mechanical page extractor/);
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

function testNewMarkerAssignment() {
  const existing = story('Existing', 'https://example.com/existing', { isNewSinceScheduledUpdate: true });
  const incoming = story('Incoming', 'https://example.com/incoming');
  const original = [existing, incoming];
  const marked = markNewsItemsNewSinceBaseline(original, new Set([storyIdentity(existing)]));
  assert.equal(marked[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(marked[1].isNewSinceScheduledUpdate, true);
  assert.equal(original[0].isNewSinceScheduledUpdate, true, 'Marker updates must not mutate source story objects.');

  const withoutComparison = markNewsItemsNewSinceBaseline(original, new Set());
  assert.equal(withoutComparison[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(withoutComparison[1].isNewSinceScheduledUpdate, undefined);
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
  assert.equal(data.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(data.stories[1].isNewSinceScheduledUpdate, true);
  assert.equal(data.stories[2].isNewSinceScheduledUpdate, true);
  assert.deepEqual(data.newsBaseline, previousData.newsBaseline);

  const currentFallbackData = { stories: [currentStory, incomingStory], crypto: { notes: [] } };
  applyScheduledNewsBaseline(currentFallbackData, {
    newsBaseline: { ...previousData.newsBaseline, previousScheduledStoryIds: [] }
  });
  assert.equal(currentFallbackData.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(currentFallbackData.stories[1].isNewSinceScheduledUpdate, true);
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
  assert.equal(data.stories[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(data.stories[1].isNewSinceScheduledUpdate, true);
  assert.equal(data.crypto.notes[0].isNewSinceScheduledUpdate, undefined);
  assert.equal(data.crypto.notes[1].isNewSinceScheduledUpdate, true);
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
  testMondayMorningFreshnessWindow();
  testArticleMetadataExtraction();
  testRssParsing();
  await testDeterministicNewsCandidateAcquisition();
  await testFuturesCandidatesUseDisplayedSessionWindow();
  await testNewsCandidateReviewCapAndProgress();
  await testNewsCandidateCapAfterEligibilityAndDedupe();
  await testYahooOriginalPromotionValidation();
  testBaselineSanitization();
  testNewMarkerAssignment();
  testManualBaselineTransition();
  testScheduledBaselineTransition();
  testScheduledStartAndFinalizationGuards();
  process.stdout.write('News tests passed.\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
