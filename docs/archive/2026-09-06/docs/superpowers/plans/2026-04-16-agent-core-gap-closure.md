---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Agent Core Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed semantic gaps in the current agent-core refactor so task routing, budgeting, continuation, cancellation, interaction handling, and task projection behavior match the intended design rather than just exposing placeholder contracts.

**Architecture:** Keep the existing `RunCoordinator -> ClaudeSdkOrchestrator -> DirectChatEngine` single-run skeleton. Fix truth ownership inside the current chain instead of adding a new outer loop: task type must drive budget truth, task projection must reflect runtime truth, and suspend/resume/continuation must recover real execution state instead of re-entering via prompt-only hints.

**Tech Stack:** Electron 34, React 19, TypeScript 5, Vite 6, better-sqlite3, existing `agent-control` / `claude-bridge` runtime.

> Execution status (2026-04-16): P0-P3 已完成实现并通过针对性验证；最新结果见 `PROGRESS.md` 与 `CHANGELOG.md`。

---

## Confirmed Gap Checklist

- [ ] **G1. Task budget is seeded before real task type is known.**
  Current code seeds `short_task` budget in `RunCoordinator`, then usually keeps that budget even after `DirectChatEngine` resolves `direct_answer`, `multi_step_task`, `media_task`, or `continuation`.
  Impact: budget UI, convergence prompts, step budget sizing, and long-task limits are often wrong in real runs.

- [ ] **G2. Tool-batch cancellation is not wired into `ExecutionLoopOrchestrator.executeToolCalls`.**
  Current tool batches have no `AbortSignal` input, so already-started groups keep running after the run is cancelled.
  Impact: unreliable cancellation, stale tool results, orphan host activity.

- [ ] **G3. Frozen budget state is recorded but never enforced by the execution loop.**
  `TaskBudgetRuntime.frozen` exists and is set when interaction state becomes `suspended`, but the tool loop never checks it.
  Impact: “paused” is a label, not a real execution stop condition.

- [ ] **G4. Continuation restores only step budget, not full task budget runtime.**
  Current continuation path reads `continuationProjection?.budget?.stepBudget`, but not prior `iterationsUsed`, `toolCallsUsed`, or remaining task headroom.
  Impact: resumed tasks restart consumption almost from scratch and do not inherit prior burn.

- [ ] **G5. Executor routing is not fully enacted in the live runtime.**
  `taskExecutionRoute.executor` can resolve to `skill`, `rss`, `calendar`, or `feishu`, but the main loop mostly falls back to one generic tool loop; only browser and one document-special path have real differentiated behavior today.
  Impact: the routing layer currently overstates what is actually isolated.

- [ ] **G6. Planner steps are generated and displayed, but not actually progressed at runtime.**
  Multi-step tasks emit step lists and initial step budget, but there is no explicit “step completed -> advance next step -> emit updated state” flow.
  Impact: step UI is informative only; it is not execution truth.

- [ ] **G7. Frontend lacks proper suspend/resume/respond interaction control paths.**
  There is no dedicated `agent:suspendRun`, `agent:resumeRun`, or `agent:respondToInteraction` IPC chain, and no end-to-end runtime handlers behind them.
  Impact: users cannot truly pause, resume, or answer pending clarification/confirmation/human-takeover states from structured UI actions.

- [ ] **G8. Generic interaction-state detection coverage is incomplete.**
  Current detection is mainly:
  `skill_*` blocker text parsing,
  browser clarify path,
  browser deterministic partial-result regex for human takeover.
  Generic assistant replies that are clearly asking for clarification or confirmation are not promoted into structured interaction states.
  Impact: tasks stay “running” when they are actually blocked on the user.

- [ ] **G9. Child-task / subtask execution is still entirely missing.**
  There is no parent-child task model in projection, budgeting, orchestration, or result collection.
  Impact: the plan promise of “子任务拆分 + 独立预算 + 结果汇总” is not implemented at all.

- [ ] **G10. No centralized run-scoped resource reaper exists.**
  Cleanup is still ad hoc per tool or per module; there is no common “register cleanup for this run, flush on cancel/fail/timeout” path.
  Impact: cancellation windows can leave behind browser state, skill processes, temp files, or delayed callbacks.

- [ ] **G11. Parallel cap semantics do not match the intended ‘max 5 concurrent tools’.**
  Current budget limits parallel groups, not parallel call count. A single parallel group can still contain an arbitrary number of read-only tools.
  Impact: actual concurrency can exceed the stated safety bound.

- [ ] **G12. `reserveToolCalls` budget hints are currently ignored.**
  Domain orchestrators already emit `reserveToolCalls`, but `applyRunBudgetHint` only changes step iterations.
  Impact: the hint interface is only half-wired and can mislead later callers.

