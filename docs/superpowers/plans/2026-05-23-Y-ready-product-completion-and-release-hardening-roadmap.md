---
title: Stage Y — Ready product completion and release hardening implementation plan
date: 2026-05-23
stage: Y-entry
status: refinement-r1 (in-place refinement of the 2026-05-23 entry roadmap; ready for codex review loop)
enforce: false
predecessors:
  - docs/superpowers/plans/2026-05-23-Y-product-surface-and-release-prep-seed.md
  - docs/superpowers/audits/2026-05-22-stage-x-closeout/CLOSE-NOTE.md
  - docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
refinement_history:
  - r0 (2026-05-23): initial roadmap draft (sections 0-10) by codex.
  - r1 (2026-05-23): Claude in-place refinement — added §3.x exit criteria precision, §4 phase ordering + parallelism table, §5 closeout-bundle file list, §6.x Y0.1 4-row disposition decision tree, §7 Y0.2 CI flip contract, §8 white-hardware live-evidence handoff schedule, §9 dogfood evidence schema + per-surface sub-plan template, §10 Stage U source discovery (Stage U closeout folder is missing; release checklist is the real source), §11 Y1.x scope locks, §12 Y2.x scope locks, §13 Stage Z entry contract, §14 verify-chain split (Y-entry vs Y-release-track), §15 expanded do-not list, §16 review cadence per phase, §17 rollback paths, §18 dispatch time estimate, §19 Stage Y closeout bundle structure (mirrors Stage X §10).
---

# Stage Y — Ready product completion and release hardening implementation plan

This file supersedes the inert seed at `docs/superpowers/plans/2026-05-23-Y-product-surface-and-release-prep-seed.md` without editing the seed in place. Its r0 version was authored by codex as a draft roadmap; r1 (this revision) is Claude's in-place refinement carrying it from roadmap to entry-implementation plan and is the artifact that enters the planning-review loop with codex.

The goal is not only to clear the Stage X ledger. The goal is to move Ready toward a product-complete, release-prepared state: real product surfaces dogfooded, known regressions either fixed or explicitly retired, CI made truthful, and release-only work separated into Stage Z.

## 0. Assumptions and completion standard

Assumptions:

- Stage X automated closeout is accepted as a baseline, but it did not finish live product proof.
- A product surface is not considered complete until both its automated checks and its real-app workflow evidence exist.
- Stage Y owns product completion and hardening. Stage Z owns release-candidate packaging, platform parity, and final release operations.
- The old Stage U release checklist is still relevant because it still contains yellow/manual items and no Stage U closeout ledger exists in the expected `docs/superpowers/audits/` path (see §10 for the source-discovery decision).

Stage Y is complete only when:

1. `docs/superpowers/audits/<date>-stage-y-closeout/` contains the §19 closeout bundle (close note, deferred-work ledger, verification matrix, dogfood report, CI report, release-candidate handoff, verify-bundle.sh, no-drift statement, Stage Z seed plan).
2. Every P0 row in §3 is green, or moved to Stage Z with a dated owner and explicit reason — and the rules in §3.2 distinguish "green" from "explicitly deferred".
3. The dogfood matrix in §9 covers every listed product surface (16 rows), not just the 9 surfaces from the seed.
4. The X1.8 known-regression gate (`verify:stage-x-known-regressions`) is either reduced to zero product regressions or replaced by a newer gate whose rows are all intentionally deferred per the §6.4 disposition contract.
5. CI has at least one real remote run URL recorded, and the local/remote gate mismatch (if any) is recorded in `ci-report.md`.
6. No source edit is claimed complete without a matching verification command and, for UI/live workflows, screenshots or logs per the §9 evidence schema.

## 1. Inputs reviewed

| Input | Relevant finding |
| --- | --- |
| `docs/superpowers/audits/2026-05-22-stage-w-closeout/deferred-work-ledger.md` | W left product and shell work, not only documentation work: W5 item 3, Workbench shell failure modes, `useAgent` extraction, lint/source-grep budgets, IPC allowlist expiry. |
| `docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md` | X classified 15 rows: 9 Stage Y, 4 Stage Z, 2 debt-warning-burn. This is necessary but not sufficient for product completion. |
| `docs/superpowers/plans/2026-05-23-Y-product-surface-and-release-prep-seed.md` | Seed lists useful P0/P1/P2 items, but P0.1 dogfood matrix is too narrow and P0.2 points to a missing Stage U ledger path. |
| `docs/release/u-stage-lessons-learned-checklist.md` | Still has 28 yellow rows and 16 manual release rows; it says yellow rows must become green at Stage U close, but they were not reconciled here. **This is the real source for Y0.6** because no Stage U closeout folder exists (see §10). |
| `.github/workflows/ready-merge-gates.yml` | Merge CI exists, but deep gates are still `if: false`; Stage X was green locally, not yet proven by first real remote run. |
| `package.json` | `verify:meta-paths` and `verify:stage-x-known-regressions` exist but are not part of `verify` or the merge workflow; Y0.2 decides the wiring. |
| `src/main/modules/claude-bridge/direct-chat.ts` + adapter tests | Research-vs-map routing is a real policy conflict, not a simple reorder. Map currently comes before Research, and tests intentionally assert map wins in some cases. §6.2 documents the disposition contract. |
| Settings/provider code | Cache quota is persistence-only; VEA/vision profile "test" only validates fields and does not make a live probe; default vision profile is disabled. |
| Large-file inventory | The previous large-file list is incomplete: CSS, `electron.d.ts`, runtime/IPC handlers, RSS/tool modules, and tests also need staged ownership decisions. |

## 2. Current truth at Stage Y entry

Captured 2026-05-23, branch `codex/readyguy`, HEAD `6031967d` (Stage X11 closeout-doc reconcile). Production code freeze remains `16bf0086` (X7.3); X8/X9/X10/X11 are doc-only.

Already green and not reopened here:

- Legacy AgentManager IPC resurrection guard.
- `tool_execute` / `ipcMain.emit` truthy bridge removal.
- `turn-engine` product-branch gate.
- No fire-and-forget gate.
- RSS platform rule single-source gate.
- Settings no legacy key read gate.
- Tool error shape gate.
- Silent catch gate.
- IPC contract: passes with 2 handled-only allowlist entries and 13 non-literal push allowlist entries.
- Stage X meta-paths gate (`verify:meta-paths`) — passes with 2 documented allowlist entries (browser-content-tools), owner = Stage X1, expires 2026-12-31.
- Stage X known-regressions replacement gate (`verify:stage-x-known-regressions`) — passes, validating the ledger rows in `docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md` remain intact.

Still open at Y entry (these are the Y0 work items, not "extra surprises"):

