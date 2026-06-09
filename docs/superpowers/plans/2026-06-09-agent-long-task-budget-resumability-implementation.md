---
date: 2026-06-09
status: approved v4 — enforce after Claude final review
enforce: true
scope:
  - Agent SDK live budget accounting
  - task projection persistence
  - budget checkpoint resumability
  - research/browser tool-surface continuity
  - provider protocol guardrails
  - browser collection partial resume
  - durable diagnostics
  - stale skill-run reconciliation
source_reviews:
  - Codex runtime/log/database audit on 2026-06-09
  - Claude independent audit pasted on 2026-06-09
  - Claude follow-up review incorporated on 2026-06-09
  - Claude final review approved enforcement on 2026-06-09
revision_history:
  - v1 (2026-06-09): expanded plan for cross-review before implementation.
  - v2 (2026-06-09): incorporated Claude follow-up. Added controlled Ready-side
    budget pause at the tool-batch boundary, clean transcript checkpoint requirements,
    70/90 percent live warning steering, earlier run-meta observability, provider
    protocol inference refinements, browser partial terminal-vs-resumable split,
    and long browser collection task-type follow-up.
  - v3 (2026-06-09): incorporated Claude follow-up 2. Reframed WP3 as
    composition of existing Agent SDK session seed / compaction / tool-pair
    integrity / child-run single-flight primitives; clarified batch-settled
    pause and warning boundaries, same-task projection continuation, SDK
    maxTurns safety formula, session-recall boundary, long-browser type staging,
    and no backfill for legacy frozen rows.
  - v4 (2026-06-09): Claude final review found no blocking architecture gaps.
    Flipped `enforce` to true. Implementation reminders: add a renderer
    task-card resume-route assertion for budget checkpoints, ensure checkpoint
    resume unfreezes budget runtime, and keep the SDK maxTurns floor from being
    lowered by long-reading adjustments.
---

# Agent Long Task Budget And Resumability Closure

## 0. Current Status

This document is an approved implementation contract after Codex audit and three
Claude review passes. It is now enforceable for implementation.

The first implementation PR must add failing behavior tests or gates for the
contracts below before changing runtime behavior.

## 1. Problem Statement

Recent long agent threads, especially research and browser collection tasks,
often fail in a pattern that looks like several independent bugs:

- research tasks hit a tool limit around 24 calls;
- the assistant tells the user to continue, but the task cannot actually resume;
- task records show `tools_used = 0` even when chat text says 24 or 27 tools ran;
- follow-up turns can lose research tools such as web fetch;
- browser collection can collect partial results, then mark the task failed;
- model-service failures sometimes surface as parse or protocol errors;
- logs are hard to recover after the fact.

The root issue is more unified:

Ready's durable budget, warning, projection, and continuation ledger exists, but
the live Agent SDK execution path is not fully connected to it. The SDK path
still derives its model-run limit from a local constant, while the task-budget
runtime used by projection and resumability remains mostly bootstrap state.

The visible result is a hard wall instead of a controlled pause:

1. The task type may be `research`, but the persisted budget still says
   `short_task` / 24.
2. The live SDK run stops at a max-turn boundary.
3. The checkpoint text says "continue", but no durable continuation handle is
   written.
4. The next user "continue" starts from an incomplete shell of context, or starts
   a new task.
5. Projection, diagnostics, and UI cannot explain what really happened.

## 2. Evidence Snapshot

Evidence collected from the local Ready database and current source:

- `task_projections` has 199 rows. In the audited database, 39 rows had
  `task_type = research`, but their `budget_json.taskType` was still
  `short_task` and `maxToolCalls` was 24.
- Across those rows, no projection recorded a non-zero tool-call count.
- `run_meta` existed but had 0 rows.
- `continuation_ref_json` existed on only 4 blocked rows and on none of the
  completed, failed, killed, or recoverable-paused rows.
- Existing frozen rows that already lack durable continuation handles will not
  become resumable retroactively; this plan fixes new checkpoints and can mark
  old rows as legacy-not-resumable in diagnostics.
- `skill_task_runs` had 15 rows still marked `running` from old work.
- Browser collection failures included incomplete collection, user-view lease
  failures, and note-collection tasks that are not resumable across restart.
- Runtime code defines a research budget preset of 60 tool calls, but the Agent
  SDK run-limit path still has `DEFAULT_AGENT_SDK_MAX_TURNS = 24`.
- `AgentSdkRuntime.buildResult()` currently returns execution diagnostics with
  `toolSnapshots: null`, but no live `taskBudgetRuntime`.
- The macOS log documentation says `/tmp`, while the code uses `os.tmpdir()`.
  On this machine that resolves to `/var/folders/.../T`.
- `shouldInjectBudgetWarning()` / budget-warning steering is wired through the
  legacy TurnEngine path, not the Agent SDK path.
- Other budget sources exist outside `run-budget-policy`, including
  `task-execution-router.ts`, so implementation must retire or redirect those
  hard-coded values instead of introducing a third source.

