# Skill Runtime Child-Loop Architecture Implementation Plan

> **Status (2026-04-30):** Phases 1–7 of this plan landed at commit
> `452f01a`, but landed the *shape* not the full *ownership* migration.
> The remediation series at
> `docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-remediation.md`
> (commits `c58e314` → `4b7e359`, T1–T9 of meta-plan
> `~/.claude/plans/bubbly-floating-mccarthy.md`) closed the residual
> gaps: parent steering no longer surfaces typed VEA actions when
> `childRunId` is set; the runner's single-flight reuse is gated on
> in-memory liveness; terminal close events are durable; child internal
> dispatches share the public Zod admission contract; live tool context
> is seeded from the active frame; contract lookup is exact-first; the
> RSS visual chain is proven against the real `videoExpertChildDriver`,
> not a stub.
>
> Treat this document as the architectural reference for *what was
> built*. For *what was missing and how it was repaired*, see the
> remediation doc and `docs/architecture/skill-child-loop-boundary.md`
> §0 (authoritative boundary statement) and §5.4 (closure table).

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace parent-turn forced skill resumption with child-owned long-skill runs that have their own identity, state, transcript/log, cancellation, budget, and close event.

**Architecture:** Long-running skills must run under a `SkillChildRun` boundary. The parent turn decides whether to launch, resume, wait, cancel, or surface status; the child runner owns internal stage selection, retries, durable state, and tool/action execution. Tool admission and live context updates move ahead of the child runner so the new runtime does not inherit the old split-schema and delayed-frame hazards. Existing `SkillRunContract` remains as the parent-facing summary during migration, but the parent must stop guessing the next VEA action.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, Ready skill runtime, existing `skill_task_runs` and task projection stores, VEA `run_state.json`, Zod tool schemas, existing skill action registry, targeted `node --test` / `npx tsx --test` suites.

---

## 1. Verdict

This is a new architecture route, not a closure-fix plan.

The latest findings are not seventeen unrelated misses. They all come from one wrong ownership model:

```text
parent turn loop tries to resume a long skill by synthesizing one more typed tool call
```

That model is the broken main pipe. It creates pressure everywhere else:

- parent steering must guess `video_expert_pipeline` vs `video_expert_ai_analyze`;
- force-loop guard has to survive across turns even though force dispatch should not exist for child-owned work;
- `run_state.json`, supervisor, projections, and frame patches all race to describe the same task;
- tests can pass by proving parts exist while the real runtime path still fails.

The next route is therefore:

```text
long skill = child-owned run
parent turn = launch/resume/cancel/status observer
```

Do not extend the old parent-force design unless a task below explicitly calls it a migration shim.

## 2. Corrections To The Draft Discussion

The prior draft direction is right, but four details need tightening before implementation.

### 2.1 "Child agent" means child-owned run, not always an LLM loop

CC-Source's `runAgent` is the reference boundary: a child owns its own loop, transcript, tools, abort controller, and close event. Ready should copy that ownership boundary, not blindly start a second model loop for every skill.

For VEA, the first child implementation should be a host-managed child runner:

- it calls existing skill actions internally;
- it reads and writes VEA-owned `run_state.json`;
- it records an append-only child run log;
- it emits one structured close event.

Only future skills that truly need multi-turn model reasoning should run an internal LLM query loop.

### 2.2 `run_state.json` remains child-owned truth for VEA

The draft says sidechain transcript is the only recovery source. That is too broad for Ready.

For VEA:

- `run_state.json` is the internal resume state;
- child-run JSONL is the audit/event log;
- child-run metadata links the run id to output paths, action inputs, and close events;
- parent projection is only a summary.

For a future LLM child skill:

- transcript may become the child-owned resume source;
- parent still must not parse it mid-run.

The shared rule is: parent reads a child summary, not the child's internal transcript or stage machine.

### 2.3 Keep `SkillRunContract`, but demote it

The existing `SkillRunContract` work is not all waste. It should become the parent-facing summary of a child run:

- useful: skill id, output dir, run-state path, artifact paths, progress, liveness, projection identity;
- temporary: `forceLoopGuard`, parent `FrameAction`, default resume action logic;
- forbidden long-term: parent selecting the next internal VEA action.

Do not delete contract plumbing first. Build child-owned execution, switch VEA to it, then remove force-only fields.

### 2.4 Do not orphan existing VEA work

Migration should not intentionally drop recoverable work.

If an old projection or `skill_task_runs` row has `outputDir` or `runStatePath`, the new runner must create a new child run that references those legacy handles and resumes from the child-owned state file. Only rows without usable handles may be marked non-resumable.

## 3. Architecture Rules

These are non-negotiable acceptance rules for the route.

1. **Long tasks own their loop.** Parent turns do not synthesize repeated typed action calls to push a long skill forward.
2. **Parent sees handles and close events.** Parent state is `childRunId`, `outputFile`, `status`, `progress`, `cancel/resume handles`, and a single close event.
3. **Child owns internal state.** VEA stage, retry, batch scoring, finalize readiness, and exact next action live inside the VEA child driver.
4. **One tool admission path.** Tool/action schema, preflight, validation, and execution metadata must resolve through one `ToolDefinition` path.
5. **Live context is immediate; durable state is explicit.** Same-turn tool context changes must be visible before the next dependent tool. Cross-turn facts must live in child-run records, run_state, projection, or contract summary.
6. **Identity is intrinsic.** Child run ids use typed prefix plus 8 base36 chars. Artifact sibling matching is a fallback, never primary identity; when the fallback is used it must filter by `skillId` before path similarity can merge anything.
7. **Cancellation is not failure.** User stop maps to `killed` or `cancelled_user`, not `failed`.

