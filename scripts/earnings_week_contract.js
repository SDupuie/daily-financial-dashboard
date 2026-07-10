function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEarningsTiming(value) {
  const raw = String(value || '').trim().toLowerCase();
  return ['bmo', 'amc', 'dmh'].includes(raw) ? raw : 'unknown';
}

function earningsRowKey(row) {
  return `${row?.reportDate || ''}:${row?.symbol || ''}`;
}

function buildEarningsWeekPolicy() {
  return {
    baseSlate: 'Finnhub earnings calendar by date range',
    enrichment: 'Finnhub company profile endpoint by symbol for name, exchange, country, and market capitalization; a bounded EarningsAPI calendar scan corroborates display-eligible report dates; official company IR confirmation resolves uncorroborated or in-week-conflict dates; Finnhub metric plus EarningsAPI calendar support identity-only recovery when Finnhub profile is empty; EarningsAPI company endpoint covers display-scale rows missing from Finnhub',
    reaction: 'Yahoo Finance Chart API close-to-close policy',
    sourceHierarchy: [
      'Finnhub primary for calendar slate, company profile, timing, EPS/revenue estimates, and EPS/revenue actuals when the row is present.',
      'Finnhub metric endpoint may recover market capitalization when Finnhub profile is empty for a Finnhub-present row.',
      'EarningsAPI secondary corroborates display-eligible Finnhub dates and supplies display-scale events missing from Finnhub; every displayed EarningsAPI-only recovery row requires official company IR date confirmation.',
      'SEC/company release resolution for actual revenue, EPS context, fiscal period, report timing, and source verification.',
      'Yahoo Finance Chart API for close-to-close market reaction.'
    ],
    fieldPrimaries: {
      slate: 'Finnhub earnings calendar after date corroboration or official company IR confirmation',
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
      slate: 'EarningsAPI calendar may queue display-scale events missing from Finnhub. For Finnhub-present display rows, a matching date corroborates the row; every date conflict or missing secondary row requires official company IR confirmation. Every displayed EarningsAPI-only recovery row also requires official company IR confirmation. An official date outside the active week excludes the row from that week.',
      profileRecovery: 'For Finnhub-present rows with empty Finnhub profile, EarningsAPI calendar may supply company name and Finnhub metric may supply market capitalization; EPS/revenue/timing remain Finnhub.',
      eps: 'EarningsAPI company endpoint may supply EPS estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      revenue: 'EarningsAPI company endpoint may supply revenue estimates and actuals for recovered rows; SEC/company release resolves missing official actuals.',
      timing: 'Finnhub calendar for primary rows; EarningsAPI company endpoint for recovered rows; SEC/company release when still missing.',
      reaction: 'Yahoo Finance Chart API.'
    },
    conflictResolution: {
      officialCompanyIr: 'Official company investor-relations schedule resolves in-week conflicts and uncorroborated display rows. A confirmation outside the active five-trading-day range excludes the row from that week.',
      nasdaqCalendar: 'Nasdaq remains an audit source and does not select a report date over the official company source.'
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

function isDisplayEligibleEarningsRow(row) {
  // Profile-recovered rows have audited company/market-cap sources but no listing fields.
  // Treat only that explicit source combination as display-eligible without country/exchange.
  const hasProfileRecovery = row?.sourceAudit?.selectedSources?.company === 'earningsApiCalendar'
    && row?.sourceAudit?.selectedSources?.marketCap === 'finnhubMetric';
  if (hasProfileRecovery) return Number.isFinite(row?.marketCap) && row.marketCap >= 1000000000;
  if (row?.country && row.country !== 'US') return false;
  if (/OTC/i.test(row?.exchange || '')) return false;
  if ((row?.sourceAudit?.finnhubProfile?.industry || '').toUpperCase() === 'N/A') return false;
  return Number.isFinite(row?.marketCap) && row.marketCap >= 1000000000;
}

module.exports = {
  buildEarningsWeekPolicy,
  computeEarningsSourceStatus,
  computeEarningsWeekCounts,
  earningsRowKey,
  isDisplayEligibleEarningsRow,
  normalizeEarningsTiming,
  numberOrNull
};
