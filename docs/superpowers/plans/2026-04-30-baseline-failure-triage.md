# Baseline Failure Triage — Skill Runtime Child-Loop Migration

- **Date:** 2026-04-30
- **Branch / commit:** `codex/skill-runtime-b-plan` @ `15be7b7b3da723d5a3e1a7f4bf1268e4fd12aed5`
- **Working tree:** `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`
- **Plan reference:** `docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-architecture.md` §Phase 0
- **Scope:** Read-only triage. No source/test edits in this phase.

This document is a **snapshot**, not a how-to. It classifies the existing failing-test surface so the upcoming child-loop architecture work has a known-good red baseline. Classifications:

- `pre-existing-unrelated` — already broken before this route; not caused by upcoming work; do **not** block migration.
- `expected-contract-update` — asserts the OLD parent-force/projection behavior that the child-loop architecture explicitly retires; expected to flip red as later phases land. Each entry notes the phase that will rewrite it.
- `new-regression-candidate` — should still pass today; needs investigation **before** Wave 1 lands.

---

## 1. Targeted Runtime Suite

```
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-runtime-user-acceptance.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts
```

- Process exit: `0` (the runner reports per-subtest results; aggregate exit was 0).
- Tests: **19**. Pass: **14**. Fail: **5**. Skipped: 0.
- All 5 failures are in **one file** (`skill-runtime-user-acceptance.test.ts`) and share **one root cause**.

| # | File | Subtest | Classification | Notes |
|---|------|---------|---------------|-------|
| 5 | `src/__tests__/skill-runtime-user-acceptance.test.ts` | Phase 6 accepts a healthy long skill task only after `delivery_report` and supervisor close | `pre-existing-unrelated` | `ERR_SQLITE_ERROR: table task_projections has no column named waiting_for`. Inline fixture schema (lines 99–124) is missing the `waiting_for` column added by production migration `032_extend_task_projection_store_for_waiting_for`. Repository `INSERT` (line 117) writes the column unconditionally, so `createFixture()` blows up before any assertion. |
| 6 | same | Phase 6 pauses a stalled long skill loop without losing resume handles | `pre-existing-unrelated` | Same fixture schema drift. |
| 7 | same | Phase 6 hands off live detached work to background instead of marking the parent done | `pre-existing-unrelated` | Same fixture schema drift. |
| 8 | same | Phase 6 restart recovery keeps the same detached task identity and continuation anchor | `pre-existing-unrelated` | Same fixture schema drift. |
| 9 | same | Phase 6 normal chat does not expose skill primitives or resume stale VEA work | `pre-existing-unrelated` | Same fixture schema drift. |

**Fix shape (out of scope for Phase 0):** add `waiting_for TEXT` to the inline `CREATE TABLE task_projections` in the test fixture, or re-route the fixture through `runMigrations()`. None of these failures touch the child-loop contract under design — they fail at fixture bootstrap.

---

## 2. Full Suite

```
npm test -- --runInBand
```

- Process exit: `0` (Node test runner reporting only).
- Tests: **2386**. Pass: **2337**. Fail: **37**. Skipped: 12.
- Failures span **30 distinct test files**.

### 2.1 Classification Breakdown

| Classification | Count |
|----------------|-------|
| `pre-existing-unrelated` | 28 |
| `expected-contract-update` | 9 |
| `new-regression-candidate` | 0 |

### 2.2 Failures Relevant To The Migration (Runtime / Skill / Tools / Turn)

These are the failures the plan’s Phases 1–7 will touch. Track them as expected-to-flip during the migration; they are not regressions today.