Claude's most important correction is accepted: the practical 24-call wall is
not only a projection-label bug. The live Agent SDK path itself must be wired to
task budget runtime. Raising the number from 24 to 60 would only move the wall
farther away; it would not fix warnings, accounting, or resumability.

Claude's second review adds three mandatory correctness constraints:

1. Ready must stop at its own clean tool-batch budget boundary, not rely on the SDK's
   `MaxTurnsExceeded` as the normal pause mechanism.
2. A continuation snapshot must be taken only at a clean message boundary, or it
   must repair dangling tool-use/tool-result pairs before rehydration.
3. The 70/90 percent budget warning path must steer the live SDK loop to
   converge or ask the user, not merely display passive projection state.

## 3. Non-Goals

- Do not simply increase `DEFAULT_AGENT_SDK_MAX_TURNS`.
- Do not weaken `canResumeShape()` to treat a bare `taskId` as resumable.
- Do not mark partial browser collection as completed.
- Do not make provider protocol inference silently more permissive.
- Do not refactor unrelated TurnEngine, skill runtime, or browser collection
  code while fixing this path.
- Do not depend on source-grep tests as the only proof for user-visible behavior.

## 4. Completion Criteria

The work is complete only when all of these are true:

1. A research task launched through the Agent SDK gets a research budget in live
   runtime and in `task_projections.budget_json`.
2. Tool execution through the Agent SDK increments persisted tool-call usage.
3. Budget warning percent and warning level are visible to projection and also
   injected into the live SDK loop as a converge-or-ask steering message.
4. Ready controls budget pause at a clean tool-batch boundary before the SDK hard
   `maxTurns` wall is the normal stopping mechanism.
5. A budget-limit stop writes a durable continuation reference that passes
   `canResumeShape()`.
6. A budget checkpoint never persists a transcript with unmatched tool-use or
   tool-result pairs.
7. A bare "continue" on that task resumes the same task lineage with the same
   task projection row, same task type, restored budget state, and required tool
   surface. A new run id and MemorySession seed are allowed; a new task card is
   not.
8. Research/browser tools authorized before a budget checkpoint are available on
   continuation when the continuation state says they are required.
9. Browser collection with partial progress stores cursor, partial results,
   output paths, and either a continuation path or a terminal partial-success
   explanation when the remainder is permanently blocked.
10. Provider protocol mismatch is surfaced as a clear configuration/protocol
   error, not a raw JSON parse failure.
11. Critical long-task events survive after transient log files disappear.
12. Stale `skill_task_runs.running` rows are reconciled on startup.

## 5. Design Invariants

### I1. One Live Budget Runtime

Every scoped Agent SDK run has exactly one task-budget runtime for the active
task. That runtime owns:

- task type;
- max iterations;
- max tool calls;
- tool-call usage;
- iteration usage where available;
- warning level;
- bootstrap versus resolved state.

Projection, task cards, continuation, and diagnostics all read the same runtime
snapshot. They must not reconstruct competing budget truth from stale defaults.

### I2. Task Type Must Be Resolved Before Budget Is Committed

The initial planning event may still show "understanding request", but the
budget committed to the run must be upgraded as soon as intent classification or
tool domain proves the task is research, browser, media, or multi-step.

If task type is unknown at run creation, the first tool-surface resolution event
must be allowed to rebind the runtime from bootstrap to the resolved type before
the first durable projection write that users rely on.

### I3. Tool Usage Must Be Recorded At The Tool Boundary

The SDK model loop may not expose exact internal iteration count, but Ready owns
tool execution. Tool-call usage must increment at the boundary where
`executeReadyToolDefinition()` records a tool result. This is the reliable
signal users see and the one that currently appears in checkpoint text.

Iteration usage should be recorded when Ready can do it accurately. If exact SDK
turn count is unavailable, do not fake precision; record tool usage as the hard
budget signal and add an implementation note in diagnostics.

### I4. Ready Controls Budget Pauses At Tool Batch Boundaries

The SDK `maxTurns` limit is a safety net, not the normal long-task pause
mechanism. Ready should set SDK `maxTurns` high enough to avoid routine hard
throws, then stop at its own budget boundary after a clean tool batch has
produced corresponding tool results.

The pause sequence is:

1. let the current tool batch settle;
2. record every tool result in the batch;
3. increment the Ready task-budget runtime for each recorded result;
4. check warning/exhaustion thresholds after the batch is clean;
5. if warning threshold is crossed, inject live steering before the next model
   call;
6. if exhausted, prevent the next model call;
7. write a `checkpoint_budget` state and continuation handle;
8. emit a controlled checkpoint response.

This keeps budget closure under Ready's control and avoids relying on
`MaxTurnsExceeded` as the common user path.

### I5. Budget Checkpoint Must Carry A Durable Handle

A checkpoint that invites "continue" must carry one of:

- `childRunId`;
- `detachedTaskId`;
- `outputDir + runStatePath`.

A bare `taskId`, `skillId`, or chat message reference is not enough. If Ready
cannot write a durable handle, the UI must not advertise continuation.

### I6. Checkpoints Must Preserve Clean Tool Transcripts

