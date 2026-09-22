---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Browser Unified Header Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser's current two-row tab bar and address bar with one unified header where the active tab expands into the address surface and the refresh dock reveals back and forward on hover.

**Architecture:** Introduce a single `BrowserHeader` container as the renderer-only owner of browser-header interaction state, then split the visible chrome into focused parts: `RefreshDock`, `TabRail`, `ActiveTabSurface`, and `HeaderUtilityActions`. Keep persistent browser data and Electron actions in the existing browser stores and hooks so the refactor stays local to renderer composition and interaction wiring.

**Tech Stack:** React 19, TypeScript 5, Zustand, Electron renderer, node:test via `tsx`

---

## Chunk 1: Contract Tests And Header Entry Point

### Task 1: Lock the new top-level browser header composition in tests

**Files:**
- Create: `src/__tests__/browser-unified-header-contract.test.ts`
- Modify: `src/renderer/pages/modes/BrowserMode.tsx`

- [ ] **Step 1: Write the failing test**

Add source-level assertions that `BrowserMode` imports and renders `BrowserHeader` instead of rendering `BrowserTabBar` and `BrowserAddressBar` as separate top-level rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: FAIL because `BrowserMode` still imports and renders the old two-row components.

- [ ] **Step 3: Write minimal implementation**

Create a temporary `BrowserHeader` shell component and swap `BrowserMode` to render it so the browser header has a single top-level entry point, even before all internal parts are migrated.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: PASS.

### Task 2: Lock the header interaction state contract before behavior work

**Files:**
- Modify: `src/__tests__/browser-unified-header-contract.test.ts`
- Create: `src/renderer/modules/browser/useBrowserHeaderInteraction.ts`
- Modify: `src/renderer/components/browser/BrowserHeader.tsx`

- [ ] **Step 1: Write the failing test**

Extend the contract test to assert that:
- `BrowserHeader` imports `useBrowserHeaderInteraction`
- `activeTabMode` includes `compact`, `primed`, `expanded`, and `editing`
- `refreshDockMode` includes `idle`, `primed`, and `revealed`
- the hook owns a root ref used for outside-click collapse wiring

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: FAIL because the interaction hook and state contract do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `useBrowserHeaderInteraction.ts` with the initial state, refs, and no-op collapse helpers, then wire `BrowserHeader` to consume it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: PASS.

## Chunk 2: Active Tab Surface And Tab Rail Migration

### Task 3: Lock the active-tab surface contract in tests

**Files:**
- Modify: `src/__tests__/browser-unified-header-contract.test.ts`
- Create: `src/renderer/components/browser/ActiveTabSurface.tsx`
- Create: `src/renderer/components/browser/TabRail.tsx`

- [ ] **Step 1: Write the failing test**

Add assertions that the new active tab surface:
- renders explicit bookmark and close affordances
- exposes a middle hotspot that triggers expansion
- renders an address input in expanded mode
- keeps tab-strip behavior in a dedicated `TabRail` component rather than in `BrowserMode`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: FAIL because the active-tab surface and extracted rail do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `TabRail.tsx` and `ActiveTabSurface.tsx`, move the existing tab-strip scroll/reorder/new-tab logic out of `BrowserTabBar`, and render the active tab through `ActiveTabSurface` while inactive tabs stay compact.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: PASS.

### Task 4: Make active-tab expansion behavior pass the contract

**Files:**
- Modify: `src/__tests__/browser-unified-header-contract.test.ts`
- Modify: `src/renderer/components/browser/BrowserHeader.tsx`
- Modify: `src/renderer/components/browser/ActiveTabSurface.tsx`
- Modify: `src/renderer/modules/browser/useBrowserHeaderInteraction.ts`
- Modify: `src/renderer/modules/browser/useBrowserTabActions.ts`

- [ ] **Step 1: Write the failing test**

Extend the contract test to assert that:
- clicking the active tab middle hotspot enters expanded mode
- focusing the address input enters editing mode
- Enter navigation collapses the active tab back to compact mode
- clicking outside the tab body collapses expanded or editing mode

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: FAIL because the state transitions and outside-click collapse are not wired yet.

- [ ] **Step 3: Write minimal implementation**

Implement the active-tab transition helpers in `useBrowserHeaderInteraction`, connect them to `ActiveTabSurface`, and add the smallest change needed in `useBrowserTabActions` so Enter navigation can trigger header collapse after dispatching navigation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: PASS.

