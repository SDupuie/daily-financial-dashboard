# Daily Financial Dashboard

## What this repo publishes

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

### Production files

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `index.html`: published root entry point; it routes visitors to `daily_financial_news.html`.
- `scripts/`: operational fetch, validation, and publish helpers.
- `launchd/`: optional local-machine LaunchAgent templates for running dashboard helper scripts.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

### Sources of authority

- `AGENTS.md` is the compact project-policy source for the deterministic, commentary, publication, and fail-open update guarantees.
- This `README.md` is the canonical human-readable operational and data-contract source.
- `daily_financial_news.html` is the canonical published runtime artifact and contains the current embedded production payload.
- `generated/` contains staging and cache artifacts. A staged artifact may be the current input to a build or editorial step, but it is not the published source of truth.
- Validators enforce selected documented contracts. Tests provide regression evidence for implementation paths. Neither tests nor fixtures define product or data policy, and fixtures are never production data.

If these surfaces disagree, treat that as drift to correct. Agent work follows `AGENTS.md`; operational and payload decisions follow this README; the published artifact must conform to both. Do not make a failing test pass by changing the documented contract unless the intended product behavior has also changed.

The main dashboard payload lives inside:

```html
<!-- ============ DATA START — published dashboard payload ============ -->
...
<!-- ============ DATA END ============ -->
```

This block is the published payload location, not the routine editorial workspace. Daily editorial work belongs in `generated/editorial/` and reaches the artifact only through the validated apply command. Do not touch the HTML, CSS, or JavaScript outside generated data blocks for a daily dashboard refresh.

Production is self-contained: the rendered dashboard reads embedded `dashboard-data` and `chart-data` JSON blocks. Helper scripts may generate staging JSON snippets, but no production section should fetch sidecar JSON files at runtime.

## Browser support

The supported baseline is Chromium 120+ (Chrome and Edge), Firefox 121+, and Safari 17.4+ on macOS and iOS. Older browsers are out of scope. Dashboard code may rely directly on modern platform APIs available across that baseline, including `fetch`, `AbortController`, `ResizeObserver`, `URL`, `Intl`, `matchMedia`, `localStorage`, and native `<details>`.

There are no WebKit-specific workarounds. The retained availability checks are intentional optional-feature boundaries, not compatibility support: theme preference falls back to the page default when `matchMedia` is unavailable or storage is blocked; `localStorage` reads/writes are best-effort because privacy or storage policy can reject them; and the local-network market refresh runs only when `fetch` and `AbortController` are available. In every one of those cases, the embedded static dashboard remains fully usable. Do not add browser-version branches or polyfills without documenting the concrete supported-browser behavior they protect here.

## Scheduled preflight

- These restrictions apply only to runs finalized with `--scheduled`. Manual/on-demand runs may occur on any day and at any time.
- In `America/Chicago`, the scheduled morning update window is 6:45–8:00 AM and the scheduled afternoon window is 3:45–5:00 PM. A scheduled run must stop outside its weekday window.
- Select the active window from that local time and keep the dashboard date and compile date on the local run date.
- Before editing, run the scheduled preflight for the active window. Finalization with `--scheduled` repeats the same check before writing, so it refuses both an out-of-window application and a duplicate completed-window marker. A completed morning run does not block the afternoon run.

## Daily runbook (normal path)

### Canonical three-phase workflow

| Run | 1. Deterministic preparation | 2. AI editorial work | 3. Deterministic finalization |
| --- | --- | --- | --- |
| Scheduled | Run `node scripts/run_daily_update.js --scheduled-preflight --morning` or `--afternoon`, then run `node scripts/run_daily_update.js --morning` or `node scripts/run_daily_update.js --afternoon` to stage `generated/daily_financial_news.candidate.html`, then run `node scripts/run_daily_update.js --prepare-editorial-dir generated/editorial --morning` or `--afternoon` | Edit `generated/editorial/dashboard-data.json`, complete `generated/editorial/editorial-review.json`, and replace retryable unavailable dispositions with verified Earnings or Week Ahead copy when evidence is available | Run `node scripts/run_daily_update.js --apply-dashboard-data-json generated/editorial/dashboard-data.json --editorial-review-json generated/editorial/editorial-review.json --scheduled --morning` or `--afternoon`; this consumes the staged candidate and editorial sidecars and atomically replaces the canonical dashboard, after which commit on `main` and run `./scripts/publish_main.sh` |
| Manual/on-demand | Run `node scripts/run_daily_update.js --morning` or `node scripts/run_daily_update.js --afternoon`, then run `node scripts/run_daily_update.js --prepare-editorial-dir generated/editorial --morning` or `--afternoon` | Edit the generated editorial handoff files, including retryable Earnings and Week Ahead editorial dispositions | Run the matching apply command without `--scheduled`; commit and publish only when the manual update is intended to go live |

### Core guarantees

- **Deterministic:** preparation validates staging inputs, assembles `generated/daily_financial_news.candidate.html`, and leaves the canonical dashboard unchanged. `run_daily_update.js` is the sole operational writer.
- **Commentary:** fresh quotes require commentary bound to that quote revision. Missing or unusable commentary becomes the visible retryable unavailable disposition; failed quote downloads retain their prior validated quote and commentary together.
- **Publish:** finalization stamps the receipt, validates the complete candidate, atomically replaces the dashboard, and refreshes the last-good snapshot. Focused repairs use the same path.
- **Fail open:** source and editorial failures preserve successful neighbors and publish same-period carried data or correctly dated unavailable states. Degraded states retry later. If no valid replacement can be assembled, the existing dashboard remains online.

The scheduled preflight is read-only and the final scheduled apply repeats it. Manual runs bypass the schedule window. A dashboard update request covers staging and canonical generated data only; source code, tests, documentation, configuration, and policy require separate authorization.

After canonical replacement, staging/cache synchronization is best-effort. A synchronization failure is reported and retried later; it never rolls back the validated dashboard.

For an already-generated chart-only payload, use `--apply-chart-data-json`; it embeds the series, rebuilds matching `chart-data.quoteRows` and visible Tape prices, replaces prior notes only for successfully downloaded quotes with the quote-bound unavailable fallback, restamps the receipt, and publishes through complete validation. To add or repair only selected chart series without refreshing the rest of the Tape, fetch each with `scripts/fetch_chart_data.js --ticker SYMBOL` and apply the resulting payload with `--merge-chart-data-json`; that preserves every untouched or failed series, quote row, and bound note while resetting commentary only for successfully downloaded merged quotes. These are repair paths, not substitutes for the canonical three-phase workflow. A standalone scheduler must not publish directly because it cannot complete the required editorial judgment.

Manual runs may occur outside the scheduled windows, on weekends, and more than once per scheduled window. Choose `--morning` or `--afternoon` for the intended dashboard edition and market session, and keep the dashboard date on that local run date. Manual application preserves `newsBaseline` and computes `isNewSinceScheduledUpdate` from its retained comparison set; it never consumes or advances scheduled newness. Scheduled application compares against the last scheduled story set, then rotates the baseline and records the completed window.

### Market Lens editorial decision contract

The normal finalization command consumes the complete generated review manifest. Its `marketLensDecisions[]` must contain one `replace` or `retain-generated` decision for every current event day. The apply command derives the final lens and `marketLensSource` from those decisions rather than trusting lens state already present in the payload.

`scripts/week_ahead_contract.js` owns calendar-payload validation, event release states, comparable actual-versus-forecast surprises, preservation of still-valid pre-close editorial lenses through `released_awaiting_close`, post-close outcome invalidation when facts or closing reactions change, explicit verified or `commentary_unavailable` outcome dispositions, event-day close-reaction derivation, and Market Lens decision coverage and action semantics. `scripts/run_daily_update.js` applies those domain results and verifies cross-section references and chart closes against the assembled dashboard.

A deterministic Friday/Monday calendar rollover may temporarily preserve an existing editorial lens only when its date and every `relatedEventId` still match the refreshed slate. That continuity behavior is not editorial reaffirmation. Before publication, the final editorial pass must reconsider every event day against the current Opening, Tape, and verified news and either retain the newly generated fallback or provide a fresh valid replacement.

Before the close, the visible Market Lens remains forward-looking. Once at least one actual is available and the afternoon chart payload contains completed event-day and previous-trading-day closes for every selected transmission ticker, the day transitions to `close_available`. The renderer then replaces the forward-looking lens with `Outcome & Close Reaction`: verified editorial copy interprets the released facts and session response when available; otherwise a concise `commentary_unavailable` warning appears while deterministic ticker buttons continue to show the preselected transmission assets that registered an event-day close move. Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

