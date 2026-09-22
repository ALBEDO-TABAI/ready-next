---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Skill Run Contract And Long Skill Ownership Implementation Plan

> **VEA superseded by 2026-04-30 child-loop route.**
>
> This plan documents the historical parent-force migration. The
> `video-expert-analyzer` long actions
> (`video_expert_pipeline` / `video_expert_ai_analyze`) no longer flow
> through the parent-force path described here — Stages A–E for VEA are
> completed-via-supersede by the child-loop runner. New child-loop work
> goes through `src/main/modules/agent-control/skill-child-runner.ts`
> (Phase 7 boundary documentation:
> `docs/architecture/skill-child-loop-boundary.md`). The `SkillRunContract`
> shape itself is preserved as the parent-facing summary of a child run;
> the migration-only `forceLoopGuard` field is fenced for non-child skills.
>
> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recoverable long skills resume from an explicit, durable run contract instead of scattered hints, stale projections, or model-side file inspection.

**Architecture:** Keep `TurnFrame` as the per-turn coordinator from `../../archive/2026-09-06/docs/superpowers/plans/2026-04-29-skill-runtime-main-loop-consolidation-route.md`, but add a durable `SkillRunContract` as the source of truth for action input, artifact roots, liveness, progress, and resume handles. Tool results may patch the current frame, but cross-turn recovery must persist through the contract and projection/task-run state, then derive deterministic `FrameAction` input from that contract.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, embedded skill manifests, Zod tool schemas, skill primitive tools, VEA as the regression fixture.

---

## 1. Why This Is A New Route

The previous route owns main-loop consolidation:

```text
docs/archive/2026-09-06/docs/superpowers/plans/2026-04-29-skill-runtime-main-loop-consolidation-route.md
```

Its Stage 5-7 target was:

- let tools patch the current frame,
- commit projections through the frame,
- make recoverable long skills choose resume or checkpoint.

The review after those stages found a deeper boundary problem. The code now has names for the pipe (`TurnFramePatch`, frame snapshots, projection truth), but the runtime still has no authoritative object that says:

- which skill run is active,
- which action should resume it,
- what exact typed action input is valid,
- which artifact roots are allowed,
- which paths and handles survive into the next turn,
- whether the next step is resume, checkpoint, repair, or finish.

That is larger than a Stage 5-7 patch. It should not be mixed into the old route because the old route is about "one main loop per turn"; this route is about "one durable long-skill run contract across turns."

## 2. Completion Standard

This route is complete when Ready can prove this chain without monkey-patching the tool registry:

```text
recoverable VEA state
  -> TurnFrame contains a SkillRunContract
  -> steering derives a concrete FrameAction
  -> force_tool uses validated action input, never {}
  -> typed action executes through the real registry
  -> tool result emits framePatch and projectionPatch
  -> next frame and projection see the same artifact paths, status, and resume handles
```

Acceptance must include a real negative path:

- If required action input cannot be built, Ready checkpoints or asks the model with a clear reminder.
- It must not force an empty typed action call.
- It must not pretend the task is done because the parent turn ran out of budget.

## 3. Assumptions

