# Daily Financial Dashboard

## What this repo publishes

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

### Production files

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `index.html`: published root entry point; it routes visitors to `daily_financial_news.html`.
- `scripts/`: operational fetch, validation, and publish helpers.
- `launchd/`: optional local-machine LaunchAgent templates for running dashboard helper scripts.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

Do not edit dashboard HTML, CSS, or JavaScript directly during a daily dashboard refresh.

## Scheduled and manual execution

- `--scheduled` identifies only a scheduler-driven Prepare or Apply run. Manual/on-demand and development runs omit it.
- In `America/Chicago`, the scheduled morning start window is 7:45–9:00 AM and the scheduled afternoon start window is 3:45–5:00 PM on weekdays.
- Scheduled preparation checks the weekday/time window and completion marker before fetching; scheduled Apply/finalization rechecks only the weekday/completion marker and may finish after the start window.
- Select the scheduled edition from Chicago time and keep the dashboard date and compile date on the local run date. Do not use the masthead, compiled timestamp, Git history, or a run lock as scheduler state.

## Daily Runbook

AI follows this section during normal updates.

Default manual-update scope: when the user asks for a manual dashboard update, run the full manual workflow by default: Prepare, AI Editorial Work, Apply, validation, commit, and publish. Stop earlier only when the request explicitly says to stop at a named stage, such as Prepare only, through Apply, or before publication.

### Canonical two-command workflow

| Run | 1. Prepare Handoff | 2. AI Editorial Work | 3. Apply Handoff |
| --- | --- | --- | --- |
| Scheduled | Run `node scripts/run_daily_update.js prepare --scheduled --morning` or `node scripts/run_daily_update.js prepare --scheduled --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every requested non-News review item and decision. For News, follow the News-card contract and write selected cards only to `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`. | Run `node scripts/run_daily_update.js apply --scheduled`; then commit on `main` and run `./scripts/publish_main.sh` |
| Manual/on-demand | Run `node scripts/run_daily_update.js prepare --morning` or `node scripts/run_daily_update.js prepare --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every requested non-News review item and decision. For News, follow the News-card contract and write selected cards only to `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`. | Run `node scripts/run_daily_update.js apply`; commit and publish only when the manual update is intended to go live |

### Core guarantees

- **Prepare Handoff:** validates staging and writes the handoff/candidate while leaving the canonical dashboard unchanged.
- **AI Editorial Work:** happens only in `generated/editorial/dashboard-data.json`; refreshed quotes need reviewed commentary, while failed quote downloads retain their prior validated quote and commentary together.
- **Apply Handoff:** validates and atomically updates the local canonical dashboard; `publish_main.sh` publishes only after commit.

## AI Editorial Instructions

Use this section during AI Editorial Work. It is the canonical handoff-editing contract for `generated/editorial/dashboard-data.json`: review, write, and select only the editorial fields described here. Do not edit source code, dashboard HTML, generated market data, calendar facts, earnings facts, or deterministic section values as part of AI Editorial Work.

### AI Editorial Work contracts

- `opening`: write the current edition's `headline`, `deck`, and exactly 4 catalyst cards. Each catalyst must have a short `label` and a current, evidence-supported `body` summarizing one of the update's main market drivers.
- `news`: use `editorialReview.newsSearch` as read-only source material. The only News field the AI edits is `editorialReview.newsSelection`; follow the News-card contract and Story selection policy below.
- `tape`: leave generated quote fields unchanged. Each refreshed Tape row needs current reviewed commentary; failed quote downloads retain their prior quote and commentary.
- `assetAllocationPortfolio`: review the generated ETF rows and sanitized portfolio summary. Use the Asset Allocation fallback only if that refresh fails.
- `earnings.week`: leave the generated five-trading-day slate, facts, and reactions unchanged. Complete every visible Earnings row under the Earnings editorial contract below.
- `weekAhead`: do not hand-edit deterministic dates, times, event names, impact levels, actual/forecast/previous values, release states, surprises, or close reactions.
- `footer`: preserve the generated compile prefix and maintain only concise non-derivable source-family or holiday context.

### AI Editorial Work checklist

