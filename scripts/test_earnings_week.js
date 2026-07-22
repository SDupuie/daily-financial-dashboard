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
  buildCompanyReleaseTasks,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsRowKey,
  emptyEarningsApiUsage,
  isDisplayEligibleEarningsRow,
  metricResult,
  mergeUnchangedEarningsNarrative,
  narrativeEditorialComplete,
  resetRepeatedEarningsNarrativeForEditorial,
} = require('./earnings_week_contract');
const { addDays, displayDatesForRange } = require('./calendar_contract');
const {
  attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates,
  alphaVantageCalendarFromResponse,
  buildEarningsApiRows,
  buildSecondaryRecoveryCandidates,
  buildRows,
  calendarVerificationDates,
  earningsApiUsageForBuild,
  ensureFinnhubPrimaryUsable,
  fetchEarningsApiCalendar,
  finnhubUsSymbolsFromResponse,
  finnhubCalendarFromResponse,
  fetchYahooBarsForRows,
  readScheduleConfirmations,
  resolveProviderDateConflicts,
  verifyEarningsApiRecoveryRows,
  verifyFinnhubScheduleRows
} = require('./earnings_week_build');
const {
  applyCompanyReleaseResolutions,
  applyEarningsNarrative,
  collectRefreshData,
  earningsCalendarFailedAttemptNeedsRetry,
  earningsCalendarNeedsBuild,
  pendingEarningsScheduleReviews,
  repairRecoveredEarningsSourceAudit,
  refreshEarningsResults,
  refreshTargetRows,
  validateEarningsWeekPayload
} = require('./earnings_week');
const { validateCompanyReleaseResolutionsPayload } = require('./earnings_week_validation');
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

