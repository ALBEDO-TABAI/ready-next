---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Liquid Glass Prototype Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a convincing liquid-glass feel to the existing workbench skin without introducing a heavyweight third-party runtime or changing BrowserView behavior.

**Architecture:** Keep the current skin system and glass utility classes, but recover material separation between panel, card, and floating surfaces, then add layered specular highlights and a more expressive morph pill treatment. Limit structural changes to existing renderer components that already opt into `glass-surface-*` classes.

**Tech Stack:** React 19, TypeScript 5, Tailwind CSS v4, global CSS variables in `src/renderer/styles/index.css`

---

## Chunk 1: Scoped Visual Prototype

### Task 1: Recover liquid-glass material depth

**Files:**
- Modify: `src/renderer/styles/index.css`
- Verify: `npm run typecheck`

- [ ] **Step 1: Adjust liquid-glass tokens**

Rebalance the `html[data-skin='liquid-glass']` tokens so panel, card, toolbar, and floating surfaces are no longer flattened into one material.

- [ ] **Step 2: Preserve unified structure without flattening the glass**

Keep the subtle divider cleanup from the optimization pass, but stop overriding every `glass-surface-*` background to `--panel-unified-bg`.

- [ ] **Step 3: Strengthen surface layering**

Add sharper border light, richer shadows, and glass-only pseudo-element highlights to `glass-surface-panel`, `glass-surface-card`, and `glass-surface-floating`.

- [ ] **Step 4: Verify stylesheet remains valid**

Run: `npm run typecheck`
Expected: PASS

### Task 2: Improve the liquid active-pill feel

**Files:**
- Modify: `src/renderer/styles/index.css`
- Verify: `npm run typecheck`

- [ ] **Step 1: Restyle morph pills**

Update `.morph-pill-primary` and `.morph-pill-secondary` so the active indicator reads like a denser liquid lens instead of a flat blue fill.

- [ ] **Step 2: Add liquid-only track polish**

Enhance `.morph-segmented-track` under `data-skin='liquid-glass'` so the control feels like it sits inside the same material system as the surrounding glass.

- [ ] **Step 3: Verify no compile regressions**

Run: `npm run typecheck`
Expected: PASS

### Task 3: Prototype review

**Files:**
- Review: `src/renderer/styles/index.css`

- [ ] **Step 1: Inspect the diff**

Check that the prototype remains CSS-only and does not alter BrowserView rules or cross-process boundaries.

- [ ] **Step 2: Summarize intended visual wins**

Confirm the prototype improves:
- top/tool bars
- floating menus
- segmented active states