1. Verify the handoff and deterministic envelope before editorial work.
   - Use the current handoff only; regenerate it if it becomes stale.
   - Leave generated masthead date/edition, compile prefix, Futures labels, and Tape session label unchanged.
   - The AI owns only the key-driver portion of `tape.label` after the separator and non-derivable source or holiday context after the generated compile prefix.
   - The run date is always the current Chicago date, including prior-evening holiday context; explain a next-day closure in `weekAhead`, stories, or the editorial footer context rather than forward-dating the envelope.
   - Friday afternoon shows current Friday plus next Monday-Thursday. Monday morning shows current Monday-Friday. Ordinary manual runs refresh the active Earnings range; manual calendar rollover requires `--rollover-calendar` and uses the local weekend day when run on Saturday or Sunday.

2. Confirm the normal deterministic refresh ran before reading news.
   - Use the matching canonical two-command workflow entry.
   - If generated market data, calendar facts, earnings facts, or deterministic section values look stale or wrong, stop and use the Reference Appendix.
   - Do not name quote/news sources in visible copy. Keep the compact source-family attribution in `footer.compiled`; use chart source details for row-specific provenance.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Review downloaded News after prices and before making any editorial decisions.
   - Use `editorialReview.newsSearch` as read-only source material; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable.
   - The AI owns relevance review, source-quality assessment, angle diversity, final selection, and reader-facing copy. The only News field the AI edits is `editorialReview.newsSelection`.
   - Before editing Opening, Futures stories, Tape commentary, Moving Today, Crypto notes, Earnings narrative, Week Ahead commentary, Market Lens, or footer context, review every candidate in `editorialReview.newsSearch.generalCandidates` and `editorialReview.newsSearch.cryptoCandidates`, including every still-fresh prior card. Do not stop reviewing after finding enough stories to fill a section.
   - Review each candidate in sufficient detail to assess its title and subject, publisher and source fidelity, publication date and exact timestamp, reader-facing URL, available summary or article text, current-dashboard relevance, substantial overlap with other candidates, and eligibility for the authoritative Futures publication window. Do not silently skip a candidate just because article-page text is missing.
   - Provisional notes may be recorded during the complete-pool review, but do not finalize a shortlist, reject the remaining pool, write story copy, or begin other editorial work until every candidate has been examined.
   - Compare all candidates in the generated News inventory with every still-fresh prior card. Retain a prior card only when it remains among the strongest relevant, source-faithful coverage; do not discard or churn it merely because the scheduled window changed.
   - Treat every candidate in the generated News inventory as eligible for editorial consideration. Before making any editorial decision, review the complete inventory and rank the candidates. Use the News-card selection counts as targets; when fewer candidates are available, select the strongest available cards and do not invent filler.
   - For selected News cards, add one entry to `editorialReview.newsSelection.futures`, `.stories`, or `.crypto` with the candidate `url` plus only `tag`/`kicker`, `title`, and `body`; do not hand-build final card arrays.
   - Follow the News-card contract and Story selection policy below for required fields, source choice, carry-forward decisions, and link rules.

4. Editorialize the generated handoff in this order.
   - `masthead`: leave the generated edition and date unchanged.
   - `opening`: complete the Opening contract above.
   - `futuresModule`: leave the four generated futures rows and session labels unchanged; select the active window’s stories through `editorialReview.newsSelection.futures`. Use each story’s descriptive `tag` for its visible badge.
   - `tape`: leave generated quote fields unchanged; update the editorial roster only when intentionally changing coverage, and rewrite each refreshed Tape note. Each note must summarize the relevant market commentary or catalyst without carrying prior commentary forward or restating quote values. Before Apply Handoff, compare every refreshed Tape note against that row's generated direction, delta, and percent; rewrite any note that contradicts the displayed move. Every Crypto-group ticker needs its own current note for the collapsed Tape Crypto tab; do not reuse generic copy across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible Crypto tickers. Leave failed-download rows on their last validated quote and bound commentary.
   - `assetAllocationPortfolio`: review the generated ETF rows and sanitized portfolio summary. Use the Asset Allocation fallback only if that refresh fails.
   - `stories`: select the broad-market news collection through `editorialReview.newsSelection.stories` per the News-card contract.
   - `crypto`: leave generated `crypto.stats[]` values unchanged and select only the crypto news collection through `editorialReview.newsSelection.crypto` per the News-card contract. Crypto ticker quote rows are generated in `tape.rows[]` with `group: "Crypto"`; their ticker-level commentary remains editorial.
   - `earnings.week`: complete the Earnings editorial contract below.
   - `weekAhead`: complete the Week Ahead and Market Lens editorial contract below.
   - `footer`: complete the Footer contract above.

