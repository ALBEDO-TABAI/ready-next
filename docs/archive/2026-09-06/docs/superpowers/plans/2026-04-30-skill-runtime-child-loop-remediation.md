---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Skill Runtime Child-Loop Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the child-owned long-skill runtime migration so VEA/RSS visual work runs under one durable child-run lifecycle, with no parent-turn forced internal action guessing and no false-green verification.

**Architecture:** Treat long-running skill work as a child-run state machine with one command surface, one status vocabulary, one durable recovery rule, one tool admission path, and one parent-visible summary. `run_state.json` remains VEA's internal recovery truth, `skill_task_runs.resumePayload.childRun` is the parent-visible child handle, and task projections/contracts are read models only.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, Ready skill runtime, VEA embedded skill, RSS visual analyzer, Zod tool schemas, Node/tsx tests, `npm run typecheck`.

---

## 0. Why This Document Exists

The current branch has a child-run shape, but not a completed child-run architecture.

The review found these hard failures:

- `npm run typecheck` fails in `src/main/modules/tools/skills-tools.ts`.
- Real VEA child driver ignores direct `sceneScoresPath` input.
- RSS visual analysis calls `video_expert_ai_analyze` with `sceneScoresPath` only, so the real product path can pause with `missing_inputs`.
- Single-flight can reuse a DB row whose in-memory runner no longer exists.
- Child close events are memory-only for observer APIs.
- Child internal skill actions still bypass unified tool admission.
- Parent steering still tells the model to call typed skill actions when a child run exists.
- Status vocabulary still mixes old supervisor words with new child-run words.
- Existing tests are green because key paths use stubs, not the real VEA driver/product path.

This is not a request for cosmetic cleanup. Do not patch only the visible errors. The deeper issue is that the system still has two long-task models running at once:

```text
old model: parent turn loop resumes long work by choosing another typed skill action
new model: child runner owns long work and parent observes/resumes/cancels the child
```

The remediation is complete only when the old model is demoted to compatibility glue and cannot steer active child work.

## 1. Completion Standard

This task is not complete until all of the following are true:

- [ ] `npm run typecheck` exits 0.
- [ ] Real VEA driver accepts direct `sceneScoresPath` for `video_expert_ai_analyze`.
- [ ] RSS visual path can launch pipeline, find `scene_scores.json`, launch AI scoring through the child runner, and receive a correct close result.
- [ ] A child run with `childRunId` prevents parent steering from selecting a typed VEA action.
- [ ] Child internal skill action execution goes through the same schema/admission/error path as public tool dispatch, or the remaining compatibility exception is explicitly named, isolated, and tested.
- [ ] A persisted `running` child row without an in-memory runner is either resumed or converted to a recoverable non-running state. It is never silently reused as if work is alive.
- [ ] `getCloseEvent` and wait/status APIs can read terminal close events from durable state, not only from `recentCloses`.
- [ ] Cancellation, timeout, launch-stuck, infra crash, blocked, recoverable pause, and business failure map to distinct final meanings.
- [ ] Contract child lookup cannot attach the wrong child when the same session runs the same skill against two different targets.
- [ ] Tests include at least one no-stub product-shaped VEA/RSS path.
- [ ] Docs stop claiming implementation is complete until the above checks pass.

## 2. Root Cause Model

### 2.1 Surface Failures

The obvious failures are type errors, missing input handling, stale close events, and weak tests.

Those are symptoms.

### 2.2 Actual Root Cause

The actual root cause is incomplete ownership migration:

```text
starting a child-run was treated as equivalent to moving long-task ownership into the child
```

That is false. Long-task ownership includes:

- command ownership: who starts, resumes, waits, cancels, and inspects;
- state ownership: which status vocabulary is legal;
- recovery ownership: what happens after process restart, session detach, or missing runner;
- execution ownership: which gateway validates and runs internal actions;
- observation ownership: which source emits progress and close events;
- test ownership: which checks prove real product paths, not just wrapper seams.

The current code moved only part of the command surface. The old parent-turn model still leaks through steering, contracts, tests, and runtime manager shortcuts.

### 2.3 Non-Negotiable Architecture Rule

When `childRunId` exists:

```text
parent code may resume/wait/cancel/status the child
parent code must not choose the next internal VEA action
parent prompts must not encourage the model to call typed skill actions for that child
```

If a code path violates this rule, fix the path. Do not add another guard around the violation.

## 3. Single Long-Task State Machine

Use one vocabulary at boundaries:

```ts
type SkillChildRunStatus =
  | 'queued'
  | 'running'
  | 'recoverable_paused'
  | 'budget_paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'killed'
```

Use one terminal reason vocabulary:

```ts
type SkillChildTerminalReason =
  | 'completed'
  | 'checkpoint_background'
  | 'budget_exhausted'
  | 'blocked_config'
  | 'blocked_external'
  | 'failed_skill'
  | 'infra_error'
  | 'child_process_crashed'
  | 'cancelled_user'
  | 'await_timeout'
  | 'launch_stuck'
  | 'queued_global_concurrency'
  | 'process_restarted'
  | 'nested_child_run_not_supported'
```

Mapping rules:

- User cancel -> `status='killed'`, `terminalReason='cancelled_user'`.
- Await timeout while child may still be alive -> do not mark user cancel. Return observer timeout and keep/recover child state.
- Launch stuck -> `recoverable_paused` if state can be resumed, `failed/infra_error` only if no usable handle exists.
- Business failure from VEA run state -> `failed/failed_skill`.
- Process crash/signal/OOM -> `failed/child_process_crashed` or `failed/infra_error`.
- Config wait -> `blocked/blocked_config`.
- External wait -> `blocked/blocked_external`.
- Completed -> `completed/completed`.

Old supervisor words such as `background_running`, `done`, and `cancelled` may appear only at legacy adapter edges. They must not leak into `SkillTaskSupervisorSnapshot['status']` if that type no longer accepts them.

## 4. File Responsibility Map

### Runtime and State

- `src/main/modules/agent-control/skill-child-run-types.ts`
  - Own child-run status, terminal reason, close event, launch result, payload types.
- `src/main/modules/agent-control/skill-child-run-id.ts`
  - Own typed child-run ids.
- `src/main/modules/agent-control/skill-child-run-log.ts`
  - Own append-only child log path/event writing.
- `src/main/modules/agent-control/skill-child-runner.ts`
  - Own start/resume/cancel/wait loop, active runner map, durable close lookup, stale running reconciliation.
- `src/main/modules/agent-control/video-expert-child-driver.ts`
  - Own VEA stage selection from `run_state.json` plus explicit requested inputs.

### Parent-Facing Read Models

- `src/main/modules/agent-control/run-contracts.ts`
  - Build parent-visible summary only. Must not infer the next VEA internal action when `childRunId` exists.
- `src/main/modules/agent-control/turn-frame-steering.ts`
  - Must suppress typed action hints when a child handle exists.
- `src/main/modules/agent-control/turn-engine.ts`
  - Must route child continuation to child-run APIs, not model-selected typed skill action.
- `src/main/modules/agent-control/task-projection-sync.ts`
  - Projection is a read model. It must not invent child liveness.

### Tool Admission

- `src/main/modules/tools/skills-tools.ts`
  - Public skill tool wrapper, contract patching, compatibility adapter.
- `src/main/modules/tools/tool-executor.ts`
  - Structured tool execution and error contract.
- `src/main/modules/tools/tool-gateway-registry.ts`
  - Unified tool/action definition lookup.
- `src/main/modules/tools/schemas/index.ts`
  - Static schemas.
- Dynamic skill-action schema cache inside `skills-tools.ts`
  - Must be used by child internal calls through the same gateway.

### Product Path

- `src/main/modules/rss-engine/item-analysis-manager.ts`
  - RSS visual path must launch/wait child runs without relying on parent-turn model behavior.

### Tests

- `src/__tests__/skill-child-runner.test.ts`
- `src/__tests__/skill-child-single-flight.test.ts`
- `src/__tests__/skill-child-runtime-decisions.test.ts`
- `src/__tests__/video-expert-child-driver.test.ts`
- `src/__tests__/rss-visual-skill-child-run.test.ts`
- `src/__tests__/skill-child-run-end-to-end.test.ts`
- `src/__tests__/tool-gateway-registry.test.ts`
- `src/__tests__/tool-input-schemas-registry.test.ts`
- Add or modify tests as required below.