The AI fills each generated event-day decision and any verified-claim evidence; the script supplies `reviewedAt`, `baseEditionId`, and event dates. Application embeds the reviewed base edition, decision summary, verified-claim evidence, new edition ID, and payload hash. Each Tape row carries the canonical chart-series `quoteRevision` and either a reviewed or `commentary_unavailable` note disposition. When application must reject malformed or unsupported editorial input, the receipt also records the system-applied `retained_candidate`, `omitted`, `generated_default`, or `unavailable_disposition` action; these dispositions are not represented as human verification and are removed after a later valid editorial apply. Every later payload rewrite clears or invalidates the receipt, and a manifest cannot be reused after the base edition changes.

### Daily editorial checklist

1. Verify the deterministic envelope before editorial work.
   - The orchestrator owns `masthead.date`, `masthead.edition`, the compile date/time prefix in `footer.compiled`, Futures session labels, and the session prefix in `tape.label`; do not hand-edit them.
   - The AI owns only the key-driver portion of `tape.label` after the separator and non-derivable source or holiday context after the generated compile prefix.
   - The run date is always the current Chicago date, including prior-evening holiday context; explain a next-day closure in `weekAhead`, stories, or the editorial footer context rather than forward-dating the envelope.
   - Friday afternoon refreshes both calendars to current Friday plus next Monday-Thursday. Monday morning replaces that bridge with the current Monday-Friday slate. All other updates retain the existing calendar days while refreshing Week Ahead values and lifecycle, non-calendar dashboard content, and arrived earnings results.

2. Run the normal deterministic refresh before reading news.
   - Use the matching canonical three-phase workflow entry. The orchestrator owns futures, chart/quote, crypto-stat, Asset Allocation, Week Ahead, and earnings refreshes; do not hand-patch those deterministic values unless it fails and the Manual fallback reference applies.
   - Earnings facts are refreshed into the deterministic candidate even when new narrative is required. `--prepare-editorial-dir` places those tasks in `generated/editorial/earnings_narrative.json`; attempt them during the same editorial pass as Opening, News, Tape, and Week Ahead. An arrived result moves the row to `released_awaiting_close` without erasing its pre-event commentary. Once the required close response becomes `close_available`, or the reaction window becomes genuinely unresolvable, the prior narrative is invalidated; do not restore pre-report copy. Supply verified replacement copy when supportable. Otherwise retain the generated `commentary_unavailable` or `unverified` disposition so deterministic actuals and reactions publish with a warning and the task remains eligible for the next scheduled run. Finalization rejects stale copy and malformed dispositions, not unavailable editorial evidence. See Appendix: Earnings operations only when the detailed provider, sidecar, or row-contract rules are needed.
   - Review the orchestrator-patched quote fields and data blocks. If a value is stale, missing, or failed to refresh, use the Manual Fallback Reference rather than editing a deterministic value by hand.
   - In each `tape.rows[].note` whose quote was successfully downloaded, summarize the relevant market commentary or catalyst driving that market. Do not carry its prior commentary forward or restate `last`, `delta`, or `pct`. If supportable commentary cannot be completed, leave the generated fallback in place; finalization publishes and records that retryable unavailable disposition rather than retaining old copy or blocking the dashboard. A failed quote row retains its last validated quote and bound commentary unchanged.
   - In each `tape.rows[]` crypto ticker row (`group: "Crypto"`), include a `note` for the collapsed Tape Crypto tab. Update these notes daily with ticker-specific context; do not reuse one generic crypto note across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible crypto tickers.
   - Do not name quote/news sources in visible copy. Keep the compact source-family attribution in `footer.compiled`; use chart source details for row-specific provenance.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Search news after prices.
   - This is a required step on every editorial dashboard update, scheduled or manual, before any story set is finalized.
   - Use a candidate-pool-first editorial process: search broadly across reputable source families and distinct market angles, gather substantially more eligible articles than the final collection needs, then winnow that pool to the strongest coverage. Do not finalize a section from the first qualifying links found.
   - Build each pool from both newly found articles and still-fresh prior cards. Compare them directly; retain a prior card when it remains among the best relevant, source-faithful coverage, and do not discard or churn it merely because the scheduled window changed.
   - Admit a candidate to its pool only after checking its required fields, date freshness, accessible reader-facing URL, source fidelity, and duplication against the other collections. For Futures, verify an offset-bearing `publishedAt` inside the active session window before considering the article as a Futures candidate.
   - Rank eligible candidates by market relevance, explanatory value, freshness, source quality, and angle diversity. Select the final 9 broad-market cards, 4–6 Crypto cards, and 3 Futures catalysts from that ranked pool.
   - If a target remains short after the full search-and-winnow pass, retain every qualifying fresh card and publish the retryable partial state; do not block publication or manufacture coverage.
   - Use today and yesterday as explicit dates in every query; for a Monday morning edition, add Saturday when needed because the freshness rule may still admit relevant Saturday-dated coverage.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - Morning: `premarket futures [yesterday] [today]`; afternoon: `index futures after the bell [today]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, semis/AI, crypto regulation, ETF flows, stablecoins, hacks/security, protocol updates, and market structure.
   - Follow the News-card contract and Story selection policy below for collection counts, required fields, freshness, source choice, carry-forward decisions, and link rules.

4. Editorialize the generated handoff in this order.
   - `masthead`: leave the generated edition and date unchanged.
   - `opening`: update `headline`, `deck`, and four concise catalyst items.
   - `futuresModule`: leave the four generated futures rows and session metadata unchanged; update only the active window’s stories per the News-card contract. Use each story’s descriptive `tag` for its visible badge.
   - `tape`: leave generated quote fields unchanged; update the editorial roster only when intentionally changing coverage, and rewrite commentary for every successfully downloaded quote. Leave failed-download rows on their last validated quote and bound commentary.
   - `assetAllocationPortfolio`: review the orchestrator-patched ETF rows and sanitized portfolio summary. Use the Asset Allocation fallback only if that refresh fails.
   - `stories`: update the broad-market news collection per the News-card contract.
   - `crypto`: leave generated `crypto.stats[]` values unchanged and update only the crypto news collection per the News-card contract. Crypto ticker quote rows are generated in `tape.rows[]` with `group: "Crypto"`; their ticker-level commentary remains editorial.
   - `earnings.week`: leave the generated five-trading-day slate, facts, and reactions unchanged; supply requested narrative only in `generated/editorial/earnings_narrative.json`. Finalization binds that sidecar to the staged facts and ignores Earnings changes made through the general dashboard JSON. Detailed provider, sidecar, and row-contract rules live in Appendix: Earnings operations.
   - `weekAhead`: official schedules own covered release dates and Eastern times, while FXMacroData supplies labeled U.S. actuals, prior releases, and forecasts through `scripts/fetch_week_ahead.js`; no API key is required. The fetcher rebuilds the slate only on Friday/Monday and refreshes values against that staged official slate on every other run. If the persisted staging payload fails its current contract, the updater switches to a fresh active-range rebuild before applying fallback. Do not hand-edit dates, times, event names, impact levels, actual/forecast/previous values, release states, surprises, or close reactions. A covered official release remains visible with blank values when FXMacroData lacks an exact labeled match; FXMacroData cannot move an official date or time. Market-consensus forecasts are unbadged; central-bank forecasts render with a `Nowcast` pill and FXMacroData blended forecasts with a `Model` pill, each naming its source and clarifying that it is not market consensus. During afternoon editorial work, attempt `days[].outcome.title` and `body` for every `close_available` day and describe the combined released facts and event-day close response without overstating causality. If that interpretation cannot be verified, leave no claim text and use the generated `commentary_unavailable` disposition; deterministic releases and close reactions still publish and the outcome remains retryable. The canonical payload stores U.S. release times in Eastern market time and the renderer converts them to Central time. Full U.S. cash-market closures come from the maintained local calendar contract.
   - After the deterministic Week Ahead refresh, evaluate all releases on each event day against the current Tape, opening, and verified news. Before `close_available`, promote one coherent daily market question only when the structured lens identifies a current evidence-backed setup, every materially related event ID, a specific transmission path, both reinforcing and challenging outcomes, and one to three canonical chartable Tape reactions. The visible copy may synthesize several releases when they inform the same market question; do not force one release to be the editorial lead. Set each generated manifest entry to `retain-generated` or supply a valid `replace` lens. At `close_available`, retain the preselected reaction ticker set and supply either a verified editorial `outcome` or the retryable `commentary_unavailable` disposition instead of selecting new tickers with hindsight. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice. Reaffirm every event day on each editorial run; a temporarily preserved prior lens is not a new decision.
   - `footer`: preserve the generated compile prefix and maintain only concise non-derivable source-family or holiday context.
   - Legacy sections such as `lede` and `renesas` are removed during preparation and rejected by validation; do not recreate them.

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
| `stories[]` | Target 9 broad-market, non-crypto cards; fewer may publish with partial coverage | `tag`, `title`, `body`, HTTPS `url`, `publishedOn` |
| `crypto.notes[]` | Target 4–6 crypto-specific cards; fewer than 4 may publish with partial coverage | `kicker`, `title`, `body`, HTTPS `url`, `publishedOn` |
| `futuresModule.stories[]` | Target 3 current Futures catalysts; fewer may publish with partial coverage | `tag` (24 characters or fewer to preserve the shared label column), `title`, `body`, HTTPS `url`, `publishedOn`, offset-bearing ISO `publishedAt` |

- `run_daily_update.js` derives `storiesCoverage`, `crypto.notesCoverage`, and `futuresModule.storiesCoverage` from the finalized collections. Normal counts use `status: "complete"`; a shortage uses `status: "partial"`, `reason: "insufficient_qualifying_fresh_coverage"`, and a retry timestamp. Partial sections remain eligible for replenishment on every later update. This is audit metadata only and must never render as inline section copy or footer content.
- A partial coverage state relaxes only the minimum count. Maximum counts, required fields, HTTPS URLs, publication freshness, duplicate detection, New-pill identity, Futures session timing, and claim verification remain unchanged for every published card.
- `publishedOn` is an `America/Chicago` date in `YYYY-MM-DD` format. It must be today or yesterday; Monday-morning editions may also use Saturday-dated coverage. Session-bound Futures stories may retain the active fetched market-session date when a weekend or holiday manual edition has no newer U.S. session.
- Futures `publishedAt` must be verified and inside the active session window. Morning stories run from the shared fetched `futuresModule.futures[].raw.referenceDate` close (4:00 PM Eastern) through the dashboard run time. Afternoon stories run from 9:30 AM Eastern through the earlier of 4:00 PM Eastern or the dashboard run time.
- Do not duplicate a promoted Futures story’s URL or title in `stories[]`. Keep crypto-specific headlines, ETF flows, proxy equities, stablecoins, token/regulation, and protocol/security coverage in `crypto.notes[]` unless explicitly requested for the main news flow.
- `isNewSinceScheduledUpdate` is generated from the scheduled baseline; do not set it by hand.
- Publication-date freshness is the same for scheduled and manual editions. Their difference is baseline handling: manual runs preserve the baseline and its current New pills, while scheduled runs advance it after successful finalization.

### Story selection policy

- Fresh enough to keep is not the same as worthy to keep. Build and rank a surplus candidate pool before choosing the final collection; select for relevance, explanatory value, freshness, source quality, and distinct angles rather than taking the first qualifying links found.
- If the target count cannot be reached, retain every still-fresh prior card that remains relevant and source-faithful before allowing the updater to mark the section partial. Never discard a qualifying card merely to create a cleaner shortage state.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, readable Reuters, CNBC, Investopedia, Kiplinger, Investor's Business Daily, Yahoo Finance, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, Blockworks, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
- Match every story's headline and body to its linked article's main reported theme. Narrow a card to a company, earnings, product, or subtheme angle when that is all the reporting supports; do not use it to imply a broader market, sector, or macro claim.
- `READ MORE` links must be reader-facing HTML pages, never raw APIs, feeds, JSON, or CSV downloads.

## Manual Fallback Reference

Use this reference only when the deterministic orchestrator fails and a documented manual fallback is necessary. Do not use it as an alternate daily workflow.

For a pre-close Market Lens-only repair, use the same complete review-manifest shape with `node scripts/run_daily_update.js --apply-market-lens-json /path/to/editorial-review.json` and the applicable window flags. This changes `days[].marketLens` and `days[].marketLensSource`, re-derives any affected deterministic lifecycle view, applies edition metadata, optionally advances the scheduled baseline, restamps `editionId`, and embeds a new hash-bound `editorialReview` receipt. At `close_available`, reaction tickers are frozen; edit `days[].outcome` through the normal dashboard-data editorial apply path instead.

### One-off fetch commands

- For an ad hoc stock/ETF quote check, use `node scripts/fetch_chart_data.js --input daily_financial_news.html --ticker SYMBOL`; quote rows are derived from the canonical chart series used by the dashboard.
- Individual staging fetchers are `node scripts/fetch_chart_data.js`, `node scripts/fetch_crypto_stats.js`, `node scripts/fetch_asset_allocation.js`, and `node scripts/fetch_week_ahead.js`; use `node scripts/fetch_chart_data.js futures --session` for afternoon Session Futures.
- `fetch_crypto_stats.js` writes staging data only. Deterministic preparation consumes that payload; Crypto stats never bypass editorial finalization to rewrite the canonical dashboard directly.

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

### Manual ticker roster changes

Whenever you manually add, remove, rename, or change the `sourceSymbol` of a dashboard ticker, restart the local helper and verify the changed ticker before considering the dashboard complete:

1. Run `launchctl kickstart -k "gui/$(id -u)/com.scott.daily-financial-dashboard"`.
2. Request `https://192.168.2.2:2210/api/market-refresh` and confirm the changed ticker has a non-empty series and no ticker-specific error.