### 3.1 Second-Pass Review Decisions

The second-pass review improves the route in three places and needs narrowing in two places.

Adopt:

- Move unified tool admission before the child runner. Current code still validates through separate `getSkillActionSchemas()` and `getToolInputSchemas()` paths, so child-run internal calls would otherwise inherit the same preflight/dispatch mismatch.
- Move live `ToolRuntimeContext` updates before agent-path integration. Same-turn roots and handles are runtime data, not next-turn-only frame rebuild data.
- Promote identity fallback repair into its own acceptance point. The current branch already rejects explicit cross-skill artifact siblings in JS, but the plan must require candidate selection to apply `skillId` before path matching rather than treating skill filtering as a late comment.
- Add runtime decisions for single-flight, session close, parent next-step hint, nested child protection, process crashes, and global concurrency.
- Add a risk register. This route is large enough that the failure modes need explicit detection signals.

Narrow:

- Do not define single-flight as `(session, skill, action)` only. That would merge two different URLs in the same session. Use a canonical child-run key derived from `scope/session + skillId + targetDigest`, where `targetDigest` prefers `runStatePath`, then `outputDir`, then source URL/input digest.
- Do not make global concurrency a user-facing configurable feature in this route. Use a constant guardrail first; expose configuration only if real usage proves it necessary.

Keep:

- Keep a separate Phase 0 for baseline failure classification. The known full-suite failures make this cheaper than debugging blind after the architecture starts moving.
- Keep VEA `run_state.json` as child-owned recovery truth. The child log is audit and future transcript material, not the source the parent parses to choose a stage.

### 3.2 Runtime Decisions Locked Before Coding

| Decision | Route answer | Why |
| --- | --- | --- |
| Duplicate launch | Single-flight by canonical child-run key. Return existing `childRunId` if the same target is already running. | Prevents duplicate ffmpeg/Python work while still allowing two different URLs in one session. |
| Session close | Closing/detaching a chat session does not kill the child run. Explicit user cancel does. App shutdown must checkpoint or abort through the child runner, not through session cleanup. | Long work should survive UI/session detachment. |
| Parent next step | `child_launched` includes `parentNextHint: 'wait_for_close_event' | 'continue_other_work'`; VEA defaults to `wait_for_close_event`. | The parent loop should checkpoint or continue intentionally, not ask the model to guess. |
| Nested child run | First version rejects nested child launches with `errorKind: 'nested_child_run_not_supported'`. Internal VEA driver calls must bypass public child-loop routing to avoid recursively launching itself. | Avoids uncontrolled recursion until one child-run level is proven. |
| Script crash | Non-zero process crash/signal/OOM maps to `terminalReason='infra_error'` and `error.kind='child_process_crashed'`; skill-declared failure maps to `terminalReason='failed_skill'`. | Keeps infrastructure crashes separate from business failures. |
| Global concurrency | Limit active VEA child runs with a constant `MAX_ACTIVE_VEA_CHILD_RUNS = 3`. Over limit returns `recoverable_paused` with `terminalReason='queued_global_concurrency'`. | Prevents local resource collapse without adding a scheduler in this route. |

## 4. Scope

### In Scope

- VEA long-running typed actions:
  - `video_expert_pipeline`
  - `video_expert_ai_analyze`
- Agent/LLM-driven use of VEA through `skills-tools.ts`.
- Product VEA visual analysis path in `src/main/modules/rss-engine/item-analysis-manager.ts`, migrated with a compatibility await helper.
- Existing `skill_task_runs` table and task projection rows as durable parent-visible state.
- Child run event log under the VEA output directory.
- Unified tool admission for static tools, dynamic skill actions, legacy force dispatch, and child-run internal calls.
- Live `ToolRuntimeContext` context modifiers for same-turn artifact roots and handles.
- Artifact sibling identity fallback tightening so `skillId` is applied before path similarity can merge tasks.
- Real-registry, real-schema end-to-end tests.

### Out Of Scope

- Converting all skills to child runs.
- Converting `lets-go-rss` retained public Python actions to child runs.
- Adding visible UI buttons.
- Replacing all `SkillsRuntimeManager.runSkill` callers at once.
- Building a generic manifest DSL before the VEA child-driver shape is proven.
- Starting an inner LLM loop for VEA unless a later test proves it is required.

## 5. Target Design

### 5.1 Child Run Ids

Add a typed id helper:

```ts
export type SkillChildRunKind = 'vea' | 'skill' | 'detached'

export function createSkillChildRunId(kind: SkillChildRunKind): string
```

Suggested prefixes:

```text
v + 8 base36 chars  video-expert-analyzer child run
s + 8 base36 chars  generic long skill child run
d + 8 base36 chars  detached process child run bridge
```

Do not use UUIDs for new child runs.

### 5.2 Child Run Record

Use existing `skill_task_runs` as the durable parent-visible table. Do not add a new top-level table for the first implementation.

