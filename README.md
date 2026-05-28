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
   - `tape.label`: most recent market close, usually the prior weekday.
   - If today is Monday or Friday, update `weekAhead`; otherwise leave `weekAhead` mostly unchanged unless a scheduled event has moved.

2. Refresh prices before reading news.
   - Never reuse prices already in the file.
   - Use exact retrieved prices. Use `~` only after exhausting that row's source hierarchy with two attempts per source.
   - In each `tape.rows[].note`, summarize only the relevant market commentary, catalyst, or major news snippet for that line item (and include pre-market context when useful).
   - Do not restate the row's last price, point change, or percent change in `tape.rows[].note`; those belong only in `last`, `delta`, and `pct`.
   - Do not name quote/news sources in `tape` notes. Keep all source attribution in `footer.compiled`.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance or a live finance quote tool. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - WTI and Brent: CME/NYMEX or ICE where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used in `footer.compiled`.
   - Renesas `6723.T`: use this fallback chain in order and record the best verified Tokyo close: Yahoo Finance Japan -> Japan Exchange Group (JPX) -> Nikkei -> Traders Web -> Asset Alive.
   - For Renesas, do not stop after one fetch/tool failure; continue down the full source chain.
   - If same-day Tokyo close is unavailable, use the latest available Tokyo close from the chain and include that trade date in the `note`/`renesas` text.
   - Use `~` for Renesas only after two attempts per source across the full chain (10 total attempts) and state in `footer.compiled` that all sources failed retrieval.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Crypto Fear & Greed: Alternative.me API endpoint `https://api.alternative.me/fng/?limit=2` first, then the Alternative.me Crypto Fear & Greed page if the API fails.
   - Do not publish F&G as `~`, `unavailable`, or a failed-pull note when either the API or page returns the current numeric reading and classification.
   - ETF/proxy rows such as `IBIT` and `MSTR`: use this fallback chain in order: Yahoo Finance -> Nasdaq -> MarketWatch.
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
   - `masthead`: bump volume by 1, update date and subhead.
   - `tape`: all refreshed closes.
   - `lede`: top market story from the latest close.
   - `stories`: 8-10 fresh stories across markets, corporate, macro, geopolitics, crypto, and Fed, each with a `url`.
   - Do not include Renesas items in `stories` ("Across the Wires"); keep all Renesas coverage in the dedicated `renesas` section only.
   - Do not include placeholder stories that only say no update was found.
   - `renesas`: latest Tokyo price plus fresh news, or explicitly say no fresh company news was found.
   - `crypto`: refreshed crypto tape plus up to six fresh crypto notes/stories. Notes should add current news context such as ETF flows, regulation, sentiment, market structure, security events, protocol updates, exchange/issuer developments, or proxy-equity interpretation; do not merely restate the crypto tape quotes.
   - No static content in `crypto.notes`: rewrite the items daily from current sources, and do not keep evergreen explainers, placeholder updates, or unchanged notes just to fill the section.
  - `earnings`: reports from the past 48 hours and the next five calendar days.
  - For any company that reported after close on `yesterday` or `today`, replace schedule placeholders with actual reported data before publish (at minimum revenue, EPS, and guidance/reaction context when available).
  - Do not leave placeholder strings such as `after-close expected`, `after-close report`, or generic preview text for names that have already reported.
   - `weekAhead`: update on Mondays and Fridays.
   - `footer`: today’s compile date and every source used.

6. Validate before finishing.
   - Run `node scripts/validate_dashboard.js`.
   - Run `git diff --check`.
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