function validateCompanyReleasePayload(week, payload) {
  const errors = validateCompanyReleaseResolutionsPayload(payload, week);
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
    companyReleaseTasks: [],
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

  const [smallCap] = buildRows([finnhubRow('SMALL')], [profile('SMALL', 9999999999)], { usListings: [usListing('SMALL')] });
  assert.equal(isDisplayEligibleEarningsRow(smallCap), false, 'A sub-$10B market-cap row must remain ineligible.');
  assert.equal(verifyFinnhubScheduleRows([smallCap], [], {
    from: '2026-01-05',
    to: '2026-01-09'
  }).rows.length, 0, 'Stage 1 must not admit primary rows that can never display.');
  assert.equal(verifyEarningsApiRecoveryRows([smallCap], {
    from: '2026-01-05',
    to: '2026-01-09'
  }).rows.length, 0, 'Stage 1 must not admit recovered rows that can never display.');

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
  assert.equal(matching.review.length, 0);
  assert.equal(matching.rows[0].sourceAudit.scheduleVerification.status, 'corroborated');

  const crossWeek = verifyFinnhubScheduleRows(baseRows('OUTSIDE'), [{
    date: '2026-01-30', rows: [earningsApiRow('OUTSIDE', { reportDate: '2026-01-30' })]
  }], range);
  assert.equal(crossWeek.rows.length, 1, 'A cross-week conflict must retain the Finnhub row while awaiting official confirmation.');
  assert.equal(crossWeek.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.deepEqual(crossWeek.rows[0].sourceAudit.scheduleVerification.secondaryDates, ['2026-01-30']);
  assert.equal(crossWeek.rows[0].sourceStatus, 'partial');
  assert.deepEqual(crossWeek.review.map((row) => row.reason), ['cross_week_calendar_date_conflict']);

  const inWeekConflict = verifyFinnhubScheduleRows(baseRows('INWEEK'), [{
    date: '2026-01-08', rows: [earningsApiRow('INWEEK', { reportDate: '2026-01-08' })]
  }], range);
  assert.equal(inWeekConflict.rows.length, 1);
  assert.equal(inWeekConflict.rows[0].reportDate, '2026-01-06');
  assert.equal(inWeekConflict.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.deepEqual(inWeekConflict.review.map((row) => row.reason), ['in_week_calendar_date_conflict']);

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

  const secondaryOutage = verifyFinnhubScheduleRows(baseRows('OUTAGE'), [{
    date: '2026-01-05', ok: false, status: 429, rows: []
  }], range);
  assert.equal(secondaryOutage.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.deepEqual(secondaryOutage.review.map((row) => row.reason), ['secondary_calendar_unavailable']);
  assert.deepEqual(secondaryOutage.review[0].sourceOrder, ['company_investor_relations', 'sec_filing']);

  const completeSecondaryMiss = verifyFinnhubScheduleRows(baseRows('SINGLE'), displayDatesForRange(range.from, range.to).map((date) => ({
    date,
    ok: true,
    rows: []
  })), range);
  assert.equal(completeSecondaryMiss.rows.length, 1);
  assert.equal(completeSecondaryMiss.rows[0].sourceAudit.scheduleVerification.status, 'primary_only');
  assert.equal(completeSecondaryMiss.rows[0].sourceStatus, 'partial');
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
    assert.deepEqual(readScheduleConfirmations(confirmationsFile).rows[0], {
      symbol: 'OFFICIAL',
      primaryDate: '2026-01-06',
      reportDate: '2026-01-08',
      sourceName: 'Official investor relations calendar',
      sourceUrl: 'https://investors.example.test/earnings'
    });
    fs.writeFileSync(confirmationsFile, `${JSON.stringify({ schemaVersion: 1, rows: [] })}\n`);
    const invalidContract = readScheduleConfirmations(confirmationsFile);
    assert.deepEqual(invalidContract.rows, []);
    assert.deepEqual(invalidContract.diagnostics.map((item) => item.code), ['confirmation_file_invalid_contract']);
    fs.writeFileSync(confirmationsFile, '{');
    assert.deepEqual(readScheduleConfirmations(confirmationsFile).diagnostics.map((item) => item.code), ['confirmation_file_invalid_json']);
    fs.writeFileSync(confirmationsFile, `${JSON.stringify({
      schemaVersion: 2,
      rows: [{
        symbol: 'GOOD',
        primaryDate: '2026-01-06',
        reportDate: '2026-01-06',
        sourceName: 'Good IR',
        sourceUrl: 'https://investors.example.test/good'
      }, {
        symbol: 'BAD',
        primaryDate: '',
        reportDate: '2026-01-06',
        sourceName: 'Bad IR',
        sourceUrl: 'http://example.test/bad'
      }, {
        symbol: 'DUP',
        primaryDate: '2026-01-07',
        reportDate: '2026-01-07',
        sourceName: 'Duplicate IR A',
        sourceUrl: 'https://investors.example.test/a'
      }, {
        symbol: 'DUP',
        primaryDate: '2026-01-07',
        reportDate: '2026-01-08',
        sourceName: 'Duplicate IR B',
        sourceUrl: 'https://investors.example.test/b'
      }]
    })}\n`);
    const partial = readScheduleConfirmations(confirmationsFile);
    assert.deepEqual(partial.rows.map((row) => row.symbol), ['GOOD']);
    assert.deepEqual(partial.diagnostics.map((item) => item.code), [
      'confirmation_row_invalid',
      'confirmation_event_duplicate'
    ]);
  } finally {
    fs.rmSync(confirmationsDir, { recursive: true, force: true });
  }

  const verificationDates = calendarVerificationDates({ from: range.from, to: range.to });
  assert.equal(verificationDates[0], addDays(range.from, -7));
  assert.equal(verificationDates.at(-1), addDays(range.to, 14));
  assert.equal(verificationDates.length, 26, 'Secondary verification must cover 7 days before through 14 days after the displayed range.');

  const recoveryRow = {
    symbol: 'RECOVERY',
    company: 'Recovery Corp',
    country: 'US',
    exchange: 'NASDAQ NMS - GLOBAL MARKET',
    marketCap: 20000000000,
    reportDate: '2026-01-06',
    sourceAudit: { selectedSources: { slate: 'alphaVantageCalendar' } }
  };
  const recovery = verifyEarningsApiRecoveryRows([recoveryRow], range);
  assert.equal(recovery.rows.length, 1);
  assert.equal(recovery.rows[0].sourceAudit.scheduleVerification.status, 'secondary_only');
  assert.equal(recovery.rows[0].sourceStatus, 'partial');
  assert.deepEqual(recovery.review.map((row) => row.reason), ['uncorroborated_secondary_recovery_date']);
  const staleRecoveryConfirmation = verifyEarningsApiRecoveryRows([recoveryRow], range, [{
    symbol: 'RECOVERY',
    primaryDate: '2025-10-06',
    reportDate: '2025-10-08',
    sourceName: 'Prior-quarter investor relations calendar',
    sourceUrl: 'https://investors.example.test/prior-quarter'
  }]);
  assert.equal(staleRecoveryConfirmation.rows.length, 1);
  assert.equal(staleRecoveryConfirmation.rows[0].sourceAudit.scheduleVerification.status, 'secondary_only');
  assert.deepEqual(staleRecoveryConfirmation.review.map((row) => row.reason), ['uncorroborated_secondary_recovery_date']);
  const officialRecovery = verifyEarningsApiRecoveryRows([recoveryRow], range, [{
    symbol: 'RECOVERY',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-08',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(officialRecovery.rows[0].reportDate, '2026-01-08');
  assert.equal(officialRecovery.rows[0].sourceAudit.scheduleVerification.status, 'official_confirmed');

  const officialRecoveryOutsideWeek = verifyEarningsApiRecoveryRows([recoveryRow], range, [{
    symbol: 'RECOVERY',
    primaryDate: '2026-01-06',
    reportDate: '2026-01-20',
    sourceName: 'Official investor relations calendar',
    sourceUrl: 'https://investors.example.test/earnings'
  }]);
  assert.equal(officialRecoveryOutsideWeek.rows.length, 0);
  assert.equal(officialRecoveryOutsideWeek.review.length, 0);

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
  const missingCompanyRow = verifyEarningsApiRecoveryRows(mismatchedCompanyRows, range, [], [missingCandidate]);
  assert.equal(missingCompanyRow.rows.length, 0);
  assert.deepEqual(missingCompanyRow.review.map((row) => row.reason), ['earningsapi_company_date_unavailable']);
}

function testScheduleReviewAndPreparationFallbacks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfd-schedule-review-fallback-'));
  try {
    const reviewFile = path.join(dir, 'earnings_schedule_review.json');
    fs.writeFileSync(reviewFile, '{');
    const malformed = pendingEarningsScheduleReviews(reviewFile, { from: '2026-01-05', to: '2026-01-09' });
    assert.deepEqual(malformed.rows, []);
    assert.deepEqual(malformed.diagnostics.map((item) => item.code), ['schedule_review_invalid_json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
  const companyReleaseTasks = buildCompanyReleaseTasks(recoveredRows, '2026-01-07T15:00:00.000Z');
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
  assert.equal(companyReleaseTasks.length, 0, 'Complete recovered rows should not create company-release tasks.');
  assert.equal(
    buildCompanyReleaseTasks([], '2026-01-08T15:00:00.000Z').length,
    0,
    'An EarningsAPI-only candidate omitted from canonical rows must remain audit-only.'
  );
}

function testApplyCompanyReleaseResolution() {
  const secondaryRecoveryCandidatesBase = buildSecondaryRecoveryCandidates(
    [],
    [{ date: '2026-01-06', rows: [alphaVantageRow('RECOVERFULL')] }],
    [profile('RECOVERFULL')],
    [usListing('RECOVERFULL')]
  );
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
  const companyReleaseTasks = buildCompanyReleaseTasks(recoveredRows, '2026-01-06T22:00:00.000Z');
  const task = companyReleaseTasks[0];
  const source = {
    rows: recoveredRows,
    secondaryRecoveryCandidates,
    companyReleaseTasks,
    summary: {
      counts: {}
    }
  };
  const resolution = {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status: 'resolved',
    sourceType: 'sec_8k_exhibit_99_1',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/ex99-1.htm',
    secFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1/filing.htm',
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
  };
  const output = applyCompanyReleaseResolutions(source, {
    outputPath: 'synthetic-company-release-resolutions.json',
    companyReleaseResolutions: [resolution]
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
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'companyReleaseApply'), false);

  const awaitingResolution = structuredClone(resolution);
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
  assert.equal(awaitingRow.outcome.interpretation, '', 'Official actuals must invalidate preview commentary even while the row awaits close reaction.');
  assert.equal(awaitingRow.reaction.note, '', 'Reaction commentary must wait for the verified close response.');
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
  source.companyReleaseTasks = [{
    id: `${row.reportDate}:${row.symbol}:company-release`,
    symbol: row.symbol,
    reportDate: row.reportDate
  }];

  assert.deepEqual(
    refreshTargetRows(source, '2026-01-05T12:00:00.000Z'),
    [],
    'An unresolved company-release task must not make a future row eligible for provider result refresh.'
  );
  assert.deepEqual(
    refreshTargetRows(source, '2026-01-07T12:00:00.000Z').map((item) => item.symbol),
    [row.symbol],
    'The row becomes eligible after its report window arrives.'
  );
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
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);
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

async function testResultRefreshRetriesPostWindowCompanyReleaseTasks() {
  const { source, task } = companyReleaseRefreshFixture('AUTORETRY');
  let loadCalls = 0;
  const result = await refreshEarningsResults(source, {
    finnhubRows: [],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [],
    rowDiagnosticsByKey: {}
  }, {
    asOf: '2026-01-06T15:00:00.000Z',
    outputPath: 'generated/earnings_week.json',
    loadTickerMap: async () => {
      loadCalls += 1;
      return new Map([[task.symbol, { cik: 1, title: task.company }]]);
    },
    resolveCompanyReleaseTask: async (retryTask, _tickerMap, _args, row) => {
      assert.equal(retryTask.id, task.id);
      assert.equal(row.symbol, task.symbol);
      return companyReleaseResolvedFixture(retryTask);
    }
  });
  const row = result.payload.rows.find((item) => item.symbol === task.symbol);

  assert.equal(loadCalls, 1, 'Refresh should load the company-release resolver dependencies once for retryable rows.');
  assert.equal(row.eps.actual, 1.25);
  assert.equal(row.revenue.actual, 1200000000);
  assert.equal(row.lifecycle, 'released_awaiting_close');
  assert.equal(row.outcome.interpretation, '', 'Official actuals must clear pre-release outcome commentary even before close reaction is available.');
  assert.equal(row.outcome.guide, '', 'Official actuals must clear stale guidance text for post-release review.');
  assert.equal(row.outcome.interpretationDisposition, undefined);
  assert.equal(row.outcome.guidanceDisposition, undefined);
  assert.equal(row.reaction.status, 'awaiting_close', 'Market reaction commentary can still wait for the verified close.');
  assert.equal(row.reaction.note, '');
  assert.equal(row.sourceAudit.companyReleaseResolution.status, 'resolved');
  assert.deepEqual(result.payload.companyReleaseTasks, [], 'A resolved retry should clear the completed company-release task.');
  assert.equal(Object.prototype.hasOwnProperty.call(result.payload, 'companyReleaseApply'), false, 'Integrated retry should not retain a sidecar apply receipt after all tasks resolve.');
  assert.equal(result.changedRows, 1);
  assert.deepEqual(validateEarningsWeekPayload(result.payload), []);
}

async function testResultRefreshRecomputesLifecycleWhenCompanyReleaseRetryFails() {
  const { source, task } = companyReleaseRefreshFixture('AUTOMISS');
  const result = await refreshEarningsResults(source, {
    finnhubRows: [],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [],
    rowDiagnosticsByKey: {}
  }, {
    asOf: '2026-01-06T15:00:00.000Z',
    loadTickerMap: async () => new Map([[task.symbol, { cik: 1, title: task.company }]]),
    resolveCompanyReleaseTask: async (retryTask) => companyReleaseNonResolvedFixture(retryTask, 'unresolved')
  });
  const row = result.payload.rows.find((item) => item.symbol === task.symbol);

  assert.equal(row.eps.actual, null);
  assert.equal(row.revenue.actual, null);
  assert.equal(row.lifecycle, 'awaiting_actual', 'A post-window BMO row with missing actuals must not remain scheduled.');
  assert.equal(row.sourceAudit.companyReleaseResolution.status, 'unresolved');
  assert.equal(Object.prototype.hasOwnProperty.call(result.payload, 'companyReleaseApply'), false);
  assert.equal(result.payload.companyReleaseTasks.length, 1, 'Unresolved automatic retry should keep the active task available for the next refresh.');
  assert.equal(result.payload.companyReleaseTasks[0].id, task.id);
  assert.deepEqual(validateEarningsWeekPayload(result.payload), []);
}

async function testPrimaryFinnhubRefreshCreatesCompanyReleaseTask() {
  const { source } = companyReleaseRefreshFixture('PRIMARYMISS');
  const row = source.rows[0];
  row.sourceAudit = {
    ...row.sourceAudit,
    finnhubCalendar: { present: true, reportDate: row.reportDate, reportTiming: row.reportTiming },
    selectedSources: {
      ...row.sourceAudit.selectedSources,
      slate: 'finnhub',
      eps: { estimate: 'finnhub', actual: 'none' },
      revenue: { estimate: 'finnhub', actual: 'none' }
    }
  };
  source.secondaryRecoveryCandidates = [];
  source.companyReleaseTasks = [];
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);
  let retriedTask;

  const result = await refreshEarningsResults(source, {
    finnhubRows: [],
    earningsApiCompanyRowsBySymbol: {},
    yahooFetches: [],
    rowDiagnosticsByKey: {
      [earningsRowKey(row)]: [{
        provider: 'finnhub',
        code: 'provider_row_unavailable',
        message: 'Finnhub returned no matching fixture row.'
      }]
    }
  }, {
    asOf: '2026-01-06T15:00:00.000Z',
    loadTickerMap: async () => new Map([[row.symbol, { cik: 1, title: row.company }]]),
    resolveCompanyReleaseTask: async (task) => {
      retriedTask = task;
      const resolution = companyReleaseResolvedFixture(task);
      resolution.fields.eps.estimateSource = 'finnhub';
      resolution.fields.eps.comparisonSource = '';
      resolution.fields.revenue.estimateSource = 'finnhub';
      resolution.notes = ['Finnhub supplied the retained consensus estimates for comparison.'];
      return resolution;
    }
  });

  const updated = result.payload.rows.find((item) => item.symbol === row.symbol);
  assert.ok(retriedTask, 'A post-window Finnhub row with missing actuals must enter company-release recovery.');
  assert.equal(retriedTask.reason, 'missing_eps_actual');
  assert.equal(updated.eps.actual, 1.25);
  assert.equal(updated.revenue.actual, 1200000000);
  assert.deepEqual(result.payload.companyReleaseTasks, []);
  assert.deepEqual(validateEarningsWeekPayload(result.payload), []);
}

async function testNeedsReviewPromotesOfficialMetricsIndependently() {
  for (const [metric, actual] of [['eps', 123.45], ['revenue', 987654321]]) {
    const source = embeddedWeekFixture();
    const task = companyReleaseTaskFixture(source);
    const original = structuredClone(source.rows.find((row) => row.symbol === task.symbol && row.reportDate === task.reportDate));
    source.companyReleaseTasks = [task];
    source.summary.counts.companyReleaseTasks = 1;
    const resolution = companyReleaseNonResolvedFixture(task, 'needs_review');
    resolution.fields[metric].actual = actual;
    if (metric === 'eps') {
      resolution.fields.eps.basis = 'gaap_diluted';
      resolution.fields.eps.gaapActual = actual;
      resolution.fields.eps.gaapBasis = 'gaap_diluted';
      resolution.fields.eps.actualSource = 'sec_company_release';
    }
    const output = applyCompanyReleaseResolutions(source, {
      companyReleaseResolutions: [resolution]
    });
    const row = output.rows.find((item) => item.symbol === task.symbol && item.reportDate === task.reportDate);
    const otherMetric = metric === 'eps' ? 'revenue' : 'eps';

    assert.equal(row[metric].actual, actual, `${metric} should promote independently from the official company release.`);
    assert.deepEqual(row[otherMetric], original[otherMetric], `${otherMetric} should retain its provider-selected facts.`);
    assert.equal(row.sourceAudit.selectedSources[metric].actual, 'sec_company_release');
    assert.equal(row.sourceAudit.selectedSources[otherMetric].actual, original.sourceAudit.selectedSources[otherMetric].actual);
    assert.equal(row.sourceSummary.primary, original.sourceSummary.primary);
    assert.deepEqual(row.sourceSummary.fallbacks, [...original.sourceSummary.fallbacks, 'sec_company_release']);
    assert.equal(row.sourceStatus, 'partial');
    assert.equal(row.sourceAudit.companyReleaseResolution.status, 'needs_review');
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'companyReleaseApply'), false);
    const validationErrors = validateEarningsWeekPayload(output);
    assert.deepEqual(validationErrors, [], `${metric}-only official promotion must remain valid staging data: ${validationErrors.join(' ')}`);
    assert.equal(output.narrativeApply, undefined, 'A newly promoted official actual must invalidate the prior narrative receipt.');

    const providerOtherActual = otherMetric === 'eps' ? 2.5 : 1234567890;
    const providerRow = {
      symbol: task.symbol,
      reportDate: task.reportDate,
      reportTiming: original.reportTiming === 'unknown' ? 'amc' : original.reportTiming,
      fiscalQuarter: original.fiscalQuarter,
      fiscalYear: original.fiscalYear,
      eps: {
        estimate: original.eps.estimate,
        actual: metric === 'eps' ? actual + 1 : providerOtherActual
      },
      revenue: {
        estimate: original.revenue.estimate,
        actual: metric === 'revenue' ? actual + 1000000 : providerOtherActual
      }
    };
    const usesFinnhub = original.sourceAudit.selectedSources.slate === 'finnhub';
    const focusedOutput = structuredClone(output);
    focusedOutput.rows = [row];
    focusedOutput.secondaryRecoveryCandidates = focusedOutput.secondaryRecoveryCandidates.filter((item) => item.symbol === task.symbol);
    focusedOutput.companyReleaseTasks = [task];
    focusedOutput.summary.counts = computeEarningsWeekCounts(focusedOutput.rows, focusedOutput.secondaryRecoveryCandidates, focusedOutput.companyReleaseTasks);
    const refreshed = await refreshEarningsResults(focusedOutput, {
      finnhubRows: usesFinnhub ? [providerRow] : [],
      earningsApiCompanyRowsBySymbol: usesFinnhub ? {} : { [task.symbol]: [providerRow] },
      yahooFetches: []
    }, { asOf: `${task.reportDate}T23:00:00.000Z` });
    const refreshedRow = refreshed.payload.rows.find((item) => item.symbol === task.symbol && item.reportDate === task.reportDate);
    assert.equal(refreshedRow[metric].actual, actual, `Provider retries must not overwrite the promoted official ${metric} actual.`);
    assert.equal(refreshedRow[otherMetric].actual, providerOtherActual, `Provider retries should still fill the unpromoted ${otherMetric} actual.`);
    assert.equal(refreshedRow.sourceAudit.selectedSources[metric].actual, 'sec_company_release');
    assert.equal(refreshedRow.sourceAudit.selectedSources[otherMetric].actual, usesFinnhub ? 'finnhub' : 'earningsApiCompany');
    assert.equal(refreshedRow.sourceAudit.companyReleaseResolution.status, 'needs_review');
    assert.equal(refreshed.payload.companyReleaseTasks.length, 1, 'A partial official resolution should remain retryable after provider recovery of the other metric.');
    const refreshValidationErrors = validateEarningsWeekPayload(refreshed.payload);
    assert.deepEqual(refreshValidationErrors, [], `${metric}-only official provenance must survive provider retries: ${refreshValidationErrors.join(' ')}`);
  }
}

function companyReleaseNonResolvedFixture(task, status) {
  const hasCompanyRelease = status === 'needs_review';
  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status,
    sourceType: hasCompanyRelease ? 'sec_8k_exhibit_99_1' : '',
    sourceUrl: hasCompanyRelease ? 'https://www.sec.gov/Archives/edgar/data/1/ex99-1.htm' : '',
    secFilingUrl: hasCompanyRelease ? 'https://www.sec.gov/Archives/edgar/data/1/filing.htm' : '',
    confidence: status === 'needs_review' ? 'medium' : 'low',
    fields: {
      company: task.company,
      fiscalPeriod: '',
      reportTiming: 'unknown',
      eps: {
        actual: null,
        basis: '',
        gaapActual: null,
        gaapBasis: '',
        adjustment: null,
        actualSource: '',
        estimate: null,
        estimateSource: '',
        estimateCount: '',
        comparisonSource: ''
      },
      revenue: { actual: null, estimate: null, estimateSource: '' }
    },
    reaction: {
      basis: 'unavailable',
      percent: null,
      fromDate: '',
      fromClose: null,
      toDate: '',
      toClose: null,
      status: 'unavailable',
      note: '',
      source: '',
      sourceAudit: {}
    },
    notes: [`${status}_fixture`],
    sourceAudit: {}
  };
}

function companyReleaseResolvedFixture(task) {
  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status: 'resolved',
    sourceType: 'sec_8k_exhibit_99_1',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/ex99-1.htm',
    secFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1/filing.htm',
    confidence: 'high',
    fields: {
      company: task.company,
      fiscalPeriod: 'Fiscal Q4 2025',
      reportTiming: 'bmo',
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
      basis: 'same_day_close',
      percent: null,
      fromDate: '',
      fromClose: null,
      toDate: '',
      toClose: null,
      status: 'awaiting_close',
      note: '',
      source: 'Yahoo Finance Chart API',
      sourceAudit: {
        status: 200,
        rowCount: 1,
        error: ''
      }
    },
    notes: ['EarningsAPI company endpoint supplied the retained consensus estimates for comparison.'],
    sourceAudit: {}
  };
}

function companyReleaseRefreshFixture(symbol) {
  const secondaryRecoveryCandidatesBase = buildSecondaryRecoveryCandidates(
    [],
    [{ date: '2026-01-06', rows: [alphaVantageRow(symbol, { reportTiming: 'bmo' })] }],
    [profile(symbol)],
    [usListing(symbol)]
  );
  const companyFetch = {
    symbol,
    ok: true,
    status: 200,
    rows: [earningsApiRow(symbol, {
      reportTiming: 'bmo',
      eps: { estimate: 1, actual: null },
      revenue: { estimate: 1000000000, actual: null }
    })]
  };
  const secondaryRecoveryCandidates = attachEarningsApiCompanyAuditToSecondaryRecoveryCandidates(secondaryRecoveryCandidatesBase, [companyFetch]);
  const recoveredRows = buildEarningsApiRows(secondaryRecoveryCandidates, [companyFetch]);
  const row = recoveredRows[0];
  row.lifecycle = 'scheduled';
  row.outcome.interpretation = 'Pre-report fare and fuel setup.';
  row.outcome.guide = 'Pre-report capacity outlook.';
  row.outcome.interpretationDisposition = { status: 'verified' };
  row.outcome.guidanceDisposition = { status: 'verified' };
  row.reaction = {
    basis: 'same_day_close',
    percent: null,
    fromDate: '',
    fromClose: null,
    toDate: '',
    toClose: null,
    status: 'pending',
    note: '',
    source: 'Yahoo Finance Chart API'
  };
  row.sourceStatus = 'partial';
  const companyReleaseTasks = buildCompanyReleaseTasks(recoveredRows, '2026-01-06T15:00:00.000Z');
  assert.equal(companyReleaseTasks.length, 1);
  const source = {
    schemaVersion: EARNINGS_WEEK_SCHEMA_VERSION,
    generatedAt: '2026-01-06T13:00:00.000Z',
    range: { from: '2026-01-05', to: '2026-01-09' },
    rows: recoveredRows,
    secondaryRecoveryCandidates,
    companyReleaseTasks,
    summary: {
      counts: computeEarningsWeekCounts(recoveredRows, secondaryRecoveryCandidates, companyReleaseTasks),
      fetches: {}
    },
    narrativeApply: {
      generatedAt: '2026-01-06T13:05:00.000Z',
      narrativeArtifact: 'generated/earnings_narrative.json',
      applied: [{ symbol, reportDate: '2026-01-06' }]
    }
  };
  return { source, task: companyReleaseTasks[0] };
}

function companyReleaseTaskFixture(source) {
  const row = source.rows.find((item) => item.sourceAudit?.finnhubProfile);
  assert.ok(row, 'Embedded dashboard fixture must include a profiled canonical row for company-release validation coverage.');
  return {
    id: `${row.reportDate}:${row.symbol}:company-release`,
    symbol: row.symbol,
    company: row.company,
    reportDate: row.reportDate,
    reason: 'missing_eps_actual',
    priority: 'normal',
    marketCap: row.marketCap,
    marketCapDisplay: row.marketCapDisplay,
    fiscalQuarterEnding: row.fiscalQuarterEnding || '',
    neededFields: ['reportTiming', 'fiscalPeriod', 'eps.actual', 'revenue.actual', 'companyReleaseUrl', 'secFilingUrl'],
    preferredSources: ['SEC 8-K Exhibit 99.1', 'Company investor relations earnings release'],
    doNotUseForOverrides: ['finnhub_calendar_row'],
    permittedUses: ['official_actuals_resolution', 'timing_resolution', 'fiscal_period_resolution', 'eps_basis_resolution'],
    instructions: 'Use an official company release to resolve missing timing or actuals. Keep the row\'s deterministic estimates for comparison.',
    sourceAudit: row.sourceAudit
  };
}

function testTaskPolicyMetadataDoesNotBlockValidation() {
  const source = embeddedWeekFixture();
  const task = companyReleaseTaskFixture(source);
  source.companyReleaseTasks = [task];
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);

  for (const item of [source.companyReleaseTasks[0]]) {
    delete item.neededFields;
    delete item.preferredSources;
    delete item.doNotUseForOverrides;
    delete item.permittedUses;
    delete item.instructions;
    item.priority = 'not-a-display-contract';
  }
  delete source.companyReleaseTasks[0].reason;

  assert.deepEqual(validateEarningsWeekPayload(source), []);
}

function testWeekValidatorAcceptsDeterministicVerifiedRow() {
  const source = deterministicVerifiedWeekFixture();

  assert.equal(source.rows[0].sourceStatus, 'verified');
  validateWeekPayload(source);

  source.rows[0].scheduleVerificationStatus = 'primary_only';
  source.rows[0].sourceStatus = computeEarningsSourceStatus(source.rows[0]);
  assert.equal(source.rows[0].sourceStatus, 'partial', 'Top-level unconfirmed schedule status cannot compute as verified.');
  source.summary.counts = computeEarningsWeekCounts(source.rows, source.secondaryRecoveryCandidates, source.companyReleaseTasks);
  validateWeekPayload(source);
}

function testCompanyReleaseResolutionValidatorRejectsCalendarEstimates() {
  const week = embeddedWeekFixture();
  const task = companyReleaseTaskFixture(week);
  week.companyReleaseTasks = [task];
  week.summary.counts.companyReleaseTasks = 1;
  const weekWithReceipt = structuredClone(week);
  weekWithReceipt.companyReleaseApply = { generatedAt: '2026-01-06T22:00:00.000Z' };
  assert.match(
    validateEarningsWeekPayload(weekWithReceipt).join(' '),
    /companyReleaseApply is not part of the canonical Earnings week contract/,
    'Canonical week validation must reject the retired company-release apply receipt.'
  );
  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-01-06T22:00:00.000Z',
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
    }]
  };

  assert.throws(
    () => validateCompanyReleasePayload(week, payload),
    /estimateSource must be finnhub/,
    'Company-release resolution payload must not use EarningsAPI calendar as a metric source.'
  );

  payload.companyReleaseResolutions[0].fields.eps.estimateSource = 'finnhub';
  payload.companyReleaseResolutions[0].fields.eps.comparisonSource = 'finnhub_eps_estimate';
  payload.companyReleaseResolutions[0].fields.revenue.estimateSource = 'finnhub';
  payload.generatedAt = '2026-07-01T19:59:00.000Z';
  assert.throws(
    () => validateCompanyReleasePayload(week, payload),
    /cannot be computed before the required closing response/,
    'Company-release reaction validation must not accept a future closing response.'
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
      marketCap: 20000000000,
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
  testScheduleReviewAndPreparationFallbacks();
  await testEarningsApiCalendarStopsAfterQuotaResponse();
  testAlphaVantageCalendarBackupFlow();
  testSkipEarningsApiDoesNotReadUsageLedger();
  await testRefreshEarningsApiIsOptIn();
  testSecondaryRecoveryAndRevenueComparison();
  testApplyCompanyReleaseResolution();
  testApplyEarningsNarrative();
  testEarningsNarrativeCompletenessIsDeferredToEditorialFinalization();
  testUnavailableNarrativeDispositionsRequireAuditFields();
  await testNeedsReviewPromotesOfficialMetricsIndependently();
  testTaskPolicyMetadataDoesNotBlockValidation();
  testWeekValidatorAcceptsDeterministicVerifiedRow();
  testCompanyReleaseResolutionValidatorRejectsCalendarEstimates();
  testResultRefreshWaitsForReportWindow();
  await testResultRefreshDoesNotRebuildSlate();
  await testResultRefreshFailuresAreRowScoped();
  await testManualRecoverySourceAuditRepair();
  await testYahooReactionFetchesSkipRowsWithoutActualsAndPreserveOrder();
  await testMixedResultRefreshAppliesSuccessfulRows();
  await testResultRefreshRetriesPostWindowCompanyReleaseTasks();
  await testResultRefreshRecomputesLifecycleWhenCompanyReleaseRetryFails();
  await testPrimaryFinnhubRefreshCreatesCompanyReleaseTask();
  testNewEarningsNarrativeRowsStagePendingEditorialCompletion();
  testEarningsNarrativeCarryForwardIsRowScoped();
  testRepeatedEarningsNarrativeResetsSameFieldOnly();
  console.log('Earnings week tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
