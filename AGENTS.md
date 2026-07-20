# Project Guardrails

## Purpose

This is a personal static financial dashboard. Optimize for a reliable daily update, clear failure behavior, and low maintenance overhead. Do not add process or abstraction for hypothetical contributors.

## Startup Requirement

At the start of every new Codex task in this repository, read `AGENTS.md` and `README.md` before making recommendations, running update workflows, editing files, or performing reviews.

## Sources of Authority

Use each repository artifact only for the scope it owns:

- `AGENTS.md` is the canonical project-policy source for agent behavior. Its safety, scope, validation, audit, and file-ownership instructions govern automated work in this repository.
- `README.md` is the canonical human-readable operational runbook and data-contract source. Follow it for daily workflow details; do not duplicate, reinterpret, or extend its operational workflow here. Treat disagreement between these documents as documentation drift to resolve, not as an alternate workflow.
- Validators are executable enforcement of selected documented contracts.
- Tests are regression evidence for implementation paths.
- Neither validators, tests, nor fixtures independently define product or data policy, and fixtures are never production data.

## Scope and Worktree Safety

- Treat current working files as authoritative when the worktree is dirty. Preserve unrelated user changes.
- A dashboard data refresh authorizes changes only to staging and canonical generated data through the README workflow.
- Source code, tests, documentation, configuration, policy, visible UI, and repository structure require explicit user authorization.
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

## Implementation and Review

Default implementation policy: choose the simplest final architecture and implementation that satisfies this repo's contracts within the authorized scope, even when that requires a larger diff than preserving the current shape. When existing code carries accidental complexity, stale paths, unsupported compatibility branches, or speculative scaffolding, remove or avoid that complexity instead of designing around it.

### Simplicity Decision Gate

Before source-code edits, explicitly choose the smallest correct end state by checking:

- Can the requested behavior be achieved by deleting, narrowing, or reusing existing code before adding new code?
- Which existing file or function owns the behavior?
- Is a new helper, fallback, compatibility branch, public command, or production file truly necessary?
- Will the change preserve visible UI unless a visible change was explicitly requested?
- What focused runnable check proves the change?

When adding any helper, abstraction, fallback path, compatibility branch, or new production file, document in the work summary why existing code was insufficient. If that reason is weak, do not add it.

Work from this order of preference:

1. Delete or avoid code before adding code.
2. Reuse existing repo patterns before creating new helpers.
3. Fix root causes in the owning function or module instead of patching one caller path.
4. Prefer concise modern JavaScript and native browser APIs over wrappers, compatibility branches, or dependencies.
5. Recreate platform features only when the native feature fails a real dashboard requirement.
6. Add browser compatibility code only for the supported baseline; document the concrete Safari/WebKit or supported-browser behavior it protects.
7. Add helpers or abstractions only for real duplication, a meaningful contract, or a clearer ownership boundary.
8. Avoid defensive wrappers around readable standard APIs when the failure mode is outside the supported runtime contract.
9. Avoid framework-like abstractions unless the user explicitly asks for a broader architecture change.
10. Leave one focused runnable check for non-trivial new logic; skip ceremonial tests for trivial docs or one-line changes.
11. Focus tests on failures that could corrupt an update, bypass the sole-writer boundary, or take the dashboard offline; use the README for exact commands and verification requirements.
12. Mark deliberate simplifications with a code comment only when there is a known ceiling and upgrade path.

## Architecture and Ownership

Use a single-writer, staged, contract-driven architecture across every dashboard section. The README owns exact commands, payload fields, and detailed data contracts; this section owns the agent behavior boundary.

- Each deterministic value has one canonical owner. Derived display values must be rebuilt from that owner during every apply path.
- `*_contract.js` files own deterministic normalization, payload validation, stable identities, derived-field rules, and domain-specific editorial-completeness policy for domains with a separate contract module.
- `fetch_*.js` files own external-source retrieval and staging output. Fetchers and domain commands may write only staging/cache artifacts or explicit temporary diagnostic outputs.
- `scripts/run_daily_update.js` must stay thin application wiring and genuinely cross-section derivation. Domain policy must not live there.
- Keep approved public operational commands documented in `README.md`. Do not introduce a second public CLI for an existing domain; small CLI adapters belong in their public owner.
- Do not merge files solely because one has a single caller, and do not split files solely because one is long. Split only for a stable, independently understandable responsibility.
- No new production file is justified without a documented owner, callers, inputs, outputs, write authority, and public/private status.

## Visible UI and Verification

- Do not change visible styling, layout, markup, interactions, or responsive behavior unless the user requested that visible change.
- Functional, data-contract, validation, accessibility, and refactoring work must preserve existing visual presentation unless a visible change is inherently required by the requested behavior.
- Identify any required visible effect before implementation and keep it to the smallest necessary surface.
- Do not opportunistically resize, restyle, harmonize, modernize, or otherwise improve nearby controls.
- Treat accessibility, touch-target, consistency, modernization, and best-practice arguments as recommendations to raise with the user, not authorization to alter the UI.
- After source edits, inspect the diff for unintended visible or unrelated changes.

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

