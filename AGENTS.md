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

## Sources of Authority

Use each repository artifact only for the scope it owns:

- `AGENTS.md` is the canonical project-policy source for agent behavior. Its safety, scope, validation, audit, and file-ownership instructions govern automated work in this repository.
- `README.md` is the canonical human-readable operational and data-contract source. Keep it aligned with production behavior and project policy; treat a disagreement between these documents as documentation drift to resolve, not as an alternate workflow.
- `daily_financial_news.html` is the canonical published runtime artifact and contains the current embedded production payload. Its generated runtime or data must still conform to the contracts documented in `README.md`.
- Files under `generated/` are staging or cache artifacts. A workflow may treat one as its current build input, but it does not supersede the published artifact or documented contract.
- Validators are executable enforcement of selected documented contracts. Tests are regression evidence for implementation paths. Neither validators, tests, nor fixtures independently define product or data policy, and fixtures are never production data.

## Dashboard Architecture Policy

Use a single-writer, staged, contract-driven architecture across every dashboard section.

### Section lifecycle

Every section follows the same lifecycle: produce deterministic staging data, reject source data the producer cannot reliably normalize, assemble it into a complete dashboard candidate, perform only explicitly editorial work in the editorial workspace, validate the finalized candidate, and atomically replace the canonical dashboard artifact.

- Fetchers and domain commands may write only staging/cache artifacts; operational defaults belong under `generated/`, while explicit test/diagnostic outputs may use temporary paths. They must never edit dashboard HTML.
- `scripts/run_daily_update.js` is the sole operational writer for `daily_financial_news.html`. It owns sequencing, cross-section integration, editorial handoff, receipt application, candidate validation, and atomic replacement.
- Normal deterministic preparation must not partially update the canonical dashboard. Staging writes use the private `staging_writer.js` atomic-write helper, one updater preparation owns the generated run lock at a time, and focused repair modes use the same candidate-validation and atomic-replacement path.
- `scripts/validate_dashboard.js` is the public validation, complete-test, and readiness entry point. Validation is read-only.
- `scripts/publish_main.sh` owns publishing only and must not fetch, normalize, or edit dashboard data.
- `scripts/local_market_server.js` owns only the ephemeral browser refresh overlay and must never update the canonical artifact.

### Section ownership matrix

This matrix is the canonical implementation partition for the normal daily workflow. A change that adds a section, staging artifact, editorial sidecar, validation boundary, or write path must update this matrix, the corresponding executable architecture tests, and the README runbook in the same change.

