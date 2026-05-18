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
   - If today is Monday, update `weekAhead`; otherwise leave `weekAhead` mostly unchanged unless a scheduled event has moved.

2. Refresh prices before reading news.
   - Never reuse prices already in the file.
   - Use exact retrieved prices. Use `~` only when no source returns data after two attempts.
   - In each `tape.rows[].note`, summarize the most relevant market catalyst for that line item (and include pre-market context when useful).
   - Do not use `tape` notes as source citations. Keep all source attribution in `footer.compiled`.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance or a live finance quote tool. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - WTI and Brent: CME/NYMEX or ICE where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used.
   - Renesas `6723.T`: Yahoo Finance Japan, Japan Exchange Group, Nikkei, Traders Web, or Asset Alive. Use Tokyo close.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Crypto Fear & Greed: Alternative.me.
   - ETF/proxy rows such as `IBIT` and `MSTR`: Yahoo Finance, Nasdaq, or MarketWatch.

4. Search news after prices.
   - Use today and yesterday as explicit dates in every query.
   - Start with:
     - `stock market news [today] OR [yesterday]`
     - `earnings [today] OR [yesterday]`
     - `crypto bitcoin [today] OR [yesterday]`
     - `Renesas Electronics [today] OR [yesterday]`
   - Add targeted searches only for gaps: Fed, oil, geopolitics, major earnings, Japan semis, crypto regulation.
   - Discard any story without a publication date from today or yesterday.

5. Rewrite the JSON sections in this order.
   - `masthead`: bump volume by 1, update date and subhead.
   - `tape`: all refreshed closes.
   - `lede`: top market story from the latest close.
   - `stories`: 8-10 fresh stories across markets, corporate, macro, geopolitics, crypto, Fed, and Renesas.
   - Do not include placeholder stories that only say no update was found.
   - `renesas`: latest Tokyo price plus fresh news, or explicitly say no fresh company news was found.
   - `crypto`: refreshed crypto tape plus four notes.
   - `earnings`: reports from the past 48 hours and the next five calendar days.
   - `weekAhead`: update on Mondays.
   - `footer`: today’s compile date and every source used.

6. Validate before finishing.
   - Parse the embedded JSON.
   - Run `git diff --check`.
   - Confirm only intended files changed.

7. Commit and publish.
   - Commit directly on `main`.
   - After each dashboard update commit, run `git push origin main`.
   - Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.
