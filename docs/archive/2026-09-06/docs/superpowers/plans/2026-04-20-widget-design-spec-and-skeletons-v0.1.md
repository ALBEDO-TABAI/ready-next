---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Widget 设计规范 + 骨架清单 v0.1（对齐稿）

> 起草时间：2026-04-20
> 状态：**已对齐 2026-04-20**（O1–O8 已闭环，工程拆解见 §8）。
> 背景：把当前 20 种 OpenUI component 塌缩为「少量骨架 + 统一规范 + LLM prompt 发挥」的第三条路。

---

## 0. 目的与非目的

**目的**
- 用 5–8 个**构图母题**替代 20 个**成品组件**，保留现有视觉质量，减轻 LLM 选择负担与三处同步成本（TS / renderer / prompt）。
- 把散落在代码里的设计约束（`widget-css-bridge.ts`、sanitizer 白名单、prompt 模板）凝成**一份显式规范**，可按需注入 LLM、可版本化、可被用户主题覆盖。
- 为"导出静态图（主）+ 导出视频（次）+ 嵌入文档（辅）" 三个消费路径在**架构早期**统一留出接口。

**非目的（v0.1 不做）**
- 不做 Live 独立分享（share server / 独立 HTML bundle 导出）——1.0 之后再谈。
- 不做真流式渲染优化（导出图优先场景下价值低）。
- 不重写 sanitizer / theme bridge / export pipeline——这些已经工作，只是在规范里**显式化**它们的契约。
- 不替换 Tiptap 内联渲染路径——骨架化是内部变化，宿主侧接口不变。

---

## 1. 设计规范 v0.1

### 1.1 尺寸系统

卡片是**固定画布**，不是响应式。LLM 在生成时必须选择一个枚举尺寸，用户可在编辑器中切换尺寸（切换时骨架负责重排）。

| 尺寸 ID | 比例 | 像素（导出 @2x） | 主要用途 |
|---|---|---|---|
| `square_card`     | 1:1   | 1080 × 1080 | 社交分享（小红书 / IG / 朋友圈）、金句卡、笔记卡 |
| `portrait_card`   | 9:16  | 1080 × 1920 | 手机竖屏分享、故事卡、日报 |
| `story_card`      | 4:5   | 1080 × 1350 | IG feed、竖版信息卡（中等密度） |
| `landscape_card`  | 16:9  | 1920 × 1080 | PPT 内嵌、横版摘要、对比卡 |
| `landscape_4_3`   | 4:3   | 1600 × 1200 | 老式 PPT、横版报表、对比卡（密度高于 16:9） |
| `a4_portrait`     | √2:1  | 2480 × 3508 | 打印 / 导出 PDF / 单页文档卡（默认 @1x 即印刷尺寸） |
| `doc_block`       | auto  | 宽 720，高自适应 | 文档内联块（现有 Tiptap 内联路径） |

**渲染约束**：
- `square / portrait / story / landscape` 四种在**编辑/预览态都以固定画布呈现**（外框可见、不随容器缩放）
- `doc_block` 是现有内联模式，宽度 100% 跟随容器，高度 auto
- 导出 @2x 是默认值；后续可加 @3x 选项

**LLM 选择规则**（写进 prompt 规范片段）：
- 用户提到"分享 / 小红书 / 朋友圈 / 故事 / 手机" → `portrait_card` 或 `square_card`
- 用户提到"PPT / 横版 / 汇报" → `landscape_card`（默认）；老式比例 / 投影仪 / 4:3 → `landscape_4_3`
- 用户提到"打印 / PDF / A4 / 单页" → `a4_portrait`
- 用户在文档内点"插入卡片"不指定尺寸 → 默认 `doc_block`
- 信息密度高（>8 项数据） → 倾向 `landscape_card` / `landscape_4_3` / `portrait_card`，避免 `square_card` 拥挤

---

### 1.2 色彩系统

**基础层（已存在，保留）**：`widget-css-bridge.ts` 里的 14 个语义变量是硬基底，骨架样式必须通过这些变量取色，不得硬编码颜色（导出时能随主题切换）。

**强调色 ramp（新增，v0.1 提议 6 组）**：

