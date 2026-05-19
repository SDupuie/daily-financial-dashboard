#!/usr/bin/env bash

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
MAX_RETRIES="${MAX_RETRIES:-1}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-2}"

is_dns_error() {
  local msg="$1"
  case "$msg" in
    *"Could not resolve host"*|*"Temporary failure in name resolution"*|*"Name or service not known"*|*"nodename nor servname provided, or not known"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

run_remote_preflight() {
  local output
  if output="$(git ls-remote "$REMOTE" -h "refs/heads/$BRANCH" 2>&1)"; then
    return 0
  fi

  echo "Remote preflight failed for $REMOTE/$BRANCH." >&2
  echo "$output" >&2
  if is_dns_error "$output"; then
    return 2
  fi
  return 1
}

attempt_push() {
  local output
  if output="$(git push "$REMOTE" "$BRANCH" 2>&1)"; then
    echo "$output"
    return 0
  fi

  echo "$output" >&2
  if is_dns_error "$output"; then
    return 2
  fi
  return 1
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

retry_count=0

while true; do
  preflight_rc=0
  run_remote_preflight || preflight_rc=$?

  if [[ "$preflight_rc" -eq 0 ]]; then
    break
  fi

  if [[ "$preflight_rc" -eq 2 && "$retry_count" -lt "$MAX_RETRIES" ]]; then
    retry_count=$((retry_count + 1))
    echo "DNS/network preflight issue; retrying ($retry_count/$MAX_RETRIES) in ${RETRY_DELAY_SECONDS}s..." >&2
    sleep "$RETRY_DELAY_SECONDS"
    continue
  fi

  if [[ "$preflight_rc" -eq 2 ]]; then
    echo "Preflight failed due to DNS/network resolution. If you are in a restricted sandbox, rerun with elevated network permissions." >&2
  fi
  exit 1
done

retry_count=0
while true; do
  push_rc=0
  attempt_push || push_rc=$?

  if [[ "$push_rc" -eq 0 ]]; then
    break
  fi

  if [[ "$push_rc" -eq 2 && "$retry_count" -lt "$MAX_RETRIES" ]]; then
    retry_count=$((retry_count + 1))
    echo "DNS/network push issue; retrying ($retry_count/$MAX_RETRIES) in ${RETRY_DELAY_SECONDS}s..." >&2
    sleep "$RETRY_DELAY_SECONDS"
    continue
  fi

  if [[ "$push_rc" -eq 2 ]]; then
    echo "Push failed due to DNS/network resolution. If you are in a restricted sandbox, rerun with elevated network permissions." >&2
  fi
  exit 1
done

status_line="$(git status --short --branch | head -n 1)"
echo "$status_line"
if [[ "$status_line" == *"[ahead "* ]]; then
  echo "Push completed but local branch still appears ahead. Verify remote state." >&2
  exit 1
fi
