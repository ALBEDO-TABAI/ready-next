# Document Widget Capability Matrix

## Status

| Family | Local Interaction | Agent Bridge | Snapshot Export | Status |
| --- | --- | --- | --- | --- |
| `stats_card` | Not required | Optional | SVG snapshot | stable |
| `bar_chart` | simple toggle only | supported | HTML snapshot | stable |
| `line_chart` | simple toggle only | supported | HTML/SVG snapshot | stable |
| `weekly_focus_chart` | week toggle | supported | HTML snapshot | stable |
| `tab_info_block` | tab switch | supported | HTML snapshot | stable |
| `mini_calculator` | local compute | supported | HTML snapshot | stable |
| `flow_diagram` | optional node click | supported | SVG snapshot | stable |
| multi-chart dashboard | partial | partial | partial | partial |
| deep drill-down analytics | partial | supported | partial | planned |

## Notes

- `stable` means there is a preferred implementation style and the runtime can support it end-to-end.
- `partial` means the runtime can execute the pattern, but we do not yet have a strong fixture library or export guarantees.
- `planned` means the interaction shape is understood, but we have not yet built a robust baseline.
