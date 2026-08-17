# AI Editorial Instructions

Use only the sections of this file routed by `AGENTS.md` during AI Editorial Work. It is the canonical handoff-editing contract for `generated/editorial/dashboard-data.json`: review, write, and select only the editorial fields described here. Do not edit source code, dashboard HTML, generated market data, calendar facts, earnings facts, or deterministic section values as part of AI Editorial Work.

## AI Editorial Work contracts

Blank fields or statuses marked `pending_review` are active AI assignments unless the section contract explicitly says they are system-provided carry-forward state.

## Section contracts

### Masthead contract

For `masthead`, leave the generated edition and date unchanged.

### Opening contract

For `opening`, write the current edition's `headline`, `deck`, and exactly 4 catalyst cards. Each catalyst must have a short `label` and a current, evidence-supported `body` summarizing one of the update's main market drivers.

### News inventory contract

Use `editorialReview.newsSearch` as read-only source material; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable. Prepare emits the complete eligible deduplicated inventory without a per-pool editorial ceiling. General and Futures may contain the same URL because Futures is a timestamp-eligibility view of General coverage; Crypto remains exclusive under the pool-classification contract.

AI Editorial Work is one phase with two ordered News-review passes:

1. **Metadata triage:** Examine the URL-deduplicated union of `generalCandidates`, `futuresCandidates`, and `cryptoCandidates` in manageable batches. Preserve each candidate's pool memberships while examining a URL only once. For every candidate, inspect title and apparent subject, `sourceLabel`, publication date and exact timestamp, reader-facing URL, and prior-card status when present. Maintain a provisional contender set while identifying plausible General, Futures, and Crypto coverage, duplicate or substantially overlapping angles, and clearly noncompetitive items. This is a complete-inventory scan, not a newest-first stopping rule. It includes Futures-only candidates and every still-fresh prior card. Do not edit `newsSearch`, finalize the contender set, write card copy, or begin another editorial section until this pass is complete.
2. **Deep review and selection:** Deeply review every plausible contender plus enough close alternatives to compare relevance, explanatory value, freshness, source quality, source fidelity, and angle diversity. Use `candidate.article.excerpt` when present and the reader-facing article page when the available context is insufficient for a selection or its copy. A missing excerpt is not a rejection reason. There is no fixed deep-review ceiling: expand the contender set whenever a target cannot be filled with strong distinct coverage or the evidence is inconclusive. Rank the reviewed contenders, then write `editorialReview.newsSelection`; no candidate may be selected on metadata triage alone.

### News-card contract

Every news card is a dated, reader-facing article. Do not use `referencePage`; durable calendars and schedules belong in `weekAhead`.

| Selection bucket | Target | AI supplies |
| --- | --- | --- |
| `editorialReview.newsSelection.stories` | Target 9 primary broad-market cards, plus up to 9 optional secondary cards (18 maximum) | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.crypto` | Target 6 primary crypto-specific cards, plus up to 6 optional secondary cards (12 maximum) | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.futures` | Target 3 current catalysts from `editorialReview.newsSearch.futuresCandidates` | candidate `url`, `tag`, `title`, `body` |

