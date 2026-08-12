# Daily Financial Dashboard

## What this repo publishes

This repository maintains `daily_financial_news.html`, the canonical static Daily Tape dashboard.

### Production files

- `daily_financial_news.html`: production dashboard HTML, CSS, JavaScript, and embedded data.
- `index.html`: published root entry point; it routes visitors to `daily_financial_news.html`.
- `scripts/`: operational fetch, validation, and publish helpers.
- `launchd/`: optional local-machine LaunchAgent templates for running dashboard helper scripts.
- `mockups/`: temporary design exploration only. Production must not depend on files in this directory.

Do not edit dashboard HTML, CSS, or JavaScript directly during a daily dashboard refresh.

### Documentation map

- `docs/editorial.md`: AI Editorial Work contract for `generated/editorial/dashboard-data.json`.
- `docs/reference.md`: dashboard data contracts, deterministic source contracts, earnings method, focused repairs, local refresh server, and browser support.
- `docs/agent-implementation.md`: Codex policy for source changes, architecture, refactors, tests, and visible UI verification.
- `docs/agent-review.md`: Codex policy for reviews, audits, changed-contract checks, and commenting passes.

## Scheduled and manual execution

- `--scheduled` identifies only a scheduler-driven Prepare or Apply run. Manual/on-demand and development runs omit it.
- Before beginning any manual or scheduled dashboard update, read the current `README.md` Daily Runbook from disk and use it as the workflow authority before running Prepare Handoff. Before AI Editorial Work, read the `docs/editorial.md` AI Editorial Work contracts and AI Editorial Work checklist, plus only the section contracts in scope; a full dashboard update requires all section contracts.
- In `America/Chicago`, the scheduled morning start window is 7:45–9:00 AM and the scheduled afternoon start window is 3:45–5:00 PM on weekdays.
- Scheduled preparation checks the weekday/time window and completion marker before fetching; scheduled Apply/finalization rechecks only the weekday/completion marker and may finish after the start window.
- Select the scheduled edition from Chicago time and keep the dashboard date and compile date on the local run date. Do not use the masthead, compiled timestamp, Git history, or a run lock as scheduler state.

## Daily Runbook

AI follows this section during normal updates.

Default manual-update scope: when the user asks for a manual dashboard update, run the full manual workflow by default: Prepare, AI Editorial Work, Apply, validation, commit, and publish. Stop earlier only when the request explicitly says to stop at a named stage, such as Prepare only, through Apply, or before publication.

### Canonical two-command workflow

| Run | 1. Prepare Handoff | 2. AI Editorial Work | 3. Apply Handoff |
| --- | --- | --- | --- |
| Scheduled | Run `node scripts/run_daily_update.js prepare --scheduled --morning` or `node scripts/run_daily_update.js prepare --scheduled --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the applicable `docs/editorial.md` sections routed above. | Run `node scripts/run_daily_update.js apply --scheduled`; then commit on `main` and run `./scripts/publish_main.sh` |
| Manual/on-demand | Run `node scripts/run_daily_update.js prepare --morning` or `node scripts/run_daily_update.js prepare --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the applicable `docs/editorial.md` sections routed above. | Run `node scripts/run_daily_update.js apply`; commit and publish only when the manual update is intended to go live |

### Codex command execution

