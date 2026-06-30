# Daily Financial Dashboard

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

## Maintained File

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `scripts/`: operational fetch, validation, and publish helpers.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

## Update Cadence

Update `daily_financial_news.html` each market morning around 7:00 AM Central, before the U.S. open. Edit only the JSON inside:

```html
<!-- ============ DATA START — edit this block to update the dashboard ============ -->
...
<!-- ============ DATA END ============ -->
```

Do not touch the HTML, CSS, or JavaScript outside that block for a daily dashboard refresh.

Production is self-contained: the rendered dashboard reads only the embedded `dashboard-data` JSON block. Helper scripts may generate staging JSON snippets, but no production section should fetch sidecar JSON files at runtime.

## Daily Update Runbook

1. Confirm dates first.
   - `masthead.date`: today.
   - `footer.compiled`: must include today’s compile date.
   - Never allow stale values such as `January 1`, year `2001`, or a prior-day compile date in `masthead.date` or `footer.compiled`.
   - `tape.label`: current market-record context.
   - If today is Monday or Friday, update `weekAhead`; otherwise leave `weekAhead` mostly unchanged unless a scheduled event has moved.

2. Refresh prices before reading news.
   - Never reuse prices already in the file.
   - Use exact retrieved prices. Use `~` only after exhausting that row's source hierarchy with two attempts per source.
   - For stock/ETF quotes, use `node scripts/fetch_quotes.js --symbols IBIT:etf,MSTR:stock` or add the symbols needed for the run.
   - For pre-market futures, asset-allocation ETF rows, and cross-asset extras, helper scripts can generate staging JSON under `scripts/generated/`. Merge their final output into the embedded data block before publish.
   - Production data that must be embedded daily includes `preMarket.futures`, `preMarket.stories`, `assetAllocationPortfolio.rows`, and all rows needed by `tape.rows`.
   - In each `tape.rows[].note`, summarize the relevant market commentary or catalyst driving that market. Do not restate `last`, `delta`, or `pct`.
   - Do not name quote/news sources in visible copy. Keep source attribution and retrieval/process commentary in `footer.compiled`.
   - Do not use source-verification phrasing such as `Reuters reported`, `Yahoo showed`, `fallback chain`, or similar process commentary in user-facing text.
   - Do not use market-superlative language such as `record`, `all-time`, `fresh high`, `new high`, `record close`, or `record low` unless that exact claim was directly verified for that instrument and session.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance or a live finance quote tool; cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - International indexes such as MSCI EAFE and MSCI EM: official MSCI pages/endpoints first, then clearly labeled high-confidence backups.
   - Real estate and broad commodity indexes: official index families or Yahoo/MarketWatch quote pages when available.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - Rates volatility and bond proxies: use the configured dashboard source or ETF quote source and label proxy rows clearly.
   - WTI: CME/NYMEX where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used in `footer.compiled`.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2` first, then the Alternative.me page if the API fails.
   - Asset Allocation Portfolio rows: instrument-level ETF market data only. Do not import or recreate tactical allocation/model logic from the separate Asset Allocation Dashboard.
   - For every quote row, follow its full fallback chain before `~`; if no same-day close is available, use the latest verified close and make the trade date clear in the row or footer.

4. Search news after prices.
   - Use today and yesterday as explicit dates in every query.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - `premarket futures [today]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, semis/AI, crypto regulation, ETF flows, stablecoins, hacks/security, protocol updates, and market structure.
   - Discard any story without a publication date from today or yesterday unless it is a standing calendar/source page.
   - Each `stories[]`, `preMarket.stories[]`, and `crypto.notes[]` item must include a direct `url`.
   - Do not repeat promoted `preMarket.stories[]` items in `stories[]`; use What’s Moving Today for additional market breadth.
   - For any `url` that renders as `READ MORE`, prefer a reader-facing article or HTML page, not a raw API/feed/download endpoint.
   - Do not use machine-readable endpoints such as `query1.finance.yahoo.com`, `api.nasdaq.com`, JSON APIs, CSV downloads, or other raw data feeds as `READ MORE` links.

5. Rewrite the JSON sections in this order.
   - `masthead`: bump volume by 1 and set `masthead.date`.
   - `opening`: update `headline`, `deck`, and four concise catalyst items.
   - `preMarket`: embed four futures rows and the top one to three priority overnight stories.
   - `tape`: refresh all required cross-asset rows and commentary.
   - `assetAllocationPortfolio`: embed instrument-level ETF rows with price, MTD dividend, daily return, and MTD return.
   - `stories`: 8-10 fresh stories across markets, corporate, macro, geopolitics, crypto, Fed, and earnings.
   - `crypto`: refreshed crypto quote rows, Crypto Market Cap stat, Fear & Greed stat, and up to six fresh crypto notes/stories.
   - `earnings`: reports from the past 48 hours and the next five calendar days.
   - `weekAhead`: update on Mondays and Fridays.
   - `footer`: today’s compile date and concise source-family attribution.
   - Remove legacy sections that are not rendered, such as `lede` and `renesas`.

6. Copy and tone rules.
   - Write normal text characters rather than HTML entity escapes unless actual markup is intended. Example: use `S&P`, not `S&amp;P`.
   - Keep publisher attribution out of story titles and bodies. Put source attribution only in `footer.compiled`.
   - Do not write tautological market-status copy that states routine facts without saying why they matter.
   - Crypto notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation.
   - Do not merely restate quote rows in notes or story bodies.
   - Earnings color rule: use muted styling for consensus/pending estimates, neutral styling for reported fundamentals such as EPS/revenue/guidance, and red/green only for market reactions or clearly labeled beat/miss surprises. When practical, set `moveRole` or `moveType` to `pending`, `reported`, `guidance`, `marketReaction`, or `surprise`.

7. Validate before finishing.
   - Run `node scripts/validate_dashboard.js daily_financial_news.html`.
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