- `editorialReview.newsSearch` is read-only source material. Prepare Handoff filters displayed-session Futures stories into `futuresCandidates`: Pre-Market Futures use the overnight futures window from 5:00 PM CT on the prior Chicago calendar day through the prepared run time or 8:30 AM CT, whichever is earlier; Session Futures use the shared `raw.sessionDate` regular-session window. When no shared Futures story window can be proven, Futures stories use the normal News freshness rule. Select Futures only from `futuresCandidates`. Selected article URLs and copy belong only in `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`.
- Prepare Handoff gives each candidate a `sourceLabel`: downloaded candidates use approved source-catalog display names, and still-fresh prior-card candidates preserve their validated published `sourceLabel`. Apply Handoff copies `sourceLabel`, `publishedOn`, and any valid candidate `publishedAt` into the published card; malformed optional precision is omitted, and Yahoo general-News time remains provisional under the rule below. The AI must not type, edit, or override `sourceLabel` in `editorialReview.newsSelection`.
- Treat `candidate.article.excerpt`, when present, as bounded article-body context for selection and card-copy decisions; otherwise use the candidate summary, title, description, source metadata, and reader-facing URL. Do not silently skip a candidate just because article-page context is missing.
- Prepare assigns each candidate exclusively to General or Crypto. Explicit Crypto feeds remain Crypto, while high-confidence crypto titles from General feeds promote the candidate to `cryptoCandidates`; source identity and timestamp provenance remain unchanged. Make selections only from the emitted pool rather than reclassifying candidates during AI Editorial Work.
- Reuters candidates come directly from Reuters' public News sitemap and therefore carry a Reuters URL plus the sitemap's verified publication time. Yahoo-hosted candidates remain Yahoo Finance candidates even when their page metadata names a syndicated publisher; their hosted timestamp is provisional general-News syndication time and never qualifies for an exact Futures timestamp window. Prepare does not relabel or promote hosted articles to another source.
- Futures selections must be major, current catalysts for the displayed futures session. Prefer stories that plausibly explain index-futures direction or broad cross-asset risk: macro data, rates, central banks, inflation, jobs, commodities, geopolitics, trade policy, credit/liquidity stress, global equity moves, or mega-cap earnings only when the article clearly ties the news to index-level market action.
- Do not use single-company product, partnership, analyst, executive, customer, or routine earnings-preview stories as Futures cards unless the article itself makes a clear index-futures or broad-market impact case. Put those stories in broad-market News instead.
- A selected URL must come from the generated candidate inventory.
- Selection order is display priority. The first 9 General and first 6 Crypto cards are visible initially; later accepted cards are secondary coverage behind the section's `More stories` disclosure. Secondary cards must pass the same deep-review, relevance, source-quality, source-fidelity, freshness, and diversity standards as primary cards. They are optional and must not be filled with weaker coverage merely to reach the maximum.
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

### Futures contract

For `futuresModule`, leave generated futures rows and session labels unchanged; select Futures cards through `editorialReview.newsSelection.futures` under the News-card contract.

### Tape contract

For `tape`, leave generated quote fields unchanged; update the editorial roster only when intentionally changing coverage, and rewrite each refreshed Tape note. Each note must summarize the relevant market commentary or catalyst without carrying prior commentary forward or restating quote values. Before Apply Handoff, compare every refreshed Tape note against that row's generated direction, delta, and percent; rewrite any note that contradicts the displayed move. Every Crypto-group ticker needs its own current note for the collapsed Tape Crypto tab; do not reuse generic copy across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible Crypto tickers. Failed quote downloads retain their last validated quote and bound commentary.

### Asset Allocation contract

For `assetAllocationPortfolio`, review the generated ETF rows and sanitized portfolio summary. Leave deterministic values unchanged, including any carried-forward or unavailable state resolved during Prepare.

### Stories contract

For `stories`, select the broad-market news collection through `editorialReview.newsSelection.stories` under the News-card contract.

### Crypto contract

For `crypto`, leave generated `crypto.stats[]` and `crypto.dominance` values unchanged, and select only the crypto news collection through `editorialReview.newsSelection.crypto` under the News-card contract. Crypto ticker quote rows are generated in `tape.rows[]` with `group: "Crypto"`; their ticker-level commentary remains editorial under the Tape contract.

### Earnings editorial contract

For `earnings.week`, leave the generated five-trading-day slate, facts, and reactions unchanged. Complete every visible Earnings row under this contract.

Treat every visible Earnings row as an independent editorial assignment. Research and write each row separately using current, company-specific evidence. Do not consult, reuse, or paraphrase prior dashboard commentary when completing a new assignment.

Earnings has two narrative states:

- **Before actuals:** Explain the company-specific business question, operating metric, or management outlook most likely to determine the earnings read. Base this on the company’s latest results and guidance, current expectations, and known company-specific developments.
- **After at least one verified actual:** Replace the pre-release commentary with the principal business takeaway from the verified reported facts. If EPS or revenue is still missing, discuss only the verified facts and do not imply the missing metric was reviewed. Complete each required field under the Earnings field contract after actuals arrive.

Editorial work is required at these transitions:

1. **Calendar rollover:** Write fresh pre-release commentary for every visible row in the new slate, including companies retained from the preceding calendar. Prior copy cannot be carried forward as completed work.
2. **Results arrival:** Once at least one verified actual is available, remove the pre-release commentary, write the post-release interpretation, and complete the guidance determination.
3. **Verified close arrival:** Add company-specific reaction commentary explaining what the market response indicates. Update the result interpretation as well if the reaction materially changes the earnings read.

A transition from `scheduled` to `awaiting_actual` does not create a new narrative state because no results have arrived. Continue to show the current pre-release thesis and do not invent results. Any correction to the report date, timing, estimates, actuals, guidance, or closing reaction invalidates the commentary affected by that correction.

Use generated Earnings guidance evidence first when it is available in `generated/editorial/earnings_week_guidance.json`. The evidence packet collects same-event SEC/EDGAR 8-K or 6-K exhibit documents for visible reported rows; EX-99.1 is primary, and EX-99.2 is supporting when present. The evidence packet is editorial context only. It does not supply deterministic EPS, sales, timing, market cap, or reaction facts. Use the deterministic Earnings facts for reported values and Yahoo Finance Chart API reaction data. Use reputable reporting when needed to explain market context or reaction. Evidence reviewed for one company does not verify commentary for another.

`verified` means that current evidence was reviewed for that specific company, transition, and narrative field. The presence of text alone does not make a field verified.

For Earnings, blank narrative fields marked `pending_review` are required AI assignments, not optional placeholders. Before Apply, scan every visible `earnings.week.rows[]` row and audit `outcome.interpretationDisposition`, `outcome.guidanceDisposition`, and `reaction.commentaryDisposition` separately. If a row has actual EPS or revenue, `outcome.interpretation` must be filled and marked `verified`, and guidance must be resolved as `verified` or `not_provided`. If the verified close reaction is computed, `reaction.note` must be filled and marked `verified`. If any currently actionable Earnings field remains `pending_review`, do not Apply; report the affected ticker and field.

#### Earnings field contract after actuals arrive

- `outcome.interpretation`: required once at least one verified actual is available. Explain the result takeaway using only verified EPS, revenue, guidance, operating, and management-commentary facts.
- `outcome.guide`: required as a guidance determination once at least one verified actual is available. Review the generated Earnings guidance evidence first when present, then use official company materials or reputable reporting when the generated evidence is missing or inconclusive. If forward guidance exists, write concise guide text and mark `guidanceDisposition.status = "verified"`. If reviewed evidence shows no guidance was provided, leave `outcome.guide` blank and mark `guidanceDisposition.status = "not_provided"`. If the guidance determination cannot be completed, leave or keep `guidanceDisposition.status = "pending_review"`, do not guess, do not mark `not_provided`, and stop before Apply with the affected ticker and field.
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

For `weekAhead`, do not hand-edit deterministic dates, times, event names, impact levels, actual/forecast/previous values, release states, surprises, close reactions, Market Lens event IDs, or Market Lens reaction tickers. Complete Market Lens `copy` and Outcome fields under this contract.

Every `weekAhead.days[].marketLens` with `status: "pending_review"` is an active assignment. Write populated `copy.question`, `copy.title`, and `copy.body`, then set the Market Lens `status` to `verified`. Do not edit `eventIds` or `reactions`. A Market Lens already marked `verified` may remain only when it still describes the same deterministic event context and remains supported by the current evidence. Once every event selected by `eventIds` has completed, replace all pre-release Market Lens copy with current commentary.