The child run id should be stored in `skill_task_runs.id`. For fields that do not yet have columns, use `resumePayload.childRun` in the first PR, then add a migration only if tests show JSON fields are making queries unsafe.

Minimum child payload:

```ts
export interface SkillChildRunPayload {
  version: 1
  childRunId: string
  kind: 'vea'
  parentScopeId: string | null
  parentSessionId: string | null
  skillId: string
  skillName: string | null
  requestedAction: string
  requestedInput: Record<string, unknown>
  singleFlightKey: string
  parentNextHint: 'wait_for_close_event' | 'continue_other_work'
  outputDir: string
  runStatePath: string
  eventLogPath: string
  status: 'queued' | 'running' | 'recoverable_paused' | 'budget_paused' | 'blocked' | 'completed' | 'failed' | 'killed'
  closeEvent: SkillChildCloseEvent | null
  legacy: {
    taskRunId: string | null
    detachedTaskId: string | null
    projectionTaskId: string | null
  }
}
```

### 5.3 Child Event Log

For VEA, write append-only JSONL under:

```text
<outputDir>/.ready/child-runs/<childRunId>.jsonl
```

Each line:

```ts
type SkillChildRunEvent =
  | { type: 'started'; at: string; childRunId: string; input: Record<string, unknown> }
  | { type: 'action_started'; at: string; action: string; input: Record<string, unknown> }
  | { type: 'action_completed'; at: string; action: string; result: Record<string, unknown> }
  | { type: 'state_observed'; at: string; runStatePath: string; state: Record<string, unknown> }
  | { type: 'checkpoint'; at: string; reason: string; state: Record<string, unknown> }
  | { type: 'close'; at: string; close: SkillChildCloseEvent }
```

Parent code may store and display the log path. Parent code must not parse it to choose the next VEA step.

### 5.4 Close Event

All child runs end or pause through one close event.

```ts
export interface SkillChildCloseEvent {
  childRunId: string
  skillId: string
  status: 'completed' | 'failed' | 'killed' | 'recoverable_paused' | 'budget_paused' | 'blocked'
  terminalReason:
    | 'completed'
    | 'checkpoint_budget'
    | 'checkpoint_background'
    | 'queued_global_concurrency'
    | 'launch_stuck'
    | 'blocked_config'
    | 'blocked_external'
    | 'nested_child_run_not_supported'
    | 'cancelled_user'
    | 'failed_skill'
    | 'infra_error'
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
  progress: {
    stage: string | null
    totalUnits: number | null
    completedUnits: number | null
    coverageRatio: number | null
    fingerprint: string | null
  }
  framePatch: TurnFramePatch | null
  projectionPatch: unknown | null
  error: {
    kind: string
    message: string
  } | null
}
```

The close event replaces parent-loop repeated force dispatch for long skills.

### 5.5 Child Runner Admission Rules

- **Single-flight key:** derive from `scopeId/sessionId + skillId + targetDigest`; `targetDigest` must prefer `runStatePath`, then normalized `outputDir`, then source URL/input digest. Same key plus active status returns the existing child run. Different source URLs must create different child runs even inside the same session.
- **Session detachment:** session close removes the live UI channel only. The child run keeps its own abort controller and continues until close event, budget pause, crash, or explicit cancel.
- **Nested child guard:** child-run internal calls must pass an internal execution flag so VEA can call its own existing actions without recursively launching another child run. If a child driver tries to launch a different child-loop action through the public route, return `nested_child_run_not_supported`.
- **Concurrency guard:** first version uses `MAX_ACTIVE_VEA_CHILD_RUNS = 3` as a process-local constant. Over limit returns a recoverable close event; do not build a full queue in this route.
- **Crash semantics:** process crash, killed signal, spawn failure, or launch timeout are infrastructure failures. Skill-level run_state failure is a skill failure. They must not collapse into the same terminal reason.

## 6. File Map

### Create

- `src/main/modules/agent-control/skill-child-run-id.ts`
  - Typed child id generation and validation.
- `src/main/modules/agent-control/skill-child-run-types.ts`
  - Child payload, event, close-event, and driver interfaces.
- `src/main/modules/agent-control/skill-child-run-log.ts`
  - Append/read JSONL event log helpers.
- `src/main/modules/agent-control/skill-child-runner.ts`
  - Launch, resume, cancel, and close-event orchestration.
- `src/main/modules/agent-control/skill-child-drivers.ts`
  - Driver registry and `getSkillChildDriver(skillId)`.
- `src/main/modules/agent-control/video-expert-child-driver.ts`
  - VEA-specific child driver. Owns stage-to-action decisions.
- `src/__tests__/skill-child-run-id.test.ts`
- `src/__tests__/skill-child-run-log.test.ts`
- `src/__tests__/video-expert-child-driver.test.ts`
- `src/__tests__/skill-child-runner.test.ts`
- `src/__tests__/skill-child-run-end-to-end.test.ts`
- `src/__tests__/skill-child-single-flight.test.ts`
- `src/__tests__/skill-child-runtime-decisions.test.ts`
- `src/__tests__/rss-visual-skill-child-run.test.ts`
- `docs/superpowers/plans/2026-04-30-baseline-failure-triage.md`

### Modify