Static dashboard validation does not prove that the already-running local helper has loaded new ticker support.

### Asset Allocation fallback

- Refresh the local Asset Allocation Dashboard export through `http://127.0.0.1:2200/api/asset-market-data`, then read `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`.
- If the refresh fails but the export exists, use that export, set `portfolioMtdReturnStale: true`, and copy the export's `asOf` date to `portfolioMtdReturnAsOf`; see the `assetAllocationPortfolio` data contract for field semantics.
- The endpoint only refreshes the sanitized local export; never call it from the published dashboard or use it as display data.

## Validation and publish

### Required daily checks

- Before committing a content-only update, run only `node scripts/validate_dashboard.js readiness --skip-tests --allow daily_financial_news.html`. Repeat `--allow PATH` for every intentionally changed file. This single command requires a current editorial receipt, validates the dashboard and HTML, checks whitespace, and rejects undeclared changed files; do not add a separate ordinary validation, `tidy`, or whitespace command.
- For quick iteration or an ordinary non-publish check, run `node scripts/validate_dashboard.js daily_financial_news.html`. It enforces dates, Week Ahead and Earnings lifecycle/reaction coherence, News-card freshness, embedded-data text hygiene, Tape note quality, superlative verification, and the runtime's LAN-only refresh endpoint contract. It is not an additional step after content-only readiness or the complete suite.
- `./scripts/publish_main.sh` runs the complete readiness validation, including the full default offline regression suite, before it pushes. Do not run the complete suite immediately before `publish_main.sh`; use focused tests while developing and let publication own the final full gate. Publishing and readiness validation are read-only with respect to dashboard data. If the editorial receipt is missing or stale, readiness fails; use the documented `run_daily_update.js` apply or focused-repair path to restamp the receipt from the validated candidate with any system-applied fallbacks, then rerun publication. A receipt that still cannot validate after that updater-owned finalization indicates a completed-artifact integrity failure.

### Expanded content and layout checks

Run the applicable checks after content, structural, layout, script, or contract changes:

- Superlative claims are rejected deterministically unless the review manifest lists the exact containing text and an HTTPS evidence URL in `verifiedClaims[]`.
- Run `tidy -q -e daily_financial_news.html` and browser-check the production page after structural or layout changes. After changing Market Lens or Outcome copy, reactions, or routing, check narrow mobile and desktop widths for readability and overflow; activate pre-close and post-close reaction controls with pointer and keyboard; verify the correct Tape group, ticker, and chart open; verify focus moves to the chart heading; and verify repeated activation leaves that chart open.
- After changing an information tooltip, browser-check tap, hover, and keyboard activation at narrow mobile, tablet, and desktop widths. The tooltip must remain inside the viewport and each state must remain legible.
- Run `node scripts/validate_dashboard.js test` after script or data-contract changes when publication is not the immediate next step. It is the complete default offline regression suite and checks tracked JavaScript and shell syntax, the four focused test routines, the canonical embedded dashboard contracts, HTML structure, and whitespace errors. Do not repeat its individual syntax, domain-suite, dashboard-validation, `tidy`, or whitespace commands. It is self-contained and does not require ignored `generated/` artifacts or network access. Environment-specific LAN/local-refresh integration, including the helper's LaunchAgent configuration, remains a separate suite; run `node scripts/test_dashboard.js --local-refresh` only when changing the local market server, its TLS/origin policy, or browser-side local-refresh behavior.
- The complete command does not replace the browser checks above: test and validation routines cannot prove responsive geometry, focus behavior in a real browser, or visual readability.
- Nonvisual data, contract, validation, and refactoring changes require no browser pass. For visible changes, exercise only the affected interactions and applicable breakpoints, including every specific tooltip or Week Ahead check listed above when that surface changed.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.

## Appendix: Data contracts

This section is the canonical human-readable contract for dashboard data. Keep `scripts/validate_dashboard.js` and fetch-script output in sync with this section whenever a payload shape changes. Use its `chart-data` mode for standalone generated chart payloads.

### Embedded `dashboard-data`

