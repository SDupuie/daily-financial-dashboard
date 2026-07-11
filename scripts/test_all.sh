#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Checking tracked JavaScript syntax..."
while IFS= read -r file; do
  node --check "$file"
done < <(git ls-files 'scripts/*.js')

echo "Checking tracked shell syntax..."
while IFS= read -r file; do
  bash -n "$file"
done < <(git ls-files 'scripts/*.sh')

echo "Checking LaunchAgent plist..."
plutil -lint launchd/com.scott.daily-financial-dashboard.plist

echo "Running contract and regression tests..."
node scripts/test_calendar_contract.js
node scripts/test_earnings.js
node scripts/test_week_ahead.js
node scripts/test_dashboard.js

echo "Validating the canonical dashboard artifact..."
# validate_dashboard covers the embedded chart and earnings contracts; their standalone validators require ignored staging artifacts.
node scripts/validate_dashboard.js daily_financial_news.html
tidy -q -e daily_financial_news.html
git diff --check

echo "Complete dashboard test suite passed."
