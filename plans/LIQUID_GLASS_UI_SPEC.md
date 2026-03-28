# Ready Liquid Glass UI Technical Spec

> Updated: 2026-03-20
> Baseline commit: `8812c4d`
> Scope: Renderer UI architecture, workbench shell, liquid glass surface system, BrowserView visibility rules, and current mode-level split boundaries.

## Project Goal
- Keep Ready’s workbench UI visually unified across Browser, Document, RSS, Calendar, Side Panel, Chat Panel, and top chrome.
- Make the UI codebase easy for another agent to change without re-discovering which file owns colors, which file owns geometry, and which component is allowed to render which shell layer.
- Preserve current user-facing behavior while continuing the P4 structural split work.

## Current Scope
- Included:
  - workbench shell layout
  - liquid glass styling tokens and surface classes
  - Browser / Document / RSS / Calendar mode structure
  - BrowserView visibility and bounds synchronization
  - Chat panel presentation split
  - UI-only error-state behavior and partial-failure messaging
- Excluded:
  - agent runtime protocol changes
  - provider/LLM behavior
  - database schema changes
  - business-rule changes for RSS/calendar/document tools

## Source Of Truth
### 1. Geometry and layout numbers
- File: `src/renderer/modules/workbench/chrome.ts`
- Owns:
  - top bar height
  - tab row height
  - toolbar row height
  - shared horizontal alignment numbers such as `WORKBENCH_HEADER_EDGE_X`
  - shared support panel width
- Do not put colors or blur behavior here.

### 2. Semantic panel tokens
- File: `src/renderer/components/layout/panelTokens.ts`
- Owns:
  - side panel dimensions
  - global search panel dimensions
  - skills panel dimensions
  - semantic aliases like `PANEL_TOKENS.title`, `PANEL_TOKENS.border`, `PANEL_TOKENS.blue`
- Use this file when a layout component needs a semantic panel token but should not know the raw CSS variable name.

### 3. Visual token and shell class source of truth
- File: `src/renderer/styles/index.css`
- Owns:
  - root theme variables
  - liquid glass theme variables
  - `workbench-canvas-shell`
  - `glass-surface-panel`
  - `glass-surface-card`
  - `content-surface-panel`
  - `workbench-panel-frame`
  - skin-specific overrides for Browser / RSS / Calendar shell edges
- If a visual override can be expressed as a shared class, put it here instead of repeating inline styles across pages.

### 4. Mode orchestration
- File: `src/renderer/pages/WorkbenchMode.tsx`
- Owns:
  - top-level workbench composition
  - side panel + icon rail + chat panel placement
  - single vs split view layout
  - “browser not visible => hide native browser hosts” rule
- File: `src/renderer/components/layout/WorkbenchModeOutlet.tsx`
- Owns:
  - keep-alive mounting of Browser / Document / RSS / Calendar
  - CSS-only visibility switching via `hidden`
  - `isActive` propagation into mode pages

## Workbench Shell Contract
### Shell layers
- `workbench-canvas-shell`
  - meaning: outer rounded rectangle of one workbench module
  - use for: Browser / Document / RSS / Calendar main module frame
  - do not use for: internal cards, list rows, floating menus
- `glass-surface-panel`
  - meaning: top chrome band, tab strip band, panel header band
  - use for: Browser tab bar, Document tabs strip, chat header, topbar-like chrome
- `content-surface-panel`
  - meaning: internal content panel inside a shell
  - use for: RSS feed body, Browser side panel, inner content sections
  - must not be used as the module’s outer shell
- `workbench-panel-frame`
  - meaning: side-mounted frame such as side panel or chat panel
  - use for: left side panel, right chat panel

### Alignment rules
- Shared left edge for module chrome is `WORKBENCH_HEADER_EDGE_X`.
- Browser / Document / RSS / Calendar top chrome should visually align to this same left edge.
- When a module has a left support column plus right content column, the outer rounded rectangle still belongs to the single `workbench-canvas-shell`, not to each half separately.

