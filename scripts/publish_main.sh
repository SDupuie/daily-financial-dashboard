#!/usr/bin/env bash

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
MAX_RETRIES="${MAX_RETRIES:-1}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-2}"
MAX_PUSH_TRANSIENT_RETRIES="${MAX_PUSH_TRANSIENT_RETRIES:-2}"
NETWORK_READY_ATTEMPTS="${NETWORK_READY_ATTEMPTS:-6}"
NETWORK_READY_DELAY_SECONDS="${NETWORK_READY_DELAY_SECONDS:-5}"
WAKE_LOCK_ENABLED="${WAKE_LOCK_ENABLED:-1}"
PAGES_VERIFY_ENABLED="${PAGES_VERIFY_ENABLED:-1}"
PAGES_RETRIGGER_MAX="${PAGES_RETRIGGER_MAX:-1}"
PAGES_POLL_ATTEMPTS="${PAGES_POLL_ATTEMPTS:-24}"
PAGES_POLL_SECONDS="${PAGES_POLL_SECONDS:-10}"
PAGES_WORKFLOW_NAME="${PAGES_WORKFLOW_NAME:-pages build and deployment}"
PAGES_FILE_PATH="${PAGES_FILE_PATH:-daily_financial_news.html}"
CURL_CONNECT_TIMEOUT_SECONDS="${CURL_CONNECT_TIMEOUT_SECONDS:-10}"
CURL_MAX_TIME_SECONDS="${CURL_MAX_TIME_SECONDS:-30}"

maybe_enable_wake_lock() {
  if [[ "$WAKE_LOCK_ENABLED" != "1" ]]; then
    return 0
  fi

  if [[ -n "${PUBLISH_MAIN_CAFFEINATED:-}" ]]; then
    return 0
  fi

  if ! command -v caffeinate >/dev/null 2>&1; then
    echo "Wake lock skipped: caffeinate not found on this system." >&2
    return 0
  fi

  echo "Enabling macOS wake lock for publish run (caffeinate)." >&2
  export PUBLISH_MAIN_CAFFEINATED=1
  exec caffeinate -dimsu "$0" "$@"
}

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

is_retryable_push_error() {
  local msg="$1"
  case "$msg" in
    *"fatal error in commit_refs"*|*"The remote end hung up unexpectedly"*|*"HTTP 502"*|*"HTTP 503"*|*"Service Unavailable"*)
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
  if is_retryable_push_error "$output"; then
    return 3
  fi
  return 1
}

push_with_retry() {
  local dns_retry_count=0
  local transient_retry_count=0
  while true; do
    local push_rc=0
    attempt_push || push_rc=$?

    if [[ "$push_rc" -eq 0 ]]; then
      return 0
    fi

    if [[ "$push_rc" -eq 2 && "$dns_retry_count" -lt "$MAX_RETRIES" ]]; then
      dns_retry_count=$((dns_retry_count + 1))
      echo "DNS/network push issue; retrying ($dns_retry_count/$MAX_RETRIES) in ${RETRY_DELAY_SECONDS}s..." >&2
      sleep "$RETRY_DELAY_SECONDS"
      continue
    fi

    if [[ "$push_rc" -eq 3 && "$transient_retry_count" -lt "$MAX_PUSH_TRANSIENT_RETRIES" ]]; then
      transient_retry_count=$((transient_retry_count + 1))
      echo "Transient remote push issue; retrying ($transient_retry_count/$MAX_PUSH_TRANSIENT_RETRIES) in ${RETRY_DELAY_SECONDS}s..." >&2
      sleep "$RETRY_DELAY_SECONDS"
      continue
    fi

    if [[ "$push_rc" -eq 2 ]]; then
      echo "Push failed due to DNS/network resolution. If you are in a restricted sandbox, rerun with elevated network permissions." >&2
    elif [[ "$push_rc" -eq 3 ]]; then
      echo "Push failed after transient remote retries; check GitHub status and rerun." >&2
    fi
    return 1
  done
}

wait_for_network_ready() {
  local attempt=1
  while [[ "$attempt" -le "$NETWORK_READY_ATTEMPTS" ]]; do
    local rc=0
    run_remote_preflight || rc=$?

    if [[ "$rc" -eq 0 ]]; then
      return 0
    fi

    if [[ "$rc" -eq 2 ]]; then
      echo "Network not ready for ${REMOTE}/${BRANCH} (${attempt}/${NETWORK_READY_ATTEMPTS}); waiting ${NETWORK_READY_DELAY_SECONDS}s..." >&2
      sleep "$NETWORK_READY_DELAY_SECONDS"
      attempt=$((attempt + 1))
      continue
    fi

    return "$rc"
  done

  return 2
}