Continuation state must not persist or rehydrate a transcript ending with an
assistant tool-use that lacks a matching tool-result. Anthropic/OpenAI-compatible
providers reject those histories.

Checkpoint may happen only after all in-flight tools in the current batch have
settled and their results have been recorded. Rehydration must reuse
`normalizeSessionSnapshotForSeed()` in
`src/main/modules/agent-control/compaction/compact-agent-input.ts`, which already
routes through `applyToolPairIntegrity()` and drops incomplete tool-use /
tool-result pairs as a unit. Do not add placeholder tool results; dropping the
incomplete turn is safer than inventing model output.

### I7. Budget Continuation And Session Recall Are Separate Entrances

Budget continuation is task-control resume: it enters through `runtime.resumeRun`
and `ContinuationIntent`, keeps the same task projection row, and restores a
run-state-backed checkpoint.

Session recall is conversation recall: `runtime.resumeSessionCandidate()` /
`SessionRecallService` attaches or resumes conversation context by
conversation id or resume title. The budget-continuation implementation may
reuse the same MemorySession seed primitive, but it must not create a second
competing "resume" path or confuse conversation recall with task continuation.

### I8. Tool Surface Is Part Of Continuation State

Continuation must restore the task's necessary tool surface. For research and
browser collection, this means persisting enough information to expose the same
tool group on the next turn instead of relying on a fresh intent guess.

### I9. Partial Progress Is Recoverable Or Explicitly Terminal

Partial browser collection is neither automatic success nor automatic failure.
If there is useful progress and a real cursor or equivalent resume point exists,
persist it as recoverable paused. If the remaining items are permanently blocked
by platform risk control or terminal skip reasons, accept the partial output as
terminal partial success with an explicit explanation.

### I10. Diagnostics Must Be Durable Enough For Long Tasks

Rotating logs can remain useful, but long-task close events, budget snapshots,
provider protocol decisions, and continuation references must also be available
from DB-backed diagnostics or a diagnostic pack.

## 6. Implementation Work Packages

### WP0. Contract Tests First

Purpose: prove the current failure shape and prevent superficial fixes.

Add tests before changing runtime logic:

- Test harness prerequisite:
  - add a scripted Agent SDK model seam if current `AgentSdkRuntimeDeps`
    cannot simulate multi-turn model responses, max-turn behavior, tool calls,
    budget warnings, and provider protocol failures without a real LLM;
  - keep this seam narrow and test-only unless production already has the
    equivalent injection point.
- `src/__tests__/agent-sdk-budget-runtime.test.ts`
  - research scoped SDK run resolves to research budget, not 24-call
    `short_task`;
  - SDK tool execution increments `toolCallsUsed`;
  - final projection carries non-zero budget usage.
- `src/__tests__/agent-sdk-budget-checkpoint-continuation.test.ts`
  - simulated Ready-side budget exhaustion after tool progress creates
    checkpoint without depending on SDK `MaxTurnsExceeded`;
  - checkpoint writes continuation ref with `outputDir + runStatePath`;
  - checkpoint waits until the whole tool batch has produced matching tool
    results;
  - rehydration uses `normalizeSessionSnapshotForSeed()` and drops incomplete
    tool-use/tool-result pairs rather than synthesizing placeholder results;
  - budget continuation reuses the same task projection row;
  - resumable actions are empty when no valid handle exists.
- `src/__tests__/agent-sdk-budget-warning-steering.test.ts`
  - 70/90 percent budget thresholds inject converge-or-ask steering only after a
    clean tool batch, before the next model call;
  - warning steering is recorded in projection and run diagnostics.
- `src/__tests__/agent-sdk-research-tool-surface-continuation.test.ts`
  - a research checkpoint persists required research tool group or tool names;
  - a bare continuation restores that surface.
- `src/__tests__/browser-collection-partial-resume.test.ts`
  - incomplete collection with a real cursor becomes recoverable paused;
  - incomplete collection with permanently blocked remainder becomes terminal
    partial success with explanation;
  - checkpoint stores cursor and partial results;
  - resume uses saved cursor instead of restarting from zero.
- `src/__tests__/provider-protocol-guardrails.test.ts`
  - `openai-compatible` with an Anthropic-style endpoint and no explicit
    protocol is rejected or normalized intentionally;
  - OpenAI chat path receiving SSE by content type or SSE-shaped body reports
    protocol mismatch.
- `src/__tests__/diagnostic-pack-long-task.test.ts`
  - diagnostic pack includes budget snapshot, continuation ref, terminal reason,
    and recent provider/runtime errors with secret redaction intact.
- `src/__tests__/agent-budget-continuation-session-boundary.test.ts`
  - budget continuation enters through task-control resume, while
    `resumeSessionCandidate()` remains a conversation-recall probe.
- `src/__tests__/run-meta-long-task-observability.test.ts`
  - scoped SDK runs write run-meta rows with task id, budget, terminal reason,
    provider protocol, and continuation summary.
