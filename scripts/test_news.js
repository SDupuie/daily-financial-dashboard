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
  fetchAcquisitionPath,
  msnReutersReaderUrl,
  parseApNewsSitemap,
  parseNewsFeed,
  priorNewsCandidates
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
    /must not stay partial.*reason.*checkedAt/
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
  assert.equal(artifact.generalCandidates.length, 4, 'The CNBC duplicate, two Yahoo stories, and the prior card must remain available once each.');
  assert.equal(artifact.cryptoCandidates.length, 2, 'The direct Crypto duplicate and prior Crypto card must both reach editorial review.');
  const cnbc = artifact.generalCandidates.find((candidate) => candidate.sourceId === 'cnbc');
  assert.equal(cnbc.provider, 'rss', 'A direct feed must win deterministic provenance deduplication over an aggregator copy.');
  assert.equal(cnbc.sourceLabel, 'CNBC');
  assert.equal(cnbc.publishedAtVerified, true, 'Article-page review must mark provider timestamps verified after confirmation.');
  assert.deepEqual(cnbc.searchPathIds, ['cnbc', 'alpha-financial-markets']);
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Removed MarketWatch fixture'), false);
  const resolvedYahoo = artifact.generalCandidates.find((candidate) => candidate.syndication?.status === 'original_validated');
  assert.equal(resolvedYahoo.url, 'https://www.reuters.com/markets/validated-fixture');
  assert.equal(resolvedYahoo.sourceLabel, 'Reuters');
  assert.equal(resolvedYahoo.syndication.hostedUrl, 'https://finance.yahoo.com/news/validated-fixture.html');
  assert.equal(resolvedYahoo.syndication.publisherName, 'Reuters');
  assert.equal(resolvedYahoo.publishedAt, '2026-07-10T18:45:00.000Z', 'A promoted story must use the original page publication time.');
  assert.equal(artifact.generalCandidates.some((candidate) => candidate.title === 'Stale provider fixture'), false);
  const unresolvedYahoo = artifact.generalCandidates.find((candidate) => candidate.syndication?.status === 'yahoo_hosted');
  assert.equal(unresolvedYahoo.url, 'https://finance.yahoo.com/news/unresolved-fixture.html');
  assert.equal(unresolvedYahoo.sourceLabel, 'Yahoo Finance');
  assert.equal(unresolvedYahoo.syndication.publisherName, undefined, 'StockFit Yahoo Finance attribution is the host, not a syndicated publisher.');
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
      publishedAt: '2026-07-13T12:50:00.000Z',
      title: 'Monday unverified premarket fixture',
      url: 'https://www.cnbc.com/2026/07/13/monday-unverified.html'
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
  assert.ok(artifact.generalCandidates.every((candidate) => candidate.sourceLabel === 'Yahoo Finance'));
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

