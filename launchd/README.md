# LaunchAgent Template

This folder contains the tracked backup template for the optional local market refresh helper. It documents the known launch configuration, but it does not indicate whether the agent is installed or currently active.

- `com.scott.daily-financial-dashboard.plist` runs `scripts/local_market_server.js` with Node over HTTPS on port `2210`.
- The server binds to the Mac Mini's reserved primary-LAN address `192.168.2.2`, loads its dedicated certificate and private key from `~/.daily-financial-dashboard/tls/`, and exposes `GET /health` plus `GET /api/market-refresh`.
- Browser requests are accepted only from `https://sdupuie.github.io` and local HTTP(S) development origins; other browser origins receive `403`.
- `GET /api/market-refresh` now returns quote-row staging, chart series, and `cryptoStats` staging for the `crypto.stats[]` cards.
- Logs are written to `~/Library/Logs/DailyFinancialDashboard/`.

The helper requires a dedicated leaf certificate signed by a private CA trusted on each client. It must contain `IP:192.168.2.2` (plus the loopback names used for direct diagnostics), be marked `CA:FALSE`, and use the paths recorded in the plist. Keep both CA and server private keys at mode `0600`; no TLS file belongs in this repository. Install only the CA certificate—not either private key—on the iPhone and enable full trust for it. Renew the leaf certificate before its expiration date.

Serve local dashboard QA from a localhost HTTP(S) origin. Direct `file://` pages send the opaque `null` origin and are intentionally not allowed.

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
curl --cacert "$HOME/.daily-financial-dashboard/tls/local-market-ca-cert.pem" https://192.168.2.2:2210/health
```

Unload it:

```sh
launchctl bootout "gui/$UID/com.scott.daily-financial-dashboard"
```

After editing the plist or the server path, copy the updated plist into `~/Library/LaunchAgents/` and run the refresh commands again. After editing `scripts/local_market_server.js` without changing the plist, run `launchctl kickstart -k "gui/$UID/com.scott.daily-financial-dashboard"` so the running helper loads the new code.