- `src/__tests__/skill-task-run-startup-reconciliation.test.ts`
  - stale running skill rows are reconciled to recoverable paused when handles
    are valid, otherwise failed or killed with a clear reason.

Acceptance:

- The new tests fail on the current code for the known gaps.
- The tests drive behavior through real runtime/coordinator boundaries where
  feasible, not source grep.

### WP1. Resolve Initial Task Type And Budget In RunCoordinator

Files:

- `src/main/modules/agent-control/task-projection/run-coordinator.ts`
- `src/main/modules/agent-control/task-projection/run-budget-policy.ts`
- `src/main/modules/agent-control/task-type-resolver.ts`
- `src/main/modules/agent-control/contracts/run-contracts.ts`

Changes:

1. Reuse the existing task-type resolver instead of adding a parallel helper.
   Feed it prepared intent, trigger module, request envelope, and known
   tool-domain hints.
2. When the resolver can prove `research`, `multi_step_task`, or `media_task`,
   call `createRunBudgetSeed(taskType)` immediately. Do not reference the
   long-browser-collection type here until WP6 defines it; WP6 will add its
   resolver hook in the same PR that adds the type.
3. Create `TaskBudgetRuntime` with that task type instead of always starting as
   `short_task`.
4. Keep bootstrap mode only when the type is genuinely unknown.
5. Treat early task typing as an optimization, not the only source of truth.
   Many tasks start ambiguous; the first tool-resolution event must be able to
   rebind from bootstrap to the resolved type.
6. When result or tool events later prove a more specific task type, rebind once
   using existing `rebindTaskBudgetRuntime()` and preserve usage.
7. Persist the resolved runtime in the first meaningful projection event.

Acceptance:

- A research scoped run no longer writes
  `task_type = research` with `budget_json.taskType = short_task`.
- Bootstrap budget does not remain `bootstrapBudget: true` after the task type is
  resolved.

### WP2. Connect AgentSdkRuntime To Budget Runtime

Files:

- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/task-projection/run-budget-policy.ts`
- `src/main/modules/agent-control/task-execution-router.ts`
- `src/main/modules/agent-control/tools-runtime/tool-runtime.ts`
- `src/main/modules/agent-control/contracts/run-contracts.ts`

Changes:

1. Type `AgentSdkExecutionOptions.budget`, `budgetState`, and
   `taskBudgetRuntime` instead of leaving them as `unknown`.
2. Initialize a live SDK budget runtime from `executionOptions.taskBudgetRuntime`
   or from `executionOptions.budget + budgetState`.
3. Stop treating SDK `maxTurns` as the primary Ready budget gate. Set it as a
   high safety ceiling above the Ready tool budget so accidental infinite model
   loops still fail, but normal long-task pause happens under Ready control.
   Initial formula:
   `sdkMaxTurns = maxToolCalls + max(8, ceil(maxToolCalls * 0.25))`, then apply
   any existing local-document or long-reading floor/ceiling as an explicit
   safety adjustment. Do not set it below `maxToolCalls + 8`.
4. Add a Ready-side controlled-pause check around the tool-result recording path:
   `recordToolResult()` records output and increments the live budget runtime,
   but the exhaustion/warning decision runs after the whole tool batch settles
   and before the next model call.
5. When the Ready budget is exhausted, finish the current tool batch, avoid
   issuing another model call, and enter a dedicated `checkpoint_budget` branch
   that writes continuation state. This branch is separate from the
   `MaxTurnsExceeded` fallback.
6. Add a helper to consume tool-call budget on `TaskBudgetRuntime`, or extend
   `consumeToolCallBudget()` with a runtime overload.
7. Increment tool-call usage when `recordToolResult()` is called.
8. Increment iteration usage only at a reliable boundary. If the SDK does not
   expose exact internal turns, record a conservative run-attempt count and rely
   on tool-call usage for hard budget control.
9. Inject budget-warning steering into the Agent SDK loop when the runtime
   crosses the warning thresholds, but only after a clean tool batch and before
   the next model call. At warning level, steer the model to converge or
   summarize next steps; at the high threshold, prefer `ask_user_questions` or a
   clear checkpoint plan if continuation requires user approval.
10. Emit updated `executionDiagnostics.taskBudgetRuntime`,
   `budgetUsagePercent`, and `budgetWarningLevel` on tool events and final
   events.
11. Return the live `taskBudgetRuntime` from `buildResult()`.
12. Retire or redirect duplicate hard-coded budget sources in
    `task-execution-router.ts` so `run-budget-policy.ts` / `TaskBudgetRuntime`
    is the single preset source.

Acceptance:

- Chat text saying "used 24 tools" and projection `toolCallsUsed` no longer
  disagree.
- `budget_usage_percent` and `budget_warning_level` are no longer always empty
  for active long tasks.
- 70/90 percent thresholds produce live converge-or-ask behavior in the SDK
  path, not only passive projection metadata.
- Ready-side budget exhaustion creates a controlled checkpoint without relying
  on the SDK hard max-turn exception.
- The SDK path is covered by tests, not only TurnEngine tests.

### WP3. Make Budget Checkpoint Truly Resumable

Files:

- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/compaction/compact-agent-input.ts`
- `src/main/modules/agent-control/skills/skill-child-runner.ts`
- `src/main/modules/agent-control/runtime-core/runtime.ts`
- `src/main/modules/agent-control/contracts/resume-handle.ts`
- `src/main/modules/agent-control/contracts/continuation-state.ts`
- `src/main/modules/agent-control/task-projection/task-projection-sync.ts`

