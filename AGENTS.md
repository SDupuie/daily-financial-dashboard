# Project Instructions

## Purpose

This is a personal static financial dashboard. Optimize for a reliable daily update, clear failure behavior, and low maintenance overhead. Do not add process or abstraction for hypothetical contributors.

The protected workflow is:

1. Deterministic preparation
2. Commentary and editorial review
3. Validated publication

Recoverable failures must fail open: publish a truthful fallback and retry later rather than losing the whole update.

## Canonical Files

- `daily_financial_news.html`: canonical generated dashboard and embedded production data.
- `generated/`: ignored staging, editorial handoff, cache, candidate, and recovery artifacts. Nothing here is a published runtime dependency.
- `index.html`: published root entry point.
- `scripts/run_daily_update.js`: sole operational writer for `daily_financial_news.html`.
- `scripts/validate_dashboard.js`: read-only dashboard validation, complete tests, and readiness checks.
- `scripts/publish_main.sh`: readiness and Git publication only; it must not fetch or alter dashboard data.
- `scripts/local_market_server.js`: optional ephemeral browser overlay only; it must never write the canonical dashboard.
- `README.md`: human runbook and data-contract reference.

Treat the current working files as authoritative when the worktree is dirty. Preserve unrelated user changes.

## Core Update Contract

### 1. Deterministic preparation

- Fetchers and domain commands write only staging/cache files or explicit temporary diagnostic outputs. They never edit dashboard HTML.
- Preparation assembles `generated/daily_financial_news.candidate.html` and leaves the canonical dashboard byte-for-byte unchanged.
- Persistent staging and canonical writes are atomic. The updater has no run lock. Scheduler-driven preparation is explicitly marked `--scheduled`; it enforces the Chicago start window before fetching, and the embedded completion marker suppresses a second successful scheduler-driven run in the same local date/window. Manual/on-demand preparation and finalization omit `--scheduled`, remain time-unrestricted, and may rerun the same edition or window intentionally.
- EarningsAPI calendar discovery is authorized only for scheduled Monday-morning and Friday-afternoon rollovers, an audited failed-rollover or unavailable-shell retry on a later scheduled run, or an explicit manual calendar rebuild. Ordinary manual, development, validation, and repair runs never infer permission from the weekday or edition name.
- Producers reject values they cannot reliably normalize and isolate failures at the narrowest useful row, ticker, provider, or section boundary.
- Deterministic display values are rebuilt from their canonical data on every apply path. Embedded `chart-data.series` owns chart history and per-ticker `quoteRevision`; quote rows and visible Tape values are derived.
- Focused repair modes use the same complete-candidate validation and atomic replacement path as a normal update.

### 2. Commentary and editorial review

- Deterministic facts are not hand-edited in the dashboard. Editorial work happens only through the single generated `dashboard-data.json` handoff.
- Preparing that handoff first runs the deterministic News downloader. The downloader owns only acquisition, freshness normalization, URL normalization, deduplication, and attempt diagnostics; the AI owns relevance review, comparison, selection, and story copy.
- Every successfully downloaded quote invalidates that ticker's prior commentary. Finalization must bind newly reviewed commentary to the exact series `quoteRevision`.
- A failed quote download retains that ticker's last validated series, quote revision, quote fields, and bound commentary together.
- Missing required non-News editorial work remains `pending_review` and cannot finalize. News is the explicit fail-open exception: the updater publishes whatever valid selected cards survive, including empty News collections, and derives the coverage state itself.
- Malformed optional editorial input may be omitted only when the enclosing required editorial work is complete; a system action never completes editorial work.
- Final editorial application stamps a receipt bound to the base edition and the finalized dashboard/chart payload. System-applied fallbacks are recorded separately from human review.

### 3. Validated publication

- `run_daily_update.js` validates the complete finalized candidate before atomically replacing `daily_financial_news.html`.
- A successful replacement refreshes the last-good recovery snapshot. Failure to synchronize post-commit cache or staging files is reported but never rolls back the validated dashboard.
- `validate_dashboard.js` is read-only. `publish_main.sh` runs readiness and pushes Git; it does not fetch, normalize, or edit dashboard content.
- Publishing never bypasses the updater's validated candidate path. Direct HTML data edits are not part of the daily workflow.

### 4. Fail-open behavior