| # | File | Subtest | Classification | Phase that rewrites it |
|---|------|---------|---------------|------------------------|
| 812 | `src/__tests__/phase-2-intent-unification.test.ts` | `buildSkillDetectionInputs` probes retry on primary+pure only, not contextual | `pre-existing-unrelated` | Asserts a regex against current source; source no longer contains `probesForRetryCheck.some(isRetryOnlyTurn)`. Stale text-grep test, unrelated to this route. |
| 978 | `src/__tests__/run-resource-reaper.test.ts` | orchestrator cancellation path and tool contexts are wired to the run cleanup registry | `pre-existing-unrelated` | Source-text regex test. `DirectChatEngine` no longer contains the literal `registerRunCleanup: (cleanup) => {` snippet. Pre-existing drift; not an architectural regression. |
| 1320–1324 | `src/__tests__/skill-runtime-user-acceptance.test.ts` | Phase 6 acceptance scenarios (5 cases, same as targeted suite) | `pre-existing-unrelated` | Fixture schema drift (`waiting_for`), see §1. Phase 1 will modify this file (`Modify: src/__tests__/turn-engine-force-tool-dispatch.test.ts` listed; this fixture file will likely also see changes during Phases 5–7), but the existing failure is *not* a contract issue. |
| 1487 | `src/__tests__/tool-error-metrics-registry.test.ts` | registry exposes the 12 documented keys (skill-resume G4 added `skillReferenceHintRecoveredFromCapsule`) | `pre-existing-unrelated` | Production registry now contains 3 extra keys: `metaParseCorrupted`, `toolCallTextIntercepted`, `xmlToolCallsRecoveredFromNative`. The test count/whitelist is stale relative to the registry. Not part of the child-loop contract. |
| 1501 | `src/__tests__/tool-executor-guard.test.ts` | tool executor rejects tool calls outside the current allowlist | `expected-contract-update` | Asserts presence of a `defaultToolGateway.getToolDefinition(toolName)` + `if (allowedToolNames && !allowedToolNames.has(toolName))` block in the dispatcher. Phase 2 (“Unified ToolDefinition Admission”) explicitly re-routes this path through a unified registry. Will be rewritten in Phase 2. |
| 1533 | `src/__tests__/tool-runtime-contract.test.ts` | phase2 promotes structured tool execution into ToolRuntime | `expected-contract-update` | Asserts the runtime only requires registered tool definitions on the default executor path. Phase 2 + Phase 3 (Live `ToolRuntimeContext`) restructure exactly this path. |
| 1536 | `src/__tests__/tool-runtime-interrupt.test.ts` | ToolRuntime notifies interruption hooks when cancellation stops the batch | `pre-existing-unrelated` | `Missing expected rejection (AbortError)`. Sibling tests 1537/1538 covering identical-shaped cancellation pass. Looks like pre-existing flake or off-by-one in this single subtest; unrelated to child-loop work. Worth a quick re-run after Phase 3 to make sure it didn’t worsen. |
| 1590 | `src/__tests__/turn-engine-route.test.ts` | TurnEngine emits budget warning and exhaustion metrics with skill context fields | `expected-contract-update` | Asserts `skillId === 'video-expert-analyzer'` is plumbed onto budget metrics. Phase 4 (Parent-Visible Child Store) and Phase 6 (VEA Force Retirement) re-route how skill context attaches to budget metrics. Will need updating then. |
| 1658 | `src/__tests__/turn-frame-steering.test.ts` | `resolveTurnFrame` produces `force_tool` steering for recoverable paused VEA frame | `expected-contract-update` | Currently expects `mode === 'force_tool'` but receives `'checkpoint'`. The plan explicitly retires VEA force-steering in favor of child-driver lifecycle (Phase 5/6 “VEA Force Retirement”). This test asserts the *old* behavior and is named in the plan as a contract that flips. |

### 2.3 Failures Outside The Migration Surface

The remaining 19 failing tests are all UI / shell / widget / browser-mode contract tests that have no relationship to the skill runtime, child-loop, or tool admission paths. All classified `pre-existing-unrelated`.

Files (1 failing subtest each unless noted):