Changes:

1. Treat this package as composition of existing primitives, not a new resume
   subsystem.
2. Add an Agent SDK continuation state writer for budget checkpoints.
3. Reuse the existing skill-child-runner state-directory pattern where possible
   instead of introducing an unrelated `agent-continuations/` hierarchy. The
   continuation still exposes the same `outputDir + runStatePath` shape required
   by `canResumeShape()`.
4. Reuse the existing Agent SDK session seed path in `agent-sdk-runtime.ts`
   where `oldRun.capturedSession.getItems()` is normalized by
   `normalizeSessionSnapshotForSeed()` and then passed to
   `new MemorySession({ initialItems })`.
5. For compacted snapshots, reuse `compactMemorySession()` instead of adding a
   second compaction implementation.
6. Reuse `normalizeSessionSnapshotForSeed()` / `applyToolPairIntegrity()` for
   transcript hygiene. Do not add placeholder tool results.
7. Reuse the child-runner trusted-handle / single-flight pattern to prevent two
   rapid "continue" actions from launching duplicate continuation runs.
8. The state file should include:
   - version;
   - scope id;
   - task id;
   - run id;
   - agent name;
   - task type;
   - budget runtime;
   - terminal reason;
   - last user message summary;
   - compacted session snapshot or seed messages;
   - used tool names;
   - required capability groups;
   - recent projection patch;
   - browser collection ids if relevant;
   - created/updated timestamps.
9. Snapshot only at a clean transcript boundary: all in-flight tools in the
   current batch must have settled and their tool results must be recorded
   before `capturedSession.getItems()` is persisted.
10. Normalize the persisted session snapshot on the read side so it cannot end
    with an unmatched assistant tool-use. Dirty legacy snapshots should drop the
    incomplete pair through the existing integrity helper.
11. Set `continuation_ref_json` to include `outputDir` and `runStatePath`.
12. Set `resumableActions` to `['continue', 'retry', 'cancel']` only when the
   continuation ref passes `canResumeShape()`.
13. On resume, load the state file and merge it into `ContinuationIntent`.
14. Resume against the same task projection row. The run id and seeded
    MemorySession may be new, but projection lineage is not a new task card.
15. Restore task type and budget runtime before new tool resolution.
16. Clear the continuation state on done/cancel or when it is superseded by a
   newer task.

Acceptance:

- A checkpoint-budget row has `continuation_ref_json.outputDir` and
  `continuation_ref_json.runStatePath`.
- `runtime.buildContinuationIntent()` returns non-null for that row.
- A bare "continue" updates the same task projection row from
  recoverable/blocked to running/resuming, not an unrelated fresh task card.
- Rehydrated provider history is valid for Anthropic/OpenAI-compatible tools and
  has no dangling tool-use/tool-result pair.
- Double-clicking or racing "continue" is collapsed by the trusted-handle /
  single-flight guard and does not launch duplicate continuation runs.

### WP4. Preserve Research And Browser Tool Surface Across Continuation

Files:

- `src/main/modules/agent-control/domain-adapters/research-domain-adapter.ts`
- `src/main/modules/agent-control/domain-adapters/browser-domain-orchestrator.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/agent-control/runtime-core/runtime.ts`
- `src/main/modules/agent-control/restart-intent-classifier.ts`

Changes:

1. Include `taskType`, capability group ids, and required tool names in the
   continuation state.
2. For research checkpoints, persist a research continuation hint so web search
   and web fetch tools are visible on resume.
3. For browser collection checkpoints, persist source task id, collection kind,
   strategy, and resume cursor.
4. During resume, feed these hints into the same tool-definition resolution path
   used by a fresh run.
5. If a persisted tool is no longer available, surface a clear
   `tool_surface_changed` recovery message instead of letting the model call a
   missing tool.

Acceptance:

- A research task that used web tools before checkpoint can use them after
  continuation.
- Missing tools produce a controlled blocked state with retry/cancel, not raw
  "tool not found".

### WP5. Provider Protocol And Context Guardrails

Files:

- `src/shared/ai-providers.ts`
- `src/shared/context-budget-types.ts`
- `src/shared/ai-providers/openai-compatible.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/settings-engine/external-service-store.ts`
- `src/main/modules/settings-engine/ipc-handler.ts`
- `src/renderer/pages/Settings.tsx`

Changes:

1. Treat `agentProtocol` as a required durable choice for custom
   `openai-compatible` profiles whose base URL does not match a known provider.
2. Extend protocol inference so base URLs matching `/\/anthropic(\/|$)/i` or
   `/v1/messages` resolve to Anthropic protocol even if an explicit override is
   missing. Keep typed save-time validation as a second line of defense.
