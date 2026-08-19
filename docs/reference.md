# Dashboard Reference

## Data Contracts

This file is the canonical human-readable contract for dashboard data. Data contracts describe canonical ownership and expected payload shape. Deterministic contracts are enforced during Prepare/source validation; Apply owns only editorial and publication-state normalization. The final publication gate enforces only artifact renderability and core published-file safety unless this reference explicitly says a condition is publication-blocking. Keep validation, normalization, tests, and fetch-script output in sync with the relevant owner whenever a payload shape changes.

### Published payload boundary

The embedded `dashboard-data` JSON block lives between the `DATA START` / `DATA END` comments in `daily_financial_news.html`. The embedded `chart-data` JSON block is a separate production payload. Generated files are staging only and must not become published runtime dependencies.

### News candidates

- Owner: `scripts/fetch_news_candidates.js` retrieves and normalizes the read-only News inventory; `scripts/news_sources.js` owns approved source identities, display names, domains, and acquisition paths.
- Handoff boundary: `generated/news_candidates.json` is Apply's authoritative prepared inventory, timestamp-bound to `editorialReview.preparedAt`; `editorialReview.newsSearch` is its read-only AI-review copy, not an Apply trust source. If the sidecar is missing, malformed, or belongs to another Prepare, Apply fails open by omitting News selections rather than trusting the editable handoff copy.
- Retrieval contract: every News feed, API, and article-page GET uses the shared News HTTP client with a 64 KiB response-header ceiling, compressed- and decoded-body ceilings, compressed-body decoding, at most five redirects, and one wall-clock deadline across the complete redirect and body operation. Before following an article-page redirect, the client rejects URL credentials, localhost names, IP-literal hosts, and nonstandard HTTPS ports. Approved publisher URLs stay within that source's approved domain policy; an unapproved Marketaux single-ticker URL stays on its normalized original hostname. Other redirects remain same-origin by default, while Reuters sitemap requests require the exact indexed endpoint. A failed acquisition path is recorded and does not discard candidates from other paths; an unavailable article page does not discard an otherwise eligible provider candidate.
- Inventory contract: Prepare emits every retrieved eligible normalized candidate that survives freshness and URL/title deduplication; there is no per-pool editorial candidate ceiling after source retrieval. General, Futures, and Crypto inventories remain independently newest-first, and the same General candidate may also appear in Futures when it meets that session's exact timestamp window. `futuresCandidates` therefore means timestamp-eligible General coverage, not a deterministic judgment that every entry is a meaningful futures catalyst. AI Editorial Work reviews the URL-deduplicated union so overlapping General/Futures entries are examined once without losing their pool memberships.
- Enrichment contract: article-page review is optional context enrichment, not an inventory gate. Provider-verified candidates bypass it. Prepare reviews at most the 250 newest unverified candidates, while every additional eligible unverified candidate remains in the inventory with provider metadata and without `candidate.article`. A failed, missing, or capped article review does not discard the candidate or affect other candidates.
- Context shape: downloaded candidates may contain `candidate.article`; its sole article-body context field is `excerpt`, bounded to 5,000 characters. `candidate.article.text` is not supported. Article context is staging-only source material for AI Editorial Work and is never copied into a published News card.
- Pool-classification contract: candidates from explicit Crypto acquisition paths remain in `cryptoCandidates`. A candidate from a General path is promoted exclusively to `cryptoCandidates` when its normalized title contains the high-confidence term `bitcoin`, `crypto`, `cryptocurrency`, `cryptocurrencies`, `ethereum`, `ether`, `stablecoin`, `stablecoins`, `blockchain`, `digital asset`, or `digital assets`; ambiguous terms such as `token`, `wallet`, `mining`, and publisher or company names do not promote a candidate by themselves. General-to-Crypto promotion does not change source identity, URL, timestamp provenance, article-review behavior, or deduplication.
- Published selection and display contract: `stories[]` requires 9 cards for fail-open complete coverage and accepts at most 18; `crypto.notes[]` requires 9 for fail-open complete coverage and accepts at most 15; `futuresModule.stories[]` remains exactly 3 for complete coverage and accepts no extras. The editorial selection targets are 18 General and 15 Crypto; the 9/9 publication minimums are not editorial stopping points. Array order owns editorial priority. The first 9 General and first 9 Crypto cards render initially, while later accepted cards render behind a right-aligned `More stories` button in the section header. The button is absent when no secondary cards survive Apply. Secondary cards use the same published card shape and freshness, provenance, duplicate, source-fidelity, and editorial-quality rules as primary cards.
- Provenance and freshness contract: ordinary downloaded URLs map directly to the approved source catalog; the configured Marketaux single-ticker paths for IBIT, ETHA, and MSTR are the sole exception to that publisher-approval gate. Each Marketaux request uses an explicit UTC timestamp for the start of the earliest eligible Chicago date and retrieves at most five pages, or 15 articles, per ticker. A later-page failure or mismatched page number stops that ticker request, preserves earlier valid pages, and records the path as partial; reaching the five-page ceiling is a normal bounded acquisition. A Marketaux ticker candidate must use a direct credential-free HTTPS article URL on a normal hostname and the default HTTPS port; localhost names, IP-literal hosts, and nonstandard ports are rejected. A URL matching the approved source catalog keeps that source's display label and domain policy; any other Marketaux publisher receives a deterministic `sourceLabel` from its normalized hostname. Each candidate carries generated `tickerSearchSymbols` through publication so a still-fresh selected card can re-enter the next review inventory. It otherwise follows the same freshness, deduplication, article enrichment, Crypto-pool, triage, deep-review, selection, Apply, and publication rules as ordinary News. Prepare does not infer or replace publisher identity from hosted-page metadata. Yahoo-hosted URLs therefore remain Yahoo Finance candidates. Their `publishedAt` is hosted syndication time, recorded as `dateSource: "hosted_syndication"` and used provisionally for general-News freshness and ordering; it never sets `publishedAtVerified` or qualifies for an exact Futures timestamp window. Other first-party article pages may verify their own publication timestamp and context, but article review does not promote a candidate to another publisher or URL. `publishedAt` is optional precision and is retained only when it is an offset-bearing ISO timestamp; malformed optional values are omitted from the affected general-News card without discarding that card or unrelated candidates. Still-fresh prior cards never manufacture `publishedAtVerified` from a previously published `publishedAt` value.
- Reuters acquisition contract: Reuters' public News sitemap is the sole Reuters acquisition path. Prepare reads only the fixed HTTPS `www.reuters.com/arc/outboundfeeds/news-sitemap-index/` index and its fixed `www.reuters.com/arc/outboundfeeds/news-sitemap/` slices, requires unique contiguous 100-row offsets, and explicitly requests 100 rows so those offsets do not skip entries. The index and each slice must contain a nonempty, structurally complete set of sitemap or URL elements, and every accepted slice must yield at least one usable English Reuters article; malformed, empty, or wholly unusable documents fail that index or slice instead of passing as a successful empty acquisition. Each valid English entry enters the ordinary News pipeline with `loc` as its Reuters URL, `news:title` as its title, and `news:publication_date` as verified `publishedAt`; Reuters candidates then use the shared normalization, freshness, pool classification, deduplication, review-bypass, and Futures-window behavior. Invalid, unsupported-locale, legacy `/default/`, malformed, or stale entries are omitted individually when another valid entry survives. Provider-verified Reuters candidates bypass redundant article-page enrichment and remain subject to the same complete-inventory contract as every other source. Failed slices preserve valid entries from other slices and record the Reuters attempt as partial; an unavailable or malformed index omits Reuters candidates without degrading other acquisition paths.

