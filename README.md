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
   - In each `tape.rows[].note`, summarize the most relevant market catalyst for that line item (and include pre-market context when useful).
   - Do not use `tape` notes as source citations. Keep all source attribution in `footer.compiled`.

3. Use this price-source hierarchy.
   - U.S. indices and equities: Yahoo Finance or a live finance quote tool. Cross-check major index closes with AP, CNBC, Reuters, MarketWatch, or TradingView when available.
   - Treasury yields: Treasury.gov daily rates first; Trading Economics or CNBC as backup.
   - WTI and Brent: CME/NYMEX or ICE where available; MarketWatch, Trading Economics, or Reuters as backup.
   - Gold and silver: GoldPrice.org spot close or MarketWatch futures close. State which one is used.
   - Renesas `6723.T`: use this fallback chain in order and record the best verified Tokyo close: Yahoo Finance Japan -> Japan Exchange Group (JPX) -> Nikkei -> Traders Web -> Asset Alive.
   - For Renesas, do not stop after one fetch/tool failure; continue down the full source chain.
   - If same-day Tokyo close is unavailable, use the latest available Tokyo close from the chain and include that trade date in the `note`/`renesas` text.
   - Use `~` for Renesas only after two attempts per source across the full chain (10 total attempts) and explicitly state that all sources failed retrieval.
   - Crypto majors: CoinGecko or CoinMarketCap.
   - Total crypto market cap: CoinGecko global market, CoinMarketCap global charts, or CoinGlance.
   - Crypto Fear & Greed: Alternative.me.
   - ETF/proxy rows such as `IBIT` and `MSTR`: use this fallback chain in order: Yahoo Finance -> Nasdaq -> MarketWatch.
   - For every quote row, follow its full fallback chain before `~`; if no same-day close is available, use the latest verified close and include the trade date in the row note.
   - Use `~` only after two attempts per source across that row's full source chain, and state in the note/footer that all listed sources failed retrieval.

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
   - `stories`: 8-10 fresh stories across markets, corporate, macro, geopolitics, crypto, and Fed.
   - Do not include Renesas items in `stories` ("Across the Wires"); keep all Renesas coverage in the dedicated `renesas` section only.
   - Do not include placeholder stories that only say no update was found.
   - `renesas`: latest Tokyo price plus fresh news, or explicitly say no fresh company news was found.
   - `crypto`: refreshed crypto tape plus four notes.
   - `earnings`: reports from the past 48 hours and the next five calendar days.
   - `weekAhead`: update on Mondays and Fridays.
   - `footer`: today’s compile date and every source used.

6. Validate before finishing.
   - Parse the embedded JSON.
   - Run `git diff --check`.
   - Confirm only intended files changed.

7. Commit and publish.
   - Commit directly on `main`.
   - After each dashboard update commit, run `./scripts/publish_main.sh` (preflight + bounded retry + push).
   - Confirm `git status --short --branch` no longer shows local commits ahead of `origin/main`.