- Fail-open applies to deterministic source failures and News coverage shortages, not required non-News editorial completion. Deterministic preparation may stage documented source fallbacks so editorial work can continue, but those source fallbacks do not satisfy a non-News editorial gate.
- A missing, malformed, or stale complete candidate is not a finalization fallback. Leave the canonical dashboard unchanged and retry deterministic preparation.
- Preserve successful neighboring rows and sections. Carry prior data only when it remains valid for the displayed period; otherwise use a correctly dated unavailable row or shell.
- Never fabricate facts, silently reuse stale dates, or show a refreshed quote beside commentary from an older quote revision.
- The deterministic News downloader attempts every Alpha Vantage, StockFit, and direct-feed path in the fixed manifest in `scripts/news_sources.js`, filters through its checked-in approved-source catalog, attempts article-page acquisition, adds still-fresh prior cards, and records every path result before the handoff is written. JavaScript does not rank or select stories. The acquisition goals are 36 fresh general-market candidates and 12 fresh Crypto candidates; the display targets are nine general stories, three Futures stories, and four to six Crypto stories. Neither candidate shortages nor selected-card shortages block finalization. Every published card still must satisfy the strict field, freshness, HTTPS, duplication, and Futures-session rules. Released Week Ahead and Earnings facts require current editorial interpretation; an Earnings row whose release window has passed but whose actuals are not reliably available remains deterministically pending without invented commentary. Missing whole-section source data may use a same-range validated carry or correctly dated unavailable shell.
- Every degraded state remains retryable and clears when fresh valid input succeeds.
- Final validation stays strict about the fallback that was selected. If no valid replacement can be assembled, keep the existing canonical dashboard available; never replace it with an invalid candidate.

## Operational Workflow

The README owns exact commands and payload fields. The normal sequence is:

1. Run deterministic preparation and create the editorial handoff.
2. Review the downloaded News pool, complete the required commentary, select the strongest available stories, and finish evidence review.
3. Apply the editorial handoff, validate the complete candidate, atomically replace the dashboard, then publish.

A request to refresh or publish dashboard data authorizes changes only to staging and canonical generated data through this workflow. Source code, tests, documentation, configuration, and policy require explicit user authorization.

## Test Policy

Keep tests proportional to a personal dashboard. Protect failures that could corrupt an update or take the dashboard offline:

- preparation does not modify the canonical artifact;
- only the updater can replace it, and only after complete validation;
- quote revisions and commentary remain bound through refresh, merge, and carry-forward;
- row/section failures preserve successful neighbors and produce valid fallbacks;
- editorial receipts bind the finalized payload and record system fallbacks;
- publishing runs readiness; and
- the last-good artifact remains usable when the canonical payload is malformed.

Prefer a few end-to-end fixtures and representative failure cases. Do not require exhaustive malformed-field permutations, CLI help/typo tests, test-owner matrices, policy-wording tests, or source-layout assertions unless they directly protect the sole-writer or publication boundary.

- `node scripts/validate_dashboard.js test` is the complete default offline check. Do not repeat its individual syntax, domain-suite, dashboard-validation, HTML, or whitespace commands.
- Use focused tests while developing. If publication is next, let `publish_main.sh` own the final complete readiness run.
- For a content-only pre-commit check, use only `node scripts/validate_dashboard.js readiness --skip-tests --allow ...`.
- Run `node scripts/test_dashboard.js --local-refresh` only when the local server or browser refresh overlay changes.
- Do not use live production fetches as test evidence. Use fixtures or injected responses.

## UI and File Scope

- Do not change visible styling, layout, markup, interactions, or responsive behavior unless the user requested that visible change.
- Nonvisual data, contract, validation, and refactoring work does not require browser testing. For visible work, test only the affected interactions and breakpoints described in the README.
- Keep design explorations under `mockups/`. Production must not depend on mockups or sidecar JSON.
- Prefer editing an existing appropriate file. Ask before creating a new top-level directory.
- After source edits, inspect the diff for unintended visible or unrelated changes.

## Financial and Source Boundaries

- Do not copy strategy, allocation, signal, ranking, selection, rebalance, or model logic from the separate Asset Allocation Dashboard project.
- Use only its sanitized exported result when the task requires portfolio-level values. If it is unavailable, show instrument-level data without fabricating tactical weights.
- Tape commentary explains market drivers; it does not restate quote values or contain citation language.
- Prefer reputable, accessible story sources when equivalent coverage exists.
- Do not include future dividend events in current MTD totals or returns.

## Implementation Style

- Prefer concise modern JavaScript and native browser APIs.
- Add helpers only for real duplication, a meaningful contract, or a clearer ownership boundary.
- Avoid framework-like abstractions, compatibility branches outside the supported browsers, and comments that restate obvious code.
- For reviews and audits, report evidence-backed findings in severity order, identify what was actually inspected, and distinguish new regressions from pre-existing issues. For every actionable finding, include a concrete recommended fix, the affected files or contract, and the verification needed to confirm the repair. Distinguish recommendations from implemented changes; do not implement fixes unless authorized. Do not require ceremonial checklists when a focused review answers the request.

## Safety

- Use narrow, task-specific network permissions for production fetches.
- Do not use destructive Git commands unless the user explicitly requests them.
- Stop and ask if completing a task requires materially broader authority than the user granted.
