import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mapComponentSpecToSkeletonSpec } from '../shared/document-widget-skeleton-mapping'
import {
  compileWidgetSkeletonSpec,
  type WidgetSkeletonSpec,
} from '../shared/document-widget-skeletons'

function requireSpec(spec: WidgetSkeletonSpec | null): WidgetSkeletonSpec {
  assert.ok(spec, 'mapping returned null')
  return spec
}

function requireRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

describe('document widget skeleton mapping (openui components → skeletons)', () => {
  it('maps info_card → single_focus preserving structured facts instead of flattening them into a text wall', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'info_card',
        props: {
          heading: '今日重点',
          body: '同步版本说明。',
          facts: [{ label: '状态', value: '已完成' }],
          points: ['准备发布'],
        },
      }),
    )
    assert.equal(spec.skeleton, 'single_focus')
    const props = requireRecord(spec.props)
    assert.equal(props.title, '今日重点')
    assert.match(String(props.body), /同步版本说明。/)
    assert.deepEqual(props.facts, [{ label: '状态', value: '已完成' }])
    assert.deepEqual(props.points, ['准备发布'])
    const compiled = compileWidgetSkeletonSpec(spec)
    assert.match(compiled.widgetCode, /今日重点/)
    assert.match(compiled.widgetCode, /data-info-facts/)
    assert.match(compiled.widgetCode, /状态/)
  })

  it('maps stats_card → metric_grid with metrics preserved', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'stats_card',
        props: {
          heading: '关键指标',
          metrics: [
            { label: '完成任务', value: '23', unit: '', delta: '+5', deltaDirection: 'up' },
            { label: '专注', value: '14.5', unit: 'h' },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'metric_grid')
    const props = requireRecord(spec.props)
    assert.equal(props.title, '关键指标')
    const metrics = props.metrics as Array<Record<string, unknown>>
    assert.equal(metrics.length, 2)
    assert.equal(metrics[0].label, '完成任务')
    const compiled = compileWidgetSkeletonSpec(spec)
    assert.match(compiled.widgetCode, /完成任务/)
  })

  it('maps bar_chart → chart_focus (type=bar)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'bar_chart',
        props: {
          heading: '分类对比',
          series: [
            { label: '一', value: 4 },
            { label: '二', value: 7 },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'chart_focus')
    const props = requireRecord(spec.props)
    const chart = requireRecord(props.chart)
    assert.equal(chart.type, 'bar')
    assert.equal((chart.data as unknown[]).length, 2)
    const compiled = compileWidgetSkeletonSpec(spec)
    assert.match(compiled.widgetCode, /分类对比/)
  })

  it('maps line_chart → chart_focus (type=line)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'line_chart',
        props: {
          heading: '趋势',
          series: [
            { label: 'W1', value: 10 },
            { label: 'W2', value: 14 },
            { label: 'W3', value: 17 },
          ],
          annotation: '周趋势向上',
        },
      }),
    )
    assert.equal(spec.skeleton, 'chart_focus')
    const props = requireRecord(spec.props)
    const chart = requireRecord(props.chart)
    assert.equal(chart.type, 'line')
    assert.equal(props.insight, '周趋势向上')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps data_table → metric_grid (compact)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'data_table',
        props: {
          heading: '明细',
          columns: ['类别', '数量'],
          rows: [
            { cells: ['A', '10'] },
            { cells: ['B', '20'] },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'metric_grid')
    const props = requireRecord(spec.props)
    assert.equal(props.title, '明细')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps callout_block → single_focus with left_bar decoration', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'callout_block',
        props: { heading: '发布提醒', body: '今晚 20:00 完成。', tone: 'warning' },
      }),
    )
    assert.equal(spec.skeleton, 'single_focus')
    const props = requireRecord(spec.props)
    assert.equal(props.decoration, 'left_bar')
    assert.equal(props.ramp, 'amber')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps tab_info_block → dual_compare (first two tabs)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'tab_info_block',
        props: {
          heading: '分组',
          tabs: [
            { label: '本周', points: ['对齐 v0.1', '准备 M1'] },
            { label: '下周', points: ['收口 M4', '文档补齐'] },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'dual_compare')
    const props = requireRecord(spec.props)
    assert.equal(props.title, '分组')
    const left = requireRecord(props.left)
    assert.equal(left.heading, '本周')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps comparison_grid → dual_compare preserving first two columns', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'comparison_grid',
        props: {
          heading: '方案对比',
          columns: [
            { heading: '方案 A', points: ['更轻', '上手快'] },
            { heading: '方案 B', points: ['更稳', '生态全'] },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'dual_compare')
    const props = requireRecord(spec.props)
    const right = requireRecord(props.right)
    assert.equal(right.heading, '方案 B')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps progress_snapshot → metric_grid with percentages', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'progress_snapshot',
        props: {
          heading: '完成度',
          items: [
            { label: '计划 A', percent: 60 },
            { label: '计划 B', percent: 100 },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'metric_grid')
    const props = requireRecord(spec.props)
    const metrics = props.metrics as Array<Record<string, unknown>>
    assert.equal(metrics[1].delta_direction, 'up')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps weekly_focus_chart → dual_compare (current vs next)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'weekly_focus_chart',
        props: {
          currentLabel: '本周',
          nextLabel: '下周',
          currentItems: [{ label: '完成 M1' }, { label: '启动 M2' }],
          nextItems: [{ label: '完成 M4' }],
        },
      }),
    )
    assert.equal(spec.skeleton, 'dual_compare')
    const props = requireRecord(spec.props)
    const left = requireRecord(props.left)
    assert.equal(left.heading, '本周')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps mini_calculator → freeform_interactive (animation capable)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'mini_calculator',
        props: {
          heading: '评分',
          fields: [
            { id: 'a', label: '输入 A', value: 1 },
            { id: 'b', label: '输入 B', value: 2 },
          ],
          outputLabel: '总分',
        },
      }),
    )
    assert.equal(spec.skeleton, 'freeform_interactive')
    const props = requireRecord(spec.props)
    assert.equal(props.supports_animation, true)
    assert.ok(String(props.widget_code).length > 0)
    compileWidgetSkeletonSpec(spec)
  })

  it('maps flow_diagram → process_flow (graph structure preserved)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'flow_diagram',
        props: {
          heading: '流程',
          nodes: [
            { id: 'n1', label: '开始' },
            { id: 'n2', label: '审阅' },
            { id: 'n3', label: '发布' },
          ],
          edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
        },
      }),
    )
    assert.equal(spec.skeleton, 'process_flow')
    const props = requireRecord(spec.props)
    const steps = props.steps as Array<Record<string, unknown>>
    assert.equal(steps.length, 3)
    assert.equal(steps[0].label, '开始')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps flow_diagram branches (out-degree >= 2) into decision steps', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'flow_diagram',
        props: {
          heading: '评审流程',
          nodes: [
            { id: 'n1', label: '提交' },
            { id: 'n2', label: '通过' },
            { id: 'n3', label: '驳回' },
          ],
          edges: [
            { from: 'n1', to: 'n2', label: '质检 OK' },
            { from: 'n1', to: 'n3', label: '质检失败' },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'process_flow')
    const props = requireRecord(spec.props)
    const steps = props.steps as Array<Record<string, unknown>>
    assert.equal(steps[0].kind, 'decision')
    const branches = steps[0].branches as Array<Record<string, unknown>>
    assert.equal(branches.length, 2)
    assert.equal(branches[0].label, '通过')
    assert.equal(branches[0].detail, '质检 OK')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps relationship_graph → relation_map (nodes/edges passthrough)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'relationship_graph',
        props: {
          heading: '人物关系',
          groups: [{ id: 'zhou', label: '周家', position: 'left' }],
          nodes: [
            { id: 'a', label: '周朴园', group: 'zhou' },
            { id: 'b', label: '鲁侍萍' },
          ],
          edges: [{ from: 'a', to: 'b', kind: 'emotion', label: '旧情' }],
        },
      }),
    )
    assert.equal(spec.skeleton, 'relation_map')
    const props = requireRecord(spec.props)
    assert.equal((props.nodes as unknown[]).length, 2)
    assert.equal((props.edges as unknown[]).length, 1)
    assert.equal(props.heading, '人物关系')
    const compiled = compileWidgetSkeletonSpec(spec)
    assert.match(compiled.widgetCode, /周朴园/)
    assert.match(compiled.widgetCode, /data-rg-node/)
  })

  it('maps day_schedule_card → vertical_timeline', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'day_schedule_card',
        props: {
          dateLabel: '2026-04-20',
          events: [
            { startTime: '09:30', title: '晨会', status: 'done' },
            { startTime: '14:00', title: 'widget 对齐', status: 'active' },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'vertical_timeline')
    const props = requireRecord(spec.props)
    assert.equal(props.axis_label, '2026-04-20')
    const events = props.events as Array<Record<string, unknown>>
    assert.equal(events[0].status, 'done')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps week_schedule_card → vertical_timeline (flattened)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'week_schedule_card',
        props: {
          weekLabel: 'W16',
          days: [
            { dateLabel: '周一', events: [{ title: '对齐会' }] },
            { dateLabel: '周二', events: [{ title: '启动 M2' }] },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'vertical_timeline')
    const props = requireRecord(spec.props)
    assert.equal(props.axis_label, 'W16')
    const events = props.events as Array<Record<string, unknown>>
    assert.equal(events.length, 2)
    compileWidgetSkeletonSpec(spec)
  })

  it('maps time_allocation_chart → chart_focus (type=pie)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'time_allocation_chart',
        props: {
          heading: '时间分配',
          periodLabel: '本周',
          segments: [
            { label: '编码', value: 18 },
            { label: '会议', value: 6 },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'chart_focus')
    const props = requireRecord(spec.props)
    const chart = requireRecord(props.chart)
    assert.equal(chart.type, 'pie')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps schedule_runtime_card → vertical_timeline with statuses', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'schedule_runtime_card',
        props: {
          heading: '自动计划',
          jobs: [
            { name: '数据同步', status: 'running', schedule: 'hourly' },
            { name: '日报推送', status: 'failed', schedule: '18:00' },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'vertical_timeline')
    const props = requireRecord(spec.props)
    const events = props.events as Array<Record<string, unknown>>
    assert.equal(events[0].status, 'active')
    assert.equal(events[1].status, 'blocked')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps todo_list_manual → vertical_timeline with done state', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'todo_list_manual',
        props: {
          heading: '今日待办',
          items: [
            { label: '审阅 PR', done: true },
            { label: '写周报', done: false },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'vertical_timeline')
    const props = requireRecord(spec.props)
    const events = props.events as Array<Record<string, unknown>>
    assert.equal(events[0].status, 'done')
    assert.equal(events[1].status, 'pending')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps weekly_plan_board_manual → grid_collection', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'weekly_plan_board_manual',
        props: {
          heading: '本周计划',
          lanes: [
            { heading: '进行中', cards: [{ label: 'M2 映射层' }] },
            { heading: '待办', cards: [{ label: 'M4 抽屉' }, { label: 'M6 文档' }] },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'grid_collection')
    const props = requireRecord(spec.props)
    const items = props.items as Array<Record<string, unknown>>
    assert.ok(items.length >= 2)
    compileWidgetSkeletonSpec(spec)
  })

  it('maps habit_streak_manual → grid_collection (done states)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'habit_streak_manual',
        props: {
          heading: '习惯',
          habits: [
            { label: '跑步', done: true },
            { label: '读书', done: false },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'grid_collection')
    const props = requireRecord(spec.props)
    const items = props.items as Array<Record<string, unknown>>
    assert.equal(items[0].status, 'done')
    compileWidgetSkeletonSpec(spec)
  })

  it('maps today_focus_snapshot → metric_grid (metrics preferred)', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec({
        component: 'today_focus_snapshot',
        props: {
          dayLabel: '2026-04-20',
          highlights: ['收口 M2', '准备 M3'],
          metrics: [
            { label: '专注', value: '5.2', unit: 'h' },
            { label: '任务', value: '7' },
          ],
        },
      }),
    )
    assert.equal(spec.skeleton, 'metric_grid')
    const props = requireRecord(spec.props)
    assert.equal(props.title, '2026-04-20')
    const metrics = props.metrics as Array<Record<string, unknown>>
    assert.equal(metrics.length, 2)
    compileWidgetSkeletonSpec(spec)
  })

  it('honors background_mode option', () => {
    const spec = requireSpec(
      mapComponentSpecToSkeletonSpec(
        { component: 'info_card', props: { heading: 'x', body: 'y' } },
        { backgroundMode: 'transparent' },
      ),
    )
    assert.equal(spec.background_mode, 'transparent')
  })

  it('returns null for unknown components', () => {
    assert.equal(
      mapComponentSpecToSkeletonSpec({ component: 'nonexistent_component', props: {} }),
      null,
    )
  })
})
