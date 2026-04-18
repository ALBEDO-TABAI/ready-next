import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectDocumentWidgets,
  tryParseWidgetPayload,
  type DocumentWidgetComponentSpecSummary,
} from '../shared/document-widget-parse'

function buildFenceFixture(payload: Record<string, unknown>): string {
  return ['```show-widget', JSON.stringify(payload), '```'].join('\n')
}

test('fence 内 component_spec 可 round-trip', () => {
  const spec: DocumentWidgetComponentSpecSummary = {
    component: 'info_card',
    props: { heading: 'h', body: 'b', tone: 'warning' },
  }
  const fence = buildFenceFixture({
    title: 'card_a',
    widget_code: '<div>x</div>',
    component_spec: spec,
  })
  const records = collectDocumentWidgets(fence)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].componentSpec, spec)
})

test('老格式 (无 component_spec) 解析不崩且 componentSpec === null', () => {
  const fence = buildFenceFixture({
    title: 'legacy_card',
    widget_code: '<svg><text x="0" y="10">hi</text></svg>',
  })
  const records = collectDocumentWidgets(fence)
  assert.equal(records.length, 1)
  assert.equal(records[0].componentSpec, null)
})

test('component_spec 字段为非对象时被忽略，不污染解析', () => {
  const fence = buildFenceFixture({
    title: 'bad_spec',
    widget_code: '<div>y</div>',
    component_spec: 'oops',
  })
  const parsed = tryParseWidgetPayload(
    JSON.stringify({
      title: 'bad_spec',
      widget_code: '<div>y</div>',
      component_spec: 'oops',
    }),
    fence,
  )
  assert.ok(parsed)
  assert.equal(parsed!.componentSpec, null)
})

test('componentSpec 缺少 component 字段时忽略', () => {
  const fence = buildFenceFixture({
    title: 'missing_component',
    widget_code: '<div>z</div>',
    component_spec: { props: { heading: 'h' } },
  })
  const records = collectDocumentWidgets(fence)
  assert.equal(records[0].componentSpec, null)
})