3. In the OpenAI chat-completions path, detect SSE/protocol mismatch by
   `Content-Type: text/event-stream` or bodies that look like SSE
   (`event:`, `data:`, comments, or leading whitespace before those markers),
   then throw a typed provider protocol mismatch error instead of raw
   `JSON.parse`.
4. Add a settings warning for custom profiles with no `contextWindowOverride`.
5. Do not default unknown custom providers to optimistic long-context behavior
   or invisible 200k. Use a conservative numeric fallback and surface it as an
   estimate that the user can override explicitly.
6. Add a provider diagnostic field that records resolved protocol, wire API,
   context window, and whether the values were explicit or inferred.

Acceptance:

- The active Mimo-style configuration is explicit about protocol and context.
- A protocol mismatch is actionable in UI and diagnostic pack.
- Long-context packing decisions cite an explicit or documented window, not an
  invisible fallback.

### WP6. Make Browser Collection Partial Results Resumable

Files:

- `src/main/modules/browser-engine/content-task-runner.ts`
- `src/main/modules/browser-engine/agent-collection-plan.ts`
- `src/main/modules/browser-engine/collection-targets.ts`
- `src/main/modules/agent-control/task-projection/run-budget-policy.ts`
- `src/main/modules/agent-control/contracts/run-contracts.ts`
- `src/main/modules/claude-bridge/browser-collection-projection-sink.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/__tests__/browser-tools.test.ts`
- `src/__tests__/browser-collection-targets.test.ts`

Changes:

1. Add a dedicated long-browser-collection task type if implementation confirms
   browser collection needs different budget and lifecycle semantics than
   generic `research`. The initial preset may inherit research-level headroom,
   but it should be a separate type so future platform limits and partial
   semantics do not distort general research.
2. Change incomplete collection handling so useful partial progress becomes:
   - `recoverable_paused` when there is a real cursor or a next action that can
     advance work;
   - terminal partial success when remaining items are permanently blocked by
     risk control, terminal skip reasons, or platform limits;
   - failed only when no useful output or resume path exists.
3. Persist:
   - cursor;
   - partial results;
   - failed items;
   - expected count;
   - source task id;
   - output root;
   - strategy;
   - stop reason.
4. Treat `expected = discovered count` as a target, not an unconditional success
   threshold. Explain when partial output is accepted as final.
5. For restart recovery, do not permanently cancel `note_collect` or
   `card_loop` solely because the old agent tab is gone. Re-acquire a fresh
   agent tab after explicit user continue and continue from saved cursor when
   state is sufficient.
6. If the platform is high-control, default continuation to `card_loop`.
   `url_batch` remains blocked unless explicit downgrade consent exists.
7. Projection should show partial progress and a real continue action only for
   recoverable partials.
8. If no cursor or partial state exists, keep failed/cancelled behavior and
   explain why it cannot resume.

Acceptance:

- A 69-item collection that reaches 47/62/67 items is not thrown away.
- The task card can resume the collection from the saved cursor.
- Permanently blocked remainder can close as explicit partial success instead
  of infinite retry.
- Cross-restart resume is tested for saved state that does not depend on the old
  tab id.

### WP7. Durable Diagnostics And Run Meta

Files:

- `src/main/modules/agent-control/task-projection/run-meta-repository.ts`
- `src/main/modules/agent-control/task-projection/run-coordinator.ts`
- `src/main/modules/app-control/diagnostic-pack-core.ts`
- `src/main/utils/platform.ts`
- `src/main/utils/rotating-logger.ts`
- `AGENTS.md`
- `CLAUDE.md`

Changes:

1. Wire `RunMetaRepository` into the production scoped-run close path.
2. Record:
   - run id;
   - task id;
   - scope id;
   - model/provider protocol;
   - task type;
   - budget snapshot;
   - terminal reason;
   - continuation ref summary;
   - usage tokens when available;
   - recovery history.
3. Keep rotating logs in `os.tmpdir()`, but do not make them the only source for
   long-task postmortems.
4. Extend diagnostic pack summaries to include budget JSON, warning level,
   provider protocol decisions, and continuation state summary.
5. Update AGENTS.md and CLAUDE.md to say macOS logs use the system temp
   directory from `os.tmpdir()`, not necessarily `/tmp`.
6. Add a legacy-row diagnostic classification for existing task projections
   that have frozen/empty budget state and no durable continuation handle. Do
   not attempt to backfill resumability for rows that never persisted the needed
   state.

Acceptance:

- `run_meta` has rows after a real scoped Agent SDK run.
- Diagnostic pack can explain a budget checkpoint without needing old temp logs.
- Documentation no longer points investigators to the wrong macOS directory.
- Legacy frozen rows are clearly reported as not retroactively resumable.

### WP8. Startup Reconciliation For Stale Skill Runs

Files:

- `src/main/modules/agent-control/skills/skill-child-runner.ts`
- `src/main/modules/agent-control/skills/skill-task-supervisor.ts`
- `src/main/modules/repositories/skill-task-run-repository.ts`
- `src/main/modules/agent-control/skills/skill-task-lifecycle.ts`

