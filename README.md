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
- Before beginning any manual or scheduled dashboard update, read the current `README.md` Daily Runbook from disk and use it as the workflow authority before running Prepare Handoff or making editorial changes.
- In `America/Chicago`, the scheduled morning start window is 7:45–9:00 AM and the scheduled afternoon start window is 3:45–5:00 PM on weekdays.
- Scheduled preparation checks the weekday/time window and completion marker before fetching; scheduled Apply/finalization rechecks only the weekday/completion marker and may finish after the start window.
- Select the scheduled edition from Chicago time and keep the dashboard date and compile date on the local run date. Do not use the masthead, compiled timestamp, Git history, or a run lock as scheduler state.

## Daily Runbook

AI follows this section during normal updates.

Default manual-update scope: when the user asks for a manual dashboard update, run the full manual workflow by default: Prepare, AI Editorial Work, Apply, validation, commit, and publish. Stop earlier only when the request explicitly says to stop at a named stage, such as Prepare only, through Apply, or before publication.

### Canonical two-command workflow

| Run | 1. Prepare Handoff | 2. AI Editorial Work | 3. Apply Handoff |
| --- | --- | --- | --- |
| Scheduled | Run `node scripts/run_daily_update.js prepare --scheduled --morning` or `node scripts/run_daily_update.js prepare --scheduled --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the section contracts below. | Run `node scripts/run_daily_update.js apply --scheduled`; then commit on `main` and run `./scripts/publish_main.sh` |
| Manual/on-demand | Run `node scripts/run_daily_update.js prepare --morning` or `node scripts/run_daily_update.js prepare --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the section contracts below. | Run `node scripts/run_daily_update.js apply`; commit and publish only when the manual update is intended to go live |

### Codex command execution

- When Codex runs Prepare, use escalated local command execution. Zacks uses Playwright Chromium during Earnings preparation, and Chromium may not launch in the default managed sandbox.
- This changes only how the Prepare command is invoked from Codex; the commands remain `node scripts/run_daily_update.js prepare --morning`, `node scripts/run_daily_update.js prepare --afternoon`, `node scripts/run_daily_update.js prepare --scheduled --morning`, or `node scripts/run_daily_update.js prepare --scheduled --afternoon`.

### Core guarantees

- **Prepare Handoff:** validates deterministic staging, resolves each failed section to validated carried-forward data or an explicit unavailable state, and writes the handoff/candidate while leaving the canonical dashboard unchanged.
- **AI Editorial Work:** happens only in `generated/editorial/dashboard-data.json`; refreshed quotes need reviewed commentary, while failed quote downloads retain their prior validated quote and commentary together.
- **Apply Handoff:** merges editorial work without revalidating or replacing deterministic candidate data, runs one top-level render-safety check, and atomically updates the local canonical dashboard; `publish_main.sh` publishes only after commit.

## AI Editorial Instructions

Use this section during AI Editorial Work. It is the canonical handoff-editing contract for `generated/editorial/dashboard-data.json`: review, write, and select only the editorial fields described here. Do not edit source code, dashboard HTML, generated market data, calendar facts, earnings facts, or deterministic section values as part of AI Editorial Work.

### AI Editorial Work contracts

Blank fields or decisions marked `pending_review` are active AI assignments unless the section contract explicitly says they are system-provided carry-forward state.

- `masthead`: leave the generated edition and date unchanged.
- `opening`: write the current edition's `headline`, `deck`, and exactly 4 catalyst cards. Each catalyst must have a short `label` and a current, evidence-supported `body` summarizing one of the update's main market drivers.
- `news inventory`: use `editorialReview.newsSearch` as read-only source material; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable.
- `futuresModule`: leave generated futures rows and session labels unchanged; select Futures cards through `editorialReview.newsSelection.futures` under the News-card contract.
- `tape`: leave generated quote fields unchanged; update the editorial roster only when intentionally changing coverage, and rewrite each refreshed Tape note. Each note must summarize the relevant market commentary or catalyst without carrying prior commentary forward or restating quote values. Before Apply Handoff, compare every refreshed Tape note against that row's generated direction, delta, and percent; rewrite any note that contradicts the displayed move. Every Crypto-group ticker needs its own current note for the collapsed Tape Crypto tab; do not reuse generic copy across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible Crypto tickers. Failed quote downloads retain their last validated quote and bound commentary.
- `assetAllocationPortfolio`: review the generated ETF rows and sanitized portfolio summary. Leave deterministic values unchanged, including any carried-forward or unavailable state resolved during Prepare.
- `stories`: select the broad-market news collection through `editorialReview.newsSelection.stories` under the News-card contract.
- `crypto`: leave generated `crypto.stats[]` and `crypto.dominance` values unchanged, and select only the crypto news collection through `editorialReview.newsSelection.crypto` under the News-card contract. Crypto ticker quote rows are generated in `tape.rows[]` with `group: "Crypto"`; their ticker-level commentary remains editorial under the Tape contract.
- `earnings.week`: leave the generated five-trading-day slate, facts, and reactions unchanged. Complete every visible Earnings row under the Earnings editorial contract below.
- `weekAhead`: do not hand-edit deterministic dates, times, event names, impact levels, actual/forecast/previous values, release states, surprises, or close reactions. Complete Market Lens and Outcome fields under the Week Ahead / Market Lens editorial contract below.
- `footer`: leave the generated footer unchanged.

