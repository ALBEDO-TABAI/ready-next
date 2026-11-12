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
| `--ink-*` 与 ink 的 studio 变量（`src/renderer/modules/document/ink/ink.css`） | 映射到 `--rn-*`，删除私有调色板；`.ink-scope` 只保留排版相关的局部变量。B13：已删除；写作者给自己内容选的颜色（文字颜色与背景、标注块颜色、数据库选项标签）原来借用 `--ink-*` 色板，改为 `modules/document/content-palette.css` 的 `--doc-*` 数据（白名单） |
| 日历 `--c-*`（`modules/calendar/workbench/styles/app.css`） | 映射到 `--rn-*` |
| 日历 `--tp-*` 色板与 `geometry-tokens.ts` | 原计划作为日程颜色数据保留。B13 核实两者都没有消费者（日程颜色由 `src/shared/calendar/color.ts` 的 `PALETTE` 与 `colorFamily` 计算），且来自参考产品的令牌表，已删除并移出白名单；界面框架的值改用 `--rn-*` |
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
| 日历色板 1400 多个字面量 | 列为数据白名单，不强行令牌化；只迁界面框架用到的值。B13：这些字面量所在的两个文件没有消费者，已删除 |
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
- 2026-11-11（B4）：**T2、T3、T4 完成。**
  - T2 材质：`design/next/materials.css`（`@layer ready-next.materials`）给出根玻璃 `.rn-glass-root`、纸 `.rn-sheet`、台 `.rn-well`、浮层 `.rn-float` 四个类；“减少透明”下根玻璃换成不透明 stage，浮层的 `--rn-float` 本身变成不透明。令牌、材质、基元样式改由 `styles/index.css` 全局各引入一次（之前令牌只被文档模式和画板各自引入）。展示页第一块就是四种材质的明暗对照。
  - T3 玻璃引擎：`GlassSurface`（含 `glass.css`、`glass.ts`）删除，书房的工具条改用 `.rn-float`；`LiquidFloatingPanel` / `LiquidSurfaceLayer` 删除，15 个调用点（资讯的菜单、订阅设置、添加订阅源，助手的标题菜单、模型、附件、@ 与 / 菜单，文档的大纲与批注浮窗，FastCard）改用 `components/ui/float/FloatPanel.tsx`（浮层材质，不折射，仍带原生网页层让位标记）；没有消费者的 `LiquidGlassScene.tsx` 删除；项目胶囊与技能提示卡从镜片改为 `.rn-float`；旧玻璃留下的死样式（`lg-surface-*`、iOS 分段控件、文档模式开关、`ready-liquid-popover*`、滑块镜片）一并删除。现在源码里只剩一份引擎 `components/ui/liquid-glass/`（`LiquidLens`、`LiquidBackdropProjection`、`refraction-map`），只有助手输入框在用（另有它自己的调参台 `#/liquid-test`）。输入框外观改用 `--rn-liquid-*`（渐变纱、边、顶部高光、反光、投影，按基准页 `.liquid`），圆角 24（折射图、投影挖孔、内容同步）；“减少透明”时 `LiquidLens` 走新的 `engine='off'`：不生成折射图、不挂镜片层和投影克隆，输入框退回纸色、发丝边、卡片投影。令牌预算：颜色 1733 → 1541，`backdrop-filter` 130 → 111，已写入 `design-budget.json`。
  - T3 测量（隐藏窗口 120Hz，消息区垫 80 条消息，脚本与原始数据不入库）：浅色与深色的液态输入框，空闲、输入、滚动消息的帧间隔 p50 8.3ms、p95 9.2ms；滚动最长 9.7ms，没有超过 20ms 的帧；输入时 4 轮里有 2 轮各出现一帧 134–158ms 的长帧，都在重启后的第一次输入，用 Long Animation Frame 归因复跑 3 轮（期间输入框高度 111↔126px 变化 6 次）没有再出现，记为待观察。“减少透明”下没有镜片层和投影，输入与滚动最长 9.4ms。暗色的输入框颜色全部来自暗色令牌；“减少透明”的纸色浅色 `rgb(253,253,252)`、深色 `rgb(28,28,31)`。
  - T4 基元：`components/ui/` 下 Button / IconButton、Input / Textarea / Select、Switch / Checkbox / Segmented、Tabs、Chip / Kbd / SectionHeader / EmptyState / Skeleton、ListRow / Toolbar / ScrollArea / ResizeHandle、Toast，以及唯一的浮层实现（`float/`：`openFloat` 状态在 `float-store.ts`，`FloatHost` 渲染；菜单与右键菜单、提示、对话框都建在它上面，最多两层，每个浮层带原生网页层让位标记）；`App.tsx` 挂一次 `FloatHost` 与 `ToastHost`；旧 `components/ui/IconButton.tsx` 删除（接口兼容）。展示页 `#/design-system`（明暗两列 + 局部“减少透明”开关）已进巡检固定界面，四种组合零问题。行为测试 5 个文件 34 项（键盘、焦点、可访问名称、浮层层级与焦点、菜单键盘、提示计时、对话框、通知、展示页），测试发现标签的关闭按钮按回车或空格会切换标签而不是关闭，已修，并补了 Delete 关闭可关闭标签（WAI-ARIA）。另修两处：旧的全局输入框兜底规则盖住了基元输入框的底色（排除 `rn-field`）；巡检的“当前项信号色”检查不再把选中的标签当作当前项（选中标签按基准页用填充）。
  - 证据：巡检 `outputs/design-matrix/2026-11-11-b4/` 四种组合在预算内，与 B3 持平；外壳窗口脚本 `npm run verify:ready-next-shell` 27/27；`npm run verify` 整条通过（测试 7985 + 142 + 42 + 37 项，0 失败；887 项跳过是普通 Node 下原生模块的 ABI 跳过，由 `verify:native` 覆盖）。B4 改动波及的旧测试按“行为还在就改断言”处理：两份 jsdom 测试补上 `window.matchMedia`（输入框现在读主题仓库），输入框暗色材质的样式合同改为钉住 `--rn-liquid-*` 令牌，快捷键合同跟随解构后的写法。lint 的“组件文件混导出函数”与 hooks 依赖回到预算内（顺带修了 B3 留下的一条）；`verify:lint-budget` 不在 `npm run verify` 里，其中 `any` 与未用变量两项在 B4 之前就已超出预算，日历的一条 hooks 依赖来自 10 月，本批没有新增。
  - 与计划的出入：① “书房、助手输入框、菜单在真实窗口正常”只做了隐藏窗口截图与计算样式检查；隐藏窗口拍不到 macOS 的窗口毛玻璃，深色玻璃下的输入框要在可见窗口里看一次。② §5 表里“取代”一列的旧实现还在（各模块私有的按钮、菜单），按 T5 逐个模块迁移时删除；仍挂旧 `glass-surface-floating` 模糊的右键菜单、文件树菜单等也在 T5 改成 `openMenu`。