5. Apply the copy and tone rules below.
   - Before Apply Handoff, confirm the handoff has no unfinished editorial markers: no `pending_review` remains in Tape or `editorialReview.marketLensDecisions[].action`. Complete every reviewable Earnings and Week Ahead Outcome field. Any remaining `pending_review` must be a system-provided carry-forward state left unchanged.

### Copy and tone rules

- Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
- Keep publisher attribution out of story titles and bodies. Put source attribution only in `footer.compiled`.
- Do not write tautological market-status copy that states routine facts without saying why they matter.
- Market-closure rows should read as status labels, not watchlists. Prefer `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate, then put any crypto or overseas-market context in the event sentence only if it is genuinely relevant.
- Crypto ticker notes in `tape.rows[]` rows with `group: "Crypto"` should explain the factor driving that ticker or proxy today: bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.
- Crypto notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation.
- Do not merely restate quote rows in ticker notes, crypto notes, or story bodies.
- Earnings color rule: use muted styling for consensus/pending estimates, neutral styling for reported fundamentals such as EPS/revenue/guidance, and red/green only for market reactions or clearly labeled beat/miss surprises.

### News-card contract

Every news card is a dated, reader-facing article. Do not use `referencePage`; durable calendars and schedules belong in `weekAhead` or footer context.

| Selection bucket | Target | AI supplies |
| --- | --- | --- |
| `editorialReview.newsSelection.stories` | Target 9 broad-market cards from the generated News inventory | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.crypto` | Target 6 crypto-specific cards from the generated News inventory | candidate `url`, `kicker`, `title`, `body` |
| `editorialReview.newsSelection.futures` | Target 3 current catalysts from `editorialReview.newsSearch.futuresCandidates` | candidate `url`, `tag`, `title`, `body` |

- `editorialReview.newsSearch` is read-only source material. Prepare Handoff filters displayed-session Futures stories into `futuresCandidates`: Pre-Market Futures use the overnight futures window from 5:00 PM CT on the prior Chicago calendar day through the prepared run time or 8:30 AM CT, whichever is earlier; Session Futures use the shared `raw.sessionDate` regular-session window. When no shared Futures story window can be proven, Futures stories use the normal News freshness rule. Select Futures only from `futuresCandidates`. Selected article URLs and copy belong only in `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`.
- A selected URL must come from the generated candidate inventory.
- Do not set or edit coverage/New-pill fields.
- Resolve duplicate URLs/titles, wrong section category, and below-target counts during AI Editorial Work; Apply Handoff does not select replacement stories.
- Use only candidates with a valid publication date/time. Futures selections require a verified offset-bearing ISO `publishedAt`; Apply Handoff mirrors the Prepare Handoff Futures-window check defensively.

### Story selection policy

- Fresh enough to keep is not the same as worthy to keep. Review and rank the generated surplus candidate pool before choosing the final collection; select for relevance, explanatory value, freshness, source quality, and distinct angles rather than taking the first qualifying links found.
- A prior card may enter the candidate pool only when it is still fresh, relevant, and source-faithful; it then competes directly with current candidates.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, readable Reuters, CNBC, Investopedia, Kiplinger, Investor's Business Daily, Yahoo Finance, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, Blockworks, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
- Match every story's headline and body to its linked article's main reported theme. Narrow a card to a company, earnings, product, or subtheme angle when that is all the reporting supports; do not use it to imply a broader market, sector, or macro claim.
- `READ MORE` links must be reader-facing HTML pages, never raw APIs, feeds, JSON, or CSV downloads.

### Earnings editorial contract

Treat every visible Earnings row as an independent editorial assignment. Research and write each row separately using current, company-specific evidence. Do not consult, reuse, or paraphrase prior dashboard commentary when completing a new assignment.

Earnings has two narrative states:

- **Before actuals:** Explain the company-specific business question, operating metric, or management outlook most likely to determine the earnings read. Base this on the company’s latest results and guidance, current expectations, and known company-specific developments.
- **After at least one verified actual:** Replace the pre-release commentary with the principal business takeaway from the verified reported facts. If EPS or revenue is still missing, discuss only the verified facts and do not imply the missing metric was reviewed. Complete each required field under the Earnings field contract below.

