# Agent Review Policy

Read this file for focused reviews, broad audits, regression audits, changed-contract checks, and commenting passes.

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