- `npm run verify:stage-x-known-regressions` passes because the four known regressions remain intentionally retired, not because they are fixed.
- `node scripts/check-research-adapter-registered-in-host.cjs` still fails: `MapDomainAdapter` is first in `src/main/modules/claude-bridge/direct-chat.ts`.
- `node scripts/check-sqlite-test-skip-pattern.cjs` still fails with 16 `missing_helper` rows and 2 stale `c4Exempt` rows. The current 16 `missing_helper` files (verified at Y entry):
  - `src/__tests__/browser-download-service.test.ts`
  - `src/__tests__/document-task-pipeline-host-contract.test.ts`
  - `src/__tests__/document-task-pipeline-widget-fallback.test.ts`
  - `src/__tests__/document-task-pipeline-widget-prompt.test.ts`
  - `src/__tests__/document-task-pipeline-widget-reprompt.test.ts`
  - `src/__tests__/external-services-and-skill-config.test.ts`
  - `src/__tests__/fastcard-ai-service.test.ts`
  - `src/__tests__/legacy-tool-execute-bridge-removed.test.ts`
  - `src/__tests__/map-tool-contract.test.ts`
  - `src/__tests__/obsidian-web-clip-current-tab-ipc.test.ts`
  - `src/__tests__/rss-analysis-manager.test.ts`
  - `src/__tests__/rss-subagent-runner.test.ts`
  - `src/__tests__/settings-emergency-feature-flag-restore.test.ts`
  - `src/__tests__/settings-legacy-key-one-shot-migration.test.ts`
  - `src/__tests__/settings-no-legacy-key-read-after-migration.test.ts`
  - `src/__tests__/tool-error-shape-mutual-exclusivity.test.ts`
  - Stale `c4Exempt`: `src/__tests__/run-capability-controller.test.ts`, `src/__tests__/capability-gate-arbitration.test.ts`.
- `node scripts/check-stage-r-verify-switch.cjs` still fails on stale CLAUDE/AGENTS `### 6.25` heading + `verify` chain composition assumption.
- `node scripts/check-stage-t-verify-switch.cjs` still fails on stale `### 6.27` heading + `verify` chain composition assumption.
- `node scripts/check-testing-conventions-doc.cjs` still fails on stale CLAUDE.md / AGENTS.md `### 6.17` heading assumption.
- `npm run lint:check` reports **771 warnings** (0 errors). Per-rule budget at Y entry: `no-explicit-any` 551/551, `no-unused-vars` 182/182, `react-hooks/exhaustive-deps` 18/18, `react-refresh/only-export-components` 17/17, unused-disable-directive 3/3.
- `debt:no-source-grep-test` is under its ceiling but still tracks 127 current source-grep entries across 101 files.

## 3. P0 — release-blocking Stage Y work

### 3.1 Row inventory

| ID | Work | Evidence | Acceptance |
| --- | --- | --- | --- |
| Y0.0 | Create Stage Y closeout source of truth | Seed at `2026-05-23-Y-product-surface-and-release-prep-seed.md` is inert once entry exists; no Stage Y closeout folder yet. | §19 bundle materialized: `docs/superpowers/audits/2026-05-23-stage-y-closeout/` with the 9 deliverables listed in §19. |
| Y0.1 | Fix or formally retire the four X1.8 known regressions | `verify:stage-x-known-regressions` is green while the underlying scripts still fail per §2. | Per §6 disposition contract: each of the 4 rows resolves into (a) source-or-doc fix + gate re-armed in `verify:c|r|s|t`, or (b) gate removed entirely with replacement gate or retired-with-reason. Outcome appended to `deferred-work-ledger.md` of stage-y-closeout. |
| Y0.2 | Make CI truthful | Merge job exists; deep-gates job is still `if: false`; first remote run URL is missing. | Per §7 contract: first real GitHub run URL recorded in `ci-report.md`; deep-gates policy is either enabled (with one real run URL) or explicitly kept manual with reason; merge job composition matches the §14 Y-release-track command list. |
| Y0.3 | Rerun W5 item 3 multi-session/composer recovery | X2 code landed; live rerun is pending in `w5-item-03-rerun/PENDING-USER-RUN.md`. | On W3.3 hardware, run the exact steps; composer unlocks on every failure path; tab strip and visible session list survive cold start and provider switching. Evidence per §9.2 schema; flip Stage X closeout `w5-item-03-rerun/PENDING-USER-RUN.md` → `COMPLETED-USER-RUN.md` with screencast + log tail. |
| Y0.4 | Close Workbench shell live evidence | X4 landed PR-shell-1/2/4 contracts; Scenario C/D tables still have pending markers. | Fill live p95 mode-switch and split-pane drag measurements; decide remaining W shell rows: overlay blanking, RSS preview race, width reconciliation, 60 Hz remeasure, first-open warm-up. Evidence per §9.2 schema; flip Stage X closeout `workbench-shell-report.md` frontmatter `status: skeleton → status: complete`. |
| Y0.5 | Expand and execute product dogfood matrix v2 | Seed covers 9 surfaces; product has 16 real surfaces. | Run every row of §9.1 dogfood matrix. Each row produces an evidence file under `audits/<y-close>/dogfood/<surface>.md` matching §9.2 schema. Pass = all 16 rows have status `pass` or `deferred-with-owner`. |
| Y0.6 | Reconcile Stage U release checklist | Expected Stage U deferred ledger path is missing per §10; `docs/release/u-stage-lessons-learned-checklist.md` is the actual source with 28 yellow + 16 manual rows. | Every yellow/manual row is now green, automated, copied into the §19 `release-handoff.md` checklist, or explicitly retired with proof. |

### 3.2 What "green" vs "deferred" means for §0 rule 2

A P0 row counts as **green** when its acceptance evidence is recorded in the §19 closeout bundle AND a corresponding verification command (machine-checkable) returns 0, except where the acceptance is intrinsically live evidence (Y0.3, Y0.4, parts of Y0.5).

A P0 row counts as **explicitly deferred** when it appears in `deferred-work-ledger.md` of stage-y-closeout with:

- `bucket` ∈ {`Stage Z release-candidate`, `blocked-external`}
- `reason` written in one sentence with the concrete blocker (vendor outage, hardware unavailability, repo-admin authority)
- `successor-stage` pointing to either a real future plan path or `Stage Z` with an owner name
- `tracking-link` to the artifact that demonstrates the work-to-date

Any P0 row that is neither green nor explicitly deferred under these definitions blocks Stage Y close.

### 3.3 Exit-criteria machine checks

| Criterion | Verification |
| --- | --- |
| §0.1 closeout bundle materialized | `ls docs/superpowers/audits/$Y_CLOSE/` returns the 9 §19 files |
| §0.2 every P0 row green or deferred | `node scripts/check-stage-y-p0-ledger.cjs` (added by Y0.0; validates every P0 row in §3.1 is either marked `green` with evidence path or appears in `deferred-work-ledger.md`) |
| §0.3 dogfood matrix 16/16 | `ls docs/superpowers/audits/$Y_CLOSE/dogfood/` returns 16 files; same script as §0.2 cross-validates |
| §0.4 known-regression resolution | Per §6.4: either `verify:stage-x-known-regressions` is removed from `package.json` (Y0.1.a path) or its ledger contents are entirely deferred (Y0.1.b path); a new gate `scripts/check-stage-y-known-regressions.cjs` enforces whichever decision was made |
| §0.5 first remote CI URL recorded | Y0.2 deliverable; greppable in `ci-report.md` |
| §0.6 evidence-schema compliance | `node scripts/check-stage-y-dogfood-evidence.cjs` (added by Y0.5; lints `dogfood/*.md` against the §9.2 schema) |

## 4. Phase ordering and parallelism

### 4.1 Dependency table

