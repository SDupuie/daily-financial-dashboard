#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  EARNINGS_WEEK_SCHEMA_VERSION,
  applyEarningsLifecycle,
  attachReactions,
  buildEarningsNarrativeSidecar,
  buildEarningsWeekPolicy,
  buildCompanyReleaseTasks,
  combinedOutcome,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsApiMonthEntry,
  earningsApiUsageMonth,
  earningsCalendarRangeNeedsBuild,
  earningsCloseAvailable,
  earningsRowKey,
  earningsRowLifecycle,
  earningsScheduleConfirmationRequiredError,
  earningsScheduleReviewRows,
  EARNINGS_USER_ACTION_REQUIRED_EXIT_CODE,
  emptyEarningsApiUsage,
  hasEarningsApiBudget,
  isEarningsApiUsage,
  metricResult,
  normalizeFinnhubCalendarFields,
  normalizeEarningsTiming,
  numberOrNull,
  pctChange,
  recordEarningsApiRequest,
  valueOutcome
} = require('./earnings_week_contract');
const { displayDatesForRange, isIsoDate } = require('./calendar_contract');
const {
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  buildEarningsApiRows,
  buildSecondaryRecoveryCandidates,
  buildRows,
  calendarVerificationDates,
  ensureFinnhubPrimaryUsable,
  fetchEarningsApiCalendar,
  profileFromCache,
  readScheduleConfirmations,
  resolveProviderDateConflicts,
  verifyEarningsApiRecoveryRows,
  verifyFinnhubScheduleRows
} = require('./earnings_week_build');
const {
  applyCompanyReleaseResolutions,
  applyEarningsNarrative,
  earningsCalendarNeedsBuild,
  refreshEarningsResults,
  refreshTargetRows,
  removeStaleCompanyReleaseResolutionSidecar,
  reportWindowArrived,
  validateEarningsWeekPayload
} = require('./earnings_week');
const { validateEarningsWeekReleasePayload } = require('./earnings_week_validation');
const root = path.resolve(__dirname, '..');

function extractDashboardRuntimeTestBlock(html, name) {
  const runtimeMatches = [...html.matchAll(/<script id="dashboard-runtime">([\s\S]*?)<\/script>/g)];
  assert.equal(runtimeMatches.length, 1, `Expected one dashboard-runtime script; found ${runtimeMatches.length}`);
  const source = runtimeMatches[0][1];
  const startMarker = `/* TEST BLOCK START: ${name} */`;
  const endMarker = `/* TEST BLOCK END: ${name} */`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.equal(source.split(startMarker).length - 1, 1, `Expected one test block start ${name}`);
  assert.equal(source.split(endMarker).length - 1, 1, `Expected one test block end ${name}`);
  assert.ok(start < end, `Test block markers are out of order for ${name}`);
  return source.slice(start + startMarker.length, end);
}

function profile(symbol, marketCap = 5000000000) {
  return {
    symbol,
    ok: true,
    status: 200,
    responseMs: 1,
    name: `${symbol} Corp`,
    ticker: symbol,
    exchange: 'NASDAQ NMS - GLOBAL MARKET',
    country: 'US',
    currency: 'USD',
    marketCap,
    marketCapMillions: marketCap / 1000000,
    shareOutstanding: 100,
    industry: 'Technology',
    error: ''
  };
}

function finnhubRow(symbol, overrides = {}) {
  return {
    symbol,
    reportDate: '2026-01-06',
    reportTiming: 'amc',
    fiscalQuarter: 4,
    fiscalYear: 2025,
    eps: {
      estimate: 1,
      actual: 1.25
    },
    revenue: {
      estimate: 1000000000,
      actual: 1100000000
    },
    ...overrides
  };
}

function earningsApiRow(symbol, overrides = {}) {
  return {
    symbol,
    company: `${symbol} Corp`,
    reportDate: '2026-01-06',
    reportTiming: 'amc',
    eps: {
      estimate: 1,
      actual: 1.1
    },
    revenue: {
      estimate: 1000000000,
      actual: 1200000000
    },
    source: {
      provider: 'earningsapi',
      bucket: 'after',
      row: {}
    },
    ...overrides
  };
}

function nasdaqRow(symbol, overrides = {}) {
  return {
    symbol,
    company: `${symbol} Corp`,
    reportDate: '2026-01-06',
    reportTiming: 'unknown',
    eps: {
      estimate: 1,
      actual: null
    },
    revenue: {
      estimate: null,
      actual: null
    },
    source: {
      provider: 'nasdaq',
      row: {}
    },
    ...overrides
  };
}

function assertThrowsLike(fn, pattern, label) {
  assert.throws(fn, pattern, label);
}

function testSharedOutcomeContract() {
  assert.equal(pctChange(80, 100), 25);
  assert.equal(pctChange(0, 100), null);
  assert.equal(valueOutcome(2.1, 2), 'beat');
  assert.equal(valueOutcome(1.9, 2), 'miss');
  assert.equal(valueOutcome(2, 2), 'met');
  assert.equal(valueOutcome(null, 2), 'unknown');
  assert.equal(metricResult(null, 2), 'pending');
  assert.equal(metricResult(2, null), 'not_compared');
  assert.equal(metricResult(2.1, 2), 'beat');
  assert.equal(combinedOutcome('beat', 'beat'), 'beat');
  assert.equal(combinedOutcome('miss', 'miss'), 'miss');
  assert.equal(combinedOutcome('beat', 'miss'), 'mixed');
  assert.equal(combinedOutcome('beat', 'not_compared'), 'eps_only_beat');
  assert.equal(combinedOutcome('pending', 'pending'), 'pending');

  const pendingRow = finnhubRow('LIFE', {
    eps: { estimate: 1, actual: null },
    revenue: { estimate: 1000000000, actual: null },
    reaction: { status: 'pending' }
  });
  assert.equal(earningsRowLifecycle(pendingRow, '2026-01-06T20:59:00.000Z'), 'scheduled');
  assert.equal(earningsRowLifecycle(pendingRow, '2026-01-06T21:00:00.000Z'), 'awaiting_actual');
  assert.equal(earningsRowLifecycle({ ...finnhubRow('LIFE'), reaction: { status: 'awaiting_close' } }, '2026-01-06T21:00:00.000Z'), 'released_awaiting_close');
  assert.equal(earningsRowLifecycle({ ...finnhubRow('LIFE'), reaction: { status: 'computed' } }, '2026-01-07T22:00:00.000Z'), 'close_available');
  assert.equal(earningsCloseAvailable({ date: '2026-01-06' }, '2026-01-06T20:59:00.000Z'), false);
  assert.equal(earningsCloseAvailable({ date: '2026-01-06' }, '2026-01-06T21:00:00.000Z'), true);
  const prematureComputed = applyEarningsLifecycle({
    ...finnhubRow('LIFE'),
    reaction: {
      basis: 'same_day_close',
      percent: 1,
      fromDate: '2026-01-05',
      fromClose: 100,
      toDate: '2026-01-06',
      toClose: 101,
      status: 'computed',
      note: '',
      source: 'Yahoo Finance Chart API'
    }
  }, '2026-01-06T20:59:00.000Z');
  assert.equal(prematureComputed.reaction.status, 'awaiting_close');
  assert.equal(prematureComputed.lifecycle, 'released_awaiting_close');

  const prematurePayload = deterministicVerifiedWeekFixture();
  prematurePayload.generatedAt = '2026-01-06T20:59:00.000Z';
  expectWeekValidationFailure(prematurePayload, /cannot be computed before the required closing response/, 'Computed reactions must not precede the required market close.');

  const invalidWindowPayload = deterministicVerifiedWeekFixture();
  invalidWindowPayload.rows[0].reaction.fromDate = '2026-01-05';
  expectWeekValidationFailure(invalidWindowPayload, /fromDate must be on or after reportDate for amc reports/, 'Computed reactions must use the timing-specific trading window.');
}

function testSharedProviderContract() {
  assert.deepEqual(normalizeFinnhubCalendarFields({
    symbol: ' acme ',
    date: '2026-07-10',
    hour: ' AMC ',
    quarter: '2',
    year: '2026',
    epsEstimate: '1.25',
    epsActual: '1.5',
    revenueEstimate: '1000',
    revenueActual: ''
  }), {
    symbol: 'ACME',
    reportDate: '2026-07-10',
    reportTiming: 'amc',
    fiscalQuarter: 2,
    fiscalYear: 2026,
    eps: { estimate: 1.25, actual: 1.5 },
    revenue: { estimate: 1000, actual: null }
  });

  const usage = emptyEarningsApiUsage();
  assert.equal(isEarningsApiUsage(usage), true);
  assert.equal(isEarningsApiUsage({ schemaVersion: 2, months: {} }), false);
  assert.equal(earningsApiUsageMonth(new Date('2026-08-01T00:00:00.000Z')), '2026-08');
  const julyEntry = earningsApiMonthEntry(usage, new Date('2026-07-31T23:59:59.000Z'));
  assert.deepEqual(julyEntry, { calls: 0, requests: [] });
  usage.months['2026-08'] = { calls: 'invalid', requests: null };
  assert.deepEqual(earningsApiMonthEntry(usage, new Date('2026-08-01T00:00:00.000Z')), { calls: 0, requests: [] });

  recordEarningsApiRequest(usage, {
    at: new Date('2026-08-01T00:00:00.000Z'),
    type: 'company-earnings',
    path: '/v1/earnings',
    queryKeys: ['symbol', 'apikey', 'date']
  });
  assert.deepEqual(usage.months['2026-08'].requests[0], {
    at: '2026-08-01T00:00:00.000Z',
    type: 'company-earnings',
    path: '/v1/earnings',
    query: 'date,symbol'
  });
  assert.equal(usage.months['2026-08'].calls, 1);
  assert.equal(hasEarningsApiBudget(usage, 3, 1, new Date('2026-08-01T00:00:00.000Z')), true);
  usage.months['2026-08'].calls = 2;
  assert.equal(hasEarningsApiBudget(usage, 3, 1, new Date('2026-08-01T00:00:00.000Z')), false);

  const capped = emptyEarningsApiUsage();
  for (let index = 0; index < 201; index += 1) {
    recordEarningsApiRequest(capped, {
      at: new Date('2026-08-01T00:00:00.000Z'),
      type: `request-${index}`,
      path: '/v1/earnings',
      queryKeys: []
    });
  }
  assert.equal(capped.months['2026-08'].calls, 201);
  assert.equal(capped.months['2026-08'].requests.length, 200);
  assert.equal(capped.months['2026-08'].requests[0].type, 'request-1');
}

function validateWeekPayload(payload) {
  const errors = validateEarningsWeekPayload(payload, { requireNarrative: true });
  if (errors.length) throw new Error(errors.join(' '));
}

function writeTempJson(prefix, payload) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

function validateCompanyReleasePayload(week, sidecar) {
  const sourceArtifact = 'generated/earnings_week.json';
  const errors = validateEarningsWeekReleasePayload({
    ...sidecar,
    sourceArtifact
  }, week, { sourceArtifact });
  if (errors.length) throw new Error(errors.join(' '));
}