- 2026-11-11（B4 之后，用户看过深色的真实窗口）：**助手输入框的液态玻璃用回旧样式。** 用户原话：“输入框的液态玻璃样式还是应该用回旧的输入框的液态玻璃样式设计”。B4 按基准页 `.liquid` 改成的渐变纱、光泽和 24px 圆角撤回，恢复 B4 之前的样式：白纱（深色为烟灰 `rgba(26,26,26,.62)`）、0.5px 发丝边、1px 渐变高光环（浅色不透明度 .38、聚焦 .52；深色 .18）、圆角 `--workbench-canvas-radius`（18px），透镜半径 18。数值放在 `--rn-liquid-*` 令牌（veil、veil-edge、rim、rim-edge、ring、ring-drag、projection-veil），样式文件不写颜色字面量，令牌预算不变（color 1541）。B4 里与外观无关的部分保留：液态玻璃只在输入框；“减少透明”时关透镜、退回纸色（令牌的减少透明段）。证据：隐藏窗口里浅色、深色 × 正常、减少透明四种组合的计算样式与旧值逐项一致，截图在会话临时目录。DL4a 里“质感取自基准页 `.liquid`”一句以此为准作废。
- 2026-11-12（B13 · 资讯）：**T5 资讯迁移完成。**
  - 样式：七个 `styles/rss-*.css` 只用 `--rn-*`。资讯里的 `--sx-*` 全部退出：选中的卡片与胶囊用分段控件选中项的样子（`--rn-sheet` + `--rn-card-shadow`），悬停 `--rn-fill`，焦点用基元的墨色描边，危险与警告用 `--rn-bad` / `--rn-warn` 的淡底；外壳别名（`--text-*`、`--color-blue`、`--bg-content`）也直接换成 `--rn-*`。`flat-chrome.css` 里资讯独有的规则（订阅与刷新抽屉、添加订阅源、约 470 行）搬进 `rss-manage.css` 重写，合并选择器里的资讯项删除；`glass-overrides.css` 的原文预览进退场搬进 `rss-reader.css`；共享模糊规则里的 `.rss-preview-surface` 删除。
  - 模糊：资讯自己的 `backdrop-filter` 全部删除：内容框与外框只留外壳的 module surface 底色（与文档、浏览器同一框架，换成纸属于外壳的迁移）；状态提示、自动整理浮层、订阅抽屉改用 `.rn-float` 材质；工具栏的 CSS 提示与视频封面上播放标记的模糊删除。
  - 组件：导航与主题编辑的列表是 `ListRow`；按钮是 `Button` / `IconButton`；“更多”、排序、引用、多看 / 少看的原因是 `openMenu`；来源筛选是浮层宿主里的一张列表（每行带删除）；翻译选项与分析任务跟随实时进度，用 `FloatPanel` + `MenuList`；添加订阅源、时间提示的“创建日程”是浮层宿主里的对话框；删除订阅源、合并事件、登录或扫码验证的确认用 `confirmDialog`；输入、多行、下拉用 `Input` / `Textarea` / `Select`；开关用 `Switch`；日报 / 简报与简报的时间用 `Segmented`；分类筛选、“包含已移出的”、主题筛选、简报分类、搜索的“正文”用 `Chip`（按下态）；空状态与骨架用 `EmptyState` / `Skeleton`。`RSSExportButton` 改为 `modules/rss/export-query.ts` 的函数（“更多”菜单的一项）。资讯不再引用 `chatMenuSurfaceStyle`、设置页的 `settings-theme` 常量与旧 `ui/Modal`。布局与行为不变；导航行按 DL11 从 34px 变为 30px。
  - 基元的小扩展（共享）：`ListRow` 合并 `className`、支持 `disabled`；当前行的图标随行的信号色文字（白色发光字形只属于左侧图标栏，两个侧栏导航器看起来一样）；`Chip` 有按下态（`aria-pressed` / `aria-checked`，选中标签的填充）；`IconButton` 的 `aria-checked` 与按下同态；输入框聚焦时不再被外壳未分层的全局 `:focus-visible` 再套一圈信号色描边（`primitives.css` 末尾一条未分层规则）。
  - 令牌预算：颜色 1458 → 1435（`components/rss` 8 → 0，`styles` 578 → 563），`backdrop-filter` 103 → 89（`styles` 53 → 39），`@font-face` 不变；资讯的样式与组件里颜色字面量、`backdrop-filter` 都是 0。
  - 证据（隐藏窗口、临时 profile 与测试资料库、本地订阅源夹具、无模型）：`npm run typecheck` 通过；`npm run verify`（HOME 指向临时目录）原生 506/506；并行整套 8284 项中 7330 通过、952 项跳过（普通 Node 的原生 ABI 跳过）、2 项失败：一项是改动带出的资讯源码合同（登录与扫码验证改用 `confirmDialog`，断言已跟上，单跑通过），一项是 rrule 一年窗口的 200ms 性能用例在机器满载时 250ms，单跑 111ms；其后的技能子进程 139 通过、3 跳过，串行性能 40 通过、5 跳过，界面合同 37/37。`npm run verify:rss-sieve` 139/139、零跳过；资讯与基元的界面测试 115 通过、4 项 ABI 跳过。真实窗口：`verify-ready-next-rss-sieve-electron` 11/11、`verify-ready-next-capture` 55 项（资讯的“收下”按钮换成共享按钮，脚本的定位跟上）、`verify-ready-next-smoke-electron` 44/44、`verify-ready-next-today-electron` 34/34、`verify-ready-next-capsule-electron` 22/22、`verify-ready-next-sources` 通过（与设计矩阵并跑时在书房的选区浮动条上超时一次，单跑通过）。设计矩阵比较模式 `outputs/design-matrix/2026-11-12-b13-rss/`：四种组合都在预算内（每种 bandSymmetry 4、uiFont 6、nativeControls 4，资讯的屏幕只剩外壳共有的上下留白一项，当前项信号色 0）。改前改后浅色与深色截图（为你筛过的有无卡片、少看这类、全部、排序 / 来源 / 更多菜单、自动整理、阅读与选区浮动条、收下 / 引用 / 翻译菜单、来源抽屉、筛子设置、主题编辑、日报与简报、新建简报、添加订阅源）逐张看过，留在会话临时目录。
  - 没做的与出入：① 内容框换成纸、顶栏去掉外壳 `.workbench-tabs-surface` 的模糊，属于外壳的迁移，资讯不单独改，免得与文档、浏览器不一致。② `verify:rss-layout`（`run-rss-layout-acceptance.cjs`）没有跑：它不隐藏窗口，选择器也停在 W2 之前的外壳。③ 深色的隐藏截图偶尔整窗发白（改前也有）；同一时刻的 DOM 探针没有任何覆盖层，判断为隐藏窗口截图丢透明度的伪影，留待可见窗口确认。④ 选中行的图标起初按图标栏的规则做成白色发光字形，浅色下在信号色淡底上几乎看不见；按协调方的意见改回随行的信号色文字（与文档导航器一致），令牌 `--rn-glyph-*` 一并删除。改回后重拍了浅色与深色的导航截图，资讯与基元的界面测试 148 通过、4 项 ABI 跳过，`verify-ready-next-rss-sieve-electron` 11/11、smoke 44/44，设计矩阵比较模式 `outputs/design-matrix/2026-11-12-b13-rss-fix/` 四种组合仍在预算内、当前项信号色 0。
