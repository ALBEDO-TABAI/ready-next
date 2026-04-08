# Workbench Panel Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two workbench-only shortcuts so plain `·` toggles the left file panel and plain `Tab` toggles the agent chat panel when the user is not typing and has no active selection.

**Architecture:** Keep the shortcut listener at the workbench shell so it only applies where both panels exist. Move the eligibility logic into a tiny helper that checks modifiers, editable targets, inline rename/create state, and current text selection before returning a toggle action.

**Tech Stack:** React 19, TypeScript, Zustand, Node test runner

---

## Chunk 1: Shortcut Guard

### Task 1: Lock the shortcut boundary in tests

**Files:**
- Create: `src/__tests__/workbench-panel-shortcuts-contract.test.ts`
- Modify: `src/renderer/pages/WorkbenchMode.tsx`
- Create: `src/renderer/modules/workbench/panel-shortcuts.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('workbench only handles plain `·` and plain Tab when no editable target or text selection is active', () => {
  // Assert the workbench shell delegates gating to a dedicated helper and toggles the right panel.
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-panel-shortcuts-contract.test.ts`
Expected: FAIL because the workbench shell has no such shortcut guard yet

- [ ] **Step 3: Write minimal implementation**

```ts
export function resolveWorkbenchPanelShortcutAction(/* ... */) {
  // return 'toggle-sidebar', 'toggle-chat', or null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-panel-shortcuts-contract.test.ts`
Expected: PASS

## Chunk 2: Regression Validation

### Task 2: Re-run focused browser/workbench checks

**Files:**
- Modify: `src/renderer/pages/WorkbenchMode.tsx`

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run targeted regression tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-panel-shortcuts-contract.test.ts src/__tests__/browser-*.test.ts`
Expected: PASS
