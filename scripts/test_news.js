#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  NEWS_COVERAGE_POLICIES,
  NEWS_COVERAGE_REASON,
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
const { validateScheduledPreflight } = require('./run_daily_update');
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
  const checkedAt = new Date('2026-07-06T12:00:00.000Z');
  const data = {
    stories: Array.from({ length: 8 }, (_item, index) => story(`Market ${index}`, `https://example.com/market/${index}`)),
    crypto: { notes: [] },
    futuresModule: { stories: Array.from({ length: 3 }, (_item, index) => story(`Futures ${index}`, `https://example.com/futures/${index}`)) }
  };
  applyNewsCoverageState(data, { now: checkedAt });

  assert.deepEqual(data.storiesCoverage, {
    status: 'partial',
    reason: NEWS_COVERAGE_REASON,
    checkedAt: checkedAt.toISOString()
  });
  assert.deepEqual(data.crypto.notesCoverage, {
    status: 'partial',
    reason: NEWS_COVERAGE_REASON,
    checkedAt: checkedAt.toISOString()
  });
  assert.deepEqual(data.futuresModule.storiesCoverage, { status: 'complete' });
  assert.deepEqual(
    validateNewsCoverageState(data.storiesCoverage, data.stories.length, NEWS_COVERAGE_POLICIES.stories),
    []
  );
  assert.deepEqual(
    validateNewsCoverageState(data.crypto.notesCoverage, data.crypto.notes.length, NEWS_COVERAGE_POLICIES.cryptoNotes),
    []
  );
  assert.match(
    validateNewsCoverageState({ status: 'complete' }, 8, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /status can be complete only/
  );
  assert.match(
    validateNewsCoverageState({ status: 'partial', reason: NEWS_COVERAGE_REASON, checkedAt: checkedAt.toISOString() }, 9, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /status must be complete once/
  );
  assert.match(
    validateNewsCoverageState({ status: 'partial', reason: 'unknown', checkedAt: 'not-a-time' }, 2, NEWS_COVERAGE_POLICIES.cryptoNotes).join(' '),
    /reason must be insufficient_qualifying_fresh_coverage.*checkedAt must be an offset-bearing ISO timestamp/
  );
  assert.match(
    validateNewsCoverageState({ status: 'complete' }, 10, NEWS_COVERAGE_POLICIES.stories).join(' '),
    /no more than 9 qualifying fresh items/
  );

  data.stories.push(story('Market 8', 'https://example.com/market/8'));
  data.crypto.notes = Array.from({ length: 4 }, (_item, index) => story(`Crypto ${index}`, `https://example.com/crypto/${index}`));
  applyNewsCoverageState(data, { now: new Date('2026-07-06T12:05:00.000Z') });
  assert.deepEqual(data.storiesCoverage, { status: 'complete' });
  assert.deepEqual(data.crypto.notesCoverage, { status: 'complete' });
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
    /requires --morning or --afternoon/
  );
}

function testScheduledPreflightEnforcesWindowAndDuplicateMarker() {
  const dir = makeTemporaryDirectory(os.tmpdir(), 'dfd-scheduled-preflight-');
  const dashboardFile = path.join(dir, 'dashboard.html');
  const baseline = {
    lastScheduledUpdateAt: '2026-07-08T21:00:00.000Z',
    lastScheduledWindow: '2026-07-08:afternoon',
    previousScheduledStoryIds: [],
    currentScheduledStoryIds: []
  };
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
  assert.equal(
    validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T12:00:00.000Z')),
    '2026-07-09:morning'
  );
  assert.throws(
    () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T14:00:00.000Z')),
    /outside its America\/Chicago update window/
  );
  assert.throws(
    () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-11T12:00:00.000Z')),
    /only permits weekday runs/
  );
  baseline.lastScheduledWindow = '2026-07-09:morning';
  fs.writeFileSync(dashboardFile, `<script type="application/json" id="dashboard-data">${JSON.stringify({ newsBaseline: baseline })}</script>`);
  assert.throws(
    () => validateScheduledPreflight(dashboardFile, 'morning', new Date('2026-07-09T12:00:00.000Z')),
    /already completed.*manual\/on-demand/
  );
}


function main() {
  testStoryIdentityContract();
  testDashboardNewsCollections();
  testNewsCoverageState();
  testBaselineSanitization();
  testNewMarkerAssignment();
  testManualBaselineTransition();
  testScheduledBaselineTransition();
  testScheduledPreflightEnforcesWindowAndDuplicateMarker();
  process.stdout.write('News tests passed.\n');
}

main();