| Phase | Must-precede | May-parallel-with | Notes |
| --- | --- | --- | --- |
| Y0.0 | Y0.1, Y0.2, Y0.5, Y0.6 | nothing | Closeout scaffold is the entry point; everything else writes into it. |
| Y0.1 | Y0.5 (only the §9.1 surfaces that depend on resolved regressions: research/map row, document-task-pipeline rows, settings rows) | Y0.2, Y0.6 | Each of the 4 rows is independently dispatchable per §6.1-§6.4. Decision-tree must run first; source fixes follow. |
| Y0.2 | nothing (CI flip is mostly infra) | Y0.1, Y0.6 | First-run URL capture needs repo-admin coordination; deep-gates flip needs Y0.1 outcomes only if the deep-gates job is restored to include the retired sub-gates. |
| Y0.3 | nothing | Y0.4 only if 白 has W3.3 equipment available for both sessions back-to-back | White-hardware deferral per X plan §3.4 pattern; treated as Y0 entry-condition for Stage Y close but does not block Y1. |
| Y0.4 | nothing | Y0.3 (same constraint as above) | Same handoff pattern. |
| Y0.5 | Y0.0 | Y0.1 (for surfaces not depending on resolved regressions), Y0.2, Y0.6 | Each of the 16 dogfood rows is independently dispatchable per §9.3 sub-plan template. Some rows need 白's machine; treat those as deferred-with-owner. |
| Y0.6 | Y0.0 | Y0.1, Y0.2, Y0.5 | Reconciliation is pure-doc + small automation; no production code change expected. |
| Y1.1-Y1.6 | All Y0 green-or-deferred | Each Y1 row can run in parallel with other Y1 rows once it has its own implementation plan | §11 phase slots. |
| Y2.1-Y2.5 | All Y1 green | Each Y2 row independent | §12 phase slots; no row may start before §11 stable. |
| Stage Z | All Y0 + at least Y1.1-Y1.4 (release-relevant subset) | n/a | §13 contract. |

### 4.2 Parallelism rule (shared-resource carryover from Stage X)

Stage X learned that **shared live-app resources** are the real concurrency bottleneck, not source-file overlap. For Stage Y:

- Y0.3 and Y0.4 are both live-evidence on 白's W3.3 equipment. They serialize unless 白 explicitly notes a back-to-back session.
- Y0.5 dogfood rows that exercise BrowserView, agent panel sessions, or settings dialogs must serialize per dev-instance unless agents use isolated `READY_USER_DATA_DIR` per instance.
- Y0.1, Y0.2, Y0.6 are pure code/doc work and may run fully in parallel with each other and with at most one live-app phase.
- Y1.3 (warning burn) and Y1.4 (IPC hardening) are pure source-edit work and may run in parallel with anything that does not edit the same files; respect the file-overlap pairwise check.

### 4.3 Dispatch time estimate (for scheduling, not contract)

| Phase | Single-agent estimate | Human-in-loop portion |
| --- | --- | --- |
| Y0.0 | 1 h | none |
| Y0.1.1 (sqlite-test-skip-pattern) | 2-3 h | none |
| Y0.1.2 (stage-r/t-verify-switch) | 1 h (decision + doc edit) | none |
| Y0.1.3 (testing-conventions-doc) | 30 min | none |
| Y0.1.4 (research-adapter-registered-in-host) | 1-2 h (touches `direct-chat.ts`) | none |
| Y0.2 (CI flip + first-run URL) | 1 h + repo-admin coordination | first-run trigger (~5 min by 白) |
| Y0.3 (W5 item 3 live rerun) | n/a code | ~30 min by 白 on W3.3 |
| Y0.4 (Workbench shell live measurement) | n/a code | ~30 min by 白 on W3.3 |
| Y0.5 (dogfood matrix v2 × 16 surfaces) | 3-4 h per surface × 16 surfaces (parallelizable per §4.2); live surfaces add 15-30 min 白-time each | sum of live portions |
| Y0.6 (Stage U checklist sync) | 2-3 h | none |
| Y1.1 (Settings/provider reliability) | 4-6 h + sub-plan first | varies |
| Y1.2 (MCP transport or label) | 6-8 h or 1 h depending on path | varies |
| Y1.3 (warning/source-grep burn) | 4-8 h (rule-by-rule) | none |
| Y1.4 (IPC/renderer contract hardening) | 3-4 h | none |
| Y1.5 (Product workflow e2e suite) | 8-12 h | varies |
| Y1.6 (Embedded skill audit) | 4-6 h | varies |
| Y2.1-Y2.5 | Each ≥ 4 h; per §12 each needs its own micro-plan first | varies |
| Stage Y closeout + review loop | 4-6 h + 2 PASS rounds with codex | review-loop time |

Stage Y agent-time total: ~80-120 hours; 白-time total: ~2-4 hours (Y0.3/Y0.4 plus first-CI-run trigger plus any §9.1 live-only surfaces).

## 5. Phase Y0.0 — Stage Y closeout scaffolding

Goal: materialize the §19 closeout bundle before any other Y0 work writes into it.

Inputs:

- `docs/superpowers/audits/2026-05-22-stage-x-closeout/CLOSE-NOTE.md`
- `docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md`
- This implementation plan.

Deliverables (created empty/scaffold at Y0.0; populated by later Y0 phases):

1. `docs/superpowers/audits/2026-05-23-stage-y-closeout/README.md` — index pointing at every other file; status: scaffold at Y0.0, flipped to current at Y closeout.
2. `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-entry-truth.md` — captures §2 commands' stdout/stderr + exit code at Y entry; mirrors X's `x0-starting-truth.md`.
3. `docs/superpowers/audits/2026-05-23-stage-y-closeout/verification-entry/` — directory of raw stdout/stderr + .exit files for each §14.1 command.
4. `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md` — empty ledger with §19 schema (`item | source-stage | reason | successor-stage | tracking-link | bucket`).
5. `docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/` — empty directory; one file per §9.1 surface lands here under Y0.5.
6. `docs/superpowers/audits/2026-05-23-stage-y-closeout/ci-report.md` — Y0.2 deliverable; section §3 reserved for first remote run URL.
7. `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` — Y0.6 deliverable; checklist with one row per Stage U yellow/manual item.
8. `docs/superpowers/audits/2026-05-23-stage-y-closeout/verification-matrix.md` — Y closeout deliverable; mirrors Stage X `verification-final/SUMMARY.md`.

Also added at Y0.0:

- `scripts/check-stage-y-p0-ledger.cjs` — validates §3.3 criterion §0.2 + §0.3.
- `scripts/check-stage-y-dogfood-evidence.cjs` — lints `dogfood/*.md` against §9.2 schema.
- `package.json`: add `verify:stage-y-p0-ledger` and `verify:stage-y-dogfood-evidence` script entries; do NOT wire them into `verify` yet (they are exit-criteria checks, not entry gates).

Done when:

- All 8 deliverable paths exist.
- Both new scripts exist and run (initially expected to fail because the ledger is empty; that is intentional — Y0.5/Y0.6 populate it).
- `y0-entry-truth.md` captures the §2 fact list verbatim, with command output evidence.

## 6. Phase Y0.1 — X1.8 four retired regressions disposition

Each of the 4 X1.8-retired gates resolves via one of two paths:

- **(a) fix**: edit source or doc so the gate passes, then re-arm the gate by either (i) restoring its direct `node scripts/...` invocation in the matching `verify:*` script, or (ii) renaming its `.deferred.cjs` back to `.test.cjs` so the wildcard test pickup re-includes it.
- **(b) formal retire**: write the disposition decision into `deferred-work-ledger.md`, then either (i) delete the gate script entirely if its contract is obsolete, or (ii) add it to a new `scripts/check-stage-y-known-regressions.cjs` (mirroring the X1.8 replacement-gate pattern) if the contract is still wanted as a future commitment but the fix is out of Y scope.

Each row's disposition decision must be made BEFORE any source edit. The decision is recorded in the row's sub-plan implementation file at `docs/superpowers/plans/2026-05-2x-Y0-1-<short-slug>-implementation.md`.

### 6.1 Y0.1.1 — `check-sqlite-test-skip-pattern`

Symptom: 16 `missing_helper` C4-transitive violations + 2 stale `c4Exempt` rows (see §2 for the file list).

Disposition default: **(a) fix**. Each `missing_helper` file gets `skipIfSqliteUnavailable()` at the top of every outer `test()` block; each stale `c4Exempt` entry is removed from `scripts/test-coverage-exemptions.json`. If a file truly never lets the module load sqlite (only injects a fake DB), keep the `c4Exempt` entry but update its `reason` field.

Decision tree:

1. For each `missing_helper` file: read the test file and trace whether it transitively loads `better-sqlite3` via a require chain. If yes → add helper call (path a). If no → it's a C4 false positive; promote to `c4Exempt` with reason (path a-variant).
2. For each stale `c4Exempt` entry: confirm via fresh trace whether the file still injects fake DB only. If yes → keep + update reason. If no → remove the entry; the helper-call fix from step 1 already covers it.
3. Re-arm: rename `scripts/__tests__/check-sqlite-test-skip-pattern.deferred.cjs` → `.test.cjs` so wildcard pickup re-includes it; add direct `node scripts/check-sqlite-test-skip-pattern.cjs` invocation to `verify:k` (or whichever chain currently lacks it per X1.8 ledger row 1).

Acceptance:

- `node scripts/check-sqlite-test-skip-pattern.cjs` exits 0.
- `npm run verify:k` (or relevant chain) exits 0.
- `deferred-work-ledger.md` row for this gate flips to status `green` with commit-hash pointer.

Fallback **(b)** triggers if: the 16 files cannot be fixed without touching production code that violates Stage Y scope (e.g., requires rewriting `agent-sdk-runtime` to remove a transitive sqlite import). In that case, the disposition becomes a Y2 large-file extraction with the gate moved into `scripts/check-stage-y-known-regressions.cjs`.

### 6.2 Y0.1.2 — `check-stage-r-verify-switch` + `check-stage-t-verify-switch`

Symptom: both gates hard-code `### 6.25` (Stage R) and `### 6.27` (Stage T) numbered CLAUDE.md sub-sections that the post-Stage-T CLAUDE.md reorganization removed (current CLAUDE.md uses §0-§12 flat structure). Both also assert `verify` / `verify:cloud` embed `verify:r` / `verify:t` directly.

Disposition default: **(b) formal retire**. The numbered-heading convention was a Stage-R/T-era contract that the new flat-section CLAUDE.md replaced. Re-armng the gates against `### 6.25` etc. would force a CLAUDE.md regression. The correct path is:

1. Decide whether the underlying contract (Stage R/T scope must be findable in CLAUDE.md and `verify` must embed `verify:r`/`verify:t`) is still wanted.
2. If wanted under new section naming: rewrite the gate to find Stage R/T content via the current section structure (likely §3 "Agent 与 Skill Runtime 速查" + §6 "测试与验证"); add a replacement gate file under `scripts/`; add to `verify:s` (Stage S+ chain).
3. If not wanted: delete `scripts/check-stage-r-verify-switch.cjs` and `scripts/check-stage-t-verify-switch.cjs` (and their `.deferred.cjs` test variants); remove the ledger row; move on.

The implementation plan must produce a one-paragraph "what does CLAUDE.md actually guarantee about Stage R/T now" written decision, signed by whoever runs Y0.1.2, before deleting or rewriting either gate.

Acceptance:

- Decision document exists in the sub-plan.
- Either both `.cjs` files are deleted + ledger row marked `retired-with-reason`, OR both rewritten gates exit 0.
- `verify:s` (or relevant chain) exits 0 either way.

### 6.3 Y0.1.3 — `check-testing-conventions-doc`

Symptom: same `### 6.NN` numbered-section drift as §6.2. Asserts CLAUDE.md and AGENTS.md both contain `### 6.17`.

Disposition default: **(a) fix via rewrite**. The testing-conventions contract is still actively referenced (CLAUDE.md §6 "测试与验证" carries it now); the gate just needs to update its regex to find the section under the current flat structure. Rewrite the gate to assert "CLAUDE.md contains §6 '测试与验证' and AGENTS.md contains the same section", then re-arm by restoring its `node scripts/check-testing-conventions-doc.cjs` direct invocation in `verify:f`.

Acceptance:

- `node scripts/check-testing-conventions-doc.cjs` exits 0 against the current CLAUDE.md and AGENTS.md.
- `npm run verify:f` exits 0.
- Sub-plan documents the regex change and the rationale for keeping the contract.

### 6.4 Y0.1.4 — `check-research-adapter-registered-in-host`

Symptom: `src/main/modules/claude-bridge/direct-chat.ts` places `MapDomainAdapter` first in `domainAdapters[]`; the Stage R W1.6 gate requires `ResearchDomainAdapter` to be first.

This is the only Y0.1 row that touches production source code (`src/main/`). Per §1 input note: research-vs-map routing is a real policy conflict — commit `012ec8a6` placed Map first because tests intentionally assert map intent wins for certain queries.

Disposition default: **decision-required** (cannot pick (a) or (b) without product context).

Decision tree:

1. Read the test file(s) that assert map-wins behavior (`src/__tests__/*adapter*` + `src/main/modules/claude-bridge/__tests__/*`).
2. Read `ResearchDomainAdapter` and `MapDomainAdapter` `classify()` functions to determine whether the conflict is real (both can fire on the same query) or apparent (their classification windows are disjoint and order does not affect outcome).
3. If conflict is apparent: re-arm Stage R gate (path a) by reordering the array to put Research first; the map-wins tests will still pass because Map classifies on queries Research declines.
4. If conflict is real: write a new "research-vs-map routing tiebreaker" contract in the sub-plan; either give Research priority (Stage R interpretation: research is meta-routing, map is one of many destination handlers) and update the map-wins tests to no longer assert map-first in the conflict overlap, OR keep Map first and rewrite the Stage R gate to assert "Research must appear in the array, position not specified" (path b).

The sub-plan must include the test-fixture evidence for whichever conflict-state was found, the decision rationale, and the diff that implements it.

Acceptance:

- Either `node scripts/check-research-adapter-registered-in-host.cjs` exits 0 and all map/research adapter tests pass (path a), OR the gate is rewritten/replaced and exits 0 with the new contract (path b).
- `npm run verify:r` exits 0.
- The disposition is recorded in `deferred-work-ledger.md` (even if green, the historical decision deserves a row).

### 6.5 Cleanup of the replacement gate

After all 4 rows are dispositioned, `verify:stage-x-known-regressions` should:

