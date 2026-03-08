# Agent Refactor Baseline 2026-03-07

## Current landed baseline
- Renderer run routing now resolves by `runId + scopeId` and no longer depends on the currently selected scope.
- `useAgent` is no longer the old single-file controller. Runtime routing, message composition, command execution, and scope-run patching have been split into dedicated modules.
- Browser main-process code has been split into services for shell commands, tab lifecycle, preview, automation/CDP, data access, diagnostics, downloads, popup handling, and session policy.
- Repository access is now separated by domain instead of routing everything through direct `getDatabase()` calls.
- Tool families now cover browser, document, design, video, RSS, and calendar.
- Renderer-side module handlers for design, video, RSS, and calendar are extracted from page components into dedicated adapter/handler modules.
- TaskPanel now renders structured run state, module labels, tool trace, and artifact state from typed payloads.

## Closed-loop coverage currently available
- Browser
  - existing browser workflow path kept
  - browser shell/layout and diagnostics entry are now separated from the page container
- Document
  - deterministic document action loop remains available
  - document page now shares the unified workbench tab chrome
- Design
  - open/save/export/session capture loop is available
  - diagnostics panel and shared tab chrome are in place
- Video
  - import/inspect/export/session capture loop is available
  - schema helpers and diagnostics panel are in place
- RSS
  - add source, fetch updates, select item, trigger analysis, diagnostics, benchmark, and session capture are available
- Calendar
  - list/create/update/delete/capture loop is available
  - agent handler and diagnostics panel are in place

## What is still not final architecture
- `useAgent` is split, but the store is still large and not yet reduced to a minimal pure-state surface.
- Browser controller orchestration still has a final coordination layer left to shrink.
- Diagnostics exist as in-product panels, not yet as full dedicated labs across every module.
- Video is moving toward `Remotion schema-first`, but renderer state is still not fully derived from one canonical project schema.
- Design inspector still lacks several high-frequency controls and consistency across shape types.
- RSS and Calendar are much less coupled to page components now, but their end-state adapter/lab story is not complete.
- Memory layering (`L0/L1/L2`) and the Feishu replacement path have not started in earnest.

## Recommended next execution order
1. Finish the remaining RSS source-acquisition work for Weibo, Xiaohongshu, and Douyin on top of the app browser module.
2. Finish the shared workbench visual baseline:
   - strict top-row alignment
   - unified tabs/chrome
   - missing design inspector controls
3. Continue shrinking the remaining browser controller orchestration and promote diagnostics panels into proper labs.
4. Return to the next untouched mainline items:
   - PromptAssemblyService and layered memory
   - Feishu capability adapter replacement
