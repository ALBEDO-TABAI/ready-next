# Ready Agent SDK Rebuild Requirements

> Date: 2026-05-13
> Scope: requirements brief before opening a branch to test an Agents SDK based rewrite of Ready's agent module.

## 0. Completion Standard

This requirements brief is complete when it answers four questions clearly enough for an implementation branch:

1. What must Ready's agent module do today?
2. Which current app facts and personal/product constraints cannot be lost?
3. Which existing backend, IPC, persistence, and frontend interfaces must remain stable?
4. What must an Agents SDK prototype prove before we consider replacing the current path?

This document is not the branch plan and does not choose the SDK implementation yet. The next branch should treat this as the checklist and then verify the current Agents SDK documentation before writing SDK code.

## 1. Assumptions

- "Codex 的 agent sdk" is treated as the OpenAI Agents SDK family referenced by the local `openai-developers:agents-sdk` skill. Exact SDK semantics must be refreshed from official docs in the implementation branch.
- The first SDK branch should be an experiment behind a feature flag or parallel runtime path. It should not delete the current `DirectChatEngine` / `TurnEngine` path until parity is proven.
- A useful prototype can start narrower, but a real replacement must preserve Ready's current multi-product agent behavior, not only "chat with tools".
- Full replacement means preserving the existing renderer-facing contract. The chat panel, task cards, scope persistence, tool-action IPC, and background task controls should not have to be rewritten first.

## 2. Current Agent Shape

Ready is an Electron creative workspace. The agent is not a plain chat bot; it is the control layer over Browser, Document, RSS, Calendar, Skills, Remote IM, memory, and research.

Current high-level flow:

```text
Renderer / Channel / Schedule
  -> AgentControlRuntime
  -> RunCoordinator
  -> ClaudeSdkOrchestrator
  -> DirectChatEngine
  -> TurnEngine
  -> DomainAdapter + ToolRuntime
  -> transcript events + task projections
  -> renderer chat, tool trace, task cards
```

Important naming note: `ClaudeSdkOrchestrator` is historical. The active path is direct HTTP over Ready's provider abstraction, with OpenAI, Anthropic, Gemini, Moonshot/Kimi, Volcano, Fox/NewCLI, and OpenAI-compatible providers.

## 3. Must-Keep Product Responsibilities

### 3.1 Conversation and Scope

The agent must support:

- Local chat scopes with stable `scopeId`.
- Remote/channel scopes with `sourceKind`, `sourceId`, and `threadKey`.
- Conversation messages persisted as user / assistant / system rows.
- Attachments persisted in message meta and recoverable by scope.
- Lazy local scope creation when renderer state exists before DB state.
- Scope lineage and resume candidates for "previous conversation" flows.
- Session recall search, attached recall capsules, and recent session listing.
- Reference skill hints persisted across restart, not only in memory.

### 3.2 Inputs

The agent must accept:

- Plain text.
- Image and video blocks.
- Local files and folders.
- Browser tab references.
- Document quotes.
- Document widget target references.
- Remote/channel attachments.
- Continuation intents from task cards.
- Explicit `/skill` and `/doc` command shortcuts.
- Remote channel messages and scheduled prompts.

Attachment rule: remote images/files enter the resource layer first. They must not automatically trigger an agent run unless a later user instruction explicitly consumes them.

### 3.3 Provider and Model Compatibility

Ready currently supports:

- Provider types: `moonshot`, `anthropic`, `openai`, `fox`, `gemini`, `volcengine`, `openai-compatible`.
- Protocol choice: Anthropic-style or OpenAI-style.
- Wire API choice: `responses` or `chat/completions`.
- Native tool calls when the provider truly supports them.
- Text tool bridge fallback when native tools are unavailable or unreliable.
- Vision gating so text-only models do not see image tools.
- Native video fallback/downshift when the provider cannot accept video blocks.
- Thinking / reasoning / long-context capability resolution.
- Per-profile capability group switches in Settings.
- Chat model switcher that only shows profiles marked visible.

An SDK replacement must either preserve this provider layer or explicitly scope itself as an OpenAI-only experiment that cannot yet replace the current runtime.