github_api_get() {
  local url="$1"
  local -a args
  args=(curl -fsSL --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS" -H "Accept: application/vnd.github+json")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  args+=("$url")
  "${args[@]}"
}

parse_github_remote() {
  local remote_url
  remote_url="$(git remote get-url "$REMOTE")"

  if [[ "$remote_url" =~ ^https?://github\.com/([^/]+)/([^/]+?)(\.git)?$ ]]; then
    GITHUB_OWNER="${BASH_REMATCH[1]}"
    GITHUB_REPO="${BASH_REMATCH[2]}"
    return 0
  fi

  if [[ "$remote_url" =~ ^git@github\.com:([^/]+)/([^/]+?)(\.git)?$ ]]; then
    GITHUB_OWNER="${BASH_REMATCH[1]}"
    GITHUB_REPO="${BASH_REMATCH[2]}"
    return 0
  fi

  return 1
}

build_pages_url() {
  if [[ "${GITHUB_REPO}" == "${GITHUB_OWNER}.github.io" ]]; then
    echo "https://${GITHUB_REPO}/${PAGES_FILE_PATH}"
  else
    echo "https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}/${PAGES_FILE_PATH}"
  fi
}

extract_dashboard_markers() {
  node -e '
const fs = require("fs");
const html = fs.readFileSync("daily_financial_news.html", "utf8");
const m = html.match(/<script type="application\/json" id="dashboard-data">\n([\s\S]*?)\n<\/script>/);
if (!m) process.exit(1);
const data = JSON.parse(m[1]);
const date = (data.masthead && data.masthead.date) || "";
const volume = (data.masthead && data.masthead.volume) || "";
if (!date || !volume) process.exit(1);
process.stdout.write(`${date}\t${volume}`);
'
}

fetch_pages_run_for_sha() {
  local sha="$1"
  local runs_json
  runs_json="$(github_api_get "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=30")" || return 1

  TARGET_SHA="$sha" WF_NAME="$PAGES_WORKFLOW_NAME" node -e '
const fs = require("fs");
const targetSha = process.env.TARGET_SHA;
const wfName = process.env.WF_NAME;
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const runs = payload.workflow_runs || [];
const run = runs.find(r => r.head_sha === targetSha && r.name === wfName);
if (!run) process.exit(2);
const fields = [String(run.id), run.status || "", run.conclusion || "", run.html_url || ""];
process.stdout.write(fields.join("\t"));
' <<<"$runs_json"
}

run_has_transient_pages_fetch_failure() {
  local run_id="$1"
  local jobs_json
  local check_run_url
  local annotations_json
  local is_transient

  jobs_json="$(github_api_get "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run_id}/jobs?per_page=20")" || return 1
  check_run_url="$(node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const jobs = payload.jobs || [];
if (!jobs.length || !jobs[0].check_run_url) process.exit(2);
process.stdout.write(jobs[0].check_run_url);
' <<<"$jobs_json")" || return 1

  annotations_json="$(github_api_get "${check_run_url}/annotations")" || return 1
  is_transient="$(node -e '
const fs = require("fs");
const anns = JSON.parse(fs.readFileSync(0, "utf8"));
const msgs = anns.map(a => String(a.message || "")).join("\n");
const transient = (
  msgs.includes("codeload.github.com/actions/deploy-pages") ||
  msgs.includes("Failed to download archive") ||
  msgs.includes("An action could not be found at the URI")
);
process.stdout.write(transient ? "yes" : "no");
' <<<"$annotations_json")"

  [[ "$is_transient" == "yes" ]]
}

wait_for_pages_run_and_deploy() {
  local sha="$1"
  local attempt=1

  while [[ "$attempt" -le "$PAGES_POLL_ATTEMPTS" ]]; do
    local run_row=""
    local rc=0
    run_row="$(fetch_pages_run_for_sha "$sha")" || rc=$?

    if [[ "$rc" -eq 2 ]]; then
      echo "Pages run for ${sha} not visible yet (${attempt}/${PAGES_POLL_ATTEMPTS}); waiting ${PAGES_POLL_SECONDS}s..." >&2
      sleep "$PAGES_POLL_SECONDS"
      attempt=$((attempt + 1))
      continue
    fi
    if [[ "$rc" -ne 0 ]]; then
      echo "Failed querying GitHub Actions run list for Pages." >&2
      return 1
    fi

    local run_id run_status run_conclusion run_url
    IFS=$'\t' read -r run_id run_status run_conclusion run_url <<<"$run_row"
    echo "Pages run ${run_id} status=${run_status} conclusion=${run_conclusion:-pending}" >&2

    if [[ "$run_status" != "completed" ]]; then
      sleep "$PAGES_POLL_SECONDS"
      attempt=$((attempt + 1))
      continue
    fi

    if [[ "$run_conclusion" == "success" ]]; then
      return 0
    fi

    LAST_PAGES_RUN_ID="$run_id"
    LAST_PAGES_RUN_URL="$run_url"
    LAST_PAGES_CONCLUSION="$run_conclusion"
    return 2
  done

  echo "Timed out waiting for Pages run completion for ${sha}." >&2
  return 1
}

verify_pages_content() {
  local pages_url="$1"
  local expected_date="$2"
  local expected_volume="$3"
  local html

  html="$(curl -fsSL --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS" "$pages_url")" || return 1
  if EXPECTED_DATE="$expected_date" EXPECTED_VOLUME="$expected_volume" node -e '
const fs = require("fs");
const html = fs.readFileSync(0, "utf8");
const m = html.match(/<script type="application\/json" id="dashboard-data">\n([\s\S]*?)\n<\/script>/);
if (!m) process.exit(1);
const data = JSON.parse(m[1]);
const date = data?.masthead?.date || "";
const volume = data?.masthead?.volume || "";
if (date === process.env.EXPECTED_DATE && volume === process.env.EXPECTED_VOLUME) {
  process.exit(0);
}
process.exit(2);
' <<<"$html"; then
    echo "Pages content verified at ${pages_url} (${expected_volume}; ${expected_date})."
    return 0
  fi
  echo "Pages content is stale at ${pages_url}; expected ${expected_volume} / ${expected_date}." >&2
  return 1
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

maybe_enable_wake_lock "$@"

node scripts/validate_dashboard.js

preflight_rc=0
wait_for_network_ready || preflight_rc=$?
if [[ "$preflight_rc" -eq 2 ]]; then
  echo "Preflight failed due to DNS/network resolution after ${NETWORK_READY_ATTEMPTS} attempt(s). If you are in a restricted sandbox, rerun with elevated network permissions." >&2
  exit 1
fi
if [[ "$preflight_rc" -ne 0 ]]; then
  exit 1
fi

push_with_retry

status_line="$(git status --short --branch | head -n 1)"
echo "$status_line"
if [[ "$status_line" == *"[ahead "* ]]; then
  echo "Push completed but local branch still appears ahead. Verify remote state." >&2
  exit 1
fi

if [[ "$PAGES_VERIFY_ENABLED" != "1" ]]; then
  exit 0
fi

if ! parse_github_remote; then
  echo "Skipping Pages verification: remote ${REMOTE} is not a GitHub URL." >&2
  exit 0
fi

if ! marker_row="$(extract_dashboard_markers)"; then
  echo "Skipping Pages verification: could not extract dashboard markers." >&2
  exit 0
fi

expected_date=""
expected_volume=""
IFS=$'\t' read -r expected_date expected_volume <<<"$marker_row"
if [[ -z "$expected_date" || -z "$expected_volume" ]]; then
  echo "Skipping Pages verification: dashboard markers were empty." >&2
  exit 0
fi

pages_url="$(build_pages_url)"
deploy_sha="$(git rev-parse HEAD)"
retrigger_count=0

while true; do
  if wait_for_pages_run_and_deploy "$deploy_sha"; then
    if verify_pages_content "$pages_url" "$expected_date" "$expected_volume"; then
      break
    fi
    echo "Pages deploy succeeded but live content still stale." >&2
    LAST_PAGES_CONCLUSION="stale_content"
  else
    wait_rc=$?
    if [[ "$wait_rc" -ne 2 ]]; then
      echo "Pages verification failed before completion check." >&2
      exit 1
    fi
    echo "Pages run failed (${LAST_PAGES_CONCLUSION:-unknown}): ${LAST_PAGES_RUN_URL:-no-url}" >&2
  fi

  if [[ "$retrigger_count" -ge "$PAGES_RETRIGGER_MAX" ]]; then
    echo "Pages verification did not succeed after ${PAGES_RETRIGGER_MAX} retrigger attempt(s)." >&2
    exit 1
  fi

  if [[ "${LAST_PAGES_CONCLUSION:-}" != "stale_content" ]] && ! run_has_transient_pages_fetch_failure "${LAST_PAGES_RUN_ID:-0}"; then
    echo "Pages failure does not match transient fetch pattern; manual review required." >&2
    exit 1
  fi

  retrigger_count=$((retrigger_count + 1))
  echo "Retrying Pages deploy via empty commit (${retrigger_count}/${PAGES_RETRIGGER_MAX})..." >&2
  git commit --allow-empty -m "Retry GitHub Pages deploy (${deploy_sha:0:7})"
  deploy_sha="$(git rev-parse HEAD)"
  push_with_retry
done
