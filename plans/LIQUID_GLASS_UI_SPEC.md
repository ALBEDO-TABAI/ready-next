# Ready Liquid Glass UI Technical Spec

> Updated: 2026-04-22
> Baseline commit: `13883b3`
> Scope: current renderer UI architecture, liquid-glass shell rules, theme/bootstrap behavior, BrowserView visibility contract, and the practical file map another implementation agent should follow.

## Status
- This file replaces the older 2026-03-20 draft.
- Reason for rewrite:
  - the older draft referenced browser header splits that no longer exist
  - it predated current first-frame theme bootstrap behavior
  - it did not reflect the current liquid-glass shell fusion rules now protected by tests
- If prose in this file conflicts with the copied source files or the listed contract tests, trust the source files and tests.

## Project Goal
- Keep Ready's workbench visually unified across Browser, Document, RSS, Calendar, Side Panel, Chat Panel, TopBar, IconRail, and StatusBar.
- Preserve the current "liquid-glass but restrained" feel:
  - soft edges
  - transparent outer chrome
  - shared geometry
  - minimal hard borders
  - no Windows-native visual drift
- Give another developer or agent enough truth to rebuild the same UI on Windows without guessing which file owns layout, theme, motion, or BrowserView visibility.

## Current Scope
- Included:
  - renderer shell structure
  - theme/token ownership
  - first-frame theme bootstrap
  - theme and mode transition choreography
  - Browser / Document / RSS / Calendar mode shells
  - side panel / chat panel / top chrome contracts
  - BrowserView visibility and bounds handoff rules
- Excluded:
  - model/provider behavior
  - database schema
  - RSS scraping logic
  - document tool semantics
  - calendar business rules beyond visible UI behavior

## Current Source Of Truth
### 1. App bootstrap and route shell
- Files:
  - `src/renderer/index.html`
  - `src/renderer/main.tsx`
  - `src/renderer/App.tsx`
- Owns:
  - first-frame `data-theme` and `data-skin` bootstrap in `<head>`
  - bootstrap-fatal fallback UI
  - root route contract:
    - `/`
    - `/workbench`
    - `/ready`
    - `/settings`
    - `* -> /workbench`
- Important:
  - `main.tsx` is now a reconciler, not the first writer of theme attributes
  - removing the inline `<head>` bootstrap will reintroduce first-frame visual drift

### 2. Geometry and shared layout numbers
- File: `src/renderer/modules/workbench/chrome.ts`
- Owns:
  - top bar height
  - status bar height
  - edge rail size
  - canvas outer padding
  - shared header alignment edge: `WORKBENCH_HEADER_EDGE_X`
  - support panel width constants
- Rule:
  - keep only geometry here
  - do not move theme, blur, or surface styling into this file

### 3. Visual tokens and shell classes
- Files:
  - `src/renderer/styles/index.css`
  - `src/renderer/styles/ritual-overlay.css`
  - `src/renderer/styles/schedule-x.css`
  - `src/renderer/components/layout/panelTokens.ts`
- Owns:
  - root theme variables
  - liquid-glass surface tokens
  - `workbench-canvas-shell`
  - `glass-surface-panel`
  - `glass-surface-card`
  - `content-surface-panel`
  - `workbench-panel-frame`
  - browser/rss/calendar specific shell overrides
  - schedule-x skin alignment for calendar mode
- Important:
  - `panelTokens.ts` is semantic aliasing, not the raw source of visual truth
  - raw colors, blur, border, shadow, and shell fusion rules still live in CSS

### 4. Workbench orchestration and global state
- Files:
  - `src/renderer/pages/WorkbenchMode.tsx`
  - `src/renderer/components/layout/WorkbenchModeOutlet.tsx`
  - `src/renderer/stores/useMode.ts`
  - `src/renderer/stores/useWorkspace.ts`
- Owns:
  - overall workbench composition
  - top bar / icon rail / side panel / mode canvas / chat panel / status bar placement
  - single-mode vs split-mode composition
  - side panel width sharing across files/search/skills
  - mode keep-alive behavior
  - global workbench split ratio and chat/sidebar open state

### 5. Theme and ritual orchestration
- Files:
  - `src/renderer/stores/useTheme.ts`
  - `src/renderer/modules/overlay/useRitualOverlay.ts`
  - `src/renderer/components/overlay/RitualOverlay.tsx`
- Owns:
  - `data-theme` lifecycle
  - theme toggle choreography
  - reduced-motion bypass
  - panel-resize bypass
  - overlay phase attributes for CSS choreography