Changes:

1. On Ready startup, scan `skill_task_runs` rows in `running`.
2. If a row has a valid durable handle and run state, mark it
   `recoverable_paused/process_restarted`.
3. If a row has no usable handle and has been stale beyond the allowed window,
   mark it `failed/stale_running_without_handle`.
4. Emit a diagnostic metric with counts.
5. Ensure task projection reflects the reconciled state.

Acceptance:

- Old running rows do not survive indefinitely after app restart.
- The active-runs UI and diagnostics are not polluted by half-month-old rows.

## 7. Rollout Plan

### PR 1. Contracts And Failing Tests

Add WP0 tests and the scripted-model test seam needed to drive the SDK path
without real LLM calls. No production behavior changes except exported test
seams if unavoidable.

Verification:

- Targeted new tests fail for the current code.
- Existing `npm run typecheck` remains green if no production code changed.

### PR 2. Durable Observability Baseline

Implement the low-risk part of WP7 first: wire `RunMetaRepository` for scoped
SDK run close events and extend diagnostic-pack summaries for budget/terminal
snapshots. Do not wait until the end; later PRs need reliable evidence.

Verification:

- `run-meta-long-task-observability.test.ts`
- `diagnostic-pack-long-task.test.ts`
- existing diagnostic pack tests
- `npm run typecheck`

Manual DB check:

```sql
SELECT COUNT(*) FROM run_meta;
```

Expected: scoped SDK runs create run-meta rows before deeper runtime changes.

### PR 3. SDK Budget Runtime Wiring

Implement WP1 and WP2.

Verification:

- `agent-sdk-budget-runtime.test.ts`
- `agent-sdk-budget-warning-steering.test.ts`
- existing `task-budget-runtime-alignment.test.ts`
- existing `agent-sdk-scoped-run-persistence.test.ts`
- `npm run typecheck`

Manual DB check after a research run:

```sql
SELECT task_type,
       json_extract(budget_json, '$.taskType'),
       json_extract(budget_json, '$.maxToolCalls'),
       json_extract(budget_json, '$.toolCallsUsed')
FROM task_projections
ORDER BY updated_at DESC
LIMIT 5;
```

Expected: research rows carry research budget and non-zero usage after tools.

### PR 4. Budget Checkpoint And Continuation

Implement WP3 and WP4.

Verification:

- `agent-sdk-budget-checkpoint-continuation.test.ts`
- `agent-sdk-research-tool-surface-continuation.test.ts`
- `agent-budget-continuation-session-boundary.test.ts`
- existing `can-resume-helper.test.ts`
- existing task projection tests

Manual DB check:

```sql
SELECT status,
       interaction_state,
       resumable_actions_json,
       continuation_ref_json,
       blocked_reason
FROM task_projections
ORDER BY updated_at DESC
LIMIT 5;
```

Expected: checkpoint-budget rows have continuation refs that include
`outputDir` and `runStatePath`.

### PR 5. Provider Guardrails

Implement WP5.

Verification:

- `provider-protocol-guardrails.test.ts`
- existing provider capability tests
- settings contract tests touched by external-service changes

Manual check:

- Saving custom providers without explicit protocol/context produces clear UI
  guidance.
- Existing explicit Anthropic-compatible profiles still work.

### PR 6. Browser Partial Collection Resume

Implement WP6.

Verification:

- `browser-collection-partial-resume.test.ts`
- `browser-tools.test.ts`
- `browser-collection-targets.test.ts`
- `task-card-action-buttons.test.tsx`

Manual check:

- Simulate a partial collection with useful progress.
- Confirm task card shows partial count and continue.
- Resume continues from cursor.
- Permanently blocked remainder closes as explicit partial success.

### PR 7. Diagnostics Finish, Docs, And Stale Run Reconciliation

Finish the remaining WP7 documentation/log-path updates and implement WP8.

Verification:

- `skill-task-run-startup-reconciliation.test.ts`
- existing diagnostic pack tests
- `npm run verify:native`

Manual DB check:

```sql
SELECT COUNT(*) FROM run_meta;
SELECT status, COUNT(*) FROM skill_task_runs GROUP BY status;
```

Expected: run-meta continues to populate; stale `running` rows do not remain
stale after startup reconciliation.

### PR 8. End-To-End Dogfood

Run one real long research task and one browser collection partial-resume task.

Required observations:

1. Research task starts with research budget.
2. Tool usage increments during execution.
3. Ready-side controlled budget checkpoint writes a continuation handle.
4. Bare "continue" updates the same task projection row and preserves research
   tools.
5. Browser partial collection either resumes from cursor or closes as explained
   partial success when the remainder is permanently blocked.
6. Diagnostic pack explains the run after temp logs are ignored.
7. A pre-existing legacy row with no continuation handle is reported as not
   retroactively resumable, rather than pretending it can continue.

Manual database path rule:

- Dev builds may write under `~/Library/Application Support/Electron/ready.db`.
- Packaged/current production builds may write under
  `~/Library/Application Support/ready/ready.db`.
