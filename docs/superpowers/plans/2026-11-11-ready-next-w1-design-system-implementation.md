---
title: Ready Next W1 设计系统实施计划
date: 2026-11-11
status: planned
enforce: true
---

# Ready Next W1 设计系统：一块玻璃，几张纸，一个信号色

属于 [收束路线图](2026-11-11-ready-next-coherence-roadmap.md) 的 W1，落实 E2、E10、E11。证据：[a-design](../audits/2026-11-11-ready-next-coherence-audit/a-design.md) 与实机观察 O6–O11。视觉意图以 [设计基准页](../../design/ready-next-design-reference.html) 为准：本文的条文与基准页不一致时，先停下来对齐两者，再动代码。

## 1. 要解决的问题

用户原本想要“整个应用像一块磨砂玻璃”，但信息要分区，玻璃就被切成了一张张卡片，再叠上各模块自带的纸面、舞台和工具条，最后谁也不像谁。

出路不是在“玻璃”和“分区”之间二选一，而是把两件事分给两种材质：**玻璃只有一块，是窗口本身；分区靠放在玻璃上的纸来完成。** 导航、工具、助手都长在这块玻璃上，不再各自成卡；每个内容区是一张纸。这样玻璃是完整的，信息也是分开的。

现状的数字（[a-design](../audits/2026-11-11-ready-next-coherence-audit/a-design.md)）：

- 令牌：外壳 `theme-tokens.css`、`--rn-*`、`--ink-*`、日历 `--tp-*` 与 `--c-*`、设置 `--sx-*`，五套并存，后四套只有部分互相映射。
- 强调色：外壳四选一（默认蓝），ink 与 `--rn-*` 写死 `#ff5a1f`，日历写死 `#ed511c`。
- 字体声明七处；图标两个库，线宽 1.25 到 2、尺寸 14 到 20 不等。
- 玻璃两套引擎（`GlassSurface` 与 `LiquidLens` 系列），另有模块里散写的 `backdrop-filter`。
- 按钮至少五套，菜单四套，对话框四套，开关三套，滚动条四套。四个新模块没有一个用 `components/ui` 里现成的 `IconButton`、`Modal`。
- 皮肤分支：`glass-overrides.css` 与 `flat-chrome.css` 各有 77 处按 `data-skin` 分支的规则，另有五个文件共 130 多处。

## 2. 设计语言 DL1–DL12（含 DL4a、DL11a）

这些是规范性条文。实现与它冲突时改实现。

| 编号 | 条文 |
| --- | --- |
| DL1 一块玻璃 | 窗口是一块连续的磨砂玻璃。图标栏、侧栏、工具条、助手都是这块玻璃上的区域，**没有自己的背景、边框、圆角、阴影**。区域之间靠间距分开，必要时用一条发丝线 |
| DL2 纸 | 内容放在纸上：不透明、近白、大圆角、贴地的柔和阴影。一个内容区一张纸，分屏就是两张。**纸上不再放纸**；纸内部用排版、留白和发丝线组织，不用卡片套卡片 |
| DL3 台 | 空间型的内容（画板、书架、阅读的书）不用纸做底，用“台”：玻璃上略微下沉的一块。台上的东西（卡片、书、书页）才是纸 |
| DL4 浮层 | 菜单、弹出层、对话框、`⌘K`、提示是同一种材质：更厚的玻璃，带模糊和投影。全应用只有一份实现。同一时刻最多叠两层 |
| DL4a 液态玻璃 | **助手输入框用液态玻璃**：比浮层更透，有高光边和反光。它是全应用唯一的签名元素，别处不用。“减少透明”时退回纸色（用户 2026-11-11 指定） |
| DL5 一个信号色 | 橘红 `#ff5a1f` 只表示“此刻”：当前所在位置、今天、正在进行（助手运行、录音、未保存）、品牌红点（在窗口右上角）。它不是装饰色，也不是按钮的默认色。主按钮用墨色实心；一屏最多一个主按钮 |
| DL6 墨 | 文字与图标只有四级墨色（正文、次要、提示、禁用），由同一个墨色加不同透明度得到。正文里的链接用墨色加下划线，不另起颜色 |
| DL7 字 | 界面用 Inter 加苹方，13px 为基准。Instrument Serif 只用于“展示时刻”（今日页的问候、日历的月份、书房的标题），一屏最多一处。数字、代码、快捷键用 Geist Mono。字体文件只加载一次 |
| DL8 图标 | 只用 Lucide，16px、线宽 1.5；图标栏 20px；密集处 14px。图标栏选中态沿用用户既定规则：白色发光字形，闭合图形换实心，开放线条加粗；浅色下垫浅灰方块，侧栏收起时不垫 |
| DL9 圆角与阴影 | 纸 20px，浮层 16px，控件 9px，小元素 6px，胶囊全圆。阴影只有三种用途：纸的贴地影、浮层影、书与卡片的实物影。玻璃上的区域没有阴影 |
| DL10 动效 | 时长 120 / 200 / 320ms，曲线 `cubic-bezier(.22, 1, .36, 1)`。只在状态变化时动；尊重系统的“减少动态效果” |
| DL11 密度 | 行高 30px，控件高 28px（紧凑）或 32px，图标栏宽 52px，侧栏默认 248px，助手默认 380px，纸与纸之间、纸与窗口右缘留 8px |
| DL11a 外框对称 | 纸（或台）上方与下方的留白等高，都是 52px，与图标栏同宽。上留白放标签条或地址栏；下留白保持安静，只在需要时显示一行状态。助手输入框的底边与纸的底边对齐。品牌红点在窗口右上角，是外框上唯一的强调（用户 2026-11-11 指定） |
| DL12 减少透明 | 一个开关，同时跟随系统的“减少透明度”。打开后玻璃变成不透明的底色，浮层不再模糊。它取代全部皮肤，也是 Windows 与低性能机器的回退 |

