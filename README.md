# Daily Financial Dashboard

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

## Maintained File

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `scripts/`: operational fetch, validation, and publish helpers.
- `launchd/`: optional local-machine LaunchAgent templates for running dashboard helper scripts.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

## Update Cadence

Update `daily_financial_news.html` each market morning around 7:00 AM Central, before the U.S. open. When doing an afternoon refresh around 4:00 PM Central, switch the futures module from the morning setup view to the completed-session view. The main dashboard payload lives inside:

```html
<!-- ============ DATA START — edit this block to update the dashboard ============ -->
...
<!-- ============ DATA END ============ -->
```

Do not touch the HTML, CSS, or JavaScript outside generated data blocks for a daily dashboard refresh.

Production is self-contained: the rendered dashboard reads embedded `dashboard-data` and `chart-data` JSON blocks. Helper scripts may generate staging JSON snippets, but no production section should fetch sidecar JSON files at runtime.

## Data Contracts

This section is the canonical human-readable contract for dashboard data. Keep `scripts/validate_dashboard.js`, `scripts/validate_chart_data.js`, and fetch-script output in sync with this section whenever a payload shape changes.

### Embedded `dashboard-data`

- `editionId`: ISO timestamp identifying the exact embedded dashboard edition. Bump it every time helper scripts rewrite `dashboard-data`; localhost refresh cache keys must use this field rather than inferring identity from the visible date/ticker shape.
- `masthead`: issue metadata for the visible header. `masthead.date` must be the dashboard date.
- `opening`: market-open summary with `headline`, `deck`, and exactly four `catalysts[]` items.
- `futuresModule`: the four-card futures module and its one to three promoted stories. Use `sectionLabel`/`sectionTitle` to distinguish morning `Before The Open` / `Pre-Market Futures` from afternoon `After The Bell` / `Session Futures`.
- `tape`: the cross-asset Tape table. All ticker quote rows, including crypto tickers, live in `tape.rows[]`.
- `assetAllocationPortfolio`: instrument-level ETF market data and sanitized portfolio-level summary fields only. Do not embed tactical model logic or derived allocation calculations.
- `stories`: exactly nine broad-market, non-crypto story cards.
- `newsBaseline`: embedded scheduled-update comparison state for the News Flow and Crypto `New` pills. `currentScheduledStoryIds` stores the most recent scheduled run's `stories[]` and `crypto.notes[]` identities, while `previousScheduledStoryIds` is the comparison set used to keep manual runs from consuming scheduled newness.
- `crypto`: crypto section metadata, crypto-only stat rows, and crypto story notes. Crypto ticker quote rows do not live here.
- `earnings.week`: canonical Monday-Friday earnings monitor payload.
- `weekAhead`: scheduled market events and closures.
- `footer`: compile date and concise source-family attribution.

### `tape.rows[]`

Each Tape row is a chartable quote row with this contract:

```json
{
  "group": "Crypto",
  "name": "Bitcoin",
  "ticker": "BTC",
  "last": "$61,406",
  "delta": "+$1,403",
  "pct": "+2.34%",
  "dir": "up",
  "note": "Ticker-specific daily market context.",
  "sourceSymbol": "BTC-USD",
  "asOf": "2026-07-03"
}
```

- `group` is optional for existing non-crypto rows that are grouped by ticker lists in the renderer; crypto ticker rows must set `group: "Crypto"`.
- `ticker` is the dashboard display/routing key. `sourceSymbol` is the fetch/chart source key.
- `last`, `delta`, `pct`, `dir`, and `asOf` are derived views. They must match the embedded `chart-data.quoteRows` value for the row, and `chart-data.quoteRows` must itself be reproducible from the latest `chart-data.series` bars.
- `note` must explain the factor driving that ticker or market today. It must not restate quote values or include source/citation language.
- Deprecated: do not put ticker quote rows in `crypto.tape[]`.

### `crypto`

Crypto section data has this contract:

```json
{
  "tapeHeader": "Crypto tape: bitcoin holds $61K while sentiment improves from extreme fear",
  "stats": [
    { "sym": "F&G", "name": "Fear & Greed Index", "sub": "Extreme Fear", "price": "21", "delta": "+2", "chg": "+2", "dir": "up" },
    { "sym": "ALTSEASON", "name": "Altcoin Season Index", "sub": "Neutral", "price": "48", "delta": "Unchanged", "chg": "/100", "dir": "flat" },
    { "sym": "TOTAL", "name": "Crypto Market Cap", "sub": "Expanding", "price": "2.21T", "delta": "+$43.86B", "chg": "+2.03%", "dir": "up" }
  ],
  "dominance": { "btc": "55.64%", "eth": "9.28%", "others": "35.08%" },
  "notes": []
}
```

