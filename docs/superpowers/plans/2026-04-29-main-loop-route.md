# Skill Main Loop Route — Architecture Edition

> **Stage:** route document. Successor stages will each get their own implementation plan with checkbox steps.
>
> **Relationship to codex draft:** This document is a critical re-take of `2026-04-29-skill-runtime-main-loop-consolidation-route.md` (codex draft). It keeps the live evidence and high-level direction codex captured, but replaces the 9-stage roadmap with one *structural* shift plus a tighter, dependency-ordered set of stages. The codex draft is preserved for reference and diff.
>
> **Audience:** the engineer who will write the per-stage implementation plans. After reading this, you should know the destination and the invariants every stage has to preserve, without re-running the diagnosis.

---

## 1. Why a route, not more patches

Ready's skill main loop has accumulated four advisory layers (`active-skill-context`, `skill-task-supervisor`, `skill-budget-lease-controller`, projection sync) that observe the world but do not own it. The actual loop in `turn-engine.ts` still threads its decisions through ad hoc `if (referenceSkillForMetrics) ...` branches. When the advisory layers disagree — and they currently do — there is no single owner that reconciles them, so:

- the model sees the right tools but isn't told to prefer them,
- budget exhausts on inspection loops the supervisor already knows are wasted,
- the projection accumulates contradictory rows for the same durable task,
- and the user-facing turn occasionally fails to finalize at all.

We have shipped seven phases of feature work since the executions table was retired. We are not patching individual symptoms anymore. The next move is to give the loop one owner.

## 2. Live evidence (verified 2026-04-29)

All from session `conv-local-1777219721244-7cx39t`, request `req-1777439706074-cpvytw`, output dir `/Users/user/Documents/实验田/测试/4qkyxm4jppc`.

**E1 — backend is not running.** `ps -axo pid,etime,command | grep -E "video-expert|pipeline_enhanced|openclaw_batch|ai_analyzer"` returns empty. No live worker.

**E2 — `run_state.json` says otherwise.** `status: "running"`, `current_stage: "score_batches"`, `total_scenes: 97`, `completed_scenes: 0`, `updated_at: 2026-04-29T04:57:21Z`. The file's `running` claim has outlived the process by ~18 minutes.

**E3 — tools were visible the whole time.** Looking at `tool_loop_request` snapshots iterations 5–9 in `ready-directchat.log` at 05:15:19–05:15:39, `allowedToolNames` includes `skill_video_expert_pipeline`, `skill_video_expert_ai_analyze`, `skill_inspect_run_state`, plus all 6 primitives. The codex draft's reading of `preferredSkillTools=[]` from the metric was misleading: that field is a metric signal, not the actual tool list.

**E4 — model never used the typed action.** Across iterations 5–9 every tool call was `skill_run_shell` doing `cat run_state.json`, `python -c "print(type(d))"`, `ls scripts/`, etc. The model was inspecting, not resuming. `skill_video_expert_pipeline` was offered but never selected.

**E5 — budget exhausted at iteration 9.** Metric: `turn_budget_exhausted` at 05:15:44 with `taskType: "continuation"`, `iterations: 9`, `maxIterations: 20`, `referenceSkillId: "video-expert-analyzer"`, `preferredSkillTools: []`, `longSkillResume: false`. The session resolved a VEA active context (separate `active_skill_context` log line) but routed as generic `continuation`, not `multi_step_task` with long-skill resume budget.

**E6 — IPC unstick is real.** `agent:sendScoped start` at 05:15:06 has no matching `done` line in `ready-directchat.log`. The metric was emitted at 05:15:44, so ~38s later the post-loop path is awaiting something that never resolves. Candidates in turn-engine.ts (2540–2625) and run-coordinator.ts (209–290): `selectedDomainAdapter.applyResult({phase:'budget_limit'})`, `recordSkillParentTaskLifecycleEvent` (DB write), `recordRunOutcome`, `emitScopeRunEvent`, `hooks?.onSuccess?.()`. Any one of them hanging blocks `runScoped` resolution, which blocks the IPC handler's "done" log.

