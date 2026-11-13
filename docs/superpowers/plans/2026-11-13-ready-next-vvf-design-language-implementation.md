---
status: implemented (rounds 1 and 2), awaiting the user's look at a visible window
enforce: true
date: 2026-11-13
supersedes: 2026-11-11-ready-next-w1-design-system-implementation.md 的 DL2、DL4、DL5、DL7、DL9、DL10（其余 DL 与 §3 之后的工程合同继续有效）
---

# Ready Next 设计语言改为 vvf-2-1 的样子（V1–V10）

用户 2026-11-13 要求：把 Ready Next 的设计与美术风格改成 `/Users/user/实验田/vvf-2-1/vvf-2-1-main` 的样子。

参照物（只读，值以它们为准）：

- `packages/ui/src/tokens.css`、`base.css`、`components.css`、`glass/glass.css`、`motion.css`
- `docs/界面规范.md`、`specs/09-ui.md`
- `apps/desktop/src/renderer/styles/*.css`（各类组件的实际写法）
- `specs/assets/ref/*.jpg`（目标观感）

两个项目的令牌同源（都来自藏书阁 / Ready Poster Printer）：墨色、舞台色、信号橙、阴影、玻璃参数、Inter、Geist Mono 本来就一样。要改的是材质、控件造型、字号层级和强调色的用法。

## 1. 设计语言的变化

| 条 | 现在（W1） | 改成（vvf） |
| --- | --- | --- |
| V1 面板是玻璃 | 内容放在不透明近白的纸上（DL2） | 内容区是一块**无色玻璃面板**：`rgb(glass-tint / alpha-strong)`、顶部 1px 内高光、底部内暗线、0.5px 发丝边、`shadow-2`、圆角 20。没有暖白实色底。窗口本身已经是系统模糊材质，所以面板**不加** `backdrop-filter`（模糊预算不变） |
| V2 材质家族 | 玻璃 / 纸 / 台 / 浮层 | 地面（窗口材质 + 很淡的 24px 点阵）→ 面板玻璃 `.rn-sheet` → 浮层玻璃 `.rn-float`（加 1px 渐变高光边和顶部焦散，保留模糊）→ 嵌片 `.rn-inlay`（面板里更薄的同色玻璃，不模糊）→ 井 `.rn-well`（深一档 + 内阴影，输入区用） |
| V3 发丝线 | 1px `inset 0 0 0 1px` | 0.5px：边 `inset 0 0 0 .5px var(--rn-hair-2)`，分隔 `inset 0 -.5px 0 var(--rn-hair)`。不用粗边框 |
| V4 控件造型 | 控件圆角 9px，主按钮墨色平涂 | 按钮、图标按钮、芯片、标签、单行输入、下拉全是胶囊。高度只用 20 / 28 / 32 / 40。主按钮是**墨色玻璃**（上亮下暗的渐变 + 顶部高光 + 落影；深色下是白色渐变）；次按钮和芯片是嵌片玻璃；文字按钮悬停才有底。多行输入、行、菜单项、标签页仍是小圆角（9 / 12） |
| V5 强调色 | 橘红表示“此刻”，当前行是橘红淡底（DL5） | 橘红只给“需要你 / 正在进行 / 今天”和品牌红点。**选中、当前行、当前标签不用它**：用 `--rn-fill-2` 底 + 墨色 + 500 字重。进度、链接也不用 |
| V6 墨色 | 三级提示墨 .46 | `--rn-ink-3` 浅色 .58（为在面板玻璃和地面上达到 4.5:1）、深色 .52；`--rn-ink-2` 深色 .66；`--rn-ink-4` 深色 .2；只给线和停用。深色舞台 `#0b0b0d`，深色信号橙 `#ff6a2c`。玻璃不着色：`--rn-amb-alpha: 0` |
| V7 字 | 13px 基准，尺寸散落 | 七级字号（行高落在 4px 基线）：眉题 11/16、次要 12/16、正文 13/20、小标题 15/24、标题 20/28、页标题 28/36、展示 40/48。标题和强调 500，正文 400，600 只给 11px 小标签。编号、时间、数量用 Geist Mono 的等宽数字。界面里不用衬线：原来的“展示时刻”（今日问候、日历月份、书房标题）改为界面字体 500 加 `-0.02em` 字距。书脊、书页这些实物上的字不算界面，保留。**不加回 Inter Tight**（B13 刚移除，字体预算只降不升） |
| V8 圆角 | 纸 20、浮层 16、控件 9 | 同心：卡片 12、面板 20、对话框和设置卡 24、菜单 12、控件胶囊 |
| V9 动效 | 120 / 200 / 320ms，一条曲线 | 时长不变；标准曲线 `cubic-bezier(.2,.8,.2,1)`；按钮按下缩到 .94、松开弹回（弹簧曲线）；退出比进入快。继续尊重“减少动态效果” |
| V10 焦点环 | 1.5px 三级墨 | `2px solid color-mix(in srgb, var(--rn-ink) 55%, transparent)`，偏移 2px |