- `crypto.stats[]` is for crypto-only section stat cards: Fear & Greed, Altcoin Season Index, and Crypto Market Cap.
- `crypto.notes[]` holds four to six crypto-specific stories or notes with direct `url` and `publishedOn`.
- `crypto.tape[]` is deprecated and validation should reject it.

### `futuresModule`

- `futuresModule.futures[]` must contain exactly four index-futures rows.
- `futuresModule.stories[]` must contain one to three promoted stories, each with `futuresModuleTag`, `title`, `body`, `url`, and `publishedOn`.
- Morning `Pre-Market Futures` rows chart the overnight Globex window from the prior futures reopen through the latest morning tick.
- Afternoon `Session Futures` rows chart the regular market window, normally 9:30 AM to 4:00 PM Eastern, and compare the latest regular-session futures value with the prior trading day's official 4:00 PM Eastern futures close.
- Dashboard display times should be local, but raw official session labels and fields must be stored in Eastern terms: `marketTimeZone: "America/New_York"`, `sessionStartEastern`, `sessionEndEastern`, `referenceCloseEastern`, and `referenceLabel: "prior 4 PM ET close"`.
- `raw.referencePrice` is the comparison baseline used for Session Futures chart/reference calculations. Keep `raw.previousClose` as the source's futures prior close when available.