- Important:
  - theme switching is coordinated behavior, not a single class toggle
  - do not replace this with a naive fade or a raw CSS transition on the body

## Workbench Shell Contract
### Shell layers
- `workbench-canvas-shell`
  - use for the outer rounded module shell of Browser / Document / RSS / Calendar
- `glass-surface-panel`
  - use for browser header, tab rails, and similar top chrome bands
- `content-surface-panel`
  - use for inner content sheets such as RSS feed body or browser side panel
  - do not use as the outer workbench module shell
- `workbench-panel-frame`
  - use for left side panel and right chat panel outer frames

### Shared alignment rules
- Browser, Document, RSS, and Calendar align their top chrome to `WORKBENCH_HEADER_EDGE_X`.
- The liquid-glass shell should read as one fused surface:
  - top bar transparent
  - icon rail transparent
  - side panel transparent outer frame
  - chat panel transparent outer frame
  - status bar transparent
- Avoid prominent shell edges in liquid-glass mode:
  - no strong vertical dividers between icon rail and side panel
  - no heavy outer borders on side/chat shells
  - no floating-card look for the chat panel

### Current top chrome rules
- `TopBar.tsx` uses `DraggableModeTabs`, not any gooey segmented control.
- `IconRail.tsx` is a transparent utility rail, not a surfaced card.
- `StatusBar.tsx` is transparent and visually quiet.
- The browser header is a unified chrome surface:
  - there is no separate `BrowserTabBar.tsx`
  - there is no separate `BrowserAddressBar.tsx`

## Current Runtime Invariants
### First-frame theme invariants
- `src/renderer/index.html` must synchronously seed:
  - `data-theme`
  - `data-skin`
- The current runtime only supports the `liquid-glass` skin path.
- `src/renderer/main.tsx` reconciles with the main-process theme source after first paint.

### Mode scene invariants
- `WorkbenchModeOutlet.tsx` keeps Browser / Document / RSS / Calendar mounted.
- Visibility and transition state are driven by:
  - `.workbench-mode-scene`
  - `data-mode-visual-state`
  - `data-mode-direction`
- Do not reintroduce remount-on-switch behavior for the main workbench modes.

### BrowserView invariants
- Treat BrowserView / WebContentsView as native overlays on Windows exactly like macOS.
- DOM `z-index` cannot reliably cover them.
- Required behavior:
  - if browser mode is not the active visible mode, renderer must hide hosts
  - if animation is not settled, renderer must hide hosts
  - renderer must send bounds before asking the main process to show the active host
  - hidden hosts are hidden by moving them offscreen, not by trusting DOM coverage
- Current source files:
  - renderer:
    - `src/renderer/pages/modes/BrowserMode.tsx`
    - `src/renderer/modules/browser/useBrowserViewBounds.ts`
  - preload:
    - `src/preload/index.ts`
  - main:
    - `src/main/modules/browser-engine/host-layout-service.ts`
- Practical rule:
  - preserve the `hideAll() -> updateBounds() -> showActive()` user-facing contract
  - do not let menus, drawers, or transitions depend on "the DOM can cover the webview on Windows"

## Current Mode Architecture
### Browser
- Primary files:
  - `src/renderer/pages/modes/BrowserMode.tsx`
  - `src/renderer/components/browser/BrowserHeader.tsx`
  - `src/renderer/components/browser/TabRail.tsx`
  - `src/renderer/components/browser/ActiveTabSurface.tsx`
  - `src/renderer/components/browser/RefreshDock.tsx`
  - `src/renderer/components/browser/HeaderUtilityActions.tsx`
  - `src/renderer/components/browser/BrowserShellLayout.tsx`
  - `src/renderer/components/browser/BrowserModeEmptyState.tsx`
  - `src/renderer/components/browser/BrowserSidePanel.tsx`
  - `src/renderer/modules/browser/useBrowserHeaderInteraction.ts`
  - `src/renderer/modules/browser/useBrowserViewBounds.ts`
  - `src/renderer/modules/browser/useBrowserPanelData.ts`
  - `src/renderer/modules/browser/tab-rail-layout.ts`
- Current ownership:
  - `BrowserMode.tsx` orchestrates mode state and native host timing
  - `BrowserHeader.tsx` owns the unified header surface
  - `TabRail.tsx` owns tab strip layout, arrows, starter tab behavior, and active-tab slot handling
  - `HeaderUtilityActions.tsx` is the entry point for bookmarks/downloads/more utility menus
- Current rules:
  - do not split browser header back into old tabbar/addressbar files
  - utility menus are native/main-process menus, not a DOM side panel
  - browser side content must not push or resize the page area in a way that fights host bounds

