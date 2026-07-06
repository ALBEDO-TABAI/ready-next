# 风格 R · Ready 点阵理性（Dot Rational）

> 信源：Ready 应用真实代码 token（`theme-tokens.css` / `ReadyStartupSplash.tsx` / `settings-theme.ts`）+ Nothing 设计语言（克制版）+ Braun 秩序 + Apple 液态玻璃（限定用法）。
> 一句话定调：**暖纸白底上的精密仪器**——秩序靠留白和 hairline，身份靠一枚橘红点阵，深度靠内高光而非阴影。

## 0. 三源张力（判断依据）

遇到规范没写到的细节，按这句话裁决：**"安静、准确、信息优先，橘红只为此刻点亮。"**

- 来自 **Nothing**：点阵是母语（字标、图表、状态点）；accent 极度稀缺；结构来自线与留白。
- 来自 **Braun**：设置页式的行秩序、对齐列、克制的功能主义；能用排版解决的不用装饰。
- 来自 **Apple / Ready 本体**：暖白纸面、12-18px 圆角、系统无衬线、玻璃浮层只在压图时出现、阴影趋近于零。

**与瑞士风的区别**（防跑偏）：Ready 有圆角（12/16/18）、有暖底色、标题字重 500-600（不是 ultra-light 巨字）、允许极淡玻璃材质。**与 Nothing 的区别**：默认亮色暖纸底（不是 OLED 黑）、accent 是橘红 `#FF4B2B`（不是信号红 `#D71921`）、圆角更大更柔。

## 1. 颜色 token（来自 Ready 真实代码，不许自造）

### 亮色（默认）

| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `#F6F5F1` | 页面底（暖面板灰白） |
| `--paper-warm` | `#F6F1E7` | 仪式感变体底（封面/幕封可选） |
| `--card` | `#FFFFFF` | 卡片/内容面 |
| `--canvas` | `#F0EFED` | 嵌入井/图表底 |
| `--ink` | `#1A1A1A` | 标题 |
| `--ink-body` | `#333333` | 正文 |
| `--ink-2` | `#666666` | 次要 |
| `--ink-3` | `#999999` | 弱化/占位 |
| `--hair` | `#E8E5DE` | hairline 边框 |
| `--accent` | `#FF4B2B` | **品牌橘红（唯一 accent）** |
| `--accent-soft` | `rgba(255,75,43,.12)` | 橘红染底 |
| `--accent-glow` | `rgba(255,75,43,.18)` | 点阵发光 drop-shadow |
| `--dot-dim` | `#DFDED9` | 点阵场未点亮底点（用时再乘 ~0.34 透明度） |

### 暗色（hero dark 页专用）

| Token | 值 |
|---|---|
| `--paper`(dark) | `#1A1B1E` |
| `--card`(dark) | `#202124` |
| `--ink`(dark) | `#D9DBE1`（标题可提到 `#FFFFFF`） |
| `--ink-2`(dark) | `#8F96A3` |
| `--hair`(dark) | `#333538` |
| `--accent-text`(dark) | `#FF6345`（暗底上的橘红文字/发光） |
| 图表 mark(dark) | 仍用 `#FF4B2B`（已过校验；`#FF6345` 作图表色超出暗色亮度带） |

### accent 纪律（硬规则）

1. 一页里橘红元素**一只手数得过来**（≤5 处）；铺满橘红的面（色带/反白块）整份 deck ≤1 页。
2. 橘红的语义是「**此刻 / 进行中 / 品牌在场**」：状态点、关键数字、进度、当前项标记、dotword 字标。不要拿它当普通装饰或分隔线。
3. 正文文字不穿橘红；允许穿橘红的文字只有：链接语义、单个强调词、大数字。
4. 没有第二 accent。Ready 应用里的功能蓝是交互态专用，**幻灯片/卡片一律不用蓝**。

## 2. 字体

```css
--sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
        "Inter", "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif;
--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code",
        Menlo, Consolas, monospace;
```

分工（Ready 的"仪表盘签名"）：

| 角色 | 字体 | 规格 |
|---|---|---|
| 大标题 display | sans | weight **600**，letter-spacing `-0.015em`，行高 1.04-1.12 |
| 章节/小节标题 | sans | weight 600，15-28px 档 |
| 正文 | sans | weight 400，行高 1.6 |
| **标签 label** | **mono** | **大写 + letter-spacing `0.08em`**，weight 500（CJK 大写是 no-op，正常回退） |
| **数字/计量** | **mono** | `font-variant-numeric: tabular-nums`（大独立数字可放开为比例数字） |
| 元数据/页码 | mono | 11-14px，`--ink-3` |

大字号绝不用 200 极细（那是瑞士风）；也绝不用 800-900 重锤。**500-600 的从容**是 Ready 的字重人格。

## 3. 几何语言