- (Path a for any row): remove that row from `scripts/check-stage-x-known-regressions.cjs`'s required-ledger-entries list.
- (Path b for any row): leave it in the X1.8 ledger but cross-link to the Y closeout row.
- If all 4 rows are green: delete `scripts/check-stage-x-known-regressions.cjs` and remove `verify:stage-x-known-regressions` from `package.json`. Add a new `verify:stage-y-known-regressions` if §6.4(b) created any new deferral row.

## 7. Phase Y0.2 — CI truthful + first remote run

Goal: produce one real GitHub run URL and make sure the workflow the URL refers to is the one we want enforced.

Steps:

1. Read `.github/workflows/ready-merge-gates.yml`.
2. Compare merge-job step list against the §14.2 Y-release-track command list. Add any missing step (likely candidates per X3 deferral notes: `verify:meta-paths`, `verify:stage-x-known-regressions` — though the latter goes away if Y0.1 fully fixes the 4 rows).
3. Decide deep-gates job disposition:
   - If Y0.1 ends with all 4 rows green and `verify:c|r|s|t` chains are clean: flip `deep-gates` from `if: false` to `if: github.event_name == 'push'` (informational; not merge-required) AND add the deep-gates commands to a separate workflow file `.github/workflows/ready-deep-gates.yml` if the team prefers them isolated.
   - If Y0.1 ends with some rows in path (b) deferral: keep `deep-gates` job `if: false` and write a one-paragraph rationale in `ci-report.md` documenting why; this becomes a Stage Z item.
4. Coordinate with 白 (or repo admin) to:
   - Push the branch.
   - Trigger first run (push or PR trigger; PR is preferred because it exercises the `pull_request` trigger path documented in X3 ci-gate-report).
   - Capture the run URL.
   - If the run fails: classify as (i) real platform regression (file as new ledger row + fix), or (ii) workflow shape bug (fix yaml + retrigger; do not delete the run, keep history).
5. Append to `ci-report.md`:
   - First run URL.
   - Per-step pass/fail outcome from that run.
   - Delta vs the local merge-gate equivalent (X3 captured this baseline at `MERGE_GATE_EXIT=0`); if any step diverges, write the delta as a ledger row.
6. Branch protection step: per X3 ci-gate-report §4, configuring branch protection is repo-admin UI work. Document the exact required-status-check name (`Ready merge gates / merge`) and the "require up-to-date branches" toggle in `release-handoff.md` for Stage Z.

Acceptance:

- `ci-report.md` §3 contains a real `https://github.com/...` run URL with a date.
- The merge-job step list matches §14.2 verbatim, OR any divergence is documented as a ledger row.
- Deep-gates disposition is decided and documented.

## 8. Phase Y0.3 + Y0.4 — White-hardware live evidence

Both phases are explicitly deferred to 白's W3.3 equipment per the X plan §3 criterion 4/7 deferral pattern.

### 8.1 Y0.3 — W5 item 3 live rerun

- Reproduction steps: `docs/superpowers/audits/2026-05-22-stage-x-closeout/w5-item-03-rerun/PENDING-USER-RUN.md`.
- 白's deliverable: run Step 0-5; capture screencast (~30s, 10fps acceptable) + `ready-directchat.log` tail covering the failed-send round-trip + `ready-tools.log` tail.
- Where evidence lands: NEW file `docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/w5-item-03-live-rerun.md` per §9.2 schema; flip the Stage X closeout `PENDING-USER-RUN.md` → `COMPLETED-USER-RUN.md` with a one-paragraph result summary + link to the new evidence file.

Acceptance per the original W5 item 3 contract:

- Composer unlocks on every observed failure path (must explicitly cover at least: quota_exceeded HTTP 402; timeout_model; transient 5xx if reproducible).
- Tab strip survives cold start (new session shows up immediately).
- Tab strip survives provider switching (existing session id remains in `sessionOrder` after switch).
- 3-session cap fires correctly.

### 8.2 Y0.4 — Workbench shell live measurement

- Reproduction steps: `docs/superpowers/audits/2026-05-22-stage-x-closeout/workbench-shell-report.md` Scenario C (mode-switch p95) + Scenario D (split-pane drag).
- 白's deliverable: 100-sample p95 mode-switch wall-clock (per Scenario C); 100-sample split-pane drag bounds-count (per Scenario D); screen recording of one round of each.
- Where evidence lands: fill Scenario C/D tables in the Stage X closeout `workbench-shell-report.md`; copy the filled tables into `audits/2026-05-23-stage-y-closeout/dogfood/workbench-shell-live.md` (§9.2 schema); flip frontmatter `status: skeleton → status: complete`.

Acceptance:

- Scenario C p95 ≤ 1000ms (per W3 chosen-layout-model target; if measurement exceeds, file as new ledger row + Y1 follow-up).
- Scenario D drag-bounds-count is non-zero and stable across the 100-sample window.

### 8.3 Coordination

Both phases serialize per §4.2. The implementation plan for Y0.3 and Y0.4 may be a single file `docs/superpowers/plans/2026-05-2x-Y0-3-Y0-4-white-hardware-live-evidence-implementation.md` that lists both as steps for the same 白-session.

## 9. Phase Y0.5 — Product dogfood matrix v2

### 9.1 Surface inventory (16 rows)

Each row needs reproduction steps, a 30-second screencap when visual, and the relevant log tail (`ready-directchat.log`, `ready-tools.log`, `ready-browser.log`, or app console output).

| # | Surface | Minimum scenario | Must prove |
| ---: | --- | --- | --- |
| 1 | File manager | Open, rename, move, delete, and restore one file across two workbench modes. | Tree state and selection persist; no stale watcher event or duplicate node. |
| 2 | Embedded browser | Create tab, navigate, switch tab, reload, open popup/new window, drag/split if applicable. | BrowserView bounds, header state, and DOM overlay behavior stay aligned. |
| 3 | RSS / RSSHub | Subscribe to three sources, refresh, preview one item, open in browser, run one analysis path. | Worker cleanup, preview handoff, and browser handoff do not race. |
| 4 | Document editor / preview | Open markdown and editable document; save; preview; reopen. | No silent save failure; preview/editor state matches disk. |
| 5 | Document widgets | Exercise A-G skeletons plus one H1/H2 freeform trigger. | Widget type does not silently fall back; target attachment does not leak into next question. |
| 6 | Calendar | Create event, recurring event, navigate day/week, accept one agent suggestion. | Timezone/recurrence render correctly; remote suggestion does not bypass scope rules. |
| 7 | Agent panel | New chat, provider switch, failed send, retry, cold start, multi-tab session. | Composer unlocks; active/visible session lists stay consistent. |
| 8 | Settings / external services | Edit/save/test providers: OpenAI-compatible, RSSHub, Jina, DuckDuckGo, Amap, VEA. | Save round-trip is real; disabled/missing-key states are understandable; tests are not fake green. |
| 9 | Skills center | Install bundled skill, run one action, resume after app restart, inspect artifacts. | Child-run durable handle works; artifact paths survive restart. |
| 10 | Provider failure recovery | Simulate timeout, 402, 429, 5xx, malformed stream, thinking-echo bug. | User sees clear failure; composer unlocks; retry policy is bounded. |
| 11 | Remote IM / channel sidecar | Receive remote text + attachment, turn it into a scoped agent task. | Attachment is resource-layer first; tool logs do not enter transcript. |
| 12 | Map / Amap workflow | Ask route planning with research/browser secondary signals. | Map intent wins only when it should; research intent is not swallowed by map. |
| 13 | FastCard / clipping / content-study | Clip a browser page into note/card flow and ask agent to transform it. | Source URL, privacy sanitizer, and document target survive the handoff. |
| 14 | Automation / schedules | Create, list, pause, resume, and fire one reminder/scheduled task. | Schedule state is durable; fired task links back to correct conversation/workspace. |
| 15 | VEA / vision model | Configure a vision model, run image analysis, force missing-key/disabled state. | Test button performs a real probe or clearly says it only validates fields. |
| 16 | Release visual checklist | Walk BrowserView overlay, theme boot, dropdowns, tldraw/text editing, shell empty states. | Manual rows from the old release checklist have dated owner evidence. |

