#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  buildEarningsWeekPolicy,
  computeEarningsWeekCounts,
  earningsRowKey,
  normalizeEarningsTiming,
  numberOrNull
} = require('./earnings_week_contract');
const { displayDatesForRange, isIsoDate } = require('./calendar_contract');
const {
  attachReactions,
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  buildEarningsApiRows,
  buildCompanyReleaseTasks,
  buildSecondaryRecoveryCandidates,
  buildRows,
  ensureFinnhubPrimaryUsable,
  profileFromCache,
  resolveProviderDateConflicts
} = require('./earnings_week_build');
const {
  applyCompanyReleaseResolutions,
  applyEarningsNarrative
} = require('./earnings_week');
const {
  refreshEarningsResults,
  refreshTargetRows,
  removeStaleCompanyReleaseResolutionSidecar,
  reportWindowArrived
} = require('./earnings_week_refresh');

const root = path.resolve(__dirname, '..');

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

function validateWeekPayload(payload) {
  const file = writeTempJson('earnings-week-contract', payload);
  execFileSync(process.execPath, [
    path.join(root, 'scripts', 'validate_earnings_week.js'),
    '--input',
    file,
    '--require-narrative'
  ], { stdio: 'pipe' });
}

function writeTempJson(prefix, payload) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

function validateCompanyReleasePayload(week, sidecar) {
  const weekFile = writeTempJson('earnings-week-company-release-contract', week);
  const sidecarFile = writeTempJson('earnings-company-release-contract', {
    ...sidecar,
    sourceArtifact: path.relative(root, weekFile)
  });
  execFileSync(process.execPath, [
    path.join(root, 'scripts', 'validate_earnings_week.js'),
    'release',
    '--input',
    sidecarFile,
    '--week',
    weekFile
  ], { stdio: 'pipe' });
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
  const rows = attachReactions(
    buildRows([finnhubRow('VERIFY')], [profile('VERIFY')]),
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
    }]
  );
  rows[0].outcome.interpretation = 'Margin expansion and pricing discipline supported the earnings read.';
  rows[0].outcome.guide = 'FY26 reaffirmed.';
  rows[0].reaction.note = 'Margin expansion and updated guidance supported the post-report read.';

  return {
    schemaVersion: 1,
    generatedAt: '2026-01-06T22:00:00.000Z',
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
      generatedAt: '2026-01-06T22:05:00.000Z',
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
}