### Earnings Monitor Contract

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`; provider sidecars are build-time inputs only. The goal is to let providers collect data and let AI write concise interpretation only after the numeric facts are fixed.

Source hierarchy:

1. Finnhub primary: calendar slate, company profile, market cap, timing, EPS estimate, EPS actual, revenue estimate, and revenue actual when Finnhub has the row.
2. Finnhub profile recovery: fetch `profile2` with retry/backoff for 429s and cache successful profiles in `generated/finnhub_profile_cache.json`; if live `profile2` still rate-limits or fails transiently, use the cached profile with audit flags. If Finnhub has the earnings row but profile identity is still empty, use Finnhub `stock/metric` only for market cap and EarningsAPI calendar only for company name. Successful Finnhub metric market caps are cached in `generated/finnhub_metric_cache.json` to reduce repeated rate-limit exposure. EPS, revenue, timing, and slate still remain Finnhub.
3. EarningsAPI secondary: missing ticker/date discovery and row-level specifics only for Finnhub-missing display candidates. Use the EarningsAPI company endpoint for row specifics; treat the EarningsAPI calendar endpoint as discovery only except for the profile-empty company-name recovery above.
4. SEC/company release resolution: official actuals, fiscal-period confirmation, timing when needed, and EPS basis notes for queued company-release tasks.
5. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

Do not use metered EarningsAPI calls to audit every Finnhub-covered row. EarningsAPI is limited to Finnhub-missing display candidates plus the narrow company-name recovery for Finnhub-covered rows whose Finnhub profile is empty. EarningsAPI must never override a Finnhub-covered row's EPS, revenue, timing, or slate.

Canonical row shape:

```json
{
  "symbol": "GIS",
  "company": "General Mills, Inc.",
  "reportDate": "2026-07-01",
  "reportTiming": "bmo",
  "fiscalYear": 2026,
  "fiscalQuarter": 4,
  "marketCap": 21000000000,
  "eps": {
    "estimate": 0.80,
    "actual": 0.95,
    "result": "beat",
    "basis": "adjusted_non_gaap",
    "note": ""
  },
  "revenue": {
    "estimate": 4590000000,
    "actual": 4600000000,
    "result": "beat",
    "note": ""
  },
  "outcome": {
    "overall": "beat",
    "guide": "FY27 EPS guide $3.00-$3.20",
    "interpretation": "Profit outlook carried the read."
  },
  "reaction": {
    "basis": "same_day_close",
    "percent": 8.5,
    "status": "computed",
    "note": "Guide and profit read drove rally."
  },
  "sourceStatus": "verified",
  "sourceSummary": {
    "primary": "finnhub",
    "fallbacks": [],
    "reaction": "yahoo"
  },
  "sourceAudit": {
    "selectedSources": {
      "slate": "finnhub",
      "company": "finnhubProfile",
      "marketCap": "finnhubProfile",
      "timing": "finnhub",
      "eps": {
        "estimate": "finnhub",
        "actual": "finnhub"
      },
      "revenue": {
        "estimate": "finnhub",
        "actual": "finnhub"
      },
      "reaction": "yahoo"
    }
  }
}
```

Allowed `reportTiming` values are `bmo`, `amc`, `dmh`, and `unknown`. Allowed metric `result` values are `beat`, `miss`, `met`, `not_compared`, and `pending`. Allowed `outcome.overall` values are `beat`, `miss`, `mixed`, `met`, `eps_only_beat`, `eps_only_miss`, `pending`, and `unverified`. Allowed `reaction.basis` values are `same_day_close`, `next_session_close`, `during_market_close`, and `unavailable`. Allowed `reaction.status` values are `computed`, `unavailable`, and `pending`. Allowed `sourceSummary.primary` values are `finnhub`, `earningsApiCompany`, and `sec_company_release`. The dashboard consumes this canonical row contract directly and derives display labels, tones, and compact metric text at render time. The source artifact keeps field-level selected sources in `sourceAudit`; dashboard-visible provenance uses compact `sourceSummary` plus `sourceStatus`. Audit snapshots should preserve provider identity by section name, but metric values still use canonical `eps` and `revenue` objects rather than provider field names.

EarningsAPI budget policy:

- Treat the monthly quota as a scarce secondary-recovery budget, not a primary data source.
- Query EarningsAPI calendar at most once per weekday in the target week during a normal weekly discovery pass.
- Query EarningsAPI company rows only for Finnhub-missing display candidates.
- Do not call EarningsAPI reactions in the normal path; Yahoo remains the reaction source.
- Keep a monthly call counter and stop optional calls before the limit. Preserve reserve capacity for urgent secondary-recovery checks.

Update methodology:

Treat weekly slate construction and post-report result refresh as separate jobs. The weekly slate job builds the five calendar cards and expected reporting universe; the result-refresh job updates only rows whose report window has arrived or passed. Do not keep probing calendar/discovery endpoints for the same static week slate during every dashboard refresh.

Weekly slate construction:

1. Run `node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD` once for the target Monday-Friday week, normally on Monday morning or when intentionally rebuilding the week.
2. Fetch Finnhub earnings calendar for the Monday-Friday target week.
3. Fetch Finnhub profiles for Finnhub rows and filter display eligibility by market cap, country/exchange/profile quality, and watchlist rules.
4. If Finnhub fails, returns zero usable rows, or returns fewer than the configured minimum usable rows, fail closed instead of promoting a secondary source into the whole slate. The default minimum is `max(1, weekdays * 2)`, so the normal Monday-Friday strip requires at least 10 Finnhub rows before any EarningsAPI secondary-recovery calls. Use `--min-finnhub-rows 1` only for intentional holiday-week or diagnostic runs.
5. Fetch EarningsAPI calendar for the same five weekdays as a one-time coverage check for the slate build. Do not repeat this call during ordinary result refreshes for the same week.
6. If Finnhub and EarningsAPI have the same symbol on different dates, fetch Nasdaq calendar for the same week as a strict conflict-only resolver. Nasdaq may confirm the report date only when it returns exactly one in-week row for that symbol and that date matches either Finnhub or EarningsAPI. If Nasdaq fails, returns no row, returns multiple rows, or returns a third date, ignore Nasdaq and keep Finnhub because Finnhub has the symbol in the weekly slate. Nasdaq date confirmation does not confirm timing; use Nasdaq timing only when supplied and matching the selected provider, otherwise keep timing unknown.
7. For Finnhub rows, fetch `profile2` with 429 retry/backoff and use `generated/finnhub_profile_cache.json` only after live profile fetches fail or rate-limit. For rows with empty Finnhub profile data after that, read cached Finnhub `stock/metric` market cap first, then fetch the metric endpoint with conservative retry/backoff if uncached; use the matching EarningsAPI calendar row for company name only. This may make a Finnhub-covered row display-eligible, but it must not change Finnhub EPS, revenue, timing, or outcome.
8. Compare EarningsAPI-discovered symbols against the conflict-resolved Finnhub slate. Queue only symbols absent from Finnhub as `secondaryRecoveryCandidates`; same-symbol date conflicts must collapse to one audited canonical row, not duplicate recovery rows.
9. For each queued candidate, fetch the EarningsAPI company endpoint and select the row matching the report date. Use that row for EPS/revenue estimates and actuals only after the date is consistent.
10. Persist the canonical `earnings_week.json` with the built slate, estimates, timing, profile fields, recovery candidates, and source audit. This artifact becomes the input for later result refreshes.

Post-report result refresh:

1. Run `node scripts/earnings_week.js refresh` against the existing canonical `earnings_week.json`; do not rebuild the slate unless the user explicitly requests it or validation proves the slate is unusable.
2. Select only rows whose report timing has arrived or passed, plus unresolved rows with `companyReleaseTasks`.
3. Refresh actual EPS/revenue from the row's primary deterministic source: Finnhub for Finnhub-covered rows, EarningsAPI company endpoint for previously recovered EarningsAPI rows, and SEC/company release only for official resolution tasks. Do not call EarningsAPI calendar in this phase.
4. Create `companyReleaseTasks` only for recovered rows with missing actuals or missing timing. Do not use company-release resolution to recover analyst estimates.
5. Resolve `companyReleaseTasks` against SEC/company release into `earnings_company_release_resolutions.json` with `node scripts/earnings_week.js resolve`.
6. Apply resolved company-release facts back into the canonical `earnings_week.json` rows with `node scripts/earnings_week.js apply-release`. The dashboard should not merge the sidecar at render time.
7. Compute EPS and revenue beat/miss mechanically from numeric estimate and actual values. If revenue estimate is unavailable, produce an EPS-only outcome and mark revenue `not_compared`.
8. Compute market reaction from Yahoo using timing-aware rules once the needed close is available: BMO/DMH = report-date close vs previous trading-day close; AMC = next trading-day close vs report-date close; unknown = unavailable.
9. Let AI write only narrative fields such as `outcome.interpretation`, `outcome.guide`, `reaction.note`, `eps.note`, and `revenue.note` into `earnings_narrative.json`, using the verified numeric row plus any official-release guidance text. AI must not invent data, dates, estimates, actuals, or reaction values.
10. Apply narrative back into the canonical `earnings_week.json` rows with `node scripts/earnings_week.js apply-narrative`. The dashboard should not carry ticker-specific commentary maps.
11. Embed the validated canonical payload into `daily_financial_news.html` with `node scripts/earnings_week.js embed`. The published dashboard should not fetch `generated/earnings_week.json` at runtime.

Company-release resolution sidecar shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-04T13:00:00.000Z",
  "sourceArtifact": "generated/earnings_week.json",
  "sourceGeneratedAt": "2026-07-04T12:08:47.592Z",
  "sourceRange": {
    "from": "2026-06-29",
    "to": "2026-07-03"
  },
  "companyReleaseResolutions": [],
  "summary": {
    "total": 0,
    "resolved": 0,
    "needsReview": 0,
    "unresolved": 0
  },
  "outputPath": "/Users/Scott/Projects/Daily Financial Dashboard/generated/earnings_company_release_resolutions.json"
}
```

