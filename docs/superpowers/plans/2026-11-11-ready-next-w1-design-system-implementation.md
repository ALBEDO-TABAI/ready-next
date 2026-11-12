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
| 设置 `--sx-*`（`styles/settings-surfaces.css`） | 映射后删除。B13：已删除，连同 inline 兼容层 `components/settings/settings-theme.ts`；设置页的版式类（`sx-card`、`sx-row` 等，前缀只是设置页自己的类名）搬到 `pages/settings/settings.css`，只用 `--rn-*`，控件全部换成共用基元 |
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
- 2026-11-12（B13 · 书房与画板）：**T5 书房与画板迁移完成。**
  - 书房样式：`library.css`、`shelf.css`、`reader.css`、`find/find.css`、`reader/page.css` 的颜色字面量与 `backdrop-filter` 都是 0。书与书架的实物光影收成 `tokens.css` 书房一节的令牌：`--rn-light` / `--rn-shade` / `--rn-cast` / `--rn-page-shade`（通道值，写成 `rgb(var(--…) / α)`，透明度留在原处，与 `--rn-amb`、`--rn-glass-tint` 同法），书架玻璃的高光与墙影 `--rn-shelf-gloss` / `--rn-shelf-face-gloss` / `--rn-shelf-wall`（深色值进令牌，删掉两条深色覆盖规则），书脊纸签与烫金 `--rn-cloth-label(-ink)` / `--rn-cloth-foil(-deep)`。书架玻璃正面（9px 高）的 `blur(10px)` 与取书对话框遮罩的 `blur(8px)` 删除，遮罩不透明度 90% → 92% 补回遮挡。阅读器里约 55 条没有消费者的旧规则（进度条、旧面板头、纸色圆钮、步进器、排版中 / 出错 / PDF 等，`.rd-*` 里组件早已不用的部分）删除。
  - 书页：`page.css` 会内联进 WebGL 书页栅格，读不到外部变量，所以颜色由书页自己带：`renderSheet` 排版时把读者选的纸色（`reader/papers.ts`）、书的布色（`topics.ts`）、划线色（`marks.ts` 的 `MARKERS`）和书页共用的几个令牌（信号点 `--rn-accent`、藏书票墨色 `--rn-paper-ink` / `-3`、光影）写到 `.sheet` 上（`--pp`…`--cf`、`--sig`、`--plate*`、`--mk-*`、`--light` / `--shade`），空白页同样带纸色；`page.css` 的 43 个字面量与兜底值全部去掉，仍然不读任何 `--rn-*`（`library-css-variables` 合同照旧）。藏书票上两个近似灰（#8a8278、#9a8f81）并到 `--rn-paper-ink-3`（#8f877a）；CSS 翻页的卷页阴影（`flipbook.js`）用 `--rn-page-shade`，书本边缘与装订线阴影用 `--rn-cast`（原 25,32,45 → 20,20,40，肉眼不可辨）。
  - 留作内容数据（白名单，原因写在 `design-budget.json` 与文件注释）：划线色 `MARKERS`（原有）、书脊布色 `lookOf` / `library-topics`（原有）、阅读纸色 `PAPERS`（从 `paginate.ts` 移到新文件 `reader/papers.ts` 并加入白名单——它是读者在排版里选的白纸、米黄、夜间，会印进书页栅格）。画板新建图形的默认描边 `#ff5a1f` 会写进画板文件，是图形自己的颜色，移到 `src/shared/ready-canvas/graphics.ts` 的 `DEFAULT_GRAPHIC_STROKE`；画板实验页的合成图片移到它的测试夹具。
  - 字体：书房没有另载界面字体；`reader/pageStyles.ts` 的一处 `@font-face` 是把同一个 Geist Mono 文件以 data URL 嵌进书页栅格（SVG 栅格取不到网页字体），保留，`@font-face` 预算 6 不变。书页的宋体 / 黑体 / 楷体系统字栈与页边批注的楷体是读者选的阅读字体，保留。
  - 书房组件：书架搜索是 `Input`；分类筛选是 `Chip`（按下态；原来按下是信号色文字）；错误条按钮、取书对话框的“放回书架”“开始阅读”（原来是信号色实心，按 DL5 改为墨色主按钮）是 `Button`；空书架、无资料库、筛选无结果是 `EmptyState`；阅读器面板头是 `SectionHeader` 加关闭 `IconButton`，目录与书签是 `ListRow`，笔记的分组标题是 `SectionHeader`、“刷新标注”“编辑”是 `Button`，排版面板的字号与行距是新的 `Slider`，字体、纸色、双页 / 单页是 `Segmented`；划线浮层的颜色是带色点的 `Chip`，动作是 `Button`，关闭是 `IconButton`，批注是 `Textarea`；找书是 `.rn-float` 浮层，输入、格式、搜索、下载上架、验证码、取消 / 重试、更多书源的复选与分类都是基元。书房私有的 `menu.tsx`（按钮开合菜单）升为共享的 `toggleMenu`。划线浮层仍在阅读器内定位：它跟着选区、随忙碌状态与批注输入实时变化，浮层宿主的 `render` 在打开时定格，不适合；材质已是 `.rn-float`。从藏书阁导入的对话框 B9 已是 W1 对话框（设置页），未改。
  - 画板：工具条、右上角、选区条、面包屑的按钮是 `IconButton` / `Button`（在浮条里取圆形，与书房浮条一致；选中工具由信号色淡底改为基元的墨色按下态；图标 16px、线宽 1.5）。`ChromeMenu` / `MenuItem` 删除：“更多”（导出）、“图形”、“排版”用 `toggleMenu`，右键菜单是浮层宿主里的 `MenuList`，在指针处打开并留在画板以内（共享浮层新增 `bounds`），选一项先关菜单再执行；菜单在选中被点卡片的那次渲染之后才打开，读到的是新选区。“链接…”“文档卡…”在同一位置接一个浮层表单（`BoardNewForms.tsx`），卡片写完才关，保留“写入期间画板忽略右键”的时序。原来右键菜单里的“正在添加…”与错误行去掉：失败显示在画板的提示行，再右键即可重试。回收站按钮与空状态、草稿卡与“继续保存”的按钮、旧画板的转换按钮、编辑中的“完成编辑”、搜索框都是基元。便签底色从 ink 私有的 `--ink-yellow-background-secondary`（ink 迁移后已删除）改为写作者内容色板里同值的 `--doc-yellow-bg`（便签就是 JSON Canvas 的 3 号黄，属于内容颜色；`surface.css` 自己引入 `content-palette.css`，画板实验页也有）。画板卡片底色保持 `--rn-on-inverse`：试过改成纸 `--rn-sheet`，深色下卡片与簇轮廓的填充同色、看不出卡片，留给 W4 的画板外观。
  - 共享基元的小改动（迁 ink 的同事也可能动这几处）：`Slider`（`Field.tsx` 与 `primitives.css` 的 `.rn-range`：发丝轨道、墨色进度、纸色旋钮；展示页加了两例）；`toggleMenu`（`float/open-menu.tsx`，原书房私有）；浮层 `bounds`（`float-store.ts`、`Float.tsx`：浮层留在给定矩形里，默认仍是窗口）。三者各有行为测试。
  - 书架的统计行原来整行用等宽字，按 DL7 改为数字等宽、文字用界面字体。设计矩阵把书页 `.rn-library .sheet` 计为内容（原来写的是不存在的 `.rn-library .page`，书页正文的宋体被算成界面字体违规），与 `.rn-reader-page`、书脊同理。
  - 预算：颜色 1327 → 1208（`modules/library` 54 → 0、`library/find` 1 → 0、`library/reader` 61 → 0、`components/canvas/surface` 2 → 0、`modules/canvas/interaction` 1 → 0），`backdrop-filter` 85 → 82（书房 3 → 0），`@font-face` 6 不变；`design-budget.json` 用 `--write` 下调，白名单加 `reader/papers.ts`。与 ink 合并后全仓颜色 899、`backdrop-filter` 65、`@font-face` 5，均在预算内。设计矩阵的 uiFont 预算 6 → 0（书房两屏原有的 5 个签名清零；合并 ink 后命令面板那一个也没了）。
  - 证据（真实窗口全部隐藏启动、临时 profile 与测试资料库，`HOME`、`TMPDIR` 指向临时目录；无网络、无模型；提交 `681df7e3d`，与 ink 合并后 `584b0439d`）：`npm run typecheck` 通过；书房、画板与基元的界面测试 91/91（新增滑块、浮层 `bounds`、`toggleMenu` 三项；画板右键菜单的测试改为在浮层宿主里找菜单，并验证菜单在指针处打开、选一项即关、失败后再右键可重试），书房的原生界面测试 7/7；`npm run verify` 在合并后的代码上分段跑（`rebuild:native` 要联网下载头文件，跳过）：原生 506/506；并行整套 8291 项中 7338 通过、952 项是普通 Node 下跳过的原生用例、1 项失败——rrule 一年窗口 200 ms 的性能用例在整机负载 86–106 时测得 420 ms，单跑 108 ms 通过；技能子进程 139 通过、3 项跳过；串行性能 39 通过、5 项跳过、1 项失败——DB4 p95 108 ms（上限 100），单跑一遍串行性能 40/40、p95 80 ms；界面合同 37/37；silent-catch、外开、拖拽格式、CSS 分层、设计令牌、快捷键、IPC 合同、版本同步都通过（合并前跑的那一遍原生 505/506，唯一失败是 DB-B 首屏 502 ms，上限 500）。真实窗口：合并前 `verify-ready-next-canvas` 全程通过（8 次读回加总门）、书房 48/48、导入、sources、capture 55 项、smoke 44/44、胶囊 22/22、今日 34/34；合并后同一组再跑全部通过（书房 5 次里 3 次 48/48，另 2 次见下面 ④）；再合并浏览器 B12c（`e031e64ea`，无冲突）后画板与书房 48/48 各跑一遍通过。设计矩阵比较模式：合并前 `outputs/design-matrix/2026-11-12-b13-library-final/`、合并后 `outputs/design-matrix/2026-11-12-b13-library-merged/`，四种组合都在预算内、没有步骤失败，书架、阅读器、画板三屏零违规。截图：改前与改后的书架、导入与排序菜单、找书、取书与翻开封面、阅读器双页与单页、选区条、划线浮层、排版、目录、笔记、从藏书阁导入，画板、右键新建与链接表单、卡片菜单、选区条、更多、图形、搜索、回收站，浅色、深色、深色减少透明各一套，在会话临时目录 `b13-lib/shots-before/`、`b13-lib/shots-after/`，逐张看过。
  - 截图里看出并修掉的：链接表单的输入框没有撑满；画板卡片改成纸色后深色下与簇轮廓同色（撤回）；图形菜单在旧的共享菜单里没有图标（ink 合并进来的“勾选项保留图标”之后恢复勾选）。
  - 没做的与出入：① `components/document/book/**` 与 `styles/document-book*.css` 是文档的书本阅读模式（`DocumentMode` 引用），不属于书房，没动。② 划线浮层留在阅读器内定位（原因见上）。③ 画板卡片的底色与台面材质（卡片是纸、台面是台）留给 W4 的画板外观。④ 书房窗口检查在合并前后共 8 次运行里有 3 次停在最后的“引用卡 → 打开原文 → 返回”：失败时的诊断快照显示返回键指向更早一次打开的书（“返回 验收用书”），而不是刚新建、还在“等待确认”的文档草稿，像是草稿尚未确认时导航历史没有记下它。这一步在文档草稿与导航历史里，本批没有改动；想在 ready-next 基线上跑对照，临时检出的基线在本机起不来（已删除），所以没有对照结论，记为待查。⑤ 菜单项的可访问名称包含快捷键提示（如“文字卡T”），是共享 `MenuList` 的现状，我的截图脚本用前缀匹配。⑥ `rebuild:native` 要联网下载 Electron 头文件，没有跑；原生模块已是 Electron ABI（`native:check` 通过）。
