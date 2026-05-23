---
title: Stage Y — Ready product completion and release hardening implementation plan
date: 2026-05-23
stage: Y-entry
status: refinement-r4 (codex r3 must-fix 1-4 + should-fix 1-5 + P2 1-2 addressed; ready for codex r4 round)
enforce: false
predecessors:
  - docs/superpowers/plans/2026-05-23-Y-product-surface-and-release-prep-seed.md
  - docs/superpowers/audits/2026-05-22-stage-x-closeout/CLOSE-NOTE.md
  - docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
refinement_history:
  - r0 (2026-05-23): initial roadmap draft (sections 0-10) by codex.
  - r1 (2026-05-23): Claude in-place refinement — added §3.x exit criteria precision, §4 phase ordering + parallelism table, §5 closeout-bundle file list, §6.x Y0.1 4-row disposition decision tree, §7 Y0.2 CI flip contract, §8 white-hardware live-evidence handoff schedule, §9 dogfood evidence schema + per-surface sub-plan template, §10 Stage U source discovery (Stage U closeout folder is missing; release checklist is the real source), §11 Y1.x scope locks, §12 Y2.x scope locks, §13 Stage Z entry contract, §14 verify-chain split (Y-entry vs Y-release-track), §15 expanded do-not list, §16 review cadence per phase, §17 rollback paths, §18 dispatch time estimate, §19 Stage Y closeout bundle structure (mirrors Stage X §10).
  - r4 (2026-05-23): Codex r3 fix-and-recheck — 4 must-fix items addressed inline: (1) §3.1 acceptance links un-reversed — Y0.7 now correctly cites §11.0b (MCP scope lock) and Y0.8 cites §11.0a (cache quota scope lock); (2) §6.5 row-count ambiguity resolved by choosing "exactly 4 rows with paired gate_id `check-stage-r-verify-switch+check-stage-t-verify-switch` as a single row"; (3) §9.2.1 reflog branch removed (not portable across clones) — replaced with checksummed `head-capture.txt` artifact in evidence bundle; (4) §20.3 Q11 added explicitly (was dropped at r3 — Q11 covers §11.0a/§11.0b naming idiomaticity). Plus 5 should-fix: bai_spotcheck.performed_at tightened to 72h with same-build_commit fallback; §9.1 row 13 schema constraint added requiring 5 sub-flow evidence markers; §9.2.2 50% fallback removed (kept only ±30s); §4.3 budget table updated for 9 mandatory spot-checks + Y1.2 MCP budget zeroed; §11.2 RESERVED note expanded to cross-reference §4.3 + §11.0b. Plus 2 P2: §20.3 Q3 stale "8 of 20 / optional" cleaned; §11.0a/§11.0b kept (per Q11 ruling) with explicit downstream-reference legend.
  - r3 (2026-05-23): Codex r2 fix-and-recheck — 5 must-fix items addressed inline: (1) Y0.7/Y0.8 P0/P1/Stage Z contradiction resolved by making Y0.7+Y0.8 non-deferrable P0 + renaming §11.1/§11.2 to "P0 scope locks (Y0.8/Y0.7)" + removing them from the §11 P1 group; (2) §9.2 schema adds `bai_spotcheck` field with required sub-evidence for mandatory-spot-check surfaces + surface 10 HTTP 402 mandatory; (3) §9.2 reproduction-window overlap check replaces ±5min loose check + build_commit ties to captured-HEAD evidence via reflog timestamp cross-reference; (4) §6.5 conditions made machine-checkable via strict `y0-1-disposition-report-schema.json` (4 gate IDs × required fields); (5) §9.1 row 13 expanded to cover FastCard translate / describe image / resolve video / overlay command paths per `src/preload/index.ts:13-19,394-404`. Plus 4 should-fix: §6.1 wording fixed to "anywhere in the file"; §6.2 verify-chain policy note + missing `.deferred.cjs` reference recorded; §0 line 36 + §4 line 181 + all "16 rows" references rewritten to "20 rows"; §9.1 rows 1/3/5/8/10/11 tightened to binary fixed-fixture spec. Plus 3 P2: §19 evidence bundle includes both JSON + `.checksums.txt`; §19 row 11 adds `inherits_to_z_phase` column; §11.5 fixed to use existing `npm run verify:f:e2e` (not invented `test:e2e`).
  - r2 (2026-05-23): Codex r1 fix-and-recheck — 8 must-fix items addressed inline: (1) §2 + §6.1 fixed C4-transitive prescription to file-level (per current `scripts/check-sqlite-test-skip-pattern.cjs:120-127` + `src/__tests__/utils/sqlite-skip.ts:10-16` contract); (2) §6.2 default flipped from "(b) delete" to "(a) current-charter rewrite or explicit replacement"; (3) §7 deep-gates flip relaxed to "stable disposition + represented commands" + split into Y0.2.a merge-job alignment vs Y0.2.b deep-gate enablement; (4) §6.5 + §14.2 keep `verify:stage-x-known-regressions` through Y0.1 + replace with Stage Y successor before deletion; (5) §9.1 dogfood matrix v3: split row 16 into 3 rows (16/17/18), added row 19 Obsidian web clip, row 20 agent_interaction routing, row 9 explicitly covers restart + crash + forced-quit resumability; (6) §9.2 evidence schema adds SHA-256 + timestamps + build_commit match + manifest validation; (7) §3.1 + §11.1/§11.2 release-blocking inconsistency resolved — Y1.1 + Y1.2 explicitly block Stage Z; (8) §2 entry HEAD updated to r1 commit 7f904fb5. Plus 5 should-fix: §6.3 testing-conventions content-level check, §6.4 overlap-fixture-first, §7 split, §13 verify:cloud handoff, §16 read-only-review disclaimer. Plus 3 P2: §9.2 evidence/manifest.json schema, §9.3 sub-plan "pre-existing coverage: none" requirement, §19 白-operator-runbook.
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
3. The dogfood matrix in §9 covers every listed product surface (20 rows at r3), not just the 9 surfaces from the seed.
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