- `editionId`: ISO timestamp identifying the exact embedded dashboard edition. `run_daily_update.js` bumps it every time it rewrites `dashboard-data`; local-refresh cache keys must use this field rather than inferring identity from the visible date/ticker shape.
- `editorialReview`: publication receipt with `schemaVersion`, `reviewedAt`, `reviewedBaseEditionId`, matching `reviewedEditionId`, one summarized `marketLensDecisions[]` entry per event day, optional `verifiedClaims[]`, optional system-owned `systemFallbacks[]`, and a SHA-256 `payloadHash`. A system fallback records the affected section/path, its non-human action, and reason. Every Tape `unavailable_disposition` receipt entry must correspond to a `commentary_unavailable` row at the same ticker path and must exactly match that row's `noteDisposition.reason`. The hash covers the complete embedded `dashboard-data` payload except the receipt itself plus the complete embedded `chart-data` payload. Any direct or orchestrated data/chart rewrite therefore invalidates the receipt; only an explicit editorial apply command with a matching one-time `baseEditionId` creates it.
- `masthead`: visible header metadata. `masthead.date` must be the dashboard date. `masthead.edition` must match the Futures session: `Morning Edition` for `Before The Open` / `Pre-Market Futures`, or `Afternoon Edition` for `After The Bell` / `Session Futures`. Use `editionId` for exact build/revision identity rather than a visible serial number.
- `opening`: market-open summary with `headline`, `deck`, and exactly four `catalysts[]` items.
- `futuresModule`: the four-card futures module and promoted Futures news. Use `sectionLabel`/`sectionTitle` to distinguish morning `Before The Open` / `Pre-Market Futures` from afternoon `After The Bell` / `Session Futures`; an explicit unavailable fallback has no futures rows and carries validated `availability` metadata. See the News-card contract for story rules.
- `tape`: the cross-asset Tape table. All ticker quote rows, including crypto tickers, live in `tape.rows[]`.
- `assetAllocationPortfolio`: instrument-level ETF market data and sanitized portfolio-level summary fields only. Do not embed tactical model logic or derived allocation calculations.
- `stories`: broad-market, non-crypto news cards; `storiesCoverage` records complete or retryable partial coverage. See the News-card contract.
- `newsBaseline`: embedded scheduled-update comparison state for the News Flow and Crypto `New` pills. `currentScheduledStoryIds` stores the most recent scheduled run's `stories[]` and `crypto.notes[]` identities, while `previousScheduledStoryIds` is the comparison set used to keep manual runs from consuming scheduled newness. `lastScheduledWindow` is the completed `YYYY-MM-DD:morning|afternoon` marker checked by the next scheduled preflight.
- `scripts/news_contract.js` owns the pure story-identity, URL normalization, coverage-state, baseline normalization, and New-pill transition rules. `run_daily_update.js` derives coverage after final story selection and remains the sole dashboard writer; `validate_dashboard.js` independently verifies the resulting news contract.
- `crypto`: crypto section metadata, crypto-only stat rows, crypto story notes, and `notesCoverage`. Crypto ticker quote rows do not live here.
- `earnings.week`: canonical `schemaVersion: 2` five-trading-day earnings monitor payload. Its range is Monday-Friday after the Monday-morning refresh, or Friday plus next Monday-Thursday after the Friday-afternoon refresh. Every row uses the shared event lifecycle `scheduled`, `awaiting_actual`, `released_awaiting_close`, or `close_available`; see Appendix: Earnings operations.
- `weekAhead`: a five-trading-day deterministic economic-event ledger with `schemaVersion: 4`. `range.timeZone` is the dashboard display zone (`America/Chicago`) and `range.marketTimeZone` is the stored U.S. release zone (`America/New_York`). Its range is Monday-Friday after Monday morning, or current Friday plus next Monday-Thursday after Friday afternoon. Each event contains a stable ID, Eastern `time`, canonical name, agency, period, local impact classification, nullable FXMacroData `actual`, `forecast`, and `previous` values, source fields, deterministic `status` (`scheduled`, `awaiting_actual`, or `released`), and a nullable unit-compatible `surprise`. Each event day with releases has lifecycle `scheduled`, `awaiting_actual`, `released_awaiting_close`, or `close_available`. `marketReaction` is present only at `close_available` and stores the event-day close versus previous-trading-day close for the Market Lens transmission tickers. `outcome` is editorial and is allowed only at `close_available`; it contains either verified `title`/`body` copy or a retryable `commentary_unavailable` disposition. FXMacroData predictions match official releases by indicator and exact Eastern date/time; the matched prediction's `announcement_id` then links its forecast to the corresponding FXMacroData actual. `officialSchedule.events[]` is the accepted authoritative manifest. Unavailable authorities, indicator requests, or unknown event keys are omitted with `source.status: "partial"` and item diagnostics while accepted events remain; a rollover fallback is used only when no valid active-range payload can be assembled. That fallback retains exactly the target five dates, contains no invented events, sets source and availability to unavailable, and remains eligible for automatic retry. `days[].marketLens` remains the deterministic transmission map and ticker selector, but the renderer replaces its forward-looking copy with Outcome & Close Reaction after the close. `generated/week_ahead.json` is staging/cache only and is never fetched by the published dashboard.
- `footer`: compile date and concise source-family attribution.

### `weekAhead.days[].marketLens`

Every lens contains `question`, `relatedEventIds`, `channels`, one to three `reactions[]`, `title`, and `body`. Each reaction contains a canonical Tape `ticker` and a concise `role`; the visible ticker control opens that exact embedded Tape chart. Its parent day must set `marketLensSource` to `generated` or `editorial`; the apply command derives this field from the decision action. Validation requires every channel to be supported by a related release, every reaction ticker to be eligible for a selected channel, and every reaction ticker to exist in both `tape.rows[]` and `chart-data.series[]`. The legacy `watchlist` field and aliases such as `2Y`, `10Y`, `DXY`, `QQQ`, `XLY`, `XLE`, `WTI`, and `Energy` are not accepted.

Generated lenses use only ordinary default transmission and must not claim a current setup or scenario analysis. The canonical default paths are:

| Path | Release families | Transmission | Default reactions |
| --- | --- | --- | --- |
| `consumer-inflation` | Consumer Price Index, Core Consumer Price Index, PCE Price Index, Core PCE Price Index | Consumer prices to expected policy path | `UST2Y`, `UUP` |
| `producer-inflation` | Producer Price Index, Core Producer Price Index | Producer costs to inflation-sensitive rates | `UST2Y`, `UST10Y` |
| `labor` | Nonfarm Payrolls, Unemployment Rate, Average Hourly Earnings, ADP Employment Change, Initial Jobless Claims, JOLTS Job Openings | Labor demand to policy and growth | `UST2Y`, `SPX` |
| `consumer-demand` | Retail Sales, Core Retail Sales, Consumer Confidence, University of Michigan Sentiment | Household demand to growth and rates | `VCR`, `UST10Y` |
| `broad-growth` | Gross Domestic Product | Aggregate growth to earnings and rates | `SPX`, `UST10Y` |
| `manufacturing` | Durable Goods Orders, Industrial Production, Factory Orders, ISM Manufacturing, Empire State Manufacturing, Philadelphia Fed Manufacturing | Factory activity to cyclicals and materials | `VIS`, `HG` |
| `services` | ISM Services | Services activity to growth and policy | `SPX`, `UST2Y` |
| `housing` | Housing Starts, Building Permits, Existing Home Sales, New Home Sales | Financing costs to housing activity | `UST10Y`, `VNQ` |
| `policy` | FOMC Minutes, Federal Reserve Decision | Fed communication to the Treasury curve | `UST2Y`, `UST10Y` |
| `energy` | EIA Crude Oil Inventories, OPEC Meeting | Supply conditions to crude and energy equities | `CL`, `VDE` |
| `external` | Trade Balance | External balance to the dollar | `UUP` |
| `fiscal` | Federal Budget Balance | Fiscal balance to Treasury financing context | `UST10Y`, `UST30Y` |

Default reactions are the generated lens choices. Editorial reactions may use any canonical symbol eligible for at least one selected channel:

| Channel | Eligible canonical Tape reactions |
| --- | --- |
| `policy-path` | `UST2Y`, `UST10Y`, `UUP`, `NDX` |
| `consumer-inflation` | `UST2Y`, `UST10Y`, `UUP`, `NDX` |
| `producer-inflation` | `UST2Y`, `UST10Y`, `VDE` |
| `labor-demand` | `UST2Y`, `SPX`, `HYG`, `UUP` |
| `consumer-demand` | `VCR`, `SPX`, `UST10Y` |
| `broad-growth` | `SPX`, `UST10Y`, `HYG` |
| `industrial-growth` | `VIS`, `HG`, `UST10Y`, `HYG` |
| `services-activity` | `SPX`, `UST2Y`, `UUP` |
| `housing` | `UST10Y`, `VNQ`, `HG` |
| `energy-balance` | `CL`, `VDE`, `UST10Y` |
| `external-balance` | `UUP`, `VEA` |
| `fiscal-financing` | `UST10Y`, `UST30Y`, `UUP` |

