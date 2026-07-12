import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIDGET_SKELETONS,
  WIDGET_SKELETON_IDS,
  WIDGET_SIZE_IDS,
  compileWidgetSkeletonSpec,
  findSkeletonForTriggerKeyword,
  getWidgetSkeleton,
  isKnownWidgetSkeleton,
  widgetSkeletonRequiresTriggerKeyword,
  type WidgetSkeletonId,
  type WidgetSkeletonSpec,
} from '../shared/document-widget-skeletons'

const fixtures: Record<WidgetSkeletonId, Record<string, unknown>> = {
  single_focus: {
    title: '今日所感',
    body: '把所见所闻所想压缩到一张卡片里。',
    attribution: '— Ready 工作台',
  },
  dual_compare: {
    title: '方案 A vs 方案 B',
    left: { heading: '方案 A', items: ['更轻', '上手快'], ramp: 'indigo' },
    right: { heading: '方案 B', items: ['更稳', '生态全'], ramp: 'rose' },
  },
  metric_grid: {
    title: '本周指标',
    period: '2026 年 4 月 W3',
    metrics: [
      { label: '完成任务', value: '23', delta: '+5', delta_direction: 'up', ramp: 'emerald' },
      { label: '专注时长', value: '14.5', unit: 'h', delta: '-1.2', delta_direction: 'down', ramp: 'amber' },
    ],
  },
  vertical_timeline: {
    title: '今日复盘',
    axis_label: '2026-04-20',
    events: [
      { time: '09:30', heading: '晨会', status: 'done' },
      { time: '14:00', heading: 'widget v0.1 对齐', body: 'O1–O8 闭环', status: 'active' },
    ],
  },
  photo_note: {
    title: '苏州拙政园',
    body: '春末的湿气还没散。',
    hero: { type: 'emoji_block', emoji: '🌿', aspect: '4/3' },
    tags: ['旅行', '随笔'],
  },
  chart_focus: {
    title: '本周专注分布',
    chart: {
      type: 'bar',
      ramp: 'sky',
      data: [
        { label: '一', value: 4 },
        { label: '二', value: 6 },
        { label: '三', value: 3 },
      ],
    },
    insight: '周二专注最佳。',
  },
  grid_collection: {
    title: '2026 阅读清单',
    cols: 3,
    item_shape: 'square',
    items: [
      { label: '设计的设计', emoji: '📘' },
      { label: '简约', emoji: '📗' },
      { label: '失控', emoji: '📕' },
      { label: '人月神话', emoji: '📙' },
    ],
  },
  relation_map: {
    heading: '雷雨人物关系',
    groups: [
      { id: 'zhou', label: '周家', position: 'left' },
      { id: 'lu', label: '鲁家', position: 'right' },
    ],
    nodes: [
      { id: 'zhupuyuan', label: '周朴园', group: 'zhou', emphasis: 'primary' },
      { id: 'lushiping', label: '鲁侍萍', group: 'lu' },
    ],
    edges: [{ from: 'zhupuyuan', to: 'lushiping', kind: 'emotion', label: '旧情' }],
  },
  process_flow: {
    heading: '光合作用流程',
    steps: [
      { label: '吸收光能', detail: '叶绿素捕获光子' },
      { label: '水的光解', kind: 'decision', branches: [
        { label: '释放氧气' },
        { label: '产生电子' },
      ] },
      { label: '暗反应固碳' },
    ],
    outcome: { label: '生成葡萄糖', detail: '化学能储存' },
  },
  freeform_static: {
    widget_code: '<div style="padding:16px;">老式电影票</div>',
    aspect_ratio: '4:5',
  },
  freeform_interactive: {
    widget_code: '<div id="x"></div><script>window.__widgetRender=function(t){};</script>',
    aspect_ratio: '1:1',
    supports_animation: true,
  },
}

