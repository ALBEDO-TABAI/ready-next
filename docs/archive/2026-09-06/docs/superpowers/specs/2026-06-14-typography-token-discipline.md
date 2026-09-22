---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready 排版 Token 纪律规范（提案）

> 日期：2026-06-14
> 状态：**提案 / 未强制**（enforce: false）。本文件只定义 token、语义角色与迁移映射，**不改动任何组件**。审定后再分期落地。
> 范围：renderer 全量文本排版的字体族、字号刻度、字重、行高、字距。
> 关系：与液态玻璃材料正交——本规范只管"字怎么排"，不碰玻璃/折射/阴影/颜色。

## 0. 目标与非目标

**目标**
- 把当前的任意值排版（`text-[Npx]` 满天飞、7 套字体栈、15 种行高）收编成一套可机器校验的 token 体系。
- 借 Nothing 的排版纪律（固定刻度、角色化、mono 标签语言、数字等宽），但**不照抄它的具体数值，也不破坏中英混排**。

**非目标**
- 不换正文/标题字体（必须保 CJK）。
- 不把正文压到 Nothing 的 11px 工业仪表尺寸。
- 不在本提案里改组件——组件迁移是后续分期。

## 1. 现状问题（基于真实用量统计）

- **没有字号刻度**：`text-[Npx]` 任意值主导，最密集落在 `12px`(179) `11px`(139) `13px`(121) `10px`(72) `9px`(16)，命名档 `text-xs/base/lg` 合计仅 6 处；还存在 `12.5/11.5/10.5px`、`0.9em`、`23px` 等一次性碎值。
- **靠字重建层级**：`600`(31) `700`(23) `500`(10) `650`(4) `400`(2)——出现非标准的 `650`。
- **几乎无字距纪律**：`letter-spacing` 全仓 5 处且均为 `±0.01em`；没有"小字号大写 + 宽字距"的标签语言。
- **数字不等宽**：`tabular-nums`/`font-variant-numeric` 仅 5 处，计数器/计时器会跳动。
- **行高失控**：从 `1` 到 `2` 共 15 种值，外加 `18px/14px` 像素行高。
- **字体栈分裂**：无 `@font-face`、无打包，靠系统字体；正文有 `Inter`/`SF Pro Text`/`-apple-system` 三种混用，mono 有 `SF Mono`/`Fira Code`/`ui-monospace` 等四种变体。

## 2. 字体族 Token（保 CJK 是硬约束）

定义 4 个角色族 token，作为唯一真源（建议落在 `:root`，见 §8 Tailwind 接线）：

```css
:root {
  /* 正文 / UI：保留最完整的 CJK 栈（来自现有代码里最全的一条） */
  --font-ui: 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
             'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

  /* 标题：与 UI 同族，仅靠字重区分，不引入 Geist（否则中文掉兜底） */
  --font-head: var(--font-ui);

  /* 等宽 / 数据 / 标签：收编四个变体为唯一规范栈 */
  --font-mono: 'SF Mono', 'Fira Code', 'Roboto Mono', 'Menlo', ui-monospace, monospace;

  /* 独立数字：阶段一先复用 mono + 等宽特性；阶段二打包 Doto 后只改这一行 */
  --font-numeric: var(--font-mono);
  /* 阶段二：--font-numeric: 'Doto', var(--font-mono); 并对 body 设 font-variation-settings:'ROND' 100 */
}
```

红线：
- **正文/标题脸必须含 CJK**。可借 Doto 做数字（纯拉丁，安全），但**不得**把 `--font-ui`/`--font-head` 换成 Geist 这类无中文字体。
- 任何文件**不得**再内联自定义字体栈——只能引用上述 4 个 token。

## 3. 字号刻度（11 档，吸收现有密集区）

小字区（9–13）是密集 UI 的真实需求，逐档保留；中大区收紧、罕用的展示字号合并到锚点。