## BrowserView Invariants
- Renderer truth:
  - `src/renderer/pages/WorkbenchMode.tsx`
  - `src/renderer/modules/browser/useBrowserViewBounds.ts`
  - `src/renderer/pages/modes/BrowserMode.tsx`
- Main-process truth:
  - `src/main/modules/browser-engine/tab-shell-service.ts`
  - `src/main/modules/browser-engine/host-layout-service.ts`

### Required behavior
- If the currently visible workbench modes do not include `browser`, renderer must call `browser.hideAll()`.
- Hidden browser hosts must not be restored by a delayed renderer callback.
- Main process must not apply visible bounds when `shouldPresentHosts()` is false.
- `hideHost()` must cancel any pending bounds timer before applying offscreen bounds.
- Preview/native browser overlays follow the same visibility model as active tab hosts.

### Windows note
- Treat BrowserView/WebContentsView as native overlays exactly like on macOS.
- Do not assume DOM `z-index` can cover them on Windows.
- Any Windows implementation must preserve the `hideAll()/showActive()` contract before changing overlay or drawer behavior.

## Current Mode Architecture
### Browser
- Page: `src/renderer/pages/modes/BrowserMode.tsx`
- Current ownership:
  - mode-level orchestration only
  - address bar and shell prop composition
- Already extracted:
  - empty state: `src/renderer/components/browser/BrowserModeEmptyState.tsx`
  - URL/domain helpers: `src/renderer/modules/browser/url-utils.ts`
  - tab/navigation actions: `src/renderer/modules/browser/useBrowserTabActions.ts`
  - panel data state: `src/renderer/modules/browser/useBrowserPanelData.ts`
  - diagnostics/adblock/toast state: `src/renderer/modules/browser/useBrowserDiagnosticsState.ts`
  - runtime subscriptions + native visibility effects: `src/renderer/modules/browser/useBrowserRuntimeEffects.ts`
  - bounds sync: `src/renderer/modules/browser/useBrowserViewBounds.ts`
- Remaining acceptable responsibility in `BrowserMode.tsx`:
  - composing props for `BrowserTabBar`, `BrowserAddressBar`, `BrowserShellLayout`
  - selecting which shell component renders based on tab state

### Document
- Page: `src/renderer/pages/modes/DocumentMode.tsx`
- Editor page already uses:
  - `WorkbenchProjectTabs`
  - `MarkdownEditor`
  - `FilePreview`
  - `UniverSheet`
- Current shape is acceptable:
  - outer shell in page
  - content routing delegated to `DocumentEditor`
  - edit/preview chrome visually acts as the reference model for Calendar shell styling

### RSS
- Page: `src/renderer/pages/modes/RSSMode.tsx`
- Important behavior:
  - `isActive` gates polling and auto-refresh
  - hidden mode pauses background churn
  - preview browser closes when mode is hidden
- Current shell rule:
  - outer module shape is `workbench-canvas-shell`
  - feed list remains an internal `content-surface-panel`

### Calendar
- Page: `src/renderer/pages/modes/CalendarMode.tsx`
- Current ownership:
  - event CRUD and modal wiring
  - date/view state
  - source toggling
  - session sync
- Already extracted:
  - outer visual shell: `src/renderer/components/calendar/CalendarWorkbenchShell.tsx`
  - view selector: `src/renderer/components/calendar/CalendarViewSelector.tsx`
  - module cache: `src/renderer/modules/calendar/calendarCache.ts`
  - quick-create/menu/card/drag-create state: `src/renderer/modules/calendar/useCalendarQuickCreate.ts`
  - SX lifecycle and portal sync: `src/renderer/modules/calendar/useScheduleXCalendar.ts`
 - Remaining acceptable responsibility in `CalendarMode.tsx`:
  - event CRUD
  - modal open/save/delete wiring
  - session sync
  - passing already-derived props into `CalendarWorkbenchShell`

### Chat panel
- Main container: `src/renderer/components/agent/ChatPanel.tsx`
- Already split presentation pieces:
  - `ChatHeader.tsx`
  - `ChatMessages.tsx`
  - `ChatAttachments.tsx`
  - `ChatInput.tsx`