An editorial lens adds `setup.statement`, one or more typed `setup.evidence[]` references, and `scenarios.reinforces` plus `scenarios.challenges`. Evidence may reference `opening.headline` or `opening.deck`, a canonical Tape ticker, or a story URL already embedded in the dashboard. `relatedEventIds` may cross default paths when all selected releases materially support one coherent daily market question. The reaction symbols must follow from the written transmission path rather than being selected as decoration.

A generated manifest already supplies the wrapper and dates. The AI either sets an entry to `"retain-generated"` or supplies a replacement in this shape:

```json
{
  "date": "2026-07-15",
  "action": "replace",
  "marketLens": {
    "question": "Is the oil shock becoming a durable inflation impulse?",
    "setup": {
      "statement": "Crude has retreated, but shipping and supply risks remain an active inflation concern.",
      "evidence": [
        { "kind": "opening", "field": "deck" },
        { "kind": "tape", "ticker": "CL" }
      ]
    },
    "relatedEventIds": ["2026-07-15:08:30:ppi-mom", "2026-07-15:10:30:crude-oil-inventories"],
    "channels": ["producer-inflation", "energy-balance"],
    "scenarios": {
      "reinforces": "Firmer producer prices and tighter inventories would reinforce the oil-to-inflation channel.",
      "challenges": "Softer producer prices or an inventory build would weaken that channel."
    },
    "reactions": [
      { "ticker": "CL", "role": "Underlying crude-balance reaction" },
      { "ticker": "UST2Y", "role": "Expected-policy-path consequence" }
    ],
    "title": "Oil risk reframes producer inflation",
    "body": "PPI tests whether higher energy costs are reaching the production pipeline while EIA inventories test the underlying crude balance."
  }
}
```

The apply command requires exactly one decision for every current event day. The manifest has no `sections` declaration or all-sections editorial gate. A malformed decision, stale event ID, missing evidence reference, noncanonical reaction ticker, missing chart, or unverified superlative is rejected as editorial input rather than treated as a publication blocker. Finalization quarantines that input, substitutes the validated generated lens for the affected event day—or the complete generated decision set when the manifest itself is unusable—and then validates and applies the complete candidate instead of partially altering Week Ahead.

### `weekAhead.days[].outcome`

`outcome` replaces the visible forward-looking Market Lens only when the day reaches `close_available`. A verified outcome contains `status: "verified"`, editorial `title` and `body`, and `source: "editorial"`. When supported interpretation cannot be completed, finalization records `status: "commentary_unavailable"`, `reason`, and `attemptedAt` with no title or body; the renderer shows a concise warning and preserves deterministic released facts and `marketReaction.rows[]`. The copy should synthesize all released facts on that day, distinguish the actual-versus-forecast result from the session response, and avoid asserting exclusive causality. Deterministic reactions remain derived from the preselected Market Lens tickers and store each ticker's event-day and previous-trading-day closes, delta, percent change, unit, direction, role, and chart date. The renderer omits flat rows and orders visible movers by absolute movement; it does not select unrelated Tape winners after the fact, and post-close decisions cannot replace the preselected ticker set. A changed actual, forecast, previous value, provenance field, or closing bar invalidates the prior outcome and starts a new verified-or-unavailable editorial attempt on the next scheduled run.

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
  "noteDisposition": {
    "status": "reviewed",
    "quoteRevision": "2026-07-03T21:05:00.000Z",
    "reviewedAt": "2026-07-03T21:20:00.000Z"
  },
  "sourceSymbol": "BTC-USD",
  "asOf": "2026-07-03"
}
```

- `group` is optional for existing non-crypto rows that are grouped by ticker lists in the renderer; crypto ticker rows must set `group: "Crypto"`.
- `ticker` is the dashboard display/routing key. `sourceSymbol` is the fetch/chart source key.
- The Tape roster is editorial and may evolve. Validation does not prescribe symbols; it requires each displayed ticker to be unique and to have matching embedded source, chart-series, and derived quote data.
- `last`, `delta`, `pct`, `dir`, and `asOf` are derived views. They must match the embedded `chart-data.quoteRows` value for the row, and `chart-data.quoteRows` must itself be reproducible from the latest `chart-data.series` bars.
- `note` must explain the factor driving that ticker or market today. It must not restate quote values or include source/citation language.
- `noteDisposition` binds the note to the accepted quote revision. `status: "reviewed"` requires newly reviewed copy and `reviewedAt`; `status: "commentary_unavailable"` requires the canonical visible fallback note, `reason`, and `attemptedAt`. `noteDisposition.quoteRevision` must exactly equal the matching canonical `chart-data.series[].quoteRevision`; the visible quote fields remain derived from that same series.
- A successfully downloaded quote invalidates the prior row note before editorial handoff. Missing, invalid, or repeated prior copy becomes the retryable unavailable disposition and is valid for publication; stale commentary is never a fallback for a fresh quote. A failed quote download retains the last validated quote and its bound commentary.
- Deprecated: do not put ticker quote rows in `crypto.tape[]`.

### `assetAllocationPortfolio`

This section may contain instrument-level ETF market data and a sanitized portfolio MTD-return summary only; never embed tactical weights, signals, or allocation calculations.

- Except for an explicitly unavailable new-month fallback, `rows[]` must cover `VTI`, `VEA`, `VWO`, `VNQ`, `DBC`, `GLD`, `IEF`, and `BOXX`. Each row includes `ticker`, `sleeve`, `price`, `monthDivPerShare`, `dailyPriceChange`, `dailyTR`, `mtdPriceChange`, and `mtdTR`. Same-month carry is allowed only with `availability.status: "carried_forward"`; a new-month fallback has no rows and uses `availability.status: "unavailable"`.
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

- `crypto.stats[]` is for crypto-only section stat cards: Fear & Greed, Altcoin Season Index, and Crypto Market Cap. A failed refresh may retain all last validated cards with `availability.status: "carried_forward"`; when no validated cards exist, the explicit unavailable fallback contains an empty array.
- `crypto.notes[]` holds crypto-specific news cards; see the News-card contract for its count, fields, and freshness rules.
- `crypto.tape[]` is deprecated and validation should reject it.

### `futuresModule`

- The staged Futures payload is owned and validated by `fetch_chart_data.js`: it requires an offset-bearing compile timestamp, source, `premarket` or `session` mode, and exactly the ordered `ES=F`, `NQ=F`, `YM=F`, and `RTY=F` rows with chart-ready values. The updater consumes this accepted payload without redefining its domain rules.
- Embedded `futuresModule.futures[]` must contain exactly four index-futures rows unless `availability.status` is explicitly `unavailable`, in which case it must contain no rows; final dashboard validation enforces both states independently of producer validation.
- Morning `Pre-Market Futures` rows chart the overnight Globex window from the prior futures reopen through the earlier of the dashboard run time or that day's 9:30 AM Eastern cash open. A later-morning manual retry therefore remains an overnight view rather than incorporating regular-session points.
- Afternoon `Session Futures` rows chart the regular market window, normally 9:30 AM to 4:00 PM Eastern, and compare the latest regular-session futures value with the prior trading day's official 4:00 PM Eastern futures close.
- Dashboard display times should be local, but raw official session labels and fields must be stored in Eastern terms: `marketTimeZone: "America/New_York"`, `sessionStartEastern`, `sessionEndEastern`, `referenceCloseEastern`, and `referenceLabel: "prior 4 PM ET close"`.
- `raw.referencePrice` is the comparison baseline used for Session Futures chart/reference calculations. Keep `raw.previousClose` as the source's futures prior close when available.
- Morning update labels are `Before The Open` / `Pre-Market Futures`; its charts cover the overnight Globex session from the prior futures reopen, normally 5:00 PM Central / 6:00 PM Eastern, through the earlier of the run timestamp or 9:30 AM Eastern cash open.
- Afternoon update labels are `After The Bell` / `Session Futures`; its charts cover regular market hours, normally 8:30 AM to 3:00 PM Central / 9:30 AM to 4:00 PM Eastern. Store the official comparison fields in Eastern terms and use `node scripts/fetch_chart_data.js futures --session` for this session payload.
- Futures-story requirements, including the strict publication window, live in the News-card contract. Holiday or unusual-session updates should use the closest accurate window label and explain the shortened or closed cash-market context in `footer.compiled`.

### Embedded `chart-data`

The `chart-data` block is generated chart history plus quote-row staging data:

- `schemaVersion` must be `1`.
- `barEncoding` must be `tuple-v1`: every `series[].bars[]` entry is `[time, open, high, low, close, volume]`, with `volume` set to `null` when unavailable. OHLC values are rounded to at most four decimal places before embedding; the runtime expands tuples back into normal bar objects before rendering.
- `noVolume` is a required boolean derived from the bars: it is `true` exactly when the series has no usable volume bars. This keeps the chart pane and its `Price only` / `Price + Volume` explanation aligned with the embedded data without prescribing particular tickers.
- `range.days` must be at least `1826` so the 5Y chart shortcut has enough embedded history.
- `series[]` is the canonical embedded price-history store. It must include every chartable ticker from `tape.rows[]`, with matching `ticker`, `section`, and `sourceSymbol`. Each series also owns an offset-bearing `quoteRevision`: a successful ticker refresh replaces it with that fetch revision, while a failed or untouched ticker preserves its prior revision through carry-forward and focused merges.
- A partial Chart/Tape source failure may carry the complete last validated series only when the failed ticker appears exactly once in `chart-data.availability.failures[]` and that same series has `availability.status: "carried_forward"`; every carried series must have that matching failure entry. `chart-data` is the sole availability owner, and the Tape renders its warning directly from that metadata. Quote rows and visible Tape values are still re-derived from the mixed canonical series, and the last quote-bound commentary remains unchanged for failed tickers. Only successfully downloaded quotes reset their Tape commentary binding and require newly reviewed copy or the nonblocking unavailable fallback.
- `quoteRows.tape[]` is a derived view over non-crypto `series[]` using `last`, `delta`, and `pct`.
- `quoteRows.crypto[]` is a derived view over crypto `series[]` using the crypto refresh shape: `price`, `delta`, and `chg`. The dashboard maps these back onto `tape.rows[].last`, `delta`, and `pct`.
- Treasury yield-curve series must include `curveDate`, current `curvePoints[]`, `comparisonCurves[]` entries labeled `1M ago` and `6M ago`, and a `curveSpread` object for the 2s10s display row.
- Each `comparisonCurves[].points[]` array must match the current curve's maturity labels in order so the renderer can draw historical lines maturity-for-maturity.
- Published production renders from embedded `dashboard-data`, but canonical market data still lives in embedded `chart-data.series`; `quoteRows` and the visible Tape price fields are derived views and must stay in sync with that series history.

## Appendix: Earnings operations

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`; provider sidecars are build-time inputs only. AI commentary must describe the current deterministic stage: pre-release preview commentary is required for each display-eligible scheduled, awaiting-actual, or released-awaiting-close row unless a current-run editorial attempt records an explicit unavailable fallback. That preview remains through `released_awaiting_close`. Once the close response is fixed, post-release outcome, guidance, and reaction commentary are required unless current official evidence or research supports a field-specific unavailable or unverified disposition.