- `src/main/modules/repositories/skill-task-run-repository.ts`
  - Store and query child-run payload through `resumePayload`.
- `src/main/modules/skills-runtime/runtime-manager.ts`
  - Add a non-breaking child-run API. Keep `runSkill` direct for short actions during migration.
- `src/main/modules/tools/skills-tools.ts`
  - Route VEA long actions through `SkillChildRunner` for agent-driven calls.
- `src/main/modules/agent-control/turn-engine.ts`
  - Stop using parent `force_tool` for child-owned long skills.
- `src/main/modules/agent-control/turn-frame-steering.ts`
  - Emit child-run launch/resume/checkpoint intent instead of default VEA resume action.
- `src/main/modules/agent-control/run-contracts.ts`
  - Reinterpret contract as parent summary; add child run id and close-event summary.
- `src/main/modules/agent-control/tool-registry.ts`
  - Add the single execution schema resolver before child-run implementation depends on it.
- `src/main/modules/tools/tool-executor.ts`
  - Use the single schema resolver instead of locally merging static and dynamic schema maps.
- `src/main/modules/tools/schemas/index.ts`
  - Move static schema access behind the unified resolver.
- `src/main/modules/agent-control/tool-runtime.ts`
  - Apply context modifiers before later dependent tools; keep frame roots live.
- `src/main/modules/agent-control/tool-parallelism-policy.ts`
  - Serialize tools whose results mutate live runtime context.
- `src/main/modules/agent-control/task-projection-sync.ts`
  - Use child close event / contract summary as projection truth.
- `src/main/modules/repositories/task-projection-repository.ts`
  - Keep artifact sibling lookup as legacy fallback only; apply `skillId` candidate filtering before path similarity.
- `src/main/modules/rss-engine/item-analysis-manager.ts`
  - Replace direct await of VEA long actions with child-run start + await-close compatibility helper.
- `assets/embedded-skills/video-expert-analyzer/ready-skill.json`
  - Add child-loop metadata only after the TS VEA driver passes. Do not block Phase 1 on manifest DSL.
- `docs/architecture/skill-child-loop-boundary.md`
  - Update from "future boundary" to "implemented boundary" after integration.
- `docs/superpowers/plans/2026-04-29-skill-run-contract-long-skill-ownership-route.md`
  - Mark parent-force stages as migration history once child route lands.

## 7. Implementation Phases

### Phase 0: Baseline Failure Triage

**Goal:** Classify the existing failing test surface before architecture work starts, so new regressions are visible.

**Files:**
- Create: `docs/superpowers/plans/2026-04-30-baseline-failure-triage.md`
- Read: current failing test output

- [ ] Run the current targeted runtime chain.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-runtime-user-acceptance.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts
```

Expected: record current failures; do not fix unrelated failures in this phase.

- [ ] Run the full suite once if locally feasible.

Run:

```bash
npm test -- --runInBand
```

Expected: classify every known failure into:

- pre-existing unrelated;
- expected contract update during this route;
- new regression candidate.

- [ ] Save the classification in `docs/superpowers/plans/2026-04-30-baseline-failure-triage.md`.

### Phase 1: Child Run Primitives And Red Acceptance Tests

**Goal:** Add the durable child-run vocabulary and lock the first child-loop acceptance tests.

**Files:**
- Create: `src/main/modules/agent-control/skill-child-run-id.ts`
- Create: `src/main/modules/agent-control/skill-child-run-types.ts`
- Create: `src/main/modules/agent-control/skill-child-run-log.ts`
- Create: `src/__tests__/skill-child-run-id.test.ts`
- Create: `src/__tests__/skill-child-run-log.test.ts`
- Create: `src/__tests__/video-expert-child-driver.test.ts`
- Modify: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`

- [ ] Write id-format and collision tests.
  - Expected ids: `v[a-z0-9]{8}` for VEA, no UUIDs.
  - Expected collision behavior: generate 10,000 ids without duplicates.

- [ ] Implement typed id generation with `node:crypto.randomBytes`.
  - Use a base36-safe lowercase alphabet.
  - Prefixes: `v`, `s`, `d`.

- [ ] Write child-log tests.
  - Append `started`, `action_started`, `close`.
  - Read back in order.
  - Corrupt one line and assert read reports a structured parse warning without dropping valid later lines.

- [ ] Implement JSONL append/read helpers.
  - Create parent directories.
  - Append one compact JSON object per line.
  - Return `{ events, parseErrors }` on read.
  - Do not throw for one corrupt line unless the file itself is unreadable.

- [ ] Write the first VEA child-driver red test.
  - Fixture: `run_state.json` with `current_stage='score_batches'`, `scene_scores.json` path present, no `url`.
  - Expected: child driver selects internal `video_expert_ai_analyze`; parent must not choose `video_expert_pipeline`.

- [ ] Write the parent-loop negative red test.
  - When frame has a child-owned VEA contract, `turn-engine` must not synthesize `skill_video_expert_pipeline` with `{}`.

- [ ] Run Phase 1 tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-run-id.test.ts \
  src/__tests__/skill-child-run-log.test.ts \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Expected: id/log tests PASS; driver/parent-loop tests may remain red until later phases.

### Phase 2: Unified ToolDefinition Admission

**Goal:** Move architecture rule 4 before the child runner, so internal child calls never depend on split schema/preflight paths.

