# Skill Runtime Long Task Supervisor and Dynamic Budget Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long skill tasks continue when they are making real progress, pause safely when they are wasting work, and recover from the durable skill task fact source instead of transient task cards.

**Architecture:** This plan separates three lifecycles that are currently collapsed: agent turn, tool step, and skill task. It introduces a lightweight task supervisor, progress/waste scoring, and budget lease renewal while keeping the existing B-plan skill primitives and not restoring the old `skill_executions` state machine.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, React renderer task cards, embedded Python skills, VEA `run_state.json`/`delivery_report.json`.

---

## 0. Relationship To The Previous B And C Plans

This work is still on the B-plan branch, but it is already moving toward the C direction.

The original B plan modernized Skill Runtime from "workflow state machine" to "markdown skill + gated primitives + task projection." That part is still valid. The current VEA failures show that B also needs one extra layer before it can be a reliable bridge to C: a general long-task supervisor and dynamic budget loop.

The previous C plan says Ready should eventually have one generic agent loop instead of multiple domain-specific loops. Dynamic budget, progress scoring, waste scoring, background handoff, and task lifecycle separation are all C-shaped capabilities. The difference is scope: this plan proves them first inside Skill Runtime, where the blast radius is smaller and the evidence is concrete.

In short:

- B remains the local delivery track.
- This plan is B's long-task reliability layer.
- The design patterns here should later be promoted into C's generic agent loop.

## 1. Completion Standard

This phase is complete only when these five conditions are true:

1. Budget exhaustion never marks an active skill task as completed.
2. A live background skill task remains recoverable after the agent turn ends and after app restart.
3. VEA progress is visible to Ready through `current_stage`, scene counts, coverage, output directory, and heartbeat timestamps.
4. Repeated reads of unchanged state reduce or stop budget renewal instead of being rewarded.
5. The UI can clearly distinguish done, failed, waiting for user, budget paused, and background running.

## 2. Phase Map

| Phase | Name | Purpose | Depends On | Main Verification |
| --- | --- | --- | --- | --- |
| 0 | Baseline And Red Tests | Freeze the current failure modes before changing behavior | Current branch state | New failing tests reproduce budget pause, stale run_state, shell monitor overwrite |
| 1 | VEA Progress Contract | Make Ready able to read real VEA progress | Phase 0 | Inspect returns stage, scene counts, coverage, active output dir |
| 2 | Skill Task Supervisor | Add one owner that decides whether a skill task is alive/progressing | Phase 1 | Supervisor picks active detached task over stale projection/shell result |
| 3 | Lifecycle Separation | Stop turn/tool statuses from overwriting skill task status | Phase 2 | Budget-exhausted turn becomes paused/background, not done |
| 4 | Dynamic Budget Lease | Renew budget when progressing, pause when wasting | Phase 2 and 3 | 200-step progressing task continues; 20-step stalled loop pauses |
| 5 | UI And Continuation Semantics | Express paused/background states and restore them correctly | Phase 3 | Task card shows correct state and buttons; continue returns to same task |
| 6 | Simulated User Acceptance | Exercise the full user path without waiting for manual screenshots | Phase 4 and 5 | CLI/UI harness confirms logs, SQLite, detached JSON, and projection agree |
| 7 | Baseline Cleanup And Documentation | Make the branch reviewable and prepare the next split plan | All previous | Skill tests/typecheck pass or non-skill failures are listed separately |

## 2.1 Current Audit Snapshot Before Phase 3

This plan is being refined against the current `codex/skill-runtime-b-plan` worktree state, not a clean baseline.

- The worktree already contains mixed tests and implementation for parts of Phase 0-2. Do not claim Phase 0 was completed as a pure red-test phase unless the implementing agent records the original failing behavior.
- Phase 1 is partly implemented on the Ready side: richer `run_state` fields, `expectedTaskId`, detached task id fallback, and ambiguity results exist. The remaining risk is selection precedence: a root-level `run_state.json` must not bypass `expectedTaskId` when it belongs to another task.
- VEA `run_state.py` already defines `schema_version`, `task_id`, `pid`, `started_at`, `active_output_dir`, stage, scene counts, coverage, and heartbeat timestamps. The plan should verify those fields through real entry points instead of asking to recreate them.
- Phase 2 has a `skill-task-supervisor.ts` draft and tests, but it is not yet wired into `turn-engine`, `run-coordinator`, `session-continuity`, or the tool-result close path. Treat it as a read-only supervisor contract until Phase 3 connects it.
- Phase 3 has partial guard rails in `run-coordinator.ts` and renderer card normalization, but the main lifecycle split is still missing: budget exhaustion still falls through toward a done turn, primitive monitor success can still flatten projection state, and session continuity still stores skill runs mostly as `success: boolean`.

## 2.2 Phase 3 Assumptions And Completion Standard

Phase 3 must be surgical. It should prevent false completion and preserve recovery, but it should not implement dynamic lease renewal yet.

**Chosen state mapping for Phase 3:**