async function testApPublicAcquisitionUsesOneSitemapFetch() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(`<?xml version="1.0"?>
      <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://apnews.com/article/markets-fixture-123</loc>
          <news:news>
            <news:publication><news:name>Associated Press</news:name><news:language>eng</news:language></news:publication>
            <news:publication_date>2026-07-10T14:30:00-04:00</news:publication_date>
            <news:title>Markets fixture</news:title>
          </news:news>
        </url>
      </urlset>`, {
      status: 200,
      headers: { 'content-type': 'text/xml' }
    });
  };
  try {
    const result = await fetchAcquisitionPath({
      id: 'ap-public',
      provider: 'ap-public',
      pool: 'generalCandidates',
      feedUrl: 'https://apnews.com/news-sitemap-content.xml'
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
    global.fetch = originalFetch;
  }
}

async function testMsnReutersProviderVerifiedAcquisition() {
  const pathConfig = {
    id: 'msn-reuters',
    provider: 'msn-reuters',
    pool: 'generalCandidates',
    feedUrl: 'https://api.msn.com/news/providers/AAf3a78/items',
    providerId: 'AAf3a78',
    limit: 100
  };
  const provider = { id: 'AAf3a78', name: 'Reuters' };
  const cards = [
    {
      id: 'AAfixture1', type: 'article', category: 'money', provider,
      title: 'Markets rally on fixture catalyst', publishedDateTime: '2026-07-10T18:00:00Z',
      url: 'https://www.msn.com/en-us/money/markets/markets-rally-on-fixture-catalyst/ar-AAfixture1?ocid=test'
    },
    {
      id: 'AAfixture2', type: 'article', category: 'news', provider,
      title: 'Markets rally on the fixture catalyst', publishedDateTime: '2026-07-10T18:01:00Z',
      url: 'https://www.msn.com/en-us/news/markets/markets-rally-on-the-fixture-catalyst/ar-AAfixture2'
    },
    {
      id: 'AAwrongtime', type: 'article', category: 'money', provider,
      title: 'Updated time must not replace publication time', publishedDateTime: '2026-07-10T18:02:00Z',
      url: 'https://www.msn.com/en-us/money/markets/updated-time-fixture/ar-AAwrongtime'
    },
    {
      id: 'AAwronglegal', type: 'article', category: 'news', provider,
      title: 'Wrong legal publisher fixture', publishedDateTime: '2026-07-10T18:02:30Z',
      url: 'https://www.msn.com/en-us/news/markets/wrong-legal-publisher/ar-AAwronglegal'
    },
    {
      id: 'AAsports', type: 'article', category: 'sports', provider,
      title: 'Sports fixture', publishedDateTime: '2026-07-10T18:03:00Z',
      url: 'https://www.msn.com/en-us/sports/other/sports-fixture/ar-AAsports'
    },
    {
      id: 'AAspoofed', type: 'article', category: 'money', provider: { id: 'other', name: 'Reuters' },
      title: 'Spoofed provider fixture', publishedDateTime: '2026-07-10T18:04:00Z',
      url: 'https://www.msn.com/en-us/money/markets/spoofed-provider/ar-AAspoofed'
    }
  ];
  const articleBody = '<p>This Reuters fixture contains a complete article body for editorial review. '.repeat(5) + '</p>';
  const detail = (card, overrides = {}) => ({
    id: card.id,
    type: 'article',
    title: card.title,
    abstract: 'Reuters fixture abstract.',
    body: articleBody,
    publishedDateTime: card.publishedDateTime,
    createdDateTime: '2026-07-10T18:05:00Z',
    updatedDateTime: '2026-07-10T18:15:00Z',
    sourceId: 'tag:reuters.com,2026:newsml_KBNFIXTURE1',
    provider: { ...provider, companyLegalName: 'Reuters News & Media Inc.' },
    ...overrides
  });
  const details = new Map([
    ['AAfixture1', detail(cards[0])],
    ['AAfixture2', detail(cards[1])],
    ['AAwrongtime', detail(cards[2], { publishedDateTime: '2026-07-10T18:15:00Z', sourceId: 'tag:reuters.com,2026:newsml_KBNWRONGTIME' })],
    ['AAwronglegal', detail(cards[3], { provider: { ...provider, companyLegalName: 'Not Reuters' }, sourceId: 'tag:reuters.com,2026:newsml_KBNWRONGLEGAL' })]
  ]);
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (value) => {
    const url = new URL(String(value));
    calls.push(url);
    if (url.hostname === 'api.msn.com') {
      return new Response(JSON.stringify({ value: [{ subCards: cards }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    const item = details.get(decodeURIComponent(url.pathname.split('/').pop()));
    return new Response(JSON.stringify(item || {}), {
      status: item ? 200 : 404,
      headers: { 'content-type': 'application/json' }
    });
  };
  let result;
  let staleResult;
  let emptyResult;
  try {
    result = await fetchAcquisitionPath(pathConfig, { eligibleDates: new Set(['2026-07-10']), timeoutMs: 1000 });
    staleResult = await fetchAcquisitionPath(pathConfig, { eligibleDates: new Set(['2026-07-09']), timeoutMs: 1000 });
    emptyResult = await fetchAcquisitionPath(pathConfig, { eligibleDates: new Set(), timeoutMs: 1000 });
  } finally {
    global.fetch = originalFetch;
  }

  const feedCall = calls.find((url) => url.hostname === 'api.msn.com');
  assert.equal(feedCall.searchParams.get('contentType'), 'article');
  assert.equal(feedCall.searchParams.get('$top'), '100');
  assert.equal(calls.filter((url) => url.hostname === 'assets.msn.com').length, 4, 'Sports and spoofed-provider cards must be rejected before detail retrieval.');
  assert.deepEqual(staleResult, { items: [] }, 'Out-of-window cards must be discarded before detail retrieval.');
  assert.deepEqual(emptyResult, { items: [] }, 'An empty eligible date set must not become a provider failure.');
  assert.equal(result.items.length, 2, 'Timestamp-mismatched detail records must be rejected without discarding the valid Reuters batch.');
  assert.ok(result.items.every((item) => item.publishedAtVerified === true));
  assert.ok(result.items.every((item) => item.publisherStoryId === 'tag:reuters.com,2026:newsml_KBNFIXTURE1'));
  assert.ok(result.items.every((item) => item.article.text.length > 200));
  assert.equal(
    msnReutersReaderUrl(cards[0].url, cards[0].id),
    'https://www.msn.com/en-us/money/markets/markets-rally-on-fixture-catalyst/ar-AAfixture1'
  );
  assert.equal(msnReutersReaderUrl('https://www.msn.com/en-us/money/not-an-article', 'AAfixture1'), '');

  const asOf = new Date('2026-07-10T21:00:00Z');
  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [pathConfig],
    clock: () => asOf,
    fetchPath: async () => result,
    fetchArticle: async () => {
      throw new Error('Provider-verified Reuters candidates must bypass article-page timestamp review.');
    }
  });
  assert.equal(artifact.generalCandidates.length, 1, 'Duplicate MSN records for one Reuters NewsML story must collapse.');
  const candidate = artifact.generalCandidates[0];
  assert.equal(candidate.provider, 'msn-reuters');
  assert.equal(candidate.sourceId, 'reuters');
  assert.equal(candidate.sourceLabel, 'Reuters');
  assert.equal(candidate.publishedAtVerified, true);
  assert.equal(candidate.publishedAt, '2026-07-10T18:00:00.000Z');
  assert.equal(candidate.article.text.length > 200, true);
  assert.equal(artifact.articleReview.reviewCandidateCount, 0);

  const prior = priorNewsCandidates({
    stories: [{
      tag: 'Markets', title: candidate.title, body: 'Prior Reuters fixture copy.', url: candidate.url,
      publishedOn: candidate.publishedOn, publishedAt: candidate.publishedAt, sourceLabel: 'Reuters'
    }],
    futuresModule: { stories: [] },
    crypto: { notes: [] }
  }, new Set([candidate.publishedOn]));
  assert.equal(prior.generalCandidates.length, 1, 'A previously validated MSN-hosted Reuters card must remain eligible while fresh.');
}

async function testVerifiedPublishedAtCandidatesBypassReviewCap() {
  const asOf = new Date('2026-07-10T21:00:00.000Z');
  const unverifiedCount = ARTICLE_REVIEW_CANDIDATE_LIMIT + 10;
  const unverifiedItems = Array.from({ length: unverifiedCount }, (_unused, index) => ({
    publishedAt: new Date(Date.parse('2026-07-10T13:00:00.000Z') + index * 1000).toISOString(),
    title: `Unverified cap fixture ${String(index).padStart(3, '0')}`,
    url: `https://www.cnbc.com/2026/07/10/unverified-cap-fixture-${String(index).padStart(3, '0')}.html`
  }));
  const verifiedItems = [0, 1].map((index) => ({
    publishedAt: new Date(Date.parse('2026-07-10T12:00:00.000Z') + index * 1000).toISOString(),
    title: `Verified AP fixture ${index}`,
    url: `https://apnews.com/article/verified-ap-fixture-${index}`,
    publishedAtVerified: true
  }));
  const reviewed = [];

  const artifact = await collectNewsCandidates({
    asOf,
    dashboardData: { stories: [], futuresModule: { stories: [] }, crypto: { notes: [] } },
    acquisitionPaths: [
      { id: 'ap-public', provider: 'ap-public', pool: 'generalCandidates' },
      { id: 'cnbc', provider: 'rss', pool: 'generalCandidates' }
    ],
    clock: () => asOf,
    fetchPath: async (acquisitionPath) => ({ items: acquisitionPath.id === 'ap-public' ? verifiedItems : unverifiedItems }),
    fetchArticle: async (candidate) => {
      assert.equal(candidate.sourceId, 'cnbc', 'AP candidates with verified provider timestamps must not spend article-review slots.');
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
  assert.equal(artifact.articleReview.eligibleDownloadedCount, unverifiedCount + verifiedItems.length);
  assert.equal(artifact.articleReview.reviewCandidateCount, ARTICLE_REVIEW_CANDIDATE_LIMIT);
  assert.equal(artifact.articleReview.skippedCount, 10);
  assert.equal(artifact.generalCandidates.length, ARTICLE_REVIEW_CANDIDATE_LIMIT + verifiedItems.length);
  const apCandidates = artifact.generalCandidates.filter((candidate) => candidate.sourceId === 'ap');
  assert.equal(apCandidates.length, verifiedItems.length);
  assert.ok(apCandidates.every((candidate) => candidate.sourceLabel === 'AP'));
  assert.ok(apCandidates.every((candidate) => candidate.dateSource === 'provider_published'));
  assert.ok(apCandidates.every((candidate) => candidate.publishedAtVerified === true));
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
  testMondayMorningFreshnessWindow();
  testArticleMetadataExtraction();
  testRssParsing();
  testApNewsSitemapParsing();
  await testApPublicAcquisitionUsesOneSitemapFetch();
  await testMsnReutersProviderVerifiedAcquisition();
  await testVerifiedPublishedAtCandidatesBypassReviewCap();
  await testUpdatedOnlyFeedsDoNotCreatePublishedCandidates();
  await testDeterministicNewsCandidateAcquisition();
  await testFuturesCandidatesUseDisplayedSessionWindow();
  await testNewsCandidateReviewCapAndProgress();
  await testNewsCandidateCapAfterEligibilityAndDedupe();
  await testYahooOriginalPromotionValidation();
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