- Target worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`.
- The old route remains the source for `TurnFrame`, terminal reasons, and main-loop sequencing.
- This document starts after the Stage 5-7 review findings are accepted as valid.
- VEA is the regression fixture, not the architecture boundary.
- First implementation should be surgical: add the missing contract and producers before designing a full child-loop runtime.
- Do not add visible UI controls in this route unless a later scoped plan requires them.
- Do not use `skill_run_shell` as the default resume mechanism for a known typed skill action.

## 4. Evidence Summary

### 4.1 Confirmed Local Gaps

The current code shows the same underlying gap in several places:

| Evidence | File | Meaning |
| --- | --- | --- |
| `force_tool` creates `input: {}` | `src/main/modules/agent-control/turn-engine.ts` | The frame can require a tool, but cannot supply the tool's required input. |
| Static skill action fallback only handles thrown errors, not runtime `null` | `src/main/modules/agent-control/tool-registry.ts` | "Tool exists in static manifest" does not guarantee dispatch can execute it. |
| Continuation resume payload omits original args and action-specific paths | `src/main/modules/tools/skills-tools.ts` | The next turn cannot reconstruct a valid typed action input. |
| `ToolExecutionOutput.framePatch` is consumed but rarely produced | `src/main/modules/agent-control/turn-engine.ts`, `src/main/modules/tools/skills-tools.ts` | The Stage 5 frame-patch pipe exists mostly as a consumer with no real source. |
| `skill_read_artifact` re-resolves context instead of reading active frame roots | `src/main/modules/tools/skills-tools.ts` | Same-turn discovered artifact roots do not reliably become readable. |
| Supervisor applies liveness/progress but not handles | `src/main/modules/agent-control/turn-frame-resolver.ts` | A frame may know "recoverable" without enough information to recover. |
| Projection snapshot is thin | `src/main/modules/agent-control/turn-engine.ts` | Projection sync still infers from summary/artifacts instead of using frame truth. |
| Projection sibling query ignores `skillId` | `src/main/modules/repositories/task-projection-repository.ts` | Stable identity can merge unrelated skills that share artifact paths. |
| Targeted force-tool test monkey-patches the registry | `src/__tests__/turn-engine-force-tool-dispatch.test.ts` | The test can pass while the real registry path returns `tool_not_registered`. |

Important Stage A correction: `src/main/modules/tools/tool-executor.ts` checks registry presence before Zod input validation. Therefore the current broken path may fail with `tool_not_registered` before it ever reaches the missing-field validation. After Stage B fixes registry fallback, empty input for VEA must fail as `input_validation` with `firstPath='url'` for `skill_video_expert_pipeline` or `firstPath='sceneScoresPath'` for `skill_video_expert_ai_analyze`.

### 4.2 CC-Source Comparison

The useful CC-Source pattern is not its CLI details. The useful pattern is ownership:

- Tool results can carry context updates.
- The loop applies those updates before the next model turn.
- Forked skill/agent work owns its own context and budget.
- The parent loop does not fake a child run by repeatedly forcing incomplete tool calls.

Ready has adopted some vocabulary (`framePatch`, projection truth, steering), but not the full ownership rule:

```text
producer -> validator -> frame update -> durable contract -> next-loop input
```

That is why the current fixes look like many small bugs but point to one missing object.

## 5. Target Objects

### 5.1 `SkillRunContract`

Add one explicit contract type near the existing agent-control contracts.

Suggested home:

```text
src/main/modules/agent-control/run-contracts.ts
```

Minimum shape:

```ts
export interface SkillRunContract {
  skillId: string
  skillName: string | null
  toolName: string | null
  action: string | null
  actionInput: Record<string, unknown> | null
  originalInput: Record<string, unknown> | null
  sourceUrl: string | null
  taskRunId: string | null
  detachedTaskId: string | null
  jobId: string | null
  outputDir: string | null
  runStatePath: string | null
  artifactRoots: string[]
  artifactPaths: {
    sceneScoresPath: string | null
    deliveryReportPath: string | null
  }
  status: 'unknown' | 'running' | 'recoverable_paused' | 'blocked' | 'ready_to_resume' | 'completed' | 'failed'
  liveness: TurnFrame['liveness']
  progress: TurnFrame['progress']
  blocker: {
    reason: string | null
    stale: boolean
  }
  projectionIdentity: {
    stableKey: string | null
    supersedesProjectionIds: string[]
  }
  forceLoopGuard: {
    lastForceToolName: string | null
    lastForceInputDigest: string | null
    lastForceToolDispatchedAt: string | null
    consecutiveForceCount: number
  }
  updatedAt: string
}
```

Notes:

- `actionInput` is the validated or validate-ready input for the next typed action.
- `originalInput` keeps the user/source input that may be needed to rebuild action input.
- `artifactRoots` is the allowed read/write surface for current skill artifacts.
- `status` and `liveness` are not duplicates: status is task state, liveness is runtime observation.
- `forceLoopGuard` must live with the contract, not only in one `turn-engine.ts` local variable. Otherwise a new turn can rebuild the frame and force the same tool forever. It must compare tool name plus a stable input digest, not only tool name, so repeated identical force calls are blocked while genuinely new input can still run.
- This contract is durable enough for the next turn. It is not only a `TurnFramePatch`.

### 5.2 `FrameAction`

`TurnFrame.steering` should eventually carry the chosen action and input, not only a tool name.

Suggested shape:

```ts
export interface FrameAction {
  mode: 'none' | 'ask_model' | 'force_tool' | 'checkpoint' | 'finish'
  toolName: string | null
  input: Record<string, unknown> | null
  inputDigest: string | null
  reason: string
  missingInputs: string[]
}
```

Rules:

- `force_tool` requires non-null `toolName` and non-null `input`.
- If required input cannot be built, choose `checkpoint` or `ask_model`.
- Empty input is valid only when the tool schema accepts it.

### 5.3 `TurnFramePatch`

`TurnFramePatch` remains useful, but only for current-turn updates:

- discovered handles,
- artifact roots,
- liveness hints,
- status/progress updates,
- validation results.

It must not be treated as the durable run contract by itself. It is the update message; `SkillRunContract` is the state that survives.

Ready must also store the patch's live fields on the frame. Current code already merges `activeArtifactRoots` and `configValidation`, but `applyTurnFramePatch` does not put them anywhere durable on `TurnFrame`. Stage D must add explicit frame slots for these fields before producer work can count as complete.

### 5.4 Durable Source Model

Do not add a new `skill_run_contracts` table in this route. The first version of `SkillRunContract` should be a read model built from existing durable sources:

| Source | Contract fields |
| --- | --- |
| `<outputDir>/run_state.json` | progress, stage, run state path, output dir, source url when present, status |
| `task_projection_records` / projection rows | task identity, continuation ref, blocker, resumable actions, recent artifact paths |
| `SkillTaskSupervisorSnapshot` | liveness, progress, task/detached handles, artifact paths |
| session continuity / reference-skill hint | skill id, skill name, original source context |

Suggested API:

```ts
export function loadSkillRunContract(params: {
  scopeId?: string | null
  sessionId?: string | null
  skillId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  supervisorSnapshot?: SkillTaskSupervisorSnapshot | null
}): SkillRunContract | null
```

Writers remain the existing producers: typed actions, detached tracker, supervisor, projection sync, and primitive tools. The contract loader normalizes those facts into one object for the next turn.

### 5.5 CC-Source Rules To Copy

The additional CC-Source rules worth copying are behavioral, not file shapes:

1. **Context updates have ordered application.** CC-Source queues tool `contextModifier`s from concurrent read-safe batches and applies them in original tool-call order before the next model turn. Ready's `framePatch` path must define the same rule: contract/frame mutating patches are serialized, or delayed and applied in tool-call order, never in completion order.
2. **Preflight and execution share one admission path.** A forced `FrameAction` must use the same registry, schema, and validation path that `tool-executor` will use. Do not add a separate hand-written validator for force dispatch.
3. **Long child work has its own transcript/state.** CC-Source records subagent sidechain transcript and metadata before the child loop runs, then resumes from that transcript. Ready's later child runner should persist a child run log or transcript-like state; parent projection is only a summary surface.
4. **Every tool use must close cleanly.** CC-Source synthesizes missing tool results on abort to avoid orphan `tool_use` state. Ready forced actions and future child-loop calls must always end as a structured tool result, checkpoint, cancellation, or failure, then drain registered cleanup.

## 6. Implementation Stages

### Stage A: Lock The Contract With Failing Tests

**Purpose:** Prove the current failure without test-only registry monkey patches.

**Files:**

- Modify: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`
- Create or modify: `src/__tests__/skill-run-contract-continuation.test.ts`
- Modify: `src/__tests__/skill-inspect-run-state-vea-contract.test.ts`