## Shared Review and Audit Notes

These notes apply to dashboard reviews, audits, regression audits, refactoring reviews, and commenting passes unless the user says otherwise.

- Prefer the smallest scope that reaches the simplest correct end state; do not preserve in-scope accidental complexity just to keep a patch small.
- Lead review reports with findings, ordered by severity, and include file/line references.
- Do not stop after finding the first issue. Continue the relevant sweep before reporting.
- When auditing after changes, distinguish:
  - New regression introduced by recent changes
  - Previously reported and still unresolved
  - Previously reported and now resolved
  - Pre-existing issue newly discovered during deeper review
- Do not classify a finding as a new regression unless the immediately preceding change or current uncommitted diff clearly introduced it.
- When a repeated pattern is found, complete a focused sweep for the same pattern before reporting.
- Check stale UI labels, variable names, comments, test names, renamed fields, renamed controls, dead code, unreachable code, unused helpers, and documentation drift.
- For refactor audits, run or approximate a mechanical declaration/reference sweep for touched JavaScript and embedded scripts. Investigate single-use or zero-use helpers, constants, local variables, event handlers, CSS hooks, data keys, and renderer helpers before reporting or removing them.
- Audit user-facing and developer-facing diagnostic text, including validator errors, console messages, comments, README contracts, and runbook wording. Treat stale error text as a real finding when it would mislead the next maintenance pass even if behavior still validates.
- After a rename or data-contract change, compare renderer permissiveness with the canonical contract. Flag leftover compatibility fallbacks, alternate legacy keys, default story/data sources, optional tag aliases, and broad `oldName || newName` patterns unless they are intentionally documented backward compatibility.
- When a renderer fallback is intentionally kept, verify the validator and documentation name that fallback and explain why production still needs it. Otherwise, prefer making the renderer, validator, generated data, and documentation strict in the same direction.
- When validation code changes, audit whether the validation could pass while the intended behavior remains broken.
- Do not require ceremonial checklists when a focused review answers the request.

## Audit Completeness Protocol

For broad dashboard audits, complete separate passes for:

1. Correctness and regressions
2. Runtime errors and event-handler issues
3. Data loading, parsing, validation, and stale-data behavior
4. Financial/data integrity and source-boundary issues
5. State management and data flow
6. UI behavior, layout, responsive behavior, and browser-visible output
7. Browser compatibility concerns
8. Error handling and fallback behavior
9. Empty, null, malformed, or unexpected data handling
10. Performance concerns with practical user impact
11. Maintainability and code organization
12. Naming consistency and wording drift
13. Dead code, stale references, and unused helpers
14. Test and validation coverage gaps
15. Documentation gaps that materially affect maintainability
16. Renderer/validator/data-contract strictness, including legacy fallbacks and aliases

Before reporting findings, create an internal checklist of the relevant passes. Do not produce the audit report until the in-scope passes have been completed.

When reporting a broad audit, include an `Audit Coverage` section listing:

- Audit passes completed
- Files reviewed
- Files sampled only
- Areas that could not be fully verified
- Confidence level: High / Medium / Low

## Audit Output Format

For every actionable audit finding, include:

- `Preferred fix`: the concrete code, data, validation, or documentation change recommended.
- `Why this fix`: why this is the smallest canonical solution and what drift, regression, or user-visible risk it removes.
- `Verification`: the specific test, validation command, browser check, or focused sweep that should prove the fix.

Keep findings ordered by severity with file/line references first. Keep remediation concise, but do not omit the preferred solution for actionable items.

## Changed Contract Matrix

When auditing uncommitted changes, recent fixes, or changed validation, define the intended changed behavior before reporting findings.

Create an internal matrix covering relevant changed surfaces:

- Runtime markup or generated DOM
- CSS selector applicability when layout/styling changed
- JavaScript data/rendering path
- Browser-visible behavior
- Static/check-script assertions
- Empty/loading/error states relevant to the change
- Mobile, narrow desktop, and desktop widths when layout is involved
- Documentation/comment wording affected by the change

For each row, verify:

- What file or line implements the behavior
- What evidence proves it works
- Whether the existing check could pass falsely
- Any remaining uncertainty

## Commenting Pass Guidance

When asked to add comments:

- Do not change functionality or UI behavior.
- Add comments only where they clarify intent, data flow, assumptions, non-obvious transformations, validation contracts, or operational constraints.
- For broad commenting runs after substantial changes, review each meaningful changed hunk for new or changed fallback, lifecycle, validation, source-boundary, stale-data, or editorial handoff behavior that would otherwise be non-obvious.
- Avoid comments that merely repeat the code.
- For scripts that fetch or transform financial data, document source expectations, stale-data behavior, fallback behavior, and output contracts.
- For validation scripts, document what contract the check proves and what it does not prove.

## Safety

Use narrow, task-specific network permissions for production fetches. Avoid broad persistent approvals for interpreters or package managers. Stop and ask if completing a task requires materially broader authority than the user granted.