Captured 2026-05-23 at r1 entry, branch `codex/readyguy`, HEAD `7f904fb5` (Stage Y entry plan r1 commit; pre-r1 HEAD was `6031967d` = Stage X11 closeout-doc reconcile). Production code freeze remains `16bf0086` (X7.3); X8/X9/X10/X11 and r1/r2 plan commits are doc-only.

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
| Y0.0 | Create Stage Y closeout source of truth | Seed at `2026-05-23-Y-product-surface-and-release-prep-seed.md` is inert once entry exists; no Stage Y closeout folder yet. | §19 bundle materialized: `docs/superpowers/audits/2026-05-23-stage-y-closeout/` with the deliverables listed in §19. |
| Y0.1 | Fix or formally dispose of the four X1.8 known regressions | `verify:stage-x-known-regressions` is green while the underlying scripts still fail per §2. | Per §6 disposition contract: each of the 4 rows resolves into (a) source-or-doc fix + gate re-armed in `verify:c|r|s|t`, or (b) gate rewritten with current-charter replacement, or (c) explicit retire-with-reason + ledger row + Stage Y successor gate per §6.5. Outcome appended to `deferred-work-ledger.md` of stage-y-closeout. |
| Y0.2.a | CI merge-job alignment | Merge job exists; composition may not match §14.2 Y-release-track list. | Merge job step list matches §14.2 verbatim. Recorded in `ci-report.md` §2. |
| Y0.2.b | CI deep-gates + first remote run | Deep-gates job is `if: false`; no remote run URL captured. | Per §7 contract: first real GitHub run URL recorded in `ci-report.md` §3. Deep-gates flipped to enabled-informational once Y0.1 dispositions are stable AND every command in the deep-gates job is either (i) currently passing, or (ii) represented by a passing replacement gate per §6.5. If a row remains red with no replacement, deep-gates stays `if: false` with one-paragraph rationale + Stage Z ledger row. |
| Y0.3 | Rerun W5 item 3 multi-session/composer recovery | X2 code landed; live rerun is pending in `w5-item-03-rerun/PENDING-USER-RUN.md`. | On W3.3 hardware, run the exact steps; composer unlocks on every failure path; tab strip and visible session list survive cold start and provider switching. Evidence per §9.2 schema; flip Stage X closeout `w5-item-03-rerun/PENDING-USER-RUN.md` → `COMPLETED-USER-RUN.md` with screencast + log tail. |
| Y0.4 | Close Workbench shell live evidence | X4 landed PR-shell-1/2/4 contracts; Scenario C/D tables still have pending markers. | Fill live p95 mode-switch and split-pane drag measurements; decide remaining W shell rows: overlay blanking, RSS preview race, width reconciliation, 60 Hz remeasure, first-open warm-up. Evidence per §9.2 schema; flip Stage X closeout `workbench-shell-report.md` frontmatter `status: skeleton → status: complete`. |
| Y0.5 | Expand and execute product dogfood matrix v3 | Seed covers 9 surfaces; r1 matrix v2 had 16 rows; r2 matrix v3 expands to 20 rows (split visual-checklist + add Obsidian + agent_interaction). | Run every row of §9.1 dogfood matrix. Each row produces an evidence file under `audits/<y-close>/dogfood/<surface>.md` matching §9.2 schema. Pass = all 20 rows have status `pass` or `deferred-with-owner`. |
| Y0.6 | Reconcile Stage U release checklist | Expected Stage U deferred ledger path is missing per §10; `docs/release/u-stage-lessons-learned-checklist.md` is the actual source with 28 yellow + 16 manual rows. | Every yellow/manual row is now green, automated, copied into the §19 `release-handoff.md` checklist, or explicitly retired with proof. No hard cap on manual-row count (codex r1 §20.6 confirmed). |
| Y0.7 | MCP transport or "not shipped" labeling — **non-deferrable P0** (codex r2 must-fix #1: was P1) | X ledger row 10 classifies as Stage Y product-surface; §13 makes it Stage Z entry blocker. | Per **§11.0b** scope lock (codex r3 must-fix #1: r3 incorrectly cited §11.0a): pick one transport (stdio recommended) and prove it end-to-end, OR add UI labeling "MCP not shipped". Implementation plan first. Deferral to Stage Z is FORBIDDEN — §3.2 deferral rule does not apply to Y0.7/Y0.8. |
| Y0.8 | Settings cache quota enforcement — **non-deferrable P0** (codex r2 must-fix #1: was P1) | X ledger row 11; quota is persistence-only; §13 makes it Stage Z entry blocker. | Per **§11.0a** scope lock (codex r3 must-fix #1: r3 incorrectly cited §11.0b): UI enforces eviction with measurable trigger OR relabeled "configured limit, not enforced". Deferral to Stage Z is FORBIDDEN. |

### 3.2 What "green" vs "deferred" means for §0 rule 2

A P0 row counts as **green** when its acceptance evidence is recorded in the §19 closeout bundle AND a corresponding verification command (machine-checkable) returns 0, except where the acceptance is intrinsically live evidence (Y0.3, Y0.4, parts of Y0.5).

A P0 row counts as **explicitly deferred** when it appears in `deferred-work-ledger.md` of stage-y-closeout with:

- `bucket` ∈ {`Stage Z release-candidate`, `blocked-external`}
- `reason` written in one sentence with the concrete blocker (vendor outage, hardware unavailability, repo-admin authority)
- `successor-stage` pointing to either a real future plan path or `Stage Z` with an owner name
- `tracking-link` to the artifact that demonstrates the work-to-date

Any P0 row that is neither green nor explicitly deferred under these definitions blocks Stage Y close.

**Non-deferrable P0 carve-out (codex r2 must-fix #1)**: Y0.7 (MCP) and Y0.8 (cache quota) are NOT eligible for the §3.2 deferral branch. They were promoted to P0 specifically because §13 makes them Stage Z entry blockers; deferring them to Stage Z would create the contradiction codex r2 flagged. Either path-a (real transport / eviction) or path-b (UI relabeling) counts as **green**, but neither row may exit Stage Y in the "explicitly deferred" state. The §3.3 §0.7 machine check enforces this.

### 3.3 Exit-criteria machine checks

| Criterion | Verification |
| --- | --- |
| §0.1 closeout bundle materialized | `ls docs/superpowers/audits/$Y_CLOSE/` returns the §19 required deliverables |
| §0.2 every P0 row green or deferred | `node scripts/check-stage-y-p0-ledger.cjs` (added by Y0.0; validates every P0 row in §3.1 is either marked `green` with evidence path or appears in `deferred-work-ledger.md` with bucket ∈ {Stage Z release-candidate, blocked-external}) |
| §0.3 dogfood matrix 20/20 | `ls docs/superpowers/audits/$Y_CLOSE/dogfood/` returns ≥ 20 files (one per §9.1 surface); same script as §0.2 cross-validates |
| §0.4 known-regression resolution | Per §6.5: `verify:stage-x-known-regressions` is replaced by `verify:stage-y-known-regressions` whose ledger reflects whichever path each of the 4 rows took. Outright deletion is forbidden by §6.5; the successor gate must exist before X gate is removed from `package.json`. |
| §0.5 first remote CI URL recorded | Y0.2.b deliverable; greppable in `ci-report.md` §3 |
| §0.6 evidence-schema compliance | `node scripts/check-stage-y-dogfood-evidence.cjs` (added by Y0.5; lints `dogfood/*.md` against the §9.2 schema, including SHA-256 manifest checks) |
| §0.7 Y0.7 + Y0.8 non-deferrable release-blocking | Both `Y0.7` (MCP) and `Y0.8` (cache quota) rows green in P0 ledger per §3.1 + §11.0a/§11.0b scope locks; `check-stage-y-p0-ledger.cjs` MUST reject the closeout if either row is marked `deferred-with-owner` (deferral forbidden per §3.2 non-deferrable carve-out) |

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
| Y0.5 (dogfood matrix v3 × 20 surfaces) | 3-4 h per surface × 20 surfaces (parallelizable per §4.2); live surfaces add 15-30 min 白-time each | **9 mandatory 白 spot-check surfaces** (2, 3, 7, 10, 13, 16, 17, 18, 19 per §9.4) × 15-30 min each = **135-270 min** (~2.25-4.5 hours 白-time for spot-checks alone) |
| Y0.6 (Stage U checklist sync) | 2-3 h | none |
| Y1.1 (VEA/vision test reliability — narrowed; cache-quota moved to Y0.8 per §11.0a) | 2-3 h + sub-plan first | varies |
| Y1.2 RESERVED — MCP moved to Y0.7 P0 per §11.0b; this slot zero-budgeted (codex r3 should-fix #4) | 0 h | n/a |
| Y1.3 (warning/source-grep burn) | 4-8 h (rule-by-rule) | none |
| Y1.4 (IPC/renderer contract hardening) | 3-4 h | none |
| Y1.5 (Product workflow e2e suite) | 8-12 h | varies |
| Y1.6 (Embedded skill audit) | 4-6 h | varies |
| Y2.1-Y2.5 | Each ≥ 4 h; per §12 each needs its own micro-plan first | varies |
| Stage Y closeout + review loop | 4-6 h + 2 PASS rounds with codex | review-loop time |

Stage Y agent-time total: ~75-115 hours (was 80-120 in r3; Y1.2 zero-budget recovered ~5h; Y1.1 narrowed from 4-6h to 2-3h). 白-time total: ~5-7 hours (r3 underestimated at 2-4h; corrected for 9 mandatory dogfood spot-checks per §9.4 = 2.25-4.5h alone, plus Y0.3 ~30min + Y0.4 ~30min + first-CI-run ~5min + Y0.7/Y0.8 hardware verification ~30min each).

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

**r2 correction (codex r1 must-fix #1)**: per the live gate contract at `scripts/check-sqlite-test-skip-pattern.cjs:120-127` and the helper documentation at `src/__tests__/utils/sqlite-skip.ts:10-16`, the enforcement scope is:

- **C3-direct** (file directly imports `better-sqlite3`): per-block — every outer `test(...)` / `it(...)` block must call `skipIfSqliteUnavailable()`.
- **C4-transitive** (file reaches `nativeBackedModule` via value import chain, BFS depth ≤ 4): **file-level only** — the helper must be imported and called at least ONCE somewhere in the file; per-block guards are intentionally NOT required because most blocks use fake injection and per-block enforcement would lose host-Node coverage on fake-only paths.

All 16 missing_helper rows at Y entry are tagged `C4-transitive` per the current script output (re-verified 2026-05-23 against the r1 HEAD). None are C3-direct.

Disposition default: **(a) fix**. For each `missing_helper` file (all are C4-transitive): add `import { skipIfSqliteUnavailable } from './utils/sqlite-skip'` AND call `skipIfSqliteUnavailable(t)` **at least once anywhere in the file** (per the helper doc and the gate's `hasSkipHelperImport` + import-only-presence check at `scripts/check-sqlite-test-skip-pattern.cjs:309-310`; "anywhere in the file" is the contract — codex r2 should-fix #1 corrected the r2 phrasing "top of the first test block" which was stricter than the gate enforces). A natural placement is the first `test(...)` block, but the gate does not require it; placing the call inside a `beforeEach` or a per-suite helper is equivalent. For each stale `c4Exempt` entry: remove from `scripts/test-coverage-exemptions.json`. If a file truly never lets the module load sqlite (only injects a fake DB through every block), keep the `c4Exempt` entry but update its `reason` field to reflect the current import shape.

Decision tree:

1. For each `missing_helper` file: verify via fresh BFS trace (re-run `node scripts/check-sqlite-test-skip-pattern.cjs` after the edit) that the file actually transitively loads `better-sqlite3` through a value import. If yes → add file-level helper call (path a). If the BFS evidence is wrong (false positive) → promote to `c4Exempt` with explicit reason (path a-variant).
2. For each stale `c4Exempt` entry: confirm via fresh trace whether the file still injects fake DB only. If yes → keep + update reason. If no → remove the entry; the file-level helper-call fix from step 1 already covers it.
3. Re-arm: rename `scripts/__tests__/check-sqlite-test-skip-pattern.deferred.cjs` → `.test.cjs` so wildcard pickup re-includes it; add direct `node scripts/check-sqlite-test-skip-pattern.cjs` invocation to `verify:k` (or whichever chain currently lacks it per X1.8 ledger row 1).

Acceptance:

- `node scripts/check-sqlite-test-skip-pattern.cjs` exits 0.
- `npm run verify:k` (or relevant chain) exits 0.
- `deferred-work-ledger.md` row for this gate flips to status `green` with commit-hash pointer.

Fallback **(b)** triggers if: the 16 files cannot be made to satisfy the file-level helper contract without touching production code that violates Stage Y scope (e.g., requires rewriting `agent-sdk-runtime` to remove a transitive sqlite import to make the C4 BFS not reach native bind). In that case, the disposition becomes a Y2 large-file extraction with the gate moved into `scripts/check-stage-y-known-regressions.cjs` per §6.5.

### 6.2 Y0.1.2 — `check-stage-r-verify-switch` + `check-stage-t-verify-switch`

Symptom: both gates hard-code `### 6.25` (Stage R) and `### 6.27` (Stage T) numbered CLAUDE.md sub-sections that the post-Stage-T CLAUDE.md reorganization removed (current CLAUDE.md uses §0-§12 flat structure). Both also assert `verify` / `verify:cloud` embed `verify:r` / `verify:t` directly.

**r2 correction (codex r1 must-fix #2)**: pure deletion is now forbidden as the default. CLAUDE.md / AGENTS.md continue to point at Stage R/T plan files (CLAUDE.md §8 "协作文档索引" lines 95-107; AGENTS.md mirrored), and `verify:cloud` still embeds `verify:t` (`package.json:50`). The Stage R/T charter is still live; only the numbered-heading anchors went away. The correct default is therefore **(a) current-charter rewrite**, not deletion.

**r3 amplification (codex r2 should-fix #2)**: the path-(a) rewrite implicitly relaxes the original Stage R/T contract from "main `verify` script must embed `verify:r`/`verify:t`" to "either `verify` OR `verify:cloud` embeds them". The current `package.json:44` plain `verify` does NOT embed either; only `verify:cloud` at line 50 embeds `verify:t`. This policy downgrade MUST be recorded explicitly in the §6.2 sub-plan (one paragraph + ledger row) so future stages do not silently treat the rewrite as "no policy change". Also: `scripts/__tests__/check-stage-t-verify-switch.deferred.cjs` is the renamed wildcard-test variant — if path (a) is chosen, rename it back to `.test.cjs`; if path (b) is chosen, leave the rename in place and update the schema reference.

Disposition default: **(a) current-charter rewrite**.

Decision tree:

1. Decide whether the underlying contract (Stage R/T scope must be findable in CLAUDE.md/AGENTS.md, and one of `verify` / `verify:cloud` must embed `verify:r` / `verify:t`) is still wanted. The §1 "package.json" input row + the active links in CLAUDE.md §8 say yes; the sub-plan should re-confirm.
2. Rewrite both gates to assert the live contract under the current section structure:
   - Replace `/###\s*6\.25/` with a search for the Stage R plan-file link (`docs/superpowers/plans/2026-05-08-R-stage12-implementation.md`) in CLAUDE.md §8 "协作文档索引".
   - Replace `/###\s*6\.27/` with a search for the Stage T plan-file link (`docs/superpowers/plans/2026-05-09-T-stage14-implementation.md`) in CLAUDE.md §8.
   - Keep the `verify` / `verify:cloud` chain-composition assertion intact but allow either `verify` OR `verify:cloud` to satisfy (current state: `verify:cloud` embeds `verify:t`, plain `verify` does not).
3. Re-arm: restore `node scripts/check-stage-r-verify-switch.cjs` and `node scripts/check-stage-t-verify-switch.cjs` direct invocations in `verify:r` / `verify:t` (or `verify:s` if the chain is cleaner there); rename their `.deferred.cjs` test variants back to `.test.cjs`.

Fallback **(b)** triggers only if the sub-plan concludes the underlying contract is obsolete (Stage R/T scope no longer needs gate-level enforcement) AND a one-paragraph written decision exists. Even then, pure deletion is forbidden — the gate must be replaced by either (i) an equivalent assertion in `verify:stage-y-known-regressions` (per §6.5), or (ii) a release-handoff row in `release-handoff.md` (per §10.3). The historical proof from X1.8 must not be silently removed.

Acceptance:

- Decision document exists in the sub-plan.
- Either both gates are rewritten and exit 0 against current CLAUDE.md/AGENTS.md/`package.json`, OR both are demoted with a replacement gate / handoff row per fallback (b).
- `verify:r` and `verify:t` (or the chosen replacement chain) exit 0.

### 6.3 Y0.1.3 — `check-testing-conventions-doc`

Symptom: same `### 6.NN` numbered-section drift as §6.2. Asserts CLAUDE.md and AGENTS.md both contain `### 6.17`.

Disposition default: **(a) fix via rewrite** + **content-level enforcement** (codex r1 should-fix #1).

The testing-conventions contract is still actively referenced (CLAUDE.md §6 "测试与验证" carries it now); the gate just needs to update its check to find the section AND assert the testing-convention substance is present.

Rewrite scope:

1. Replace the `/###\s*6\.17/` regex with a `### ` heading match against the current flat structure: CLAUDE.md must contain `## 6. 测试与验证` (or equivalent header) AND AGENTS.md must contain the mirror header.
2. **Content-level**: beyond heading existence, assert that both files reference at minimum: (a) `npm run verify:native` requirement for SQLite-backed tests, (b) "no source-grep冒充行为验证" rule, (c) "no skip 当通过" rule. These are the testing-conventions invariants currently captured in CLAUDE.md §6 lines 124-131. The gate should grep for representative substrings.
3. **CLAUDE/AGENTS sync**: per CLAUDE.md §12 "指引同步" (lines 134-136) and AGENTS.md §12 (mirrored), the two files must stay in sync on substance. The gate should additionally assert that the §6 testing-conventions paragraph content is identical (or equivalent) between CLAUDE.md and AGENTS.md.
4. Re-arm: restore `node scripts/check-testing-conventions-doc.cjs` direct invocation in `verify:f`.

Acceptance:

- `node scripts/check-testing-conventions-doc.cjs` exits 0 against the current CLAUDE.md and AGENTS.md.
- `npm run verify:f` exits 0.
- The gate fails if CLAUDE.md §6 is removed, OR if AGENTS.md §6 diverges from CLAUDE.md §6 on testing-convention substance.
- Sub-plan documents the content-substring choices and the CLAUDE/AGENTS-sync rationale.

### 6.4 Y0.1.4 — `check-research-adapter-registered-in-host`

Symptom: `src/main/modules/claude-bridge/direct-chat.ts:459-461` places `MapDomainAdapter` first in `domainAdapters[]`; the Stage R W1.6 gate requires `ResearchDomainAdapter` to be first.

This is the only Y0.1 row that touches production source code (`src/main/`). Per §1 input note + r2 verification: research-vs-map routing is a real policy conflict — commit `012ec8a6` placed Map first because tests intentionally assert map intent wins for certain queries; the inline comment at `direct-chat.ts:458` documents that "MapDomainAdapter reads the TurnEngine-precomputed mapSemanticIntent synchronously" (a tight signal-driven `shouldHandle`).

Confirmed at r2 (codex r1 must-fix #2 verification): `selectDomainAdapter` at `src/main/modules/agent-control/domain-adapters/domain-adapter.ts:264-272` uses `adapters.find((adapter) => adapter.shouldHandle(params))` — first matching wins. **Order does matter** when more than one adapter's `shouldHandle` returns true for the same query. Whether the conflict is theoretically reachable is the question Y0.1.4 must answer with overlap tests, not guesses.

Disposition default: **decision-required after overlap-fixture-first investigation** (codex r1 should-fix #2).

Decision tree:

1. **Construct overlap fixtures FIRST** (before reading any existing test). Build a small fixture matrix:
   - Query A: pure route planning ("how do I drive to Beijing Capital Airport"). Expected: Map wins (or should win) per current commit `012ec8a6` intent.
   - Query B: pure research ("research the latest GPT-5 benchmarks"). Expected: Research wins.
   - Query C: ambiguous overlap ("research the fastest route from Shanghai to Beijing — should I drive or fly"). Expected: undefined under current code; this is the conflict zone.
   - Query D: research-with-map-keywords ("compare the COVID-19 case map across countries in 2024"). Expected: undefined; overlap zone.
   Run each query through a real `DirectChatEngine.classify()` call (or equivalent test harness) with both orderings (Map-first per current code; Research-first per Stage R gate) and capture which adapter's `shouldHandle` returns true and which adapter `selectDomainAdapter` picks.
2. Read the existing test files (`src/__tests__/*adapter*`, `src/main/modules/claude-bridge/__tests__/*`, `src/main/modules/agent-control/__tests__/*adapter*`) and identify any test that asserts a specific adapter wins for a specific query.
3. Classify the conflict:
   - **Apparent conflict** (no query has both Map and Research's `shouldHandle` return true): reorder the array to put Research first (path a); map-wins tests still pass because Map classifies on queries Research declines; re-arm Stage R gate.
   - **Real conflict** (at least one fixture query has both shouldHandle return true): the conflict zone is real. Then:
     - Path (a-priority-research): give Research priority per the Stage R interpretation (research is meta-routing, map is a destination handler); update the conflict-zone test fixtures to assert Research wins; document in the sub-plan that Map-only queries (queries A) still route via Map because Research's `shouldHandle` declines on them.
     - Path (b-gate-rewrite): keep Map first and rewrite the Stage R gate to assert "Research must appear in the array at any position; the routing tiebreaker is defined elsewhere"; document the new tiebreaker contract in `direct-chat.ts` JSDoc.

The sub-plan must include the overlap fixture evidence (all 4 queries × 2 orderings = 8 outcomes), the decision rationale, and the diff that implements it. No edit lands without the fixture evidence first.

Acceptance:

- Overlap fixture evidence captured in the sub-plan.
- Either `node scripts/check-research-adapter-registered-in-host.cjs` exits 0 with the original assertion (path a-* variants), OR the gate is rewritten and exits 0 with the new contract (path b).
- `npm run verify:r` exits 0.
- The disposition is recorded in `deferred-work-ledger.md` (even if green, the historical decision deserves a row).

### 6.5 Cleanup of the replacement gate (codex r1 must-fix #4 + #7)

After all 4 rows are dispositioned, the X1.8 replacement gate is NEVER simply deleted. It is replaced by a Stage Y successor gate `scripts/check-stage-y-known-regressions.cjs` (wired as `npm run verify:stage-y-known-regressions`) that mirrors the X1.8 pattern: validates the Y deferred-work-ledger rows AND prevents silent re-introduction of any Y-retired sub-gate into the verify chains.

Per-row transition rules:

- **Row went green via path (a)** (source/doc fix + gate re-armed): remove the row from `check-stage-x-known-regressions.cjs`'s required-ledger-entries list AND from the new Y successor gate's list — the gate is back in the live verify chain, so neither replacement gate needs to pin it.
- **Row went via path (a) rewrite** (gate rewritten to current charter + re-armed): same as above; the rewritten gate is the live proof.
- **Row went via path (b) explicit retire-with-reason**: move the row from X1.8 ledger to Stage Y ledger; add to `check-stage-y-known-regressions.cjs`'s required list; cross-link via tracking-link field.

Deletion of `scripts/check-stage-x-known-regressions.cjs` is permitted ONLY when all 3 conditions below are met. To make these machine-checkable (codex r2 must-fix #4), `y0-1-disposition-report.md` MUST conform to `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report-schema.json` (created at Y0.0):

```json
{
  "$schema": "Stage Y Y0.1 disposition report v1",
  "rows": [
    {
      "gate_id": "check-sqlite-test-skip-pattern",     // one of the 4 original X1.8 IDs
      "original_script_path": "scripts/check-sqlite-test-skip-pattern.cjs",
      "original_ledger_link": "docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md#row-1",
      "disposition_path": "a-fix" | "a-rewrite" | "b-replacement-gate" | "b-retired-with-reason",
      "outcome_commit": "<git sha of the disposition commit>",
      "rearmed_in_verify_chain": "verify:k" | "verify:r" | "verify:s" | "verify:t" | "verify:f" | null,
      "replacement_gate_path": "scripts/check-stage-y-known-regressions.cjs#<gate_id>" | null,
      "retire_reason": "<one paragraph>" | null,
      "rationale": "<one paragraph cross-referencing the §6.x decision tree branch chosen>"
    },
    // ... exactly 4 rows, one per X1.8 retired gate
  ]
}
```

`scripts/check-y0-1-disposition-report.cjs` (added at Y0.0) validates:

- **Exactly 4 rows present** (codex r3 must-fix #2: ambiguity resolved). The 4 rows correspond to the 4 X1.8 ledger rows (NOT the 5 individual scripts). gate_ids MUST be exactly: {`check-sqlite-test-skip-pattern`, `check-stage-r-verify-switch+check-stage-t-verify-switch` (paired as a single gate_id), `check-testing-conventions-doc`, `check-research-adapter-registered-in-host`}. The paired row covers both scripts under one disposition; if Y0.1.2 chooses to split them (e.g., one path-a + one path-b), the paired row's `rationale` field must explain the split AND `replacement_gate_path` / `rearmed_in_verify_chain` may use semicolon-separated multi-value form. The schema validator enforces exactly 4 rows, no more, no less.
- Each row's `outcome_commit` exists in the repo per `git cat-file -e`.
- If `disposition_path = a-fix` or `a-rewrite`: `rearmed_in_verify_chain` is non-null AND that verify chain in current `package.json` invokes the gate's original script (or its rewritten name).
- If `disposition_path = b-replacement-gate`: `replacement_gate_path` resolves on disk AND the gate is invoked by `scripts/check-stage-y-known-regressions.cjs`.
- If `disposition_path = b-retired-with-reason`: `retire_reason` is non-empty AND a ledger row exists in `deferred-work-ledger.md` with matching gate_id.
- Every gate's `rationale` cites at least one §6.x section anchor verbatim.

**Conditions for X gate removal**:

1. `node scripts/check-y0-1-disposition-report.cjs` exits 0, AND
2. `scripts/check-stage-y-known-regressions.cjs` exists and `npm run verify:stage-y-known-regressions` exits 0 (its own ledger may be empty if all 4 rows went green via path a/a-rewrite; that is a valid terminal state), AND
3. `y0-1-disposition-report.md` exists with the schema above AND links to the original X1.8 ledger rows for historical proof.

Until conditions 1-3 are met, `verify:stage-x-known-regressions` stays in `package.json` AND in the CI merge-job step list (per §14.2 + §7 Y0.2.a).

## 7. Phase Y0.2 — CI truthful (codex r1 must-fix #3 + should-fix #3: split into Y0.2.a + Y0.2.b)

### 7.1 Y0.2.a — Merge-job step alignment

Goal: bring `.github/workflows/ready-merge-gates.yml` merge job into structural agreement with §14.2 Y-release-track list. No remote run required at this sub-phase.

Steps:

1. Read `.github/workflows/ready-merge-gates.yml`.
2. Compare merge-job step list against §14.2. Add any missing step:
   - `npm run verify:meta-paths` (likely missing per X3 deferral note).
   - `npm run verify:stage-x-known-regressions` (keep this in the merge job through Y0.1 work window per §6.5; remove only after Stage Y successor gate is in place).
   - Any other §14.2 row that the merge job currently lacks.
3. Record divergences (rows in §14.2 that intentionally do NOT make it into merge — e.g., `npm run build` may be Stage Z-only) in `ci-report.md` §2.

Acceptance:

- Merge-job step list matches §14.2 verbatim OR every divergence is documented in `ci-report.md` §2.
- `verify:stage-x-known-regressions` is in the merge job until §6.5 conditions are met.

### 7.2 Y0.2.b — Deep-gates enablement + first remote run

Goal: produce one real GitHub run URL AND decide deep-gates disposition.

Steps:

1. Decide deep-gates job disposition (codex r1 must-fix #3 relaxation):
   - Flip `deep-gates` from `if: false` to `if: github.event_name == 'push'` (informational; not merge-required) when BOTH (a) Y0.1 dispositions are stable (each of the 4 rows has a committed disposition per §6) AND (b) every command in the deep-gates job either passes currently OR is represented by a passing replacement gate per §6.5. Path-(b) dispositions are acceptable IF the deep-gates job invokes the replacement gate instead of the original.
   - Otherwise, keep `deep-gates` `if: false` and write a one-paragraph rationale + Stage Z ledger row in `ci-report.md` §3.
2. If deep-gates flipped: bundle the deep-gate commands into the existing workflow OR a separate `.github/workflows/ready-deep-gates.yml` file (team preference; either is acceptable).
3. Coordinate with 白 (or repo admin) to:
   - Push the branch.
   - Trigger first run (push or PR trigger; PR is preferred because it exercises the `pull_request` trigger path documented in X3 ci-gate-report).
   - Capture the run URL.
   - If the run fails: classify as (i) real platform regression (file as new ledger row + fix), or (ii) workflow shape bug (fix yaml + retrigger; do not delete the run, keep history).
4. Append to `ci-report.md` §3:
   - First run URL.
   - Per-step pass/fail outcome from that run.
   - Delta vs the local merge-gate equivalent (X3 captured this baseline at `MERGE_GATE_EXIT=0`); if any step diverges, write the delta as a ledger row.
5. Branch protection step: per X3 ci-gate-report §4, configuring branch protection is repo-admin UI work. Document the exact required-status-check name (`Ready merge gates / merge`) and the "require up-to-date branches" toggle in `release-handoff.md` for Stage Z.

Acceptance:

- `ci-report.md` §3 contains a real `https://github.com/...` run URL with a date.
- Deep-gates disposition is decided per the relaxed rule and documented.
- Branch-protection handoff captured in `release-handoff.md`.

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

## 9. Phase Y0.5 — Product dogfood matrix v3 (codex r1 must-fix #5: 16 → 20 rows)

### 9.1 Surface inventory (20 rows)

Each row needs reproduction steps, a 30-second screencap when visual, and the relevant log tail (`ready-directchat.log`, `ready-tools.log`, `ready-browser.log`, or app console output).

r1 → r2 changes per codex must-fix #5: row 16 (Release visual checklist) split into 16 (BrowserView overlay + theme boot), 17 (dropdowns + tldraw + text editing), 18 (shell empty states + first-open warm-up); row 13 expanded to explicitly call out FastCard, clipping, content-study, AND Obsidian web clip / current-tab clip; row 9 now explicitly covers restart AND forced-quit AND crash resumability (CLAUDE.md §3 line 49-50 durable-handle requirement); new row 19 covers Obsidian web clip; new row 20 covers `agent_interaction` capability routing (CLAUDE.md §3 line 53 first-class capability dimension).

| # | Surface | Minimum scenario | Must prove |
| ---: | --- | --- | --- |
| 1 | File manager | Fixed fixture: open `/tmp/ready-y0-5-fixture/` (created by sub-plan with one file `notes.md`); switch from `browser` mode to `document` mode and back; rename `notes.md` → `notes-renamed.md`; move to subdirectory `archive/`; delete; restore from trash within same session. (Codex r2 should-fix #4: was "across two workbench modes" without specifying which.) | Tree state and selection persist across each mode switch; no stale watcher event or duplicate node; restore returns file to original path. |
| 2 | Embedded browser | Create tab, navigate, switch tab, reload, open popup/new window, drag/split if applicable. | BrowserView bounds, header state, and DOM overlay behavior stay aligned. |
| 3 | RSS / RSSHub | Fixed fixtures: subscribe to (a) `https://news.ycombinator.com/rss`, (b) one Bilibili up-master route via personal RSSHub, (c) one Twitter/X user via personal RSSHub; refresh all three; preview the latest item from each; open one item in browser; trigger `analyze-rss-feed` skill on the HN feed. (Codex r2 should-fix #4: was "three sources, one analysis path" without specifying.) | Worker cleanup (no leaked RSSHub child process after refresh); preview handoff (DOM overlay before BrowserView showActive); browser handoff (URL opens in active tab); analyze path produces structured output. |
| 4 | Document editor / preview | Open markdown and editable document; save; preview; reopen. | No silent save failure; preview/editor state matches disk. |
| 5 | Document widgets | Fixed fixtures: trigger each of widgets A–G with the canonical prompt per `docs/superpowers/plans/2026-04-30-D-*-implementation.md` (A=summary, B=todo, C=quote, D=table, E=code, F=diagram, G=image-caption); plus one H1/H2 freeform trigger using the exact phrase "把这段写成醒目的标题卡" (per CLAUDE.md §4 trigger-word note). (Codex r2 should-fix #4: was "A-G skeletons plus one H1/H2" without specifying prompts.) | Each of A–G renders the matching widget type (not silent fallback to plain text); H1/H2 freeform triggers freeform widget only on the trigger phrase; target attachment from one widget does not leak into the next question's context. |
| 6 | Calendar | Create event, recurring event, navigate day/week, accept one agent suggestion. | Timezone/recurrence render correctly; remote suggestion does not bypass scope rules. |
| 7 | Agent panel | New chat, provider switch, failed send, retry, cold start, multi-tab session. | Composer unlocks; active/visible session lists stay consistent. |
| 8 | Settings / external services | For each of OpenAI-compatible, RSSHub, Jina, DuckDuckGo, Amap, VEA: open Settings → external services page; edit one field; click Save; click Test. Then for each, force the missing-key state (clear key, click Test). (Codex r2 should-fix #4: was "edit/save/test" without specifying scope.) | Save round-trip is real (value persists across reopen); Test button distinguishes "real probe pass" vs "field validation only" per Y1.1 disposition; missing-key state surfaces understandable error toast (not silent green). |
| 9 | Skills center (restart + crash + forced-quit resumability) | Install bundled skill, run one action that produces an artifact, then in three separate sessions: (a) clean app restart, (b) `kill -9` on Electron process mid-run, (c) Cmd-Q forced quit mid-run. After each, reopen app and verify the child-run handle resumes. | Child-run durable handle works in ALL THREE scenarios per CLAUDE.md §3; artifact paths survive; the projection UI shows the correct continuable state without renderer guessing. |
| 10 | Provider failure recovery | Fixed-fixture matrix: for each of the X2 11-code ProviderTerminalCode values, trigger the failure via (a) stub provider for unit-test-equivalent paths, (b) live provider for HTTP 402 and HTTP 429-with-retry-after (mandatory 白 spot-check per §9.4 codex r2 ruling). All 11 codes documented in `src/main/modules/claude-bridge/provider-terminal-error.ts`. (Codex r2 should-fix #4: was "simulate ..." without specifying stub vs live.) | User sees clear failure for each of 11 codes; composer unlocks on every code; retry policy is bounded (transient + provider_thinking_echo_required have bounded auto-retry; others do not retry); HTTP 402 + HTTP 429 evidence captured live by 白. |
| 11 | Remote IM / channel sidecar | Fixed fixture: 白 sends from a configured Feishu thread (1 text message + 1 image attachment + 1 PDF attachment); agent receives all three into the scoped session; user then asks agent to summarize. If no live Feishu sidecar is reachable, mark surface as `deferred-with-owner` (owner=白, reason="live Feishu sidecar not reachable in this run") — do NOT stub remote IM. (Codex r2 should-fix #4: ambiguity about live vs stub resolved.) | Attachment lands in resource layer first (no auto-agent-task fire); tool logs do not enter the user-visible transcript (CLAUDE.md §2 hard constraint); summary task references all three attachments by resource id, not raw URLs. |
| 12 | Map / Amap workflow | Ask route planning with research/browser secondary signals. | Map intent wins only when it should; research intent is not swallowed by map (depends on Y0.1.4 disposition). |
| 13 | FastCard full surface — translate + describe image + resolve video + overlay command + clipping/content-study (codex r2 must-fix #5) | (a) In a browser tab, select text and trigger `translateFastCardSelection` (`src/preload/index.ts:399`); verify translated overlay renders. (b) Right-click an image and trigger `FastCardDescribeImageRequest`; verify description appears in overlay. (c) Right-click a video element and trigger `FastCardResolveVideoRequest`; verify resolved metadata appears. (d) Fire one `FastCardOverlayCommand` (per `BrowserFastCardContextActionEvent` at `src/preload/index.ts:13-19,394`); verify overlay command round-trip. (e) Clip a browser page into note/card flow and ask agent to transform it. | All four FastCard APIs round-trip; overlay snapshot (`FastCardOverlaySnapshot`) reflects the latest action; source URL, privacy sanitizer, and document target survive the handoff; overlay commands do not race with BrowserView hide/show ritual (X4.1 BrowserViewIntent contract). |
| 14 | Automation / schedules | Create, list, pause, resume, and fire one reminder/scheduled task. | Schedule state is durable; fired task links back to correct conversation/workspace. |
| 15 | VEA / vision model | Configure a vision model, run image analysis, force missing-key/disabled state. | Test button performs a real probe or clearly says it only validates fields (depends on Y1.1 / Y0.8 disposition). |
| 16 | Release visual — BrowserView overlay + theme boot | Toggle BrowserView visibility under dropdown/modal overlay; cold-start app and observe theme application before first paint. | Overlay blanking behaves per X4.1 BrowserViewIntent contract (5 kinds); no white-flash on theme boot. |
| 17 | Release visual — dropdowns + tldraw + text editing | Exercise every Settings dropdown, open a tldraw widget and draw, focus a text editor and type. | Dropdowns z-index correct over BrowserView; tldraw input does not lose focus; text editor IME composition works. |
| 18 | Release visual — shell empty states + first-open warm-up | Cold-start app with empty user-data; observe each workbench-mode empty state; record first-open warm-up time (cold-start → ready-to-input). | Empty states render per spec; warm-up time p95 ≤ 3000ms on W3.3 hardware (carry-over from W3 chosen-layout-model). |
| 19 | Obsidian web clip / current-tab clip | From an active BrowserView tab, trigger Obsidian web-clip IPC; verify clipped content lands in Obsidian; trigger the current-tab clip IPC variant. | Clip content shape matches Obsidian's expected payload; current-tab IPC does not regress per `src/__tests__/obsidian-web-clip-current-tab-ipc.test.ts` (listed in Y0.1.1 missing_helper rows; this surface depends on Y0.1.1 disposition). |
| 20 | `agent_interaction` capability routing | Send a query that triggers `ask_user_questions` (the structured reverse-question tool); verify the routing path; verify the "1-per-turn + 1-pending-card-per-session" constraint from CLAUDE.md §5. | `agent_interaction` is its own capability dimension per CLAUDE.md §3 line 53; routing must not be confused with skill authorization. |

### 9.2 Evidence schema (one file per surface) — codex r1 must-fix #6 strengthened

Each `audits/2026-05-23-stage-y-closeout/dogfood/<surface-slug>.md` MUST contain:

```markdown
---
surface: <surface name, exactly matching §9.1>
surface_id: <integer 1-20 from §9.1>
date: YYYY-MM-DD
operator: <name>                # primary operator: agent-id or 白
operator_class: agent-only | agent-with-bai-spotcheck | bai-only   # MUST match §9.4 row class
hardware: <macbook-pro-m5-pro-24gb / linux-x64 / other>
build_commit: <git sha — MUST match the HEAD at evidence-capture time per §9.2.1 capture-HEAD rule>
build_commit_captured_at: <ISO 8601 timestamp from `git log -1 --format=%cI <sha>` of the commit OR the explicit `git rev-parse HEAD` capture moment>
status: pass | fail | deferred-with-owner
deferred_owner: <name, only if status=deferred-with-owner>
deferred_reason: <one sentence, only if status=deferred-with-owner>
artifact_manifest: evidence/<surface-slug>-manifest.json
bai_spotcheck:                  # REQUIRED iff operator_class != agent-only
  performed_by: <白 or named release-engineer>
  performed_at: <ISO 8601>
  spotcheck_evidence: evidence/<surface-slug>-bai-spotcheck.{mp4|gif|txt}   # separate artifact from agent baseline
  spotcheck_sha256: <sha256 of spotcheck_evidence>
  spotcheck_signoff_text: "<one sentence in 白's voice confirming the surface behaves as expected>"
---

# <surface name> — dogfood evidence

## Reproduction steps
1. ...
2. ...

## Expected result (from §9.1 "Must prove")
- ...

## Observed result
- ...

## Evidence artifacts (listed verbatim in the manifest)
- Screencap: `evidence/<surface-slug>-screencap.mp4` (or `.gif`); SHA-256 in manifest.
- Log tail: `evidence/<surface-slug>-ready-tools.log` (or others as relevant); SHA-256 in manifest.
- Console output: `evidence/<surface-slug>-console.txt`; SHA-256 in manifest.

## Timestamp alignment
- Reproduction window: `<ISO 8601 start>` → `<ISO 8601 end>`.
- Each log tail's earliest and latest timestamp falls within the reproduction window ± 30 seconds. The gate verifies overlap.

## Pass/fail rationale
- One paragraph explaining how the evidence supports the status field.

## New defects discovered
- Any new bug found during this surface's exercise gets a row here AND a new entry in `deferred-work-ledger.md`. Do not squeeze the new defect into another surface's row.
```

And `evidence/<surface-slug>-manifest.json` (per codex r1 P2 nice-to-have #1):

```json
{
  "$schema": "Stage Y dogfood evidence manifest v1",
  "surface_id": 1,
  "surface": "File manager",
  "captured_at": "2026-05-25T10:00:00Z",
  "build_commit": "abcdef1234567890",
  "operator": "白",
  "hardware": "macbook-pro-m5-pro-24gb",
  "artifacts": [
    {
      "path": "evidence/file-manager-screencap.mp4",
      "type": "screencap",
      "sha256": "...",
      "bytes": 1234567,
      "created_at": "2026-05-25T10:00:30Z"
    },
    {
      "path": "evidence/file-manager-ready-tools.log",
      "type": "log",
      "sha256": "...",
      "bytes": 8192,
      "created_at": "2026-05-25T10:00:35Z",
      "log_earliest_timestamp": "2026-05-25T10:00:01Z",
      "log_latest_timestamp": "2026-05-25T10:00:29Z"
    }
  ]
}
```

### 9.2.1 Capture-HEAD rule (codex r3 must-fix #3: reflog branch replaced with portable head-capture artifact)

To prevent "tested-against-stale-build" fake-green AND keep the rule verifiable from any clone or CI runner (not just the operator's machine), the manifest's `build_commit` and `captured_at` together MUST tie the evidence to a specific repo state via a checksummed `head-capture.txt` artifact:

1. At capture time, the operator runs:
   ```bash
   {
     echo "build_commit=$(git rev-parse HEAD)"
     echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
     echo "git_status_porcelain=$(git status --porcelain | wc -l)"
   } > evidence/<surface-slug>-head-capture.txt
   sha256sum evidence/<surface-slug>-head-capture.txt
   ```
   The SHA-256 of the resulting file is recorded in the manifest as a `type: head-capture` artifact (separate from log/screencap artifacts).
2. `build_commit` MUST exist in the local repo (validated via `git cat-file -e <sha>^{commit}`).
3. `build_commit_captured_at` in the frontmatter MUST equal the commit's committer-date (`git log -1 --format=%cI <sha>`). The r3 reflog-fallback branch is REMOVED (reflog is per-clone and cannot be verified from another machine); operators who test against a non-HEAD commit must explicitly checkout that commit first OR mark the surface as `deferred-with-owner` (reason: "evidence is against non-HEAD commit; needs Stage Z re-capture against release-candidate HEAD").
4. `captured_at` in the manifest MUST be ≥ `build_commit_captured_at`. Future-dated `captured_at` (more than 1 minute past the lint run) is rejected.
5. The `git_status_porcelain` count in the head-capture.txt MUST be 0 (clean working tree at capture time); non-zero count means the evidence was captured with uncommitted local changes and is rejected.

The lint rule `check-stage-y-dogfood-evidence.cjs` re-computes the SHA-256 of the head-capture.txt artifact and matches against the manifest entry, then parses the file and verifies the 3 lines.

### 9.2.2 Reproduction-window overlap (codex r3 should-fix #3: 50% fallback removed)

For `type: log` artifacts, the gate enforces **strict overlap** with the reproduction window declared in the `## Timestamp alignment` body section:

- The body's `Reproduction window: <start> → <end>` must be parsed and capture-window = [start, end].
- For each log artifact, the gate parses the log file's first and last entries to extract `actual_log_earliest` and `actual_log_latest`.
- Both `actual_log_earliest` AND `actual_log_latest` MUST fall within `[reproduction_window.start - 30s, reproduction_window.end + 30s]`. The r3 "50% overlap of shorter window" fallback is REMOVED — a partial-overlap log does not prove the artifact covers the relevant period.
- Logs with no parseable timestamps (e.g., truncated log files) cause the surface to be marked `fail` automatically.

### 9.2.3 `scripts/check-stage-y-dogfood-evidence.cjs` lint rules

- All frontmatter fields present.
- `status` ∈ {`pass`, `fail`, `deferred-with-owner`}.
- If `status = deferred-with-owner`: both `deferred_owner` and `deferred_reason` non-empty.
- `operator_class` matches the §9.4 row's class for that `surface_id`.
- If `operator_class != agent-only`: the `bai_spotcheck` block is REQUIRED with all sub-fields non-empty; `spotcheck_evidence` exists on disk; `spotcheck_sha256` matches `sha256sum spotcheck_evidence`; `performed_at` is within `[captured_at, captured_at + 72 hours]` (codex r3 should-fix #1: tightened from 14 days). If 72h is exceeded, the spotcheck must produce its own `head-capture.txt` artifact AND prove `build_commit` matches the agent baseline's `build_commit`; otherwise the surface is marked `fail`.
- For surface 13 (FastCard full surface — codex r3 should-fix #2): the body's `## Evidence artifacts` section MUST contain 5 named sub-flow markers `### Sub-flow 13.{a|b|c|d|e}` covering translate / describe image / resolve video / overlay command / clipping respectively. Each sub-flow either references a separate screencap artifact OR an explicit time-range within a composite screencap; missing any of the 5 markers makes the surface ineligible for `status=pass`.
- For surface 10 (provider failure recovery), the body MUST explicitly cover the HTTP 402 scenario OR cross-link to Y0.3 evidence where 白 captured the 402 path. Surface 10 is also mandatory-spotcheck per §9.4 codex r2 ruling.
- Body contains required sections (`## Reproduction steps`, `## Expected result`, `## Observed result`, `## Evidence artifacts`, `## Timestamp alignment`, `## Pass/fail rationale`).
- `artifact_manifest` path resolves on disk.
- Manifest JSON is valid AND its `surface_id`, `surface`, `build_commit`, `operator`, `hardware` fields match the frontmatter verbatim.
- Each artifact in the manifest: file exists on disk, file size matches `bytes`, SHA-256 of file matches `sha256` field.
- For `type: log` artifacts: enforced per §9.2.2 strict overlap.
- Manifest's `build_commit` enforced per §9.2.1 capture-HEAD rule.
- If `status = pass` or `fail`: at least one screencap artifact AND one log artifact present.
- A separate `evidence-checksums.txt` file is emitted alongside `evidence-checksum-manifest.json` (per §19 row 12 P2 P2 #1) for `sha256sum -c` tooling compatibility.

### 9.3 Per-surface sub-plan template (codex r1 P2 #2: "pre-existing coverage" required, not silent)

For each of the 20 surfaces, create `docs/superpowers/plans/2026-05-2x-Y0-5-<surface-slug>-implementation.md` containing:

- Surface name + §9.1 row reference.
- Detailed reproduction steps (expand the §9.1 minimum scenario).
- Expected result decomposition (test cases).
- **Pre-existing automated coverage**: MUST contain explicit prose, even if "none yet — this surface has zero automated coverage" (silence is forbidden). When tests exist, link to specific test file paths + line ranges.
- Operator (agent vs 白 per §9.4) — most can run on Linux/CI-class hardware; some are mandatory-白.
- Evidence file path (`audits/<y-close>/dogfood/<slug>.md`).
- Acceptance: per §9.1 "Must prove" + per-test-case checks.

### 9.4 Operator assignment (codex r1 must-fix #5 + §20.3: tighten visual/timing-sensitive surfaces to mandatory-白 spot-check)

| Surface | Default operator | Mandatory 白 spot-check? | Reason |
| --- | --- | --- | --- |
| 1, 4, 5, 8, 14, 15 | agent (CI-class hardware) | No (optional) | Pure interaction; no W3.3-specific behavior. |
| 9 | agent | No, but the forced-quit / `kill -9` paths require careful evidence capture; agent may need to script them. | Resumability test; visual aspect is minimal. |
| 6 | agent | No (optional) | Timezone correctness is verifiable from logs + screencap. |
| 2, 7, 16, 17, 18 | agent produces baseline; **白 mandatory spot-check** | YES | BrowserView, Agent panel composer timing, visual checklist — all are visual/timing-sensitive in ways that CI-class hardware may mask. 白 must observe at least once before status=pass is signed. |
| 3 | agent + **白 mandatory spot-check** | YES | RSSHub network behavior varies by personal RSSHub instance; only 白's box has the configured instance. |
| 10 | agent (stub paths) + **白 mandatory spot-check** for HTTP 402 + HTTP 429 (codex r2 §20.3 question 3 ruling) | YES (HTTP 402 + HTTP 429 paths only) | X2 already covered the 11-code matrix in unit tests; HTTP 402 is the X2 root-cause regression and its live recovery must be 白-verified. May cross-link to Y0.3 evidence if Y0.3 captures the 402 path. |
| 11 | agent OR 白 | No (but 白 has the live Feishu sidecar configured; preferred operator if reachable) | Remote IM requires a live channel for attachment ingest evidence. |
| 12 | agent (after Y0.1.4 disposition) | Optional | Map/research routing is deterministic once Y0.1.4 lands; agent can verify against the overlap fixtures. |
| 13, 19 | agent + **白 mandatory spot-check** | YES (Obsidian) | Obsidian web clip needs a live Obsidian instance; only 白's box has it. FastCard/clipping (13) is visual; agent baseline + 白 spot-check. |
| 20 | agent | No (optional) | `ask_user_questions` constraint enforcement is logic-testable; agent can run the fixture matrix. |

Surfaces that must run on 白's W3.3 hardware: 18 (first-open warm-up p95 ≤ 3000ms is W3.3-baseline-dependent). Y0.4 already owns the W3.3-specific shell mode-switch + split-pane drag evidence.

Surfaces with mandatory 白 spot-check (status=pass not signable without 白's evidence): **2, 3, 7, 10 (HTTP 402 + HTTP 429 paths), 13, 16, 17, 18, 19** (9 of 20 per r3 codex r2 ruling).

The §9.3 sub-plan template's "operator" field must explicitly select one of: `agent-only`, `agent-with-bai-spotcheck`, `bai-only`.

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

## 11. P0 scope locks for Y0.7/Y0.8 + P1 sub-plan slots (codex r2 must-fix #1 reorganization)

### 11.0a — P0 scope lock for Y0.8 (Settings cache quota enforcement)

Y0.8 is **non-deferrable P0** per §3.1 + §3.2 carve-out. Its scope lock (formerly §11.1 Y1.1 cache-quota subset):

- Cache quota: either UI enforces eviction with a measurable trigger (e.g., size > N → evict LRU until ≤ M), OR the UI is relabeled to honest "configured limit, not enforced; manual cleanup required" with a tracking row in `release-handoff.md`.
- Tests cover both branches (eviction-fires + eviction-disabled-with-relabel).
- May NOT bundle MCP work (that is Y0.7) or expand to general settings refactor.

Note: the VEA/vision profile test sub-item from r2 §11.1 stays in §11.1 P1 below because it is a Settings-reliability hardening, not a Stage Z entry blocker.

### 11.0b — P0 scope lock for Y0.7 (MCP transport or "not shipped" labeling)

Y0.7 is **non-deferrable P0** per §3.1 + §3.2 carve-out. Its scope lock (formerly §11.2 Y1.2):

- Pick one transport (stdio recommended for minimal scope) and prove it end-to-end, OR add UI labeling that "MCP is not shipped in this release; see Stage Z roadmap".
- Transport-branch acceptance: install one bundled MCP server (filesystem or fetch); user can install via Settings, server appears in skill/tool authorization UI, one tool call round-trip succeeds, server lifecycle (start/stop on app quit) does not leak processes.
- Labeling-branch acceptance: Settings MCP section shows the "not shipped" label; the existing authorization plumbing (Stage T) is left in place but visibly inert in UI.
- The choice between transport and labeling is documented in `release-handoff.md` § "Stage Z MCP carry-over".

## 11.1 onward — P1 sub-plan slots

Each P1 row needs its own `docs/superpowers/plans/2026-05-2x-Y1-<id>-<slug>-implementation.md` before any source edit lands. The scope locks below are non-negotiable boundaries; the sub-plan refines them.

### 11.1 Y1.1 — VEA/vision profile test behavior + disabled-default labeling (Settings reliability remainder)

Scope lock: VEA/vision profile "test" button must either probe a real endpoint (one HTTP request with auth + minimal payload, accepts non-error response as pass), OR button label changes to "Validate fields only" with disabled state when no key is configured. Tests cover both branches (probe-success + probe-failure). May NOT bundle cache-quota work (that is Y0.8 per §11.0a).

### 11.2 Y1.2 — RESERVED (formerly MCP; now Y0.7 per §11.0b)

This slot intentionally left blank to preserve §11 numbering across r2 → r3 → r4 + downstream references. The MCP scope lock is at §11.0b. The §4.3 budget row for Y1.2 is zero-budgeted per codex r3 should-fix #4/#5; the §13 Stage Z entry condition correctly excludes Y1.2 (lists `Y1.1 + Y1.3 + Y1.4` as the release-relevant P1 subset, with Y1.2 absent because MCP is now Y0.7). Any future reference to "Y1.2" should be read as "Y0.7 via §11.0b".

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

Scope lock: extend the existing `npm run verify:f:e2e` harness (defined at `package.json:37`, currently `npx tsx --test --test-concurrency=1 src/__tests__/e2e/*.e2e.ts`) to cover at minimum: Browser Agent send-receive, document/widget round-trip, remote attachment ingest, skills install+run+resume, provider smoke (one provider), BrowserView shell mode-switch, artifact retention across restart. (Codex r2 P2 #3: do not invent a new `test:e2e` script — extend the existing `verify:f:e2e`.)

Acceptance: harness runs in CI as `npm run verify:f:e2e` (separate from `npm run test`); at least 7 named scenarios pass; new scenarios named `*.e2e.ts` under `src/__tests__/e2e/`.

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

Stage Z starts only after (a) all Y0 P0 rows are green or explicitly deferred per §3.2, EXCEPT Y0.7 + Y0.8 which are non-deferrable per §3.2 carve-out and MUST be green, AND (b) Y1.1 + Y1.3 + Y1.4 (the release-relevant P1 subset; Y1.2 reserved per §11.2 since MCP is now Y0.7) are green.

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

### 14.2 Y-release-track (must all exit 0 at Y closeout AND must be the workflow's merge-job step list per Y0.2.a)

```bash
npm run verify:native
npm run typecheck
npm run lint:check
npm run verify:lint-budget
node scripts/check-eslint-baseline.cjs
npm run verify:ipc-contract
npm run verify:meta-paths
npm run verify:stage-x-known-regressions   # kept through Y0.1 per §6.5; removed AT Y closeout iff §6.5 conditions 1-3 are met
npm run test
npm run build
```

Plus (Y-closeout-specific, added by Y0.0):

```bash
npm run verify:stage-y-p0-ledger
npm run verify:stage-y-dogfood-evidence
```

Plus (added by §6.5 at Y closeout):

```bash
npm run verify:stage-y-known-regressions
```

Per §6.5: `verify:stage-x-known-regressions` is REMOVED at Y closeout iff (1) all 4 X1.8 rows are dispositioned, (2) Stage Y successor gate exists and passes, (3) historical proof preserved in `y0-1-disposition-report.md`. Until then, it stays in both `package.json` and the merge job.

### 14.3 Stage Z handoff context (codex r1 should-fix #4: `verify:cloud` status surfacing)

`verify:cloud` currently embeds `verify:t` (`package.json:50`) but plain `verify` does not. Stage Z must decide whether `verify:cloud` becomes required for release branches or stays an opt-in dev command. Stage Y captures the current state in `release-handoff.md` for Stage Z to act on. Not a Y-entry or Y-closeout command.

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

## 19. Stage Y closeout bundle structure (codex r1 must-fix + should-fix + P2 promotions)

`docs/superpowers/audits/2026-05-23-stage-y-closeout/` must contain (REQUIRED — formerly "plus" items 1, 3, 4 now promoted to required per codex r1 §20.5):

| # | Deliverable | Path | Source phase |
| ---: | --- | --- | --- |
| 1 | Close note (umbrella authority) | `CLOSE-NOTE.md` | Closeout |
| 2 | Deferred-work ledger | `deferred-work-ledger.md` | Closeout (populated from Y0.1 + Y0.5 + Y0.6 outputs) |
| 3 | No-drift statement | `no-drift.md` | Closeout |
| 4 | Verification matrix | `verification-matrix.md` | Closeout |
| 5 | Dogfood report | `dogfood/REPORT.md` (top-level index) + **20** per-surface files in `dogfood/` + evidence manifests per §9.2 | Y0.5 |
| 6 | CI report | `ci-report.md` (§1 workflow inventory, §2 merge-job alignment, §3 first remote run URL) | Y0.2 |
| 7 | Release handoff | `release-handoff.md` (§10.3 sections 1-5) | Y0.6 |
| 8 | Y entry truth + capture | `y0-entry-truth.md` + `verification-entry/` | Y0.0 |
| 9 | Stage Z seed plan | linked from `CLOSE-NOTE.md`; file path `docs/superpowers/plans/2026-05-2x-Z-release-candidate-seed.md` | Closeout |
| 10 | **Y0.1 disposition report** (NEW — codex r1 §20.5) | `y0-1-disposition-report.md` | Y0.1 (combines the 4 §6 decisions) |
| 11 | **Y-to-Z handoff matrix** (NEW — codex r1 §20.5) | `y-to-z-handoff-matrix.md` (one row per Stage Y deliverable; columns: `deliverable`, `path`, `inherits_to_z_phase` ∈ {Z0.1..Z0.5} per §13, `inherits_what`, `adds_what`, `discards_what`) — codex r2 P2 #2 added the inherits_to_z_phase column | Closeout |
| 12 | **Evidence checksum bundle** (NEW — codex r1 §20.5 + r2 P2 #1) | `evidence-checksum-manifest.json` (aggregates the 20 per-surface manifests + verify-bundle.sh outputs into a single bundle) + `evidence-checksums.txt` (generated from the JSON; standard `sha256sum -c` format for tooling compatibility per codex r2 P2 #1) | Closeout |
| 13 | **`verify-bundle.sh`** (PROMOTED to required — codex r1 must-fix #12) | `verify-bundle.sh` (mirrors Stage X pattern; one-line invocation re-running §14.2 + closeout-specific commands; compares live exit codes against `verification-final/<name>.exit`) | Closeout |
| 14 | **`verification-final/`** (PROMOTED to required — codex r1 must-fix #12) | `verification-final/<name>.out`, `.err`, `.exit` per §14.2 command + `SUMMARY.md` | Closeout |
| 15 | **白 operator runbook** (NEW — codex r1 P2 #3) | `bai-operator-runbook.md` (step-by-step instructions for 白 spot-check sessions per §9.4; includes screencap-and-checksum capture commands) | Y0.5 |

Plus stage-specific reports as needed (still optional):

- `bundled-skills-audit.md` (Y1.6)
- Per-surface dogfood sub-plans (each is a plans/ entry, not an audits/ entry)

## 20. Codex r1 verdict resolution + r2 open questions

### 20.1 Resolution of codex r1 open questions

| # | r1 question | codex r1 answer | r2 status |
| ---: | --- | --- | --- |
| 1 | §6 default for Y0.1.2 | "Default should be (a) current-charter rewrite, not (b) deletion" | §6.2 reset to default (a); deletion forbidden by §6.5 |
| 2 | §7 deep-gates flip condition | "Too restrictive; flip when dispositions are stable and represented commands pass" | §7 split into Y0.2.a + Y0.2.b; flip rule relaxed |
| 3 | §9.4 operator assignment | "Make 白 spot-check mandatory for visual/timing/personal-service surfaces" | §9.4 lists 8 mandatory-白-spot-check surfaces |
| 4 | §14.2 keep X gate during Y0.1 | "Yes, keep until §6.5 successor gate exists" | §14.2 + §6.5 updated to keep X gate |
| 5 | §19 closeout bundle | "Add Y0.1 disposition report, Y-to-Z handoff matrix, evidence checksum manifest, verify-bundle.sh required, verification-final/ required" | §19 expanded from 9 to 15 required deliverables |
| 6 | §3.1 Y0.6 acceptance | "Every row dispositioned; no hard cap" | §3.1 + §10 retained "every row" rule |

### 20.2 Read-only-review disclaimer (codex r1 should-fix #5)

This plan's verification-matrix entries reference commands that codex has NOT run end-to-end as part of the planning review. In particular:

- `npm run test` (full test matrix) — not run in this review.
- Full Ready dev-mode app dogfood — not run; r0/r1/r2 are doc-only.
- `npm run build` — not run.

These are Y0.0 entry-capture responsibilities. Any divergence between expected behavior in this plan and actual behavior at Y0.0 capture becomes a Y entry-state ledger row.

### 20.1b Resolution of codex r2 verdict items

| # | r2 item | r3 resolution |
| ---: | --- | --- |
| MF1 | Y0.7/Y0.8 P0/P1/Stage Z contradiction | §3.1 + §3.2 non-deferrable carve-out + §11.0a/§11.0b P0 scope locks + §11.1/§11.2 renumbered; §13 explicitly excludes Y0.7/Y0.8 from deferrable bucket |
| MF2 | §9.2 spot-check machine-checkable + surface 10 HTTP 402 | §9.2 added `bai_spotcheck` block with 5 required sub-fields + §9.2.3 gate enforces existence + §9.4 lists surface 10 (HTTP 402/429) as mandatory spot-check |
| MF3 | Timestamp/commit validation tightened | §9.2.1 capture-HEAD rule + §9.2.2 strict reproduction-window overlap (50% or ±30s) replace ±5min loose check |
| MF4 | §6.5 conditions machine-checkable | §6.5 added `y0-1-disposition-report-schema.json` (4 rows × 9 fields) + `check-y0-1-disposition-report.cjs` gate |
| MF5 | §9.1 row 13 FastCard expanded | Row 13 now covers translate + describe image + resolve video + overlay command + clipping/content-study (5 sub-flows) |
| SF1 | §6.1 wording correction | "anywhere in the file" replaces "top of first test block" |
| SF2 | §6.2 verify-chain policy + .deferred.cjs reference | §6.2 r3 amplification paragraph |
| SF3 | "16 rows" → "20 rows" stale text | §0 + §4 fixed |
| SF4 | Rows 1/3/5/8/10/11 binary fixed-fixture | All 6 rows rewritten with concrete fixtures and operator paths |
| P2-1 | JSON + sha256sum -c | §19 row 12 emits both `evidence-checksum-manifest.json` + `evidence-checksums.txt` |
| P2-2 | inherits_to_z_phase column | §19 row 11 explicit |
| P2-3 | test:e2e vs verify:f:e2e | §11.5 corrected to use existing `verify:f:e2e` |

### 20.1c Resolution of codex r3 verdict items

| # | r3 item | r4 resolution |
| ---: | --- | --- |
| MF1 | §3.1 Y0.7/Y0.8 acceptance links REVERSED | Swapped: Y0.7 → §11.0b (MCP), Y0.8 → §11.0a (cache quota) |
| MF2 | §6.5 row-count ambiguity (4 or 5 rows) | Chose exactly 4 rows with paired gate_id `check-stage-r-verify-switch+check-stage-t-verify-switch`; ambiguous "either/or" language removed |
| MF3 | §9.2.1 reflog branch not portable | Replaced reflog branch with checksummed `head-capture.txt` artifact (operator runs `git rev-parse HEAD` + `date -u` + `git status --porcelain` count, SHA-256'd into manifest); clean-tree requirement added |
| MF4 | §20.3 Q11 NOT FOUND | Q11 added explicitly (covers §11.0a/§11.0b naming idiomaticity vs renumber-now trade-off) |
| SF1 | bai_spotcheck 14d → 72h | §9.2.3 tightened to 72h with same-build_commit fallback for longer-window spotchecks |
| SF2 | Row 13 5 sub-flow constraint | §9.2.3 requires 5 named `### Sub-flow 13.{a-e}` markers; missing any makes status=pass ineligible |
| SF3 | §9.2.2 50% overlap fallback removed | Kept only ±30s strict overlap |
| SF4 | §4.3 budget for 9 mandatory spotchecks + Y1.2 zero | §4.3 updated: 9 surfaces × 15-30 min = 135-270 min 白-time; Y1.2 row = 0h; total 白-time corrected 2-4h → 5-7h |
| SF5 | §11.2 RESERVED vs §4.3 Y1.2 contradiction | §11.2 RESERVED note expanded to explicitly cross-reference §4.3 zero-budget + §13 exclusion |
| P2-1 | §20.3 Q3 stale "8 of 20 / optional" | §20.3 Q3 rewritten to reflect r3 resolution (9 of 20, mandatory for HTTP 402+429) |
| P2-2 | Rename §11.0a/§11.0b to §11.1/§11.2 | NOT applied per r4 — kept current naming with explicit downstream-reference legend; codex r4 round may challenge this trade-off (see Q11) |

### 20.3 Remaining r3 open questions for codex r3 round

1. **§9.1 row 9 — kill -9 + Cmd-Q + restart**: are all three durable-handle resume scenarios truly contractually required by CLAUDE.md §3 line 49-50, or is only "restart" (clean exit) required? If only restart, the row scope shrinks.
2. **§9.1 row 19 — Obsidian web clip dependency on Y0.1.1**: row 19 lists `obsidian-web-clip-current-tab-ipc.test.ts` as a Y0.1.1 missing_helper file. If Y0.1.1 fix lands first, does that automatically validate row 19's surface? Or does row 19 still need its own live evidence?
3. **§9.4 mandatory-白 list (resolved at r3, cleaned at r4)**: codex r2 ruled YES — HTTP 402 + HTTP 429 paths of surface 10 are mandatory spot-check. Now §9.4 lists 9 mandatory surfaces (2, 3, 7, 10, 13, 16, 17, 18, 19); the r1/r2 framing "8 of 20 / optional but recommended" was retired at r3.
4. **§19 row 11 — Y-to-Z handoff matrix**: is one-row-per-Stage-Y-deliverable the right granularity, or should it be one-row-per-§13 Stage Z phase?
5. **§19 row 12 — evidence checksum manifest format**: JSON-with-SHA-256 is the default. Should it be a `.checksums.txt` file in standard `sha256sum -c` format instead, for tooling compatibility?
6. **§6.5 X gate removal**: r2 forbids outright deletion until 3 conditions are met. Is the "historical proof preserved in `y0-1-disposition-report.md`" condition sufficient, or should the X gate's content be inlined into the new Y successor gate as a comment block?
7. **§11 Y1.x sub-plan timing**: r2 §3 promotes Y1.1 + Y1.2 to P0 (Y0.7 + Y0.8). The other 4 Y1 rows remain P1. Codex r1 didn't object, codex r2 said NO to promoting Y1.5 — accepted. Should any other Y1 row be promoted given r3's tighter dogfood evidence schema?
8. **§9.2.2 reproduction-window 50%-overlap-or-±30s**: is the 50% threshold correct? A 60s reproduction window with 50% overlap means logs that share only 30s with the window pass — is that too generous? Codex should challenge whether ±30s should be the only branch (no 50% fallback).
9. **§9.2 `bai_spotcheck.performed_at` 14-day window**: is 14 days too long? The agent baseline could capture state-X but 白 spot-checks state-X+14d worth of drift. Codex should challenge whether 7 days or even 72 hours is tighter.
10. **§11.0a/§11.0b labeling vs §3 P0 status**: structurally, Y0.7 and Y0.8 are listed in §3.1 P0 rows but their scope locks live in §11. Should the scope locks be inlined into §3.1 instead, or is the §11 placement (mirroring how Y0.1-Y0.6 reference §6/§7/§8/§9/§10 for their scope locks) consistent? (Codex r3 answer: §11 placement is consistent; r3 kept it. r4 preserves.)
11. **§11.0a/§11.0b naming idiomaticity** (codex r3 R2 risk + must-fix #4 — Q11 explicit per codex r3 ruling): codex r3 recommended renaming to standard integer subsections (§11.1 Y0.8, §11.2 Y0.7, shifting old §11.1/§11.2 to §11.3/§11.4) but marked as should-fix not must-fix. r4 kept §11.0a/§11.0b naming with the explicit downstream-reference legend in §11.2 RESERVED to avoid churn through all earlier `§11.1/§11.2` references in committed history. Codex r4 round should confirm or challenge this trade-off (renumber-now vs lock-naming-now).