**Files:**
- Modify: `src/main/modules/agent-control/tool-registry.ts`
- Modify: `src/main/modules/tools/tool-executor.ts`
- Modify: `src/main/modules/tools/schemas/index.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/agent-control/turn-frame-steering.ts`
- Modify: `src/__tests__/tool-gateway-registry.test.ts`
- Modify: `src/__tests__/tool-input-schemas-registry.test.ts`
- Modify: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`

- [ ] Add a single schema resolver.

```ts
export function resolveToolInputSchemaForExecution(
  toolName: string,
): ZodObject<ZodRawShape> | null
```

- [ ] Make this resolver the only admission source for:
  - normal `tool-executor` dispatch;
  - legacy forced-tool preflight while legacy force still exists;
  - child-run internal action calls;
  - tests that check action schema availability.

- [ ] Keep old exports only as compatibility wrappers if needed.
  - `getToolInputSchemas()` may remain temporarily, but it must be derived from the same resolver/source.
  - `getSkillActionSchemas()` may remain temporarily for tests, but not as a second authoritative execution path.

- [ ] Replace local schema merges.
  - `tool-executor.ts` must stop building `{ ...getSkillActionSchemas(), ...getToolInputSchemas() }`.
  - `turn-engine.ts` forced preflight must stop reading only `getToolInputSchemas()[forceToolName]`.
  - `turn-frame-steering.ts` forced validation must use the same resolver.

- [ ] Register dynamic skill actions through the same `ToolDefinition` path used by static tools.
  - If dynamic metadata cannot fully become a `ToolDefinition` in this phase, add an adapter that exposes the same schema and execution metadata to the resolver.

- [ ] Run registry tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Expected: dynamic VEA action schemas and static primitive schemas validate through one path.

### Phase 3: Live ToolRuntimeContext And Context Modifiers

**Goal:** Move architecture rule 5 before agent integration, so same-turn roots and handles are immediately visible.

**Files:**
- Modify: `src/main/modules/agent-control/tool-runtime.ts`
- Modify: `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- Modify: `src/main/modules/agent-control/tool-parallelism-policy.ts`
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/tools/skill-primitives/read-artifact.ts`
- Modify: `src/__tests__/skill-tools-frame-patch-delta.test.ts`
- Modify: `src/__tests__/skill-read-artifact-frame-roots.test.ts`

- [ ] Extend runtime context with a live frame slot.

```ts
interface ToolRuntimeActiveFrameContext {
  activeArtifactRoots: string[]
  runContract: SkillRunContract | null
  discoveredHandles: Record<string, unknown>[]
}
```

- [ ] Add `contextModifier` support to tool execution output.
  - A tool result that discovers roots/handles must mutate `ToolRuntimeContext.activeFrame` before later dependent tools run.
  - Frame patches remain the end-of-turn persistence path, not the only in-turn data path.

- [ ] Serialize tools that return context modifiers.
  - If a batch contains a context-mutating tool, dependent later tools must run after it.
  - Independent non-mutating tools may still run in parallel.

- [ ] Update `skill_read_artifact`.
  - First read `ToolRuntimeContext.activeFrame.activeArtifactRoots`.
  - Fall back to `resolveActiveSkillContext` only when no active frame exists.
  - Add a TODO to delete the fallback once child-run path is stable.

- [ ] Run live-context tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-tools-frame-patch-delta.test.ts \
  src/__tests__/skill-read-artifact-frame-roots.test.ts
```

Expected: same-turn tool A discovers an artifact root; later tool B reads it without rebuilding a TurnFrame.

### Phase 4: Parent-Visible Child Store And Contract Summary

**Goal:** Reuse `skill_task_runs` as the parent-visible child-run registry and demote `SkillRunContract` to a summary.

**Files:**
- Modify: `src/main/modules/repositories/skill-task-run-repository.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Create: `src/__tests__/skill-child-runner.test.ts`
- Create: `src/__tests__/skill-child-run-migration.test.ts`

- [ ] Extend repository mapping through `resumePayload.childRun`.
  - Add helpers:
    - `createChildRun(record)`
    - `updateChildRun(childRunId, patch)`
    - `findLatestChildRunByKey(singleFlightKey)`
    - `findLatestChildRunBySkill({ sessionId, scopeId, skillId })`
  - Do not add a DB migration in this phase unless tests show JSON fields make required queries unsafe.

- [ ] Add child summary fields to `SkillRunContract`.
  - `childRunId`
  - `childStatus`
  - `parentNextHint`
  - `childCloseEvent`
  - Keep old fields intact for migration.
  - Mark `forceLoopGuard` as migration-only.

- [ ] Teach `loadSkillRunContract` to prefer active child run records.
  - If child run exists, contract action fields are summary only.
  - Parent must not derive VEA internal action from contract.

- [ ] Add legacy adoption.
  - If old rows have `outputDir` or `runStatePath`, expose them for Phase 5 to create/adopt a child run.
  - If neither exists, return `recoverable_paused` with blocker reason `no_usable_handles`.
  - Never silently mark legacy work as completed.

- [ ] Run repository/contract tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-run-contract-continuation.test.ts \
  src/__tests__/skill-task-supervisor.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-run-migration.test.ts
```

Expected: existing contract tests still pass; child-store and legacy-adoption tests pass.