## Chunk 3: Refresh Dock, Utility Actions, And Old Shell Retirement

### Task 5: Lock the refresh dock reveal and utility migration contract in tests

**Files:**
- Modify: `src/__tests__/browser-unified-header-contract.test.ts`
- Create: `src/renderer/components/browser/RefreshDock.tsx`
- Create: `src/renderer/components/browser/HeaderUtilityActions.tsx`
- Modify: `src/renderer/components/browser/BrowserHeader.tsx`

- [ ] **Step 1: Write the failing test**

Add assertions that:
- `RefreshDock` owns refresh, back, and forward rendering
- `BrowserHeader` passes `loading`, `canGoBack`, and `canGoForward` into `RefreshDock`
- `HeaderUtilityActions` owns the right-side adblock, panel, print, and external-open controls
- the old top-level `BrowserAddressBar` buttons are no longer rendered from `BrowserMode`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: FAIL because the left dock and right utility cluster are not extracted yet.

- [ ] **Step 3: Write minimal implementation**

Create `RefreshDock.tsx` and `HeaderUtilityActions.tsx`, move the existing address-bar utility button logic into those components, and wire the refresh dock hover states through `useBrowserHeaderInteraction`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts`
Expected: PASS.

### Task 6: Remove the old two-row shell and preserve browser bounds behavior

**Files:**
- Modify: `src/renderer/pages/modes/BrowserMode.tsx`
- Modify: `src/renderer/modules/workbench/chrome.ts`
- Modify: `src/__tests__/browser-host-visibility-contract.test.ts`
- Delete or retire: `src/renderer/components/browser/BrowserTabBar.tsx`
- Delete or retire: `src/renderer/components/browser/BrowserAddressBar.tsx`

- [ ] **Step 1: Write the failing test**

Add or extend contract assertions that browser mode now renders a single-row browser header while keeping the existing `useBrowserViewBounds` top inset wiring stable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts`
Expected: FAIL because the old shell still exists or the updated composition is not reflected in the bounds contract.

- [ ] **Step 3: Write minimal implementation**

Remove the remaining top-level `BrowserTabBar` and `BrowserAddressBar` usage, keep the browser content layout stable, and adjust chrome constants only if the final single-row header height truly changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts`
Expected: PASS.

## Chunk 4: Documentation And Verification

### Task 7: Document the new browser header behavior in collaboration docs

**Files:**
- Modify: `PROJECT_OVERVIEW.md`
- Modify: `PROGRESS.md`
- Modify: `LESSONS_LEARNED.md`

- [ ] **Step 1: Add concise browser-header notes**

Document that browser mode now uses a unified header where the active tab expands into the address surface and refresh hover reveals back and forward controls.

- [ ] **Step 2: Sanity-check the new notes**

Run: `rg -n "unified header|active tab expands|refresh dock" PROJECT_OVERVIEW.md PROGRESS.md LESSONS_LEARNED.md`
Expected: The new browser-header notes are present.

### Task 8: Run focused verification for the browser header refactor

**Files:**
- Test: `src/__tests__/browser-unified-header-contract.test.ts`
- Test: `src/__tests__/browser-host-visibility-contract.test.ts`
- Test: `src/__tests__/ui-browser-hook-split-contract.test.ts`

- [ ] **Step 1: Run focused browser contract tests**

Run: `npm test -- src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/ui-browser-hook-split-contract.test.ts`
Expected: PASS.

- [ ] **Step 2: Run project typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Review the targeted diff**

Run: `git diff -- src/renderer/pages/modes/BrowserMode.tsx src/renderer/components/browser/BrowserHeader.tsx src/renderer/components/browser/TabRail.tsx src/renderer/components/browser/ActiveTabSurface.tsx src/renderer/components/browser/RefreshDock.tsx src/renderer/components/browser/HeaderUtilityActions.tsx src/renderer/modules/browser/useBrowserHeaderInteraction.ts src/renderer/modules/browser/useBrowserTabActions.ts src/renderer/modules/workbench/chrome.ts src/__tests__/browser-unified-header-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts PROJECT_OVERVIEW.md PROGRESS.md LESSONS_LEARNED.md`
Expected: Only the intended unified browser header changes are present.
