---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Workbench Horizontal Mode Transition Design

**Date:** 2026-03-26

## Goal

把工作区四模块切换从“瞬时硬切”改成更明显的左右切页，让点击顶部模块按钮时，主工作区看起来像在同一个视窗里左右翻页。

目标效果：

- 点击右侧模块时，当前工作区向左滑出，新工作区从右侧滑入
- 点击左侧模块时，方向完全镜像
- 只让主工作区参与切页，不带动左侧文件区、顶栏、右侧聊天区一起移动
- 过场存在感要明显，但不能拖慢切换节奏
- 四个模块仍然保持常驻，不因为动画而丢失原有状态

## Current Structure

- 四模块切换状态由 `src/renderer/stores/useMode.ts` 提供
- 顶部切换入口在 `src/renderer/components/layout/TopBar.tsx`
- 主工作区渲染壳层在 `src/renderer/components/layout/WorkbenchModeOutlet.tsx`
- 实际模块分别是：
  - `src/renderer/pages/modes/BrowserMode.tsx`
  - `src/renderer/pages/modes/DocumentMode.tsx`
  - `src/renderer/pages/modes/RSSMode.tsx`
  - `src/renderer/pages/modes/CalendarMode.tsx`
- 当前约定是四个主模式常驻挂载，切换只靠 CSS 显隐，不做整区切场动画

这套结构的优点是稳，但用户感知到的是“立即切换”，缺少工作区层面的页面感。

## Chosen Approach

采用“保留常驻挂载 + 在共享壳层编排左右切页”的方式：

1. 继续让四个主模式全部挂在 `WorkbenchModeOutlet` 内，不回退到切换时重新挂载
2. 在壳层记录：
   - 上一个可见模式
   - 本次切换方向
   - 正在滑出的模式
3. 切换时只让两个面板参与过场：
   - 当前目标面板从左或右进入
   - 上一个面板向相反方向滑出
4. 动画结束后回到稳态，只保留当前模式可交互，其他模式继续常驻但隐藏

## Why This Approach

- 最接近用户要的“整块工作区左右翻页”感觉
- 不需要拆四个模块内部结构
- 还能保留现有 keep-alive 收益，例如文档编辑状态、RSS 列表状态、日程视图状态
- 风险集中在共享壳层里，出问题时不需要分别回滚四个模块

## Interaction Rules

### Direction

- 模块顺序固定为 `browser -> document -> rss -> calendar`
- 从序列里往右切时：
  - 旧页向左移出
  - 新页从右侧进入
- 从序列里往左切时：
  - 旧页向右移出
  - 新页从左侧进入

### Motion tone

- 这是“明显切页”，不是轻微滑移
- 主感受来自水平位移，不依赖淡入淡出
- 透明度最多只做极轻微辅助，避免变成普通淡场
- 尊重系统减弱动效偏好，必要时退化成几乎瞬时的轻量切换

### Fast switching

- 连续快速点击时，以最后一次目标为准
- 新一轮切换开始时，上一次还没完全滑出的旧页可以直接收口，不允许残留空白、双重激活或错误方向

## Browser Constraint

`browser` 模块包含原生 `BrowserView`，它不是普通 DOM 内容，不能跟随 DOM 容器一起被真正平移。

因此本次方案的边界是：

- 工作区壳层做左右切页视觉过场
- 浏览器原生层继续遵守现有 `hideAll() / showActive()` 约定
- 不尝试让原生网页内容像 DOM 那样跟着滑动

这意味着 `browser` 模块在切出或切入时，真正参与横向滑动的主要是工作区壳层与浏览器 chrome；原生网页内容仍按既有时机隐藏或恢复。这是为了优先保稳定性。

## Component Boundaries

- `src/renderer/components/layout/WorkbenchModeOutlet.tsx`
  - 新增切换方向、离场模式、位移状态管理
  - 把现有“直接 hidden / flex”切换改成“显示层 + 滑动层”编排
- `src/__tests__/workbench-keep-alive-contract.test.ts`
  - 更新契约，锁定“常驻挂载 + 左右切页”新规则
- `DOCUMENTATION.md`
  - 更新工作区 keep-alive 约定
- `PROGRESS.md`
  - 记录工作区切换体验升级
- `CHANGELOG.md`
  - 补用户可感知的变化说明

## Risks And Mitigations

- 风险：快速切换时方向错乱或残留双层
  - 处理：显式记录离场模式与方向，并在新切换开始时清理上一轮收尾定时器
- 风险：改回带动画后破坏常驻挂载
  - 处理：所有模式 wrapper 都持续存在，只改显示和位移，不改组件挂载关系
- 风险：浏览器模式动画时原生层表现不一致
  - 处理：不碰 BrowserView 现有显示协议，只在共享壳层增加 DOM 过场

## Validation Plan

- 先补契约测试，锁住：
  - 四模式仍然全部常驻
  - 壳层显式维护离场模式和方向
  - 切换采用左右位移，不退回硬切
- 运行相关测试与类型检查
- 启动应用实际点击：
  - `browser -> document -> rss -> calendar`
  - `calendar -> rss -> document -> browser`
  - 快速连续切换不同模块
- 重点确认：
  - 工作区确实有明显左右切页感
  - 文档/RSS/日历切出切入时内容状态不丢
  - 浏览器切出后原生层不会残留在前台
  - 快速切换不闪白、不重影、不卡住
