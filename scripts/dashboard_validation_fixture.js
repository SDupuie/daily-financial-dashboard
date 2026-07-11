const { buildEarningsWeekPolicy } = require('./earnings_week_contract');
const { compactChartPayload, quoteRowFromSeries } = require('./fetch_chart_data');
const { normalizeWeekAhead } = require('./week_ahead_contract');

const FIXTURE_NOW = '2026-07-10T13:30:00Z';

function story(kind, index) {
  const url = `https://fixture.test/${kind}-${index}`;
  return {
    tag: kind === 'crypto' ? 'Crypto' : 'Markets',
    tone: kind === 'crypto' ? 'crypto' : 'neutral',
    kicker: kind === 'crypto' ? 'Digital assets' : undefined,
    title: `${kind} fixture story ${index}`,
    body: `Fixture reporting item ${index} provides a concise, dated market-development summary for validator coverage.`,
    url,
    publishedOn: '2026-07-10',
    isNewSinceScheduledUpdate: false
  };
}

function fixtureFutures() {
  const sessionOpen = Date.parse('2026-07-10T13:30:00Z') / 1000;
  const sessionClose = Date.parse('2026-07-10T20:00:00Z') / 1000;
  return Array.from({ length: 4 }, (_item, index) => ({
    label: `Fixture future ${index + 1}`,
    value: '+1.00%',
    body: 'Fixture index futures are one percent higher versus the prior 4 PM ET close after a constructive cash session.',
    series: [[sessionOpen, 100], [sessionClose, 101]],
    raw: {
      previousClose: 100,
      referencePrice: 100,
      price: 101,
      regularMarketTime: sessionClose,
      delta: 1,
      pct: 1,
      sessionOpen: 100,
      sessionDate: '2026-07-10',
      referenceDate: '2026-07-09',
      referenceLabel: 'vs prior 4 PM ET close',
      marketTimeZone: 'America/New_York',
      sessionStartEastern: '9:30 AM ET',
      sessionEndEastern: '4:00 PM ET',
      referenceCloseEastern: '4:00 PM ET'
    }
  }));
}

function fixturePortfolioRows() {
  return ['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX'].map((ticker) => ({
    ticker,
    sleeve: 'Fixture sleeve',
    price: '$100.00',
    monthDivPerShare: '$0.00',
    dailyPriceChange: '+0.00%',
    dailyTR: '+0.00%',
    mtdPriceChange: '+0.00%',
    mtdTR: '+0.00%',
    upcomingCurrentMonthDividends: 'None',
    upcomingCurrentMonthDividendsValue: 0,
    upcomingCurrentMonthDividendEvents: [],
    futureMonthDividends: 'None',
    futureMonthDividendsValue: 0,
    futureMonthDividendEvents: []
  }));
}

function fixtureEarningsWeek() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-10T12:00:00.000Z',
    range: { from: '2026-07-10', to: '2026-07-16' },
    policy: buildEarningsWeekPolicy(),
    rows: [],
    secondaryRecoveryCandidates: [],
    companyReleaseTasks: [],
    summary: {
      counts: {
        total: 0,
        verified: 0,
        partial: 0,
        reactionComputed: 0,
        missingTiming: 0,
        missingRevenue: 0,
        missingMarketCap: 0,
        secondaryRecoveryCandidates: 0,
        companyReleaseTasks: 0
      }
    }
  };
}