function embeddedWeekFixture() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Dashboard fixture must include embedded dashboard-data JSON.');
  const dashboard = JSON.parse(match[1]);
  assert.ok(dashboard.earnings?.week, 'Dashboard fixture must include embedded earnings.week payload.');
  return dashboard.earnings.week;
}

function deterministicVerifiedWeekFixture() {
  // Keep one fully synthetic validator fixture available so this contract test
  // does not depend on whatever live/generated week artifact happens to exist.
  const stagedRows = buildRows([finnhubRow('VERIFY')], [profile('VERIFY')]);
  stagedRows[0].sourceAudit.scheduleVerification = {
    status: 'corroborated',
    primaryDate: stagedRows[0].reportDate,
    secondaryDates: [stagedRows[0].reportDate],
    official: null
  };
  const rows = attachReactions(
    stagedRows,
    [{
      symbol: 'VERIFY',
      ok: true,
      status: 200,
      responseMs: 1,
      error: '',
      bars: [{
        date: '2026-01-06',
        close: 100
      }, {
        date: '2026-01-07',
        close: 105
      }]
    }],
    { asOf: '2026-01-07T22:00:00.000Z' }
  );
  rows[0].outcome.interpretation = 'Margin expansion and pricing discipline supported the earnings read.';
  rows[0].outcome.guide = 'FY26 reaffirmed.';
  rows[0].reaction.note = 'Margin expansion and updated guidance supported the post-report read.';

  return {
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: '2026-01-07T22:00:00.000Z',
    range: {
      from: '2026-01-05',
      to: '2026-01-09'
    },
    policy: buildEarningsWeekPolicy(),
    rows,
    secondaryRecoveryCandidates: [],
    companyReleaseTasks: [],
    summary: {
      counts: computeEarningsWeekCounts(rows)
    },
    narrativeApply: {
      generatedAt: '2026-01-07T22:05:00.000Z',
      narrativeArtifact: 'generated/earnings_narrative.json',
      applied: [{
        symbol: 'VERIFY',
        reportDate: '2026-01-06'
      }]
    }
  };
}

function expectWeekValidationFailure(payload, pattern, label) {
  assert.throws(
    () => validateWeekPayload(payload),
    pattern,
    label
  );
}

function testFailClosed() {
  assertThrowsLike(
    () => ensureFinnhubPrimaryUsable({ ok: false, rows: [], error: 'HTTP 500' }),
    /Finnhub primary calendar failed/,
    'Finnhub transport failure must fail closed.'
  );
  assertThrowsLike(
    () => ensureFinnhubPrimaryUsable({ ok: true, rows: [] }),
    /zero usable rows/,
    'Suspiciously empty Finnhub slate must fail closed.'
  );
  assertThrowsLike(
    () => ensureFinnhubPrimaryUsable({
      ok: true,
      rows: [finnhubRow('ONE'), finnhubRow('TWO')]
    }, {
      from: '2026-01-05',
      to: '2026-01-09'
    }),
    /below the minimum 10/,
    'Suspiciously sparse full-week Finnhub slate must fail closed.'
  );
  assert.doesNotThrow(
    () => ensureFinnhubPrimaryUsable({
      ok: true,
      rows: [finnhubRow('ONE'), finnhubRow('TWO')]
    }, {
      from: '2026-01-05',
      to: '2026-01-09',
      minFinnhubRows: 1
    }),
    'Explicit low threshold should allow unusual holiday or ad hoc runs.'
  );
  assert.doesNotThrow(
    () => ensureFinnhubPrimaryUsable({
      ok: true,
      rows: [finnhubRow('ONE'), finnhubRow('TWO')]
    }, {
      from: '2026-01-06',
      to: '2026-01-06'
    }),
    'Two Finnhub rows should satisfy the scaled one-weekday default.'
  );
}

function testCalendarRolloverDisplayDates() {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false, 'Impossible calendar dates must not roll into a different week.');
  assert.equal(normalizeEarningsTiming(' AMC '), 'amc');
  assert.equal(normalizeEarningsTiming('unknown-provider-code'), 'unknown');
  assert.equal(numberOrNull('12.5'), 12.5);
  assert.equal(numberOrNull(''), null);
  assert.equal(earningsRowKey({ reportDate: '2026-07-10', symbol: 'ACME' }), '2026-07-10:ACME');
  assert.deepEqual(displayDatesForRange('2026-07-13', '2026-07-17'), [
    '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'
  ]);
  assert.deepEqual(displayDatesForRange('2026-07-10', '2026-07-16'), [
    '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'
  ]);
  assert.deepEqual(displayDatesForRange('2026-07-11', '2026-07-17'), []);
  const fridayBridge = { from: '2026-07-10', to: '2026-07-16' };
  assert.equal(earningsCalendarRangeNeedsBuild(null, fridayBridge), false);
  assert.equal(earningsCalendarRangeNeedsBuild(fridayBridge, null), true);
  assert.equal(earningsCalendarRangeNeedsBuild(fridayBridge, fridayBridge), false);
  assert.deepEqual(earningsScheduleReviewRows({ range: fridayBridge, rows: [{ symbol: 'ACME' }] }, { range: fridayBridge }), [{ symbol: 'ACME' }]);
  assert.deepEqual(earningsScheduleReviewRows({ range: fridayBridge, rows: [{ symbol: 'ACME' }] }, { range: { from: '2026-07-13', to: '2026-07-17' } }), []);
  const scheduleError = earningsScheduleConfirmationRequiredError([{ symbol: 'ACME', primaryDate: '2026-07-10' }]);
  assert.equal(scheduleError.exitCode, EARNINGS_USER_ACTION_REQUIRED_EXIT_CODE);
  assert.match(scheduleError.message, /ACME \(2026-07-10\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-earnings-rollover-'));
  const earningsPath = path.join(dir, 'earnings_week.json');
  try {
    assert.equal(earningsCalendarNeedsBuild(fridayBridge, earningsPath), true);
    fs.writeFileSync(earningsPath, JSON.stringify({ range: fridayBridge }));
    assert.equal(earningsCalendarNeedsBuild(fridayBridge, earningsPath), false);
    assert.equal(earningsCalendarNeedsBuild({ from: '2026-07-13', to: '2026-07-17' }, earningsPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testFinnhubProfileCacheFallbackPreservesIdentity() {
  const cached = profileFromCache('CACHEME', {
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    updatedAt: '2026-01-05T12:00:00.000Z',
    profiles: {
      CACHEME: {
        name: 'CacheMe Corp',
        ticker: 'CACHEME',
        exchange: 'NASDAQ NMS - GLOBAL MARKET',
        country: 'US',
        currency: 'USD',
        marketCapMillions: 2500,
        shareOutstanding: 100,
        industry: 'Technology',
        fetchedAt: '2026-01-05T12:00:00.000Z'
      }
    }
  }, {
    attempts: 4,
    rateLimited: true,
    error: 'HTTP 429'
  });

  assert.equal(cached.ok, true);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.staleProfileFallback, true);
  assert.equal(cached.rateLimited, true);
  assert.equal(cached.attempts, 4);
  assert.equal(cached.name, 'CacheMe Corp');
  assert.equal(cached.marketCap, 2500000000);
}

function testFinnhubCoveredRowsDoNotSpendSecondaryRecovery() {
  const primary = finnhubRow('PRIMARY', {
    eps: {
      estimate: 1,
      actual: 2.25
    },
    revenue: {
      estimate: 1000000000,
      actual: 2250000000
    }
  });
  const secondaryDuplicate = earningsApiRow('PRIMARY', {
    eps: {
      estimate: 1,
      actual: 0.75
    },
    revenue: {
      estimate: 1000000000,
      actual: 750000000
    }
  });
  const profiles = [profile('PRIMARY')];
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates([primary], [{ date: primary.reportDate, rows: [secondaryDuplicate] }], profiles);
  const rows = buildRows([primary], profiles);

  assert.equal(secondaryRecoveryCandidates.length, 0, 'Metered secondary recovery must not be queued for a row already covered by Finnhub.');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceAudit.selectedSources.slate, 'finnhub');
  assert.deepEqual(rows[0].sourceAudit.finnhubCalendar.eps, {
    estimate: 1,
    actual: 2.25
  });
  assert.deepEqual(rows[0].sourceAudit.finnhubCalendar.revenue, {
    estimate: 1000000000,
    actual: 2250000000
  });
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0].sourceAudit.finnhubCalendar, 'epsActual'), false);
  assert.equal(rows[0].eps.actual, 2.25, 'Finnhub EPS actual remains canonical for Finnhub-covered rows.');
  assert.equal(rows[0].revenue.actual, 2250000000, 'Finnhub revenue actual remains canonical for Finnhub-covered rows.');
}

function testProviderDateConflictResolution() {
  const cases = [
    {
      description: 'Nasdaq confirmation selects the EarningsAPI date without inheriting its timing.',
      symbol: 'DATEWIN',
      primary: { reportTiming: 'amc', fiscalQuarter: 4, fiscalYear: 2025 },
      secondary: { reportTiming: 'bmo' },
      nasdaqDate: '2026-01-07',
      verify: ({ resolution, candidates, rows }) => {
        assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-07');
        assert.equal(resolution.finnhubRows[0].reportTiming, 'unknown');
        assert.equal(candidates.length, 0);
        assert.equal(rows[0].sourceAudit.providerDateConflict.selectedProvider, 'earningsApiCalendar');
        assert.equal(rows[0].sourceAudit.providerDateConflict.selectedDateSource, 'nasdaq');
        assert.equal(rows[0].sourceAudit.providerDateConflict.candidates.finnhub[0].reportDate, '2026-01-06');
      }
    },
    {
      description: 'Conflict recovery can supply display identity when the profile is unavailable.',
      symbol: 'DISPLAY',
      primary: { reportTiming: 'unknown' },
      secondary: { company: 'Display Therapeutics, Inc.', reportTiming: 'bmo' },
      nasdaqDate: '2026-01-07',
      nasdaq: { company: 'Display Therapeutics, Inc.', marketCap: 2500000000, marketCapDisplay: '$2,500,000,000' },
      profile: { ok: false, status: 429, name: '', ticker: '', exchange: '', country: '', currency: '', marketCap: null, marketCapMillions: null, shareOutstanding: null, industry: '', error: 'HTTP 429' },
      verify: ({ rows }) => {
        assert.equal(rows[0].company, 'Display Therapeutics, Inc.');
        assert.equal(rows[0].marketCap, 2500000000);
        assert.equal(rows[0].sourceAudit.selectedSources.company, 'providerDateConflict');
        assert.equal(rows[0].sourceAudit.selectedSources.marketCap, 'providerDateConflict');
      }
    },
    {
      description: 'Nasdaq confirmation keeps the Finnhub date and suppresses recovery.',
      symbol: 'DATEKEEP',
      primary: { reportTiming: 'amc' },
      secondary: { reportTiming: 'bmo' },
      nasdaqDate: '2026-01-06',
      nasdaq: { reportTiming: 'amc' },
      verify: ({ resolution, candidates }) => {
        assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-06');
        assert.equal(resolution.finnhubRows[0].providerDateConflict.selectedProvider, 'finnhub');
        assert.equal(resolution.finnhubRows[0].providerDateConflict.reason, 'nasdaq_matched_finnhub_date');
        assert.equal(candidates.length, 0);
      }
    },
    {
      description: 'An unresolved three-date conflict falls back to Finnhub without a duplicate recovery row.',
      symbol: 'DATEFALLBACK',
      nasdaqDate: '2026-01-08',
      verify: ({ resolution, candidates }) => {
        assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-06');
        assert.equal(resolution.finnhubRows[0].providerDateConflict.status, 'fallback');
        assert.equal(resolution.finnhubRows[0].providerDateConflict.selectedDateSource, 'finnhub_fallback');
        assert.equal(candidates.length, 0);
      }
    }
  ];

  for (const scenario of cases) {
    const primary = finnhubRow(scenario.symbol, { reportDate: '2026-01-06', ...scenario.primary });
    const secondary = earningsApiRow(scenario.symbol, { reportDate: '2026-01-07', ...scenario.secondary });
    const selectedProfile = { ...profile(scenario.symbol), ...scenario.profile };
    const resolution = resolveProviderDateConflicts(
      [primary],
      [{ date: secondary.reportDate, rows: [secondary] }],
      [{ date: scenario.nasdaqDate, rows: [nasdaqRow(scenario.symbol, { reportDate: scenario.nasdaqDate, ...scenario.nasdaq })] }]
    );
    const candidates = buildSecondaryRecoveryCandidates(resolution.finnhubRows, resolution.earningsApiCalendarDays, [selectedProfile]);
    const rows = buildRows(resolution.finnhubRows, [selectedProfile], { earningsApiCalendarDays: resolution.earningsApiCalendarDays });
    try {
      scenario.verify({ resolution, candidates, rows });
    } catch (error) {
      error.message = `${scenario.description} ${error.message}`;
      throw error;
    }
  }
}