describe('document widget skeletons v0.1', () => {
  it('defines exactly 11 skeletons (A–G + relation_map/process_flow + H split into static/interactive)', () => {
    assert.equal(WIDGET_SKELETON_IDS.length, 11)
    for (const id of WIDGET_SKELETON_IDS) {
      assert.ok(WIDGET_SKELETONS[id], `missing skeleton: ${id}`)
    }
  })

  it('exposes 7 sizes covering social / portrait / a4 / 4:3 / inline', () => {
    assert.deepEqual([...WIDGET_SIZE_IDS], [
      'square_card',
      'portrait_card',
      'story_card',
      'landscape_card',
      'landscape_4_3',
      'a4_portrait',
      'doc_block',
    ])
  })

  it('compiles every skeleton with a minimal valid props fixture', () => {
    for (const id of WIDGET_SKELETON_IDS) {
      const spec: WidgetSkeletonSpec = { skeleton: id, props: fixtures[id] }
      const compiled = compileWidgetSkeletonSpec(spec)
      assert.equal(compiled.skeleton, id)
      assert.ok(compiled.widgetCode.includes('widget-canvas'), `${id} should wrap with widget-canvas`)
      assert.ok(compiled.widgetCode.includes(`data-widget-skeleton="${id}"`), `${id} canvas marker`)
      assert.ok(compiled.widgetCode.length > 32, `${id} should produce non-trivial output`)
    }
  })

  it('respects requested size if allowed, else falls back to default', () => {
    const allowed = compileWidgetSkeletonSpec({
      skeleton: 'metric_grid',
      size: 'a4_portrait',
      props: fixtures.metric_grid,
    })
    assert.equal(allowed.size, 'a4_portrait')

    const fallback = compileWidgetSkeletonSpec({
      skeleton: 'photo_note',
      size: 'a4_portrait',
      props: fixtures.photo_note,
    })
    assert.equal(fallback.size, WIDGET_SKELETONS.photo_note.defaultSize)
  })

  it('honors background_mode and emits transparent marker into canvas', () => {
    const opaque = compileWidgetSkeletonSpec({
      skeleton: 'single_focus',
      background_mode: 'opaque',
      props: fixtures.single_focus,
    })
    assert.equal(opaque.backgroundMode, 'opaque')
    assert.match(opaque.widgetCode, /data-widget-bg="opaque"/)

    const transparent = compileWidgetSkeletonSpec({
      skeleton: 'single_focus',
      background_mode: 'transparent',
      props: fixtures.single_focus,
    })
    assert.equal(transparent.backgroundMode, 'transparent')
    assert.match(transparent.widgetCode, /data-widget-bg="transparent"/)
  })

  it('marks H1/H2 as keyword-triggered and others as freely usable', () => {
    assert.ok(widgetSkeletonRequiresTriggerKeyword('freeform_static'))
    assert.ok(widgetSkeletonRequiresTriggerKeyword('freeform_interactive'))
    assert.equal(widgetSkeletonRequiresTriggerKeyword('single_focus'), false)
    assert.equal(widgetSkeletonRequiresTriggerKeyword('chart_focus'), false)
  })

  it('routes trigger keywords to H1/H2 and ignores neutral text', () => {
    assert.equal(findSkeletonForTriggerKeyword('做一个超特殊卡片'), 'freeform_static')
    assert.equal(findSkeletonForTriggerKeyword('我要一张交互式数据图'), 'freeform_interactive')
    assert.equal(findSkeletonForTriggerKeyword('做一张周报卡片'), null)
    assert.equal(findSkeletonForTriggerKeyword(''), null)
  })

  it('exposes lookup helpers without throwing on unknown ids', () => {
    assert.ok(getWidgetSkeleton('chart_focus'))
    assert.equal(getWidgetSkeleton('nonexistent_skeleton'), null)
    assert.equal(isKnownWidgetSkeleton('grid_collection'), true)
    assert.equal(isKnownWidgetSkeleton('grid_unknown'), false)
  })

  it('marks freeform_interactive as the only animation-capable skeleton in v0.1', () => {
    const animationCapable = WIDGET_SKELETON_IDS.filter((id) => WIDGET_SKELETONS[id].supportsAnimation)
    assert.deepEqual(animationCapable, ['freeform_interactive'])
  })

  it('rejects malformed props (Zod gate)', () => {
    assert.throws(() => compileWidgetSkeletonSpec({ skeleton: 'single_focus', props: {} as unknown as Record<string, unknown> }))
    assert.throws(() => compileWidgetSkeletonSpec({ skeleton: 'metric_grid', props: { title: 'x', metrics: [] } }))
  })
})
