import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import DocumentBookPageFace from '../renderer/components/document/book/DocumentBookPageFace'
import DocumentBookBlock from '../renderer/components/document/book/DocumentBookBlock'
import { sanitizeBookWidgetStaticHtml } from '../renderer/modules/document/book/bookWidgetStatic'

test('活动页克隆源保留左右页身份与正文，翻页背面不会失去内容宽度', () => {
  const markup = renderToStaticMarkup(createElement(DocumentBookPageFace, {
    side: 'left',
    pageIndex: 1,
    page: {
      index: 1,
      entries: [{
        blockIdx: 0,
        offsetY: 24,
        continued: false,
        columnIndex: 0,
        spansPages: false,
        startOffsetY: 24,
      }],
      anchorBlock: 0,
      anchorRatio: 0,
    },
    blocks: [{ id: 'body', type: 'markdown', markdown: 'BACK_FACE_CONTENT' }],
    embedsById: new Map(),
    widgetsById: new Map(),
    docTitle: 'Book',
    docSubtitle: '',
    contentWidth: 380,
    contentHeight: 500,
    onInnerElement: () => undefined,
  }))

  assert.match(markup, /data-book-page-side="left"/)
  assert.match(markup, /document-book-page__content/)
  assert.match(markup, /BACK_FACE_CONTENT/)
})

test('跨页正文沿浏览器真实分栏横向取页，不再按固定页高纵向切字', () => {
  const markup = renderToStaticMarkup(createElement(DocumentBookPageFace, {
    side: 'right',
    pageIndex: 1,
    page: {
      index: 1,
      entries: [{
        blockIdx: 0,
        offsetY: 24,
        continued: true,
        columnIndex: 1,
        spansPages: true,
        startOffsetY: 24,
      }],
      anchorBlock: 0,
      anchorRatio: 0,
    },
    blocks: [{ id: 'body', type: 'markdown', markdown: 'FULL_LINE_CONTENT' }],
    embedsById: new Map(),
    widgetsById: new Map(),
    docTitle: 'Book',
    docSubtitle: '',
    contentWidth: 380,
    contentHeight: 500,
    onInnerElement: () => undefined,
  }))

  assert.match(markup, /document-book-page__fragment-flow/)
  assert.match(markup, /column-width:380px/)
  assert.match(markup, /transform:translateX\(-380px\)/)
  assert.doesNotMatch(markup, /translateY\(-476px\)/)
})

test('阅读页的信息卡使用可克隆的隔离宿主，危险脚本与越界样式先被清除', () => {
  const staticHtml = sanitizeBookWidgetStaticHtml(`
    <style>@import url('https://example.com/bad.css'); .x { position: fixed; background: url(https://example.com/x.png) }</style>
    <div id="leaking-id" class="card"><div class="title">一张卡读懂</div><script>alert(1)</script></div>
  `)
  assert.doesNotMatch(staticHtml, /@import|https:\/\/example\.com|position:\s*fixed|leaking-id|alert\(1\)/i)
  assert.match(staticHtml, /position: static/i)

  const markup = renderToStaticMarkup(createElement(DocumentBookBlock, {
    block: { id: 'widget-block', type: 'widget', widgetId: 'widget-1' },
    embedsById: new Map(),
    widgetsById: new Map([['widget-1', {
      id: 'widget-1',
      title: '浓缩信息卡',
      widgetCode: '<div class="card"><div class="title">一张卡读懂</div><div>核心命题正文</div><script>alert(1)</script></div>',
      rawFence: '',
    }]]),
  }))

  assert.match(markup, /data-book-widget-shadow/)
  assert.match(markup, /信息卡 · 浓缩信息卡/)
  assert.doesNotMatch(markup, /一张卡读懂|核心命题正文/)
  assert.doesNotMatch(markup, /在预览模式查看/)
  assert.doesNotMatch(markup, /alert\(1\)/)
})