**E7 — `skill_read_artifact` rejects the active output dir.** At 05:15:11 metric `skill_primitive_rejected{reason:"path_escape"}` for `/Users/user/Documents/实验田/测试/4qkyxm4jppc/run_state.json`. The active context knows that path; the read primitive does not. The model falls back to shell.

**E8 — projection rows contradict.** `task_projections` query returns 5 rows for the same durable VEA task: 4 historical `blocked + interaction_state=running + waiting_for=background + blocked_reason="自动并行评分失败：ValueError: 未找到 provider: zai"` and 1 latest `queued + interaction_state=running + waiting_for=background + blocked_reason="本轮预算已用完，技能任务已暂停"`. The "zai" blocker is stale (provider config has changed; metric also stopped emitting it). Nothing reconciles old rows when the new truth lands.

## 3. CC-Source — the structural answer

The lesson from `/Users/user/Documents/实验田/CC-Source` is not a file-for-file translation. It is five structural patterns that, combined, explain why CC's loop stays coherent under load.

### L1. One State object, threaded through one generator

`src/query.ts:241–311, 1716–1727`. A single `queryLoop()` async generator owns the loop. Each iteration starts by destructuring `state` (`{ messages, toolUseContext, turnCount, transition, autoCompactTracking, ... }`) and ends by writing a fresh `state = { ... }` before `continue`. There is exactly one mutable state object; messages, tool context, budget tracking, and recovery flags all hang off it. No parallel observers.

### L2. Termination is an explicit reason enum

`src/query.ts` returns `{ reason }` from one of ~10 explicit cases: `'completed'`, `'max_turns'`, `'aborted_streaming'`, `'aborted_tools'`, `'model_error'`, `'image_error'`, `'prompt_too_long'`, `'blocking_limit'`, `'stop_hook_prevented'`, `'hook_stopped'`. Every exit path picks one. The caller (and tests) can branch on the reason.

### L3. Tools own behavior through a contract, not by name

`src/Tool.ts:362–695`. Each tool declares `isReadOnly(input)`, `isConcurrencySafe(input)`, `isDestructive?(input)`, `interruptBehavior?()`, `validateInput?()`, `checkPermissions()`, `inputsEquivalent?()`, `maxResultSizeChars`, `renderToolUseMessage()`. The loop reads these via the contract — never via string-prefix sniffing. Tool gating, concurrency partitioning, permission flow, UI rendering are all derived from the same contract.

### L4. Tools return context modifiers; the loop applies them in order

`src/services/tools/toolOrchestration.ts:19–82`. Concurrent-safe tools run in parallel. Their `contextModifier` functions (returned from each call) are queued, then applied **serially after the batch completes**, in input order:

```ts
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  if (!modifiers) continue
  for (const modifier of modifiers) currentContext = modifier(currentContext)
}
```

This is the mechanism by which a tool result actually changes the loop's view of the world. It is not direct mutation; it is a function returned from the call site that the loop applies to its own state. This eliminates a whole class of "tool side effect leaked into shared state out of order" bugs.

### L5. Sub-tasks fork a new loop with forked context

`src/tools/SkillTool/SkillTool.ts:122–250` and `src/tools/AgentTool/runAgent.ts:248+`. A skill or subagent invocation is **not** prompt injection. It is `runAgent()` calling `query()` recursively with a forked `ToolUseContext` (cloned file-state cache, possibly its own MCP servers, depth-incremented `queryTracking`). The parent loop's state is never touched; the result of the sub-loop is returned as a tool result.

---

## 4. How Ready maps to those patterns today

