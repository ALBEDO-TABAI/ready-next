# UI 调整导览

> 核对日期：2026-11-13
> 目标：先定位状态拥有者、壳层和回归入口，再修改 UI。

## 0. 设计语言

全应用只有一套设计语言，权威是 [V1–V32 设计语言合同](docs/superpowers/plans/2026-11-13-ready-next-vvf-design-language-implementation.md) 和 [W1 设计系统计划](docs/superpowers/plans/2026-11-11-ready-next-w1-design-system-implementation.md) 仍有效的部分（DL2、DL4、DL5、DL7、DL9、DL10 已被新合同取代；DL11a 的上留白用途以 V11、V15 为准）。应用内的基元展示页是 `#/design-system`（`src/renderer/pages/DesignSystem.tsx`）；`PRODUCT.md` 有一页摘要。

- 令牌：只用 `src/renderer/design/next/tokens.css` 的 `--rn-*`（颜色、圆角、阴影、字体、动效）。模块不定义自己的调色板；外壳旧别名层 `theme-tokens.css` 已删除。
- 材质：地面（窗口玻璃和很淡的 24px 点阵）、无色面板玻璃 `.rn-sheet`、浮层玻璃 `.rn-float`、嵌片 `.rn-inlay`、井 `.rn-well`（`design/next/materials.css`）。面板和嵌片不另加模糊，浮层保留模糊；液态玻璃只给助手输入框，圆角 18px（`styles/liquid-composer.css`、`components/ui/liquid-glass/`）。书页和书脊保留实物材质。
- 一个功能区一个整块（V11）：每个功能区是一块 `.rn-panel`，44px 的 `.rn-panel__head` 放标签、地址栏或工具条，下面是 `.rn-panel__body`；分屏时各有一块，工具条不放在上留白。浏览器网页由面板框住，左右和下方各留 6px，网页圆角为 14px（`--rn-r-panel-inset`），Main 的 `HOST_BORDER_RADIUS` 同步为 14。
- 控件：只用 `src/renderer/components/ui/` 的共用基元。按钮、图标按钮、芯片、标签、单行输入、下拉用胶囊，高度只用 20 / 28 / 32 / 40px；主按钮是墨色玻璃，深色下用白色渐变。多行输入、行、菜单项、标签页用 9 / 12px 小圆角。
- 线与圆角：边和分隔线都是 0.5px 发丝线；卡片 12px、面板 20px、对话框和设置卡 24px、菜单 12px。焦点环为 2px、55% 墨色，向外偏移 2px。
- 字号与字重：七级字号/行高为 11/16、12/16、13/20、15/24、20/28、28/36、40/48px。正文 400，标题和强调 500，600 只给 11px 小标签；除字标、助手欢迎语和“关于”产品名外，界面不用衬线，编号、时间、数量用 Geist Mono。
- 字标（V12、V24）：顶部留白左侧、红绿灯右边放墨色的 “Ready”，用 Instrument Serif 400、22px、字距 -0.01em（`--rn-font-wordmark`），字形的视觉中心对齐红绿灯的中心线，到绿灯的距离等于红灯到窗口左缘的距离。助手欢迎语 “Ready for work , Ready for life.”（上方不放点阵标）和设置里“关于”的产品名用同一字体，墨色。应用图标是白底上同一字标（`scripts/make-app-icon.cjs`）。文档侧栏的标题固定为“内容管理”。
- 侧栏的收起与展开（V13、V23）：点图标栏里当前模式的图标，或按 `⌘B`。顶部留白里没有侧栏开关，各侧栏头也不放收起或固定按钮，不靠左缘悬停滑出。切换模式时，侧栏的导航内容沿图标栏的方向上下切换，与中央面板的左右切换同步（280ms）。
- 窄窗口侧栏（V14）：用四角 20px 的浮层玻璃卡，上下与面板对齐，左边离图标栏 8px。由上述入口打开，点卡片外面、按 Esc 或再点开关关闭；鼠标移开不关闭。
- 外框（V15）：四个模式的面板上下留白相等，各为 52px 的带加 8px 间距；侧栏头、面板头、助手头同高 44px、同一条线。助手输入框底边仍与面板底边对齐。
- 右侧留白（V17）：助手收起或是浮层卡时，右侧留一条与图标栏同宽（52px）的留白。助手头行的按钮沿一条圆角路径从横排滑到这条留白里竖排，顺序不变；收起 / 展开按钮始终在右上角同一位置。图标栏不放“助手”按钮。
- 侧栏是一块面板（V18、V25）：停靠的侧栏下面垫一块与中央面板同材质的圆角面板，上下与中央面板对齐；它紧接图标栏的 52px 列（图标到左缘和到面板的距离相等），与中央面板之间留 8px。右侧留白同理。窄窗口下仍是浮层玻璃卡。
- 全区工作面（V19）：关系图谱、查找与替换占用中央面板同一个框，用面板材质，没有投影；打开时底下的模式隐藏。
- 模式切换槽（V20、V21、V27、V32）：助手输入框上方，“选择项目”和四个模式的切换槽是两枚等高（40px）的液态玻璃胶囊，从左向右紧挨着排。槽里没有滑块，图标下面也不垫底：当前模式的字形是白色发光（实心字形，与图标栏的选中字形同一规则；浅色下靠字形自己的柔和光晕 `--rn-liquid-glyph-lit` 读出来），点击即亮，分屏时两个模式都亮；不能拖。与图标栏的模式图标是同一个状态。项目胶囊、切换槽和输入框共用一套液态玻璃材质（`--rn-liquid-*`），液态玻璃只用在这一区。
- 面板阴影（V22）：面板外阴影很浅、向四周均匀发散（`--rn-panel-shadow`），外壳的裁切区给它留出 `--rn-panel-shadow-reach`，任何一边都不被截断；相邻面板的阴影在对方边缘处裁掉，不透过玻璃显出暗带。
- 图标：只用 `lucide-react`；图标栏选中的闭合图形用 `src/renderer/design/next/icons/` 的实心变体。`@tabler/icons-react` 已被 ESLint 禁用。
- 信号色 `--rn-accent` 只给“需要你 / 正在进行 / 今天”和品牌红点。当前或选中的行、标签页用 `--rn-fill-2` 底、墨色字和 500 字重；进度和正文链接不用信号色，链接用墨色加下划线。图标栏选中字形沿用 `--rn-rail-*` 的白色发光规则。
- 动效：时长仍为 120 / 200 / 320ms，标准曲线为 `cubic-bezier(.2,.8,.2,1)`；按钮按下缩到 .94，松开弹回，退出比进入快；尊重“减少动态效果”。“减少透明”时玻璃变成不透明底色。

