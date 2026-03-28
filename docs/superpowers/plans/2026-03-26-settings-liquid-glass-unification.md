# Settings Liquid Glass Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the settings screen visually match the main workbench with the same translucent frosted-glass shell and controls.

**Architecture:** Keep the existing settings information architecture, but replace the page shell and shared settings surface tokens so the header, navigation, content cards, and controls all use the same glass layering as the workbench. Reuse shared settings theme helpers wherever possible so dynamic sections inherit the new style together.

**Tech Stack:** React 19, TypeScript 5, Tailwind CSS v4, renderer CSS variables

---

## Chunk 1: Guardrail Test

### Task 1: Add a contract test for glass-shell settings surfaces

**Files:**
- Create: `src/__tests__/settings-liquid-glass-contract.test.ts`
- Test: `src/__tests__/settings-liquid-glass-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Write a contract test that expects:
- `Settings.tsx` to expose dedicated liquid shell hooks for header, sidebar, and content.
- `Settings.tsx` to use glass surface classes on its main layout shells.
- `settings-theme.ts` to define translucent borders, blur, and glass-like shadows for shared cards and inputs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/settings-liquid-glass-contract.test.ts`
Expected: FAIL because the new shell hooks and glass helpers are not implemented yet.

## Chunk 2: Page Shell

### Task 2: Rebuild the settings page shell around the shared glass language

**Files:**
- Modify: `src/renderer/pages/Settings.tsx`

- [ ] **Step 1: Update the page shell**

Keep the current two-column structure, but:
- make the page background transparent so the app backdrop shows through
- turn the top bar, left navigation, and main content frame into glass surfaces
- add shell-level data hooks for header, sidebar, and content

- [ ] **Step 2: Restyle section affordances**

Update section header, theme cards, and standard setting rows so they read like the same glass system as the workbench.

## Chunk 3: Shared Tokens

### Task 3: Move settings cards and controls onto shared glass tokens

**Files:**
- Modify: `src/renderer/components/settings/settings-theme.ts`
- Modify: `src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- Modify: `src/renderer/components/memory/MemoryStatsCard.tsx`
- Modify: `src/renderer/components/memory/MemoryCreator.tsx`
- Modify: `src/renderer/components/memory/MemoryListPanel.tsx`
- Modify: `src/renderer/components/memory/TriggerManager.tsx`

- [ ] **Step 1: Update shared settings tokens**

Adjust card, subtle card, input, readonly, button, notice, and list item helpers to use translucent backgrounds, softer borders, and blur-aware shadows.

- [ ] **Step 2: Point settings subpanels at those helpers**

Replace local panel/input/button styles in remote IM and memory panels with the shared settings theme helpers so they visually match the new shell.

## Chunk 4: Verification

### Task 4: Prove the change works

**Files:**
- Test: `src/__tests__/settings-liquid-glass-contract.test.ts`

- [ ] **Step 1: Run the contract test**

Run: `npm test -- src/__tests__/settings-liquid-glass-contract.test.ts`
Expected: PASS

- [ ] **Step 2: Run renderer typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 3: Open the settings preview and inspect layout**

Run a local renderer preview for `#/settings?preview=settings` (or equivalent local preview flow) and confirm:
- top bar, sidebar, and content panel all feel like one glass system
- section switching still works
- theme and appearance controls remain readable in light and dark themes
