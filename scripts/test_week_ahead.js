#!/usr/bin/env node

const assert = require('assert/strict');
const {
  addDays,
  compareIsoDate,
  displayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isIsoTime,
  isSupportedFiveTradingDayRange
} = require('./calendar_contract');
const {
  applyWeekAheadLifecycle,
  buildWeekAheadPreparationFallback,
  finalizeWeekAheadOutcomes,
  fxMacroValueRequests,
  formatFxMacroValue,
  applyMarketLensDecisions,
  mergeWeekAheadPayload,
  comparableWeekAheadSurprise,
  normalizeWeekAhead,
  rangeForDate,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const {
  buildOfficialSchedule,
  dateFromArg,
  isTransient,
  parseBeaSchedule,
  parseCensusSchedule,
  requestFxMacroValues
} = require('./fetch_week_ahead');
const { calendarRolloverRange } = require('./run_daily_update');

function weekAheadDashboardFixture() {
  return {
    opening: { headline: '', deck: '' },
    tape: { rows: [{ ticker: 'SPX', group: 'Equities' }] },
    weekAhead: { days: [] }
  };
}

function officialScheduleFixture() {
  return {
    events: [
      {
        date: '2026-07-14', time: '08:30', keys: ['cpi', 'core-cpi'],
        authority: 'bls-2026', authorityName: 'BLS 2026 release schedule', authorityUrl: 'https://www.bls.gov/schedule/2026/'
      },
      {
        date: '2026-07-15', time: '08:30', keys: ['ppi', 'core-ppi'],
        authority: 'bls-2026', authorityName: 'BLS 2026 release schedule', authorityUrl: 'https://www.bls.gov/schedule/2026/'
      },
      {
        date: '2026-07-16', time: '08:30', keys: ['retail-sales', 'core-retail-sales'],
        authority: 'census-economic-indicators', authorityName: 'Census economic-indicator calendar', authorityUrl: 'https://www.census.gov/economic-indicators/calendar-listview.html'
      },
      {
        date: '2026-07-15', time: '10:30', keys: ['crude-oil-inventories'],
        authority: 'eia-wpsr-2026', authorityName: 'EIA weekly petroleum schedule', authorityUrl: 'https://www.eia.gov/petroleum/supply/weekly/schedule.php'
      }
    ],
    authorities: [{ id: 'fixture', name: 'Fixture authority', url: 'https://example.test/', mode: 'fixture', status: 'fresh', checkedAt: '2026-07-10T18:00:00.000Z' }]
  };
}

function response(data) {
  return { data };
}

function prediction(announcementId, local, predictedValue, type = 'market_consensus', sourceLabel = 'Market consensus') {
  return {
    announcement_id: announcementId,
    announcement_datetime: Date.parse(local) / 1000,
    announcement_datetime_local: local,
    predictions: predictedValue === null ? [] : [{ predicted_value: predictedValue, prediction_type: type, prediction_source_label: sourceLabel }]
  };
}

function fxMacroFixture() {
  return {
    announcements: {
      inflation: response([{ announcement_id: 'usd_inflation_2026-05-31', announcement_datetime: 1781094600, val: 4.2, val_mom: 0.5 }]),
      core_inflation: response([{ announcement_id: 'usd_core_inflation_2026-05-31', announcement_datetime: 1781094600, val: 2.9, val_mom: 0.2 }]),
      ppi: response([{ announcement_id: 'usd_ppi_2026-05-31', announcement_datetime: 1781181000, val: 5.1, val_mom: 0.8 }]),
      retail_sales: response([{ announcement_id: 'usd_retail_sales_2026-05-31', announcement_datetime: 1781699400, val: 0.9 }])
    },
    predictions: {
      inflation: response([prediction('usd_inflation_2026-06-30', '2026-07-14T08:30:00-04:00', 3.9)]),
      inflation_mom: response([prediction('usd_inflation_2026-06-30', '2026-07-14T08:30:00-04:00', 0.3)]),
      core_inflation: response([prediction('usd_core_inflation_2026-06-30', '2026-07-14T08:30:00-04:00', 3.1)]),
      core_inflation_mom: response([prediction('usd_core_inflation_2026-06-30', '2026-07-14T08:30:00-04:00', 0.2)]),
      ppi: response([prediction('usd_ppi_2026-06-30', '2026-07-15T08:30:00-04:00', 4.8, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      ppi_mom: response([prediction('usd_ppi_2026-06-30', '2026-07-15T08:30:00-04:00', 0.5, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      retail_sales: response([prediction('usd_retail_sales_2026-06-30', '2026-07-16T08:30:00-04:00', null)])
    }
  };
}

function testUpdaterWeekAheadPreservesEditorialLens() {
  const data = weekAheadDashboardFixture();
  const payload = normalizeWeekAhead({
    announcements: {
      retail_sales: { data: [{ announcement_id: 'usd_retail_sales_2026-05-31', announcement_datetime: 1781699400, val: 0.1 }] }
    },
    predictions: {
      retail_sales: { data: [{
        announcement_id: 'usd_retail_sales_2026-06-30',
        announcement_datetime: 1784205000,
        announcement_datetime_local: '2026-07-13T08:30:00-04:00',
        predictions: [{ prediction_type: 'market_consensus', predicted_value: 0.2 }]
      }] }
    }
  }, {
    range: { from: '2026-07-13', to: '2026-07-17' },
    officialSchedule: {
      events: [{
        date: '2026-07-13', time: '08:30', keys: ['retail-sales'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  data.weekAhead = {
    days: [{
      date: '2026-07-13',
      events: structuredClone(payload.days[0].events),
      marketLens: {
        question: 'Is current demand keeping rates elevated?',
        setup: { statement: 'Consumer demand remains the active growth question.', evidence: [{ kind: 'opening', field: 'deck' }] },
        relatedEventIds: ['2026-07-13:08:30:retail-sales'],
        channels: ['consumer-demand', 'broad-growth'],
        scenarios: { reinforces: 'A firmer result would reinforce demand.', challenges: 'A softer result would challenge demand.' },
        reactions: [{ ticker: 'SPX', role: 'Broad growth reaction' }],
        title: 'Custom lens',
        body: 'Editorial copy stays separate from calendar facts.'
      },
      marketLensSource: 'editorial'
    }]
  };
  data.weekAhead = mergeWeekAheadPayload(data.weekAhead, payload);
  assert.equal(data.weekAhead.days[0].marketLens.title, 'Custom lens');
  assert.equal(data.weekAhead.days[0].marketLensSource, 'editorial');
  assert.equal(data.weekAhead.days[0].events[0].time, '08:30');
  assert.equal(data.weekAhead.days[0].events[0].forecast, '0.2%');

  const releasedPayload = structuredClone(payload);
  releasedPayload.days[0].events[0].actual = '0.3%';
  releasedPayload.days[0].events[0].status = 'released';
  releasedPayload.days[0].events[0].surprise = comparableWeekAheadSurprise('0.3%', '0.2%');
  releasedPayload.days[0].lifecycle = 'released_awaiting_close';
  const releasedMerge = mergeWeekAheadPayload(data.weekAhead, releasedPayload);
  assert.equal(releasedMerge.days[0].marketLens.title, 'Custom lens');
  assert.equal(releasedMerge.days[0].marketLensSource, 'editorial');
  assert.equal(releasedMerge.days[0].lifecycle, 'released_awaiting_close');

  const failedRefresh = structuredClone(releasedPayload);
  failedRefresh.source.status = 'partial';
  failedRefresh.availability = {
    status: 'partial',
    reason: 'source_refresh_failed',
    checkedAt: '2026-07-13T13:05:00.000Z',
    failures: [{ source: 'fxmacro:announcements', item: 'retail_sales', message: 'fixture outage' }]
  };
  const failedEvent = failedRefresh.days[0].events[0];
  Object.assign(failedEvent, {
    actual: null,
    forecast: null,
    forecastType: null,
    forecastSource: null,
    previous: null,
    valueSource: null,
    verification: 'official-schedule-values-unavailable',
    surprise: null,
    status: 'awaiting_actual'
  });
  failedRefresh.days[0].lifecycle = 'awaiting_actual';
  const preservedMerge = mergeWeekAheadPayload(releasedMerge, failedRefresh);
  const preservedEvent = preservedMerge.days[0].events[0];
  assert.equal(preservedEvent.actual, '0.3%');
  assert.equal(preservedEvent.forecast, '0.2%');
  assert.equal(preservedEvent.previous, releasedMerge.days[0].events[0].previous);
  assert.equal(preservedEvent.valueSource, 'FXMacroData');
  assert.equal(preservedEvent.status, 'released');
  assert.equal(preservedMerge.days[0].lifecycle, 'released_awaiting_close');
  assert.equal(preservedMerge.availability.status, 'partial');

  const generatedData = weekAheadDashboardFixture();
  generatedData.weekAhead = {
    days: [{
      date: '2026-07-13',
      marketLens: { title: 'Stale generated lens', body: 'This should not survive a calendar refresh.', reactions: [{ ticker: 'SPX', role: 'Stale' }] }
    }]
  };
  generatedData.weekAhead = mergeWeekAheadPayload(generatedData.weekAhead, payload);
  assert.equal(generatedData.weekAhead.days[0].marketLens.title, 'Household demand tests growth');
  assert.equal(generatedData.weekAhead.days[0].marketLensSource, 'generated');
}

function testMarketLensDecisionApplication() {
  const data = weekAheadDashboardFixture();
  data.opening = { headline: 'Demand stays firm', deck: 'Consumer demand remains the current market question.' };
  data.weekAhead = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-13', to: '2026-07-17' },
    officialSchedule: {
      events: [{ date: '2026-07-13', time: '08:30', keys: ['retail-sales'], authorityName: 'Fixture schedule' }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  const editorialLens = {
    question: 'Is consumer demand keeping growth firm?',
    setup: { statement: 'Consumer demand remains the current market question.', evidence: [{ kind: 'opening', field: 'deck' }, { kind: 'tape', ticker: 'SPX' }] },
    relatedEventIds: ['2026-07-13:08:30:retail-sales'],
    channels: ['consumer-demand', 'broad-growth'],
    scenarios: { reinforces: 'A firmer result would reinforce growth.', challenges: 'A softer result would challenge growth.' },
    reactions: [{ ticker: 'SPX', role: 'Broad growth reaction' }],
    title: 'Demand tests the growth outlook',
    body: 'Retail sales will test whether household demand is keeping the growth outlook firm.'
  };

  data.weekAhead = applyMarketLensDecisions(data.weekAhead, [{ date: '2026-07-13', action: 'replace', marketLens: editorialLens }]);
  assert.equal(data.weekAhead.days[0].marketLensSource, 'editorial');
  assert.equal(data.weekAhead.days[0].marketLens.question, editorialLens.question);

  data.weekAhead = applyMarketLensDecisions(data.weekAhead, [{ date: '2026-07-13', action: 'retain-generated' }]);
  assert.equal(data.weekAhead.days[0].marketLensSource, 'generated');
  assert.equal(data.weekAhead.days[0].marketLens.title, 'Household demand tests growth');
  const missingDecisionFallback = applyMarketLensDecisions(data.weekAhead, []);
  assert.equal(missingDecisionFallback.days[0].marketLensSource, 'generated');
  const pendingDecisionFallback = applyMarketLensDecisions(data.weekAhead, [{ date: '2026-07-13', action: 'pending_review' }]);
  assert.equal(pendingDecisionFallback.days[0].marketLensSource, missingDecisionFallback.days[0].marketLensSource);
  const replacementWithOptionalTicker = applyMarketLensDecisions(data.weekAhead, [{
    date: '2026-07-13',
    action: 'replace',
    marketLens: { ...editorialLens, reactions: [{ ticker: 'QQQ', role: 'Legacy alias' }] }
  }]);
  assert.equal(replacementWithOptionalTicker.days[0].marketLensSource, 'editorial');
}


function testCalendarRolloverRange() {
  assert.deepEqual(calendarRolloverRange('afternoon', new Date('2026-07-10T21:00:00Z')), {
    from: '2026-07-10', to: '2026-07-16'
  });
  assert.deepEqual(calendarRolloverRange('morning', new Date('2026-07-13T12:00:00Z')), {
    from: '2026-07-13', to: '2026-07-17'
  });
  assert.equal(calendarRolloverRange('morning', new Date('2026-07-10T12:00:00Z')), null);
  assert.equal(calendarRolloverRange('afternoon', new Date('2026-07-13T21:00:00Z')), null);

}

function normalizedWeekAheadFixture() {
  const range = { from: '2026-07-13', to: '2026-07-17' };
  const officialSchedule = officialScheduleFixture();
  const payload = normalizeWeekAhead(fxMacroFixture(), {
    range,
    officialSchedule,
    now: new Date('2026-07-10T18:00:00Z')
  });
  return { officialSchedule, payload, range };
}

async function testProducerAndScheduleNormalization() {
  const { officialSchedule, payload, range } = normalizedWeekAheadFixture();
  assert.deepEqual(fxMacroValueRequests(officialSchedule), {
    announcements: ['inflation', 'core_inflation', 'ppi', 'retail_sales'],
    predictions: ['inflation_mom', 'inflation', 'core_inflation_mom', 'core_inflation', 'ppi', 'ppi_mom', 'retail_sales']
  });
  assert.equal(payload.days.length, 5);
  assert.equal(payload.source.provider, 'FXMacroData');
  assert.equal(payload.sourceSummary.includedEvents, 11);
  const monday = payload.days.find((day) => day.date === '2026-07-13');
  assert.deepEqual(monday.events, []);
  assert.equal(monday.marketLens, undefined);
  assert.equal(monday.marketLensSource, undefined);
  const tuesday = payload.days.find((day) => day.date === '2026-07-14');
  assert.equal(tuesday.events.length, 4);
  assert.deepEqual(tuesday.events.map((event) => event.period), ['MoM', 'YoY', 'MoM', 'YoY']);
  assert.deepEqual(tuesday.events.map((event) => event.time), ['08:30', '08:30', '08:30', '08:30']);
  assert.equal(tuesday.events[0].name, 'Core Consumer Price Index');
  assert.equal(tuesday.events[0].forecast, '0.2%');
  assert.equal(tuesday.events[0].previous, '0.2%');
  assert.equal(tuesday.events[3].forecast, '3.9%');
  assert.equal(tuesday.events[3].previous, '4.2%');
  assert.equal(tuesday.events[3].valueSource, 'FXMacroData');
  assert.equal(tuesday.marketLens.title, 'Consumer inflation tests the rate path');
  assert.deepEqual(tuesday.marketLens.relatedEventIds, tuesday.events.map((event) => event.id).sort());
  assert.deepEqual(tuesday.marketLens.reactions.map((reaction) => reaction.ticker), ['UST2Y', 'UUP']);
  assert.equal(tuesday.marketLensSource, 'generated');
  assert.equal(tuesday.lifecycle, 'scheduled');
  assert.ok(tuesday.events.every((event) => event.status === 'scheduled'));
  const wednesday = payload.days.find((day) => day.date === '2026-07-15');
  assert.deepEqual(wednesday.events.map((event) => event.id), [
    '2026-07-15:08:30:core-ppi-mom',
    '2026-07-15:08:30:core-ppi-yoy',
    '2026-07-15:08:30:ppi-mom',
    '2026-07-15:08:30:ppi-yoy',
    '2026-07-15:10:30:crude-oil-inventories'
  ]);
  assert.equal(wednesday.events[2].forecast, '0.5%');
  assert.equal(wednesday.events[2].forecastType, 'model');
  assert.equal(wednesday.events[2].previous, '0.8%');
  assert.equal(wednesday.events[3].previous, '5.1%');
  assert.equal(wednesday.events[0].valueSource, null, 'Unsupported core-PPI variants remain blank.');
  assert.equal(wednesday.events[2].scheduleSource, 'BLS 2026 release schedule');
  assert.equal(payload.sourceSummary.officialConflicts, 0);
  const thursday = payload.days.find((day) => day.date === '2026-07-16');
  assert.deepEqual(thursday.events.map((event) => event.id), [
    '2026-07-16:08:30:core-retail-sales',
    '2026-07-16:08:30:retail-sales'
  ]);
  assert.equal(thursday.events[1].previous, '0.9%');
  assert.deepEqual(validateWeekAheadPayload(payload), []);

  const census = parseCensusSchedule(`
    <h1>2026 Economic Indicator Release Schedule</h1>
    <tr><td><a>Advance Monthly Sales for Retail and Food Services</a></td><td>July 16, 2026</td><td>8:30 AM</td></tr>
  `);
  assert.deepEqual(census[0].keys, ['retail-sales', 'core-retail-sales']);
  assert.equal(census[0].date, '2026-07-16');
  const bea = parseBeaSchedule(`
    <h1>Release Schedule Year 2026</h1>
    <tr><td class="scheduled-date no-wrap"><div class="release-date">July 30</div><small>8:30 AM</small></td><td class="release-title">GDP (Advance Estimate), 2nd Quarter 2026</td></tr>
  `);
  assert.deepEqual(bea[0].keys, ['gdp']);
  assert.deepEqual(parseCensusSchedule(`
    <h1>2026 Economic Indicator Release Schedule</h1>
    <tr><td>Advance Monthly Sales for Retail and Food Services</td><td></td><td>8:30 AM</td></tr>
    <tr><td>Advance Monthly Sales for Retail and Food Services</td><td>July 16, 2026</td><td>8:99 AM</td></tr>
  `), []);
  const builtSchedule = buildOfficialSchedule(range, {
    censusHtml: '<h1>2026 Economic Indicator Release Schedule</h1><tr><td>Advance Monthly Sales for Retail and Food Services</td><td>July 16, 2026</td><td>8:30 AM</td></tr>',
    beaHtml: '<h1>Release Schedule Year 2026</h1><tr><td><div class="release-date">July 30</div><small>8:30 AM</small></td><td class="release-title">GDP (Advance Estimate), 2nd Quarter 2026</td></tr>',
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.ok(builtSchedule.events.some((item) => item.date === '2026-07-14' && item.keys.includes('cpi')));
  assert.ok(builtSchedule.events.some((item) => item.date === '2026-07-15' && item.keys.includes('crude-oil-inventories')));
  const partialSchedule = buildOfficialSchedule(range, {
    censusHtml: '<h1>2026 Economic Indicator Release Schedule</h1>',
    beaHtml: '<h1>Release Schedule Year 2026</h1>'
  });
  assert.ok(partialSchedule.events.some((item) => item.keys.includes('cpi')), 'Available maintained authority events should survive unavailable live schedules.');
  assert.equal(partialSchedule.authorities.find((item) => item.id === 'census-economic-indicators').status, 'unavailable');
  assert.equal(partialSchedule.authorities.find((item) => item.id === 'bea-release-schedule').status, 'unavailable');
  const partialPayload = normalizeWeekAhead({
    announcements: {},
    predictions: {},
    failures: [{ kind: 'announcements', indicator: 'cpi', message: 'fixture values unavailable' }]
  }, {
    range,
    officialSchedule: {
      ...builtSchedule,
      failures: [{ authority: 'census', message: 'fixture schedule unavailable' }]
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.equal(partialPayload.source.status, 'partial');
  assert.equal(partialPayload.availability.status, 'partial');
  assert.equal(partialPayload.availability.failures.length, 2);
  assert.deepEqual(validateWeekAheadPayload(partialPayload), []);

  const partialValues = await requestFxMacroValues(builtSchedule, 1000, {
    requestJson: async (url) => {
      if (url.includes('/ppi?')) throw new Error('fixture indicator failure');
      return [];
    }
  });
  assert.ok(Object.keys(partialValues.announcements).length > 0);
  assert.ok(Object.keys(partialValues.predictions).length > 0);
  assert.ok(partialValues.failures.length > 0);
  assert.ok(partialValues.failures.every((item) => item.indicator === 'ppi'));
  const collectedPartialPayload = normalizeWeekAhead(partialValues, {
    range,
    officialSchedule: builtSchedule,
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.equal(collectedPartialPayload.source.status, 'partial');
  assert.deepEqual(validateWeekAheadPayload(collectedPartialPayload), []);

  const failedValues = await requestFxMacroValues(builtSchedule, 1000, {
    requestJson: async () => { throw new Error('fixture total outage'); }
  });
  assert.equal(Object.keys(failedValues.announcements).length, 0);
  assert.equal(Object.keys(failedValues.predictions).length, 0);
  assert.ok(failedValues.failures.length > 0);
  const failedValuePayload = normalizeWeekAhead(failedValues, {
    range,
    officialSchedule: builtSchedule,
    now: new Date('2026-07-10T18:05:00Z')
  });
  assert.equal(failedValuePayload.source.status, 'partial');
  assert.equal(failedValuePayload.availability.status, 'partial');
  assert.deepEqual(validateWeekAheadPayload(failedValuePayload), []);
  const priorValuePayload = normalizeWeekAhead(fxMacroFixture(), {
    range,
    officialSchedule: builtSchedule,
    now: new Date('2026-07-10T18:00:00Z')
  });
  const priorSeedEvent = priorValuePayload.days
    .flatMap((day) => day.events)
    .find((event) => event.id === '2026-07-15:08:30:ppi-yoy');
  priorSeedEvent.actual = '5.1%';
  priorSeedEvent.status = 'released';
  const mergedAfterValueOutage = mergeWeekAheadPayload(priorValuePayload, failedValuePayload);
  const preservedRelease = mergedAfterValueOutage.days
    .flatMap((day) => day.events)
    .find((event) => event.id === '2026-07-15:08:30:ppi-yoy');
  const priorRelease = priorValuePayload.days
    .flatMap((day) => day.events)
    .find((event) => event.id === '2026-07-15:08:30:ppi-yoy');
  assert.equal(preservedRelease.actual, priorRelease.actual);
  assert.equal(preservedRelease.forecast, priorRelease.forecast);
  assert.equal(mergedAfterValueOutage.availability.status, 'partial');

  const recoveredValues = await requestFxMacroValues(builtSchedule, 1000, {
    requestJson: async () => []
  });
  assert.deepEqual(recoveredValues.failures, []);
  const recoveredPayload = normalizeWeekAhead(recoveredValues, {
    range,
    officialSchedule: builtSchedule,
    now: new Date('2026-07-10T18:05:00Z')
  });
  assert.equal(recoveredPayload.availability, undefined);
  assert.deepEqual(validateWeekAheadPayload(recoveredPayload), []);
}

function testVerifiedFxMacroValueMappings() {
  const range = { from: '2026-07-13', to: '2026-07-17' };
  const officialSchedule = {
    events: [
      {
        date: '2026-07-13', time: '08:30', keys: ['average-hourly-earnings', 'gdp', 'trade-balance'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      },
      {
        date: '2026-07-13', time: '10:00', keys: ['jolts'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      },
      {
        date: '2026-07-13', time: '14:00', keys: ['fed-rate-decision'],
        authority: 'fixture', authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/'
      }
    ],
    authorities: [{ id: 'fixture', name: 'Fixture schedule', url: 'https://example.test/', mode: 'fixture', status: 'fresh', checkedAt: '2026-07-10T18:00:00.000Z' }]
  };
  assert.deepEqual(fxMacroValueRequests(officialSchedule), {
    announcements: ['average_hourly_earnings', 'gdp', 'gdp_growth_qoq_saar', 'trade_balance', 'job_openings', 'policy_rate_midpoint'],
    predictions: ['average_hourly_earnings', 'gdp', 'gdp_growth_qoq_saar', 'trade_balance', 'job_openings', 'policy_rate_midpoint']
  });
  const payload = normalizeWeekAhead({
    announcements: {
      average_hourly_earnings: response([{ announcement_id: 'usd_average_hourly_earnings_2026-06-30', announcement_datetime: 1782995400, val: 3.5 }]),
      gdp: response([{ announcement_id: 'usd_gdp_2026-03-31', announcement_datetime: 1777552200, val: 6045.105 }]),
      gdp_growth_qoq_saar: response([{ announcement_id: 'usd_gdp_growth_qoq_saar_2026-03-31', announcement_datetime: 1777552200, val: 2.1 }]),
      trade_balance: response([{ announcement_id: 'usd_trade_balance_2026-05-31', announcement_datetime: 1783427400, val: -77585 }]),
      job_openings: response([{ announcement_id: 'usd_job_openings_2026-05-31', announcement_datetime: 1782828000, val: 7594 }]),
      policy_rate_midpoint: response([{ announcement_id: 'usd_policy_rate_midpoint_2026-06-17', announcement_datetime: 1781719200, val: 3.625 }])
    },
    predictions: {
      average_hourly_earnings: response([prediction('usd_average_hourly_earnings_2026-07-31', '2026-07-13T08:30:00-04:00', 3.51, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      gdp: response([prediction('usd_gdp_2026-07-30', '2026-07-13T08:30:00-04:00', 6059.23, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      gdp_growth_qoq_saar: response([prediction('usd_gdp_growth_qoq_saar_2026-07-30', '2026-07-13T08:30:00-04:00', 1.98, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      trade_balance: response([prediction('usd_trade_balance_2026-08-04', '2026-07-13T08:30:00-04:00', -72701.01, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      job_openings: response([prediction('usd_job_openings_2026-07-31', '2026-07-13T10:00:00-04:00', 7641.49, 'fxmacrodata', 'FXMacroData Blended Forecast')]),
      policy_rate_midpoint: response([prediction('usd_policy_rate_midpoint_2026-07-29', '2026-07-13T14:00:00-04:00', 3.625)])
    }
  }, {
    range,
    officialSchedule,
    now: new Date('2026-07-10T18:00:00Z')
  });
  const events = payload.days.find((day) => day.date === '2026-07-13').events;
  assert.deepEqual(events.map((event) => event.id), [
    '2026-07-13:08:30:average-hourly-earnings',
    '2026-07-13:08:30:gdp-growth',
    '2026-07-13:08:30:gdp-level',
    '2026-07-13:08:30:trade-balance',
    '2026-07-13:10:00:jolts',
    '2026-07-13:14:00:fed-rate-decision'
  ]);
  assert.equal(events[0].period, 'YoY');
  assert.equal(events[0].forecast, '3.5%');
  assert.equal(events[1].forecast, '2%');
  assert.equal(events[1].previous, '2.1%');
  assert.equal(events[2].forecast, '$6.06T');
  assert.equal(events[2].previous, '$6.05T');
  assert.equal(events[3].forecast, '-$72.7B');
  assert.equal(events[3].previous, '-$77.6B');
  assert.equal(events[4].forecast, '7.6M');
  assert.equal(events[4].previous, '7.6M');
  assert.equal(events[5].forecast, '3.6%');
  assert.equal(events[5].forecastType, 'consensus');
  assert.deepEqual(validateWeekAheadPayload(payload), []);
}

function testLifecycleAndCloseReactionTransitions() {
  const { payload } = normalizedWeekAheadFixture();
  const awaitingActual = applyWeekAheadLifecycle(payload, null, { now: new Date('2026-07-14T13:00:00Z'), windowMode: 'morning' });
  assert.equal(awaitingActual.days.find((day) => day.date === '2026-07-14').lifecycle, 'awaiting_actual');
  assert.deepEqual(validateWeekAheadPayload(payload, { now: new Date('2026-07-14T13:00:00Z') }), []);

  const released = structuredClone(payload);
  const releasedTuesday = released.days.find((day) => day.date === '2026-07-14');
  releasedTuesday.events[0].actual = '0.4%';
  const prematureActual = applyWeekAheadLifecycle(released, null, { now: new Date('2026-07-14T12:00:00Z'), windowMode: 'morning' });
  const prematureEvent = prematureActual.days.find((day) => day.date === '2026-07-14').events[0];
  assert.equal(prematureEvent.actual, null);
  assert.equal(prematureEvent.status, 'scheduled');
  assert.equal(prematureEvent.surprise, null);
  assert.deepEqual(validateWeekAheadPayload(prematureActual, { now: new Date('2026-07-14T12:00:00Z') }), []);
  const awaitingClose = applyWeekAheadLifecycle(released, null, { now: new Date('2026-07-14T14:00:00Z'), windowMode: 'morning' });
  assert.equal(awaitingClose.days.find((day) => day.date === '2026-07-14').lifecycle, 'released_awaiting_close');
  const unavailableReleasedLens = applyMarketLensDecisions(awaitingClose, awaitingClose.days
    .filter((day) => day.events.length)
    .map((day) => day.date === '2026-07-14'
      ? { date: day.date, action: 'commentary-unavailable', attemptedAt: '2026-07-14T14:05:00.000Z', reason: 'current_run_research_exhausted' }
      : { date: day.date, action: 'retain-generated' }));
  const unavailableLensDay = unavailableReleasedLens.days.find((day) => day.date === '2026-07-14');
  assert.equal(unavailableLensDay.marketLensSource, 'unavailable');
  assert.equal(unavailableLensDay.marketLensDisposition.status, 'commentary_unavailable');
  assert.deepEqual(validateWeekAheadPayload(unavailableReleasedLens), []);
  const prematureUnavailable = applyMarketLensDecisions(awaitingActual, awaitingActual.days
    .filter((day) => day.events.length)
    .map((day) => day.date === '2026-07-14'
      ? { date: day.date, action: 'commentary-unavailable', attemptedAt: '2026-07-14T13:05:00.000Z', reason: 'current_run_research_exhausted' }
      : { date: day.date, action: 'retain-generated' }));
  assert.equal(prematureUnavailable.days.find((day) => day.date === '2026-07-14').marketLensSource, 'generated');
  const invalidPreRelease = structuredClone(awaitingActual);
  Object.assign(invalidPreRelease.days.find((day) => day.date === '2026-07-14'), {
    marketLens: unavailableLensDay.marketLens,
    marketLensSource: unavailableLensDay.marketLensSource,
    marketLensDisposition: unavailableLensDay.marketLensDisposition
  });
  assert.deepEqual(validateWeekAheadPayload(invalidPreRelease), []);
  assert.deepEqual(comparableWeekAheadSurprise('0.4%', '0.2%'), { direction: 'above', delta: 0.2, unit: '%' });
  const prematureClose = applyWeekAheadLifecycle(awaitingClose, {
    series: [
      { ticker: 'UST2Y', unit: 'percent_yield', bars: [{ time: '2026-07-13', close: 4.1 }, { time: '2026-07-14', close: 4.18 }] },
      { ticker: 'UUP', unit: 'price', bars: [{ time: '2026-07-13', close: 28 }, { time: '2026-07-14', close: 28.14 }] }
    ]
  }, { now: new Date('2026-07-14T19:59:00Z'), windowMode: 'afternoon' });
  assert.equal(prematureClose.days.find((day) => day.date === '2026-07-14').lifecycle, 'released_awaiting_close');
  const afterClose = applyWeekAheadLifecycle(awaitingClose, {
    series: [
      { ticker: 'UST2Y', unit: 'percent_yield', bars: [{ time: '2026-07-13', close: 4.1 }, { time: '2026-07-14', close: 4.18 }] },
      { ticker: 'UUP', unit: 'price', bars: [{ time: '2026-07-13', close: 28 }, { time: '2026-07-14', close: 28.14 }] }
    ]
  }, { now: new Date('2026-07-14T21:00:00Z'), windowMode: 'afternoon' });
  const closedTuesday = afterClose.days.find((day) => day.date === '2026-07-14');
  assert.equal(closedTuesday.lifecycle, 'close_available');
  assert.deepEqual(closedTuesday.marketReaction.rows.map((row) => row.ticker), ['UST2Y', 'UUP']);
  assert.match(validateWeekAheadPayload(afterClose, { now: new Date('2026-07-14T19:59:00Z') }).join('\n'), /cannot precede the event-day market close/);
  assert.match(
    validateWeekAheadPayload(afterClose, { requireOutcomeDisposition: true }).join('\n'),
    /requires an outcome disposition/,
    'Publication validation must require a disposition, not necessarily prose.'
  );
  const unfinishedOutcome = finalizeWeekAheadOutcomes(afterClose, { now: new Date('2026-07-14T22:05:00Z') });
  assert.equal(unfinishedOutcome.days.find((day) => day.date === '2026-07-14').outcome.status, 'pending_review');
  assert.deepEqual(validateWeekAheadPayload(unfinishedOutcome, { requireOutcomeDisposition: true }), []);
  const failOpenOutcome = structuredClone(afterClose);
  failOpenOutcome.days.find((day) => day.date === '2026-07-14').outcome = {
    status: 'commentary_unavailable',
    source: 'editorial',
    reason: 'current_run_research_exhausted',
    attemptedAt: '2026-07-14T22:05:00.000Z'
  };
  assert.deepEqual(validateWeekAheadPayload(failOpenOutcome, { requireOutcomeDisposition: true }), []);
  const retriedOutcome = finalizeWeekAheadOutcomes(failOpenOutcome, { now: new Date('2026-07-15T22:05:00Z') });
  assert.deepEqual(retriedOutcome.days.find((day) => day.date === '2026-07-14').outcome, { status: 'pending_review' });
  const contradictoryOutcome = structuredClone(failOpenOutcome);
  contradictoryOutcome.days.find((day) => day.date === '2026-07-14').outcome.title = 'Unsupported interpretation';
  assert.deepEqual(validateWeekAheadPayload(finalizeWeekAheadOutcomes(contradictoryOutcome, { now: new Date('2026-07-14T22:05:00Z') }), { requireOutcomeDisposition: true }), []);
  closedTuesday.outcome = { source: 'editorial', title: 'Inflation firmed', body: 'The release and close reaction reinforced a firmer expected policy path.' };
  const finalizedVerified = finalizeWeekAheadOutcomes(afterClose, { now: new Date('2026-07-14T22:05:00Z') });
  assert.equal(finalizedVerified.days.find((day) => day.date === '2026-07-14').outcome.status, 'verified');
  assert.deepEqual(validateWeekAheadPayload(afterClose), []);
  closedTuesday.marketReaction.rows[0].unit = 'basis_points';
  assert.deepEqual(validateWeekAheadPayload(afterClose), []);
  closedTuesday.marketReaction.rows[0].unit = 'percent_yield';
  const sameValues = mergeWeekAheadPayload(afterClose, awaitingClose);
  assert.equal(sameValues.days.find((day) => day.date === '2026-07-14').outcome.title, 'Inflation firmed');
  const quarantinedLens = applyMarketLensDecisions(sameValues, sameValues.days
    .filter((day) => day.events.length)
    .map((day) => day.date === '2026-07-14'
      ? {
          date: day.date,
          action: 'replace',
          marketLens: { ...closedTuesday.marketLens, reactions: [{ ticker: 'UST10Y', role: 'Long-rate reaction' }, { ticker: 'UUP', role: 'Dollar-policy reaction' }] }
        }
      : { date: day.date, action: 'retain-generated' }));
  const quarantinedTuesday = quarantinedLens.days.find((day) => day.date === '2026-07-14');
  assert.equal(quarantinedTuesday.marketLensSource, 'generated');
  assert.deepEqual(quarantinedTuesday.marketLens.reactions, closedTuesday.marketLens.reactions);
  const badPreEventLens = structuredClone(awaitingClose);
  badPreEventLens.days.find((day) => day.date === '2026-07-15').marketLens = { title: 'Bad lens', body: 'Missing required reaction contract.' };
  const finalizedBadPreEventLens = finalizeWeekAheadOutcomes(badPreEventLens, { now: new Date('2026-07-14T22:05:00Z') });
  const finalizedBadPreEventDay = finalizedBadPreEventLens.days.find((day) => day.date === '2026-07-15');
  assert.equal(finalizedBadPreEventDay.marketLensSource, 'generated');
  assert.deepEqual(validateWeekAheadPayload(finalizedBadPreEventLens), []);
  const correctedClose = applyWeekAheadLifecycle(sameValues, {
    series: [
      { ticker: 'UST2Y', unit: 'percent_yield', bars: [{ time: '2026-07-13', close: 4.1 }, { time: '2026-07-14', close: 4.2 }] },
      { ticker: 'UUP', unit: 'price', bars: [{ time: '2026-07-13', close: 28 }, { time: '2026-07-14', close: 28.14 }] }
    ]
  }, { now: new Date('2026-07-14T22:00:00Z'), windowMode: 'afternoon' });
  assert.equal(correctedClose.days.find((day) => day.date === '2026-07-14').outcome, undefined);
  const revised = structuredClone(awaitingClose);
  revised.days.find((day) => day.date === '2026-07-14').events[0].actual = '0.5%';
  revised.days.find((day) => day.date === '2026-07-14').events[0].surprise = comparableWeekAheadSurprise('0.5%', '0.2%');
  const revisedMerge = mergeWeekAheadPayload(afterClose, revised);
  assert.equal(revisedMerge.days.find((day) => day.date === '2026-07-14').outcome, undefined);
  const revisedProvenance = structuredClone(awaitingClose);
  revisedProvenance.days.find((day) => day.date === '2026-07-14').events.forEach((event) => { event.scheduleSource = 'Corrected official schedule'; });
  revisedProvenance.officialSchedule.events.find((release) => release.date === '2026-07-14').authorityName = 'Corrected official schedule';
  const revisedProvenanceMerge = mergeWeekAheadPayload(afterClose, revisedProvenance);
  assert.equal(revisedProvenanceMerge.days.find((day) => day.date === '2026-07-14').outcome, undefined);

}

function testMarketLensDecisions() {
  const { payload, range } = normalizedWeekAheadFixture();
  const industrialPayload = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range,
    officialSchedule: {
      events: [{ date: '2026-07-17', time: '09:15', keys: ['industrial-production'], authorityName: 'Fixture', authorityUrl: 'https://example.test/' }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.equal(industrialPayload.days.find((day) => day.date === '2026-07-17').marketLens.title, 'Industry tests the cyclical pulse');

  const generatedDrift = structuredClone(payload);
  generatedDrift.days[1].marketLens.reactions[0].ticker = '2-Y';
  assert.match(validateWeekAheadPayload(generatedDrift).join('\n'), /canonical uppercase/);

  const invalidEditorial = structuredClone(payload);
  invalidEditorial.days[1].marketLensSource = 'editorial';
  assert.doesNotMatch(validateWeekAheadPayload(invalidEditorial).join('\n'), /setup must contain|scenarios must explain/);

}

function testPayloadValidationMutations() {
  const { payload } = normalizedWeekAheadFixture();
  const cases = [
    ['duplicate event identity', (value) => { value.days[2].events[0].id = value.days[1].events[0].id; }, /must be unique/],
    ['malformed day date', (value) => { value.days[1].date = '2026-02-30'; }, /must match the target weekday/],
    ['malformed event time', (value) => { value.days[1].events[0].time = '99:99'; }, /must be an ordered HH:MM time/],
    ['unsupported display range', (value) => { value.range = { from: '2026-07-14', to: '2026-07-18' }; }, /Monday-Friday or Friday plus next Monday-Thursday/]
  ];
  for (const [name, mutate, expectedError] of cases) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.match(validateWeekAheadPayload(invalid).join('\n'), expectedError, name);
  }
}

function testWeekAheadPreparationFallbacks() {
  const { payload } = normalizedWeekAheadFixture();
  const carried = buildWeekAheadPreparationFallback(payload, payload.range, {
    checkedAt: '2026-07-10T21:05:00.000Z'
  });
  assert.equal(carried.mode, 'carried_forward');
  assert.equal(carried.week.availability.status, 'carried_forward');
  assert.equal(carried.week.availability.checkedAt, '2026-07-10T21:05:00.000Z');
  assert.equal(carried.week.source.fetchedAt, payload.source.fetchedAt, 'Fallback must preserve the last successful source timestamp.');
  assert.deepEqual(carried.week.days, payload.days, 'Fallback must preserve the existing Week Ahead values and events.');
  assert.deepEqual(validateWeekAheadPayload(carried.week), []);

  const unavailable = buildWeekAheadPreparationFallback(payload, {
    from: '2026-07-17',
    to: '2026-07-23'
  }, { checkedAt: '2026-07-17T21:05:00.000Z' });
  assert.equal(unavailable.mode, 'unavailable');
  assert.equal(unavailable.week.source.status, 'unavailable');
  assert.equal(unavailable.week.days.length, 5);
  assert.ok(unavailable.week.days.every((day) => day.events.length === 0));
  assert.deepEqual(validateWeekAheadPayload(unavailable.week), []);

  const recovered = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: { from: '2026-07-17', to: '2026-07-23' },
    officialSchedule: {
      events: [{ date: '2026-07-20', time: '08:30', keys: ['retail-sales'], authorityName: 'Fixture schedule', authorityUrl: 'https://example.test/schedule' }],
      authorities: []
    },
    now: new Date('2026-07-17T21:10:00.000Z')
  });
  assert.equal(recovered.availability, undefined);
  assert.equal(recovered.days.find((day) => day.date === '2026-07-20').events.length, 1);
  assert.deepEqual(validateWeekAheadPayload(recovered), []);

  unavailable.week.availability.reason = 'unknown';
  assert.deepEqual(validateWeekAheadPayload(unavailable.week), []);
}

function testCalendarAndTransientCases() {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDateTime('2026-07-10T15:45:00-05:00'), true);
  assert.equal(isIsoDateTime('2026-07-10T25:45:00Z'), false);
  assert.equal(isIsoDateTime('2026-07-10'), false);
  assert.equal(isIsoTime('08:30'), true);
  assert.equal(isIsoTime('99:99'), false);
  assert.equal(addDays('2026-07-10', 3), '2026-07-13');
  assert.equal(compareIsoDate('2026-07-10', '2026-07-13') < 0, true);
  assert.equal(isSupportedFiveTradingDayRange('2026-07-13', '2026-07-17'), true);
  assert.equal(isSupportedFiveTradingDayRange('2026-07-10', '2026-07-16'), true);
  assert.equal(isSupportedFiveTradingDayRange('2026-07-11', '2026-07-17'), false);
  assert.deepEqual(displayDatesForRange('2026-07-10', '2026-07-16'), [
    '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'
  ]);
  assert.deepEqual(rangeForDate(new Date('2026-07-10T18:00:00Z')), { from: '2026-07-10', to: '2026-07-16' });
  assert.deepEqual(rangeForDate(new Date('2026-07-12T18:00:00Z')), { from: '2026-07-10', to: '2026-07-16' });
  assert.deepEqual(rangeForDate(new Date('2026-07-13T18:00:00Z')), { from: '2026-07-13', to: '2026-07-17' });
  assert.equal(dateFromArg('2026-02-30'), null, 'Impossible calendar dates must not roll into another week.');
  assert.equal(dateFromArg('2026-02-28')?.toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(isTransient(new Error('Malformed provider payload')), false, 'Parser and contract errors must not use cached data.');
  assert.equal(isTransient(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(isTransient(Object.assign(new Error('Socket reset'), { transient: true })), true);
  assert.equal(formatFxMacroValue(1413, 'millions'), '1.413M');
  assert.equal(formatFxMacroValue(7641.49, 'thousandsAsMillions'), '7.6M');
  assert.equal(formatFxMacroValue(6059.23, 'usdBillions'), '$6.06T');
  assert.equal(formatFxMacroValue(-72701.01, 'usdMillions'), '-$72.7B');
}

async function run() {
  const tests = [
    testUpdaterWeekAheadPreservesEditorialLens,
    testMarketLensDecisionApplication,
    testCalendarRolloverRange,
    testProducerAndScheduleNormalization,
    testVerifiedFxMacroValueMappings,
    testLifecycleAndCloseReactionTransitions,
    testMarketLensDecisions,
    testPayloadValidationMutations,
    testWeekAheadPreparationFallbacks,
    testCalendarAndTransientCases
  ];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      error.message = `${test.name}: ${error.message}`;
      throw error;
    }
  }
  process.stdout.write('Calendar and Week Ahead tests passed.\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