### Document
- Primary files:
  - `src/renderer/pages/modes/DocumentMode.tsx`
  - `src/renderer/components/document/DocumentTabRail.tsx`
  - `src/renderer/components/document/MarkdownEditor.tsx`
  - `src/renderer/components/workbench/WorkbenchProjectTabs.tsx`
- Current ownership:
  - `DocumentMode.tsx` owns tab/split composition and contains the local `DocumentEditor` router
  - `DocumentTabRail.tsx` is the document top chrome
  - the path bar sits below the tab rail and stays visually quiet
- Current rules:
  - document split ratio is document-specific state, not the global workbench split ratio
  - edit/preview switching is lightweight chrome, not a mode remount

### RSS
- Primary files:
  - `src/renderer/pages/modes/RSSMode.tsx`
  - `src/renderer/components/rss/RSSFeed.tsx`
  - `src/renderer/components/rss/PreviewBrowser.tsx`
- Current ownership:
  - `RSSMode.tsx` owns visible-mode activation, warm cache hydration, and preview routing
  - `RSSFeed.tsx` is the feed sheet inside the module shell
  - `PreviewBrowser.tsx` is the embedded preview pane surface
- Current rules:
  - hidden mode should not keep acting like a foreground polling UI
  - outer module shell is `workbench-canvas-shell`
  - feed and preview remain internal surfaces

### Calendar
- Primary files:
  - `src/renderer/pages/modes/CalendarMode.tsx`
  - `src/renderer/components/calendar/CalendarWorkbenchShell.tsx`
  - `src/renderer/components/calendar/CalendarViewSelector.tsx`
  - `src/renderer/styles/schedule-x.css`
- Current ownership:
  - `CalendarMode.tsx` owns event CRUD, load state, source state, and session sync
  - `CalendarWorkbenchShell.tsx` owns the outer visual structure
  - `schedule-x.css` is part of the UI contract, not incidental vendor styling
- Current rules:
  - keep the calendar shell as a unified rounded module surface
  - do not reintroduce obvious inner card borders that break the fused look

### Chat panel
- Primary files:
  - `src/renderer/components/agent/ChatPanel.tsx`
  - `src/renderer/components/agent/ChatHeader.tsx`
  - `src/renderer/components/agent/ChatMessages.tsx`
  - `src/renderer/components/agent/ChatInput.tsx`
  - `src/renderer/components/agent/ChatAttachments.tsx`
- Current ownership:
  - `ChatPanel.tsx` is the coordinator
  - split presentation blocks stay in their own files
- Current rules:
  - keep the chat panel inside `workbench-panel-frame`
  - keep the outer shell transparent in liquid-glass mode
  - do not turn the header back into a separate glass card floating above the panel body

## Current Contract Tests Worth Reading
- `src/__tests__/browser-unified-header-contract.test.ts`
- `src/__tests__/workbench-shell-alignment-contract.test.ts`
- `src/__tests__/panel-fusion-contract.test.ts`
- `src/__tests__/renderer-startup-fouc-contract.test.ts`

These tests are valuable because they lock practical UI truths that prose tends to drift on:
- unified browser header ownership
- left-edge alignment across modules
- fused liquid-glass shell behavior
- first-frame theme bootstrap requirements

## Rules For A Windows Implementation Agent
- Read this file first.
- Then read the referenced source files before changing architecture.
- Recreate structure and contracts before polishing visuals.
- If something is unclear, inspect the current source and tests instead of inventing a new pattern.

### Do not reintroduce
- `BrowserTabBar.tsx`
- `BrowserAddressBar.tsx`
- gooey segmented mode switchers
- late theme bootstrap that waits for renderer startup
- DOM-only assumptions that try to cover BrowserView with `z-index`
- prominent panel borders that break the fused liquid-glass shell
- utility menus that reflow browser content instead of opening as native menus

### Preserve
- first-frame theme correctness
- unified browser header composition
- keep-alive workbench modes
- `workbench-canvas-shell` as the outer module shell
- `workbench-panel-frame` for side/chat outer frames
- browser host hide/show timing discipline

## Acceptance Checklist
- The first frame should already look like the intended theme and skin.
- Browser, Document, RSS, and Calendar top chrome should align to the same left edge.
- TopBar, IconRail, SidePanel, ChatPanel, and StatusBar should read as one fused shell, not separate floating cards.
- Browser mode should never let the native host visually overtake DOM-only chrome during transitions.
- Theme switching should feel coordinated, not like a hard flash.
- Utility menus should not shove browser content around.
- The Windows version should feel like the same product, not a platform-specific redesign.
