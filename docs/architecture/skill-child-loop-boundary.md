# Skill Child-Loop Boundary

> Status: implemented boundary as of 2026-05-07 (Stage N closes the
> parent-loop force-typed-action retirement). Last updated 2026-05-07.
>
> The Phase 1–7 child-loop *shape* landed at commit `452f01a`
> (`feat(skill): introduce child-owned long-skill runtime architecture`).
> A subsequent independent code review found that the *ownership
> migration* was incomplete: parent steering still surfaced typed VEA
> actions, the child runner false-claimed live work for inactive DB
> rows, terminal close events were memory-only, and the gateway-style
> tool admission did not yet apply to internal child dispatches. The
> remediation series (commits `c58e314` → `4b7e359`, T1–T9 of
> `~/.claude/plans/bubbly-floating-mccarthy.md`) closed those gaps.
> What this document describes is now the actual runtime behavior, not
> a future-state target.

## 0. Authoritative boundary statement (post-remediation)

When `frame.skill?.runContract?.childRunId` is set:

- Parent code MAY resume / wait / cancel / status the child via the
  child runner's public APIs.
- Parent code MUST NOT choose the next internal VEA action. The child
  driver picks the action; the runner dispatches it through the
  unified tool gateway.
- Parent prompts (`buildTurnFrameSteering`) MUST NOT surface typed
  `skill_video_expert_*` actions. A child-aware system reminder names
  the live `childRunId` so the model knows why the typed action is
  absent.
- `task_projection` is a read model. It never invents child liveness.
- `<outputDir>/run_state.json` is VEA's recovery truth. The parent
  reads handles, never the file content.
- The child's append-only JSONL log is audit, not parent decision
  input. The parent never parses it to choose VEA's next action.

## 1. Why this document exists

Today the parent turn loop in `turn-engine.ts` calls a single validated typed
skill action per turn, observes its result, then checkpoints the turn. That is
fine for short-to-medium skill work (one shell call, one config patch, one
batch). It is **not** fine for the long-skill route the run-contract chain was
built for: a skill like `video-expert-analyzer` legitimately wants to run dozens
of internal steps with its own budget, its own retries, and its own progress
log before it has anything terminal to report. When that work tries to run
inside the parent loop today we paper over the mismatch with three things —
all of which are temporary and all of which need to migrate to a child-owned
runner:

1. **Force-tool dispatch** in `turn-engine.ts` synthesises one typed-action
   `tool_use`, dispatches it, and waits for the result.
2. **Typed-action wrapper** in `skills-tools.ts` wraps the runtime call,
   reports outputs back as a `framePatch`, and lets the parent decide what to
   do next.
3. **Supervisor reconciliation** in `skill-task-supervisor.ts` post-hoc
   reconciles detached/run-state/task-run signals into a single liveness +
   progress snapshot the parent contract loader can read.

This works because every long-skill iteration we do today is "one-shot from
the parent's view" — the parent dispatches a typed action, the action does
its slice, returns, and the next user turn (or steering decision) drives the
next slice. The parent never owns the long-skill loop; it owns one slice and
checkpoints. The chain is correct, but the parent is doing two jobs that
should not be co-located: **outer agent loop** (which converses with the user,
chooses tools, decides terminal reasons) and **inner skill loop** (which knows
its own budget, its own checkpoints, its own retries, and its own internal
tool admission rules).

The Anthropic public reference for this split is the `runAgent` pattern in CC
("Claude Code") — the parent SDK loop launches a sub-agent, the sub-agent
owns its own message log, its own tool surface, its own permissions, and its
own termination criteria. The parent never inspects the sub-agent's transcript
mid-run; it observes a single structured close event (success, cancelled,
failed, checkpoint). Ready does **not** intend to copy `runAgent` line for
line — our skill runtime is host-managed, not SDK-spawned, and our budget
policy is different. We borrow the **boundary** only: the parent observes one
event, the child owns its own loop.

## 2. What the child loop owns

The child-loop runner owns all of the following inside its own process /
async lifetime (this list described future state pre-Stage N; Stage N
closes the parent retirement so the runner is now the sole owner):