Editorial work is required at these transitions:

1. **Calendar rollover:** Write fresh pre-release commentary for every visible row in the new slate, including companies retained from the preceding calendar. Prior copy cannot be carried forward as completed work.
2. **Results arrival:** Once at least one verified actual is available, remove the pre-release commentary, write the post-release interpretation, and complete the guidance determination.
3. **Verified close arrival:** Add company-specific reaction commentary explaining what the market response indicates. Update the result interpretation as well if the reaction materially changes the earnings read.

A transition from `scheduled` to `awaiting_actual` does not create a new narrative state because no results have arrived. Continue to show the current pre-release thesis and do not invent results. Any correction to the report date, timing, estimates, actuals, guidance, or closing reaction invalidates the commentary affected by that correction.

Use official company releases, filings, presentations, and earnings-call materials first. Use the deterministic Earnings facts for reported values and reaction data. Use reputable reporting when needed to explain market context or reaction. Evidence reviewed for one company does not verify commentary for another.

`verified` means that current evidence was reviewed for that specific company, transition, and narrative field. The presence of text alone does not make a field verified.

Earnings field contract after actuals arrive:

- `outcome.interpretation`: required once at least one verified actual is available. Explain the result takeaway using only verified EPS, revenue, guidance, operating, and management-commentary facts.
- `outcome.guide`: required as a guidance determination once at least one verified actual is available. Search official company sources first and exhaustively: earnings release, investor-relations release page, shareholder letter, earnings presentation, and linked or available 8-K exhibits; use earnings-call materials or transcripts when release materials do not answer the guidance question. If official forward guidance exists, write concise guide text and mark `guidanceDisposition.status = "verified"`. If exhaustive official-source review finds no guidance was provided, leave `outcome.guide` blank and mark `guidanceDisposition.status = "not_provided"` with official-company evidence. If the guidance determination cannot be completed, leave or keep `guidanceDisposition.status = "pending_review"`; do not guess and do not mark `not_provided`.
- `reaction.note`: required only after the verified close reaction is available. Explain the earnings driver behind the market response.

Commentary is not completed editorial work when it:

- Could be moved unchanged to another ticker.
- Duplicates or closely paraphrases another row.
- Merely restates displayed EPS, revenue, or price values.
- Uses generic references to demand, costs, margins, execution, or management outlook without identifying the company-specific issue.
- Reuses a batch template, placeholder, or prior-state commentary.

Every required Earnings narrative field must contain completed, company-specific commentary supported by current evidence. Generic, duplicated, templated, or unsupported text does not satisfy the requirement and must not be marked verified.

Compact Earnings monitor writing rules:

- Keep the post-release business takeaway to 120 characters or fewer.
- Keep the guidance summary to 130 characters or fewer.
- Keep the stock-reaction note to 100 characters or fewer.
- For reported rows, explain the business takeaway rather than restating an EPS or revenue beat or miss.
- Name at least one concrete business driver and explain why it matters to the earnings read.
- When guidance is provided, summarize only the official company outlook and identify whether it is next-quarter or full-year guidance. If both are provided, lead with the quarterly outlook.
- For stock-reaction notes, explain the earnings driver behind the move rather than repeating the displayed percentage change.

### Week Ahead / Market Lens editorial contract

For each current event day, choose whether to keep generated commentary or replace it. Once an event has released, replace pre-release copy with current commentary.

Reconsider every event day against the current Opening, Tape, and verified news. Do not treat carried-over copy as automatically reviewed.

Before the close, the visible Market Lens remains forward-looking. At `close_available`, write verified `Outcome & Close Reaction` editorial copy interpreting the released facts and session response. Prepare Handoff marks Outcome only after released actuals and close-reaction rows are available. Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

Scheduled or awaiting days may retain generated Market Lens copy or use a valid replacement. Released days without actuals keep trying deterministic value recovery. Once released actuals are available, supply current Market Lens commentary if a valid current editorial lens is not already present. At `close_available`, supply verified Outcome copy only when Prepare Handoff marks it `pending_review`. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice.

## Validation and Publish

### Required daily checks

