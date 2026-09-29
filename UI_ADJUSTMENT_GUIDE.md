# UI 调整导览

> 核对日期：2026-09-29
> 目标：先定位状态拥有者、壳层和回归入口，再修改 UI。详细视觉原则见 `PRODUCT.md` 与当前运行时合同，不在本文件复制历史设计稿。

## 1. 工作台壳层

| 区域 | 入口 |
| --- | --- |
| 路由与 fallback | `src/renderer/App.tsx` |
| Workbench 总壳 | `src/renderer/pages/WorkbenchMode.tsx` |
| 左侧轨道 | `src/renderer/components/layout/IconRail.tsx` |
| 顶部模式标签 | `src/renderer/components/layout/DraggableModeTabs.tsx` |
| 模式切换与分屏 | `src/renderer/modules/workbench/` |
| 共享 chrome 尺寸 | `src/renderer/modules/workbench/chrome.ts` |
| 滑块动效 | `src/renderer/components/motion/MorphIconRailGroup.tsx`、`src/renderer/styles/workbench-sliders.css` |

不要在各模式页面复制工作台尺寸、切换状态或滑块时间线。

## 2. 左侧面板与文件

| 目标 | 入口 |
| --- | --- |
| 面板切换/动画壳 | `src/renderer/components/layout/SidePanel.tsx` |
| 文件面板标题与主体 | `src/renderer/components/layout/FilesPanel.tsx` |
| 文件树编排 | `src/renderer/components/layout/FileTree.tsx` |
| 文件树子行为 | `src/renderer/components/layout/file-tree/` |
| 文件夹缩略图 | `FolderPreview.tsx`、`folderPreviewModel.ts` |
| 全局搜索 | `GlobalSearchPanel.tsx` |
| 技能中心 | `SkillsCenterPanel.tsx` |
| 文件涌现 | `FileEmergenceSection.tsx`、`fileEmergenceViewModel.ts` |

瞬时菜单不要挂在带 `overflow-hidden` 的侧栏布局内；使用顶层弹层并由拥有菜单的组件计算位置。文件选择、拖放、移动和删除优先查 `file-tree/`，不要继续把所有逻辑塞回 `FileTree.tsx`。

## 3. 四个工作面

### Browser

- 页面：`src/renderer/pages/modes/BrowserMode.tsx`
- 顶栏：`src/renderer/components/browser/BrowserTopBar.tsx`
- 竖向标签：`src/renderer/components/browser/VerticalTabRail.tsx`
- 分组共用件：`src/renderer/components/tabs/TabGroupHeaderRow.tsx`、`TabGroupEditMenu.tsx`
- BrowserView bounds：`src/renderer/modules/browser/useBrowserViewBounds.ts`
- 状态：`src/renderer/stores/useBrowserTabs.ts`

BrowserView 是原生覆盖层。弹层、hover flyout 和模式切换问题先核对 hide/show 与 bounds，不要只调 `z-index`。

### Document

- 页面：`src/renderer/pages/modes/DocumentMode.tsx`
- 竖向标签：`src/renderer/components/document/DocumentVerticalTabRail.tsx`
- 编辑/预览：`src/renderer/components/document/`
- 状态：`src/renderer/stores/useDocTabs.ts`
- Widget 主题与结构：`src/shared/document-widget-theme.ts`、`src/shared/document-widget-skeletons.ts`
- 书本阅读组件：`src/renderer/components/document/book/`；分页、翻页和偏好：`src/renderer/modules/document/book/`
- 阅读样式：`src/renderer/styles/document-book.css`、`src/renderer/styles/document-book-controls.css`；验证：`npm run verify:document-reading`

Widget 视觉不能在组件内另造色板；预览、导出和编辑必须从结构真值重编译。

### RSS

- 页面：`src/renderer/pages/modes/RSSMode.tsx`
- 组件：`src/renderer/components/rss/`；列表窗口与滚动容器：`RSSVirtualList.tsx`
- 状态：`src/renderer/stores/useRSSSession.ts`