| Concern | Owned by child | Notes |
| --- | --- | --- |
| Iteration loop | yes | Multiple internal tool calls per child run; parent only sees the close. |
| Transcript / run log | yes | Child writes to `<outputDir>/run_state.json` plus its own append-only log. Parent does NOT read mid-run. |
| Budget | yes | Child gets a `RunBudgetSeed` at launch, decrements internally, and checkpoints itself when exhausted. Parent's budget is independent. |
| Internal checkpoints | yes | Child decides when to write `run_state.json`. Parent does not gate checkpoint cadence. |
| Tool admission | yes | Child has its own allowed-tool surface (manifest-driven). Parent's `allowedToolNames` does not constrain the child. |
| Abort / cancel | partial | Parent can request abort; child must honour and drain. The cancel signal is the child's responsibility to translate into a clean close event. |
| Heartbeat | yes | Child writes liveness markers; supervisor reads them out-of-band. |

What the child does **not** own:

- The user-visible turn lifecycle (system messages, hide/show, soft-failure
  capsule). That stays with the parent.
- Cross-skill arbitration (e.g. "the user mentioned skill X; should we
  switch?"). That stays with the parent / orchestrator layer.
- The IPC contract with the renderer. The child speaks to the host runtime,
  which speaks to the parent, which speaks to the renderer.

## 3. What the parent owns

After Stage N (2026-05-07) the parent's job around long skills is:

1. **Decide to launch.** Read the `SkillRunContract`, derive the action input,
   validate it against the registry (same code path as today's force-tool
   preflight), and either checkpoint or launch.
2. **Track liveness.** Hold a handle to the child run. The supervisor read
   path stays — it is the out-of-band reconciliation that lets the parent
   answer "is the child still alive" without reading the transcript.
3. **Drain on close.** Wait for the child's structured close event. Cleanup
   any heartbeat timers / lease state / projection placeholders the parent
   set up at launch. Surface the close to the renderer as one event.
4. **Resume on next turn.** On the next user turn, read the child's
   summary (NOT the transcript) and the contract's recorded handles, and
   either restart the child, treat the close as terminal, or escalate.

Parent never reads the child's transcript. The whole point of the boundary is
that the parent's view of the child is the close event plus whatever the
contract says about output paths, run-state path, and progress fingerprint.

## 4. Resume semantics

Long skills resume across turns. The resume payload travels through
`buildContinuityResumePayload` and lands in `rememberSkillRun`, which the
supervisor reads back next turn. The child-loop runtime owns resume:

- **Child reads its own state on resume.** The child re-opens
  `<outputDir>/run_state.json` (and any sibling artefacts the manifest
  declares) and rebuilds its internal loop position. The parent provides
  the paths via `SkillRunContract.runStatePath` / `outputDir` /
  `artifactPaths`, but does **not** parse the file content for
  resume-position logic.
- **Parent carries a summary only.** The parent's contract carries
  `progressFingerprint`, `liveness`, `status`, `blockers`, and the durable
  handles (`taskRunId`, `detachedTaskId`, `jobId`). That is enough for the
  parent to decide "should I relaunch the child" or "the user must resolve
  the blocker first". The parent never reconstructs internal step state.
- **Single close event.** When a child run ends — for any reason: completion,
  budget exhaustion, blocker, cancellation, infra error — the child emits one
  structured close event. The parent's `consumeExecutedToolBatch` consumes
  that one event, applies a `framePatch`, and lets the next-turn resolver
  decide what to do.

The orphan-result regression test (`turn-engine-force-tool-dispatch.test.ts`)
is the most concrete expression of this invariant: when a forced dispatch
is interrupted mid-flight, exactly one terminal close event must surface,
never an orphan `tool_use`. After Stage N the same invariant holds for
both the legacy non-child-loop force path AND the child-loop runner —
a cancelled child surfaces one close event with
`terminalReason='cancelled_user'`.

## 5. Where the boundary lives in the source (Phase 1–7 landed)

The boundary is implemented across the following files. Each file owns one
responsibility; the parent never reaches inside the child's loop.

### Child-side files (created by Phase 1 / 5)

- `src/main/modules/agent-control/skill-child-run-id.ts` — typed id helper
  (`v[a-z0-9]{8}` for VEA, `s` for generic, `d` for detached-bridge).
- `src/main/modules/agent-control/skill-child-run-types.ts` — payload,
  event log entries, close event, driver interface.
- `src/main/modules/agent-control/skill-child-run-log.ts` — append-only
  JSONL helpers for `<outputDir>/.ready/child-runs/<childRunId>.jsonl`.
- `src/main/modules/agent-control/skill-child-runner.ts` — lifecycle
  orchestrator (start / resume / cancel / close). Owns
  single-flight collapse, MAX_ACTIVE_VEA_CHILD_RUNS = 3, nested-child
  guard, launch-stuck guard, and per-child internal budget.
- `src/main/modules/agent-control/skill-child-drivers.ts` — driver
  registry (`getSkillChildDriver(skillId)` / `isChildOwnedSkill`).
- `src/main/modules/agent-control/video-expert-child-driver.ts` —
  VEA-specific stage-to-action decisions. Owns the answer to
  "should I run `video_expert_pipeline` or `video_expert_ai_analyze`?"
  The parent never asks.

### Parent-side adapters

- `src/main/modules/tools/skills-tools.ts` —
  `isChildLoopSkillAction(skillId, action)` table-driven gate; agent-driven
  VEA tool calls dispatch via `dispatchChildLoopSkillAction(...)` instead
  of awaiting `runSkill`. Returns the child-run envelope vocabulary
  (`child_launched / child_reused / child_paused / child_terminal`).
- `src/main/modules/agent-control/run-contracts.ts` — `SkillRunContract`
  carries `childRunId` / `childStatus` / `parentNextHint` /
  `childCloseEvent` / `legacyAdoptableHandles` / `blockerReason`.
  `shouldParentForceLongSkillTool(contract)` is the single gate for
  whether the parent's force-tool path is allowed.
- `src/main/modules/skills-runtime/runtime-manager.ts` —
  `startSkillChildRunAndWait(...)` is the await-style helper for product
  callers (RSS visual flow). Internally launches a child run, polls for
  the close event, and times out via `cancelSkillChildRun(id, 'await_timeout')`.
- `src/main/modules/rss-engine/item-analysis-manager.ts` — RSS visual
  flow uses the child-run helper for VEA actions (Phase 7 migration).
  Bounded retry on `queued_global_concurrency`. Distinct
  `failed / killed / blocked / paused` outcomes preserved.

### Repository

- `src/main/modules/repositories/skill-task-run-repository.ts` —
  `createChildRun` / `updateChildRun` / `findLatestChildRunByKey` /
  `findLatestChildRunBySkill`. Child-run payload stored in
  `resumePayload.childRun`; no DB migration in this route.
- `src/main/modules/repositories/task-projection-repository.ts` —
  artifact sibling lookup (legacy fallback) tightened to apply `skillId`
  filtering in SQL (`json_each` + `NOT EXISTS`) BEFORE path similarity.

## 5.1 Tool envelope vocabulary

Long skill tool calls return one of four stable status strings, all
enumerated in `dispatchChildLoopSkillAction(...)`:

| Envelope | Meaning |
| --- | --- |
| `child_launched` | A new child run was started; close event arrives via the runner. |
| `child_reused`   | Single-flight collapsed onto an existing run. |
| `child_paused`   | Recoverable pause / blocked / queued — close event present. |
| `child_terminal` | Completed / failed / killed — close event present. |

Cancellation maps to `child_terminal` with
`closeEvent.status === 'killed'` and `terminalReason === 'cancelled_user'`.
It MUST NOT be reported as `failed` (source plan §3 rule 7).

## 5.2 Public predicates

- `isChildLoopSkillAction(skillId, action)` — table-driven; current
  allowlist is the VEA pipeline + ai_analyze pair.
- `shouldParentForceLongSkillTool(contract)` — returns `false` whenever
  the contract carries a `childRunId`. Single gate for force-tool fencing.
- `isChildOwnedSkill(skillId)` — owned by `skill-child-drivers.ts`,
  reflects whether a driver has been registered.

## 5.4 Remediation closures (T1–T9, commits c58e314 → 4b7e359)

The shape from `452f01a` plus the remediation series jointly satisfy
each rule in §0 above. Concrete code locations:

| Rule | Code that enforces it | Test that locks it |
| --- | --- | --- |
| Parent never picks next VEA action | `turn-frame-steering.ts:isChildOwnedFrame` — `shouldPreferTypedAction` early-returns false; `selectSteeringMode` early-returns `ask_model`; `buildTurnFrameSteering` short-circuits with primitives-only `preferredToolNames` and a child-aware reminder. | `turn-frame-steering.test.ts` T5 cases. |
| Parent actively routes continuation | `turn-engine.ts:computeChildContinuationDecision` — wired at iteration top to surface child closes / parent-side checkpoint / wait posture before any model invocation or force-tool decision. | `skill-child-run-end-to-end.test.ts` T5 cases (Cases G–L). |
| Single-flight reuse only when runner is alive | `skill-child-runner.ts:reconcileExistingChildRun` — gates `'reused'` on `this.active.get(existingId)`; inactive `running` rows are pinned to `recoverable_paused / process_restarted`. | `skill-child-single-flight.test.ts` T4 Cases A & B. |
| getCloseEvent reads durable terminal closes | `skill-child-runner.ts:getCloseEvent` — falls back to `repository.get(id).resumePayload.childRun.closeEvent` after `recentCloses` misses. Skips fallback while a live runner exists for the id. | `skill-child-runner.test.ts` T4 Case C. |
| Cancel uses real metadata | `skill-child-runner.ts:cancelSkillChildRun` — looks up the row first; preserves real `skillId / outputDir / runStatePath`; observer/launch timeouts produce `failed/launch_stuck`, never `killed/cancelled_user`. | `skill-child-runner.test.ts` T4 Cases D & E. |
| Child internal admission is unified | `tool-registry.ts:executeSkillActionViaToolGateway` — same Zod resolver as public typed dispatch, structured errors mapped to runner close event vocabulary. Recursion guards live where they can fire (`startSkillChildRun:inDriverDepth`, `dispatchChildLoopSkillAction`), not in the gateway. | `tool-input-schemas-registry.test.ts` T6 cases + `tool-gateway-registry.test.ts` parity. |
| Live frame seeded into ToolRuntimeContext | `tool-runtime-context-builder.ts:buildActiveFrameContextFromTurnFrame` + `turn-engine.ts` per-turn `activeFrame` seed. Earlier same-batch `contextModifier` patches union onto the seed. | `skill-tools-frame-patch-delta.test.ts` T7 cases. |
| Exact-first contract identity | `run-contracts.ts:loadSkillRunContract` — strict order: childRunId → runStatePath → outputDir → singleFlightKey → latest-by-skill fallback. `skillId` filter applied at every step. | `skill-child-run-end-to-end.test.ts` T8 cases + `task-projection-sync.test.ts`. |
| Direct sceneScoresPath cold-start | `video-expert-child-driver.ts:planNextAction` — prefers explicit `state.requestedInput.sceneScoresPath`; derives outputDir from `dirname(sceneScoresPath)` when absent. | `video-expert-child-driver.test.ts` T3 cases + `rss-visual-skill-child-run.test.ts` T9 real-driver test. |
| No false-green stub tests | `rss-visual-skill-child-run.test.ts` T9 block + identity guard `assert.strictEqual(videoExpertChildDriver, productionExport)` in both T3 and T9 real-driver tests so a stub swap-in fails before any plan runs. | T9 itself. |
| Parent never synthesizes force `tool_use` for manifest-declared child-loop action (Stage N) | `run-contracts.ts:isParentForceForbiddenByManifest` reverse-maps via `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` then consults `isConfiguredChildLoopSkillAction`; `turn-engine.ts:3252` splits candidate vs. blocked, emits `turn_force_tool_blocked_child_owned` and breaks to checkpoint when the manifest fence wins; `turn-engine.ts:3413` invariant belt fails-closed if a future refactor reaches the `forceLoopGuard` write site for a child-loop tool. | `skill-child-parent-force-blocked.test.ts` (Cases A/B/C); `turn-engine-force-tool-dispatch.test.ts` re-targeted off VEA fixture so legacy regression remains pinned for non-child-loop skills; `agent-vea-resume-probe.test.cjs` updated to assert checkpoint terminal + manifest-fence metric. |
| Manifest ⇔ driver invariant fails boot when violated (Stage N) | `runtime.ts` constructs `AgentControlRuntime` and immediately runs `assertStageNChildLoopInvariants` (pure helper at `stage-n-boot-assertion.ts`) AFTER the swallowed `configureSkillChildRunner` try/catch; throw escapes via `setupAgentIPC → createWindow → unhandledRejection → handleFatal` (process exits). Embedded skills only — Phase 0.4 strips `child_loop` from custom-source manifests at compile (`skill-compiler.ts:463`). | `skill-child-stage-n-boot-assertion.test.ts` covers throw shapes; `skill-child-compiler-custom-child-loop-drop.test.ts` covers compile-time drop. |
| Manifest ⇔ static-name invariant catches CI drift (Stage N) | `scripts/check-manifest-vs-static-tool-name.cjs` parses the forward literal `STATIC_SKILL_TOOL_NAMES_BY_ACTION` (`skills-tools-static.ts:27-36`) and cross-references with embedded `child_loop.actions[]`; runtime mirror in the boot assertion. | `scripts/__tests__/check-manifest-vs-static-tool-name.test.cjs` self-tests; boot-assertion test above. |
| Source gate forbids regressions (Stage N) | `scripts/check-no-parent-force-for-child-loop.cjs` enforces: (1) no child-loop action in `DEFAULT_RESUME_ACTION_BY_SKILL_ID`; (2) synthesis site references both `shouldParentForceLongSkillTool` AND `isParentForceForbiddenByManifest`; (3) `forceLoopGuard` write site has the invariant belt. | `scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs` (positive + negative). |
| Budget-warning suppression fenced for child-loop (Stage N) | `turn-engine.ts:3937` checks `STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]` + `isConfiguredChildLoopSkillAction` before setting `lastLongTypedSkillActionIteration`; child-loop typed launches no longer mute the next iteration's budget warning. | `skill-child-budget-warning-no-suppression.test.ts`. |

## 5.5 Verification (recorded 2026-04-30 after T9 landed)

```bash
npm run typecheck                                    # PASS
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
                                                     # PASS (144 / 144)
```

## 5.3 Status normalization (Phase 7)

The supervisor / contract / projection / child-runner layers all share
one normalized public vocabulary:

```text
running | completed | failed | killed | recoverable_paused | budget_paused | blocked | unknown
```

`background_running` is removed from the public surface; the supervisor
returns `status: 'running'` plus `liveness: 'background'` when the work
is owned by a detached / pid-tracked process. Internal per-source
mappers (`statusFromTaskRun`, `statusFromDetached`, `statusFromRunState`)
keep the legacy raw vocabulary; normalization happens once at the end
of `inspectSkillTask` via `normalizeSkillStatus(...)`.

## 6. Pre-Stage-N migration anchors (historical)

Below are the boundaries that carried `// TODO(skill-child-loop):`
comments before the migration. Phases 1–7 implemented them, and Stage N
(2026-05-07) closed the parent retirement at each anchor; the bulk of
the TODO markers have been replaced with Stage-N-landing comments.
Only the supervisor reconciliation in §5.3 still carries a Stage-N-stamp
comment (no TODO) because its semantics did not change — it remains the
parent's out-of-band liveness probe with a shrunken consumer set.

### 5.1 `src/main/modules/agent-control/turn-engine.ts`

- **Force-tool dispatch boundary**. Pre-migration: parent reads
  `turnFrame.steering.action`, validates input via the registry + Zod path,
  and synthesises a `tool_use`. **Post-Stage-N**: child-loop skills never
  reach this branch — the candidate-vs-blocked split + manifest fence at
  the synthesis site early-break with `turn_force_tool_blocked_child_owned`
  (see §0 + §5.4). The synthesized `tool_use`, the per-turn
  `forceToolDispatchedThisTurn` cap, and the cross-turn `forceLoopGuard`
  are now reserved for non-child-loop migration paths only; the
  invariant belt at the `forceLoopGuard` write site fails closed if a
  future refactor reaches it for a child-loop tool.
- **Typed-action result handling**. Pre-migration: the parent watched
  the typed action's heartbeat, applied its `framePatch`, and re-ran
  steering on every batch. **Post-Stage-N**: heartbeat / progress is the
  child runner's concern. The parent's `consumeExecutedToolBatch`
  consumes the `child_launched` envelope (and subsequent close events)
  as ordinary tool results; the Phase 3 fence at the
  `lastLongTypedSkillActionIteration` write site keeps child-loop
  launches from muting the next iteration's budget warning.

### 5.2 `src/main/modules/tools/skills-tools.ts`

- **Typed-action wrapper await**. Pre-migration: `await getManager().runSkill(...)`
  blocked the parent's tool-batch promise on the entire skill run.
  **Post-Stage-N**: child-loop typed actions route through
  `dispatchChildLoopSkillAction(...)` which returns the `child_launched`
  envelope immediately; the close event arrives via the runner's
  separate channel.
- **Typed-action completion / framePatch emission**. Pre-migration:
  `loadSkillRunContract` + `buildContractFramePatch` ran inline at the
  bottom of the typed-action wrapper. **Post-Stage-N**: child-loop
  skills emit the contract patch at the runner's close event; the
  parent only consumes that patch through the normal post-batch
  framePatch pipeline.

### 5.3 `src/main/modules/agent-control/skill-task-supervisor.ts`

- **Reconciliation boundary**. Pre-migration: `inspectSkillTask` /
  `inspectLatestSkillTask` fused detached task store, task-run store,
  and `run_state.json` into a supervisor snapshot the parent used to
  probe "is something running and how far has it got?" without reading
  the child transcript. **Post-Stage-N**: the supervisor stays — it is
  how the parent observes liveness without inspecting the transcript —
  but its consumers have shrunk to the parent's next-turn resolver
  choosing between "resume", "wait for blocker", and "give up".

## 6. Migration history (closed in Stage N)

Wave 4 (2026-04-30) marked the child-loop boundaries; Phases 1–7 of the
child-loop architecture plan landed the runtime; the remediation series
closed the ownership gaps. **Stage N (2026-05-07)** retired the parent's
last legacy lever — force-typed-action synthesis for VEA — and replaced it
with manifest + contract fences plus boot-time invariants. The original
"future migration sketch" listed five items:

1. **Child runtime entry point** — landed as `startSkillChildRun /
   resumeSkillChildRun / cancelSkillChildRun` in
   `src/main/modules/agent-control/skill-child-runner.ts`.
2. **Child-side budget engine** — landed as the runner's per-run budget
   scoped via `SkillChildRunner` (independent of the parent turn budget).
3. **Child-side abort drain** — landed: parent abort flows through the
   runner's `AbortController`, producing a structured close event with
   `terminalReason: 'cancelled_user'`.
4. **Close-event channel** — landed: `dispatchChildLoopSkillAction` returns
   the `child_launched` envelope; subsequent close events flow back as
   `framePatch` via `consumeExecutedToolBatch` and the runner's lookup
   API.
5. **Regression suite** — landed: parent never reads the child transcript
   (asserted in `skill-child-run-end-to-end.test.ts`), abort produces one
   close (asserted in the orphan-result test), resume reads child state
   from disk (`skill-child-runner-resume-lifecycle.test.ts`), and the
   `forceLoopGuard` field is now unreachable for child-loop skills via
   the Stage N invariant belt at the write site.

Stage N specifically retires the "parent synthesizes the next VEA action"
path. After Stage N, `forceLoopGuard` writes are statically unreachable
for any embedded skill that declares `child_loop.actions[]` in its
manifest, the boot assertion enforces manifest⇔driver consistency, and
the source gate
(`scripts/check-no-parent-force-for-child-loop.cjs`) prevents a regression
from re-introducing parent-side typed-action synthesis for child-loop
actions. See §5.4 for the closure table and §0 for the authoritative
boundary statement.

## 7. Cross-references

- `docs/superpowers/plans/2026-04-29-skill-run-contract-implementation-plan-claude.md`
  — the plan that introduced `SkillRunContract` + `FrameAction`. The
  child-loop migration will consume the same contract type as its launch
  payload; no new types are required.
- `docs/superpowers/plans/2026-04-29-skill-run-contract-long-skill-ownership-route.md`
  — Stages A–G. Stage G4 (this document) and Stage G1 (the TODO markers)
  are the last items in Wave 4.
- `src/main/modules/agent-control/run-contracts.ts` — `SkillRunContract`,
  `loadSkillRunContract`, `buildContractFramePatch`. The child-loop runner
  will build on these without modification.
- `src/__tests__/turn-engine-force-tool-dispatch.test.ts` — orphan-result
  regression. The post-migration child runner must keep this test green:
  one close event per dispatch, no orphan `tool_use`.
- `src/__tests__/turn-frame-summary-log.test.ts` — single per-turn
  `turn_frame_summary` invariant. The child-loop migration must not break
  this; the child's internal iterations are NOT counted as parent
  iterations, but the parent's close-event handling still emits one
  summary per parent turn.
