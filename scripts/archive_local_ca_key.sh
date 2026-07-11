#!/usr/bin/env bash

set -euo pipefail

TLS_DIR="${TLS_DIR:-$HOME/.daily-financial-dashboard/tls}"
ARCHIVE_DIR="${CA_ARCHIVE_DIR:-$HOME/.daily-financial-dashboard/ca-archive}"
CA_KEY="$TLS_DIR/local-market-ca-key.pem"
CA_CERT="$TLS_DIR/local-market-ca-cert.pem"
ARCHIVE_KEY="$ARCHIVE_DIR/local-market-ca-key.encrypted.pem"
KEYCHAIN_SERVICE="Daily Financial Dashboard Local CA Archive"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [[ ! -f "$CA_KEY" || ! -f "$CA_CERT" ]]; then
  echo "Expected the CA certificate and plaintext key in $TLS_DIR." >&2
  exit 1
fi
if [[ -e "$ARCHIVE_KEY" ]]; then
  echo "Refusing to overwrite existing CA archive: $ARCHIVE_KEY" >&2
  exit 1
fi

mkdir -p "$ARCHIVE_DIR"
chmod 0700 "$ARCHIVE_DIR"

keychain_updated=false
cleanup_on_exit() {
  status=$?
  trap - EXIT
  unset CA_ARCHIVE_PASSWORD archive_password
  if [[ "$status" -ne 0 ]]; then
    rm -f "$ARCHIVE_KEY"
    if [[ "$keychain_updated" == true ]]; then
      security delete-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

archive_password="$(openssl rand -base64 48)"
export CA_ARCHIVE_PASSWORD="$archive_password"
openssl pkcs8 -topk8 -v2 aes-256-cbc -iter 250000 \
  -in "$CA_KEY" \
  -out "$ARCHIVE_KEY" \
  -passout env:CA_ARCHIVE_PASSWORD
chmod 0600 "$ARCHIVE_KEY"

security add-generic-password -U \
  -a "$USER" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$archive_password" \
  "$LOGIN_KEYCHAIN" >/dev/null
keychain_updated=true

cert_fingerprint="$(openssl x509 -in "$CA_CERT" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
archive_fingerprint="$(openssl pkey -in "$ARCHIVE_KEY" -passin env:CA_ARCHIVE_PASSWORD -pubout -outform DER | openssl dgst -sha256)"
if [[ "$cert_fingerprint" != "$archive_fingerprint" ]]; then
  echo "Encrypted CA archive does not match the trusted CA certificate; plaintext key was retained." >&2
  exit 1
fi

unset CA_ARCHIVE_PASSWORD archive_password
rm "$CA_KEY"
trap - EXIT
echo "Archived the CA key at $ARCHIVE_KEY and removed the plaintext live copy."
