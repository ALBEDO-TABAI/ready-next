---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Browser Unified Header Design

> Date: 2026-03-23
> Status: Draft for review
> Scope: Browser mode unified single-row header, active-tab address expansion, and refresh dock reveal interactions

## Goal

Replace the current two-row browser chrome in `BrowserMode` with a single unified header that:

- keeps the current browser tab and navigation capabilities intact
- turns the active tab itself into the address surface
- adds explicit bookmark and close affordances on tabs
- reveals back and forward controls from the refresh dock on hover
- uses lightweight liquid-style motion without destabilizing BrowserView bounds or existing panel behavior

## Problem Summary

The current browser chrome splits the experience into two rows:

1. `BrowserTabBar` renders the tabs
2. `BrowserAddressBar` renders navigation, URL entry, and utility actions

That structure creates two product issues:

- the browser header visually feels incomplete because the tab row lacks obvious functional affordances
- the interaction model does not match the desired product direction, where the active tab should become the address bar instead of handing control to a second row

The result is a browser UI that works functionally but does not feel coherent or intentional.

## Decision

Adopt a unified single-row browser header.

The recommended implementation is to replace the current top-level `BrowserTabBar + BrowserAddressBar` composition with a new `BrowserHeader` container that owns the UI interaction state for:

- active tab compact / primed / expanded / editing modes
- refresh dock idle / primed / revealed modes

Existing browser business actions and store state should remain in the current hooks and stores. This is a renderer architecture refactor, not a browser-engine behavior rewrite.

## Non-Goals

- no change to `BrowserView` creation, tab lifecycle, or Electron browser handlers
- no change to bookmark/history/download persistence behavior
- no redesign of the browser side panel content
- no additional global keyboard shortcut work beyond preserving current navigation behavior
- no heavy animation framework adoption for the header

## Current Code Anchors

The implementation should be grounded in the current browser module structure:

- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/components/browser/BrowserTabBar.tsx`
- `src/renderer/components/browser/BrowserAddressBar.tsx`
- `src/renderer/components/browser/BrowserShellLayout.tsx`
- `src/renderer/modules/browser/useBrowserTabActions.ts`
- `src/renderer/modules/browser/useBrowserPanelData.ts`
- `src/renderer/stores/useBrowserTabs.ts`
- `src/renderer/modules/workbench/chrome.ts`

## User Experience Targets

### Unified Header

- browser mode renders a single header row above the web content
- the active tab looks like a functional browser surface, not just a label
- non-active tabs remain compact and reorderable

### Active Tab Surface

- every visible tab includes explicit bookmark and close affordances
- clicking the active tab's middle region expands it into address mode
- the expanded tab keeps the same physical position in the strip rather than jumping to a second row
- pressing Enter while editing navigates and then collapses back to compact mode
- clicking anywhere outside the tab body collapses the expanded state

### Refresh Dock

- refresh stays visible to the left of the active tab
- hovering the dock first gives a subtle primed response
- continuing the hover reveals back and forward around the refresh control
- the reveal should feel continuous, not like a hard swap

### Motion Tone

- motion should signal affordance, not draw attention away from content
- the only strong animated regions are the active tab middle hotspot and refresh dock
- surrounding tabs should shift only slightly to accommodate expansion

## Proposed Architecture

### 1. New Top-Level Header Container

Create a new `BrowserHeader` component that becomes the only top-level header rendered by `BrowserMode`.

Responsibilities:

- own transient header interaction state
- coordinate layout of left dock, tab rail, and right utility actions
- detect outside clicks for collapse behavior
- keep the rest of browser data flow unchanged

`BrowserMode` should still compute the business data and callbacks, then pass them into `BrowserHeader`.

### 2. Component Decomposition

The unified header should be split into focused internal components:

#### `BrowserHeader`

- root layout and state coordinator
- owns `activeTabMode` and `refreshDockMode`
- exposes a single header root ref for outside-click detection

#### `RefreshDock`

- renders refresh, back, and forward controls
- handles idle / primed / revealed visual states
- does not own navigation business logic

#### `TabRail`

- renders the tab strip container, overflow handling, drag reorder, and new-tab button
- renders inactive tabs directly
- renders the active tab through `ActiveTabSurface`

#### `ActiveTabSurface`

- compact tab rendering for the active tab
- expandable address-entry rendering
- middle hotspot for expand behavior
- explicit bookmark and close buttons in both compact and expanded forms

#### `HeaderUtilityActions`

- renders the right-side controls currently living in `BrowserAddressBar`
- preserves bookmarks / downloads / history / adblock / print / external-open actions
- triggers header collapse before or alongside utility action handling

### 3. State Ownership

Keep persistent browser state where it already belongs:

- `tabs`, `activeTabId`, and `urlInput` stay in `useBrowserTabs`
- tab lifecycle and navigation actions stay in `useBrowserTabActions`
- bookmark and side-panel state stay in `useBrowserPanelData`

Add a renderer-only interaction hook, for example `useBrowserHeaderInteraction`, to own transient UI states:

- `activeTabMode: 'compact' | 'primed' | 'expanded' | 'editing'`
- `refreshDockMode: 'idle' | 'primed' | 'revealed'`

This hook may also own:

- header root ref
- active tab hotspot ref
- refresh dock ref
- outside-click collapse handler

## Interaction Rules

### Active Tab

- clicking a non-active tab switches tabs and never expands it
- clicking the active tab middle hotspot changes `compact -> expanded`
- hovering the active tab middle hotspot changes `compact -> primed`
- leaving the hotspot without expansion returns `primed -> compact`
- focusing the input changes `expanded -> editing`
- pressing Enter in editing mode navigates and collapses back to `compact`
- clicking outside the tab body while expanded or editing collapses back to `compact`
- clicking bookmark, close, or right utility actions should also leave the expanded state

### Refresh Dock

- default state is `idle` with only refresh visible
- hover entry changes `idle -> primed`
- deeper or sustained hover reveals back and forward with `primed -> revealed`
- leaving the dock returns to `idle`
- executing dock actions should not force the dock to stay open

### URL Synchronization

- when expansion begins, the input should show the current active tab URL
- on collapse without navigation, `urlInput` should reset to the active tab URL
- on Enter navigation, the target URL should be written to `urlInput`, navigation triggered, then the UI collapses

## Visual And Motion Rules

### Layout

- keep the header at the current toolbar row height baseline from `workbench/chrome`
- use a single continuous rail rather than stacked bars
- active tab expansion should happen in-place inside the strip

### Motion

- primed feedback: roughly `120-160ms`
- active-tab expansion: roughly `180-220ms`
- refresh dock reveal: roughly `160-200ms`
- collapse should be slightly faster than expansion

Preferred implementation:

- CSS transitions
- state-driven class toggles
- reuse existing morph tab primitives only where they simplify strip behavior

Avoid:

- large layout choreography across the whole header
- animation dependencies that make the header timing hard to reason about

## File Structure Recommendation

Recommended new files:

- `src/renderer/components/browser/BrowserHeader.tsx`
- `src/renderer/components/browser/BrowserHeaderParts.tsx` or a small set of focused files such as:
  - `src/renderer/components/browser/RefreshDock.tsx`
  - `src/renderer/components/browser/ActiveTabSurface.tsx`
  - `src/renderer/components/browser/HeaderUtilityActions.tsx`
- `src/renderer/modules/browser/useBrowserHeaderInteraction.ts`

Recommended modified files:

- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/components/browser/BrowserTabBar.tsx` or replace it entirely if the new structure makes it redundant
- `src/renderer/components/browser/BrowserAddressBar.tsx` or replace it entirely after extracting reusable logic
- `src/renderer/modules/workbench/chrome.ts` only if dimensions must change