| Surface | Deterministic owner and staging input | Domain contract or staging gate | Editorial workspace scope | Final application and write authority |
| --- | --- | --- | --- | --- |
| Envelope: masthead, edition/session labels, compile prefix, scheduled baseline | `run_daily_update.js` derives these cross-section fields while assembling `generated/daily_financial_news.candidate.html` | Updater-owned cross-section derivation plus independent dashboard validation | Only the documented driver/source/holiday context may be edited; generated envelope fields remain unchanged | `run_daily_update.js` re-derives the envelope and may write it only through validated final candidate replacement |
| Opening | No independent producer; prior editorial content is carried into the staged complete candidate | Editorial completeness and final dashboard validation | `generated/editorial/dashboard-data.json` owns headline, deck, and catalyst copy | `run_daily_update.js` applies reviewed dashboard data; no other script writes the section |
| Futures | `fetch_chart_data.js futures` writes `generated/futures_module.json` | The Chart/Futures owner validates each contract, emits unavailable shells only for failed contracts, and owns the explicit current-window unavailable fallback when the command itself fails; final dashboard validation remains independent | Only `futuresModule.stories[]` is editorial | `run_daily_update.js` applies the validated fresh/partial/unavailable payload and derives window labels without redefining Futures policy |
| Tape and embedded charts | `fetch_chart_data.js` writes `generated/chart_data.json`; embedded `chart-data.series` is canonical | Chart normalization/projection isolates each ticker and carries only a failed ticker's prior series; the consolidated Chart owner also owns the whole-section carried fallback; `validate_dashboard.js` independently checks final series, availability, quotes, and Tape coherence | Tape roster changes are intentional editorial decisions; every retained row's commentary is editorial | `run_daily_update.js` embeds fresh and explicitly carried series together and re-derives `chart-data.quoteRows` plus visible Tape quote fields on every apply path |
| Crypto | `fetch_crypto_stats.js` writes `generated/crypto_stats.json`; crypto quote series come from the Chart producer | Crypto normalization isolates each provider card, retains same-card prior data or emits an unavailable card, and owns the whole-section carried/unavailable fallback; final dashboard validation enforces availability, stat-card, and Tape placement contracts | `crypto.notes[]` and crypto Tape commentary are editorial; stat values and quote fields are not | `run_daily_update.js` applies mixed fresh/carried/unavailable cards and chart-derived crypto quotes through the complete candidate |
| Asset Allocation | `fetch_asset_allocation.js` independently writes `generated/asset_allocation_portfolio.json` and `generated/asset_allocation_summary.json` from instrument data and the sanitized export | Portfolio normalization isolates each ETF; same-month failures retain only the affected row and new-month failures emit unavailable rows. The portfolio and sanitized summary have separate updater transactions and fallbacks; final dashboard validation enforces the published display contract | Review only; do not create strategy logic or hand-edit deterministic values | `run_daily_update.js` independently applies the portfolio rows and sanitized summary so either successful artifact survives failure of the other |
| News Flow and promoted stories | No market-fact producer; `news_contract.js` owns pure identity, URL, coverage, baseline, and New-pill transitions | News contract plus final freshness, link, coverage, duplication, and claim validation | `stories[]`, `crypto.notes[]`, and `futuresModule.stories[]` are edited in `generated/editorial/dashboard-data.json` | `run_daily_update.js` applies reviewed stories, derives complete or retryable partial section coverage, and applies scheduled-baseline transitions |
| Week Ahead | `fetch_week_ahead.js` writes `generated/week_ahead.json` | `week_ahead_contract.js` isolates unavailable schedule authorities, FXMacro indicators, and unknown event keys while retaining accepted events; it also owns lifecycle, surprises, reactions, Market Lens defaults, post-close dispositions, validation, and same-range/rollover fallback construction | Market Lens decisions and verified post-close outcomes are completed in the common editorial workspace; unusable optional decisions default to the validated generated lens and unavailable outcome commentary receives an explicit retryable disposition | `run_daily_update.js` merges deterministic facts or an explicit fallback, retries missing items and unavailable rollover ranges, applies normalized decisions, derives lifecycle views, finalizes outcome dispositions, and commits only the complete candidate |
| Earnings | `earnings_week.js` owns build/refresh/apply commands and `generated/earnings_week.json`; result collection isolates Finnhub, each EarningsAPI company symbol, and each Yahoo symbol before staging pending narrative tasks | `earnings_week_contract.js` owns row/lifecycle/narrative and field-level editorial-disposition policy, row-level result-refresh diagnostics, same-range/rollover fallback, field-level partial provenance for non-resolved company-release dispositions, and the official schedule-fallback order: company investor relations before SEC | Verified copy or explicit retryable unavailable dispositions are recorded only in `generated/editorial/earnings_narrative.json`; schedule-review research records event-scoped official confirmation input without altering deterministic facts | `run_daily_update.js` binds the editorial sidecar to staged facts, preserves successful ticker refreshes, retries active `primary_only` schedule rows once on a later Central-time day, independently promotes SEC-backed actuals from `needs_review`, accepts recorded non-resolved and editorial-unavailable dispositions without fabricating facts or copy, and applies the validated section during finalization |
| Editorial review and receipt | `editorial_review_contract.js` creates the review skeleton/receipt contract; `generated/editorial/editorial-review.json` is the staging input | The pure review contract validates section coverage, claims, base edition, normalized decisions, and payload hash; malformed optional story rows, copy fields, narrative rows, and Market Lens decisions are quarantined before receipt validation | Review every declared section and complete all decision/evidence fields | Only `run_daily_update.js` may preserve validated candidate copy, apply accepted editorial items, and stamp the hash-bound receipt into the final candidate |
| Canonical artifact and publication | `generated/daily_financial_news.candidate.html` is the deterministic complete staging candidate; `generated/daily_financial_news.last_good.html` is an ignored validated recovery snapshot; `daily_financial_news.html` remains unchanged during preparation | `validate_dashboard.js` validates staging and finalized candidates with the appropriate editorial-completeness gate; malformed canonical JSON may recover only from the last validated snapshot | No direct HTML editing is part of the daily workflow | Only `run_daily_update.js` may atomically replace `daily_financial_news.html` and refresh the recovery snapshot; only `publish_main.sh` may run readiness and push publication |

