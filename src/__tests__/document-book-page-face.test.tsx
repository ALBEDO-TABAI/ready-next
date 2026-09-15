import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import DocumentBookPageFace from '../renderer/components/document/book/DocumentBookPageFace'
import DocumentBookBlock from '../renderer/components/document/book/DocumentBookBlock'
import { BookImageContext } from '../renderer/modules/document/book/bookImageLayout'
import { sanitizeBookWidgetStaticHtml } from '../renderer/modules/document/book/bookWidgetStatic'

test('Markdown 内的相对图片从文档目录读取并命中同一份尺寸', () => {
  const markup = renderToStaticMarkup(createElement(BookImageContext.Provider, {
    value: { contentWidth: 380, contentHeight: 500, fontSize: 15, notePath: '/books/story.md', sizes: new Map([
      ['local-file:///books/images/cover.png', { width: 500, height: 1000 }],
    ]) },
  }, createElement(DocumentBookBlock, {
    block: { id: 'local', type: 'markdown', markdown: '![本地图片](images/cover.png)' },
    embedsById: new Map(), widgetsById: new Map(),
  })))
  assert.match(markup, /src="local-file:\/\/\/books\/images\/cover.png"/)
  assert.match(markup, /width:250px;height:500px/)
})

test('独立、重复与失败图片按冻结尺寸显示，不依赖显示页再次加载测量', () => {
  const render = (block: Parameters<typeof DocumentBookBlock>[0]['block']) => renderToStaticMarkup(
    createElement(BookImageContext.Provider, {
      value: { contentWidth: 380, contentHeight: 500, fontSize: 15, sizes: new Map([
        ['https://example.com/cover.png', { width: 500, height: 1000 }],
        ['https://example.com/missing.png', { width: 0, height: 0 }],
      ]) },
    }, createElement(DocumentBookBlock, {
      block,
      embedsById: new Map([['image', { id: 'image', kind: 'image', source: 'body', url: 'https://example.com/cover.png', displayUrl: '', title: '', alt: '卷首' }]]),
      widgetsById: new Map(),
    })),
  )
  for (const block of [
    { id: 'embed', type: 'embed' as const, embedId: 'image' },
    { id: 'markdown', type: 'markdown' as const, markdown: '![重复](https://example.com/cover.png)\n\n后文' },
  ]) {
    const markup = render(block)
    assert.match(markup, /document-book-image--page/)
    assert.match(markup, /width:250px;height:500px/)
    assert.match(markup, /loading="eager"/)
  }
  const failed = render({ id: 'failed', type: 'markdown', markdown: '![插图](https://example.com/missing.png)\n\n后文' })
  assert.match(failed, /图片加载失败 · 插图/)
  assert.match(failed, /后文/)
  assert.doesNotMatch(failed, /<img/)
})

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