| Ramp | 50 (背景) | 200 (边框) | 400 (点缀) | 600 (副标题) | 800 (主标题) | 语义建议 |
|---|---|---|---|---|---|---|
| Indigo  | #EEF2FF | #C7D2FE | #818CF8 | #4F46E5 | #3730A3 | 默认主色、常规信息 |
| Emerald | #ECFDF5 | #A7F3D0 | #34D399 | #059669 | #065F46 | 正向、达成、增长 |
| Amber   | #FFFBEB | #FDE68A | #FBBF24 | #D97706 | #92400E | 提醒、待办、高亮 |
| Slate   | #F8FAFC | #E2E8F0 | #94A3B8 | #64748B | #334155 | 结构、中性、辅助 |
| Rose    | #FFF1F2 | #FECDD3 | #FB7185 | #E11D48 | #9F1239 | 警示、强调、情绪 |
| Sky     | #F0F9FF | #BAE6FD | #38BDF8 | #0284C7 | #075985 | 数据、信息、链接 |

**规则**（写进 prompt 规范）：
- Indigo 是默认主色；单张卡片用 2–3 个 ramp，Slate 留给结构元素（分隔、次要 icon）
- 卡片外层背景用 `--bg-content`（主题感知），ramp-50 只用于内部 token（badge / pill / chart fill）
- 图表填充用 ramp-400 + 透明度 0.1；边框用 ramp-200；标题用 ramp-800
- Chart.js 里因 canvas 不支持 CSS 变量，强制使用 ramp 十六进制值
- 夜间模式：ramp 反转规则由 `widget-css-bridge.ts` 的 `isDark` 分支负责（v0.1 沿用现状，不动）

**与现有 5 色变量（blue / blue-light / green / orange / red）的关系**：
- 现有 5 色是**主题 UI 语义层**，保留，用于 `--widget-accent` 等兜底
- 新增的 6 ramp 是**卡片内容层**，给骨架和 LLM 用
- 两套不冲突：骨架 CSS 里既读主题变量（外层），也用 ramp 十六进制（内容）

---

### 1.2.1 背景模式（`background_mode`，跨骨架正交维度）

| 模式 | 外框背景 | 适用 |
|---|---|---|
| `opaque`（默认） | `--bg-content`（主题感知） | 独立分享、导出图、需要画布感 |
| `transparent`   | `transparent`（去外框 1px 边框） | 嵌入文档、与文档背景融合、日/夜间无突兀 |

**规则**：
- 所有骨架（A–H2）都支持 `background_mode`，作为 schema 顶层字段，不影响内部模块色块
- `transparent` 模式下，骨架内部的 `.card` / 模块色块**仍可保留色值**（来自 ramp-50/200），只去掉最外层卡片底；这样既保留视觉层次又能与文档融合
- LLM 选择策略：用户说"嵌入文档 / 无突兀 / 透明背景 / 融入" → `transparent`；用户说"导出图 / 分享 / 独立卡片" → `opaque`
- 渲染层：`widget-css-bridge.ts` 收到 `backgroundMode='transparent'` 时把 `--widget-bg-primary` 解析为 `transparent`，并去掉 `.card` 的外框

---

### 1.3 字阶与排版

| 角色 | 字号 | 字重 | 行高 | 字色变量 |
|---|---|---|---|---|
| H1（主标题） | 28/32/36px（按尺寸阶梯） | 700 | 1.2 | `--text-title` / ramp-800 |
| H2（副标题） | 18/20/22px | 600 | 1.3 | `--text-title` / ramp-600 |
| 正文 | 14/15/16px | 400 | 1.6 | `--text-body` |
| 说明 / caption | 12/13px | 400 | 1.5 | `--text-muted` |
| 数字强调（KPI） | 36/48/64px | 700 | 1.0 | ramp-800 |
| 徽标 / badge | 11/12px | 600 | 1.0 | ramp-600（文字）/ ramp-50（背景） |

**规则**：
- 字重**只用 400 / 600 / 700**三档（现有规范是 400/500，v0.1 提议升级到 600 更稳）
- **禁止 < 11px**（导出 PNG 时小字糊）
- 使用 sentence case，标题不全大写
- 字体栈：`Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`（沿用现有）
- 数字上下文用等宽（KPI、表格列对齐）：`"JetBrains Mono", "SF Mono", monospace`

---

### 1.4 留白 / 圆角 / 边框 / 阴影