### Fail-open invariant

Every recoverable source, staging, evidence, or editorial-content failure must be converted into the domain's documented nonblocking fallback before complete-candidate validation. The fallback must preserve accepted neighboring data, avoid fabricated facts, remain correct for the displayed period, and be retried on subsequent runs. A domain implements only the fallback states meaningful to its lifecycle. Final validation remains strict: it validates the selected fallback rather than requiring unavailable source data.

The following matrix defines fail-open compliance. It does not impose a universal status list or require a section to implement states that have no meaning for that section.

| Section | Recoverable boundary | Required fallback | Retry behavior | Test owner |
| --- | --- | --- | --- | --- |
| Futures | One contract or the whole Futures artifact cannot be normalized | Preserve valid contracts and emit an unavailable row for each failed contract; use a correctly labeled unavailable module only when no valid contract artifact can be assembled | Retry failed contracts on every run and clear diagnostics after success | `test_dashboard.js:testFuturesStagingPayloadContract` |
| Chart/Tape | One ticker or the whole chart artifact cannot be normalized | Preserve fresh series and retain only same-period validated series for failed tickers; derive Tape quotes again from the mixed accepted chart payload | Retry failed tickers on every run and clear diagnostics after success | `test_dashboard.js:testChartFetcherTickerFilterAndMergeChartDataCliMode` |
| Crypto | One stat provider or the whole stat artifact fails | Preserve successful cards; retain the matching validated card or emit an unavailable card only for the failed provider | Retry failed providers on every run and clear diagnostics after success | `test_dashboard.js:testUpdaterQuoteAndCryptoPatches` |
| Asset Allocation | One holding, the portfolio artifact, or the sanitized summary fails | Handle holdings, portfolio, and summary independently; retain same-month accepted values and use unavailable rows for a new month rather than carrying misleading dates | Retry each failed holding or artifact independently on every run | `test_dashboard.js:testUpdaterModulePatches` |
| News Flow and promoted stories | Too few qualifying fresh stories are available, including during a focused deterministic repair | Publish every qualifying story that remains valid and record partial section coverage; a focused repair removes stale retained items before validation rather than stranding its target section; never relax URL, freshness, duplication, or claim checks | Re-evaluate coverage on every editorial apply and clear partial metadata when complete | `test_news.js:testNewsCoverageState`; `test_dashboard.js:testDashboardValidatorAllowsPartialNewsCoverageWithoutRelaxingStoryQuality`; `test_dashboard.js:testFocusedEarningsApplyUsesNewsPartialFallback` |
| Week Ahead | One authority, indicator, editorial outcome, or the whole active-range artifact fails | Preserve accepted events and values; use the generated Market Lens for unusable decisions, an explicit unavailable outcome for missing commentary, and a correctly dated empty shell only when the active range cannot be assembled | Retry failed items and unavailable rollover ranges on every run | `test_week_ahead.js:testProducerAndScheduleNormalization`; `test_week_ahead.js:testWeekAheadPreparationFallbacks`; `test_dashboard.js:testDeterministicSectionFallbackContracts` |
| Earnings | Schedule confirmation, provider result, company release, narrative, or the whole active-range artifact remains unresolved | Preserve admitted rows and every independently accepted fact with domain-specific provenance and warnings; on EarningsAPI outage or budget exhaustion, queue company-IR then SEC schedule research while retaining the Finnhub row as `primary_only`; use a correctly dated empty shell only when the active range cannot be assembled. Final editorial apply must not silently publish a skipped narrative pass: each missing narrative field requires verified copy or an explicit editorial-attempted unavailable disposition | Retry active `primary_only` schedule rows once on a later Central-time day; retry other unresolved rows, fields, narratives, and unavailable rollover ranges on every run | `test_earnings_week.js:testScheduleReviewAndPreparationFallbacks`; `test_earnings_week.js:testRefreshCollectionIsolatesProvidersAndTickers`; `test_earnings_week.js:testResultRefreshFailuresAreRowScoped`; `test_earnings_week.js:testEarningsNarrativeCompletenessIsDeferredToEditorialFinalization`; `test_dashboard.js:testEditorialEarningsMissingCopyBlocksFinalApplyUntilAttempted`; `test_dashboard.js:testDashboardCandidateAppliesEarningsSectionFallback` |
| Editorial content | An optional story, copy field, Market Lens decision, or narrative item is malformed or unavailable | Omit the unsupported item, retain validated candidate copy, use the generated lens, or apply the domain's unavailable disposition; remove unsupported claims and record system-applied fallback separately from human review. A focused repair restamps a hash-bound receipt after system fallback rather than removing publication auditability | Reconsider every system-applied fallback during the next editorial apply | `test_dashboard.js:testArchitectureFinalizationValidatesBeforeReplace`; `test_dashboard.js:testFocusedEarningsApplyRestampsEditorialReview` |
| Canonical artifact | Embedded canonical JSON is malformed but a validated recovery snapshot exists | Assemble from the last validated snapshot and subject the resulting candidate to normal complete validation before replacement | Refresh the recovery snapshot after the next successful canonical replacement | `test_dashboard.js:testLastGoodDashboardRecovery` |
| Post-commit staging | Staging/cache synchronization fails after canonical replacement | Keep the validated committed dashboard, report the synchronization failure, and do not roll back publication | Retry synchronization on the next run | `test_dashboard.js:testFocusedApplyValidatesBeforeAtomicReplace` |