材质的叠放关系：

| 材质 | 可以放在 | 不可以 |
| --- | --- | --- |
| 玻璃 | 窗口（只有一块） | 嵌套；被切成带边框的面板 |
| 纸 | 玻璃上 | 放在纸上；放在台上充当面板 |
| 台 | 玻璃上，占一个内容区 | 放在纸上 |
| 浮层 | 任何材质之上 | 超过两层；不通知原生网页层让位就出现 |

## 3. 令牌合同

### 3.1 一套令牌

`src/renderer/design/next/tokens.css` 的 `--rn-*` 是唯一的令牌来源，前缀不改。其余四套退役，退役方式是“先映射，后删除”，不保留并行定义。

要新增的语义令牌（值以基准页为准）：

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--rn-sheet` | `#fdfdfc` | `#1c1c1f` | 纸 |
| `--rn-sheet-shadow` | `0 1px 2px rgb(10 10 20 / .05), 0 8px 24px -12px rgb(10 10 30 / .14)` | `0 1px 2px rgb(0 0 0 / .4), 0 8px 24px -12px rgb(0 0 0 / .6)` | 纸的贴地影 |
| `--rn-well` | `rgb(11 11 14 / .04)` | `rgb(0 0 0 / .26)` | 台 |
| `--rn-float` | `rgb(252 252 253 / .82)` | `rgb(28 28 32 / .86)` | 浮层底色 |
| `--rn-accent-text` | `#c8410f` | `#ff8a5c` | 橘红文字。`--rn-accent` 在白底上对比度约 3:1，不能直接做小字 |
| `--rn-r-sheet` / `--rn-r-float` / `--rn-r-control` | `20px` / `16px` / `9px` | 同左 | 圆角 |
| `--rn-rail-w` / `--rn-sidebar-w` / `--rn-assistant-w` | `52px` / `248px` / `380px` | 同左 | 外壳尺寸 |
| `--rn-band-h` | `52px` | 同左 | 上留白与下留白的高度 |
| `--rn-liquid-a` / `-b` / `-rim` / `-hi` / `-sheen` / `-shadow` | 见基准页 | 见基准页 | 液态玻璃（只用于助手输入框） |
| `--rn-row-h` / `--rn-control-h` / `--rn-control-h-lg` | `30px` / `28px` / `32px` | 同左 | 密度 |
| `--rn-icon` / `--rn-icon-stroke` | `16px` / `1.5` | 同左 | 图标 |
| `--rn-prose-size` / `--rn-prose-lh` | `16px` / `1.75` | 同左 | 纸上的正文 |

`--rn-paper`（`#f7f4ee`）保留原义：书页的颜色，只在书房阅读器里用，不是应用的纸。

### 3.2 退役与映射