| Token | 值 | 用途 |
|---|---|---|
| 外层内边距 | 32px（portrait/landscape）/ 24px（square/story）/ 16px（doc_block） | 卡片四周留白 |
| 模块间距 | 16px（紧）/ 24px（标准）/ 32px（松） | 骨架内块与块 |
| 外层圆角 | 20px（social 尺寸）/ 12px（doc_block） | 卡片外轮廓 |
| 内部圆角 | 12px（card）/ 8px（badge 以外的小元素）/ 999px（pill） | 内部模块 |
| 边框 | 1px solid `--border-default` 或 ramp-200 | 模块分隔，禁止超过 1.5px |
| 阴影 | **禁用** | 会在 DOM 流式 diff 时闪烁，也对导出 PNG 不友好 |
| 渐变 | **禁用** | 同上，且破坏"flat 温暖极简"气质 |
| blur / glow / neon | **禁用** | 理由同上 |

---

### 1.5 流式安全创作规则（向 Generative-UI-MCP 借的核心资产）

为即便将来 1.x 要做流式渲染也不返工，**v0.1 就把创作规则定下来**：

**SVG**
- `<defs>` 必须出现在第一个视觉元素之前
- 所有 `<marker>` / `<pattern>` / `<linearGradient>`（若将来放开）在 `<defs>` 内声明
- viewBox 固定在骨架定义，不由 LLM 自由写

**HTML**
- 顺序：`<style>`（短，≤ 2KB） → 内容 → `<script>`（最后）
- `<script>` 加 `onload="init()"` + 脚本尾 `if (window.Lib) init();` 双保险
- 禁止在 `<head>` 风格的位置放 `<link>`、`<meta>`、`<base>`（sanitizer 已剥离，这里写成规范）

**纯色填充**（已在禁用项重复，作为规则再强调）

---

### 1.6 动画约束 + 视频导出协议（Q6 的工程早期接口）

**目标**：同一份 widget，在屏幕上能正常播放，离线也能被按帧采样导出为 MP4/GIF。

**v0.1 提议："帧驱动协议"**
widget 若有动画，**必须通过以下协议之一驱动**，不得用 `setTimeout / setInterval / CSS animation` 做关键动效：

```js
// 协议 A：基于 requestAnimationFrame 的时间函数
// 宿主按墙钟给 t（毫秒），导出时宿主按虚拟时间步进
window.__widgetRender = function(t) {
  // 根据 t 重绘 DOM / canvas，不依赖外部时间状态
};

// 协议 B：Remotion 风格（可选，更严格）
window.__widgetFrame = function({ frame, fps, duration }) {
  // 根据帧号重绘
};
```

**兼容层**：
- 未实现协议的老 widget → 视频导出走**方案 V1 屏幕录制**（可用但质量普通，UI 标注"屏录模式"）
- 实现协议的新 widget → 走**方案 V2 帧采样**（高质量，CPU 而非 wall clock）

**约束**：
- 动画总时长 ≤ 10 秒（用于视频/GIF，默认 5 秒）
- 禁止无限动画（loading spinner 除外，且在导出时会定格到第 0 帧）
- `<script>` 内不得有 `document.cookie` / `localStorage` / `fetch` 外部数据 —— 动画必须是输入 props 的纯函数

**v0.1 做到哪一步**：
- ✅ 写进规范、LLM prompt 里要求新 widget 遵循
- ✅ 预留 `window.__widgetRender` 的宿主调用入口（存根即可）
- ❌ 实际的 V2 ffmpeg.wasm 编码管线在 v0.1 **不实现**，占位
- ❌ Live 独立输出口不纳入 v0.1

#### 1.6.1 宿主接口契约（v0.1 必须落，避免 v0.2 破坏性改动）

`widget-sanitizer.ts:buildWidgetReceiverSrcdoc` 在生成的 receiver srcdoc 末尾必须无条件注入：

```js
window.__widgetRender = window.__widgetRender || function(){};
window.__widgetFrame  = window.__widgetFrame  || function(){};
```

- 老 widget 不调用这两个函数 → 占位无副作用
- 新 widget（H2 / 启用动画的骨架）调用 `window.__widgetRender(t)` → v0.1 由空函数兜底；v0.2 接入帧采样时由宿主真正实现
- CSS `@keyframes` / `transition` **不禁用**，但仅作"装饰动效"对待，不参与帧采样导出（v0.2 帧采样只调用 `__widgetRender(t)`）

---

### 1.7 禁用项汇总（sanitizer 层 + 规范层合并）

