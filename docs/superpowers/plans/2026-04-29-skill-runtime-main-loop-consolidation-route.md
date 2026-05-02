# Skill Runtime Main Loop Consolidation Route

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement follow-up phase plans. This document is the route and evidence base; each stage below should be split into its own implementation plan with checkbox steps before coding.

**Goal:** Consolidate skill continuation into one reliable main loop so Ready can find the current skill task, choose the next action, execute or pause it, and update UI state without different layers contradicting each other.

**Architecture:** Ready should move from scattered skill heuristics to a single per-turn `TurnFrame`. The frame owns active task identity, liveness, tool policy, steering, budget stop, projection update, and final UI phase for the turn. Skill-specific state is one slice of the frame, not a separate judge. Supervisor, projection, tool gating, and renderer become consumers of this frame rather than independent judges.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, React renderer task cards, embedded skill primitives. The current VEA task is the fixture for this route, but the architecture target is the Ready agent main loop.

---

## 1. Current Stage Objective

The current phase should not keep patching isolated bugs one by one. The target is to make skill continuation obey one main loop first.

This route is complete when it gives enough information to write detailed phase plans without reopening the same diagnosis:

- The live failure is described from logs, database rows, process state, and VEA artifacts.
- The CC-Source comparison is reduced to the specific main-loop patterns Ready should adopt.
- The desired Ready main-loop responsibilities are explicit.
- Remaining problems are grouped by layer and dependency order.
- Each stage has a boundary, success condition, and verification direction.

## 2. Assumptions And Scope

