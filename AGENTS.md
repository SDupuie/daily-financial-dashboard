# Project Instructions

## Repository Directory Usage

Use the top-level files and directories according to their intended ownership:

- `daily_financial_news.html`: Canonical generated dashboard artifact and embedded dashboard data used by the current static dashboard.
- `generated/`: Ignored local staging/cache artifacts produced by fetchers and consumed by update or validation scripts; not source code and not a published runtime dependency.
- `index.html`: Root entry point for the published dashboard.
- `launchd/`: Optional local-machine LaunchAgent templates for running dashboard helper scripts; not used by GitHub Pages at runtime.
- `mockups/`: Visual or interaction mockups created for design exploration. Production must not depend on mockup files or sidecar JSON at runtime.
- `scripts/`: Operational automation, data-fetch utilities, validation checks, publishing helpers, and tests for dashboard behavior.
- `README.md`: Project documentation and operational notes.

Default file-change policy:

- Do not create, edit, or delete project files outside `mockups/` for visual design exploration unless the user specifically asks to modify dashboard source, data, scripts, tests, documentation, repository configuration, or publishing assets.
- When the user asks for a visual design concept or UI mockup that is not yet meant to be wired into the real dashboard, keep new files under `mockups/`.
- When the user asks to update the real dashboard data, rendering path, validation, publishing scripts, or documentation, edit the canonical files directly.
- Prefer reusing an existing appropriate file over creating a new one.
- If a new top-level directory seems necessary, ask the user first.

## Modern JavaScript and Platform API Policy

- Prefer modern JavaScript language features and native browser/platform APIs over custom wrappers, compatibility branches, or local abstractions.
- Do not add compatibility code for browsers outside the project's current supported baseline. If a fallback is required for Safari/WebKit or another supported browser, document the concrete browser behavior it protects.
- Do not recreate platform features such as native dialogs, form controls, pointer events, fetch cancellation, URL handling, dates/numbers via `Intl`, or browser file/download APIs unless the native feature fails a real dashboard requirement.
- Keep code concise and direct. Add helpers only when they remove meaningful duplication, encode domain policy, or clarify a shared responsibility boundary.
- Avoid defensive wrappers around standard APIs when the direct API call is readable and the failure mode is already outside the supported runtime contract.
- Avoid boilerplate classes or framework-like component abstractions in the vanilla static dashboard unless the user explicitly asks for a broader architecture change.
- Keep comments focused on intent, financial/data assumptions, browser-specific behavior, and non-obvious data flow. Do not duplicate comments for trivial one-line helpers or restate what a platform API already says.
- Before adding a new custom UI abstraction, check whether current native browser capabilities can satisfy the requirement with less code and equal accessibility.

## External Project Boundary

The Asset Allocation Dashboard is a separate project and may contain proprietary strategy/model logic.

For this repository:

- Do not import `src/model.js` or equivalent model/strategy files from the Asset Allocation Dashboard.
- Do not copy strategy, tactical allocation, signal, ranking, selection, rebalance, or model logic into this repository.
- Do not recreate allocation calculations here.
- Do not derive tactical weights from raw model inputs.
- Do not expose calculation details in HTML, JSON, scripts, README, or mockups in this repository.
- It is acceptable to read sanitized system result data from the other project only when the user has made that data available and the task requires it.
- If sanitized result data is unavailable, show only instrument-level market data and clearly avoid fabricating tactical weights.

## Data Provenance and Dashboard Content

- Treat `daily_financial_news.html` as the source artifact for the current dashboard payload unless a task explicitly targets a generated mockup-only JSON file.
- Keep provenance useful but not visually overwhelming. The visible footer should summarize source families; detailed source audits belong in documentation, validation output, or generated metadata rather than a long UI paragraph.
- For story links, prefer reputable free-to-read or less paywalled articles when several sources cover the same basic story, without sacrificing source quality, timeliness, or originality.
- Tape commentary should explain the factors driving recent action in that market. It should not merely restate last price, delta, or percent change.
- Tape commentary should not contain source/citation language.
- Asset Allocation dividend lookahead buckets are display-only; do not include upcoming or future ex-date events in current MTD dividend totals or returns.
- Portfolio-level Asset Allocation return must come only from the sanitized local export. During local daily updates, refresh it via `http://127.0.0.1:2200/api/asset-market-data` before reading `/Users/Scott/Projects/Asset Allocation Dashboard/exports/daily-tape-summary.json`; never call that endpoint from the published dashboard or use it for display data.
- Keep removed or filtered dashboard items out of prominent visible summaries. For example, if a row is filtered out of the active mockup, do not foreground that row’s source details in the visible footer.
- Crypto has its own section; do not duplicate crypto rows inside The Tape unless the user explicitly asks.
- When labels are renamed, sweep generated data, fetch scripts, validation, mockups, and visible UI strings for stale wording.

## Validation and Browser Checks

Use the narrowest practical validation for the change:

- For dashboard data/content changes, run `node scripts/validate_dashboard.js daily_financial_news.html` when practical.
- For HTML mockup changes, run `tidy -q -e <file>`.
- For visual/layout changes, verify the active mockup in the browser and inspect actual rendered geometry or computed styles when layout correctness matters.
- For data-fetch script changes that alter generated JSON, update both the script defaults and the current generated JSON unless the user asks to defer regeneration.
- Do not treat a zero exit code as sufficient when a check may pass falsely; confirm it covers the intended implementation path.

## Common Permission Patterns

- Network-backed fetch scripts usually need network access. Request escalation directly when running commands that fetch Yahoo, MSCI, Treasury, FRED, CoinGecko, or other remote data.
- Avoid broad persistent approvals for interpreters or package managers. Use narrow, task-specific escalation.
- Do not use destructive git commands unless the user explicitly requests them.

## Shared Review and Audit Notes

These notes apply to dashboard reviews, audits, regression audits, refactoring reviews, and commenting passes unless the user says otherwise.

- Prefer minimal, targeted fixes over broad refactors.
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
- Avoid comments that merely repeat the code.
- For scripts that fetch or transform financial data, document source expectations, stale-data behavior, fallback behavior, and output contracts.
- For validation scripts, document what contract the check proves and what it does not prove.