### Phase 5: VEA Child Driver And Runner Lifecycle

**Goal:** Move VEA stage selection, budget, cancellation, and close-event generation inside child-owned runtime.

**Files:**
- Create: `src/main/modules/agent-control/skill-child-drivers.ts`
- Create: `src/main/modules/agent-control/video-expert-child-driver.ts`
- Create: `src/main/modules/agent-control/skill-child-runner.ts`
- Modify: `src/main/modules/skills-runtime/runtime-manager.ts`
- Modify: `src/main/modules/agent-control/runtime.ts`
- Modify: `src/__tests__/video-expert-child-driver.test.ts`
- Modify: `src/__tests__/skill-child-runner.test.ts`
- Create: `src/__tests__/skill-child-single-flight.test.ts`
- Create: `src/__tests__/skill-child-runtime-decisions.test.ts`

- [ ] Define `SkillChildDriver`.

```ts
export interface SkillChildDriver {
  skillId: string
  canStart(input: Record<string, unknown>): boolean
  canResume(contract: SkillRunContract): boolean
  createInitialState(params: SkillChildLaunchParams): Promise<SkillChildDriverState>
  planNextAction(state: SkillChildDriverState): Promise<SkillChildDriverAction | SkillChildCloseEvent>
  observeAfterAction(state: SkillChildDriverState, result: SkillRunResult): Promise<SkillChildDriverState>
}
```

- [ ] Implement VEA start planning.
  - If input has `url`, first internal action is `video_expert_pipeline`.
  - Preserve `outputDir` when provided.
  - Build `singleFlightKey` from canonical target data, not just action.

- [ ] Implement VEA resume planning.
  - If run state says `completed`, return close event `completed`.
  - If `sceneScoresPath` exists and stage is `score_batches`, `merge_validate`, `finalize`, or status is `ready_to_finalize`, plan `video_expert_ai_analyze`.
  - If state is blocked, return close event `blocked`.
  - If required path is missing, return close event `recoverable_paused` with `missing_scene_scores`.

- [ ] Implement `startSkillChildRun`.
  - Enforce `MAX_ACTIVE_VEA_CHILD_RUNS = 3`.
  - Enforce single-flight: same active key returns the existing child run.
  - Create child run id.
  - Resolve output dir before start.
  - Create `skill_task_runs` record with `status='running'`.
  - Write `started` event.
  - Start async run with its own `AbortController`.
  - Return launch acknowledgement immediately.

- [ ] Implement runner loop.
  - Ask driver for next internal action.
  - Append `action_started`.
  - Call `SkillsRuntimeManager.runSkill` internally through the unified tool admission path, with a child-internal flag to prevent recursive child launch.
  - Append `action_completed`.
  - Observe state.
  - Repeat until close event or child budget exhausted.

- [ ] Implement child budget.
  - Do not use parent turn iteration counter.
  - Budget exhaustion returns `budget_paused` or `recoverable_paused` with `terminalReason='checkpoint_background'` or `checkpoint_budget`, never `done`.

- [ ] Implement `resumeSkillChildRun`.
  - Read child payload from `skill_task_runs`.
  - Re-open output dir/run state.
  - Continue through the same driver.
  - Preserve child run id and append `resume_started`.

- [ ] Implement `cancelSkillChildRun`.
  - Abort controller if live.
  - Mark status `killed`.
  - Emit close event with `terminalReason='cancelled_user'`.
  - Do not map to `failed`.

- [ ] Implement crash and launch-stuck handling.
  - Spawn failure, signal death, OOM-like termination, or launch timeout produces `terminalReason='infra_error'`.
  - If a child run writes `started` but no `action_started` within the guard window, produce `terminalReason='launch_stuck'`.
  - Skill-declared run_state failure produces `terminalReason='failed_skill'`.

- [ ] Run lifecycle tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/video-expert-child-driver.test.ts \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts
```

Expected: new/resume/cancel/budget/crash/single-flight decisions pass without parent force dispatch.

### Phase 6: Agent Tool Path Integration And VEA Force Retirement

**Goal:** Make agent-driven VEA calls launch/resume child runs and remove VEA from legacy parent-force routing in the same phase.

**Files:**
- Modify: `src/main/modules/tools/skills-tools.ts`
- Modify: `src/main/modules/agent-control/turn-engine.ts`
- Modify: `src/main/modules/agent-control/turn-frame-steering.ts`
- Modify: `src/main/modules/agent-control/tool-runtime.ts`
- Modify: `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/__tests__/turn-engine-force-tool-dispatch.test.ts`
- Create: `src/__tests__/skill-child-run-end-to-end.test.ts`

- [ ] Add `isChildLoopSkillAction(skillId, action)` helper.
  - Initially true only for VEA long actions.
  - False for `lets-go-rss`.
  - False for short primitive tools.

- [ ] In `skills-tools.ts`, route VEA long action calls to `startSkillChildRun`.
  - Return tool result:

```json
{
  "status": "child_launched",
  "childRunId": "vxxxxxxxx",
  "outputDir": "...",
  "runStatePath": "...",
  "eventLogPath": "...",
  "parentNextHint": "wait_for_close_event"
}
```

- [ ] The returned `ToolExecutionOutput` must include `framePatch`, `projectionPatch`, and live context modifier.
  - `framePatch.runContract.childRunId`
  - `framePatch.runContract.parentNextHint`
  - `framePatch.livenessHint='running_process'`
  - `framePatch.activeArtifactRoots=[outputDir]`
  - live `contextModifier.activeFrame.activeArtifactRoots=[outputDir]`

- [ ] Change steering for child-owned VEA.
  - If a child run is active/running, parent checkpoints or waits instead of force-dispatching another typed action.
  - If a child run is recoverable and user asked to continue, parent calls child resume API, not `force_tool`.
  - `parentNextHint='wait_for_close_event'` should drive checkpoint behavior without letting the model invent the next internal VEA action.

- [ ] Delete VEA from `DEFAULT_RESUME_ACTION_BY_SKILL_ID`.
  - Keep legacy force only for non-child migration paths.
  - Fence `forceLoopGuard` so it cannot apply to child-owned VEA.

- [ ] Update force-tool tests.
  - Rename legacy cases to say "legacy force-tool".
  - Add assertion that child-owned VEA never goes through legacy force.
  - Remove monkey-patched registry acceptance for VEA child-run path.

- [ ] Run integration tests.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/turn-frame-steering.test.ts \
  src/__tests__/skill-runtime-user-acceptance.test.ts
```