### Source hierarchy

1. Finnhub primary: calendar slate, company profile, market cap, timing, EPS estimate, EPS actual, revenue estimate, and revenue actual when Finnhub has the row.
2. Finnhub profile recovery: fetch `profile2` with retry/backoff for 429s and cache successful profiles in `generated/finnhub_profile_cache.json`; if live `profile2` still rate-limits or fails transiently, use the cached profile with audit flags. If Finnhub has the earnings row but profile identity is still empty, use Finnhub `stock/metric` only for market cap and EarningsAPI calendar only for company name. Successful Finnhub metric market caps are cached in `generated/finnhub_metric_cache.json` to reduce repeated rate-limit exposure. EPS, revenue, timing, and slate still remain Finnhub.
3. EarningsAPI secondary: missing ticker/date discovery on the five displayed dates plus date corroboration from seven calendar days before the displayed range through 14 calendar days after it during one authorized production slate build. Use the EarningsAPI company endpoint for row-level specifics only for Finnhub-missing display candidates; the calendar endpoint may also supply company-name recovery for a Finnhub-covered row whose Finnhub profile is empty.
4. Official schedule fallback: when EarningsAPI is unavailable, rate-limited, out of daily budget, or does not corroborate a display-eligible Finnhub row, research company investor relations first and an SEC filing or exhibit only as the final schedule-date backup. A confirmed official source may promote the row to `official_confirmed`; otherwise preserve the Finnhub date as `primary_only` and retry official-source research on every scheduled dashboard run while the event remains in the active range. This retry does not authorize another Finnhub/EarningsAPI calendar build outside the Monday-morning or Friday-afternoon slate rollover.
5. SEC/company release resolution: official actuals, fiscal-period confirmation, timing when needed, and EPS basis notes for queued company-release tasks. A completed lookup records `resolved`, `needs_review`, or `unresolved`. A `needs_review` result independently promotes each usable official EPS or revenue actual while retaining provider data for the other metric; all non-resolved dispositions remain partial and nonblocking.
6. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

Do not use metered EarningsAPI calls during validation, tests, source-code audits, or development reruns. One authorized production slate build may scan from seven calendar days before the displayed range through 14 calendar days after it to corroborate Finnhub dates, while only the five displayed dates may supply Finnhub-missing discovery candidates; company-endpoint calls remain limited to those missing candidates. The slate build stops at 80 of the Free-plan's 100 daily calls, reserving the remaining 20 for later company-result refreshes; a result refresh stops its remaining company calls after the first HTTP 429. The narrow calendar-based company-name recovery for a Finnhub-covered row with an empty Finnhub profile does not transfer ownership of its EPS, revenue, timing, or slate to EarningsAPI.

### Canonical row shape

The earnings-week payload uses `schemaVersion: 2`. Every canonical row carries the same deterministic lifecycle vocabulary as Week Ahead: `scheduled`, `awaiting_actual`, `released_awaiting_close`, or `close_available`.