### Calendar

- 页面：`src/renderer/pages/modes/CalendarMode.tsx`
- 左栏/工作台：`src/renderer/components/calendar/CalendarWorkbenchShell.tsx`
- 状态：`src/renderer/stores/useCalendarSession.ts`

日历格线、事件内容和左栏宽度分开验证，避免内容反向撑开网格。

## 4. Agent 聊天

| 区域 | 入口 |
| --- | --- |
| 总面板 | `src/renderer/components/agent/ChatPanel.tsx` |
| 主体布局 | `src/renderer/components/agent/chat-panel/ChatPanelBody.tsx` |
| 项目目录胶囊 | `src/renderer/components/agent/ProjectSelector.tsx`；宿主为 `ChatPanelBody.tsx`，共享 `liquid-composer.css` |
| 聊天菜单边界 | `src/renderer/components/agent/chatMenuLayout.ts`、`src/renderer/components/agent/ChatHeader.tsx` |
| 消息列表 | `src/renderer/components/agent/ChatMessages.tsx` |
| 任务卡 | `src/renderer/components/agent/chat-panel/task/TaskCard.tsx` |
| 工具时间线 | `src/renderer/components/agent/chat-panel/task/ToolTimeline.tsx` |
| 工具快照 | `src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx` |
| 状态 | `src/renderer/stores/useAgent.ts` |
| 草稿与编辑/发送边界 | `src/renderer/modules/agent/composer-state.ts`、`src/renderer/components/agent/ChatInput.tsx` |
| 上下文用量 | `src/renderer/components/agent/chat-panel/ContextUsageMeter.tsx` |

任务卡和工具时间线只呈现 projection/runtime 真值，不在组件里推断完成或后台运行。输入框是底部浮层，消息列表尾部必须按实测高度留白；液态玻璃以真实 Electron 聊天记录验收。

项目目录按聊天 scope 保存，显式文件夹引用优先；项目和模式胶囊共享一行，长名称渐隐，异步选择结果必须绑定原聊天。不要把项目目录选择当作内部运行目录切换。

历史上下文阻断只限制发送，不锁草稿编辑。重试、停止和开始新上下文都消费 Main 当前动作；只有重置/关闭这类所有权变更短暂锁编辑。当前产品不显示 Agent 选择器或旧子任务继续按钮。

## 5. Settings

- 页面与分区路由：`src/renderer/pages/Settings.tsx`
- 共用组件：`src/renderer/components/settings/`
- 共用 token：`src/renderer/components/settings/settings-theme.ts`
- Tag Forge：`src/renderer/pages/settings/TagForgeSettingsPanel.tsx`
- 长期记忆：`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx`（自动整理当前禁用）
- 微信/飞书：`src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- 状态：`src/renderer/stores/useSettings.ts`

设置页左侧不堆大卡片底板；输入、按钮、只读槽优先复用共用 token。新增持久设置必须同时核对 Main、Preload、Renderer 类型和 native DB 验证。

## 6. 样式与验证

共享样式位于 `src/renderer/styles/`。修改前先找现有 layer/token；禁止在层外新增通用 `* { margin/padding }` reset。

常用 UI 合同：

```bash
npm run test:ui-contracts
npm run verify:tab-groups
npm run verify:widget-ready
node scripts/check-css-cascade-layer-reset.cjs
npx tsx --test src/__tests__/ui-adjustment-guide-contract.test.ts
```

焦点文件以当前 `package.json` 和 `src/__tests__/` 为准，不从旧计划复制测试路径。

## 7. 修改前后检查

1. 先确认状态拥有者和生产调用方。
2. 查相邻模式是否复用同一 token/组件。
3. 只改目标区域，不顺手重排整个组件。
4. 跑焦点行为测试与对应 gate。
5. BrowserView、窗口材质、液态玻璃、拖放或复杂弹层在真实 Electron 中复核。
6. 若代码文件净增且总行数超过 1000，更新大文件健康台账。
