# Side Panel Waterfall Transition Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把左侧三个面板从硬切换改成固定视窗里的上卷切换，同时给左边轨道滑块增加下陷记忆态与先浮起再滑动的行为。

**Architecture:** 在共享的 `SidePanel` 壳层里保留固定外框，把标题行和内容层都放进裁剪视窗。切换方向由左侧按钮的上下顺序决定，标题和内容分开跑但始终同向。左边轨道滑块则额外维护“浮起 / 下陷”的深度状态，并在从收起态切换按钮时先浮起再滑动。

**Tech Stack:** React 19、TypeScript、Framer Motion、node:test

---

## Chunk 1: Motion Contract

### Task 1: 锁定切换契约

**Files:**
- Modify: `src/__tests__/rss-agent-workbench-regressions.test.ts`
- Test: `src/__tests__/rss-agent-workbench-regressions.test.ts`

- [ ] **Step 1: Write the failing test**

增加契约断言，要求 `SidePanel` 使用固定视窗 + 内层纵向流动，而不是整块条件切换或整层淡入淡出。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/rss-agent-workbench-regressions.test.ts`
Expected: FAIL，指出 `SidePanel` 仍然是直接条件渲染

- [ ] **Step 3: Write minimal implementation**

在 `SidePanel` 中引入固定视窗遮挡式切换编排，并把标题/内容拆出到各自 panel 组件。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/rss-agent-workbench-regressions.test.ts`
Expected: PASS

## Chunk 2: Shared Transition Shell

### Task 2: 建立共享切换壳层

**Files:**
- Modify: `src/renderer/components/layout/SidePanel.tsx`

- [ ] **Step 1: 建立切换状态**

增加“当前显示”和“正在进入”的控制，处理快速切换收敛到最后目标。

- [ ] **Step 2: 渲染标题交接层**

让标题脱离具体 panel，在壳层里按固定视窗内上卷的方式交接。

- [ ] **Step 3: 渲染内容交接层**

同时保留旧内容和新内容，只移动内层内容本身，让它们像在窗口里上卷通过，并且根据上下层级决定往上还是往下。

- [ ] **Step 4: 控制节奏与遮挡感**

把时长放慢，减少透明度参与，确保肉眼感受更接近“文档在窗口里滚动”。

- [ ] **Step 5: 保持宽度与显隐逻辑**

确保现有侧栏宽度和折叠逻辑不变。

## Chunk 3: Panel Decomposition

### Task 3: 拆出三个面板的标题与主体

**Files:**
- Modify: `src/renderer/components/layout/FilesPanel.tsx`
- Modify: `src/renderer/components/layout/GlobalSearchPanel.tsx`
- Modify: `src/renderer/components/layout/SkillsCenterPanel.tsx`

- [ ] **Step 1: FilesPanel 拆出主体**
- [ ] **Step 2: GlobalSearchPanel 拆出主体**
- [ ] **Step 3: SkillsCenterPanel 拆出主体**
- [ ] **Step 4: 确认主体布局在共享壳层下仍然贴合原视觉**

## Chunk 4: Verification

### Task 4: 跑验证并人工回看

**Files:**
- Modify: `src/__tests__/rss-agent-workbench-regressions.test.ts` (if needed)

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- src/__tests__/rss-agent-workbench-regressions.test.ts`

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Launch app and click through**

Run: `npm run dev`
Expected:
- `文件管理 -> 全局搜索 -> 技能中心` 切换平顺
- 标题和内容都像在固定窗口里上卷
- 连续快速点不会错位
- 文件管理切回时内部状态仍在
- 面板收起后，左边滑块会在原位下陷
- 从收起态点别的按钮时，滑块先浮起再滑动

- [ ] **Step 4: Update any user-facing note if needed**

若验证中出现与现有文档约定相关的变化，再补充记录。