Reconsider every event day against the released facts, deterministic market-reaction data, current Opening and Tape, and the full `editorialReview.newsSearch` inventory, not just News cards selected for promotion. Prefer event-specific coverage when available, then related market context such as rates, the dollar, equity indexes, sectors, commodities, or credit. Do not treat carried-over copy as automatically reviewed.

Before the close, the visible Market Lens remains forward-looking. At `close_available`, write verified `Outcome & Close Reaction` editorial copy interpreting the completed event context and session response. Prepare Handoff marks Outcome only after close-reaction rows are available and every event selected by `eventIds` has either supplied its statistical actual or completed as a non-statistical event, such as a policy communication. Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

Statistical releases selected by `eventIds` continue deterministic value recovery until their actuals are available; selected non-statistical events complete when their scheduled time passes. Once the complete selected context is available, complete the prepared Market Lens assignment with current commentary. Do not leave an actionable `pending_review` assignment unresolved or use an unavailable disposition as completed AI Editorial Work. At `close_available`, supply verified Outcome copy only when Prepare Handoff marks it `pending_review`. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice.

### Footer contract

For `footer`, leave the generated footer unchanged.

## AI Editorial Work checklist

1. Verify the handoff and deterministic envelope before editorial work.
   - Use the current handoff only; regenerate it if it becomes stale.
   - Leave generated masthead date/edition, compile prefix, Futures labels, and Tape session label unchanged.
   - The AI owns only the key-driver portion of `tape.label` after the separator.
   - The run date is always the current Chicago date, including prior-evening holiday context; explain a next-day closure in `weekAhead` or stories rather than forward-dating the envelope.
   - Friday afternoon shows current Friday plus next Monday-Thursday. Monday morning shows current Monday-Friday. Ordinary manual runs refresh the active Week Ahead and Earnings ranges; manual calendar rollover requires `--rollover-calendar` and uses the local weekend day when run on Saturday or Sunday.

2. Confirm the normal deterministic refresh ran before reading news.
   - Use the matching canonical two-command workflow entry.
   - If generated market data, calendar facts, earnings facts, or deterministic section values look stale or wrong, stop AI Editorial Work and read only the relevant data-contract, deterministic-source, or focused-repair subsection in `docs/reference.md`.
   - Do not name quote/news sources in narrative copy. News cards may show the deterministic card-level `sourceLabel`; use chart source details for row-specific provenance.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Review downloaded News after prices and before making any editorial decisions.
   - Use `editorialReview.newsSearch` as read-only source material; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable.
   - The AI owns relevance review, source-quality assessment, angle diversity, final selection, and reader-facing copy. The only News field the AI edits is `editorialReview.newsSelection`.
   - Complete the News inventory contract's metadata-triage pass over the URL-deduplicated union of General, Futures, and Crypto before editing Opening, Futures stories, Tape commentary, Moving Today, Crypto notes, Earnings narrative, Week Ahead commentary, or Market Lens. Include Futures-only candidates and every still-fresh prior card; do not stop after finding enough stories to fill a section.
   - Preserve pool membership during triage. A URL shared by General and Futures is examined once but remains eligible for both; a Futures-only URL must receive the same triage as every other candidate. Treat `futuresCandidates` as timestamp eligible until deep editorial review establishes that the story is a meaningful index-futures catalyst.
   - After triage is complete, deeply review the plausible contenders and close alternatives under the News inventory contract. Inspect available summaries, descriptions, `candidate.article.excerpt`, and, when needed, the reader-facing page before ranking or writing. Do not silently skip a candidate because article-page context is missing, and do not select a candidate using metadata alone.
   - Working triage notes and a provisional contender set are allowed, but they do not edit the handoff or establish a fixed shortlist ceiling. Expand deep review whenever coverage is weak, duplicative, below target, or uncertain.
   - Compare all candidates in the generated News inventory with every still-fresh prior card. Retain a prior card only when it remains among the strongest relevant, source-faithful coverage; do not discard or churn it merely because the scheduled window changed.
   - Treat every candidate in the generated News inventory as eligible for metadata triage. Rank only deeply reviewed contenders. Fill the primary News-card targets first, then add optional secondary cards only while the remaining coverage stays strong and distinct; do not invent filler to reach either maximum.
   - For selected News cards, add one entry to `editorialReview.newsSelection.futures`, `.stories`, or `.crypto` with the candidate `url` plus only `tag`, `title`, and `body`; do not hand-build final card arrays.
   - Follow the News-card contract and Story selection policy for required fields, source choice, carry-forward decisions, and link rules.

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
   - `masthead`: follow the Masthead contract.
   - `opening`: follow the Opening contract.
   - `futuresModule`: follow the Futures contract.
   - `tape`: follow the Tape contract.
   - `assetAllocationPortfolio`: follow the Asset Allocation contract.
   - `stories`: follow the Stories contract.
   - `crypto`: follow the Crypto contract.
   - `earnings.week`: follow the Earnings editorial contract.
   - `weekAhead`: follow the Week Ahead / Market Lens editorial contract.
   - `footer`: follow the Footer contract.