- Do not add new database status enum values in Phase 3.
- Keep `skill_task_runs.status` within the existing set: `queued | running | blocked | done | failed | cancelled`.
- Treat supervisor-only states such as `background_running` and `budget_paused` as observation/lifecycle states, then project them through existing UI fields:
  - `phase: checkpoint`
  - `interactionState: suspended`
  - `waitingFor: background`
  - `resumableActions: ["continue", "cancel"]` or `["continue", "retry", "cancel"]` when retry is meaningful
  - `blockedReason` / `taskContinuation` carrying `pauseReason`, `detachedTaskId`, `taskRunId`, `runStatePath`, and `outputDir`
- A task may become `done` only when the supervisor says `closeAllowed === true`, or when there is no skill task snapshot relevant to the turn.
- Do not treat an empty supervisor result as relevant work. A snapshot is relevant only if at least one durable handle exists: `taskRunId`, `detachedTaskId`, `skillId`, `runStatePath`, `outputDir`, or `resumePayload`. `status: "unknown" + closeAllowed: false` by itself must not block ordinary chat or non-skill turns.
- `background_running` means live work or recent progress exists. `budget_paused` means the turn stopped because of budget, no live process/recent progress is visible, but the task has a durable resume handle and should not be marked done.

**Phase 3 is complete only when:**

- The real budget-exhausted path asks the supervisor before returning final state.
- Live or recently progressing skill work ends the agent turn as checkpoint/background, not done.
- Primitive monitor success appends a step but cannot clear parent task background/blocked state.
- `RunCoordinator` has an explicit lifecycle signal to prefer over `result.success`.
- Session continuity can persist and restore skill task status, run kind, and detached/task ids without losing compatibility with older `success` records.
- Detached task cards and parent turn cards are linked well enough that one cannot show done while the other is still running.

## 2.3 Phase 0-4 Audit Addendum

This addendum is a hard acceptance layer for the Phase 4 implementation pass. It backfills the gaps found while reviewing Phase 0-3 and prevents Phase 4 from being accepted on stub-only evidence.

**Native DB gate:**

- Before accepting any DB-backed supervisor, session-continuity, or `skill_task_runs` behavior, run `npm run rebuild:native`.
- If test output still contains `Database initialization failed` or a better-sqlite3 ABI mismatch, the DB-backed persistence path is not proven even when targeted tests pass.
- In that case, mark SQLite-backed acceptance as unproven and rerun with a real working SQLite harness before claiming completion.

**Phase 0 extra red/regression coverage:**

- Add at least one real mainline test from `RunCoordinator.runScoped` through a real `TurnEngine`, real tool batch, supervisor inspection, scope event emission, and projection sync.
- Add the tool-budget-limited branch where `executeToolBatch.budgetLimited === true`.
- Do not count tests that only prebuild `projectionPatch` or inject `skillTaskLifecycle` as proof of the real path.

**Phase 1/2 run_state selection rule:**

- Use one JS helper for `run_state.json` candidate selection instead of copying selection logic.
- When `expectedTaskId` is present, a root-level `run_state.json` must also match `task_id` / `taskId`; otherwise skip it and continue searching child output directories.
- When there is no identity and multiple candidates exist, return an explicit ambiguous result instead of picking by newest mtime.
- Apply the rule to `skill_inspect_run_state`, `SkillTaskSupervisor`, `detached-skill-task-tracker`, `skill-running-projection`, and the Python `ready_compat.py` path.
- Update the `skill_inspect_run_state` tool description to expose `currentStage`, `totalScenes`, `completedScenes`, `coverageRatio`, `activeOutputDir`, `taskId`, and `expectedTaskId`.

**Phase 2 closeAllowed hardening:**

- `closeAllowed` must stay false when any non-terminal `run_state`, durable resume handle, active detached task, or active task run still indicates recoverable work.
- SQLite or detached terminal status alone cannot close the parent if a stale running `run_state` plus resume handle still exists.
- Add a regression fixture for "SQLite done + stale running run_state + durable resume handle".

**Phase 3 lifecycle honesty:**

- Checkpoint/background handoff must not be recorded as ordinary `status: done`.
- `RunCoordinator.recordRunOutcome`, memory reflection, and prompt assembly must all preserve "paused/background/resumable" as the final lifecycle.
- Monitor-only primitive success without an active parent or durable supervisor handle is only an observation. It must not write a successful recent skill run.

## Phase 0: Baseline And Red Tests

**Purpose:** Lock the real failure modes into tests before touching behavior. This prevents "fix one symptom, create another" churn.

**Key Files:**

- Add tests under `src/__tests__/`
- Existing likely targets:
  - `src/__tests__/run-coordinator-budget.test.ts`
  - `src/__tests__/turn-engine-route.test.ts`
  - `src/__tests__/skill-task-tracker.test.ts`
  - `src/__tests__/skill-primitive-run-shell.test.ts`
  - `src/__tests__/skill-running-projection.test.ts`
  - `src/__tests__/skill-inspect-run-state-vea-contract.test.ts`
  - `src/__tests__/skill-task-supervisor.test.ts`
  - `src/__tests__/session-continuity.test.ts`
  - `src/__tests__/task-projection-sync.test.ts`
  - `src/__tests__/task-card-view-model-contract.test.ts`

**Current Audit Addendum:**

- Some Phase 0 tests already exist in the current diff, but they were not captured as a clean red phase. Execution agents must either re-run against a baseline commit or mark them as regression guards with the failure mode written down.
- Existing tests cover parts of `blockedReason: null`, background card labels, VEA inspector fields, and supervisor conflict handling. Do not duplicate those tests without adding a missing branch.