function testFinnhubProfileCacheFallbackPreservesIdentity() {
  const cached = profileFromCache('CACHEME', {
    schemaVersion: 1,
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

function testNasdaqConfirmedEarningsApiDateWinsConflictDateOnly() {
  const primary = finnhubRow('DATEWIN', {
    reportDate: '2026-01-06',
    reportTiming: 'amc',
    fiscalQuarter: 4,
    fiscalYear: 2025
  });
  const secondary = earningsApiRow('DATEWIN', {
    reportDate: '2026-01-07',
    reportTiming: 'bmo'
  });
  const resolution = resolveProviderDateConflicts(
    [primary],
    [{ date: secondary.reportDate, rows: [secondary] }],
    [{ date: secondary.reportDate, rows: [nasdaqRow('DATEWIN', { reportDate: '2026-01-07', reportTiming: 'unknown' })] }]
  );
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates(
    resolution.finnhubRows,
    resolution.earningsApiCalendarDays,
    [profile('DATEWIN')]
  );
  const rows = buildRows(resolution.finnhubRows, [profile('DATEWIN')], {
    earningsApiCalendarDays: resolution.earningsApiCalendarDays
  });

  assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-07');
  assert.equal(resolution.finnhubRows[0].reportTiming, 'unknown', 'Nasdaq date confirmation must not inherit unconfirmed EarningsAPI timing.');
  assert.equal(secondaryRecoveryCandidates.length, 0, 'Confirmed conflict rows must collapse to one canonical row.');
  assert.equal(rows[0].reportDate, '2026-01-07');
  assert.equal(rows[0].sourceAudit.providerDateConflict.selectedProvider, 'earningsApiCalendar');
  assert.equal(rows[0].sourceAudit.providerDateConflict.selectedDateSource, 'nasdaq');
  assert.equal(rows[0].sourceAudit.providerDateConflict.candidates.finnhub[0].reportDate, '2026-01-06');
  assert.equal(rows[0].sourceAudit.providerDateConflict.candidates.earningsApiCalendar[0].reportDate, '2026-01-07');
}

function testConflictDateRecoveryCanPreserveDisplayEligibility() {
  const primary = finnhubRow('DISPLAY', {
    reportDate: '2026-01-06',
    reportTiming: 'unknown'
  });
  const secondary = earningsApiRow('DISPLAY', {
    company: 'Display Therapeutics, Inc.',
    reportDate: '2026-01-07',
    reportTiming: 'bmo'
  });
  const emptyProfile = {
    ...profile('DISPLAY'),
    ok: false,
    status: 429,
    name: '',
    ticker: '',
    exchange: '',
    country: '',
    currency: '',
    marketCap: null,
    marketCapMillions: null,
    shareOutstanding: null,
    industry: '',
    error: 'HTTP 429'
  };
  const resolution = resolveProviderDateConflicts(
    [primary],
    [{ date: secondary.reportDate, rows: [secondary] }],
    [{ date: secondary.reportDate, rows: [nasdaqRow('DISPLAY', {
      company: 'Display Therapeutics, Inc.',
      reportDate: '2026-01-07',
      reportTiming: 'unknown',
      marketCap: 2500000000,
      marketCapDisplay: '$2,500,000,000'
    })] }]
  );
  const rows = buildRows(resolution.finnhubRows, [emptyProfile], {
    earningsApiCalendarDays: resolution.earningsApiCalendarDays
  });
  const row = rows[0];

  assert.equal(row.reportDate, '2026-01-07');
  assert.equal(row.company, 'Display Therapeutics, Inc.');
  assert.equal(row.marketCap, 2500000000);
  assert.equal(row.sourceSummary.fallbacks.includes('providerDateConflict'), true);
  assert.equal(row.sourceAudit.selectedSources.company, 'providerDateConflict');
  assert.equal(row.sourceAudit.selectedSources.marketCap, 'providerDateConflict');
}

function testNasdaqConfirmedFinnhubDateSuppressesConflictRecovery() {
  const primary = finnhubRow('DATEKEEP', {
    reportDate: '2026-01-06',
    reportTiming: 'amc'
  });
  const secondary = earningsApiRow('DATEKEEP', {
    reportDate: '2026-01-07',
    reportTiming: 'bmo'
  });
  const resolution = resolveProviderDateConflicts(
    [primary],
    [{ date: secondary.reportDate, rows: [secondary] }],
    [{ date: primary.reportDate, rows: [nasdaqRow('DATEKEEP', { reportDate: '2026-01-06', reportTiming: 'amc' })] }]
  );
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates(
    resolution.finnhubRows,
    resolution.earningsApiCalendarDays,
    [profile('DATEKEEP')]
  );

  assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-06');
  assert.equal(resolution.finnhubRows[0].providerDateConflict.selectedProvider, 'finnhub');
  assert.equal(resolution.finnhubRows[0].providerDateConflict.reason, 'nasdaq_matched_finnhub_date');
  assert.equal(secondaryRecoveryCandidates.length, 0);
}

function testUnresolvedProviderDateConflictFallsBackToFinnhub() {
  const primary = finnhubRow('DATEFALLBACK', {
    reportDate: '2026-01-06'
  });
  const secondary = earningsApiRow('DATEFALLBACK', {
    reportDate: '2026-01-07'
  });
  const resolution = resolveProviderDateConflicts(
    [primary],
    [{ date: secondary.reportDate, rows: [secondary] }],
    [{ date: '2026-01-08', rows: [nasdaqRow('DATEFALLBACK', { reportDate: '2026-01-08' })] }]
  );
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates(
    resolution.finnhubRows,
    resolution.earningsApiCalendarDays,
    [profile('DATEFALLBACK')]
  );

  assert.equal(resolution.finnhubRows[0].reportDate, '2026-01-06');
  assert.equal(resolution.finnhubRows[0].providerDateConflict.status, 'fallback');
  assert.equal(resolution.finnhubRows[0].providerDateConflict.selectedDateSource, 'finnhub_fallback');
  assert.equal(secondaryRecoveryCandidates.length, 0, 'Unresolved same-symbol conflicts must not surface duplicate recovery rows.');
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
  assert.equal(row.sourceStatus, 'verified');
  assert.equal(row.sourceSummary.primary, 'sec_company_release');
  assert.equal(row.sourceAudit.selectedSources.eps.actual, 'sec_company_release');
  assert.equal(row.sourceAudit.selectedSources.revenue.estimate, 'earningsApiCompany');
  assert.equal(row.sourceAudit.companyReleaseResolution.taskId, task.id);
  assert.equal(output.summary.counts.verified, 1);
  assert.equal(output.summary.counts.companyReleaseTasks, 1);
  assert.deepEqual(output.companyReleaseApply.applied, [{ taskId: task.id, symbol: task.symbol }]);
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

function testResultRefreshTimingThresholds() {
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
    schemaVersion: 1,
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
  const result = await refreshEarningsResults(source, {
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
  }, {
    asOf: '2026-01-06T18:00:00.000Z',
    outputPath: 'generated/earnings_week.json'
  });
  const row = result.payload.rows[0];

  assert.equal(result.refreshedRows, 1);
  assert.equal(row.sourceAudit.selectedSources.slate, 'finnhub');
  assert.equal(row.eps.actual, 1.5);
  assert.equal(row.revenue.actual, 1250000000);
  assert.equal(row.reaction.status, 'computed');
  assert.equal(row.sourceStatus, 'verified');
  assert.equal(row.outcome.interpretation, '', 'Deterministic refresh must invalidate stale narrative.');
  assert.equal(row.reaction.note, '', 'Deterministic refresh must invalidate stale reaction narrative.');
  assert.equal(Object.prototype.hasOwnProperty.call(result.payload, 'narrativeApply'), false);
  assert.equal(result.payload.secondaryRecoveryCandidates.length, 0, 'Result refresh must not create a new secondary slate.');
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
}

function testWeekValidatorRejectsPriceRecapReactionNarrative() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].reaction.note = 'Verify Corp shares rose 5.0% on the first eligible close after the report.';

  expectWeekValidationFailure(
    source,
    /reaction\.note must explain the earnings driver, not repeat the displayed share-price move/,
    'Reaction narratives must add a driver instead of restating the displayed move.'
  );
}

function testWeekValidatorRejectsVerboseReactionNarrative() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].reaction.note = 'Margin expansion and guidance supported the read, but investors still need proof that demand and operating leverage can hold through year-end.';

  expectWeekValidationFailure(
    source,
    /reaction\.note must stay within 100 characters for the compact earnings monitor/,
    'Reaction copy must stay concise enough for the current compact layout.'
  );
}

