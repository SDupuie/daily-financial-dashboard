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
- Before beginning any manual or scheduled dashboard update, read the current `README.md` Daily Runbook from disk and use it as the workflow authority before running Prepare Handoff. Before AI Editorial Work, read the `docs/editorial.md` AI Editorial Work contracts (including its final gate), plus only the section contracts in scope; a full dashboard update requires all section contracts.
- In `America/Chicago`, the scheduled morning start window is 7:45–9:00 AM and the scheduled afternoon start window is 3:45–5:00 PM on weekdays.
- Scheduled preparation checks the weekday/time window, completion marker, and Finnhub U.S. market-holiday calendar before fetching. A matching full-closure date skips preparation and leaves the canonical dashboard unchanged; shortened sessions continue normally. If the holiday check is unavailable or invalid, preparation continues. Scheduled Apply/finalization rechecks only the weekday/completion marker and may finish after the start window.
- Select the scheduled edition from Chicago time and keep the dashboard date and compile date on the local run date. Do not use the masthead, compiled timestamp, Git history, or a run lock as scheduler state.

## Daily Runbook

AI follows this section during normal updates.

Default manual-update scope: when the user asks for a manual dashboard update, run the full manual workflow by default: Prepare, AI Editorial Work, Apply, validation, commit, and publish. Stop earlier only when the request explicitly says to stop at a named stage, such as Prepare only, through Apply, or before publication.

### Update continuity and recovery

This section owns progress saving and recovery for manual and scheduled updates. Compaction, a model switch, or an interruption continues the existing run. It does not authorize restarting Prepare, replacing a handoff, or repeating verified work.

1. **Recovery record and authority.** The AI maintains the optional plain-text string `editorialReview.resumeNotes` in `generated/editorial/dashboard-data.json`. Apply ignores this field, including malformed values, and excludes it from published data and review receipts. It is working memory, not completion evidence, scheduler state, or permission to act. Completed reviews, selections, copy, and dispositions remain in their existing handoff fields under `docs/editorial.md`. Keep no separate checkpoint or inventory copy. Notes and conversation summaries cannot override current instructions, artifacts, or command results.

2. **Saving progress.** After successful Prepare, initialize fresh notes bound to the handoff's `preparedAt`; a new Prepare resets the handoff and prior-run notes must not be reused. Record the original Chicago run date, edition, scheduled/manual mode, current phase, and one concrete next action. During metadata triage, record completed contiguous 1-based ranges and the next unread position in General array order, then unseen Futures URLs, then unseen Crypto URLs; include the last inspected zero-based inventory reference. Advance only after inspecting the full, untruncated batch. Before starting deep review, record the finalized General/Futures and Crypto shortlists as inventory references in these notes, using the News inventory contract's first-reference order. These references preserve the Pass 1 decision for resumption; they are working memory, not completion evidence. Also record pending contender references, section progress for Opening/Tape/Earnings/Week Ahead, provisional research findings with sources and unresolved questions, and active command/session identifiers or terminal-result references. Save completed evidence and edited copy first, then update notes after each metadata batch, meaningful deep-review group, completed section, subsequent workflow stage, and before yielding. Reference completed evidence instead of duplicating it; derive counts rather than typing totals. Replace superseded notes. Work lost before a save may require repeating only that unsaved batch.

3. **Reloading context.** Before researching, editing, or running an update command on resume, complete these dependent reads in order: root `AGENTS.md`, the current README runbook, then its routed editorial instructions from disk. Finish inspecting each result before starting the next; do not batch these reads with each other or with recovery-data reads. Inspect `git status --short` and relevant current diffs; current working files govern, including uncommitted changes. Next read the existing handoff's notes, structured evidence, selections, and fields relevant to the next assignment. Finish inspecting the handoff before retrieving inventory or command results for reconciliation. Do not restore an older recovery design from Git history merely because it is familiar. If Prepare has not produced this run's handoff, recover its command state from the existing task outputs instead; an older handoff does not establish progress for the current run.

4. **Reconciling saved work.** Confirm inventory `generatedAt`, handoff `preparedAt`, and evidence `inventoryGeneratedAt` agree, and resolve saved candidate references against that immutable inventory. Check the notes' run identity, scan boundaries, and claims against saved work. Missing, empty, non-string, stale, or contradictory notes are unusable for the affected claim; preserve independently supported handoff progress and recover missing details from saved task outputs before repeating only uncertain work. A partial review may be valid progress even though it cannot yet pass final Apply checks. Never manufacture evidence from a summary, a selected card, or an unsupported "done" claim. If the actual inventory and handoff disagree or a necessary state cannot be established, report that specific blocker and preserve the files; do not regenerate them to erase the uncertainty. Briefly state what is saved, what remains uncertain, and the next action.

