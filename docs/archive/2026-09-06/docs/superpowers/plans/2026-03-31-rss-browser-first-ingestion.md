---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# RSS Browser-First Ingestion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让微博、抖音、小红书统一走应用内浏览器更新链路，并在失败时直接引导用户去浏览器处理登录或验证。

**Architecture:** 保留现有 RSS 浏览器抓取基础，但把这三类平台从 RSSHub 依赖语义中彻底剥离，同时补一条“RSS 可直接唤起浏览器目标页”的跨进程能力。前端只消费归一化后的简单结果，不再自己拼接技术化失败提示。

**Tech Stack:** Electron 34、React 19、TypeScript 5、node:test

---

## Chunk 1: Contract Coverage

### Task 1: 先锁定浏览器主链与引导动作

**Files:**
- Modify: `src/__tests__/rss-diagnostics.test.ts`
- Modify: `src/__tests__/rss-browser-acquisition.test.ts`
- Test: `src/__tests__/rss-browser-browser-handoff.test.ts`

- [ ] **Step 1: Write the failing tests**

补充断言，要求：
- 微博、抖音、小红书不再被 `needsRSSHub()` 视为 RSSHub 必需平台
- 能力矩阵不再展示这三类平台的 RSSHub 回退
- RSS 可拿到“去浏览器处理”的结构化引导信息
- 浏览器可为 RSS 复用或打开目标主页

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/rss-diagnostics.test.ts src/__tests__/rss-browser-acquisition.test.ts src/__tests__/rss-browser-browser-handoff.test.ts`
Expected: FAIL，因为当前代码还没有这些新约束。

## Chunk 2: Main Process Routing

### Task 2: 收紧 RSSHub 依赖并统一浏览器主链

**Files:**
- Modify: `src/main/modules/rss-engine/scrapers/index.ts`
- Modify: `src/main/modules/rss-engine/source-diagnostics.ts`
- Modify: `src/main/modules/rss-engine/ipc-handler.ts`

- [ ] **Step 1: 收紧 RSSHub 依赖判断**
- [ ] **Step 2: 去掉微博、抖音、小红书的 RSSHub 预热与回退**
- [ ] **Step 3: 在刷新结果里返回浏览器引导动作和更清楚的失败原因**

## Chunk 3: Browser Handoff Bridge

### Task 3: 新增 RSS 可用的浏览器目标页唤起能力

**Files:**
- Modify: `src/main/modules/browser-engine/ipc-handler.ts`
- Modify: `src/main/modules/browser-engine/capture-url-utils.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: 增加主进程“打开或复用抓取目标页”能力**
- [ ] **Step 2: 暴露 preload API 和 renderer 类型声明**
- [ ] **Step 3: 让复用规则覆盖微博、抖音、小红书主页场景**

## Chunk 4: Renderer UX

### Task 4: 收口提示文案与浏览器引导入口

**Files:**
- Modify: `src/renderer/components/rss/AddSourceModal.tsx`
- Modify: `src/renderer/pages/modes/RSSMode.tsx`
- Modify: `src/renderer/components/rss/RSSSourceCapabilityMatrix.tsx`

- [ ] **Step 1: 把“需要 RSSHub”提示改成浏览器登录态提示**
- [ ] **Step 2: 在 RSS 刷新失败时显示“去浏览器处理”入口**
- [ ] **Step 3: 调整能力矩阵文案与失败说明**

## Chunk 5: Docs And Verification

### Task 5: 同步文档并完成回归验证

**Files:**
- Modify: `DOCUMENTATION.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 RSS 与浏览器主链约定**
- [ ] **Step 2: Run focused tests**

Run: `npx tsx@^4.19.2 --test src/__tests__/rss-diagnostics.test.ts src/__tests__/rss-browser-acquisition.test.ts src/__tests__/rss-scrapers.test.ts src/__tests__/rss-browser-browser-handoff.test.ts`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Record known unrelated failures if broader RSS suite still contains pre-existing UI contract issues**