### 1.1 第二轮（用户看过真实窗口后，2026-11-13）

用户的原话：字标字体的用法没有迁移过来；左侧折叠面板“非常难用，不知道怎么控制折叠或展开”，D 形轮廓让版面割裂；中央工作区没有保持一个整体，“红色的部分（标签条、地址栏、工具条）应当始终和当前功能区连为整体，现在只有日历日程保持了这个设计语言”。

方向（按 unslop 的五行写）：产品是一个人浏览、写作、读资讯、排日程的桌面工作台，助手在旁边；性格是安静、准确、有一点书卷气；所在的世界是编辑的书桌：玻璃、墨、一盏信号灯；记忆点是 Instrument Serif 的字标和点阵的 READY；签名是右上角的信号橙圆点。

| 条 | 现在 | 改成 |
| --- | --- | --- |
| V11 一个功能区一个整块 | 标签条、地址栏、资讯工具条浮在面板上方的地面上，只有日历在面板里 | 每个功能区是一块 `.rn-panel`：头行 `.rn-panel__head`（44px，底部 0.5px 发丝线）放标签、地址栏或工具条，下面是 `.rn-panel__body`。地面上不再有任何工具条。分屏是两块，各带自己的头行。浏览器的网页被面板框住：左右下各留 `--rn-panel-pad`（6px），网页圆角 `--rn-r-panel-inset`（14px，Main 的 `HOST_BORDER_RADIUS` 同步） |
| V12 字标 | 没有字标；助手欢迎语用界面字体 600 | 顶部留白左侧放字标 “Ready”：Instrument Serif 400、20px、字距 -0.01em（`--rn-font-wordmark`），照 vvf 顶栏字标。助手欢迎语 “Ready for work , Ready for life.” 和设置里“关于”的产品名用同一字体。其余界面仍不用衬线（V7） |
| V13 侧栏的开关 | 收起按钮在侧栏头里，收起后界面上没有展开入口；靠鼠标停在左缘悬停滑出，移开就收 | 一个开关，位置不变：顶部留白左侧、红绿灯右边（字标之前）。收起和展开都点它，`⌘B` 不变。点图标栏里当前模式的图标也切换侧栏（VS Code 的做法）。各模式侧栏头里的收起按钮去掉。去掉左缘悬停滑出 |
| V14 窄窗口的侧栏 | D 形抽屉：左边贴着图标栏是直角，右边圆角，不透明 | 一张浮层玻璃卡（`.rn-float` 材质）：四角同为 20px，上下与面板对齐，左边离图标栏 `--rn-frame-gap`。由开关、图标栏当前图标或 `⌘B` 打开；点卡片外面、按 Esc、再点开关关闭；鼠标移开不关 |
| V15 外框 | 面板上方 97px、下方 63px（日历 59 / 63） | 面板上下留白相等：上下各是 52px 的带加 `--rn-frame-gap`（8px），四个模式同一个框。侧栏头行、面板头行、助手头行同高（44px）同一条线。助手输入框底边仍与面板底边对齐 |
| V16 细节 | 见下 | 数据库表头与首列只在真的有内容滚到下面时才垫不透明底；勾选框选中用墨色底加随主题的勾；其余按 unslop 的清单逐项修 |

## 2. 不变的东西

- 外壳的结构和版式：一个侧栏、图标栏、上下 52px 留白、品牌红点在右上角（W2、DL11、DL11a）。
- 图标栏选中字形的白色发光（DL8 里用户定的规则）。
- 助手输入框的液态玻璃样式（`--rn-liquid-*`，用户 2026-11-11 指定，圆角 18）。
- 减少透明（DL12）：玻璃 alpha 变 1，面板成为不透明的底色。
- 书、书脊、书页、书架、阅读器纸色（`--rn-paper*`、`--rn-cloth-*`、`--rn-shelf-*`）：它们是实物。
- 用户内容色板 `content-palette.css`、日历事件色、书脊色、划线色。
- 文档 Widget 的调色板和合同（`src/shared/document-widget-theme.ts`、`verify:widget-ready`）：本次不动。
- 图标仍是 Lucide。
- 令牌仍只有 `--rn-*` 一套，仍只在 `src/renderer/design/next/tokens.css`；W1 的 DS1–DS7 工程合同、预算脚本、分层规则继续有效。