| CC-Source pattern | Ready today | Gap |
|---|---|---|
| L1 single State threaded | `TurnState` exists (`turn-state.ts`) but is mutated in-place by many helpers; advisory observers (active-skill-context, supervisor, lease) live outside it | Loop has a state container but not a single owner; observers contradict |
| L2 explicit termination | `finish({ status: 'done'\|'error'\|'cancelled'\|'checkpoint' })` — 4 statuses, plus an implicit `'budget_limit'` branch in code | Too coarse; "checkpoint" hides 4–5 different real situations |
| L3 tool contract | Tools registered via `tool-definition.ts`; concurrency/readonly/destructiveness are not on the contract; gating split across `tool-registry`, `tool-gateway`, `execution-tool-config`, `execution-tool-policy`, `skill-tool-session-gate`, `skills-tools` | 5+ filter points, name-prefix sniffing, no isReadOnly contract |
| L4 context modifiers | Tool dispatcher returns `ToolExecutionOutput`; mutation of state happens at call sites in turn-engine | No `frameUpdate` / `contextModifier` return path; loop state changes are scattered |
| L5 forked sub-loop for skills | Skills run in the same loop; "preferred tools" are injected and the model is expected to pick them | Skill turn body is a series of `if hasReferenceSkill ...` branches in turn-engine, not a sub-loop |

The honest reading: **Ready has the bones of L1 and L2 but never adopted L3/L4/L5.** Skill resume turns work by piling more advisory inputs on top of the same generic body. Each new advisor adds another way for inputs to disagree.

## 5. The structural shift

One change, expressed three ways. Pick the framing that fits each stage.

> **Build a `TurnFrame` once at iteration 0. Make it the single owner that routing, prompt steering, tool gating, dispatch, projection, and finalization consult. Tools may return frame updates; they may not mutate state directly. Termination is one of N explicit reasons.**

The frame replaces — does not supplement — the current chain of `referenceSkillForMetrics`, `preferredSkillToolNames`, `hasActiveSkill`, `continuationProjection`, supervisor snapshot status, and raw `run_state.status`. Once a stage adopts the frame, the corresponding ad hoc check is deleted, not left as a fallback.

### 5.1 Minimum frame shape

```ts
interface TurnFrame {
  // Identity (resolved once, used everywhere)
  sessionId: string
  requestId: string
  mode: 'general' | 'skill_resume' | 'skill_start' | 'skill_repair' | 'skill_inspect'
  skill: { id, name, source: 'explicit'|'supervisor'|'projection'|'task_run'|'reference_hint', confidence } | null
  durableHandle: { taskRunId, detachedTaskId, outputDir, runStatePath, sceneScoresPath, deliveryReportPath, action } | null

  // Reconciled liveness (NOT raw run_state.status)
  liveness: 'running_process' | 'recoverable_paused' | 'ready_to_resume' | 'blocked_input' | 'blocked_config' | 'done' | 'failed' | 'unknown'
  progress: { stage, fingerprint, scoredCount, totalCount, coverageRatio } | null

  // Per-turn policy (derived from mode + liveness, not from prompts)
  steering: { primaryAction: string | null, preferredTools: string[], banShellLoop: boolean }
  budget: { profile: 'short'|'multi_step'|'long_skill_resume', leaseEnd, hardCap, allowRenew }
  toolPolicy: { allowed: string[], primitivesGated: boolean, readSandboxIncludes: string[] }

  // Termination contract — exactly one fires per turn
  exit: { reason: TerminalReason, projectionPatch, lifecycleEvent } | null
}

type TerminalReason =
  | 'completed_done'
  | 'budget_exhausted_checkpoint'
  | 'budget_exhausted_handoff_background'
  | 'aborted_user'
  | 'aborted_tool_phase'
  | 'skill_blocked_input'
  | 'skill_blocked_config'
  | 'skill_failed_terminal'
  | 'model_error'
  | 'permission_denied_terminal'
```

### 5.2 Loop body becomes a switch on `frame.mode`

Today the loop body is one big procedure with `if (referenceSkillForMetrics) ...` sprinkled through. After the shift it becomes one switch at the top of each iteration:

```
each iteration:
  if (frame.exit) finalize(frame.exit) ; break
  steerPrompt(frame.steering)
  callModel(frame.toolPolicy.allowed)
  for each toolUse: dispatch(toolUse, frame)  // dispatch may attach a frameUpdate
  applyFrameUpdates(frame, results)            // serialized in tool order, à la CC L4
  evaluateLeaseAndProgress(frame)              // sets frame.exit if lease pauses
  evaluateModelStop(frame)                     // sets frame.exit on natural stop
```

### 5.3 Why this fixes the live failures

- **E2 stale `run_state`:** liveness reconciliation at frame build replaces `run_state.status` with `recoverable_paused`. The loop body no longer treats it as live.
- **E4 inspection loops:** `frame.steering.primaryAction = 'skill_video_expert_pipeline'` and `banShellLoop = true` once liveness says ready_to_resume. The model is steered, and excessive `skill_run_shell` triggers waste-scorer earlier.
- **E5 generic continuation routing:** mode is set to `skill_resume` at frame build, so taskType is `multi_step_task`, longSkillResume is true, the typed-action budget profile applies.
- **E6 IPC unstick:** there is exactly one `frame.exit` per turn, with one finalization path. No async fan-out in the success branch; lifecycle/projection writes happen *inside* finalization, not after `runScoped` returns. The IPC `done` log fires from the same finalize call.
- **E7 read sandbox:** `frame.toolPolicy.readSandboxIncludes = [outputDir]`. `skill_read_artifact` consults the frame; absolute paths inside that list are allowed. Anything outside is still rejected.
- **E8 projection contradictions:** `frame.exit.projectionPatch` is the *only* source of projection writes for that turn. `task-projection-sync` supersedes prior rows for the same durable handle.

### 5.4 Why the model wasn't steered before, in plain English

We assumed "make the typed action visible and the model will pick it." That assumption is broken by reality (E4): models given a long sequence of `skill_run_shell` calls in conversation history mimic that pattern. Visibility is necessary but not sufficient. Steering is the missing primitive: the system message must say "the typed action is the right move now," and the loop must penalize repeated shell calls when liveness says ready_to_resume.

## 6. Stages — dependency-ordered, invariants only

Each stage below states an *invariant* and an *exit criterion*. Step-by-step plans are deferred to per-stage implementation documents. The first implementation plan should fuse Stage 1 + Stage 2 because they share fixtures.

### Stage 1 — Terminal closure invariant

**Invariant:** every entry into `RunCoordinator.executeRun` exits with exactly one terminal `emitScopeRunEvent({type:'updated', phase})` AND one IPC `agent:sendScoped done|failed` line, regardless of which branch of turn-engine resolved.

**Scope:** turn-engine `finish()` paths (lines 2520–2685), run-coordinator post-loop path (lines 209–293), the IPC handler that logs `done`. Move `recordSkillParentTaskLifecycleEvent` and `recordRunOutcome` *inside* a single `finalize(frame.exit)` step so an exception in either fans into one error path. Reflection stays fire-and-forget but is hardened so it can't reject `runScoped`.

**Exit:** the live VEA session reproduced today either (a) completes its IPC `done` line within 2s of the budget-exhausted metric, or (b) emits `done|failed` with an explicit terminal reason. Renderer leaves "thinking" within 1s of either.

**Verification:** turn-engine route test for budget-exhausted skill turns; integration smoke that asserts `done` log line appears for every `start`.

### Stage 2 — TurnFrame resolver and terminal taxonomy

**Invariant:** at iteration 0, exactly one `TurnFrame` is built and frozen for the turn. All later code paths *consume* the frame; none rebuild or mutate identity fields. `finish()` accepts only a `TerminalReason` from the enum in §5.1, not free-form `status` strings.

**Scope:** new module (probably `agent-control/turn-frame.ts`) that subsumes today's `active-skill-context.ts`, the supervisor snapshot read, the projection scan, and the reference-hint lookup. `turn-engine.ts` calls it once, consumes its `mode`, `skill`, `durableHandle`, `liveness`. The frame captures *intent at iteration 0*; per-iteration updates land in a separate `frame.runtime` slot (progress, leaseState, toolHistory).