- 2026-11-12（B13 · 外壳、助手与独立窗口）：**T5 外壳、助手面板与独立窗口迁移完成；外壳的橘红焦点环从根上换成墨色。**
  - 焦点：外壳 `base-chrome.css` 未分层的全局 `:focus-visible`（2px 信号色，压过一切分层规则）改为放进 `@layer base` 的墨色描边（1.5px `--rn-ink-3`、外移 1px，与基元相同）。自己画焦点的控件（基元输入框的墨色边、菜单的高亮行、图标栏的底块）因为样式在更后的层或未分层，自然胜出，不再需要局部补丁；已删除的补丁：`primitives.css` 末尾那条未分层的 `.rn-field:focus-visible`、日历 `app.css` 的按钮墨色环与三处输入框去环、资讯 `rss-feed / rss-manage / rss-digest / rss-controls / rss-reader / rss-sieve` 里八条重复的墨色环（只留与默认不同的圆角或外移）、外壳图标栏与图标列各自的焦点环、助手链接与代码复制按钮的橘红环（`markdown.css`）、附件预览动作按钮引用未定义变量的环。`Menu.tsx` 里“外壳未分层的焦点环会胜出”的注释随之改写。真实窗口（隐藏）里 10 类控件在浅色、深色、深色减少透明下聚焦，计算样式全部是墨色 1.5px（改前图标栏为信号色 1px、助手标题按钮 / 输入框按钮 / 文件面板按钮为信号色 2px）。Tailwind 的 `outline-none` 只出现在自己画焦点的输入框上，层级下移没有让按钮失去焦点环。
  - 样式（全部只用 `--rn-*`，颜色字面量与 `backdrop-filter` 均为 0，外壳别名 `--bg-* / --text-* / --surface-* / --color-* / --lg-* / --chat-menu-* / --input-slot-*` 等使用 0）：`workbench-surfaces`、`flat-chrome`、`base-chrome`、`workbench-sliders`、`startup-preview`、`mode-switch`、`electron-shell`、`chat-utilities`、`liquid-composer`、`attachment-preview`、`glass-overrides`。删掉的死规则：日历旧助手抽屉与工具条（约 370 行，类名已无引用）、`calendar-mode-shell`、`workbench-toolbar-row / -panel / -content`、`t-title-lg / t-label-sm`、`flex-center / animate-* / aspect-square`、`.glass-surface-floating`、`.ready-glass-button`、`.ready-floating-menu*`、`.chat-header-floating-menu*`。
  - 材质：模式外框（`.workbench-canvas-shell`、模式根）只做裁切、透明；资讯的内容框是纸（`--rn-sheet` + 纸影 + `--rn-r-sheet`，`rss-workspace.css` 里等外壳迁移的那段模块底色一并删除），顶栏 `.workbench-tabs-surface` 在玻璃上、没有底色和模糊；文档内的 `.document-content-frame` 只是纸里的裁切。窗口底 `.ready-app-bg` 浅色画 `--rn-glass-tint`、深色与全屏不透明底画 `--rn-stage`（原来是暖白与蓝黑渐变）。旧的 `glass-surface-panel / -card`、`content-surface-panel` 只剩令牌外观、不再模糊；FastCard 结果、附件预览、关系图谱的浮动面板 `.ready-app-liquid-panel` 只给浮层颜色与投影，模糊来自 `.rn-float`（FastCard 结果与附件预览已加上该类）。输入框兜底规则（未换基元的原生输入框）改成 Field 的样子：`--rn-fill`、发丝边、聚焦墨色边。分段与标签的滑块胶囊（`MorphSegmentedControl / MorphTabStrip`）是 `Segmented` 选中项的样子（纸色加卡片影），不再有渐变与模糊。
  - 助手输入框保持 B4 之前的液态玻璃（用户指定）：纱、发丝边、边缘高光环、圆角 18 都不变，只是把字面量收进令牌：新增 `--rn-liquid-r`（18px，原来借外壳的 `--workbench-canvas-radius`）、`--rn-liquid-ink / -ink-2 / -ink-3 / -placeholder / -hair / -hover`（浅色等于墨色级别，深色保留原来的柔灰），深色投影纱并入 `--rn-liquid-projection-veil` 的深色值；深色发送按钮用 `--rn-inverse / --rn-on-inverse`。改前改后的输入框截图逐像素比对：浅色平均差 2.9 / 255（最大 13，来自随内容变化的折射投影），外观不变。
  - 图标栏：选中字形的白色发光、浅色底块与光晕收进 `--rn-rail-glyph / -tile / -glow / -glow-rest`（只有图标栏用）。**侧栏收起时底块消失、只留字形**原来没有接线（`ShellRail` 一直传 `expanded`），现在由外壳把侧栏是否在屏幕上（停靠或滑出）传给图标栏；`shell-rail.test.tsx` 加了收起时 `is-remembered` 不带底块的断言。导航器里的当前行仍是信号色淡底和信号色图标。
  - 组件（三个并行的子任务 + 收口）：助手（`components/agent/**`）、文件树与侧栏面板（`components/layout/**`，技能中心除外）、标签组（`components/tabs/**`）、`/ready` 页（`components/ready/**`、`pages/ReadyMode.tsx`）、启动卡、`stores/fileAppearance.ts` 的颜色字面量与别名全部换成 `--rn-*`；文件与标签组的用户颜色指向用户内容色板 `content-palette.css`（`--doc-*`），保存的键不变。私有件换基元：助手标题的操作菜单是 `openMenu`，会话行“更多”是浮层里的 `MenuList`，删除与改名是 `confirmDialog` / 带 `Input` 的 `openDialog`；@、/、授权、模型、项目这些跟随输入实时变化的列表留在 `FloatPanel`，行样式统一；文件树的删除确认与自定图标是共享对话框（`file-tree/dialogs.tsx`），筛选菜单与“网页拖进来”菜单是 `FloatPanel + MenuList`，工具条与缩略图按钮是 `IconButton`，搜索是 `Input`，空状态是 `EmptyState`；问答卡的选项是 `Chip`、提交是主按钮（墨色）；任务卡的关闭与回复的悬停动作是 `IconButton`。旧 `components/ui/Modal.tsx`、`useModal.ts`、`floatingMenuStyles.ts` 已无引用，删除（DS4）。外壳的 `components/layout/ContextMenu.tsx` 保留原来的属性接口，改由共享浮层绘制（`openFloat` + `MenuList`：浮层材质、键盘、原生网页层让位），所以文件树兜底、助手选区、文档编辑器、技能中心的右键菜单无需改调用就成了同一份菜单；新增行为测试 `shell-context-menu-float.test.tsx`（条目 / 提示 / 危险行、选择只执行一次、Esc 与点外面关闭、调用方重渲染时菜单不重开且执行最新的处理函数）。DL5：只有“正在进行”（任务运行、助手指针、锁定提示的 Agent 态、宠物工作中）用信号色；完成与中性状态是墨色，状态色用 `--rn-ok / --rn-warn / --rn-bad`；装饰性的蓝与橘改为墨色。
  - 浏览器的地址栏（`.browser-header-surface`）与分屏缝的填色暂时保留旧的模块底与模糊：网页框（`BrowserShellLayout`）在原生网页的上角画着同色的补角，地址栏单独换到玻璃上会露出补角，所以两者随浏览器工具条的迁移一起改（预算里 `styles` 的 2 个 `backdrop-filter` 即此处）。
  - 独立窗口：FastCard 浮窗的面板在 B4 已是浮层；本批把它的结果面板加上 `.rn-float`，窗口级的旧玻璃变量删除。全局快记（`FastCardOverlayWindow` 的快记编辑器）原来是无样式的原生按钮和看不见的文本框，改为一张铺满窗口的纸、`Textarea` 与 `Button`（主按钮“收进 FastCard”），标题行可拖动窗口。锁定遮罩与 Agent 指针的行内样式（蓝色、`#172033` 等 16 个字面量）改为 `electron-shell.css` 里的令牌类：Agent 在操作是信号色，等你确认是 `--rn-warn`，关闭是 `IconButton`；指针圈用信号色、标签用反色墨。启动卡（`startup-preview.css`）跟随主题成为纸。渲染器启动失败的兜底页（`main.tsx`）改用令牌（样式表随该模块加载、`data-theme` 由 `index.html` 先写好）。宠物窗口的便签、气泡与控制条用 `.rn-float`。
  - 预算：颜色 1018 → 709，`backdrop-filter` 68 → 37，`@font-face` 5 → 5。分目录：`.` 67 → 48、`components/agent` 16 → 0、`components/agent/chat-panel`（含子目录）15 → 0、`components/layout` 24 → 4、`components/layout/file-tree` 33 → 0、`components/ready` 19 → 0、`components/startup` 2 → 0、`components/tabs` 6 → 0、`components/ui` 11 → 0、`pages` 33 → 17、`stores` 7 → 0、`styles` 563 → 418（`backdrop-filter` 39 → 14）；`design-budget.json` 用 `--write` 下调。
  - 证据（全部真实窗口隐藏启动、临时 profile 与测试资料库，`HOME`、`TMPDIR` 指向临时目录，无网络、无模型）：`npm run typecheck` 通过；`npm run verify` 各段分别跑（`rebuild:native` 要联网下载头文件，跳过；模块已是 Electron ABI）：原生清单 507/507；版本同步、silent-catch、外开、拖拽格式、CSS 分层、设计令牌、快捷键、IPC 合同通过；并行整套 8342 项、7386 通过、955 项是宿主 Node 上跳过的原生用例、1 项失败——输入框合同钉住了发送按钮的旧写法（之后把深色发送按钮改回与改前同亮的 `--rn-inverse`），断言已跟上、单跑 4/4；技能子进程 139 通过、3 跳过；串行性能 39 通过、5 跳过、1 项失败是 DB4 千行查询 p95（机器负载约 70，单跑 222ms，同一时刻在未改动的 `ready-next` 上单跑 365ms 同样失败；本批没有改 `src/shared` 与 `src/main`）；界面合同 37/37。读样式的合同测试 44 个文件 166/166。改动文件 ESLint 无新增错误或告警（`workbench-shell-alignment-contract` 的源码 grep 错误在 HEAD 已有；`floating-submenu-style-contract` 删一行导入后同一条旧违例的位置变了，`eslint-rules/baseline.json` 里该条换成新位置）。真实窗口：`verify-ready-next-shell` 51/51，`verify-ready-next-smoke-electron` 44/44（第一次 24/25：脚本按 `.chat-header-floating-menu` 找历史菜单，换成 `[data-chat-header-menu="history"]`），`verify-ready-next-today-electron` 34/34，`verify-ready-next-capsule-electron` 22/22，`verify-ready-next-browser-shell-electron` 52/52（带截图再跑 53/53；改前同一脚本带截图时 50/53，三项 T8 阅读划线超时），`verify-ready-next-capture` 55 项，`verify-calendar-electron` 70/70，`verify-ready-next-rss-sieve-electron` 11/11。设计矩阵比较模式 `outputs/design-matrix/2026-11-12-2026-11-12-b13-shell/`：四种组合在预算内、无步骤失败（每种 bandSymmetry 4、uiFont 5〔书房〕，其余 0，焦点环 0）。改前改后截图（四个模式的侧栏展开与收起、标签条、文件树、助手消息、输入框、⌘K、10 类控件的焦点、FastCard 浮窗、快记、锁定提示两种语气、Agent 指针两种状态、启动卡，浅色、深色、深色减少透明各一套，共 97 × 2 张，外加浏览器壳任务卡）逐张看过，留在会话临时目录 `b13-shell/shots/`。
  - 截图里看出并修掉的：资讯的模式根与外框在 RSSMode 里行内写着旧模块底色，原来靠外壳的 `!important` 透明盖住，第一次改写时去掉了 `!important`，深色下露出一块方角的蓝灰底，已恢复；浏览器地址栏单独换到玻璃上后，网页框的同色补角会露出来，改为与浏览器工具条一起迁移（见上）；深色发送按钮起初用 96% 的反色，比改前暗一点，改回 `--rn-inverse`（改后与改前平均差 0.05 / 255）。
  - 没做的与出入：① 纸的上下留白仍是 97 / 63（标签条在纸上方单独一行），属于 W2 的版式，本批按“保持布局”未动。② `LiquidTest.tsx`（`#/liquid-test` 透镜调参台）的 48 个颜色字面量没有换：它们是给折射看的测试背景，跟着调参台自己的明暗开关而不是应用主题，令牌表达不了；留给白名单或 T6 退役该页时一起处理。③ `styles/markdown.css` 只改了助手的代码块、表格外框与链接焦点，其余与文档预览共用的部分不在本批。④ 隐藏窗口拍不到系统毛玻璃：浅色玻璃现在是 `--rn-glass-tint`，在隐藏截图里纸与玻璃几乎同色、侧栏收起后图标栏的白色字形也很淡，要在可见窗口里看一次。⑤ 启动卡现在跟随主题（深色下是深色的纸），原来始终是白卡。⑥ `theme-tokens.css` 里外壳还在用的非颜色变量（`--app-bg-overlay-opacity` 及其明暗、全屏、减少透明分支，合同测试钉在该文件）要在 T6 搬到 `base-chrome.css`；别的模块里仍有外壳别名：`RSSMode.tsx` 与 `PreviewBrowser.tsx` 的模块底色、`MarkdownEditor.tsx`、`BrowserShellLayout.tsx` / `BrowserMode.tsx`、`rss-feed.css:253`、技能中心、`LibraryQuoteCard`、设置页，以及没有引用的 `WorkbenchProjectTabs.tsx`。⑦ 这些仍是各自的私有件：会话完成提示（测试要求面板内三条可点的堆叠，共享 `showToast` 是底带一行）、上下文用量的提示（测试要求立即出现且多行，`tooltip()` 有延迟）、附件预览的 36px 动作按钮、软失败胶囊的关闭按钮（换成 `IconButton` 会变高）、文件树行（拖放与原地改名，换 `ListRow` 会坏，外观已按 `ListRow`）、文件面板的列表 / 网格切换（`Segmented` 只接受文字）。⑧ `panelTokens.ts` 的值换成令牌后，技能中心里原来的蓝色随之变成墨色。