- Before committing a content-only update, run only `node scripts/validate_dashboard.js readiness --skip-tests --allow daily_financial_news.html`. The `--allow` option hides expected dirty files from the warning list; readiness reports but does not block on other dirty files.
- For quick iteration or an ordinary non-publish check, run `node scripts/validate_dashboard.js daily_financial_news.html`.
- Let `./scripts/publish_main.sh` own the full readiness gate before it pushes; do not run the complete suite immediately before publishing.

### Expanded content and layout checks

Run the applicable checks after content, structural, layout, script, or contract changes:

- Avoid market-superlative claims unless directly verified during AI Editorial Work.
- Run `tidy -q -e daily_financial_news.html` and browser-check the production page after structural or layout changes. After changing Market Lens or Outcome copy, reactions, or routing, check narrow mobile and desktop widths for readability and overflow; activate pre-close and post-close reaction controls with pointer and keyboard; verify the correct Tape group, ticker, and chart open; verify focus moves to the chart heading; and verify repeated activation leaves that chart open.
- After changing an information tooltip, browser-check tap, hover, and keyboard activation at narrow mobile, tablet, and desktop widths. The tooltip must remain inside the viewport and each state must remain legible.
- Run `node scripts/validate_dashboard.js test` after script or data-contract changes when publication is not the immediate next step. Run `node scripts/test_dashboard.js --local-refresh` only when changing local-refresh behavior.
- Nonvisual data, contract, validation, and refactoring changes require no browser pass. For visible changes, exercise only the affected interactions and applicable breakpoints, including every specific tooltip or Week Ahead check listed above when that surface changed.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm publication succeeds and `git status --short --branch` no longer shows local commits ahead of `origin/main`.

Normal daily updates stop here. The Reference Appendix is not AI Editorial Work guidance. During Prepare Handoff, AI Editorial Work, or Apply Handoff, use the appendix only when this runbook explicitly points to it, when debugging a failed run, or when changing code/data contracts.

## Reference Appendix

### Data Contracts

This section is the canonical human-readable contract for dashboard data. Keep `scripts/validate_dashboard.js` and fetch-script output in sync with this section whenever a payload shape changes.

#### Published payload boundary

The embedded `dashboard-data` JSON block lives between the `DATA START` / `DATA END` comments in `daily_financial_news.html`. The embedded `chart-data` JSON block is a separate production payload. Generated files are staging only and must not become published runtime dependencies.

#### Week Ahead

- Owner: `scripts/week_ahead_contract.js` defines the deterministic slate, Market Lens channel rules, and Outcome contract.
- Boundary rules: Market Lens reactions must use canonical Tape tickers present in both `tape.rows[]` and `chart-data.series[]`; released events require current replacement commentary; `outcome` exists only at `close_available` and cannot change the preselected reaction ticker set.
- Publication safety: Apply/finalization must not retain stale generated or pre-release Market Lens or Outcome commentary after release. When verified current Outcome copy is unavailable or invalid, the implementation records `pending_review` and publishes no Outcome copy.

#### Tape and chart data

- Owners: `scripts/fetch_chart_data.js` produces chart/futures data, and `scripts/validate_dashboard.js` enforces embedded chart/Tape consistency.
- Boundary rules: `chart-data.series[]` is the canonical market-data store; visible Tape quote fields are derived from it; every displayed Tape ticker must have matching embedded source, chart series, and derived quote data.
- Tape commentary binds to the accepted quote revision. Refreshed quotes need reviewed commentary; failed quote downloads retain their last validated quote and bound commentary.
- Crypto ticker quote rows live in `tape.rows[]`, not `crypto.tape[]`.

#### Asset Allocation

- Owner: `scripts/fetch_asset_allocation.js` supplies instrument-level ETF market data and sanitized portfolio summary data.
- Boundary rules: never embed tactical weights, signals, or allocation calculations; lookahead dividend events never enter current MTD dividend totals.

#### Crypto

- Owner: `scripts/fetch_crypto_stats.js` supplies crypto stat cards; Crypto news cards follow the News-card contract.
- Boundary rules: `crypto.stats[]` is for section stat cards, `crypto.notes[]` is for crypto news, and ticker-level crypto commentary belongs in `tape.rows[]`.

#### Futures

- Owner: `scripts/fetch_chart_data.js` owns Futures payloads.
- Boundary rules: `futuresModule.futures[]` contains exactly four index-futures rows unless `availability.status` is explicitly `unavailable`; Futures story rules live in the News-card contract.

### Deterministic Source Contracts

