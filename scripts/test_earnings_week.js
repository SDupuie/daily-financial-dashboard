#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EARNINGS_WEEK_SCHEMA_VERSION,
  attachReactions,
  buildEarningsNarrativeSidecar,
  buildEarningsPreparationFallback,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsRowKey,
  emptyEarningsApiUsage,
  isDisplayEligibleEarningsRow,
  metricResult,
  mergeUnchangedEarningsNarrative,
  narrativeEditorialComplete,
  reportWindowArrived,
  resetRepeatedEarningsNarrativeForEditorial,
} = require('./earnings_week_contract');
const { addDays, displayDatesForRange } = require('./calendar_contract');
const {
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  alphaVantageCalendarFromResponse,
  buildEarningsApiRows,
  buildSecondaryRecoveryCandidates,
  buildZacksRows,
  buildRows,
  calendarVerificationDates,
  earningsApiUsageForBuild,
  ensureFinnhubPrimaryUsable,
  fetchEarningsApiCalendar,
  filterZacksRowsByFinnhubUsListings,
  finnhubUsSymbolsFromResponse,
  finnhubCalendarFromResponse,
  fetchYahooBarsForRows,
  parseZacksTable,
  resolveProviderDateConflicts,
  verifyEarningsApiRecoveryRows,
  verifyFinnhubScheduleRows,
  zacksEndpointDateFromUrl,
  zacksVisibleDateFromButtonText,
  zacksGate
} = require('./earnings_week_build');
const {
  applyEarningsNarrative,
  collectRefreshData,
  earningsCalendarFailedAttemptNeedsRetry,
  earningsCalendarNeedsBuild,
  repairRecoveredEarningsSourceAudit,
  refreshEarningsResults,
  refreshTargetRows,
  validateEarningsWeekPayload
} = require('./earnings_week');
const {
  buildEarningsGuidanceEvidenceIndex,
  chooseEarningsFiling,
  chooseExhibitDocuments,
  guidanceSignalsFromText,
  writeEarningsGuidanceEvidence
} = require('./earnings_week_guidance');
const root = path.resolve(__dirname, '..');