```json
{
  "symbol": "GIS",
  "company": "General Mills, Inc.",
  "reportDate": "2026-07-01",
  "reportTiming": "bmo",
  "lifecycle": "close_available",
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

Allowed `reportTiming` values are `bmo`, `amc`, `dmh`, and `unknown`. Allowed lifecycle values are `scheduled`, `awaiting_actual`, `released_awaiting_close`, and `close_available`. Allowed metric `result` values are `beat`, `miss`, `met`, `not_compared`, and `pending`. Allowed `outcome.overall` values are `beat`, `miss`, `mixed`, `met`, `eps_only_beat`, `eps_only_miss`, `pending`, and `unverified`. Allowed `reaction.basis` values are `same_day_close`, `next_session_close`, `during_market_close`, and `unavailable`. Allowed `reaction.status` values are `pending`, `awaiting_close`, `computed`, and `unavailable`; `unavailable` is reserved for a reported row whose reaction window cannot be resolved, not a close that simply has not happened yet. Allowed `sourceSummary.primary` values are `finnhub`, `earningsApiCompany`, and `sec_company_release`. The dashboard consumes this canonical row contract directly and derives display labels, tones, and compact metric text at render time. The source artifact keeps field-level selected sources in `sourceAudit`; dashboard-visible provenance uses compact `sourceSummary` plus `sourceStatus`. The existing company-row information tooltip appears for exceptional or degraded provenance: `official_confirmed` names the confirming IR source, `primary_only` identifies an unconfirmed Finnhub date, and `secondary_only` identifies an unconfirmed EarningsAPI date; an ordinary verified `corroborated` row has no tooltip. Audit snapshots should preserve provider identity by section name, but metric values still use canonical `eps` and `revenue` objects rather than provider field names.

### EarningsAPI budget policy

- Treat the Free-plan daily quota (100 requests) as a scarce secondary-recovery budget, not a primary data source.
- During an authorized weekly build, query EarningsAPI calendar from seven calendar days before the displayed range through 14 calendar days after it. Use only the five displayed trading dates for secondary discovery. This 26-date scan never runs during development, validation, tests, source-code verification, same-day manual repairs, or ordinary result refreshes.
- Query EarningsAPI company rows only for Finnhub-missing display candidates.
- Do not call EarningsAPI reactions in the normal path; Yahoo remains the reaction source.
- Keep a Central-time daily call counter and record each request outcome. The slate build stops at 80 calls, reserving 20 of the Free-plan's 100 daily calls for company-result refreshes. The usage ledger is a safeguard, not proof of the provider-account balance; a provider 429 immediately stops the calendar scan or all remaining company-result calls for that run.
- `scripts/earnings_week_contract.js` owns the shared earnings row policy, narrative-completion and sidecar-building policy, staged-slate rebuild decisions, schedule-review applicability, fail-open row dispositions, row-level result-refresh status, and same-range/rollover section fallback. It also owns Finnhub calendar-field normalization, EarningsAPI daily-bucket and request/outcome audit mechanics, Yahoo reaction rules, and company-release task construction. Result collection isolates Finnhub, EarningsAPI company, and Yahoo attempts; a required-call or unreadable-ledger failure is recorded only on affected rows and does not discard independent successes. `run_daily_update.js` invokes the contract-owned fallback only when the resulting Earnings artifact itself cannot be validated and coordinates the narrative sidecar.
- `scripts/earnings_week.js` is the only public Earnings CLI and module owner. It owns refresh, resolution, and apply commands and coordinates the staging files used by the contract decisions imported by the updater. `scripts/earnings_week_build.js` is its private build implementation and must not be invoked directly. If a persisted Earnings artifact is malformed or fails the current policy contract, `run_daily_update.js` forces a fresh active-range build before allowing the documented same-range carry or rollover-unavailable fallback.
- `scripts/earnings_week_validation.js` is the private validation implementation. Use `node scripts/earnings_week.js validate` or `validate-release`; do not invoke the implementation file directly.

### Update methodology

Treat weekly slate construction and post-report result refresh as separate jobs. The weekly slate job builds the five calendar cards and expected reporting universe; the result-refresh job updates only rows whose report window has arrived or passed. Do not keep probing calendar/discovery endpoints for the same static week slate during every dashboard refresh.

#### Weekly slate construction

1. The orchestrator builds a calendar slate when a Friday-afternoon or Monday-morning target range differs from the current staged `generated/earnings_week.json` range, or when the embedded target range is still an explicitly unavailable rollover shell. Friday uses current Friday plus next Monday-Thursday; Monday uses the current Monday-Friday. Remaining `primary_only` rows do not authorize another Finnhub/EarningsAPI calendar build. Run `node scripts/earnings_week.js build --from YYYY-MM-DD --to YYYY-MM-DD` only for an authorized production rollover, an unavailable rollover-shell retry, or an explicit manual rebuild.
2. Fetch Finnhub earnings calendar for the selected five trading days.
3. Fetch Finnhub profiles for Finnhub rows and filter display eligibility by market cap, country/exchange/profile quality, and watchlist rules.
4. Treat Finnhub as available only when the request succeeds, the response parses as JSON, and `earningsCalendar` is an array. Once those semantic checks pass, accept every valid in-range row regardless of count; an empty or sparse array is diagnostic information, not a publication gate. EarningsAPI discoveries retain explicit secondary-only provenance and must never be relabeled as Finnhub or silently treated as corroborated.
5. Fetch EarningsAPI calendar from seven calendar days before the displayed range through 14 calendar days after it and stop the scan after a quota-related HTTP 429. Use surrounding dates only for corroboration; only the five displayed dates may supply secondary-recovery candidates. Production calendar builds belong only to the Monday-morning or Friday-afternoon rollover, an unavailable rollover-shell retry, or an explicitly requested manual rollover; regression, source-code verification, and development use fixtures and must never run this metered build for evidence.
6. Reconcile providers before consulting official sources. A Finnhub row with one matching EarningsAPI date passes as `corroborated` even if an older confirmation exists. For an EarningsAPI outage, daily-budget exhaustion, in-week disagreement, outside-week conflict, or symbol missing from a complete corroboration response, add every affected display-eligible Finnhub row to `generated/earnings_schedule_review.json`. Research company investor relations first, then use SEC only as the final backup. An official date in the displayed range moves the row and marks it `official_confirmed`; an official date outside the range excludes only that event. If neither source resolves the event, retain the Finnhub date with `scheduleVerification.status: "primary_only"` and `sourceStatus: "partial"`. The review queue is nonblocking: it records the work and retry path, never suppresses the row or blocks publication.
7. On every scheduled dashboard run, work the active schedule-review queue without rebuilding the calendar slate. For each active `primary_only` row, retry company IR first and SEC/EDGAR only if IR does not resolve the schedule date. A successful confirmation must be recorded against the active `symbol` and Finnhub `primaryDate`; stale, out-of-range, or prior-quarter confirmation rows do not satisfy the queue. Rows that remain unresolved stay `primary_only`, publish as partial, and remain eligible for official-source retry on the next scheduled run while they remain in the active range.
8. An official confirmation row must contain `symbol`, `primaryDate`, `reportDate`, `sourceName`, and an HTTPS `sourceUrl`. `primaryDate` binds the evidence to the specific provider event that triggered review, so an old confirmation for the same ticker cannot affect a later quarter. If the official `reportDate` is in the active week, the matching event moves to that date; if it is outside the active week, only that matching event is excluded. Confirmation input is optional evidence: malformed rows are ignored individually, duplicate event confirmations are all ignored, and a malformed file is treated as no usable confirmation with diagnostics rather than a build failure. Scheduled preparation must consume active matching confirmation records without re-running Finnhub/EarningsAPI calendar discovery solely for that evidence.
9. For Finnhub rows, fetch `profile2` with 429 retry/backoff and use `generated/finnhub_profile_cache.json` only after live profile fetches fail or rate-limit. For rows with empty Finnhub profile data after that, read cached Finnhub `stock/metric` market cap first, then fetch the metric endpoint with conservative retry/backoff if uncached; use the matching EarningsAPI calendar row for company name only. This may make a Finnhub-covered row display-eligible, but it must not change Finnhub EPS, revenue, timing, or outcome.
10. Compare active-week EarningsAPI-discovered symbols against the admitted Finnhub slate. Queue only symbols absent from Finnhub as `secondaryRecoveryCandidates`; same-symbol date conflicts must collapse to one audited canonical row, not duplicate recovery rows.
11. For each queued candidate, fetch the EarningsAPI company endpoint and select the row matching the calendar report date. If the endpoints match and IR has not resolved the event, admit the row with `scheduleVerification.status: "secondary_only"` and `sourceStatus: "partial"`, retain its nonblocking review item, and show the warning tooltip. If the company endpoint has no matching row, omit the candidate from canonical rows, retain the audit/review record, create no `companyReleaseTask`, and continue. Matching official IR evidence may instead promote an admitted row to `official_confirmed`; an official date outside the displayed range excludes it.
12. Persist the staged `generated/earnings_week.json` with the admitted slate, estimates, timing, profile fields, recovery candidates, and source audit. `generated/earnings_schedule_review.json` is a nonblocking audit queue; if it is missing or malformed, emit a warning, treat it as an empty queue, and continue. Subsequent scheduled runs must keep working active review rows and consume active matching confirmations during preparation, without repeating calendar discovery solely because rows remain unconfirmed. If Earnings preparation fails for the same range, retain the last validated embedded week and continue the other dashboard sections. If it fails during rollover, stage a validated empty active-range week with `availability.status: "unavailable"` rather than showing prior-week dates. A focused Earnings apply also removes unrelated stale News/Crypto items and records partial coverage before complete validation, so valid Earnings staging is not stranded behind expired editorial stories; it records those system actions in a fresh hash-bound publication receipt. The final complete candidate must still pass dashboard validation.

`earnings_schedule_confirmations.json` uses this local generated-artifact shape (illustrative values):

```json
{
  "schemaVersion": 2,
  "rows": [{
    "symbol": "EXM",
    "primaryDate": "2026-07-29",
    "reportDate": "2026-07-30",
    "sourceName": "Example Corp Q2 earnings-date announcement",
    "sourceUrl": "https://investors.example.com/news/2026-q2-earnings-date"
  }]
}
```

`sourceUrl` is an audit pointer captured when the event-scoped confirmation is recorded, not a published-dashboard dependency or a requirement that the page remain available indefinitely. Prefer a durable SEC/EDGAR filing when it contains the announcement; otherwise use the relevant official company IR announcement or event page. Offline validation proves the record's structure and its binding to the current symbol and `primaryDate`; it does not fetch, authenticate, or preserve the remote source contents, and a later broken link does not invalidate an already recorded confirmation.

#### Post-report result refresh

1. Run `node scripts/earnings_week.js refresh` against the existing staged `generated/earnings_week.json`; outside the Friday-afternoon and Monday-morning rollover windows, do not rebuild a valid slate. If the embedded current range is an explicitly unavailable rollover shell, rebuild and refresh that same range on every scheduled run until it validates.
2. Select only rows whose report timing has arrived or passed, plus unresolved rows with `companyReleaseTasks`.
3. Refresh actual EPS/revenue from the row's primary deterministic source: Finnhub for Finnhub-covered rows, EarningsAPI company endpoint for previously recovered EarningsAPI rows, and SEC/company release only for official resolution tasks. Do not call EarningsAPI calendar in this phase. Collect Finnhub, each EarningsAPI symbol, and each Yahoo symbol independently. Apply every successful row; when a required key, provider request, matching provider row, call budget, or readable usage ledger is unavailable, retain only that row's prior facts and record `sourceAudit.resultRefresh` with `status: "partial"`, `checkedAt`, and provider-specific failures. The row remains retryable and the diagnostic clears after its next fully successful refresh.
4. Create `companyReleaseTasks` only for recovered rows with missing actuals or missing timing, or for an arrived provider-date conflict or official IR-confirmed redate whose actuals remain unavailable. Do not use company-release resolution to recover analyst estimates.
5. Resolve `companyReleaseTasks` against SEC/company release into `earnings_company_release_resolutions.json` with `node scripts/earnings_week.js resolve`. Besides secondary-recovery rows, an arrived provider-date conflict or official IR-confirmed redate escalates here when provider actuals remain unavailable; retain Finnhub estimates for comparison. Every task must receive one `resolved`, `needs_review`, or `unresolved` sidecar result, even when no filing or release can be found.
6. Apply every company-release disposition back into staged `generated/earnings_week.json` with `node scripts/earnings_week.js apply-release`. A `resolved` result may replace fields under the existing source-selection rules. A `needs_review` result independently promotes the one numeric official EPS or revenue actual supported by the SEC exhibit; the unpromoted metric retains provider data or remains unavailable. If both official actuals are usable, the disposition is `resolved`. An `unresolved` result records only the disposition. Both non-resolved statuses force partial provenance and remain nonblocking. The dashboard should not merge the sidecar at render time.
7. Compute EPS and revenue beat/miss mechanically from numeric estimate and actual values. If revenue estimate is unavailable, produce an EPS-only outcome and mark revenue `not_compared`.
8. Compute market reaction from Yahoo using timing-aware rules once the needed close is available: BMO/DMH = report-date close vs previous trading-day close; AMC = next trading-day close vs report-date close; unknown = unavailable. Before that close, use `reaction.status: "awaiting_close"`; reserve `unavailable` for a reaction window that cannot be resolved.
9. During the common editorial phase, let AI write only narrative fields and their dispositions into `generated/editorial/earnings_narrative.json`, using the verified numeric row plus official-release evidence. AI must not invent data, dates, estimates, actuals, reaction values, business drivers, or guidance. Pre-release `outcome.interpretation` is the required preview field for every display-eligible row before `close_available`; it should state the setup, key issue, or market question without pretending results are known. Preserve that pre-event commentary while a reported row is `released_awaiting_close`; the intermediate actual does not invalidate the preview. When the required close response moves the row to `close_available`, or the reaction becomes genuinely unresolvable, editorial preparation clears the preview and will not accept carried-forward pre-report copy. At that point the required post-release fields are `outcome.interpretation`, `outcome.guide` or an official no-guidance/unverified disposition, and `reaction.note`. Verified `outcome.interpretation` must be a terse, decision-relevant business takeaway of 120 characters or fewer, not a restatement of EPS/revenue beats or misses, and uses `interpretationDisposition.status: "verified"`. Verified `outcome.guide` must be 130 characters or fewer and name a quarterly or full-year horizon. An official finding that no updated guidance was provided uses `guidanceDisposition.status: "not_provided"` with `evidenceSource: "official_company"` and an official `evidenceUrl`; a failed search instead uses `status: "unverified"` with no guidance claim. A verified computed-reaction note uses `commentaryDisposition.status: "verified"`, remains within 100 characters, and explains a supported driver rather than repeating the displayed move. If required commentary cannot be supported after a current-run research attempt, use the field-specific unavailable or unverified disposition with no unsupported claim text. Generated blank dispositions are fail-open fallbacks, not completed editorial work. Every unavailable disposition records a reason and `attemptedAt`, renders a concise warning, preserves deterministic facts, and remains eligible for replacement on the next scheduled run.
10. Let the normal final apply command merge the bound editorial sidecar into the deterministic Earnings rows in memory. It requires one valid disposition for every applicable editorial field, ignores Earnings mutations in the general dashboard JSON, commits the complete dashboard candidate, and then refreshes the Earnings staging cache. Verified dispositions retain all substantive copy checks; `commentary_unavailable` and `unverified` are dashboard-ready, while malformed or contradictory dispositions are rejected. Source selection and lifecycle behavior are enforced directly by the shared contract and validation code rather than copied into generated policy prose.
11. For an explicit earnings-only repair outside the normal three-phase workflow, first use `node scripts/earnings_week.js apply-narrative`, then run `node scripts/run_daily_update.js --apply-earnings-week-json generated/earnings_week.json`. This focused path applies only a fully complete Earnings payload. A malformed review queue is warning-only; malformed or invalid Earnings staging makes the focused apply a nonfatal no-op. `earnings_week.js` never edits dashboard HTML, and the published dashboard must not fetch staging files at runtime.

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
  "outputPath": "generated/earnings_company_release_resolutions.json"
}
```

