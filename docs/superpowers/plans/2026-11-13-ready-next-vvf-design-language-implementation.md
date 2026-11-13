---
status: implemented (rounds 1–4), awaiting the user's look at a visible window
enforce: true
date: 2026-11-13
supersedes: 2026-11-11-ready-next-w1-design-system-implementation.md 的 DL2、DL4、DL5、DL7、DL9、DL10（其余 DL 与 §3 之后的工程合同继续有效）
---

# Ready Next 设计语言改为 vvf-2-1 的样子（V1–V30）

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

### 1.2 第三轮（用户看过第二轮的真实窗口后，2026-11-13）

用户说“好了非常多”，第二轮已提交（`b31fd5584`）。再提四点：

| 条 | 现在 | 改成 |
| --- | --- | --- |
| V17 右侧留白 | 助手收起后不占宽度，面板直接贴到窗口右缘；展开助手的按钮跑到左侧图标栏底部 | 助手收起时右侧留一条与左侧图标栏同宽（52px）的留白，左右近乎对称。助手头行的按钮（会话、新建、技能、更多、收起）沿一条圆角路径从横排滑到这条留白里竖排，像滑梯拐过一个弯；收起 / 展开按钮始终在右上角同一个位置。左侧图标栏不再放“助手”按钮。窄窗口下助手是浮层卡时，右侧同样是这条留白 |
| V18 侧栏是一块面板 | 侧栏内容直接散在窗口玻璃上，元素多时（日历）显得松散 | 停靠的侧栏下面垫一块与中央面板同材质的圆角面板（共享宽度区）：上下与中央面板对齐，圆角 20，和中央面板之间留 `--rn-frame-gap`。侧栏头行在面板里。窄窗口下仍是浮层玻璃卡 |
| V19 关系图谱 | 一张带大投影的浮层盖在内容区上，投影被内容区边界切成一块灰色方框 | 关系图谱占用中央面板同一个框，用面板材质，没有投影。查找与替换等同类全区工作面一样处理 |
| V20 模式切换槽 | 模式切换只在左侧图标栏（W2 把助手输入框上方的切换槽删了） | 助手输入框上方、“选择项目”右边补回模式切换槽（四个模式图标的滑槽，可点可拖，分屏时滑块跨两格）。左侧图标栏的模式图标保留，两处是同一个状态 |

### 1.3 第四轮（用户看过第三轮的真实窗口后，2026-11-13）

| 条 | 现在 | 改成 |
| --- | --- | --- |
| V21 切换槽用回旧样式 | 凹槽轨道加墨色胶囊滑块，靠右；“选择项目”在左 | 用户原话：“还是旧的样式会更协调统一一点，使用液态玻璃做好等高的设计从左向右排”。“选择项目”和切换槽都是液态玻璃胶囊，等高，从左向右紧挨着排；滑块是液态透镜，当前模式的图标是白色发光字形（图标栏选中字形的规则）。液态玻璃的范围由“只有输入框”（DL4a）扩为“输入框和它上方这一行” |
| V22 面板阴影 | 侧栏面板的阴影偏重，底部被外壳的裁切截成一条 | 面板外阴影改为很浅、向四周均匀发散（`--rn-panel-shadow`），外壳各裁切区给它留出 `--rn-panel-shadow-reach`，不被截断；中央面板、分屏的两块、关系图谱等同样有这层阴影 |
| V23 字标旁的开关去掉，侧栏随模式上下切换 | 字标左边有侧栏开关；切换模式时中央面板左右滑动，侧栏内容直接替换 | 去掉字标旁的开关（V13 的开关作废）：侧栏的收起 / 展开靠点图标栏里当前模式的图标和 `⌘B`。切换模式时，侧栏的导航内容沿图标栏的方向上下切换（切到下面的模式，新内容从下方进入、旧内容向上离开；反之相反），与中央面板的左右切换同步 |
| V24 字标与标题 | 字标 20px；文档侧栏标题显示资料库文件夹名（vault） | 字标放大到 22px，视觉中心与红绿灯的中心线对齐；文档侧栏标题固定为“内容管理” |
| V25 图标栏两侧留白 | 图标到窗口左缘 10px，到侧栏面板 18px（多了一个 8px 间距） | 图标栏的图标到左缘和到相邻面板的距离相等：相邻的面板紧接图标栏的 52px 列，不再另加 8px；右侧留白与它右边的窗口边缘、左边的面板同理 |