- Target worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`.
- Current priority is the `video-expert-analyzer` continuation failure, but the fix should be shaped as a generic skill runtime loop.
- Do not add visible UI buttons in this phase unless a later implementation plan explicitly scopes them.
- Do not expose full provider keys in logs, tests, docs, commit messages, or UI output.
- Do not continue treating key/model configuration as the main blocker unless a validator proves configuration is currently invalid.
- Existing worktree is already dirty with related skill-runtime changes. Future implementation plans must stage only their intended files.

### 2.1 Corrections From Parallel Review

Claude's parallel route review is right on the main architectural correction:

- The latest failure is not primarily "skill tools are invisible." The real `tool_loop_request` allowlist contained `skill_video_expert_pipeline` through the loop. The model did not choose it because Ready never turned the recovered skill context into an authoritative next-action instruction.
- `preferredSkillTools=[]` is still useful evidence, but only as evidence of missing steering, not as evidence that the tool was absent from the model's tool surface.
- The current session primitive gate is brittle: `hasActiveExecution` is permanently false after the old `skill_executions` state machine was removed, so exposure relies on reference hints or active task projections. That is a bridge, not a durable main-loop owner.
- CC-Source contributes more than one ownership idea. The relevant lessons are: one loop state, explicit terminal reasons, a rich tool behavior contract, tool-returned context modifiers, and forked subtask/skill loops.
- The route below therefore treats the first architecture change as `TurnFrame` ownership plus explicit terminal reasons. VEA-specific facts stay as regression fixtures, not as the design center.

## 3. Live Evidence Snapshot

### 3.1 The Backend Is Not Actually Running

Process inspection for `video-expert`, `ai_analyzer`, `pipeline_enhanced`, `openclaw_batch`, and the current output directory found no active scoring process.

Current output directory:

```text
/Users/user/Documents/实验田/测试/4qkyxm4jppc
```

Current artifact state:

```json
{
  "run_state": {
    "status": "running",
    "current_stage": "score_batches",
    "total_scenes": 97,
    "completed_scenes": 0,
    "coverage_ratio": 0,
    "updated_at": "2026-04-29T04:57:21.912Z",
    "last_error": ""
  },
  "scene_scores": {
    "records": 97,
    "scored": 0
  },
  "host_batches": {
    "output_files": 17,
    "statuses": {
      "pending": 17
    },
    "scored_batches": 0
  },
  "process_matches": 0,
  "has_zai": false
}
```

Interpretation:

- `run_state.status=running` is stale or misleading.
- The real scoring work is not running.
- `scene_scores.json` has 97 scene templates, but 0 actual scored scenes.
- The old `zai` configuration blocker is no longer present in the current `run_state` data.

### 3.2 Ready Finds The Skill But Does Not Enter The Skill Resume Lane

Latest real session:

```text
conv-local-1777219721244-7cx39t
```

Important log facts:

```text
[active_skill_context] {"skillId":"video-expert-analyzer","source":"supervisor","hasRunState":true,"hasOutputDir":true,"status":"blocked"}
```

The tool snapshot includes:

```text
skill_video_expert_pipeline
skill_video_expert_ai_analyze
skill_run_shell
skill_patch_config
skill_start_detached
skill_inspect_detached
skill_inspect_run_state
```

But the final budget metric for the real session says:

```json
{
  "metric": "turn_budget_exhausted",
  "sessionId": "conv-local-1777219721244-7cx39t",
  "taskType": "continuation",
  "iterations": 9,
  "maxIterations": 20,
  "budgetLimitedBeforeCompletion": true,
  "referenceSkillId": "video-expert-analyzer",
  "preferredSkillTools": [],
  "longSkillResume": false
}
```

Interpretation:

- The new active skill context can identify VEA.
- Tool visibility is not the primary missing piece: the VEA typed action was already allowed during the loop.
- `preferredSkillTools=[]` means Ready did not promote the typed action into the "this is the next thing to do" lane.
- The route still falls into generic continuation instead of a long-skill typed-action resume.
- The model spends the turn inspecting files because Ready exposes possible tools but does not commit the recovered skill frame to a next action.

### 3.3 Budget Exhaustion Does Not Cleanly End The User Turn

The real log contains:

```text
[ipc] agent:sendScoped start scopeId=conv-local-1777219721244-7cx39t requestId=req-1777439706074-cpvytw
```

No matching `agent:sendScoped done` line appears after the latest budget exhaustion.

The latest assistant chat row for the same request is only:

```text
好，直接开始找。先并行查 run_state 和配置文件位置。
```

Interpretation:

- Budget exhaustion is recorded internally.
- The user-facing turn is not reliably finalized.
- The renderer can remain in "thinking" even though no backend scoring process exists.

### 3.4 Artifact Access Still Contradicts Active Context

The active context knows the current output directory and run state path, but `skill_read_artifact` rejects those same paths:

```json
{
  "metric": "skill_primitive_rejected",
  "primitive": "skill_read_artifact",
  "reason": "path_escape",
  "relativePath": "/Users/user/Documents/实验田/测试/4qkyxm4jppc/run_state.json"
}
```

The rejection says the path escapes:

```text
/Users/user/Library/Application Support/ready/skill-runtime/outputs/video-expert-analyzer
```

Interpretation:

- The active task output directory is not part of the artifact read sandbox.
- The model falls back to `skill_run_shell` for normal task-state reads.
- This wastes budget and encourages repeated inspection loops.

### 3.5 Projection Rows Still Mix Old And New Truth

Current projection for the latest turn:

```json
{
  "task_id": "task-61615c03-f09b-4393-b9ba-8c8863e7e7d9",
  "run_id": "req-1777439706074-cpvytw",
  "task_type": "short_task",
  "module": "skill",
  "status": "queued",
  "interaction_state": "running",
  "waiting_for": "background",
  "blocked_reason": "本轮预算已用完，技能任务已暂停，可继续执行 · score_batches",
  "continuation_ref_json": {
    "taskRunId": "str-8b9029f0",
    "detachedTaskId": "dst-a330f559",
    "skillId": "video-expert-analyzer",
    "action": "skill_run_shell",
    "outputDir": "/Users/user/Documents/实验田/测试/4qkyxm4jppc",
    "runStatePath": "/Users/user/Documents/实验田/测试/4qkyxm4jppc/run_state.json",
    "pauseReason": "budget_exhausted"
  }
}
```

Older projection for the same detached task:

```json
{
  "task_id": "detached:dst-a330f559",
  "status": "blocked",
  "interaction_state": "running",
  "waiting_for": "background",
  "blocked_reason": "自动并行评分失败：ValueError: 未找到 provider: zai"
}
```

Interpretation:

- Latest projection says queued + running + budget paused.
- Older projection still carries a stale `zai` blocker.
- `action` is `skill_run_shell`, even though the real desired continuation is VEA scoring.
- Projection is still being used as a UI surface and a recovery source at the same time, with no single owner reconciling stale truth.

## 4. Current Ready Ownership Map

This is the current split of responsibility that causes contradictory decisions.

| Layer | Current role | Problem |
| --- | --- | --- |
| `RunCoordinator` | Starts scoped run, emits planning/final scope events | Final phase depends on mixed projection/lifecycle signals, and IPC can remain unresolved when turn finalization fails |
| `TurnEngine` | Does skill detection, tool loop, budget, lifecycle patching | Too many decisions live here; active context exists but does not fully drive route, typed action preference, and finalization |
| `active-skill-context.ts` | Resolves supervisor/projection/task-run/reference hint context | Correctly identifies VEA, but is advisory instead of authoritative |
| `skill-task-supervisor.ts` | Reads detached/task-run/run_state/projection signals | Still treats some file statuses as liveness without enough process/heartbeat reconciliation |
| `skills-tools.ts` | Builds and dispatches skill tools | Tool visibility and dispatch context are closer now, but execution still falls back to shell instead of deterministic resume |
| `skill_read_artifact` | Reads per-skill artifact root | Cannot read active external output dirs, even when they are the current task's durable artifacts |
| `task-projection-sync.ts` | Persists task cards | Can preserve stale blocker/status combinations and duplicate projections for one durable task |
| Renderer task cards | Display task/projection state | Can show background/running/budget states even when backend is stopped or IPC is still pending |
| VEA scripts | Produce run_state, scene_scores, host_batches | Current `run_state.status=running` can outlive the process; scoring completion must be derived from real score fields/receipts, not template records |

## 5. CC-Source Reference Pattern

CC-Source's useful lesson is not a file-for-file implementation and not only one "ownership pattern." The important difference is that the loop, tool context, terminal reason, and subtask execution form one chain.

### 5.1 L1 — One Query State Owns The Turn

CC-Source keeps the active query state inside one generator loop. The loop receives model output, records tool-use blocks, executes tools, appends tool results, then either continues with a new state or exits with a reason.

The key property: "continue vs terminal" is owned by the same loop that owns messages and `toolUseContext`.

### 5.2 L2 — Terminal Reasons Are Explicit

The CC-style loop does not rely on "no more text" or "budget ended" as implicit completion. Stop reasons, hook stops, max-turns, interruptions, and tool-driven exits are represented as explicit terminal events.

The key property: UI finalization and persistence consume a terminal reason, not scattered booleans.

### 5.3 L3 — Tools Declare Behavior In One Contract

CC-Source's `Tool` contract centralizes behavior such as:

- schema and validation
- permission checks
- read-only/destructive checks
- concurrency safety
- interrupt behavior
- result mapping
- context modification

The key property: tool visibility, execution, concurrency, and permission behavior are not inferred by string-prefix checks in several layers.

### 5.4 L4 — Tool Results Can Modify The Next Context

`CC-Source/src/services/tools/toolExecution.ts` lets a tool result carry a `contextModifier`. `CC-Source/src/services/tools/toolOrchestration.ts` then applies those modifiers back into `ToolUseContext`, serially for non-read-only tools and in deterministic order after concurrent read-only batches.

The key property: tools are not just side effects; a tool can return structured changes that become the next loop's context.

### 5.5 L5 — Skill/Subtask Work Forks A Real Loop

`CC-Source/src/tools/SkillTool/SkillTool.ts` executes forked skills through `runAgent(...)`. `runAgent.ts` then calls `query(...)` with its own `toolUseContext`, messages, system prompt, and max-turn handling.

The key property: a complex skill is not merely an inline prompt inserted into the parent turn. It can run in a nested loop with its own state and tool context, while the parent receives progress and a final result.

### 5.6 Ready Gap Summary

| CC-Source lesson | Ready current state | Route decision |
| --- | --- | --- |
| L1 one query state | Ready has pieces in `TurnEngine`, supervisor, projection, and tool policy | introduce `TurnFrame` as the per-turn owner |
| L2 terminal reasons | Ready can exhaust budget without clean UI finalization | make terminal reason mandatory before returning |
| L3 tool contract | Ready still has duplicated gates and dispatch assumptions | first align tool policy with `TurnFrame`; full contract can follow |
| L4 context modifiers | Ready tools mostly return text/side effects | later move config fixes, artifact roots, and task handles into frame patches |
| L5 forked skill loop | Ready long skills are mostly resumed inside parent loop | later run long skill continuations as child loops or detached frame-owned work |

## 6. Target Ready Pattern

Ready should not copy CC-Source's CLI skill loader. Ready should copy the main-loop shape:

```text
RunCoordinator
  -> TurnEngine
    -> build TurnFrame
    -> derive tool policy and steering from TurnFrame
    -> run model/tools or a deterministic action
    -> apply frame patches from tool results
    -> reconcile liveness/progress once
    -> commit projection/task truth once
    -> finalize with an explicit terminal reason