The company-release sidecar is not a dashboard runtime input. It must identify the exact staged earnings-week artifact it was derived from with `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`; `node scripts/earnings_week.js validate-release` verifies those fields against the week file before any apply step uses the sidecar. When the current week has no `companyReleaseTasks[]`, refresh removes a stale sidecar and `validate-release` succeeds as not applicable. Every active task must have exactly one matching `companyReleaseResolutions[]` entry. A dashboard-ready `earnings_week.json` with company-release tasks must include `companyReleaseApply.dispositions[]` with exactly one status for every task. Only `resolved` dispositions also appear in `companyReleaseApply.applied[]`. A `needs_review` disposition may update each canonical actual independently when that exact metric is numeric and backed by the recorded SEC exhibit; provider estimates and every unpromoted metric remain unchanged. `needs_review`, `unresolved`, and an active `sourceAudit.resultRefresh` diagnostic require `sourceStatus: "partial"`, render an information warning, and do not block publication. SEC/company-release resolution may carry estimates forward only from the EarningsAPI company endpoint for recovered rows, or from Finnhub for a resolved provider-date conflict; never use the EarningsAPI calendar discovery row.

The narrative sidecar uses the same source anchor fields: `sourceArtifact`, `sourceGeneratedAt`, and `sourceRange`. Normal dashboard finalization verifies those anchors against the staged candidate before merging `generated/editorial/earnings_narrative.json`; the focused `node scripts/earnings_week.js apply-narrative` command enforces the same binding before writing staging rows. Generated blank fields already carry retryable unavailable dispositions so the dashboard can fail open, but they are not a substitute for the editorial pass. Supplying verified copy requires changing the corresponding disposition to `verified`; leaving the unavailable disposition is acceptable only after a current-run attempt cannot support the required pre-release or post-release commentary and must remain visibly retryable.

## Appendix: Local refresh server

Run `node scripts/local_market_server.js` to start a read-only local market server at `https://192.168.2.2:2210`. It binds to the Mac Mini's reserved primary-LAN address, requires no paid API keys, and exposes:

- `GET /health`
- `GET /api/market-refresh`

The helper expects a dedicated TLS certificate at `~/.daily-financial-dashboard/tls/local-market-cert.pem` and its private key at `~/.daily-financial-dashboard/tls/local-market-key.pem`. The certificate must chain to a CA trusted by each client and contain `192.168.2.2` as an IP subject alternative name. Keep the server key at mode `0600`, archive the CA key encrypted outside the live TLS directory, and keep all TLS material outside Git. The tracked LaunchAgent template passes only the server certificate paths. The helper rejects browser origins other than `https://sdupuie.github.io` and local HTTP(S) development origins, while command-line requests without an `Origin` header remain available for diagnostics; CORS is not authentication. Do not forward port `2210` from the WAN, and keep guest-network access to the primary LAN blocked. See `launchd/README.md` for initial provisioning, CA-key archival, iPhone trust, the Local Network permission prompt, and renewal.

For local browser QA, serve the repository from `http://127.0.0.1` or `http://localhost`; direct `file://` pages have the opaque `null` origin and are intentionally rejected by the helper's origin policy.

The static dashboard always keeps embedded data as the production fallback. When the local market server is available, the browser silently tries `https://192.168.2.2:2210/api/market-refresh`, explicitly identifies the target address space as local, merges refreshed quote rows, crypto stat cards, and recent chart data, stores a materially changed local refresh in browser `localStorage` for up to 12 hours, and updates the status indicator beside The Tape heading. For every locally changed quote, the ephemeral overlay immediately replaces the embedded note with the same visible commentary-unavailable fallback; it never displays a refreshed local price beside prior commentary, and it never writes this overlay state back to the canonical artifact. Identical overlap data in a complete response produces the amber-outline idle state; a useful response with one or more failed rows or sections produces the filled amber partial state and includes the error count in its tooltip. At home, clients reach the reserved IP directly; away from home, a Teleport connection routes the same request to the primary LAN, so the GitHub Pages URL does not change. Reloads on the same embedded dashboard can render the cached local refresh immediately before checking the server again. The server treats chart refreshes and crypto-stat refreshes as independent sections, so one upstream crypto outage does not block otherwise healthy quote/chart updates. For chart data, it reads the embedded `chart-data` block, finds the latest embedded bar, and requests only the missing tail plus internal overlap, capped to avoid large backfills; full Treasury Yield Curve comparison history stays scheduled-only so a short local tail cannot replace the embedded 1M/6M curve context. `--days N` remains an explicit diagnostic override. GitHub Pages continues to work normally when the server is unreachable or Local Network permission is denied.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.