### 1.4 第五轮（2026-11-13，用户给了参考视频）

| 条 | 现在 | 改成 |
| --- | --- | --- |
| V26 切换槽的滑块 | 灰色底盘在图标下面，白色字形在上面 | 照用户给的参考视频：滑块是一枚浮在图标之上的透明液态透镜，没有底色盘；中心通透，边缘折射下面和旁边的图标并带一点色散；比轨道略高（上下各 3px）、比一格略宽；玻璃感只靠光来表达（亮环、上缘高光、下缘反光、内缘柔光、淡淡的面光，`--rn-liquid-lens-*`）。当前模式的字形改为墨色实心（深色下是浅色）。减少透明时透镜关闭，当前格垫 `--rn-fill-2` |
| V27 输入区的立体感 | 项目胶囊、切换槽、输入框偏平 | 三者共用的液态玻璃材质加强一点：很轻的贴地阴影（`--rn-liquid-shadow`）、更亮的上缘高光与一条下缘暗线、边缘折射略强。输入框的形状、圆角 18 和色调不变 |
| V24 补充 | 字标离绿灯约 5px | 字标到绿灯的距离等于红灯到窗口左缘的距离（约 21px，字标起点 x 100） |

### 1.5 第六轮（2026-11-13）

| 条 | 现在 | 改成 |
| --- | --- | --- |
| V26 修正 | 透镜比轨道高、比一格宽，在第一格会伸出轨道；当前字形墨色实心 | 用户原话：“这个玻璃滑块不应该超过滑槽的上下左右边界”“切换到的图标应该是发光不是发黑填充”。透镜完全在轨道里：轨道 40px，四周各留 4px，透镜 32px 高、一格宽，滑动和拖拽时不放大、不越界。当前模式的字形是信号橙实心加一圈同色柔光（`--rn-liquid-glyph-glow`）；这是信号橙唯一用来表示选中的地方，图标栏仍是白色发光 |
| V28 字标是橙红色 | 顶栏字标墨色 | 顶栏字标 “Ready” 用信号橙（`--rn-accent`）；助手欢迎语与“关于”的产品名仍是墨色 |
| V29 欢迎语上方的点阵 R | 欢迎语上方有 40px 的点阵 R | 去掉，欢迎语单独成行；点阵 R 留在设置的“关于” |
| V30 应用图标 | 白底橙色点阵 R | 白底、信号橙的 Instrument Serif 字标 “Ready”，字占图标白底宽度的 64%，四周留白；由 `scripts/make-app-icon.cjs` 生成 `build/icon.{svg,png,icns,ico}` |

### 1.6 第七轮（2026-11-13）

用户原话：“ready 都改回黑色，滑块调整到贴着滑槽的边好了，亮灯是亮白灯不用橙红色”。

