// Keep the generated artifact, validator, and deterministic fixture tests on
// one contract surface so wording/count-rule changes do not drift by file.
function buildEarningsWeekPolicy() {
  return {
    baseSlate: 'Finnhub earnings calendar by date range',
    enrichment: 'Finnhub company profile endpoint by symbol for name, exchange, country, and market capitalization; Finnhub metric plus EarningsAPI calendar for identity-only recovery when Finnhub profile is empty; Nasdaq calendar as a conflict-only date resolver when Finnhub and EarningsAPI disagree on the same symbol; EarningsAPI company endpoint for display-scale rows missing from Finnhub',
    reaction: 'Yahoo Finance Chart API close-to-close policy',
    sourceHierarchy: [
      'Finnhub primary for calendar slate, company profile, timing, EPS/revenue estimates, and EPS/revenue actuals when the row is present.',
      'Finnhub metric endpoint may recover market capitalization when Finnhub profile is empty for a Finnhub-present row.',
      'EarningsAPI secondary for display-scale events missing from Finnhub, and company-name recovery only when Finnhub profile is empty for a Finnhub-present row; never overrides a Finnhub row.',
      'SEC/company release resolution for actual revenue, EPS context, fiscal period, report timing, and source verification.',
      'Yahoo Finance Chart API for close-to-close market reaction.'
    ],
    fieldPrimaries: {
      slate: 'Finnhub earnings calendar',
      company: 'Finnhub company profile name, falling back to EarningsAPI calendar company name for profile-empty Finnhub rows, then ticker symbol',
      marketCap: 'Finnhub company profile marketCapitalization converted from millions to dollars, falling back to Finnhub stock metric marketCapitalization for profile-empty Finnhub rows',
      timing: 'Finnhub earnings calendar hour',
      eps: {
        estimate: 'Finnhub earnings calendar EPS estimate',
        actual: 'Finnhub earnings calendar EPS actual'
      },
      revenue: {
        estimate: 'Finnhub earnings calendar revenue estimate',
        actual: 'Finnhub earnings calendar revenue actual'
      }
    },
    reactionRules: {
      bmo: 'report-date close vs previous trading-day close',
      amc: 'next trading-day close vs report-date close',
      dmh: 'report-date close vs previous trading-day close',
      unknown: 'unavailable'
    },
    secondaryRecoveryFieldPolicy: {
      slate: 'EarningsAPI calendar may queue display-scale events missing from Finnhub. If Finnhub has the same symbol on a different date, a strict Nasdaq match may confirm either provider date; otherwise Finnhub remains canonical and the EarningsAPI row is not recovered.',
      profileRecovery: 'For Finnhub-present rows with empty Finnhub profile, EarningsAPI calendar may supply company name and Finnhub metric may supply market capitalization; EPS/revenue/timing remain Finnhub.',
      eps: 'EarningsAPI company endpoint may supply EPS estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      revenue: 'EarningsAPI company endpoint may supply revenue estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      timing: 'Finnhub calendar for primary rows; EarningsAPI company endpoint for recovered rows; SEC/company release when still missing.',
      reaction: 'Yahoo Finance Chart API.'
    },
    conflictResolution: {
      nasdaqCalendar: 'Use only for same-symbol, different-date Finnhub/EarningsAPI conflicts. Nasdaq resolves the report date only when it returns exactly one in-week row matching either provider date; otherwise ignore Nasdaq and fall back to Finnhub when Finnhub has the symbol.',
      timing: 'Nasdaq date confirmation does not imply timing confirmation. Use Nasdaq timing only when it is supplied and agrees with the selected provider; otherwise keep timing unknown.'
    }
  };
}

// These counts are embedded in the canonical earnings-week artifact and must
// stay identical anywhere the payload is generated, refreshed, applied, or
// validated.
function computeEarningsWeekCounts(rows, secondaryRecoveryCandidates = [], companyReleaseTasks = []) {
  return {
    total: rows.length,
    verified: rows.filter((row) => row?.sourceStatus === 'verified').length,
    partial: rows.filter((row) => row?.sourceStatus === 'partial').length,
    reactionComputed: rows.filter((row) => row?.reaction?.status === 'computed').length,
    missingTiming: rows.filter((row) => row?.reportTiming === 'unknown').length,
    missingRevenue: rows.filter((row) => row?.revenue?.estimate === null && row?.revenue?.actual === null).length,
    missingMarketCap: rows.filter((row) => row?.marketCap === null).length,
    secondaryRecoveryCandidates: secondaryRecoveryCandidates.length,
    companyReleaseTasks: companyReleaseTasks.length
  };
}

// Initial fetch rows are staged before reaction data exists; final artifacts
// and validators must require the computed reaction to mark a row verified.
function computeEarningsSourceStatus(row, options = {}) {
  const requireComputedReaction = options.requireComputedReaction !== false;
  if (row?.reportTiming === 'unknown') return 'partial';
  if (!Number.isFinite(row?.eps?.estimate) || !Number.isFinite(row?.eps?.actual)) return 'partial';
  if (!Number.isFinite(row?.revenue?.estimate) || !Number.isFinite(row?.revenue?.actual)) return 'partial';
  if (requireComputedReaction && row?.reaction?.status !== 'computed') return 'partial';
  return 'verified';
}

module.exports = {
  buildEarningsWeekPolicy,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts
};
