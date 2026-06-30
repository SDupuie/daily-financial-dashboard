# Project Instructions

## Repository Directory Usage

Use the top-level files and directories according to their intended ownership:

- `daily_financial_news.html`: Canonical generated dashboard artifact and embedded dashboard data used by the current static dashboard.
- `index.html`: Root entry point for the published dashboard.
- `mockups/`: Visual or interaction mockups created for design exploration. Production must not depend on mockup files or sidecar JSON at runtime.
- `scripts/`: Operational automation, data-fetch utilities, validation checks, publishing helpers, and tests for dashboard behavior.
- `README.md`: Project documentation and operational notes.

Default file-change policy:

- Do not create, edit, or delete project files outside `mockups/` for visual design exploration unless the user specifically asks to modify dashboard source, data, scripts, tests, documentation, repository configuration, or publishing assets.
- When the user asks for a visual design concept or UI mockup that is not yet meant to be wired into the real dashboard, keep new files under `mockups/`.
- When the user asks to update the real dashboard data, rendering path, validation, publishing scripts, or documentation, edit the canonical files directly.
- Prefer reusing an existing appropriate file over creating a new one.
- If a new top-level directory seems necessary, ask the user first.

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
- Tape commentary should explain the factors driving recent action in that market. It should not merely restate last price, delta, or percent change.
- Tape commentary should not contain source/citation language.
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

Before reporting findings, create an internal checklist of the relevant passes. Do not produce the audit report until the in-scope passes have been completed.

When reporting a broad audit, include an `Audit Coverage` section listing:

- Audit passes completed
- Files reviewed
- Files sampled only
- Areas that could not be fully verified
- Confidence level: High / Medium / Low

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