**Exit:** turn-engine no longer reads `referenceSkillForMetrics`, `hasActiveSkill`, `preferredSkillToolNames` directly — these are all `frame.skill`, `frame.mode === 'skill_resume'`, `frame.steering.preferredTools`. Codepaths that previously branched on three independent advisors now branch on `frame.mode`.

**Verification:** unit tests for the resolver covering the 5 source priorities (explicit > supervisor > recoverable projection > task run > reference hint), with stale-status reconciliation. A regression test that the live VEA session resolves to `mode: 'skill_resume'`, `liveness: 'recoverable_paused'`.

### Stage 3 — Frame-driven steering and tool gating

**Invariant:** the frame's `steering` and `toolPolicy` fields are the *only* inputs to the prompt steering text and the per-iteration `allowedToolNames`. Any code path that builds a tool list outside the frame is removed.

**Scope:** `skill-context-orchestrator.ts`, `skills-tools.ts`, `skill-tool-session-gate.ts`, the prompt assembly path that injects "用户希望继续使用 skill X". Two concrete deletions: (a) `filterSkillPrimitivesBySession`'s three-callback signature collapses to `consultsFrame(frame)`, (b) `preferredSkillToolNames` becomes `frame.steering.preferredTools` everywhere it appears.

**Exit:** for `frame.mode === 'skill_resume' && frame.liveness === 'ready_to_resume'`, the system message contains the typed action's name and the steering banner; the model's first iteration has `skill_video_expert_pipeline` in `preferredTools` and the loop's waste-scorer increments faster on repeated `skill_run_shell` calls.

**Verification:** prompt assembly tests that assert the steering banner; tool gating tests that assert frame consistency between visibility and dispatch context.

### Stage 4 — Liveness reconciliation owns "running"

**Invariant:** `frame.liveness` is computed from process presence, pid existence (via `kill -0`), heartbeat freshness, batch receipt presence, and *only then* `run_state.status`. A `run_state.status: "running"` claim with no live process is `recoverable_paused`, never `running_process`.

**Scope:** `skill-task-supervisor.ts`, `skill-running-projection.ts`, `inspect-run-state.ts`. VEA Python scripts continue to write `run_state.json` as they do — Ready is the side that re-interprets it.

**Exit:** the live evidence (E2) is classified as `recoverable_paused`. The supervisor snapshot exposes the reconciliation reason so logs can explain the decision in one line.

**Verification:** liveness unit tests with synthetic run_state + process state combinations; a manual check on the current live session.

### Stage 5 — Read sandbox follows the frame

**Invariant:** `skill_read_artifact` accepts paths inside `frame.durableHandle.outputDir`, in addition to the per-skill artifact root. Paths outside both are rejected.

**Scope:** `tools/skill-primitives/read-artifact.ts`, `path-sandbox.ts`. No widening of `skill_write_artifact` or `skill_run_shell`.

**Exit:** the live VEA session can read `run_state.json`, `scene_scores.json`, `delivery_report.json` without `path_escape`. Absolute paths in unrelated directories still fail.

**Verification:** unit tests for sandbox decisions with frame-supplied output dirs; rejection tests for unrelated absolute paths.

### Stage 6 — Projection writes through the frame

**Invariant:** for each terminal turn, `task-projection-sync` receives exactly one `frame.exit.projectionPatch`. Old projection rows for the same durable handle are superseded (status updated, `interaction_state` set consistently with the new exit), not appended.

**Scope:** `task-projection-sync.ts`, `task-projection-repository.ts`, `skill-task-tracker.ts`. Stable key for skill task projections: `detachedTaskId` if set, else `runStatePath`, else `outputDir + skillId + action`. Stale `blocked_reason` (e.g. "未找到 provider: zai") is cleared if and only if `frame.liveness !== 'blocked_config'`.