5. **Resuming execution.** Continue the first verified unfinished step, preserving the original run date, edition, and scheduled/manual mode; the updater still owns scheduler eligibility and completion checks. If saved task evidence establishes that Prepare never started, begin the normal workflow; absence of a handoff alone does not establish that. A session ID, running state, or missing numeric exit code means a command is active: poll its session and assess the complete output after exit. If the session handle is missing, recover it or the terminal result from saved task outputs; unresolved command state is a concrete blocker, not permission to launch a duplicate. Prepare succeeds only after a successful exit with both `Preparation status: candidate ready` and `Editorial workspace prepared ...`; skipped/refused/failed preparation or missing success markers/handoff ends the scheduled invocation without a retry. Elapsed time alone is not a blocker. If Apply, commit, publication, or maintenance may have completed, inspect saved command results and current artifact/Git state before repeating the operation; notes alone cannot establish success. Follow the existing publication and Weekly Git maintenance sections for their checks, eligibility, and failure reporting.

### Canonical two-command workflow

| Run | 1. Prepare Handoff | 2. AI Editorial Work | 3. Apply Handoff |
| --- | --- | --- | --- |
| Scheduled | Run `node scripts/run_daily_update.js prepare --scheduled --morning` or `node scripts/run_daily_update.js prepare --scheduled --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the applicable `docs/editorial.md` sections routed above. | Run `node scripts/run_daily_update.js apply --scheduled`; then commit on `main` and run `./scripts/publish_main.sh` |
| Manual/on-demand | Run `node scripts/run_daily_update.js prepare --morning` or `node scripts/run_daily_update.js prepare --afternoon` | Edit the single `generated/editorial/dashboard-data.json` handoff. Complete every required editorial assignment marked by the handoff, following the applicable `docs/editorial.md` sections routed above. | Run `node scripts/run_daily_update.js apply`; commit and publish only when the manual update is intended to go live |

For the editorial contract's mechanical review, run `node scripts/run_daily_update.js apply --preview` (add `--scheduled` for a scheduled run). This read-only mode uses Apply's merge and acceptance decisions and reports accepted News counts, evidence issues, omissions/fallbacks, and copy advisories. It exits nonzero when News review-evidence issues are present, after printing the report. Preview does not fetch, write the handoff/candidate/canonical dashboard or narrative sidecar, advance scheduler state, or publish; normal Apply keeps its documented fail-open behavior. Preview is not a research-completeness certificate or a replacement for Apply's final artifact-safety check. Editorial correction and fail-open continuation are governed only by [AI Editorial Work contracts](docs/editorial.md#ai-editorial-work-contracts).

### Codex command execution

- When Codex runs Prepare, use escalated local command execution. Zacks uses Chromium during Earnings preparation, and Chromium may not launch in the default managed sandbox.
- Handle running commands and terminal results under [Update continuity and recovery](#update-continuity-and-recovery).
- Zacks uses the Chromium browser installed for this repository. On a new checkout, run `npm install` and then `npm run install:browsers`. This is a one-time setup or repair step, not something required before every dashboard update.
- News discovery and article downloads share `scripts/fetch_news_candidates.js`. When AP, Axios, Investing.com, or Crowdfund Insider returns HTTP 403 for a feed or article, that script retries the request through its private `curl_cffi` transport. The retry downloads complete feed documents and uses the same bounded early-stop rule for article excerpts. It does not launch a browser or read browser cookies. Run `npm run install:news-client` once per checkout to install the pinned library in `scripts/.news-http-env`; rerun it only if that folder is removed. If the library is unavailable, affected feeds or article excerpts remain inaccessible and Prepare continues with other sources.
- At the start of Prepare, if the repo-local Chromium executable is missing, Prepare runs `npm run install:browsers` once and continues regardless of whether that repair succeeds.
- If Chromium cannot start because the execution environment blocks browser launch, Prepare continues using backup earnings sources or retained prior Zacks facts and prints a warning. Run Prepare with escalated local command execution for that case; reinstalling Chromium does not repair a sandbox or permission failure.
- If the Playwright dependency itself is missing, run `npm install`, then `npm run install:browsers`.
- This changes only how the Prepare command is invoked from Codex; the normal Prepare commands remain `node scripts/run_daily_update.js prepare --morning`, `node scripts/run_daily_update.js prepare --afternoon`, `node scripts/run_daily_update.js prepare --scheduled --morning`, or `node scripts/run_daily_update.js prepare --scheduled --afternoon`.

### Core guarantees

- **Prepare Handoff:** validates deterministic staging, resolves each failed section to validated carried-forward data or an explicit unavailable state, and writes the handoff/candidate while leaving the canonical dashboard unchanged.
- **AI Editorial Work:** writes only to `generated/editorial/dashboard-data.json`; its structured review evidence is the sole News-review record defined by the [News inventory contract](docs/editorial.md#news-inventory-contract). Refreshed quotes need reviewed commentary, while failed quote downloads retain their prior validated quote and commentary together.
- **Apply Handoff:** merges editorial work without revalidating or replacing deterministic candidate data, runs one top-level render-safety check, and atomically updates the local canonical dashboard; `publish_main.sh` publishes only after commit.

## Validation and Publish

### Required daily checks

Publication validation is a final artifact safety check. It blocks malformed HTML, unparsable embedded JSON, missing required runtime blocks, render-surface shapes that would break dashboard initialization, and core published-file safety issues. It does not block publication solely for incomplete editorial work, partial sections, unavailable dispositions, omitted cards, blank fallback copy, or recoverable section-level data issues already resolved during Prepare or deferred to later handoffs.

- Before committing a content-only update, run only `node scripts/validate_dashboard.js readiness --skip-tests --allow daily_financial_news.html`. The `--allow` option hides expected dirty files from the warning list; readiness reports but does not block on other dirty files.
- For quick iteration or an ordinary non-publish check, run `node scripts/validate_dashboard.js daily_financial_news.html`.
- Let `./scripts/publish_main.sh` own the full readiness gate before it pushes; do not run the complete suite immediately before publishing.

### Commit and publish

- Commit directly on `main`.
- After each dashboard update commit, run `./scripts/publish_main.sh`.
- Confirm publication succeeds and `git status --short --branch` no longer shows local commits ahead of `origin/main`.

### Weekly Git maintenance

- After successful publication, run this step only for the scheduled Friday afternoon edition. Determine eligibility from the scheduled run's start date and edition in `America/Chicago`; retain that decision if publication finishes later. Other editions and manual updates stop after publication.
- From the repository root, record `du -sk .git`, run ordinary `git gc` with escalated local command execution and default settings, then record `du -sk .git` again. Wait for a numeric exit code before reporting completion. Do not add `--aggressive`, `--prune=now`, or `--force`.
- Include the maintenance result and space recovered in the run's completion report. If maintenance fails or cannot run, report that separately while preserving the successful publication result; do not repeat Prepare, Apply, commit, or publish to retry maintenance.

### Completion report

After a successful scheduled or manual publication, write a concise narrative report in this order:

1. Open with a bold sentence giving the Chicago date, edition, and publication result, followed by a live dashboard link.
2. In a short paragraph, report the actual Futures, General, and Crypto story counts, mechanically generated News deep-review and retained/new selection counts, and the number of refreshed Tape notes. Mention substantive Opening, Earnings, or Week Ahead changes and any deliberately deferred reaction when relevant.
3. In a short paragraph, state which Apply, readiness, publication-suite, deployment, and live-page checks actually passed. Give the commit ID, whether `main` is synchronized with `origin/main`, and any pre-existing local changes left untouched.
4. Add a separate **Verification gap:** paragraph whenever a required check was not performed or remains unresolved. Say exactly what was missed and do not claim checks that were not run. Include Friday Git maintenance and space recovered for an eligible afternoon run, or briefly state why it was inapplicable.

Use these compact paragraphs rather than a checklist of status bullets for a routine success. For a reportable failure, material data limitation, or unmet requirement, adapt the report to the actual outcome and include only completed work and checks. For scheduled runs, honor the scheduler's notification rules: an unchanged or non-actionable skipped run may use only the required quiet heartbeat status, without a narrative report. When notification is warranted and a machine-readable heartbeat status is required, put the user-facing report before that status block.

Normal daily updates stop after publication and any eligible weekly Git maintenance. `docs/reference.md` is not AI Editorial Work guidance. During Prepare Handoff, AI Editorial Work, or Apply Handoff, read only the applicable `docs/reference.md` subsection, and do so only when this runbook explicitly points to it, when debugging a failed run, or when changing code or data contracts.