- `ChatPanel.tsx` should remain the business/state coordinator and should not re-inline those display blocks again.

## UI Error Handling Rules
- Do not silently replace real data with mock data in normal runtime.
- If workbench init fails, show an explicit banner with retry.
- If calendar load fails, show an explicit inline warning.
- If document load fails or format is unsupported for direct editing, show an explicit editor-state message.
- For background/partial failures:
  - RSS uses visible status messaging
  - Skills Center uses visible import error messaging
  - Global Search explicitly says results may be incomplete

## Current Tests That Protect The UI Structure
- `src/__tests__/browser-host-visibility-contract.test.ts`
- `src/__tests__/workbench-keep-alive-contract.test.ts`
- `src/__tests__/workbench-shell-alignment-contract.test.ts`
- `src/__tests__/ui-structure-cleanup-contract.test.ts`
- `src/__tests__/ui-fail-fast-contract.test.ts`
- `src/__tests__/ui-partial-failure-contract.test.ts`
- `src/__tests__/browser-url-utils.test.ts`
- `src/__tests__/ui-mode-split-contract.test.ts`
- `src/__tests__/ui-browser-hook-split-contract.test.ts`

## Commands To Verify Before Any UI Merge
```bash
npx tsx@^4.19.2 --test \
  src/__tests__/browser-host-visibility-contract.test.ts \
  src/__tests__/workbench-keep-alive-contract.test.ts \
  src/__tests__/workbench-shell-alignment-contract.test.ts \
  src/__tests__/ui-structure-cleanup-contract.test.ts \
  src/__tests__/ui-fail-fast-contract.test.ts \
  src/__tests__/ui-partial-failure-contract.test.ts \
  src/__tests__/browser-url-utils.test.ts \
  src/__tests__/ui-mode-split-contract.test.ts \
  src/__tests__/ui-browser-hook-split-contract.test.ts

npm run typecheck
```

## Rules For A Windows Implementation Agent
- Read only this file plus the listed source files before changing UI architecture.
- Do not reintroduce:
  - outer-shell styling via `content-surface-panel`
  - gooey segmented module switchers
  - silent mock fallbacks for real UI failures
  - native BrowserView restore paths that bypass `hideAll()/showActive()`
- If changing a module shell:
  - check `chrome.ts` for geometry
  - check `panelTokens.ts` for semantic panel tokens
  - check `index.css` for class-level visual ownership
  - only then touch page-level inline styles
- If changing Browser mode:
  - update hook modules first
  - keep `BrowserMode.tsx` orchestration-focused
  - prefer adding future stateful behavior into:
    - `useBrowserTabActions.ts`
    - `useBrowserPanelData.ts`
    - `useBrowserDiagnosticsState.ts`
    - `useBrowserRuntimeEffects.ts`
- If changing Calendar mode:
  - keep `CalendarWorkbenchShell.tsx` visual
  - keep `useCalendarQuickCreate.ts` responsible for quick-create state
  - keep `useScheduleXCalendar.ts` responsible for SX DOM/app lifecycle
  - keep `calendarCache.ts` as the only cache source of truth for mode persistence
- If changing Chat panel:
  - keep `ChatPanel.tsx` as coordinator
  - keep the four split presentation components as the display layer

## Remaining Recommended P4 Follow-Up
- Browser:
  - optional next step only if needed: split address-bar specific composition from shell composition
- Calendar:
  - optional next step only if needed: split event CRUD into a dedicated hook
- Chat:
  - only continue splitting if `ChatPanel.tsx` still owns non-trivial view-only blocks that are not already delegated

## Acceptance Notes
- Another agent should be able to:
  - locate the true source of a color or shell style in under one minute
  - identify whether a change belongs in page, shell component, hook, or global CSS without guessing
  - modify BrowserView visibility behavior without breaking the hide/show invariants
  - extend Calendar or Browser presentation without re-inlining already split blocks
