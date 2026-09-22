---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Document Generative UI Capability Expansion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand document generative UI beyond basic runtime stability by adding intent/style normalization, a stable weekly-focus chart baseline, and widget export snapshot helpers.

**Architecture:** Keep the existing widget runtime intact and add a thin guidance layer for agent-facing chart decisions plus a separate export helper layer that prepares widget content for future PDF and overnight automation flows. Prefer pure helpers with source-level or unit tests so we can evolve prompt behavior without destabilizing the renderer.

**Tech Stack:** TypeScript 5, Electron renderer/main, node:test via `tsx`, Markdown docs

---

### Task 1: Add a widget intent/style normalization layer

**Files:**
- Create: `src/main/modules/claude-bridge/widget-guidance.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Test: `src/__tests__/document-widget-guidance.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that natural-language requests like “本周下周对比图，周报风格” normalize into a stable widget family/style recommendation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-guidance.test.ts`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement a pure helper that infers:
- widget family
- preferred interaction pattern
- style vocabulary
- title hint
- short generation guidance bullets

- [ ] **Step 4: Wire guidance into direct chat**

Append normalized guidance into document widget prompt guidance only when the user intent matches widget generation/update flows.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-guidance.test.ts`
Expected: PASS.

### Task 2: Add a stable weekly focus chart baseline

**Files:**
- Modify: `docs/DOCUMENT_WIDGET_BASELINES.md`
- Modify: `src/main/modules/claude-bridge/widget-guidance.ts`
- Test: `src/__tests__/document-widget-guidance.test.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that `weekly_focus_chart` is a first-class baseline with a stable title hint and a fixed interaction pattern (`本周 / 下周` toggle).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-guidance.test.ts`
Expected: FAIL because the baseline and guidance are not explicit yet.

- [ ] **Step 3: Write minimal implementation**

Document and expose a dedicated weekly-focus chart baseline:
- stable title hint: `weekly_focus_chart`
- preferred implementation: `HTML + CSS + minimal inline script`
- stable interaction: two-state toggle
- bounded layout guidance to avoid runaway height

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-guidance.test.ts`
Expected: PASS.

### Task 3: Add widget export snapshot helpers

**Files:**
- Create: `src/renderer/components/document/widget-export-snapshot.ts`
- Test: `src/__tests__/document-widget-export-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that:
- SVG widgets export as SVG snapshots
- scripted HTML widgets export as safe static HTML snapshots
- snapshot helpers strip unsafe content while preserving visible structure

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-export-snapshot.test.ts`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create a pure helper that returns snapshot metadata for future PDF/export flows without yet wiring a full export pipeline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-export-snapshot.test.ts`
Expected: PASS.

### Task 4: Verify and commit

**Files:**
- Test: `src/__tests__/document-widget-system.test.ts`
- Test: `src/__tests__/document-widget-authoring.test.ts`
- Test: `src/__tests__/note-preview-parser.test.ts`
- Test: `src/__tests__/document-widget-guidance.test.ts`
- Test: `src/__tests__/document-widget-export-snapshot.test.ts`

- [ ] **Step 1: Run focused regression tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/document-widget-system.test.ts src/__tests__/document-widget-authoring.test.ts src/__tests__/note-preview-parser.test.ts src/__tests__/document-widget-guidance.test.ts src/__tests__/document-widget-export-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/DOCUMENT_WIDGET_BASELINES.md \
  docs/archive/2026-09-06/docs/superpowers/plans/2026-03-17-document-generative-ui-capability-expansion.md \
  src/main/modules/claude-bridge/widget-guidance.ts \
  src/main/modules/claude-bridge/direct-chat.ts \
  src/renderer/components/document/widget-export-snapshot.ts \
  src/__tests__/document-widget-guidance.test.ts \
  src/__tests__/document-widget-export-snapshot.test.ts
git commit -m "feat(document): expand generative ui guidance and export helpers"
```