Expected: child-owned VEA bypasses parent force dispatch; no VEA `force_tool` path remains live.

### Phase 7: Projection Identity, Status, Product Compatibility, And Docs

**Goal:** Finish the durable surfaces: projection identity, status semantics, RSS compatibility, migration docs, and old-route markers.

**Files:**
- Modify: `src/main/modules/agent-control/task-projection-sync.ts`
- Modify: `src/main/modules/repositories/task-projection-repository.ts`
- Modify: `src/main/modules/agent-control/skill-task-supervisor.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/main/modules/rss-engine/item-analysis-manager.ts`
- Modify: `src/main/modules/skills-runtime/runtime-manager.ts`
- Modify: `src/main/modules/migrations.ts` only if a repository field cannot be represented safely in existing columns.
- Create: `src/__tests__/rss-visual-skill-child-run.test.ts`
- Modify: `src/__tests__/skill-child-run-migration.test.ts`
- Modify: `src/__tests__/task-projection-supersede.test.ts`
- Modify: `docs/architecture/skill-child-loop-boundary.md`
- Modify: `docs/superpowers/plans/2026-04-29-skill-run-contract-long-skill-ownership-route.md`

- [ ] Projection primary key should use child run identity when present.
  - `taskId = skill-child:<childRunId>` or equivalent stable form.
  - Do not supersede by artifact path when child id exists.

- [ ] Tighten artifact sibling fallback.
  - Artifact sibling lookup remains legacy fallback only.
  - It must reject explicit different `skillId` candidates before path similarity can match.
  - Legacy rows with no recorded `skillId` remain adoptable.

SQL sketch:

```sql
SELECT *
FROM task_projections tp
WHERE tp.scope_id = ?
  AND tp.module = 'system'
  AND tp.task_type = 'short_task'
  AND tp.status NOT IN ('cancelled', 'done', 'killed', 'completed')
  AND tp.task_id NOT LIKE 'skill:%'
  AND (
    ? IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM json_each(COALESCE(tp.recent_artifacts_json, '[]')) artifact
      WHERE TRIM(COALESCE(json_extract(artifact.value, '$.meta.skillId'), '')) <> ''
        AND TRIM(json_extract(artifact.value, '$.meta.skillId')) <> ?
    )
  )
```

Then apply path/outputDir/runState sibling matching to this already skill-filtered candidate set. Do not do path matching first and skill filtering later.

- [ ] Add projection identity tests.
  - Two different skills sharing one `outputDir` do not supersede each other.
  - Same skill old short-task row and new child run can supersede/adopt.
  - Legacy row with no `skillId` and usable `outputDir/runStatePath` remains adoptable.

- [ ] Normalize statuses.
  - Child/contract/projection allowed statuses:
    - `running`
    - `completed`
    - `failed`
    - `killed`
    - `recoverable_paused`
    - `budget_paused`
    - `blocked`
    - `unknown`
  - User cancellation maps to `killed`.
  - Do not collapse `killed` into `failed`.

- [ ] Add an await helper for product callers.

```ts
await runtime.startSkillChildRunAndWait({
  skillId: 'video-expert-analyzer',
  action: 'video_expert_pipeline',
  params: { url, outputDir },
  timeoutMs,
  triggerType: 'tool',
})
```

- [ ] Migrate `item-analysis-manager.ts`.
  - Preserve current RSS visual flow await semantics.
  - Internally the long work is child-owned.
  - Pipeline and AI analyze continuation use the same child helper/resume path.
  - Do not migrate `video-copy-analyzer` in this phase.

- [ ] Update docs.
  - `docs/architecture/skill-child-loop-boundary.md` becomes implemented boundary documentation.
  - The older parent-force route plan gets a superseded marker for VEA.

- [ ] Run final targeted suite.

Run:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/skill-child-run-migration.test.ts \
  src/__tests__/task-projection-supersede.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/skill-runtime-user-acceptance.test.ts
