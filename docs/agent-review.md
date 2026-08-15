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
- Audit user-facing and developer-facing diagnostic text, including validator errors, console messages, comments, the applicable contracts in `docs/editorial.md` and `docs/reference.md`, and `README.md` runbook wording. Treat stale error text as a real finding when it would mislead the next maintenance pass even if behavior still validates.
- After a rename or data-contract change, compare renderer permissiveness with the canonical contract. Flag leftover compatibility fallbacks, alternate legacy keys, default story/data sources, optional tag aliases, and broad `oldName || newName` patterns unless they are intentionally documented backward compatibility.
- When a renderer fallback is intentionally kept, verify the validator and documentation name that fallback and explain why production still needs it. Otherwise, prefer making the renderer, validator, generated data, and documentation strict in the same direction.
- When validation code changes, audit whether the validation could pass while the intended behavior remains broken.
- Treat fail-closed behavior as blocking publication or preventing the canonical dashboard write. Fail closed only for malformed HTML, unparsable embedded JSON, missing required runtime blocks, render-surface shapes that would break dashboard initialization, core published-file safety issues, or another condition explicitly documented as publication-blocking. Partial, unavailable, omitted, blank, recoverable, or section-level failures must fail open unless they would prevent the overall dashboard from displaying.
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

## Closure Audit Protocol

Use this protocol for a broad audit requested after audit findings have been fixed, for a requested closure audit, or when the user asks to stop progressive rediscovery.

- After an audit report has been issued, `rerun`, `recheck`, `verify`, or `audit again` means a closure audit unless the user explicitly requests a new full-repository rebaseline. A closure audit may report only an original finding that remains unresolved, a regression introduced or worsened by its fixes, a defect within the frozen changed-contract matrix, or an unchanged defect proven to prevent overall dashboard startup. Do not investigate or report unrelated pre-existing issues during closure.
- Freeze the complete changed-contract matrix before editing starts. Include every transitive renderer, validator, fallback, documentation, and test path that implements or proves the changed behavior. If the worktree is dirty, identify the baseline by commit plus dirty-file list; after commit, identify the durable baseline by commit.
- Before implementation, freeze a finite, contract-derived malformed-input corpus. Include one representative for each relevant equivalence class: rejected, fulfilled-malformed, absent, null, wrong primitive type, wrong container type, malformed member, stale, carried-forward, and unavailable. Add combinations only at explicit fallback or state-transition boundaries, and record why a class is not applicable. Do not invent additional mutation classes during closure unless a fix changed the relevant parser or state transition.
- Verify isolation explicitly. One bad ticker, row, card, event, provider, section, or fallback input must not degrade unrelated data unless the documented contract is intentionally atomic.
- Test staged and published modes separately against the fail-open publication policy. Staged validation may reject data that Prepare must normalize or replace with an unavailable state; published validation should block only artifact renderability and core published-file safety unless the reference marks the condition publication-blocking.
- Exercise actual browser startup for each frozen malformed published-data equivalence class that published validation allows through and that reaches a changed renderer or startup path. A static validator pass is not sufficient evidence for those render-surface classes.
- Do not close the audit until every finding is marked resolved, intentionally accepted, or outside scope, with evidence for that classification.
- After closure establishes a baseline, subsequent audits default to reporting only regressions introduced or worsened since that baseline. Do not reopen the repository with progressively broader probes unless the user explicitly requests a new full audit or rebaseline.
- If an unchanged defect discovered after closure can prevent the overall dashboard from displaying, report it as a baseline breach with evidence and the preferred fix. Do not use that exception to reopen unrelated non-regression findings.

## Audit Output Format

For every actionable audit finding, include:

- `Preferred fix`: the concrete code, data, validation, or documentation change recommended.
- `Why this fix`: why this is the smallest canonical solution and what drift, regression, or user-visible risk it removes.
- `Verification`: the specific test, validation command, browser check, or focused sweep that should prove the fix.

Report an item as an actionable finding only when the evidence demonstrates incorrect runtime or browser-visible behavior, financial or data-integrity risk, incorrect fallback or isolation, a validator false pass or false rejection with operational consequences, a documented publication-boundary violation, or test/documentation wording that could cause an incorrect maintenance or publication decision. Put cosmetic wording, redundant fixtures, speculative hardening, and diagnostics already superseded by stronger evidence under `Non-blocking observations`; they do not prevent closure.

Keep findings ordered by severity with file/line references first. Keep remediation concise, but do not omit the preferred solution for actionable items.

## Changed Contract Matrix

When auditing uncommitted changes, recent fixes, or changed validation, define the intended changed behavior before reporting findings.

Create an internal matrix covering relevant changed surfaces. For closure audits and audit finding fixes, freeze this matrix before implementation begins and treat it as the scope that must be resolved, accepted, or marked outside scope before closure:

- Runtime markup or generated DOM
- CSS selector applicability when layout/styling changed
- JavaScript data/rendering path
- Browser-visible behavior
- Static/check-script assertions
- Empty/loading/error states relevant to the change
- Rejected, fulfilled-malformed, absent, null, wrong type, stale, carried-forward, and unavailable data behavior relevant to the change
- Per-item, per-row, per-section, and cross-section isolation behavior relevant to the change
- Staged validation, Apply behavior, published validation, and browser startup behavior relevant to the change
- Mobile, narrow desktop, and desktop widths when layout is involved
- Documentation/comment wording affected by the change

For every changed fallback, add a transition table covering fresh-result state, prior-state eligibility, expected output state, and isolation result. At minimum, distinguish fresh valid, rejected, and fulfilled-malformed results against prior fresh, carried-forward, unavailable, malformed, absent, and out-of-range states.

Before removing or renaming a field, freeze its complete occurrence inventory across producer output, prior-canonical fallback, normalizer, validator, Apply path, renderer, fixtures, generated canonical data, documentation, and diagnostics. Closure verifies that exact inventory; it does not begin a new general naming sweep.

When validation depends on markup identity, test semantic equivalence rather than exact source strings. Cover attribute order, additional non-conflicting attributes, duplicate IDs with different markup, required nesting, and browser DOM resolution.

For each row, verify:

- What file or line implements the behavior
- What evidence proves it works
- Whether the existing check could pass falsely
- Any remaining uncertainty
- Whether the behavior fails open or fails closed, and why that matches the documented publication policy

## Commenting Pass Guidance

When asked to add comments:

- Do not change functionality or UI behavior.
- Add comments only where they clarify intent, data flow, assumptions, non-obvious transformations, validation contracts, or operational constraints.
- For broad commenting runs after substantial changes, review each meaningful changed hunk for new or changed fallback, lifecycle, validation, source-boundary, stale-data, or editorial handoff behavior that would otherwise be non-obvious.
- Avoid comments that merely repeat the code.
- For scripts that fetch or transform financial data, document source expectations, stale-data behavior, fallback behavior, and output contracts.
- For validation scripts, document what contract the check proves and what it does not prove.