## 3. 令牌合同（新增与改值）

新增（都在 `tokens.css`）：

- 字号：`--rn-t-micro` 11px / `--rn-lh-micro` 16px；`-meta` 12/16；`-body` 13/20；`-lead` 15/24；`-title` 20/28；`-page` 28/36；`-display` 40/48。`--rn-tracking-tight: -0.02em`；`--rn-tracking-caps: 0.06em`。
- 字标字体：`--rn-font-wordmark` 为 Instrument Serif，只用于 V12 指定的三处。
- 面板与外框：`--rn-frame-gap: 8px`、`--rn-panel-head-h: 44px`、`--rn-panel-pad: 6px`、`--rn-r-panel-inset: 14px`；Main 的 `HOST_BORDER_RADIUS` 同步为 14。
- 控件高度：`--rn-control-h-tag: 20px`、`--rn-control-h-xl: 40px`（已有 `--rn-control-h` 28、`--rn-control-h-lg` 32）。
- 圆角：`--rn-r-card: 12px`、`--rn-r-dialog: 24px`；`--rn-r-float` 改为 12px；`--rn-r-control` 改为 `var(--rn-r-pill)`；`--rn-r-sheet` 仍 20px。
- 材质：`--rn-well-shade`、`--rn-stage-glow`、`--rn-solid`（必须不透明的小件用的实色，如开关和滑块的旋钮）、`--rn-inlay`、墨色玻璃按钮的 `--rn-btn-ink-bg` / `--rn-btn-ink-shadow`（明暗各一份）。
- 动效：`--rn-ease-std: cubic-bezier(.2,.8,.2,1)`；`--rn-ease-spring` 在支持 `linear()` 时用 vvf 的弹簧曲线。

改值：`--rn-sheet` 由不透明色改为 `rgb(var(--rn-glass-tint) / var(--rn-glass-alpha-strong))`；`--rn-sheet-shadow` 改为面板玻璃的整组阴影；V6 里列的墨色、舞台、信号橙、`--rn-amb-alpha`。

颜色字面量只写在 `tokens.css`；别的样式文件只引用令牌（`scripts/design-budget.json` 不调高）。

## 4. 任务

| 任务 | 范围 |
| --- | --- |
| F 地基 | `design/next/tokens.css`、`materials.css`、`components/ui/primitives.css`、`styles/base-chrome.css`（点阵、焦点环）、`pages/DesignSystem.tsx` 与 `design-system.css`、直接钉住这些值的合同测试 |
| A1 外壳与浏览器 | `modules/workbench/**`、`styles/workbench-surfaces.css`、`electron-shell.css`、`flat-chrome.css`、`mode-switch.css`、`glass-overrides.css`、`components/layout/**`、`components/browser/**`、`components/tabs/**`、`components/workbench/**` |
| A2 文档 | `modules/document/**`、`components/document/**`、`styles/document-*.css`（Widget 的两份除外）、`markdown.css`、`attachment-preview.css` |
| A3 资讯与日历 | `styles/rss-*.css`、`components/rss/**`、`modules/rss/**`、`modules/calendar/**` |
| A4 助手、设置与其余 | `components/agent/**`、`styles/chat-utilities.css`、`pages/settings/**`、`components/settings/**`、`components/skill/**`、`pages/skills-center.css`、`styles/knowledge-graph.css`、`components/ready/**`、`modules/library/**`（只改界面件，不动实物）、`components/search/**` |
| T 检查 | `typecheck`、`verify:design-tokens`、`check-css-cascade-layer-reset`、`verify:library-styles`、相关合同测试、隐藏窗口里的设计矩阵与截图 |
| D 文档 | `UI_ADJUSTMENT_GUIDE.md` §0、`PRODUCT.md` 的 Visual Language、W1 计划顶部加“被本文取代的条目”、`docs/README.md` 索引 |

## 5. 完成标准

- 四个模式 × 明暗 × 减少透明，在隐藏的真实窗口里截图对照 `specs/assets/ref`：面板是玻璃、控件是胶囊、发丝线 0.5px、选中不用橘红。
- `npm run typecheck`、`npm run verify:design-tokens`、`node scripts/check-css-cascade-layer-reset.cjs`、`npm run verify:library-styles` 通过；受影响的合同测试按新值改写后通过；设计矩阵在预算内（`currentAccent` 检查按 V5 改写）。
- 文字对比度：`--rn-ink-3` 及以上在面板玻璃上 ≥ 4.5:1（减少透明与正常两种）。