### Week Ahead

- Owners: `scripts/fetch_week_ahead.js` makes one direct TradingView Economic Calendar request for the complete authorized range, and `scripts/week_ahead_contract.js` owns Eastern-time normalization, canonical event identity, the visible slate, Market Lens templates and lifecycle, and the Outcome contract.
- Source contract: TradingView owns raw U.S. event discovery, release timestamp, impact, Previous, Forecast, and Actual. Prepare includes high- and medium-impact rows, omits low-impact rows, retries transient or malformed responses up to two times after the first attempt, and never combines TradingView with a secondary calendar.
- Display contract: high-impact events are shown by default. The persisted `Medium impact` checkbox-style header toggle reveals the already embedded medium-impact rows when selected. Statistical values that have not arrived display em dashes; policy commentary and other non-statistical events leave those value cells blank.
- Refresh contract: each successful Prepare replaces the complete authorized TradingView range, including null values. If refresh fails, Prepare may carry forward only the validated same-range canonical calendar and marks it `carried_forward`; a new range becomes explicitly unavailable instead of being synthesized from an older week.
- Apply boundary: Apply does not fetch, normalize, supplement, or replace deterministic Week Ahead facts. It merges only the documented Market Lens and Outcome editorial state.
- Market Lens shape: each event day owns one `marketLens` object containing `status`, deterministic `eventIds`, deterministic `reactions`, and editable `copy.question`, `copy.title`, and `copy.body`. Supported statuses are `setup`, handoff-only `pending_review`, `verified`, and `commentary_unavailable`. There are no channel, source, or separate disposition fields.
- Boundary rules: source time is stored as `America/New_York` wall time and converted to the dashboard time zone on render. Market Lens reactions use predetermined canonical template tickers. After the selected event context completes, any available close reaction moves the day to `close_available`; the dashboard displays the calculable reactions and omits unavailable rows. Missing reaction or chart data does not block publication. Released event days must not publish pre-release Market Lens copy as current commentary; `outcome` exists only at `close_available` and cannot change the preselected reaction ticker set.

