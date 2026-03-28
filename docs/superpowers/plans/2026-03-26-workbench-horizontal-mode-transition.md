# Workbench Horizontal Mode Transition Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给四模块主工作区加上明显的左右切页过场，同时保留四个模块常驻挂载和现有浏览器显隐稳定性。

**Architecture:** 在 `WorkbenchModeOutlet` 这一层维护“当前模式 + 离场模式 + 切换方向 + 位移状态”，让进入页和离开页做水平滑动，其余模式继续常驻但隐藏。相关文档和契约测试同步更新，避免回退到过去的硬切实现。

**Tech Stack:** React 19、TypeScript 5、Framer Motion、node:test

---

## Chunk 1: Contract Test

### Task 1: 锁定“常驻挂载 + 左右切页”契约

**Files:**
- Modify: `src/__tests__/workbench-keep-alive-contract.test.ts`

- [ ] **Step 1: Write the failing test**

增加断言，要求 `WorkbenchModeOutlet`：
- 继续保留四个模式全部挂载
- 维护显式离场模式和切换方向
- 使用水平位移的动画容器，而不是 `hidden / flex` 的瞬时切换

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts`
Expected: FAIL，因为当前实现还是直接 CSS 显隐。

## Chunk 2: Shared Transition Shell

### Task 2: 在共享壳层实现左右切页

**Files:**
- Modify: `src/renderer/components/layout/WorkbenchModeOutlet.tsx`

- [ ] **Step 1: 建立切换状态**

增加离场模式、方向、位移状态和收尾逻辑。

- [ ] **Step 2: 让当前页和离场页并存**

切换时同时显示两个 wrapper，其余 wrapper 保持挂载但隐藏。

- [ ] **Step 3: 做水平滑动过场**

进入页从左右两侧进入，离场页向相反方向退出。

- [ ] **Step 4: 保持稳态**

动画结束后只保留当前页可操作，避免双层点击区残留。

## Chunk 3: Docs Sync

### Task 3: 更新工作区约定和进展说明

**Files:**
- Modify: `DOCUMENTATION.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 Keep-Alive 约定**
- [ ] **Step 2: 记录用户可感知的工作区切页变化**

## Chunk 4: Verification

### Task 4: 跑验证并人工回看

**Files:**
- Test: `src/__tests__/workbench-keep-alive-contract.test.ts`
- Test: `src/__tests__/browser-host-visibility-contract.test.ts`
- Test: `src/__tests__/workbench-shell-alignment-contract.test.ts`

- [ ] **Step 1: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/workbench-keep-alive-contract.test.ts src/__tests__/browser-host-visibility-contract.test.ts src/__tests__/workbench-shell-alignment-contract.test.ts`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Launch app and click through**

Run: `npm run dev`
Expected:
- 四模块切换出现明显左右切页
- 左右方向和顶部按钮顺序一致
- 连续快速切换不乱
- 文档/RSS/日历状态仍保留
- 浏览器切出后没有原生层残留在前台