function testWeekValidatorRejectsMetricRecapOutcomeNarrative() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].outcome.interpretation = 'Verify Corp beat on both EPS and revenue.';

  expectWeekValidationFailure(
    source,
    /outcome\.interpretation must explain the business takeaway, not restate EPS\/revenue beats or misses/,
    'Outcome narratives must add a business takeaway instead of restating the metrics.'
  );
}

function testWeekValidatorRejectsPartialReportedMetricRecapOutcomeNarrative() {
  const source = deterministicVerifiedWeekFixture();
  const row = source.rows[0];
  row.reaction = {
    status: 'unavailable',
    basis: 'unavailable',
    percent: null,
    note: ''
  };
  row.sourceStatus = 'partial';
  row.outcome.interpretation = 'Verify Corp beat on both EPS and revenue.';
  source.summary.counts = computeEarningsWeekCounts(source.rows);

  expectWeekValidationFailure(
    source,
    /outcome\.interpretation must explain the business takeaway, not restate EPS\/revenue beats or misses/,
    'Partial reported rows must receive the same substantive outcome commentary.'
  );
}

function testWeekValidatorRejectsVerboseOutcomeNarrative() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].outcome.interpretation = 'Margin expansion and pricing discipline supported the earnings read while demand, inventory, and operating leverage all improved materially.';
  source.rows[0].outcome.guide = 'FY26 guidance reaffirmed.';

  expectWeekValidationFailure(
    source,
    /outcome\.interpretation must stay within 120 characters for the compact earnings monitor/,
    'Outcome copy must stay concise enough for the current compact layout.'
  );
}