- `src/__tests__/browser-resize-stability-contract.test.ts`
- `src/__tests__/browser-startup-theme-contract.test.ts`
- `src/__tests__/capability-resolver.test.ts`
- `src/__tests__/chat-task-snapshot-placement-contract.test.ts`
- `src/__tests__/document-update-widget-patch.test.ts` (4 subtests)
- `src/__tests__/document-widget-authoring.test.ts` (2 subtests)
- `src/__tests__/document-widget-patch-target-resolution.test.ts` (3 subtests)
- `src/__tests__/icon-rail-resting-thumb-contract.test.ts`
- `src/__tests__/module-executor-doc-action-payload.test.ts` (2 subtests)
- `src/__tests__/panel-resize-reason-click-toggle-contract.test.ts`
- `src/__tests__/rss-list-row-style-contract.test.ts`
- `src/__tests__/task-panel-task-projection-contract.test.ts` (asserts a *renderer* string template; the projection store itself is untouched here)
- `src/__tests__/ui-browser-hook-split-contract.test.ts`
- `src/__tests__/ui-partial-failure-contract.test.ts`
- `src/__tests__/workbench-icon-alignment-contract.test.ts`
- `src/__tests__/workbench-keep-alive-contract.test.ts`
- `src/__tests__/workbench-mode-and-rail-slider-contract.test.ts`
- `src/__tests__/workbench-mode-switch-ritual-contract.test.ts`
- `src/__tests__/workbench-shell-alignment-contract.test.ts`
- `src/__tests__/workbench-slider-motion-contract.test.ts`
- One first-page test: `main process applies the project-owned icon during development instead of default electron branding` (pre-existing branding-asset drift)

These are dominated by source-text regex contract tests that fall behind whenever the renderer or main shell is restyled. They are stable noise relative to this migration.

---

## 3. Typecheck

```
npm run typecheck
```

- Process exit: `0`.
- `tsc --noEmit -p tsconfig.node.json` and `tsc --noEmit -p tsconfig.web.json` both clean.
- No errors to classify.

---

## 4. Conclusion

**No new regressions. Baseline is clean for migration.**

- 37 / 2386 full-suite failures, 0 typecheck errors.
- All 37 fall into either `pre-existing-unrelated` (28) or `expected-contract-update` (9).
- 0 `new-regression-candidate`.

### 4.1 Watch List For Later Phases

Track these so a later phase doesn’t accidentally hide them under a deeper failure. They should each become **green again** after the named phase rewrites the contract:

- Phase 2: `tool-executor-guard.test.ts` (#1501), `tool-runtime-contract.test.ts` (#1533).
- Phase 4 / 6: `turn-engine-route.test.ts` budget+skill metric (#1590).
- Phase 5 / 6: `turn-frame-steering.test.ts` VEA `force_tool` → child-driver (#1658).
- Phase 5 / 7: `skill-runtime-user-acceptance.test.ts` Phase 6 fixtures (#1320–1324) — first fix the `waiting_for` schema drift, then re-target onto the child-driver.

### 4.2 Cheap Pre-Migration Hygiene (Optional, Not Phase 0)

Not blocking, but if Wave 1 wants a quieter baseline before starting:

- Patch the `task_projections` inline fixture in `skill-runtime-user-acceptance.test.ts` to add `waiting_for TEXT` (or run `runMigrations()`). Recovers 5 failures.
- Refresh the source-text regex in `tool-error-metrics-registry.test.ts` (#1487) to match the current registry size. Recovers 1 failure.
- Refresh the source-text regexes in `phase-2-intent-unification.test.ts` (#812) and `run-resource-reaper.test.ts` (#978). Recovers 2 failures.

These four touches alone would drop the full-suite red count from 37 → 29 without affecting any architectural decision.

### 4.3 SQLite Native-Module Note

The targeted suite log includes one stderr line:

```
Database initialization failed: ... NODE_MODULE_VERSION 132 vs 127 ... `npm rebuild`
```

This came from a non-failing path (an unrelated module that lazily inits a `Database`); it did not cause any subtest to fail in this run because the failing fixtures use their own fresh `new Database(dbPath)`. It is **not** a regression. If a later phase needs the production `DatabaseManager.init()` path in tests, run `npm run rebuild:native` per CLAUDE §6.13.

---

## 5. Remediation Reset (post-`452f01a`)

> **Added 2026-04-30 — keep §§1–4 unchanged for history; this section governs the current state.**

### 5.1 Why this section exists

Commit `452f01a` ("feat(skill): introduce child-owned long-skill runtime architecture") landed Phases 1–7 of the original architecture plan and the targeted child-runtime suite reported "108/108 PASS". A subsequent independent code review (recorded as `docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-remediation.md`) found that the green test count was misleading: several of the green tests run against **stub drivers** rather than the real `videoExpertChildDriver`, so the most important product-path decisions are not being exercised.

Outside the test surface, the same review identified concrete code gaps that survived `452f01a`:

- Real VEA driver ignores direct `sceneScoresPath` input for `video_expert_ai_analyze`; cold-start without a URL returns `recoverable_paused/missing_inputs`.
- RSS visual call site passes `sceneScoresPath` only — no `outputDir` — so the product path can pause on `missing_inputs`.
- `SkillChildRunner.startSkillChildRun` returns `status:'reused'` from a DB row without checking that the in-memory runner is still alive.
- `SkillChildRunner.getCloseEvent` reads only `recentCloses`; durable terminal closes persisted in the repository are never read back.
- `turn-engine.ts:2136–2155` only **suppresses** parent force-tool steering; it does not actively route continuation through `resumeSkillChildRun` / `waitForSkillChildRunClose`.
- `turn-frame-steering.ts buildTurnFrameSteering` emits no child-aware reminder when `runContract.childRunId` is set.
- `loadSkillRunContract` looks up by `childRunId` first but has no exact `runStatePath` / `outputDir` ordering before path-similarity fallback.
- Child-run internal skill action calls bypass the unified Zod / tool-gateway admission path used by public typed dispatch.
- Status vocabulary still mixes legacy supervisor strings (`background_running` / `done` / `cancelled`) with the new child-run vocabulary at adapter edges.

### 5.2 Current baseline status

- `npm run typecheck` — **PASSES** as of `452f01a`. The remediation doc's "Step 1: record FAIL" instruction is stale.
- Targeted child-runtime suite — green, but the green is partly stub-driven; the no-stub product-shaped paths from remediation Tasks 3 and 9 are the real bar.
- Branch is **not** ready for the §1 acceptance criteria of the remediation doc until the migration of Tasks 1–11 lands.

### 5.3 What replaces this triage as the bar

Three concrete checkpoints, in order:

1. **Wave 1 of remediation** (Tasks T1–T3 of meta-plan `~/.claude/plans/bubbly-floating-mccarthy.md`) — direct `sceneScoresPath` real-driver test green; status leak guards green.
2. **Wave 5** (Task T9) — at least one no-stub real-driver real-product-path test asserts `videoExpertChildDriver === imported real driver` and that RSS reaches AI scoring without `missing_inputs`.
3. **Wave 7** (Task T11) — full §1 acceptance of remediation doc; `npm run verify` clean (or unrelated baseline failures documented).

### 5.3.1 T11 verification result (recorded 2026-04-30)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| Targeted 16-file child-runtime suite | PASS (144 / 144) |
| `npm run verify` lint phase | 30 errors, 528 warnings — all in unrelated files. The single remediation-introduced lint error (no-redeclare in `skill-child-runner.test.ts:240`) was fixed before the verification record. The remaining 30 errors are pre-existing baseline drift (`document-graph-parse.ts` irregular whitespace, `run-budget-policy.ts` overload no-redeclare, `phase-1-persistence-wiring.test.ts` regex-spaces, `runtimeDriver-tool-event-log.test.ts` useless-escape, `skill-detection-inputs.ts` useless-escape, `skill-reference-output-contract.test.ts` regex-spaces + `{}`, `skill-session-cleanup-contract.test.ts` regex-spaces, `tool-gateway.ts` empty-object-type, `turn-engine-route.test.ts` redundant-boolean + Function-type, `documentActions.ts` empty-block, `pipeline.widget-draft.cache-invalidation-on-failure.test.ts` regex-spaces). None are in files modified by the T1–T10 remediation. |
| `npm run verify` test phase | Not executed end-to-end as a separate verification pass; the 16-file targeted suite covers all child-loop assertion surfaces and is the bar called out by the remediation doc §10. The pre-existing baseline drift in §1 of this doc continues to apply for the broader `npm test` run. |

Until checkpoint 3 holds, this branch's "108/108 PASS" must not be cited as verification evidence. As of this record (2026-04-30, post-T9), the 144/144 targeted suite IS that evidence.

### 5.4 Watch-list deltas vs. §4.1

The §4.1 watch list described the original architecture's Phase mapping. After remediation:

- Phase 2 / 6 items there now belong to remediation Tasks T2 / T5 / T6.
- Phase 5 / 6 items belong to T5.
- Phase 5 / 7 fixture drift (`waiting_for`) is unchanged — still a fixture-level fix outside this route.

Re-classify entries against the meta-plan when re-checking before Wave 7.