### 3.4 Task Routing

The agent must classify and route work across these task types:

- `direct_answer`
- `short_task`
- `multi_step_task`
- `media_task`
- `continuation`
- `research`

It must route to these executors/domains:

- Direct response.
- Generic tool loop.
- Browser.
- Document.
- Skill.
- RSS.
- Calendar.
- Feishu / remote collaboration.
- Research.

Routing must respect current special cases:

- Live external information such as weather, news, prices, schedules, scores, and official latest announcements should route to browser/research, not direct answer.
- Widget update context must not be hijacked by live-info routing.
- Document/widget tasks must not accidentally get browser tools if the current widget update should stay in document mode.
- Research is separate from browser browsing: backend `web_search` / `web_fetch` research can exist beside BrowserView-driven `browser_research_topic`.

### 3.5 Domain Adapter Contract

Each product domain currently owns one `DomainAdapter` role. A replacement must preserve the idea that products plug in through a stable contract instead of adding product `if/else` inside the main loop.

Each domain must be able to:

- Decide whether it should handle the turn.
- Contribute prompt fragments.
- Arbitrate tool/capability visibility.
- Decorate user text.
- Prepare domain state.
- Deterministically dispatch when applicable.
- Apply model/tool results.
- Emit projection patches.

Current domains:

- Research.
- Browser.
- Document.
- Skill.
- RSS.
- Calendar.
- Feishu.

### 3.6 Tool Runtime

Ready's tools are not just function names. They carry behavior contracts.

The replacement must preserve:

- Tool registry by capability group.
- OpenAI and Anthropic schema generation.
- Model-visible vs internal tools.
- Tool definition fields: name, group, domain, kind, concurrency, interrupt behavior, timeout profile, text bridge support, projection hint, result shape.
- Zod/safe-parse style validation before handlers.
- Structured tool result shape, including `errorKind`, `data`, `projectionPatch`, and `framePatch`.
- Tool admission order: registered/not registered, authorization, then per-turn allowlist.
- `tool_not_registered` and `authorization_denied` as distinct outcomes.
- Per-turn skill authorization.
- Skill manifest `allowed_tools`.
- Vision-based filtering.
- MCP tools with per-session/per-scope authorization.
- Deferred MCP tool promotion.
- Tool-call args hash normalization for repetition detection.
- Tool name collision failure at registration time.
- Orphan tool-call history sanitization.
- Parallel-read vs serialized execution policy.
- Timeout and cancellation behavior.
- Renderer-mediated tools through `agent:toolActionRequest`.

Capability groups that currently matter:

- `browser_interaction`
- `browser_content_tasks`
- `document`
- `file_management`
- `rss`
- `calendar`
- `skills`
- `memory`
- `session_recall`
- `pet`
- `channel_feishu`
- `general_research`
- `system_host`
- `mcp`

### 3.7 Browser Agent

Browser tasks must preserve the Browser Agent V7 style:

- Understand the task.
- Generate a plan.
- Execute in steps.
- Verify page evidence.
- Treat links as resources, not immediate instructions.
- Use current page when reusable.
- Hide BrowserView when DOM overlay is required.
- Restore BrowserView and bounds when browser content is shown again.
- Upload task success requires evidence that attachment is mounted, prompt is in the right input, submission happened, and the page shows running/result evidence.

Browser tools must support navigation, search, page reading, clicking, typing, upload target detection, prompt/input target detection, viewport/vision fallback, downloads, gallery collection, structured extraction, scrolling collection, workflow runs, and background browser tasks.

### 3.8 Document and Widget Work

Document work must preserve:

- Real document editing through `document_*` tools, not only prose advice.
- Multi-tab document operations.
- Open/switch/rename/save.
- Set/append/replace/format/rewrite.
- Widget insert/list/update/remove.
- Current document context as environment, not as a stronger source than explicit user material.
- Resource role binding for multi-document tasks.
- Document task plans for multi-source or multi-step work.
- Pipeline execution for read-then-card and read-then-widget-update flows.
- Widget skeleton arbitration.
- H1/H2 freeform widget triggers only for explicit trigger phrases.
- Widget update context must prefer updating the existing widget, not creating a duplicate.