### 9.2 Evidence schema (one file per surface)

Each `audits/2026-05-23-stage-y-closeout/dogfood/<surface-slug>.md` MUST contain:

```markdown
---
surface: <surface name, exactly matching §9.1>
surface_id: <integer 1-16 from §9.1>
date: YYYY-MM-DD
operator: <name>
hardware: <macbook-pro-m5-pro-24gb / linux-x64 / other>
build_commit: <git sha>
status: pass | fail | deferred-with-owner
deferred_owner: <name, only if status=deferred-with-owner>
deferred_reason: <one sentence, only if status=deferred-with-owner>
---

# <surface name> — dogfood evidence

## Reproduction steps
1. ...
2. ...

## Expected result (from §9.1 "Must prove")
- ...

## Observed result
- ...

## Evidence artifacts
- Screencap: `evidence/<surface-slug>-screencap.mp4` (or `.gif`)
- Log tail: `evidence/<surface-slug>-ready-tools.log` (or others as relevant)
- Console output: `evidence/<surface-slug>-console.txt`

## Pass/fail rationale
- One paragraph explaining how the evidence supports the status field.

## New defects discovered
- Any new bug found during this surface's exercise gets a row here AND a new entry in `deferred-work-ledger.md`. Do not squeeze the new defect into another surface's row.
```

`scripts/check-stage-y-dogfood-evidence.cjs` lints every file in `audits/<y-close>/dogfood/` against this schema:

