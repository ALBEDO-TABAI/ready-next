---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Workbench Transition Smoothness Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让四模块切换更利落，优先消除浏览器切回时的慢半拍和顶部模式滑块的拖泥带水。

**Architecture:** 保留现有 keep-alive 与 BrowserView 安全边界，但把浏览器运行态改成“一次准备，多次复用”，并允许浏览器在进入过场时提前露出。工作台切换继续用现有壳层承接，但把浏览器相关时机和顶部滑块点击动画拆开，减少不必要的等待。

**Tech Stack:** React 19、TypeScript 5、Framer Motion、node:test

---

## Chunk 1: Contract Coverage

### Task 1: 锁定浏览器提前露出和运行态复用

**Files:**
- Modify: `src/__tests__/workbench-keep-alive-contract.test.ts`
- Modify: `src/__tests__/browser-startup-theme-contract.test.ts`
- Modify: `src/__tests__/workbench-slider-motion-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

补充断言，要求：
- Browser 模块支持提前露出原生网页
- Browser 运行态支持一次初始化后复用，不再每次切回都重置
- 顶部模式滑块点击时使用短促直达动画，拖动释放时才保留弹簧回弹

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/browser-startup-theme-contract.test.ts src/__tests__/workbench-slider-motion-contract.test.ts`
Expected: FAIL，因为当前代码还没有这些新约束。

## Chunk 2: Workbench And Browser Runtime

### Task 2: 浏览器提前露出并复用已准备好的运行态

**Files:**
- Modify: `src/renderer/pages/WorkbenchMode.tsx`
- Modify: `src/renderer/components/layout/WorkbenchModeOutlet.tsx`
- Modify: `src/renderer/pages/modes/BrowserMode.tsx`
- Modify: `src/renderer/modules/browser/useBrowserRuntimeEffects.ts`

- [ ] **Step 1: 增加浏览器提前露出判定**
- [ ] **Step 2: 让 BrowserMode 接收提前露出信号**
- [ ] **Step 3: 把浏览器运行态改成“首次准备，后续复用”**
- [ ] **Step 4: 对已有标签做后台预热，但不在后台强行新建空白页**

## Chunk 3: Slider Motion

### Task 3: 顶部模式滑块点击直达、拖动回弹

**Files:**
- Modify: `src/renderer/components/layout/DraggableModeTabs.tsx`
- Modify: `src/renderer/modules/workbench/slider-motion.ts`

- [ ] **Step 1: 增加点击切换专用时长与缓动**
- [ ] **Step 2: 点击切换走短促直达动画**
- [ ] **Step 3: 拖动释放继续走弹簧动画**

## Chunk 4: Docs And Verification

### Task 4: 同步文档并做回归验证

**Files:**
- Modify: `DOCUMENTATION.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 记录工作台切换与 BrowserView 显隐时机的新约定**
- [ ] **Step 2: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/browser-startup-theme-contract.test.ts src/__tests__/workbench-slider-motion-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/browser-resize-stability-contract.test.ts`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run dev build smoke check**

Run: `npm run dev`
Expected:
- renderer 和 electron 都能启动
- 不出现新的编译错误