### AI Editorial Work checklist

1. Verify the handoff and deterministic envelope before editorial work.
   - Use the current handoff only; regenerate it if it becomes stale.
   - Leave generated masthead date/edition, compile prefix, Futures labels, and Tape session label unchanged.
   - The AI owns only the key-driver portion of `tape.label` after the separator.
   - The run date is always the current Chicago date, including prior-evening holiday context; explain a next-day closure in `weekAhead` or stories rather than forward-dating the envelope.
   - Friday afternoon shows current Friday plus next Monday-Thursday. Monday morning shows current Monday-Friday. Ordinary manual runs refresh the active Week Ahead and Earnings ranges; manual calendar rollover requires `--rollover-calendar` and uses the local weekend day when run on Saturday or Sunday.

2. Confirm the normal deterministic refresh ran before reading news.
   - Use the matching canonical two-command workflow entry.
   - If generated market data, calendar facts, earnings facts, or deterministic section values look stale or wrong, stop and use the Reference Appendix.
   - Do not name quote/news sources in narrative copy. News cards may show the deterministic card-level `sourceLabel`; use chart source details for row-specific provenance.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Review downloaded News after prices and before making any editorial decisions.
   - Use `editorialReview.newsSearch` as read-only source material; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable.
   - The AI owns relevance review, source-quality assessment, angle diversity, final selection, and reader-facing copy. The only News field the AI edits is `editorialReview.newsSelection`.
   - Before editing Opening, Futures stories, Tape commentary, Moving Today, Crypto notes, Earnings narrative, Week Ahead commentary, or Market Lens, review every candidate in `editorialReview.newsSearch.generalCandidates` and `editorialReview.newsSearch.cryptoCandidates`, including every still-fresh prior card. Do not stop reviewing after finding enough stories to fill a section.
   - Review each candidate in sufficient detail to assess its title and subject, publisher and source fidelity, publication date and exact timestamp, reader-facing URL, available summary or article text, current-dashboard relevance, substantial overlap with other candidates, and eligibility for the authoritative Futures publication window. Do not silently skip a candidate just because article-page text is missing.
   - Provisional notes may be recorded during the complete-pool review, but do not finalize a shortlist, reject the remaining pool, write story copy, or begin other editorial work until every candidate has been examined.
   - Compare all candidates in the generated News inventory with every still-fresh prior card. Retain a prior card only when it remains among the strongest relevant, source-faithful coverage; do not discard or churn it merely because the scheduled window changed.
   - Treat every candidate in the generated News inventory as eligible for editorial consideration. Before making any editorial decision, review the complete inventory and rank the candidates. Use the News-card selection counts as targets; when fewer candidates are available, select the strongest available cards and do not invent filler.
   - For selected News cards, add one entry to `editorialReview.newsSelection.futures`, `.stories`, or `.crypto` with the candidate `url` plus only `tag`, `title`, and `body`; do not hand-build final card arrays.
   - Follow the News-card contract and Story selection policy below for required fields, source choice, carry-forward decisions, and link rules.

