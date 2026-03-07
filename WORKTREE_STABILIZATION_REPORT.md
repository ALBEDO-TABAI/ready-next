# Worktree Stabilization Report

## Branch Layout
- Snapshot branch: `codex/worktree-snapshot-20260307`
- Integration branch: `codex/browser-agent-stabilize`
- Protected baseline: `main` remains unchanged during stabilization.

## Integrated Into Baseline
- `package.json`, `package-lock.json`: minimal dependency update to support retained document edit path (`docx`) and install the clean worktree.
- `src/main/index.ts`: wired the clean branch to the retained browser controller and agent runtime IPC path.
- `src/main/modules/browser-engine/`: retained browser controller, popup/auth handling, adblock state, browser tab metadata, browser diagnostic/probe surface.
- `src/main/modules/tools/`: retained browser-agent runner, workflow probe, browser tool execution, browser vision analysis, tool dispatcher.
- `src/main/modules/agent-control/`: retained structured agent runtime, session continuity, takeover/checkpoint state handling.
- `src/main/modules/claude-bridge/agent-manager.ts`: retained agent manager changes needed by the structured runtime bridge.
- `src/main/modules/claude-bridge/ipc-handler.ts`: retained runtime IPC, scope/timeline events, tool bridge plumbing.
- `src/main/modules/claude-bridge/direct-chat.ts`: retained direct chat bridge used by the browser-agent execution path.
- `src/main/modules/claude-bridge/tool-bridge.ts`: retained text tool bridge parsing and result formatting.
- `src/main/modules/claude-bridge/worktree-pool.ts`: retained worktree pool adjustments required by the new runtime path.
- `src/main/modules/database.ts`, `src/main/modules/migrations.ts`: retained schema and migration support for conversation scopes, browser metadata and related settings.
- `src/main/modules/document-engine/ipc-handler.ts`: retained editable document read/write helpers required by the agent runtime.
- `src/main/modules/openai-responses.ts`: retained response parsing used by browser vision/direct chat.
- `src/main/modules/skills-runtime/manifest.ts`, `custom-skill-registry.ts`, `runtime-manager.ts`: retained only the runtime support required by direct chat imports; no separate skills product surface was integrated.
- `src/shared/ai-providers.ts`: retained provider capability metadata required by direct chat and browser vision.
- `src/preload/index.ts`, `src/renderer/types/electron.d.ts`: retained preload/type surface for the integrated browser and agent IPC contract.
- `src/renderer/pages/modes/BrowserMode.tsx`: retained docked browser UI, tab metadata display, bookmarks/history/downloads pane, adblock controls.
- `src/renderer/components/browser/`: retained browser address bar and tab bar for the stabilized BrowserMode.
- `src/renderer/stores/useBrowserTabs.ts`: retained persisted browser tab state.
- `src/renderer/stores/useWorkspace.ts`: retained side-panel width model required by the docked browser pane layout.
- `src/renderer/stores/useDocTabs.ts`: retained doc tab helpers needed by agent-driven document writes.
- `src/renderer/stores/useAgent.ts`: retained structured run state, tool trace, checkpoint/takeover state and related renderer logic.
- `src/renderer/components/ready/TaskPanel.tsx`, `AgentSelector.tsx`, `AgentTagRow.tsx`: retained structured task timeline UI.
- `src/renderer/pages/ReadyMode.tsx`: minimally adapted to use the structured task panel without importing the larger Ready UI redesign.
- `src/renderer/utils/dragDrop.ts`, `docx-format.ts`: retained utility support required by BrowserMode and useAgent.
- `src/__tests__/browser-popup-policy.test.ts`, `browser-tools.test.ts`, `tool-bridge.test.ts`: retained focused tests for the integrated browser-agent path.

## Deferred For Later Review
- `src/main/modules/rss-engine/` and RSS feature expansion outside the existing baseline UI.
- `src/main/modules/video-engine/`, `src/main/modules/design-engine/`, `src/main/modules/settings-engine/`: separate product lines, not required for browser-agent stabilization.
- `src/renderer/components/calendar/`, `creative/`, `design/`, `document/`, `rss/`, `settings/`, `ui/`, `motion/`: broader UI/product redesigns not required to stabilize the current browser-agent baseline.
- `src/renderer/pages/modes/DesignMode.tsx` and the broader design-mode rollout.
- `src/renderer/components/agent/ChatPanel.tsx`: larger chat shell rewrite deferred to the later architecture cleanup pass.
- `src/renderer/App.tsx`, `TopBar.tsx`, `IconRail.tsx`, `ModeSlider.tsx`, `StatusBar.tsx`, `ContextMenu.tsx`, `main.tsx`, `styles/index.css`: broad shell/polish changes deferred so the stabilization branch stays narrow.
- `assets/embedded-skills/`, `src/python/ready_sidecar/`, remote-channel delivery work and embedded skill content: not required for this baseline commit.

## Isolated / Not Integrated
- `.claude/` and `.claude/worktrees/design-module`: nested Git/worktree content; intentionally excluded from the clean integration path.
- Bulk documentation rewrites and deletions: `DELIVERY_REPORT.md`, `DEVELOPMENT_PLAN.md`, `KIMI_*`, `LOCAL_HANDOFF.md`, `OUTPUT_CONTRACT.md`, `PROJECT_STRUCTURE.md`, `TASK_ASSIGNMENT.md`, plus large documentation replacements. These need a dedicated documentation review, not automatic carry-over.
- `src/renderer/pages/modes/ImageMode.tsx` deletion: intentionally not brought into the stabilized branch.
- Broad feature maps / progress docs (`DEPENDENCY_MAP.md`, `FEATURE_MODULE_MAP.md`, `LESSONS_LEARNED.md`, `PROGRESS.md`, `PROJECT_OVERVIEW.md`, `PROJECT_STRUCTURE_SNAPSHOT.md`): useful references, but not part of the code baseline.

## Validation Completed
- `npm run typecheck:node`
- `npm run typecheck:web`
- `npm test`

## Next Cleanup Pass
- Review deferred renderer shell changes and decide whether to adopt the larger Ready/Workbench UI redesign.
- Revisit deferred product modules (`settings`, `rss`, `video`, `design`) one subsystem at a time from the snapshot branch.
- Evaluate whether the retained skills runtime support should stay as a hidden dependency or be reduced before merge to `main`.
