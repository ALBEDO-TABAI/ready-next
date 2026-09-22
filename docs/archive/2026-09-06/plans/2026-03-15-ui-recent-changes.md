---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../documentation-inventory.md)。

# 2026-03-15 UI Recent Changes

## 概览
最近一轮 UI 调整主要围绕工作台整体观感统一、文档模式顶部结构优化，以及浏览器/标签体系的视觉收敛。

## 已完成改动

### 1. 工作台整体视觉统一
- 去掉了工作台中大部分重分隔线与明显的壳层阴影。
- 主内容区从偏白底统一改成浅米色底，增强各模块之间的连续感。
- 日历主表格区域也同步换成浅米色，不再与其他模块割裂。

### 2. 文档模式头部与标签
- 文档模式顶部路径信息从右上角挤压态改成独立信息带。
- 标签支持更强的自适应压缩，多标签时不会直接被加号吞掉。
- 激活标签颜色从更亮的白底收敛到与地址信息带一致的浅米色。
- 文档模式中标签与内容区之间的小分隔线已去除。
- 编辑器空段落不再显示中间占位文案，回车后的段落观感更自然。
- 文档右键引用改成更接近 IDE 的引用 chip，不再向输入框里硬塞大段文本，也不会把旧引用长期留在当前输入上下文里。
- 文档引用 chip 新增 hover 摘要与点击回跳原文位置的交互。
- 聊天框中的文档引用 chip 改成“标题 + 小元数据块”的形式，直接展示章节/行号。
- 删除 skill 或其他附件后，不会再继续残留在 `@` 引用候选中。

### 3. 顶部模式切换与多选状态
- 顶部模式图标在双激活/分屏状态下，不再出现“括号感”或残留包边。
- 主选与次选统一为连贯的浅蓝色覆盖态。
- 文档模式的 `编辑 / 预览` 切换器从白色浮卡改成更收敛的米色底 + 浅蓝激活态。

### 4. 浏览器模块视觉收敛
- 浏览器标签条、激活标签、地址工具栏底色统一到与文档地址带接近的层级。
- 浏览器空状态下的顶部条也同步了新的颜色体系。

## 影响范围
- `src/renderer/styles/index.css`
- `src/renderer/components/workbench/WorkbenchProjectTabs.tsx`
- `src/renderer/components/browser/BrowserTabBar.tsx`
- `src/renderer/components/browser/BrowserAddressBar.tsx`
- `src/renderer/pages/modes/DocumentMode.tsx`
- `src/renderer/pages/modes/BrowserMode.tsx`
- `src/renderer/pages/modes/CalendarMode.tsx`

## 后续可继续打磨的点
- RSS 列表内部项之间的层次是否继续弱化。
- 预览工具条内部的小分隔线是否全部收掉。
- 浅米色体系在深色主题下是否需要独立微调一版。
- 文档模式中的引用 chip 是否需要进一步做成更接近 IDE 的内联 token 样式。
