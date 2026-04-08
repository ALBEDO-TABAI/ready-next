# Document Widget Card Header Actions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified widget card header in document edit and preview views with rename, quote-to-agent, and card export actions.

**Architecture:** Reuse one shared widget header component so edit-mode code-block cards and preview-mode rendered widgets keep the same visual language and behavior. Keep rename as a true widget title update in document content, reuse the existing widget-target attachment flow for quoting, and add a card-level export helper that can save a single widget as SVG or HTML snapshot today while leaving room for future PNG rendering.

**Tech Stack:** React 19, TypeScript, Tiptap widget decorations, Electron IPC save dialog, existing document widget snapshot helpers, node:test + tsx

---

## Chunk 1: Contracts And Shared Surface

### Task 1: Add failing tests for the new widget card header behavior

**Files:**
- Modify: `src/__tests__/document-widget-system.test.ts`
- Test: `src/__tests__/document-widget-system.test.ts`

- [ ] **Step 1: Write failing contract assertions**

Add assertions that:
- `DocumentWidgetBlockCard` exposes rename, quote, and export actions
- `NotePreview` renders the same card shell around preview widgets
- `MarkdownEditor` wires preview widget actions through shared handlers

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts`
Expected: FAIL because preview widgets do not yet render the shared header and export action is missing.

- [ ] **Step 3: Commit after green**

```bash
git add src/__tests__/document-widget-system.test.ts
git commit -m "test(document): cover widget card header actions"
```

## Chunk 2: Shared Widget Toolbar

### Task 2: Build a shared widget card surface used by edit and preview

**Files:**
- Create: `src/renderer/components/document/DocumentWidgetCardShell.tsx`
- Modify: `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
- Modify: `src/renderer/components/document/NotePreview.tsx`
- Modify: `src/renderer/styles/tiptap.css`
- Modify: `src/renderer/styles/index.css`

- [ ] **Step 1: Add minimal shared shell implementation**

Create a component that renders:
- editable title pill
- quote button
- export button
- content slot for widget body

- [ ] **Step 2: Reuse shell in edit and preview**

Move edit card header UI to the shared shell and wrap preview widgets with the same shell.

- [ ] **Step 3: Update spacing and alignment styles**

Keep the current Ready document language:
- soft border
- subtle glassy fill
- comfortable top padding
- compact but readable right-side action buttons with full text labels

- [ ] **Step 4: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts`
Expected: PASS

## Chunk 3: Rename, Quote, Export Wiring

### Task 3: Wire title updates and quote/export actions into the live document flow

**Files:**
- Modify: `src/renderer/components/document/TiptapEditor.tsx`
- Modify: `src/renderer/components/document/MarkdownEditor.tsx`
- Modify: `src/renderer/components/document/NotePreview.tsx`
- Modify: `src/renderer/modules/agent/chat-input-bridge.ts`
- Modify: `src/renderer/modules/agent/widget-target-attachment.ts`
- Modify: `src/shared/widget-export-snapshot.ts` (if needed for title-aware export metadata)

- [ ] **Step 1: Add failing tests for title update and card export helpers**

Cover:
- renaming a widget updates the serialized `show-widget` title
- quote action still targets the current widget title
- export helper resolves a safe suggested file name

- [ ] **Step 2: Run tests to verify red**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-export-snapshot.test.ts`
Expected: FAIL on the new rename/export assertions.

- [ ] **Step 3: Implement minimal behavior**

Add handlers so:
- rename edits the widget fence title in the document source
- quote reuses existing widget-target attachment flow
- export saves the current widget as `.svg` or `.html` snapshot through the existing save dialog path

- [ ] **Step 4: Re-run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-export-snapshot.test.ts`
Expected: PASS

## Chunk 4: End-To-End Verification

### Task 4: Verify visual and behavior regressions in document mode

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Record the behavior change**

Document that widget cards now expose inline rename, quote, and export actions in both edit and preview views.

- [ ] **Step 2: Run full focused verification**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-export-snapshot.test.ts src/__tests__/document-widget-openui.test.ts`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Manual regression**

Open document mode and verify:
- title click-to-rename works in edit and preview
- quote opens chat with current widget attached
- export saves the current card
- spacing stays aligned with the existing document shell

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/document src/renderer/modules/agent src/shared src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-export-snapshot.test.ts src/renderer/styles/index.css src/renderer/styles/tiptap.css CHANGELOG.md docs/superpowers/plans/2026-04-08-document-widget-card-header-actions.md
git commit -m "feat(document): add widget card header actions"
```

Plan complete and saved to `docs/superpowers/plans/2026-04-08-document-widget-card-header-actions.md`. Ready to execute.