- [ ] **G13. `TaskProjectionStore` is still only a partial runtime truth.**
  It is persisted and useful, but some fields still come from `ScopeRunSummary` and text-derived projection patches rather than first-class runtime writes.
  Impact: projection is good enough for UI fallback, but not yet the full single source of truth promised by the architecture.

## Confirmed Risks To Track, Not Treat As Standalone Functional Gaps

- [ ] `ErrorClassifier` / `RecoveryRouter` live under `claude-bridge/`, not `agent-control/`; docs should stop claiming otherwise.
- [ ] `buildPlannerSteps` is still a template expander, not an adaptive planner. Acceptable for v1 if the limitation is documented explicitly.
- [ ] Parent-child task lookups should use independent DB columns (`parent_task_id`) rather than burying linkage in JSON payloads.
- [ ] Current full test suite still has one unrelated pre-existing failure in the app-icon contract; agent-core verification must avoid conflating that with this plan’s work.

## Delivery Order

- [ ] **P0 Runtime truth**
  Fix G1, G2, G3, G4 first. Without correct budget truth and reliable cancellation, every higher-level feature remains soft.

- [ ] **P1 Execution truth**
  Fix G5, G6, G7, G8 next. This turns task routing, planner steps, and interaction states from display hints into real execution state.

- [ ] **P2 Structural expansion**
  Fix G9, G10, G11, G12 after the runtime truth is stable.

- [ ] **P3 Projection cleanup**
  Fix G13 and doc alignment once the runtime emits richer structured truth directly.

## Task 1: Budget Runtime Realignment

**Files:**
- Modify: `src/main/modules/agent-control/run-coordinator.ts`
- Modify: `src/main/modules/agent-control/run-budget-policy.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/run-coordinator-budget.test.ts`
- Test: `src/__tests__/task-budget-runtime-alignment.test.ts`

- [ ] Add a failing test proving a default scoped run currently starts with `short_task` budget even when the resolved task later becomes `direct_answer`, `multi_step_task`, or `media_task`.

- [ ] Add a failing test proving `reserveToolCalls` hints are currently emitted but ignored.

- [ ] Introduce an explicit way for execution host setup to rebind budget truth after task type resolution:
  `resolvedTaskType -> create correct task budget seed -> preserve compatible usage when applicable`.

- [ ] Update `RunCoordinator` so planning diagnostics no longer permanently lock the run into `short_task` semantics.

- [ ] Update `DirectChatEngine` so task-type resolution can replace a bootstrap budget when that budget came from the generic default path.

- [ ] Teach budget hint application to honor both:
  `maxIterations` for step budget,
  `reserveToolCalls` for remaining tool-call headroom.

- [ ] Ensure `direct_answer` really gets its smaller default budget and `multi_step_task` / `media_task` really get their larger defaults in ordinary `sendScoped` flows.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/run-coordinator-budget.test.ts src/__tests__/task-budget-runtime-alignment.test.ts`

## Task 2: Cancellation And Freeze Plumbing

**Files:**
- Modify: `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/tools/tool-executor.ts`
- Test: `src/__tests__/execution-loop-parallel-tools.test.ts`
- Test: `src/__tests__/execution-loop-cancellation.test.ts`

- [ ] Add failing tests for:
  cancelled serial batch stops before the next tool,
  cancelled parallel batch does not start a new batch,
  frozen runtime does not continue consuming iteration budget.

- [ ] Extend `ExecutionLoopOrchestrator.executeToolCalls` to accept `signal?: AbortSignal`.

- [ ] Check `signal.aborted` before each serial tool execution and before starting each parallel batch.

- [ ] Ensure tool-loop callers in `DirectChatEngine` pass the run abort signal in all three execution paths.

- [ ] Decide the freeze rule and implement it consistently:
  either short-circuit at loop start when `taskBudgetRuntime.frozen`,
  or teach `consumeIterationBudget` / loop control to no-op under frozen runtime.

- [ ] Preserve current behavior for non-cancelled runs and keep timeout recovery behavior unchanged.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/execution-loop-cancellation.test.ts`

## Task 3: Continuation Budget Recovery

**Files:**
- Modify: `src/main/modules/agent-control/task-execution-router.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/run-budget-policy.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/task-continuation-budget.test.ts`

- [ ] Add a failing test proving continuation currently restores only `stepBudget`, not prior `iterationsUsed` / `toolCallsUsed`.

- [ ] Define continuation restore policy:
  restore prior budget seed,
  restore prior usage,
  recompute remaining task headroom,
  apply a minimum safety floor when remaining headroom is nearly exhausted.

