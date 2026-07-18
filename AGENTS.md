# Project Guardrails

## Canonical Runbook

Follow `README.md` as the canonical daily runbook and data-contract reference. Do not duplicate, reinterpret, or extend its operational workflow here.

## Canonical Files and Writer Boundary

- `daily_financial_news.html` is the canonical generated dashboard and embedded production data.
- `generated/` is ignored staging, editorial handoff, cache, candidate, and recovery material. Nothing in it is a published runtime dependency.
- `index.html` is the published root entry point.
- `scripts/run_daily_update.js` is the sole operational writer for `daily_financial_news.html`.
- `scripts/validate_dashboard.js` is read-only validation.
- `scripts/publish_main.sh` is publication-only; it must not fetch source data or alter dashboard data.
- `scripts/local_market_server.js` is an optional ephemeral browser overlay and must never write the canonical dashboard.

Do not directly edit dashboard HTML data as part of a normal refresh. Use the README-defined updater workflow.

## Scope and Worktree Safety

Treat current working files as authoritative when the worktree is dirty. Preserve unrelated user changes.

A dashboard data refresh authorizes changes only to staging and canonical generated data through the README workflow. Source code, tests, documentation, configuration, policy, visible UI, and repository structure require explicit user authorization.

Prefer editing an existing appropriate file. Ask before creating a new top-level directory. Do not use destructive Git commands unless the user explicitly requests them.

## UI and Testing

Do not change visible styling, layout, markup, interactions, or responsive behavior unless the user requested that visible change.

Keep tests proportional to this personal dashboard and focused on failures that could corrupt an update, bypass the sole-writer boundary, or take the dashboard offline. Use the README for exact commands and verification requirements.

After source edits, inspect the diff for unintended visible or unrelated changes.

## Financial and Source Boundaries

Do not copy strategy, allocation, signal, ranking, selection, rebalance, or model logic from the separate Asset Allocation Dashboard project. Use only its sanitized exported result when portfolio-level values are required.

Tape commentary explains market drivers; it does not restate quote values or contain citation language. Do not include future dividend events in current MTD totals or returns.

## Implementation and Review

Prefer concise modern JavaScript and native browser APIs. Add helpers only for real duplication, a meaningful contract, or a clearer ownership boundary. Avoid framework-like abstractions and compatibility branches outside supported browsers.

When Ponytail or "minimal/simple/lazy" implementation guidance applies, treat "simple" as the canonical simplest end state for this repo's contracts, not the smallest diff from the current implementation. Do not preserve accidental complexity, stale paths, compatibility branches, or speculative scaffolding merely because removing them is a larger change. Keep the change scoped to authorized files, preserve unrelated user work, and during audits/reviews make recommendations only unless implementation is explicitly authorized.

For reviews and audits, report evidence-backed findings in severity order; identify what was inspected; distinguish new regressions from pre-existing issues; and include a concrete recommendation, affected files or contract, and verification for each actionable finding. Do not implement fixes unless authorized.

## Safety

Use narrow, task-specific network permissions for production fetches. Stop and ask if completing a task requires materially broader authority than the user granted.