The company-release sidecar is not a dashboard runtime input. It must identify the exact canonical earnings week artifact it was derived from with `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`; `node scripts/earnings_week.js validate-release` verifies those fields against the week file before any apply step uses the sidecar. Every `companyReleaseTasks[]` entry must have exactly one matching `companyReleaseResolutions[]` entry. A dashboard-ready `earnings_week.json` with company-release tasks must also include `companyReleaseApply`, every task must be applied with no skipped tasks, and the matching canonical row must contain the applied `sourceAudit.companyReleaseResolution`. SEC/company-release resolution may carry recovered estimates forward only from the EarningsAPI company endpoint, not the EarningsAPI calendar discovery row.

The narrative sidecar uses the same source anchor fields: `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`. `node scripts/earnings_week.js apply-narrative` rejects narrative generated from a different earnings week artifact before writing any canonical rows.

### Embedded `chart-data`

The `chart-data` block is generated chart history plus quote-row staging data:

- `schemaVersion` must be `1`.
- `range.days` must be at least `1826` so the 5Y chart shortcut has enough embedded history.
- `series[]` is the canonical embedded price-history store. It must include every chartable ticker from `tape.rows[]`, with matching `ticker`, `section`, and `sourceSymbol`.
- `quoteRows.tape[]` is a derived view over non-crypto `series[]` using `last`, `delta`, and `pct`.
- `quoteRows.crypto[]` is a derived view over crypto `series[]` using the crypto refresh shape: `price`, `delta`, and `chg`. The dashboard maps these back onto `tape.rows[].last`, `delta`, and `pct`.
- Treasury yield-curve series must include `curveDate`, current `curvePoints[]`, `comparisonCurves[]` entries labeled `1M ago` and `6M ago`, and a `curveSpread` object for the 2s10s display row.
- Each `comparisonCurves[].points[]` array must match the current curve's maturity labels in order so the renderer can draw historical lines maturity-for-maturity.
- Published production renders from embedded `dashboard-data`, but canonical market data still lives in embedded `chart-data.series`; `quoteRows` and the visible Tape price fields are derived views and must stay in sync with that series history.