## 5. Execution Plan

Work in small commits. Do not mark a task complete until its local verification passes.

### Task 1: Stop The False-Green Baseline

**Files:**

- Modify: `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-baseline-failure-triage.md`
- No production code changes in this task.

- [ ] **Step 1: Record the current blocked checks**

Run:

```bash
npm run typecheck
```

Expected before fixes: FAIL with `skills-tools.ts` status/liveness errors.

- [ ] **Step 2: Update the baseline doc**

Replace any claim that typecheck currently passes. The doc must say this branch is blocked until the status contract is repaired.

- [ ] **Step 3: Commit only the doc correction**

```bash
git add docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-baseline-failure-triage.md
git commit -m "docs: correct child runtime baseline status"
```

### Task 2: Unify Status And Liveness Contracts

**Files:**

- Modify: `src/main/modules/agent-control/skill-child-run-types.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/skill-child-runner.test.ts`
- Test: `src/__tests__/skill-child-runtime-decisions.test.ts`

- [ ] **Step 1: Add failing tests for old status leakage**

Tests must assert:

- `makeSupervisorSnapshotForContract` or its public wrapper produces a snapshot with `liveness`.
- No child-run wrapper returns `background_running`, `done`, or `cancelled` where the type expects child/supervisor status.
- `cancelled` from legacy run state does not become `failed` unless it is explicitly a skill-declared failure.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts
```

Expected before implementation: FAIL on the newly added assertions or typecheck.

- [ ] **Step 3: Fix status mapping minimally**

Implementation constraints:

- Add `liveness` wherever `SkillTaskSupervisorSnapshot` requires it.
- Map legacy detached statuses at adapter edges:
  - `running` -> `running`
  - `done` -> `completed`
  - `cancelled` -> `killed` or a distinct legacy-cancel adapter result, not `failed`
  - `failed` -> `failed`
  - `blocked` -> `blocked`
- Remove or isolate old strings `background_running`, `done`, `cancelled` from typed child/supervisor outputs.
- Do not widen types just to silence TypeScript.

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/skill-child-run-types.ts \
  src/main/modules/tools/skills-tools.ts \
  src/main/modules/agent-control/run-contracts.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts
git commit -m "fix: unify child run status contracts"
```

### Task 3: Make Direct VEA `sceneScoresPath` Real

**Files:**

- Modify: `src/main/modules/agent-control/video-expert-child-driver.ts`
- Modify: `src/main/modules/rss-engine/item-analysis-manager.ts`
- Test: `src/__tests__/video-expert-child-driver.test.ts`
- Test: `src/__tests__/rss-visual-skill-child-run.test.ts`

- [ ] **Step 1: Add a failing real-driver test**

Add a test using the real `videoExpertChildDriver`:

- requested action: `video_expert_ai_analyze`
- requested input: `{ sceneScoresPath, mode: 'api' }`
- no URL
- no pre-existing `run_state.json`

Expected planned action:

```ts
{
  action: 'video_expert_ai_analyze',
  input: {
    sceneScoresPath,
    mode: 'api'
  }
}
```

Expected before fix: FAIL with `missing_inputs`.

- [ ] **Step 2: Add a product-shaped RSS test**

The test must cover `item-analysis-manager.ts` launching `video_expert_ai_analyze` after a pipeline-created `scene_scores.json`.

Do not replace the VEA driver with a behavior stub for this assertion. It is acceptable to fake the expensive skill action executor, but the stage decision must use the real VEA child driver.

- [ ] **Step 3: Implement minimal driver fix**

Rules:

- `planNextAction` must prefer explicit `state.requestedInput.sceneScoresPath` before falling back to `inferSceneScoresPath(parsed, state.outputDir)`.
- If only `sceneScoresPath` is present, derive a usable `outputDir` when possible from the known file location, or carry `outputDir` from the caller if provided.
- Preserve `mode`, thresholds, and existing run-state behavior.
- Do not force a URL for AI scoring.

- [ ] **Step 4: Pass `outputDir` from RSS when available**

In `item-analysis-manager.ts`, when calling `video_expert_ai_analyze`, include the known `outputDir` alongside `sceneScoresPath`.