| 项 | 理由 |
|---|---|
| `<iframe>` / `<object>` / `<embed>` / `<form>` / `<meta>` / `<link>` / `<base>` | sanitizer 已剥离，规范再声明 |
| `<script src="..."` 非白名单域名 | CDN 白名单：cdnjs / cdn.jsdelivr / unpkg / esm.sh |
| `javascript:` URL | XSS |
| `position: fixed` | 破坏画布边界 |
| `DOCTYPE / html / head / body` | widget 是片段，不是文档 |
| 渐变 / 阴影 / blur / glow / neon | 视觉气质 + 流式 + 导出稳定性 |
| `font-size < 11px` | 导出模糊 |
| 深色/彩色外层背景（外框） | 宿主主题会冲突 |
| 无限动画 | 视频导出冻结 |
| `setTimeout / setInterval` 做关键动效 | 不可按帧采样 |
| Tailwind CDN | 与内置变量冲突 |
| `document.cookie / localStorage / fetch` | 动画必须纯函数 |

---

## 2. 骨架清单 v0.1

每个骨架包含：**构图意图 / 默认尺寸 / 可编辑槽位 / LLM 选择指引 / 典型示例**。

骨架不是 React 组件，而是**"构图契约 + HTML/SVG 模板 + props schema"** 的三元组。LLM 在此骨架内按规范 + 用户 prompt 发挥，用户通过 props 表单轻度编辑。

---

### 骨架 A：`single_focus` 单焦长卡

**构图**：标题 + 主体文本（长）+ 可选视觉元素（引号符号、装饰线、署名）。一个视觉焦点，不分栏。

**默认尺寸**：`square_card` / `portrait_card`

**适用**：
- 一段感想 / 摘录 / 金句
- 一条精炼 insight
- 一本书的读后感
- 一句话 + 署名

**可编辑槽位**：
- `title` (string, optional)
- `body` (richText, required, 支持段落 / 引号 / 斜体粗体)
- `attribution` (string, optional, 署名 / 来源)
- `accent_ramp` (enum, default Indigo)
- `decoration` (enum: none / quote_mark / left_bar / top_divider, default quote_mark)
- `alignment` (enum: left / center, default left)

**LLM 使用指引**：内容 ≤ 200 字、有强烈情绪/观点、需要"被阅读"而不是"被扫描"——选这个。

**映射自现有**：`info_card`（文本多的）、`callout_block`、`today_focus_snapshot`（当摘要为纯文本时）

---

### 骨架 B：`dual_compare` 双栏对比

**构图**：标题 + 左右两栏（或上下两栏），每栏有子标题 + 要点列表 / 指标。两栏视觉对等或鲜明对比。

**默认尺寸**：`landscape_card` / `square_card`

**适用**：
- 选型对比（A vs B）
- 前后对比（before / after）
- 优缺点对比（pros / cons）
- 两选一决策

**可编辑槽位**：
- `title` (string, required)
- `subtitle` (string, optional)
- `left` / `right`：each `{ heading: string, items: string[] | KeyValue[], ramp: enum }`
- `divider_style` (enum: line / vs_badge / none, default vs_badge)

**LLM 使用指引**：用户用"对比 / 选型 / 更好 / 还是 / pk / vs" 等词——选这个。

**映射自现有**：`comparison_grid`（2 列时）、`tab_info_block`（只有 2 个 tab 时）

---

### 骨架 C：`metric_grid` 多栏数据板

**构图**：标题 + 2×2 / 3×1 / 4×1 / 2×3 的指标网格。每格是一个 KPI（大数字 + 标签 + 可选趋势箭头 + 可选对比值）。可选底部附一张小图（趋势线）。

**默认尺寸**：`landscape_card`（4 格）/ `square_card`（2×2）/ `portrait_card`（4 格竖排）

**适用**：
- 周报 / 月报的数据摘要
- 仪表盘式数据展示
- 财务 / 健康 / 项目指标

**可编辑槽位**：
- `title` (string, required)
- `period` (string, optional, e.g. "2026 年 4 月")
- `metrics`: `{ label, value, unit?, delta?, delta_direction?, ramp? }[]`（2–6 项）
- `footer_chart` (optional, `{ type: sparkline, data: number[] }`)
- `columns` (enum: 2 / 3 / 4, 自动推荐)

**LLM 使用指引**：用户给了 2–6 组数字且每组有明确标签——选这个。

**映射自现有**：`stats_card`、`progress_snapshot`、`time_allocation_chart`（小型时）、`focus_metrics`

---

### 骨架 D：`vertical_timeline` 垂直时间线