- [ ] Update continuation route construction so it carries recoverable budget runtime, not only step metadata.

- [ ] Update `DirectChatEngine` to rebuild `TaskBudgetRuntime` from projection truth for continuation runs before entering the next loop.

- [ ] Emit diagnostics that clearly distinguish:
  inherited budget,
  restored usage,
  safety floor grants, if any.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/task-continuation-budget.test.ts`

## Task 4: Make Executor Routing Real

**Files:**
- Modify: `src/main/modules/agent-control/task-type-resolver.ts`
- Modify: `src/main/modules/agent-control/task-execution-router.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/host-capability-dispatcher.ts`
- Test: `src/__tests__/task-type-resolver.test.ts`
- Test: `src/__tests__/task-execution-router.test.ts`
- Test: `src/__tests__/direct-chat-executor-routing.test.ts`

- [ ] Add failing integration-style tests showing that `executor: 'skill' | 'rss' | 'calendar' | 'feishu'` currently still falls through the generic loop.

- [ ] Decide the first real executor matrix:
  browser,
  document,
  skill,
  lightweight rss/calendar/feishu path,
  generic tool loop,
  continuation restore path.

- [ ] Implement explicit runtime handling for skill / rss / calendar / feishu executors instead of only tagging them in route objects.

- [ ] Keep browser and existing document-special path behavior intact while moving the rest onto real branches.

- [ ] Ensure degraded environments still set clear `degradationReason` rather than silently dropping back into “best effort”.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/direct-chat-executor-routing.test.ts`

## Task 5: Step Progression For Multi-Step Tasks

**Files:**
- Modify: `src/main/modules/agent-control/task-execution-router.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Test: `src/__tests__/task-step-progression.test.ts`

- [ ] Add failing tests showing that planner steps are emitted once but never advanced.

- [ ] Define explicit step progression triggers for v1:
  current-step budget exhaustion,
  explicit model completion cue,
  deterministic domain executor completion,
  child-task completion when Task 7 lands.

- [ ] Add runtime state for:
  current planned step index,
  per-step summary/output,
  step completion timestamps.

- [ ] When a step advances:
  mark prior step done or blocked,
  update `currentStepId`,
  allocate next step budget,
  emit updated structured task payload.

- [ ] Record per-step output summaries so continuation and task panel can resume with more than a flat blocked reason.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/task-step-progression.test.ts`

## Task 6: Interaction-State Detection And Run Control IPC

**Files:**
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/main/modules/claude-bridge/ipc-handler.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/ready/TaskPanel.tsx`
- Modify: `src/renderer/components/agent/ChatPanel.tsx`
- Test: `src/__tests__/interaction-state-detection.test.ts`
- Test: `src/__tests__/task-run-control-ipc.test.ts`

- [ ] Add failing tests for generic assistant replies that clearly ask:
  for clarification,
  for confirmation,
  for human takeover completion.

- [ ] Introduce a lightweight generic interaction detector for non-tool replies.
  First version may stay heuristic if it is deterministic and well-scoped.

- [ ] Add runtime endpoints for:
  suspend run,
  resume run,
  submit interaction response.

- [ ] Add matching IPC handlers, preload bridge, and renderer types.

- [ ] Update TaskPanel / ChatPanel to expose the new actions only when the current projection state supports them.

- [ ] Ensure suspend uses the same runtime truth as cancellation/freeze work from Task 2.

- [ ] Ensure resume routes through continuation restoration instead of creating a fresh unrelated run.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/interaction-state-detection.test.ts src/__tests__/task-run-control-ipc.test.ts`

## Task 7: Child-Task Scaffolding

**Files:**
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/main/modules/agent-control/run-coordinator.ts`
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Modify: `src/main/modules/repositories/task-projection-repository.ts`
- Modify: `src/main/modules/migrations.ts`
- Test: `src/__tests__/task-projection-repository.test.ts`
- Test: `src/__tests__/task-subtask-runtime.test.ts`

- [ ] Add failing tests proving there is currently no parent-child task linkage in projection persistence.

- [ ] Extend task projection schema with:
  `parentTaskId`,
  child-task lookup support.

- [ ] Add a migration that introduces `parent_task_id` and any supporting index needed for child lookup.

- [ ] Define minimal v1 child-task contract:
  child task has its own `taskId`,
  own budget runtime,
  parent step reference,
  completion summary,
  artifact summary backflow.

- [ ] Teach `RunCoordinator` to start child tasks through the existing execution host without creating a second outer runtime loop.

- [ ] When a child task finishes, project its summary/artifacts back into the parent step state.

- [ ] Keep v1 intentionally non-autonomous:
  no free-form sub-agents,
  only controlled decomposition under the existing coordinator.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/task-projection-repository.test.ts src/__tests__/task-subtask-runtime.test.ts`