- All frontmatter fields present.
- `status` ∈ {`pass`, `fail`, `deferred-with-owner`}.
- If `status = deferred-with-owner`: both `deferred_owner` and `deferred_reason` non-empty.
- Body contains required sections (`## Reproduction steps`, `## Expected result`, `## Observed result`, `## Evidence artifacts`, `## Pass/fail rationale`).
- Evidence artifact paths in the body resolve on disk (relative to the file's directory).

### 9.3 Per-surface sub-plan template

For each of the 16 surfaces, create `docs/superpowers/plans/2026-05-2x-Y0-5-<surface-slug>-implementation.md` containing:

- Surface name + §9.1 row reference.
- Detailed reproduction steps (expand the §9.1 minimum scenario).
- Expected result decomposition (test cases).
- Pre-existing automated coverage (link to relevant tests/gates; if zero, say so).
- Operator (agent vs 白) — most can run on Linux/CI-class hardware; a few need 白's box.
- Evidence file path (`audits/<y-close>/dogfood/<slug>.md`).
- Acceptance: per §9.1 "Must prove" + per-test-case checks.

### 9.4 Operator assignment

| Surface | Default operator | Reason |
| --- | --- | --- |
| 1, 4, 5, 8, 9, 14, 15 | agent (CI-class hardware) | Pure interaction; no W3.3-specific behavior. |
| 2, 6, 7, 10, 11, 12, 13, 16 | agent OR 白 (preference) | Visual/timing-sensitive; agent may produce evidence on CI-class, 白 should spot-check. |
| 3 | agent + 白 spot-check | RSSHub network behavior varies; 白 should confirm against personal RSSHub instance. |

Surfaces that must run on 白's W3.3 hardware: none mandatory; Y0.4 already owns the W3.3-specific shell evidence. Surfaces 2/7 may benefit from 120Hz observation but are not blocked.

## 10. Phase Y0.6 — Stage U release checklist reconciliation

### 10.1 Source discovery

The Y roadmap r0 §3 assumed a `docs/superpowers/audits/2026-05-19-stage-u-closeout/deferred-work-ledger.md` exists. A directory listing at Y entry shows:

- `docs/superpowers/audits/` contains NO `stage-u-closeout` directory.
- `docs/release/u-stage-lessons-learned-checklist.md` DOES exist and is the actual Stage U lessons-learned source.

Decision: **`docs/release/u-stage-lessons-learned-checklist.md` is the authoritative source for Y0.6**. The expected Stage U closeout-folder path never existed; the seed plan P0.2 was written from incomplete knowledge.

### 10.2 Reconciliation steps

1. Read `docs/release/u-stage-lessons-learned-checklist.md` end-to-end.
2. Inventory every row marked yellow (28 expected per roadmap §1) and every row marked manual (16 expected).
3. For each row, decide one of:
   - **automate**: write a real gate or test that makes the row green; record the gate path in `release-handoff.md`.
   - **release-checklist-only**: copy the row verbatim into `release-handoff.md` § "Manual release operations" with owner + due-date; this is acceptable when the row is intrinsically human (e.g., "verify installer signature in production keychain").
   - **retire-with-reason**: write a one-paragraph "no longer applicable" rationale and remove the row from the U checklist (or strike it through with a date); add a ledger row.
4. Audit pass: after step 3, the U checklist must have 0 yellow rows that have no disposition; every manual row must have a `release-handoff.md` mirror or a retired-with-reason.

### 10.3 Deliverable

`docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` containing:

- Section 1: Stage U row inventory + disposition table (28 yellow + 16 manual + any "green at U close" rows that need re-validation now).
- Section 2: New automated-gate inventory (which yellow rows were converted).
- Section 3: Manual release-engineer checklist (which yellow + which manual rows now require human action at release time).
- Section 4: Retired-with-reason rows.
- Section 5: Branch protection + repo-admin items handed to Stage Z.

Acceptance:

- All Stage U yellow + manual rows have a disposition.
- `release-handoff.md` covers Stage Z release operations end-to-end with no orphan rows.

## 11. P1 — Stage Y core hardening (sub-plan slots)

Each P1 row needs its own `docs/superpowers/plans/2026-05-2x-Y1-<id>-<slug>-implementation.md` before any source edit lands. The scope locks below are non-negotiable boundaries; the sub-plan refines them.

### 11.1 Y1.1 — Settings/provider reliability

Scope lock: cache quota UI + VEA/vision profile test behavior + disabled-default labeling. May NOT bundle MCP work (that is Y1.2) or expand to general settings refactor.

Acceptance per row:

- Cache quota: either UI enforces eviction with a measurable trigger (e.g., size > N → evict LRU until ≤ M), OR the UI is relabeled to honest "configured limit, not enforced; manual cleanup required" with a tracking row.
- VEA test: either probes a real endpoint (one HTTP request with auth + minimal payload, accepts non-error response as pass), OR button label changes to "Validate fields only" with disabled state when no key is configured.
- Tests cover both branches (eviction-fires + eviction-disabled-with-relabel; probe-success + probe-failure).

### 11.2 Y1.2 — MCP transport or "not shipped" labeling

Scope lock: pick one transport (stdio recommended for minimal scope) and prove it end-to-end, OR add UI labeling that "MCP is not shipped in this release; see Stage Z roadmap".

Acceptance per branch:

- Transport: install one bundled MCP server (filesystem or fetch); user can install via Settings, server appears in skill/tool authorization UI, one tool call round-trip succeeds, server lifecycle (start/stop on app quit) does not leak processes.
- Labeling: Settings MCP section shows the "not shipped" label; the existing authorization plumbing (Stage T) is left in place but visibly inert in UI.

### 11.3 Y1.3 — Warning/source-grep burn

Scope lock: priority is correctness-relevant rules first, volume rules last. Concrete order:

1. `react-hooks/exhaustive-deps` (18 occurrences at Y entry) — each is a potential stale closure bug.
2. `react-refresh/only-export-components` (17) — each breaks Vite HMR.
3. `@typescript-eslint/no-unused-vars` (182) — start with ChatPanel.tsx + the 8 X2-touched files per X5.6 ledger row 7.
4. `unused-disable-directive` (3) — trivial cleanup once nothing depends on the directive line.
5. `@typescript-eslint/no-explicit-any` (551) — last; volume but low correctness signal.

Acceptance: each rule's budget number drops monotonically as rows are burned; `verify:lint-budget` is updated in the same PR; no rule budget is raised by Stage Y work.

### 11.4 Y1.4 — IPC/renderer contract hardening

Scope lock: 2 handled-only allowlist entries + 13 non-literal push allowlist entries + `src/renderer/types/electron.d.ts` size review. May NOT add new IPC channels; this phase is reduction-only.

Acceptance: every removed allowlist row has a verifying behavior test; if removal requires renderer type changes, those are bundled in the same PR; `verify:ipc-contract` stays green.

### 11.5 Y1.5 — Product workflow e2e suite

Scope lock: ONE Playwright-style or equivalent harness covering at minimum: Browser Agent send-receive, document/widget round-trip, remote attachment ingest, skills install+run+resume, provider smoke (one provider), BrowserView shell mode-switch, artifact retention across restart.

Acceptance: harness exists, runs in CI as `npm run test:e2e` (separate from `npm run test`), at least 7 named scenarios pass.

### 11.6 Y1.6 — Embedded skill / VEA / artifact packaging audit

Scope lock: enumerate every bundled skill, verify manifest/SKILL.md parity, document requirements strategy, document launch path, document artifact retention, run one acceptance pass per skill.

Acceptance: `docs/superpowers/audits/2026-05-23-stage-y-closeout/bundled-skills-audit.md` lists every bundled skill with the 5 attributes + green/blocker per skill.

## 12. P2 — Structural debt (post-P1 stretch)

Each row needs a small implementation plan, before/after behavior checks, and no unrelated formatting churn. No P2 row may start until all P1 rows are green.

### 12.1 Y2.1 — Large-file extraction wave

Starting files (X plan §11 P2 + Y roadmap expansion):

- `turn-engine.ts`
- `browser-tools.ts`
- `agent-sdk-runtime.ts`
- `skill-child-runner.ts`
- `runtime.ts` (main process bootstrap)
- `Settings.tsx`
- `database.ts`, `migrations.ts`
- `FileTree.tsx`
- `useAgent.ts` (W4.8 deferred)
- document task pipeline executor
- `skills-tools.ts`, `runtime-manager.ts`, `run-contracts.ts`
- `direct-chat.ts`, IPC handlers
- `src/renderer/styles/index.css`
- `src/renderer/types/electron.d.ts`
- large route tests

Each extraction is its own micro-plan; do not bundle. No extraction may break public exports without paired test updates in the same commit.

### 12.2 Y2.2 — `useAgent` physical split + consumer cleanup

W4.8 deferred this. Stage Y already reduced logical ownership; physical maintenance cost remains. Split must preserve composer-unlock target-capture (X2 contract).

### 12.3 Y2.3 — Database/migration/test harness cleanup

SQLite skip-guard failures (per Y0.1.1) showed test harness assumptions are leaky. Y2.3 audits the harness, not just the failing tests.

### 12.4 Y2.4 — Windows/macOS parity groundwork

Process cleanup + RSSHub worker behavior have Windows-specific TODOs. CI only covers macOS. Stage Y groundwork = inventory + isolate platform-specific code paths; full Windows parity is Stage Z.

### 12.5 Y2.5 — Verify-chain simplification

`verify`, `verify:cloud`, deep gates, meta gates, replacement gates need a single current taxonomy after Stage Y fixes land. Final deliverable: updated `docs/superpowers/operations/verify-gate-taxonomy.md` reflecting Y closeout state.

## 13. Stage Z — release-candidate phase (handoff contract)

Stage Z starts only after Y0 P0 rows are green or explicitly deferred AND Y1.1-Y1.4 (release-relevant subset) are green.

| ID | Work | Acceptance |
| --- | --- | --- |
| Z0.1 | Release-candidate gate bundle | One command or script records `verify:native`, `typecheck`, `lint:check`, lint budgets, IPC, meta paths, tests, build, deep gates as configured, and release smoke. |
| Z0.2 | Platform parity | macOS packaged smoke plus Windows smoke. Windows must cover startup, SQLite/native, BrowserView or equivalent shell behavior, RSSHub/process cleanup, file paths, and build. |
| Z0.3 | Release manual checklist | Old manual rows become a dated checklist with owner, evidence, and pass/fail (most of this lands at Y0.6 `release-handoff.md`; Stage Z executes it). |
| Z0.4 | Branch protection and CI policy | Required GitHub status checks are configured and documented; deep gates are either required for release branches or documented as manual release gates. |
| Z0.5 | Release notes and handoff | User-facing changes, known limitations, rollback steps, and next debt budget are written before release. |

Stage Z seed plan path: `docs/superpowers/plans/2026-05-2x-Z-release-candidate-seed.md` — created at Stage Y close as the final §19 deliverable.

## 14. Verification commands to keep current

### 14.1 Y-entry baseline (every command must run at Y0.0 and capture in `verification-entry/`)

```bash
npm run verify:stage-x-known-regressions
npm run verify:meta-paths
npm run verify:ipc-contract
npm run debt:no-source-grep-test
node scripts/check-eslint-baseline.cjs
npm run lint:check
node scripts/check-research-adapter-registered-in-host.cjs
node scripts/check-sqlite-test-skip-pattern.cjs
node scripts/check-stage-r-verify-switch.cjs
node scripts/check-stage-t-verify-switch.cjs
node scripts/check-testing-conventions-doc.cjs
```

### 14.2 Y-release-track (must all exit 0 at Y closeout AND must be the workflow's merge-job step list per Y0.2)

```bash
npm run verify:native
npm run typecheck
npm run lint:check
npm run verify:lint-budget
node scripts/check-eslint-baseline.cjs
npm run verify:ipc-contract
npm run verify:meta-paths
npm run test
npm run build
```

Plus (Y-closeout-specific, added by Y0.0):

```bash
npm run verify:stage-y-p0-ledger
npm run verify:stage-y-dogfood-evidence
```

Plus (only if Y0.1 retains any retired-gate path):

```bash
npm run verify:stage-y-known-regressions
```

If Y0.1 makes all 4 X1.8 retired regressions green: `verify:stage-x-known-regressions` is REMOVED at Y closeout per §6.5.

## 15. Do not do

- Do not edit the Y seed (`2026-05-23-Y-product-surface-and-release-prep-seed.md`) in place; link back to it.
- Do not mark W5/Workbench live evidence (Y0.3/Y0.4) as complete without 白's screencast + log.
- Do not "fix" the research/map regression (Y0.1.4) by blindly reordering adapters without preserving map intent tests (per §6.4 decision tree).
- Do not turn the product dogfood matrix (§9.1) back into the seed's smaller 9-row version.
- Do not start large-file extraction (Y2.1) before P0/P1 gates tell the truth.
- Do not count a source-grep or static check as a replacement for a real behavior test unless the plan explicitly says no runtime harness exists yet.
- Do not bundle multiple §6 disposition decisions in a single PR; each of the 4 rows is independently dispatchable.
- Do not pre-emptively raise any lint warning budget; Y1.3 reduces only.
- Do not add new IPC channels at Y1.4; that phase is reduction-only.
- Do not run Y0.3 and Y0.4 concurrently on 白's hardware unless 白 explicitly schedules a back-to-back session.
- Do not delete the X1.8 replacement gate (`scripts/check-stage-x-known-regressions.cjs`) until §6.5 cleanup confirms all 4 rows are dispositioned.

## 16. Review cadence per phase

Every Stage Y sub-phase must produce, before merging:

1. A scoped implementation branch or clearly isolated commit.
2. Before/after verification output (captured in `verification-entry/` for Y-entry-state evidence, in per-phase capture dirs otherwise).
3. A short review note answering:
   1. Did this touch only the declared boundary?
   2. Which gate or behavior would fail if this regressed?
   3. Is any source-grep gate still unsupported by a behavior test?
   4. Did warning count grow? (must be no for Y1.3 PRs; must be no-growth for everything else)
   5. Did this add any new deferred item? If yes, the ledger row is included in the same PR.

Y0 phases must not advance to Y1 until §3.3 criteria §0.2 + §0.3 are green or explicitly deferred. Y1 must not advance to Y2 until all Y1 sub-plans report green.

## 17. Rollback paths

| Phase | Symptom that triggers revert | Recovery action |
| --- | --- | --- |
| Y0.1 | A re-armed gate starts failing on green code, or a "fixed" test re-introduces a real regression. | `git revert <commit>`; redo the disposition decision with a real reproducer; do not re-attempt the same fix path. |
| Y0.2 | First remote CI run is red and the failure is not a real platform regression but a workflow shape bug. | Same-day follow-up commit; do not delete the failing run, keep history. |
| Y0.5 | Dogfood reveals a new defect that breaks the surface entirely. | File new ledger row + flip surface status to `fail`; do not collapse the new defect into another row; do not relax §9.1 acceptance. |
| Y0.6 | A retired-with-reason row is later found still-needed by Stage Z. | Reopen the row; copy back into `release-handoff.md` manual checklist; ledger row marked `reopened`. |
| Y1.x | A sub-plan's source edit breaks an unrelated test. | Revert + re-scope the sub-plan to exclude the cross-cutting edit. |
| Y2.x | A large-file extraction breaks a public export. | Revert; do not patch tests to accommodate the break; redo extraction with the export preserved. |
| Stage Y closeout | Codex review-loop finds a contradiction between phase reports and the verification matrix. | Same X-stage pattern: fix the contradiction in a doc-only PR; do not amend the verification capture; re-enter the review loop. |

## 18. Stage Y closeout review loop (mirrors Stage X)

After all P0 + P1 + closeout bundle land, enter the codex terminal review loop:

- Each codex round produces a verdict ∈ {`PASS`, `FIX-AND-RECHECK`}.
- A `FIX-AND-RECHECK` resets the consecutive-PASS counter to zero; fix the must-fix items, then re-enter the loop.
- Stage Y closes only on TWO CONSECUTIVE `PASS` rounds (X plan stop rule, preserved verbatim).

The Stage Y closeout commit message includes the codex round count and the final PASS-verdict text quoted verbatim.

## 19. Stage Y closeout bundle structure

`docs/superpowers/audits/2026-05-23-stage-y-closeout/` must contain:

| # | Deliverable | Path | Source phase |
| ---: | --- | --- | --- |
| 1 | Close note (umbrella authority) | `CLOSE-NOTE.md` | Closeout |
| 2 | Deferred-work ledger | `deferred-work-ledger.md` | Closeout (populated from Y0.1 + Y0.5 + Y0.6 outputs) |
| 3 | No-drift statement | `no-drift.md` | Closeout |
| 4 | Verification matrix | `verification-matrix.md` | Closeout |
| 5 | Dogfood report | `dogfood/REPORT.md` (top-level index) + 16 per-surface files in `dogfood/` | Y0.5 |
| 6 | CI report | `ci-report.md` | Y0.2 |
| 7 | Release handoff | `release-handoff.md` | Y0.6 |
| 8 | Y entry truth + capture | `y0-entry-truth.md` + `verification-entry/` | Y0.0 |
| 9 | Stage Z seed plan | linked from `CLOSE-NOTE.md`; file path `docs/superpowers/plans/2026-05-2x-Z-release-candidate-seed.md` | Closeout |

Plus stage-specific reports as needed:

- `y0-1-disposition-report.md` (combines the 4 §6 decisions)
- `bundled-skills-audit.md` (Y1.6)
- `verify-bundle.sh` (mirrors Stage X pattern; one-line invocation that re-runs §14.2 + closeout-specific commands and compares against `verification-final/`)
- `verification-final/` (frozen snapshot at Y closeout)

## 20. Open questions for codex review

The following are intentional choice-points that codex should challenge or confirm:

1. **§6 disposition default for Y0.1.2**: roadmap defaulted to "(b) formal retire" because the numbered-section CLAUDE.md convention is gone. Codex should challenge whether the underlying Stage R/T charter contract still deserves a rewritten gate (path a-rewrite) rather than retirement.
2. **§7 deep-gates flip condition**: roadmap defers the flip to Y0.1 outcome. Codex should challenge whether the flip should happen regardless (deep-gates informational only, not merge-required, so flipping to `if: github.event_name == 'push'` is low-cost even if some sub-chains are red).
3. **§9.4 operator assignment**: roadmap defaults most surfaces to "agent" (CI-class hardware). Codex should challenge whether visual-timing-sensitive surfaces (2, 7, 12) should require 白 mandatorily.
4. **§14.2 Y-release-track list**: roadmap removed `verify:stage-x-known-regressions` from the merge job because Y0.1 either fixes the 4 rows (gate goes away) or creates a Y-specific replacement gate. Codex should challenge whether the merge job should temporarily include the X gate during the Y0.1 work window.
5. **§19 deliverable count**: roadmap has 9 deliverables (mirrors X). Codex should challenge whether the Y closeout needs anything Stage X didn't, e.g., a "Stage Y → Stage Z handoff verification matrix" separate from `verification-matrix.md`.
6. **§3.1 Y0.6 acceptance**: roadmap requires every Stage U yellow/manual row to be dispositioned. Codex should challenge whether a hard cap (e.g., "≤ 5 rows may remain manual into Stage Z") is more realistic than "every row dispositioned".