| 现有 | 处理 |
| --- | --- |
| 外壳 `src/renderer/styles/theme-tokens.css`（`--bg-*`、`--text-*`、`--surface-*`、`--color-accent` 等） | 第一步改成指向 `--rn-*` 的别名；所有使用点迁完后删除文件 |
| `--ink-*` 与 ink 的 studio 变量（`src/renderer/modules/document/ink/ink.css`） | 映射到 `--rn-*`，删除私有调色板；`.ink-scope` 只保留排版相关的局部变量 |
| 日历 `--c-*`（`modules/calendar/workbench/styles/app.css`） | 映射到 `--rn-*` |
| 日历 `--tp-*` 色板与 `geometry-tokens.ts` | 这是日程颜色的数据（每种颜色的明暗两组值），保留为数据文件并列入白名单；其中用于界面框架的值改用 `--rn-*` |
| 设置 `--sx-*`（`styles/settings-surfaces.css`） | 映射后删除 |
| 强调色：`useTheme.ts` 的 `accentPalettes`、`ThemeAccent`、`setAccent`，设置页的选择器 | 删除。`--rn-accent` 是唯一来源；日历的 `#ed511c` 改用它 |
| 皮肤：`ThemeSkin`、`data-skin`、`data-glass-backdrop`、`data-glass-variant` 及七个样式文件里的分支 | 删除。只留 `data-theme`（明暗）与 `data-transparency`（`normal | reduced`） |
| 字体：ink 另载的 Inter Tight、日历另载的 Inter 与 Instrument Serif | 删除重复的 `@font-face`，统一用 `--rn-font-*` |
| `@tabler/icons-react` | 图标栏改用 Lucide 与少量自绘实心变体（放 `src/renderer/design/next/icons/`）后移除依赖 |

用户设置的一次性迁移：`localStorage` 里的 `ready-theme-skin`、`ready-theme-accent` 读一次后删除；原皮肤是任一种实色皮肤的用户，迁移为“减少透明”打开。迁移有行为测试，重复执行无副作用。

## 4. 材质的实现

| 材质 | 实现 |
| --- | --- |
| 玻璃 | 根节点一层：macOS 用窗口的 `under-window` 毛玻璃做底，DOM 只画一层带色的半透明；不在 DOM 里做模糊。“减少透明”时画不透明的 `--rn-stage`。`src/main/modules/window-material/` 相应简化为明暗两种 |
| 纸 | `.rn-sheet`：`--rn-sheet` 底、`--rn-r-sheet`、`--rn-sheet-shadow` |
| 台 | `.rn-well`：`--rn-well` 底、`--rn-r-sheet`、内侧一条发丝线 |
| 浮层 | 一个 `Float` 组件：`--rn-float` 底、`backdrop-filter: blur(var(--rn-glass-blur))`、`--rn-shadow-3`、`--rn-r-float`。`backdrop-filter` 全应用只允许出现在这里和助手输入框 |
| 液态玻璃 | 只有助手输入框。沿用现有的液态实现（`styles/liquid-composer.css` 与 `components/ui/liquid-glass/`），外观参数改用 `--rn-liquid-*`，圆角 24px |

**玻璃引擎收成一份（T3）。** 现在有两套：`GlassSurface`（SVG 折射加模糊，书房在用）和 `LiquidLens` / `LiquidGlassScene` / `LiquidFloatingPanel`（外壳、助手输入框、资讯菜单等 23 个文件在用）。之后的分工是：

- **助手输入框保留液态玻璃**（DL4a）。默认留它现在用的 Liquid 系列；如果 `GlassSurface` 能在同样的观感下更省，可以换成它，但两套只留一份。
- **常驻面板不用引擎**（DL1）：图标栏、侧栏、标签条上现有的液态效果去掉。
- **浮层用普通的模糊**（`Float`），不做折射。书房里用 `GlassSurface` 的工具条改用 `Float`。

留下的那一份要量一次：输入时与滚动消息时的帧耗时、暗色是否完整、“减少透明”下是否正确退回。

## 5. 基元

放在 `src/renderer/components/ui/`，全应用共用。以 ink 的实现（`modules/document/ink/menu.tsx`、`overlay.tsx`）为起点，因为它完成度最高、最接近目标外观。