### Tape and chart data

- Owners: `scripts/fetch_chart_data.js` produces chart/futures data and owns the reusable payload-metadata and per-series market-data validators; `scripts/validate_dashboard.js` reuses them for staged artifact checks and adds chart/Tape roster and derived-quote consistency checks. Published validation separately checks only runtime-dereferenced shapes.
- Boundary rules: `chart-data.series[]` is the canonical market-data store; visible Tape quote fields are derived from it; every displayed Tape ticker must have matching embedded source, chart series, and derived quote data.
- MOVE uses EODHD's `MOVE.INDX` daily EOD endpoint with `EODHD_API_KEY`, and `MOVE.INDX` is the canonical `sourceSymbol` for its Tape row and chart series. The permanent free personal plan supplies one year of history, so each successful refresh replaces overlapping canonical MOVE dates with the EODHD bars, appends newer dates, and preserves older validated history within the dashboard's requested range. The chart information tooltip describes this as EODHD recent data plus retained history; individual historical bars are not source-attributed. MOVE volume is omitted, and the visible daily change is derived from the two latest EODHD closes. A missing credential, malformed response, or source failure follows the normal validated-series carry-forward/unavailable contract; Yahoo is not a MOVE fallback.
- Each published compact chart bar contains exactly `[time, open, high, low, close, volume]`; `time` is a valid `YYYY-MM-DD` calendar date, OHLC fields are finite JSON numbers with coherent high/low bounds, bars are strictly ascending by `time`, and `volume` is either a non-negative finite JSON number or `null` when no volume is available. Missing or additional tuple members are not supported. Published startup skips malformed compact bars or series instead of deriving visible quote values from them; staged validation remains the strict contract gate.
- Tape commentary binds to the accepted quote revision. Refreshed quotes need reviewed commentary; failed quote downloads retain their last validated quote and bound commentary.
- If neither refreshed nor prior canonical Chart/Tape data validates, Prepare emits an atomic unavailable bundle with empty `chart-data.series[]` and `tape.rows[]`; Apply copies that bundle unchanged.

### Asset Allocation

- Owner: `scripts/fetch_asset_allocation.js` supplies two independently prepared inputs: instrument-level ETF rows and the sanitized portfolio summary. Prepare validates and resolves each independently, so failure of one does not discard valid data from the other.
- Row fallback and isolation: each instrument row resolves independently. A rejected or fulfilled-but-malformed fresh row may carry forward only a validated prior row from the same dashboard month; a missing, malformed, or older prior row becomes explicitly unavailable. Other valid fresh rows remain fresh and the section is marked partial rather than discarded.
- Dividend boundary: each ETF row partitions validated non-negative numeric dividend events into current/past ex-dates, later ex-dates in the displayed month, and the following-month lookahead. Only the current bucket contributes to MTD dividend totals, and every bucket total must equal its event sum. Numeric totals and event arrays are canonical; new staging output does not store duplicate formatted dividend fields, and display text is derived by the consumer.

