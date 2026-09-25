# Agent Implementation Policy

Read this file for source-code changes, architecture changes, refactors, tests, and visible UI work.

## Implementation Policy

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
11. Focus tests on failures that could corrupt an update, bypass the sole-writer boundary, or take the dashboard offline. Use `README.md` for daily publication checks and this file's Source-change and audit verification section for development checks.
12. Mark deliberate simplifications with a code comment only when there is a known ceiling and upgrade path.

### Audit Finding Fixes

When implementing audit findings, use the frozen changed-contract matrix from `docs/agent-review.md` as the implementation scope. Do not narrow the fix to the single failing example if the contract also covers adjacent renderer, validator, fallback, documentation, or test behavior.

- Fix the owning contract path and every transitive consumer needed to keep renderer, validator, generated data, fallback behavior, documentation, and tests in sync.
- Preserve the repo's fail-open publication policy. Do not add a publication-blocking or canonical-write-blocking condition unless it prevents the overall dashboard from displaying or is explicitly marked as publication-blocking by the owning contract in `docs/reference.md`.
- Verify behavior classes for the changed contract: rejected, fulfilled-malformed, absent, null, wrong type, stale, carried-forward, and unavailable inputs, or document why a class is not applicable.
- Verify isolation explicitly: one bad ticker, row, card, event, provider, section, or fallback input must not degrade unrelated data unless the documented contract is intentionally atomic.
- Verify staged and published modes separately when both are affected. Run an actual browser-startup check for each malformed published-data shape that published validation allows through and that reaches a renderer or startup path changed by the fix. A change confined to staging metadata, validation, documentation, or another non-runtime path does not require browser verification unless it changes the published shapes that can reach runtime.
- Before marking the fix complete, make sure every matrix row and every finding is resolved, intentionally accepted, or outside scope with evidence.

## Architecture and Ownership

Use a single-writer, staged, contract-driven architecture across every dashboard section. `README.md` owns the normal daily runbook and validation/publish workflow; `docs/reference.md` owns payload fields, detailed data contracts, deterministic-source contracts, focused repair commands, local-refresh operation, and the supported-browser baseline; this section owns the agent behavior boundary.

- Each deterministic value has one canonical owner. Derived display values must be rebuilt from that owner during every apply path.
- `*_contract.js` files own deterministic normalization, payload validation, stable identities, derived-field rules, and domain-specific editorial-completeness policy for domains with a separate contract module.
- `fetch_*.js` files own external-source retrieval and staging output. Fetchers and domain commands may write only staging/cache artifacts or explicit temporary diagnostic outputs.
- `scripts/run_daily_update.js` must stay thin application wiring and genuinely cross-section derivation. Domain policy must not live there.
- Keep normal update, validation, and publication commands documented in `README.md`; keep exceptional repair and local-tool commands in `docs/reference.md`. Do not introduce a second public CLI for an existing domain; small CLI adapters belong in their public owner.
- Do not merge files solely because one has a single caller, and do not split files solely because one is long. Split only for a stable, independently understandable responsibility.
- No new production file is justified without a documented owner, callers, inputs, outputs, write authority, and public/private status.

## Visible UI and Verification

- Do not change visible styling, layout, markup, interactions, or responsive behavior unless the user requested that visible change.
- Functional, data-contract, validation, accessibility, and refactoring work must preserve existing visual presentation unless a visible change is inherently required by the requested behavior.
- Identify any required visible effect before implementation and keep it to the smallest necessary surface.
- Do not opportunistically resize, restyle, harmonize, modernize, or otherwise improve nearby controls.
- Treat accessibility, touch-target, consistency, modernization, and best-practice arguments as recommendations to raise with the user, not authorization to alter the UI.
- After source edits, inspect the diff for unintended visible or unrelated changes.

### Source-change and audit verification

Browser UI checks belong to source-code testing and audits, not routine dashboard data updates or publication. Editing Opening, Market Lens, Outcome, or other editorial copy does not by itself require a browser pass.

- After structural or layout source changes, run `tidy -q -e daily_financial_news.html` and inspect the affected page at relevant widths.
- After source changes to Market Lens or Outcome rendering, reactions, or routing, check narrow mobile and desktop widths for readability and overflow. Activate pre-close and post-close reaction controls with pointer and keyboard; verify the correct Tape group, ticker, and chart open, focus moves to the chart heading, and repeated activation leaves that chart open.
- After information-tooltip source changes, run `node scripts/test_dashboard.js --browser`, then check tap, hover, and keyboard activation at narrow mobile, tablet, and desktop widths. Verify that the tooltip remains inside the viewport, paints above neighboring controls, and stays legible.
- Run `node scripts/validate_dashboard.js test` after script or data-contract changes when publication is not the immediate next step. It runs the focused test scripts, so keep those checks sequential. Run `node scripts/test_dashboard.js --browser` after embedded runtime or startup changes. Run `node scripts/test_market_data.js` when changing local-refresh behavior without the full aggregate suite.
- Nonvisual data, contract, validation, and refactoring changes need no browser pass when they do not affect the embedded runtime, startup, renderer behavior, or published data shapes that can reach those paths. For malformed published shapes reaching a changed renderer or startup path, follow the browser-startup requirements above and in `docs/agent-review.md`.