Shared architecture assertions are intentionally not duplicated in every domain test: `test_dashboard.js:testArchitecturePreparationLeavesCanonicalUnchanged` proves that deterministic preparation does not modify the canonical dashboard, while `test_dashboard.js:testDeterministicSectionFallbackContracts` proves validator-clean assembly of the mixed deterministic fallback candidate. Row-owned tests prove the applicable neighboring-data, no-fabrication, period, retry, and recovery behavior.

Architecture invariants enforced by tests:

- Deterministic preparation leaves the canonical dashboard byte-for-byte unchanged and writes only the staged complete candidate.
- The editorial handoff contains exactly `dashboard-data.json`, `earnings_narrative.json`, and `editorial-review.json`; new editorial sidecars require an explicit matrix and test update.
- A stale candidate/base-edition binding is rejected before editorial handoff or final replacement.
- Producers and domain contracts own reusable domain acceptance rules and must validate before persistent staging writes when the lifecycle requires it. The updater may invoke those rules but must not redefine them.
- Final dashboard validation is independent of producer acceptance validation and must be capable of rejecting a malformed assembled artifact even when a producer check passed.
- A source-refresh failure is section-scoped: the updater applies only a domain-owned, explicitly marked same-period carry or correctly dated unavailable shell, keeps complete-candidate validation strict, and retries an unavailable rollover range on every subsequent run until valid data replaces it.
- When a domain exposes independent row or ticker requests, successful rows must survive neighboring failures. Earnings result refresh records affected provider/ticker failures on the canonical row and retains only that row's prior validated fields.
- A successful producer command is not sufficient: the updater must read and validate the exact staged artifact before accepting it. Missing, malformed, or invalid output enters the same section transaction fallback as a command failure.
- Post-commit staging/cache synchronization is best-effort and cannot reverse an already validated canonical replacement. The next run retries any failed synchronization.
- Focused repair modes are an explicit allowlist, use complete candidate validation, and reach the canonical artifact only through the same atomic replacement function.
- The complete test entry point and publishing path must execute the architecture contract tests; changing or bypassing those tests is an architecture-policy change, not routine implementation work.