- 2026-11-12（B13 · 设置、浏览器工具条、关系图谱、技能面板）：**T5 这四块迁移完成，设置的 `--sx-*` 删除。**
  - 设置：`styles/settings-surfaces.css`（`--sx-*` 明暗两套，约 1280 行、97 个颜色字面量、2 个 `backdrop-filter`）与 inline 兼容层 `components/settings/settings-theme.ts` 删除。设置页自己的版式（分组、卡片、行、字段、表格、提示、状态、单选卡）搬到 `pages/settings/settings.css`，只用 `--rn-*`，由 `styles/index.css` 在原位置引入，级联顺序不变；类名前缀 `sx-` 保留（只是版式类名，别的同事的脚本与测试按 `.sx-row` 找行）。一组设置是一张纸（`--rn-sheet`、`--rn-r-sheet`、贴地影，原来是半透明白玻璃加投影）；卡里的列表、代码、预览是 `--rn-fill` 的填充区，不是纸上放纸。`settings-shared.tsx` 只留 `SettingsCard/Row/Group/Notice/Status` 等版式件，私有控件全部删除：`settingsButtonClass` 的约 90 处按钮换成 `Button` / `IconButton`，输入、多行、下拉换成 `Input` / `Textarea` / `Select`，`SettingsSwitch` 换成 `Switch`（要显示文字的用新加的 `SettingsSwitchLabel` 包一层），`SettingsSegmented` 换成 `Segmented`（远程助手的平台与“模型配置分区”换成 `Tabs`），复选框换成 `Checkbox`，键帽换成 `Kbd`，存储与浏览器数据两处手写的确认弹窗换成 `confirmDialog`。导航的分组标题是 `SectionHeader`，分区是 `ListRow`（30px，当前分区是信号色淡底与文字，与外壳侧栏的导航器一致；原来是 32px、托起的白玻璃）。顶部按 DL11a 改成一条 52px 的带（与技能中心同一外框，原来是 12px 外边距加 46px）。外观页的主题预览不再写死颜色：两块小窗口各带 `data-theme`，直接取那个主题的令牌。单选卡选中的样子与分段控件的选中项相同，右上角的勾改为墨色；正文链接（“访问 Ready 官方网站”）按 DL6 改为墨色加下划线。分组、卡片、行与说明文字的结构、文案、行为都不变。
  - 浏览器工具条：`components/browser` 的 13 个 `backdrop-filter` 与 3 个颜色字面量、`pages/modes/BrowserMode.tsx` 的 2 个 `backdrop-filter` 清零。悬浮的东西（“已保存登录状态”提示、上传胶囊、诊断条、助手监督面板、FastCard 保存与回执）用 `.rn-float`；盖住网页区域的遮罩（空白页、出错页、启动与过渡遮罩）是不透明的底色，不再自己模糊；外壳别名（`--text-*`、`--color-blue` 等）换成 `--rn-*`，`--workbench-*` 外壳变量保留。后退、前进、刷新、收藏、阅读视图开关、工具按钮、标签条的滚动箭头换成 `IconButton`，出错页的“重试”、空状态的“新建标签页”与诊断条的动作换成 `Button`。地址栏画成共用输入框的样子（填充加发丝边，聚焦时纸色加墨色描边，不用信号色）；阅读视图开关按下时是 `IconButton` 的按下态（白色发光字形只属于左侧图标栏，同资讯一批的结论），私有的 `.rn-reading-toggle` 样式删除；“订阅”保持 W7 的样子（本来就只用令牌）。没有导入者的 `BrowserSidePanel.tsx` 删除。网页原生层的让位与恢复（`data-ready-native-overlay`、`data-ready-native-surface`、遮罩与显隐意图）一处没改。提示条、助手的标签组、⌘F 查找条与地址建议在 B12 已是令牌与基元，本批只修了查找框被外壳全局输入框兜底规则画上方框的问题（加 `ready-input-slot-inner`）。
  - 关系图谱：浮层改用 `.rn-float`（原来自带模糊、半透明底与 `!important` 覆盖），悬浮预览是第二层 `.rn-float`，状态提示是墨色小片，关闭按钮是 `IconButton`；原来 `.knowledge-graph-workspace__header button` 一条规则把“图谱范围”分段控件的按钮也压成 32×32，“全工作区”被挤成两行，随这条规则一起删除。画布不再有自己的调色板：`graph-canvas-renderer.ts` 的明暗两套 14 个颜色改为 `readGraphPalette` 从画布所在处读取 `--rn-*`（每个主题读一次，不在平移的每一帧读）；按 DL5，孤立点、卫星点、枢纽点用三级墨色，信号色只留给指针下的节点和它的连线（原来卫星点与标签连线是橘红），画布背景去掉信号色的光晕。
  - 技能面板：技能追问卡是对话里一块 `--rn-fill` 的安静底（与浏览器任务卡同一种样子），答案行是纸色加发丝边，回复框是 `Textarea`，“提交回复”是墨色 `Button`（原来是写死的蓝色 `#3b82f6`，因为 `--accent` 变量并不存在）；样式在 `components/skill/skill-ask-user.css`。“已加载技能”从窗口顶部的私有胶囊改为共享的 `showToast`（下留白里的一行状态，DL11a）。
  - 共享基元的小改动：`SectionHeader` 接受 `className`（设置导航的分组标题要保留 `sx-nav-group-label`，外壳脚本按它数分组）；`Segmented` 的选项可带 `count`（模型列表按供应商筛选时显示数量）。
  - 令牌预算：颜色 1018 → 842（`styles` 563 → 440、`pages` 33 → 16、`components/graph` 18 → 0、`components/skill` 13 → 0、`components/browser` 3 → 0、`components/settings` 2 → 0），`backdrop-filter` 68 → 43（`styles` 39 → 29、`components/browser` 13 → 0、`pages/modes` 2 → 0），`@font-face` 不变；`design-budget.json` 用 `--write` 下调。设置、浏览器组件、关系图谱、技能面板里颜色字面量与 `backdrop-filter` 都是 0；`pages` 剩下的 16 个在独立窗口（Agent 指针、锁定遮罩），属于外壳一方。
  - 证据（全部真实窗口隐藏启动、临时 profile 与测试资料库，`HOME`、`TMPDIR` 指向临时目录，只用本地网站夹具与本地替身模型，无网络、无模型）：`npm run typecheck` 通过；`npm run verify` 各段分别跑（`rebuild:native` 要联网下载头文件，跳过；模块已是 Electron ABI）：原生清单 507/507；版本同步、silent-catch、外开、拖拽格式、CSS 分层、设计令牌、快捷键、IPC 合同通过；并行整套 8336 项、7381 通过、955 项是宿主 Node 上跳过的原生用例、0 失败；技能子进程 139 通过、3 跳过；串行性能 40 通过、5 跳过；界面合同 37/37。改动文件 ESLint 0 错误、没有新增警告（`verify:lint-budget` 里 `any`、未用变量与 hooks 依赖三项在改前就已超出，与改前计数相同）；A0 基线只把改过标题的 `settings-shell-visual-contract` 一条的指纹换成新的，条数不变。浏览器门：`verify:browser-surface` 通过（17/17、93 通过 7 跳过、135/135，工具层评测 45 通过 0 失败；与截图并跑的第一次在 attention.login 上失败一次，单跑改前改后都通过），`verify:browser-target-claims` 22/22、10/10、45/45。真实窗口：`verify-ready-next-browser-shell-electron` 52/52（设置导航的定位改为共用 `ListRow` 的 `.rn-row__label`），`verify-ready-next-shell` 51/51，smoke 44/44，today 34/34，`verify-calendar-electron` 70/70，capsule 22/22（与其他脚本连跑时在书房划线的 ⌘K 搜索上超时一次，与文档一批记录的相同，单跑通过）。设计矩阵比较模式 `outputs/design-matrix/2026-11-12-b13-settings/`：四种组合在预算内、无步骤失败，各项与预算持平（bandSymmetry 4、uiFont 5，其余 0），设置屏零问题。截图：改前改后各 135 张（浅色、深色、深色减少透明：21 个设置分区连同长页的滚动段、两个确认对话框、键盘焦点、运行时启动后的长期记忆；浏览器空白页、文章页工具条、地址建议、查找条、阅读视图、出错页、提示条与助手的标签组；关系图谱；技能追问与“已加载技能”），逐张对照看过，留在会话临时目录 `b13-settings/shots-before/`、`shots-after/`，并排图在 `pairs/`。深色正常透明度的隐藏截图整窗发白（改前也是，隐藏窗口拍不到窗口毛玻璃），颜色以深色减少透明为准。
  - 合入外壳一批（`275a92600`）之后：外壳特意留给本批的浏览器地址栏与网页框一起迁到玻璃上。`.browser-header-surface` 那条带模块底色和模糊的规则删除，地址栏所在的行与标签条一样在玻璃上；网页框不再在原生网页的上角与左下角画同色补角（`BrowserShellLayout` 的三块补角与 `fillBottomLeftCorner` 删除），网页本身就是纸：四角同一个纸的圆角，Main 里原生网页的圆角 `HOST_BORDER_RADIUS` 由 18 改为 20（`--rn-r-sheet`），空白页、出错页、阅读视图与启动、过渡遮罩用 `--rn-sheet` 和同样的圆角；“网页显示中”的判断改名 `showNativePage`，`data-ready-native-surface` 的条件不变。分屏的拖拽缝不再画渐变补色，宽度由 3px 改为 8px（两张纸之间的间距，DL11）。外壳列出的别名残留：浏览器的 `--workbench-*`（圆角与外壳底色）全部换成 `--rn-*`；设置页合入后没有残留；技能中心（`components/layout/SkillsCenterPanel.tsx`）的 51 处外壳别名与 4 个字面量换成令牌，“编辑技能”与“配置技能”两个对话框的卡片改为 `.rn-float`，蓝底白字的保存与取消、“前往设置”换成共用 `Button`（`panelTokens.ts` 外壳一批已换成令牌，原来的蓝色随之是墨色）。合入后预算：颜色 414 → 410、`backdrop-filter` 9 → 7（`styles` 的 2 个即地址栏那条规则）；`design-budget.json` 用 `--write` 下调。合入后的检查：`npm run typecheck` 通过；设计令牌、CSS 分层通过；并行整套 8346 项、7390 通过、956 项是宿主 Node 上跳过的原生用例、0 失败；界面合同 37/37；钉住旧地址栏模糊、补角、分屏渐变与遮罩圆角的六处源码合同按新样子改写。隐藏真实窗口：`verify-ready-next-browser-shell-electron` 52/52、`verify-ready-next-shell` 51/51、`verify-ready-next-smoke-electron` 44/44；浏览器的文章页、查找条、阅读视图、出错页、提示条与助手标签组在浅色与深色减少透明下重拍并对照（会话临时目录 `b13-settings/shots-after-merge/`、并排图 `pairs-merge/`）：地址栏一行在玻璃上，网页是四角圆的纸。设计矩阵比较模式 `outputs/design-matrix/2026-11-12-b13-settings-merged/`：四种组合在预算内、无步骤失败，bandSymmetry 4（W2 的版式），uiFont 0，其余 0。
  - 截图里看出并修掉的：查找框的方框（见上）；关系图谱头部被压扁的分段控件（见上）；技能追问的回复框起初是填充叠填充，一块发灰的井，改为纸色；原来带 `w-full` 的十个下拉（模型与外部服务的表单）换成基元后不再铺满，改为内层带 `w-full` 时整个下拉铺满（`:has()`），设置页给基元的宽度规则放在 `components` 层、特异性为 0，日历设置自己的 `.cal-set-*` 宽度不受影响；“开源许可”紧贴在版本卡下面（改前就有），补上分组间距。
  - 没做的与出入：① 长期记忆（3 处）、资讯底稿、ChatGPT 断开仍用系统 `window.confirm`，测试按它模拟；系统对话框不在网页层之下，没有换成 `confirmDialog`。② `styles/base-chrome.css` 第 454–457、473–475 行全局输入框兜底规则里的 `:not(.sx-input)`、`:not(.sx-textarea)`、`:not(.sx-select)` 与第 454 行注释已经没有对象，属于外壳文件，留给外壳一方删。③ 地址栏与分栏缝在合入外壳一批之后已迁移（见下）；`base-chrome.css` 里浏览器标签滚动条、已无使用者的 `.browser-address-shell` / `.browser-address-input` 与 `glass-overrides.css` 的 `.browser-address-bar` 是否还在，以外壳一批合入后的文件为准，本批没有再动外壳文件。④ 共用 `Switch` 在深色下关闭时的圆钮是纸色，在纸上不太显眼（改前设置页自己的开关是白色圆钮）；这是基元的样子，各模块一致，没有单独改。⑤ 共用按钮没有“平时安静、悬停变红”的样子，行内删除（模型 ID、MCP、Cookie、远程助手的解绑）改为普通幽灵按钮。⑥ 键盘焦点环：外壳一批已把全局焦点环换成 `@layer base` 里的墨色 1.5px，设置页没有加任何局部焦点补丁（`.sx-link`、`.sx-option` 自己画的也是同样的墨色描边）。