### Crypto

- Owner: `scripts/fetch_crypto_stats.js` supplies crypto stat cards; Crypto news cards follow the News-card contract.
- Boundary rules: `crypto.stats[]` is for section stat cards, CoinGecko-owned `crypto.dominance` contains BTC, ETH, and other market-cap percentages, `crypto.notes[]` is for crypto news, and ticker-level crypto quote rows and commentary live in `tape.rows[]`; `crypto.tape[]` is not supported.
- Refresh behavior: the three stat providers resolve independently. A failed provider carries only its validated prior card, or marks that card unavailable, while successful cards remain fresh and the section becomes partial. Because TOTAL and `crypto.dominance` share the CoinGecko response, they carry forward or become unavailable together.

### Futures

- Owner: `scripts/fetch_chart_data.js` owns Futures payloads.
- Boundary rules: `futuresModule.futures[]` contains exactly four index-futures rows unless `availability.status` is explicitly `unavailable`; Futures story rules live in the News-card contract.

### Prepare fallback contracts

Prepare validates fresh deterministic payloads. Where a domain permits prior-canonical carry-forward, Prepare validates that fallback before using it. If no permitted fallback validates, it emits the domain's explicit unavailable state and continues. Chart and Tape are resolved as one atomic bundle. Section-level source or contract failures do not block publication.

- `chart-data` and `tape.rows`: failed refreshes retain the complete validated quote/history/commentary bundle; if no valid bundle exists, both publish empty with `availability.status = "unavailable"`.
- `futuresModule`: individual source failures may produce a validated partial payload from the current preparation run. If no valid current-run payload exists, Futures becomes explicitly unavailable; prior canonical Futures values are not carried forward.
- `crypto.stats` and `crypto.dominance`: invalid fresh data uses validated same-domain carry-forward where allowed; otherwise Prepare emits explicit unavailable state.
- `assetAllocationPortfolio`: instrument rows resolve independently through validated same-dashboard-month row carry-forward or per-row unavailable state, while the sanitized portfolio summary resolves independently through its documented section-level fallback. One failed row or input does not discard unrelated fresh rows or the other input.
- `earnings.week` and `weekAhead`: a failed refresh carries forward only a validated canonical payload for the exact requested calendar range. Without one, Prepare emits that requested range as unavailable.

### Apply editorial fallback contracts

These are Apply implementation contracts, not AI Editorial Work completion rules. Apply never revalidates or replaces Prepare-owned deterministic values.

- `opening`: incomplete or invalid editorial Opening fields are omitted from the published payload rather than replaced with generated copy.
- `news`: missing, invalid, duplicate, outside-inventory, missing-provenance, or over-limit selected cards are omitted independently; Apply marks coverage partial where applicable and does not search for replacement stories or infer provenance. Optional secondary-card omissions do not make a section partial when its primary minimum remains satisfied.
- `tape`: refreshed quote rows without reviewed commentary publish a blank note with `commentary_unavailable`; failed quote-download rows retain their last validated quote-bound commentary bundle.
- `weekAhead`: Apply accepts only populated Market Lens copy marked `verified`, rebuilds `eventIds` and `reactions` from the deterministic candidate, and normalizes every other Market Lens into a publishable system-owned lifecycle state. Missing verified close Outcome remains `pending_review` and publishes no Outcome copy.
- `earnings.week`: narrative fields still marked `pending_review` or carrying a valid unavailable status publish no copy for that field and preserve that disposition for the next handoff. Apply never replaces `pending_review` with prior commentary. For a malformed non-pending narrative/disposition pair, Apply may recover previously verified copy only when the relevant deterministic facts are unchanged; otherwise the field publishes no copy and the invalid state is normalized. Deterministic empty-row recovery occurs during Prepare.

## Deterministic Source Contracts

The automated routing below describes the sources used by the deterministic fetchers. Use the normal Prepare Handoff / Apply Handoff workflow; this reference is not an alternate daily workflow.

### Automated deterministic-source routing