## Task 8: Run-Scoped Resource Reaper

**Files:**
- Modify: `src/main/modules/agent-control/orchestrator.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: selected tool/runtime files that allocate external resources
- Test: `src/__tests__/run-resource-reaper.test.ts`

- [ ] Add a failing test for run cancellation that leaves registered cleanup callbacks uninvoked.

- [ ] Create a run-scoped cleanup registry with:
  register cleanup callback,
  drain on cancel/error/timeout,
  bounded wait with timeout fallback.

- [ ] Thread run identity into places that create long-lived resources so they can register cleanup work.

- [ ] Keep cleanup idempotent so repeated cancel/error paths are safe.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/run-resource-reaper.test.ts`

## Task 9: Parallel Cap Semantics And Projection Truth Cleanup

**Files:**
- Modify: `src/main/modules/agent-control/tool-parallelism-policy.ts`
- Modify: `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Modify: `src/main/modules/agent-control/run-projection.ts`
- Modify: `src/renderer/components/ready/TaskPanel.tsx`
- Modify: `src/renderer/components/agent/ChatPanel.tsx`
- Test: `src/__tests__/execution-loop-parallel-tools.test.ts`
- Test: `src/__tests__/task-projection-sync.test.ts`
- Test: `src/__tests__/chat-task-projection-contract.test.ts`

- [ ] Add a failing test proving one “parallel” group can currently exceed the intended max concurrent tool count.

- [ ] Cap actual concurrent tool execution per batch, not just number of parallel groups used so far.

- [ ] Reduce text-derived projection patching where equivalent structured fields already exist from runtime payloads.

- [ ] Preserve text parsing only as fallback for legacy/older paths, not as preferred truth.

- [ ] Update TaskPanel / ChatPanel consumption rules so projection-first rendering becomes explicit where data is available.

- [ ] Run targeted verification:
  `npx tsx --test src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/task-projection-sync.test.ts src/__tests__/chat-task-projection-contract.test.ts`

## Task 10: Docs And Regression Signoff

**Files:**
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`
- Modify: `DOCUMENTATION.md`
- Modify: `FEATURE_MODULE_MAP.md`
- Modify: `DEPENDENCY_MAP.md`
- Modify: `LESSONS_LEARNED.md` (only if new operational lessons appear)

- [ ] Update docs so they stop claiming already-finished support for features that still only exist as contracts or placeholders.

- [ ] Document the actual v1 rules for:
  continuation budget inheritance,
  step progression,
  interaction detection,
  child-task scope,
  parallel cap semantics.

- [ ] Run final project verification for this stream:
  `npm run typecheck`
  `npx tsx --test src/__tests__/run-coordinator-budget.test.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/task-type-resolver.test.ts src/__tests__/task-execution-router.test.ts src/__tests__/task-projection-sync.test.ts`

- [ ] Run broader verification once implementation lands, while separately noting the existing unrelated app-icon contract failure if it still reproduces.

## Suggested Execution Batches

- [ ] **Batch A:** Task 1 + Task 2 + targeted tests
- [ ] **Batch B:** Task 3 + Task 4 + targeted tests
- [ ] **Batch C:** Task 5 + Task 6 + targeted tests
- [ ] **Batch D:** Task 7 + Task 8 + targeted tests
- [ ] **Batch E:** Task 9 + Task 10 + final verification

## Out Of Scope For This Closure

- [ ] Replacing the entire `DirectChatEngine` skeleton with a brand-new outer planner loop
- [ ] Autonomous sub-agents outside the current coordinator
- [ ] Rewriting intent classification from scratch
- [ ] Rebuilding the browser or skill runtimes from first principles
- [ ] UI redesign unrelated to new task control surfaces

## Completion Criteria

- [ ] A default run uses the correct budget preset for its resolved task type.
- [ ] Cancelling a run stops future tool work and triggers registered cleanup.
- [ ] Suspending a run actually freezes execution instead of only changing a label.
- [ ] Continuation resumes with inherited budget/usage truth, not a fresh short-task budget.
- [ ] Skill/rss/calendar/feishu routes have real runtime differences where the plan claims they do.
- [ ] Multi-step tasks visibly and structurally advance between steps.
- [ ] Users can suspend, resume, and answer pending interaction states through structured UI actions.
- [ ] Child tasks can be created, tracked, budgeted, and summarized back into a parent task.
- [ ] Parallel execution respects a real max-concurrency ceiling.
- [ ] Task projection is primarily runtime-driven and reliable after refresh/reopen.