**Exit:** the live evidence (E8) collapses to one current projection for the VEA task. `done + interaction_state=running` and `queued + interaction_state=running + budget paused` contradictions cannot occur.

**Verification:** projection sync tests with stale-row fixtures; integration test on the live blocked session.

### Stage 7 — Diagnostics on top of the frame

**Invariant:** every turn that touches a skill emits one `turn_frame_summary` log line with `{ sessionId, mode, skillId, source, confidence, liveness, primaryAction, terminalReason, leaseDecision }`. Mismatches between layers (visible tool but no dispatch context, budget exhausted but no terminal reason, projection running but liveness paused) emit a dedicated `turn_frame_invariant_violation` metric.

**Scope:** `agent-control/metrics.ts`, the finalize path. This is observability glue; do not introduce new business logic.

**Exit:** a single log slice per turn explains routing, steering, and exit. CI test asserts the metric registry includes the new names.

## 7. Out of scope for this route

- A full L3-style Tool contract rewrite (`isReadOnly`, `isConcurrencySafe`, `interruptBehavior` on every tool). Worth doing later, but it is a separate refactor of the registry and unrelated to the current failures.
- A real L5-style sub-loop for skill turns (`runAgent`-equivalent). Architecturally desirable; out of scope until the frame ownership stabilises.
- Restarting VEA Python scoring directly. Stage 3 (steering + waste-scorer pressure) is the lever; the model still picks the action. If the model keeps refusing, the next plan can add a fallback `auto-dispatch ready_to_resume` path, but that change goes through its own design.
- VEA `run_state.json` schema changes (e.g. emitting `paused` from Python). Ready owns reconciliation; do not push state semantics into the script.

## 8. What the first implementation plan should cover

**Stage 1 + Stage 2 fused.** They share the failing VEA session as a fixture and they are the only stages whose output is testable in isolation. Until the frame exists, every later stage is rebuilding the same pre-frame state in different places.

The first plan should NOT include: Stage 3 prompt steering changes, Stage 4 liveness fields, Stage 5 read sandbox widening, Stage 6 projection dedupe, Stage 7 diagnostics. Each of those is one focused plan after Stage 1+2 lands.

Suggested initial verification:

```bash
npx tsx --test src/__tests__/turn-engine-route.test.ts
npx tsx --test src/__tests__/skill-tool-gating-by-session.test.ts
npx tsx --test src/__tests__/task-projection-sync.test.ts
npm run typecheck
```

Manual smoke after Stage 1+2:

1. Open the existing `conv-local-1777219721244-7cx39t` session.
2. Send "继续上次的视频分析".
3. Assert in `ready-directchat.log`: `agent:sendScoped start ... done` pair within ~10s of one another.
4. Assert in `ready-agent-metrics.log`: one `turn_frame_summary` with `mode:"skill_resume"`, `liveness:"recoverable_paused"`, `terminalReason:"budget_exhausted_checkpoint"` (or `completed_done` if budget renews).
5. Assert renderer leaves "思考中" within 1s of the IPC `done`.

## 9. Open questions for later stages

- **Should `frame.steering.primaryAction` ever auto-dispatch?** Today's plan keeps the model in charge. If Stage 3's steering+waste-scorer pressure does not change behavior in practice, an auto-dispatch fallback for `ready_to_resume` cases becomes a real candidate, but it needs its own design (idempotency, abort semantics, user signal).
- **When does `skill_run_shell` outrank a typed action legitimately?** The waste-scorer needs to recognise "exploring scripts" as a valid first iteration when liveness is `unknown` but penalize it once liveness lands at `ready_to_resume`. This is a tuning problem for Stage 3.
- **Projection dedupe — eager or lazy?** Stage 6 supersedes on terminal write. There is also a case for eagerly clearing `zai`-style stale blockers at frame build (when `frame.liveness !== 'blocked_config'`) so the renderer cleans up before the next turn finishes. Pick one in the Stage 6 plan; do not split the policy.
- **Liveness on macOS after app restart.** Process pids do not survive restarts. Stage 4 needs to decide whether `recoverable_paused` is the floor for "we don't know" and whether heartbeat freshness alone suffices.
- **Sub-loop migration timeline.** L5 (forked skill query) is the architecturally clean answer but a multi-week change. Worth a dedicated route doc once frame ownership is stable; should not block any current stage.