## Futures Module Windows

Use the same embedded `futuresModule` data block for both update windows; set the visible labels to match the update:

- Morning update: `futuresModule.sectionLabel` = `Before The Open`; `futuresModule.sectionTitle` = `Pre-Market Futures`. Futures charts should cover the current overnight Globex session from the prior futures reopen, normally 5:00 PM Central / 6:00 PM Eastern, through the latest available morning tick.
- Afternoon update: `futuresModule.sectionLabel` = `After The Bell`; `futuresModule.sectionTitle` = `Session Futures`. Run the update around 4:00 PM Central, but keep the futures charts scoped to regular market hours, normally 8:30 AM to 3:00 PM Central / 9:30 AM to 4:00 PM Eastern. Visible change values should compare the latest regular-session futures value with the prior trading day's official 4:00 PM Eastern futures close, matching the daily-change basis used by cash indexes. Store the official market-time contract in Eastern time, e.g. raw `referenceLabel` = `prior 4 PM ET close` and `marketTimeZone` = `America/New_York`. Use `node scripts/fetch_futures_module.js --session` for this completed-session futures payload.
- Holiday or unusual-session updates should use the closest accurate window label and make the shortened or closed cash-market context clear in `footer.compiled`.

## Optional Local Market Refresh

Run `node scripts/local_market_server.js` to start a read-only local market server at `http://127.0.0.1:2210`. It binds only to localhost, requires no secrets or paid API keys, and exposes:

- `GET /health`
- `GET /api/market-refresh`

The static dashboard always keeps embedded data as the production fallback. When the local market server is available, the browser silently tries `http://127.0.0.1:2210/api/market-refresh` with `http://localhost:2210/api/market-refresh` as a loopback fallback, merges refreshed quote rows, crypto stat cards, and recent chart data, stores the successful local refresh in browser `localStorage` for up to 12 hours, and appends a small footer status after a successful refresh. Reloads on the same embedded dashboard can render the cached local refresh immediately before checking the server again. The server treats chart refreshes and crypto-stat refreshes as independent sections, so one upstream crypto outage does not block otherwise healthy quote/chart updates. For chart data, it reads the embedded `chart-data` block, finds the latest embedded bar, and requests only the missing tail plus internal overlap, capped to avoid large backfills; full Treasury Yield Curve comparison history stays scheduled-only so a short local tail cannot replace the embedded 1M/6M curve context. `--days N` remains an explicit diagnostic override. GitHub Pages continues to work normally when the server is not running.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.

## Daily Update Runbook

Standard local commands:

```sh
node scripts/run_daily_update.js --morning
node scripts/run_daily_update.js --afternoon
node scripts/run_daily_update.js --apply-dashboard-data-json /tmp/dashboard-data.json
node scripts/run_daily_update.js --refresh-news-baseline
```

Codex Scheduler runs should finish with `node scripts/run_daily_update.js --refresh-news-baseline --scheduled` after the final story edits. Manual/ad hoc runs should omit `--scheduled`; they may refresh dashboard content and recompute News Flow and Crypto `New` pills, but they must not advance `newsBaseline.currentScheduledStoryIds`.