```

### 6.1 New Central Object: TurnFrame

Every turn should build one `TurnFrame` before tool policy is finalized. A skill is one possible slice of that frame.

Minimum shape:

```ts
interface TurnFrame {
  ids: {
    sessionId: string
    requestId: string | null
  }

  userIntent: 'start' | 'continue' | 'repair_config' | 'inspect' | 'cancel' | 'unknown'

  skill: null | {
    skillId: string
    skillName: string | null
    source: 'explicit' | 'supervisor' | 'projection' | 'task_run' | 'reference_hint'
    confidence: number
    taskRunId: string | null
    detachedTaskId: string | null
    outputDir: string | null
    runStatePath: string | null
    artifactPaths: {
      sceneScoresPath: string | null
      deliveryReportPath: string | null
    }
  }

  liveness:
    | 'running_process'
    | 'recent_progress'
    | 'recoverable_paused'
    | 'blocked'
    | 'ready_to_resume'
    | 'done'
    | 'failed'
    | 'unknown'

  progress: {
    stage: string | null
    totalUnits: number | null
    completedUnits: number | null
    coverageRatio: number | null
    fingerprint: string | null
  }

  steering: {
    mode: 'none' | 'ask_model' | 'force_tool' | 'checkpoint' | 'finish'
    requiredToolName: string | null
    preferredToolNames: string[]
    systemReminder: string | null
  }

