#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    hidden: id === 'runtime-banner',
    setAttribute() {}
  };
}

function baseData() {
  return {
    masthead: { volume: 'v', date: 'd', subhead: 's' },
    tape: { label: 't', rows: [] },
    lede: { kicker: 'k', headline: 'h', paragraphs: [], cards: [] },
    stories: [],
    renesas: { label: 'r', title: 'rt', head: 'rh', headline: 'rhh', paragraphs: [], stats: [] },
    crypto: { tapeHeader: 'c', tape: [], notes: [] },
    earnings: { label: 'e', tiles: [] },
    weekAhead: { rows: [] },
    footer: { compiled: 'f', disclaimer: 'n' }
  };
}

function runRuntimeWithData(dataOrRaw) {
  const runtimePath = path.resolve(__dirname, 'dashboard_runtime.js');
  const runtimeCode = fs.readFileSync(runtimePath, 'utf8');

  const ids = [
    'dashboard-data', 'runtime-banner', 'mast-vol', 'mast-date', 'subhead',
    'tape-label', 'tape-body', 'lede-kicker', 'lede-headline', 'lede-paragraphs',
    'lede-cards', 'stories', 'renesas-label', 'renesas-title', 'renesas-head',
    'renesas-headline', 'renesas-paragraphs', 'renesas-stats', 'crypto-tape-header',
    'crypto-tape-rows', 'crypto-notes', 'earnings-label', 'earnings-grid',
    'week-ahead', 'footer-compiled', 'footer-disclaimer'
  ];

  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  const dashboardEl = elements.get('dashboard-data');

  if (typeof dataOrRaw === 'string') {
    dashboardEl.textContent = dataOrRaw;
  } else {
    dashboardEl.textContent = JSON.stringify(dataOrRaw);
  }

  const context = {
    window: {
      location: { href: 'https://example.com/daily_financial_news.html' },
      console: { error() {} }
    },
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    URL,
    console: { error() {} }
  };

  vm.createContext(context);
  vm.runInContext(runtimeCode, context, { filename: 'dashboard_runtime.js' });

  return elements;
}

function testHttpsOnlyStoryLinks() {
  const d = baseData();
  d.stories = [
    { tag: 'bad', tone: 'red', title: 'Bad', body: 'B', url: 'javascript:alert(1)' },
    { tag: 'ok', tone: 'green', title: 'Ok', body: 'B', url: 'https://example.org/story' }
  ];

  const elements = runRuntimeWithData(d);
  const html = elements.get('stories').innerHTML;

  assert(!html.includes('javascript:alert(1)'), 'javascript: URL should never be rendered');
  assert(html.includes('https://example.org/story'), 'https URL should be rendered');
}

function testInvalidJsonShowsBanner() {
  const elements = runRuntimeWithData('{bad json');
  const banner = elements.get('runtime-banner');

  assert(banner.hidden === false, 'runtime banner should be visible on JSON parse failure');
  assert(/invalid/i.test(banner.textContent), 'runtime banner should mention invalid data');
}

function testMissingSectionsDoesNotCrash() {
  const elements = runRuntimeWithData({});
  const banner = elements.get('runtime-banner');

  assert(banner.hidden === true, 'runtime banner should stay hidden for missing optional sections');
  assert(typeof elements.get('tape-body').innerHTML === 'string', 'tape-body should still render to a string');
}

function main() {
  testHttpsOnlyStoryLinks();
  testInvalidJsonShowsBanner();
  testMissingSectionsDoesNotCrash();
  process.stdout.write('dashboard_runtime tests passed\n');
}

main();
