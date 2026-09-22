# Document Widget Baselines

> 核对日期：2026-09-06。本文描述当前受控组件选择；字段与实现真值为 `src/shared/document-widget-openui.ts`、`document-widget-skeletons.ts`、`document-widget-theme.ts` 和 `document-widget-dot-charts.ts`。

## Purpose

文档卡片从结构化 `component_spec` / `skeleton_spec` 编译。信息卡、图表、关系图与流程图使用 `document_insert_widget`，不以 Markdown 表格或任意 HTML 冒充。预览、保存、重新打开和导出共享结构与令牌。

## Supported Families

| 场景 | 当前组件 |
| --- | --- |
| 摘要、指标、提醒 | `info_card`、`stats_card`、`callout_block` |
| 对照、表格、进度 | `comparison_grid`、`data_table`、`progress_snapshot` |
| 数据比较与趋势 | `bar_chart`、`line_chart` |
| 周重点与分组文字 | `weekly_focus_chart`、`tab_info_block` |
| 计算与手动计划 | `mini_calculator`、`todo_list_manual`、`weekly_plan_board_manual`、`habit_streak_manual` |
| 关系与过程 | `relationship_graph`、`flow_diagram`；结构骨架另含 `relation_map`、`process_flow` |
| 日程快照 | `day_schedule_card`、`week_schedule_card`、`time_allocation_chart`、`today_focus_snapshot` |

当前 OpenUI 注册组件统一标记 `html-inline-script`，具体图表和图形由 Ready 编译器生成。类型中保留 `svg/chartjs` 不等于默认应手写 SVG 或加载 Chart.js。字段清单由 [OpenUI Prompt](DOCUMENT_WIDGET_OPENUI_PROMPT.md) 生成。

## Weekly Focus Chart

`weekly_focus_chart` 适合“本周 / 下周”重点切换；每页保留少量重点，采用单卡片的本地切换。周重点文字不是数值趋势；“科研绘图”“投资趋向”“数据动态变化”通常由 `line_chart` 表达，需要实际数据和标注，不能从组件样式生成事实。

请求示例：

```text
读取当前文档，在适当位置插入一张 weekly_focus_chart 信息卡并保存。
保留本周 / 下周两个切换页，每页展示 3–5 个重点；沿用 Ready 主题。
```

执行前仍需本轮明确的当前文档指向、读取回执与写入授权，示例文字不会绕过这些检查。

## Style Vocabulary

Use these style words to reduce drift between user intent and generated widgets.

### warm_minimal
- warm paper hierarchy from Ready theme tokens
- use the same Ready accent and restrained dividers
- no separate palette or shadow system

### dashboard
- denser information layout
- clearer metrics and chart framing
- stronger emphasis on data labels

### notebook
- document-like card feeling
- softer dividers
- readable note-oriented spacing

### editorial
- stronger typography hierarchy
- more dramatic spacing and titles
- suitable for explanation-heavy visual storytelling

### bold_data
- higher contrast
- more assertive accents
- still constrained to one focused card

### academic
- restrained colors
- annotation-friendly labels
- clean explanatory structure

## Recommended Defaults

- 优先使用受控组件与结构骨架；颜色、字号、边界与图表走共享令牌。
- 风格词只调信息密度和层级；不开放彩虹色、饼图或独立装饰系统。
- 关系图用节点、分组和边；流程图用结构步骤，不手排 SVG 坐标。
- 本地交互和请求 Agent 更新分开：现有 receiver 接收事件，写回仍走宿主授权与精确 Widget 目标。
- Widget 不自行 fetch 最新事实。需要实时内容时由本轮网页查询提供依据，再更新同一目标。
- 书本阅读只展示经过净化的静态 Widget，不创建 iframe 或交互写回。

## Validation Checklist

- 当前文档与 Widget 身份准确，结构可重建。
- 预览、编辑、保存、重开和导出使用同一主题与内容。
- iframe、receiver 和导出脚本使用共享 nonce；事件经 `data-ready-on*` 桥处理。
- 运行 `npm run verify:widget-ready`，并完成与修改有关的真实 Electron 检查。

历史样例见 [Widget fixtures](widget-fixtures/README.md)，组件能力边界见 [Capability Matrix](DOCUMENT_WIDGET_CAPABILITY_MATRIX.md)。