## 1. 工作台壳层

| 区域 | 入口 |
| --- | --- |
| 路由与 fallback | `src/renderer/App.tsx` |
| Workbench 总壳 | `src/renderer/pages/WorkbenchMode.tsx` |
| 图标栏 | `src/renderer/modules/workbench/shell/ShellRail.tsx`、`shell.css` |
| 文档标签条 | `src/renderer/modules/document/ink/InkTabStrip.tsx` |
| 模式切换与分屏 | `src/renderer/modules/workbench/` |
| 共享 chrome 尺寸 | `src/renderer/modules/workbench/chrome.ts` |
| 滑块动效 | `src/renderer/components/motion/MorphIconRailGroup.tsx`、`src/renderer/styles/workbench-sliders.css` |

不要在各模式页面复制工作台尺寸、切换状态或滑块时间线。

## 2. 左侧面板与文件

| 目标 | 入口 |
| --- | --- |
| 唯一侧栏与导航器槽位（宽度、统一开关和窄窗口浮层由外壳负责） | `src/renderer/modules/workbench/shell/ShellSidebar.tsx`、`src/renderer/pages/WorkbenchMode.tsx` |
| 文档导航器（页面 / 文件） | `src/renderer/modules/document/navigator/DocumentNavigator.tsx` |
| 文件面板标题与主体 | `src/renderer/components/layout/FilesPanel.tsx` |
| 文件树编排 | `src/renderer/components/layout/FileTree.tsx` |
| 文件树子行为 | `src/renderer/components/layout/file-tree/` |
| 文件夹缩略图 | `FolderPreview.tsx`、`folderPreviewModel.ts` |
| 全局查找与替换 | `src/renderer/components/search/FindReplaceWorkspace.tsx` |
| 技能中心整页 | `src/renderer/pages/SkillsCenter.tsx`（`/skills`） |
| 关系图谱（全工作区 / 当前文档） | `src/renderer/components/graph/GraphWorkspace.tsx` |
| 文件涌现 | `FileEmergenceSection.tsx`、`fileEmergenceViewModel.ts` |