**Key Tests To Add:**

- [ ] Budget exhaustion while a skill task is active must not emit a completed task.
- [ ] The real `budgetLimitedBeforeCompletion` / max-iteration path in `turn-engine.ts` must produce checkpoint/background when supervisor reports live work. A test that only pre-builds a projection patch is not enough.
- [ ] A primitive shell monitor returning exit code 0 must not overwrite a detached running skill task as done.
- [ ] `stdout` containing `status: running` must be classified as running/observation, not done.
- [ ] A monitor-only primitive success with no active parent must not create a completed skill task or successful memory record by itself.
- [ ] Two `run_state.json` files under one output root must not be selected by newest mtime alone when task identity is known.
- [ ] A root-level `run_state.json` with a mismatched `task_id` must not be selected ahead of a matching child `run_state.json`.
- [ ] VEA `current_stage`, `completed_scenes`, `total_scenes`, and `coverage_ratio` must be extracted by `skill_inspect_run_state`.
- [ ] `blockedReason: null` must clear a previous blocker.
- [ ] A task card cannot materialize `done + blockedReason + resumableActions: ["none"]`.
- [ ] Recovery must prefer detached/background running task over primitive shell success.
- [ ] Projection-level state must remain live/background after primitive `done`, not only the SQLite parent row.

**Verification:**

Run the targeted tests before implementation and record, next to each test or in the phase commit note, the exact old behavior it catches. If the current dirty worktree already makes a test pass, mark it as a regression guard and add the missing red case instead of pretending the original red run happened.

Suggested commands:

```bash
npx tsx --test src/__tests__/skill-inspect-run-state-vea-contract.test.ts
npx tsx --test src/__tests__/skill-task-supervisor.test.ts
npx tsx --test src/__tests__/skill-task-tracker.test.ts
npx tsx --test src/__tests__/run-coordinator-budget.test.ts
npx tsx --test src/__tests__/turn-engine-route.test.ts
```

## Phase 1: VEA Progress Contract

**Purpose:** Fix the "sensor" layer. Dynamic budget cannot work until Ready can see real task progress.

**Current Audit Addendum:**

- `assets/embedded-skills/video-expert-analyzer/scripts/run_state.py` already has the baseline fields this plan needs. Phase 1 should verify and tighten them, not rebuild the helper.
- `assets/embedded-skills/video-expert-analyzer/scripts/ready_compat.py` already tries to select output dirs by `READY_SKILL_TASK_ID`.
- `src/main/modules/tools/skill-primitives/inspect-run-state.ts` already exposes `expectedTaskId` and richer VEA fields, but direct root-file selection must also respect identity.

**VEA Changes:**

- Verify `assets/embedded-skills/video-expert-analyzer/scripts/run_state.py` default state contains and preserves:
  - `schema_version`
  - `task_id`
  - `pid`
  - `started_at`
  - `active_output_dir`
- Ensure VEA writes `active_output_dir` as soon as the real video subdirectory is known.
- Add lightweight heartbeat updates during long stages:
  - `updated_at`
  - `current_stage`
  - `total_scenes`
  - `completed_scenes`
  - `coverage_ratio`
- Keep `delivery_report.json` as final delivery validation, not live progress truth.

**Identity Contract:**

- Detached tasks use the detached task id, such as `dst-*`, as the Ready task identity and inject it through `READY_SKILL_TASK_ID`.
- Typed skill actions must have one stable Ready-owned identity, either the task run id or the skill job id chosen by the action runtime. Do not let VEA invent a separate id after launch.
- `run_state.task_id`, detached tracker `id`, `skill_task_runs.detachedTaskId` / `jobId`, and the `expectedTaskId` passed to inspectors must be traceable in tests.
- When `expectedTaskId` is present, any `run_state.json` with a different non-empty `task_id` is ineligible, including a root-level direct file. A blank legacy `task_id` is not a match unless the caller passed an explicit `runStatePath`.

**Ready Changes:**

- Update `src/main/modules/tools/skill-primitives/inspect-run-state.ts` to extract:
  - `schemaVersion`
  - `taskId`
  - `pid`
  - `startedAt`
  - `activeOutputDir`
  - `currentStage`
  - `completedStages`
  - `totalScenes`
  - `completedScenes`
  - `coverageRatio`
  - `status`
  - `updatedAt`
- Stop using newest mtime as the first-choice selector when task identity is available.
- If identity is unavailable, return an explicit ambiguity result instead of silently picking a stale run.
- Apply the same identity-first selection rule in:
  - `src/main/modules/tools/skill-primitives/inspect-run-state.ts`
  - `src/main/modules/tools/skill-primitives/tool-defs.ts`
  - `src/main/modules/agent-control/skill-task-supervisor.ts`
  - `src/main/modules/agent-control/skill-running-projection.ts`
  - `assets/embedded-skills/video-expert-analyzer/scripts/ready_compat.py`
- Update the `skill_inspect_run_state` tool description so the LLM sees the real fields it can rely on: `currentStage`, `totalScenes`, `completedScenes`, `coverageRatio`, `activeOutputDir`, `taskId`, and `expectedTaskId`, not only the older `currentStep/completedSteps` wording.

