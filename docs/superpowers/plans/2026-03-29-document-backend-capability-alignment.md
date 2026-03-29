# Document Backend Capability Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the reference version's document backend and generated-UI behavior improvements into the current project without changing the current document UI shell.

**Architecture:** Keep the existing renderer surfaces and interactions intact, and only patch behavior-layer files that decide document tool routing, context composition, and host-side completion tracking. Use targeted regression tests first so each imported behavior is proven by red-green verification instead of broad file replacement.

**Tech Stack:** TypeScript, Electron main-process tool orchestration, React/Zustand renderer context builders, Node test runner via `tsx --test`

---

## Chunk 1: Document Tool Completion Tracking

### Task 1: Persist host-side document progress across tool iterations

**Files:**
- Modify: `src/main/modules/claude-bridge/document-tool-flow.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Test: `src/__tests__/document-tool-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Add a regression test proving host-side completion only fires after a mutation and a save have both happened, even if they happen in separate iterations.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-tool-flow.test.ts`
Expected: FAIL because progress is not accumulated across iterations yet.

- [ ] **Step 3: Write minimal implementation**

Add a small progress accumulator in `document-tool-flow.ts`, then wire `direct-chat.ts` to accumulate document mutation/save counts and tool results before evaluating completion.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-tool-flow.test.ts`
Expected: PASS

## Chunk 2: Generated-UI Tool Routing

### Task 2: Improve generated-UI request detection for document flows

**Files:**
- Modify: `src/main/modules/claude-bridge/tool-policy-heuristics.ts`
- Test: `src/__tests__/document-tool-heuristics.test.ts`

- [ ] **Step 1: Write the failing test**

Add a regression test covering file-referenced information-card requests so they are treated as generated-UI creation in document flows.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-tool-heuristics.test.ts`
Expected: FAIL because the current heuristic misses this request shape.

- [ ] **Step 3: Write minimal implementation**

Expand the actionable and generated-UI keywords just enough to recognize information-card style requests and route them to the document tool path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-tool-heuristics.test.ts`
Expected: PASS

## Chunk 3: Active Document Context Preference

### Task 3: Prefer the current document body over generic environment text in document mode

**Files:**
- Modify: `src/renderer/modules/agent/messageComposer.ts`
- Test: `src/__tests__/document-widget-target-context.test.ts`

- [ ] **Step 1: Write the failing test**

Add a regression test proving that when the user is in document mode with an active document, the composed agent input includes the active document body and does not fall back to generic environment text first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-target-context.test.ts`
Expected: FAIL because environment text currently wins over active document content.

- [ ] **Step 3: Write minimal implementation**

Change the context composition order so active document context is preferred when available.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-target-context.test.ts`
Expected: PASS

## Chunk 4: Verification And Documentation

### Task 4: Verify the imported behavior as a stable bundle

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run targeted regression suite**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-tool-flow.test.ts src/__tests__/document-tool-heuristics.test.ts src/__tests__/document-widget-target-context.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader type and project verification relevant to touched code**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Update project changelog**

Record that document backend behavior and generated-UI routing were aligned to the reference version while preserving the current UI shell.