瞬时菜单不要挂在带 `overflow-hidden` 的侧栏布局内；使用顶层弹层并由拥有菜单的组件计算位置。文件选择、拖放、移动和删除优先查 `file-tree/`，不要继续把所有逻辑塞回 `FileTree.tsx`。

## 3. 四个工作面

### Browser

- 页面：`src/renderer/pages/modes/BrowserMode.tsx`
- 顶栏：`src/renderer/components/browser/BrowserTopBar.tsx`
- 标签列表（外壳侧栏里的导航器，带标题、分组、拖到助手）：`src/renderer/components/browser/BrowserTabList.tsx`
- 分组共用件：`src/renderer/components/tabs/TabGroupHeaderRow.tsx`、`TabGroupEditMenu.tsx`
- BrowserView bounds：`src/renderer/modules/browser/useBrowserViewBounds.ts`
- 状态：`src/renderer/stores/useBrowserTabs.ts`

BrowserView 是原生覆盖层。弹层、侧栏浮层和模式切换问题先核对 hide/show 与 bounds，不要只调 `z-index`。

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

框架与 Document/Browser 一致：`rss-topbar` 放在面板的 44px 头行，资讯流、阅读、日报、栏目管理放在下面的内容区，头行与内容是一块完整的 `.rn-panel`；左侧 `RSSNavigation` 使用外壳的唯一侧栏。各视图通过 `RSSTopbarTools`（`slot="lead"` / `tools`）把位置与工具放进头行，只有可见视图才放。视觉按设计语言：资讯流是无色面板玻璃（`.rss-feed-sheet`），面包屑与工具条都在面板头行里；选中项是共用 `ListRow`，用 `--rn-fill-2` 底、墨色字和 500 字重；未读靠字重区分；主操作是墨色玻璃；菜单是共用浮层玻璃（`components/ui/float/FloatPanel.tsx`，不折射）。资讯流不得引入聊天依赖（引用、导出入口由 `RSSMode` 通过 `renderMoreActions` 注入）。真实窗口验收：`npm run verify:rss-layout` 与 `node scripts/run-rss-reader-acceptance.cjs`。

内容版面参考 AIHOT：资讯流按日分组成时间轴（左侧时刻 + 圆点竖线，未读点用墨色）。精选栏目每条带大预览图与“推荐理由”，列表顶部是“当前热点”（`modules/rss/hot-events.ts`：近 48 小时、至少两个来源的事件，按来源数、报道数、时间排序，只用已保存的事件归组）；其他栏目用标题右侧的缩略图。分类以 `#名称` 显示，精选不算标签而是“精选”标记。日报是报纸式版面：刊头、标题与期号、日期块和本月小日历、统计行、头条（本期报道依据最多的一条）、按栏目分节；“今日看点 / 本期版面”是导读，宽版在右栏，窄于 980px 移到正文前。左侧往期按月分组，日报/简报分架，打开时显示当前架最新一期。侧栏“新建简报”在正文区原位选择栏目、分类、来源、时间窗口与关键词（`RSSBriefComposer.tsx`），默认带入资讯流当前范围并实时显示篇数；“日报设置”里的“收录范围”说明日报按“精选”标准收录，并可直接打开栏目管理编辑该标准。

