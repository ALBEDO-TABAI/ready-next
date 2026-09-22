---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent Checkpoint / Skill Resume Correction Route

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Implementation status:** Executed in the `codex/i-cross-boundary-confirmation` branch. The landed slice covers terminalReason propagation, renderer stop-state handling, VEA stage/action separation, fake preferred-tool blocking, VEA artifact truth, provider preflight, docs, and hard gates. The checklist below is the execution route that this implementation followed.

**Goal:** Make budget-paused / checkpoint turns stop cleanly in the chat UI, preserve terminal state across the main-to-renderer boundary, and prevent VEA resume turns from falling into fake tool names or diagnostic-only loops.

**Architecture:** Treat terminal turn state as a cross-boundary contract, not a local `turn-engine` detail. Treat VEA stage and executable action as different concepts: `score_batches` is progress state; `video_expert_ai_analyze` is the executable action. Treat VEA progress truth as artifact-backed (`scene_scores.json` + `host_batches`) rather than optimistic `run_state.json` text.

**Tech Stack:** Electron main process, TypeScript, direct-chat IPC, React renderer scope run state, embedded skill runtime, VEA child driver, Node test runner via `tsx`.

---

## 1. Current Verdict

This is not only a skill problem, and the agent module is not fully closed.

The agent side has improved: the current branch can recover a VEA frame and can compute terminal reasons such as `checkpoint_background` / `checkpoint_budget`. The remaining P0 break is that the terminal reason does not reliably survive `turn-engine -> transcript -> direct-chat IPC -> scopeRunEvent -> renderer state`. When that happens, the renderer sees an active `checkpoint` / `queued` phase with no terminal reason and keeps rendering the "thinking" indicator after the backend turn has ended.

The skill side also still has real gaps. The live VEA output directory had 97 scenes, 0 real scores, and all host batches pending. The turn also produced a non-existent preferred tool name, `skill_video_expert_analyzer_score_batches`, because a progress stage was treated as an executable action. That is a skill/agent integration bug, even if the child runner's budget close-event machinery is mostly healthy.

## 2. Review Resolution

### Adopted From Claude Review

- `terminalReason` must become a first-class field on the status / scope-run boundary.
- `finish(status='checkpoint')` must not emit a renderer-visible active state without the terminal reason.
- Task cards can show budget-paused correctly through projection while chat still shows "thinking"; those are separate pipelines and both need contracts.
- The `checkpoint -> queued` fallback is a legacy compatibility path and must be removed, not preserved as a safety net.
- Active phase + non-null terminal reason is an invariant: terminal reason always wins over streaming state.
- VEA stage and executable action should be separated by types, not comments.
- Blocking a synthesized fake preferred tool should emit a metric so any other synthesis path is visible in production.
- The final docs / CI work must include a concrete hard gate, not only a focused test list.

### Narrowed / Corrected

- The current branch already has partial `terminalReason` support in `ScopeRunEventPayload` and renderer `deriveScopeRunStatePatch`. The break is not "no field anywhere"; it is inconsistent propagation and a later event overwriting terminal state.
- `checkpoint` is not always active work. A checkpoint with `terminalReason` is terminal for the current assistant turn, even if the long-running task remains resumable.
- The fix should cover both `agent:status` and `agent:scopeRunEvent`, because the chat spinner reads scope-run state, not only the status event.
- A grep-style gate is appropriate here, but it must target terminal-status emissions only. `working` can remain a plain status update; `checkpoint` / `done` / `cancelled` / `error` need structured terminal data.

### Not Adopted

- "Skill has no gap" is too optimistic. Child close events may be correct, but VEA artifact truth and stage-to-action mapping are still incomplete.
- A renderer-only spinner patch is not enough. It would hide the symptom while leaving the IPC contract and fake tool-name path broken.
- Registering `score_batches` as a manifest action is not an acceptable shortcut. That would merge progress state and executable action, recreating the root problem under a new name.

## 3. Evidence To Preserve

- Backend turn ended before the screenshot: logs showed `success=true` and terminal reason `checkpoint_background`; the screenshot was taken later and still showed "thinking".
- `TurnTranscript.emitStatus(status)` currently only accepts a status string.
- `direct-chat.ts` emits `{ agent, sessionId, runId, status, isMock }` with no terminal reason.
- `ipc-handler.ts` maps unknown status values, including `checkpoint`, to scope phase `queued`; this can re-activate a run after the `done` output event.
- `runtimeDriver.ts` assigns `terminalReason: patch.terminalReason ?? null`, so a later event without terminal reason can clear a previously terminal state.
- `scopeRunState.ts` treats active phases as streaming unless `terminalReason` is present.
- VEA artifacts for the observed run showed 97 scenes, 0 scored scenes, and pending host batches; `run_state.status='running'` was not reliable progress proof.
- The deeper W3/W4 root is not "VEA is a bad skill"; it is that runtime boundaries allowed internal progress state to leak into the model-facing executable action namespace.

