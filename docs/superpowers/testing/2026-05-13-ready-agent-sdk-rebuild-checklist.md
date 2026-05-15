# Ready Agent SDK Rebuild Test Checklist

> Date: 2026-05-13
> Branch: `codex/ready-agent-sdk-rebuild`
> Runtime: Ready Agent SDK is the main execution host. The previous fallback switch has been retired.

## 0. Completion Gate

This branch has moved past the initial SDK feasibility slice and the local product gates now pass. The local minimum acceptance matrix (§15) is now automated and green; live-provider/account gates still require valid external credentials when running those smoke tests.

Current automated proof:

- `src/__tests__/agent-sdk-runtime.test.ts`
- SDK runtime is the primary execution host; the old fallback escape hatch is retired.
  - SDK runtime streams text through the existing event contract and closes with `terminalReason='done'`.
  - SDK runtime preempts an old run and cancels pending renderer actions.
  - SDK runtime maps Ready `ToolDefinition` into an Agents SDK function tool and preserves structured patches.
  - SDK runtime emits tool trace output and scope-run tool events, and registers per-run cleanup callbacks.
  - SDK runtime forwards renderer-mediated tool requests through the existing tool-action requester.
  - SDK runtime preserves structured tool validation errors as tool results.
  - SDK runtime classifies provider quota/rate failures as external blockers instead of persistence failures.
  - SDK runtime inherits Ready's model-visible tool surface from the existing capability registry.
  - SDK runtime claims OpenAI-protocol configs and Anthropic-protocol configs via a Ready model adapter.
  - SDK runtime uses a Ready OpenAI-compatible model adapter for third-party OpenAI-protocol providers, preserving provider patchers and `chat/completions` / `responses` wire API rules.
  - SDK runtime uses Ready text-tool bridge for OpenAI-compatible non-native tool transports.
  - SDK runtime gates vision-dependent tools with the resolved provider/model capability.
  - SDK runtime keeps MCP tools scoped to explicit OAuth + per-scope authorization.
  - SDK runtime exposes authorized skill typed actions and primitives for explicit skill turns and threads authorization into tool execution.
  - SDK runtime executes representative browser/RSS/calendar/Feishu/pet/file/research tools without losing projection truth.
- `src/__tests__/agent-sdk-product-acceptance.test.ts`
  - Automates the local product acceptance matrix across direct answer, research, document, widget, browser, upload, background browser, RSS, calendar, Feishu, pet, file, memory, session recall, recoverable/terminal errors, skill launch/continue/cancel/close, channel reply, scheduled run-now metadata, OpenAI-compatible text bridge, vision gating, MCP authorization, and explicit skill authorization.
- `src/__tests__/agent-sdk-runtime-live.test.ts`
  - Optional OpenAI Responses and Chat Completions live smoke is gated by `READY_AGENT_SDK_LIVE_SMOKE=1` + `OPENAI_API_KEY`.
  - Optional OpenAI-compatible live smoke is gated by `READY_AGENT_SDK_COMPAT_BASE_URL`, `READY_AGENT_SDK_COMPAT_API_KEY`, and `READY_AGENT_SDK_COMPAT_MODEL`.
  - Default non-live run skips cleanly.