Use this reference only when deterministic refresh fails and a documented manual fallback is necessary. Do not use it as an alternate daily workflow.

Manual fallback work never goes directly into `daily_financial_news.html`. Put the verified fallback into the appropriate staging artifact or editorial handoff, then return to the normal Prepare Handoff / Apply Handoff workflow. If the correct entry point is unclear, stop and check the relevant data contract rather than editing the published dashboard.

#### Price-source hierarchy

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

### Earnings Deterministic Method

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`.

#### Source hierarchy

1. Finnhub primary: calendar slate, company profile, timing, estimates, and actuals when Finnhub has the row.
2. EarningsAPI secondary: date corroboration during authorized weekly builds and row-level recovery only for Finnhub-missing display candidates.
3. Official company IR or SEC fallback: schedule confirmation and official-result resolution when provider data is incomplete or conflicting.
4. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

#### Canonical row contract

Earnings rows use the shared lifecycle vocabulary; validation owns the full schema. Dashboard-visible provenance stays compact, while detailed source audit remains build/debug data.

#### EarningsAPI budget policy

- Treat the Free-plan daily quota (100 requests) as a scarce secondary-recovery budget, not a primary data source.
- EarningsAPI calendar scans are authorized only by scheduler-marked Monday-morning and Friday-afternoon rollovers or `--rollover-calendar` on an intentional manual preparation. They never run during ordinary manual updates, automatic retries, development, validation, tests, source-code verification, focused repairs, or result refreshes.
- Query EarningsAPI company rows only for Finnhub-missing display candidates.
- Do not call EarningsAPI reactions in the normal path; Yahoo remains the reaction source.

### Focused Repair Commands

Use focused repair commands only for explicit repairs. They update the current staged candidate, not the canonical dashboard. After a focused repair, regenerate the editorial handoff from that repaired candidate, then run `apply`; rerun `prepare` only when intentionally replacing the candidate.

- Market Lens-only correction: no standalone command. Use the current complete candidate when it still matches the canonical dashboard edition, regenerate the editorial handoff, and make the decision there. If no current candidate exists, rerun deterministic preparation first.
- Chart-only correction: start with a current complete candidate, then use `node scripts/run_daily_update.js --apply-chart-data-json PATH`, `node scripts/run_daily_update.js --merge-chart-data-json PATH`, or `node scripts/run_daily_update.js --sync-chart-quotes`. Regenerate the editorial handoff afterward; successful quote changes require reviewed commentary.
- Asset Allocation fallback: refresh `http://127.0.0.1:2200/api/asset-market-data`, then use `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`. If refresh fails but the export exists, use it as a stale fallback; never import tactical allocation/model logic.
- Earnings-only repair: first complete deterministic preparation, then run `node scripts/earnings_week.js apply-narrative`, run `node scripts/run_daily_update.js --apply-earnings-week-json generated/earnings_week.json`, regenerate the editorial handoff from the repaired candidate, and run `apply`.
- Company-release earnings repair: when `companyReleaseTasks[]` exist, run `node scripts/earnings_week.js resolve`, `node scripts/earnings_week.js validate-release`, `node scripts/earnings_week.js apply-release`, then `node scripts/run_daily_update.js --apply-earnings-week-json generated/earnings_week.json`, regenerate the editorial handoff from the repaired candidate, and run `apply`.
- Manual calendar rollover: use `node scripts/run_daily_update.js prepare --afternoon --rollover-calendar` for the Friday-through-Thursday bridge, or `node scripts/run_daily_update.js prepare --morning --rollover-calendar` for Monday-through-Friday. On Saturday, either edition rolls to the Friday bridge; on Sunday, either edition rolls to Monday-Friday.

### Local Refresh Server

Run `node scripts/local_market_server.js` to start the optional read-only local market overlay at `https://192.168.2.2:2210`. It exposes:

- `GET /health`
- `GET /api/market-refresh`

Local refresh may overlay fresher browser data, but it never writes that overlay back to the canonical artifact and must never display refreshed quote values beside prior commentary. See `launchd/README.md` for provisioning, TLS, origin policy, and renewal.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.

### Browser Support

The supported baseline is Chromium 120+ (Chrome and Edge), Firefox 121+, and Safari 17.4+ on macOS and iOS. Older browsers, browser-version branches, and polyfills are out of scope unless a concrete supported-browser behavior requires them.
