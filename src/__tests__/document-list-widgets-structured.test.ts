import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectDocumentWidgets,
  summarizeDocumentWidgets,
  summarizeWidgetRecord
} from '../shared/document-widget-parse'

const SAMPLE = [
  '# 标题',
  '',
  '```show-widget',
  JSON.stringify({
    title: 'lck_week_preview_9_16',
    widget_code: '<svg width="640" height="240"><text x="10" y="40">Week 1 Preview · 9/16 ~ 9/22</text></svg>',
    component_spec: { component: 'week_schedule_card', props: { weekLabel: '9/16' } },
  }),
  '```',
  '',
  '中间正文',
  '',
  '```show-widget',
  JSON.stringify({
    title: 'plan_overview',
    widget_code: '<div><p>Plan Overview body 这是一段较长的纯文本内容用于测试 preview 截断功能，超过 120 字符后应出现省略号。abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz abcdefghijklmnop</p></div>',
    widget_state: { controls: [{ index: 0, tag: 'input', value: 'x' }] },
  }),
  '```',
  '',
].join('\n')

test('summarizeDocumentWidgets 返回结构化清单，含 componentHint 与 preview', () => {
  const summaries = summarizeDocumentWidgets(SAMPLE)
  assert.equal(summaries.length, 2)

  const [first, second] = summaries

  assert.equal(typeof first.id, 'string')
  assert.ok(first.id.length > 0)
  assert.equal(first.index, 1)
  assert.equal(first.title, 'lck_week_preview_9_16')
  assert.equal(first.mode, 'static-svg')
  assert.equal(first.componentHint, 'week_schedule_card')
  assert.match(first.preview, /Week 1 Preview/)
  assert.equal(first.hasState, false)
  assert.equal(first.hasComponentSpec, true)
  assert.equal(first.canPatch, true)
  assert.equal(first.canReplace, true)

  assert.equal(typeof second.id, 'string')
  assert.ok(second.id.length > 0)
  assert.equal(second.index, 2)
  assert.equal(second.title, 'plan_overview')
  assert.equal(second.mode, 'static-html')
  assert.equal(second.componentHint, null, '没有 component_spec 时 componentHint 应为 null')
  assert.ok(second.preview.length <= 121, 'preview 应限制为 120 字符 + 可选省略号')
  assert.ok(second.preview.endsWith('…'), 'preview 超限时末尾应带省略号')
  assert.equal(second.hasState, true, 'widget_state 非空时 hasState 应为 true')
  assert.equal(second.hasComponentSpec, false)
  assert.equal(second.canPatch, false)
  assert.equal(second.canReplace, true)
})

test('summarizeWidgetRecord 对 null componentSpec 字段返回 null hint', () => {
  const records = collectDocumentWidgets([
    '```show-widget',
    JSON.stringify({ title: 'legacy', widget_code: '<svg><text x="0" y="10">legacy</text></svg>' }),
    '```',
  ].join('\n'))
  assert.equal(records.length, 1)
  const summary = summarizeWidgetRecord(records[0])
  assert.equal(summary.componentHint, null)
  assert.equal(summary.hasState, false)
  assert.equal(summary.hasComponentSpec, false)
  assert.equal(summary.canPatch, false)
  assert.equal(summary.canReplace, true)
})

test('非法 component_spec 字段不会污染 summary', () => {
  const summaries = summarizeDocumentWidgets([
    '```show-widget',
    JSON.stringify({
      title: 'w1',
      widget_code: '<div>x</div>',
      component_spec: 'not-an-object',
    }),
    '```',
  ].join('\n'))
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].componentHint, null)
})