- [ ] **Step A1: Add a real-registry registration regression**

Create a test that uses `defaultToolRegistry` and real skill action schemas. The fixture should put VEA into a recoverable paused score-batch state and assert the chosen forced action is registered.

Expected current result:

```text
FAIL with tool_not_registered if runtime manager lookup returns null and static fallback is not used.
```

- [ ] **Step A2: Add a schema-specific empty-input assertion**

Assert that a forced typed action never dispatches with `{}` when its schema requires `url`, `sceneScoresPath`, or another required field.

Expected current result after registry fallback is available:

```text
FAIL as input_validation.
For skill_video_expert_pipeline: firstPath is "url".
For skill_video_expert_ai_analyze: firstPath is "sceneScoresPath".
```

- [ ] **Step A3: Add a next-frame artifact continuity assertion**

After a typed action or inspect result discovers `sceneScoresPath`, assert the next frame sees the same path without re-guessing from summary text.

Expected current result:

```text
FAIL because framePatch producers are missing or roots are re-resolved elsewhere
```

- [ ] **Step A4: Add a restart/rebuild contract fixture**

Create a fixture that reads an existing or synthetic `run_state.json` plus projection/supervisor facts, then rebuilds `SkillRunContract` without relying on in-memory turn locals.

Expected current result:

```text
FAIL because SkillRunContract and loadSkillRunContract do not exist yet.
```

- [ ] **Step A5: Run the narrow tests**

Run:

```bash
npx tsx --test src/__tests__/turn-engine-force-tool-dispatch.test.ts src/__tests__/skill-run-contract-continuation.test.ts src/__tests__/skill-inspect-run-state-vea-contract.test.ts
```

Expected before implementation:

```text
At least one assertion fails on real registry, empty input, or missing continuity.
```

### Stage B: Normalize Skill Action Registry And Schemas

**Purpose:** Make "static skill action exists" and "dispatch can execute skill action" mean the same thing.

**Files:**

- Modify: `src/main/modules/agent-control/tool-registry.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/tools/schemas/index.ts` if schema registration needs a static bridge
- Modify: `src/main/modules/tools/skills-tools-static.ts` if static manifest schema metadata needs to be exposed
- Test: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`

- [ ] **Step B1: Fix `null` fallback**

When runtime manager lookup returns `null`, fall back to the boot-safe static skill tool table exactly as the thrown-error path does.

- [ ] **Step B2: Ensure schema source matches the fallback**

If a static skill action is used for execution, schema lookup must use the same manifest/action source.

- [ ] **Step B3: Remove or narrow monkey patching from the force-tool test**

Keep test-specific fixtures, but do not replace the registry method that the production path needs to prove.

- [ ] **Step B4: Run registry tests**

- [ ] **Step B5: Add static schema fallback**

`getSkillActionSchemas()` currently returns `{}` when the runtime manager is unavailable. If execution falls back to a boot-safe static skill action, input schema lookup must also fall back to the static manifest-derived Zod schema. Otherwise the action can dispatch without required-field validation.

- [ ] **Step B6: Run registry tests**

Run:

```bash
npx tsx --test src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Expected:

```text
PASS, and no `tool_not_registered` for a valid static VEA action.
```

### Stage C: Build `SkillRunContract`

**Purpose:** Preserve all information required to resume a long skill.

**Files:**

- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/agent-control/turn-frame.ts`
- Modify: `src/main/modules/agent-control/turn-frame-resolver.ts`
- Modify: `src/main/modules/agent-control/skill-task-supervisor.ts`
- Modify: `src/main/modules/agent-control/session-continuity.ts` if original source context must be read
- Modify: `src/main/modules/tools/skills-tools.ts`
- Test: `src/__tests__/skill-run-contract-continuation.test.ts`

- [ ] **Step C1: Define the contract type and loader**

Add `SkillRunContract`, helper normalizers, and `loadSkillRunContract(...)` in `run-contracts.ts`. The loader is a read model over run state, projection rows, supervisor snapshots, and session continuity. It should not create a new table.

- [ ] **Step C2: Store the contract on the frame**

Add a nullable `runContract` or equivalent field under `TurnFrame.skill`.

- [ ] **Step C3: Build contract from durable sources**

Use the loader to rebuild the contract from:

- run state files,
- projection/task-run state,
- supervisor snapshots,
- reference-skill/session continuity hints.

- [ ] **Step C4: Patch contract from typed action results**

When a typed skill action returns or observes output paths, include:

- skill id,
- action,
- tool name,
- original input,
- validated or rebuildable action input,
- output dir,
- run state path,
- scene scores path,
- delivery report path,
- task/detached/job handles,
- artifact roots,
- status/liveness/progress.

- [ ] **Step C5: Build contract from supervisor/task-run snapshots**

Supervisor reconciliation should not only update liveness/progress. It should also copy durable handles into the frame contract when it has them.

- [ ] **Step C6: Add force-loop guard state**

Move cross-turn force-loop guard state into the contract. `turn-engine.ts` may keep per-iteration locals, but repeated forced action decisions across turns must be visible through `SkillRunContract.forceLoopGuard`. The guard key is `(toolName, inputDigest)`, not tool name alone.

- [ ] **Step C7: Run contract tests**

Run:

```bash
npx tsx --test src/__tests__/skill-run-contract-continuation.test.ts src/__tests__/skill-inspect-run-state-vea-contract.test.ts
```

Expected:

```text
PASS with sceneScoresPath, outputDir, runStatePath, and action input preserved.
```

### Stage D: Add Real `framePatch` Producers

**Purpose:** Connect the declared Stage 5 pipe to actual tool outputs.

**Files:**

- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/tools/skill-primitives/inspect-run-state.ts`
- Modify: `src/main/modules/tools/skill-primitives/patch-config.ts`
- Modify: `src/main/modules/tools/skill-primitives/read-artifact.ts`
- Modify: `src/main/modules/agent-control/turn-frame.ts`
- Modify: `src/main/modules/agent-control/tool-parallelism-policy.ts` if any frame-patching tool is reclassified as read-only later
- Modify: `src/main/modules/agent-control/tool-result-types.ts`
- Test: `src/__tests__/turn-frame-patch.test.ts`
- Test: `src/__tests__/skill-read-artifact-frame-roots.test.ts`

- [ ] **Step D1: Add frame slots for patch state**

Add explicit `TurnFrame` storage for `activeArtifactRoots` and `configValidation`, then update `applyTurnFramePatch` so those fields survive for same-turn steering and dispatch. Without this, producers can return valid patches and `skill_read_artifact` still cannot consume them.

- [ ] **Step D2: Emit frame patches from typed skill actions**

When a skill action discovers handles, roots, liveness, progress, or artifact paths, return `framePatch` beside `projectionPatch`.

- [ ] **Step D3: Emit frame patches from `skill_inspect_run_state`**

Return `skillStatusUpdates`, `activeArtifactRoots`, liveness/progress, blocker state, and artifact paths.

- [ ] **Step D4: Emit frame patches from `skill_inspect_detached`**

Return detached/job handles, status, liveness, output paths, and artifact roots.

- [ ] **Step D5: Emit frame patches from config validation**

`skill_patch_config` should return validation status and blocker-clearing information in `framePatch`, not only plain `data`.

- [ ] **Step D6: Emit frame patches from `skill_start_detached`**

Return detached/job handles, output paths inferred from params, and `livenessHint: 'running_process'`.

- [ ] **Step D7: Emit terminal patches from `skill_cancel_detached`**

Cancellation is part of the long-skill lifecycle. When cancellation succeeds, return status/liveness information so the frame and projection do not keep showing recoverable/running work.

- [ ] **Step D8: Make artifact reads use active frame roots**