**Verification:**

- `skill_inspect_run_state` returns VEA stage and scene progress from a fixture run_state.
- A root output directory with stale and fresh runs selects the run matching `task_id` or returns ambiguous.
- A root-level `run_state.json` whose `task_id` does not match `expectedTaskId` is skipped, and a matching child run is selected.
- A VEA pipeline fixture writes `active_output_dir` as soon as the video-specific output directory is known.
- VEA fixture with `current_stage: score_batches` displays progress in task projection.
- `src/__tests__/skill-execution-tools-removed.test.ts` or a dedicated tool-definition test proves `skill_inspect_run_state` tells the model about stage, scene count, coverage, active output directory, and task identity matching.

## Phase 2: Skill Task Supervisor

**Purpose:** Add a single owner that answers "is this skill task alive, progressing, blocked, failed, or done?"

**New Module:**

- Create `src/main/modules/agent-control/skill-task-supervisor.ts`.

**Current Audit Addendum:**

- A draft supervisor module and tests already exist in the current worktree. Treat this phase as contract hardening unless the draft is missing in the execution branch.
- The module is currently only referenced by tests. Phase 2 is not done until its contract is stable enough for Phase 3 to call; Phase 3 is where it becomes part of the real turn lifecycle.
- `budget_paused` is currently a supervisor status name without a source of truth. Either define it in Phase 3 as a budget-exhausted lifecycle outcome, or keep it out of Phase 2 assertions.

**Responsibilities:**

- Aggregate these sources:
  - SQLite `skill_task_runs`
  - detached task JSON tracker
  - process liveness when pid is known
  - VEA `run_state.json`
  - output directory file activity
  - task projection as UI-only fallback
- Return a normalized snapshot:

```ts
interface SkillTaskSupervisorSnapshot {
  taskRunId: string | null
  detachedTaskId: string | null
  skillId: string | null
  status: 'running' | 'background_running' | 'budget_paused' | 'blocked' | 'failed' | 'done' | 'cancelled' | 'unknown'
  hasLiveWork: boolean
  hasRecentProgress: boolean
  closeAllowed: boolean
  ambiguous: boolean
  stale: boolean
  outputDir: string | null
  runStatePath: string | null
  lastProgressAt: string | null
  pauseReason: string | null
  resumePayload: Record<string, unknown> | null
  progressFingerprint: string | null
  progress: {
    currentStage?: string | null
    totalScenes?: number | null
    completedScenes?: number | null
    coverageRatio?: number | null
    updatedAt?: string | null
  }
  blockers: string[]
}
```

**Rules:**

- Any reliable live signal wins over a primitive monitor result.
- Detached running wins over task projection done.
- A shell monitor step can update step history but cannot close the parent skill task.
- `closeAllowed` is the only permission Phase 3 may use to finish a parent skill task as done.
- Projection is fallback context only. It cannot override SQLite/detached/run_state live evidence.
- If `expectedTaskId` is provided, direct root `run_state.json` does not bypass identity matching.
- If supervisor sees conflicting truth, it should preserve recoverability and mark the task blocked/background rather than done.

**Verification:**

- Supervisor reports live work when detached JSON says running even if SQLite latest row says done.
- Supervisor reports live work when pid exists and run_state is stale.
- Supervisor reports ambiguity instead of selecting stale output paths from another task.
- Supervisor selects a matching child `run_state.json` over a mismatched root `run_state.json`.
- Supervisor returns `closeAllowed: false` for every combination where detached JSON, pid, fresh heartbeat, output activity, or active task run says the work is still live.
- Supervisor conflict fixture covers all four sources at once: SQLite terminal row, detached running record, run_state running, projection done.
- Supervisor returns enough resume data for Phase 3: `detachedTaskId`, `taskRunId`, `runStatePath`, `outputDir`, `progressFingerprint`, and `pauseReason`.

## Phase 3: Lifecycle Separation

**Purpose:** Make agent turn, tool step, and skill task independent.

**Do Not Do In Phase 3:**

- Do not implement dynamic lease renewal. Phase 3 only prevents false completion and preserves resume handles.
- Do not add new `skill_task_runs.status` enum values.
- Do not treat `exitCode: 0` from a monitor command as proof that the parent skill task is complete.
- Do not make `delivery_report.json` live progress truth.

### Phase 3.1: Define The Lifecycle Projection Contract

**Files:**

- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/types.ts`
- Modify: `src/renderer/modules/agent/scopeRunState.ts`
- Create: `src/main/modules/agent-control/skill-task-lifecycle.ts`
- Test: `src/__tests__/skill-task-lifecycle.test.ts`
- Test: `src/__tests__/scope-run-state.test.ts`

**Plan:**

- [ ] Add one explicit optional lifecycle signal to turn results, for example:

```ts
interface SkillTaskLifecycleSignal {
  state: 'background_running' | 'budget_paused' | 'blocked' | 'done' | 'failed'
  reason: 'budget_exhausted' | 'background_handoff' | 'primitive_observation' | 'supervisor_close'
  phase: 'checkpoint' | 'done' | 'error' | 'cancelled'
  waitingFor: ScopeRunWaitingFor
  interactionState: TaskInteractionState
  resumableActions: ScopeRunResumableAction[]
  blockedReason: string | null
  taskContinuation: ScopeRunTaskContinuation | null
}
```

- [ ] Extend `ScopeRunTaskContinuation` and the renderer parser to preserve the handles used for recovery:
  - `pauseReason`
  - `detachedTaskId`
  - `taskRunId`
  - `jobId`
  - `skillId`
  - `action`
  - `runStatePath`
  - `outputDir`
  - `progressFingerprint`
- [ ] Map supervisor snapshots to existing UI fields:
  - `hasLiveWork || hasRecentProgress || closeAllowed === false` -> checkpoint/background.
  - `closeAllowed === true && status === "done"` -> done.
  - terminal failure with no live work -> error.
- [ ] Add `isRelevantSkillTaskSnapshot(snapshot)` and require it before using `closeAllowed`. An empty `unknown` snapshot must be ignored.
- [ ] Define `budget_paused` only for budget exhaustion plus a durable resume handle plus no live/recent progress.
- [ ] Keep this mapper pure. It must not inspect files, read SQLite, or mutate projections.

**Verification:**

```bash
npx tsx --test src/__tests__/skill-task-lifecycle.test.ts
npx tsx --test src/__tests__/scope-run-state.test.ts --test-name-pattern "taskContinuation|background"
```

Expected: lifecycle mapping tests pass without changing DB enums or `ScopeRunEventPayload.phase`.

### Phase 3.2: Connect TurnEngine Budget Exhaustion To Supervisor

**Files:**

- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify if needed for dependency injection: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/turn-engine-route.test.ts`
- Test: `src/__tests__/turn-engine-contract.test.ts`

**Plan:**

- [ ] Land this together with Phase 3.5, or land Phase 3.5's consumer test first as a failing test. Do not leave an intermediate state where TurnEngine emits a lifecycle signal that RunCoordinator ignores.
- [ ] In the real budget exhaustion branch near the final `turn_budget_exhausted` metric, call `inspectLatestSkillTask({ sessionId: request.sessionId, scopeId: request.sessionId, skillId })` or an injected equivalent.
- [ ] First check that the snapshot is relevant to this turn. Ignore empty `unknown` snapshots so ordinary tasks can still finish.
- [ ] If the relevant snapshot says live/recent work exists, or `closeAllowed === false`, emit a structured skill projection with:
  - `module: "skill"`
  - `phase: "checkpoint"`
  - `waitingFor: "background"`
  - `resumableActions: ["continue", "cancel"]`
  - `blockedReason: "本轮预算已用完，但技能任务仍在后台运行"`
  - `taskContinuation` carrying the supervisor resume payload
- [ ] Return `success: true` but include the explicit lifecycle signal from Phase 3.1. Do not rely only on the projection patch.
- [ ] Only fall through to the existing done finish when supervisor returns no relevant skill task or a relevant snapshot with `closeAllowed === true`.

**Verification:**

```bash
npx tsx --test src/__tests__/turn-engine-route.test.ts --test-name-pattern "budget"
npx tsx --test src/__tests__/turn-engine-contract.test.ts --test-name-pattern "budget"
```

Expected: a max-iteration or tool-budget-limited skill turn with live supervisor evidence ends as checkpoint/background, not done.

### Phase 3.3: Add A Parent Skill Task Lifecycle Event

**Files:**

- Modify: `src/main/modules/agent-control/skill-task-tracker.ts`
- Modify: `src/main/modules/repositories/skill-task-run-repository.ts` only if an update helper is missing; do not add new status values.
- Test: `src/__tests__/skill-task-tracker.test.ts`
- Test: `src/__tests__/skill-task-run-repository.test.ts`

**Plan:**

- [ ] Add a tracker entry point for parent lifecycle updates, separate from primitive tool-step events.
- [ ] For `background_running`, keep the parent task run `status: "running"` and `interactionState: "suspended"` while setting projection `waitingFor: "background"`.
- [ ] For `budget_paused` with no live process but a resumable task, use parent task run `status: "blocked"` and `interactionState: "suspended"`.
- [ ] Append a lifecycle step such as `skill_lifecycle#N` so history records why the turn yielded, without pretending any primitive tool completed the whole task.
- [ ] Preserve output paths and resume payload from the supervisor snapshot.

**Verification:**

```bash
npx tsx --test src/__tests__/skill-task-tracker.test.ts --test-name-pattern "lifecycle|primitive|background"
npx tsx --test src/__tests__/skill-task-run-repository.test.ts
```

Expected: parent task status remains active/recoverable after budget handoff, and lifecycle events do not create terminal rows.

### Phase 3.4: Stop Primitive Success From Flattening The Parent Projection

**Files:**

- Modify: `src/main/modules/agent-control/skill-task-tracker.ts`
- Inspect only unless needed: `src/main/modules/tools/skills-tools.ts`
- Test: `src/__tests__/skill-task-tracker.test.ts`
- Test: `src/__tests__/skill-runtime-structured-result.test.ts`

**Plan:**

- [ ] Extend the existing DB-level `preserveActiveParent` rule to the in-memory projection.
- [ ] When `event.runKind === "primitive"` and `event.status === "done"`:
  - append or update the primitive step;
  - do not clear parent `blockedReason`, `waitingFor`, `resumableActions`, or `taskContinuation` if the parent task is active/background/blocked;
  - do not move the current parent lifecycle step to done unless supervisor close is allowed.