- PR-level manual SQL must state which database path was used.

## 8. Test And Verify Matrix

Minimum verification before calling implementation done:

```bash
npm run typecheck
npm run test
npm run verify:native
```

Focused tests expected across the rollout:

```bash
npx tsx --test src/__tests__/agent-sdk-budget-runtime.test.ts
npx tsx --test src/__tests__/agent-sdk-budget-checkpoint-continuation.test.ts
npx tsx --test src/__tests__/agent-sdk-budget-warning-steering.test.ts
npx tsx --test src/__tests__/agent-sdk-research-tool-surface-continuation.test.ts
npx tsx --test src/__tests__/agent-budget-continuation-session-boundary.test.ts
npx tsx --test src/__tests__/browser-collection-partial-resume.test.ts
npx tsx --test src/__tests__/provider-protocol-guardrails.test.ts
npx tsx --test src/__tests__/run-meta-long-task-observability.test.ts
npx tsx --test src/__tests__/diagnostic-pack-long-task.test.ts
npx tsx --test src/__tests__/skill-task-run-startup-reconciliation.test.ts
```

If the runtime touches SQLite-backed acceptance, `npm run verify:native` is
mandatory. A host-Node sqlite skip is not sufficient for closure.

## 9. Claude Follow-Up Decisions

1. Tool-call usage is the hard budget signal. SDK internal turn count can be
   used for display only if exposed reliably; do not use it as the hard gate.
2. Continuation should use a run-state JSON file exposed through
   `outputDir + runStatePath`, preferably reusing the skill-child-runner
   directory/state pattern.
3. Unknown custom provider context windows should warn and fall back
   conservatively. Do not silently use invisible 200k as if it were confirmed.
4. Browser `note_collect` cross-restart resume requires one explicit continue
   click before recreating the agent tab.
5. Long browser collection should get its own task type if implementation
   confirms the budget/lifecycle split. This is now part of WP6, but it should
   not block WP1-WP4's core budget and continuation closure.

## 10. Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Budget accounting double-counts tools. | Increment only at `recordToolResult()` and test one native path plus one text-bridge path. |
| SDK max turns and Ready tool budget are not the same unit. | Use SDK maxTurns as a high safety net only. Ready pauses after a clean tool batch using task-budget runtime. |
| Checkpoint persists a dangling assistant tool-use. | Snapshot only after all tool results are recorded; sanitize or repair legacy dirty snapshots before rehydration. |
| Budget warning is visible but not actionable. | Inject live converge-or-ask steering at warning thresholds and cover it with SDK-path tests. |
| Continuation state grows too large. | Store compacted session snapshot and recent projection truth, not full raw transcript. |
| Double-click continue launches duplicate work. | Reuse the trusted-handle / single-flight guard and test concurrent resume calls. |
| Resume restores stale tools after settings change. | Detect missing persisted tools and block with `tool_surface_changed` instead of executing. |
| Browser collection resumes a high-control platform too aggressively. | Require explicit continue, recreate agent tab only after that click, and keep url_batch downgrade consent separate. |
| Browser partials loop forever on permanently blocked items. | Distinguish recoverable cursor progress from terminal partial success with explanation. |
| Diagnostic pack leaks secrets. | Reuse existing secret redaction patterns and extend tests with provider/config fields. |
| Old frozen rows are expected to resume after the fix. | Document and diagnose them as legacy-not-resumable unless they already have a durable handle. |
| Stale run reconciliation kills valid background work. | Only reconcile rows older than a startup-safe threshold and preserve valid handles as recoverable paused. |

## 11. Final Done Checklist

- [ ] New behavior tests prove current failure shape before fixes.
- [ ] Agent SDK uses task-budget runtime for Ready-side pause and SDK safety ceiling.
- [ ] SDK tool usage persists to task projection.
- [ ] SDK budget pause is controlled by Ready at the tool-batch boundary, not normal SDK hard max-turn failure.
- [ ] SDK budget pause and warning decisions happen after the tool batch settles, before the next model call.
- [ ] Budget warning thresholds inject live converge-or-ask steering.
- [ ] Research rows no longer persist as `budget_json.taskType = short_task`.
- [ ] Budget checkpoints write durable continuation refs.
- [ ] Budget checkpoints persist only clean tool-use/tool-result transcripts.
- [ ] Bare continuation updates the same task projection row with the expected tool surface.
- [ ] Concurrent continuation attempts collapse through single-flight.
- [ ] Browser partial collection can either resume or close as explained partial success.
- [ ] Provider protocol mismatch is typed and user-actionable.
- [ ] Run meta records production scoped runs.
- [ ] Diagnostic pack can explain long-task failure without old temp logs.
- [ ] Legacy frozen rows with no durable handle are reported as not retroactively resumable.
- [ ] Startup reconciliation handles stale running skill rows.
- [ ] AGENTS.md and CLAUDE.md log-path guidance are synchronized.
- [ ] `npm run typecheck`, `npm run test`, and `npm run verify:native` pass.
