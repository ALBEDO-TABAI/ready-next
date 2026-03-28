# Document Generative UI Unified Widget Runtime Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document `show-widget` blocks run through one sandboxed runtime so local interactive widgets behave the same in edit and preview modes.

**Architecture:** Unify document widget rendering around the existing iframe receiver instead of splitting static HTML and script-backed widgets into separate paths. Tighten sanitizer expectations and widget guidance so local inline-event widgets and small script widgets both remain valid inside the same sandbox boundary.

**Tech Stack:** React 19, TypeScript 5, Electron renderer, node:test via `tsx`

---

## Chunk 1: Runtime Contract Tests

### Task 1: Lock the unified sanitizer contract in tests

**Files:**
- Modify: `src/__tests__/document-widget-system.test.ts`
- Modify: `src/renderer/components/document/widget-sanitizer.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that finalized widget sanitization keeps local inline handlers even when no `<script>` tag exists, while still stripping dangerous tags and `javascript:` URLs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: FAIL on the new handler-preservation assertion.

- [ ] **Step 3: Write minimal implementation**

Update sanitizer helpers so the finalized widget payload no longer uses `<script>` presence as the gate for preserving local inline handlers.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: PASS.

### Task 2: Lock the renderer contract in source-level tests

**Files:**
- Modify: `src/__tests__/document-widget-system.test.ts`
- Modify: `src/renderer/components/document/WidgetRenderer.tsx`

- [ ] **Step 1: Write the failing test**

Add source-level assertions that `WidgetRenderer` no longer has a non-sandbox `dangerouslySetInnerHTML` rendering branch for finalized widget content.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: FAIL because the static branch still exists.

- [ ] **Step 3: Write minimal implementation**

Refactor `WidgetRenderer` so all widgets flow through the iframe receiver while keeping fallback content only as degraded error UI.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: PASS.

## Chunk 2: Renderer Unification

### Task 3: Unify widget runtime execution

**Files:**
- Modify: `src/renderer/components/document/WidgetRenderer.tsx`
- Modify: `src/renderer/components/document/widget-sanitizer.ts`

- [ ] **Step 1: Refactor the iframe setup**

Always build the receiver document and blob URL for widget content. Remove the `needsSandbox` gate from the main render path.

- [ ] **Step 2: Preserve local interaction safely**

Ensure sanitized finalized widget HTML:
- keeps inline handlers for local interaction
- keeps existing script whitelist behavior
- still strips dangerous tags and `javascript:` URLs

- [ ] **Step 3: Keep degraded fallback behavior**

Retain static fallback content only for receiver startup failure or runtime error states, not as the normal rendering path.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: PASS.

### Task 4: Align edit and preview mode widget usage

**Files:**
- Modify: `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
- Modify: `src/renderer/components/document/NotePreview.tsx`
- Modify: `src/renderer/components/document/TiptapEditor.tsx`

- [ ] **Step 1: Simplify mode labeling**

Rename the widget mode labels so they no longer imply that non-script widgets are necessarily static.

- [ ] **Step 2: Verify edit-mode card preview still renders the unified widget runtime**

Keep `DocumentWidgetBlockCard` using `WidgetRenderer` directly so edit-mode preview matches preview mode behavior.

- [ ] **Step 3: Verify preview-mode usage remains unchanged**

Keep `NotePreview` using the same `WidgetRenderer` path with no parallel rendering logic.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: PASS.

## Chunk 3: Agent Guidance And Regression Coverage

### Task 5: Update widget authoring guidance

**Files:**
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/main/modules/tools/document-tools.ts`

- [ ] **Step 1: Write the failing test or source assertion**

If there is an existing prompt/tool contract test file that covers document widget guidance, extend it. If not, add a narrow source-level assertion in `src/__tests__/document-widget-system.test.ts` that the guidance allows local-only inline interactivity without requiring `<script>`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: FAIL because current guidance still biases toward script-only interactivity.

- [ ] **Step 3: Write minimal implementation**

Update document widget guidance so agents know:
- local inline events are allowed
- complex local interactivity may use small inline scripts
- network and submit behaviors remain forbidden

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/document-widget-system.test.ts`
Expected: PASS.

### Task 6: Add a changelog note for the behavior change

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a concise entry**

Document that document widgets now use a unified sandbox runtime so local interactive widgets work consistently in edit and preview modes.

- [ ] **Step 2: Sanity-check docs**

Run: `rg -n "统一 sandbox|统一.*widget|show-widget" CHANGELOG.md`
Expected: The new note is present.

## Chunk 4: Verification

### Task 7: Run focused regression tests

**Files:**
- Test: `src/__tests__/document-widget-system.test.ts`
- Test: `src/__tests__/document-widget-authoring.test.ts`

- [ ] **Step 1: Run focused widget tests**

Run: `npm test -- src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-authoring.test.ts`
Expected: PASS.

### Task 8: Run typecheck for touched areas

**Files:**
- Verify touched renderer and main-process files compile

- [ ] **Step 1: Run project typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Review git diff**

Run: `git diff -- src/renderer/components/document/WidgetRenderer.tsx src/renderer/components/document/widget-sanitizer.ts src/renderer/components/document/DocumentWidgetBlockCard.tsx src/renderer/components/document/TiptapEditor.tsx src/main/modules/claude-bridge/direct-chat.ts src/main/modules/tools/document-tools.ts src/__tests__/document-widget-system.test.ts CHANGELOG.md`
Expected: Only intended unified widget runtime changes appear.