| 元素 | 规格 |
|---|---|
| 内容卡片 | radius **16px**，`1px solid var(--hair)`，白底，无阴影 |
| 模块壳/图片井 | radius **18px** |
| 控件/小卡 | radius **12px** |
| 胶囊/badge | radius 999px |
| 阴影 | 默认**无**。允许的上限：`0 1px 3px rgba(0,0,0,.06)`；表达"浮起"改用内高光 `inset 0 1px 0 rgba(255,255,255,.58)` |
| hairline | 恒 1px。**横向分隔优先用留白不画线**；竖向分隔用 40% 透明 hairline（`rgba(232,229,222,.4)`） |
| 点 | 一切点都是**完整正圆**（`border-radius:50%`）。禁止 mask / clip-path / dotted border 切出半圆 |

间距节奏：`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96`（px 基数），卡片内边距 24-32，版心边距走 `5vw/5.5vh` 级。

## 4. 点阵母题系统（Ready 的身份层）

### 4.1 dotword 点阵字标（5×7 字模）

复刻 Ready 启动画面 READY 字标的几何：

- 字模 5×7，**点直径 = 格距的 75%**（点间气隙 = 1/3 点径），字母间空 1 列。
- 颜色：亮底用 `--accent`，暗底用 `--accent-text`；可叠 `filter: drop-shadow(0 0 8px var(--accent-glow))` 发光（暗底/封面用，正文页不用）。
- 用途分级：封面主字标（大写英文/数字，dot 8-14px）、章节序号（dot 6-9px）、KPI 大数字（dot 9-14px）、页脚小标（dot 3-4px）。
- **只用于拉丁字母与数字**；中文永远用系统字排。一页 dotword ≤2 处。
- 入场动效：**逐列点亮，86ms/列**（Ready 原生节奏），列内做轻微正弦呼吸；低功耗/静态直接满亮。

### 4.2 点阵场背景（hero 页专用）

- 底点网格：格距 24-30px，点半径 ~2px，颜色 `--dot-dim` 乘 ~0.34 透明度——远看是纸的织体，不抢内容。
- 动效（可选 canvas）：正弦波场让点做 0.06-0.14 透明度呼吸，速度 ~0.5x，机械而安静。
- **只在封面/幕封/收尾出现**；正文页永远素底。点场永远垫底（z-index 低于内容），卡片压住点。
- 静态替身：`radial-gradient` 平铺同参数点网格（校验/低功耗/打印时的形态）。

### 4.3 橘点 motif

- 6-8px 橘红实心圆 = 行级"进行中/当前项"标记（列表当前行、时间线当前节点、进度点）。
- 14px 橘红圆 = 品牌在场标记（页脚/封面角落，配 0.5px 白描边感）。
- 状态点语义：橘=进行中/此刻，绿 `#34D399`=完成，灰=未开始。形状+标签先行，颜色其次。

## 5. 玻璃浮层（限定用法）

仅当**文字必须压在图片上**时使用玻璃面板（标题浮层、图注条）：

```css
background: rgba(253,253,251,.46);
backdrop-filter: blur(24px) saturate(1.18);
border: 1px solid rgba(255,255,255,.5);
box-shadow: inset 0 1px 0 rgba(255,255,255,.58);   /* 内高光，非外阴影 */
border-radius: 16px;
```

纪律：不透明白底遮图是错的；外部暗色阴影是错的；玻璃只做浮层材质，不做整页底。暗图上可换 `rgba(26,27,30,.42)` 深玻璃。一页玻璃面 ≤2 块。

## 6. 图表语言（点阵图表）

详细规范见 `dot-charts.md`。要点：单 accent（`#FF4B2B`）+ 灰退避（`#C9C6BE`）的 emphasis 模式；点=固定单位、图例必标 `● = N`；精确数值用 mono 直标；文字永远穿文本色不穿数据色。校验结论：`#FF4B2B` 在 `#F6F5F1`/`#FFFFFF`/`#1A1B1E` 三种面上全部通过（validate_palette 六检）。

## 7. Do / Don't

**Do**
- 用留白和字号层级解决 90% 的排版问题，再考虑加线，最后才考虑加面。
- mono 大写小标签 + 大 sans 标题的组合是页眉标配。
- 数字用 tabular-nums 对齐；计量单位跟在数字后用 `--ink-2`。
- 图片放进 `.img-slot` 槽位系统（见 `image-slots.md`），圆角 18px 由槽位统一给。
- 每 3-4 页安排一个 hero 节奏页（点阵场封面/幕封/dark 陈述页）。

**Don't**
- 不用衬线字体（任何位置）。
- 不用渐变大底、彩色大面、外部暗阴影、双 accent。
- 不用 emoji 当图标（lucide 线性图标，stroke 1.65，或点阵 glyph）。
- 不把点阵场铺到正文页；不把 dotword 用于中文。
- 不用 0/100 极端字重；不做弹簧回弹动效（一切缓动 ease / cubic-bezier 平滑，机械干脆）。
- 深浅不混搭发明新灰；只用 token 表里的值。