This orchestrates the repo-owned deterministic daily refresh steps for the selected window:
- runs the futures fetcher in morning pre-open mode or afternoon session mode
- refreshes staging JSON under `generated/` for futures, chart-data, crypto stat cards, asset-allocation rows, and the sanitized portfolio summary
- patches embedded `futuresModule.futures`, `futuresModule.sectionLabel`, `futuresModule.sectionTitle`, `tape.rows` quote fields, `crypto.stats[]`, `assetAllocationPortfolio.rows`, `assetAllocationPortfolio` summary fields, and the full embedded `chart-data` block
- marks `stories[]` and `crypto.notes[]` cards with `isNewSinceScheduledUpdate` from the embedded scheduled baseline, advancing that baseline only when `--scheduled` is present
- runs dashboard validation

Publish remains a separate explicit step via `./scripts/publish_main.sh`.

For non-deterministic editorial/news work, do not hand-edit the embedded HTML outside the JSON block and do not use ad hoc full-file replacement. Instead:
- prepare the revised `dashboard-data` payload as JSON in a temporary file
- apply it with `node scripts/run_daily_update.js --apply-dashboard-data-json /path/to/dashboard-data.json`
- let the command restamp `editionId` and rerun `scripts/validate_dashboard.js`

1. Confirm dates first.
   - `masthead.date`: today.
   - `footer.compiled`: must include today’s compile date.
   - Never allow stale values such as `January 1`, year `2001`, or a prior-day compile date in `masthead.date` or `footer.compiled`.
   - Do not forward-date the dashboard on the prior evening, even for full-market holidays or after-close refreshes. If the local run date is `July 2`, keep `masthead.date` and the compile date on `July 2`; use `weekAhead`, stories, and `footer.compiled` to explain the next-day holiday context.
   - `tape.label`: current market-record context.
   - If today is Monday or Friday, update `weekAhead`; otherwise leave `weekAhead` mostly unchanged unless a scheduled event has moved.

