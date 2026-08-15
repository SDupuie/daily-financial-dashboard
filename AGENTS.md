# Project Guardrails

## Purpose

This is a personal static financial dashboard. Optimize for a reliable daily update, clear failure behavior, and low maintenance overhead. Do not add process or abstraction for hypothetical contributors.

## Startup and Reload Requirement

At the start of every new Codex task in this repository, read the current root `AGENTS.md` from disk before making recommendations, running workflows, editing files, or performing reviews. Do not rely only on prior conversation summaries.

After any context compaction or model switch, reread the current root `AGENTS.md` from disk before continuing work or answering repository-specific questions. Do not rely only on prior conversation summaries.

After an interrupted or resumed turn, re-check the current files needed for the next action before relying on prior context. Reread root `AGENTS.md` when the interruption may have changed task scope, workflow state, or applicable instructions.

Use the Policy Routing section below to choose any additional files or README sections needed for the current task.

## Sources of Authority

Use each repository artifact only for the scope it owns:

- `AGENTS.md` is the canonical project-policy entry point for agent behavior. Its always-loaded safety, scope, routing, and file-ownership instructions govern automated work in this repository.
- `docs/agent-implementation.md` is the routed agent policy for source changes, architecture, refactors, tests, and visible UI verification.
- `docs/agent-review.md` is the routed agent policy for focused reviews, broad audits, changed-contract checks, audit output, and commenting passes.
- `README.md` is the canonical human-readable operational runbook and validation/publish source. Follow it for daily workflow details; do not duplicate, reinterpret, or extend its operational workflow here.
- `docs/editorial.md` is the canonical AI Editorial Work contract for `generated/editorial/dashboard-data.json`.
- `docs/reference.md` is the canonical human-readable reference for data contracts, deterministic sources, focused repairs, local refresh, and browser support.
- Treat disagreement between these documents as documentation drift to resolve, not as an alternate workflow.
- Validators are executable enforcement of selected documented contracts.
- Tests are regression evidence for implementation paths.
- Neither validators, tests, nor fixtures independently define product or data policy, and fixtures are never production data.
- Audit finding fixes must follow both `docs/agent-review.md` and `docs/agent-implementation.md`: freeze the changed-contract matrix before editing, implement the full transitive contract surface, and verify the behavior classes required by the review policy.
- After a closure audit establishes a baseline, later audits default to reporting only regressions from subsequent changes unless the user explicitly asks to reopen or rebaseline the full repository. An unchanged defect that can prevent the overall dashboard from displaying is a baseline breach, not a general reopening.

## Scope and Worktree Safety

- Treat current working files as authoritative when the worktree is dirty. Preserve unrelated user changes.
- A dashboard data refresh authorizes changes only to staging and canonical generated data through the README workflow.
- Source code, tests, documentation, configuration, policy, visible UI, and repository structure require explicit user authorization.
- When the user asks a question about a possible change, answer the question only; do not edit files, run update workflows, commit, or publish unless the user explicitly authorizes that action.
- If an update exposes a source defect or contract gap, stop the update before changing source files, report the blocker, and get explicit approval for that source change.
- Re-read the exact current ranges immediately before applying a narrow patch.
- Do not use stale full-file snapshots, broad replacements, or carried-forward diffs that could restore rejected or unrelated changes.
- Prefer editing an existing appropriate file.
- Ask before creating a new top-level directory.
- Do not use destructive Git commands unless the user explicitly requests them.

## Canonical Files and Writer Boundary

- `daily_financial_news.html` is the canonical generated dashboard and embedded production data.
- `generated/` is ignored staging, editorial handoff, cache, candidate, and recovery material. Nothing in it is a published runtime dependency.
- `index.html` is the published root entry point.
- `scripts/run_daily_update.js` is the sole operational writer for `daily_financial_news.html`.
- `scripts/validate_dashboard.js` is read-only validation.
- `scripts/publish_main.sh` is publication-only; it must not fetch source data or alter dashboard data.
- `scripts/local_market_server.js` is an optional ephemeral browser overlay and must never write the canonical dashboard.

Do not directly edit dashboard HTML data as part of a normal refresh. Use the README-defined updater workflow.

## Policy Routing

Read only the routed files or README sections needed for the current task:

- Prepare or Apply Handoff: read `README.md` Scheduled and manual execution and the relevant Daily Runbook subsections. Before Apply, also read `docs/editorial.md` Final Pre-Apply Editorial Gate.
- AI Editorial Work: read `docs/editorial.md` AI Editorial Work contracts and AI Editorial Work checklist, plus only the section contracts in scope. For a full dashboard update, all section contracts are in scope.
- Validation, commit, or publish: read only the applicable `README.md` Validation and Publish subsections: Required daily checks, Expanded content and layout checks when the change requires them, and Commit and publish for commit or publication work.
- Deterministic source, staging, payload-shape, fallback, or data-contract work: read the relevant `docs/reference.md` subsection for the affected domain.
- Focused repairs or local-refresh work: read only the applicable `docs/reference.md` Focused Repair Commands or Local Refresh Server subsection. For browser-compatibility work, read `docs/agent-implementation.md` and the `docs/reference.md` Browser Support subsection.
- Source-code, architecture, refactor, tests, or visible UI changes: read `docs/agent-implementation.md`, plus any relevant `docs/reference.md` section for touched dashboard domains.
- Reviews, audits, regression audits, closure audits, changed-contract checks, or commenting passes: read `docs/agent-review.md`, plus `docs/agent-implementation.md` when the review scope includes implementation, architecture, visible UI policy, or audit finding fixes, plus only the relevant `docs/reference.md` subsection when domain contracts are in scope.
- Questions about policy, documentation structure, or possible changes: read only the current files needed to answer the question. Do not edit, run workflows, commit, or publish unless explicitly authorized.

## Financial and Source Boundaries

- Do not import `src/model.js` or equivalent model/strategy files from the separate Asset Allocation Dashboard project.
- Do not copy strategy, tactical allocation, signal, ranking, selection, rebalance, or model logic into this repository.
- Do not recreate allocation calculations, derive tactical weights from raw model inputs, or expose calculation details in HTML, JSON, scripts, README, or mockups.
- Use only the sanitized exported result when portfolio-level values are required.
- If sanitized result data is unavailable, show instrument-level data without fabricating tactical weights.
- Tape commentary explains market drivers; it does not restate quote values or contain citation language.
- Do not include future dividend events in current MTD totals or returns.
- Prefer reputable free-to-read or less paywalled articles when equivalent coverage exists, without sacrificing source quality, timeliness, or originality.
- Keep removed or filtered dashboard items out of prominent visible summaries.
- When labels are renamed, sweep generated data, fetch scripts, validation, mockups, and visible UI strings for stale wording.

## Safety

Use narrow, task-specific network permissions for production fetches. Avoid broad persistent approvals for interpreters or package managers. Stop and ask if completing a task requires materially broader authority than the user granted.
