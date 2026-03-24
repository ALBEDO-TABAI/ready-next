# Document Mode Source/Rich Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse text documents to `源码 / 排版`, make `排版` the only clean finished surface, and move generative UI actions back into `源码`.

**Architecture:** Keep non-text file viewers unchanged, simplify text-mode state to two surfaces, and reuse the structured note parsing/rendering work inside a richer `排版` surface instead of a separate preview mode. Keep generative UI rendering unified through `WidgetRenderer`, but separate result-only presentation in `排版` from management actions in `源码`.

**Tech Stack:** React 19, TypeScript, Zustand, existing document widget runtime, Node test runner (`tsx --test`)

---

## Chunk 1: Mode Rules And Surface Routing

### Task 1: Lock the new two-mode rules in tests

**Files:**
- Modify: `src/__tests__/document-view-modes.test.ts`
- Modify: `src/__tests__/document-widget-system.test.ts`

- [ ] **Step 1: Write the failing tests**

Add expectations that:
- markdown-like files only expose `source` and `rich`
- markdown-like files default to `rich`
- legacy `preview` requests normalize to `rich`
- generative UI source cards no longer expose a `预览` action

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-view-modes.test.ts src/__tests__/document-widget-system.test.ts`
Expected: FAIL because current mode rules still expose `preview` and widget cards still contain the preview action.

- [ ] **Step 3: Write minimal implementation**

Update the document mode rule helper and widget card contract to match the new two-mode design.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-view-modes.test.ts src/__tests__/document-widget-system.test.ts`
Expected: PASS

### Task 2: Simplify mode state and top-bar controls

**Files:**
- Modify: `src/renderer/components/document/document-view-modes.ts`
- Modify: `src/renderer/pages/modes/DocumentMode.tsx`

- [ ] **Step 1: Update mode enum and option rules**

Remove text-mode `preview` from the helper and make markdown-like documents default to `rich`.

- [ ] **Step 2: Update the document page header**

Show only the relevant controls for text documents, remove preview-only routing, and make old preview state fall back to `rich`.

- [ ] **Step 3: Verify mode routing**

Run: `npm run typecheck`
Expected: PASS

## Chunk 2: Rich Surface Becomes The Only Finished View

### Task 3: Replace preview-mode rendering with a richer finished document surface

**Files:**
- Create: `src/renderer/components/document/RichDocumentView.tsx`
- Modify: `src/renderer/components/document/MarkdownEditor.tsx`
- Modify: `src/renderer/components/document/note-preview-parser.ts` (only if needed for shared structured data)
- Modify: `src/renderer/styles/index.css`

- [ ] **Step 1: Write the failing test or contract**

Add or update tests to reflect that text documents no longer route through a separate preview-only branch.

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-view-modes.test.ts src/__tests__/document-widget-system.test.ts`
Expected: FAIL or remain red until the preview branch is removed and the new rich surface is wired.

- [ ] **Step 3: Build the rich surface**

Create a clean result-only document surface that:
- uses structured note parsing
- keeps title, metadata, tags, hero media, body blocks, and widgets
- presents widgets without edit/manage buttons
- is visually suitable as the future export baseline

- [ ] **Step 4: Wire rich mode to the new surface**

Use the new component from `MarkdownEditor` and remove the separate `preview` render path.

- [ ] **Step 5: Verify targeted tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-view-modes.test.ts src/__tests__/document-widget-system.test.ts src/__tests__/note-preview-parser.test.ts`
Expected: PASS

## Chunk 3: Source Surface Keeps Editing And Widget Management

### Task 4: Move generative UI actions into source mode

**Files:**
- Modify: `src/renderer/components/document/MarkdownEditor.tsx`
- Modify: `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
- Modify: `src/renderer/components/document/TiptapEditor.tsx` (remove preview callback and any no-longer-used edit-only preview path)
- Modify: `src/renderer/styles/tiptap.css`
- Modify: `src/renderer/styles/index.css`

- [ ] **Step 1: Keep source editing raw and visible**

Preserve the raw textarea for Markdown/text editing.

- [ ] **Step 2: Add source-mode widget management cards**

Render the document’s `show-widget` blocks in source mode as management cards near the raw editor, with:
- `让 agent 更新`
- `查看源码`
- `复制源码`
- `删除`

- [ ] **Step 3: Remove preview action from widget cards**

Delete the preview CTA and any `onRequestPreview` plumbing tied to widget cards.

- [ ] **Step 4: Verify source-mode widget contracts**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-authoring.test.ts src/__tests__/document-widget-target-context.test.ts`
Expected: PASS

## Chunk 4: Cleanup, Docs, And Final Verification

### Task 5: Update copy and docs to match the new mental model

**Files:**
- Modify: `src/renderer/components/document/MarkdownEditor.tsx`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Remove stale “preview” copy in text document mode**

Update default help copy and in-surface hints so they describe `源码 / 排版`.

- [ ] **Step 2: Refresh project docs**

Record that text documents now use the two-surface model and that `排版` is the finished/export-oriented surface.

- [ ] **Step 3: Run final verification**

Run:
- `npm run typecheck`
- `npm test`
- `npm run build`

Expected:
- typecheck passes
- all tests pass
- build passes