## 4. File Map

### Terminal Boundary

- Modify `src/main/modules/agent-control/turn-transcript.ts`
  - Extend status emission to carry `terminalReason`.
- Modify `src/main/modules/agent-control/turn-engine.ts`
  - Pass the computed terminal reason into final status emission.
- Modify `src/main/modules/claude-bridge/direct-chat.ts`
  - Include `terminalReason` in status payloads.
- Modify `src/main/modules/claude-bridge/ipc-handler.ts`
  - Convert checkpoint status into a terminal scope-run event with phase `checkpoint` and terminal reason.
- Modify `src/main/modules/agent-control/run-collector.ts`
  - Preserve terminal reason in `SendAndCollectResult` when status is `checkpoint` / `done` / `cancelled` / `error`.
- Modify `src/main/modules/agent-control/types.ts`
  - Keep main-side scope-run payload type authoritative.
- Modify `src/renderer/types/electron.d.ts`
  - Add `terminalReason` to renderer scope-run event data.
- Modify `src/renderer/modules/agent/runtimeDriver.ts`
  - Do not clear an existing terminal reason from a later same-run event that lacks terminal reason.
- Modify `src/renderer/modules/agent/scopeRunState.ts`
  - Keep the invariant: active phase + terminal reason is not streaming.
- Create `scripts/check-terminal-reason-propagation.cjs`
  - Enforce that terminal status emissions do not drop `terminalReason`.
- Create `scripts/__tests__/check-terminal-reason-propagation.test.cjs`
  - Cover accepted `working` status and rejected terminal status emissions without a reason.

### VEA Resume / Action Normalization

- Create `src/main/modules/agent-control/vea-resume-action.ts`
  - Own `VeaStage`, `VeaAction`, `VeaArtifacts`, and `resolveVeaResumeAction(stage, artifacts)`.
  - Keep `VeaStage` and `VeaAction` as disjoint namespaces.
- Modify `src/main/modules/tools/skill-primitives/inspect-run-state.ts`
  - Stop writing `currentStage` into `skillStatusUpdates.action`.
  - If a VEA run is in `score_batches` and has `sceneScoresPath`, map it to `video_expert_ai_analyze`.
- Modify `src/main/modules/agent-control/active-skill-context.ts`
  - Keep stage/progress separate from executable action.
- Modify `src/main/modules/agent-control/turn-frame.ts`
  - Do not allow status patches to overwrite a known executable action with a progress stage.
- Modify `src/main/modules/agent-control/turn-frame-steering.ts`
  - Never synthesize preferred tools from unknown action strings when the manifest does not contain that action.
  - Emit `preferred_tool_name_synthesis_blocked` when a candidate action is rejected.
- Keep `src/main/modules/agent-control/video-expert-child-driver.ts`
  - Use it as the correct reference: `score_batches` + `scene_scores.json` routes to `video_expert_ai_analyze`.

### VEA Progress / Provider Truth

- Modify `src/main/modules/agent-control/skill-progress-artifacts.ts`
  - Preserve strict progress truth: empty scene skeletons and pending host batches do not count as scored progress.
- Consider focused changes in the VEA config / preflight path only after the P0 agent boundary is fixed.
  - The observed stale `zai` error must not be treated as current truth unless a fresh typed action reproduces it.

## 5. Implementation Order

### W0 - Lock Failing Contracts First

- [ ] Add a failing renderer test: `checkpoint` scope event with `terminalReason='checkpoint_budget'` must make `isStreamingScopeRunState` false.
- [ ] Add an invariant test: for every active phase, any non-null terminal reason must make `isStreamingScopeRunState(...) === false`.
- [ ] Add a failing IPC / runtime-driver test: a final checkpoint status must produce a scope-run event with phase `checkpoint` and terminal reason.
- [ ] Add a failing collector / turn-engine contract test: `finish(status='checkpoint')` must return and emit a structured terminal reason.
- [ ] Add a failing VEA action test: `currentStage='score_batches'` must not create `skill_video_expert_analyzer_score_batches`.
- [ ] Add a projection consistency test: `taskContinuation.pauseReason='budget_exhausted'` must imply `terminalReason` is `checkpoint_budget` or `checkpoint_background`.

### W1 - Terminal Reason Status Contract

- [ ] Extend transcript status events to accept `{ terminalReason }`.
- [ ] Pass the computed `terminalReason` from `turn-engine.finish()` into `transcript.emitStatus(...)`.
- [ ] Extend direct-chat status payloads with `terminalReason`.
- [ ] Extend `StatusEventLike` / related tests so collectors do not drop it.
- [ ] Verify checkpoint turns resolve with `terminalReason='checkpoint_budget' | 'checkpoint_background' | 'checkpoint_user_input'`, not generic success.

