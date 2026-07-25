#!/usr/bin/env node

const assert = require('assert/strict');
const {
  SCHEMA_VERSION,
  SOURCE_TIME_ZONE,
  TIME_ZONE,
  TRADINGVIEW_ENDPOINT,
  TRADINGVIEW_PROVIDER,
  applyMarketLensDecisions,
  applyWeekAheadLifecycle,
  buildWeekAheadPreparationFallback,
  displayDatesForRange,
  finalizeWeekAheadOutcomes,
  formatTradingViewValue,
  mergeWeekAheadPayload,
  normalizeWeekAhead,
  prepareWeekAheadForEditorial,
  rangeForDate,
  validateWeekAheadPayload,
  weekAheadMarketLensDecision,
  weekAheadNeedsOutcomeEditorial
} = require('./week_ahead_contract');
const {
  REQUEST_RETRIES,
  TRADINGVIEW_ORIGIN,
  dateFromArg,
  isRetryableTradingViewError,
  parseArgs,
  requestTradingViewCalendar,
  run,
  tradingViewUrl
} = require('./fetch_week_ahead');

const RANGE = { from: '2026-07-27', to: '2026-07-31' };
const BEFORE_WEEK = new Date('2026-07-24T16:00:00Z');

function tradingViewRow(overrides = {}) {
  return {
    id: 'us-cpi-yoy',
    title: 'Consumer Price Index YoY',
    country: 'US',
    indicator: 'CPI',
    source: 'U.S. Bureau of Labor Statistics',
    actual: 3,
    previous: 2.9,
    forecast: 3.1,
    unit: '%',
    scale: '',
    importance: 1,
    date: '2026-07-28T12:30:00.000Z',
    ...overrides
  };
}

function providerFixture() {
  return {
    status: 'ok',
    result: [
      tradingViewRow(),
      tradingViewRow({
        id: 'us-core-cpi-mom',
        title: 'Core Consumer Price Index MoM',
        indicator: 'Core CPI',
        actual: 0.2,
        previous: 0.2,
        forecast: 0.3,
        importance: 0
      }),
      tradingViewRow({
        id: 'fed-chair-speech',
        title: 'Fed Chair Speech',
        indicator: 'Federal Reserve',
        source: 'Federal Reserve',
        actual: null,
        previous: null,
        forecast: null,
        unit: '',
        importance: 0,
        date: '2026-07-29T17:00:00.000Z'
      }),
      tradingViewRow({
        id: 'us-low',
        title: 'Wholesale Inventories MoM',
        indicator: 'Wholesale Inventories',
        actual: null,
        previous: 0.1,
        forecast: 0.2,
        importance: -1
      }),
      tradingViewRow({
        id: 'ca-cpi',
        title: 'Consumer Price Index YoY',
        country: 'CA',
        importance: 1
      })
    ]
  };
}

function normalizedFixture(options = {}) {
  return normalizeWeekAhead(providerFixture(), {
    range: RANGE,
    now: options.now || BEFORE_WEEK
  });
}

function findEvent(week, id) {
  return week.days.flatMap((day) => day.events).find((event) => event.id === `tradingview:${id}`);
}

function testRangeSelection() {
  assert.deepEqual(rangeForDate(new Date('2026-07-20T18:00:00Z')), {
    from: '2026-07-20',
    to: '2026-07-24'
  });
  assert.deepEqual(rangeForDate(new Date('2026-07-24T18:00:00Z')), {
    from: '2026-07-24',
    to: '2026-07-30'
  });
  assert.deepEqual(displayDatesForRange({ from: '2026-07-24', to: '2026-07-30' }), [
    '2026-07-24',
    '2026-07-27',
    '2026-07-28',
    '2026-07-29',
    '2026-07-30'
  ]);
}