4. Apply these copy and tone rules throughout AI Editorial Work.
   - Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep publisher attribution out of story titles and bodies. News-card provenance belongs only in the generated `sourceLabel` metadata.
   - Do not write tautological market-status copy that states routine facts without saying why they matter.
   - Market-closure rows should read as status labels, not watchlists. Prefer `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate, then put any crypto or overseas-market context in the event sentence only if it is genuinely relevant.
   - Crypto ticker notes in `tape.rows[]` rows with `group: "Crypto"` should explain the factor driving that ticker or proxy today: bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.
   - Crypto notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation.
   - Do not merely restate quote rows in ticker notes, crypto notes, or story bodies.
   - Earnings color rule: use muted styling for consensus/pending estimates, neutral styling for reported fundamentals such as EPS/revenue/guidance, and red/green only for market reactions or clearly labeled beat/miss surprises.

5. Editorialize the generated handoff in this order.
   - `masthead`: complete the Masthead contract above.
   - `opening`: complete the Opening contract above.
   - `futuresModule`: complete the Futures contract above.
   - `tape`: complete the Tape contract above.
   - `assetAllocationPortfolio`: complete the Asset Allocation contract above.
   - `stories`: complete the Stories contract above.
   - `crypto`: complete the Crypto contract above.
   - `earnings.week`: complete the Earnings editorial contract below.
   - `weekAhead`: complete the Week Ahead / Market Lens editorial contract below.
   - `footer`: complete the Footer contract above.

6. Run the final pre-Apply editorial gate.
   - Confirm the handoff has no unresolved active AI assignments: no `pending_review` remains in Tape, Market Lens, Earnings, Week Ahead Outcome, or guidance unless the section contract explicitly identifies that field as system-provided carry-forward state. Complete, fix, or repair the handoff before Apply.
   - Audit every refreshed Tape note for ticker-specific, current commentary. Rewrite notes that are generic, formulaic, interchangeable across tickers, merely restate quote movement, or use repeated framing. Each refreshed note must name or clearly imply the relevant catalyst or market driver for that row.
   - Audit every Crypto-group Tape note separately. Each visible Crypto ticker needs its own crypto-specific driver, such as bitcoin leadership, ETH/SOL relative strength, ETF demand, regulation, market structure, protocol updates, exchange/issuer developments, sentiment, or listed-proxy beta. Do not reuse generic crypto copy.
   - Compare every refreshed Tape note against that row's generated direction, delta, and percent. Rewrite any note that contradicts or ignores the displayed move before Apply.
   - Every `editorialReview.newsSelection.futures[].url` must appear in `editorialReview.newsSearch.futuresCandidates`.
   - Every `editorialReview.newsSelection.stories[].url` must appear in `editorialReview.newsSearch.generalCandidates`.
   - Every `editorialReview.newsSelection.crypto[].url` must appear in `editorialReview.newsSearch.cryptoCandidates`.
   - No selected URL may appear twice within a section or across Futures, Stories, and Crypto.
   - Futures selections must satisfy the Futures catalyst rule below.
   - If a selected URL fails any check, fix `editorialReview.newsSelection` before Apply Handoff. Do not rely on Apply Handoff to omit or replace it.
   - Inspect intended editorial fallbacks before Apply. Any avoidable editorial fallback, duplicate omission, blank reviewed field, or below-target section caused by AI selection or copy quality must be fixed or repaired in the handoff before Apply.
   - Confirm required Earnings and Week Ahead commentary is current, company- or event-specific, and not carried forward as completed work when the section contract requires fresh review.
   - If the section remains below target after all eligible reviewed candidates are exhausted, leave it below target rather than inventing filler.
   - Run Apply only after the AI can state: `The handoff passed the pre-Apply editorial checklist.` Any checklist failure means continue repairing `generated/editorial/dashboard-data.json` until it passes, then send it to Apply.

### News-card contract

Every news card is a dated, reader-facing article. Do not use `referencePage`; durable calendars and schedules belong in `weekAhead`.

| Selection bucket | Target | AI supplies |
| --- | --- | --- |
| `editorialReview.newsSelection.stories` | Target 9 broad-market cards from the generated News inventory | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.crypto` | Target 6 crypto-specific cards from the generated News inventory | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.futures` | Target 3 current catalysts from `editorialReview.newsSearch.futuresCandidates` | candidate `url`, `tag`, `title`, `body` |

- `editorialReview.newsSearch` is read-only source material. Prepare Handoff filters displayed-session Futures stories into `futuresCandidates`: Pre-Market Futures use the overnight futures window from 5:00 PM CT on the prior Chicago calendar day through the prepared run time or 8:30 AM CT, whichever is earlier; Session Futures use the shared `raw.sessionDate` regular-session window. When no shared Futures story window can be proven, Futures stories use the normal News freshness rule. Select Futures only from `futuresCandidates`. Selected article URLs and copy belong only in `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`.
- Prepare Handoff gives each candidate a `sourceLabel`: downloaded candidates use approved source-catalog display names, and still-fresh prior-card candidates preserve their validated published `sourceLabel`. Apply Handoff copies `sourceLabel`, `publishedOn`, and `publishedAt` from the selected candidate into the published card. The AI must not type, edit, or override `sourceLabel` in `editorialReview.newsSelection`.
- Reuters candidates downloaded through MSN syndication remain Reuters-sourced and use the reader-facing MSN article page. Treat MSN `publishedDateTime` as provider-verified publication time only after the Reuters provider identity, matching feed/detail timestamp, NewsML identity, and full article text validate; never substitute MSN `createdDateTime` or `updatedDateTime`.
- Futures selections must be major, current catalysts for the displayed futures session. Prefer stories that plausibly explain index-futures direction or broad cross-asset risk: macro data, rates, central banks, inflation, jobs, commodities, geopolitics, trade policy, credit/liquidity stress, global equity moves, or mega-cap earnings only when the article clearly ties the news to index-level market action.
- Do not use single-company product, partnership, analyst, executive, customer, or routine earnings-preview stories as Futures cards unless the article itself makes a clear index-futures or broad-market impact case. Put those stories in broad-market News instead.
- A selected URL must come from the generated candidate inventory.
- Do not set or edit coverage/New-pill fields.
- Resolve duplicate URLs/titles, wrong section category, missing-inventory URLs, and below-target counts during AI Editorial Work before Apply Handoff; Apply Handoff does not select replacement stories.
- Use only candidates with a valid publication date/time. Futures selections require a verified offset-bearing ISO `publishedAt`; Apply Handoff mirrors the Prepare Handoff Futures-window check defensively.

### Story selection policy

- Fresh enough to keep is not the same as worthy to keep. Review and rank the generated surplus candidate pool before choosing the final collection; select for relevance, explanatory value, freshness, source quality, and distinct angles rather than taking the first qualifying links found.
- Before selecting a Futures card, answer: why does this matter for index futures before the open or during the active session? If the answer is mainly "this is an interesting company story," it is not a Futures card.
- A prior card may enter the candidate pool only when it is still fresh, relevant, and source-faithful; it then competes directly with current candidates.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, Reuters, CNBC, Yahoo Finance, Axios, Kiplinger, Investing.com, Investopedia, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
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

Use generated Earnings guidance evidence first when it is available in `generated/editorial/earnings_week_guidance.json`. The evidence packet collects same-event SEC/EDGAR 8-K or 6-K exhibit documents for visible reported rows; EX-99.1 is primary, and EX-99.2 is supporting when present. The evidence packet is editorial context only. It does not supply deterministic EPS, sales, timing, market cap, or reaction facts. Use the deterministic Earnings facts for reported values and Yahoo Finance Chart API reaction data. Use reputable reporting when needed to explain market context or reaction. Evidence reviewed for one company does not verify commentary for another.

`verified` means that current evidence was reviewed for that specific company, transition, and narrative field. The presence of text alone does not make a field verified.

For Earnings, blank narrative fields marked `pending_review` are required AI assignments, not optional placeholders. Before Apply, scan every visible `earnings.week.rows[]` row. If a row has actual EPS or revenue, `outcome.interpretation` must be filled and marked `verified`, and guidance must be resolved as `verified`, `not_provided`, or still explicitly `pending_review` only when the evidence review could not be completed. If the verified close is available, `reaction.note` must also be filled and marked `verified`.

Earnings field contract after actuals arrive:

- `outcome.interpretation`: required once at least one verified actual is available. Explain the result takeaway using only verified EPS, revenue, guidance, operating, and management-commentary facts.
- `outcome.guide`: required as a guidance determination once at least one verified actual is available. Review the generated Earnings guidance evidence first when present, then use official company materials or reputable reporting when the generated evidence is missing or inconclusive. If forward guidance exists, write concise guide text and mark `guidanceDisposition.status = "verified"`. If reviewed evidence shows no guidance was provided, leave `outcome.guide` blank and mark `guidanceDisposition.status = "not_provided"`. If the guidance determination cannot be completed, leave or keep `guidanceDisposition.status = "pending_review"`; do not guess and do not mark `not_provided`.
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
- Do not start Earnings commentary with the company name, ticker, or a generic reference to the company; the row already supplies that context.
- For reported rows, explain the business takeaway rather than restating whether EPS or revenue beat, missed, or matched.
- Name at least one concrete business driver and explain why it matters to the earnings read.
- When guidance is provided, summarize only the company outlook and identify whether it is next-quarter or full-year guidance. If both are provided, lead with the quarterly outlook.
- For stock-reaction notes, explain the earnings driver behind the move rather than repeating the displayed percentage change.

### Week Ahead / Market Lens editorial contract

For each current event day, choose whether to keep generated commentary or replace it. Once an event has released, replace pre-release copy with current commentary.

Reconsider every event day against the current Opening, Tape, and verified news. Do not treat carried-over copy as automatically reviewed.

Before the close, the visible Market Lens remains forward-looking. At `close_available`, write verified `Outcome & Close Reaction` editorial copy interpreting the released facts and session response. Prepare Handoff marks Outcome only after released actuals and close-reaction rows are available. Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

Scheduled or awaiting days may retain generated Market Lens copy or use a valid replacement. Released days without actuals keep trying deterministic value recovery. Once released actuals are available, supply current Market Lens commentary if a valid current editorial lens is not already present. At `close_available`, supply verified Outcome copy only when Prepare Handoff marks it `pending_review`. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice.

## Validation and Publish

### Required daily checks

Publication validation is a final artifact safety check. It blocks malformed HTML, unparsable embedded JSON, missing required runtime blocks, render-surface shapes that would break dashboard initialization, and core published-file safety issues. It does not block publication solely for incomplete editorial work, partial sections, unavailable dispositions, omitted cards, blank fallback copy, or recoverable section-level data issues already resolved during Prepare or deferred to later handoffs.

- Before committing a content-only update, run only `node scripts/validate_dashboard.js readiness --skip-tests --allow daily_financial_news.html`. The `--allow` option hides expected dirty files from the warning list; readiness reports but does not block on other dirty files.
- For quick iteration or an ordinary non-publish check, run `node scripts/validate_dashboard.js daily_financial_news.html`.
- Let `./scripts/publish_main.sh` own the full readiness gate before it pushes; do not run the complete suite immediately before publishing.

### Expanded content and layout checks

Run the applicable checks after content, structural, layout, script, or contract changes:

- Avoid market-superlative claims unless directly verified during AI Editorial Work.
- Run `tidy -q -e daily_financial_news.html` and browser-check the production page after structural or layout changes. After changing Market Lens or Outcome copy, reactions, or routing, check narrow mobile and desktop widths for readability and overflow; activate pre-close and post-close reaction controls with pointer and keyboard; verify the correct Tape group, ticker, and chart open; verify focus moves to the chart heading; and verify repeated activation leaves that chart open.
- After changing an information tooltip, browser-check tap, hover, and keyboard activation at narrow mobile, tablet, and desktop widths. The tooltip must remain inside the viewport and each state must remain legible.
- Run `node scripts/validate_dashboard.js test` after script or data-contract changes when publication is not the immediate next step. It already runs `scripts/test_dashboard.js`, so keep those checks sequential rather than launching a parallel dashboard-test run. Run `node scripts/test_dashboard.js --local-refresh` only when changing local-refresh behavior.
- Nonvisual data, contract, validation, and refactoring changes require no browser pass. For visible changes, exercise only the affected interactions and applicable breakpoints, including every specific tooltip or Week Ahead check listed above when that surface changed.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm publication succeeds and `git status --short --branch` no longer shows local commits ahead of `origin/main`.

Normal daily updates stop here. The Reference Appendix is not AI Editorial Work guidance. During Prepare Handoff, AI Editorial Work, or Apply Handoff, use the appendix only when this runbook explicitly points to it, when debugging a failed run, or when changing code/data contracts.

## Reference Appendix

### Data Contracts

This section is the canonical human-readable contract for dashboard data. Data contracts describe canonical ownership and expected payload shape. Deterministic contracts are enforced during Prepare/source validation; Apply owns only editorial and publication-state normalization. The final publication gate enforces only artifact renderability and core published-file safety unless this appendix explicitly says a condition is publication-blocking. Keep validation, normalization, tests, and fetch-script output in sync with the relevant owner whenever a payload shape changes.

#### Published payload boundary

The embedded `dashboard-data` JSON block lives between the `DATA START` / `DATA END` comments in `daily_financial_news.html`. The embedded `chart-data` JSON block is a separate production payload. Generated files are staging only and must not become published runtime dependencies.

#### Week Ahead

- Owner: `scripts/week_ahead_contract.js` defines the deterministic slate, Market Lens channel rules, and Outcome contract.
- Boundary rules: Market Lens reactions must use canonical Tape tickers present in both `tape.rows[]` and `chart-data.series[]`; released events require current replacement commentary; `outcome` exists only at `close_available` and cannot change the preselected reaction ticker set.

#### Tape and chart data

- Owners: `scripts/fetch_chart_data.js` produces chart/futures data, and `scripts/validate_dashboard.js` provides artifact safety plus staged chart/Tape consistency checks.
- Boundary rules: `chart-data.series[]` is the canonical market-data store; visible Tape quote fields are derived from it; every displayed Tape ticker must have matching embedded source, chart series, and derived quote data.
- Each published compact chart bar contains exactly `[time, open, high, low, close]` or, when volume is included, `[time, open, high, low, close, volume]`. Additional values are not supported.
- Tape commentary binds to the accepted quote revision. Refreshed quotes need reviewed commentary; failed quote downloads retain their last validated quote and bound commentary.
- If neither refreshed nor prior canonical Chart/Tape data validates, Prepare emits an atomic unavailable bundle with empty `chart-data.series[]` and `tape.rows[]`; Apply copies that bundle unchanged.

#### Asset Allocation

- Owner: `scripts/fetch_asset_allocation.js` supplies two independently prepared inputs: instrument-level ETF rows and the sanitized portfolio summary. Prepare validates and resolves each independently, so failure of one does not discard valid data from the other.

#### Crypto

- Owner: `scripts/fetch_crypto_stats.js` supplies crypto stat cards; Crypto news cards follow the News-card contract.
- Boundary rules: `crypto.stats[]` is for section stat cards, CoinGecko-owned `crypto.dominance` contains BTC, ETH, and other market-cap percentages, `crypto.notes[]` is for crypto news, and ticker-level crypto quote rows and commentary live in `tape.rows[]`; `crypto.tape[]` is not supported.
- Refresh behavior: the three stat providers resolve independently. A failed provider carries only its validated prior card, or marks that card unavailable, while successful cards remain fresh and the section becomes partial. Because TOTAL and `crypto.dominance` share the CoinGecko response, they carry forward or become unavailable together.

#### Futures

- Owner: `scripts/fetch_chart_data.js` owns Futures payloads.
- Boundary rules: `futuresModule.futures[]` contains exactly four index-futures rows unless `availability.status` is explicitly `unavailable`; Futures story rules live in the News-card contract.

#### Prepare fallback contracts

Prepare validates fresh deterministic payloads. Where a domain permits prior-canonical carry-forward, Prepare validates that fallback before using it. If no permitted fallback validates, it emits the domain's explicit unavailable state and continues. Chart and Tape are resolved as one atomic bundle. Section-level source or contract failures do not block publication.

- `chart-data` and `tape.rows`: failed refreshes retain the complete validated quote/history/commentary bundle; if no valid bundle exists, both publish empty with `availability.status = "unavailable"`.
- `futuresModule`: individual source failures may produce a validated partial payload from the current preparation run. If no valid current-run payload exists, Futures becomes explicitly unavailable; prior canonical Futures values are not carried forward.
- `crypto.stats` and `crypto.dominance`, `assetAllocationPortfolio`, `weekAhead` facts, and `earnings.week` facts: invalid fresh data uses validated same-domain carry-forward where allowed, otherwise explicit unavailable state.

#### Apply editorial fallback contracts

These are Apply implementation contracts, not AI Editorial Work completion rules. Apply never revalidates or replaces Prepare-owned deterministic values.

- `opening`: incomplete or invalid editorial Opening fields are omitted from the published payload rather than replaced with generated copy.
- `news`: missing, invalid, duplicate, outside-inventory, or missing-provenance selected cards are omitted; Apply marks coverage partial where applicable and does not search for replacement stories or infer provenance.
- `tape`: refreshed quote rows without reviewed commentary publish a blank note with `commentary_unavailable`; failed quote-download rows retain their last validated quote-bound commentary bundle.
- `weekAhead`: invalid or unavailable released Market Lens commentary uses an unavailable disposition; missing verified close Outcome remains `pending_review` and publishes no Outcome copy.
- `earnings.week`: narrative fields still marked `pending_review` or carrying a valid unavailable status publish no copy for that field and preserve that disposition for the next handoff. Apply never replaces `pending_review` with prior commentary. For a malformed non-pending narrative/disposition pair, Apply may recover previously verified copy only when the relevant deterministic facts are unchanged; otherwise the field publishes no copy and the invalid state is normalized. Deterministic empty-row recovery occurs during Prepare.

### Deterministic Source Contracts

The automated routing below describes the sources used by the deterministic fetchers. Use the normal Prepare Handoff / Apply Handoff workflow; this reference is not an alternate daily workflow.

#### Automated price-source routing

- Tape and chart series, including U.S. indices and equities, international and sector ETFs, commodity futures, rates-volatility and bond proxies, index futures, and crypto majors: Yahoo Finance chart history through the configured `sourceSymbol`.
- Finnhub quote data: latest-bar repair only for eligible plain U.S. symbols when Yahoo exposes a newer close but does not provide usable OHLC for that date. Finnhub is not a second quote authority and is not used for futures, Treasury, or crypto symbols.
- Treasury yields and curve data: Treasury.gov Daily Treasury Yield Curve Rate Data.
- Total crypto market cap and BTC/ETH/other market-cap dominance: CoinGecko global market API.
- Altcoin Season Index: CoinMarketCap chart API; the stat-card `delta` comes from `historicalValues.yesterday`, and is `n/a` when that comparison is unavailable.
- Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2`.
- Asset Allocation Portfolio rows: Yahoo Finance instrument-level ETF market data only. The portfolio summary may use only the sanitized export from the separate Asset Allocation Dashboard; never import or recreate tactical allocation/model logic.

