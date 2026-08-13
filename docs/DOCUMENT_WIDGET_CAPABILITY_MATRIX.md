# Document Widget Capability Matrix

## Status

| Family | Local Interaction | Agent Bridge | Snapshot Export | Status |
| --- | --- | --- | --- | --- |
| `info_card` | Not required | Optional | HTML snapshot | stable |
| `stats_card` | Not required | Optional | SVG snapshot | stable |
| `bar_chart` | simple toggle only | supported | HTML snapshot | stable |
| `line_chart` | simple toggle only | supported | HTML/SVG snapshot | stable |
| `data_table` | Not required | Optional | HTML snapshot | stable |
| `callout_block` | Not required | Optional | HTML snapshot | stable |
| `weekly_focus_chart` | week toggle | supported | HTML snapshot | stable |
| `tab_info_block` | tab switch | supported | HTML snapshot | stable |
| `comparison_grid` | Not required | Optional | HTML snapshot | stable |
| `progress_snapshot` | Not required | Optional | HTML snapshot | stable |
| `mini_calculator` | local compute | supported | HTML snapshot | stable |
| `flow_diagram` | optional node click | supported | SVG snapshot | stable |
| `day_schedule_card` | read snapshot + action trigger | supported | HTML snapshot | stable |
| `week_schedule_card` | read snapshot + action trigger | supported | HTML snapshot | stable |
| `time_allocation_chart` | read snapshot + action trigger | supported | SVG snapshot | stable |
| `todo_list_manual` | local toggle | optional | HTML snapshot | stable |
| `weekly_plan_board_manual` | local reorder-light | optional | HTML snapshot | stable |
| `habit_streak_manual` | local toggle | optional | HTML snapshot | stable |
| `today_focus_snapshot` | read snapshot + action trigger | supported | HTML snapshot | stable |
| multi-chart dashboard | partial | partial | partial | partial |
| deep drill-down analytics | partial | supported | partial | planned |

## Notes

- `stable` means there is a preferred implementation style and the runtime can support it end-to-end.
- `partial` means the runtime can execute the pattern, but we do not yet have a strong fixture library or export guarantees.
- `planned` means the interaction shape is understood, but we have not yet built a robust baseline.
- `action trigger` means the widget itself不直接重做编辑器，而是通过现有入口或既有动作完成写回。