| Token | 值 | 角色定位 | 吸收的旧值 |
|---|---|---|---|
| `--text-2xs` | 9px | 微标签、徽标 | 9 |
| `--text-xs` | 10px | 标签、caption | 10, 10.5 |
| `--text-sm` | 11px | 次要文本、密集 meta | 11, 11.5 |
| `--text-base` | 12px | **默认 UI 文本**（按钮/菜单/控件） | 12, 12.5 |
| `--text-md` | 13px | 正文阅读（聊天消息、文档） | 13 |
| `--text-lg` | 15px | 强调正文、小标题 | 14, 15, 16, 0.9em |
| `--text-xl` | 18px | 卡片/区块标题 | 18 |
| `--text-2xl` | 22px | 面板/页标题 | 20, 22, 23, 24 |
| `--text-3xl` | 28px | 大标题 | 28, 30, 32 |
| `--text-4xl` | 40px | 展示数字/英雄文本 | 40, 48 |
| `--text-5xl` | 64px | 超大英雄数字 | 64 |

说明：
- 展示档（≥22）罕用（各 1–2 处），向锚点 snap 成本极低。
- **碎值一律消除**：`12.5→12`、`11.5→11`、`10.5→10`、`0.9em→--text-lg`、`23→22`。
- 若某个英雄位确需非锚点尺寸，**新增一个命名一次性 token**（如 `--text-hero-splash`），**不得**回退到任意像素值。

## 4. 行高（5 档，按字号区配对）

```css
:root {
  --lh-none:   1;     /* 单行控件、图标对齐 */
  --lh-tight:  1.2;   /* 展示/大标题 ≥22px */
  --lh-snug:   1.3;   /* 标题、标签 15–20px */
  --lh-normal: 1.5;   /* 正文阅读 12–15px */
  --lh-dense:  1.4;   /* 密集 meta/标签 ≤11px */
}
```

红线：禁止像素行高（`line-height:18px`）；禁止 §4 之外的裸数值。

## 5. 字距（3 档）

```css
:root {
  --track-label:  0.08em;  /* mono 大写标签的签名字距（范围 .06–.1em，统一取 .08） */
  --track-tight: -0.01em;  /* 大号展示标题的光学收紧 */
  --track-normal: 0;       /* 其余一切 */
}
```

## 6. 字重（3 档，层级以字号为主、字重为辅）

```css
:root {
  --fw-regular:  400;
  --fw-medium:   500;
  --fw-semibold: 600;   /* UI 内字重上限 */
}
```

红线：
- **删除 `650`**（4 处 → snap 到 600）。
- **`700` 收敛**：仅展示英雄文本可用，普通 UI 加粗一律降到 600；目标是层级靠字号拉开，不靠堆字重。
- 一屏内字重种类 ≤3。

## 7. 语义角色（核心——组件应消费角色，而非裸 token）

每个角色 = 字体 + 字号 + 字重 + 行高 + 字距 + 大小写 的固定组合。组件迁移时只认角色名。

| 角色 | font | size | weight | line-height | tracking | transform | 用途 |
|---|---|---|---|---|---|---|---|
| `display` | numeric | 4xl/5xl | medium | tight | tight | — | 英雄数字/展示 |
| `title-lg` | head | 2xl | semibold | tight | tight | — | 页/面板标题 |
| `title` | head | xl | semibold | snug | normal | — | 卡片/区块标题 |
| `subtitle` | head | lg | semibold | snug | normal | — | 小标题 |
| `body` | ui | md | regular | normal | normal | — | 主阅读正文（聊天/文档） |
| `body-sm` | ui | base | regular | normal | normal | — | 次要正文 |
| `ui` | ui | base | medium | dense | normal | — | **默认控件文本** |
| `meta` | ui | sm | regular | dense | normal | — | 次要说明/caption |
| `label` | mono | xs | medium | snug | label | **UPPERCASE** | **签名标签**（区块抬头/状态名） |
| `label-sm` | mono | 2xs | medium | snug | label | **UPPERCASE** | 微标签/徽标 |
| `data` | mono | base | regular | dense | normal | — | 时间戳/表格数据 |
| `numeral` | numeric | 继承 | medium | none | normal | — | 独立数字（计数/计时/百分比） |