```

Expected: RSS visual behavior is preserved, child-run projection identity is stable, and VEA parent-force route is documented as retired.

## 8. End-To-End Acceptance

The route is complete only when these scenarios pass without monkey-patching `defaultToolRegistry`.

### Scenario A: New VEA Run

Input: user asks VEA to analyze a URL.

Expected:

```text
parent turn launches child run
child run id vxxxxxxxx is created
parent receives child_launched result
child internally runs video_expert_pipeline
child writes event log and run_state
parent projection shows running/background
```

### Scenario B: Resume From `score_batches`

Fixture:

```text
outputDir exists
run_state.json current_stage=score_batches
scene_scores.json exists
no original url available
```

Expected:

```text
parent creates/resumes child run
VEA child driver chooses video_expert_ai_analyze
parent never chooses video_expert_pipeline
parent never dispatches {}
```

### Scenario C: Budget Exhausted While Child Still Has Work

Expected:

```text
child close event status=recoverable_paused
terminalReason=checkpoint_background or checkpoint_budget
projection waiting_for=background
no done terminal reason
```

### Scenario D: User Cancels

Expected:

```text
cancelSkillChildRun aborts child controller
status=killed
terminalReason=cancelled_user
UI/projection does not say failed
```

### Scenario E: Product RSS Visual Analysis

Expected:

```text
item-analysis-manager keeps await-style behavior
internally uses child runner
report generation still runs after VEA completes
failures preserve distinct failed/killed/blocked semantics
```

### Scenario F: Child Process Crash

Expected:

```text
child runner observes non-zero crash/signal/spawn failure
close event status=failed
terminalReason=infra_error
error.kind=child_process_crashed
business run_state failure still maps to failed_skill instead
```

### Scenario G: Single-Flight

Expected:

```text
same scope/session + same VEA target launches twice
second launch returns existing childRunId
only one child_task_runs row is active
different URL in same session creates a different childRunId
```

### Scenario H: Cross-Skill Shared OutputDir

Expected:

```text
two different skills reference the same outputDir
artifact sibling fallback does not merge them
same skill legacy row can still be adopted by new child run
```

## 9. Risk Register

| Failure mode | Detection signal | Fallback |
| --- | --- | --- |
| Child run row created but process never starts | Row is `running`, event log has `started`, no `action_started` inside guard window | Emit close event with `terminalReason='launch_stuck'` and `status='recoverable_paused'` |
| Legacy VEA row marked done during adoption | Migration test sees old row become `completed` without child close event | Block merge; old row must become adopted/superseded or non-resumable, never silently done |
| Single-flight race creates duplicate active child runs | Concurrent launch test creates more than one row for same single-flight key | Add repository transaction/unique guard for active key before runner launch |
| Frame patch carries child run but live context misses roots | Integration test sees `frame.runContract.childRunId` but later same-turn artifact read cannot use `outputDir` | Fix contextModifier application before adding more child-run features |
| Tool schema path splits again | Dynamic action validates in `tool-executor` but fails forced/internal preflight or vice versa | Require all paths to call `resolveToolInputSchemaForExecution` |
| Cross-skill outputDir merge | Projection supersede test with two skills and one outputDir merges records | Reject explicit different `skillId` candidates before path matching |
| Session cleanup kills background child | Closing chat session aborts child run without explicit cancel | Move abort ownership from session cleanup to child runner; session close only detaches |

## 10. Full Verification Plan

Use targeted tests first:

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

Then run typecheck:

```bash
npm run typecheck
```

Then run full test classification:

```bash
npm test -- --runInBand
```

If the full suite still has the known UI/contract failures, classify them in the implementation notes:

- pre-existing unrelated;
- expected contract update;
- new regression.

New regressions block completion.

## 11. Commit Boundaries

Use small commits:

1. `test: classify child-run baseline failures`
2. `feat: add skill child-run primitives`
3. `refactor: unify tool admission for child runs`
4. `refactor: apply live tool context modifiers`
5. `feat: store child-run summaries in skill task runs`
6. `feat: run VEA through child runner`
7. `feat: route agent VEA calls to child runs`
8. `feat: project child-run lifecycle and migrate RSS visual analysis`
9. `docs: mark child-loop boundary implemented`

Do not mix doc-only route updates with runtime behavior commits after implementation starts.

## 12. Non-Goals And Guardrails

- Do not convert `lets-go-rss` to child-loop.
- Do not add a visible UI surface.
- Do not add a generic manifest DSL before the VEA driver passes.
- Do not let parent `turn-engine.ts` parse VEA stage to choose an internal action.
- Do not map cancellation to failure.
- Do not make transcript parsing the only VEA recovery source.
- Do not keep monkey-patched registry tests as acceptance evidence.
- Do not delete legacy recovery until old `outputDir/runStatePath` adoption is tested.
- Do not dedupe child runs by `(session, skill, action)` alone; include canonical target identity.
- Do not add a full queue/scheduler in this route. The concurrency limit returns a recoverable pause.

## 13. The Final Shape

After this route lands, the user-visible story should be simple:

```text
Ready starts the long video analysis as a real background skill run.
That run owns its own progress and resume state.
The chat loop no longer guesses the next internal action.
Continuing the task resumes the same child run.
Cancelling it cancels the child run.
Projection and UI display the child run's real status.
```

That is the main pipe. The existing `SkillRunContract` and frame patches become summary and notification plumbing around it, not the place where long-skill execution logic lives.