2. Refresh prices before reading news.
   - Never reuse prices already in the file.
   - Use exact retrieved prices. Use `~` only after exhausting that row's source hierarchy with two attempts per source.
   - For the futures module, chart/quote data, crypto stat cards, asset-allocation ETF rows, and asset-allocation portfolio summary, helper scripts can generate staging JSON under `generated/`. The standard path is `node scripts/run_daily_update.js --morning` or `node scripts/run_daily_update.js --afternoon`, which runs those fetchers and patches the deterministic embedded blocks for you before validation.
   - For ad hoc stock/ETF quote checks, use `node scripts/fetch_chart_data.js --input daily_financial_news.html`; quote rows are derived from the same canonical chart series used by the dashboard.
   - If you need the fetchers individually, use `node scripts/fetch_chart_data.js` for unified chart bars and quote-row staging data, `node scripts/fetch_crypto_stats.js` for the `crypto.stats[]` card payload, `node scripts/fetch_asset_allocation.js` for Asset Allocation ETF rows plus the sanitized portfolio MTD return export, and `node scripts/fetch_futures_module.js --session` for afternoon Session Futures.
   - Production data that must be embedded daily includes `futuresModule.futures`, `futuresModule.stories`, `assetAllocationPortfolio.rows`, and all rows needed by `tape.rows`.
   - In each `tape.rows[].note`, summarize the relevant market commentary or catalyst driving that market. Do not restate `last`, `delta`, or `pct`.
   - In each `tape.rows[]` crypto ticker row (`group: "Crypto"`), include a `note` for the collapsed Tape Crypto tab. Update these notes daily with ticker-specific context; do not reuse one generic crypto note across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible crypto tickers.
   - Do not name quote/news sources in visible copy. Keep source attribution and retrieval/process commentary in `footer.compiled`.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance chart history first; use Finnhub quote data only as a latest-bar repair fallback when Yahoo exposes a newer close but does not provide usable OHLC for that date. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - International equity ETFs such as VEA and VWO: Yahoo Finance chart/quote data first, then clearly labeled high-confidence backups.
   - Sector and commodity ETFs: Yahoo Finance chart history first; use Finnhub latest quotes only for the same latest-bar repair fallback on plain U.S. ETF symbols. MarketWatch quote pages are an acceptable backup.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - Rates volatility and bond proxies: use the configured dashboard source or ETF quote source and label proxy rows clearly.
   - WTI: CME/NYMEX where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used in `footer.compiled`.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Altcoin Season Index: CoinMarketCap Altcoin Season Index. Prefer `node scripts/fetch_crypto_stats.js` so the stat-card `delta` comes from CoinMarketCap's chart API `historicalValues.yesterday`; otherwise use a clear `n/a` rather than fabricating a change.
   - Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2` first, then the Alternative.me page if the API fails.
   - Asset Allocation Portfolio rows: instrument-level ETF market data only. Do not import or recreate tactical allocation/model logic from the separate Asset Allocation Dashboard.
   - For every quote row, follow its full fallback chain before `~`; if no same-day close is available, use the latest verified close and make the trade date clear in the row or footer.
   - If you use a same-day manual quote fallback for a chartable ticker, do not patch only `tape.rows` or `chart-data.quoteRows`. Reconcile the corresponding embedded `chart-data.series` latest bar to the same trade date/value, or validation should fail.

4. Search news after prices.
   - Use today and yesterday as explicit dates in every query; during the scheduled Monday morning dashboard window, add Saturday when needed because the freshness rule may still admit relevant Saturday-dated coverage.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - Morning: `premarket futures [today]`; afternoon: `index futures after the bell [today]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, semis/AI, crypto regulation, ETF flows, stablecoins, hacks/security, protocol updates, and market structure.
   - This repository uses a calendar-date freshness rule, not a rolling 48-hour rule: stories must be dated today or yesterday in America/Chicago, and scheduled Monday morning updates may also keep relevant Saturday-dated coverage.
   - Discard any story outside that calendar-date freshness rule unless it is a standing calendar/source page.
   - Fresh enough to keep is not the same as worthy to keep. On every scheduled run, first search for the best available current coverage within the allowed date window, then let that story set determine the narrative for each card.
   - Do not treat the prior run's card framing as the default. Start from the newly gathered stories, decide what the most important current takeaway is for each slot, and then write the card to match the reporting actually in hand.
   - A carried-forward link may stay only if it remains one of the best available stories after that fresh comparison. A newer story should replace it when the newer link adds a genuinely new catalyst, better explains the move now, is more appropriate for the active slot, or is a clearly better source/link on the same theme.
   - Do not churn links just because the scheduled window changed or because a story is merely newer. Do replace links when the existing article is stale in angle, too narrow for the claim the card now makes, materially weaker than a newly available article, or no longer the best explanation for what is moving prices.
   - If a carried-forward link survives the comparison, rewrite the card copy only as needed so it stays faithful to the reporting actually in hand. The active session matters for whether the story belongs in that slot, not for overriding the story's own narrative.
   - Each `stories[]` and `futuresModule.stories[]` item must include a direct `url` plus a `publishedOn` local date in `YYYY-MM-DD` format so validation can enforce that calendar-date freshness rule before commit.
   - If a link is intentionally an evergreen reference page rather than a dated article, mark it with `referencePage: true`; use that exception sparingly for maintained calendars or official schedule pages, not ordinary news stories.
   - Each `crypto.notes[]` item must include a direct `url`.
   - Do not repeat promoted `futuresModule.stories[]` items in `stories[]`; use What’s Moving Today for additional market breadth.
   - Keep crypto-specific headlines, ETF-flow stories, proxy-equity stories, stablecoin stories, and token/regulation stories out of `stories[]`; those belong in `crypto.notes[]` unless the user explicitly asks to feature crypto in What’s Moving Today.
   - When more than one reputable article covers the same basic story, prefer a free-to-read or less paywalled link. This is a preference, not a hard rule; use the paywalled source when it is clearly the best, original, or most reliable source.
   - Match each `stories[]` and `futuresModule.stories[]` headline/body to the linked article's main reported theme. Do not use a company-specific article to support a broader market, sector, or macro claim unless that broader frame is the article's clear primary thrust.
   - If the best available article supports only a narrower company, earnings, product, or subtheme angle, narrow the card copy to that scope or choose a different link.
   - For any `url` that renders as `READ MORE`, prefer a reader-facing article or HTML page, not a raw API/feed/download endpoint.
   - Do not use machine-readable endpoints such as `query1.finance.yahoo.com`, `api.nasdaq.com`, JSON APIs, CSV downloads, or other raw data feeds as `READ MORE` links.