This is not a substitute for the driver fix. It reduces ambiguity for the product path, but direct `sceneScoresPath` must still work.

- [ ] **Step 5: Verify**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/agent-control/video-expert-child-driver.ts \
  src/main/modules/rss-engine/item-analysis-manager.ts \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts
git commit -m "fix: support direct scene scores child runs"
```

### Task 4: Make Child-Run Recovery Durable

**Files:**

- Modify: `src/main/modules/agent-control/skill-child-runner.ts`
- Modify: `src/main/modules/agent-control/skill-child-run-types.ts`
- Modify if needed: `src/main/modules/agent-control/skill-task-run-repository.ts`
- Test: `src/__tests__/skill-child-single-flight.test.ts`
- Test: `src/__tests__/skill-child-runner.test.ts`
- Test: `src/__tests__/skill-child-run-migration.test.ts`

- [ ] **Step 1: Add failing tests for stale running rows**

Create tests for:

- A `running` child row exists in repository, but `SkillChildRunner.active` does not contain that id.
- `startSkillChildRun` with the same single-flight key must not return `status: 'reused'` unless the runner is actually active.
- The runner should either resume the durable row or mark it `recoverable_paused/process_restarted`.

- [ ] **Step 2: Add failing tests for durable close lookup**

Test:

- Persist a terminal close event in the repository.
- Clear `recentCloses`.
- `getCloseEvent(childRunId)` returns the durable close event.

- [ ] **Step 3: Fix single-flight reuse**

Rules:

- If matching row is active in memory, return `reused`.
- If matching row is terminal with close event, return a terminal result or close summary.
- If matching row is `running` but inactive:
  - resume it when payload and driver allow;
  - otherwise update it to `recoverable_paused/process_restarted`.
- Never claim stale DB work is live only because a row exists.

- [ ] **Step 4: Fix inactive cancel semantics**

Rules:

- Explicit user cancel on inactive persisted row should use the row's real `skillId`, `outputDir`, and `runStatePath`.
- Await timeout is not user cancel.
- Do not synthesize `skillId: 'unknown'` when the repository has the record.

- [ ] **Step 5: Verify**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-run-migration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/agent-control/skill-child-runner.ts \
  src/main/modules/agent-control/skill-child-run-types.ts \
  src/main/modules/agent-control/skill-task-run-repository.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-run-migration.test.ts
git commit -m "fix: make child run recovery durable"
```

### Task 5: Replace Parent Typed-Action Continuation With Child Commands

**Files:**

- Modify: `src/main/modules/agent-control/turn-frame-steering.ts`
- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/skill-child-run-end-to-end.test.ts`
- Test: add or modify a steering test if one exists for `turn-frame-steering.ts`

- [ ] **Step 1: Add failing steering test**

Given a `TurnFrame` / `SkillRunContract` with `childRunId` and no close event:

- `preferredToolNames` must not include `skill_video_expert_*` typed action.
- `requiredToolName` must be null.
- reminder must say parent is waiting/resuming child, not asking the model to pick an internal action.

- [ ] **Step 2: Add failing TurnEngine continuation test**

When a turn resumes a frame with `childRunId`:

- TurnEngine should call `resumeSkillChildRun`, `waitForSkillChildRunClose`, or equivalent child API.
- It should not dispatch `video_expert_pipeline` or `video_expert_ai_analyze` from parent steering.

- [ ] **Step 3: Implement steering suppression**

Rules:

- `shouldPreferTypedAction` must return false when the frame has an active child handle.
- `buildTurnFrameSteering` must produce child-aware reminder text.
- Existing no-child typed action behavior must remain unchanged.

- [ ] **Step 4: Implement child continuation in TurnEngine**

Rules:

- If frame has `childRunId` and no terminal close:
  - route through child runner status/resume/wait API;
  - update frame patch from the child close/progress summary;
  - do not ask the model to choose a typed VEA action.
- If child is already terminal, surface the close event and stop.
- If child is recoverable paused and needs user input, checkpoint cleanly.

- [ ] **Step 5: Verify**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-run-end-to-end.test.ts
```

Expected: PASS and assertions prove no parent typed-action dispatch.

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/agent-control/turn-frame-steering.ts \
  src/main/modules/agent-control/turn-engine.ts \
  src/main/modules/agent-control/run-contracts.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts
git commit -m "fix: route child continuation through child commands"
```

### Task 6: Route Child Internal Actions Through Unified Tool Admission

**Files:**

- Modify: `src/main/modules/agent-control/skill-child-runner.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify if needed: `src/main/modules/tools/tool-gateway-registry.ts`
- Modify if needed: `src/main/modules/tools/tool-executor.ts`
- Test: `src/__tests__/tool-gateway-registry.test.ts`
- Test: `src/__tests__/tool-input-schemas-registry.test.ts`
- Test: `src/__tests__/skill-child-runner.test.ts`

- [ ] **Step 1: Add failing child-internal validation test**

Create a test where the VEA child driver plans an invalid action input.

Expected:

- child internal execution returns the same structured validation error shape as public tool dispatch;
- runtime manager direct `runSkill` is not called for invalid input.

- [ ] **Step 2: Add failing registry parity test**

Assert that the same dynamic skill-action schema is used for:

- public typed skill action;
- legacy compatibility wrapper;
- child internal action.

- [ ] **Step 3: Implement one child action executor**

Create or expose a small function with a name like:

```ts
executeSkillActionViaToolGateway(params)
```

Rules:

- Resolve the action through the same tool/action registry used by public tools.
- Run Zod validation before handler execution.
- Return `ToolExecutionOutput`-compatible structured errors.
- Preserve child-specific metadata: `childRunId`, `scopeId`, `sessionId`, `outputDir`, `runStatePath`.
- Do not let child internal execution recursively launch another child unless explicitly allowed later.

- [ ] **Step 4: Replace direct runtime-manager call**

In `skill-child-runner.ts`, replace direct calls to `runtimeManager.runSkillFromChildRunner` / `runSkill` with the gateway executor.

If a tiny compatibility shim remains, document it in code and test that schemas/errors still match the public path.

- [ ] **Step 5: Verify**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/skill-child-runner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/agent-control/skill-child-runner.ts \
  src/main/modules/tools/skills-tools.ts \
  src/main/modules/tools/tool-gateway-registry.ts \
  src/main/modules/tools/tool-executor.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/skill-child-runner.test.ts
git commit -m "fix: execute child actions through tool gateway"
```

### Task 7: Seed Live Tool Context Before Dependent Tools

**Files:**

- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify if needed: `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- Test: add or modify a focused test for tool runtime context.

- [ ] **Step 1: Add failing context test**

Given a turn frame that already has active artifact roots / run contract handles:

- the first tool call in the next batch must receive those roots/handles in `ToolRuntimeContext`;
- this must work before any same-batch `framePatch` is applied.

- [ ] **Step 2: Pass active frame into context builder**

When TurnEngine builds host tool context, seed it from the current `TurnFrame`, not only same-batch context modifiers.

- [ ] **Step 3: Verify**

Run the new focused context test and any existing frame patch tests:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-tools-frame-patch-delta.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/modules/agent-control/turn-engine.ts \
  src/main/modules/agent-control/tool-runtime-context-builder.ts \
  src/__tests__
git commit -m "fix: seed live tool runtime context"
```

### Task 8: Fix Child Contract Identity Lookup

**Files:**

- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify if needed: `src/main/modules/agent-control/skill-task-run-repository.ts`
- Test: `src/__tests__/skill-child-run-end-to-end.test.ts`
- Test: `src/__tests__/task-projection-sync.test.ts`

- [ ] **Step 1: Add failing multi-child test**

Create two child runs in the same session and same skill:

- child A: `outputDir=/tmp/a`, `runStatePath=/tmp/a/run_state.json`
- child B: `outputDir=/tmp/b`, `runStatePath=/tmp/b/run_state.json`

Load a contract with `outputDir=/tmp/a`.

Expected: contract attaches child A, never child B.

- [ ] **Step 2: Implement exact-first lookup**

Lookup order:

1. explicit `childRunId`;
2. exact `runStatePath`;
3. exact `outputDir`;
4. exact `singleFlightKey`;
5. latest active row by `skillId/session/scope` only as last fallback.

Apply `skillId` before any path similarity or sibling fallback.

- [ ] **Step 3: Verify**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/task-projection-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/modules/agent-control/run-contracts.ts \
  src/main/modules/agent-control/skill-task-run-repository.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/task-projection-sync.test.ts
git commit -m "fix: bind contracts to exact child run identity"
```