function profile(symbol, marketCap = 50000000000) {
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

function usListing(symbol, overrides = {}) {
  return {
    market: 'US',
    symbol,
    displaySymbol: symbol,
    mic: 'XNGS',
    type: 'Common Stock',
    currency: 'USD',
    figi: `FIGI-${symbol}`,
    shareClassFIGI: `SHARE-${symbol}`,
    ...overrides
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

function alphaVantageRow(symbol, overrides = {}) {
  return {
    symbol,
    company: `${symbol} Corp`,
    reportDate: '2026-01-06',
    reportTiming: 'unknown',
    fiscalQuarterEnding: '2025-12-31',
    fiscalQuarter: 4,
    fiscalYear: 2025,
    eps: {
      estimate: 1,
      actual: null
    },
    revenue: {
      estimate: null,
      actual: null
    },
    source: {
      provider: 'alpha_vantage',
      row: {
        symbol,
        name: `${symbol} Corp`,
        reportDate: '2026-01-06',
        fiscalDateEnding: '2025-12-31',
        estimate: '1',
        currency: 'USD'
      }
    },
    ...overrides
  };
}

function assertThrowsLike(fn, pattern, label) {
  assert.throws(fn, pattern, label);
}

function validateWeekPayload(payload) {
  const errors = validateEarningsWeekPayload(payload);
  if (errors.length) throw new Error(errors.join(' '));
}

function embeddedWeekFixture() {
  // Keep Earnings contract tests independent of the mutable published artifact.
  return deterministicVerifiedWeekFixture();
}

function deterministicVerifiedWeekFixture() {
  // Keep one fully synthetic validator fixture available so this contract test
  // does not depend on whatever live/generated week artifact happens to exist.
  const stagedRows = buildRows([finnhubRow('VERIFY')], [profile('VERIFY')], { usListings: [usListing('VERIFY')] });
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
    rows,
    secondaryRecoveryCandidates: [],
    summary: {
      counts: computeEarningsWeekCounts(rows),
      fetches: {}
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

function testFinnhubPrimaryAcceptance() {
  assertThrowsLike(
    () => ensureFinnhubPrimaryUsable({ ok: false, rows: [], error: 'HTTP 500' }),
    /Finnhub primary calendar is unavailable/,
    'Finnhub transport failure must remain distinguishable from a valid empty calendar.'
  );
  assert.doesNotThrow(
    () => ensureFinnhubPrimaryUsable({ ok: true, rows: [] }),
    'A structurally valid empty calendar must not fail based on row count.'
  );
  assert.doesNotThrow(
    () => ensureFinnhubPrimaryUsable({
      ok: true,
      rows: [finnhubRow('ONE'), finnhubRow('TWO')]
    }),
    'A sparse but structurally valid calendar must not fail based on a heuristic floor.'
  );
  const args = { displayDates: ['2026-01-06'] };
  const empty = finnhubCalendarFromResponse({
    ok: true,
    status: 200,
    ms: 1,
    data: { earningsCalendar: [] }
  }, args);
  assert.equal(empty.ok, true);
  assert.equal(empty.rowCount, 0);
  const missingCalendar = finnhubCalendarFromResponse({
    ok: true,
    status: 200,
    ms: 1,
    data: { error: 'provider returned no calendar field' }
  }, args);
  assert.equal(missingCalendar.ok, false);
  assert.match(missingCalendar.error, /missing earningsCalendar/);
}

function testMetricComparisonsUseDisplayedPrecision() {
  assert.equal(metricResult(0.33, 0.3329, 'eps'), 'met');
  assert.equal(metricResult(0.34, 0.3329, 'eps'), 'beat');
  assert.equal(metricResult(0.32, 0.3329, 'eps'), 'miss');
  assert.equal(metricResult(2384900000, 2384545147, 'revenue'), 'met');
  assert.equal(metricResult(2390000000, 2384545147, 'revenue'), 'beat');
  assert.equal(metricResult(2370000000, 2384545147, 'revenue'), 'miss');

  const [row] = buildRows([finnhubRow('ROUND', {
    eps: { estimate: 0.3329, actual: 0.33 },
    revenue: { estimate: 2384545147, actual: 2384900000 }
  })], [profile('ROUND')], { usListings: [usListing('ROUND')] });
  assert.equal(row.eps.result, 'met');
  assert.equal(row.revenue.result, 'met');
  assert.equal(row.outcome.overall, 'met');
}

function testUsListingEligibilityUsesExactDirectorySymbol() {
  const directory = finnhubUsSymbolsFromResponse({
    ok: true,
    status: 200,
    ms: 4,
    data: [{
      symbol: 'ADR',
      displaySymbol: 'ADR',
      mic: 'XNGS',
      type: 'ADR',
      currency: 'USD',
      figi: 'ADR-FIGI'
    }, {
      symbol: 'OTCADR',
      displaySymbol: 'OTCADR',
      mic: 'OTCM',
      type: 'ADR',
      currency: 'USD'
    }]
  });
  assert.equal(directory.ok, true);
  const adrListing = directory.listings.find((listing) => listing.symbol === 'ADR');
  const foreignProfile = {
    ...profile('ADR', 500000000000),
    ticker: 'ADR.AS',
    exchange: 'NYSE EURONEXT - EURONEXT AMSTERDAM',
    country: 'NL'
  };
  const [row] = buildRows([finnhubRow('ADR')], [foreignProfile], { usListings: directory.listings });
  assert.equal(row.symbol, 'ADR');
  assert.equal(row.sourceAudit.finnhubProfile.ticker, 'ADR.AS');
  assert.deepEqual(row.sourceAudit.finnhubUsListing, adrListing);
  assert.equal(isDisplayEligibleEarningsRow(row), true, 'Exact U.S. listing evidence must outrank issuer domicile and the profile primary ticker.');

  const candidates = buildSecondaryRecoveryCandidates(
    [],
    [{ date: '2026-01-06', rows: [alphaVantageRow('ADR')] }],
    [foreignProfile],
    directory.listings
  );
  assert.deepEqual(candidates.map((task) => task.symbol), ['ADR']);
  assert.deepEqual(candidates[0].sourceAudit.finnhubUsListing, adrListing);

  const [foreignOnly] = buildRows([finnhubRow('FOREIGN')], [{
    ...profile('FOREIGN'),
    ticker: 'FOREIGN.L',
    exchange: 'LONDON STOCK EXCHANGE',
    country: 'GB'
  }], { usListings: directory.listings });
  assert.equal(isDisplayEligibleEarningsRow(foreignOnly), false, 'A foreign profile without an exact U.S. directory match must stay hidden.');

  const [otc] = buildRows([finnhubRow('OTCADR')], [profile('OTCADR')], { usListings: directory.listings });
  assert.equal(isDisplayEligibleEarningsRow(otc), false, 'An exact OTC directory match must remain ineligible.');

  const [smallCap] = buildRows([finnhubRow('SMALL')], [profile('SMALL', 24999999999)], { usListings: [usListing('SMALL')] });
  assert.equal(isDisplayEligibleEarningsRow(smallCap), false, 'A sub-$25B market-cap row must remain ineligible.');
  assert.equal(verifyFinnhubScheduleRows([smallCap], [], {
    from: '2026-01-05',
    to: '2026-01-09'
  }).rows.length, 0, 'Prepare must not admit primary rows that can never display.');
  assert.equal(verifyEarningsApiRecoveryRows([smallCap], {
    from: '2026-01-05',
    to: '2026-01-09'
  }).rows.length, 0, 'Prepare must not admit recovered rows that can never display.');

  const receiptBound = deterministicVerifiedWeekFixture();
  receiptBound.summary.fetches.finnhubUsSymbols = { ok: true, status: 200, rows: 2, cacheHit: false, error: '' };
  delete receiptBound.rows[0].sourceAudit.finnhubUsListing;
  assert.deepEqual(validateEarningsWeekPayload(receiptBound), []);
}

function testPrimaryScheduleVerification() {
  const range = { from: '2026-01-05', to: '2026-01-09' };
  const baseRows = (symbol) => buildRows(
    [finnhubRow(symbol, { reportDate: '2026-01-06' })],
    [profile(symbol)],
    { usListings: [usListing(symbol)] }
  );
  const matching = verifyFinnhubScheduleRows(baseRows('MATCH'), [{
    date: '2026-01-06', rows: [earningsApiRow('MATCH', { reportDate: '2026-01-06' })]
  }], range);
  assert.equal(matching.rows.length, 1);
  assert.equal(matching.rows[0].sourceAudit.scheduleVerification.status, 'corroborated');

  const crossWeek = verifyFinnhubScheduleRows(baseRows('OUTSIDE'), [{
    date: '2026-01-30', rows: [earningsApiRow('OUTSIDE', { reportDate: '2026-01-30' })]
  }], range);
  assert.equal(crossWeek.rows.length, 1, 'A cross-week conflict must retain the provider row with partial provenance.');
  assert.equal(crossWeek.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.deepEqual(crossWeek.rows[0].sourceAudit.scheduleVerification.secondaryDates, ['2026-01-30']);
  assert.equal(crossWeek.rows[0].sourceStatus, 'partial');

  const inWeekConflict = verifyFinnhubScheduleRows(baseRows('INWEEK'), [{
    date: '2026-01-08', rows: [earningsApiRow('INWEEK', { reportDate: '2026-01-08' })]
  }], range);
  assert.equal(inWeekConflict.rows.length, 1);
  assert.equal(inWeekConflict.rows[0].reportDate, '2026-01-06');
  assert.equal(inWeekConflict.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');

  const uncorroborated = verifyFinnhubScheduleRows(baseRows('SINGLE'), [], range);
  assert.equal(uncorroborated.rows.length, 1);
  assert.equal(uncorroborated.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.equal(uncorroborated.rows[0].sourceStatus, 'partial');

  const secondaryOutage = verifyFinnhubScheduleRows(baseRows('OUTAGE'), [{
    date: '2026-01-05', ok: false, status: 429, rows: []
  }], range);
  assert.equal(secondaryOutage.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.equal(secondaryOutage.rows[0].sourceStatus, 'partial');

  const completeSecondaryMiss = verifyFinnhubScheduleRows(baseRows('SINGLE'), displayDatesForRange(range.from, range.to).map((date) => ({
    date,
    ok: true,
    rows: []
  })), range);
  assert.equal(completeSecondaryMiss.rows.length, 1);
  assert.equal(completeSecondaryMiss.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.equal(completeSecondaryMiss.rows[0].sourceStatus, 'partial');

  const providerAgreementIgnoresOtherDates = verifyFinnhubScheduleRows(baseRows('MATCHFIRST'), [{
    date: '2026-01-06', rows: [earningsApiRow('MATCHFIRST', { reportDate: '2026-01-06' })]
  }]);
  assert.equal(providerAgreementIgnoresOtherDates.rows[0].reportDate, '2026-01-06');
  assert.equal(providerAgreementIgnoresOtherDates.rows[0].sourceAudit.scheduleVerification.status, 'corroborated');

  const verificationDates = calendarVerificationDates({ from: range.from, to: range.to });
  assert.equal(verificationDates[0], addDays(range.from, -7));
  assert.equal(verificationDates.at(-1), addDays(range.to, 14));
  assert.equal(verificationDates.length, 26, 'Secondary verification must cover 7 days before through 14 days after the displayed range.');

  const recoveryRow = {
    symbol: 'RECOVERY',
    company: 'Recovery Corp',
    country: 'US',
    exchange: 'NASDAQ NMS - GLOBAL MARKET',
    marketCap: 30000000000,
    reportDate: '2026-01-06',
    sourceAudit: { selectedSources: { slate: 'alphaVantageCalendar' } }
  };
  const recovery = verifyEarningsApiRecoveryRows([recoveryRow], range);
  assert.equal(recovery.rows.length, 1);
  assert.equal(recovery.rows[0].sourceAudit.scheduleVerification.status, 'secondary_only');
  assert.equal(recovery.rows[0].sourceStatus, 'partial');

  const missingCandidate = {
    symbol: 'MISSING',
    company: 'Missing Company Row Corp',
    reportDate: '2026-01-06'
  };
  const mismatchedCompanyRows = buildEarningsApiRows([{
    ...missingCandidate,
    sourceAudit: {
      finnhubProfile: profile('MISSING'),
      alphaVantageCalendar: alphaVantageRow('MISSING')
    }
  }], [{
    symbol: 'MISSING',
    ok: true,
    status: 200,
    rows: [earningsApiRow('MISSING', { reportDate: '2026-01-08' })]
  }]);
  assert.equal(mismatchedCompanyRows.length, 0, 'A company endpoint date mismatch must not create a canonical recovery row.');
  const missingCompanyRow = verifyEarningsApiRecoveryRows(mismatchedCompanyRows, range);
  assert.equal(missingCompanyRow.rows.length, 0);
}

function testProviderScheduleRetryAndPreparationFallbacks() {
  const canonical = deterministicVerifiedWeekFixture();
  const retryWeek = structuredClone(canonical);
  retryWeek.generatedAt = '2026-01-05T12:00:00.000Z';
  retryWeek.rows[0].sourceAudit.scheduleVerification = {
    status: 'primary_only',
    primaryDate: retryWeek.rows[0].reportDate,
    secondaryDates: [],
    official: null
  };
  retryWeek.summary.fetches = {
    secondaryCalendar: {
      provider: 'alpha_vantage',
      requests: 1,
      ok: 1,
      skipped: 0,
      rows: 400,
      errors: []
    }
  };
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-schedule-retry-'));
  try {
    const retryPath = path.join(retryDir, 'retry-week.json');
    fs.writeFileSync(retryPath, JSON.stringify(retryWeek));
    assert.equal(earningsCalendarNeedsBuild(retryWeek.range, retryPath, new Date('2026-01-06T12:00:00.000Z')), false, 'A successful rollover scan must not repeat solely because primary-only rows remain.');

    retryWeek.summary.fetches.secondaryCalendar.rows = 0;
    fs.writeFileSync(retryPath, JSON.stringify(retryWeek));
    assert.equal(earningsCalendarNeedsBuild(retryWeek.range, retryPath, new Date('2026-01-06T12:00:00.000Z')), true, 'A rollover scan that returned no rows may retry on the next Central-time day.');
    assert.equal(earningsCalendarFailedAttemptNeedsRetry(retryWeek.range, retryPath, new Date('2026-01-06T12:00:00.000Z')), true);

    retryWeek.summary.fetches.secondaryCalendar = {
      provider: 'alpha_vantage',
      requests: 1,
      ok: 0,
      skipped: 0,
      rows: 0,
      errors: [{ date: '2026-01-05', status: 429, error: 'HTTP 429' }]
    };
    fs.writeFileSync(retryPath, JSON.stringify(retryWeek));
    assert.equal(earningsCalendarNeedsBuild(retryWeek.range, retryPath, new Date('2026-01-05T23:00:00.000Z')), false, 'Do not repeat a failed metered scan during the same Central-time day.');
    assert.equal(earningsCalendarFailedAttemptNeedsRetry(retryWeek.range, retryPath, new Date('2026-01-05T23:00:00.000Z')), false);
    assert.equal(earningsCalendarNeedsBuild(retryWeek.range, retryPath, new Date('2026-01-06T12:00:00.000Z')), true, 'A failed rollover scan may retry on the next Central-time day.');
  } finally {
    fs.rmSync(retryDir, { recursive: true, force: true });
  }

  const scheduledRows = buildRows([
    finnhubRow('SCHEDULED', {
      reportDate: '2026-01-08',
      reportTiming: 'bmo',
      eps: { estimate: 1, actual: null },
      revenue: { estimate: 1000000000, actual: null }
    })
  ], [profile('SCHEDULED')], { usListings: [usListing('SCHEDULED')] });
  scheduledRows[0].sourceAudit.scheduleVerification = {
    status: 'corroborated',
    primaryDate: scheduledRows[0].reportDate,
    secondaryDates: [scheduledRows[0].reportDate],
    official: null
  };
  const scheduledCanonicalRows = attachReactions(scheduledRows, [], {
    asOf: canonical.generatedAt
  });
  assert.equal(scheduledCanonicalRows[0].lifecycle, 'scheduled');
  scheduledCanonicalRows[0].outcome.interpretation = 'Consensus estimates remain the key setup before the scheduled report.';
  scheduledCanonicalRows[0].outcome.guide = 'No company guidance update available yet.';
  canonical.rows.push(scheduledCanonicalRows[0]);
  canonical.narrativeApply.applied.push({
    symbol: 'SCHEDULED',
    reportDate: '2026-01-08'
  });
  canonical.summary.counts = computeEarningsWeekCounts(canonical.rows);

  const carriedCheckedAt = '2026-01-08T13:00:00.000Z';
  const carried = buildEarningsPreparationFallback(canonical, canonical.range, {
    checkedAt: carriedCheckedAt
  });
  assert.equal(carried.mode, 'carried_forward');
  assert.equal(carried.week.rows.length, canonical.rows.length);
  assert.equal(carried.week.generatedAt, carriedCheckedAt);
  assert.equal(carried.week.availability.status, 'carried_forward');
  assert.equal(carried.week.rows.find((row) => row.symbol === 'SCHEDULED').lifecycle, 'awaiting_actual');
  validateWeekPayload(carried.week);

  const unavailable = buildEarningsPreparationFallback(canonical, {
    from: '2026-01-09',
    to: '2026-01-15'
  }, { checkedAt: '2026-01-09T22:00:00.000Z' });
  assert.equal(unavailable.mode, 'unavailable');
  assert.equal(unavailable.week.rows.length, 0);
  assert.equal(unavailable.week.availability.status, 'unavailable');
  validateWeekPayload(unavailable.week);
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

function testAlphaVantageCalendarBackupFlow() {
  const dates = ['2026-01-06', '2026-01-07'];
  const args = { from: '2026-01-05', to: '2026-01-09', displayDates: displayDatesForRange('2026-01-05', '2026-01-09') };
  const days = alphaVantageCalendarFromResponse({
    ok: true,
    status: 200,
    ms: 12,
    body: [
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfDay',
      'RECOVERAV,"Recover, Alpha Inc",2026-01-06,2025-12-31,1.23,USD,post-market',
      'TIMEFALL,Timing Fallback Inc,2026-01-06,2025-12-31,0.50,USD,post-market',
      'OUTSIDE,Outside Corp,2026-02-01,2025-12-31,0.10,USD,'
    ].join('\n')
  }, args, dates);
  assert.equal(days.length, 2);
  assert.equal(days[0].ok, true);
  assert.equal(days[0].rowCount, 2);
  const parsedRow = days[0].rows.find((row) => row.symbol === 'RECOVERAV');
  assert.equal(parsedRow.company, 'Recover, Alpha Inc');
  assert.equal(parsedRow.reportTiming, 'amc');
  assert.equal(parsedRow.fiscalQuarter, 4);
  assert.equal(parsedRow.fiscalYear, 2025);
  assert.equal(parsedRow.eps.estimate, 1.23);

  const recoveryCandidates = buildSecondaryRecoveryCandidates(
    [finnhubRow('ANCHOR')],
    days,
    [profile('ANCHOR'), profile('RECOVERAV'), profile('TIMEFALL')],
    [usListing('ANCHOR'), usListing('RECOVERAV'), usListing('TIMEFALL')]
  );
  const recovery = recoveryCandidates.find((task) => task.symbol === 'RECOVERAV');
  assert.ok(recovery, 'Alpha-only display candidates should be queued for EarningsAPI company recovery.');
  assert.equal(recovery.sourceAudit.alphaVantageCalendar.company, 'Recover, Alpha Inc');
  assert.equal(recovery.trigger, 'missing_from_finnhub_but_present_in_alphaVantageCalendar');

  const resolution = resolveProviderDateConflicts(
    [finnhubRow('TIMEFALL', { reportTiming: 'unknown' })],
    days
  );
  const builtRows = buildRows(resolution.finnhubRows, [profile('TIMEFALL')], {
    secondaryCalendarDays: resolution.secondaryCalendarDays,
    usListings: [usListing('TIMEFALL')]
  });
  assert.equal(builtRows[0].reportTiming, 'amc');
  assert.equal(builtRows[0].sourceAudit.selectedSources.slate, 'finnhub');
  assert.equal(builtRows[0].sourceAudit.selectedSources.timing, 'alphaVantageCalendar');
  assert.equal(builtRows[0].sourceAudit.alphaVantageCalendar.reportTiming, 'amc');
}

function testSkipEarningsApiDoesNotReadUsageLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-earningsapi-skip-'));
  const usageFile = path.join(dir, 'earningsapi_usage.json');
  try {
    fs.writeFileSync(usageFile, '{broken');
    assert.deepEqual(
      earningsApiUsageForBuild({ skipEarningsApi: true, earningsApiUsage: usageFile }),
      emptyEarningsApiUsage()
    );
    assert.deepEqual(
      earningsApiUsageForBuild({ earningsApiUsage: usageFile }),
      emptyEarningsApiUsage()
    );
    assert.equal(fs.readFileSync(usageFile, 'utf8'), '{broken');
    assert.throws(
      () => earningsApiUsageForBuild({ useEarningsApi: true, skipEarningsApi: false, earningsApiUsage: usageFile }),
      /EarningsAPI usage ledger is unreadable/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testRefreshEarningsApiIsOptIn() {
  const source = deterministicVerifiedWeekFixture();
  const row = source.rows[0];
  row.sourceAudit.selectedSources.slate = 'alphaVantageCalendar';
  let calls = 0;
  const data = await collectRefreshData(source, {
    asOf: '2026-01-07T22:00:00.000Z',
    timeoutMs: 1000,
    earningsApiUsage: 'generated/earningsapi_usage.json',
    earningsApiDailyLimit: 100,
    earningsApiReserve: 0
  }, {
    env: { EARNINGSAPI_API_KEY: 'test' },
    readEarningsApiUsage: () => {
      throw new Error('usage ledger should not be read without opt-in');
    },
    fetchEarningsApiCompanyRows: async () => {
      calls += 1;
      throw new Error('EarningsAPI should not be called without opt-in');
    },
    fetchYahooBars: async (symbol) => ({ symbol, ok: true, status: 200, responseMs: 1, error: '', bars: [] })
  });
  assert.equal(calls, 0);
  assert.equal(Object.values(data.rowDiagnosticsByKey)[0][0].code, 'budget_unavailable');
}

function testSecondaryRecoveryAndRevenueComparison() {
  const anchor = finnhubRow('ANCHOR');
  const recoveredFullCalendar = alphaVantageRow('RECOVERFULL');
  const recoveredEpsOnlyCalendar = alphaVantageRow('RECOVEREPS');
  const profiles = [profile('ANCHOR'), profile('RECOVERFULL'), profile('RECOVEREPS')];
  const secondaryRecoveryCandidates = buildSecondaryRecoveryCandidates(
    [anchor],
    [{ date: anchor.reportDate, rows: [recoveredFullCalendar, recoveredEpsOnlyCalendar] }],
    profiles,
    [usListing('ANCHOR'), usListing('RECOVERFULL'), usListing('RECOVEREPS')]
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
  const full = recoveredRows.find((row) => row.symbol === 'RECOVERFULL');
  const epsOnly = recoveredRows.find((row) => row.symbol === 'RECOVEREPS');

  assert.deepEqual(
    secondaryRecoveryCandidates.map((task) => task.symbol).sort(),
    ['RECOVEREPS', 'RECOVERFULL'],
    'Finnhub-missing display candidates should be selected for secondary recovery.'
  );
  assert.equal(full.sourceAudit.selectedSources.slate, 'alphaVantageCalendar');
  assert.equal(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').sourceAudit.alphaVantageCalendar.eps, undefined);
  assert.equal(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').neededFields.includes('eps.estimate'), true);
  assert.equal(secondaryRecoveryCandidates.find((task) => task.symbol === 'RECOVERFULL').neededFields.includes('epsEstimate'), false);
  assert.deepEqual(enrichedSecondaryCandidates.find((task) => task.symbol === 'RECOVERFULL').sourceAudit.earningsApiCompany.selectedRow, {
    reportDate: '2026-01-06',
    reportTiming: 'amc'
  });
  assert.equal(full.sourceAudit.earningsApiCompany.selectedRow.revenue, undefined);
  assert.equal(full.revenue.estimate, 1000000000);
  assert.equal(full.revenue.actual, 1200000000);
  assert.equal(full.sourceAudit.selectedSources.revenue.estimate, 'earningsApiCompany');
  assert.equal(full.sourceAudit.selectedSources.revenue.actual, 'earningsApiCompany');
  assert.equal(full.revenue.result, 'beat', 'Revenue comparison should be allowed when EarningsAPI supplies estimate and actual.');
  assert.equal(full.outcome.overall, 'beat', 'Full EPS/revenue recovery should not collapse to EPS-only.');

  assert.equal(epsOnly.sourceAudit.selectedSources.revenue.estimate, 'none');
  assert.equal(epsOnly.sourceAudit.selectedSources.revenue.actual, 'earningsApiCompany');
  assert.equal(epsOnly.eps.result, 'beat');
  assert.equal(epsOnly.revenue.result, 'not_compared');
  assert.equal(epsOnly.outcome.overall, 'eps_only_beat', 'EPS-only outcome should appear only when revenue estimate is unavailable.');
}

function zacksTable(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function testZacksPrimaryBuildContract() {
  const headers = ['Symbol', 'Company', 'Market Cap', 'Time', 'Expected', 'Reported', 'Surprise'];
  const eps = parseZacksTable({
    ok: true,
    status: 200,
    responseMs: 1,
    date: '2026-01-06',
    body: zacksTable(headers, [[
      '<a href="/stock/quote/ZZZZ">ZZZZ Quick Quote</a>',
      'Zeta Zacks Corp',
      '$150.25B',
      '06:30',
      '1.25',
      '1.50',
      '20.00%'
    ]])
  }, 'eps');
  const revenue = parseZacksTable({
    ok: true,
    status: 200,
    responseMs: 1,
    date: '2026-01-06',
    body: zacksTable(headers, [[
      '<a href="/stock/quote/ZZZZ">ZZZZ Quick Quote</a>',
      'Zeta Zacks Corp',
      '$150.25B',
      'amc',
      '1,100.00',
      '1,250.50',
      '13.68%'
    ]])
  }, 'revenue');
  const days = [{ date: '2026-01-06', eps, revenue }];
  assert.equal(eps.ok, true);
  assert.equal(revenue.ok, true);
  assert.deepEqual(zacksGate(days, ['2026-01-06']).failures, []);
  const rows = attachReactions(buildZacksRows(days, { observedAt: '2026-01-06T15:00:00.000Z' }), [], { asOf: '2026-01-06T15:00:00.000Z' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ZZZZ');
  assert.equal(rows[0].reportTiming, 'bmo');
  assert.equal(rows[0].actualsObservedAt, '2026-01-06T15:00:00.000Z');
  assert.equal(rows[0].marketCap, 150250000000);
  assert.equal(rows[0].revenue.actual, 1250500000);
  assert.equal(rows[0].sourceAudit.zacks.schedule.reportTiming, 'bmo');
  assert.equal(rows[0].sourceAudit.zacks.revenue.raw.Time, 'amc');
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0].sourceAudit.zacks.revenue, 'reportTiming'), false);
  assert.equal(rows[0].sourceAudit.selectedSources.slate, 'zacks');
  assert.equal(rows[0].sourceAudit.selectedSources.revenue.actual, 'zacks');
  assert.deepEqual(validateEarningsWeekPayload({
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: '2026-01-06T15:00:00.000Z',
    range: { from: '2026-01-05', to: '2026-01-09' },
    rows,
    summary: { counts: computeEarningsWeekCounts(rows) },
    outputPath: 'generated/earnings_week.json'
  }), []);

  const misaligned = zacksGate([{ date: '2026-01-06', eps, revenue: { ...revenue, rows: [] } }], ['2026-01-06']);
  assert.equal(misaligned.ok, false);
  assert.equal(misaligned.failures.some((failure) => failure.code === 'zacks_revenue_table_unavailable' || failure.code === 'zacks_sales_alignment_failure'), true);

  const liveShape = parseZacksTable({
    ok: true,
    status: 200,
    responseMs: 1,
    date: '2026-07-22',
    body: `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody><tr>
      <th><button rel="SCHW">SCHW Quick Quote</button><a href="//www.zacks.com/stock/quote/SCHW" rel="SCHW">SCHW</a></th>
      <td>Charles Schwab</td>
      <td>178,330.95</td>
      <td>bmo</td>
      <td>1.53</td>
      <td>1.62</td>
      <td>5.88%</td>
    </tr></tbody></table>`
  }, 'eps');
  assert.equal(liveShape.rows[0].symbol, 'SCHW');
  assert.equal(liveShape.rows[0].company, 'Charles Schwab');
  assert.equal(liveShape.rows[0].reportTiming, 'bmo');
  assert.equal(liveShape.rows[0].marketCap, 178330950000);
  assert.equal(liveShape.rows[0].actual, 1.62);
}

function testZacksListingFilterUsesFinnhubDirectory() {
  const headers = ['Symbol', 'Company', 'Market Cap', 'Time', 'Expected', 'Reported', 'Surprise'];
  const symbolCell = (symbol) => `<a href="/stock/quote/${symbol}">${symbol} Quick Quote</a>`;
  const tableRows = [
    [symbolCell('LISTADR'), 'Listed ADR Corp', '$50.00B', 'bmo', '1.00', '--', '--'],
    [symbolCell('OTCADR'), 'OTC ADR Corp', '$60.00B', 'bmo', '1.00', '--', '--'],
    [symbolCell('OTCCOM'), 'OTC Common Corp', '$70.00B', 'bmo', '1.00', '--', '--'],
    [symbolCell('MISSING'), 'Missing Directory Corp', '$80.00B', 'bmo', '1.00', '--', '--']
  ];
  const eps = parseZacksTable({
    ok: true,
    status: 200,
    responseMs: 1,
    date: '2026-01-06',
    body: zacksTable(headers, tableRows)
  }, 'eps');
  const revenue = parseZacksTable({
    ok: true,
    status: 200,
    responseMs: 1,
    date: '2026-01-06',
    body: zacksTable(headers, tableRows.map((row) => [...row.slice(0, 4), '1,000.00', '--', '--']))
  }, 'revenue');
  const rows = buildZacksRows([{ date: '2026-01-06', eps, revenue }], { observedAt: '2026-01-06T15:00:00.000Z' });
  assert.deepEqual(rows.map((row) => row.symbol), ['MISSING', 'OTCCOM', 'OTCADR', 'LISTADR']);

  const result = filterZacksRowsByFinnhubUsListings(rows, {
    ok: true,
    listings: [
      usListing('LISTADR', { type: 'ADR', mic: 'XNYS' }),
      usListing('OTCADR', { type: 'ADR', mic: 'OOTC' }),
      usListing('OTCCOM', { type: 'Common Stock', mic: 'OOTC' })
    ]
  });
  assert.deepEqual(result.rows.map((row) => row.symbol), ['LISTADR']);
  assert.deepEqual(result.rows[0].sourceAudit.finnhubUsListing, usListing('LISTADR', { type: 'ADR', mic: 'XNYS' }));
  assert.equal(result.summary.mode, 'classified');
  assert.equal(result.summary.inputRows, 4);
  assert.equal(result.summary.keptRows, 1);
  assert.equal(result.summary.droppedRows, 3);
  assert.deepEqual(
    result.summary.dropped.map((row) => [row.symbol, row.reason, row.mic || '']),
    [
      ['MISSING', 'missing_exact_finnhub_us_listing', ''],
      ['OTCCOM', 'otc_or_pink_mic', 'OOTC'],
      ['OTCADR', 'otc_or_pink_mic', 'OOTC']
    ]
  );

  const unfiltered = filterZacksRowsByFinnhubUsListings(rows, {
    ok: false,
    listings: [],
    error: 'directory unavailable'
  });
  assert.deepEqual(unfiltered.rows.map((row) => row.symbol), rows.map((row) => row.symbol));
  assert.equal(unfiltered.summary.mode, 'unavailable_unfiltered');
  assert.equal(unfiltered.summary.reason, 'finnhub_us_symbol_directory_unavailable');
}

function unknownTimingReactionRow(actualsObservedAt) {
  return {
    symbol: 'ADR',
    company: 'ADR Fixture PLC',
    exchange: 'NYSE',
    country: 'US',
    currency: 'USD',
    marketCap: 30000000000,
    marketCapDisplay: '$30.00B',
    reportDate: '2026-01-06',
    reportTiming: 'unknown',
    actualsObservedAt,
    fiscalQuarterEnding: '',
    fiscalQuarter: null,
    fiscalYear: null,
    eps: { estimate: 1, actual: 1.1, surprisePercent: 10, result: 'beat', basis: '', note: '' },
    revenue: { estimate: 1000000000, actual: 1100000000, surprisePercent: 10, result: 'beat', note: '' },
    outcome: { overall: 'beat', guide: '', interpretation: '' },
    reaction: { basis: 'unavailable', percent: null, fromDate: '', fromClose: null, toDate: '', toClose: null, status: 'unavailable', note: '', source: '' },
    sourceStatus: 'partial',
    sourceSummary: { primary: 'zacks', fallbacks: [], reaction: 'none' },
    sourceAudit: {
      zacks: {
        schedule: { symbol: 'ADR', company: 'ADR Fixture PLC', reportDate: '2026-01-06', reportTiming: 'unknown', marketCap: 30000000000 },
        eps: { estimate: 1, actual: 1.1, surprisePercent: 10, raw: {} },
        revenue: { estimate: 1000000000, actual: 1100000000, surprisePercent: 10, raw: {} }
      },
      selectedSources: {
        slate: 'zacks',
        company: 'zacks',
        marketCap: 'zacks',
        timing: 'none',
        eps: { estimate: 'zacks', actual: 'zacks' },
        revenue: { estimate: 'zacks', actual: 'zacks' },
        reaction: 'none'
      }
    }
  };
}

function testUnknownTimingActualObservationDrivesReactionBasis() {
  const bars = [
    { date: '2026-01-05', close: 100 },
    { date: '2026-01-06', close: 110 },
    { date: '2026-01-07', close: 121 }
  ];
  const yahooFetches = [{ symbol: 'ADR', ok: true, status: 200, responseMs: 1, error: '', bars }];
  const sameDay = attachReactions([unknownTimingReactionRow('2026-01-06T15:00:00.000Z')], yahooFetches, { asOf: '2026-01-06T22:00:00.000Z' })[0];
  assert.equal(sameDay.reportTiming, 'unknown');
  assert.equal(sameDay.reaction.basis, 'same_day_close');
  assert.equal(sameDay.reaction.status, 'computed');
  assert.equal(sameDay.reaction.fromDate, '2026-01-05');
  assert.equal(sameDay.reaction.toDate, '2026-01-06');
  assert.ok(Math.abs(sameDay.reaction.percent - 10) < 0.0001);
  assert.deepEqual(validateEarningsWeekPayload({
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: '2026-01-06T22:00:00.000Z',
    range: { from: '2026-01-05', to: '2026-01-09' },
    rows: [sameDay],
    summary: { counts: computeEarningsWeekCounts([sameDay]) },
    outputPath: 'generated/earnings_week.json'
  }), []);

  const nextSession = attachReactions([unknownTimingReactionRow('2026-01-07T13:00:00.000Z')], yahooFetches, { asOf: '2026-01-07T22:00:00.000Z' })[0];
  assert.equal(nextSession.reaction.basis, 'next_session_close');
  assert.equal(nextSession.reaction.status, 'computed');
  assert.equal(nextSession.reaction.fromDate, '2026-01-06');
  assert.equal(nextSession.reaction.toDate, '2026-01-07');
  assert.ok(Math.abs(nextSession.reaction.percent - 10) < 0.0001);
}

function testZacksVisibleDateMapping() {
  const displayDates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  assert.equal(
    zacksVisibleDateFromButtonText('WED JUL 22 Earnings & Sales 154 Reported', displayDates),
    '2026-07-22'
  );
  assert.equal(
    zacksEndpointDateFromUrl('https://www.zacks.com/data_handler/earnings_calendar/calendar_handlers.php?calltype=eventscal&date=1784782800&type=1&search_trigger=0'),
    '1784782800'
  );
}

function testEarningsGuidanceChoosesSameEventFiling() {
  const filing = chooseEarningsFiling({
    symbol: 'TXN',
    reportDate: '2026-07-22'
  }, {
    accessionNumber: ['older', 'same-day-6k', 'same-day-8k', 'nearby-8k'],
    primaryDocument: ['older.htm', 'foreign.htm', 'txn-20260722.htm', 'nearby.htm'],
    filingDate: ['2026-07-19', '2026-07-22', '2026-07-22', '2026-07-23'],
    acceptanceDateTime: ['20260719170000', '20260722120000', '20260722160500', '20260723160500'],
    form: ['8-K', '6-K', '8-K', '8-K'],
    items: ['7.01,9.01', '', '2.02,9.01', '2.02,9.01']
  });

  assert.equal(filing.accessionNumber, 'same-day-8k');
  assert.equal(filing.primaryDocument, 'txn-20260722.htm');
}

function testEarningsGuidanceExhibitSelectionUsesWrapperLabels() {
  const cases = [
    { symbol: 'TXN', primary: 'txn-20260722.htm', expected: ['q22026txnex99-eredgar.htm'], html: ['q22026txnex99-eredgar.htm'] },
    { symbol: 'NOW', primary: 'now-20260722.htm', expected: ['erq2fy26.htm'], html: ['erq2fy26.htm'] },
    { symbol: 'IBM', primary: 'ibm-20260722.htm', expected: ['ibm-20260722xex991.htm', 'ibm-20260722xex992.htm'], html: ['ibm-20260722xex991.htm', 'ibm-20260722xex992.htm'] },
    { symbol: 'GOOGL', primary: 'goog-20260722.htm', expected: ['googexhibit991q22026.htm'], html: ['googexhibit991q22026.htm'] },
    { symbol: 'T', primary: 't-20260722.htm', expected: ['t-2q2026exhibit991.htm', 't-2q2026exhibit992.htm'], html: ['t-2q2026exhibit991.htm', 't-2q2026exhibit992.htm', 't-2q2026exhibit993.htm'] },
    { symbol: 'PM', primary: 'pm-20260722.htm', expected: ['earningsreleasepm-ex991xq2.htm'], html: ['earningsreleasepm-ex991xq2.htm', 'glossaryselectfininfoandno.htm'] },
    {
      symbol: 'CCI',
      primary: 'cci-20260723.htm',
      expected: ['q22026earningsrelease.htm'],
      html: ['q22026earningsrelease.htm', 'q22026supplement.htm'],
      detailHtml: `
        <tr><td>2</td><td>EARNINGS RELEASE</td><td><a href="q22026earningsrelease.htm">q22026earningsrelease.htm</a></td><td>EX-99.1</td><td>42000</td></tr>
        <tr><td>3</td><td>SUPPLEMENT</td><td><a href="q22026supplement.htm">q22026supplement.htm</a></td><td>EX-99.2</td><td>250000</td></tr>
        <tr><td>4</td><td>EX-99.3</td><td><a href="q22026trendreport_ex993.htm">q22026trendreport_ex993.htm</a></td><td>EX-99.3</td><td>175000</td></tr>
      `
    },
    {
      symbol: 'NTRS',
      primary: 'ntrs-20260723.htm',
      expected: ['q22026earningsreleaseex991.htm'],
      html: ['q22026earningsreleaseex991.htm', 'q22026presentationmateri.htm'],
      detailHtml: `
        <tr><td>2</td><td>EARNINGS RELEASE</td><td><a href="q22026earningsreleaseex991.htm">q22026earningsreleaseex991.htm</a></td><td>EX-99.1</td><td>43000</td></tr>
        <tr><td>3</td><td>PRESENTATION MATERIALS</td><td><a href="q22026presentationmateri.htm">q22026presentationmateri.htm</a></td><td>EX-99.2</td><td>210000</td></tr>
      `
    },
    { symbol: 'SCHW', primary: 'schw-20260721.htm', expected: ['a2q26exhibit991.htm'], html: ['a2q26exhibit991.htm'] },
    {
      symbol: 'NVS',
      primary: 'nvs-20260630.htm',
      expected: ['nvs-20260630-99_1.htm', 'nvs-20260630-99_2.htm'],
      html: ['nvs-20260630-99_1.htm', 'nvs-20260630-99_2.htm'],
      form: '6-K',
      detailHtml: `
        <tr><td>1</td><td>6-K</td><td><a href="nvs-20260630.htm">nvs-20260630.htm</a></td><td>6-K</td><td>9658</td></tr>
        <tr><td>2</td><td>99.1 FINANCIAL REPORT Q2 2026</td><td><a href="nvs-20260630-99_1.htm">nvs-20260630-99_1.htm</a></td><td>EX-99</td><td>147183</td></tr>
        <tr><td>3</td><td>99.2 INTERIM FINANCIAL REPORT</td><td><a href="nvs-20260630-99_2.htm">nvs-20260630-99_2.htm</a></td><td>EX-99</td><td>2280708</td></tr>
        <tr><td>4</td><td>XBRL TAXONOMY EXTENSION SCHEMA DOCUMENT</td><td><a href="nvs-20260630.xsd">nvs-20260630.xsd</a></td><td>EX-101.SCH</td><td>605158</td></tr>
      `
    },
    {
      symbol: 'SAN',
      primary: 'q22026earningspresentati.htm',
      expected: ['q22026earningspresentati.htm'],
      html: [],
      form: '6-K',
      detailHtml: '<tr><td>1</td><td>6-K</td><td><a href="q22026earningspresentati.htm">q22026earningspresentati.htm</a></td><td>6-K</td><td>114916</td></tr>'
    },
    {
      symbol: 'EQNR',
      primary: 'equinorfinancialstatements.htm',
      expected: ['equinorfinancialstatements.htm'],
      html: [],
      form: '6-K',
      detailHtml: `
        <tr><td>1</td><td>EQUINOR SECOND QUARTER 2026 REPORT</td><td><a href="equinorfinancialstatements.htm">equinorfinancialstatements.htm</a></td><td>6-K</td><td>5453289</td></tr>
        <tr><td>12</td><td>GRAPHIC</td><td><a href="crop_tle-dsc00299a.jpg">crop_tle-dsc00299a.jpg</a></td><td>GRAPHIC</td><td>1536550</td></tr>
      `
    }
  ];

  for (const item of cases) {
    const names = [
      `0000000000-26-000001-index-headers.html`,
      `0000000000-26-000001-index.html`,
      item.primary,
      ...item.html,
      'R1.htm'
    ];
    const indexData = {
      directory: {
        item: names.map((name, index) => ({ name, size: String(1000 + index * 500) }))
      }
    };
    const primaryHtml = item.html
      .map((name, index) => `<tr><td>EX-99.${index + 1}</td><td><a href="${name}">${name}</a></td></tr>`)
      .join('\n');
    const selected = chooseExhibitDocuments(indexData, { primaryDocument: item.primary, form: item.form || '8-K' }, primaryHtml, item.detailHtml || '');
    assert.deepEqual(
      selected.map((document) => document.name),
      item.expected,
      `${item.symbol} should select the current earnings release exhibit document(s).`
    );
  }
}

function testEarningsGuidanceExhibitSelectionPrefersDetailTableMetadata() {
  const indexData = {
    directory: {
      item: [
        { name: 'xom-20260501.htm', size: '40000' },
        { name: 'livef8k1q26991.htm', size: '25000' },
        { name: 'livef8k1q26992.htm', size: '95000' },
        { name: 'xom-20260501xbrl.xml', size: '100000' },
        { name: 'xomgraphic.jpg', size: '200000' }
      ]
    }
  };
  const detailHtml = `
    <table>
      <tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
      <tr><td>1</td><td>FORM 8-K</td><td><a href="/Archives/edgar/data/34088/000003408826000065/xom-20260501.htm">xom-20260501.htm</a></td><td>8-K</td><td>40000</td></tr>
      <tr><td>2</td><td>NEWS RELEASE</td><td><a href="/Archives/edgar/data/34088/000003408826000065/livef8k1q26991.htm">livef8k1q26991.htm</a></td><td>EX-99.1</td><td>25000</td></tr>
      <tr><td>3</td><td>INVESTOR RELATIONS DATA SUMMARY</td><td><a href="/Archives/edgar/data/34088/000003408826000065/livef8k1q26992.htm">livef8k1q26992.htm</a></td><td>EX-99.2</td><td>95000</td></tr>
      <tr><td>4</td><td>XBRL INSTANCE DOCUMENT</td><td><a href="/Archives/edgar/data/34088/000003408826000065/xom-20260501xbrl.xml">xom-20260501xbrl.xml</a></td><td>XML</td><td>100000</td></tr>
      <tr><td>5</td><td>GRAPHIC</td><td><a href="/Archives/edgar/data/34088/000003408826000065/xomgraphic.jpg">xomgraphic.jpg</a></td><td>GRAPHIC</td><td>200000</td></tr>
    </table>
  `;
  const selected = chooseExhibitDocuments(indexData, { primaryDocument: 'xom-20260501.htm' }, '', detailHtml);

  assert.deepEqual(selected.map((document) => document.name), ['livef8k1q26991.htm']);
  assert.equal(selected[0].source, 'filing_detail_table');
  assert.equal(selected[0].description, 'NEWS RELEASE');
  assert.equal(selected[0].exhibitType, 'EX-99.1');
}

function testEarningsGuidanceSignalsAndIndex() {
  const snippets = guidanceSignalsFromText(`
    The company expects third quarter revenue of $5.1 billion to $5.5 billion and non-GAAP earnings per share of $1.40 to $1.60.
    Management also discussed product demand and cost savings.
  `);
  assert.equal(snippets.length, 1);
  assert.match(snippets[0].text, /expects third quarter revenue/);

  const index = buildEarningsGuidanceEvidenceIndex({
    schemaVersion: 1,
    generatedAt: '2026-07-23T20:00:00.000Z',
    source: 'sec_edgar',
    sourceUse: 'editorial_guidance_evidence',
    summary: { targetCount: 1, available: 1, guidanceSignalCount: 1, byStatus: { available: 1 } },
    rows: [{
      key: 'TXN:2026-07-22',
      symbol: 'TXN',
      reportDate: '2026-07-22',
      status: 'available',
      guidanceSignalCount: 1,
      filingUrl: 'https://www.sec.gov/Archives/example/txn.htm',
      documents: [{
        status: 'available',
        url: 'https://www.sec.gov/Archives/example/q22026txnex99-eredgar.htm'
      }]
    }]
  }, path.join(root, 'generated', 'editorial', 'earnings_week_guidance.json'));
  assert.equal(index.artifact, 'generated/editorial/earnings_week_guidance.json');
  assert.equal(index.rows[0].evidenceRef, 'generated/editorial/earnings_week_guidance.json#TXN:2026-07-22');
  assert.equal(index.rows[0].primaryUrl, 'https://www.sec.gov/Archives/example/q22026txnex99-eredgar.htm');
}

async function testEarningsGuidanceEvidenceIncludesLegacyBackupRows() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-earnings-guidance-legacy-'));
  try {
    const output = path.join(dir, 'earnings_week_guidance.json');
    const legacyRow = {
      symbol: 'LEGACY',
      company: 'Legacy Backup Corp',
      marketCap: 30000000000,
      reportDate: '2026-07-22',
      reportTiming: 'bmo',
      eps: { estimate: 1, actual: 1.25 },
      revenue: { estimate: 1000000000, actual: 1200000000 },
      sourceAudit: {
        selectedSources: {
          slate: 'alphaVantageCalendar',
          eps: { estimate: 'earningsApiCompany', actual: 'earningsApiCompany' },
          revenue: { estimate: 'earningsApiCompany', actual: 'earningsApiCompany' }
        },
        finnhubUsListing: { symbol: 'LEGACY', market: 'US', mic: 'XNYS' }
      }
    };
    const week = {
      range: { from: '2026-07-20', to: '2026-07-24' },
      rows: [legacyRow]
    };
    const before = structuredClone(legacyRow);
    const { payload, index } = await writeEarningsGuidanceEvidence(week, output, {
      asOf: '2026-07-23T20:00:00.000Z',
      networkDisabled: true,
      sourceArtifact: 'generated/earnings_week.json'
    });
    assert.equal(payload.sourceUse, 'editorial_guidance_evidence');
    assert.deepEqual(payload.rows.map((row) => row.key), ['LEGACY:2026-07-22']);
    assert.equal(payload.rows[0].status, 'network_disabled');
    assert.deepEqual(index.rows.map((row) => row.key), ['LEGACY:2026-07-22']);
    assert.deepEqual(legacyRow, before, 'SEC guidance evidence must not mutate deterministic provider facts.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testApplyEarningsNarrative() {
  const rows = buildRows(
    [finnhubRow('NARRATIVE')],
    [profile('NARRATIVE')],
    { usListings: [usListing('NARRATIVE')] }
  );
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
  assert.equal(row.outcome.guidanceDisposition.status, 'verified');
  assert.equal(row.outcome.interpretationDisposition.status, 'verified');
  assert.equal(row.reaction.commentaryDisposition.status, 'verified');
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
  assert.deepEqual(validateEarningsWeekPayload(source), []);

  const staged = buildEarningsNarrativeSidecar(source, { rows: [] }, {
    outputPath: 'generated/editorial/earnings_narrative.json'
  }).payload;
  const unavailable = applyEarningsNarrative(source, staged, {
    sourceArtifact: 'generated/earnings_week.json',
    narrativeArtifact: 'generated/editorial/earnings_narrative.json',
    appliedAt: '2026-01-08T22:05:00.000Z'
  });
  assert.deepEqual(validateEarningsWeekPayload(unavailable), []);
  assert.equal(unavailable.rows[0].outcome.interpretationDisposition.status, 'commentary_unavailable');
  assert.equal(unavailable.rows[0].outcome.guidanceDisposition.status, 'unverified');
  assert.equal(unavailable.rows[0].reaction.commentaryDisposition.status, 'commentary_unavailable');
  assert.equal(unavailable.rows[0].outcome.interpretationDisposition.attemptedAt, '2026-01-08T22:05:00.000Z');
  staged.rows[0].outcome.interpretation = originalNarrative.outcome.interpretation;
  staged.rows[0].outcome.interpretationDisposition = { status: 'verified' };
  staged.rows[0].outcome.guide = originalNarrative.outcome.guide;
  staged.rows[0].outcome.guidanceDisposition = { status: 'verified' };
  staged.rows[0].reaction.note = originalNarrative.reaction.note;
  staged.rows[0].reaction.commentaryDisposition = { status: 'verified' };
  const finalized = applyEarningsNarrative(source, staged, {
    sourceArtifact: 'generated/earnings_week.json',
    narrativeArtifact: 'generated/editorial/earnings_narrative.json'
  });

  assert.deepEqual(validateEarningsWeekPayload(finalized), []);

  const pending = structuredClone(source.rows[0]);
  pending.outcome.overall = 'pending';
  pending.lifecycle = 'awaiting_actual';
  pending.reaction = { status: 'pending', note: '' };
  assert.equal(
    narrativeEditorialComplete(pending, { outcome: {}, reaction: {} }),
    false,
    'A visible row awaiting actuals still requires its reviewed pre-release thesis.'
  );
  assert.equal(
    narrativeEditorialComplete(pending, {
      outcome: {
        interpretation: 'Demand and margins remain the key pre-release watch items.',
        interpretationDisposition: { status: 'verified' }
      },
      reaction: {}
    }),
    true,
    'A reviewed pre-release thesis completes the editorial requirement while actuals remain unavailable.'
  );

  const releasedAwaitingClose = {
    ...pending,
    lifecycle: 'released_awaiting_close',
    outcome: { overall: 'mixed' },
    reaction: { status: 'awaiting_close', note: '' }
  };
  assert.equal(
    narrativeEditorialComplete(releasedAwaitingClose, {
      outcome: {
        interpretation: 'Revenue conversion and costs are the key post-release issues.',
        interpretationDisposition: { status: 'verified' }
      },
      reaction: {}
    }),
    false,
    'A released row must not finalize before its earnings-release guidance has been reviewed.'
  );
  assert.equal(
    narrativeEditorialComplete(releasedAwaitingClose, {
      outcome: {
        interpretation: 'Revenue conversion and costs are the key post-release issues.',
        interpretationDisposition: { status: 'verified' },
        guidanceDisposition: {
          status: 'not_provided',
          evidenceSource: 'official_company',
          evidenceUrl: 'https://example.com/earnings-release'
        }
      },
      reaction: {}
    }),
    true,
    'A release-time no-guidance conclusion must be explicitly evidenced before finalization.'
  );
}

function testUnavailableNarrativeDispositionsRequireAuditFields() {
  const source = deterministicVerifiedWeekFixture();
  const attemptedAt = '2026-01-08T22:05:00.000Z';
  const unavailable = structuredClone(source);
  unavailable.rows[0].outcome.interpretation = '';
  unavailable.rows[0].outcome.interpretationDisposition = {
    status: 'commentary_unavailable',
    reason: 'not_verified_for_current_run',
    attemptedAt
  };
  unavailable.rows[0].outcome.guide = '';
  unavailable.rows[0].outcome.guidanceDisposition = {
    status: 'unverified',
    reason: 'not_verified_for_current_run',
    attemptedAt
  };
  unavailable.rows[0].reaction.note = '';
  unavailable.rows[0].reaction.commentaryDisposition = {
    status: 'commentary_unavailable',
    reason: 'not_verified_for_current_run',
    attemptedAt
  };
  assert.deepEqual(validateEarningsWeekPayload(unavailable), []);

  const missingInterpretationAudit = structuredClone(unavailable);
  missingInterpretationAudit.rows[0].outcome.interpretationDisposition = { status: 'commentary_unavailable' };
  assert.match(
    validateEarningsWeekPayload(missingInterpretationAudit).join('\n'),
    /interpretationDisposition\.status commentary_unavailable requires blank copy, non-empty reason, and ISO attemptedAt/,
    'Staging validation must reject unavailable interpretation dispositions without audit fields.'
  );

  const missingGuidanceAudit = structuredClone(unavailable);
  missingGuidanceAudit.rows[0].outcome.guidanceDisposition = { status: 'unverified' };
  assert.match(
    validateEarningsWeekPayload(missingGuidanceAudit).join('\n'),
    /guidanceDisposition\.status unverified requires blank copy, non-empty reason, and ISO attemptedAt/,
    'Staging validation must reject unverified guidance dispositions without audit fields.'
  );

  const missingReactionAudit = structuredClone(unavailable);
  missingReactionAudit.rows[0].reaction.commentaryDisposition = { status: 'commentary_unavailable' };
  assert.match(
    validateEarningsWeekPayload(missingReactionAudit).join('\n'),
    /reaction\.commentaryDisposition\.status commentary_unavailable requires blank copy, non-empty reason, and ISO attemptedAt/,
    'Staging validation must reject unavailable reaction dispositions without audit fields.'
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
  })], [profile('REFRESH')], { usListings: [usListing('REFRESH')] });
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
    summary: {
      counts: {
        total: 1,
        verified: 0,
        partial: 1,
        reactionComputed: 0,
        missingTiming: 0,
        missingRevenue: 0,
        missingMarketCap: 0,
        secondaryRecoveryCandidates: 0
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
  assert.equal(awaitingRow.outcome.interpretation, '', 'Reported actuals must invalidate pre-release commentary before the close response is available.');
  assert.equal(awaitingRow.reaction.note, '', 'Reported actuals must invalidate the prior reaction commentary before the close response is available.');

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
  assert.equal(result.payload.secondaryRecoveryCandidates.length, 0, 'Result refresh must not create a new secondary slate.');
}

async function testResultRefreshFailuresAreRowScoped() {
  const source = deterministicVerifiedWeekFixture();
  const key = earningsRowKey(source.rows[0]);
  const priorRow = structuredClone(source.rows[0]);
  const failure = await refreshEarningsResults(source, {
    finnhubRows: [],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [],
    rowDiagnosticsByKey: {
      [key]: [{
        provider: 'finnhub',
        code: 'provider_request_failed',
        message: 'Finnhub fixture failure.'
      }, {
        provider: 'yahoo',
        code: 'provider_request_failed',
        message: 'Yahoo fixture failure.'
      }]
    }
  }, {
    asOf: '2026-01-07T22:00:00.000Z'
  });
  const failedRow = failure.payload.rows[0];
  assert.equal(failure.failedRows, 1);
  assert.deepEqual(failedRow.eps, priorRow.eps, 'A failed result provider must retain the row’s prior EPS facts.');
  assert.deepEqual(failedRow.revenue, priorRow.revenue, 'A failed result provider must retain the row’s prior revenue facts.');
  assert.deepEqual(failedRow.reaction, priorRow.reaction, 'A failed Yahoo refresh must retain the row’s prior reaction.');
  assert.equal(failedRow.outcome.interpretation, priorRow.outcome.interpretation, 'A source failure alone must not invalidate verified narrative.');
  assert.equal(failedRow.sourceAudit.resultRefresh.status, 'partial');
  assert.deepEqual(failedRow.sourceAudit.resultRefresh.failures.map((item) => item.provider), ['finnhub', 'yahoo']);
  assert.equal(failedRow.sourceStatus, 'partial');
  assert.deepEqual(validateEarningsWeekPayload(failure.payload), []);
  const malformedDiagnostic = structuredClone(failure.payload);
  malformedDiagnostic.rows[0].sourceAudit.resultRefresh.failures[0].provider = 'unknown';
  assert.deepEqual(validateEarningsWeekPayload(malformedDiagnostic), [], 'Non-blocking row diagnostics must not block a renderable row.');

  const recovered = await refreshEarningsResults(failure.payload, {
    finnhubRows: [finnhubRow('VERIFY')],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'VERIFY', ok: true, status: 200, responseMs: 1, error: '',
      bars: [{ date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 105 }]
    }],
    rowDiagnosticsByKey: {}
  }, {
    asOf: '2026-01-07T22:05:00.000Z'
  });
  assert.equal(recovered.failedRows, 0);
  assert.equal(recovered.payload.rows[0].sourceAudit.resultRefresh, undefined, 'The next successful row refresh must clear its stale diagnostic.');
  assert.equal(recovered.payload.rows[0].sourceStatus, 'verified');
}

async function testManualRecoverySourceAuditRepair() {
  const recovered = deterministicVerifiedWeekFixture();
  delete recovered.rows[0].sourceAudit;
  assert.ok(validateEarningsWeekPayload(recovered).some((error) => error.includes('sourceAudit must be populated')));
  await assert.rejects(
    () => refreshEarningsResults(recovered, {}, { asOf: '2026-01-07T22:00:00.000Z' }),
    /missing sourceAudit\.selectedSources/
  );

  const repaired = repairRecoveredEarningsSourceAudit(recovered);
  assert.equal(repaired.rows[0].sourceAudit.recoveredFrom, 'manual_schedule_review');
  assert.equal(repaired.rows[0].sourceAudit.selectedSources.slate, 'finnhub');
  assert.deepEqual(validateEarningsWeekPayload(repaired), []);
  const refreshed = await refreshEarningsResults(repaired, {
    finnhubRows: [finnhubRow('VERIFY')],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'VERIFY', ok: true, status: 200, responseMs: 1, error: '',
      bars: [{ date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 105 }]
    }]
  }, { asOf: '2026-01-07T22:00:00.000Z' });
  assert.deepEqual(validateEarningsWeekPayload(refreshed.payload), []);
}

async function testYahooReactionFetchesSkipRowsWithoutActualsAndPreserveOrder() {
  const sourceRows = buildRows([
    finnhubRow('SKIP', {
      reportTiming: 'amc',
      eps: { estimate: 1, actual: null },
      revenue: { estimate: 1000000000, actual: null }
    }),
    finnhubRow('OLD', { reportTiming: 'amc' }),
    finnhubRow('FRESH', {
      reportTiming: 'amc',
      eps: { estimate: 1, actual: null },
      revenue: { estimate: 1000000000, actual: null }
    })
  ], [profile('SKIP'), profile('OLD'), profile('FRESH')], {
    usListings: [usListing('SKIP'), usListing('OLD'), usListing('FRESH')]
  });
  const source = {
    range: { from: '2026-01-06', to: '2026-01-10' },
    rows: sourceRows
  };
  const yahooCalls = [];
  const refreshData = await collectRefreshData(source, {
    asOf: '2026-01-07T22:00:00.000Z',
    timeoutMs: 1000,
    earningsApiUsage: 'generated/earningsapi_usage.json',
    earningsApiDailyLimit: 100,
    earningsApiReserve: 0
  }, {
    env: { FINNHUB_API_KEY: 'test' },
    fetchFinnhubCalendarRows: async () => [
      finnhubRow('SKIP', {
        reportTiming: 'amc',
        eps: { estimate: 1, actual: null },
        revenue: { estimate: 1000000000, actual: null }
      }),
      finnhubRow('OLD', { reportTiming: 'amc' }),
      finnhubRow('FRESH', { reportTiming: 'amc' })
    ],
    fetchYahooBars: async (symbol) => {
      yahooCalls.push(symbol);
      if (symbol === 'OLD') await new Promise((resolve) => setTimeout(resolve, 20));
      return { symbol, ok: true, status: 200, responseMs: 1, error: '', bars: [] };
    }
  });
  assert.deepEqual(yahooCalls, ['OLD', 'FRESH']);
  assert.deepEqual(refreshData.yahooFetches.map((item) => item.symbol), ['OLD', 'FRESH']);

  const unknownRows = buildRows([
    finnhubRow('TIMEADR', { reportTiming: 'unknown' })
  ], [profile('TIMEADR')], {
    usListings: [usListing('TIMEADR')]
  });
  unknownRows[0].actualsObservedAt = '2026-01-06T15:00:00.000Z';
  const unknownSource = {
    range: { from: '2026-01-05', to: '2026-01-09' },
    rows: unknownRows
  };
  const unknownYahooCalls = [];
  const unknownRefreshData = await collectRefreshData(unknownSource, {
    asOf: '2026-01-06T22:00:00.000Z',
    timeoutMs: 1000,
    earningsApiUsage: 'generated/earningsapi_usage.json',
    earningsApiDailyLimit: 100,
    earningsApiReserve: 0
  }, {
    env: { FINNHUB_API_KEY: 'test' },
    fetchFinnhubCalendarRows: async () => [
      finnhubRow('TIMEADR', { reportTiming: 'unknown' })
    ],
    fetchYahooBars: async (symbol) => {
      unknownYahooCalls.push(symbol);
      return { symbol, ok: true, status: 200, responseMs: 1, error: '', bars: [] };
    }
  });
  assert.deepEqual(unknownYahooCalls, ['TIMEADR']);
  assert.deepEqual(unknownRefreshData.yahooFetches.map((item) => item.symbol), ['TIMEADR']);

  let activeBuildFetches = 0;
  let maxActiveBuildFetches = 0;
  const buildRowsForFetch = ['SLOW', 'FAST1', 'FAST2', 'FAST3', 'FAST4', 'FAST5'].map((symbol) => ({ symbol }));
  const buildFetches = await fetchYahooBarsForRows(buildRowsForFetch, { from: '2026-01-06', to: '2026-01-10', timeoutMs: 1000 }, async (url) => {
    const symbol = new URL(url).pathname.split('/').pop();
    activeBuildFetches += 1;
    maxActiveBuildFetches = Math.max(maxActiveBuildFetches, activeBuildFetches);
    try {
      await new Promise((resolve) => setTimeout(resolve, symbol === 'SLOW' ? 20 : 5));
      return {
        ok: true,
        status: 200,
        ms: 1,
        data: {
          chart: {
            result: [{
              timestamp: [1767657600],
              indicators: { quote: [{ close: [100], open: [100], high: [100], low: [100], volume: [1] }] }
            }]
          }
        }
      };
    } finally {
      activeBuildFetches -= 1;
    }
  });
  assert.equal(maxActiveBuildFetches, 4);
  assert.deepEqual(buildFetches.map((item) => item.symbol), buildRowsForFetch.map((row) => row.symbol));
}

function testResultRefreshWaitsForReportWindow() {
  const source = deterministicVerifiedWeekFixture();
  const row = source.rows[0];

  assert.deepEqual(
    refreshTargetRows(source, '2026-01-05T12:00:00.000Z'),
    [],
    'Provider result refresh must wait for the report window.'
  );
  assert.deepEqual(
    refreshTargetRows(source, '2026-01-07T12:00:00.000Z').map((item) => item.symbol),
    [row.symbol],
    'The row becomes eligible after its report window arrives.'
  );
  const unknown = { ...row, reportTiming: 'unknown', eps: { ...row.eps, actual: null }, revenue: { ...row.revenue, actual: null } };
  assert.equal(reportWindowArrived(unknown, '2026-01-06T13:00:00.000Z'), true, 'TIME UNKNOWN rows are eligible on their report date so same-day actuals can be observed.');
}

async function testMixedResultRefreshAppliesSuccessfulRows() {
  const source = deterministicVerifiedWeekFixture();
  const retained = structuredClone(source.rows[0]);
  retained.symbol = 'RETAIN';
  retained.company = 'RETAIN Corp';
  retained.sourceAudit.finnhubProfile = {
    ...retained.sourceAudit.finnhubProfile,
    name: 'RETAIN Corp',
    ticker: 'RETAIN'
  };
  retained.sourceAudit.finnhubUsListing = usListing('RETAIN');
  source.rows.push(retained);
  source.narrativeApply.applied.push({ symbol: 'RETAIN', reportDate: retained.reportDate });
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates);
  const retainedBefore = structuredClone(retained);

  const result = await refreshEarningsResults(source, {
    finnhubRows: [finnhubRow('VERIFY', {
      eps: { estimate: 1, actual: 2 },
      revenue: { estimate: 1000000000, actual: 1300000000 }
    })],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [{
      symbol: 'VERIFY', ok: true, status: 200, responseMs: 1, error: '',
      bars: [{ date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 110 }]
    }, {
      symbol: 'RETAIN', ok: true, status: 200, responseMs: 1, error: '',
      bars: [{ date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 105 }]
    }],
    rowDiagnosticsByKey: {
      [earningsRowKey(retained)]: [{
        provider: 'finnhub',
        code: 'provider_row_unavailable',
        message: 'Finnhub returned no matching fixture row.'
      }]
    }
  }, {
    asOf: '2026-01-07T22:00:00.000Z'
  });

  const refreshed = result.payload.rows.find((row) => row.symbol === 'VERIFY');
  const carried = result.payload.rows.find((row) => row.symbol === 'RETAIN');
  assert.equal(refreshed.eps.actual, 2, 'A neighboring row failure must not discard a successful EPS refresh.');
  assert.equal(refreshed.revenue.actual, 1300000000);
  assert.equal(refreshed.outcome.interpretation, '', 'New actual results must invalidate pre-release commentary while the row awaits its reaction close.');
  assert.equal(refreshed.outcome.interpretationDisposition, undefined);
  assert.deepEqual(carried.eps, retainedBefore.eps, 'Only the failed row must retain its prior provider facts.');
  assert.equal(carried.sourceAudit.resultRefresh.failures[0].provider, 'finnhub');
  assert.equal(result.failedRows, 1);
  assert.deepEqual(validateEarningsWeekPayload(result.payload), []);
}

function testCompanyReleaseTasksAreRetiredFromCanonicalWeek() {
  const source = embeddedWeekFixture();
  source.companyReleaseTasks = [{
    id: `${source.rows[0].reportDate}:${source.rows[0].symbol}:company-release`,
    symbol: source.rows[0].symbol,
    reportDate: source.rows[0].reportDate
  }];
  assert.match(
    validateEarningsWeekPayload(source).join(' '),
    /companyReleaseTasks is not part of the canonical Earnings week contract/
  );
}

function testWeekValidatorAcceptsDeterministicVerifiedRow() {
  const source = deterministicVerifiedWeekFixture();

  assert.equal(source.rows[0].sourceStatus, 'verified');
  validateWeekPayload(source);

  source.rows[0].scheduleVerificationStatus = 'primary_only';
  source.rows[0].sourceStatus = computeEarningsSourceStatus(source.rows[0]);
  assert.equal(source.rows[0].sourceStatus, 'partial', 'Top-level unconfirmed schedule status cannot compute as verified.');
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates);
  validateWeekPayload(source);
}

function publishedWeekFixture() {
  const source = deterministicVerifiedWeekFixture();
  const published = structuredClone(source);
  delete published.narrativeApply;
  delete published.secondaryRecoveryCandidates;
  for (const row of published.rows) {
    delete row.sourceAudit;
  }
  published.summary = {
    counts: computeEarningsWeekCounts(published.rows, [])
  };
  return published;
}

function testPublishedSummaryValidationIsStrict() {
  const published = publishedWeekFixture();

  assert.deepEqual(validateEarningsWeekPayload(published, { mode: 'published' }), []);

  const debugSummary = structuredClone(published);
  debugSummary.summary.providerMode = 'zacks';
  debugSummary.summary.zacksGate = { ok: true };
  assert.match(
    validateEarningsWeekPayload(debugSummary, { mode: 'published' }).join(' '),
    /summary may only contain counts in published dashboard data/
  );

  const staleCounts = structuredClone(published);
  staleCounts.summary.counts = { total: -1 };
  assert.match(
    validateEarningsWeekPayload(staleCounts, { mode: 'published' }).join(' '),
    /summary\.counts must match published earnings rows/
  );

  const missingSummary = structuredClone(published);
  delete missingSummary.summary;
  assert.match(
    validateEarningsWeekPayload(missingSummary, { mode: 'published' }).join(' '),
    /summary must be an object in published dashboard data/
  );
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
      marketCap: 30000000000,
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
  assert.deepEqual(awaitingClose.missingRows, [{ symbol: 'NEW', reportDate: '2026-07-09' }], 'Awaiting-close rows must require release-time guidance review after actuals arrive.');

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

function testEarningsNarrativeCarryForwardIsRowScoped() {
  const row = (symbol) => ({
    symbol,
    reportDate: '2026-07-14',
    reportTiming: 'bmo',
    lifecycle: 'scheduled',
    eps: { estimate: 1, actual: null, surprisePercent: null, result: 'pending', basis: 'adjusted', note: `${symbol} preview` },
    revenue: { estimate: 100, actual: null, surprisePercent: null, result: 'pending', note: '' },
    outcome: {
      overall: 'pending',
      guide: '',
      interpretation: `${symbol} demand setup`,
      interpretationDisposition: { status: 'verified' }
    },
    reaction: { status: 'pending', note: '' }
  });
  const previous = { rows: [row('AAA'), row('BBB')] };
  const next = structuredClone(previous);
  next.rows.push(row('NEW'));
  for (const item of next.rows) {
    item.eps.note = '';
    item.outcome.interpretation = '';
    delete item.outcome.interpretationDisposition;
  }
  next.rows[0].eps.estimate = 1.1;
  next.rows[0].eps.actual = 1.2;
  next.rows[0].eps.result = 'beat';
  next.rows[0].outcome.overall = 'beat';
  next.rows[0].outcome.interpretation = 'Stale carried preview';
  next.rows[0].outcome.interpretationDisposition = { status: 'verified' };
  next.rows[1].lifecycle = 'awaiting_actual';
  next.rows[2].outcome.interpretation = 'Unreviewed staging copy';
  next.rows[2].outcome.interpretationDisposition = { status: 'verified' };

  const merged = mergeUnchangedEarningsNarrative(previous, next);
  assert.equal(merged.rows[0].outcome.interpretation, '', 'Changed deterministic facts must invalidate only that row.');
  assert.equal(merged.rows[1].outcome.interpretation, 'BBB demand setup', 'A row awaiting actuals must retain its reviewed pre-release thesis.');
  assert.equal(merged.rows[1].outcome.interpretationDisposition.status, 'verified');
  assert.equal(merged.rows[2].outcome.interpretation, '', 'A new row cannot import verified narrative from deterministic staging.');
  assert.equal(merged.rows[2].outcome.interpretationDisposition, undefined);

  const priorReleased = {
    rows: [{
      ...row('CCC'),
      lifecycle: 'released_awaiting_close',
      eps: { estimate: 1, actual: 1.2, surprisePercent: 20, result: 'beat', basis: 'adjusted', note: '' },
      revenue: { estimate: 100, actual: null, surprisePercent: null, result: 'pending', note: '' },
      outcome: {
        overall: 'beat',
        guide: '',
        guidanceDisposition: {
          status: 'not_provided',
          evidenceSource: 'official_company',
          evidenceUrl: 'https://investors.example.test/earnings'
        },
        interpretation: 'EPS strength was the verified release takeaway.',
        interpretationDisposition: { status: 'verified' }
      },
      reaction: { status: 'awaiting_close', note: '' }
    }]
  };
  const closeArrived = structuredClone(priorReleased);
  closeArrived.rows[0].lifecycle = 'close_available';
  closeArrived.rows[0].reaction = {
    status: 'computed',
    basis: 'same_day_close',
    percent: 2.5,
    fromDate: '2026-07-14',
    fromClose: 100,
    toDate: '2026-07-14',
    toClose: 102.5,
    note: 'Deterministic staging copy must not be trusted.'
  };
  const mergedClose = mergeUnchangedEarningsNarrative(priorReleased, closeArrived);
  assert.equal(mergedClose.rows[0].outcome.interpretation, 'EPS strength was the verified release takeaway.');
  assert.equal(mergedClose.rows[0].outcome.interpretationDisposition.status, 'verified');
  assert.equal(mergedClose.rows[0].outcome.guidanceDisposition.status, 'not_provided');
  assert.equal(mergedClose.rows[0].reaction.note, '', 'A newly available close reaction must only invalidate reaction commentary.');
  assert.equal(mergedClose.rows[0].reaction.commentaryDisposition, undefined);
}

function testRepeatedEarningsNarrativeResetsSameFieldOnly() {
  const row = (symbol, company, interpretation) => ({
    symbol,
    company,
    exchange: 'NYSE',
    country: 'US',
    currency: 'USD',
    marketCap: 50000000000,
    reportDate: '2026-07-14',
    reportTiming: 'bmo',
    lifecycle: 'scheduled',
    eps: { estimate: 1, actual: null, surprisePercent: null, result: 'pending', basis: 'adjusted', note: '' },
    revenue: { estimate: 100, actual: null, surprisePercent: null, result: 'pending', note: '' },
    outcome: {
      overall: 'pending',
      guide: '',
      interpretation,
      interpretationDisposition: { status: 'verified' }
    },
    reaction: { status: 'pending', note: '' }
  });
  const week = {
    rows: [
      row('AAA', 'Acme Analytics Inc.', 'Acme revenue cadence and margin execution remain the key read.'),
      row('BBB', 'Beta Systems Corp.', 'Beta revenue cadence and margin execution remain the key read.'),
      row('UNQ', 'Unique Holdings Inc.', 'Unique backlog conversion remains the company-specific setup.'),
      row('SHA', 'Short Alpha Inc.', 'Alpha margins drove upside.'),
      row('SHB', 'Short Beta Inc.', 'Beta margins drove upside!'),
      row('DFA', 'Date Alpha Inc.', 'Alpha demand improved on 2026-07-21.'),
      row('DFB', 'Date Beta Inc.', 'Beta demand improved on July 22, 2026.'),
      row('FYA', 'Fiscal Alpha Inc.', 'Fiscal Alpha FY26 margin target depends on cloud demand.'),
      row('FYB', 'Fiscal Beta Inc.', 'Fiscal Beta FY27 margin target depends on cloud demand.'),
      {
        ...row('GDA', 'Guide Alpha Inc.', 'Guide Alpha product mix is the setup.'),
        outcome: {
          overall: 'beat',
          interpretation: 'Guide Alpha product mix is the setup.',
          interpretationDisposition: { status: 'verified' },
          guide: 'Management reaffirmed full-year margin and revenue targets.',
          guidanceDisposition: { status: 'verified' }
        }
      },
      {
        ...row('GDB', 'Guide Beta Inc.', 'Guide Beta channel demand is the setup.'),
        outcome: {
          overall: 'beat',
          interpretation: 'Guide Beta channel demand is the setup.',
          interpretationDisposition: { status: 'verified' },
          guide: 'Management reaffirmed full-year margin and revenue targets.',
          guidanceDisposition: { status: 'verified' }
        }
      },
      {
        ...row('RXA', 'Reaction Alpha Inc.', 'Reaction Alpha order growth is the setup.'),
        lifecycle: 'close_available',
        reaction: {
          status: 'computed',
          note: 'Margin upside drove the close reaction despite mixed demand.',
          commentaryDisposition: { status: 'verified' }
        }
      },
      {
        ...row('RXB', 'Reaction Beta Inc.', 'Reaction Beta order growth is the setup.'),
        lifecycle: 'close_available',
        reaction: {
          status: 'computed',
          note: 'Margin upside drove the close reaction despite mixed demand.',
          commentaryDisposition: { status: 'verified' }
        }
      },
      {
        // Same text in another field must not trip the interpretation pass.
        ...row('XFD', 'Cross Field Inc.', 'Management reaffirmed full-year margin and revenue targets.'),
        outcome: {
          overall: 'pending',
          guide: '',
          interpretation: 'Management reaffirmed full-year margin and revenue targets.',
          interpretationDisposition: { status: 'verified' }
        }
      },
      // Dual share classes can legitimately share one company-specific read.
      row('GOOG', 'Alphabet Inc', 'Search monetization, cloud margin, and AI spending discipline drive the read.'),
      row('GOOGL', 'Alphabet Inc', 'Search monetization, cloud margin, and AI spending discipline drive the read.'),
      row('SIA', 'Same Issuer Inc', 'Same Issuer subscription retention is the decisive earnings question.'),
      {
        ...row('SIB', 'Same Issuer Inc', 'Same Issuer subscription retention is the decisive earnings question.'),
        reportDate: '2026-07-21'
      },
      {
        ...row('FQ1', 'Fiscal Event Inc', 'Fiscal Event recurring revenue remains the company-specific setup.'),
        fiscalQuarterEnding: '2026-03-31'
      },
      {
        ...row('FQ2', 'Fiscal Event Inc', 'Fiscal Event recurring revenue remains the company-specific setup.'),
        fiscalQuarterEnding: '2026-06-30'
      }
    ]
  };

  const reset = resetRepeatedEarningsNarrativeForEditorial(week);
  const bySymbol = new Map(reset.rows.map((item) => [item.symbol, item]));
  assert.equal(bySymbol.get('AAA').outcome.interpretation, '');
  assert.equal(bySymbol.get('AAA').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('BBB').outcome.interpretation, '');
  assert.equal(bySymbol.get('BBB').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('UNQ').outcome.interpretation, 'Unique backlog conversion remains the company-specific setup.');
  assert.equal(bySymbol.get('UNQ').outcome.interpretationDisposition.status, 'verified');
  assert.equal(bySymbol.get('SHA').outcome.interpretation, '');
  assert.equal(bySymbol.get('SHA').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('SHB').outcome.interpretation, '');
  assert.equal(bySymbol.get('SHB').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('DFA').outcome.interpretation, '');
  assert.equal(bySymbol.get('DFA').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('DFB').outcome.interpretation, '');
  assert.equal(bySymbol.get('DFB').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('FYA').outcome.interpretation, '');
  assert.equal(bySymbol.get('FYA').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('FYB').outcome.interpretation, '');
  assert.equal(bySymbol.get('FYB').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('GDA').outcome.guide, '');
  assert.equal(bySymbol.get('GDA').outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('GDA').outcome.interpretation, 'Guide Alpha product mix is the setup.');
  assert.equal(bySymbol.get('GDB').outcome.guide, '');
  assert.equal(bySymbol.get('GDB').outcome.guidanceDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('RXA').reaction.note, '');
  assert.equal(bySymbol.get('RXA').reaction.commentaryDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('RXB').reaction.note, '');
  assert.equal(bySymbol.get('RXB').reaction.commentaryDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('XFD').outcome.interpretation, 'Management reaffirmed full-year margin and revenue targets.');
  assert.equal(bySymbol.get('XFD').outcome.interpretationDisposition.status, 'verified');
  assert.equal(bySymbol.get('GOOG').outcome.interpretation, 'Search monetization, cloud margin, and AI spending discipline drive the read.');
  assert.equal(bySymbol.get('GOOGL').outcome.interpretationDisposition.status, 'verified');
  assert.equal(bySymbol.get('SIA').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('SIB').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('FQ1').outcome.interpretationDisposition.status, 'pending_review');
  assert.equal(bySymbol.get('FQ2').outcome.interpretationDisposition.status, 'pending_review');
}


async function main() {
  testFinnhubPrimaryAcceptance();
  testMetricComparisonsUseDisplayedPrecision();
  testUsListingEligibilityUsesExactDirectorySymbol();
  testPrimaryScheduleVerification();
  testProviderScheduleRetryAndPreparationFallbacks();
  await testEarningsApiCalendarStopsAfterQuotaResponse();
  testAlphaVantageCalendarBackupFlow();
  testSkipEarningsApiDoesNotReadUsageLedger();
  await testRefreshEarningsApiIsOptIn();
  testZacksPrimaryBuildContract();
  testZacksListingFilterUsesFinnhubDirectory();
  testUnknownTimingActualObservationDrivesReactionBasis();
  testZacksVisibleDateMapping();
  testEarningsGuidanceChoosesSameEventFiling();
  testEarningsGuidanceExhibitSelectionUsesWrapperLabels();
  testEarningsGuidanceExhibitSelectionPrefersDetailTableMetadata();
  testEarningsGuidanceSignalsAndIndex();
  await testEarningsGuidanceEvidenceIncludesLegacyBackupRows();
  testSecondaryRecoveryAndRevenueComparison();
  testApplyEarningsNarrative();
  testEarningsNarrativeCompletenessIsDeferredToEditorialFinalization();
  testUnavailableNarrativeDispositionsRequireAuditFields();
  testCompanyReleaseTasksAreRetiredFromCanonicalWeek();
  testWeekValidatorAcceptsDeterministicVerifiedRow();
  testPublishedSummaryValidationIsStrict();
  testResultRefreshWaitsForReportWindow();
  await testResultRefreshDoesNotRebuildSlate();
  await testResultRefreshFailuresAreRowScoped();
  await testManualRecoverySourceAuditRepair();
  await testYahooReactionFetchesSkipRowsWithoutActualsAndPreserveOrder();
  await testMixedResultRefreshAppliesSuccessfulRows();
  testNewEarningsNarrativeRowsStagePendingEditorialCompletion();
  testEarningsNarrativeCarryForwardIsRowScoped();
  testRepeatedEarningsNarrativeResetsSameFieldOnly();
  console.log('Earnings week tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