- Tape and chart series, including U.S. indices and equities, international and sector ETFs, commodity futures, rates-volatility and bond proxies, index futures, and crypto majors: Yahoo Finance chart data through the configured `sourceSymbol`, except MOVE. Yahoo chart series require usable daily OHLC; a fulfilled response with only closes is malformed and falls through the normal alternate-host/carry-forward/unavailable path. MOVE uses the authenticated EODHD EOD endpoint for source symbol `MOVE.INDX`, capped to the free plan's trailing one-year history and merged with older validated canonical history as described above.
- Finnhub quote data: latest-bar repair only for eligible plain U.S. symbols when Yahoo exposes a newer dated daily row, or the requested cutoff has passed Yahoo's scheduled regular-session end but the chart response does not provide usable OHLC for that session. Finnhub is not a second quote authority and is not used for futures, Treasury, or crypto symbols.
- Treasury yields and curve data: Treasury.gov Daily Treasury Yield Curve Rate Data.
- Total crypto market cap and BTC/ETH/other market-cap dominance: CoinGecko global market API.
- Altcoin Season Index: CoinMarketCap chart API; the stat-card `delta` comes from `historicalValues.yesterday`, and is `n/a` when that comparison is unavailable.
- Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2`.
- Asset Allocation Portfolio rows: Yahoo Finance instrument-level ETF market data only. The portfolio summary may use only the sanitized export from the separate Asset Allocation Dashboard; never import or recreate tactical allocation/model logic.
- Week Ahead: TradingView Economic Calendar at `https://economic-calendar.tradingview.com/events`, requested directly with `Origin: https://www.tradingview.com`. This private-dashboard integration uses no API key or automated secondary source.

### Manual research/cross-check references

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

## Earnings Deterministic Method

The richer earnings monitor uses this contract as the canonical deterministic method. The production dashboard consumes the canonical earnings week payload from embedded `dashboard-data.earnings.week`.

### Source hierarchy

1. Zacks primary: calendar slate, timing, market cap, EPS estimate, EPS actual, sales estimate, sales actual, surprise, and related row facts.
2. Legacy backup path: Finnhub -> Alpha Vantage -> EarningsAPI runs only when the Zacks path is unavailable or schema-invalid.
3. Yahoo Finance Chart API: deterministic market reaction using close-to-close rules.

The build does not blend Zacks rows with legacy-provider rows. A valid Zacks build uses Zacks only.

### Zacks availability and schema gate

- The Zacks path must pass an availability and schema gate before its data is accepted.
- The gate checks HTTP success, parseable response data, expected EPS and sales table fields, active-week dates, row identity alignment, non-empty eligible slate after the $25B market-cap filter, and sane numeric parsing.
- After a valid Zacks build, Prepare attempts a narrow Finnhub U.S. symbol-directory classification pass. Exact U.S. exchange-listed securities, including ADRs, remain eligible; OTC/Pink listings and symbols without an exact directory match are excluded from visible rows. If the live directory and cache are both unavailable, Prepare proceeds with the original Zacks market-cap-filtered rows and records the unavailable classification in staging diagnostics.
- If the Zacks gate fails, the build uses the legacy Finnhub -> Alpha Vantage -> EarningsAPI backup path.
- Backup use is recorded in staging diagnostics with the Zacks failure reason.
- If Zacks is valid but an individual row is missing actual EPS or sales, that field remains pending.

### Published row and narrative state

Published Earnings rows are selected and normalized by the Earnings contract owner during Prepare. Apply merges narrative fields only; final publication blocks only Earnings states that would make the dashboard fail to render. Display rows keep compact schedule, result, guidance, and reaction status fields; detailed source audit, Zacks schema-gate results, selected provider mode, and backup diagnostics are staging/debug state and must not be treated as reader-facing content.

For `TIME UNKNOWN` rows, `reportTiming` remains `unknown`. When actual EPS or sales first appears, the row stores `actualsObservedAt`. If that timestamp falls on or before `reportDate`, Yahoo reaction uses the same-day close basis; if it falls after `reportDate`, Yahoo reaction uses the next-session close basis.

Prepare Handoff treats repeated verified Earnings narrative as stale editorial state: same-field reuse across visible rows representing different underlying companies is reopened as `pending_review` for that field on the next handoff. Same-issuer rows, such as multiple share classes tied to one earnings report, may retain identical verified narrative only when they represent the same underlying company and earnings event; this does not allow reused or generic narrative across different issuers or relax the current-evidence requirement. This is a handoff self-healing check, not an Apply-time rejection gate.

