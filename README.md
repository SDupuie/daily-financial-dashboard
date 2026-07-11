# Daily Financial Dashboard

## What this repo publishes

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

### Production files

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `index.html`: published root entry point; it routes visitors to `daily_financial_news.html`.
- `scripts/`: operational fetch, validation, and publish helpers.
- `launchd/`: optional local-machine LaunchAgent templates for running dashboard helper scripts.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

The main dashboard payload lives inside:

```html
<!-- ============ DATA START — edit this block to update the dashboard ============ -->
...
<!-- ============ DATA END ============ -->
```

Do not touch the HTML, CSS, or JavaScript outside generated data blocks for a daily dashboard refresh.

Production is self-contained: the rendered dashboard reads embedded `dashboard-data` and `chart-data` JSON blocks. Helper scripts may generate staging JSON snippets, but no production section should fetch sidecar JSON files at runtime.

## Scheduled preflight

- In `America/Chicago`, the morning update window is 6:45–8:00 AM and the afternoon window is 3:45–5:00 PM. Proceed only on a weekday inside one of those windows; otherwise stop before fetching, editing, committing, or publishing.
- Select the active window from that local time and keep the dashboard date and compile date on the local run date.
- Before editing, run the scheduled preflight for the active window. It refuses a duplicate completed-window marker while allowing a completed morning run and the afternoon run to proceed independently.

## Daily runbook (normal path)

### Command matrix

| Run | Deterministic refresh | Editorial patch | Finish | Publish |
| --- | --- | --- | --- | --- |
| Scheduled | First run `node scripts/run_daily_update.js --scheduled-preflight --morning` or `--afternoon`, then run the matching deterministic refresh | Apply the completed `dashboard-data` JSON with `node scripts/run_daily_update.js --apply-dashboard-data-json /path/to/dashboard-data.json` | `node scripts/run_daily_update.js --refresh-news-baseline --scheduled --morning` or `--afternoon` | Commit on `main`, then run `./scripts/publish_main.sh` |
| Manual/on-demand | Run the matching `node scripts/run_daily_update.js --morning` or `node scripts/run_daily_update.js --afternoon` path | Apply the completed `dashboard-data` JSON with `node scripts/run_daily_update.js --apply-dashboard-data-json /path/to/dashboard-data.json` | `node scripts/run_daily_update.js --refresh-news-baseline` | Commit and publish when the manual update is intended to go live |

The scheduled preflight is read-only: it enforces the weekday/Chicago-time window and refuses a completed `YYYY-MM-DD:morning|afternoon` marker. Every deterministic refresh updates futures, chart data, Tape quote fields, crypto stat cards, Asset Allocation data, and earnings results. Calendar slates refresh only on Friday afternoon and Monday morning: Friday afternoon shows the current Friday plus next Monday-Thursday, while Monday morning replaces that Friday with the current Monday-Friday slate. For editorial/news work, edit only the `dashboard-data` JSON and use `--apply-dashboard-data-json`; it restamps `editionId` and validates. For an already-generated chart-only payload, use `--apply-chart-data-json`; it embeds the series and rebuilds matching `chart-data.quoteRows` and visible Tape prices. A standalone scheduler must not publish directly because it cannot complete the required editorial judgment.

Manual runs may occur outside the scheduled windows. Choose `--morning` or `--afternoon` for the intended dashboard edition and market session, and keep the dashboard date on that local run date.

### Daily editorial checklist

1. Confirm dates first.
   - `masthead.date`: today.
   - `footer.compiled`: must include today’s compile date.
   - Never allow stale values such as `January 1`, year `2001`, or a prior-day compile date in `masthead.date` or `footer.compiled`.
   - Do not forward-date the dashboard on the prior evening, even for full-market holidays or after-close refreshes. If the local run date is `July 2`, keep `masthead.date` and the compile date on `July 2`; use `weekAhead`, stories, and `footer.compiled` to explain the next-day holiday context.
   - `tape.label`: current session and the key market drivers.
   - Friday afternoon refreshes both calendars to current Friday plus next Monday-Thursday. Monday morning replaces that bridge with the current Monday-Friday slate. All other updates retain the existing calendar days while refreshing non-calendar dashboard content and arrived earnings results.

