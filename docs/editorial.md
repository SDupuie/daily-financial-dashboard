# AI Editorial Instructions

Use only the sections of this file routed by `AGENTS.md` during AI Editorial Work. It is the canonical contract for editing the editorial content of `generated/editorial/dashboard-data.json`. The following section owns the cross-section work process; the section contracts own domain-specific assignments and evidence requirements. README owns command execution, recovery, and publication.

## AI Editorial Work contracts

### Authority and assignment scope

Review, write, and select only the editorial fields described in the section contracts. Do not edit source code, dashboard HTML, generated market data, calendar facts, earnings facts, or other system-owned values during AI Editorial Work.

Required editorial fields are active assignments, including `pending_review` fields. A blank field requires completion only when currently actionable under its section contract. Intentionally blank fields, such as guidance reviewed and marked `not_provided`, and fields awaiting required deterministic evidence are not incomplete merely because they are blank. Unresolved or unavailable work is not completed work; the Final Pre-Apply Editorial Gate below owns its fail-open handling.

### Handoff identity and deterministic envelope

- Confirm successful preparation under README's canonical workflow before reading News. A handoff/candidate/base-edition mismatch requires reconciliation under README recovery before Apply. A failure confined to the News inventory or review-evidence binding instead makes News unavailable: preserve the files, report the News blocker, and continue unrelated sections without trusting those selections.
- Follow README [Update continuity and recovery](../README.md#update-continuity-and-recovery) for all progress saving, compaction, model-switch, and interruption recovery. Preserve supported work and reconcile identity mismatches; elapsed time alone does not authorize regeneration. An authorized new run or an explicit focused repair may replace the handoff under its documented workflow. Do not regenerate merely to erase uncertainty.
- Leave the generated date/edition, compile prefix, Futures labels, and Tape session label unchanged. Prepare uses the Chicago run date, including prior-evening holiday context; explain a next-day closure in Week Ahead or stories rather than forward-dating the envelope. A resumed run preserves its original identity under README recovery.
- Friday afternoon shows current Friday plus next Monday–Thursday; Monday morning shows current Monday–Friday. Ordinary manual runs refresh the active Week Ahead and Earnings ranges. Manual calendar rollover requires `--rollover-calendar` and uses the local weekend day when run on Saturday or Sunday.
- If deterministic values look stale or wrong, pause work on the affected material and read only the relevant data-contract, deterministic-source, or focused-repair subsection in `docs/reference.md`. Do not invent replacement facts or change source files. Preserve unrelated editorial progress; follow `AGENTS.md` when a source change requires approval.

### Review and writing order

1. Review downloaded News after prices and before other editorial decisions. Complete the News inventory contract's metadata triage and deep review, then select and provisionally order cards under the News-card contract and Story selection policy.
2. Work through the handoff in this order, applying each section contract: `masthead`, `opening`, `futuresModule`, `tape`, `assetAllocationPortfolio`, `stories`, `crypto`, `earnings.week`, `weekAhead`, `footer`.
3. Once section drafting and review are finished, including identifying any unresolved fields, perform the Story selection policy's collection review and finalize News ordering. When a selection changes, update `newsSelection` and the old and new URLs' `deepReviews[].decision` together. Keep one evidence entry per reviewed URL; do not append a duplicate review or expand the frozen shortlist.
4. Run the Final Pre-Apply Editorial Gate below. Revisit only a specific problem it reveals, not the whole completed research process.

### Shared copy and tone

- Write normal text characters rather than HTML entity escapes unless actual markup is intended: `S&P`, not `S&amp;P`.
- Keep quote/news-source attribution and verification/process language out of narrative copy, including story titles and bodies. Do not write phrases such as `Reuters reported`, `Yahoo showed`, or `fallback chain`. News provenance belongs in generated `sourceLabel`; chart details own row-specific provenance.
- Do not use `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.
- Explain why a development matters; do not write tautological market-status copy or merely restate quote rows in ticker notes or story bodies.
- Market-closure rows read as status labels, not watchlists: use `U.S. Markets Closed`, `Markets Closed`, or `Early Close` as appropriate. Include crypto or overseas-market context in the event sentence only when genuinely relevant.

### Final Pre-Apply Editorial Gate

This is a required editorial review, not an all-or-nothing publication gate. Apply's mechanical result does not prove research completeness or source fidelity.

1. **Semantic review:** Confirm the in-scope section assignments meet their contracts: current, specific Tape commentary consistent with each displayed move; company- and event-specific Earnings and Week Ahead copy; Futures catalyst eligibility; and the final News collection review. Use `editorialReview.earningsChecklist` as the read-only Earnings assignment index, auditing each underlying narrative field separately. Retain existing copy only when its section contract permits retention and current review supports it. Unchanged deterministic facts alone do not establish that prior research still applies.
2. **Mechanical review:** Use the read-only Apply preview documented in README to inspect the actual acceptance/omission decisions, evidence diagnostics, derived counts, and Opening catalyst-count and Earnings copy-length advisories. It replaces hand-counting or independently reimplementing Apply checks; it does not replace the complete News scan, deep review, or semantic review. News review-evidence issues make preview exit nonzero; artifact-safety errors can also fail it. Use the printed evidence diagnostics to correct resolvable problems, including selection/evidence linkage, using reviewed shortlist alternatives. If a required conclusion genuinely remains unavailable, follow Disposition and continuation rather than treating evidence-related status as a publication gate. Rerun the preview only after a relevant correction, not as an unchanged retry loop. Style advisories do not authorize automatic truncation or discarding sound copy.
3. **Disposition and continuation:** Complete all work that can be supported with available evidence and fix avoidable omissions. Do not stop after a perfunctory attempt or skip assignments because publication can proceed. If a required conclusion genuinely cannot be established, leave unsupported copy blank and retain its `pending_review` state (or its section's valid unavailable state); never guess, mark it verified, or treat it as completed. Record the affected section/item/field, evidence gap, and next action in the existing resume notes. After required review and available corrections, proceed to Apply with the supported material and report unresolved work and News shortfalls under README's Completion report. Section-level editorial gaps or an unavailable preview do not block publication or justify restarting Prepare. Uncertain run identity, active-command state, source-change authority, and artifact render/write safety remain governed by AGENTS and README; do not bypass those boundaries. Claim the editorial work complete only when no required actionable work remains unresolved.

## Section contracts

### Masthead contract

For `masthead`, leave the generated edition and date unchanged. "Before The Open" and "After The Bell" are only the morning and afternoon edition section titles, respectively. They identify which update is being prepared; do not infer market-open or market-close status, data freshness, or any other fact from either title.

### Opening contract

For `opening`, write the current edition's `headline`, `deck`, and exactly 4 catalyst cards. Each catalyst must have a short `label` and a current, evidence-supported `body` summarizing one of the update's main market drivers.

### News inventory contract

Use `generated/news_candidates.json` as the sole read-only News inventory for AI review and Apply. Confirm its `generatedAt` matches `editorialReview.preparedAt` before review; do not edit, delete, reorder, prune, summarize, or mark candidates unavailable in that file. The editable handoff contains review evidence and News selections, not a copy of the inventory. Prepare emits the complete eligible deduplicated inventory without a per-pool editorial ceiling. General and Futures may contain the same URL because Futures applies the News-card contract's session-time or fallback freshness rules to General coverage; Crypto remains exclusive under the pool-classification contract. Eligibility for `futuresCandidates` does not establish that an article is a meaningful index-futures catalyst; that judgment belongs to deep editorial review.

Use ordinary read-only inspection commands to view compact metadata in batches sized to keep the output fully visible; there is no fixed batch size or prescribed query. Keep a stable URL-deduplicated ordering throughout the scan and preserve pool memberships. If output is truncated, retrieve and inspect the missing range before recording it as reviewed. Source or keyword filters may help compare contenders, but must not replace the complete metadata scan below.

AI Editorial Work is one phase with two ordered News-review passes:

1. **Metadata triage:** Examine the URL-deduplicated union of `generalCandidates`, `futuresCandidates`, and `cryptoCandidates` in manageable batches. Preserve pool memberships while examining a URL only once. Inspect each candidate's subject, `sourceLabel`, publication date and exact timestamp, reader-facing URL, and prior-card status. Identify plausible coverage, overlapping angles, and clearly noncompetitive items. Retain 60 unique General/Futures candidates and 30 unique Crypto candidates as the completed shortlists for deep review. Within those totals, prioritize publisher diversity in rounds by `sourceLabel`: take each publisher's strongest qualifying candidate, then its next strongest, for up to five General/Futures rounds and three Crypto rounds. If a round has more candidates than remaining places, take the strongest candidates in that round. Fill any places left after the rounds with the strongest remaining candidates overall; the rounds do not cap a publisher's final contribution. A URL shared by General and Futures counts once. If a pool contains fewer eligible candidates than its target, retain the full pool. Use the complete metadata scan to cover the important distinct topics, enough plausible stories to meet the General and Crypto News-card targets, and viable alternatives. Before deep review begins, record the retained inventory references in `editorialReview.resumeNotes` as directed by README [Update continuity and recovery](../README.md#update-continuity-and-recovery). Those references define the completed shortlists for Pass 2; do not add or replace candidates during deep review. This remains a complete-inventory scan, including Futures-only candidates and every fresh prior card; it is not a newest-first stopping rule. Set `editorialReview.reviewEvidence.metadataScanComplete` to `true` only after the complete scan.
2. **Deep review and selection:** Read every shortlisted candidate's full record once, applying the Story selection policy below. Use `candidate.article.excerpt` when present; otherwise use the candidate summary, title, description, and source metadata. Browse only when the available evidence cannot resolve a specific selection or copy question. For every reviewed candidate, append one `editorialReview.reviewEvidence.deepReviews[]` object shaped as `{ "ref": "generalCandidates[index]", "decision": "selected", "evidence": "brief article-specific note" }`, using its first zero-based inventory reference in scan order (`generalCandidates[index]`, then unseen `futuresCandidates[index]`, then `cryptoCandidates[index]`). The property name is exactly `ref`; do not substitute aliases such as `inventoryRef`. Set `decision` to `selected` or `not_selected`. Then write `editorialReview.newsSelection`; every selected URL must have a matching `selected` review entry. Select and compare stories only within the completed shortlists; do not deep-review candidates excluded by Pass 1.

`editorialReview.reviewEvidence` in `generated/editorial/dashboard-data.json` is the sole structured News-review completion record. Its `inventoryGeneratedAt` must match the current inventory. Apply resolves references, checks review floors and selection linkage, and derives valid-review and prior-card reuse counts; do not type totals. A local evidence error affects only selections depending on that evidence. An unusable inventory or unbound review record leaves no trustworthy selections. Incomplete scan/review diagnostics remain visible even when independently supported cards can publish; they do not establish completion. Handle these diagnostics under the Final Pre-Apply Editorial Gate.

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
- Selection order is display priority. The first 9 General and first 9 Crypto cards are visible initially; later accepted cards are secondary coverage behind the section's `More stories` disclosure. For Crypto, fill the first three positions with the strongest qualifying candidates carrying generated `tickerSearchSymbols` for IBIT, ETHA, or MSTR whenever possible, preferring one qualifying story per ticker before repeating a ticker. If fewer than three such candidates pass normal deep review, fill the remaining primary positions with the strongest ordinary Crypto candidates. This priority is not a quota and never lowers relevance, source-quality, source-fidelity, freshness, or diversity standards. The News-card targets above include secondary cards, so reaching the initially visible counts is not a stopping point. After the single deep-review pass, fill the General and Crypto targets from qualified shortlisted candidates, using the strongest unused reviewed alternatives when a proposed card fails. Secondary cards must pass the same standards as primary cards. If the completed shortlist exceptionally lacks enough qualified stories, use the qualified selections and report the specific shortfall; do not invent filler, repeat reviews, or expand the shortlist.
- Do not set or edit coverage/New-pill fields.
- Resolve duplicate URLs/titles, wrong section category, and missing-inventory URLs during AI Editorial Work using qualified reviewed shortlist alternatives; Apply Handoff does not select replacement stories.
- Use only candidates with a valid publication date. When the Futures article publication window is known, Futures selections also require a verified offset-bearing ISO `publishedAt` within that window, including its endpoints. If no articles qualify, leave Futures stories empty; do not switch to the fallback or widen the window to fill slots. Under the normal News freshness fallback described above, a verified precise timestamp is not required. Apply Handoff mirrors the Prepare Handoff eligibility check defensively; the Futures catalyst requirements apply in either case.

### Story selection policy

- Rank the reviewed Pass 1 shortlist candidates for relevance, explanatory value, freshness, source quality, source fidelity, and distinct coverage of topics and publishers. Freshness alone does not justify selection or retention. For comparable coverage of the same development, favor a publisher less represented in that section; avoid publisher dominance when strong alternatives are available.
- Before selecting a Futures card, answer: why does this matter for index futures before the open or during the active session? If the answer is mainly "this is an interesting company story," it is not a Futures card.
- During metadata triage, a fresh prior card in the generated inventory competes with current candidates for a shortlist place only when it remains relevant and source-faithful.
- Keep a prior-run link only when it remains among the best available candidates after direct comparison. Prefer the newer candidate when reporting quality and price relevance are materially similar; do not churn a link merely because the scheduled window changed.
- Replace a link when it is stale in angle, too narrow for the card's claim, materially weaker than current reporting, or no longer the best explanation for market action. If a carried-forward link remains, rewrite its copy only as needed to stay faithful to that article.
- Before finalizing a subscriber, metered, or commonly gated link, check for an accessible reputable substitute. Use gated outlets only when their reporting is original or materially stronger and no suitable accessible substitute exists.
- Preferred general sources: AP, Reuters, CNBC, Yahoo Finance, Axios, Investing.com, Investopedia, Morningstar, TheStreet, U.S. News Money, and official exchange or index-provider pages. Prefer primary sources for company, policy, or market-structure claims; preferred crypto sources include CoinDesk, Decrypt, CoinGecko, CoinMarketCap, Alternative.me, issuer pages, SEC filings, and official protocol, exchange, or company announcements.
- Match every story's headline and body to its linked article's main reported theme. Narrow a card to a company, earnings, product, or subtheme angle when that is all the reporting supports; do not use it to imply a broader market, sector, or macro claim.
- `READ MORE` links must be reader-facing HTML pages, never raw APIs, feeds, JSON, or CSV downloads.
- At the collection-review step, judge General and Crypto as complete collections, with separate attention to the first 9 initially visible cards in each section. Compare the first 9 General stories with the Opening catalysts, Futures cards, Week Ahead, Earnings, Tape drivers, and Crypto section. Each collection should provide coherent, balanced coverage of its most important distinct drivers and forward risks. Check topic coverage, distinct angles, and publisher concentration in each section. When one publisher dominates, compare strong reviewed shortlist alternatives and revise the collection when they provide comparable or better coverage. Replace narrow, redundant, or comparatively weak cards when stronger reviewed shortlist contenders would resolve scattered, repetitive, or incomplete coverage. Do not impose publisher quotas on final card selections, weaken article-quality standards, or force coverage when the completed shortlist lacks suitable source-faithful articles.

### Futures contract

For `futuresModule`, leave generated futures rows and session labels unchanged; select Futures cards through `editorialReview.newsSelection.futures` under the News-card contract.

### Tape contract

For `tape`, the generated roster, row order, ticker identities, groups, row labels, quote fields, and commentary dispositions are system-owned. Do not add, remove, reorder, or replace Tape rows during AI Editorial Work. The AI may edit only each generated row's `note` and the key-driver portion of `tape.label` after the separator. Rewrite each refreshed Tape note. Each note must summarize the relevant market commentary or catalyst without carrying prior commentary forward or restating quote values. Before Apply Handoff, compare every refreshed Tape note against that row's generated direction, delta, and percent; rewrite any note that contradicts the displayed move. Every Crypto-group ticker needs its own current note for the collapsed Tape Crypto tab; do not reuse generic copy across BTC, ETH, SOL, XRP, IBIT, ETHA, MSTR, or other visible Crypto tickers. Failed quote downloads retain their last validated quote and bound commentary.

Reject generic, formulaic, interchangeable, or repeatedly framed notes. Each refreshed note must name or clearly imply that row's relevant driver. Review Crypto notes separately for ticker-specific drivers such as bitcoin leadership, ETH/SOL relative strength, XRP-specific participation, ETF demand, listed-proxy beta, sentiment, flows, regulation, market structure, security events, protocol updates, or exchange/issuer developments.

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

Audit `outcome.interpretationDisposition`, `outcome.guidanceDisposition`, and `reaction.commentaryDisposition` separately for every visible row. The field rules below define successful completion; unresolved work follows the Final Pre-Apply Editorial Gate rather than blocking the whole dashboard.

#### Earnings field contract after actuals arrive

- `outcome.interpretation`: required once at least one verified actual is available. Explain the result takeaway using only verified EPS, revenue, guidance, operating, and management-commentary facts, and mark `interpretationDisposition.status = "verified"` when completed.
- `outcome.guide`: required as a guidance determination once at least one verified actual is available. Review the generated Earnings guidance evidence first when present, then use official company materials or reputable reporting when the generated evidence is missing or inconclusive. If forward guidance exists, write concise guide text and mark `guidanceDisposition.status = "verified"`. For a no-guidance conclusion, review the applicable official company material for that earnings event, leave `outcome.guide` blank, and supply `guidanceDisposition` with `status: "not_provided"`, `evidenceSource: "official_company"`, and `evidenceUrl` set to that reviewed document's HTTPS URL. An available packet URL or zero detected guidance signals alone is not evidence for this conclusion. Do not automatically attach an unreviewed URL. If inconclusive, keep `guidanceDisposition.status = "pending_review"` and follow the final gate's unresolved-work handling; do not guess or mark `not_provided`.
- `reaction.note`: required only after the verified close reaction is `computed`. Explain the earnings driver behind the market response, and mark `commentaryDisposition.status = "verified"` when completed. For every non-`computed` reaction state, leave the note blank; Apply removes any stray note or stale commentary disposition.

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

Reconsider every event day using its prepared event context, verified released facts, and deterministic market-reaction data. Use additional reporting only when a specific event-related claim needs support; prefer event-specific evidence over general market context. Do not treat carried-over copy as automatically reviewed.

Use these stages to keep Market Lens commentary current:

- **Before selected events occur:** Explain the questions and risks ahead.
- **As events complete, before closing reactions are available:** Reflect verified released facts and discuss only the remaining uncertainties; do not anticipate an event that has already occurred. Once all selected events complete, replace pre-release copy with current interpretation. Do not imply that missing statistical actuals or closing reactions have been verified.
- **At `close_available`:** Write verified `Outcome & Close Reaction` copy interpreting the completed event context and session response only when Prepare Handoff marks Outcome `pending_review`. Prepare marks Outcome only after close-reaction rows are available and every event selected by `eventIds` has either supplied its statistical actual or completed as a non-statistical event, such as a policy communication.

When a day has `lifecycle: "close_available"` and `outcome.status: "pending_review"`, write populated `weekAhead.days[].outcome.title` and `weekAhead.days[].outcome.body`, then set `weekAhead.days[].outcome.status` to `"verified"`. Do not add or edit `outcome.source`; Apply owns that field and sets it to `"editorial"` for an accepted verified Outcome. Do not create Outcome copy before Prepare marks the assignment `pending_review`.

Do not scan the Tape after the fact for the largest movers or imply that one release caused the entire session when several catalysts were active.

Statistical releases selected by `eventIds` continue deterministic value recovery until their actuals are available; selected non-statistical events complete when their scheduled time passes. Once the complete selected context is available, complete the prepared Market Lens assignment with current commentary. Handle any unresolved assignment under the Final Pre-Apply Editorial Gate; an unavailable disposition is not completed AI Editorial Work. Do not alter calendar facts, restate displayed values, use source/process language, or write tactical-allocation advice.

### Footer contract

For `footer`, leave the generated footer unchanged.