`skill_read_artifact` should prefer the active `TurnFrame` artifact roots for the current turn before re-resolving context.

- [ ] **Step D9: Lock frame-patch ordering and parallelism**

Frame/contract mutating skill tools must stay serialized unless the runtime queues their patches and applies them in original tool-call order. Add a regression that two synthetic patches merge deterministically by tool-call order and that no frame-mutating skill primitive is accidentally marked read-only parallel-safe.

- [ ] **Step D10: Run frame-patch tests**

Run:

```bash
npx tsx --test src/__tests__/turn-frame-patch.test.ts src/__tests__/skill-read-artifact-frame-roots.test.ts
```

Expected:

```text
PASS with same-turn discovered roots readable without shell fallback.
```

### Stage E: Replace Empty Forced Calls With Contract-Derived Input

**Purpose:** Make deterministic continuation safe and useful.

**Files:**

- Modify: `src/main/modules/agent-control/turn-frame-steering.ts`
- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/agent-control/turn-frame.ts`
- Test: `src/__tests__/turn-frame-steering-force-tool.test.ts`
- Test: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`

- [ ] **Step E1: Add `FrameAction` to steering**

Preserve existing `requiredToolName` compatibility if needed, but make the new source of truth include `toolName`, `input`, `reason`, and `missingInputs`.

- [ ] **Step E2: Derive input from `SkillRunContract`**

For VEA score-batch resume, derive the input from the contract. Minimum expected fields should include whichever of these the action schema requires:

- `sceneScoresPath`,
- `deliveryReportPath`,
- `outputDir`,
- `runStatePath`,
- original `url` or source path,
- task/detached/job handle.

- [ ] **Step E3: Validate before dispatch**

Before creating a forced `TurnToolCall`, validate the input against the target tool schema.

This preflight must call the same registry/schema path that `tool-executor` uses. It may not maintain a separate schema map or hand-written VEA-only validator.

- [ ] **Step E4: Checkpoint instead of forcing if input is incomplete**

If validation cannot pass, emit a checkpoint/ask-model action with a clear reminder. Do not dispatch `{}`.

- [ ] **Step E5: Standardize missing-input reasons**

Use `reason: 'missing_<schemaPath>'` for missing required action fields. This makes downstream logging and user-facing checkpoint copy deterministic.

- [ ] **Step E6: Run deterministic continuation tests**

Run:

```bash
npx tsx --test src/__tests__/turn-frame-steering-force-tool.test.ts src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Expected:

```text
PASS; forced VEA action has valid input or cleanly checkpoints.
```

### Stage F: Make Projection A Consumer Of Contract Truth

**Purpose:** Stop projection from re-inferring state that the frame already knows.

**Files:**

- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Modify: `src/main/modules/repositories/task-projection-repository.ts`
- Test: `src/__tests__/task-projection-sync.test.ts`
- Test: `src/__tests__/task-projection-supersede.test.ts`

- [ ] **Step F1: Enrich projection frame snapshot**

Include contract fields such as:

- `sceneScoresPath`,
- `deliveryReportPath`,
- `status`,
- `liveness`,
- `progress`,
- `terminalReason`,
- action input summary,
- stable identity fields.

- [ ] **Step F2: Prefer frame snapshot in projection sync**

Projection sync should consume frame truth first and use summary/artifact heuristics only as fallback.

- [ ] **Step F3: Include `skillId` in sibling lookup and stable identity**

Fix sibling projection matching so artifact path overlap is scoped by skill identity. Projection identity should follow the CC-Source lesson: prefer intrinsic typed identity over path-only inference. Artifact overlap can be a hint, not the identity by itself.

- [ ] **Step F4: Add cross-skill non-supersede regression**

Two different skills with overlapping output paths must not supersede each other unless their stable skill identity also matches.

- [ ] **Step F5: Run projection tests**

Run:

```bash
npx tsx --test src/__tests__/task-projection-sync.test.ts src/__tests__/task-projection-supersede.test.ts
```

Expected:

```text
PASS with no false merge between different skills sharing artifact paths.
```

### Stage G: Mark The Child-Loop Boundary

**Purpose:** Keep the first repair small while making the next ownership step explicit in both code and docs.

**Files:**

- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/agent-control/skill-task-supervisor.ts`
- Create: `docs/architecture/skill-child-loop-boundary.md`
- Possible later create: `src/main/modules/agent-control/skill-child-runner.ts`
- Possible later create: `src/main/modules/agent-control/skill-run-contract-store.ts`