2. Run the normal deterministic refresh before reading news.
   - Use the matching Command matrix entry. The orchestrator owns futures, chart/quote, crypto-stat, Asset Allocation, Week Ahead, and earnings refreshes; do not hand-patch those deterministic values unless it fails and the Manual fallback reference applies.
   - Earnings are refreshed and embedded by the orchestrator. If it exits with code `2`, supply the required earnings editorial copy, then rerun the same deterministic command. When reported EPS, revenue, guidance, timing, or market-reaction facts change, the prior narrative is invalidated and must be replaced; do not restore pre-report copy from `earnings_narrative.json`. On a Friday/Monday rollover, Week Ahead remains published because its validated generated lens is an acceptable fallback; the prior embedded Earnings slate remains in place until its required narratives are complete. See Appendix: Earnings operations only when the detailed provider, sidecar, or row-contract rules are needed.
   - Review the orchestrator-patched quote fields and data blocks. If a value is stale, missing, or failed to refresh, use the Manual Fallback Reference rather than editing a deterministic value by hand.
   - In each `tape.rows[].note`, summarize the relevant market commentary or catalyst driving that market. Rewrite every tape note on each dashboard update instead of carrying commentary forward. Do not restate `last`, `delta`, or `pct`.
   - In each `tape.rows[]` crypto ticker row (`group: "Crypto"`), include a `note` for the collapsed Tape Crypto tab. Update these notes daily with ticker-specific context; do not reuse one generic crypto note across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible crypto tickers.
   - Do not name quote/news sources in visible copy. Keep the compact source-family attribution in `footer.compiled`; use chart source details for row-specific provenance.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Search news after prices.
   - This is a required step on every scheduled run, before any story set is finalized.
   - Start every scheduled run with a fresh news search pass and keep previous links only if they remain among the best available reporting after direct comparison.
   - Use today and yesterday as explicit dates in every query; during the scheduled Monday morning dashboard window, add Saturday when needed because the freshness rule may still admit relevant Saturday-dated coverage.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - Morning: `premarket futures [yesterday] [today]`; afternoon: `index futures after the bell [today]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, semis/AI, crypto regulation, ETF flows, stablecoins, hacks/security, protocol updates, and market structure.
   - Follow the News-card contract and Story selection policy below for collection counts, required fields, freshness, source choice, carry-forward decisions, and link rules.

4. Rewrite the JSON sections in this order.
   - `masthead`: set `masthead.edition` to `Morning Edition` or `Afternoon Edition` for the active run and set `masthead.date`.
   - `opening`: update `headline`, `deck`, and four concise catalyst items.
   - `futuresModule`: embed four futures rows and the active window’s stories per the News-card contract. Use each story’s descriptive `tag` for its visible badge.
   - `tape`: refresh all required cross-asset rows and commentary.
   - `assetAllocationPortfolio`: review the orchestrator-patched ETF rows and sanitized portfolio summary. Use the Asset Allocation fallback only if that refresh fails.
   - `stories`: update the broad-market news collection per the News-card contract.
   - `crypto`: update crypto-only stat rows in `crypto.stats[]` plus the crypto news collection per the News-card contract. Crypto ticker quote rows and ticker-level commentary live in `tape.rows[]` with `group: "Crypto"`.
   - `earnings.week`: canonical five-trading-day earnings monitor payload. Its detailed provider, sidecar, and row-contract rules live in Appendix: Earnings operations.
   - `weekAhead`: official schedules own covered release dates and Eastern times, while FXMacroData supplies labeled U.S. actuals, prior releases, and forecasts through `scripts/fetch_week_ahead.js`; no API key is required. The fetcher overlays the maintained BLS CPI/PPI, employment, and JOLTS schedule plus EIA/FOMC calendars with the live Census and BEA calendars. Do not hand-edit dates, times, event names, impact levels, or actual/forecast/previous values. A covered official release remains visible with blank values when FXMacroData lacks an exact labeled match; FXMacroData cannot move an official date or time. Market-consensus forecasts are unbadged; central-bank forecasts render with a `Nowcast` pill and FXMacroData blended forecasts with a `Model` pill, each naming its source and clarifying that it is not market consensus. The canonical payload stores U.S. release times in Eastern market time and the renderer converts them to Central time. Full U.S. cash-market closures come from the maintained local calendar contract.
   - After the deterministic Week Ahead refresh, review each generated `days[].marketLens` against the current Tape, opening, and verified news. Replace it only when the editorial lens adds all three: a current, verified market setup; a specific transmission path between that setup and the scheduled release; and a conditional consequence for relevant instruments or sectors. Set `marketLensSource: "editorial"` for a replacement; otherwise retain the generated lens. Do not alter calendar facts, restate the displayed values, use source/process language, or write tactical-allocation advice. The generated lens is the fallback and an editorial override is preserved only for its matching calendar date.
   - `footer`: today’s compile date and concise source-family attribution.
   - Remove legacy sections that are not rendered, such as `lede` and `renesas`.

5. Copy and tone rules.
   - Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep publisher attribution out of story titles and bodies. Put source attribution only in `footer.compiled`.
   - Do not write tautological market-status copy that states routine facts without saying why they matter.
   - Market-closure rows should read as status labels, not watchlists. Prefer `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate, then put any crypto or overseas-market context in the event sentence only if it is genuinely relevant.
   - Crypto ticker notes in `tape.rows[]` rows with `group: "Crypto"` should explain the factor driving that ticker or proxy today: bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.
   - Crypto notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation.
   - Do not merely restate quote rows in ticker notes, crypto notes, or story bodies.
   - Earnings color rule: use muted styling for consensus/pending estimates, neutral styling for reported fundamentals such as EPS/revenue/guidance, and red/green only for market reactions or clearly labeled beat/miss surprises. When practical, set `moveRole` or `moveType` to `pending`, `reported`, `guidance`, `marketReaction`, or `surprise`.

