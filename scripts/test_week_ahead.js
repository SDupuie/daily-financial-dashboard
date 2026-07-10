#!/usr/bin/env node

const assert = require('assert/strict');
const {
  fxMacroValueRequests,
  formatFxMacroValue,
  normalizeWeekAhead,
  rangeForDate,
  TIME_INTERPRETATION,
  validateWeekAheadPayload
} = require('./week_ahead_contract');
const {
  buildOfficialSchedule,
  parseBeaSchedule,
  parseCensusSchedule
} = require('./week_ahead_official');
const {
  dateFromArg,
  isTransient,
  parseArgs
} = require('./fetch_week_ahead');

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

function run() {
  const fridayRange = rangeForDate(new Date('2026-07-10T18:00:00Z'));
  assert.deepEqual(fridayRange, { from: '2026-07-10', to: '2026-07-16' });
  assert.equal(dateFromArg('2026-02-30'), null, 'Impossible calendar dates must not roll into another week.');
  assert.equal(dateFromArg('2026-02-28')?.toISOString(), '2026-02-28T12:00:00.000Z');
  assert.throws(() => parseArgs(['--timeout-ms', 'not-a-number']), /finite number/);
  assert.throws(() => parseArgs(['--timeout-ms', '999']), /at least 1000/);
  assert.equal(parseArgs(['--timeout-ms', '1000']).timeoutMs, 1000);
  assert.equal(isTransient(new Error('Malformed provider payload')), false, 'Parser and contract errors must not use cached data.');
  assert.equal(isTransient(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(isTransient(Object.assign(new Error('Socket reset'), { transient: true })), true);
  assert.equal(formatFxMacroValue(1413, 'millions'), '1.413M');
  const sundayRange = rangeForDate(new Date('2026-07-12T18:00:00Z'));
  assert.deepEqual(sundayRange, { from: '2026-07-10', to: '2026-07-16' });
  const mondayRange = rangeForDate(new Date('2026-07-13T18:00:00Z'));
  assert.deepEqual(mondayRange, { from: '2026-07-13', to: '2026-07-17' });

  const officialSchedule = officialScheduleFixture();
  assert.deepEqual(fxMacroValueRequests(officialSchedule), {
    announcements: ['inflation', 'core_inflation', 'ppi', 'retail_sales'],
    predictions: ['inflation_mom', 'inflation', 'core_inflation_mom', 'core_inflation', 'ppi', 'ppi_mom', 'retail_sales']
  });
  const payload = normalizeWeekAhead(fxMacroFixture(), {
    range: mondayRange,
    officialSchedule,
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.equal(payload.days.length, 5);
  assert.equal(payload.source.provider, 'FXMacroData');
  assert.equal(payload.source.timeInterpretation, TIME_INTERPRETATION);
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
  assert.equal(tuesday.marketLens.title, 'CPI is the rates reset');
  assert.match(tuesday.marketLens.body, /2Y, dollar/);
  assert.equal(tuesday.marketLensSource, 'generated');
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

  const industrialPayload = normalizeWeekAhead({ announcements: {}, predictions: {} }, {
    range: mondayRange,
    officialSchedule: {
      events: [{ date: '2026-07-17', time: '09:15', keys: ['industrial-production'], authorityName: 'Fixture', authorityUrl: 'https://example.test/' }],
      authorities: []
    },
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.equal(industrialPayload.days.find((day) => day.date === '2026-07-17').marketLens.title, 'Output tests the cyclical handoff');

  const malformed = structuredClone(payload);
  malformed.days[2].events[0].id = malformed.days[1].events[0].id;
  assert.match(validateWeekAheadPayload(malformed).join('\n'), /must be unique/);

  const invalidEventTime = structuredClone(payload);
  invalidEventTime.days[1].events[0].time = '99:99';
  assert.match(validateWeekAheadPayload(invalidEventTime).join('\n'), /must be an ordered HH:MM time/);

  const invalidOfficialTime = structuredClone(payload);
  invalidOfficialTime.officialSchedule.events[0].time = '99:99';
  assert.match(validateWeekAheadPayload(invalidOfficialTime).join('\n'), /officialSchedule\.events contains an invalid release/);

  const timezoneFreeTimestamp = structuredClone(payload);
  timezoneFreeTimestamp.generatedAt = '2026-07-10T18:00:00';
  assert.match(validateWeekAheadPayload(timezoneFreeTimestamp).join('\n'), /offset-bearing ISO timestamp/);

  const staleProvenance = structuredClone(payload);
  staleProvenance.source.timeInterpretation = 'Nasdaq schedule times';
  assert.match(validateWeekAheadPayload(staleProvenance).join('\n'), /timeInterpretation/);

  const shifted = structuredClone(payload);
  shifted.range.from = '2026-07-14';
  shifted.range.to = '2026-07-18';
  assert.match(validateWeekAheadPayload(shifted).join('\n'), /Monday-Friday or Friday plus next Monday-Thursday/);

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
  const official = buildOfficialSchedule({ from: '2026-07-13', to: '2026-07-17' }, {
    censusHtml: '<h1>2026 Economic Indicator Release Schedule</h1><tr><td>Advance Monthly Sales for Retail and Food Services</td><td>July 16, 2026</td><td>8:30 AM</td></tr>',
    beaHtml: '<h1>Release Schedule Year 2026</h1><tr><td><div class="release-date">July 30</div><small>8:30 AM</small></td><td class="release-title">GDP (Advance Estimate), 2nd Quarter 2026</td></tr>',
    now: new Date('2026-07-10T18:00:00Z')
  });
  assert.ok(official.events.some((item) => item.date === '2026-07-14' && item.keys.includes('cpi')));
  assert.ok(official.events.some((item) => item.date === '2026-07-15' && item.keys.includes('crude-oil-inventories')));
  assert.throws(() => buildOfficialSchedule({ from: '2026-07-13', to: '2026-07-17' }, {
    censusHtml: '<h1>2026 Economic Indicator Release Schedule</h1>',
    beaHtml: '<h1>Release Schedule Year 2026</h1>'
  }), /no recognized covered releases/);

  process.stdout.write('Week Ahead tests passed.\n');
}

run();