function testWeekValidatorPrioritizesQuarterlyGuidance() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].outcome.guide = 'FY26 revenue +5%; Q4 revenue +3%.';

  expectWeekValidationFailure(
    source,
    /outcome\.guide must lead with next-quarter guidance when both quarterly and full-year outlooks are provided/,
    'Guidance must lead with the nearer quarter when both horizons are available.'
  );
}

function testWeekValidatorRejectsNonGuidanceOutcomeGuide() {
  const source = deterministicVerifiedWeekFixture();
  source.rows[0].outcome.guide = 'This year had a mixed demand backdrop.';

  expectWeekValidationFailure(
    source,
    /outcome\.guide must identify a quarterly\/full-year horizon or explicit no-guidance status/,
    'A generic reference to a year must not pass as forward guidance.'
  );
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

function testValidateReleaseSkipsWeekWithoutCompanyReleaseTasks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-release-validate-'));
  const weekFile = path.join(dir, 'earnings_week.json');
  const absentSidecar = path.join(dir, 'missing_resolutions.json');
  const week = embeddedWeekFixture();
  week.companyReleaseTasks = [];
  week.summary.counts.companyReleaseTasks = 0;
  fs.writeFileSync(weekFile, `${JSON.stringify(week)}\n`);
  try {
    const output = execFileSync(process.execPath, [
      path.join(root, 'scripts', 'earnings_week.js'),
      'validate-release',
      '--week',
      weekFile,
      '--input',
      absentSidecar
    ], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.match(output, /Company-release validation not applicable: .* has no active company-release tasks/);
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

async function main() {
  testCalendarRolloverDisplayDates();
  testFailClosed();
  testFinnhubProfileCacheFallbackPreservesIdentity();
  testFinnhubCoveredRowsDoNotSpendSecondaryRecovery();
  testNasdaqConfirmedEarningsApiDateWinsConflictDateOnly();
  testConflictDateRecoveryCanPreserveDisplayEligibility();
  testNasdaqConfirmedFinnhubDateSuppressesConflictRecovery();
  testUnresolvedProviderDateConflictFallsBackToFinnhub();
  testFinnhubRowsCanRecoverProfileOnly();
  testWeekValidatorAcceptsProfileRecoveryContract();
  testWeekValidatorAllowsEmptyEarningsWeek();
  testWeekValidatorRejectsMissingRowsArray();
  testSecondaryRecoveryAndRevenueComparison();
  testApplyCompanyReleaseResolution();
  testApplyEarningsNarrative();
  testResultRefreshTimingThresholds();
  testResultRefreshTargetsUnresolvedCompanyReleaseTasks();
  testWeekValidatorRejectsUnappliedCompanyReleaseTasks();
  testWeekValidatorRejectsSkippedCompanyReleaseTasks();
  testWeekValidatorRequiresAppliedCompanyReleaseOnRow();
  testWeekValidatorRejectsProvenanceDrift();
  testWeekValidatorAcceptsDeterministicVerifiedRow();
  testWeekValidatorRejectsPriceRecapReactionNarrative();
  testWeekValidatorRejectsVerboseReactionNarrative();
  testWeekValidatorRejectsMetricRecapOutcomeNarrative();
  testWeekValidatorRejectsPartialReportedMetricRecapOutcomeNarrative();
  testWeekValidatorRejectsVerboseOutcomeNarrative();
  testWeekValidatorPrioritizesQuarterlyGuidance();
  testWeekValidatorRejectsNonGuidanceOutcomeGuide();
  testWeekValidatorRejectsSourceStatusDrift();
  testWeekValidatorRejectsExtraContractFields();
  testCompanyReleaseValidatorRejectsCalendarEstimates();
  testRefreshRemovesStaleCompanyReleaseResolutionSidecarWithoutTasks();
  testValidateReleaseSkipsWeekWithoutCompanyReleaseTasks();
  testValidateReleaseRejectsMalformedCompanyReleaseTasks();
  await testResultRefreshDoesNotRebuildSlate();
  await testResultRefreshUsesFinnhubActualsAfterResolvedDateConflict();
  console.log('Earnings contract fixture tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