## News-card contract

Every news card is a dated, reader-facing article. Do not use `referencePage`; durable calendars and schedules belong in `weekAhead` or footer context.

| Collection | Count and scope | Required fields |
| --- | --- | --- |
| `stories[]` | Exactly 9 broad-market, non-crypto cards | `tag`, `title`, `body`, HTTPS `url`, `publishedOn` |
| `crypto.notes[]` | 4–6 crypto-specific cards | `kicker`, `title`, `body`, HTTPS `url`, `publishedOn` |
| `futuresModule.stories[]` | Exactly 3 current Futures catalysts | `tag` (24 characters or fewer to preserve the shared label column), `title`, `body`, HTTPS `url`, `publishedOn`, offset-bearing ISO `publishedAt` |

- `publishedOn` is an `America/Chicago` date in `YYYY-MM-DD` format. It must be today or yesterday; scheduled Monday-morning runs may also use Saturday-dated coverage.
- Futures `publishedAt` must be verified and inside the active session window. Morning stories run from the shared fetched `futuresModule.futures[].raw.referenceDate` close (4:00 PM Eastern) through the dashboard run time. Afternoon stories run from 9:30 AM Eastern through the earlier of 4:00 PM Eastern or the dashboard run time.
- Do not duplicate a promoted Futures story’s URL or title in `stories[]`. Keep crypto-specific headlines, ETF flows, proxy equities, stablecoins, token/regulation, and protocol/security coverage in `crypto.notes[]` unless explicitly requested for the main news flow.
- `isNewSinceScheduledUpdate` is generated from the scheduled baseline; do not set it by hand.

### Story selection policy

- Fresh enough to keep is not the same as worthy to keep. Start from the best current reporting inside the News-card contract, then let that reporting determine each card's narrative rather than preserving the prior run's framing.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, readable Reuters, CNBC, Investopedia, Kiplinger, Investor's Business Daily, Yahoo Finance, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, Blockworks, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
- Match every story's headline and body to its linked article's main reported theme. Narrow a card to a company, earnings, product, or subtheme angle when that is all the reporting supports; do not use it to imply a broader market, sector, or macro claim.
- `READ MORE` links must be reader-facing HTML pages, never raw APIs, feeds, JSON, or CSV downloads.

## Manual Fallback Reference

Use this reference only when the deterministic orchestrator fails and a documented manual fallback is necessary. Do not use it as an alternate daily workflow.

### One-off fetch commands

- For an ad hoc stock/ETF quote check, use `node scripts/fetch_chart_data.js --input daily_financial_news.html`; quote rows are derived from the canonical chart series used by the dashboard.
- Individual staging fetchers are `node scripts/fetch_chart_data.js`, `node scripts/fetch_crypto_stats.js`, `node scripts/fetch_asset_allocation.js`, `node scripts/fetch_week_ahead.js`, and `node scripts/fetch_futures_module.js --session` for afternoon Session Futures.

### Price-source hierarchy

