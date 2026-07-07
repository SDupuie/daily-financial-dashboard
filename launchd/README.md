# LaunchAgent Template

This folder contains the tracked backup template for the optional local market refresh helper. It documents the known launch configuration, but it does not indicate whether the agent is installed or currently active.

- `com.scott.daily-financial-dashboard.plist` runs `scripts/local_market_server.js` with Node on port `2210`.
- The server binds to `127.0.0.1` only and exposes `GET /health` plus `GET /api/market-refresh`.
- `GET /api/market-refresh` now returns quote-row staging, chart series, and `cryptoStats` staging for the `crypto.stats[]` cards.
- Logs are written to `~/Library/Logs/DailyFinancialDashboard/`.

Install or refresh the LaunchAgent:

```sh
mkdir -p "$HOME/Library/Logs/DailyFinancialDashboard"
cp "launchd/com.scott.daily-financial-dashboard.plist" "$HOME/Library/LaunchAgents/com.scott.daily-financial-dashboard.plist"
launchctl bootout "gui/$UID/com.scott.daily-financial-dashboard" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.scott.daily-financial-dashboard.plist"
launchctl kickstart -k "gui/$UID/com.scott.daily-financial-dashboard"
```

Check it:

```sh
launchctl print "gui/$UID/com.scott.daily-financial-dashboard"
curl http://127.0.0.1:2210/health
```

Unload it:

```sh
launchctl bootout "gui/$UID/com.scott.daily-financial-dashboard"
```

After editing the plist or the server path, copy the updated plist into `~/Library/LaunchAgents/` and run the refresh commands again.