| 基元 | 取代 |
| --- | --- |
| `Button`（主、次、幽灵、危险；两种高度）、`IconButton` | ink、日历、书房、画板、设置各自的按钮类；现有 `IconButton` 扩展后保留 |
| `Field`（输入框、多行、选择）、`Switch`、`Checkbox`、`Segmented` | 设置页 `settings-shared.tsx`、ink `menu.tsx`、日历 `Settings.tsx` 里的三套开关和各自的输入框；`MorphSegmentedControl` 并入 |
| `Menu`、`ContextMenu` | `components/layout/ContextMenu.tsx`、ink `menu.tsx`、日历 `Menus.tsx`、画板里手写的右键菜单 |
| `Popover`、`Tooltip`、`Dialog`、`Toast` | ink `overlay.tsx`、`components/ui/Modal.tsx`、书房 `ArchiveImport.tsx` 的对话框、日历 `Overlays.tsx`、浏览器壳里的提示条 |
| `Tabs` / `TabStrip` | `InkTabStrip`、`DraggableModeTabs`、`MorphTabStrip` |
| `ListRow`（侧栏行）、`SectionHeader`、`Toolbar`、`Chip`、`Kbd` | 各模块侧栏和工具条里手写的行与胶囊 |
| `EmptyState`、`Skeleton`、`ScrollArea`、`ResizeHandle` | 三套空状态、两套骨架、四套滚动条样式、三处拖拽分隔条 |
| `RefCapsule`（引用胶囊） | 由 W6 实现，放在同一目录 |

两条硬规则：

- **所有浮层基元内置原生网页层让位。** 出现前隐藏 BrowserView、消失后恢复并同步位置（`modules/overlay/useNativeSurfaceAwareOverlay.ts` 的逻辑收进 `Float`）。调用方不再各自处理，也就不会漏。
- **基元展示页。** 新增实验路由 `#/design-system`，把全部基元的每种状态在明暗两种主题下摆出来。它是实现的权威，也是截图巡检的固定对象。不替换默认入口。

## 6. 强制

写下来的规范靠不住，要让违反它的改动过不了检查。

| 检查 | 内容 | 入口 |
| --- | --- | --- |
| 令牌预算 | 统计 `src/renderer` 下各目录的颜色字面量、`backdrop-filter`、`@font-face` 数量，与 `scripts/design-budget.json` 比较：只许降，不许升。白名单：`design/next/**`、日历的日程色板数据、用户内容颜色（文字高亮色板、书脊布色）。收尾目标：模块样式里颜色字面量为 0，`backdrop-filter` 只在材质文件，`@font-face` 只在 `tokens.css` | `scripts/check-design-tokens.cjs`，接入 `npm run verify` |
| 禁用引入 | ESLint `no-restricted-imports`：模块之间不得引入对方私有的菜单、弹层、按钮；`@tabler/icons-react` 在图标栏迁完后禁用 | `eslint.config.mjs` |
| 退役属性 | 源码里不得再出现 `data-skin`、`data-glass-variant`、`ThemeAccent`、`ready-theme-accent`（迁移器除外） | 并入令牌预算脚本 |
| 截图巡检 | 真实窗口，隔离 profile，固定的测试资料库。四个模式 × 明暗 × 两种窗口（1440×900、1100×760），外加固定界面：页面、数据库、画板、书架、阅读器、资讯文章、日历事件面板、`⌘K`、斜杠菜单、设置、今日页、基元展示页。每张图同时做机器检查（见下）并存到 `outputs/design-matrix/<日期>/` 供人看 | `scripts/verify-ready-next-design-matrix.cjs`，`npm run verify:ready-next-design-matrix` |

截图巡检的机器检查：

- 内容区宽度满足 G1。
- 纸或台的上边距与下边距相等（DL11a），四个模式一致；助手输入框的底边与纸的底边在同一条线上。
- 根面板没有横向溢出。
- 界面文字的计算字体是 `--rn-font-ui` 的首选字体。
- “当前项”的计算颜色等于 `--rn-accent` 或 `--rn-accent-text`。
- 可见的 `button`、`input`、`select`、`textarea` 没有浏览器默认外观（用计算样式里的默认边框和 `appearance` 判断）。
- 浅色与深色下，四级墨色在纸、玻璃回退色、浮层上的对比度：正文不低于 4.5:1，次要文字不低于 4.5:1，提示文字不低于 3:1。

做法与已知的坑见 [盘点 README](../audits/2026-11-11-ready-next-coherence-audit/README.md) 末尾。两点要先解决：需要一个只在隔离 profile 下生效的主题设置入口（这次没拿到暗色截图）；`page.screenshot` 拍不到系统毛玻璃和网页层，玻璃质感仍要用可见窗口由人确认一次。

## 7. 任务

T7 的脚本先做出来并存一份基线，再开始 T1 的删除。