- U.S. indices and equities: Yahoo Finance chart history first; use Finnhub quote data only as a latest-bar repair fallback when Yahoo exposes a newer close but does not provide usable OHLC for that date. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
- International equity ETFs such as VEA and VWO: Yahoo Finance chart/quote data first, then clearly labeled high-confidence backups.
- Sector and commodity ETFs: Yahoo Finance chart history first; use Finnhub latest quotes only for the same latest-bar repair fallback on plain U.S. ETF symbols. MarketWatch quote pages are an acceptable backup.
- Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
- Rates volatility and bond proxies: use the configured dashboard source or ETF quote source and label proxy rows clearly.
- WTI: CME/NYMEX where available; MarketWatch, Trading Economics, or Reuters as backup.
- Gold and silver: GoldPrice.org spot close or MarketWatch futures close. Preserve the chosen source in the chart source details.
- Crypto majors: CoinGecko or CoinMarketCap.
- Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
- Altcoin Season Index: CoinMarketCap Altcoin Season Index. Prefer `node scripts/fetch_crypto_stats.js` so the stat-card `delta` comes from CoinMarketCap's chart API `historicalValues.yesterday`; otherwise use a clear `n/a` rather than fabricating a change.
- Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2` first, then the Alternative.me page if the API fails.
- Asset Allocation Portfolio rows: instrument-level ETF market data only. Do not import or recreate tactical allocation/model logic from the separate Asset Allocation Dashboard.

For every manually refreshed quote row, follow its full fallback chain before using `~`; never reuse the prior embedded price as a substitute. If no same-day close is available, use the latest verified close and make the trade date clear in the row or footer. For a chartable ticker, reconcile the corresponding embedded `chart-data.series` latest bar to the same trade date/value; do not patch only `tape.rows` or `chart-data.quoteRows`.

### Asset Allocation fallback

- Refresh the local Asset Allocation Dashboard export through `http://127.0.0.1:2200/api/asset-market-data`, then read `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`.
- If the refresh fails but the export exists, use that export, set `portfolioMtdReturnStale: true`, and copy the export's `asOf` date to `portfolioMtdReturnAsOf`; see the `assetAllocationPortfolio` data contract for field semantics.
- The endpoint only refreshes the sanitized local export; never call it from the published dashboard or use it as display data.

## Validation and publish

### Required daily checks

- Run `node scripts/validate_dashboard.js daily_financial_news.html`. It enforces dates, News-card freshness, embedded-data text hygiene, and Tape note quality. Treat a Futures News-card contract failure as a hard stop; do not finish a scheduled update with `--skip-validate`.
- Run `git diff --check`.
- Confirm that only intended files changed. `./scripts/publish_main.sh` runs dashboard validation again before it pushes.

### Expanded content and layout checks

Run the applicable checks after content, structural, layout, script, or contract changes:

- Superlative-claim gate: `rg -n "record|all-time|fresh high|new high|record close|record low" daily_financial_news.html`
- URL hygiene gate: `rg -n "query1\\.finance\\.yahoo\\.com|api\\.nasdaq\\.com|/api/|_format=csv|\\.json\\b" daily_financial_news.html`
- Run `tidy -q -e daily_financial_news.html` and browser-check the production page after structural or layout changes. Browser-check the Week Ahead section after changing an editorial `marketLens` for readability and overflow.
- Run `node scripts/test_calendar_contract.js`, `node scripts/test_earnings.js`, `node scripts/test_week_ahead.js`, and `node scripts/test_dashboard.js` after script or data-contract changes.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.

## Appendix: Data contracts

This section is the canonical human-readable contract for dashboard data. Keep `scripts/validate_dashboard.js`, `scripts/validate_chart_data.js`, and fetch-script output in sync with this section whenever a payload shape changes.

### Embedded `dashboard-data`

- `editionId`: ISO timestamp identifying the exact embedded dashboard edition. Bump it every time helper scripts rewrite `dashboard-data`; localhost refresh cache keys must use this field rather than inferring identity from the visible date/ticker shape.
- `masthead`: visible header metadata. `masthead.date` must be the dashboard date. `masthead.edition` must match the Futures session: `Morning Edition` for `Before The Open` / `Pre-Market Futures`, or `Afternoon Edition` for `After The Bell` / `Session Futures`. Use `editionId` for exact build/revision identity rather than a visible serial number.
- `opening`: market-open summary with `headline`, `deck`, and exactly four `catalysts[]` items.
- `futuresModule`: the four-card futures module and promoted Futures news. Use `sectionLabel`/`sectionTitle` to distinguish morning `Before The Open` / `Pre-Market Futures` from afternoon `After The Bell` / `Session Futures`; see the News-card contract for story rules.
- `tape`: the cross-asset Tape table. All ticker quote rows, including crypto tickers, live in `tape.rows[]`.
- `assetAllocationPortfolio`: instrument-level ETF market data and sanitized portfolio-level summary fields only. Do not embed tactical model logic or derived allocation calculations.
- `stories`: broad-market, non-crypto news cards; see the News-card contract.
- `newsBaseline`: embedded scheduled-update comparison state for the News Flow and Crypto `New` pills. `currentScheduledStoryIds` stores the most recent scheduled run's `stories[]` and `crypto.notes[]` identities, while `previousScheduledStoryIds` is the comparison set used to keep manual runs from consuming scheduled newness. `lastScheduledWindow` is the completed `YYYY-MM-DD:morning|afternoon` marker checked by the next scheduled preflight.
- `crypto`: crypto section metadata, crypto-only stat rows, and crypto story notes. Crypto ticker quote rows do not live here.
- `earnings.week`: canonical five-trading-day earnings monitor payload. Its range is Monday-Friday after the Monday-morning refresh, or Friday plus next Monday-Thursday after the Friday-afternoon refresh; see Appendix: Earnings operations.
- `weekAhead`: a five-trading-day deterministic economic-event ledger. `range.timeZone` is the dashboard display zone (`America/Chicago`) and `range.marketTimeZone` is the stored U.S. release zone (`America/New_York`). Its range is Monday-Friday after Monday morning, or current Friday plus next Monday-Thursday after Friday afternoon. Each event contains a stable ID, Eastern `time`, canonical name, agency, period, local impact classification, nullable FXMacroData `actual`, `forecast`, and `previous` values, plus `forecastType`, `forecastSource`, `scheduleSource`, `valueSource`, and `verification`. FXMacroData predictions match official releases by indicator and exact Eastern date/time; the matched prediction's `announcement_id` then links its forecast to the corresponding FXMacroData actual. `consensus` forecasts display without a badge, `nowcast` forecasts show a `Nowcast` pill, and FXMacroData blended `model` forecasts show a `Model` pill. `officialSchedule.events[]` is the embedded authoritative manifest; validation requires every covered release and variant at its official date and time. `officialSchedule.authorities[]` records the source calendars. The maintained BLS/EIA/FOMC schedules require an annual renewal before their coverage year ends. `days[].marketLens` is present only when the day has covered events; it is a generated fallback from the highest-impact covered event. Replace it only with a current, verified editorial setup that explains the release's transmission path and conditional market consequence; set `days[].marketLensSource` to `editorial` to preserve that override for the matching calendar date. `generated/week_ahead.json` is staging/cache only and is never fetched by the published dashboard.
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

