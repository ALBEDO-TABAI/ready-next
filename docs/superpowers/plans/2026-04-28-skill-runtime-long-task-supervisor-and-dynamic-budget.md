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

## Phase 0: Baseline And Red Tests

**Purpose:** Lock the real failure modes into tests before touching behavior. This prevents "fix one symptom, create another" churn.

**Key Files:**

- Add tests under `src/__tests__/`
- Existing likely targets:
  - `src/__tests__/run-coordinator-budget.test.ts`
  - `src/__tests__/skill-task-tracker.test.ts`
  - `src/__tests__/skill-primitive-run-shell.test.ts`
  - `src/__tests__/skill-running-projection.test.ts`
  - `src/__tests__/task-projection-sync.test.ts`
  - `src/__tests__/task-card-view-model-contract.test.ts`

**Key Tests To Add:**

- [ ] Budget exhaustion while a skill task is active must not emit a completed task.
- [ ] A primitive shell monitor returning exit code 0 must not overwrite a detached running skill task as done.
- [ ] `stdout` containing `status: running` must be classified as running/observation, not done.
- [ ] Two `run_state.json` files under one output root must not be selected by newest mtime alone when task identity is known.
- [ ] VEA `current_stage`, `completed_scenes`, `total_scenes`, and `coverage_ratio` must be extracted by `skill_inspect_run_state`.
- [ ] `blockedReason: null` must clear a previous blocker.
- [ ] A task card cannot materialize `done + blockedReason + resumableActions: ["none"]`.
- [ ] Recovery must prefer detached/background running task over primitive shell success.

**Verification:**

Run the new targeted tests before implementation and confirm they fail for the expected reasons. Do not proceed if a test fails for unrelated setup issues.

## Phase 1: VEA Progress Contract

**Purpose:** Fix the "sensor" layer. Dynamic budget cannot work until Ready can see real task progress.

**VEA Changes:**

- Extend `assets/embedded-skills/video-expert-analyzer/scripts/run_state.py` default state with:
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

**Verification:**

- `skill_inspect_run_state` returns VEA stage and scene progress from a fixture run_state.
- A root output directory with stale and fresh runs selects the run matching `task_id` or returns ambiguous.
- VEA fixture with `current_stage: score_batches` displays progress in task projection.

## Phase 2: Skill Task Supervisor

**Purpose:** Add a single owner that answers "is this skill task alive, progressing, blocked, failed, or done?"

**New Module:**

- Create `src/main/modules/agent-control/skill-task-supervisor.ts`.

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
  outputDir: string | null
  runStatePath: string | null
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
- If supervisor sees conflicting truth, it should preserve recoverability and mark the task blocked/background rather than done.

**Verification:**

- Supervisor reports live work when detached JSON says running even if SQLite latest row says done.
- Supervisor reports live work when pid exists and run_state is stale.
- Supervisor reports ambiguity instead of selecting stale output paths from another task.

## Phase 3: Lifecycle Separation

**Purpose:** Make agent turn, tool step, and skill task independent.

**Main Changes:**

- Update `turn-engine.ts` budget exhaustion path:
  - Ask supervisor whether the skill task still has live work or recent progress.
  - If yes, finish the agent turn as paused/background, not done.
  - Emit a durable skill task event with `failureKind: budget_exhausted` or `pauseReason: background_handoff`.
- Update `run-coordinator.ts`:
  - Do not map `result.success` directly to `phase: done` when result carries pause/background state.
  - Memory reflection must not reinforce `phase: done` for paused/background tasks.
- Update `skill-task-tracker.ts`:
  - Track tool step status separately from parent task status.
  - Primitive events append steps but do not overwrite active typed/detached parent status unless supervisor agrees.
- Update `session-continuity.ts`:
  - Store `runKind`, `detachedTaskId`, and status, not just `success: boolean`.

**Verification:**

- Budget exhaustion with live detached task creates `status: blocked/background_running`, not done.
- Shell monitor exit 0 appends a step but parent task remains running/background.
- Memory capture after a paused skill task does not change the visible task to completed.

## Phase 4: Dynamic Budget Lease

**Purpose:** Replace fixed long-task ceilings with progress-aware renewal.

**New Modules:**

- `src/main/modules/agent-control/progress-scorer.ts`
- `src/main/modules/agent-control/waste-scorer.ts`

**Progress Signals:**

- Stage changes.
- `completedScenes` increases.
- `coverageRatio` increases.
- New artifacts appear in output directory.
- `run_state.updated_at` advances.
- Typed action returns new structured result.
- Detached pid is alive.

**Waste Signals:**

- Same tool and same args repeat.
- Different tools read the same unchanged file.
- Inspecting the same run_state repeatedly with unchanged content.
- Command parse failure, input validation failure, allowlist rejection.
- Same provider/auth/quota error repeats.
- A monitor command reports no progress for several checks.

**Budget Lease Model:**

- Start long skill tasks with a smaller initial lease, such as 20 or 40 iterations.
- Near lease end, ask supervisor and scorers for the current score.
- If progress is strong, renew by a bounded chunk.
- If progress is weak but background work is alive, hand off to background supervisor.
- If waste is high, pause and ask for user/strategy intervention.
- Never renew indefinitely without positive progress.

**Verification:**

- Simulated 200-step task with periodic progress does not stop early.
- Simulated stalled loop pauses within a bounded number of iterations.
- Read-only calls against unchanged content do not refund budget.
- Repeated invalid tool calls reduce renewal eligibility.

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
  - background running: inspect / continue / cancel.
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

The safest split is seven stages:

1. Stage 0: red tests only.
2. Stage 1: VEA progress schema and inspect parser.
3. Stage 2: supervisor read-only aggregation.
4. Stage 3: lifecycle separation and task status protection.
5. Stage 4: dynamic lease and anti-loop scoring.
6. Stage 5: UI/continuation semantics.
7. Stage 6: simulated user acceptance and cleanup.

Do not start with dynamic budget. Without Stage 1 and Stage 2, the budget controller has no reliable progress signal and will only encode guesses.

## 4. Key Design Decisions

- Do not increase the fixed VEA budget to 200 as the primary fix.
- Do not restore `skill_executions`.
- Do not let primitive monitor results close parent skill tasks.
- Do not pick output directories by newest mtime when a task identity is available.
- Do not treat `delivery_report.json` as live progress truth.
- Do not make shell the VEA long-flow main path.
- Do use Skill Runtime as the proving ground for C-style generic scheduling.

## 5. Open Questions For Phase-Level Refinement

These should be answered when expanding each phase into task-level implementation:

1. Should `paused/background_running` be new top-level phases, or should they be represented as `blocked` plus richer interaction state for minimum blast radius?
2. How much process liveness should be trusted after app restart on macOS, where child process ownership can be ambiguous?
3. Should VEA generate a Ready task id itself from env, or should Ready inject one into the action payload and env together?
4. Should progress/waste scoring be skill-specific at first, or a generic scorer with optional skill adapters?
5. Should supervisor actively poll in the background, or only refresh on user-visible events and task card reads?