- [ ] Ensure `stdout` or structured output indicating `status: running` remains an observation, not parent completion.

**Verification:**

```bash
npx tsx --test src/__tests__/skill-task-tracker.test.ts --test-name-pattern "primitive"
npx tsx --test src/__tests__/skill-runtime-structured-result.test.ts --test-name-pattern "running"
```

Expected: primitive monitor exit 0 can be visible in step history while the parent projection still shows background/continue.

### Phase 3.5: Make RunCoordinator Prefer Lifecycle Over Success

This is the same execution slice as Phase 3.2. Splitting them across commits is allowed only if the first commit contains failing tests that prove an ignored lifecycle signal still becomes done.

**Files:**

- Modify: `src/main/modules/agent-control/run-coordinator.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/run-coordinator-budget.test.ts`

**Plan:**

- [ ] Compute final phase in this order:
  1. cancellation
  2. explicit lifecycle signal
  3. recoverable projection wait
  4. `result.success`
- [ ] Keep memory reflection on the same final phase. A checkpoint/background task must not get a follow-up memory event with `phase: "done"`.
- [ ] Keep `promptAssembly.recordRunOutcome` honest: use the final lifecycle state to avoid training future turns that a paused/background skill task was completed.
- [ ] Preserve lifecycle `taskContinuation` fields all the way through emitted scope-run events. Tests must prove `pauseReason`, `detachedTaskId`, `taskRunId`, `runStatePath`, and `outputDir` survive.

**Verification:**

```bash
npx tsx --test src/__tests__/run-coordinator-budget.test.ts
```

Expected: `success: true` plus lifecycle checkpoint emits checkpoint in both the immediate final event and later memory-capture event.

### Phase 3.6: Persist Skill Continuity Without Flattening To Success

**Files:**

- Modify: `src/main/modules/agent-control/session-continuity.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts` only if resume resolution needs the new fields.
- Test: `src/__tests__/session-continuity.test.ts`
- Test: `src/__tests__/skill-resume-end-to-end.test.ts`

**Plan:**

- [ ] Extend `SkillRunRecord` with optional fields:
  - `status`
  - `runKind`
  - `taskRunId`
  - `detachedTaskId`
  - `jobId`
  - `outputDir`
  - `runStatePath`
  - `pauseReason`
  - `resumePayload`
- [ ] Bump the persisted session-continuity payload version and keep the reader compatible with older records that only contain `success`.
- [ ] Add a hydration test: write an old continuity file, load it, and prove it still returns a usable `SkillRunRecord`.
- [ ] Add a round-trip test: write a background/budget-paused record with the new fields, reload from disk, and prove no resume handle is lost.
- [ ] Update `rememberSkillRun` call sites so detached/background/budget-paused work is stored as recoverable, not as plain success.
- [ ] Make resume lookup prefer active `skill_task_runs` / supervisor snapshot over old `recentSkillRuns`.

**Verification:**

```bash
npx tsx --test src/__tests__/session-continuity.test.ts
npx tsx --test src/__tests__/skill-resume-end-to-end.test.ts --test-name-pattern "recent skill|resume|continuation"
```

Expected: app restart can restore a background or budget-paused skill task with its detached id/run state path intact.

### Phase 3.7: Link Detached Task And Parent Turn Semantics

**Files:**