- `npm run typecheck:node`
- `npm run typecheck`
- `npm run verify:native`
- `npm run test:parallel` (3299 tests: 3238 pass, 61 skipped, 0 fail in the final `npm run verify` run)
- `npm run test:serial-skill-child` (156 tests: 153 pass, 3 skipped, 0 fail in the final `npm run verify` run)
- `READY_E2E=1 READY_E2E_PYTHON=<python3.12-venv>/bin/python npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/e2e/*.e2e.ts` (green with real ffmpeg/scenedetect material generation before AI mock short-circuit)
- `npm run verify` (green after fixing child status helper usage, CLAUDE path claims, and silent-catch evidence)
- `npm run build` (green; Vite reports only existing dynamic/static import chunk warnings)
- Electron SDK runtime + SQLite scoped-run proof: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 src/__tests__/agent-sdk-runtime.test.ts src/__tests__/agent-sdk-runtime-live.test.ts src/__tests__/agent-sdk-scoped-run-persistence.test.ts` (28 tests: 25 pass, 3 skipped, 0 fail)
- Local product acceptance matrix: `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-sdk-product-acceptance.test.ts` (24 tests: 23 pass, 1 SQLite host-ABI guard skipped and covered by `verify:native`, 0 fail)
- Live smoke attempt: `OPENAI_AGENTS_DISABLE_TRACING=1 READY_AGENT_SDK_LIVE_SMOKE=1 ... src/__tests__/agent-sdk-runtime-live.test.ts` reached OpenAI and failed with quota exhaustion for both Responses and Chat Completions. OpenAI-compatible smoke is still skipped without `READY_AGENT_SDK_COMPAT_BASE_URL`, `READY_AGENT_SDK_COMPAT_API_KEY`, and `READY_AGENT_SDK_COMPAT_MODEL`. These are environment/account blockers, not local code failures.

Replacement acceptance is locally green. Replacement cutover remains blocked until the live provider gates above pass with a funded OpenAI project key and a valid OpenAI-compatible provider config.

Baseline status:

- The earlier inherited `npm run test:parallel` failures have been repaired on this branch.
- Latest full verify baseline: 0 local failures.

## 1. Conversation And Scope

Checklist:

- Local scoped chat persists the user message before execution.
- Local scoped chat streams assistant text through `agent:stream`.
- Local scoped chat persists the assistant message after completion.
- Remote/channel scope keeps `sourceKind`, `sourceId`, and `threadKey`.
- Attachments stay in message meta and can be recovered by scope.
- Lazy local scope creation still works for renderer-created `conv-*` ids.
- Scope lineage and resume candidates still work.
- Session recall search and attached capsules still work.
- Reference skill hints survive restart through conversation meta.

Current coverage:

- Automated: SDK scoped run persists the user message, assistant final snapshot, scope run event, and task projection through real SQLite under Electron runtime.
- Automated: SDK runtime emits stream/status events in unit tests.
- Automated: channel scoped run, session recall, scheduled run-now metadata, and memory create/search are covered by the SDK product acceptance matrix.
- Existing `sendScoped` and `RunCoordinator` path remains in place.

Missing:

- Restart-after-process-exit proof for persisted reference skill hint with SDK runtime enabled.

## 2. Inputs

Checklist:

- Plain text.
- Image blocks.
- Video blocks with provider fallback/downshift.
- Local files and folders.
- Browser tab references.
- Document quotes.
- Widget target references.
- Remote/channel attachments.
- Task-card continuation intents.
- Explicit `/skill` and `/doc` shortcuts.
- Scheduled prompts.
- Remote images/files enter resource layer first and do not auto-run.

Current coverage:

- Partial: SDK runtime accepts plain text and maps image blocks to SDK image input.
- Partial: video blocks are downgraded to text in the SDK slice.

Missing:

- Renderer attachment e2e.
- Remote attachment no-auto-run regression.
- Continuation intent e2e.
- `/skill` and `/doc` routing parity test.

## 3. Provider And Model Compatibility

Checklist:

- OpenAI provider through Responses and Chat Completions.
- OpenAI-compatible provider through configured base URL.
- Non-OpenAI providers keep legacy path or have a documented SDK strategy.
- Native tool gating still respects provider capability.
- Text bridge fallback remains available where native tools are unavailable.
- Vision-disabled models do not see image-dependent tools.
- Video fallback/downshift remains honest.
- Settings capability switches affect tool exposure.
- Chat-visible profile filter still works.

Current coverage:

- Partial: SDK runtime uses the official SDK `OpenAIProvider` for first-party OpenAI Responses / Chat Completions configs.
- Automated: SDK runtime uses a Ready Anthropic model adapter, including SDK tool loops.
- Automated: SDK runtime uses a Ready OpenAI-compatible model adapter for third-party OpenAI-protocol providers, including SDK tool loops, provider request patchers, and `responses` wire API routing.
- Automated: SDK runtime uses Ready text-tool bridge when `toolCallTransport='text'`, instead of silently disabling product tools or falling back to the old main loop.
- Automated: SDK runtime filters vision-dependent tools when the resolved model capability says vision is unavailable.
- Automated: Ready Agent SDK is the only main execution host; old runtime flags are absent.
- Automated: provider quota/rate failures surface as `blocked_external`.
- Blocked: live OpenAI Responses and Chat Completions smoke reached the API but the project key returned quota exhaustion.

Missing:

- Passing live OpenAI Responses smoke after account quota is restored.
- Passing live OpenAI Chat Completions smoke after account quota is restored.
- Passing OpenAI-compatible smoke with valid external config.
- Capability switch + model switcher e2e.
- Vision gating app e2e.

Important fit risk:

- The installed JavaScript SDK imports and the SDK slice tests pass under Electron 34's embedded Node 20.19.1, even though the SDK documentation targets Node.js 22 or later.
- A real OpenAI network smoke inside Electron is still required before production use.

## 4. Task Routing And Domain Adapter Contract

Checklist:

- `direct_answer`, `short_task`, `multi_step_task`, `media_task`, `continuation`, `research`.
- Domains: research, browser, document, skill, RSS, calendar, Feishu.
- Live-info routes to browser/research.
- Widget update context is not hijacked by live-info routing.
- Product logic stays in `DomainAdapter`, not coordinator branches.

Current coverage:

- Partial: SDK runtime inherits model-visible tool groups from Ready's existing capability registry and suppresses browser tools when the browser host is unavailable.
- Existing domain adapters are still supplied to prompt assembly through the legacy host.

Missing:

- SDK route parity tests for every task type.
- SDK route parity tests for every domain.
- Widget-live-info conflict e2e.
- Coordinator isolation check specifically covering SDK adapter code.

## 5. Tool Runtime

Checklist:

- Ready `ToolDefinition` maps to SDK tools.
- Internal tools do not leak to the model.
- Zod/schema validation still returns structured `errorKind`.
- Tool results preserve `data`, `projectionPatch`, `framePatch`, and `interactionHint`.
- Renderer-mediated tools still use `agent:toolActionRequest`.
- Text bridge fallback exists or is replaced.
- Admission order keeps `tool_not_registered` distinct from `authorization_denied`.
- Skill authorization still works.
- Vision and MCP authorization filters still work.
- Parallel-read vs serialized execution remains enforced.
- Timeout/cancellation works for tools.

Current coverage:

- Automated: tool definition mapping and structured patch preservation.
- Automated: default SDK tool surface includes Ready document/RSS/calendar/research tools and does not expose browser tools without a browser host.
- Automated: browser, Feishu, file, pet, and research tools appear when runtime availability and intent allow them.
- Automated: upload intent exposes upload browser tools without opening background browser task tools.
- Automated: host-only tools and unauthorized skill primitives do not leak into the default SDK model-visible surface.
- Automated: renderer-mediated tool requests still pass through the existing requester payload shape.
- Automated: structured validation errors remain visible as tool result data.
- Automated: MCP tool exposure is gated by explicit per-scope OAuth authorization.
- Automated: explicit skill turns expose selected typed actions + primitives and pass the same authorization into execution.
- Automated: SDK tool execution goes back through Ready `executeToolCall`, so validation/admission still happens at dispatch.
- Automated: SDK model-visible list applies vision gating before exposing tools.

Missing:

- Renderer-mediated tool app e2e.
- App-level MCP OAuth authorization e2e.
- Parallel/serialized policy e2e.

## 6. Browser Agent

Checklist:

- Task understanding.
- Plan generation.
- Step execution.
- Page evidence verification.
- Links treated as resources.
- BrowserView hide/restore behavior.
- Upload success evidence: attachment mounted, prompt entered, submitted, running/result evidence.
- Navigation, search, page read, click, type, upload target detection, input target detection, vision fallback, downloads, gallery, extraction, scroll collection, workflows, background browser tasks.

Current coverage:

- Partial: SDK runtime exposes browser navigation/read/click/type/search tools for browser workflow intent.
- Partial: SDK runtime exposes upload target and upload attachment tools for upload workflow intent.
- Partial: representative browser tool execution preserves projection truth in SDK unit coverage.

Missing:

- Full Browser Agent V7 e2e suite with SDK runtime enabled.

## 7. Document And Widget

Checklist:

- Real `document_*` editing tools.
- Multi-tab operations.
- Open/switch/rename/save.
- Set/append/replace/format/rewrite.
- Widget insert/list/update/remove.
- Current document context remains environment only.
- Resource role binding for multi-doc tasks.
- Document task plans for multi-source/multi-step work.
- Read-then-card and read-then-widget-update pipelines.
- Widget skeleton arbitration.
- H1/H2 trigger phrases only.
- Existing widget update preferred over duplicate creation.

Current coverage:

- Partial: renderer-mediated document write contract is covered in SDK unit tests.
- Partial: representative document/widget tool surface is available through Ready registry.

Missing:

- Document inspect/update/save e2e through renderer-mediated tools.
- Widget update-context e2e.
- Skeleton arbitration regression suite with SDK runtime enabled.

## 8. RSS, Calendar, Feishu, Pet, File, Research

Checklist:

- RSS source management, update fetching, item selection, item analysis, capture session.
- Calendar list/create/update/delete/capture session.
- Feishu docs/messages/calendar/chats/file upload/download.
- Pet sticky-note tools.
- File search/management tools.
- Research `web_search`, `web_fetch`, `present_file`.
- Current-date reminder for latest/research tasks.

Current coverage:

- Partial: research/RSS/calendar/Feishu/pet/file tools can be exposed through the SDK tool bridge in unit tests.
- Automated: representative tool execution for research/RSS/calendar/Feishu/pet/file preserves projection truth.

Missing:

- Live research e2e with sources.
- RSS e2e.
- Calendar e2e.
- Feishu sidecar e2e.
- Pet/file tool e2e.

## 9. Skills Runtime And Child Loop

Checklist:

- Embedded and custom skills.
- Reference/advisory skill injection.
- Dynamic `skill_<id>_<action>` tools.
- Primitive tools.
- `SkillTurnIdentity` + `SkillToolAuthorization`.
- No resurrection of retired `skill_executions`.
- In-memory tracker + `skill_task_runs`.
- Reference hint TTL and persistence.
- `skill_ask_user` capsule.
- Artifact sandboxing.
- Shell allowlist and high-risk blocking.
- Config repair.
- Detached skill tasks.
- Child-owned long skills.
- VEA run state/outputDir survives turns and restarts.

Current coverage:

- Partial: explicit skill turns now arm SDK-visible selected typed actions and skill primitives.
- Automated: selected skill authorization is passed into tool execution.
- Automated: `npm run test:serial-skill-child` is green after aligning the double-finalize lifecycle test with the async finalize contract.
- Automated e2e: VEA child runner reaches real ffmpeg/scenedetect material generation before the AI stage is short-circuited.
- Automated: SDK product acceptance covers SDK-triggered skill launch handles, budget pause, continue, cancel, close event, and durable projection state.

Missing:

- Cross-process restart proof for SDK-triggered VEA run_state/outputDir recovery.
- Primitive sandbox regression suite with SDK runtime enabled remains covered by shared primitive tests, but not yet duplicated as a separate SDK-only app e2e.

## 10. Main Loop Runtime

Checklist:

- One per-turn execution truth.
- `TurnFrame` or equivalent.
- `TurnFramePatch` equivalent.
- Terminal reasons.
- Budget presets and runtime.
- Long-skill budget leases.
- Repetition detection.
- System reminder registry.
- Layered compaction.
- Hook registry.
- Abort/preemption.
- Cleanup registry.
- Structured `ExecutionTurnResult`.

Current coverage:

- Automated: SDK path emits terminal reason and structured result.
- Automated: preemption aborts old run and cancels pending renderer actions.
- Automated: cleanup registry is plumbed into tool execution.
- Automated: text-tool bridge loops back tool results through SDK runtime without leaking tool_call markers into visible text.

Missing:

- TurnFrame parity.
- Budget parity.
- Compaction/hook parity.
- Repetition detection parity.
- Full terminal reason matrix.

## 11. Projection And UI Truth

Checklist:

- `scopeRunEvent` stream.
- `task_projections` persisted read model.
- `agent:taskProjectionsChanged` notification.
- Projection-only task cards.
- Main-side `canResume`.
- Current/background task cards.
- Continue/retry/open artifact/cancel.
- Soft failure capsules.
- Terminal errors as system messages.
- Tool trace events.
- Segment breaks around tool events.
- Assistant message meta task snapshots.
- Memory capture and recent artifacts.
- Rollback target diagnostic-only.

Current coverage:

- Partial: SDK tool bridge preserves projection patches for `RunCoordinator`.

Missing:

- Task projection DB e2e.
- Soft failure capsule e2e.
- Tool trace UI e2e.
- Task-card action e2e.

## 12. Channels And Schedules

Checklist:

- Channel CRUD, enable/disable, test/probe, sidecar sync.
- Remote thread mapping to scope.
- Remote reply send after successful run.
- Schedule CRUD, run now, pause/resume/delete.
- Channel types: local-debug, generic-webhook, feishu-bot, feishu-app, telegram-bot.

Current coverage:

- None in SDK path.

Missing:

- Channel scoped run e2e with SDK runtime enabled.
- Scheduled run e2e with SDK runtime enabled.

## 13. Memory And Feedback

Checklist:

- Memory CRUD/query/stats.
- Memory creation from conversation.
- Memory lifecycle.
- Resident/user/scope/trigger/session-recall refs.
- Hybrid session recall.
- Attached recall capsules.
- Reflection/user-profile/personality repositories.
- Run metadata/thread metadata/token attribution/feedback.

Current coverage:

- None specific to SDK path.

Missing:

- Memory capture e2e.
- Session recall e2e.
- Feedback metadata e2e.

## 14. Observability And Safety

Checklist:

- `ready-agent-sdk.log` SDK path exists.
- Runtime status and settings copy expose only Ready Agent SDK, not the retired fallback path.
- Tool diagnostics and snapshots.
- Tool resolution diagnostics.
- Renderer/agent/friendly-error/tool-error metrics.
- Capability runtime snapshot.
- No hidden legacy branch as migration strategy.
- No product logic leak into coordinator.
- No fake/empty AI config fallback.
- No renderer-side resumability guessing.
- No stale tool request lands in newer run.
- No arbitrary shell/destructive file operations.
- No secret leakage.
- Explicit MCP OAuth/authorization.
- Traversal and symlink rejection.

Current coverage:

- Automated: SDK path does not silently enable; flag is explicit.
- Automated: SDK path does not use env key fallback when app AI config is absent.
- Automated: stale pending renderer actions are cancelled on preempt.
- Automated: SDK provider quota/rate failures are not mislabeled as persistence failures.

Missing:

- Log redaction checks.
- MCP OAuth e2e.
- Sandbox/path e2e under SDK runtime.

## 15. Minimum Acceptance Matrix

Required before replacement candidate:

All local matrix items below are automated by `src/__tests__/agent-sdk-product-acceptance.test.ts` unless a stronger proof is named.

1. Local direct answer with no tools: automated with scoped stream/terminal contract; SQLite persistence is covered by Electron scoped-run proof.
2. Local document edit and save: automated through renderer-mediated inspect/update/save tool requests.
3. Widget update using existing widget target context: automated with existing-target update preferred over duplicate creation.
4. Browser current-page task: automated for read/click/type/evidence through the SDK tool bridge.
5. Browser upload task with evidence verification: automated with the four required evidence points.
6. Research task with current date and citations/source tracking: automated for `web_search` + `web_fetch` + `present_file`, current-date prompt, sources, and artifacts.
7. RSS analyze item: automated for fetch/select/analyze/capture chain.
8. Calendar create/update: automated for list/create/update/capture chain.
9. Session recall query: automated.
10. Memory create/search: automated.
11. Recoverable tool error shows soft capsule path: automated as structured recoverable tool result.
12. Terminal provider/config error shows user-friendly failure: automated for blocked terminal status and provider quota classification.
13. Stop generation cancels pending renderer tools: automated for SDK runtime.
14. Background skill task displays and can be cancelled: automated for durable handles and cancel close event state.
15. Budget-paused skill task can continue: automated for budget pause and continue path.
16. VEA child-loop fixture: real child-runner material generation e2e is automated; SDK acceptance covers launch/budget/continue/cancel/close handles.
17. Remote channel scoped run and reply: automated for Feishu-scoped reply.
18. Scheduled run: automated for run-now metadata in projection truth.
19. OpenAI native tools: local SDK tool bridge automated; live API trace blocked by OpenAI quota.
20. OpenAI-compatible text bridge or proven equivalent: automated locally; live smoke requires external compatible provider config.
21. Vision-disabled model does not see image tools: automated.
22. MCP tool only appears after authorization: automated for OAuth + per-scope authorization.
23. Explicit skill tool surface only exposes the selected skill action and primitives: automated.

## 16. Next Repair Order

1. Restore OpenAI quota or switch the smoke key/model, then rerun the live Responses and Chat Completions smoke.
2. Provide `READY_AGENT_SDK_COMPAT_BASE_URL`, `READY_AGENT_SDK_COMPAT_API_KEY`, and `READY_AGENT_SDK_COMPAT_MODEL`, then rerun the OpenAI-compatible live smoke.
3. After all live provider gates pass, delete the old main-loop execution responsibilities and rerun `npm run verify`, `npm run build`, Electron SDK proof, app e2e, and all live smokes.
4. Optional hardening after cutover: add cross-process restart e2e for SDK-triggered VEA run_state/outputDir recovery.