### Validation gates

- Every producer must reject source data it cannot reliably normalize. These producer sanity checks protect the staging boundary but do not need a separate validator file or reusable domain-validation API.
- A staging artifact must have explicit domain validation before downstream consumption when it persists across runs, anchors sidecars or later decisions, supports editorial work, or passes through multiple domain commands. Keep that validation in the owning contract or, when its implementation is substantial, in a private module reached through the domain's public CLI.
- Every dashboard change, including changes assembled from one-hop staging payloads, must pass complete candidate validation before atomic replacement of the canonical dashboard artifact.
- Do not create domain validators merely for structural symmetry. Add one only when the staging artifact's lifecycle requires an independently enforced boundary.

### Domain ownership

- `*_contract.js` files own deterministic normalization, payload validation, stable identities, derived-field rules, and domain-specific editorial-completeness policy for domains with a separate contract module. Contract modules must not use filesystem, network, environment, CLI-argument, child-process, or process-exit APIs.
- `fetch_*.js` files own external-source retrieval and staging output. A producer may expose subcommands for closely related outputs in the same dashboard domain.
- A documented consolidated domain producer may also export pure staging transformations used by the updater, validator, or local service when a separate contract file would not own an independently understandable responsibility.
- A complex domain may expose one public core CLI, such as `scripts/earnings_week.js`. Large build or validation implementations may remain separate private modules, but the core CLI must import them directly rather than spawning sibling JavaScript files.
- Private implementation modules must export callable functions and fail fast with guidance when executed directly.
- Cross-domain orchestration may invoke documented public domain CLIs as subprocess boundaries; within one domain, use direct imports.
- Domain policy must not live in `run_daily_update.js`; the updater may contain only thin application wiring and genuinely cross-section derivations.

### Canonical and derived fields

- Each deterministic value has one canonical owner. Derived display values must be rebuilt from that owner during every apply path.
- Embedded `chart-data.series` owns chart history; `chart-data.quoteRows` and visible Tape prices are derived views.
- Week Ahead calendar facts, release states, comparable surprises, and event-day close reactions are deterministic; pre-release Market Lens decisions, post-close Week Ahead outcomes, and explicitly requested earnings narrative fields are editorial.
- Event-driven sections must expose the shared deterministic lifecycle states `scheduled`, `awaiting_actual`, `released_awaiting_close`, and `close_available`. A domain may retain additional error detail outside that lifecycle, but it must not use an error label for a merely incomplete time window.
- Pre-event editorial commentary remains valid through `released_awaiting_close`. The required close response—not the intermediate arrival of an actual—invalidates that preview and triggers post-event editorial replacement. A genuinely unresolvable reaction may invalidate the preview when the workflow can no longer reach `close_available`. Finalization stops when the editorial handoff still has unattempted narrative work; `commentary_unavailable` is valid only after the editorial pass records an explicit attempt.
- Missing post-event editorial verification is a valid, retryable disposition rather than a publication blocker. Deterministic actuals and market reactions remain visible; `unverified` must never be interpreted as proof that guidance was not provided, and stale or generic copy must not be substituted.
- Masthead date/edition, session labels, compile prefix, and scheduled baseline metadata are updater-derived envelope fields.
- News collection coverage metadata is updater-derived from the finalized qualifying story collections; partial coverage relaxes only minimum cardinality and remains retryable on later runs.
- Generated and editorial sidecars are staging inputs only and are never published runtime dependencies.

