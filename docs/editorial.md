# AI Editorial Instructions

Use only the sections of this file routed by `AGENTS.md` during AI Editorial Work. It is the canonical contract for editing `generated/editorial/dashboard-data.json` and maintaining review continuity. In the handoff, review, write, and select only the editorial fields described here; maintain review notes under the News inventory contract. Do not edit source code, dashboard HTML, generated market data, calendar facts, earnings facts, or deterministic section values as part of AI Editorial Work.

## AI Editorial Work contracts

Editorial fields required by their section contract are active assignments, including fields marked `pending_review`. A blank field requires completion only when currently actionable under that contract. Intentionally blank fields, such as guidance reviewed and marked `not_provided`, and fields awaiting required deterministic evidence are not incomplete merely because they are blank. System-owned fields remain outside AI editing authority.

## Section contracts

### Masthead contract

For `masthead`, leave the generated edition and date unchanged.

### Opening contract

For `opening`, write the current edition's `headline`, `deck`, and exactly 4 catalyst cards. Each catalyst must have a short `label` and a current, evidence-supported `body` summarizing one of the update's main market drivers.

### News inventory contract

Use `generated/news_candidates.json` as the sole read-only News inventory for AI review and Apply. Confirm its `generatedAt` matches `editorialReview.preparedAt` before review; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable in that file. The editable handoff contains News selections, not a copy of the inventory. Prepare emits the complete eligible deduplicated inventory without a per-pool editorial ceiling. General and Futures may contain the same URL because Futures applies the News-card contract's session-time or fallback freshness rules to General coverage; Crypto remains exclusive under the pool-classification contract. Eligibility for `futuresCandidates` does not establish that an article is a meaningful index-futures catalyst; that judgment belongs to deep editorial review.

Use ordinary read-only inspection commands to view compact metadata in batches sized to keep the output fully visible; there is no fixed batch size or prescribed query. Keep a stable URL-deduplicated ordering throughout the scan and preserve pool memberships. If output is truncated, retrieve and inspect the missing range before recording it as reviewed. Source or keyword filters may help compare contenders, but must not replace the complete metadata scan below.

AI Editorial Work is one phase with two ordered News-review passes:

1. **Metadata triage:** Examine the URL-deduplicated union of `generalCandidates`, `futuresCandidates`, and `cryptoCandidates` in manageable batches. Preserve each candidate's pool memberships while examining a URL only once. For every candidate, inspect title and apparent subject, `sourceLabel`, publication date and exact timestamp, reader-facing URL, and prior-card status when present. Maintain a provisional contender set while identifying plausible General, Futures, and Crypto coverage, duplicate or substantially overlapping angles, and clearly noncompetitive items. Aim to finish this first pass with 90 unique General/Futures contenders and 60 unique Crypto contenders. For the General/Futures provisional contender set, retain the five strongest qualifying unique candidates from each represented `sourceLabel` before filling the remaining places toward the 90-candidate target with the strongest remaining contenders overall. If a General/Futures source has fewer than five qualifying candidates, retain all that qualify and return its unused places to the overall pool. For the Crypto provisional contender set, retain the three strongest qualifying unique candidates from each represented `sourceLabel` before filling the remaining places toward the 60-candidate target with the strongest remaining contenders overall. If a Crypto source has fewer than three qualifying candidates, retain all that qualify and return its unused places to the overall pool. These per-source floors guarantee deep review only; they do not create final-selection or publication quotas. A URL belonging to both General and Futures counts once toward the General/Futures target. If an eligible pool contains fewer candidates than its target, carry that entire pool into deep review. These are reduction targets rather than hard ceilings: retain additional close alternatives when ties, uncertainty, source diversity, angle diversity, or coverage quality make a larger set useful. This is a complete-inventory scan, not a newest-first stopping rule. It includes Futures-only candidates and every still-fresh prior card. Do not alter the candidate file, finalize the contender set, write card copy, or begin another editorial section until this pass is complete.
2. **Deep review and selection:** Read retained contenders' full records together in manageable groups and deeply review every contender for relevance, explanatory value, freshness, source quality, source fidelity, and angle diversity. Use `candidate.article.excerpt` as bounded article-body context when present; otherwise use the candidate summary, title, description, and source metadata. A missing excerpt is not a rejection reason. Browse the reader-facing article page or another permitted source when the available evidence is insufficient to resolve a specific question about selection or copy. Reuse recorded findings; repeat research only when evidence changes or a specific question remains unresolved. There is no fixed deep-review ceiling: expand the contender set whenever a target cannot be filled with strong distinct coverage or the evidence is inconclusive. Rank the reviewed contenders, then write `editorialReview.newsSelection`; no candidate may be selected on metadata triage alone.