The exact split can be adjusted, but the key requirement is that the final code should have one clear state owner for header UI behavior.

## Testing Strategy

### Renderer Interaction Tests

Add focused tests for:

- non-active tab click switching without expansion
- active-tab middle click entering expanded or editing mode
- Enter navigation collapsing the tab back to compact mode
- outside-click collapse behavior
- refresh dock reveal behavior
- bookmark and close actions remaining clickable in compact and expanded states

### Regression Coverage

Verify existing behavior still works:

- drag reorder
- new tab creation
- middle-click close
- bookmark panel toggle
- downloads/history panel toggle
- adblock toggles
- print and external-open actions

### Manual Verification

At minimum, manually verify:

- BrowserView bounds still align after the header becomes single-row
- active tab expansion does not visually overlap the side panel trigger area
- dock reveal remains usable at narrow widths
- the browser still behaves correctly when there are many tabs and horizontal overflow

## Documentation Impact

This change touches browser UI behavior and cross-module interaction rules. During implementation, update the relevant root-level collaboration docs called out by the project instructions if the final behavior or architecture meaningfully changes:

- `PROJECT_OVERVIEW.md`
- `DOCUMENTATION.md`
- `LESSONS_LEARNED.md`
- `PROGRESS.md`

Also keep `AGENTS.md` and `CLAUDE.md` behavior guidance aligned if any browser-specific collaboration rule is introduced.

## Risks

### 1. State Split Regression

If the new header reuses old components too literally, the result may still behave like two hidden rows instead of a true single-state surface.

Mitigation:

- move transient header state to one owner
- reuse low-level logic, not whole old shells

### 2. Outside Click Edge Cases

Expanded-state collapse can become fragile if blur and pointer handlers compete.

Mitigation:

- use one header root ref
- handle collapse from document-level pointer events
- keep input blur logic limited to URL value sync

### 3. Overflow And Reveal Conflicts

Expansion and dock reveal may compete for space when many tabs are open.

Mitigation:

- keep inactive tabs compact
- allow active tab expansion within a constrained max width
- preserve overflow controls for the rail

## Recommended Next Step

Write an implementation plan that:

- introduces `BrowserHeader` as the sole top-level browser chrome
- migrates tab-strip behavior without regressing existing tab management
- migrates address-input and utility behavior into the active-tab surface and right utility cluster
- adds tests for the new interaction state machine before implementation code