### W2 - ScopeRunEvent / Renderer Stop Contract

- [ ] Map `checkpoint` status to scope-run phase `checkpoint`, not `queued`.
- [ ] Delete the legacy unknown-status `queued` fallback for terminal/unknown statuses; unknown statuses must be logged / metriced / ignored or mapped to an explicit non-active failure, never silently made active.
- [ ] Emit checkpoint as terminal-for-this-turn: include `terminalReason` and use an event type that cannot be mistaken for an active run.
- [ ] Add `terminalReason` to renderer `ScopeRunEventData`.
- [ ] Update `runtimeDriver` so a later same-run event without terminal data cannot clear an existing terminal reason.
- [ ] Verify the chat spinner disappears while task cards can still show "budget paused" / resumable state.
- [ ] Document in the PR description why `unknown -> queued` is forbidden, so the same compatibility fallback is not reintroduced.

### W3 - VEA Stage-To-Action Normalization

- [ ] Add a typed normalization helper for VEA resume action selection: `(stage: VeaStage, artifacts: VeaArtifacts) => VeaAction | null`.
- [ ] Make progress `stage` and manifest `action` compile-time distinct. `inspect-run-state.ts` must not be able to assign raw `currentStage` to `skillStatusUpdates.action`.
- [ ] Map `score_batches` / `merge_validate` / `finalize` only when the required artifact path exists.
- [ ] Preserve progress stage separately for user-facing status.
- [ ] Remove or block fallback preferred tool synthesis for unknown action names.
- [ ] Emit `preferred_tool_name_synthesis_blocked` when blocking an unknown action-derived tool name.
- [ ] Verify preferred tools contain real manifest names such as `skill_video_expert_ai_analyze`, never `skill_video_expert_analyzer_score_batches`.

### W4 - VEA Progress And Provider Preflight

- [ ] Add a focused preflight before typed scoring: preferred provider/model must exist in the current model catalog.
- [ ] If preflight fails, surface a blocked state with the current provider/model reason.
- [ ] If preflight passes, run the typed action and update artifacts; do not let stale `delivery_report.json` alone keep the task blocked.
- [ ] Verify 0/97 scored scenes remains a resumable incomplete state, not a fake completed/running state.

### W5 - Docs And Gates

- [ ] Update `CLAUDE.md` and `AGENTS.md` §6.13 / §6.17 with the checkpoint terminal IPC contract.
- [ ] Update `CLAUDE.md` and `AGENTS.md` §6.13 to state that skill progress/stage and manifest action are disjoint namespaces; runtime must never expose progress stage as part of a model-facing tool name.
- [ ] Add `scripts/check-terminal-reason-propagation.cjs` and wire it into the focused gate for this work.
- [ ] Add a test for `preferred_tool_name_synthesis_blocked` emission when a fake action-derived tool is rejected.
- [ ] Record the final evidence: backend terminal log, renderer non-streaming state, VEA typed action choice, and artifact progress truth.

## 6. Test Plan

Run focused tests first:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/scope-run-state.test.ts \
  src/__tests__/turn-engine-contract.test.ts \
  src/__tests__/turn-engine-route.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts
```

Then run VEA-focused tests:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-inspect-run-state-vea-contract.test.ts \
  src/__tests__/turn-frame-steering.test.ts \
  src/__tests__/turn-frame-steering-force-tool.test.ts \
  src/__tests__/video-expert-child-driver.test.ts
```

Run hard gates:

```bash
node scripts/check-terminal-reason-propagation.cjs
node --test scripts/__tests__/check-terminal-reason-propagation.test.cjs
```

Final local verification:

```bash
npm run typecheck
npm run native:check
```

If SQLite-backed runtime paths are touched, run:

```bash
npm run verify:native
```

Manual acceptance:

- Start `npm run dev`.
- Reproduce the paused VEA turn.
- Confirm the assistant no longer stays in "thinking" after checkpoint.
- Confirm the task card still shows the resumable budget-paused state.
- Confirm the next VEA resume route exposes / chooses the real typed action and does not create a fake tool name.

## 7. Non-Goals

- Do not rewrite the whole agent loop.
- Do not add visible renderer buttons.
- Do not scan all disks for VEA state.
- Do not treat every `run_state.json` as trustworthy progress.
- Do not move provider config again until a fresh typed action proves current config is invalid.

## 8. Stop Conditions

- Stop if checkpoint terminal reason is present in main result but absent from renderer state after W2; that means another boundary is dropping it.
- Stop if typed action normalization would require changing embedded skill manifests; inspect the manifest contract before patching.
- Stop if any implementation tries to add `score_batches` / `merge_validate` / `finalize` as manifest actions instead of keeping them as progress stages.
- Stop if VEA provider preflight fails against current config; surface the exact provider/model mismatch before continuing.