function testPrimaryScheduleVerification() {
  const range = { from: '2026-01-05', to: '2026-01-09' };
  const baseRows = (symbol) => buildRows([finnhubRow(symbol, { reportDate: '2026-01-06' })], [profile(symbol)]);
  const matching = verifyFinnhubScheduleRows(baseRows('MATCH'), [{
    date: '2026-01-06', rows: [earningsApiRow('MATCH', { reportDate: '2026-01-06' })]
  }], range);
  assert.equal(matching.rows.length, 1);
  assert.equal(matching.review.length, 0);
  assert.equal(matching.rows[0].sourceAudit.scheduleVerification.status, 'corroborated');

  const crossWeek = verifyFinnhubScheduleRows(baseRows('OUTSIDE'), [{
    date: '2026-01-30', rows: [earningsApiRow('OUTSIDE', { reportDate: '2026-01-30' })]
  }], range);
  assert.equal(crossWeek.rows.length, 0, 'A cross-week conflict must await an official confirmation.');
  assert.deepEqual(crossWeek.review.map((row) => row.reason), ['cross_week_calendar_date_conflict']);

  const crossWeekOfficial = verifyFinnhubScheduleRows(baseRows('OUTSIDE'), [], range, [{
    symbol: 'OUTSIDE',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-30',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(crossWeekOfficial.rows.length, 0, 'An official out-of-week date must exclude the row from the active slate.');
  assert.equal(crossWeekOfficial.review.length, 0);

  const uncorroborated = verifyFinnhubScheduleRows(baseRows('SINGLE'), [], range);
  assert.equal(uncorroborated.rows.length, 1);
  assert.equal(uncorroborated.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.equal(uncorroborated.rows[0].sourceStatus, 'partial');
  assert.deepEqual(uncorroborated.review, []);

  const completeSecondaryMiss = verifyFinnhubScheduleRows(baseRows('SINGLE'), displayDatesForRange(range.from, range.to).map((date) => ({
    date,
    ok: true,
    rows: []
  })), range);
  assert.equal(completeSecondaryMiss.rows.length, 0);
  assert.deepEqual(completeSecondaryMiss.review.map((row) => row.reason), ['uncorroborated_primary_calendar_date']);

  const official = verifyFinnhubScheduleRows(baseRows('OFFICIAL'), [], range, [{
    symbol: 'OFFICIAL',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-08',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(official.rows[0].reportDate, '2026-01-08');
  assert.equal(official.rows[0].sourceAudit.scheduleVerification.status, 'official_confirmed');
  assert.equal(official.review.length, 0);

  const staleOutageConfirmation = verifyFinnhubScheduleRows(baseRows('STALE'), [], range, [{
    symbol: 'STALE',
    primaryDate: '2025-10-06',
    reportDate: '2025-10-08',
    sourceName: 'Prior-quarter investor relations calendar',
    sourceUrl: 'https://investors.example.test/prior-quarter'
  }]);
  assert.equal(staleOutageConfirmation.rows[0].reportDate, '2026-01-06');
  assert.equal(staleOutageConfirmation.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');

  const matchingIgnoresIr = verifyFinnhubScheduleRows(baseRows('MATCHFIRST'), [{
    date: '2026-01-06', rows: [earningsApiRow('MATCHFIRST', { reportDate: '2026-01-06' })]
  }], range, [{
    symbol: 'MATCHFIRST',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-08',
    sourceName: 'Conflicting investor relations fixture',
    sourceUrl: 'https://investors.example.test/conflicting-fixture'
  }]);
  assert.equal(matchingIgnoresIr.rows[0].reportDate, '2026-01-06');
  assert.equal(matchingIgnoresIr.rows[0].sourceAudit.scheduleVerification.status, 'corroborated');

  const completeMissWithOfficial = verifyFinnhubScheduleRows(baseRows('MISSOFFICIAL'), displayDatesForRange(range.from, range.to).map((date) => ({
    date,
    ok: true,
    rows: []
  })), range, [{
    symbol: 'MISSOFFICIAL',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-08',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(completeMissWithOfficial.rows[0].reportDate, '2026-01-08');
  assert.equal(completeMissWithOfficial.rows[0].sourceAudit.scheduleVerification.status, 'official_confirmed');

  const confirmationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-schedule-confirmations-'));
  try {
    const confirmationsFile = path.join(confirmationsDir, 'confirmations.json');
    fs.writeFileSync(confirmationsFile, `${JSON.stringify({
      schemaVersion: 2,
      rows: [{
        symbol: 'OFFICIAL',
        primaryDate: '2026-01-06',
        reportDate: '2026-01-08',
        sourceName: 'Official investor relations calendar',
        sourceUrl: 'https://investors.example.test/earnings'
      }]
    })}\n`);
    assert.deepEqual(readScheduleConfirmations(confirmationsFile)[0], {
      symbol: 'OFFICIAL',
      primaryDate: '2026-01-06',
      reportDate: '2026-01-08',
      sourceName: 'Official investor relations calendar',
      sourceUrl: 'https://investors.example.test/earnings'
    });
    fs.writeFileSync(confirmationsFile, `${JSON.stringify({ schemaVersion: 1, rows: [] })}\n`);
    assert.throws(() => readScheduleConfirmations(confirmationsFile), /schemaVersion 2 and event-scoped rows/);
  } finally {
    fs.rmSync(confirmationsDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    calendarVerificationDates({ from: range.from, to: range.to }),
    displayDatesForRange(range.from, range.to),
    'Live secondary verification must query only the five displayed trading dates.'
  );

  const recoveryRow = {
    symbol: 'RECOVERY',
    company: 'Recovery Corp',
    country: 'US',
    exchange: 'NASDAQ NMS - GLOBAL MARKET',
    marketCap: 2000000000,
    reportDate: '2026-01-06',
    sourceAudit: { selectedSources: { slate: 'earningsApiCalendar' } }
  };
  const recovery = verifyEarningsApiRecoveryRows([recoveryRow], range);
  assert.equal(recovery.rows.length, 0);
  assert.deepEqual(recovery.review.map((row) => row.reason), ['uncorroborated_earningsapi_recovery_date']);
  const staleRecoveryConfirmation = verifyEarningsApiRecoveryRows([recoveryRow], range, [{
    symbol: 'RECOVERY',
    primaryDate: '2025-10-06',
    reportDate: '2025-10-08',
    sourceName: 'Prior-quarter investor relations calendar',
    sourceUrl: 'https://investors.example.test/prior-quarter'
  }]);
  assert.equal(staleRecoveryConfirmation.rows.length, 0);
  assert.deepEqual(staleRecoveryConfirmation.review.map((row) => row.reason), ['uncorroborated_earningsapi_recovery_date']);
  const officialRecovery = verifyEarningsApiRecoveryRows([recoveryRow], range, [{
    symbol: 'RECOVERY',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-08',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(officialRecovery.rows[0].reportDate, '2026-01-08');
  assert.equal(officialRecovery.rows[0].sourceAudit.scheduleVerification.status, 'official_confirmed');
}

async function testEarningsApiCalendarStopsAfterQuotaResponse() {
  const requested = [];
  const dates = displayDatesForRange('2026-01-05', '2026-01-09');
  const days = await fetchEarningsApiCalendar({}, 'fixture-token', emptyEarningsApiUsage(), dates, async (date) => {
    requested.push(date);
    return { date, ok: false, skipped: false, status: 429, rowCount: 0, rows: [], error: 'HTTP 429' };
  });
  assert.deepEqual(requested, [dates[0]]);
  assert.equal(days.length, 1);
}

function testWeekValidatorAllowsOfficialScheduleRedate() {
  const source = deterministicVerifiedWeekFixture();
  const row = source.rows[0];
  const originalDate = row.reportDate;
  row.reportDate = '2026-01-07';
  row.reaction.fromDate = '2026-01-07';
  row.reaction.toDate = '2026-01-08';
  source.generatedAt = '2026-01-08T22:00:00.000Z';
  source.narrativeApply.generatedAt = '2026-01-08T22:05:00.000Z';
  source.narrativeApply.applied = source.narrativeApply.applied.map((item) => item.symbol === row.symbol
    ? { ...item, reportDate: row.reportDate }
    : item);
  row.sourceAudit.scheduleVerification = {
    status: 'official_confirmed',
    primaryDate: originalDate,
    secondaryDates: [row.reportDate],
    official: {
      symbol: row.symbol,
      primaryDate: originalDate,
      reportDate: row.reportDate,
      sourceName: 'Official investor relations calendar',
      sourceUrl: 'https://investors.example.test/earnings'
    }
  };
  validateWeekPayload(source);
  const unscoped = structuredClone(source);
  delete unscoped.rows[0].sourceAudit.scheduleVerification.official.primaryDate;
  expectWeekValidationFailure(
    unscoped,
    /official must identify the current symbol and primary date/,
    'Published official confirmation provenance must remain bound to the provider event it verified.'
  );
  const unnamed = structuredClone(source);
  unnamed.rows[0].sourceAudit.scheduleVerification.official.sourceName = '';
  expectWeekValidationFailure(
    unnamed,
    /official must identify the current symbol and primary date/,
    'Official confirmation provenance must name the source shown in the dashboard tooltip.'
  );
}

function testFinnhubRowsCanRecoverProfileOnly() {
  const primary = finnhubRow('PROFILEMISS');
  const emptyProfile = {
    ...profile('PROFILEMISS'),
    ok: false,
    name: '',
    ticker: '',
    exchange: '',
    country: '',
    currency: '',
    marketCap: null,
    marketCapMillions: null,
    shareOutstanding: null,
    industry: '',
    error: ''
  };
  const rows = buildRows([primary], [emptyProfile], {
    finnhubMetrics: [{
      symbol: 'PROFILEMISS',
      ok: true,
      status: 200,
      responseMs: 1,
      marketCap: 2500000000,
      marketCapMillions: 2500,
      error: ''
    }],
    earningsApiCalendarDays: [{
      date: primary.reportDate,
      rows: [earningsApiRow('PROFILEMISS', {
        company: 'Recovered Profile Corp',
        eps: {
          estimate: 0.5,
          actual: 0.4
        },
        revenue: {
          estimate: 500000000,
          actual: 450000000
        }
      })]
    }]
  });
  const row = rows[0];

  assert.equal(row.company, 'Recovered Profile Corp');
  assert.equal(row.country, '');
  assert.equal(row.exchange, '');
  assert.equal(row.marketCap, 2500000000);
  assert.equal(row.sourceAudit.selectedSources.slate, 'finnhub');
  assert.equal(row.sourceAudit.selectedSources.company, 'earningsApiCalendar');
  assert.equal(row.sourceAudit.selectedSources.marketCap, 'finnhubMetric');
  assert.equal(row.sourceAudit.selectedSources.eps.actual, 'finnhub');
  assert.equal(row.sourceAudit.selectedSources.revenue.actual, 'finnhub');
  assert.deepEqual(row.sourceSummary, {
    primary: 'finnhub',
    fallbacks: ['earningsApiCalendar', 'finnhubMetric'],
    reaction: 'none'
  });
  assert.equal(row.eps.actual, primary.eps.actual, 'Profile recovery must not override Finnhub EPS actual.');
  assert.equal(row.revenue.actual, primary.revenue.actual, 'Profile recovery must not override Finnhub revenue actual.');
  assert.deepEqual(row.sourceAudit.earningsApiCalendar.eps, {
    estimate: 0.5,
    actual: 0.4
  });
  assert.equal(row.sourceAudit.finnhubMetric.marketCap, 2500000000);
}

function testWeekValidatorAcceptsProfileRecoveryContract() {
  const source = embeddedWeekFixture();
  const row = source.rows.find((item) => item.sourceAudit?.selectedSources?.slate === 'finnhub' && item.sourceAudit?.finnhubProfile?.name);
  assert.ok(row, 'Embedded dashboard fixture must include a Finnhub row for profile-recovery validation.');
  const originalMarketCap = row.marketCap;

  row.company = `${row.symbol} Profile Recovery Corp`;
  row.exchange = '';
  row.country = '';
  row.currency = '';
  row.marketCap = originalMarketCap;
  row.marketCapDisplay = `$${Math.round(originalMarketCap).toLocaleString('en-US')}`;
  row.sourceSummary.fallbacks = ['earningsApiCalendar', 'finnhubMetric'];
  row.sourceAudit.finnhubProfile = {
    ...row.sourceAudit.finnhubProfile,
    ok: false,
    name: '',
    ticker: '',
    exchange: '',
    country: '',
    currency: '',
    marketCap: null,
    marketCapMillions: null,
    shareOutstanding: null,
    industry: '',
    error: ''
  };
  row.sourceAudit.finnhubMetric = {
    status: 200,
    ok: true,
    marketCap: originalMarketCap,
    marketCapMillions: originalMarketCap / 1000000,
    error: ''
  };
  row.sourceAudit.earningsApiCalendar = {
    reportDate: row.reportDate,
    company: row.company,
    eps: {
      estimate: row.eps.estimate,
      actual: row.eps.actual
    },
    revenue: {
      estimate: row.revenue.estimate,
      actual: row.revenue.actual
    },
    reportTiming: row.reportTiming,
    bucket: row.reportTiming === 'amc' ? 'after' : 'pre'
  };
  row.sourceAudit.selectedSources.company = 'earningsApiCalendar';
  row.sourceAudit.selectedSources.marketCap = 'finnhubMetric';

  validateWeekPayload(source);
}

function testWeekValidatorAllowsEmptyEarningsWeek() {
  const source = embeddedWeekFixture();
  source.rows = [];
  source.secondaryRecoveryCandidates = [];
  source.companyReleaseTasks = [];
  delete source.companyReleaseApply;
  delete source.narrativeApply;
  source.summary.counts = {
    total: 0,
    verified: 0,
    partial: 0,
    reactionComputed: 0,
    missingTiming: 0,
    missingRevenue: 0,
    missingMarketCap: 0,
    secondaryRecoveryCandidates: 0,
    companyReleaseTasks: 0
  };

  validateWeekPayload(source);

  source.range = { from: '2026-07-10', to: '2026-07-16' };
  validateWeekPayload(source);
}

function testWeekValidatorRejectsMissingRowsArray() {
  const source = embeddedWeekFixture();
  delete source.rows;

  expectWeekValidationFailure(
    source,
    /rows must be an array/,
    'rows must remain an explicit array even when the earnings week is empty.'
  );
}

function testSecondaryRecoveryAndRevenueComparison() {
  const anchor = finnhubRow('ANCHOR');
  const recoveredFullCalendar = earningsApiRow('RECOVERFULL');
  const recoveredEpsOnlyCalendar = earningsApiRow('RECOVEREPS', {
    revenue: {
      estimate: null,
      actual: 500000000
    }
  });
  const profiles = [profile('ANCHOR'), profile('RECOVERFULL'), profile('RECOVEREPS')];
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates(
    [anchor],
    [{ date: anchor.reportDate, rows: [recoveredFullCalendar, recoveredEpsOnlyCalendar] }],
    profiles
  );
  const companyFetches = [
    {
      symbol: 'RECOVERFULL',
      ok: true,
      status: 200,
      rows: [earningsApiRow('RECOVERFULL')]
    },
    {
      symbol: 'RECOVEREPS',
      ok: true,
      status: 200,
      rows: [earningsApiRow('RECOVEREPS', {
        revenue: {
          estimate: null,
          actual: 500000000
        }
      })]
    }
  ];
  const recoveredRows = buildEarningsApiRows(secondaryRecoveryCandidates, companyFetches);
  const enrichedSecondaryCandidates = attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(secondaryRecoveryCandidates, companyFetches);
  const companyReleaseTasks = buildCompanyReleaseTasks(enrichedSecondaryCandidates, recoveredRows);
  const full = recoveredRows.find((row) => row.symbol === 'RECOVERFULL');
  const epsOnly = recoveredRows.find((row) => row.symbol === 'RECOVEREPS');

  assert.deepEqual(
    secondaryRecoveryCandidates.map((task) => task.symbol).sort(),
    ['RECOVEREPS', 'RECOVERFULL'],
    'Finnhub-missing display candidates should be selected for secondary recovery.'
  );
  assert.equal(full.sourceAudit.selectedSources.slate, 'earningsApiCalendar');
  assert.deepEqual(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').sourceAudit.earningsApiCalendar.eps, {
    estimate: 1,
    actual: 1.1
  });
  assert.equal(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').neededFields.includes('eps.estimate'), true);
  assert.equal(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').neededFields.includes('epsEstimate'), false);
  assert.deepEqual(enrichedSecondaryCandidates.find((task) => task.symbol === 'RECOVERFULL').sourceAudit.earningsApiCompany.selectedRow.eps, {
    estimate: 1,
    actual: 1.1
  });
  assert.deepEqual(full.sourceAudit.earningsApiCompany.selectedRow.revenue, {
    estimate: 1000000000,
    actual: 1200000000
  });
  assert.equal(full.sourceAudit.selectedSources.revenue.estimate, 'earningsApiCompany');
  assert.equal(full.sourceAudit.selectedSources.revenue.actual, 'earningsApiCompany');
  assert.equal(full.revenue.result, 'beat', 'Revenue comparison should be allowed when EarningsAPI supplies estimate and actual.');
  assert.equal(full.outcome.overall, 'beat', 'Full EPS/revenue recovery should not collapse to EPS-only.');

  assert.equal(epsOnly.sourceAudit.selectedSources.revenue.estimate, 'none');
  assert.equal(epsOnly.sourceAudit.selectedSources.revenue.actual, 'earningsApiCompany');
  assert.equal(epsOnly.eps.result, 'beat');
  assert.equal(epsOnly.revenue.result, 'not_compared');
  assert.equal(epsOnly.outcome.overall, 'eps_only_beat', 'EPS-only outcome should appear only when revenue estimate is unavailable.');
  assert.equal(companyReleaseTasks.length, 0, 'Complete recovered rows should not create company-release tasks.');
}

function testApplyCompanyReleaseResolution() {
  const secondaryRecoveryCandidatesBase = buildSecondaryRecoveryCandidates([], [{ date: '2026-01-06', rows: [earningsApiRow('RECOVERFULL')] }], [profile('RECOVERFULL')]);
  const secondaryRecoveryCandidates = attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(secondaryRecoveryCandidatesBase, [{
    symbol: 'RECOVERFULL',
    ok: true,
    status: 200,
    rows: [earningsApiRow('RECOVERFULL')]
  }]);
  const recoveredRows = buildEarningsApiRows(secondaryRecoveryCandidates, [{
    symbol: 'RECOVERFULL',
    ok: true,
    status: 200,
    rows: [earningsApiRow('RECOVERFULL')]
  }]);
  recoveredRows[0].eps.actual = null;
  recoveredRows[0].eps.result = 'pending';
  recoveredRows[0].eps.surprisePercent = null;
  recoveredRows[0].outcome.overall = 'pending';
  recoveredRows[0].outcome.guide = 'FY26 preview guide remains under review.';
  recoveredRows[0].outcome.interpretation = 'Pre-event margin expectations frame the setup.';
  recoveredRows[0].reaction = { note: 'The next-session response remains the confirmation test.' };
  recoveredRows[0].sourceStatus = 'partial';
  const companyReleaseTasks = buildCompanyReleaseTasks(secondaryRecoveryCandidates, recoveredRows);
  const task = companyReleaseTasks[0];
  const source = {
    rows: recoveredRows,
    secondaryRecoveryCandidates,
    companyReleaseTasks,
    summary: {
      counts: {}
    }
  };
  const output = applyCompanyReleaseResolutions(source, {
    outputPath: 'synthetic-company-release-resolutions.json',
    companyReleaseResolutions: [{
      taskId: task.id,
      symbol: task.symbol,
      company: task.company,
      reportDate: task.reportDate,
      status: 'resolved',
      confidence: 'high',
      fields: {
        company: task.company,
        fiscalPeriod: 'Fiscal Q4 2025',
        reportTiming: 'amc',
        eps: {
          estimate: 1,
          actual: 1.25,
          basis: 'adjusted_non_gaap',
          gaapActual: null,
          gaapBasis: '',
          adjustment: null,
          actualSource: 'sec_company_release',
          estimateSource: 'earningsapi_company',
          estimateCount: '',
          comparisonSource: 'earningsapi_company_eps_estimate'
        },
        revenue: {
          estimate: 1000000000,
          actual: 1200000000,
          estimateSource: 'earningsapi_company'
        }
      },
      reaction: {
        basis: 'next_session_close',
        percent: 10,
        fromDate: '2026-01-06',
        fromClose: 100,
        toDate: '2026-01-07',
        toClose: 110,
        status: 'computed',
        note: '',
        source: 'Yahoo Finance Chart API',
        sourceAudit: {
          status: 200,
          rowCount: 2,
          error: ''
        }
      },
      notes: []
    }]
  });
  const row = output.rows.find((item) => item.symbol === 'RECOVERFULL');

  assert.equal(row.eps.actual, 1.25, 'Company-release EPS actual should update the canonical row.');
  assert.equal(row.revenue.estimate, 1000000000, 'Deterministic revenue estimate should survive application.');
  assert.equal(row.revenue.actual, 1200000000);
  assert.equal(row.outcome.overall, 'beat');
  assert.equal(row.sourceStatus, 'partial', 'Company-release metrics cannot promote a row without schedule verification.');
  assert.equal(row.sourceSummary.primary, 'sec_company_release');
  assert.equal(row.sourceAudit.selectedSources.eps.actual, 'sec_company_release');
  assert.equal(row.sourceAudit.selectedSources.revenue.estimate, 'earningsApiCompany');
  assert.equal(row.sourceAudit.companyReleaseResolution.taskId, task.id);
  assert.equal(row.outcome.interpretation, '', 'A completed close response must invalidate preview commentary.');
  assert.equal(output.summary.counts.verified, 0);
  assert.equal(output.summary.counts.partial, 1);
  assert.equal(output.summary.counts.companyReleaseTasks, 1);
  assert.deepEqual(output.companyReleaseApply.applied, [{ taskId: task.id, symbol: task.symbol }]);
  assert.deepEqual(output.policy, buildEarningsWeekPolicy());

  const awaitingResolution = structuredClone(row.sourceAudit.companyReleaseResolution);
  awaitingResolution.reaction = {
    basis: 'next_session_close',
    percent: null,
    fromDate: '',
    fromClose: null,
    toDate: '',
    toClose: null,
    status: 'awaiting_close',
    note: '',
    source: 'Yahoo Finance Chart API'
  };
  const awaitingOutput = applyCompanyReleaseResolutions(source, {
    outputPath: 'synthetic-company-release-resolutions.json',
    companyReleaseResolutions: [awaitingResolution]
  });
  const awaitingRow = awaitingOutput.rows.find((item) => item.symbol === 'RECOVERFULL');
  assert.equal(awaitingRow.lifecycle, 'released_awaiting_close');
  assert.equal(awaitingRow.outcome.interpretation, 'Pre-event margin expectations frame the setup.');
  assert.equal(awaitingRow.reaction.note, 'The next-session response remains the confirmation test.');
}

function testApplyEarningsNarrative() {
  const rows = buildRows([finnhubRow('NARRATIVE')], [profile('NARRATIVE')]);
  const source = {
    generatedAt: '2026-01-06T22:00:00.000Z',
    range: {
      from: '2026-01-05',
      to: '2026-01-09'
    },
    rows
  };
  const output = applyEarningsNarrative({
    ...source
  }, {
    schemaVersion: 1,
    sourceArtifact: 'generated/earnings_week.json',
    sourceGeneratedAt: source.generatedAt,
    sourceRange: source.range,
    rows: [{
      symbol: 'NARRATIVE',
      reportDate: '2026-01-06',
      outcome: {
        guide: 'FY guide reiterated.',
        interpretation: 'Margin improvement carried the read.'
      },
      reaction: {
        note: 'Guidance drove the bid.'
      },
      revenue: {
        note: 'Revenue +5% YoY.'
      }
    }]
  }, {
    sourceArtifact: 'generated/earnings_week.json',
    narrativeArtifact: 'generated/earnings_narrative.json'
  });
  const row = output.rows[0];

  assert.equal(row.outcome.guide, 'FY guide reiterated.');
  assert.equal(row.outcome.interpretation, 'Margin improvement carried the read.');
  assert.equal(row.reaction.note, 'Guidance drove the bid.');
  assert.equal(row.revenue.note, 'Revenue +5% YoY.');
  assert.deepEqual(output.narrativeApply.applied, [{ symbol: 'NARRATIVE', reportDate: '2026-01-06' }]);
  assert.equal(output.narrativeApply.narrativeArtifact, 'generated/earnings_narrative.json');
  assert.deepEqual(output.policy, buildEarningsWeekPolicy());
  assert.throws(
    () => applyEarningsNarrative(source, {
      schemaVersion: 1,
      sourceArtifact: 'generated/earnings_week.json',
      sourceGeneratedAt: source.generatedAt,
      sourceRange: source.range,
      rows: []
    }, {
      sourceArtifact: 'generated/earnings_week.json'
    }),
    /rows must be a non-empty array/,
    'Empty narrative payload must not silently validate.'
  );
  assert.throws(
    () => applyEarningsNarrative(source, {
      schemaVersion: 1,
      sourceArtifact: 'generated/earnings_week.json',
      sourceGeneratedAt: '2026-01-05T22:00:00.000Z',
      sourceRange: source.range,
      rows: [{
        symbol: 'NARRATIVE',
        reportDate: '2026-01-06'
      }]
    }, {
      sourceArtifact: 'generated/earnings_week.json'
    }),
    /sourceGeneratedAt must match/,
    'Stale narrative payload must not apply.'
  );
}

function testEarningsNarrativeCompletenessIsDeferredToEditorialFinalization() {
  const source = deterministicVerifiedWeekFixture();
  const originalNarrative = {
    outcome: { ...source.rows[0].outcome },
    reaction: { ...source.rows[0].reaction }
  };
  source.rows[0].outcome.interpretation = '';
  source.rows[0].outcome.guide = '';
  source.rows[0].reaction.note = '';
  delete source.narrativeApply;

  assert.deepEqual(validateEarningsWeekPayload(source), [], 'Deterministic staging must accept pending Earnings narrative.');
  assert.match(
    validateEarningsWeekPayload(source, { requireNarrative: true }).join('\n'),
    /narrativeApply must be populated|outcome\.interpretation must be populated/,
    'Publication validation must reject pending Earnings narrative.'
  );

  const staged = buildEarningsNarrativeSidecar(source, { rows: [] }, {
    outputPath: 'generated/editorial/earnings_narrative.json'
  }).payload;
  staged.rows[0].outcome.interpretation = originalNarrative.outcome.interpretation;
  staged.rows[0].outcome.guide = originalNarrative.outcome.guide;
  staged.rows[0].reaction.note = originalNarrative.reaction.note;
  const finalized = applyEarningsNarrative(source, staged, {
    sourceArtifact: 'generated/earnings_week.json',
    narrativeArtifact: 'generated/editorial/earnings_narrative.json'
  });

  assert.deepEqual(validateEarningsWeekPayload(finalized, { requireNarrative: true }), []);
}

function testResultRefreshTimingThresholds() {
  assert.equal(
    reportWindowArrived(finnhubRow('AMC', { reportDate: '2026-07-13', reportTiming: 'amc' }), '2026-07-13T04:30:00.000Z'),
    false,
    'Midnight Eastern must remain before the same-day after-close threshold.'
  );
  assert.equal(
    reportWindowArrived(finnhubRow('BMO', { reportTiming: 'bmo' }), '2026-01-06T12:59:00.000Z'),
    false,
    'BMO rows should wait until the same-day Eastern pre-open threshold.'
  );
  assert.equal(
    reportWindowArrived(finnhubRow('BMO', { reportTiming: 'bmo' }), '2026-01-06T13:00:00.000Z'),
    true,
    'BMO rows should refresh once the same-day Eastern pre-open threshold arrives.'
  );
  assert.equal(
    reportWindowArrived(finnhubRow('AMC', { reportTiming: 'amc' }), '2026-01-06T20:59:00.000Z'),
    false,
    'AMC rows should not refresh before the same-day Eastern close threshold.'
  );
  assert.equal(
    reportWindowArrived(finnhubRow('AMC', { reportTiming: 'amc' }), '2026-01-06T21:00:00.000Z'),
    true,
    'AMC rows should refresh once the same-day Eastern close threshold arrives.'
  );
}

function testResultRefreshTargetsUnresolvedCompanyReleaseTasks() {
  const rows = buildRows([finnhubRow('TASKED', {
    reportDate: '2026-01-07',
    reportTiming: 'amc'
  })], [profile('TASKED')]);
  const task = {
    id: '2026-01-07:TASKED:company-release',
    symbol: 'TASKED',
    reportDate: '2026-01-07'
  };
  const source = {
    rows,
    companyReleaseTasks: [task]
  };

  assert.deepEqual(
    refreshTargetRows(source, '2026-01-06T12:00:00.000Z').map((row) => row.symbol),
    ['TASKED'],
    'Unresolved company-release tasks should force refresh targeting before the report window arrives.'
  );

  assert.deepEqual(
    refreshTargetRows({
      ...source,
      companyReleaseApply: {
        applied: [{ taskId: task.id, symbol: task.symbol }],
        skipped: []
      }
    }, '2026-01-06T12:00:00.000Z').map((row) => row.symbol),
    [],
    'Applied company-release tasks should not force refresh targeting forever.'
  );
}

async function testResultRefreshDoesNotRebuildSlate() {
  const rows = buildRows([finnhubRow('REFRESH', {
    reportTiming: 'bmo',
    eps: {
      estimate: 1,
      actual: null
    },
    revenue: {
      estimate: 1000000000,
      actual: null
    }
  })], [profile('REFRESH')]);
  const source = {
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: '2026-01-06T12:00:00.000Z',
    range: {
      from: '2026-01-05',
      to: '2026-01-09'
    },
    rows: [{
      ...rows[0],
      outcome: {
        ...rows[0].outcome,
        guide: 'Stale guide.',
        interpretation: 'Stale interpretation.'
      },
      reaction: {
        basis: 'unavailable',
        percent: null,
        fromDate: '',
        fromClose: null,
        toDate: '',
        toClose: null,
        status: 'pending',
        note: 'Stale reaction.',
        source: ''
      },
      sourceAudit: {
        ...rows[0].sourceAudit,
        scheduleVerification: {
          status: 'corroborated',
          primaryDate: rows[0].reportDate,
          secondaryDates: [rows[0].reportDate],
          official: null
        },
        yahoo: {}
      }
    }],
    secondaryRecoveryCandidates: [],
    companyReleaseTasks: [],
    summary: {
      counts: {
        total: 1,
        verified: 0,
        partial: 1,
        reactionComputed: 0,
        missingTiming: 0,
        missingRevenue: 0,
        missingMarketCap: 0,
        secondaryRecoveryCandidates: 0,
        companyReleaseTasks: 0
      }
    },
    narrativeApply: {
      generatedAt: '2026-01-06T12:30:00.000Z',
      narrativeArtifact: 'generated/earnings_narrative.json',
      applied: [{ symbol: 'REFRESH', reportDate: '2026-01-06' }]
    }
  };
  const refreshData = {
    finnhubRows: [finnhubRow('REFRESH', {
      reportTiming: 'bmo',
      eps: {
        estimate: 1,
        actual: 1.5
      },
      revenue: {
        estimate: 1000000000,
        actual: 1250000000
      }
    })],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'REFRESH',
      ok: true,
      status: 200,
      responseMs: 1,
      error: '',
      bars: [{
        date: '2026-01-05',
        close: 100
      }, {
        date: '2026-01-06',
        close: 110
      }]
    }]
  };
  const awaitingResult = await refreshEarningsResults(source, refreshData, {
    asOf: '2026-01-06T18:00:00.000Z',
    outputPath: 'generated/earnings_week.json'
  });
  const awaitingRow = awaitingResult.payload.rows[0];
  assert.equal(awaitingRow.reaction.status, 'awaiting_close');
  assert.equal(awaitingRow.lifecycle, 'released_awaiting_close');
  assert.equal(awaitingRow.outcome.interpretation, 'Stale interpretation.', 'Pre-event commentary must remain until the close response is available.');
  assert.equal(awaitingRow.reaction.note, 'Stale reaction.', 'Awaiting-close lifecycle must not erase the existing commentary.');

  const result = await refreshEarningsResults(awaitingResult.payload, refreshData, {
    asOf: '2026-01-06T22:00:00.000Z',
    outputPath: 'generated/earnings_week.json'
  });
  const row = result.payload.rows[0];

  assert.equal(result.refreshedRows, 1);
  assert.equal(row.sourceAudit.selectedSources.slate, 'finnhub');
  assert.equal(row.eps.actual, 1.5);
  assert.equal(row.revenue.actual, 1250000000);
  assert.equal(row.reaction.status, 'computed');
  assert.equal(row.lifecycle, 'close_available');
  assert.equal(row.sourceStatus, 'verified');
  assert.equal(row.outcome.interpretation, '', 'Deterministic refresh must invalidate stale narrative.');
  assert.equal(row.reaction.note, '', 'Deterministic refresh must invalidate stale reaction narrative.');
  assert.equal(Object.prototype.hasOwnProperty.call(result.payload, 'narrativeApply'), false);
  assert.deepEqual(result.payload.policy, buildEarningsWeekPolicy());
  assert.equal(result.payload.secondaryRecoveryCandidates.length, 0, 'Result refresh must not create a new secondary slate.');
}

async function testUnchangedResultRefreshPreservesNarrative() {
  const source = deterministicVerifiedWeekFixture();
  const result = await refreshEarningsResults(source, {
    finnhubRows: [finnhubRow('VERIFY')],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'VERIFY',
      ok: true,
      status: 200,
      responseMs: 1,
      error: '',
      bars: [{
        date: '2026-01-06',
        close: 100
      }, {
        date: '2026-01-07',
        close: 105
      }]
    }]
  }, {
    asOf: '2026-01-07T22:00:00.000Z',
    outputPath: 'generated/earnings_week.json'
  });

  assert.equal(result.changedRows, 0, 'Unchanged deterministic facts must not invalidate narrative.');
  assert.equal(result.payload.rows[0].outcome.interpretation, source.rows[0].outcome.interpretation);
  assert.equal(result.payload.rows[0].reaction.note, source.rows[0].reaction.note);
  assert.deepEqual(result.payload.narrativeApply, source.narrativeApply);
}

async function testResultRefreshUsesFinnhubActualsAfterResolvedDateConflict() {
  const [baseRow] = buildRows([finnhubRow('CONFLICT', {
    reportDate: '2026-01-06',
    eps: { estimate: 1, actual: null },
    revenue: { estimate: 1000000000, actual: null }
  })], [profile('CONFLICT')]);
  const row = {
    ...baseRow,
    reportDate: '2026-01-07',
    reportTiming: 'unknown',
    reaction: {
      basis: 'unavailable', percent: null, fromDate: '', fromClose: null,
      toDate: '', toClose: null, status: 'pending', note: '', source: ''
    },
    sourceAudit: {
      ...baseRow.sourceAudit,
      providerDateConflict: {
        symbol: 'CONFLICT',
        status: 'resolved',
        selectedDate: '2026-01-07',
        selectedProvider: 'earningsApiCalendar',
        selectedDateSource: 'nasdaq',
        reason: 'nasdaq_matched_earningsapi_date',
        candidates: {
          finnhub: [{
            reportDate: '2026-01-06', reportTiming: 'amc', fiscalQuarter: 4, fiscalYear: 2025,
            eps: { estimate: 1, actual: null }, revenue: { estimate: 1000000000, actual: null }
          }],
          earningsApiCalendar: [],
          nasdaq: []
        }
      },
      selectedSources: { ...baseRow.sourceAudit.selectedSources, timing: 'none' },
      yahoo: {}
    }
  };
  const result = await refreshEarningsResults({
    rows: [row], secondaryRecoveryCandidates: [], companyReleaseTasks: [], summary: { counts: {} }
  }, {
    finnhubRows: [finnhubRow('CONFLICT', {
      reportDate: '2026-01-06',
      eps: { estimate: 1, actual: 1.5 },
      revenue: { estimate: 1000000000, actual: 1250000000 }
    })],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'CONFLICT', ok: true, status: 200, responseMs: 1, error: '',
      bars: [{ date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 110 }]
    }]
  }, { asOf: '2026-01-08T12:00:00.000Z' });

  const refreshed = result.payload.rows[0];
  assert.equal(refreshed.eps.actual, 1.5, 'A resolved date conflict must not block Finnhub actuals.');
  assert.equal(refreshed.revenue.actual, 1250000000);
  assert.equal(refreshed.sourceAudit.finnhubCalendar.reportDate, '2026-01-06');
  assert.equal(refreshed.sourceAudit.providerDateConflict.candidates.finnhub[0].eps.actual, 1.5);

  const unresolved = await refreshEarningsResults({
    rows: [row], secondaryRecoveryCandidates: [], companyReleaseTasks: [], summary: { counts: {} }
  }, {
    finnhubRows: [finnhubRow('CONFLICT', {
      reportDate: '2026-01-06', eps: { estimate: 1, actual: null }, revenue: { estimate: 1000000000, actual: null }
    })],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: []
  }, { asOf: '2026-01-08T12:00:00.000Z' });
  assert.equal(unresolved.payload.companyReleaseTasks.length, 1, 'An arrived date conflict without actuals must escalate to the company-release resolver.');
  assert.equal(unresolved.payload.companyReleaseTasks[0].trigger, 'provider_date_conflict_requires_company_release');

  const officialRow = structuredClone(row);
  officialRow.sourceAudit.providerDateConflict.status = 'fallback';
  officialRow.sourceAudit.providerDateConflict.selectedProvider = 'finnhub';
  officialRow.sourceAudit.scheduleVerification = {
    status: 'official_confirmed',
    primaryDate: '2026-01-06',
    secondaryDates: ['2026-01-07'],
    official: {
      symbol: 'CONFLICT',
      primaryDate: '2026-01-06',
      reportDate: '2026-01-07',
      sourceName: 'Official investor relations calendar',
      sourceUrl: 'https://investors.example.test/earnings'
    }
  };
  const officialUnresolved = await refreshEarningsResults({
    rows: [officialRow], secondaryRecoveryCandidates: [], companyReleaseTasks: [], summary: { counts: {} }
  }, {
    finnhubRows: [finnhubRow('CONFLICT', {
      reportDate: '2026-01-06', eps: { estimate: 1, actual: null }, revenue: { estimate: 1000000000, actual: null }
    })],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: []
  }, { asOf: '2026-01-08T12:00:00.000Z' });
  assert.equal(officialUnresolved.payload.companyReleaseTasks.length, 1, 'An arrived official redate without actuals must also escalate to the company-release resolver.');
  const stagingErrors = validateEarningsWeekPayload(officialUnresolved.payload);
  assert.doesNotMatch(stagingErrors.join(' '), /companyReleaseApply|provider-resolved or officially confirmed/, 'A staging payload may carry unresolved company-release tasks before the apply step.');
}

function testWeekValidatorRejectsUnappliedCompanyReleaseTasks() {
  const source = embeddedWeekFixture();
  source.companyReleaseTasks = [companyReleaseTaskFixture(source)];
  delete source.companyReleaseApply;
  source.summary.counts.companyReleaseTasks = 1;

  expectWeekValidationFailure(
    source,
    /companyReleaseApply must be populated/,
    'Company-release tasks must not validate as dashboard-ready until applied.'
  );
}

function testWeekValidatorRejectsSkippedCompanyReleaseTasks() {
  const source = embeddedWeekFixture();
  const task = companyReleaseTaskFixture(source);
  source.companyReleaseTasks = [task];
  source.companyReleaseApply = {
    generatedAt: '2026-01-06T22:00:00.000Z',
    resolutionArtifact: 'generated/earnings_company_release_resolutions.json',
    applied: [],
    skipped: [{ taskId: task.id, reason: 'unresolved' }]
  };
  source.summary.counts.companyReleaseTasks = 1;

  expectWeekValidationFailure(
    source,
    /must not be skipped/,
    'Skipped company-release tasks must not validate as dashboard-ready.'
  );
}

function testWeekValidatorRequiresAppliedCompanyReleaseOnRow() {
  const source = embeddedWeekFixture();
  const task = companyReleaseTaskFixture(source);
  source.companyReleaseTasks = [task];
  source.companyReleaseApply = {
    generatedAt: '2026-01-06T22:00:00.000Z',
    resolutionArtifact: 'generated/earnings_company_release_resolutions.json',
    applied: [{ taskId: task.id, symbol: task.symbol }],
    skipped: []
  };
  source.summary.counts.companyReleaseTasks = 1;

  expectWeekValidationFailure(
    source,
    /must be reflected in row\.sourceAudit\.companyReleaseResolution/,
    'Applied company-release tasks must update the canonical row, not just the apply ledger.'
  );
}

function companyReleaseTaskFixture(source) {
  if (!source.secondaryRecoveryCandidates[0]) {
    const row = source.rows.find((item) => item.sourceAudit?.finnhubProfile);
    assert.ok(row, 'Embedded dashboard fixture must include at least one profiled row for synthetic company-release validation coverage.');
    const recovery = {
      id: `${row.reportDate}:${row.symbol}:earningsapi-recovery`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      trigger: 'missing_from_finnhub_but_present_in_earningsapi',
      priority: 'normal',
      marketCap: row.marketCap,
      marketCapDisplay: row.marketCapDisplay,
      fiscalQuarterEnding: row.fiscalQuarterEnding || '',
      neededFields: ['earningsApiCompanyRow', 'reportTiming', 'eps.estimate', 'eps.actual', 'revenue.estimate', 'revenue.actual'],
      preferredSources: ['EarningsAPI company earnings endpoint'],
      doNotUseForOverrides: ['finnhub_calendar_row'],
      instructions: 'Use EarningsAPI only to recover display-scale events missing from Finnhub. Do not override Finnhub rows.',
      permittedUses: ['missing_row_discovery', 'eps_estimate_recovery', 'eps_actual_recovery', 'revenue_estimate_recovery', 'revenue_actual_recovery'],
      sourceAudit: {
        earningsApiCalendar: {
          reportDate: row.reportDate,
          company: row.company,
          eps: {
            estimate: row.eps.estimate,
            actual: row.eps.actual
          },
          revenue: {
            estimate: row.revenue.estimate,
            actual: row.revenue.actual
          },
          reportTiming: row.reportTiming,
          bucket: row.reportTiming === 'amc' ? 'after' : row.reportTiming === 'bmo' ? 'pre' : 'notSupplied'
        },
        finnhubCalendar: {
          present: false
        },
        finnhubProfile: row.sourceAudit.finnhubProfile,
        earningsApiCompany: {
          status: 200,
          ok: true,
          selectedRow: {
            reportDate: row.reportDate,
            reportTiming: row.reportTiming,
            eps: {
              estimate: row.eps.estimate,
              actual: row.eps.actual
            },
            revenue: {
              estimate: row.revenue.estimate,
              actual: row.revenue.actual
            }
          },
          rowCount: 1,
          error: ''
        }
      }
    };
    source.secondaryRecoveryCandidates = [recovery];
    source.summary.counts.secondaryRecoveryCandidates = 1;
  }
  const recovery = source.secondaryRecoveryCandidates[0];
  return {
    id: `${recovery.reportDate}:${recovery.symbol}:company-release`,
    recoveryId: recovery.id,
    symbol: recovery.symbol,
    company: recovery.company,
    reportDate: recovery.reportDate,
    trigger: 'secondary_recovery_requires_company_release',
    reason: 'missing_eps_actual',
    priority: recovery.priority,
    marketCap: recovery.marketCap,
    marketCapDisplay: recovery.marketCapDisplay,
    fiscalQuarterEnding: recovery.fiscalQuarterEnding || '',
    neededFields: ['reportTiming', 'fiscalPeriod', 'eps.actual', 'revenue.actual', 'companyReleaseUrl', 'secFilingUrl'],
    preferredSources: ['SEC 8-K Exhibit 99.1', 'Company investor relations earnings release'],
    doNotUseForOverrides: ['finnhub_calendar_row'],
    permittedUses: ['official_actuals_resolution', 'timing_resolution', 'fiscal_period_resolution', 'eps_basis_resolution'],
    instructions: 'Use SEC/company release only when a recovered EarningsAPI row is missing official timing or actuals. Do not override Finnhub rows.',
    sourceAudit: recovery.sourceAudit
  };
}

function testWeekValidatorRejectsProvenanceDrift() {
  const source = embeddedWeekFixture();
  source.rows[0].sourceSummary.primary = 'sec_company_release';

  expectWeekValidationFailure(
    source,
    /sourceSummary\.primary must be finnhub/,
    'Visible source summary must match selected deterministic sources.'
  );
}

function testWeekValidatorAcceptsDeterministicVerifiedRow() {
  const source = deterministicVerifiedWeekFixture();

  assert.equal(source.rows[0].sourceStatus, 'verified');
  validateWeekPayload(source);

  const policyDrift = structuredClone(source);
  policyDrift.policy.enrichment = 'Finnhub and EarningsAPI are used.';
  expectWeekValidationFailure(
    policyDrift,
    /policy must exactly match buildEarningsWeekPolicy\(\)/,
    'Structurally plausible policy drift must not pass validation.'
  );

  delete source.rows[0].sourceAudit.scheduleVerification;
  source.rows[0].sourceStatus = computeEarningsSourceStatus(source.rows[0]);
  assert.equal(source.rows[0].sourceStatus, 'partial', 'Missing schedule verification cannot compute as verified.');
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);
  expectWeekValidationFailure(
    source,
    /scheduleVerification must be populated for every display-eligible row/,
    'Display-eligible rows must carry affirmative schedule-verification state.'
  );
}

function testWeekValidatorAcceptsPrimaryOnlySecondaryOutage() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].sourceAudit.scheduleVerification = {
    status: 'primary_only',
    primaryDate: source.rows[0].reportDate,
    secondaryDates: [],
    official: null
  };
  source.rows[0].sourceStatus = 'partial';
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);
  validateWeekPayload(source);
}

function testNarrativeValidationRules() {
  const cases = [
    {
      description: 'Reaction narratives must add a driver instead of restating the displayed move.',
      mutation: (source) => { source.rows[0].reaction.note = 'Verify Corp shares rose 5.0% on the first eligible close after the report.'; },
      expectedError: /reaction\.note must explain the earnings driver, not repeat the displayed share-price move/
    },
    {
      description: 'Reaction copy must stay concise enough for the current compact layout.',
      mutation: (source) => { source.rows[0].reaction.note = 'Margin expansion and guidance supported the read, but investors still need proof that demand and operating leverage can hold through year-end.'; },
      expectedError: /reaction\.note must stay within 100 characters for the compact earnings monitor/
    },
    {
      description: 'Outcome narratives must add a business takeaway instead of restating the metrics.',
      mutation: (source) => { source.rows[0].outcome.interpretation = 'Verify Corp beat on both EPS and revenue.'; },
      expectedError: /outcome\.interpretation must explain the business takeaway, not restate EPS\/revenue beats or misses/
    },
    {
      description: 'Partial reported rows must receive the same substantive outcome commentary.',
      mutation: (source) => {
        const row = source.rows[0];
        row.reaction = { status: 'unavailable', basis: 'unavailable', percent: null, note: '' };
        row.sourceStatus = 'partial';
        row.outcome.interpretation = 'Verify Corp beat on both EPS and revenue.';
        source.summary.counts = computeEarningsWeekCounts(source.rows);
      },
      expectedError: /outcome\.interpretation must explain the business takeaway, not restate EPS\/revenue beats or misses/
    },
    {
      description: 'Outcome copy must stay concise enough for the current compact layout.',
      mutation: (source) => {
        source.rows[0].outcome.interpretation = 'Margin expansion and pricing discipline supported the earnings read while demand, inventory, and operating leverage all improved materially.';
        source.rows[0].outcome.guide = 'FY26 guidance reaffirmed.';
      },
      expectedError: /outcome\.interpretation must stay within 120 characters for the compact earnings monitor/
    },
    {
      description: 'Guidance must lead with the nearer quarter when both horizons are available.',
      mutation: (source) => { source.rows[0].outcome.guide = 'FY26 revenue +5%; Q4 revenue +3%.'; },
      expectedError: /outcome\.guide must lead with next-quarter guidance when both quarterly and full-year outlooks are provided/
    },
    {
      description: 'A generic reference to a year must not pass as forward guidance.',
      mutation: (source) => { source.rows[0].outcome.guide = 'This year had a mixed demand backdrop.'; },
      expectedError: /outcome\.guide must identify a quarterly\/full-year horizon or explicit no-guidance status/
    }
  ];

  for (const { mutation, expectedError, description } of cases) {
    const source = deterministicVerifiedWeekFixture();
    mutation(source);
    expectWeekValidationFailure(source, expectedError, description);
  }
}

function testWeekValidatorRejectsSourceStatusDrift() {
  const source = embeddedWeekFixture();
  const row = source.rows[0];
  assert.ok(row, 'Embedded dashboard fixture must include at least one canonical row.');
  const expectedStatus = row.sourceStatus;
  // Flip whatever status the embedded dashboard fixture currently has so Monday-morning
  // all-partial weeks still exercise validator recomputation.
  row.sourceStatus = expectedStatus === 'verified' ? 'partial' : 'verified';
  source.summary.counts = computeEarningsWeekCounts(
    source.rows,
    source.secondaryRecoveryCandidates,
    source.companyReleaseTasks
  );

  expectWeekValidationFailure(
    source,
    new RegExp(`sourceStatus must be ${expectedStatus}`),
    'sourceStatus must be recomputed, not accepted as arbitrary metadata.'
  );
}

function testWeekValidatorRejectsExtraContractFields() {
  const source = embeddedWeekFixture();
  source.staleDisplayRows = [];
  source.rows[0].expected = 'display string';

  expectWeekValidationFailure(
    source,
    /staleDisplayRows is not part of the canonical earnings week contract|expected is not part of the canonical row contract/,
    'Canonical earnings payload must reject display/mockup scaffolding fields.'
  );
}

function testCompanyReleaseValidatorRejectsCalendarEstimates() {
  const week = embeddedWeekFixture();
  const task = companyReleaseTaskFixture(week);
  week.companyReleaseTasks = [task];
  week.summary.counts.companyReleaseTasks = 1;
  const sidecar = {
    schemaVersion: 1,
    generatedAt: '2026-01-06T22:00:00.000Z',
    sourceGeneratedAt: week.generatedAt,
    sourceRange: week.range,
    companyReleaseResolutions: [{
      taskId: task.id,
      symbol: task.symbol,
      company: task.company,
      reportDate: task.reportDate,
      status: 'resolved',
      sourceType: 'sec_8k_exhibit_99_1',
      sourceUrl: 'https://www.sec.gov/Archives/example/exhibit99.htm',
      secFilingUrl: 'https://www.sec.gov/Archives/example/filing.htm',
      confidence: 'high',
      fields: {
        company: task.company,
        fiscalPeriod: 'Fiscal Q4 2025',
        reportTiming: 'amc',
        eps: {
          actual: 1.25,
          basis: 'adjusted_non_gaap',
          gaapActual: null,
          gaapBasis: '',
          adjustment: null,
          actualSource: 'sec_company_release',
          estimate: 1,
          estimateSource: 'earningsapi_calendar',
          estimateCount: '',
          comparisonSource: 'earningsapi_calendar_eps_estimate'
        },
        revenue: {
          actual: 1200000000,
          estimate: 1000000000,
          estimateSource: 'earningsapi_calendar'
        }
      },
      reaction: {
        basis: 'next_session_close',
        percent: 10,
        fromDate: task.reportDate,
        fromClose: 100,
        toDate: '2026-07-01',
        toClose: 110,
        status: 'computed',
        note: '',
        source: 'Yahoo Finance Chart API'
      },
      notes: []
    }],
    summary: {
      total: 1,
      resolved: 1,
      needsReview: 0,
      unresolved: 0
    }
  };

  assert.throws(
    () => validateCompanyReleasePayload(week, sidecar),
    /estimateSource must be earningsapi_company/,
    'Company-release sidecar must not use EarningsAPI calendar as a metric source.'
  );

  sidecar.companyReleaseResolutions[0].fields.eps.estimateSource = 'earningsapi_company';
  sidecar.companyReleaseResolutions[0].fields.eps.comparisonSource = 'earningsapi_company_eps_estimate';
  sidecar.companyReleaseResolutions[0].fields.revenue.estimateSource = 'earningsapi_company';
  sidecar.generatedAt = '2026-07-01T19:59:00.000Z';
  assert.throws(
    () => validateCompanyReleasePayload(week, sidecar),
    /cannot be computed before the required closing response/,
    'Company-release reaction validation must not accept a future closing response.'
  );
}

function testRefreshRemovesStaleCompanyReleaseResolutionSidecarWithoutTasks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-release-sidecar-'));
  const sidecar = path.join(dir, 'earnings_company_release_resolutions.json');
  fs.writeFileSync(sidecar, '{"stale":true}\n');
  try {
    assert.equal(removeStaleCompanyReleaseResolutionSidecar({ companyReleaseTasks: [] }, sidecar), true);
    assert.equal(fs.existsSync(sidecar), false);
    fs.writeFileSync(sidecar, '{"current":true}\n');
    assert.equal(removeStaleCompanyReleaseResolutionSidecar({ companyReleaseTasks: [{ id: 'release-1' }] }, sidecar), false);
    assert.equal(fs.existsSync(sidecar), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testValidateReleaseRejectsMalformedCompanyReleaseTasks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-release-malformed-'));
  const weekFile = path.join(dir, 'earnings_week.json');
  const week = embeddedWeekFixture();
  week.companyReleaseTasks = {};
  fs.writeFileSync(weekFile, `${JSON.stringify(week)}\n`);
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'earnings_week.js'),
      'validate-release',
      '--week',
      weekFile
    ], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, 'Malformed companyReleaseTasks must fail release validation.');
    assert.match(result.stderr, /companyReleaseTasks must be an array/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testNewEarningsNarrativeRowsStagePendingEditorialCompletion() {
  const week = {
    generatedAt: '2026-07-09T22:00:00.000Z',
    range: { from: '2026-07-06', to: '2026-07-10' },
    rows: [{
      symbol: 'NEW',
      reportDate: '2026-07-09',
      country: 'US',
      exchange: 'NASDAQ',
      marketCap: 2000000000,
      sourceAudit: { finnhubProfile: { industry: 'Technology' } },
      lifecycle: 'close_available',
      outcome: { overall: 'beat' },
      reaction: { status: 'computed' }
    }]
  };
  const staged = buildEarningsNarrativeSidecar(week, { rows: [] });

  assert.deepEqual(staged.missingRows, [{ symbol: 'NEW', reportDate: '2026-07-09' }]);
  assert.equal(staged.payload.rows.length, 1);
  assert.equal(staged.payload.rows[0].outcome.interpretation, '');
  const awaitingClose = buildEarningsNarrativeSidecar({
    ...week,
    rows: [{ ...week.rows[0], lifecycle: 'released_awaiting_close', reaction: { status: 'awaiting_close' } }]
  }, {
    rows: [{
      ...staged.payload.rows[0],
      outcome: { interpretation: 'Pre-event demand assumptions still frame the setup.', guide: '' },
      reaction: { note: '' }
    }]
  });
  assert.deepEqual(awaitingClose.missingRows, [], 'Awaiting-close rows must retain complete pre-event commentary until the response is available.');

  const staleNarrative = {
    rows: [{
      ...staged.payload.rows[0],
      postReportRefreshRequired: false,
      outcome: { interpretation: 'Pre-report demand assumptions framed the setup.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Pre-report copy should never return after actuals arrive.' }
    }]
  };
  const invalidatedWeek = {
    ...week,
    rows: [{
      ...week.rows[0],
      outcome: { overall: 'mixed', guide: '', interpretation: '' },
      reaction: { status: 'computed', note: '' }
    }]
  };
  const invalidated = buildEarningsNarrativeSidecar(invalidatedWeek, staleNarrative);
  assert.deepEqual(invalidated.missingRows, [{ symbol: 'NEW', reportDate: '2026-07-09' }]);
  assert.equal(invalidated.payload.rows[0].outcome.interpretation, '');
  assert.equal(invalidated.payload.rows[0].postReportRefreshRequired, true);

  const completed = buildEarningsNarrativeSidecar(week, {
    rows: [{
      ...staged.payload.rows[0],
      outcome: { interpretation: 'Demand and margin expansion supported the result.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Demand and margin expansion supported the reaction.' }
    }]
  });
  assert.deepEqual(completed.missingRows, []);

  const refreshed = buildEarningsNarrativeSidecar(invalidatedWeek, {
    rows: [{
      ...invalidated.payload.rows[0],
      outcome: { interpretation: 'Margins and the forward outlook became the post-report focus.', guide: 'FY26 outlook reaffirmed.' },
      reaction: { note: 'Updated margin and outlook detail drove the post-report read.' }
    }]
  });
  assert.deepEqual(refreshed.missingRows, []);
  assert.equal(refreshed.payload.rows[0].postReportRefreshRequired, undefined);
  assert.equal(refreshed.payload.rows[0].outcome.interpretation, 'Margins and the forward outlook became the post-report focus.');
}


function testDashboardEarningsMoneySignContract() {
  const html = fs.readFileSync(path.join(root, 'daily_financial_news.html'), 'utf8');
  const source = extractDashboardRuntimeTestBlock(html, 'earnings-currency');
  const { formatEarningsEps, formatEarningsRevenue } = Function(`${source}\nreturn { formatEarningsEps, formatEarningsRevenue };`)();
  const provenanceSource = extractDashboardRuntimeTestBlock(html, 'earnings-provenance');
  const { earningsRowNoticeHtml } = Function('esc', `${provenanceSource}\nreturn { earningsRowNoticeHtml };`)((value) => String(value));

  assert.equal(formatEarningsEps(-0.73), '-$0.73');
  assert.equal(formatEarningsEps(0.73), '$0.73');
  assert.equal(formatEarningsRevenue(-16500000), '-$16.5M');
  assert.equal(formatEarningsRevenue(16500000), '$16.5M');
  assert.equal(earningsRowNoticeHtml({ scheduleVerificationStatus: 'corroborated', sourceStatus: 'verified' }), '');
  assert.match(earningsRowNoticeHtml({ scheduleVerificationStatus: 'official_confirmed', scheduleVerificationSourceName: 'Acme Investor Relations' }), /Report date confirmed by Acme Investor Relations\./);
  assert.match(earningsRowNoticeHtml({ scheduleVerificationStatus: 'primary_only' }), /Secondary date verification unavailable; using Finnhub\./);
  assert.equal(earningsRowNoticeHtml({ scheduleVerificationStatus: '', sourceStatus: 'verified' }), '');
}

function testBuildUsesOnlyPublicEarningsCli() {
  const internal = spawnSync(process.execPath, [path.join(root, 'scripts', 'earnings_week_build.js'), '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(internal.status, 1);
  assert.match(internal.stderr, /earnings_week_build\.js is internal; use: node scripts\/earnings_week\.js build/);

  const publicCli = spawnSync(process.execPath, [path.join(root, 'scripts', 'earnings_week.js'), 'build', '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(publicCli.status, 0, publicCli.stderr);
  assert.match(publicCli.stdout, /Usage: node scripts\/earnings_week\.js build/);

  const internalValidation = spawnSync(process.execPath, [path.join(root, 'scripts', 'earnings_week_validation.js'), '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(internalValidation.status, 1);
  assert.match(internalValidation.stderr, /earnings_week_validation\.js is internal; use: node scripts\/earnings_week\.js validate/);

  const publicValidation = spawnSync(process.execPath, [path.join(root, 'scripts', 'earnings_week.js'), 'validate', '--help'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(publicValidation.status, 0, publicValidation.stderr);
  assert.match(publicValidation.stdout, /Usage: node scripts\/earnings_week\.js validate/);
}

function testPublicEarningsValidationCli() {
  const validFile = writeTempJson('earnings-week-cli-valid', deterministicVerifiedWeekFixture());
  const invalid = deterministicVerifiedWeekFixture();
  delete invalid.rows;
  const invalidFile = writeTempJson('earnings-week-cli-invalid', invalid);
  const command = [path.join(root, 'scripts', 'earnings_week.js'), 'validate', '--require-narrative'];

  const validResult = spawnSync(process.execPath, [...command, '--input', validFile], { cwd: root, encoding: 'utf8' });
  assert.equal(validResult.status, 0, validResult.stderr);
  const invalidResult = spawnSync(process.execPath, [...command, '--input', invalidFile], { cwd: root, encoding: 'utf8' });
  assert.notEqual(invalidResult.status, 0);
  assert.match(invalidResult.stderr, /rows must be an array/);
}


async function main() {
  testSharedOutcomeContract();
  testSharedProviderContract();
  testCalendarRolloverDisplayDates();
  testFailClosed();
  testFinnhubProfileCacheFallbackPreservesIdentity();
  testFinnhubCoveredRowsDoNotSpendSecondaryRecovery();
  testProviderDateConflictResolution();
  testPrimaryScheduleVerification();
  await testEarningsApiCalendarStopsAfterQuotaResponse();
  testWeekValidatorAllowsOfficialScheduleRedate();
  testFinnhubRowsCanRecoverProfileOnly();
  testWeekValidatorAcceptsProfileRecoveryContract();
  testWeekValidatorAllowsEmptyEarningsWeek();
  testWeekValidatorRejectsMissingRowsArray();
  testSecondaryRecoveryAndRevenueComparison();
  testApplyCompanyReleaseResolution();
  testApplyEarningsNarrative();
  testEarningsNarrativeCompletenessIsDeferredToEditorialFinalization();
  testResultRefreshTimingThresholds();
  testResultRefreshTargetsUnresolvedCompanyReleaseTasks();
  testWeekValidatorRejectsUnappliedCompanyReleaseTasks();
  testWeekValidatorRejectsSkippedCompanyReleaseTasks();
  testWeekValidatorRequiresAppliedCompanyReleaseOnRow();
  testWeekValidatorRejectsProvenanceDrift();
  testWeekValidatorAcceptsDeterministicVerifiedRow();
  testWeekValidatorAcceptsPrimaryOnlySecondaryOutage();
  testNarrativeValidationRules();
  testWeekValidatorRejectsSourceStatusDrift();
  testWeekValidatorRejectsExtraContractFields();
  testCompanyReleaseValidatorRejectsCalendarEstimates();
  testRefreshRemovesStaleCompanyReleaseResolutionSidecarWithoutTasks();
  testValidateReleaseRejectsMalformedCompanyReleaseTasks();
  await testResultRefreshDoesNotRebuildSlate();
  await testUnchangedResultRefreshPreservesNarrative();
  await testResultRefreshUsesFinnhubActualsAfterResolvedDateConflict();
  testNewEarningsNarrativeRowsStagePendingEditorialCompletion();
  testDashboardEarningsMoneySignContract();
  testBuildUsesOnlyPublicEarningsCli();
  testPublicEarningsValidationCli();
  console.log('Earnings week tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