function createDashboardValidationFixture() {
  // Keep validator mutations independent of the live edition while still exercising
  // the complete dashboard-to-chart and quote-row contracts.
  const chartSeries = {
    ticker: 'SPX',
    name: 'Fixture Index',
    section: 'tape',
    sourceSymbol: 'SPX',
    note: 'Fixture market positioning remains constructive as breadth improves and investors assess earnings, rates, growth, and liquidity conditions across sessions.',
    source: 'Yahoo Finance Chart API',
    dataKind: 'ohlc',
    priceOnly: false,
    noVolume: false,
    bars: [
      { time: '2026-07-09', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: '2026-07-10', open: 100, high: 102, low: 99, close: 101, volume: 1100 }
    ]
  };
  const quote = quoteRowFromSeries(chartSeries);
  const chartData = compactChartPayload({
    schemaVersion: 1,
    generatedAt: '2026-07-10T12:00:00.000Z',
    dashboardSource: 'scripts/dashboard_validation_fixture.js',
    range: { days: 1826, startDate: '2021-07-10', endDate: '2026-07-10' },
    sourceFamilies: ['Yahoo Finance Chart API'],
    quoteRows: { tape: [quote], crypto: [] },
    series: [chartSeries]
  });
  const stories = Array.from({ length: 9 }, (_item, index) => story('market', index + 1));
  const cryptoNotes = Array.from({ length: 4 }, (_item, index) => story('crypto', index + 1));
  const futuresStories = Array.from({ length: 3 }, (_item, index) => ({
    ...story('futures', index + 1),
    tag: 'Futures',
    publishedAt: '2026-07-10T15:00:00Z'
  }));
  const scheduledIds = [...stories, ...cryptoNotes].map((item) => `url:${item.url}`);

  return {
    dashboard: {
      editionId: '2026-07-10T21:00:00Z',
      newsBaseline: {
        lastScheduledUpdateAt: '2026-07-10T12:00:00.000Z',
        lastScheduledWindow: '2026-07-10:afternoon',
        previousScheduledStoryIds: [],
        currentScheduledStoryIds: scheduledIds
      },
      masthead: { edition: 'Afternoon Edition', date: 'Friday · July 10, 2026' },
      tape: { rows: [{ ...quote, group: 'Equities' }] },
      stories,
      crypto: {
        stats: [
          { sym: 'TOTAL', name: 'Crypto Market Cap', price: '$1.00T', delta: '+$0.01T' },
          { sym: 'F&G', name: 'Fear & Greed', price: '50', chg: 'Neutral' },
          { sym: 'ALTSEASON', name: 'Altcoin Season Index', price: '25', sub: 'Bitcoin Season', delta: '+1', chg: '/100' }
        ],
        notes: cryptoNotes
      },
      earnings: { week: fixtureEarningsWeek() },
      weekAhead: normalizeWeekAhead({ announcements: {}, predictions: {} }, {
        range: { from: '2026-07-10', to: '2026-07-16' },
        officialSchedule: {
          events: [{
            date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
            authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://fixture.test/schedule'
          }],
          authorities: []
        },
        now: new Date(FIXTURE_NOW)
      }),
      footer: {
        compiled: 'Compiled Friday, July 10, 2026 at 4:00 PM CDT · Market data: Alternative.me Crypto Fear & Greed Index, CoinMarketCap Altcoin Season Index'
      },
      opening: {
        headline: 'Fixture headline',
        deck: 'Fixture deck',
        catalysts: Array.from({ length: 4 }, (_item, index) => ({ label: `Catalyst ${index + 1}`, body: 'Fixture catalyst detail.' }))
      },
      futuresModule: {
        sectionLabel: 'After The Bell',
        sectionTitle: 'Session Futures',
        futures: fixtureFutures(),
        stories: futuresStories
      },
      assetAllocationPortfolio: {
        rows: fixturePortfolioRows(),
        portfolioMtdReturnAsOf: '2026-07-10',
        portfolioMtdReturnValue: null,
        portfolioMtdReturnStatus: 'unavailable',
        portfolioMtdReturnStale: true
      }
    },
    chartData
  };
}

function renderDashboardValidationFixture(dashboard, chartData) {
  return `<!-- ============ DATA START ============ -->
<script type="application/json" id="dashboard-data">${JSON.stringify(dashboard)}</script>
<!-- ============ DATA END ============ -->
<script type="application/json" id="chart-data">${JSON.stringify(chartData)}</script>
<div class="page" id="app"><div id="mast-edition"></div><div class="right" id="mast-date"></div><h1 id="hero-headline"></h1><div id="hero-copy"></div><main id="content"></main><footer id="footer"></footer></div>
<script id="dashboard-runtime">const localRefreshUrls = ['http://127.0.0.1:2210/api/market-refresh', 'http://localhost:2210/api/market-refresh'];</script>`;
}

module.exports = {
  FIXTURE_NOW,
  createDashboardValidationFixture,
  renderDashboardValidationFixture
};