### `assetAllocationPortfolio`

This section may contain instrument-level ETF market data and a sanitized portfolio MTD-return summary only; never embed tactical weights, signals, or allocation calculations.

- `rows[]` must cover `VTI`, `VEA`, `VWO`, `VNQ`, `DBC`, `GLD`, `IEF`, and `BOXX`. Each row includes `ticker`, `sleeve`, `price`, `monthDivPerShare`, `dailyPriceChange`, `dailyTR`, `mtdPriceChange`, and `mtdTR`.
- Each row also carries display-only dividend buckets: current/past `dividends[]`, plus `upcomingCurrentMonthDividends`, `upcomingCurrentMonthDividendsValue`, `upcomingCurrentMonthDividendEvents`, `futureMonthDividends`, `futureMonthDividendsValue`, and `futureMonthDividendEvents`. Lookahead events never enter current MTD dividend totals.
- The sanitized summary uses `portfolioMtdReturnStatus` (`available` or `unavailable`), `portfolioMtdReturnValue`, `portfolioMtdReturnAsOf`, and `portfolioMtdReturnStale`. `portfolioMtdReturnValue` is percentage points (`1.24` renders as `+1.24%`); it is `null` when status is `unavailable`.

### `crypto`

Crypto section data has this contract:

```json
{
  "stats": [
    { "sym": "F&G", "name": "Fear & Greed Index", "sub": "Extreme Fear", "price": "21", "delta": "+2", "chg": "+2", "dir": "up" },
    { "sym": "ALTSEASON", "name": "Altcoin Season Index", "sub": "Neutral", "price": "48", "delta": "Unchanged", "chg": "/100", "dir": "flat" },
    { "sym": "TOTAL", "name": "Crypto Market Cap", "sub": "Expanding", "price": "2.21T", "delta": "+$43.86B", "chg": "+2.03%", "dir": "up" }
  ],
  "dominance": { "btc": "55.64%", "eth": "9.28%", "others": "35.08%" },
  "notes": [{
    "kicker": "ETF Flows",
    "title": "Bitcoin demand remains the institutional test",
    "body": "Fund flows and macro risk appetite remain the near-term drivers.",
    "url": "https://example.com/crypto-story",
    "publishedOn": "2026-07-09"
  }]
}
```

- `crypto.stats[]` is for crypto-only section stat cards: Fear & Greed, Altcoin Season Index, and Crypto Market Cap.
- `crypto.notes[]` holds crypto-specific news cards; see the News-card contract for its count, fields, and freshness rules.
- `crypto.tape[]` is deprecated and validation should reject it.

### `futuresModule`