function testTradingViewNormalization() {
  const week = normalizedFixture();
  assert.equal(week.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(week.range, {
    ...RANGE,
    timeZone: TIME_ZONE,
    marketTimeZone: SOURCE_TIME_ZONE
  });
  assert.deepEqual(week.source, {
    provider: TRADINGVIEW_PROVIDER,
    endpoint: TRADINGVIEW_ENDPOINT,
    status: 'fresh',
    fetchedAt: BEFORE_WEEK.toISOString()
  });
  assert.deepEqual(week.sourceSummary, {
    returnedEvents: 5,
    includedEvents: 3,
    highImpactEvents: 1,
    mediumImpactEvents: 2,
    omittedLowImpactEvents: 1
  });
  assert.deepEqual(validateWeekAheadPayload(week, { now: BEFORE_WEEK }), []);

  const cpi = findEvent(week, 'us-cpi-yoy');
  assert.equal(cpi.time, '08:30');
  assert.equal(cpi.name, 'Consumer Price Index');
  assert.equal(cpi.agency, 'BLS');
  assert.equal(cpi.period, 'YoY');
  assert.equal(cpi.impact, 'high');
  assert.equal(cpi.previous, '2.9%');
  assert.equal(cpi.forecast, '3.1%');
  assert.equal(cpi.actual, null, 'future actuals must not appear before release time');
  assert.equal(cpi.forecastType, 'consensus');
  assert.equal(cpi.valuesApplicable, true);
  assert.equal(cpi.lensPath, 'consumer-inflation');
  assert.equal(cpi.status, 'scheduled');

  const speech = findEvent(week, 'fed-chair-speech');
  assert.equal(speech.time, '13:00');
  assert.equal(speech.agency, 'Federal Reserve');
  assert.equal(speech.period, 'Policy');
  assert.equal(speech.valuesApplicable, false);
  assert.equal(speech.previous, null);
  assert.equal(speech.forecast, null);
  assert.equal(speech.actual, null);
  assert.equal(speech.forecastType, null);
  assert.equal(speech.lensPath, 'policy');

  assert.equal(findEvent(week, 'us-low'), undefined);
  assert.equal(findEvent(week, 'ca-cpi'), undefined);

  assert.equal(formatTradingViewValue(4.1, { title: 'PCE Price Index YoY' }), '4.1%');
  assert.equal(formatTradingViewValue(6.69, { title: 'MBA 30-Year Mortgage Rate' }), '6.69%');
  assert.equal(formatTradingViewValue(2.011, { title: 'EIA Crude Oil Stocks Change' }), '2.011M');
}

function testReleasedValuesAndLifecycle() {
  const afterRelease = normalizedFixture({ now: new Date('2026-07-28T14:00:00Z') });
  const cpi = findEvent(afterRelease, 'us-cpi-yoy');
  assert.equal(cpi.actual, '3%');
  assert.equal(cpi.status, 'released');
  assert.deepEqual(cpi.surprise, { direction: 'below', delta: -0.1, unit: '%' });
  assert.equal(afterRelease.days.find((day) => day.date === '2026-07-28').lifecycle, 'released_awaiting_close');

  const speechWeek = normalizedFixture({ now: new Date('2026-07-29T18:00:00Z') });
  assert.equal(findEvent(speechWeek, 'fed-chair-speech').status, 'released');

  const chartData = {
    series: [
      {
        ticker: 'UST2Y',
        unit: 'percent_yield',
        bars: [
          { time: '2026-07-27', close: 3.8 },
          { time: '2026-07-28', close: 3.85 }
        ]
      },
      {
        ticker: 'UUP',
        unit: 'price',
        bars: [
          { time: '2026-07-27', close: 28 },
          { time: '2026-07-28', close: 28.2 }
        ]
      }
    ]
  };
  const afterClose = applyWeekAheadLifecycle(afterRelease, chartData, {
    now: new Date('2026-07-28T21:00:00Z')
  });
  const tuesday = afterClose.days.find((day) => day.date === '2026-07-28');
  assert.equal(tuesday.lifecycle, 'close_available');
  assert.equal(tuesday.marketReaction.rows.length, 2);
}

function testMalformedProviderRowsFailClosed() {
  assert.throws(
    () => normalizeWeekAhead({ status: 'ok', result: [tradingViewRow({ id: '' })] }, { range: RANGE, now: BEFORE_WEEK }),
    /stable identity/
  );
  assert.throws(
    () => normalizeWeekAhead({ status: 'error', result: [] }, { range: RANGE, now: BEFORE_WEEK }),
    /status "ok"/
  );
  assert.throws(
    () => normalizeWeekAhead({ status: 'ok', result: [
      tradingViewRow(),
      tradingViewRow()
    ] }, { range: RANGE, now: BEFORE_WEEK }),
    /duplicate event identity/
  );
  for (const importance of [null, '', '1', 2, undefined]) {
    assert.throws(
      () => normalizeWeekAhead({
        status: 'ok',
        result: [tradingViewRow({ importance })]
      }, { range: RANGE, now: BEFORE_WEEK }),
      /invalid importance value/
    );
  }
}

function testLatestTradingViewValuesOwnRefresh() {
  const prior = normalizedFixture();
  const tuesday = prior.days.find((day) => day.date === '2026-07-28');
  tuesday.marketLens = {
    ...tuesday.marketLens,
    title: 'Editorial inflation lens',
    body: 'Current editorial interpretation.'
  };
  tuesday.marketLensSource = 'editorial';

  const refreshedProvider = providerFixture();
  refreshedProvider.result[0].previous = 2.8;
  refreshedProvider.result[0].forecast = null;
  refreshedProvider.result[0].actual = null;
  const refreshed = normalizeWeekAhead(refreshedProvider, { range: RANGE, now: BEFORE_WEEK });
  const merged = mergeWeekAheadPayload(prior, refreshed);
  const event = findEvent(merged, 'us-cpi-yoy');
  assert.equal(event.previous, '2.8%');
  assert.equal(event.forecast, null, 'missing latest values must replace prior values');
  assert.equal(event.actual, null);
  assert.equal(merged.days.find((day) => day.date === '2026-07-28').marketLens.title, 'Editorial inflation lens');
  assert.equal(merged.days.find((day) => day.date === '2026-07-28').marketLensSource, 'editorial');
}

function testStatisticalReleaseReopensMarketLensReview() {
  const prior = normalizedFixture();
  const priorTuesday = prior.days.find((day) => day.date === '2026-07-28');
  priorTuesday.marketLens = {
    ...priorTuesday.marketLens,
    title: 'Pre-release inflation lens',
    body: 'Forward-looking inflation setup.'
  };
  priorTuesday.marketLensSource = 'editorial';

  const refreshed = normalizedFixture({ now: new Date('2026-07-28T14:00:00Z') });
  const merged = mergeWeekAheadPayload(prior, refreshed);
  const tuesday = merged.days.find((day) => day.date === '2026-07-28');
  assert.equal(findEvent(merged, 'us-cpi-yoy').status, 'released');
  assert.equal(tuesday.marketLensSource, 'generated');
  assert.equal(tuesday.marketLens.title, 'Consumer inflation tests the rate path');
  assert.equal(weekAheadMarketLensDecision(tuesday).action, 'pending_review');
}

function testNonStatisticalReleaseReopensMarketLensReview() {
  const prior = normalizedFixture();
  const priorWednesday = prior.days.find((day) => day.date === '2026-07-29');
  priorWednesday.marketLens = {
    ...priorWednesday.marketLens,
    title: 'Pre-release Fed lens',
    body: 'Forward-looking policy setup.'
  };
  priorWednesday.marketLensSource = 'editorial';

  const refreshed = normalizedFixture({ now: new Date('2026-07-29T18:00:00Z') });
  const merged = mergeWeekAheadPayload(prior, refreshed);
  const wednesday = merged.days.find((day) => day.date === '2026-07-29');
  assert.equal(findEvent(merged, 'fed-chair-speech').status, 'released');
  assert.equal(wednesday.marketLensSource, 'generated');
  assert.equal(wednesday.marketLens.title, 'The expected rate path is the test');
  assert.equal(weekAheadMarketLensDecision(wednesday).action, 'pending_review');

  const carriedForward = applyWeekAheadLifecycle(prior, null, {
    now: new Date('2026-07-29T18:00:00Z')
  });
  const carriedWednesday = carriedForward.days.find((day) => day.date === '2026-07-29');
  assert.equal(carriedWednesday.marketLensSource, 'generated');
  assert.equal(weekAheadMarketLensDecision(carriedWednesday).action, 'pending_review');
}

function testNonStatisticalCloseCreatesOutcomeAssignment() {
  const released = normalizedFixture({ now: new Date('2026-07-29T18:00:00Z') });
  const releasedWednesday = released.days.find((day) => day.date === '2026-07-29');
  const chartData = {
    series: releasedWednesday.marketLens.reactions.map((reaction, index) => ({
      ticker: reaction.ticker,
      unit: 'price',
      bars: [
        { time: '2026-07-28', close: 100 + index },
        { time: '2026-07-29', close: 101 + index }
      ]
    }))
  };
  const afterClose = applyWeekAheadLifecycle(released, chartData, {
    now: new Date('2026-07-29T21:00:00Z')
  });
  const wednesday = afterClose.days.find((day) => day.date === '2026-07-29');
  assert.equal(wednesday.lifecycle, 'close_available');
  assert.equal(weekAheadNeedsOutcomeEditorial(wednesday), true);

  const prepared = prepareWeekAheadForEditorial(afterClose);
  assert.deepEqual(
    prepared.days.find((day) => day.date === '2026-07-29').outcome,
    { status: 'pending_review' }
  );
  const finalized = finalizeWeekAheadOutcomes(afterClose, {
    now: new Date('2026-07-29T21:01:00Z')
  });
  assert.deepEqual(
    finalized.days.find((day) => day.date === '2026-07-29').outcome,
    { status: 'pending_review' }
  );
  const verifiedOutcome = {
    status: 'verified',
    source: 'editorial',
    title: 'Policy reaction settled',
    body: 'Rates and the dollar reflected the completed Fed communication.'
  };
  const verifiedWeek = structuredClone(afterClose);
  verifiedWeek.days.find((day) => day.date === '2026-07-29').outcome = verifiedOutcome;
  assert.deepEqual(
    finalizeWeekAheadOutcomes(verifiedWeek, {
      now: new Date('2026-07-29T21:02:00Z')
    }).days.find((day) => day.date === '2026-07-29').outcome,
    verifiedOutcome
  );

  const awaitingActual = structuredClone(afterClose);
  const awaitingDay = awaitingActual.days.find((day) => day.date === '2026-07-29');
  awaitingDay.events[0] = {
    ...awaitingDay.events[0],
    valuesApplicable: true,
    status: 'awaiting_actual',
    actual: null
  };
  delete awaitingDay.outcome;
  assert.equal(weekAheadNeedsOutcomeEditorial(awaitingDay), false);
  assert.equal(
    finalizeWeekAheadOutcomes(awaitingActual).days.find((day) => day.date === '2026-07-29').outcome,
    undefined
  );
}

function testPostReleaseMarketLensSurvivesUnchangedRefresh() {
  const prior = normalizedFixture({ now: new Date('2026-07-28T14:00:00Z') });
  const priorTuesday = prior.days.find((day) => day.date === '2026-07-28');
  priorTuesday.marketLens = {
    ...priorTuesday.marketLens,
    title: 'Post-release inflation lens',
    body: 'Current inflation interpretation.'
  };
  priorTuesday.marketLensSource = 'editorial';

  const refreshed = normalizedFixture({ now: new Date('2026-07-28T15:00:00Z') });
  const merged = mergeWeekAheadPayload(prior, refreshed);
  const tuesday = merged.days.find((day) => day.date === '2026-07-28');
  assert.equal(tuesday.marketLensSource, 'editorial');
  assert.equal(tuesday.marketLens.title, 'Post-release inflation lens');
  assert.equal(weekAheadMarketLensDecision(tuesday).action, 'replace');
}

function testCorrectedReleasedFactsReopenMarketLensReview() {
  const prior = normalizedFixture({ now: new Date('2026-07-28T14:00:00Z') });
  const priorTuesday = prior.days.find((day) => day.date === '2026-07-28');
  priorTuesday.marketLens = {
    ...priorTuesday.marketLens,
    title: 'Post-release inflation lens',
    body: 'Current inflation interpretation.'
  };
  priorTuesday.marketLensSource = 'editorial';

  const refreshedProvider = providerFixture();
  refreshedProvider.result[0].actual = 3.2;
  const refreshed = normalizeWeekAhead(refreshedProvider, {
    range: RANGE,
    now: new Date('2026-07-28T15:00:00Z')
  });
  const merged = mergeWeekAheadPayload(prior, refreshed);
  const tuesday = merged.days.find((day) => day.date === '2026-07-28');
  assert.equal(findEvent(merged, 'us-cpi-yoy').actual, '3.2%');
  assert.equal(tuesday.marketLensSource, 'generated');
  assert.equal(weekAheadMarketLensDecision(tuesday).action, 'pending_review');
}

function testGeneratedLensRegeneration() {
  const week = normalizedFixture();
  const tuesday = week.days.find((day) => day.date === '2026-07-28');
  tuesday.marketLens = {
    ...tuesday.marketLens,
    title: 'Stale generated copy'
  };
  tuesday.marketLensSource = 'generated';
  const refreshed = applyMarketLensDecisions(week, [{
    date: tuesday.date,
    action: 'retain-generated'
  }]);
  assert.equal(refreshed.days.find((day) => day.date === tuesday.date).marketLens.title, 'Consumer inflation tests the rate path');
}

function testSameRangeFallbackOnly() {
  const canonical = normalizedFixture();
  const carried = buildWeekAheadPreparationFallback(canonical, RANGE, {
    checkedAt: new Date('2026-07-25T12:00:00Z')
  });
  assert.equal(carried.mode, 'carried_forward');
  assert.equal(carried.week.source.status, 'cached');
  assert.deepEqual(carried.week.availability, {
    status: 'carried_forward',
    reason: 'source_refresh_failed',
    checkedAt: '2026-07-25T12:00:00.000Z'
  });
  assert.deepEqual(validateWeekAheadPayload(carried.week), []);

  const nextRange = { from: '2026-08-03', to: '2026-08-07' };
  const unavailable = buildWeekAheadPreparationFallback(canonical, nextRange, {
    checkedAt: new Date('2026-08-01T12:00:00Z')
  });
  assert.equal(unavailable.mode, 'unavailable');
  assert.equal(unavailable.week.source.status, 'unavailable');
  assert.equal(unavailable.week.days.flatMap((day) => day.events).length, 0);
  assert.deepEqual(validateWeekAheadPayload(unavailable.week), []);
}

function testFetcherContract() {
  assert.equal(REQUEST_RETRIES, 2);
  assert.equal(dateFromArg('2026-07-27').toISOString(), '2026-07-27T12:00:00.000Z');
  assert.equal(dateFromArg('2026-02-30'), null);
  assert.equal(dateFromArg('not-a-date'), null);
  assert.deepEqual(parseArgs(['--date', '2026-07-27', '--output', 'generated/test-week.json', '--timeout-ms', '5000']), {
    date: '2026-07-27',
    output: require('path').resolve(process.cwd(), 'generated/test-week.json'),
    timeoutMs: 5000
  });

  const url = new URL(tradingViewUrl(RANGE));
  assert.equal(`${url.origin}${url.pathname}`, TRADINGVIEW_ENDPOINT);
  assert.equal(url.searchParams.get('countries'), 'US');
  assert.equal(url.searchParams.get('from'), '2026-07-26T00:00:00.000Z');
  assert.equal(url.searchParams.get('to'), '2026-08-02T00:00:00.000Z');

  assert.equal(isRetryableTradingViewError({ status: 429 }), true);
  assert.equal(isRetryableTradingViewError({ status: 404 }), false);
  assert.equal(isRetryableTradingViewError({ providerPayload: true }), true);
}

async function testFetcherRetriesAndHeaders() {
  let attempts = 0;
  const sleeps = [];
  let observedHeaders;
  const result = await requestTradingViewCalendar(RANGE, 5000, {
    requestText: async (_url, _timeout, headers) => {
      attempts += 1;
      observedHeaders = headers;
      if (attempts < 3) {
        const error = new Error('temporarily unavailable');
        error.status = 503;
        error.headers = { 'retry-after': '0' };
        throw error;
      }
      return JSON.stringify(providerFixture());
    },
    sleep: async (delay) => { sleeps.push(delay); },
    now: BEFORE_WEEK
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [0, 0]);
  assert.equal(observedHeaders.Origin, TRADINGVIEW_ORIGIN);
  assert.equal(observedHeaders.Accept, 'application/json');
  assert.equal(result.sourceSummary.includedEvents, 3);

  let fourOhFourAttempts = 0;
  await assert.rejects(
    requestTradingViewCalendar(RANGE, 5000, {
      requestText: async () => {
        fourOhFourAttempts += 1;
        const error = new Error('not found');
        error.status = 404;
        throw error;
      },
      sleep: async () => {}
    }),
    /not found/
  );
  assert.equal(fourOhFourAttempts, 1);

  let malformedAttempts = 0;
  await requestTradingViewCalendar(RANGE, 5000, {
    requestText: async () => {
      malformedAttempts += 1;
      return malformedAttempts < 3 ? '{' : JSON.stringify(providerFixture());
    },
    sleep: async () => {},
    now: BEFORE_WEEK
  });
  assert.equal(malformedAttempts, 3);

  let malformedImpactAttempts = 0;
  await requestTradingViewCalendar(RANGE, 5000, {
    requestText: async () => {
      malformedImpactAttempts += 1;
      const payload = providerFixture();
      if (malformedImpactAttempts < 3) payload.result[0].importance = null;
      return JSON.stringify(payload);
    },
    sleep: async () => {},
    now: BEFORE_WEEK
  });
  assert.equal(malformedImpactAttempts, 3);
}

async function testRunWritesOneCompletePayload() {
  let writtenPath = '';
  let writtenPayload = null;
  const payload = await run({
    date: '2026-07-27',
    output: '/tmp/week-ahead-test.json',
    timeoutMs: 5000
  }, {
    requestText: async () => JSON.stringify(providerFixture()),
    sleep: async () => {},
    now: BEFORE_WEEK,
    writePayload: (output, value) => {
      writtenPath = output;
      writtenPayload = value;
    }
  });
  assert.equal(writtenPath, '/tmp/week-ahead-test.json');
  assert.equal(writtenPayload, payload);
  assert.equal(payload.sourceSummary.includedEvents, 3);
}

async function main() {
  testRangeSelection();
  testTradingViewNormalization();
  testReleasedValuesAndLifecycle();
  testMalformedProviderRowsFailClosed();
  testLatestTradingViewValuesOwnRefresh();
  testStatisticalReleaseReopensMarketLensReview();
  testNonStatisticalReleaseReopensMarketLensReview();
  testNonStatisticalCloseCreatesOutcomeAssignment();
  testPostReleaseMarketLensSurvivesUnchangedRefresh();
  testCorrectedReleasedFactsReopenMarketLensReview();
  testGeneratedLensRegeneration();
  testSameRangeFallbackOnly();
  testFetcherContract();
  await testFetcherRetriesAndHeaders();
  await testRunWritesOneCompletePayload();
  process.stdout.write('Week Ahead tests passed.\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