| 任务 | 内容 | 范围 | 验收 |
| --- | --- | --- | --- |
| T1 令牌合并与旧主题退役 | 新增 §3.1 的令牌；外壳令牌改为别名；删除强调色与皮肤的全部分支、设置项、状态；窗口材质简化；设置迁移；“减少透明”开关 | `design/next/tokens.css`、`styles/theme-tokens.css`、`styles/glass-overrides.css`、`styles/flat-chrome.css`、`styles/workbench-surfaces.css`、`styles/liquid-composer.css`、`styles/mode-switch.css`、`styles/workbench-sliders.css`、`components/document/documentFloatingPanels.css`、`stores/useTheme.ts`、`pages/Settings.tsx`、`src/main/modules/window-material/` | 巡检基线与改后对比，四个旧模式除强调色由蓝变橘红外无非预期变化；退役属性检查通过；迁移测试通过；`check-css-cascade-layer-reset.cjs` 通过 |
| T2 材质层 | `design/next/materials.css`；根玻璃、纸、台三个类 | 新文件；由 W2 的外壳使用 | 基元展示页上三种材质明暗各一张图，与基准页一致 |
| T3 玻璃引擎收成一份 | 按 §4：液态玻璃只留给助手输入框，其余调用点改用 `Float` 或去掉 | `design/next/glass.*`、`GlassSurface.tsx`、`components/ui/liquid-glass/`、`LiquidGlassScene.tsx`、`styles/liquid-composer.css` 及调用点 | 测量记录写进本文“交付状态”；源码里只剩一份引擎，且只有助手输入框在用；书房、助手输入框、菜单在真实窗口正常 |
| T4 基元库与展示页 | §5 的全部基元；`#/design-system` | `components/ui/`、`App.tsx` 路由 | 每个基元有行为测试（键盘、焦点、可访问名称）；展示页进入巡检 |
| T5 模块迁移 | 按顺序：外壳与助手、设置、资讯（旧外观）→ ink → 日历 → 书房与画板 → 浏览器工具条 → 独立窗口（FastCard 浮层、锁定遮罩、Agent 指针）。每个模块：私有调色板映射后删除，私有按钮、菜单、弹层、开关换成基元 | 各模块样式与组件 | 每迁完一个模块：巡检通过，预算下调并提交新的 `design-budget.json` |
| T6 清尾 | 删除别名层与空掉的旧样式文件；移除 `@tabler/icons-react`；重写 `PRODUCT.md` 的视觉部分与 `UI_ADJUSTMENT_GUIDE.md`，使两份文档只描述这一套语言（现在一份反对玻璃，一份要求白玻璃） | 样式、`package.json`、两份文档 | 预算达到收尾目标；G3、G4、G5 通过；`verify:version` 等文档检查通过 |
| T7 检查与巡检脚本 | §6 的三个脚本与预算文件；主题测试入口 | `scripts/`、`package.json` | 脚本在当前代码上能跑出基线；故意加一个颜色字面量时预算检查失败 |

## 8. 合同 DS1–DS7

| 合同 | 标准 |
| --- | --- |
| DS1 | 颜色、圆角、阴影、字体、动效只来自 `--rn-*`；模块根节点不定义自己的调色板 |
| DS2 | 强调色与皮肤不存在：没有设置项、没有属性、没有分支；旧设置迁移一次且可重复执行 |
| DS3 | 浮层只有一份实现，出现时原生网页层让位、消失后恢复；真实窗口验证 |
| DS4 | 每类基元只有一份实现；§5 表里“取代”一列的旧实现全部删除 |
| DS5 | 明暗两种主题、“减少透明”开与关，四种组合下巡检都通过 |
| DS7 | 外框对称：上下留白等高；品牌红点在窗口右上角；液态玻璃只出现在助手输入框 |
| DS6 | 字体文件每种只加载一次；图标库只有一个 |

## 9. 风险

| 风险 | 处理 |
| --- | --- |
| 旧样式按 `data-skin` 写了大量选择器，直接删属性会让规则全部失效 | 分两步：先把“玻璃、原生底”定为唯一路径并删掉其他皮肤的规则，巡检通过后再去掉选择器里的属性条件 |
| 橘红做小字对比度不足 | 文字用 `--rn-accent-text`；对比度检查进巡检 |
| 根玻璃依赖 macOS 的窗口毛玻璃，截图拍不到 | 每批至少用可见窗口看一次；“减少透明”的截图作为机器可比的基线 |
| 日历色板 1400 多个字面量 | 列为数据白名单，不强行令牌化；只迁界面框架用到的值 |
| 暗色现状没有画面证据 | T7 先拿到暗色基线，再开始改 |
| 迁移期间新旧基元并存，容易又长出第三套 | 每个模块迁移必须在同一批里删掉该模块的旧实现；预算只降不升 |