#### Manual research/cross-check references

Use these sources only to diagnose a deterministic refresh failure or cross-check a suspicious value. They are not automated fallback inputs and do not authorize editing generated market data, the editorial handoff's deterministic fields, or `daily_financial_news.html`.

- Major U.S. index closes: AP, CNBC, Reuters, MarketWatch, or TradingView when available.
- International equity ETFs such as VEA and VWO, and sector or commodity ETFs: reputable quote pages with a clearly identified instrument and trade date; MarketWatch is acceptable.
- Treasury yields: Trading Economics or CNBC against the Treasury.gov date and maturity.
- Rates-volatility and bond proxies: verify the configured dashboard instrument and keep proxy labels explicit.
- WTI: CME/NYMEX where available; MarketWatch, Trading Economics, or Reuters.
- Gold and silver: GoldPrice.org spot data or MarketWatch futures data; distinguish spot from futures when comparing values.
- Crypto majors: CoinGecko or CoinMarketCap.
- Total crypto market cap: CoinMarketCap global charts or CoinGlance against CoinGecko.
- Altcoin Season Index: the CoinMarketCap public index page may cross-check the current reading, but only the chart API supplies the canonical yesterday comparison.
- Crypto Fear & Greed: the Alternative.me page may cross-check the API reading.

If research identifies a source defect or a value that requires replacement, stop until the relevant data contract identifies a supported staging input. Never reuse the prior embedded price as a substitute, patch only `tape.rows`, or edit the published dashboard directly.

