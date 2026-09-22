# Document Widget Capability Matrix

> 核对日期：2026-09-06。组件注册与动作政策以 `src/shared/document-widget-openui.ts` 为准。本表是样例覆盖导览，不是每一组件当前已做安装验收的证明。

## Status

| Family | Local Interaction | Agent Bridge | Snapshot Export | Status |
| --- | --- | --- | --- | --- |
| `info_card` | Not required | Optional | HTML snapshot | stable |
| `stats_card` | Not required | Optional | compiled static snapshot | stable |
| `bar_chart` | simple toggle only | supported | HTML snapshot | stable |
| `line_chart` | simple toggle only | supported | compiled static snapshot | stable |
| `data_table` | Not required | Optional | HTML snapshot | stable |
| `callout_block` | Not required | Optional | HTML snapshot | stable |
| `weekly_focus_chart` | week toggle | supported | HTML snapshot | stable |
| `tab_info_block` | tab switch | supported | HTML snapshot | stable |
| `comparison_grid` | Not required | Optional | HTML snapshot | stable |
| `progress_snapshot` | Not required | Optional | HTML snapshot | stable |
| `mini_calculator` | local compute | supported | HTML snapshot | stable |
| `flow_diagram` | optional node click | supported | compiled static snapshot | stable |
| `day_schedule_card` | read snapshot + action trigger | supported | HTML snapshot | stable |
| `week_schedule_card` | read snapshot + action trigger | supported | HTML snapshot | stable |
| `time_allocation_chart` | read snapshot + action trigger | supported | compiled static snapshot | stable |
| `todo_list_manual` | local toggle | optional | HTML snapshot | stable |
| `weekly_plan_board_manual` | local reorder-light | optional | HTML snapshot | stable |
| `habit_streak_manual` | local toggle | optional | HTML snapshot | stable |
| `today_focus_snapshot` | read snapshot + action trigger | supported | HTML snapshot | stable |
| multi-chart dashboard | partial | partial | partial | partial |
| deep drill-down analytics | partial | supported | partial | planned |
| `relationship_graph` | optional node interaction | guarded update | compiled static snapshot | registered |

## Notes

- `stable` 标记已有受控组件与参考样例，不代表本次完成每种组件的端到端或安装验收。
- `partial` means the runtime can execute the pattern, but we do not yet have a strong fixture library or export guarantees.
- `planned` means the interaction shape is understood, but we have not yet built a robust baseline.
- `action trigger` means the widget itself不直接重做编辑器，而是通过现有入口或既有动作完成写回。

当前组件均通过 Ready 结构编译器与共享令牌输出；历史样例中的自由 SVG/Chart.js 不再是生成默认值。日程写入须经当前产品动作与确认，表中 `supported` 不授予任意脚本或网络权限。书本阅读与静态导出不保留活动 receiver。验证入口是 `verify:widget-ready`，当前字段见 [生成的 OpenUI 说明](DOCUMENT_WIDGET_OPENUI_PROMPT.md)。