- 2026-11-12（B13 日历）：**T5 日历完成，参考产品的测量版式替换完毕（M8 §C）。**
  - 迁移：日历私有的 `--c-*`（连同 `--g-*`、`--sh-*`、`--m-*`、`--stage`、`--t-*`、`--ease`）删除，`styles/app.css` 重写为只用 `--rn-*`（440 → 349 行，颜色字面量 0，`backdrop-filter` 0）；网格与事件面板是两张纸（`.rn-sheet`，面板原来是带模糊的半透明白，暗色隐藏截图里发灰）。按钮与图标按钮换成 `Button` / `IconButton`；全部菜单（视图、日程与网格右键、日历菜单、事件面板的日历 / 忙闲 / 可见性 / 提醒 / 重复 / 时间 / 时区 / 颜色）换成浮层里的 `MenuList`，只有颜色行是日历自己的（日程颜色是数据）；重复日程的范围询问用 `openDialog`，删除日历用 `confirmDialog`（原来是系统 `confirm`）；前往日期、自定义重复、快速创建、订阅日历是浮层对话框；提示换成共享 `showToast`，撤销是它的动作；图层开关用 `Checkbox`、侧栏小标题用 `SectionHeader`、按键用 `Kbd`、输入用 `Input` / `Textarea` / `Select`，全天用 `Switch`；画板“安排日程”的表单同样换成基元。浮层关闭后焦点回到日历，快捷键继续可用。设置 › 日历改用设置页自己的 `SettingsCard` / `SettingsRow` 与基元，原来的二级侧栏换成一行 `Tabs`；去掉与“外观”重复且保存后会被立即改回的主题单选、没有作用的“所有视图快捷键”链接和事件面板顶上不能点的“日程 ⌄”。
  - 删除的参考数据：`styles/tokens.css`（921 行，约 715 个颜色字面量）与 `geometry-tokens.ts`（约 711 个颜色字面量加网格、日程块、交互三张尺寸表）都没有消费者——日程颜色由 `src/shared/calendar/color.ts` 计算——且是参考产品的令牌表，删除并移出白名单（§3.2、§9 已同步）。三处日程颜色兜底值收进 `color.ts` 的 `DEFAULT_CALENDAR_COLOR`（数据库默认日历色）与 `NEUTRAL_EVENT_COLOR`（色板灰）。
  - 新几何（`workbench/geometry.ts`，样式用同一组令牌）：列头与月视图列头一行高（`--rn-row-h` 30）；全天条一个控件高（`--rn-control-h` 28），两行时正好一条带（`--rn-band-h` 52）；半小时一个控件高，所以一小时 56（`--rn-s14`），一刻钟 14，缩放每级加减一刻钟，上限四倍；时间栏每个时区一列 56（容纳 `--rn-fs-2xs` 的“上午 10 时”和 `--rn-s2` 内距）加 8 的前缘，单时区 64，网格窄于 300 时让到五分之一、不少于 40（`--rn-s10`）；日程块按基准页 `.ev`：标题 11px（`--rn-fs-xs`）、时间 10px，行距 1.35（15 / 14 px 行框），3px 色带，上下各 4（`--rn-s1`），右侧留 8（`--rn-s2`）可点空白；全天与月视图的条 20（`--rn-s5`）高、行距 4；月格日期在一个控件高的行里（20 的药丸、四周 4），装不下的日期用最后一行写“其他 N 个”（原来格子矮时它会盖到日期上）；事件面板宽度同侧栏（`--rn-sidebar-w` 248），每个字段是 28 的控件放在 30 的行里，16px 图标（`--rn-icon`）后隔 8 是文字，缩进行从 32（`--rn-s8`）起与上文对齐；面板头与工具行一条带高；月份用 `--rn-fs-3xl`，年份衬线 `--rn-fs-4xl`；层级数字改成网格内自己的顺序。“measured from the reference”的注释与悬空的 `docs/SPEC-NOTES.md` 引用一并删除，`geometry.ts` 与样式开头写明每个数的来由。
  - 预算：颜色 1458 → 1350（日历三个目录 3 / 9 / 96 → 0，另有白名单内约 1426 个字面量随文件删除），`backdrop-filter` 103 → 99（日历 4 → 0），`@font-face` 不变；`design-budget.json` 用 `--write` 下调。
  - 证据（提交 `8e1c67388`；全部真实窗口隐藏启动、临时 profile 与测试资料库，`HOME`、`TMPDIR` 指向临时目录）：`npm run typecheck` 通过；`npm run verify:calendar` 182/182（含新增 `calendar-floats-ui.test.tsx`：视图菜单是带名字、可勾选的共享菜单，选择写入偏好；日程右键是颜色行加共享菜单；“.”只开一个日期框，输入日期后跳转并关闭；提示是共享提示、撤销是它的动作；几何与 `tokens.css` 的令牌逐项相等），日历原生 11/11；`npm run verify` 各段分别跑（`rebuild:native` 需要联网下载头文件，跳过；模块已是 Electron ABI）：原生清单 505/506，唯一失败是 DB-B 首屏 <500ms，单跑 470ms 通过（当时负载约 75）；并行整套 8286 项、7333 通过、952 项是宿主 Node 上跳过的原生用例、1 项失败（`codex-model-gateway-retry` 的上游头部超时用例，与日历无关，单跑通过）；技能子进程 139 通过、3 跳过；串行性能 40 通过、5 跳过；界面合同 37/37；silent-catch、外开、拖拽格式、CSS 分层、设计令牌、快捷键、IPC 合同、版本同步通过；改动文件 ESLint 0 错误、无新增告警。真实窗口：`verify-calendar-electron` 70/70（菜单、范围对话框、自定义重复按共享基元的角色点按；“网格与事件面板是纸”取代“圆角 24、无投影”），smoke 44/44，今日 34/34，胶囊 22/22；设计矩阵（比较模式）四种组合在预算内、无步骤失败，`nativeControls` 4 → 0（原来是日历图层的四个系统复选框），`design-matrix-budget.json` 按本次计数下调，报告在 `outputs/design-matrix/2026-11-12-b13-calendar/`。截图：改前与改后的周、月、日、事件面板、视图菜单、日程右键、重复菜单、自定义重复、前往日期、1100 宽周视图、设置 › 日历（通用与日历列表）、侧栏，浅色、深色和深色减少透明各一套，在会话临时目录 `b13-cal/shots/`。
  - 截图里看出并修掉的：按钮清零规则的特异性盖过了日历自己的类（面板字段没有内距、待办圆圈消失），改用 `:where()`；选中日程的时间行在暗色下看不见（行内样式的 `--fg2` 压过类规则）；结束日期一行没有对齐；外壳全局 `:focus-visible` 的橘红外框叠在共享输入框上，日历范围内去掉（输入框自带墨色描边）。
  - 与计划的出入：① §3.2 原定保留 `--tp-*` 色板与 `geometry-tokens.ts` 作为数据，核实没有消费者后删除。② 日历侧栏的日历行带悬停工具（显示 / 更多），按钮不能嵌在 `ListRow` 的按钮里，保留为日历自己的行，尺寸与令牌按 `ListRow`。③ 日程颜色的推导 `src/shared/calendar/color.ts` 也注明“values measured from the reference”（17 色色板与明暗系数），属于颜色而非几何，不在本批，已记入 M8。④ 日历网格上下留白 59 / 63 的 `bandSymmetry` 来自外壳的内容区内距，与其他模式相同，留给 W2。