### Final Pre-Apply Editorial Gate

Run this gate before Apply.

- No field marked `pending_review` may be treated as completed editorial work. Before Apply, every `pending_review` field must be either completed, fixed, or identified by the section contract as not currently actionable because the required deterministic state is not yet available. For Earnings or Week Ahead fields, verify actionability against the Earnings editorial contract or Week Ahead / Market Lens editorial contract, respectively. Otherwise stop before Apply and report the affected section, item, and field.
- Use `editorialReview.earningsChecklist` as the read-only Earnings assignment index for the final audit. Do not edit the checklist; update the underlying `earnings.week.rows[]` narrative fields and dispositions.
- For Earnings, reported rows with actual EPS or revenue are currently actionable for `outcome.interpretationDisposition` and `outcome.guidanceDisposition`; rows with computed close reactions are currently actionable for `reaction.commentaryDisposition`. Resolve each currently actionable field before Apply.
- Audit every refreshed Tape note for ticker-specific, current commentary. Rewrite notes that are generic, formulaic, interchangeable across tickers, merely restate quote movement, or use repeated framing. Each refreshed note must name or clearly imply the relevant catalyst or market driver for that row.
- Audit every Crypto-group Tape note separately. Each visible Crypto ticker needs its own crypto-specific driver, such as bitcoin leadership, ETH/SOL relative strength, ETF demand, regulation, market structure, protocol updates, exchange/issuer developments, sentiment, or listed-proxy beta. Do not reuse generic crypto copy.
- Compare every refreshed Tape note against that row's generated direction, delta, and percent. Rewrite any note that contradicts or ignores the displayed move before Apply.
- Every `editorialReview.newsSelection.futures[].url` must appear in `editorialReview.newsSearch.futuresCandidates`.
- Every `editorialReview.newsSelection.stories[].url` must appear in `editorialReview.newsSearch.generalCandidates`.
- Every `editorialReview.newsSelection.crypto[].url` must appear in `editorialReview.newsSearch.cryptoCandidates`.
- No selected URL may appear twice within a section or across Futures, Stories, and Crypto.
- Read the Futures eligibility bullets in the News-card contract and verify every Futures selection against them.
- If a selected URL fails any check, fix `editorialReview.newsSelection` before Apply Handoff. Do not rely on Apply Handoff to omit or replace it.
- Inspect intended editorial fallbacks before Apply. Any avoidable editorial fallback, duplicate omission, blank reviewed field, or below-target section caused by AI selection or copy quality must be fixed or repaired in the handoff before Apply.
- Under the Earnings editorial contract and Week Ahead / Market Lens editorial contract, confirm required commentary is current, company- or event-specific, and not carried forward as completed work.
- If the section remains below target after all eligible reviewed candidates are exhausted, leave it below target rather than inventing filler.
- Run Apply only after the AI can state: `The handoff passed the Final Pre-Apply Editorial Gate.` Any gate failure means continue repairing `generated/editorial/dashboard-data.json` until it passes, then send it to Apply.
