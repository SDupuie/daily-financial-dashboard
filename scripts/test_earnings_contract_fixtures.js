#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  buildEarningsApiRows,
  buildCompanyReleaseTasks,
  buildSecondaryRecoveryCandidates,
  buildRows,
  ensureFinnhubPrimaryUsable
} = require('./fetch_earnings_week');
const { applyCompanyReleaseResolutions } = require('./apply_company_release_resolutions');
const { applyEarningsNarrative } = require('./apply_earnings_narrative');
const {
  refreshEarningsResults,
  refreshTargetRows,
  reportWindowArrived
} = require('./refresh_earnings_results');

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
    path.join(root, 'scripts', 'validate_company_release_resolutions.js'),
    '--input',
    sidecarFile,
    '--week',
    weekFile
  ], { stdio: 'pipe' });
}

function generatedWeekFixture() {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'generated', 'earnings_week.json'), 'utf8'));
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
  const source = generatedWeekFixture();
  const row = source.rows.find((item) => item.sourceAudit?.selectedSources?.slate === 'finnhub' && item.sourceAudit?.finnhubProfile?.name);
  assert.ok(row, 'Generated fixture must include a Finnhub row for profile-recovery validation.');
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
  const source = generatedWeekFixture();
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
}

function testWeekValidatorRejectsMissingRowsArray() {
  const source = generatedWeekFixture();
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
    sourceArtifact: 'scripts/generated/earnings_week.json',
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
    sourceArtifact: 'scripts/generated/earnings_week.json',
    narrativeArtifact: 'scripts/generated/earnings_narrative.json'
  });
  const row = output.rows[0];

  assert.equal(row.outcome.guide, 'FY guide reiterated.');
  assert.equal(row.outcome.interpretation, 'Margin improvement carried the read.');
  assert.equal(row.reaction.note, 'Guidance drove the bid.');
  assert.equal(row.revenue.note, 'Revenue +5% YoY.');
  assert.deepEqual(output.narrativeApply.applied, [{ symbol: 'NARRATIVE', reportDate: '2026-01-06' }]);
  assert.equal(output.narrativeApply.narrativeArtifact, 'scripts/generated/earnings_narrative.json');
  assert.throws(
    () => applyEarningsNarrative(source, {
      schemaVersion: 1,
      sourceArtifact: 'scripts/generated/earnings_week.json',
      sourceGeneratedAt: source.generatedAt,
      sourceRange: source.range,
      rows: []
    }, {
      sourceArtifact: 'scripts/generated/earnings_week.json'
    }),
    /rows must be a non-empty array/,
    'Empty narrative payload must not silently validate.'
  );
  assert.throws(
    () => applyEarningsNarrative(source, {
      schemaVersion: 1,
      sourceArtifact: 'scripts/generated/earnings_week.json',
      sourceGeneratedAt: '2026-01-05T22:00:00.000Z',
      sourceRange: source.range,
      rows: [{
        symbol: 'NARRATIVE',
        reportDate: '2026-01-06'
      }]
    }, {
      sourceArtifact: 'scripts/generated/earnings_week.json'
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
      narrativeArtifact: 'scripts/generated/earnings_narrative.json',
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
    outputPath: 'scripts/generated/earnings_week.json'
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

function testWeekValidatorRejectsUnappliedCompanyReleaseTasks() {
  const source = generatedWeekFixture();
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
  const source = generatedWeekFixture();
  const task = companyReleaseTaskFixture(source);
  source.companyReleaseTasks = [task];
  source.companyReleaseApply = {
    generatedAt: '2026-01-06T22:00:00.000Z',
    resolutionArtifact: 'scripts/generated/earnings_company_release_resolutions.json',
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
  const source = generatedWeekFixture();
  const task = companyReleaseTaskFixture(source);
  source.companyReleaseTasks = [task];
  source.companyReleaseApply = {
    generatedAt: '2026-01-06T22:00:00.000Z',
    resolutionArtifact: 'scripts/generated/earnings_company_release_resolutions.json',
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
  const recovery = source.secondaryRecoveryCandidates[0];
  assert.ok(recovery, 'Generated fixture must include a secondary recovery candidate for validation coverage.');
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
  const source = generatedWeekFixture();
  source.rows[0].sourceSummary.primary = 'sec_company_release';

  expectWeekValidationFailure(
    source,
    /sourceSummary\.primary must be finnhub/,
    'Visible source summary must match selected deterministic sources.'
  );
}

function testWeekValidatorRejectsSourceStatusDrift() {
  const source = generatedWeekFixture();
  const row = source.rows.find((item) => item.sourceStatus === 'verified');
  assert.ok(row, 'Generated fixture must include a verified row for sourceStatus coverage.');
  row.sourceStatus = 'partial';
  source.summary.counts.verified = source.rows.filter((item) => item.sourceStatus === 'verified').length;
  source.summary.counts.partial = source.rows.filter((item) => item.sourceStatus === 'partial').length;

  expectWeekValidationFailure(
    source,
    /sourceStatus must be verified/,
    'sourceStatus must be recomputed, not accepted as arbitrary metadata.'
  );
}

function testWeekValidatorRejectsExtraContractFields() {
  const source = generatedWeekFixture();
  source.staleDisplayRows = [];
  source.rows[0].expected = 'display string';

  expectWeekValidationFailure(
    source,
    /staleDisplayRows is not part of the canonical earnings week contract|expected is not part of the canonical row contract/,
    'Canonical earnings payload must reject display/mockup scaffolding fields.'
  );
}

function testCompanyReleaseValidatorRejectsCalendarEstimates() {
  const week = generatedWeekFixture();
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

async function main() {
  testFailClosed();
  testFinnhubCoveredRowsDoNotSpendSecondaryRecovery();
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
  testWeekValidatorRejectsSourceStatusDrift();
  testWeekValidatorRejectsExtraContractFields();
  testCompanyReleaseValidatorRejectsCalendarEstimates();
  await testResultRefreshDoesNotRebuildSlate();
  console.log('Earnings contract fixture tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