### Public commands and private modules

- Keep the approved public operational commands documented in `README.md`.
- Do not introduce a second public CLI for an existing domain. Small CLI adapters belong in their public owner.
- Do not merge files solely because one has a single caller, and do not split files solely because one is long. Split only for a stable, independently understandable responsibility; merge adapters and subcontracts that do not own one.
- No new production file is justified without a documented owner, callers, inputs, outputs, write authority, and public/private status.

### Test architecture

- `test_<domain>.js` owns self-contained domain policy, producer, and domain-command coverage.
- `test_dashboard.js` owns complete-artifact, cross-section, embedded-runtime, candidate-commit, and local-service integration coverage.
- Test-suite entry points must not import other test-suite entry points. Small local fixture/runtime helpers are preferable to cross-suite dependencies.
- `node scripts/validate_dashboard.js test` is the complete regression command and must enforce JavaScript/shell syntax, plist validity, contract purity, test independence, all domain/integration suites, canonical dashboard validation, HTML validation, and whitespace checks.
- Regression, audit, commenting, source-verification, and development work must not invoke live production fetches for evidence. Exercise fetch behavior with deterministic fixtures or injected responses. Metered EarningsAPI calendar calls are reserved for one authorized production scan of the 26-day corroboration window during Monday-morning, Friday-afternoon, an explicitly requested manual calendar rollover, or one later Central-time daily retry for active `primary_only` rows.

Default file-change policy:

- A request to run, refresh, or publish dashboard data authorizes changes only to staging artifacts and canonical generated data through the documented updater workflow. It does not authorize edits to source code, tests, documentation, repository configuration, or project policy. If an update exposes a source defect or contract gap, stop the update before changing those files, report the blocker, and obtain explicit user approval for the source change.
- Do not change any browser-visible styling, geometry, spacing, typography, color, markup, interaction affordance, or responsive behavior unless the user explicitly requested that visual or interaction change. Accessibility, touch-target, consistency, modernization, and best-practice arguments are recommendations to raise with the user; they are not authorization to alter the UI.
- Functional, data-contract, validation, accessibility, and refactoring work must preserve existing visual presentation unless a visible change is inherently required by the explicitly requested behavior. When a visible consequence is required, identify it before implementation and keep it to the smallest necessary surface. Do not opportunistically resize, restyle, harmonize, or otherwise “improve” nearby controls.
- Treat the current working file as authoritative when the worktree is dirty or another task may have edited the repository. Re-read the exact current ranges immediately before applying a narrow patch. Do not use a stale full-file snapshot, broad replacement, or carried-forward diff that can restore previously rejected or removed changes.
- After any source edit, inspect the resulting diff for browser-visible changes outside the user-authorized scope. Remove only unintended changes introduced by the current work. If authorship or intent is uncertain, stop and ask rather than preserving, reverting, or publishing the questionable visual change.
- Do not create, edit, or delete project files outside `mockups/` for visual design exploration unless the user specifically asks to modify dashboard source, data, scripts, tests, documentation, repository configuration, or publishing assets.
- When the user asks for a visual design concept or UI mockup that is not yet meant to be wired into the real dashboard, keep new files under `mockups/`.
- When the user asks to update real dashboard data, rendering, validation, publishing, or documentation, work in the canonical owning files and use the documented staged updater path for generated dashboard data; do not redirect production work into mockups.
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
- Crypto news and stat cards have their own section. Crypto ticker quote rows belong only in the Tape's `group: "Crypto"`; do not duplicate them in a separate `crypto.tape[]` payload.
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
