# Daily Financial Dashboard

This repository maintains `daily_financial_news.html`, a daily financial news dashboard.

## Maintained File

- `daily_financial_news.html`

## Update Cadence

Update `daily_financial_news.html` each market morning around 7:00 AM Central, before the U.S. open. Edit only the JSON inside:

```html
<!-- ============ DATA START — edit this block to update the dashboard ============ -->
...
<!-- ============ DATA END ============ -->
```

Do not touch the HTML, CSS, or JavaScript outside that block.

## Daily Update Runbook

1. Confirm dates first.
   - `masthead.date`: today.
   - `footer.compiled`: must include today’s compile date.
   - Never allow stale values such as `January 1` / year `2001` / prior-day date in `masthead.date` or `footer.compiled`.
   - `tape.label`: most recent market close, usually the prior weekday.
   - For non-U.S. listings, check the local market calendar/date before accepting any quote. Example: on a Monday morning U.S. run, Tokyo cash trading has already closed, so Renesas `6723.T` should normally use the Monday Tokyo close, not the prior Friday close.
   - If today is Monday or Friday, update `weekAhead`; otherwise leave `weekAhead` mostly unchanged unless a scheduled event has moved.

2. Refresh prices before reading news.
   - Never reuse prices already in the file.
   - Use exact retrieved prices. Use `~` only after exhausting that row's source hierarchy with two attempts per source.
   - For U.S. stock/ETF quotes, run `node scripts/fetch_quotes.js --symbols IBIT:etf,MSTR:stock` (or add more symbols) before manual quote pulls.
   - If stock/ETF DNS preflight fails, rerun quote pulls immediately with elevated network permissions rather than waiting for publish.
   - In each `tape.rows[].note`, summarize only the relevant market commentary, catalyst, or major news snippet for that line item (and include pre-market context when useful).
   - Do not restate the row's last price, point change, or percent change in `tape.rows[].note`; those belong only in `last`, `delta`, and `pct`.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` in any user-facing copy unless you directly verified that claim from a current primary or high-confidence market source for that exact instrument and session.
   - If a move is strong but record status is not directly verified, use neutral wording such as `broad risk-on move`, `sharp rally`, `strong close`, `near recent highs`, or similar non-record phrasing.
   - Do not name quote/news sources in `tape` notes. Keep all source attribution in `footer.compiled`.
   - Do not use source-verification phrasing in `tape` notes such as `Reuters reported`, `Nikkei verified`, `Yahoo showed`, `fallback chain`, or similar retrieval/process commentary. Keep the note focused on the market move itself.
   - This rule applies everywhere user-facing copy appears, not just `tape` notes: titles, headings, headlines, paragraphs, story bodies, stat labels, Renesas copy, crypto notes, ledes, and earnings text must not mention which source won, which source failed, or how the fallback chain behaved. Keep all source and retrieval/process commentary in `footer.compiled` only.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance or a live finance quote tool. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - WTI and Brent: CME/NYMEX or ICE where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used in `footer.compiled`.
   - Renesas `6723.T`: use this fallback chain in order and record the best verified Tokyo close: Yahoo Finance Japan -> Japan Exchange Group (JPX) -> Nikkei -> Traders Web -> Asset Alive.
   - For Renesas, do not stop after one fetch/tool failure; continue down the full source chain.
   - For Renesas, do not accept a stale trade date just because one source returned a quote. If the Tokyo session has already closed for the current Tokyo date and the retrieved trade date is still the prior session, continue down the fallback chain until you verify the latest Tokyo close or exhaust all listed sources.
   - If same-day Tokyo close is unavailable, use the latest available Tokyo close from the chain and include that trade date in the `note`/`renesas` text.
   - On Monday U.S. morning runs specifically, treat Friday `6723.T` data as stale once Monday Tokyo has closed; the default expectation is a Monday Tokyo close unless every source in the Renesas chain still lacks it.
   - Use `~` for Renesas only after two attempts per source across the full chain (10 total attempts) and state in `footer.compiled` that all sources failed retrieval.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2` first, then the Alternative.me Crypto Fear & Greed page if the API fails.
   - Do not publish F&G as `~`, `unavailable`, or a failed-pull note when either the API or page returns the current numeric reading and classification.
   - U.S. stock/ETF rows (including proxy rows such as `IBIT` and `MSTR`): use this fallback chain in order: Yahoo Finance -> Nasdaq -> MarketWatch.
   - Use `scripts/fetch_quotes.js` for deterministic stock/ETF chain runs with DNS preflight, two attempts per source, and structured attempt logs.
   - `scripts/fetch_quotes.js` writes/reads `scripts/quotes_last_verified.json`; if all three stock/ETF sources are unreachable due DNS/network outage, use last verified close from that cache with explicit trade date labeling and note the outage in `footer.compiled`.
   - Compatibility note: `scripts/fetch_proxy_closes.js` is a thin wrapper over `fetch_quotes.js` with defaults for `IBIT` and `MSTR` using the same `scripts/quotes_last_verified.json` cache.
   - For every quote row, follow its full fallback chain before `~`; if no same-day close is available, use the latest verified close and include the trade date in the row note.
   - Use `~` only after two attempts per source across that row's full source chain, and state in `footer.compiled` that all listed sources failed retrieval.

4. Search news after prices.
   - Use today and yesterday as explicit dates in every query.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
     - `Renesas Electronics [today] OR [yesterday]`
   - For the crypto section, try to pull up to six fresh crypto stories/items each day using targeted searches for BTC/ETH, ETF flows, stablecoins, regulation, exchange/issuer news, hacks/security, major protocol updates, institutional flows, and crypto market structure.
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, Japan semis, crypto regulation.
   - Discard any story without a publication date from today or yesterday.
   - Each `stories[]` item must include a direct `url` to the article, source page, or calendar page used for that item.

5. Rewrite the JSON sections in this order.
   - `masthead`: bump volume by 1, set `masthead.date` to current run date format, update subhead.
   - Set `footer.compiled` to match the same compile date as `masthead.date` and include the source list for all live fields.
   - `tape`: all refreshed closes.
   - `lede`: top market story from the latest close.
   - In copy fields such as `masthead.subhead`, `lede.headline`, `lede.paragraphs`, `stories[].body`, `renesas`, `crypto.notes[]`, and `earnings.tiles[]`, write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep source attribution and retrieval/process commentary out of all user-facing copy fields. Do not mention outlet names, quote vendors, source winners/losers, stale-source problems, API failures, fallback chains, or verification steps in titles, headings, headlines, paragraphs, notes, stat labels, or story bodies. Put that information only in `footer.compiled`.
   - Treat `record`, `all-time`, `fresh high`, `record close`, `record low`, and similar superlatives as claims that require explicit verification. If you did not verify the claim directly for that instrument and session, rewrite to a neutral description.
   - `stories`: 8-10 fresh stories across markets, corporate, macro, geopolitics, crypto, and Fed, each with a `url`.
   - In `stories[]`, keep publisher attribution out of the `title` and `body`. Put source attribution only in `footer.compiled`.
   - Do not include Renesas items in `stories` ("Across the Wires"); keep all Renesas coverage in the dedicated `renesas` section only.
   - Do not include placeholder stories that only say no update was found.
   - `renesas`: latest Tokyo price plus fresh news, or explicitly say no fresh company news was found.
   - `crypto`: refreshed crypto tape plus up to six fresh crypto notes/stories. Notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation; do not merely restate the crypto tape quotes.
   - Each `crypto.notes[]` item must include a direct `url` to the article, source page, API endpoint, or market page used for that note so the rendered card can show a `READ MORE` link like `stories[]`.
   - No static content in `crypto.notes`: rewrite the items daily from current sources, and do not keep evergreen explainers, placeholder updates, or unchanged notes just to fill the section.
  - `earnings`: reports from the past 48 hours and the next five calendar days.
  - For any company that reported after close on `yesterday` or `today`, replace schedule placeholders with actual reported data before publish (at minimum revenue, EPS, and guidance/reaction context when available).
  - Do not leave placeholder strings such as `after-close expected`, `after-close report`, or generic preview text for names that have already reported.
   - `weekAhead`: update on Mondays and Fridays.
   - `footer`: today’s compile date and every source used.

6. Validate before finishing.
   - Run `node scripts/validate_dashboard.js`.
   - Run `node scripts/test_dashboard_runtime.js`.
   - Run `node scripts/test_publish_timeouts.js`.
   - Run `node scripts/test_fetch_quotes_source_order.js`.
   - Run `node scripts/test_fetch_quotes_parsers.js`.
   - Run `node scripts/test_fetch_quotes_exit_behavior.js`.
   - Run `node scripts/test_validate_freshness_warning.js`.
   - Run `node scripts/test_validate_market_dates.js`.
   - Run a stale-date guard on the run fields:
     - `rg -n "\"masthead\"|\"compiled\"|January 1|2001" daily_financial_news.html`
     - If `masthead.date` or `footer.compiled` contains yesterday/default/placeholder text, edit JSON again before proceeding.
   - Run an HTML-entity guard on human-readable copy:
     - `rg -n "&amp;|&lt;|&gt;" daily_financial_news.html`
     - If matches appear in normal text fields rather than intentional markup, replace them with plain characters before proceeding.
   - Run `git diff --check`.
   - Run a superlative-claim gate on user-facing copy:
     - `rg -n "record|all-time|fresh high|new high|record close|record low" daily_financial_news.html`
     - For every match in user-facing copy, either confirm the claim from a direct source for that instrument/session or rewrite it to neutral wording before proceeding.
   - Manually confirm that any non-U.S. listing uses the latest local-market close available for that market date. Example: if the run happens after Tokyo cash close, verify that `6723.T` is not still showing the prior Tokyo session unless the fallback notes explicitly document why newer data was unavailable.
   - Run a quick placeholder gate for completed reports (example):
     - `rg -n "after-close expected|after-close report" daily_financial_news.html`
     - If matches refer to companies that already reported in the last 48 hours, backfill those tiles with actual results.
   - Confirm only intended files changed.

7. Commit and publish.
   - Commit directly on `main`.
   - After each dashboard update commit, run `./scripts/publish_main.sh` (preflight + bounded retry + push + GitHub Pages deployment verification).
   - The publish script now polls the `pages build and deployment` run for the pushed SHA and verifies live page markers (`masthead.date`, `masthead.volume`) at the GitHub Pages URL.
   - If Pages fails due to a transient `actions/deploy-pages` fetch/download failure, the script auto-retries once by creating an empty retrigger commit and pushing again.
   - Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.
