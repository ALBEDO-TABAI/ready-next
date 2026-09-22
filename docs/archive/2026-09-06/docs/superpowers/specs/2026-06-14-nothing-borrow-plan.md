---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Nothing 借鉴改进计划（Tier 1 / Tier 2 实践与排期）

> 日期：2026-06-14
> 状态：进行中。本文件汇总从 `vibe-nothing-ui-design`（MIT + SIL OFL）借鉴的条目、落点、风险与排期。
> 关系：液态玻璃材料不变；这里只借「克制纪律」与「点阵签名资产」，不引入对方的零阴影/零渐变/纯单色。
> 关联：排版纪律见 `2026-06-14-typography-token-discipline.md`。

## 判断前提

两套设计在「深度」「颜色」两轴相反，不可整套搬。可借的是：① 几个零依赖、和玻璃不冲突的点阵资产；② 一套「accent 即信号 / token 单源 / 固定刻度 / 动效克制」的纪律。

## Tier 1 — 直接拆下来用

| # | 条目 | 落点 | 状态 | 说明 |
|---|---|---|---|---|
| 1.1 | Doto 圆点点阵数字 | 预算读数/计时/计数/百分比 | **DEFER (P3)** | 需打包字体（二进制资产）且与 readyguy 安装包瘦身冲突，须先做数字子集。临时已用 `tabular-nums` 顶住跳动。 |
| 1.2 | 9×9 点阵图标系统 | agent 状态字形/空状态/桶图标 | **DONE（本次）** | 纯 CSS/JS，从 MIT 字典裁剪。`DotGlyph` + `dot-glyphs.ts`。 |
| 1.3 | 统一状态机 idle/running/needs-input/done/error（形状+标签优先，颜色其次） | 任务卡状态 | **DONE（本次）** | `agent-status-glyph.ts` 把我们 `TaskCardVisualState` 7 态映射到点阵字形 + tone。 |
| 1.4 | 差值混合圆点场 `mix-blend-mode:difference` | ready-glass 皮肤底纹 | **DEFER** | 只对 DOM 自持底有效；native vibrancy 无可差值底，须先在 `#/liquid-test` 调参 + 真实 dev 验收。 |

## Tier 2 — 借纪律

| # | 条目 | 状态 | 落点 / 说明 |
|---|---|---|---|
| 2.5 | accent 是信号不是装饰；激活态反相不上色 | **PARTIAL（本次）** | 点阵 tone：`signal`（红 `--color-red`）只给 needs-input/error/over-budget；running/done/idle 一律 neutral（不上色）。这条已写进测试合同。皮肤层全面收编另排。 |
| 2.6 | token 单源 / 禁裸 hex / 禁 `!important` | **PARTIAL** | 排版 token 已单源化；green/pink/solid-green 皮肤的 `!important` + 裸 hex 蔓延是独立大重构，未做。 |
| 2.7 | 固定刻度（4px 间距 / radius 6·8·pill / 1px hairline） | **PARTIAL** | 字号刻度已落；间距/圆角刻度 gate 未做。 |
| 2.8 | 动效克制（ease-in-out / 无 spring / hover opacity·translateY / 尊重 reduced-motion） | **PARTIAL（本次）** | 点阵 pulse 用 ease-in-out 且 `prefers-reduced-motion` 下停；全局动效审计未做。 |

## 本次实践范围（已实现 + 测试）

- 新增 `src/renderer/components/ui/dot-matrix/`：`dot-glyphs.ts`（9×9 字典 + 取格函数）、`DotGlyph.tsx`（grid 渲染，`--dot-glyph-size` 缩放）、`agent-status-glyph.ts`（7 态→字形/tone/label）、`AgentStatusDot.tsx`（任务卡用包装）。
- `index.css`：`.dot-glyph` 渲染样式 + tone + pulse（含 reduced-motion）。
- 接线：`TaskCard` 状态行在中文 `statusLabel` 前加点阵字形（signal 态字形转红，标签保持灰——颜色落在信号元素上，不染整行）。
- 测试 `src/__tests__/dot-matrix-glyph.test.ts`：字典良构（9×9）、取格计数、映射纪律（signal 仅 needs-input/error/over-budget；running/done 永不 signal）、真实渲染（`renderToStaticMarkup` 断言点亮格数与 tone/pulse 属性）。

## 后续（按价值/风险排序）

1. **Doto 数字子集打包**（1.1）：仅数字 + `% : .`，配合安装包瘦身；切 `--font-numeric`。
2. **ready-glass 差值圆点场原型**（1.4）：`#/liquid-test` 调参 → 真实 dev 截图验收。
3. **皮肤层纪律收编**（2.6）：把 green/pink/solid-green 的裸 hex + `!important` 收进 token，激活态降饱和、只给真信号留色。
4. **间距/圆角刻度 gate**（2.7）+ **全局动效审计**（2.8）。