## 10. 交付状态

- 2026-11-11：计划与设计基准页完成，未开始实现。
- 2026-11-11：用户看过基准页后补充三点，已写入 DL4a、DL11a、§4 与基准页第 2 版：上下留白对称、品牌红点留在右上角、助手输入框用液态玻璃。其余认可。
- 2026-11-11（B1）：**T7 与 T1 完成。**
  - T7 检查与巡检脚本：`scripts/check-design-tokens.cjs` 与 `scripts/design-budget.json`（`npm run verify:design-tokens`，已接入 `npm run verify`）按目录统计颜色字面量、`backdrop-filter`、`@font-face` 与退役标识，只降不升，并与 HEAD 版本比较防止手改调高；`eslint.config.mjs` 加了跨模块私有菜单、弹层、对话框的禁用引入（ink 的私有件归整个文档模块所有，含 `pages/modes/DocumentMode.tsx`）。截图巡检 `scripts/verify-ready-next-design-matrix.cjs`（`npm run verify:ready-next-design-matrix`，辅助文件在 `scripts/design-matrix/`）：每次新建隔离 profile 与测试资料库，四个模式 × 两种窗口 + 12 个固定界面，明暗 ×“减少透明”开关共四种组合；机器检查 G1 内容宽度、DL11a 上下留白与助手输入框底边、横向溢出、界面字体、当前项信号色、浏览器默认外观、焦点环、四级墨色对比度；结果按“违反签名”计数，与 `scripts/design-matrix-budget.json` 比较，只降不升。主题测试入口不需要另加：主题与透明度的真值在 Main，脚本用隔离 profile 上的 `theme.set` / `theme.setReduceTransparency` 加重启切换。基线：`outputs/design-matrix/2026-11-11-baseline-e42/`（Electron 42，第一次拿到暗色截图）。
  - T1：新增 §3.1 全部令牌（值按基准页；深色 stage、ink 各级随之对齐）；外壳 `theme-tokens.css` 的文字、底色、线、强调色、字体改为 `--rn-*` 的别名；四种强调色、四种皮肤及其设置项、状态、属性、样式分支全部删除（`glass-overrides.css` 410 → 59 行），恒为真的 `html[data-skin='liquid-glass']` 前缀等优先级地换成 `html:root`，所以级联没有移动；启动画面的 pink 变体随实色皮肤删除，品牌色统一为 `#ff5a1f`；日历的 `#ed511c` 改用 `--rn-accent`；窗口材质只看明暗。“减少透明”：Main 持有开关（`ui_reduce_transparency`），与系统的 `nativeTheme.prefersReducedTransparency` 任一为真即 `data-transparency='reduced'`：窗口底换成不透明的 `--rn-stage`，全应用不再模糊，浮层与液态玻璃退回纸色。旧皮肤设置一次性迁移（`window-material/theme-appearance.ts`，实色或稳定玻璃皮肤 → 开关打开，可重复执行），Renderer 删掉两个旧缓存键（`stores/theme-legacy-storage.ts`，退役标识检查唯一的白名单文件）。
  - 证据：巡检 `outputs/design-matrix/2026-11-11-t1-full/`，四种组合无步骤失败；与基线相比界面字体违反 434 → 240、当前项不是信号色 4 → 0、对比度违反 3 → 0，其余各项不变（内容宽度 8、上下留白 8、窄窗口溢出 1–2、浏览器默认外观 6，留给 W2 与 T4/T5）；可见窗口的系统截图（四种组合）确认玻璃与不透明回退正常。令牌预算：颜色 2134 → 1879，`backdrop-filter` 136 → 134，退役标识全部为 0。
  - 与计划的出入：① 基准页的 `--rn-ink-3`（.44）在浅色玻璃回退色上只有 2.95:1，达不到 §6 的提示文字 3:1，基准页与令牌一起改为 .46（3.14:1）。② “减少透明”下旧外壳面板的半透明底叠在不透明 stage 上，分区比玻璃下弱；这是过渡状态，T2 的纸与台落地后解决。③ 系统“减少透明度”在运行中切换时，是否触发 `nativeTheme` 的 updated 事件未实测；启动时一定生效。