- When Codex runs Prepare, use escalated local command execution. Zacks uses Chromium during Earnings preparation, and Chromium may not launch in the default managed sandbox.
- If command execution returns a session ID, a running state, or no numeric exit code, the underlying command is still active. Poll that session until it returns an exit code, then evaluate the complete accumulated output. `Preparation status: candidate ready` is intermediate until `Editorial workspace prepared ...` appears. Never report or record a terminal result while the session remains active.
- Zacks uses the Chromium browser installed for this repository. On a new checkout, run `npm install` and then `npm run install:browsers`. This is a one-time setup or repair step, not something required before every dashboard update.
- At the start of Prepare, if the repo-local Chromium executable is missing, Prepare runs `npm run install:browsers` once and continues regardless of whether that repair succeeds.
- If Chromium cannot start because the execution environment blocks browser launch, Prepare continues using backup earnings sources or retained prior Zacks facts and prints a warning. Run Prepare with escalated local command execution for that case; reinstalling Chromium does not repair a sandbox or permission failure.
- If the Playwright dependency itself is missing, run `npm install`, then `npm run install:browsers`.
- This changes only how the Prepare command is invoked from Codex; the normal Prepare commands remain `node scripts/run_daily_update.js prepare --morning`, `node scripts/run_daily_update.js prepare --afternoon`, `node scripts/run_daily_update.js prepare --scheduled --morning`, or `node scripts/run_daily_update.js prepare --scheduled --afternoon`.

### Core guarantees

- **Prepare Handoff:** validates deterministic staging, resolves each failed section to validated carried-forward data or an explicit unavailable state, and writes the handoff/candidate while leaving the canonical dashboard unchanged.
- **AI Editorial Work:** happens only in `generated/editorial/dashboard-data.json`; refreshed quotes need reviewed commentary, while failed quote downloads retain their prior validated quote and commentary together.
- **Apply Handoff:** merges editorial work without revalidating or replacing deterministic candidate data, runs one top-level render-safety check, and atomically updates the local canonical dashboard; `publish_main.sh` publishes only after commit.

## Validation and Publish

### Required daily checks

Publication validation is a final artifact safety check. It blocks malformed HTML, unparsable embedded JSON, missing required runtime blocks, render-surface shapes that would break dashboard initialization, and core published-file safety issues. It does not block publication solely for incomplete editorial work, partial sections, unavailable dispositions, omitted cards, blank fallback copy, or recoverable section-level data issues already resolved during Prepare or deferred to later handoffs.

- Before committing a content-only update, run only `node scripts/validate_dashboard.js readiness --skip-tests --allow daily_financial_news.html`. The `--allow` option hides expected dirty files from the warning list; readiness reports but does not block on other dirty files.
- For quick iteration or an ordinary non-publish check, run `node scripts/validate_dashboard.js daily_financial_news.html`.
- Let `./scripts/publish_main.sh` own the full readiness gate before it pushes; do not run the complete suite immediately before publishing.

### Expanded content and layout checks

Run the applicable checks after content, structural, layout, script, or contract changes:

- Avoid market-superlative claims unless directly verified during AI Editorial Work.
- Run `tidy -q -e daily_financial_news.html` and browser-check the production page after structural or layout changes. After changing Market Lens or Outcome copy, reactions, or routing, check narrow mobile and desktop widths for readability and overflow; activate pre-close and post-close reaction controls with pointer and keyboard; verify the correct Tape group, ticker, and chart open; verify focus moves to the chart heading; and verify repeated activation leaves that chart open.
- After changing an information tooltip, browser-check tap, hover, and keyboard activation at narrow mobile, tablet, and desktop widths. The tooltip must remain inside the viewport and each state must remain legible.
- Run `node scripts/validate_dashboard.js test` after script or data-contract changes when publication is not the immediate next step. It already runs `scripts/test_dashboard.js`, so keep those checks sequential rather than launching a parallel dashboard-test run. Run `node scripts/test_dashboard.js --local-refresh` only when changing local-refresh behavior.
- Nonvisual data, contract, validation, and refactoring changes require no browser pass. For visible changes, exercise only the affected interactions and applicable breakpoints, including every specific tooltip or Week Ahead check listed above when that surface changed.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm publication succeeds and `git status --short --branch` no longer shows local commits ahead of `origin/main`.

Normal daily updates stop here. `docs/reference.md` is not AI Editorial Work guidance. During Prepare Handoff, AI Editorial Work, or Apply Handoff, read only the applicable `docs/reference.md` subsection, and do so only when this runbook explicitly points to it, when debugging a failed run, or when changing code or data contracts.