**构图**：标题 + 垂直轴线 + 沿轴的事件节点。每个节点有时间戳 + 标题 + 可选描述 + 可选状态色。

**默认尺寸**：`portrait_card` / `square_card` / `doc_block`

**适用**：
- 日报 / 一天回顾
- 项目进度 / 里程碑
- 旅行行程
- 历史事件时间线
- 学习路径

**可编辑槽位**：
- `title` (string, required)
- `axis_label` (string, optional, e.g. "2026-04-20")
- `events`: `{ time, heading, body?, status?: done/active/pending, ramp? }[]`（3–10 项）
- `orientation` (enum: vertical / horizontal, default vertical)
- `show_connector` (bool, default true)

**LLM 使用指引**：用户提到"一天 / 行程 / 进度 / 步骤 / 顺序 / 历程"且有时间属性——选这个。

**映射自现有**：`day_schedule_card`、`week_schedule_card`、`schedule_runtime_card`、`flow_diagram`（线性时）、`todo_list_manual`（带时间时）

---

### 骨架 E：`photo_note` 图文笔记

**构图**：上方主视觉（图片 / 插画 / 图标 / SVG 装饰）+ 下方标题 + 正文 + 可选 tag。

**默认尺寸**：`portrait_card`（小红书主打） / `story_card`

**适用**：
- 旅行照片 + 感想
- 读书笔记 + 封面
- 产品推荐 + 图
- "今日分享" 的图文混排

**可编辑槽位**：
- `hero`: `{ type: 'image' | 'svg_illustration' | 'emoji_block', src? / svg? / emoji?, aspect? }`
- `title` (string, required)
- `body` (richText)
- `tags` (string[], optional)
- `footer` (string, optional, 署名 / 日期)

**LLM 使用指引**：用户提供了图片、或主题显然视觉主导（旅行 / 美食 / 产品 / 自然）——选这个。v0.1 **图片槽位暂只支持粘贴的 base64 / URL，不做上传**（挂在现有 Tiptap 资源层）。

**映射自现有**：`info_card`（有图时）、无直接映射（多数是新增能力）

---

### 骨架 F：`chart_focus` 单图表聚焦卡

**构图**：标题 + 简短描述 + 主图表（占画布 60%+）+ 图例 / caption / 数据源注解。

**默认尺寸**：`landscape_card` / `square_card`

**适用**：
- 一张图说明一个趋势
- 单维度数据可视化
- 柱 / 线 / 饼 / 堆叠 / 散点（规范阶段统一走 Chart.js）

**可编辑槽位**：
- `title` (string, required)
- `subtitle` (string, optional)
- `chart`: `{ type: bar / line / pie / stacked_bar / scatter, data: ChartJsDataset, ramp: enum }`
- `insight` (string, optional, 图下方的一句总结)
- `source_note` (string, optional)

**LLM 使用指引**：用户给了结构化数据（数组 / 表）且想强调"趋势 / 分布 / 对比量级"——选这个。

**映射自现有**：`bar_chart`、`line_chart`、`weekly_focus_chart`、`time_allocation_chart`

**约束**（继承 Generative-UI-MCP）：
- canvas 用 ramp 十六进制而非 CSS 变量
- 图例默认关闭
- bar 的 borderRadius=6，line 的 tension=0.3

**动态/交互图表的归宿**：
- **常规动画**（柱条增长、线段绘入、饼图分裂）→ 仍走骨架 F，动效由 §1.6 `window.__widgetRender(t)` 协议驱动；不允许 `setTimeout/setInterval` 关键动效
- **强交互**（用户输入参数、悬停 tooltip 之外的点击切片、实时计算）→ 不在 F 范围内，必须由用户在 prompt 里使用"交互式数据图 / 交互式信息卡"关键词显式触发，进入骨架 H2（见下）
- **导出退化**：H2 在导出静态图时只截取首帧；抽屉 UI 应在保存时给用户提示"此 widget 含交互逻辑，导出图片只保留视觉"

---

### 骨架 G：`grid_collection` 网格拼贴

**构图**：标题 + N×M 网格，每格是一个小 item（icon / 图 / 短文），可规则或瀑布流。

**默认尺寸**：`square_card` / `portrait_card`

**适用**：
- 2026 读书清单（书封网格）
- 习惯追踪器（heatmap）
- 工具 / 应用推荐墙
- 小红书的"九宫格"