- 2026-11-12（B13 · 文档）：**T5 文档模块（ink）迁移完成。**
  - 令牌：`modules/document/ink/ink.css` 重写，只用 `--rn-*`：私有调色板 `--ink-*`（明暗各 60 多个）与 studio 变量全部删除，`.ink-scope` 只留排版变量 `--ink-font-serif`（写作者选的“衬线”页面样式，不是界面的展示衬线）；ink 另载的 Inter Tight `@font-face` 删除，页面标题、各级标题、首次启动卡改用 `--rn-font-display`，等宽改用 `--rn-font-mono`。页面本身是纸：`main.ink-main` 加 `.rn-sheet`（`--rn-sheet`、圆角 20、贴地影，原来是 studio-paper、圆角 24、无影）。打开的标签像 `Segmented` 的选中项（纸色加卡片影），去掉自己的模糊；树行与外壳侧栏的 `ListRow` 同尺寸同颜色（30px、`--rn-ink-2`，当前页信号色淡底与文字，去掉左侧色条）；数据库视图标签选中改用填充（与 `Tabs` 一致），看板卡片、表头、单元格悬停全用令牌。⌘K 与速览的面板（样式在 ink.css）改为 `.rn-float`，遮罩去掉模糊。
  - 写作者的内容颜色：文字颜色与背景（块编辑器 `dom-inline.ts`，原来借外壳的 `--color-*` 别名，所以“蓝色”字显示成信号橘红、“黄色”背景是一块深黄）、标注块颜色（`callouts.css`）、数据库选项标签（`cells.tsx`，原来借 `--ink-*-background/text-secondary`）收进一份数据 `modules/document/content-palette.css`（`--doc-<色>-fg/-bg/-rule`，明暗两套），按 §6 的“用户内容颜色”列入白名单；`callouts.css` 与块编辑器样式不再有字面量。
  - 浮层与基元：ink 私有的 `menu.tsx`、`overlay.tsx`（含 `OverlayHost`、`tip`）删除，文档模式不再挂自己的浮层宿主；ESLint 私有菜单禁用规则里 ink 那一条随文件删除，日历那一条保留。侧栏的新建菜单、行菜单（右键与“…”）改用共享 `openMenu` / `MenuList`（有歧义的页面在菜单下附一行说明）；改名、新建文件夹、图标、封面、回收站、页面选项是 `openFloat` 浮层；移动、恢复、收进资料库、模板、导入是浮层对话框（`rn-dialog`）；提示用共享 `tooltip`。按钮换 `Button` / `IconButton`（顶栏的收藏、大纲、页面选项，标签条的新建，行与分区的 +、…，回收站的恢复与删除，草稿的保存到…、重试、冲突比较，首次启动卡，数据库的工具与新建、单元格编辑与视图设置的取消 / 保存，评论面板，导入向导，模板），输入换 `Input` / `Textarea` / `Select`，页面菜单的小字、全宽换 `Switch`，“保存到…”选择器换基元（框只是一条发丝线，在浮层里由浮层做框），底部的阅读、关系图谱、查找与替换、模板、导入、回收站是 `ListRow`。页面菜单：字体卡片与小字、全宽在上（试样式时菜单不关），下面是一份共享菜单（复制链接、导出、书本阅读 / 书签与笔记 / 不让筛子看到 / Markdown 源码为可勾选项、移到回收站）。内容速览与书签笔记两个侧浮窗、评论面板、草稿面板、源码模式的选区工具条改用 `.rn-float`，各自的 `backdrop-filter` 删除。收藏的星形按 DL6 用墨色实心，不再是黄色。
  - 共享基元的小改动（另一位迁移书房与画板的同事可能也会碰）：`MenuList` 中带图标的可勾选项保留图标、勾在行尾（原来勾选项只显示勾，没有图标）；`IconButton` 在调用方展开 `tooltip()` 时不再同时出原生 title（与它注释里写的行为一致，展示页的“搜索”按钮因此不再双提示）；`ListRow` 的 `onClick` 带上点击事件（回收站浮层要以那一行定位）。
  - 其他：数据库单元格编辑与视图设置里的复选框原来 `appearance: none` 后勾与不勾一个样子，改为 `Checkbox` 基元的样子（勾选是墨色实心加勾）；PDF 阅读的底改成 `--rn-stage-2`、页面影用 `--rn-shadow-2`、搜索高亮用 `--rn-hl`；图片透明格用纸色与填充；epub 正文页取当时的 `--rn-sheet` / `--rn-ink` 值（书页文档读不到应用的令牌）；导出的 HTML、跳转闪烁、日期提及定位闪烁、书本页内组件的墨色改用令牌或书本自己的变量；没有消费者的 `documentTabPresentation.ts` 删除。
  - 令牌预算：颜色 1327 → 1018（`modules/document/ink` 207 → 0、`modules/document` 81 → 56、`components/document` 69 → 5、`components/document/book` 8 → 4、`modules/document/block-editor` 9 → 0），`backdrop-filter` 85 → 68（ink 15 → 0、`components/document` 2 → 0），`@font-face` 6 → 5（ink 1 → 0）；`design-budget.json` 用 `--write` 下调，白名单加一条 `content-palette.css`。巡检预算 `uiFont` 6 → 5（四种组合，文档标题的 Inter Tight 不再算违反；剩下的 5 条都在书房）。
  - 证据（全部真实窗口隐藏启动、临时 profile 与测试资料库，`HOME`、`TMPDIR` 指向临时目录，无网络、无模型）：`npm run typecheck` 通过；`npm run verify` 各段分别跑（`rebuild:native` 要联网下载头文件，跳过；模块已是 Electron ABI）：原生清单 506/506；版本同步、silent-catch、外开、拖拽格式、CSS 分层、设计令牌、快捷键、IPC 合同通过；并行整套 8288 项、7334 通过、952 项是宿主 Node 上跳过的原生用例、2 项失败——一项是本批带出的画板保存测试（“保留文档卡”换成共享 `Checkbox` 后测试还在找原生复选框，选择器改为 `[role="checkbox"]`，单跑 4/4），一项是 rrule 一年窗口 200ms 用例在满载时 308ms、单跑通过；技能子进程 139 通过、3 跳过；串行性能 39 通过、5 跳过、1 项失败是 DB4 千行查询 p95（`src/shared` 本批没动，单跑 91ms 通过、负载约 35 时再跑 109ms）；界面合同 37/37。文档与基元的界面测试 187 项（1 项是 M3 集成用例在普通 Node 的 ABI 跳过，由下面的 M3 窗口脚本在 Electron 里跑过），基元新增两条行为测试（带图标的可勾选菜单项；展开 `tooltip()` 的 `IconButton` 不再有原生 title），改动文件 ESLint 0 错误。真实窗口：`verify-ready-next-pages` 7/7，`verify-ready-next-block-editor` 9/9，`verify-ready-next-database` 8/8 加 `--checks` 10/10，`verify-ready-next-annotations` 4/4 加 `--checks` 14/14，`verify-ready-next-today-electron` 34/34，`verify-ready-next-smoke-electron` 44/44，`verify-ready-next-capsule-electron` 22/22（与其他脚本连跑时在书房划线的 ⌘K 搜索上超时一次，单跑通过），`verify-ready-next-m3` 组件与服务 15/15、窗口 8/8；`verify-ready-next-shell` 50/51，唯一失败的 S6 找的是设置 › 日历的 `set-nav-general`，这个标识在日历迁移（`8e1c67388`）换成一行 `Tabs` 时已删除，与本批无关，留给日历或外壳一方更新脚本。设计矩阵比较模式 `outputs/design-matrix/2026-11-12-b13-ink-a2/`：四种组合在预算内、无步骤失败，文档的固定界面（今日、页面、斜杠菜单、数据库、画板）零问题，`uiFont` 可降到 5 并已下调。改前改后的浅色、深色、深色减少透明截图（今日、带块的页面、侧栏树、行菜单、新建菜单、回收站、页面菜单、提示、页面头部与图标选择、斜杠菜单、块菜单、选区工具条、数据库表格 / 看板 / 视图设置、查找与替换、草稿页与“保存到…”、模板、1100 宽页面）逐张看过，留在会话临时目录 `b13-ink/shots/`（`before/`、`after/` 各 64 张）。
  - 截图里看出并修掉的：页面菜单的开关项起初换成共享菜单的勾选项后既没图标也看不出开关状态（于是给共享菜单加了“图标在前、勾在后”）；底部 `ListRow` 的图标与文字和树行差 5px（对齐到 8 + 22 + 8）；页面菜单里开关行与菜单项的左边距差 6px；新建菜单选“文件夹”时“+”已随指针离开而隐藏，改名浮层会定位到窗口左上角（原来也有这个问题，改为用打开菜单时量下的位置）；数据库复选框（见上）。
  - 没做的与出入：① 外壳未分层的全局 `:focus-visible` 仍会给键盘聚焦的按钮套一圈橘红；输入框由 `primitives.css` 末尾那条 `.rn-field:focus-visible` 兜住，文档模块没有加第三处局部补丁，留给外壳迁移从根上去掉。② `InkTabStrip` 没有换成共享 `Tabs`：文档标签要拖动排序、中键关闭、未保存点、今日系统标签和横向滚动，共享 `Tabs` 都没有；外观已按令牌与选中项的样子对齐，新建按钮是 `IconButton`。③ `mermaidRenderCache.ts` 的 56 个颜色是 Mermaid 主题变量（Mermaid 要具体色值来推导，且与 Widget 主题同源，归 Widget 合同），`ArtVideoPlayer.tsx` 的 5 个是视频播放器的黑底与主题色，书本的翻页阴影与自选背景色（取色器要十六进制）共 4 个，都留着；`styles/document-book*.css`、`document-widget-*.css`、`document-preview.css` 不在 `modules/document`、`components/document` 内，本批没动。④ `design/next/fonts/InterTight.woff2` 已不被引用（不会打进包），文件与 M8 许可清单里的 Inter Tight 一项留给 T6 一起删。⑤ 画板 `components/canvas/surface/surface.css` 的便签卡用 `var(--ink-yellow-background-secondary, var(--canvas-card))`，`--ink-*` 删除后便签退回卡片底色；画板不在本批范围，正在迁移画板的同事可改用 `--doc-yellow-bg`。⑥ 数据库视图设置里的下拉、输入与复选框仍是原生控件加 `database.css` 的令牌样式（测试按原生控件操作），没有换成基元。