### 3.9 RSS, Calendar, Feishu, Pet, File, Research

The replacement must preserve:

- RSS source management, update fetching, item selection, item analysis, and capture session.
- Calendar list/create/update/delete and capture session.
- Feishu docs, messages, calendar, chats, file upload/download where configured.
- Pet sticky-note tools.
- File search/management tools where exposed.
- General research tools `web_search`, `web_fetch`, and `present_file`.
- Current-date reminder for research/latest work.

### 3.10 Skills Runtime

Skills are a core Ready feature, not optional tools.

The replacement must support:

- Embedded skills and user custom skills.
- Reference/advisory skills injected inline.
- Dynamic `skill_<id>_<action>` tools from manifests.
- Primitive tools: ask user, run shell, write/read artifact, patch config, start/inspect/cancel detached, inspect run state.
- Per-turn `SkillTurnIdentity` and `SkillToolAuthorization`.
- No resurrection of the retired `skill_executions` SQLite state machine.
- In-memory `SkillTaskTracker`.
- `SkillTaskTracker` and `skill_task_runs` for current runtime state.
- Reference hint TTL and persistence to conversation meta.
- `skill_ask_user` renderer capsule flow.
- Artifact root sandboxing.
- Shell allowlist and high-risk command blocking.
- Symlink rejection and file size caps.
- Host path redaction.
- Structured config repair and validation.
- Detached skill tasks.
- Child-owned long skills.

Long-skill / child-loop requirements:

- Parent can launch, wait, resume, cancel, or surface a child run.
- Parent must not decide a child skill's internal next action.
- Child runner owns its own loop, budget, retries, checkpointing, and close event.
- Parent observes one structured close event.
- VEA (`video-expert-analyzer`) is the primary hard fixture.
- Output directory and `run_state.json` must survive across turns/restarts.
- Task cards must show background running, budget paused, waiting, completed, failed, and cancelled states from projection truth.

### 3.11 Main Loop Runtime

The replacement must preserve these main-loop concepts:

- One per-turn execution truth.
- `TurnFrame` or equivalent containing identity, user intent, active skill, liveness, progress, steering, budget, active artifact roots, config validation, terminal reason.
- `TurnFramePatch` or equivalent for tool results to update the next iteration.
- Explicit terminal reasons:
  - `done`
  - `checkpoint_budget`
  - `checkpoint_background`
  - `checkpoint_user_input`
  - `blocked_config`
  - `blocked_external`
  - `blocked_tool_error`
  - `failed_skill`
  - `resume_launch_failed`
  - `persistence_failed`
  - `cancelled_user`
  - `cancelled_runtime`
- Budget presets and per-turn budget runtime.
- Long-skill budget leases.
- Budget warnings that do not sabotage long skills.
- Repetition detection.
- Prompt/system reminder registry.
- Layered context compaction with circuit breaker.
- Hook registry for pre/post tool, user prompt submit, stop.
- Abort and preemption: a new foreground send cancels old pending renderer tool requests and aborts the old run.
- Run cleanup registry.
- Structured final `ExecutionTurnResult`.

### 3.12 Projection and UI Truth

The UI must remain projection-driven.

The replacement must keep:

- `scopeRunEvent` push stream.
- `task_projections` persisted read model.
- `agent:taskProjectionsChanged` push notification.
- Projection-only task card truth.
- Renderer must not invent task status from random text.
- `canResume` derived on the main side.
- Background task / current task cards.
- Continue, retry, open artifact, cancel actions.
- Soft failure capsules for recoverable errors.
- Terminal errors as system messages.
- Tool trace events.
- Assistant response persistence after stream done.
- Response segment breaks when tool events appear during a response.
- Task snapshots in assistant message meta.
- Memory capture display.
- Recent artifacts display.
- Rollback target as diagnostic-only display, not an action.

Frontend surfaces that must keep working:

- `ChatPanel`.
- `ChatMessages`.
- `ChatInput`.
- `ChatAttachments`.
- `SoftFailureCapsule`.
- `SkillAskUserPrompt`.
- `TaskCard` / current task / background task area.
- Agent selector and model selector.
- Settings capability switches and chat-visible profile control.

### 3.13 Remote Channels and Schedules

The replacement must preserve:

- Channel CRUD.
- Channel enable/disable.
- Channel test/probe.
- Sidecar sync.
- Remote thread mapping to conversation scope.
- Remote reply send after a successful scoped run.
- Schedule CRUD.
- Run schedule now.
- Pause/resume/delete schedule.

Supported channel types:

- `local-debug`
- `generic-webhook`
- `feishu-bot`
- `feishu-app`
- `telegram-bot`

### 3.14 Memory and Feedback

The replacement must preserve:

- Memory CRUD.
- Memory query and stats.
- Memory creation from conversation.
- Memory lifecycle maintenance.
- Resident/user/scope/trigger/session-recall memory refs in run state.
- Session recall via keyword/vector hybrid search.
- Attached recall capsules.
- Reflection/user-profile/personality repositories.
- Run metadata, thread metadata, token attribution, and feedback storage where already landed.

### 3.15 Observability and Logs

The replacement must keep or improve:

- `ready-directchat.log`.
- `ready-tools.log`.
- Browser and tool diagnostics.
- Tool snapshots.
- Tool resolution diagnostics.
- Renderer metrics.
- Agent metrics.
- Friendly error metrics.
- Tool error metrics registry.
- Scope persistence failure metrics.
- Capability runtime snapshot.

### 3.16 Safety and Boundaries

The replacement must preserve:

- No hidden legacy branch as the migration strategy.
- No product logic leaking back into the coordinator/main loop.
- No direct DB fallback that lets the app start with fake/empty AI config when primary DB fails.
- No renderer-side guess of resumability.
- No child-run output deletion outside the runtime outputs root.
- No stale tool request landing into a newer run.
- No arbitrary shell or destructive file operations through skill primitives.
- No secret/key/token leakage in logs, artifacts, docs, or UI.
- No automatic remote attachment execution.
- MCP OAuth and authorization must be explicit.
- File/path sandboxing must reject traversal and symlink escapes.

## 4. Personalized Requirements

The user-facing Ready agent should behave like a capable coworker inside the app:

- It should do the work, not only describe how to do it.
- If a gap is small and clear, it should fix it in the same run.
- It should dig past the first symptom and find the underlying layer.
- It should return completed, usable outcomes, not first drafts that require the user to inspect every item.
- It should report results in simple Chinese, without heavy implementation jargon.
- It should preserve existing valid work rather than cleaning the tree for appearance.
- It should prefer verifiable output and concrete blockers over abstract architecture talk.
- It should keep task cards and UI state honest: no fake completion, no fake liveness.
- It should use first-principles/contract-first reasoning for architecture-level changes.

## 5. Existing Interfaces To Keep Stable

### 5.1 Renderer API

`window.electronAPI.agent` currently exposes:

- Send/session: `send`, `sendScoped`, `newSession`, `kill`, `orchestrate`.
- Status: `getStatus`, `getAll`, `getDiagnostics`, `getRuntimeStatus`, `getCapabilityRuntimeSnapshot`.
- Scopes: `listConversationScopes`, `createLocalScope`, `getConversationScopeMessages`.
- Scope runs: `listScopeRuns`, `listTaskProjections`, `getTaskProjection`.
- Session recall: `searchSessionRecall`, `listRecentSessions`, `getSessionRecallCapsule`, `attachSessionRecallContext`, `detachSessionRecallContext`, `resumeSessionCandidate`, `listAttachedSessionRecallContexts`.
- Reference skill hint: `getReferenceSkillHint`.
- Skill tasks: `startDetachedSkillAction`, `inspectDetachedSkillTask`, `listDetachedSkillTasks`, `cancelDetachedSkillTask`, `listActiveChildRuns`, `cancelChildRun`.
- Attachments/cache: `listScopeAttachments`, `getScopeAttachment`, `clearRemoteAttachmentCache`, `getRemoteAttachmentCacheStats`.
- Controls: `suspendRun`, `resumeRun`, `respondToInteraction`.
- Channels: `listChannels`, `upsertChannel`, `testChannel`, `deleteChannel`, `setChannelEnabled`, `sendChannelProbe`.
- Schedules: `listSchedules`, `upsertSchedule`, `runScheduleNow`, `pauseSchedule`, `resumeSchedule`, `deleteSchedule`.
- Metrics: `emitRendererMetric`.
- Events: `onStream`, `onStatusChange`, `onError`, `onToolAction`, `onToolActionRequest`, `onCancelToolActionRequest`, `onConversationEvent`, `onScopeRunEvent`, `onReferenceSkillHintChanged`, `onTaskProjectionsChanged`.