**可编辑槽位**：
- `title` (string, required)
- `grid`: `{ cols: 2/3/4, items: Item[] }`
- `item_shape` (enum: square / portrait / free)
- `items`: `{ icon_or_image?, label?, status?, ramp? }[]`（4–16 项）

**LLM 使用指引**：用户给了并列的 4+ 个同质 item，没有明确时间/对比关系——选这个。

**映射自现有**：`habit_streak_manual`（网格态）、`weekly_plan_board_manual`（当项少时）

---

### 骨架 H1：`freeform_static` 自由构图 - 静态版（关键词触发）

**构图**：无预设结构。骨架只提供尺寸、规范约束、外框。LLM 在画布内完全自由发挥（HTML + SVG），但不能含交互或脚本逻辑。

**默认尺寸**：任意

**适用**：
- 用户 prompt 明确要求特殊构图（"我想要一个像老式电影票的卡片"）
- 其他 7 个骨架都无法承载时的兜底
- 进阶用户的"Code 视图" 直接从这个骨架切入

**触发条件（强制）**：用户 prompt 必须含关键词 **"做一个超特殊卡片" / "超特殊卡片"** 才能启用 H1。LLM **默认禁用 H1**，未命中关键词时即使 LLM 选了也由 `run-capability-controller` 强制降级到最近的 A–G。

**可编辑槽位**：
- `title` (string, optional, 用于列表展示)
- `widget_code` (raw HTML/SVG string, required)
- `aspect_ratio` (enum: 1:1 / 9:16 / 16:9 / 4:5 / 4:3 / a4, 必填用于导出)
- `background_mode` (enum: opaque / transparent)

**映射自现有**：相当于现有 `widget_code` 原始字符串的"静态用法"。

---

### 骨架 H2：`freeform_interactive` 自由构图 - 交互版（关键词触发）

**构图**：在 H1 基础上允许交互逻辑（输入框 + 计算、动画、状态切换）。脚本仍受 sanitizer 白名单约束（CDN + inline script），但可使用 `window.__widgetRender(t)` 协议或 CSS animation 做动效。

**默认尺寸**：任意

**适用**：
- 强交互信息卡 / 数据图（mini calculator、实时筛选图、参数化图表）
- 在 prompt 里明确要做"动起来"的可视化

**触发条件（强制）**：用户 prompt 必须含关键词 **"交互式信息卡 / 交互式数据图"** 才能启用 H2。LLM **默认禁用 H2**；未命中关键词时强制降级到 F（普通图表）或 A（静态信息卡）。

**可编辑槽位**：
- `title` (string, optional)
- `widget_code` (raw HTML/SVG/JS string, required)
- `aspect_ratio` (enum, 必填)
- `background_mode` (enum)
- `supports_animation` (bool, 强制为 true，是 H2 的标识)

**约束（继承 §1.5 / §1.6）**：
- 动画必须用 `window.__widgetRender(t)` 协议（CSS animation 仅装饰，不参与帧采样）
- `<script>` 必须有 `onload="init()"` + 尾部 `if (window.Lib) init();` 双保险
- 动画总时长 ≤ 10 秒，禁无限动画
- 不允许 `fetch / cookie / localStorage`，动画/交互必须是输入 props 的纯函数

**导出退化**：导出静态图时只取首帧。抽屉 UI 在保存时必须 callout：「此 widget 含交互逻辑，导出图片只保留视觉首帧」。

**映射自现有**：`mini_calculator` 等强交互组件归入此骨架。

---

### 骨架 H 共同说明

H1/H2 都是**保留原始自由度的逃生口**，不是主路径。它们的存在为了不堵死高阶用户，但 LLM 默认必须先尝试 A–G。所有触发关键词检测、强制降级都在 `run-capability-controller` 单点裁决（与 CLAUDE.md 6.10 一致）。

---

## 3. 现有 20 组件 → 新骨架 映射表

