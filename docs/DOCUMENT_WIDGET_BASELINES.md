# Document Widget Baselines

## Purpose
- Give the document module a stable set of widget reference patterns.
- Provide agent-facing prompt baselines so generated widgets are less random and easier to validate.
- Define which implementation style is preferred for each widget family.

## Supported Families

### 0. Info Card
- Best for: 摘要、结论、推荐、单条重点说明
- Preferred implementation: `HTML + CSS`
- Why: 结构简单，最适合先约束成稳定模板

### 0.1 Data Table
- Best for: 对照表、明细表、小型统计表
- Preferred implementation: `HTML table`
- Why: 结构化强，适合直接走字段约束而不是自由 HTML

### 0.2 Callout Block
- Best for: 提示、风险、建议、结论、提醒
- Preferred implementation: `HTML + CSS`
- Why: 比自由信息卡更容易保持语气和结构一致

### 0.3 Comparison Grid
- Best for: 方案对比、选项比较、优劣分栏
- Preferred implementation: `HTML + CSS`

### 0.4 Progress Snapshot
- Best for: 完成度、阶段状态、推进概览
- Preferred implementation: `HTML + CSS`

### 1. Stats Card
- Best for: summary dashboards, reading notes, KPI snapshots
- Preferred implementation: `SVG`
- Why: predictable layout, sharp rendering, easy validation

Prompt pattern:
```text
请直接修改当前文档并保存。
插入一个纯 SVG 的统计卡 widget，标题使用 snake_case。
要求：
1. 只做 3-4 个指标
2. 布局横向均分
3. 颜色适配当前浅色文档
4. 不使用外部脚本
```

### 2. Bar Chart
- Best for: category comparison, weekly summaries
- Preferred implementation: `Chart.js`
- Fallback: `SVG`
- Why: lightweight script widget, stable enough for small datasets

Prompt pattern:
```text
请直接更新当前文档中的指定 widget，不要新增第二个。
生成一个小型柱状图 widget：
1. 4-6 个分类
2. 支持一组简单切换按钮
3. 仅使用白名单 CDN
4. 保持单卡片视觉
```

### 3. Line Chart
- Best for: trend tracking, time series summaries
- High-frequency asks:
  - 科研绘图
  - 投资趋向
  - 数据动态
- Preferred implementation: `Chart.js`
- Fallback: `SVG polyline`

### 4. Tab Info Block
- Best for: multi-state note summaries, grouped findings
- Preferred implementation: `HTML + CSS + minimal inline script`
- Why: interaction simple, easier than full chart runtime

### 5. Mini Calculator
- Best for: budget, score, estimate widgets
- Preferred implementation: `HTML + CSS + inline script`
- Constraints:
  - local calculation only
  - no fetch
  - no form submit

### 6. Flow Diagram
- Best for: process notes, research flow, architecture summaries
- Preferred implementation: `SVG`
- Why: no script required, good visual consistency

### 7. Weekly Focus Chart
- Best for: 本周 / 下周重点对比、周报卡片、轻量计划切换
- Preferred implementation: `HTML + CSS + minimal inline script`
- Stable title hint: `weekly_focus_chart`
- Stable interaction:
  - two-state toggle only: `本周` / `下周`
  - each state shows 3-5 focus rows
  - avoid unbounded vertical growth after switching
- Why: the interaction is semantically closer to a tabbed info card than a heavy chart runtime

### 8. Day Schedule Card
- Best for: 单日安排、今日事件卡、时间块概览
- Preferred implementation: `HTML + CSS + minimal inline script`
- Data source: `calendar`
- Writeback: trigger existing calendar entrypoints

### 9. Week Schedule Card
- Best for: 周视角安排总览、每日重点预览
- Preferred implementation: `HTML + CSS + minimal inline script`
- Data source: `calendar`
- Writeback: trigger existing calendar entrypoints

### 10. Time Allocation Chart
- Best for: 时间分配、时间占比、工作/内容/生活聚合
- Preferred implementation: `SVG`
- Data source: `calendar`

### 11. Schedule Runtime Card
- Best for: 自动计划、定时任务、运行状态概览
- Preferred implementation: `HTML + CSS`
- Data source: `schedule`
- Writeback: trigger existing schedule entrypoints

### 12. Todo List Manual
- Best for: 文档内手填待办清单
- Preferred implementation: `HTML + CSS + inline script`
- Data source: `manual`

### 13. Weekly Plan Board Manual
- Best for: 文档内手填周计划板
- Preferred implementation: `HTML + CSS`
- Data source: `manual`

### 14. Habit Streak Manual
- Best for: 文档内手填习惯连续记录
- Preferred implementation: `HTML + CSS`
- Data source: `manual`

### 15. Today Focus Snapshot
- Best for: 今日重点摘要、今天的关键信息快照
- Preferred implementation: `HTML + CSS`
- Data source: `calendar + schedule`

Prompt pattern:
```text
请直接修改当前文档并保存。
插入一个标题为 weekly_focus_chart 的 show-widget。
要求：
1. 顶部只有“本周 / 下周”两个切换项
2. 每个切换页只展示 3-5 个重点
3. 单卡片，不做多面板
4. 控制高度，不要无限延长
5. 本地切换，不要 fetch
```

## Style Vocabulary

Use these style words to reduce drift between user intent and generated widgets.

### warm_minimal
- beige / cream / soft warm background
- low-saturation accent colors
- gentle borders and card shadows

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
- If a widget can be expressed clearly in SVG, prefer SVG first.
- 优先使用受控组件家族：信息卡、表格、提示块、折线图、柱状图、对比网格、进度概览，以及个性化数据卡。
- If interaction is needed, prefer tiny `HTML + CSS + inline script`.
- Use `Chart.js` only for chart-shaped interaction, not as a generic rendering hammer.
- If the user asks for weekly comparison or week switching, prefer the `weekly_focus_chart` pattern before inventing a custom multi-tab widget.
- Keep widget code compact; prefer a single card or a single block of focus.

## Not Recommended
- iframe inside widget
- external data fetch
- complex framework runtime
- multi-panel mini apps
- oversized unstructured HTML blobs
- global CSS resets

## Validation Checklist
- title is explicit and stable
- widget type matches the requested task
- no empty shell output
- no duplicated widget with same title unless explicitly requested
- preview readable in both edit-card preview and full preview mode