- `futuresModule.futures[]` must contain exactly four index-futures rows.
- Morning `Pre-Market Futures` rows chart the overnight Globex window from the prior futures reopen through the latest morning tick.
- Afternoon `Session Futures` rows chart the regular market window, normally 9:30 AM to 4:00 PM Eastern, and compare the latest regular-session futures value with the prior trading day's official 4:00 PM Eastern futures close.
- Dashboard display times should be local, but raw official session labels and fields must be stored in Eastern terms: `marketTimeZone: "America/New_York"`, `sessionStartEastern`, `sessionEndEastern`, `referenceCloseEastern`, and `referenceLabel: "prior 4 PM ET close"`.
- `raw.referencePrice` is the comparison baseline used for Session Futures chart/reference calculations. Keep `raw.previousClose` as the source's futures prior close when available.
- Morning update labels are `Before The Open` / `Pre-Market Futures`; its charts cover the overnight Globex session from the prior futures reopen, normally 5:00 PM Central / 6:00 PM Eastern, through the latest morning tick.
- Afternoon update labels are `After The Bell` / `Session Futures`; its charts cover regular market hours, normally 8:30 AM to 3:00 PM Central / 9:30 AM to 4:00 PM Eastern. Store the official comparison fields in Eastern terms and use `node scripts/fetch_futures_module.js --session` for this session payload.
- Futures-story requirements, including the strict publication window, live in the News-card contract. Holiday or unusual-session updates should use the closest accurate window label and explain the shortened or closed cash-market context in `footer.compiled`.

### Embedded `chart-data`

The `chart-data` block is generated chart history plus quote-row staging data:

- `schemaVersion` must be `1`.
- `barEncoding` must be `tuple-v1`: every `series[].bars[]` entry is `[time, open, high, low, close, volume]`, with `volume` set to `null` when unavailable. OHLC values are rounded to at most four decimal places before embedding; the runtime expands tuples back into normal bar objects before rendering.
- `range.days` must be at least `1826` so the 5Y chart shortcut has enough embedded history.
- `series[]` is the canonical embedded price-history store. It must include every chartable ticker from `tape.rows[]`, with matching `ticker`, `section`, and `sourceSymbol`.
- `quoteRows.tape[]` is a derived view over non-crypto `series[]` using `last`, `delta`, and `pct`.
- `quoteRows.crypto[]` is a derived view over crypto `series[]` using the crypto refresh shape: `price`, `delta`, and `chg`. The dashboard maps these back onto `tape.rows[].last`, `delta`, and `pct`.
- Treasury yield-curve series must include `curveDate`, current `curvePoints[]`, `comparisonCurves[]` entries labeled `1M ago` and `6M ago`, and a `curveSpread` object for the 2s10s display row.
- Each `comparisonCurves[].points[]` array must match the current curve's maturity labels in order so the renderer can draw historical lines maturity-for-maturity.
- Published production renders from embedded `dashboard-data`, but canonical market data still lives in embedded `chart-data.series`; `quoteRows` and the visible Tape price fields are derived views and must stay in sync with that series history.