| 原 component | 去向 | 映射方式 |
|---|---|---|
| `info_card` | A / E | 纯文本 → A；带图 → E |
| `stats_card` | C | metrics[] |
| `bar_chart` | F | chart.type=bar |
| `line_chart` | F | chart.type=line |
| `data_table` | C（小表）/ H1（大表） | 4 列以内转 metric_grid；否则 freeform_static |
| `callout_block` | A | decoration=left_bar 或 quote_mark |
| `tab_info_block` | B（2 tab）/ H2（多 tab 含切换） | 多 tab 含交互走 H2，否则建议拆成多张卡片 |
| `comparison_grid` | B（2 列）/ C（多列同类） | 对比用 B，同类并列用 C |
| `progress_snapshot` | C | metrics 带 delta |
| `weekly_focus_chart` | F | chart.type=bar/line |
| `mini_calculator` | H2 | 强交互，freeform_interactive 兜底（需触发关键词） |
| `flow_diagram` | D（线性）/ H1（分支） | 线性转时间线；复杂流程走 freeform_static SVG |
| `day_schedule_card` | D | events[] |
| `week_schedule_card` | D（竖排）/ G（周视图网格） | 按视觉形态选 |
| `time_allocation_chart` | C / F | 单数字 → C；饼图 → F |
| `schedule_runtime_card` | D | events[] 带 status |
| `todo_list_manual` | D（有时间）/ G（无时间） | |
| `weekly_plan_board_manual` | G（网格）/ D（条目纵向） | |
| `habit_streak_manual` | G | heatmap 化 |
| `today_focus_snapshot` | A（纯文本）/ C（有指标） | |

**观察**：
- 20 → 8 的映射基本无信息损失
- `mini_calculator` 等强交互组件归入 H2，但**只有用户在 prompt 里命中"交互式信息卡 / 交互式数据图"关键词才会触发**——避免 LLM 默认产出难以维护的脚本 widget
- 所有骨架支持 `background_mode` 维度，覆盖 O1 中"透明背景元素"诉求

---

## 4. 用户 prompt 发挥的边界

骨架 + 规范是**硬约束**，LLM 在此之上按用户 prompt **在以下维度自由发挥**：

**允许 LLM 自由做**：
- 骨架内的视觉细节（具体的文案、icon 选择、装饰线位置、ramp 组合）
- 骨架内的微构图调整（metric_grid 里选 2×2 还是 4×1）
- SVG 装饰元素（引号符号的具体画法、分隔线的样式）
- 骨架允许的 slot 范围内的语义变体

**不允许 LLM 自由做**：
- 打破骨架契约（metric_grid 里塞一张图表）
- 超出规范（加阴影、用非白名单色值、字号 < 11px）
- 改变尺寸比例
- 引入非白名单依赖

**冲突仲裁**：
- 用户 prompt 与骨架冲突（"我要 10 个指标"但 metric_grid 最多 6）→ LLM 换骨架或截断，不破契约
- 用户 prompt 与规范冲突（"给我一个带阴影的卡片"）→ LLM 礼貌忽略阴影要求，因为规范是硬约束；若用户坚持，提示用户改用 H1（需关键词触发）

**H1/H2 触发关键词降级（强制单点裁决）**：
- H1 仅在 prompt 含 "做一个超特殊卡片 / 超特殊卡片" 时启用
- H2 仅在 prompt 含 "交互式信息卡 / 交互式数据图" 时启用
- 未命中关键词时，即使 LLM 输出了 H1/H2 骨架，也由 `run-capability-controller` **强制降级**到最近的 A–G（H1 → 最贴合的视觉骨架；H2 → F 或 A）
- 该降级与 CLAUDE.md 6.10 的"运行能力裁决器单点"原则一致，不允许散落到 prompt 模板或 executor 里做双重挡板

这和 CLAUDE.md 6.10 的"裁决点唯一"精神一致：**规范和骨架是 LLM 和用户之间的仲裁层**。

---

## 5. 用户编辑 UX（v0.1 范围）

**轻度编辑（90% 场景，v0.1 必做）**
- widget 卡片头部新增「编辑」按钮（与现有「导出」「删除」并列）
- 点击后右侧抽屉打开 props 表单：
  - 文本字段 → `<textarea>` / `<input>`
  - ramp 字段 → 色板 6 选 1
  - items 数组 → 简单的列表增删改
  - 尺寸切换 → 下拉（触发骨架重排）
- 保存即重渲染 + 入文档 + 触发导出快照失效

**深度编辑（10% 场景，v0.1 做入口，不做编辑器）**
- 骨架 H（freeform_canvas）和任何骨架的「切换到源码」入口
- v0.1 先做只读源码视图（已有 `onToggleSource`），**可编辑的 Monaco/CodeMirror 推到 v0.2**

**保留现状**
- `onQuoteToAgent` 保留——"改复杂的东西还是找 agent" 是合理逃生口
- `onExport` / `onDelete` / `onRenameTitle` / `onCopySource` 保留