## 10. Evidence + reference index

```bash
# verify VEA process state
ps -axo pid,etime,command | grep -E "video-expert|pipeline_enhanced|openclaw_batch|ai_analyzer"

# verify run_state staleness
cat "/Users/user/Documents/实验田/测试/4qkyxm4jppc/run_state.json"

# verify allowed tools the model actually saw
grep '"stage":"tool_loop_request"' /var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T/ready-directchat.log | tail -10

# verify IPC unstick
grep "agent:sendScoped" /var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T/ready-directchat.log | tail -10

# verify projection contradictions
sqlite3 -json "/Users/user/Library/Application Support/ready/ready.db" \
  "select task_id, status, interaction_state, blocked_reason from task_projections order by updated_at desc limit 6;"
```

CC-Source primary references:

- `/Users/user/Documents/实验田/CC-Source/src/query.ts` (loop, State, terminals)
- `/Users/user/Documents/实验田/CC-Source/src/Tool.ts` (tool contract)
- `/Users/user/Documents/实验田/CC-Source/src/services/tools/toolOrchestration.ts` (concurrency, contextModifier)
- `/Users/user/Documents/实验田/CC-Source/src/services/tools/StreamingToolExecutor.ts` (streaming, sibling abort)
- `/Users/user/Documents/实验田/CC-Source/src/tools/SkillTool/SkillTool.ts`, `src/tools/AgentTool/runAgent.ts` (sub-loop fork)

Ready primary references:

- `src/main/modules/agent-control/turn-engine.ts` (current loop)
- `src/main/modules/agent-control/run-coordinator.ts` (entry, finalization)
- `src/main/modules/agent-control/active-skill-context.ts` (advisory observer to be subsumed)
- `src/main/modules/agent-control/skill-task-supervisor.ts` (advisory observer to be subsumed)
- `src/main/modules/agent-control/skill-budget-lease-controller.ts` (lease logic to be wired into frame)
- `src/main/modules/agent-control/task-projection-sync.ts` (projection write site)
- `src/main/modules/tools/skills-tools.ts`, `skill-tool-session-gate.ts` (gating to consume frame)
- `src/main/modules/tools/skill-primitives/*.ts` (primitives to consume frame's read sandbox)

## 11. What this route does NOT promise

It does not promise that adding a frame fixes the bug at runtime by itself. The frame is the *seam* through which Stages 3–7 land coherently. Without the frame, Stages 3–7 each invent their own version of "active context," and we end up with one more advisor.

It also does not promise that codex's draft was wrong. Most of codex's stages survive — they appear here as Stage 4 (liveness), Stage 5 (sandbox), Stage 6 (projection), Stage 7 (diagnostics), with tighter invariants and the "9 stages" reduced to 7 because Stage 0 ("freeze the failure with a regression test") is folded into each stage's verification, and Stage 8 ("budget under main loop") is already present in the lease controller and is consumed by the frame rather than re-architected.

The structural delta against codex's draft:

1. The frame is a *seam*, not a renamed `ActiveSkillContext`.
2. Steering (prompt + waste-scorer pressure) is named as a first-class output of the frame; codex omitted this and assumed visibility = selection.
3. Terminal closure (Stage 1) is moved before frame construction (Stage 2) because finalization gaps are blocking diagnostics for everything else.
4. CC-Source's L3/L4/L5 are explicitly out of scope for this route, with reasons. Codex implied a partial Tool-contract adoption without committing.

Future doc work: once Stage 2 lands, write a follow-up route for the L3 (Tool contract) and L5 (sub-loop) migrations.