The SDK branch should avoid changing these signatures in the first pass.

### 5.2 Chat API

`window.electronAPI.chat` is still used for:

- Conversation list/load/delete.
- Message persistence.
- Conversation title update.
- File picker.
- File read for AI input.

### 5.3 Main Runtime Contracts

Important backend contracts:

- `ExecutionHostRequest`
- `ExecutionHostResult`
- `ExecutionTurnResult`
- `TurnEngineSession`
- `TurnEngineHost`
- `TurnTranscriptEvent`
- `TaskExecutionRoute`
- `TaskProjectionRecord`
- `ScopeRunEventPayload`
- `ScopeRunSummary`
- `DomainAdapter`
- `ToolPolicy`
- `ToolDefinition`
- `ToolExecutionOutput`
- `SkillRunContract`
- `TurnFrame`
- `TurnFramePatch`

### 5.4 Persistence Contracts

Important persisted surfaces:

- Conversation scopes.
- Chat messages.
- Conversation attachments.
- Agent channels.
- Agent schedules.
- Scope runs.
- Task projections.
- Skill task runs.
- Memory tables.
- Session recall/index tables.
- Run/thread metadata and feedback tables.

## 6. SDK Prototype Proof Points

The branch should prove these in order.

### 6.1 Thin Runtime Adapter

Goal: keep renderer/IPC stable and route one scoped local chat through the SDK path.

Must prove:

- `agent:sendScoped` still persists the user message.
- Streaming text still arrives through `agent:stream`.
- `agent:status` closes the run with a terminal reason.
- Assistant message is persisted after done.
- Stop/preempt cancels the SDK run.

### 6.2 Tool Bridge

Goal: map Ready `ToolDefinition` to SDK tool definitions without losing policy.

Must prove:

- Per-turn visible tools match Ready's `ToolPolicy`.
- Internal tools do not leak to the model.
- Tool input validation still returns structured `errorKind`.
- Tool results can carry projection/frame patches.
- Renderer-mediated tools still use `agent:toolActionRequest`.
- Text-tool-bridge fallback either still exists or has a proven replacement.

### 6.3 One Domain End-To-End

Pick one narrow domain first. Recommended first proofs:

- `research`: `web_search` + `web_fetch` + `present_file` because it is backend-only and has fewer BrowserView constraints.
- `document`: one inspect/update/save flow because it validates renderer-mediated tool actions and projection patches.

Success requires:

- Correct route.
- Correct tool exposure.
- Tool call executes.
- Projection/card updates.
- User sees a simple final answer.
- No stale pending tool request.

### 6.4 Skill/Child-Loop Fixture

This is the hardest replacement gate.

Must prove:

- A typed skill action can launch a child run.
- Parent does not choose child internal actions.
- Child emits a close event.
- Background/budget/waiting status lands in task projections.
- Continue/cancel actions work.
- `canResume` is derived by main, not renderer.
- VEA run state/outputDir handles survive across turns.

### 6.5 Full UI Parity

Must prove:

- Chat input, attachments, `@[]` references, and message coalescing still work.
- Soft failure capsule still appears only for recoverable failures.
- Task cards do not regress.
- Model switcher and capability settings still affect tool exposure.
- Channel/schedule runs still use the same scoped runtime.

