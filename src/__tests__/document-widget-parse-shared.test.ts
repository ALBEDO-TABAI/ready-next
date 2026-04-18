import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectDocumentWidgets,
  getWidgetRenderMode,
  parseShowWidgetFences,
  tryParseWidgetPayload,
} from '../shared/document-widget-parse'

const FIXTURE = [
  '# Heading',
  '',
  '```show-widget',
  '{"title":"summary","widget_code":"<div>hi</div>"}',
  '```',
  '',
  '中间正文。',
  '',
  '```show-widget',
  '{"title":"chart","widget_code":"<svg><rect/></svg>"}',
  '```',
  '',
  '尾段。',
  '',
  '```show-widget',
  '{"title":"live","widget_code":"<div><script>1</script></div>"}',
  '```',
  '',
].join('\n')

describe('shared document-widget-parse', () => {
  it('tryParseWidgetPayload accepts both widget_code and widgetCode keys', () => {
    const snake = tryParseWidgetPayload('{"title":"a","widget_code":"<b/>"}', 'fence')
    const camel = tryParseWidgetPayload('{"title":"a","widgetCode":"<b/>"}', 'fence')
    assert.equal(snake?.widgetCode, '<b/>')
    assert.equal(camel?.widgetCode, '<b/>')
  })

  it('tryParseWidgetPayload rejects empty widget_code / malformed JSON', () => {
    assert.equal(tryParseWidgetPayload('{"title":"a","widget_code":""}', 'fence'), null)
    assert.equal(tryParseWidgetPayload('not-json', 'fence'), null)
  })

  it('getWidgetRenderMode classifies scripted, svg, and html', () => {
    assert.equal(getWidgetRenderMode('<div><script>1</script></div>'), 'scripted')
    assert.equal(getWidgetRenderMode('<svg><rect/></svg>'), 'static-svg')
    assert.equal(getWidgetRenderMode('<div>hi</div>'), 'static-html')
  })

  it('collectDocumentWidgets returns structured records in order', () => {
    const widgets = collectDocumentWidgets(FIXTURE)
    assert.equal(widgets.length, 3)
    assert.equal(widgets[0].index, 1)
    assert.equal(widgets[0].title, 'summary')
    assert.equal(widgets[0].mode, 'static-html')
    assert.equal(widgets[1].index, 2)
    assert.equal(widgets[1].title, 'chart')
    assert.equal(widgets[1].mode, 'static-svg')
    assert.equal(widgets[2].index, 3)
    assert.equal(widgets[2].title, 'live')
    assert.equal(widgets[2].mode, 'scripted')
    assert.ok(widgets[0].start < widgets[1].start)
    assert.ok(widgets[1].end <= widgets[2].start)
  })

  it('collectDocumentWidgets falls back to synthetic title when missing', () => {
    const source = [
      '```show-widget',
      '{"widget_code":"<div/>"}',
      '```',
    ].join('\n')
    const widgets = collectDocumentWidgets(source)
    assert.equal(widgets.length, 1)
    assert.equal(widgets[0].title, 'widget_1')
  })

  it('parseShowWidgetFences and collectDocumentWidgets agree on widget slices', () => {
    const segments = parseShowWidgetFences(FIXTURE)
    const widgets = collectDocumentWidgets(FIXTURE)
    const widgetSegmentCount = segments.filter((segment) => segment.type === 'widget').length
    assert.equal(widgetSegmentCount, widgets.length)
  })
})