B 站、YouTube 资讯在阅读页标题下直接嵌入播放器（`rssVideoEmbed`，只用 CSP 允许的 `player.bilibili.com` 与 `youtube-nocookie.com`），资讯流封面上有播放标记。

阅读页“打开原文”在内容框右侧打开临时浏览器（`PreviewBrowser.tsx`，原生预览视图，与浏览器模块共享登录身份），左侧留出阅读页；工具栏可前进后退、刷新，“浏览器模式”带着当前页面转到浏览器模块。预览内容区登记为原生面（`data-ready-native-surface`），菜单等浮层压上来时统一隐藏、收起后重新放回；内容区底色不透明，原生页面收起时不会透出阅读页。

### Calendar

- 页面：`src/renderer/pages/modes/CalendarMode.tsx`
- 日历本体（侧栏导航器、网格、事件面板）：`src/renderer/modules/calendar/workbench/App.tsx`，样式 `modules/calendar/workbench/styles/app.css`（只用 `--rn-*`）
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

- 页面与分区路由：`src/renderer/pages/Settings.tsx`（导航按 通用 / 助手 / 内容 / 隐私与数据 / 关于 分组）
- 版式：`src/renderer/pages/settings/settings.css`（`sx-*` 只是设置页自己的版式类：分组、卡片、行、表格、状态；只用 `--rn-*`，没有私有调色板）
- 共用版式件：`src/renderer/pages/settings/settings-shared.tsx`（SettingsCard / SettingsRow / SettingsGroup / SettingsNotice / SettingsStatus / SettingsSwitchLabel）与 `src/renderer/components/settings/`
- 控件：一律用 `src/renderer/components/ui` 的共用基元（Button、IconButton、Input、Textarea、Select、Switch、Checkbox、Segmented、Tabs、Kbd、confirmDialog），设置页不再有私有按钮、开关或对话框
- Tag Forge：`src/renderer/pages/settings/TagForgeSettingsPanel.tsx`
- 长期记忆：`src/renderer/pages/settings/ReadyMemorySettingsPanel.tsx`（自动整理当前禁用）
- 微信/飞书：`src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- 状态：`src/renderer/stores/useSettings.ts`

设置页追求极简与安静：导航与内容落在窗口玻璃上，不额外铺整块画布；需要成组的设置项才用无色面板玻璃（`sx-card`：`--rn-sheet`、24px 圆角，行间只留 0.5px 内缩发丝线）。当前分区用共用 `ListRow`，与外壳侧栏一样，用 `--rn-fill-2` 底、墨色字和 500 字重；单选卡与分段控件也用墨色表示选中，不用信号色或线框圈选。关键行动与「开」状态用墨色，每个视图最多一个墨色玻璃主按钮；信号色 `--rn-accent` 只给“需要你 / 正在进行 / 今天”和品牌红点，已连接用墨色；正文链接是墨色加下划线；设置页不用成功绿；危险操作是红字，不铺红块。外观页只有明暗与“减少透明”。行为合同见 `src/__tests__/settings-design-system.test.tsx` 与 `settings-liquid-glass-contract.test.ts`。新增持久设置必须同时核对 Main、Preload、Renderer 类型和 native DB 验证。

## 6. 样式与验证

共享样式位于 `src/renderer/styles/`。修改前先找现有基元与 `--rn-*` 令牌；禁止在层外新增通用 `* { margin/padding }` reset。新增颜色字面量、`backdrop-filter` 或 `@font-face` 会被令牌预算拦下（只降不升）。

常用 UI 合同：

```bash
npm run verify:design-tokens
npm run verify:ready-next-design-matrix   # 隐藏的真实窗口截图巡检，结果在 outputs/design-matrix/
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