### Earnings Deterministic Method

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`.

#### Source hierarchy

1. Zacks primary: calendar slate, timing, market cap, EPS estimate, EPS actual, sales estimate, sales actual, surprise, and related row facts.
2. Legacy backup path: Finnhub -> Alpha Vantage -> EarningsAPI runs only when the Zacks path is unavailable or schema-invalid.
3. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

The build does not blend Zacks rows with legacy-provider rows. A valid Zacks build uses Zacks only.

#### Zacks availability and schema gate

- The Zacks path must pass an availability and schema gate before its data is accepted.
- The gate checks HTTP success, parseable response data, expected EPS and sales table fields, active-week dates, row identity alignment, non-empty eligible slate after the $25B market-cap filter, and sane numeric parsing.
- After a valid Zacks build, Prepare attempts a narrow Finnhub U.S. symbol-directory classification pass. Exact U.S. exchange-listed securities, including ADRs, remain eligible; OTC/Pink listings and symbols without an exact directory match are excluded from visible rows. If the live directory and cache are both unavailable, Prepare proceeds with the original Zacks market-cap-filtered rows and records the unavailable classification in staging diagnostics.
- If the Zacks gate fails, the build uses the legacy Finnhub -> Alpha Vantage -> EarningsAPI backup path.
- Backup use is recorded in staging diagnostics with the Zacks failure reason.
- If Zacks is valid but an individual row is missing actual EPS or sales, that field remains pending.

#### Published row and narrative state

Published Earnings rows are selected and normalized by the Earnings contract owner during Prepare. Apply merges narrative fields only; final publication blocks only Earnings states that would make the dashboard fail to render. Display rows keep compact schedule, result, guidance, and reaction status fields; detailed source audit, Zacks schema-gate results, selected provider mode, and backup diagnostics are staging/debug state and must not be treated as reader-facing content.

For `TIME UNKNOWN` rows, `reportTiming` remains `unknown`. When actual EPS or sales first appears, the row stores `actualsObservedAt`. If that timestamp falls on or before `reportDate`, Yahoo reaction uses the same-day close basis; if it falls after `reportDate`, Yahoo reaction uses the next-session close basis.

Prepare Handoff treats repeated verified Earnings narrative as stale editorial state: same-field reuse across visible rows representing different underlying companies is reopened as `pending_review` for that field on the next handoff. Same-issuer rows, such as multiple share classes tied to one earnings report, may retain identical verified narrative only when they represent the same underlying company and earnings event; this does not allow reused or generic narrative across different issuers or relax the current-evidence requirement. This is a handoff self-healing check, not an Apply-time rejection gate.

#### EarningsAPI budget policy

- EarningsAPI is quota-limited and is used only inside the legacy backup path after the Zacks gate fails.
- A successful Zacks build spends no EarningsAPI budget.
- Do not call EarningsAPI reactions; Yahoo remains the reaction source.

### Focused Repair Commands

Use focused repair commands only for explicit repairs. They update the current staged candidate, not the canonical dashboard. After a focused repair, regenerate the editorial handoff from that repaired candidate, then run `apply`; rerun `prepare` only when intentionally replacing the candidate.

- Market Lens-only correction: no standalone command. Use the current complete candidate when it still matches the canonical dashboard edition, regenerate the editorial handoff, and make the decision there. If no current candidate exists, rerun deterministic preparation first.
- Chart-only correction: start with a current complete candidate, then use `node scripts/run_daily_update.js --apply-chart-data-json PATH`, `node scripts/run_daily_update.js --merge-chart-data-json PATH`, or `node scripts/run_daily_update.js --sync-chart-quotes`. Regenerate the editorial handoff afterward; successful quote changes require reviewed commentary.
- Asset Allocation fallback: refresh `http://127.0.0.1:2200/api/asset-market-data`, then use `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`. If refresh fails but the export exists, use it as a stale fallback; never import tactical allocation/model logic.
- Earnings-only repair: rebuild the staged Earnings week from the current provider contract, then run `node scripts/earnings_week.js apply-narrative`, run `node scripts/run_daily_update.js --apply-earnings-week-json generated/earnings_week.json`, regenerate the editorial handoff from the repaired candidate, and run `apply`. Normal repair uses Zacks. Repair uses the legacy backup path only when the Zacks gate fails, and the staged diagnostics must preserve the reason Zacks was bypassed.
- Manual calendar rollover: use `node scripts/run_daily_update.js prepare --afternoon --rollover-calendar` for the Friday-through-Thursday bridge, or `node scripts/run_daily_update.js prepare --morning --rollover-calendar` for Monday-through-Friday. On Saturday, either edition rolls to the Friday bridge; on Sunday, either edition rolls to Monday-Friday.

### Local Refresh Server

Run `node scripts/local_market_server.js` to start the optional read-only local market overlay at `https://192.168.2.2:2210`. It exposes:

- `GET /health`
- `GET /api/market-refresh`

Local refresh may overlay fresher browser data, but it never writes that overlay back to the canonical artifact and must never display refreshed quote values beside prior commentary. See `launchd/README.md` for provisioning, TLS, origin policy, and renewal.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.

### Browser Support

The supported baseline is Chromium 120+ (Chrome and Edge), Firefox 121+, and Safari 17.4+ on macOS and iOS. Older browsers, browser-version branches, and polyfills are out of scope unless a concrete supported-browser behavior requires them.