注：
- `numeral` 与 `data` 默认带 `font-variant-numeric: tabular-nums`（消除数字跳动），阶段二 Doto 化时此特性天然满足。
- `label`/`label-sm` 是目前完全空白、收益最大的"工业仪表"签名。

## 8. 落地形态：Tailwind v4 `@theme` 接线

token 进 `@theme` 后，刻度即变成可用工具类，从根上断掉 `text-[Npx]`：

```css
@theme {
  --text-2xs: 9px;  --text-xs: 10px;  --text-sm: 11px;  --text-base: 12px;
  --text-md: 13px;  --text-lg: 15px;  --text-xl: 18px;  --text-2xl: 22px;
  --text-3xl: 28px; --text-4xl: 40px; --text-5xl: 64px;
  /* font-family / leading / tracking 同理注册 */
}
```

语义角色建议用一组 `@utility`（如 `@utility text-label { ... }`）或一份 `text-roles.css` 暴露 `.t-label`/`.t-title` 等类，组件只贴角色类。

## 9. 迁移映射（旧值 → 新 token，供后续分期对照）

| 旧任意值 | 映射 |
|---|---|
| `9px` | `text-2xs` |
| `10px` / `10.5px` | `text-xs` |
| `11px` / `11.5px` | `text-sm` |
| `12px` / `12.5px` | `text-base` |
| `13px` | `text-md` |
| `14px` / `15px` / `16px` / `0.9em` | `text-lg` |
| `18px` | `text-xl` |
| `20–24px`（含 23） | `text-2xl` |
| `28–32px` | `text-3xl` |
| `40px` / `48px` | `text-4xl` |
| `64px` | `text-5xl` |
| `font-weight:650` | `--fw-semibold` (600) |
| 任意 `line-height` | §4 五档就近 |

## 10. 红线（do / don't）

- **don't** 用 `text-[Npx]` / 内联 `font-size` 任意值；**do** 用刻度 token 或角色类。
- **don't** 在组件里写字体栈；**do** 引用 `--font-*`。
- **don't** 新增刻度/行高/字距档；**do** 复用既有档或提案新增命名 token。
- **don't** 用 Geist 等无 CJK 字体做正文/标题。
- **don't** 用字重堆层级（≤3 档，≤600 为主）。
- **do** 独立数字一律等宽（`numeral`/`data` 角色）。

## 11. 强制手段（CI 优先于文档，文档优先于人审）

落地后建议加一条静态 gate（grep 即可起步）：

- 禁止 `text-\[[0-9.]+px\]` 任意字号工具类（白名单：本提案新增的命名一次性 token）。
- 禁止组件内 `font-family:`（只允许 `:root`/tokens 文件）。
- 禁止 `font-weight:650`、像素 `line-height`。

## 12. 落地分期（提案，待审）

- **P0（本提案）**：定义 token + 角色 + 迁移表，零代码改动。
- **P1**：在 `:root` / `@theme` 落 token 与角色类；新代码强制走 token。
- **P2**：按模块迁移存量（建议顺序 workbench → 聊天面板 → 设置页），每模块过基础回归。
- **P3**：打包 Doto（仅数字子集，配合 readyguy 安装包瘦身），切换 `--font-numeric`；加 §11 gate 转 enforce。

## 13. 验收

- 每个迁移模块：`npm run typecheck` 无错；关键页面渲染与切换正常；中文不掉兜底。
- gate 转 enforce 后：全仓无 `text-[Npx]` 任意字号、无组件内字体栈、无 `650`/像素行高。
- 视觉：标签呈现统一的 mono 大写宽字距；计数/计时数字不跳动。