## 6. 交付状态

- 2026-11-13：合同写定，开始 F。
- 2026-11-13：F、A1–A4、T、D 完成，未提交。
  - 改动：144 个文件，净减约 140 行。令牌与材质在 `design/next/`，共享控件在 `components/ui/primitives.css`，其余是各模块按新令牌归位（面板 / 嵌片 / 井 / 不透明件 `--rn-solid`，胶囊控件，0.5px 发丝线，选中不用橘红，七级字号）。
  - 与本文的出入：任务卡和工具卡保持无边框（现有测试要求卡片透明、与正文同列）；设置页的“已连接 / 可用 / 运行中”状态由橘红改为 `--rn-ok` 绿色；网页加载的进度条与转圈改为墨色；含中文的时间标签（日历小时、今日页倒计时）用界面字体加等宽数字，纯数字才用 Geist Mono；勾选框选中仍是橘红（勾是写死的白色 SVG，换墨色后深色下看不见）。
  - 检查：`typecheck`、`eslint src/renderer`、`verify:design-tokens`（颜色字面量预算已用 `--write` 下调）、`check-css-cascade-layer-reset`、`verify:library-styles` 通过；`test:parallel` 8346 项 0 失败（956 项是宿主 Node 上跳过的原生用例，未覆盖；本次不涉及持久化，没有跑 `verify:native`）；`test:ui-contracts` 37/37。隐藏真实窗口：设计矩阵四种组合在预算内（`outputs/design-matrix/2026-11-13-vvf-2/`，`currentAccent` 检查已按 V5 改写，键盘高亮的菜单项不计），外壳 51/51、浏览器壳 52/52（第一次 51/52，下载速览一项重跑通过）、smoke 44/44、日历、对象界面通过。
  - 没做：截图看不到窗口背后的系统玻璃，深色正常透明度下面板玻璃的真实观感还没有在可见窗口里看过；文档 Widget 的调色板按 §2 未动。
- 2026-11-13（第二轮，V11–V16）：完成，未提交。
  - 改动：每个模式的内容区是一块 `.rn-panel`（文档的标签条、浏览器的地址栏、资讯的工具条都是面板头行；日历保留自己的 44px 控制行作头）；浏览器网页被面板框住，`HOST_BORDER_RADIUS` 20 → 14；顶部留白左侧是侧栏开关和 Instrument Serif 字标，助手欢迎语与“关于”的产品名同字体；`ShellSidebarToggle`、左缘悬停滑出删除，点图标栏当前图标切换侧栏；窄窗口的侧栏和助手抽屉是四角圆角的浮层玻璃卡；外框上下各 60px，三列头行同在 y 60–104；数据库表头与首列的不透明底改为滚动驱动；勾选框选中为墨色；今日页“接下来”共用一列；日历时间轴顶部留 8px。
  - 与本文的出入：浅色 `--rn-ink-3` 用 .58（vvf 是 .56），因为巡检量到 .56 在面板上只有 4.41:1；浏览器头行下面不画发丝线（网页已被 6px 玻璃框住，再画一条读成双重边框）；`.workbench-canvas-shell` 保留裁切，面板外阴影在四个模式里一样被裁掉。
  - 检查：`typecheck`、`verify:design-tokens`、`check-css-cascade-layer-reset`、`verify:library-styles` 通过；`test:parallel` 8346 项 0 失败（956 项跳过，绝大多数是宿主 Node 上的原生用例，未覆盖）；`test:ui-contracts` 37/37。隐藏真实窗口：设计矩阵四种组合零违规，`bandSymmetry` 预算由 4 下调到 0（`outputs/design-matrix/2026-11-13-vvf-4/`），提示级文字对比度浅色 4.59–4.80、深色 5.09–5.28；外壳 61/61（含 V12–V15 的新检查）、日历 70 项、浏览器壳 52/52、smoke 44/44、对象界面通过。日历脚本第一次与整套测试同时跑时在“前往日期”处超时，单独重跑通过。
  - 没做 / 已知：`eslint` 在 8 个测试文件上报错（7 个是 `ready/no-source-grep-test` 的基线哈希过期，1 个 `react/prop-types`），其中 6 个文件本次未改动；日历里当前时间的橘色标签会盖住紧邻的小时标签（改版前就有）；真实桌面上的玻璃观感仍需在可见窗口里确认。