  toolPolicy: {
    allowedToolNames: string[]
    exposedPrimitiveTools: string[]
    dispatchContextId: string | null
  }

  budget: {
    leaseEndIteration: number | null
    hardCapIteration: number | null
    exhausted: boolean
  }

  terminalReason: TurnTerminalReason | null
}
```

This should supersede ad hoc combinations of:

- `referenceSkillHintArmed`
- `preferredSkillToolNames`
- `hasActiveSkill`
- `continuationProjection`
- stale projection blockers
- supervisor-only snapshot status
- current `run_state.status`
- renderer "thinking" state

### 6.2 Terminal Reasons Must Be Explicit

Every turn must end with exactly one terminal reason before `agent:sendScoped` resolves.

Initial reason taxonomy:

| Reason | Meaning |
| --- | --- |
| `done` | Work is truly complete and close is allowed |
| `checkpoint_budget` | Current turn budget ended but work is recoverable |
| `checkpoint_background` | Work is running outside this turn with a durable handle |
| `checkpoint_user_input` | Waiting for user input or confirmation |
| `blocked_config` | Config validation failed and needs repair |
| `blocked_tool_error` | Recoverable tool error blocked the next action |
| `failed_skill` | Skill failed terminally |
| `cancelled_user` | User cancelled |
| `cancelled_runtime` | Runtime cancelled or aborted the turn |
| `infra_error` | Infrastructure failure prevented reliable completion |

Budget exhaustion is never `done`. It is usually `checkpoint_budget`; if a detached worker is still alive, it can be `checkpoint_background`.

### 6.3 Main Loop State Machine

The Ready main loop should follow this order:

1. Resolve durable identity into `TurnFrame.skill`.
2. Reconcile liveness from process, pid, heartbeat, run_state, detached tracker, task run, and projection.
3. Rebuild progress from real artifacts.
4. Validate config only when config is relevant to the next action.
5. Choose steering: ask the model, force one tool/action, checkpoint, or finish.
6. Build tool visibility and dispatch context from the same frame.
7. Execute a model tool batch or deterministic action.
8. Apply any structured frame patches from tool results.
9. Commit projection/task-run truth once.
10. Finalize the user turn with `terminalReason`.

The renderer must leave "thinking" when any terminal reason is emitted.

## 7. Route Stages

The earlier "freeze failure first" idea is folded into each stage's verification. The authoritative route is seven stages plus one architecture shift: `TurnFrame` ownership and explicit terminal reasons.

### Stage 1: Terminal Closure + Minimal TurnFrame

**Purpose:** Stop the visible deadlock first, while introducing the frame owner needed to avoid another local patch.

**Scope:**

- Build the minimal `TurnFrame` at turn start.
- Budget exhaustion must resolve as `checkpoint_budget` or `checkpoint_background`.
- `RunCoordinator` must emit a final scope event even when final assistant text is empty.
- Renderer must clear "thinking" on every terminal reason.
- Use the current VEA fixture to prove the frame identifies the skill and output dir, but does not claim background work is running when the process is gone.

**Key files:**

- `src/main/modules/agent-control/turn-engine.ts`
- `src/main/modules/agent-control/run-coordinator.ts`
- `src/main/modules/agent-control/runtime.ts`
- `src/main/modules/agent-control/active-skill-context.ts`
- `src/renderer/stores/useAgent.ts`
- `src/renderer/modules/agent/scopeRunState.ts`

**Verification:**

- The VEA budget-exhausted turn exits with a terminal reason.
- No `agent:sendScoped start` remains without `done` or `failed`.
- Active VEA context is present in the frame.
- UI leaves "思考中" even if the task only checkpoints.

### Stage 2: Frame Resolver And Identity Priority

**Purpose:** Make one resolver decide "what task is this turn about?"

**Scope:**

- Resolve priority:
  1. explicit task/runState/outputDir
  2. supervisor snapshot
  3. blocked/running projection
  4. recoverable task run
  5. reference hint
- Stale hints cannot override a higher-confidence live/recoverable frame.
- `referenceSkillId=null` is not allowed after a supervisor/projection frame identifies a skill.
- No DB mutation in resolver; it only returns the frame.

**Key files:**

- `src/main/modules/agent-control/active-skill-context.ts`
- new or renamed frame resolver module near `agent-control`
- `src/main/modules/agent-control/skill-task-supervisor.ts`
- `src/main/modules/agent-control/continuation-state.ts`

**Verification:**

- Stale `novel-writer-system` hint plus blocked VEA chooses VEA.
- Projection-only blocked VEA still builds a skill frame.
- Supervisor snapshot with VEA artifacts builds a skill frame without reference hint.

### Stage 3: Steering And Tool Policy From The Frame

**Purpose:** Fix the real missing turn: Ready must turn the model toward the next action, not merely expose possible tools.

**Scope:**

- `preferredSkillTools` comes from frame steering, not only explicit hints.
- If the frame says "recoverable VEA scoring should resume," `skill_video_expert_pipeline` or the chosen resume action becomes preferred/required.
- `filterSkillPrimitivesBySession`, typed skill action exposure, static fallback, and dispatch all consume the same frame.
- A visible tool cannot fail dispatch because dispatch sees a different context.

**Key files:**

- `src/main/modules/tools/skill-tool-session-gate.ts`
- `src/main/modules/tools/skills-tools.ts`
- `src/main/modules/tools/skills-tools-static.ts`
- `src/main/modules/agent-control/skill-context-orchestrator.ts`
- `src/main/modules/agent-control/turn-engine.ts`

**Verification:**

- `allowedToolNames` and `preferredSkillTools` no longer contradict each other for recoverable VEA.
- `longSkillResume=true` when generic "continue" hits a recoverable long skill frame.
- Dispatch cannot return "no skill context" for a tool exposed from the same frame.

### Stage 4: Liveness And Progress Reconciliation

**Purpose:** Stop treating stale `running` strings and template records as real progress.

**Scope:**

- Reconcile process presence, pid, heartbeat, run_state, detached tracker, projection, task run, and output activity.
- Classify "recoverable but no live worker" separately from "background running."
- VEA scoring completion must count actual score fields and batch receipts, not scene templates.

**Key files:**

- `src/main/modules/agent-control/skill-task-supervisor.ts`
- `src/main/modules/tools/skill-primitives/inspect-run-state.ts`
- `src/main/modules/agent-control/skill-running-projection.ts`
- `assets/embedded-skills/video-expert-analyzer/scripts/*`
- `/Users/user/Documents/实验田/video-expert-analyzer-vnext/scripts/*` if both copies must stay aligned

**Verification:**

- Current VEA state is `ready_to_resume` or `recoverable_paused`, not `running_process`.
- `scene_scores` with 97 empty records counts as 0 scored.
- `host_batches` pending receipts do not count as completed scoring.

### Stage 5: Artifact Authority And Tool Result Context Patches

**Purpose:** Active task state should be readable through the runtime, and tools should be able to update the frame.

**Scope:**

- Keep sandboxing, but allow reads for the frame's declared active output dir/run_state/scene_scores/delivery_report.
- Prefer dedicated task artifact readers over arbitrary absolute reads.
- Add a small structured "frame patch" return path for tools such as config validation, artifact discovery, and detached launch.

**Key files:**

- `src/main/modules/tools/skill-primitives/read-artifact.ts`
- `src/main/modules/tools/skill-primitives/inspect-run-state.ts`
- `src/main/modules/tools/skill-primitives/path-sandbox.ts`
- `src/main/modules/tools/skills-tools.ts`
- `src/main/modules/agent-control/turn-engine.ts`

**Verification:**

- Reading current VEA `run_state.json` no longer produces `path_escape`.
- The model does not need shell just to read current task state.
- Tool-returned task handles or validation results are applied to the next frame.

### Stage 6: Projection Commit Through The Frame

**Purpose:** Projection becomes the display of the frame result, not a competing source of truth.

**Scope:**

- Stable projection key by detached task id, then run state path, then output dir + skill id + action.
- Supersede or merge old system short-task projections for the same output dir.
- Clear stale blockers only after validation passes.
- Terminal projections cannot keep `interaction_state=running`.

**Key files:**

- `src/main/modules/agent-control/task-projection-sync.ts`
- `src/main/modules/repositories/task-projection-repository.ts`
- `src/main/modules/agent-control/skill-task-tracker.ts`
- `src/renderer/modules/agent/taskCardViewModel.ts`
- `src/renderer/components/ready/TaskPanel.tsx`
- `src/renderer/components/agent/ChatPanel.tsx`

**Verification:**

- One current projection represents `dst-a330f559` / `4qkyxm4jppc`.
- Stale `zai` blocker no longer appears after validator success.
- No `done + running` or `queued + running + budget exhausted` contradictions remain for the same task.

### Stage 7: Deterministic Long-Skill Continuation And Diagnostics

**Purpose:** Once the frame knows the task is recoverable, Ready should either launch/resume it or checkpoint with a clear reason.

**Scope:**

- Frame steering can choose a deterministic typed action instead of another inspection loop.
- Lease/budget uses frame progress and tool history; hard cap remains only a ceiling.
- Diagnostics log one frame summary per turn: skill id, source, liveness, selected action, allowed/preferred tool mismatch, terminal reason.
- Full CC-style forked skill loops are not required in this stage, but this stage must not make them harder later.

**Key files:**

- `src/main/modules/agent-control/turn-engine.ts`
- `src/main/modules/agent-control/skill-budget-lease-controller.ts`
- `src/main/modules/agent-control/progress-scorer.ts`
- `src/main/modules/agent-control/waste-scorer.ts`
- `src/main/modules/tools/skills-tools.ts`
- `assets/embedded-skills/video-expert-analyzer/ready-skill.json`

**Verification:**

- Recoverable VEA score-batch state chooses resume/checkpoint, not repeated file inspection.
- Budget pause commits one checkpoint and exits.
- A single log slice explains why a turn chose inspect, resume, checkpoint, or fail.

## 8. What Not To Do Next

- Do not keep adding prompt text that tells the model to "continue harder".
- Do not infer "tool invisible" from `preferredSkillTools=[]`; compare against the actual `allowedToolNames`.
- Do not make `skill_run_shell` the default recovery mechanism for known task artifacts.
- Do not fix only `waitingFor`, only stale blockers, or only `preferredSkillTools` without moving them under the main frame.
- Do not trust `run_state.status=running` without process or heartbeat reconciliation.
- Do not mark config as fixed unless the validator can explain provider/model/fallback validity.
- Do not treat current task-card appearance as proof that runtime state is correct.
- Do not make VEA the architecture; use it as the regression fixture for a generic Ready main loop.

## 9. First Detailed Plan To Write From This Route

The first implementation plan should be **Stage 1 + Stage 2 together**:

1. Make every budget-exhausted skill turn finalize with an explicit terminal reason and exit the renderer thinking state.
2. Introduce the minimal `TurnFrame` resolver needed to make recovered skill context authoritative for routing.

Do not include artifact sandbox, VEA scoring restart, or projection dedupe in the first implementation plan unless the failing tests prove they are necessary to close Stage 1/2. Those belong to later plans once the main loop has a reliable entry and exit.

Suggested first-plan verification:

```bash
npx tsx --test src/__tests__/turn-engine-route.test.ts
npx tsx --test src/__tests__/skill-tool-gating-by-session.test.ts
npx tsx --test src/__tests__/task-projection-sync.test.ts
npm run typecheck
```

Manual dry check after Stage 1/2:

- Use the current blocked VEA session.
- Send "找回当前任务进度然后继续".
- Confirm logs show a `TurnFrame` with skill slice `video-expert-analyzer`.
- Confirm the turn exits as checkpoint if it cannot launch scoring yet.
- Confirm the UI leaves "思考中".
- Confirm the final message says the task is recoverable and not currently scoring.

## 10. Open Questions For Later Stage Plans

- Should active task output dirs be mounted into `skill_read_artifact`, or should Ready add a separate task-artifact primitive?
- Should VEA set `run_state.status=paused` when Ready budget pauses, or should Ready keep that state only in its own task-run/projection tables?
- Should `skill_video_expert_pipeline` resume scoring directly, or should `skill_start_detached` be the only long-running launch path?
- How much process liveness should be trusted after app restart on macOS?
- Should stale projection cleanup be immediate on validator success or delayed until the next successful resume frame?
- When should long skills move from parent-loop deterministic actions to CC-style forked child loops?

## 11. Evidence Commands Used For This Route

```bash
ps -axo pid,ppid,etime,command | rg -i "video-expert|ai_analyzer|pipeline_enhanced|openclaw_batch|4qkyxm4jppc"
rg -n "active_skill_context|tool_loop_request|allowedToolNames|turn_budget_exhausted|skill_read_artifact|path_escape|preferredSkillTools|longSkillResume|agent:sendScoped" \
  /var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T/ready-directchat.log \
  /var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T/ready-agent-metrics.log
sqlite3 -json "/Users/user/Library/Application Support/ready/ready.db" \
  "select task_id, run_id, task_type, module, task_title, status, interaction_state, waiting_for, blocked_reason, continuation_ref_json, updated_at from task_projections where task_id='task-61615c03-f09b-4393-b9ba-8c8863e7e7d9' or task_id='detached:dst-a330f559' order by updated_at desc;"
```

Primary CC-Source references:

```text
/Users/user/Documents/实验田/CC-Source/src/query.ts
/Users/user/Documents/实验田/CC-Source/src/tools/SkillTool/SkillTool.ts
/Users/user/Documents/实验田/CC-Source/src/tools/AgentTool/runAgent.ts
/Users/user/Documents/实验田/CC-Source/src/services/tools/toolExecution.ts
/Users/user/Documents/实验田/CC-Source/src/services/tools/toolOrchestration.ts
/Users/user/Documents/实验田/CC-Source/src/services/tools/StreamingToolExecutor.ts
/Users/user/Documents/实验田/CC-Source/src/Tool.ts
```