- [ ] **Step G1: Add code boundary markers**

Add `// TODO(skill-child-loop):` comments at the parent-loop forced dispatch, typed action wait/result handling, and supervisor reconciliation boundary. Each comment should state what will move to a child runner later.

- [ ] **Step G2: Document what remains parent-loop owned**

For this route, parent-loop deterministic continuation can call one validated typed action and then checkpoint or finish.

- [ ] **Step G3: Document what must become child-loop owned later**

Long-running skill sequences with their own budget, repeated tool use, and internal checkpoints should move to a child loop or detached runner.

- [ ] **Step G4: Add `skill-child-loop-boundary.md`**

Capture the future architecture boundary using CC-Source `runAgent` as a reference pattern, without implementing the child-loop runtime in this route. The doc must include: child-owned loop, child-owned transcript/run log, parent projection as summary only, resume from child state, and root-level task cleanup/abort semantics.

- [ ] **Step G5: Add a guardrail test**

Add a test that budget exhaustion with a recoverable skill produces `checkpoint_budget` or `checkpoint_background`, never `done`.

Run:

```bash
npx tsx --test src/__tests__/turn-frame-summary-log.test.ts src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Expected:

```text
PASS with explicit terminal reason.
```

- [ ] **Step G6: Add orphan-result cleanup guardrail**

Add a negative test or architecture assertion that a forced action or future child-loop call interrupted mid-flight still emits one structured close event: checkpoint, cancellation, tool error, or failure. The parent turn must not leave an unresolved synthetic tool call or a task card that remains "thinking" with no terminal reason.

## 7. Full Verification Gate

After stages A-F pass narrowly, run:

```bash
npm run typecheck
git diff --check
npx tsx --test \
  src/__tests__/turn-frame-patch.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts \
  src/__tests__/turn-frame-steering-force-tool.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/skill-run-contract-continuation.test.ts \
  src/__tests__/skill-inspect-run-state-vea-contract.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/turn-frame-summary-log.test.ts
```

Expected:

```text
typecheck passes
diff check passes
targeted tests pass
```

Run full tests only after the targeted chain is green:

```bash
npm test
```

Known prior full-suite noise must be separated from regressions. Do not hide a new failure behind existing unrelated failures.

## 8. Non-Goals

- Do not rewrite VEA internals unless a contract test proves VEA output itself is missing required data.
- Do not introduce a visible user-facing control for continuation in this route.
- Do not make `skill_run_shell` the default recovery lane for typed long skills.
- Do not keep adding prompt reminders as the primary fix.
- Do not treat `framePatch` as durable storage.
- Do not add a `skill_run_contracts` table in this route; build the first contract as a read model over existing durable sources.
- Do not leave cross-turn force-loop state only in `turn-engine.ts` locals.
- Do not implement a full child-loop runner before the contract and forced-action input path are working.
- Do not broaden projection cleanup beyond the identity and state fields required by this route.

## 9. Handoff Notes For The Next Implementer

The repair order matters:

1. Prove real registry + non-empty input failure first.
2. Make dispatch and schema lookup agree.
3. Add the contract read model and force-loop guard.
4. Add the framePatch producer inventory.
5. Make forced continuation consume the contract.
6. Enrich projection from frame truth.
7. Mark the child-loop boundary in code/docs before considering a real child runner.

If a later review finds another missing field, add it to `SkillRunContract` and its producer tests first. Do not patch only the consumer that happened to fail.
