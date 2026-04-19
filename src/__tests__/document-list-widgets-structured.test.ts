import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildListWidgetsUserFacingText,
  collectDocumentWidgets,
  summarizeDocumentWidgets,
  summarizeWidgetRecord,
  type DocumentWidgetSummary,
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

function makeSummary(index: number, title: string): DocumentWidgetSummary {
  return {
    id: `widget_${index.toString(16).padStart(6, '0')}`,
    index,
    title,
    mode: 'static-html',
    componentHint: null,
    preview: `${title} preview`,
    hasState: false,
    hasComponentSpec: false,
    canPatch: false,
    canReplace: true,
  }
}

test('buildListWidgetsUserFacingText 0 个 widget 给出新增引导', () => {
  const text = buildListWidgetsUserFacingText({ summaries: [], tabTitle: '需求文档.md' })
  assert.match(text, /「需求文档\.md」/)
  assert.match(text, /暂无 widget/)
  assert.doesNotMatch(text, /widget:/i)
  assert.doesNotMatch(text, /已查到/)
})

test('buildListWidgetsUserFacingText 1 个 widget 给出短句', () => {
  const text = buildListWidgetsUserFacingText({
    summaries: [makeSummary(1, 'ready_positioning_card')],
    tabTitle: '需求文档.md',
  })
  assert.match(text, /已查到「需求文档\.md」中的 1 个 widget/)
  assert.match(text, /「ready_positioning_card」/)
  assert.match(text, /请指出具体标题或序号/)
  assert.ok(text.length < 120, `文案应控制在 120 字以内，当前长度 ${text.length}`)
})

test('buildListWidgetsUserFacingText 3 个 widget 罗列全部，不出现"等"', () => {
  const text = buildListWidgetsUserFacingText({
    summaries: [
      makeSummary(1, 'A'),
      makeSummary(2, 'B'),
      makeSummary(3, 'C'),
    ],
    tabTitle: '需求文档.md',
  })
  assert.match(text, /3 个 widget/)
  assert.match(text, /「A」、「B」、「C」/)
  assert.doesNotMatch(text, /示例/)
  assert.doesNotMatch(text, /等。/)
})

test('buildListWidgetsUserFacingText 6 个 widget 走"示例…等"分支且不泄漏内部字段', () => {
  const summaries: DocumentWidgetSummary[] = []
  for (let i = 1; i <= 6; i += 1) {
    summaries.push(makeSummary(i, `卡片${i}`))
  }
  const text = buildListWidgetsUserFacingText({ summaries, tabTitle: '需求文档.md' })
  assert.match(text, /6 个 widget/)
  assert.match(text, /示例：「卡片1」、「卡片2」、「卡片3」 等/)
  assert.doesNotMatch(text, /id=widget_/)
  assert.doesNotMatch(text, /可 patch/)
  assert.doesNotMatch(text, /```json/)
  assert.doesNotMatch(text, /「卡片4」/)
})

test('buildListWidgetsUserFacingText 缺失 tabTitle 时降级为"当前文档"', () => {
  const text = buildListWidgetsUserFacingText({
    summaries: [makeSummary(1, 'only_card')],
    tabTitle: '',
  })
  assert.match(text, /^已查到当前文档中的 1 个 widget/)
  assert.doesNotMatch(text, /「」/)
})