## Appendix: Earnings operations

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`; provider sidecars are build-time inputs only. The goal is to let providers collect data and let AI write concise interpretation only after the numeric facts are fixed.

### Source hierarchy

1. Finnhub primary: calendar slate, company profile, market cap, timing, EPS estimate, EPS actual, revenue estimate, and revenue actual when Finnhub has the row.
2. Finnhub profile recovery: fetch `profile2` with retry/backoff for 429s and cache successful profiles in `generated/finnhub_profile_cache.json`; if live `profile2` still rate-limits or fails transiently, use the cached profile with audit flags. If Finnhub has the earnings row but profile identity is still empty, use Finnhub `stock/metric` only for market cap and EarningsAPI calendar only for company name. Successful Finnhub metric market caps are cached in `generated/finnhub_metric_cache.json` to reduce repeated rate-limit exposure. EPS, revenue, timing, and slate still remain Finnhub.
3. EarningsAPI secondary: missing ticker/date discovery and row-level specifics only for Finnhub-missing display candidates. Use the EarningsAPI company endpoint for row specifics; treat the EarningsAPI calendar endpoint as discovery only except for the profile-empty company-name recovery above.
4. SEC/company release resolution: official actuals, fiscal-period confirmation, timing when needed, and EPS basis notes for queued company-release tasks.
5. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

Do not use metered EarningsAPI calls to audit every Finnhub-covered row. EarningsAPI is limited to Finnhub-missing display candidates plus the narrow company-name recovery for Finnhub-covered rows whose Finnhub profile is empty. EarningsAPI must never override a Finnhub-covered row's EPS, revenue, timing, or slate.

### Canonical row shape

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

### EarningsAPI budget policy

- Treat the monthly quota as a scarce secondary-recovery budget, not a primary data source.
- During a weekly build, query EarningsAPI calendar across the active week plus a bounded seven-day lookback and 28-day lookahead for date corroboration. This scan never runs during ordinary result refreshes.
- Query EarningsAPI company rows only for Finnhub-missing display candidates.
- Do not call EarningsAPI reactions in the normal path; Yahoo remains the reaction source.
- Keep a monthly call counter and stop optional calls before the limit. Preserve reserve capacity for urgent secondary-recovery checks.

### Update methodology

Treat weekly slate construction and post-report result refresh as separate jobs. The weekly slate job builds the five calendar cards and expected reporting universe; the result-refresh job updates only rows whose report window has arrived or passed. Do not keep probing calendar/discovery endpoints for the same static week slate during every dashboard refresh.

#### Weekly slate construction

1. The orchestrator builds a calendar slate only when a Friday-afternoon or Monday-morning target range differs from the canonical generated `earnings_week.json` range. Friday uses current Friday plus next Monday-Thursday; Monday uses the current Monday-Friday. A rerun after earnings editorial copy is supplied retains that just-built slate. Run `node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD` only to intentionally rebuild one of those supported five-trading-day ranges.
2. Fetch Finnhub earnings calendar for the selected five trading days.
3. Fetch Finnhub profiles for Finnhub rows and filter display eligibility by market cap, country/exchange/profile quality, and watchlist rules.
4. If Finnhub fails, returns zero usable rows, or returns fewer than the configured minimum usable rows, fail closed instead of promoting a secondary source into the whole slate. The default minimum is `max(1, weekdays * 2)`, so the normal Monday-Friday strip requires at least 10 Finnhub rows before any EarningsAPI secondary-recovery calls. Use `--min-finnhub-rows 1` only for intentional holiday-week or diagnostic runs.
5. Fetch EarningsAPI calendar across the active week plus a bounded seven-day lookback and 28-day lookahead. Use only active-week rows for secondary recovery; use the wider scan solely to corroborate report dates.
6. Every displayed calendar row needs date verification. A Finnhub row passes with one matching EarningsAPI date; any provider-date disagreement—whether within or outside the active five-trading-day range—or a missing secondary match queues the row in `generated/earnings_schedule_review.json`. An EarningsAPI-only recovery row also queues there because it has no independent calendar corroboration. The dashboard update stops until an official IR confirmation is supplied. Nasdaq is audit-only in this flow; it does not choose a date over the official company source.
7. An official confirmation row must contain `symbol`, `reportDate`, `sourceName`, and an HTTPS `sourceUrl`. If its date is in the active week, the canonical row moves to that date; if it is outside the active week, the row is excluded. After adding or changing a confirmation, rebuild the active week with `node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD`, then rerun the deterministic orchestrator.
8. For Finnhub rows, fetch `profile2` with 429 retry/backoff and use `generated/finnhub_profile_cache.json` only after live profile fetches fail or rate-limit. For rows with empty Finnhub profile data after that, read cached Finnhub `stock/metric` market cap first, then fetch the metric endpoint with conservative retry/backoff if uncached; use the matching EarningsAPI calendar row for company name only. This may make a Finnhub-covered row display-eligible, but it must not change Finnhub EPS, revenue, timing, or outcome.
9. Compare active-week EarningsAPI-discovered symbols against the corroborated Finnhub slate. Queue only symbols absent from Finnhub as `secondaryRecoveryCandidates`; same-symbol date conflicts must collapse to one audited canonical row, not duplicate recovery rows.
10. For each queued candidate, fetch the EarningsAPI company endpoint and select the row matching the report date. Use that row for EPS/revenue estimates and actuals only after the date is consistent.
11. Persist the canonical `earnings_week.json` with the verified slate, estimates, timing, profile fields, recovery candidates, and source audit. This artifact becomes the input for later result refreshes.

`earnings_schedule_confirmations.json` uses this local generated-artifact shape:

```json
{
  "schemaVersion": 1,
  "rows": [{
    "symbol": "H",
    "reportDate": "2026-07-30",
    "sourceName": "Hyatt investor relations",
    "sourceUrl": "https://investors.hyatt.com/"
  }]
}
```

#### Post-report result refresh

1. Run `node scripts/earnings_week.js refresh` against the existing canonical `earnings_week.json`; outside the Friday-afternoon and Monday-morning rollover windows, do not rebuild the slate.
2. Select only rows whose report timing has arrived or passed, plus unresolved rows with `companyReleaseTasks`.
3. Refresh actual EPS/revenue from the row's primary deterministic source: Finnhub for Finnhub-covered rows, EarningsAPI company endpoint for previously recovered EarningsAPI rows, and SEC/company release only for official resolution tasks. Do not call EarningsAPI calendar in this phase.
4. Create `companyReleaseTasks` only for recovered rows with missing actuals or missing timing, or for an arrived Nasdaq-resolved provider-date conflict whose actuals remain unavailable. Do not use company-release resolution to recover analyst estimates.
5. Resolve `companyReleaseTasks` against SEC/company release into `earnings_company_release_resolutions.json` with `node scripts/earnings_week.js resolve`. Besides secondary-recovery rows, a row with a Nasdaq-resolved provider-date conflict escalates here once its report window has arrived and provider actuals remain unavailable; retain its Finnhub estimates for comparison.
6. Apply resolved company-release facts back into the canonical `earnings_week.json` rows with `node scripts/earnings_week.js apply-release`. The dashboard should not merge the sidecar at render time.
7. Compute EPS and revenue beat/miss mechanically from numeric estimate and actual values. If revenue estimate is unavailable, produce an EPS-only outcome and mark revenue `not_compared`.
8. Compute market reaction from Yahoo using timing-aware rules once the needed close is available: BMO/DMH = report-date close vs previous trading-day close; AMC = next trading-day close vs report-date close; unknown = unavailable.
9. Let AI write only narrative fields such as `outcome.interpretation`, `outcome.guide`, `reaction.note`, `eps.note`, and `revenue.note` into `earnings_narrative.json`, using the verified numeric row plus any official-release guidance text. AI must not invent data, dates, estimates, actuals, or reaction values. If the deterministic refresh stages a newly display-eligible row without complete narrative, it writes the row into the sidecar and defers earnings apply/embed; enrich that sidecar before continuing with steps 10 and 11. A deterministic change to a reported row invalidates its old sidecar copy: the next sidecar sync clears it, requires fresh post-report text, and will not accept a carried-forward preview. For every displayed reported row, `outcome.interpretation` must be one terse, decision-relevant business takeaway (120 characters or fewer)—such as guidance, margins, demand, pricing, segment trends, inventory, costs, or valuation tension—not a restatement of EPS/revenue beats or misses. `outcome.guide` must, in 130 characters or fewer, name a verified quarterly or full-year horizon, or clearly state that no updated/formal guidance was provided; a generic reference to a year is not guidance. Do not repeat the column title as an inline prefix. When management provides both, lead with the next-quarter outlook; add the full-year outlook only when it confirms, qualifies, or contradicts that nearer-term message. For a computed reaction, `reaction.note` must be one terse, driver-focused sentence (100 characters or fewer) that explains what investors are weighing—not repeat the displayed share-price move or close-to-close calculation. When a specific driver cannot be verified, summarize the result detail investors are weighing without asserting unsupported causation.
10. Apply narrative back into the canonical `earnings_week.json` rows with `node scripts/earnings_week.js apply-narrative`. The dashboard should not carry ticker-specific commentary maps.
11. Embed the validated canonical payload into `daily_financial_news.html` with `node scripts/earnings_week.js embed`. The published dashboard should not fetch `generated/earnings_week.json` at runtime.

### Company-release resolution sidecar

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

The company-release sidecar is not a dashboard runtime input. It must identify the exact canonical earnings week artifact it was derived from with `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`; `node scripts/earnings_week.js validate-release` verifies those fields against the week file before any apply step uses the sidecar. When the current week has no `companyReleaseTasks[]`, refresh removes a stale sidecar and `validate-release` succeeds as not applicable. Every active task must have exactly one matching `companyReleaseResolutions[]` entry. A dashboard-ready `earnings_week.json` with company-release tasks must also include `companyReleaseApply`, every task must be applied with no skipped tasks, and the matching canonical row must contain the applied `sourceAudit.companyReleaseResolution`. SEC/company-release resolution may carry estimates forward only from the EarningsAPI company endpoint for recovered rows, or from Finnhub for a resolved provider-date conflict; never use the EarningsAPI calendar discovery row.

The narrative sidecar uses the same source anchor fields: `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`. `node scripts/earnings_week.js apply-narrative` rejects narrative generated from a different earnings week artifact before writing any canonical rows.

## Appendix: Local refresh server

Run `node scripts/local_market_server.js` to start a read-only local market server at `http://127.0.0.1:2210`. It binds only to localhost, requires no secrets or paid API keys, and exposes:

- `GET /health`
- `GET /api/market-refresh`

The static dashboard always keeps embedded data as the production fallback. When the local market server is available, the browser silently tries `http://127.0.0.1:2210/api/market-refresh` with `http://localhost:2210/api/market-refresh` as a loopback fallback, merges refreshed quote rows, crypto stat cards, and recent chart data, stores the successful local refresh in browser `localStorage` for up to 12 hours, and appends a small footer status after a successful refresh. Reloads on the same embedded dashboard can render the cached local refresh immediately before checking the server again. The server treats chart refreshes and crypto-stat refreshes as independent sections, so one upstream crypto outage does not block otherwise healthy quote/chart updates. For chart data, it reads the embedded `chart-data` block, finds the latest embedded bar, and requests only the missing tail plus internal overlap, capped to avoid large backfills; full Treasury Yield Curve comparison history stays scheduled-only so a short local tail cannot replace the embedded 1M/6M curve context. `--days N` remains an explicit diagnostic override. GitHub Pages continues to work normally when the server is not running.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.