### Task 9: Replace Stub-Only Acceptance With Real Path Tests

**Files:**

- Modify: `src/__tests__/skill-child-run-end-to-end.test.ts`
- Modify: `src/__tests__/rss-visual-skill-child-run.test.ts`
- Modify: `src/__tests__/video-expert-child-driver.test.ts`

- [ ] **Step 1: Rename misleading tests**

If a test uses a stub driver, its name and comments must say so. Do not call it "real registry" or "end-to-end" unless the real driver and real registry path are used.

- [ ] **Step 2: Add one real-driver product-path test**

The test must prove:

- RSS visual path obtains `scene_scores.json`;
- child runner asks real VEA child driver for next action;
- planned action is `video_expert_ai_analyze`;
- close/result maps back to RSS without `missing_inputs`.

Fake expensive external process/model calls only after the real driver has made the decision.

- [ ] **Step 3: Verify targeted suite**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-run-id.test.ts \
  src/__tests__/skill-child-run-log.test.ts \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/skill-child-run-migration.test.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/skill-tools-frame-patch-delta.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/skill-runtime-user-acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/video-expert-child-driver.test.ts
git commit -m "test: cover real child runtime product path"
```

### Task 10: Correct Architecture Docs After Code Is True

**Files:**

- Modify: `docs/architecture/skill-child-loop-boundary.md`
- Modify: `docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-architecture.md`
- Modify: `PROGRESS.md` if it currently claims completion.
- Modify: `CHANGELOG.md` only if the branch convention requires it for this change.

- [ ] **Step 1: Remove overclaims**

Docs must not say the child boundary is fully implemented until final verification passes.

- [ ] **Step 2: Add the real boundary statement**

Document:

- parent may start/resume/wait/cancel/status child;
- child owns internal VEA action selection;
- task projection is a read model;
- `run_state.json` is VEA recovery truth;
- child log is audit, not parent decision input.

- [ ] **Step 3: Add verification evidence**

Include the commands from Task 11 and the result date.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/skill-child-loop-boundary.md \
  docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-architecture.md \
  PROGRESS.md CHANGELOG.md
git commit -m "docs: align child runtime architecture with implementation"
```

Only stage files that actually changed.

### Task 11: Final Verification Gate

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Targeted child-runtime suite**

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-run-id.test.ts \
  src/__tests__/skill-child-run-log.test.ts \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/skill-child-run-migration.test.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/skill-tools-frame-patch-delta.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/skill-runtime-user-acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 3: Full relevant verification**

Run the repo's standard verification if time allows:

```bash
npm run verify
```

If this fails because of known unrelated baseline failures, document:

- exact failing test;
- why it is unrelated;
- whether this branch introduced it.

Do not hide the failure.

- [ ] **Step 4: Git status check**

```bash
git status --short
```

Expected:

- only intended files are changed;
- no generated logs, temp files, or accidental output artifacts are staged.

## 6. Things Not To Do

- Do not silence TypeScript by widening status types to `string`.
- Do not keep parent typed-action steering for child-owned work.
- Do not claim a product path works if the test used a stub driver for the important decision.
- Do not treat `await_timeout` as `cancelled_user`.
- Do not treat a DB `running` row as live without an active runner or a successful resume.
- Do not parse child JSONL logs in parent code to choose VEA's next action.
- Do not delete unrelated old code while fixing this route.
- Do not add visible UI controls for this remediation.

## 7. Handoff Summary For The Implementer

The fix is not "make six review comments disappear."

The fix is:

```text
one child-run lifecycle owns long skill work
parent code only commands or observes that lifecycle
all public summaries are read models of that lifecycle
tests prove the real VEA/RSS path, not just wrapper seams
```

Start with status/typecheck because it blocks all reliable verification. Then fix direct `sceneScoresPath` because it is the current product-path break. Then make child-run recovery durable. Only after that remove parent typed-action continuation and tool-admission bypasses; otherwise the system will still have two competing long-task models.