5. Rewrite the JSON sections in this order.
   - `masthead`: bump volume by 1 and set `masthead.date`.
   - `opening`: update `headline`, `deck`, and four concise catalyst items.
   - `futuresModule`: embed four futures rows and the top one to three priority futures-module stories for the active morning or afternoon update window.
   - `tape`: refresh all required cross-asset rows and commentary.
   - `assetAllocationPortfolio`: embed instrument-level ETF rows with price, MTD dividend, daily return, and MTD return. Before reading the sanitized portfolio-level return export, refresh the Asset Allocation Dashboard export by calling `http://127.0.0.1:2200/api/asset-market-data`, then read `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`. Treat `portfolioMtdReturnValue` as percentage points (`1.24` means `+1.24%`, `-0.35` means `-0.35%`). If the refresh call fails, fall back to the existing export file when present and embed `portfolioMtdReturnStale: true` with the export `asOf` date. Do not call `/api/asset-market-data` for display data; call it only to update the sanitized export. Keep any `upcomingCurrentMonthDividendEvents` or `futureMonthDividendEvents` as display-only lookahead; only current/past ex-date dividends belong in the MTD dividend total.
   - `stories`: exactly 9 fresh non-crypto stories across markets, corporate, macro, geopolitics, Fed, earnings, and other broad market themes.
   - `crypto`: crypto-only stat rows in `crypto.stats[]` for Crypto Market Cap, Altcoin Season Index, and Fear & Greed, plus 4 to 6 fresh crypto notes/stories. Crypto ticker quote rows and ticker-level commentary live in `tape.rows[]` with `group: "Crypto"`.
   - `earnings.week`: canonical Monday-Friday earnings monitor payload. Follow the Earnings Monitor Contract above: Finnhub primary, EarningsAPI secondary for Finnhub-missing display candidates, SEC/company release for official resolution, and Yahoo for market reaction.
   - `weekAhead`: update on Mondays and Fridays. For full U.S. cash-market holidays, use a plain closure label such as `U.S. Markets Closed` in `tickers`; do not list separate exchange closures or append 24/7 assets such as `BTC`. Use the event text to explain why the closure matters for the week, and reserve instrument tickers for rows with an actual scheduled catalyst or market to watch.
   - `footer`: today’s compile date and concise source-family attribution.
   - Remove legacy sections that are not rendered, such as `lede` and `renesas`.

6. Copy and tone rules.
   - Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep publisher attribution out of story titles and bodies. Put source attribution only in `footer.compiled`.
   - Do not write tautological market-status copy that states routine facts without saying why they matter.
   - Market-closure rows should read as status labels, not watchlists. Prefer `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate, then put any crypto or overseas-market context in the event sentence only if it is genuinely relevant.
   - Crypto ticker notes in `tape.rows[]` rows with `group: "Crypto"` should explain the factor driving that ticker or proxy today: bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.
   - Crypto notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation.
   - Do not merely restate quote rows in ticker notes, crypto notes, or story bodies.
   - Earnings color rule: use muted styling for consensus/pending estimates, neutral styling for reported fundamentals such as EPS/revenue/guidance, and red/green only for market reactions or clearly labeled beat/miss surprises. When practical, set `moveRole` or `moveType` to `pending`, `reported`, `guidance`, `marketReaction`, or `surprise`.

7. Validate before finishing.
   - Run `node scripts/validate_dashboard.js daily_financial_news.html`.
   - For regression coverage after script or contract changes, run `node scripts/test_earnings.js` and `node scripts/test_dashboard.js`.
   - Treat Tape ticker notes as a strict validation contract: every `tape.rows[].note`, including rows with `group: "Crypto"`, must be populated, substantive, source-free, and not a quote recap.
   - Run a stale-date guard:
     - `rg -n "\"masthead\"|\"compiled\"|January 1|2001" daily_financial_news.html`
   - Run an HTML-entity guard:
     - `sed -n '/DATA START/,/DATA END/p' daily_financial_news.html | rg -n "&amp;|&lt;|&gt;"`
   - Run a superlative-claim gate:
     - `rg -n "record|all-time|fresh high|new high|record close|record low" daily_financial_news.html`
   - Run a URL hygiene gate:
     - `rg -n "query1\\.finance\\.yahoo\\.com|api\\.nasdaq\\.com|/api/|_format=csv|\\.json\\b" daily_financial_news.html`
   - Run `tidy -q -e daily_financial_news.html`.
   - Run `git diff --check`.
   - Browser-check the production page after structural or layout changes.
   - Confirm only intended files changed.

8. Commit and publish.
   - Commit directly on `main`.
   - After each dashboard update commit, run `./scripts/publish_main.sh`.
   - Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.