### EarningsAPI budget policy

- EarningsAPI is quota-limited and is used only inside the legacy backup path after the Zacks gate fails.
- A successful Zacks build spends no EarningsAPI budget.
- Do not call EarningsAPI reactions; Yahoo remains the reaction source.

## Focused Repair Commands

Use focused repair commands only for explicit repairs. They update the current staged candidate, not the canonical dashboard. After a focused repair, regenerate the editorial handoff from that repaired candidate, then run `apply`; rerun `prepare` only when intentionally replacing the candidate.

- Market Lens-only correction: no standalone command. Use the current complete candidate when it still matches the canonical dashboard edition, regenerate the editorial handoff, and edit the Market Lens there. If no current candidate exists, rerun deterministic preparation first.
- Chart-only correction: start with a current complete candidate, then use `node scripts/run_daily_update.js --apply-chart-data-json PATH`, `node scripts/run_daily_update.js --merge-chart-data-json PATH`, or `node scripts/run_daily_update.js --sync-chart-quotes`. Regenerate the editorial handoff afterward; successful quote changes require reviewed commentary.
- Asset Allocation fallback: refresh `http://127.0.0.1:2200/api/asset-market-data`, then use `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`. If refresh fails but the export exists, use it as a stale fallback; never import tactical allocation/model logic.
- Earnings-only repair: rebuild the staged Earnings week from the current provider contract, then run `node scripts/earnings_week.js apply-narrative`, run `node scripts/run_daily_update.js --apply-earnings-week-json generated/earnings_week.json`, regenerate the editorial handoff from the repaired candidate, and run `apply`. Normal repair uses Zacks. Repair uses the legacy backup path only when the Zacks gate fails, and the staged diagnostics must preserve the reason Zacks was bypassed.
- Manual calendar rollover: use `node scripts/run_daily_update.js prepare --afternoon --rollover-calendar` for the Friday-through-Thursday bridge, or `node scripts/run_daily_update.js prepare --morning --rollover-calendar` for Monday-through-Friday. On Saturday, either edition rolls to the Friday bridge; on Sunday, either edition rolls to Monday-Friday.

## Local Refresh Server

Run `node scripts/local_market_server.js` to start the optional read-only local market overlay at `https://192.168.2.2:2210`. It exposes:

- `GET /health`
- `GET /api/market-refresh`

Local refresh may overlay fresher browser data, but it never writes that overlay back to the canonical artifact. Before returning any ticker, the local server applies the same four-decimal price and whole-number volume normalization used by scheduled chart data so equivalent source bars derive identical displayed quotes. Every accepted local chart series requires a valid `quoteRevision` and coherent object-form OHLC bars; changed local data may not reuse the current series revision, and a malformed series is ignored without affecting other tickers. The browser compares the rendered quote fields (`last`, `delta`, `pct`, `dir`, and `asOf`) when reconciling reviewed Tape commentary with a newer local revision. Unchanged quote fields keep the commentary and rebind its disposition to the accepted revision. Changed quote fields keep only valid reviewed commentary bound to its original revision, record the newer displayed quote revision in browser-only state, and show an information tooltip that discloses when the commentary was reviewed and when the local quote was refreshed. That stale state survives later local refreshes until a scheduled dashboard update supplies newly reviewed commentary. Missing, unavailable, or malformed commentary is never preserved as reviewed; it remains blank and is marked `commentary_unavailable` for the accepted revision. MOVE is excluded from the local overlay so automatic browser refreshes cannot consume EODHD's daily request quota; its embedded series changes only during the scheduled daily update. All one-bar overlays are ignored. See `launchd/README.md` for provisioning, TLS, origin policy, and renewal.

Use `node scripts/local_market_server.js --port 2211` to choose another local port for direct testing; the published dashboard only auto-checks port `2210`.

## Browser Support

The supported baseline is Chromium 120+ (Chrome and Edge), Firefox 121+, and Safari 17.4+ on macOS and iOS. Older browsers, browser-version branches, and polyfills are out of scope unless a concrete supported-browser behavior requires them.