Maintain `generated/editorial/review-progress.md` as the single plain-text review checkpoint. Initialize it for the matching inventory `generatedAt` and handoff `editorialReview.preparedAt`, and record:

- The inventory timestamp, stable ordering used for the scan, completed metadata-review ranges with boundary URLs, and next unread position.
- Retained contender URLs and pool memberships, distinguishing pending from completed deep review.
- Brief evidence notes and decisions, unresolved questions, and the next action; include progress on other editorial sections as work proceeds.

Update the checkpoint after each completed metadata batch and meaningful deep-review group, and when another editorial section is completed. Record only work actually completed. Keep it concise; do not copy the full inventory or article bodies, create a secondary inventory or progress file, or treat checkpoint notes as a substitute for handoff selections or required evidence.

After context compaction or interruption, read the checkpoint and current handoff, confirm that the checkpoint timestamp matches the current inventory and handoff, and resume the next unfinished step. If the inventory and handoff timestamps disagree, stop review until a matching pair is available. Compaction alone does not require restarting Prepare or repeating completed review. Revisit completed work only when evidence changes or a specific gap remains. Replace the checkpoint for a new inventory; never reuse stale completion marks. If progress is missing or inconsistent, recover what is supported by saved outputs and the handoff, then review only the work whose completion cannot be established.

### News-card contract

Every news card is a dated, reader-facing article. Do not use `referencePage`; durable calendars and schedules belong in `weekAhead`.

