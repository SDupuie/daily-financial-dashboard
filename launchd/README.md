# LaunchAgent Template

This folder contains the tracked backup template for the optional local market refresh helper. It documents the known launch configuration, but it does not indicate whether the agent is installed or currently active.

- `com.scott.daily-financial-dashboard.plist` runs `scripts/local_market_server.js` with Node over HTTPS on port `2210`.
- The server binds to the Mac Mini's reserved primary-LAN address `192.168.2.2`, loads its dedicated certificate and private key from `~/.daily-financial-dashboard/tls/`, and exposes `GET /health` plus `GET /api/market-refresh`.
- Browser requests are accepted only from `https://sdupuie.github.io` and local HTTP(S) development origins; other browser origins receive `403`.
- `GET /api/market-refresh` now returns quote-row staging, chart series, and `cryptoStats` staging for the `crypto.stats[]` cards.
- Logs are written to `~/Library/Logs/DailyFinancialDashboard/`.

The helper requires a dedicated leaf certificate signed by a private CA trusted on each client. The tracked `local-market-ca.cnf` and `local-market-server.cnf` templates enforce the intended constraints: the root is `CA:TRUE`; the leaf is `CA:FALSE`, is restricted to TLS server authentication, and covers `192.168.2.2`, `localhost`, `127.0.0.1`, and `::1`. No certificate or private key belongs in Git.

### Initial TLS provisioning

Create a new CA only for an initial installation or intentional CA rotation. Existing clients must install the replacement CA after a rotation.

```sh
TLS_DIR="$HOME/.daily-financial-dashboard/tls"
mkdir -p "$TLS_DIR"

openssl genrsa -out "$TLS_DIR/local-market-ca-key.pem" 3072
openssl req -x509 -new -sha256 \
  -key "$TLS_DIR/local-market-ca-key.pem" \
  -out "$TLS_DIR/local-market-ca-cert.pem" \
  -days 3650 \
  -config launchd/local-market-ca.cnf

openssl genrsa -out "$TLS_DIR/local-market-key.pem" 2048
openssl req -new -sha256 \
  -key "$TLS_DIR/local-market-key.pem" \
  -out "$TLS_DIR/local-market.csr" \
  -config launchd/local-market-server.cnf
openssl x509 -req -sha256 \
  -in "$TLS_DIR/local-market.csr" \
  -CA "$TLS_DIR/local-market-ca-cert.pem" \
  -CAkey "$TLS_DIR/local-market-ca-key.pem" \
  -CAcreateserial \
  -out "$TLS_DIR/local-market-cert.pem" \
  -days 397 \
  -extfile launchd/local-market-server.cnf \
  -extensions v3_req

openssl x509 -in "$TLS_DIR/local-market-ca-cert.pem" -outform der \
  -out "$TLS_DIR/Daily-Financial-Dashboard-Local-CA.cer"
rm "$TLS_DIR/local-market.csr" "$TLS_DIR/local-market-ca-cert.srl"
chmod 0600 "$TLS_DIR/local-market-ca-key.pem" "$TLS_DIR/local-market-key.pem"
chmod 0644 "$TLS_DIR/local-market-ca-cert.pem" "$TLS_DIR/local-market-cert.pem" \
  "$TLS_DIR/Daily-Financial-Dashboard-Local-CA.cer"

security add-trusted-cert -d -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$TLS_DIR/local-market-ca-cert.pem"
./scripts/archive_local_ca_key.sh
```

`archive_local_ca_key.sh` encrypts the CA key with AES-256, stores a random archive password in the login Keychain under `Daily Financial Dashboard Local CA Archive`, writes the encrypted key to `~/.daily-financial-dashboard/ca-archive/`, verifies it against the CA certificate, and only then removes the plaintext CA key from the live TLS directory. Copy the encrypted archive to offline backup media for stronger recovery protection. Before relying on that copy for disaster recovery, retrieve the archive password with `security find-generic-password -a "$USER" -s "Daily Financial Dashboard Local CA Archive" -w` and save it in a password manager separately from the archive. The running helper needs only the CA certificate plus the server certificate and server key.

### iPhone trust and browser permission

AirDrop only `Daily-Financial-Dashboard-Local-CA.cer` to the iPhone; never transfer a private key. Install it under **Settings → General → VPN & Device Management**, then enable **Daily Financial Dashboard Local CA** under **Settings → General → About → Certificate Trust Settings**. Verify `https://192.168.2.2:2210/health` in Safari. When the GitHub Pages dashboard first requests the helper, allow `sdupuie.github.io` to access devices on the local network. Blocking that permission disables only local refresh; embedded dashboard data remains available.

### Leaf-certificate renewal

Renew the leaf before it expires without rotating the trusted CA:

```sh
TLS_DIR="$HOME/.daily-financial-dashboard/tls"
ARCHIVE_KEY="$HOME/.daily-financial-dashboard/ca-archive/local-market-ca-key.encrypted.pem"
TEMP_CA_KEY="$(mktemp)"
export CA_ARCHIVE_PASSWORD="$(security find-generic-password \
  -a "$USER" -s "Daily Financial Dashboard Local CA Archive" -w)"

openssl pkcs8 -in "$ARCHIVE_KEY" -passin env:CA_ARCHIVE_PASSWORD -out "$TEMP_CA_KEY"
openssl req -new -sha256 \
  -key "$TLS_DIR/local-market-key.pem" \
  -out "$TLS_DIR/local-market.csr" \
  -config launchd/local-market-server.cnf
openssl x509 -req -sha256 \
  -in "$TLS_DIR/local-market.csr" \
  -CA "$TLS_DIR/local-market-ca-cert.pem" \
  -CAkey "$TEMP_CA_KEY" \
  -CAcreateserial \
  -out "$TLS_DIR/local-market-cert.pem" \
  -days 397 \
  -extfile launchd/local-market-server.cnf \
  -extensions v3_req

rm "$TEMP_CA_KEY" "$TLS_DIR/local-market.csr" "$TLS_DIR/local-market-ca-cert.srl"
unset CA_ARCHIVE_PASSWORD
chmod 0600 "$TLS_DIR/local-market-key.pem"
chmod 0644 "$TLS_DIR/local-market-cert.pem"
launchctl kickstart -k "gui/$UID/com.scott.daily-financial-dashboard"
```

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

The exact browser-origin allowlist is a CORS boundary, not authentication. Origin-less command-line clients on the trusted LAN can call the read-only endpoints. Keep guest-to-primary-LAN routing blocked and never forward port `2210` from the WAN.

Unload it:

```sh
launchctl bootout "gui/$UID/com.scott.daily-financial-dashboard"
```

After editing the plist or the server path, copy the updated plist into `~/Library/LaunchAgents/` and run the refresh commands again. After editing `scripts/local_market_server.js` without changing the plist, run `launchctl kickstart -k "gui/$UID/com.scott.daily-financial-dashboard"` so the running helper loads the new code.