---

## 6. v0.1 → v0.2 的工程边界预判（只列，不排期）

**v0.1 核心**
- 骨架定义 8 个 + 规范 artifact（一个 `.ts` 文件 + 一份 markdown）
- `document-widget-openui.ts` 的 20 种映射到 8 骨架
- Agent prompt 用新规范片段替换
- props 表单编辑器（右侧抽屉 + 基础字段组件）
- 旧 `widget_code` 原始路径 → 骨架 H

**v0.1 之后可能进入 v0.2/v1.0 的**
- 视频导出 V2（ffmpeg.wasm + 帧采样）
- Code 视图可编辑（Monaco）
- 版本快照 / undo
- 尺寸切换时的布局智能重排（v0.1 重排可能需要人工兜底）
- 图片槽位上传
- Live 独立 HTML 输出

---

## 7. 已对齐的决策（2026-04-20）

以下为 §0–§6 已落地的关键决策来源，作为后续工程拆解的依据。

- **骨架数量**：8 个（A/B/C/D/E/F/G/H1/H2）。覆盖"常见数据图（F）、动态/交互图（H2 关键词触发）、透明背景元素（所有骨架的 `background_mode` 维度）"三类用户诉求。
- **尺寸清单**：7 种（`square_card` / `portrait_card` / `story_card` / `landscape_card` / `landscape_4_3` / `a4_portrait` / `doc_block`）。
- **背景模式**：新增 `background_mode: opaque | transparent` 跨骨架正交维度（§1.2.1）；不新增"透明骨架"，避免重复。
- **动画协议**：v0.1 仅落规范 + 在 srcdoc 注入 `window.__widgetRender / __widgetFrame` 占位（§1.6.1），不实现 ffmpeg.wasm 管线。
- **图片槽位**：v0.1 复用 `ImageGallery.tsx` 拾取 UI；存储仍为 URL/base64（**不重做资源模型**）；schema 留 `mediaRef` 占位为 v0.2 间接寻址做铺垫；单 widget base64 上限 5MB。
- **Code 编辑器**：v0.1 只做只读源码视图，Monaco 推 v0.2。
- **骨架 H1 触发**：用户 prompt 含 "做一个超特殊卡片 / 超特殊卡片" → 启用；未命中由 `run-capability-controller` 强制降级到 A–G。
- **骨架 H2 触发**：用户 prompt 含 "交互式信息卡 / 交互式数据图" → 启用；未命中强制降级到 F/A。强交互（`mini_calculator` 等）归入 H2。
- **冲突裁决**：H1/H2 关键词检测、强制降级、forceDocumentTool 与 widget update/inspect 的策略冲突，**全部由 `run-capability-controller` 单点处理**（与 CLAUDE.md 6.10 一致）。

---

## 8. 工程里程碑摘要（详见 `~/.claude/plans/elegant-herding-kay.md`）

| 里程碑 | 范围 | 主要文件 |
|---|---|---|
| **M0** | 本对齐稿基于 O1–O8 的修订（§1.1 / §1.2.1 / §1.6.1 / §2 H1/H2 / §4 / §7 / §8） | 本文件 |
| **M1** | 骨架运行时 + 透明背景 + render 占位 | `document-widget-skeletons.ts`（新）/ `widget-css-bridge.ts` / `widget-sanitizer.ts` / `WidgetRenderer.tsx` |
| **M2** | 20 → 8 映射兼容层 | `document-widget-skeleton-mapping.ts`（新）/ `document-widget-parse.ts` / `document-widget-patch.ts` |
| **M3** | LLM prompt 切骨架 + 关键词裁决 | `widget-guidance.ts` / `document-task-pipeline-executor.ts:709/741` / `live-info-intent.ts:26` / `run-capability-controller.ts` |
| **M4** | 编辑抽屉 + 图片槽位（O5） | `WidgetEditDrawer.tsx`（新）/ `ImageGallery.tsx`（复用） |
| **M5** | 动画接口预留（O4） | `widget-sanitizer.ts:buildWidgetReceiverSrcdoc` |
| **M6** | CLAUDE.md / AGENTS.md 同步 | 根目录两份指引 |

> 详细文件路径、Zod schema、测试用例、风险点 R1–R4（legacy fence 升级策略 / ImageGallery z-index / CSS animation 范围 / H2 导出退化提示）见执行计划文件。

> 对齐稿结束。本稿为已对齐版，非待审稿。