| 条 | 第六轮 | 改成 |
| --- | --- | --- |
| V26 再修正 | 透镜四周各离轨道 4px；当前字形信号橙加柔光 | 透镜贴着轨道的边：与轨道同高（40px）、一格宽，两端与轨道的端头重合，但不越界。当前字形是白色发光（图标栏的规则，不带橙色光）；透镜里带一点很淡的烟色，白色字形在浅色轨道上才读得出来。信号橙不再用于任何选中状态 |
| V28 作废 | 顶栏字标信号橙 | 顶栏字标回到墨色 |
| V30 修正 | 应用图标的字标信号橙 | 应用图标的字标是墨色（`#0B0B0E`），白底不变 |

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
- 2026-11-13（第三轮，V17–V20）：完成。第二轮已提交为 `b31fd5584`。
  - 改动：助手未停靠时外壳保留 52px 的右侧留白（`SHELL_ASSISTANT_STRIP_WIDTH`，窗口最小宽度 664），助手头行的五个按钮移到外壳右上角的一个常驻元素里，收起 / 展开按钮固定不动，其余四个用 CSS motion path 作为一列“珠子”整体滑过圆角（`shell.css`，320ms）；左侧图标栏的“助手”按钮删除。停靠的侧栏插槽是 `.rn-panel`，各间距统一为 8px，拖拽手柄不占宽度。关系图谱与查找与替换占用面板的框、用面板材质，查找与替换打开时也挂起底下的模式。模式切换槽从 `7a31e843b^` 恢复（`DraggableModeTabs`、`mode-tabs-layout`），放在助手输入框上方的上下文行右侧，凹槽轨道加墨色胶囊滑块，与图标栏共用同一组处理函数。
  - 与本文的出入：切换槽没有用回原来的液态透镜（DL4a：液态玻璃只给输入框）；“选择项目”由 38px 改为 32px 与切换槽同高；按钮滑动最初实现成靠近拐角的先到位，四个按钮会在拐角处交叉挤成一团，改为整列同距同速，横排从左到右即竖排从上到下。
  - 检查：`typecheck`、`verify:design-tokens`、`check-css-cascade-layer-reset`、`verify:library-styles`、`check-browser-surface-binding` 通过；`test:parallel` 8350 项 0 失败（956 项跳过，绝大多数是宿主 Node 上的原生用例，未覆盖）；`test:ui-contracts` 37/37。隐藏真实窗口：设计矩阵四种组合在预算内（`outputs/design-matrix/2026-11-13-vvf-5/`）；外壳 76 项（含 V17、V18、V20 的新检查）、日历 70 项、浏览器壳 52/52、smoke 44/44、对象界面通过。
  - 没做 / 已知：`run-rss-layout-acceptance.cjs`、`run-rss-reader-acceptance.cjs`、`verify-ready-next-capsule-electron.cjs` 里点击助手开关的选择器已改，但这三个脚本本轮没有运行；滑动的手感、拖拽切换槽的手感需要在可见窗口里确认。
- 2026-11-13（第四轮，V21–V25）：完成，第三、四轮未提交。
  - 改动：模式切换槽与“选择项目”恢复液态透镜（轨道、滑块、白色发光的当前字形），同高 40px，从左向右相隔 8px；面板外阴影换成 `--rn-panel-shadow`，外壳行、内容列、模式场景、日历根等裁切区改为 `overflow: clip` 加 `overflow-clip-margin`，`.workbench-canvas-shell` 不再裁切，模式滑动期间才硬裁切，相邻面板的阴影用 `clip-path` 在对方边缘处截掉；顶部留白的侧栏开关删除；`navigator-motion.ts` 让侧栏导航随模式上下进出（280ms，与场景同曲线，离开的一方保持可见但不可交互）；字标 22px，上移 0.059em；文档侧栏标题固定为“内容管理”；图标栏与右侧留白旁的面板不再另加 8px（内容列用 margin 留面板之间的 8px）。
  - 实测（隐藏窗口，1440×900）：字标基线 y 32.2、大写顶 16.36、字形整体中点约 26；图标栏按钮 x 10–42，侧栏面板 x 52 起。
  - 与本文的出入：日历根元素去掉了 `contain: paint`（它会在根的边缘把阴影裁掉），保留 `contain: layout`。
  - 检查：`typecheck`、`verify:design-tokens`（颜色与 `backdrop-filter` 计数未增加）、`check-css-cascade-layer-reset`、`verify:library-styles`、`check-browser-surface-binding` 通过；`test:parallel` 8351 项 0 失败（956 项跳过，绝大多数是宿主 Node 上的原生用例，未覆盖）；`test:ui-contracts` 37/37。隐藏真实窗口：设计矩阵四种组合在预算内（`outputs/design-matrix/2026-11-13-vvf-6/`）；外壳 80 项、日历 70 项、浏览器壳 52/52、smoke 44/44、对象界面通过。
  - 没做 / 已知：侧栏上下切换、按钮滑动、切换槽拖拽都是动效，只能在可见窗口里确认手感；浅色下切换槽里白色的当前字形对比度偏低（沿用旧样式与图标栏的规则）。
