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
- Inkwell 外壳（侧栏、顶部标签栏、顶栏、主页、弹层）：`src/renderer/modules/document/ink/`；标签栏与就地导航见 `InkTabStrip.tsx`、`layout-state.ts`
- 页面视图与 Markdown 源码（源码开关在顶栏「…」菜单）：`src/renderer/components/document/`、`src/renderer/modules/document/page-ui/`
- 状态：`src/renderer/stores/useDocTabs.ts`
- Widget 主题与结构：`src/shared/document-widget-theme.ts`、`src/shared/document-widget-skeletons.ts`
- 书本阅读组件：`src/renderer/components/document/book/`；分页、翻页和偏好：`src/renderer/modules/document/book/`
- 阅读样式：`src/renderer/styles/document-book.css`、`src/renderer/styles/document-book-controls.css`；验证：`npm run verify:document-reading`

Widget 视觉不能在组件内另造色板；预览、导出和编辑必须从结构真值重编译。

### RSS

- 页面：`src/renderer/pages/modes/RSSMode.tsx`
- 组件：`src/renderer/components/rss/`；列表窗口与滚动容器：`RSSVirtualList.tsx`；行组件按内容等值 memo（`modules/rss/rssFeedItemEquality.ts`）
- 状态：`src/renderer/stores/useRSSSession.ts`
- 样式：`rss-workspace.css`（框架、导航、顶栏工具）、`rss-feed.css`（页头、时间轴资讯流、当前热点）、`rss-controls.css`（提示、按钮、自动整理浮层）、`rss-reader.css`（阅读）、`rss-digest.css`（日报版面与往期档案）、`rss-manage.css`（栏目管理、订阅设置抽屉、引用预览）

框架与 Document/Browser 同构：画布上方 `rss-topbar`（38px）与左侧 `RSSNavigation`（收起 52px，与两者的标签列同宽）在同一层材质上连成 L 形，资讯流、阅读、日报、栏目管理都放在四角圆角的 `rss-content-frame` 里。各视图通过 `RSSTopbarTools`（`slot="lead"` / `tools`）把位置与工具放进顶栏，只有可见视图才放。视觉沿用设置页的 sx 纪律：选中与悬停是被托起的白玻璃填充，不画描边和分隔线；未读只靠字重；主操作墨色，删除类平时安静、悬停转红；菜单统一用 `LiquidFloatingPanel` + `ready-floating-menu-item`。资讯流不得引入聊天依赖（引用、导出入口由 `RSSMode` 通过 `renderMoreActions` 注入）。真实窗口验收：`npm run verify:rss-layout` 与 `node scripts/run-rss-reader-acceptance.cjs`。

内容版面参考 AIHOT：资讯流按日分组成时间轴（左侧时刻 + 圆点竖线，未读点为强调色）。精选栏目每条带大预览图与“推荐理由”，列表顶部是“当前热点”（`modules/rss/hot-events.ts`：近 48 小时、至少两个来源的事件，按来源数、报道数、时间排序，只用已保存的事件归组）；其他栏目用标题右侧的缩略图。分类以 `#名称` 显示，精选不算标签而是“精选”标记。日报是报纸式版面：刊头、标题与期号、日期块和本月小日历、统计行、头条（本期报道依据最多的一条）、按栏目分节；“今日看点 / 本期版面”是导读，宽版在右栏，窄于 980px 移到正文前。左侧往期按月分组，日报/简报分架，打开时显示当前架最新一期。侧栏“新建简报”在正文区原位选择栏目、分类、来源、时间窗口与关键词（`RSSBriefComposer.tsx`），默认带入资讯流当前范围并实时显示篇数；“日报设置”里的“收录范围”说明日报按“精选”标准收录，并可直接打开栏目管理编辑该标准。

B 站、YouTube 资讯在阅读页标题下直接嵌入播放器（`rssVideoEmbed`，只用 CSP 允许的 `player.bilibili.com` 与 `youtube-nocookie.com`），资讯流封面上有播放标记。

阅读页“打开原文”在内容框右侧打开临时浏览器（`PreviewBrowser.tsx`，原生预览视图，与浏览器模块共享登录身份），左侧留出阅读页；工具栏可前进后退、刷新，“浏览器模式”带着当前页面转到浏览器模块。预览内容区登记为原生面（`data-ready-native-surface`），菜单等浮层压上来时统一隐藏、收起后重新放回；内容区底色不透明，原生页面收起时不会透出阅读页。

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

- 页面与分区路由：`src/renderer/pages/Settings.tsx`（导航按 通用 / 智能 / 内容与连接 / 隐私与数据 / 应用 分组）
- 设计系统：`src/renderer/styles/settings-surfaces.css`（`--sx-*` token 与 `sx-*` 组件类）
- 共用组件：`src/renderer/pages/settings/settings-shared.tsx`（SettingsCard / SettingsRow / SettingsSegmented / SettingsSwitch / SettingsNotice / SettingsStatus / `settingsButtonClass`）与 `src/renderer/components/settings/`
- inline 兼容 token：`src/renderer/components/settings/settings-theme.ts`（取值全部指向 `--sx-*`）
- Tag Forge：`src/renderer/pages/settings/TagForgeSettingsPanel.tsx`
- 长期记忆：`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx`（自动整理当前禁用）
- 微信/飞书：`src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- 状态：`src/renderer/stores/useSettings.ts`

设置页追求极简与安静：内容直接落在窗口玻璃底上，不额外铺整块画布；需要成组的设置项才放进分组玻璃卡（`sx-card`：半透明白 + 柔和投影，无外框，行间只留内缩发丝线）。选中、聚焦、悬停一律用「填充 + 轻投影」表达（选中 = 被托起的白玻璃，与导航选中同配方），不用线框圈选；输入是无边框的凹陷槽，按钮是带白色高光边的浮起玻璃片。按钮、输入、分段、开关只用 `sx-*` 类，hover / active / focus 由类统一，不再写 inline 颜色或零散 `hover:` 工具类。色彩纪律：关键行动与「开」状态用墨色（与发送键同源），每个视图最多一个主按钮；强调色只做点缀（当前导航图标、选中点、焦点环、状态圆点、文字链接）；设置页不用成功绿；危险操作是红字 + 极淡水洗，不铺红块。强调色只有一个 `--rn-accent`（橘红，W1 收束后不再有强调色与皮肤选项，外观页只有明暗与“减少透明”），行为合同见 `src/__tests__/settings-design-system.test.tsx`。新增持久设置必须同时核对 Main、Preload、Renderer 类型和 native DB 验证。

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