| Selection bucket | Target | AI supplies |
| --- | --- | --- |
| `editorialReview.newsSelection.stories` | Target 18 broad-market cards: 9 primary cards plus 9 secondary cards | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.crypto` | Target 15 crypto-specific cards: 9 primary cards plus 6 secondary cards | candidate `url`, `tag`, `title`, `body` |
| `editorialReview.newsSelection.futures` | Target 3 current catalysts from `generated/news_candidates.json` `futuresCandidates` | candidate `url`, `tag`, `title`, `body` |

- Prepare Handoff determines the article publication window from the displayed Futures session context, then filters stories into `futuresCandidates`. This article window is distinct from the Futures instruments' trading hours: Pre-Market Futures articles must be published from 5:00 PM CT on the prior Chicago calendar day through the prepared run time or 8:30 AM CT, whichever is earlier; Session Futures articles must be published from 8:30 AM to 3:00 PM CT on the shared `raw.sessionDate`. If the updater cannot determine the applicable Futures session time range and therefore cannot establish its article publication window, Futures stories use the normal News freshness rule. Normal News freshness accepts articles dated on the current Chicago calendar date or the immediately preceding calendar date; during the Monday 7:45 AM through 9:00 AM Chicago-time window, Saturday is also eligible. A missing, unverified, malformed, or out-of-window article timestamp never triggers this fallback when the article window is known. Select Futures only from `futuresCandidates`. Selected article URLs and copy belong only in `editorialReview.newsSelection.futures`, `.stories`, and `.crypto`; do not hand-build final card arrays.
- Prepare Handoff gives each candidate a `sourceLabel`: ordinary downloaded candidates and Marketaux candidates matching the approved source catalog use its display name, unapproved Marketaux single-ticker candidates use their normalized publisher hostname, and still-fresh prior-card candidates preserve their validated published `sourceLabel`. Apply Handoff copies `sourceLabel`, `publishedOn`, any valid candidate `publishedAt`, and the generated single-ticker marker into the published card; malformed optional precision is omitted, and Yahoo general-News time remains provisional under the rule below. The AI must not type, edit, or override provenance fields in `editorialReview.newsSelection`.
- Prepare assigns each candidate exclusively to General or Crypto. Explicit Crypto feeds remain Crypto, while high-confidence crypto titles from General feeds promote the candidate to `cryptoCandidates`; source identity and timestamp provenance remain unchanged. Make selections only from the emitted pool rather than reclassifying candidates during AI Editorial Work.
- Reuters candidates come directly from Reuters' public News sitemap. Their URL date controls General-News freshness; the sitemap time is verified only when its Chicago date agrees with that URL date, while a conflicting timestamp is omitted unless article-page metadata subsequently verifies the publication time. Yahoo-hosted candidates remain Yahoo Finance candidates even when their page metadata names a syndicated publisher; their hosted timestamp is provisional general-News syndication time and never qualifies for an exact Futures timestamp window. Prepare does not relabel or promote hosted articles to another source.
- Futures selections must be major, current catalysts for the displayed futures session. Prefer stories that plausibly explain index-futures direction or broad cross-asset risk: macro data, rates, central banks, inflation, jobs, commodities, geopolitics, trade policy, credit/liquidity stress, global equity moves, or mega-cap earnings only when the article clearly ties the news to index-level market action.
- Do not use single-company product, partnership, analyst, executive, customer, or routine earnings-preview stories as Futures cards unless the article itself makes a clear index-futures or broad-market impact case. Put those stories in broad-market News instead.
- A selected URL must come from the generated candidate inventory.
- Selection order is display priority. The first 9 General and first 9 Crypto cards are visible initially; later accepted cards are secondary coverage behind the section's `More stories` disclosure. For Crypto, fill the first three positions with the strongest qualifying candidates carrying generated `tickerSearchSymbols` for IBIT, ETHA, or MSTR whenever possible, preferring one qualifying story per ticker before repeating a ticker. If fewer than three such candidates pass normal deep review, fill the remaining primary positions with the strongest ordinary Crypto candidates. This priority is not a quota and never lowers relevance, source-quality, source-fidelity, freshness, or diversity standards. The editorial targets are 18 General and 15 Crypto, so reaching the initially visible counts is not a stopping point. Continue deep review and selection until both targets are filled or every eligible candidate in the affected pool has been exhausted. Secondary cards must pass the same standards as primary cards; do not invent filler merely to reach a target.
- Do not set or edit coverage/New-pill fields.
- Resolve duplicate URLs/titles, wrong section category, missing-inventory URLs, and below-target counts during AI Editorial Work before Apply Handoff; Apply Handoff does not select replacement stories.
- Use only candidates with a valid publication date. When the Futures article publication window is known, Futures selections also require a verified offset-bearing ISO `publishedAt` within that window, including its endpoints. If no articles qualify, leave Futures stories empty; do not switch to the fallback or widen the window to fill slots. Under the normal News freshness fallback described above, a verified precise timestamp is not required. Apply Handoff mirrors the Prepare Handoff eligibility check defensively; the Futures catalyst requirements apply in either case.

### Story selection policy

- Review and rank the candidate pool for relevance, explanatory value, freshness, source quality, source fidelity, and distinct coverage of topics and publishers. Freshness alone does not justify selection or retention. For comparable coverage of the same development, favor a publisher less represented in that section; avoid publisher dominance when strong alternatives are available.
- Before selecting a Futures card, answer: why does this matter for index futures before the open or during the active session? If the answer is mainly "this is an interesting company story," it is not a Futures card.
- A prior card may enter the candidate pool only when it is still fresh, relevant, and source-faithful; it then competes directly with current candidates.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, Reuters, CNBC, Yahoo Finance, Axios, Kiplinger, Investing.com, Investopedia, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
- Match every story's headline and body to its linked article's main reported theme. Narrow a card to a company, earnings, product, or subtheme angle when that is all the reporting supports; do not use it to imply a broader market, sector, or macro claim.
- `READ MORE` links must be reader-facing HTML pages, never raw APIs, feeds, JSON, or CSV downloads.
- Judge General and Crypto as complete collections, with separate attention to the first 9 initially visible cards in each section. Compare the first 9 General stories with the Opening catalysts, Futures cards, Week Ahead, Earnings, Tape drivers, and Crypto section. Each collection should provide coherent, balanced coverage of its most important distinct drivers and forward risks. Check topic coverage, distinct angles, and publisher concentration in each section. When one publisher dominates, compare strong reviewed alternatives and revise the collection when they provide comparable or better coverage. Replace narrow, redundant, or comparatively weak cards when stronger reviewed contenders would resolve scattered, repetitive, or incomplete coverage. Do not impose publisher quotas, weaken article-quality standards, or force coverage when the candidate pool lacks suitable source-faithful articles.

### Futures contract

For `futuresModule`, leave generated futures rows and session labels unchanged; select Futures cards through `editorialReview.newsSelection.futures` under the News-card contract.

### Tape contract

For `tape`, the generated roster, row order, ticker identities, groups, row labels, quote fields, and commentary dispositions are system-owned. Do not add, remove, reorder, or replace Tape rows during AI Editorial Work. The AI may edit only each generated row's `note` and the key-driver portion of `tape.label` after the separator. Rewrite each refreshed Tape note. Each note must summarize the relevant market commentary or catalyst without carrying prior commentary forward or restating quote values. Before Apply Handoff, compare every refreshed Tape note against that row's generated direction, delta, and percent; rewrite any note that contradicts the displayed move. Every Crypto-group ticker needs its own current note for the collapsed Tape Crypto tab; do not reuse generic copy across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible Crypto tickers. Failed quote downloads retain their last validated quote and bound commentary.

### Asset Allocation contract

For `assetAllocationPortfolio`, review the generated ETF rows and sanitized portfolio summary. Leave deterministic values unchanged, including any carried-forward or unavailable state resolved during Prepare.

### Stories contract

For `stories`, select the broad-market news collection through `editorialReview.newsSelection.stories` under the News-card contract.

### Crypto contract

For `crypto`, leave generated `crypto.stats[]` and `crypto.dominance` values unchanged, and select only the crypto news collection through `editorialReview.newsSelection.crypto` under the News-card contract. Crypto ticker quote rows are generated in `tape.rows[]` with `group: "Crypto"`; their ticker-level commentary remains editorial under the Tape contract.

### Earnings editorial contract

For `earnings.week`, leave the generated five-trading-day slate, facts, and reactions unchanged. Complete every visible Earnings row under this contract.

Treat every visible Earnings row as an editorial assignment. Verify each row's identity, deterministic facts, narrative state, and supporting evidence. Normally, research and write each row separately and do not reuse or paraphrase commentary from another row. As a narrow exception, multiple rows representing the same underlying issuer and the same earnings event, such as different share classes, may use identical verified narrative when that narrative accurately applies to every affected row. This exception is determined from issuer and earnings-event identity, not from a hard-coded ticker list. It does not permit reuse across different issuers or different earnings events, and it does not relax the current-evidence requirement. Do not consult, reuse, or paraphrase prior dashboard commentary when completing a new assignment.

Earnings has two narrative states:

- **Before actuals:** Explain the company-specific business question, operating metric, or management outlook most likely to determine the earnings read. Base this on the company’s latest results and guidance, current expectations, and known company-specific developments.
- **After at least one verified actual:** Replace the pre-release commentary with the principal business takeaway from the verified reported facts. If EPS or revenue is still missing, discuss only the verified facts and do not imply the missing metric was reviewed. Complete each required field under the Earnings field contract after actuals arrive.

Editorial work is required at these transitions:

1. **Calendar rollover:** Write fresh pre-release commentary for every visible row in the new slate, including companies retained from the preceding calendar. Prior copy cannot be carried forward as completed work.
2. **Results arrival:** Once at least one verified actual is available, remove the pre-release commentary, write the post-release interpretation, and complete the guidance determination.
3. **Verified close arrival:** Add company-specific reaction commentary explaining what the market response indicates. Update the result interpretation as well if the reaction materially changes the earnings read.

A transition from `scheduled` to `awaiting_actual` does not create a new narrative state because no results have arrived. Continue to show the current pre-release thesis and do not invent results. Any correction to the report date, timing, estimates, actuals, guidance, or closing reaction invalidates the commentary affected by that correction.

Use generated Earnings guidance evidence first when it is available in `generated/editorial/earnings_week_guidance.json`. The evidence packet collects same-event SEC/EDGAR 8-K or 6-K exhibit documents for visible reported rows; EX-99.1 is primary, and EX-99.2 is supporting when present. The evidence packet is editorial context only. It does not supply deterministic EPS, sales, timing, market cap, or reaction facts. Use the deterministic Earnings facts for reported values and Yahoo Finance Chart API reaction data. Use reputable reporting when needed to explain market context or reaction. Evidence reviewed for one company does not verify commentary for another.

After drafting a post-release interpretation, review current company-specific News/Futures coverage. If it contains a verified fact that materially changes the principal business takeaway, revise the interpretation accordingly.

`verified` means that current evidence was reviewed for that specific company, transition, and narrative field. The presence of text alone does not make a field verified.

For Earnings, blank narrative fields marked `pending_review` are required AI assignments, not optional placeholders. Before Apply, scan every visible `earnings.week.rows[]` row and audit `outcome.interpretationDisposition`, `outcome.guidanceDisposition`, and `reaction.commentaryDisposition` separately. If a row has actual EPS or revenue, `outcome.interpretation` must be filled and marked `verified`, and guidance must be resolved as `verified` or `not_provided`. If the verified close reaction is computed, `reaction.note` must be filled and marked `verified`. If any currently actionable Earnings field remains `pending_review`, do not Apply; report the affected ticker and field.

#### Earnings field contract after actuals arrive

- `outcome.interpretation`: required once at least one verified actual is available. Explain the result takeaway using only verified EPS, revenue, guidance, operating, and management-commentary facts.
- `outcome.guide`: required as a guidance determination once at least one verified actual is available. Review the generated Earnings guidance evidence first when present, then use official company materials or reputable reporting when the generated evidence is missing or inconclusive. If forward guidance exists, write concise guide text and mark `guidanceDisposition.status = "verified"`. If reviewed evidence shows no guidance was provided, leave `outcome.guide` blank and mark `guidanceDisposition.status = "not_provided"`. If the guidance determination cannot be completed, leave or keep `guidanceDisposition.status = "pending_review"`, do not guess, do not mark `not_provided`, and stop before Apply with the affected ticker and field.
- `reaction.note`: required only after the verified close reaction is available. Explain the earnings driver behind the market response.

Commentary is not completed editorial work when it:

- Could be moved unchanged to a different underlying company or earnings event.
- Duplicates or closely paraphrases another row, except for the permitted same-issuer, same-event case described above.
- Merely restates displayed EPS, revenue, or price values.
- Uses generic references to demand, costs, margins, execution, or management outlook without identifying the company-specific issue.
- Reuses a batch template, placeholder, or prior-state commentary.

Every required Earnings narrative field must contain completed, company-specific commentary supported by current evidence. Generic, templated, unsupported, or duplicated commentary across different underlying companies or earnings events does not satisfy the requirement and must not be marked verified. Identical narrative for a valid same-issuer, same-event set remains subject to the same evidence and field-completeness requirements.

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

For `weekAhead`, do not hand-edit deterministic dates, times, event names, impact levels, actual/forecast/previous values, release states, surprises, close reactions, Market Lens event IDs, or Market Lens reaction tickers. Complete the editable Market Lens and Outcome fields described below.

Every `weekAhead.days[].marketLens` with `status: "pending_review"` is an active assignment. Write populated `copy.question`, `copy.title`, and `copy.body`, then set the Market Lens `status` to `verified`. Do not edit `eventIds` or `reactions`. A Market Lens already marked `verified` may remain only when it still describes the same deterministic event context and remains supported by the current evidence. Once every event selected by `eventIds` has completed, replace all pre-release Market Lens copy with current commentary.

Reconsider every event day against the released facts, deterministic market-reaction data, current Opening and Tape, and the full `generated/news_candidates.json` inventory, not just News cards selected for promotion. Prefer event-specific coverage when available, then related market context such as rates, the dollar, equity indexes, sectors, commodities, or credit. Do not treat carried-over copy as automatically reviewed.

Use these stages to keep Market Lens commentary current:

- **Before selected events occur:** Explain the questions and risks ahead.
- **As events complete, before closing reactions are available:** Reflect verified released facts and discuss only the remaining uncertainties; do not anticipate an event that has already occurred. Once all selected events complete, replace pre-release copy with current interpretation. Do not imply that missing statistical actuals or closing reactions have been verified.
- **At `close_available`:** Write verified `Outcome & Close Reaction` copy interpreting the completed event context and session response only when Prepare Handoff marks Outcome `pending_review`. Prepare marks Outcome only after close-reaction rows are available and every event selected by `eventIds` has either supplied its statistical actual or completed as a non-statistical event, such as a policy communication.

When a day has `lifecycle: "close_available"` and `outcome.status: "pending_review"`, write populated `weekAhead.days[].outcome.title` and `weekAhead.days[].outcome.body`, then set `weekAhead.days[].outcome.status` to `"verified"`. Do not add or edit `outcome.source`; Apply owns that field and sets it to `"editorial"` for an accepted verified Outcome. Do not create Outcome copy before Prepare marks the assignment `pending_review`.

Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

Statistical releases selected by `eventIds` continue deterministic value recovery until their actuals are available; selected non-statistical events complete when their scheduled time passes. Once the complete selected context is available, complete the prepared Market Lens assignment with current commentary. Do not leave an actionable `pending_review` assignment unresolved or use an unavailable disposition as completed AI Editorial Work. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice.

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
   - Follow the News inventory contract for metadata triage, deep review, checkpointing, and recovery.
   - Select and order cards under the News-card contract and Story selection policy, including prior-card comparison, Crypto ticker priority, collection review, and target/exhaustion requirements.
   - Write only the permitted `editorialReview.newsSelection` fields; keep `generated/news_candidates.json` read-only.

4. Apply these copy and tone rules throughout AI Editorial Work.
   - Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep publisher attribution out of story titles and bodies. News-card provenance belongs only in the generated `sourceLabel` metadata.
   - Do not write tautological market-status copy that states routine facts without saying why they matter.
   - Market-closure rows should read as status labels, not watchlists. Prefer `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate, then put any crypto or overseas-market context in the event sentence only if it is genuinely relevant.
   - Crypto ticker notes in `tape.rows[]` rows with `group: "Crypto"` should explain the factor driving that ticker or proxy today: bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.
   - Do not merely restate quote rows in ticker notes, crypto notes, or story bodies.

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
- For every Week Ahead day with an actionable Outcome assignment, confirm that `outcome.title` and `outcome.body` are populated and `outcome.status` is `"verified"`. Leave `outcome.source` system-owned.
- Audit every refreshed Tape note for ticker-specific, current commentary. Rewrite notes that are generic, formulaic, interchangeable across tickers, merely restate quote movement, or use repeated framing. Each refreshed note must name or clearly imply the relevant catalyst or market driver for that row.
- Audit every Crypto-group Tape note separately. Each visible Crypto ticker needs its own crypto-specific driver, such as bitcoin leadership, ETH/SOL relative strength, ETF demand, regulation, market structure, protocol updates, exchange/issuer developments, sentiment, or listed-proxy beta. Do not reuse generic crypto copy.
- Compare every refreshed Tape note against that row's generated direction, delta, and percent. Rewrite any note that contradicts or ignores the displayed move before Apply.
- Every `editorialReview.newsSelection.futures[].url` must appear in `generated/news_candidates.json` `futuresCandidates`.
- Every `editorialReview.newsSelection.stories[].url` must appear in `generated/news_candidates.json` `generalCandidates`.
- Every `editorialReview.newsSelection.crypto[].url` must appear in `generated/news_candidates.json` `cryptoCandidates`.
- No selected URL may appear twice within a section or across Futures, Stories, and Crypto.
- Read the Futures eligibility bullets in the News-card contract and verify every Futures selection against them.
- Treat fewer than 18 General selections or 15 Crypto selections as below target. Continue reviewing eligible candidates until both targets are met or every eligible candidate in the affected pool has been exhausted.
- Complete the Story selection policy's collection review for General and Crypto, checking both full selections and their first 9 initially visible cards for topic coverage, distinct angles, publisher concentration, and important unexplained gaps. Compare strong reviewed alternatives when one publisher dominates; revise the selections when comparable or better coverage is available. Do not treat individually acceptable cards as sufficient or impose publisher quotas.
- If a selected URL fails any check, fix `editorialReview.newsSelection` before Apply Handoff. Do not rely on Apply Handoff to omit or replace it.
- Inspect intended editorial fallbacks before Apply. Any avoidable editorial fallback, duplicate omission, blank currently required editorial field, or below-target section caused by AI selection or copy quality must be fixed or repaired in the handoff before Apply.
- Under the Earnings editorial contract and Week Ahead / Market Lens editorial contract, confirm required commentary is current and company- or event-specific. Retain existing commentary only when the section contract permits retention and current review confirms that its facts, event context, and interpretation remain valid. Complete fresh commentary whenever the section contract requires a new assignment or transition.
- If the section remains below target after all eligible reviewed candidates are exhausted, leave it below target rather than inventing filler.
- Run Apply only after the AI can state: `The handoff passed the Final Pre-Apply Editorial Gate.` Any gate failure means continue repairing `generated/editorial/dashboard-data.json` until it passes, then send it to Apply.