## 7. SDK Fit Questions For The Branch

The implementation branch must verify these from current official docs and/or code:

- Can the SDK stream model text and tool events with enough granularity for Ready's existing `agent:stream`, `agent:status`, and task-card updates?
- Can Ready supply per-turn dynamic tool lists and dynamic schemas?
- Can Ready hide internal tools while still allowing host/internal execution?
- Can SDK tool calls return structured patches, not just text?
- Can cancellation abort both model requests and in-flight tools?
- Can SDK handoffs/subagents model Ready's child-owned long skills without the parent reading the child transcript?
- Can sandboxed agents be used without weakening Ready's current artifact/path sandbox?
- Can SDK support non-OpenAI providers, or must Ready keep a provider abstraction around the SDK path?
- Can MCP/OAuth/deferred tools be authorized per session and scope?
- Can long-running jobs outlive a foreground turn and reattach through persisted handles?
- Can evaluation/tracing be added without leaking secrets or local host paths?

## 8. Minimum Acceptance Matrix

The SDK branch is not a candidate replacement until these scenarios pass:

1. Local direct answer with no tools.
2. Local document edit and save.
3. Widget update using existing widget target context.
4. Browser current-page task.
5. Browser upload task with evidence verification.
6. Research task with current date and citations/source tracking.
7. RSS analyze item.
8. Calendar create/update.
9. Session recall query.
10. Memory create/search.
11. Recoverable tool error shows soft capsule.
12. Terminal provider/config error shows user-friendly failure.
13. Stop generation cancels pending renderer tools.
14. Background skill task displays and can be cancelled.
15. Budget-paused skill task can continue.
16. VEA child-loop fixture.
17. Remote channel scoped run and reply.
18. Scheduled run.
19. OpenAI native tools.
20. OpenAI-compatible text bridge or proven equivalent.
21. Vision-disabled model does not see image tools.
22. MCP tool only appears after authorization.

## 9. Source Evidence Map

Primary backend:

- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/agent-control/orchestrator.ts`
- `src/main/modules/agent-control/runtime.ts`
- `src/main/modules/agent-control/turn-engine.ts`
- `src/main/modules/agent-control/domain-adapter.ts`
- `src/main/modules/agent-control/run-contracts.ts`
- `src/main/modules/agent-control/turn-frame.ts`
- `src/main/modules/agent-control/tool-registry.ts`
- `src/main/modules/agent-control/tool-runtime.ts`
- `src/main/modules/agent-control/run-capability-controller.ts`

Domains and tools:

- `src/main/modules/agent-control/*-domain-adapter.ts`
- `src/main/modules/tools/*`
- `src/main/modules/tools/skill-primitives/*`
- `src/main/modules/skills-runtime/*`
- `src/main/modules/browser-engine/*`
- `src/main/modules/document-engine/*`
- `src/main/modules/rss-engine/*`
- `src/main/modules/calendar-engine/*`
- `src/main/modules/mcp/*`

Frontend:

- `src/preload/index.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/stores/useAgent.ts`
- `src/renderer/modules/agent/runtimeDriver.ts`
- `src/renderer/modules/agent/messageComposer.ts`
- `src/renderer/modules/agent/moduleExecutor.ts`
- `src/renderer/modules/agent/taskCardViewModel.ts`
- `src/renderer/components/agent/ChatPanel.tsx`
- `src/renderer/components/agent/ChatInput.tsx`
- `src/renderer/components/skill/SkillAskUserPrompt.tsx`

Architecture/history docs used as context:

- `PROJECT_OVERVIEW.md`
- `FEATURE_MODULE_MAP.md`
- `docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md`
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`
- `docs/architecture/skill-child-loop-boundary.md`

## 10. Recommended Next Step

Open a branch only after this brief is accepted. The branch should start with a small SDK runtime adapter under a feature flag, then run the acceptance matrix from the top. If the SDK path cannot preserve provider/tool/projection contracts without reintroducing parallel truth sources, keep it as a narrow OpenAI-only experiment instead of replacing Ready's current runtime.