- Modify: `src/main/modules/agent-control/detached-skill-task-tracker.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Test: `src/__tests__/detached-skill-task-tracker.test.ts`
- Test: `src/__tests__/task-projection-sync.test.ts`
- Test: `src/__tests__/task-card-view-model-contract.test.ts`

**Plan:**

- [ ] Use this minimal Phase 3 relationship: parent turn yields to the detached task and stays checkpoint/background until supervisor says close is allowed.
- [ ] Carry `parentTaskId`, `parentStepId`, or `taskProjectionId` where already available so the renderer can avoid showing one card as done while the detached job is still running.
- [ ] Do not do full UI grouping in Phase 3; just provide stable linkage data for Phase 5.
- [ ] Ensure detached task status updates cannot overwrite the parent turn to done unless supervisor close is allowed.

**Verification:**

```bash
npx tsx --test src/__tests__/detached-skill-task-tracker.test.ts
npx tsx --test src/__tests__/task-projection-sync.test.ts --test-name-pattern "background|budget|detached"
npx tsx --test src/__tests__/task-card-view-model-contract.test.ts
```

Expected: parent and detached projections are linked and never contradict each other as done plus running.

### Phase 3 Final Verification

Run the full Phase 3 slice:

```bash
npx tsx --test src/__tests__/skill-task-supervisor.test.ts
npx tsx --test src/__tests__/skill-task-lifecycle.test.ts
npx tsx --test src/__tests__/scope-run-state.test.ts --test-name-pattern "taskContinuation|background"
npx tsx --test src/__tests__/skill-task-tracker.test.ts
npx tsx --test src/__tests__/run-coordinator-budget.test.ts
npx tsx --test src/__tests__/turn-engine-route.test.ts
npx tsx --test src/__tests__/session-continuity.test.ts
npx tsx --test src/__tests__/detached-skill-task-tracker.test.ts
npx tsx --test src/__tests__/task-projection-sync.test.ts
npm run typecheck
```

Phase 3 passes only if budget exhaustion with live work produces checkpoint/background and if no later memory/projection update turns it into done.

## Phase 4: Dynamic Budget Lease

**Purpose:** Replace fixed long-task ceilings with a lease loop that renews only on real progress, pauses wasteful loops, and hands off live background work instead of pretending it is done.

**New Modules:**

- `src/main/modules/agent-control/progress-scorer.ts`
- `src/main/modules/agent-control/waste-scorer.ts`
- `src/main/modules/agent-control/skill-budget-lease-controller.ts`
- `src/main/modules/agent-control/run-state-selection.ts`

**Module Boundaries:**

- `run-state-selection.ts` is the only JS-side helper for selecting `run_state.json` candidates by task identity.
- `progress-scorer.ts` only decides whether new evidence represents real progress. It must not read files or mutate budget state.
- `waste-scorer.ts` only decides whether repeated behavior is wasting budget. It must not read files or mutate budget state.
- `skill-budget-lease-controller.ts` is the only module that decides `renew`, `pause`, `handoff_background`, `close`, or `active`.

**Runtime Contract Changes:**

- Add `SkillBudgetLeaseState` to `run-contracts.ts` and attach it to `TaskBudgetRuntime.lease`.
- Add `budgetLease` to `ExecutionRunDiagnostics`.
- Diagnostics must include at least:
  - `leaseId`
  - `decision`
  - `reason`
  - `renewalsUsed`
  - `progressScore`
  - `wasteScore`
  - `lastFingerprint`
  - `currentLeaseEndIteration`

**Progress Signals:**

- Stage changes.
- `completedScenes` increases.
- `coverageRatio` increases.
- New artifacts appear in output directory.
- `run_state.updated_at` advances.
- Typed action returns new structured result.
- Typed action returns a new milestone or durable output handle.
- Progress fingerprint changes.

**Waste Signals:**

- Same tool and same args repeat.
- Different tools read the same unchanged file.
- Inspecting the same run_state repeatedly with unchanged content.
- Command parse failure, input validation failure, allowlist rejection.
- Same provider/auth/quota error repeats.
- A monitor command reports no progress for several checks.

**Budget Lease Model:**

- Initial lease: 20 iterations.
- Renewal chunk: 20 iterations.
- Maximum renewals: 10.
- Hard cap: 220 total iterations.
- The hard cap is only a ceiling. It is not the starting budget.
- Keep the existing 80-iteration compatibility seed if needed, but gate foreground continuation through the lease state.

**Renewal Conditions:**

- `progress.score >= 2`.
- `waste.score <= 1`.
- Progress fingerprint changed, or a typed action returned a new milestone.
- The same fingerprint has not already been renewed.
- The lease has not exceeded `maxRenewals` or the 220-iteration hard cap.

**Pause Conditions:**

- Two consecutive lease windows have no fingerprint change.
- Repeated unchanged `run_state` or unchanged artifact reads reach 3 observations.
- Repeated input validation, parse, allowlist, auth, quota, or rate-limit style errors reach 3 observations.
- Supervisor result is ambiguous or stale and there is no live pid or fresh output activity.

**Background Handoff Conditions:**

- `hasLiveWork === true` but foreground progress is weak.
- A pid is alive or output activity is fresh.
- At least one resume handle exists: `resumePayload`, `runStatePath`, `outputDir`, or `detachedTaskId`.
- A pid-only signal may receive at most one short renewal. After that, the controller must see stage, scene, artifact, or `updatedAt` movement, or hand off to background.

**TurnEngine Integration Points:**

- After tool-loop initialization, create a lease state for long skills or recoverable supervisor snapshots.
- Before each budget check, if the lease has two or fewer iterations left or has reached the lease end, sample the supervisor and ask the lease controller for a decision.
- On `renew`, extend only the lease end, not the global hard cap.
- On `pause` or `handoff_background`, route through the Phase 3 lifecycle path so the parent task remains resumable.
- After each tool batch, feed executed tools, tool results, recovery history, and supervisor snapshot into the progress and waste scorers.

**Temporary Logic To Remove:**

- Long typed-action success must not automatically call `grantBudgetSafetyFloor`.
- Pure read-only tool batches must not unconditionally refund an iteration.
- Continuing foreground work is a progress/waste lease decision, not a special case per tool type.

**Verification:**

- Unit test `progress-scorer` for stage, scene, coverage, artifact, `updatedAt`, and fingerprint changes.
- Unit test `waste-scorer` for repeated tools, repeated reads, unchanged `run_state`, and repeated validation/allowlist/auth/quota errors.
- Unit test `skill-budget-lease-controller` for renew, pause, handoff, and close decisions.
- Integration test a 200-step progressing fixture through bounded renewals until done.
- Integration test a stalled unchanged `run_state` loop until it reaches `budget_paused`.
- Integration test weak live background work: one short renewal at most, then `handoff_background` unless progress changes.
- Verify `budgetRuntime.lease` appears in diagnostics and can be restored with the runtime state.

## Phase 5: UI And Continuation Semantics

**Purpose:** Make the user-facing state match the real task state.

**Main Changes:**

- Extend run/task types with:
  - `paused`
  - `background_running`
  - `budget_paused`
  - `awaiting_progress`
  - `pauseReason`
  - `backgroundTaskRefs`
  - `lastProgressAt`
- Update task projection and renderer state normalization:
  - `blockedReason: null` must clear old blocker.
  - `done + blocker` is invalid.
  - `blocked/background + ["none"]` is invalid unless intentionally read-only.
- Update task card labels:
  - Done: truly completed and verified.
  - Background running: agent yielded, work continues.
  - Budget paused: user can continue/retry/cancel.
  - Waiting for user: clarification/confirmation.
  - Failed: actionable failure.
- Continuation anchors:
  - budget paused: continue monitor / continue execution / cancel.
  - background running: continue / open artifact / cancel.
  - failed: retry / restart / cancel.

**Verification:**

- Screenshot-level state cannot show completed while background task is alive.
- Continue from a budget-paused card restores the same skill task.
- Restart after app relaunch recovers background/budget-paused task from `skill_task_runs`, not from transient projection text.

## Phase 6: Simulated User Acceptance

**Purpose:** Stop waiting for manual screenshots as the primary feedback loop.

**Harness Scenarios:**

- Healthy long task:
  - Simulate a VEA-like task that needs 100-200 agent iterations.
  - Every few iterations, stage or scene progress changes.
  - Expected: dynamic lease renews and final status is done only after delivery verification.
- Stalled loop:
  - Simulate repeated inspect/read of unchanged run_state.
  - Expected: budget does not keep renewing; task pauses with clear reason.
- Background handoff:
  - Simulate detached task with pid alive and output files growing after agent lease ends.
  - Expected: turn finishes as background running; supervisor keeps task recoverable.
- Restart recovery:
  - Persist `skill_task_runs` and detached record.
  - Recreate runtime.
  - Expected: "continue" restores the live/background task first.
- Ordinary chat:
  - Message like "帮我换个标题".
  - Expected: no skill resume and no primitive tool exposure.

**Verification Sources:**

- Renderer task projection.
- SQLite `skill_task_runs`.
- detached task JSON.
- run_state fixture.
- agent logs and tool logs.

## Phase 7: Baseline Cleanup And Documentation

**Purpose:** Make this branch reviewable and prepare the next implementation split.

**Tasks:**

- Review current large worktree diff and separate:
  - already completed B-plan fixes
  - new long-task supervisor work
  - unrelated churn
- Keep commits or PR slices aligned to phases above.
- Update AGENTS/CLAUDE docs only when behavior rules change.
- List non-skill test failures separately.

**Verification Commands:**

```bash
npx tsx --test src/__tests__/skill-task-run-repository.test.ts
npx tsx --test src/__tests__/skill-runtime-structured-result.test.ts
npx tsx --test src/__tests__/embedded-skill-vea-runtime-failure-paths.test.ts
npx tsx --test src/__tests__/skill-resume-end-to-end.test.ts
npx tsx --test src/__tests__/skill-tool-gating-by-session.test.ts
npx tsx --test src/__tests__/run-coordinator-budget.test.ts
npm run typecheck
npm run test:skill
```

## 3. Suggested Stage Split For Execution

The safest split is eight stages, matching the phase map:

1. Stage 0: red tests only.
2. Stage 1: VEA progress schema and inspect parser.
3. Stage 2: supervisor read-only aggregation.
4. Stage 3: lifecycle separation and task status protection.
5. Stage 4: dynamic lease and anti-loop scoring.
6. Stage 5: UI/continuation semantics.
7. Stage 6: simulated user acceptance.
8. Stage 7: cleanup, documentation, and review slicing.

Do not start with dynamic budget. Without Stage 1 and Stage 2, the budget controller has no reliable progress signal and will only encode guesses.

## 4. Key Design Decisions

- Do not increase the fixed VEA budget to 200 as the primary fix.
- Do not restore `skill_executions`.
- Do not let primitive monitor results close parent skill tasks.
- Do not pick output directories by newest mtime when a task identity is available.
- Do not treat `delivery_report.json` as live progress truth.
- Do not make shell the VEA long-flow main path.
- Do use Skill Runtime as the proving ground for C-style generic scheduling.
- For Phase 3, map paused/background skill work to existing checkpoint/background fields instead of adding new DB status values.
- `closeAllowed` from the supervisor is the gate for parent task completion.

## 5. Resolved And Open Questions For Phase-Level Refinement

Resolved for Phase 3:

1. `paused/background_running` should not become new top-level phases in Phase 3. Use existing `checkpoint + suspended + waitingFor: background` projection fields.
2. Ready owns task identity. VEA reads it from env/payload and writes it into `run_state.task_id`; VEA should not generate a separate durable id.
3. Parent task completion is allowed only through supervisor `closeAllowed`, not through primitive step success.

Still open for later phases:

1. How much process liveness should be trusted after app restart on macOS, where child process ownership can be ambiguous?
2. Should progress/waste scoring be skill-specific at first, or a generic scorer with optional skill adapters?
3. Should supervisor actively poll in the background, or only refresh on user-visible events and task card reads?
4. Should Phase 5 introduce first-class UI labels for `budget_paused/background_running`, or keep them as view-model labels derived from checkpoint/background fields?
