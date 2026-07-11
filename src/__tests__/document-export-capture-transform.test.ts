import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  buildExportHtmlDocument,
  deriveWatchUrlFromEmbedSrc,
  transformPreviewDomForExport,
} from '../renderer/components/document/document-export-html'

function makePreviewDom(innerHtml: string): { root: HTMLElement; dom: JSDOM } {
  const dom = new JSDOM(`<!doctype html><html><body><div class="note-preview-shell">${innerHtml}</div></body></html>`)
  const root = dom.window.document.querySelector('.note-preview-shell') as HTMLElement
  return { root, dom }
}

test('transform strips interactive chrome but keeps content', () => {
  const { root } = makePreviewDom(`
    <div class="note-preview-code-block">
      <button class="note-preview-code-copy-button">复制</button>
      <pre class="note-preview-markdown-pre">const a = 1</pre>
    </div>
    <div class="note-preview-mermaid--error">
      <div class="note-preview-mermaid__error">Mermaid 渲染失败：x</div>
      <button class="note-preview-repair-button">让 AI 修复</button>
    </div>
    <div class="ready-doc-widget-card">
      <div class="ready-doc-widget-card-actions"><button>引用</button><button>导出</button></div>
      <div class="ready-doc-widget-card-preview">卡片内容</div>
    </div>
    <div class="document-widget-fallback-shell">
      <div class="document-widget-fallback-note">默认不自动渲染</div>
      <button class="ready-doc-widget-card-action">启用预览</button>
    </div>
  `)

  transformPreviewDomForExport(root)

  assert.equal(root.querySelector('.note-preview-code-copy-button'), null)
  assert.equal(root.querySelector('.note-preview-repair-button'), null)
  assert.equal(root.querySelector('.ready-doc-widget-card-actions'), null)
  assert.equal(root.querySelector('.document-widget-fallback-shell button'), null)
  assert.ok(root.textContent?.includes('const a = 1'))
  assert.ok(root.textContent?.includes('Mermaid 渲染失败'))
  assert.ok(root.textContent?.includes('卡片内容'))
  assert.ok(root.textContent?.includes('默认不自动渲染'))
})

test('transform expands details and makes images eager', () => {
  const { root } = makePreviewDom(`
    <details class="note-preview-details"><summary>折叠段</summary><p>内文</p></details>
    <img class="note-preview-image" src="local-file:///x/a.png" loading="lazy" decoding="async" />
  `)

  transformPreviewDomForExport(root)

  assert.ok(root.querySelector('details')?.hasAttribute('open'))
  const img = root.querySelector('img')
  assert.equal(img?.getAttribute('loading'), 'eager')
  assert.equal(img?.getAttribute('decoding'), 'sync')
})

test('transform replaces site players with durable watch links', () => {
  const { root } = makePreviewDom(`
    <div class="note-preview-youtube-thumb-shell">
      <iframe class="note-preview-youtube-iframe" src="https://www.youtube.com/embed/abc123XYZ_-?rel=0"></iframe>
    </div>
    <div class="note-preview-youtube-thumb-shell">
      <iframe class="note-preview-youtube-iframe" src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1"></iframe>
    </div>
  `)

  transformPreviewDomForExport(root)

  assert.equal(root.querySelector('iframe'), null)
  const links = Array.from(root.querySelectorAll('a.ready-export-embed-link'))
  assert.equal(links.length, 2)
  assert.equal(links[0].getAttribute('href'), 'https://www.youtube.com/watch?v=abc123XYZ_-')
  assert.equal(links[1].getAttribute('href'), 'https://www.bilibili.com/video/BV1xx411c7mD')
})

test('transform keeps widget srcdoc iframes but replaces videos with placeholders', () => {
  const { root } = makePreviewDom(`
    <iframe class="document-widget-frame" srcdoc="&lt;p&gt;widget&lt;/p&gt;" style="height: 240px;"></iframe>
    <video class="note-preview-video" src="local-file:///docs/%E6%BC%94%E7%A4%BA%20demo.mp4"></video>
  `)

  transformPreviewDomForExport(root)

  assert.ok(root.querySelector('iframe.document-widget-frame'), 'widget iframe 保留')
  assert.equal(root.querySelector('video'), null)
  const placeholder = root.querySelector('.ready-export-video-placeholder')
  assert.ok(placeholder?.textContent?.includes('演示 demo.mp4'), '占位卡显示解码后的文件名')
})

test('deriveWatchUrlFromEmbedSrc only rewrites known players', () => {
  assert.equal(deriveWatchUrlFromEmbedSrc('https://example.com/embed/x'), null)
  assert.equal(
    deriveWatchUrlFromEmbedSrc('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  )
})

test('buildExportHtmlDocument assembles a standalone themed document', () => {
  const html = buildExportHtmlDocument({
    title: '我的 <文档> & "笔记"',
    bodyHtml: '<div class="note-preview-shell">正文</div>',
    baseCss: '.base { color: red; }',
    collectedCss: '.collected { color: blue; }',
    darkTheme: true,
  })

  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('data-theme="dark"'))
  assert.ok(html.includes('<title>我的 &lt;文档&gt; &amp; &quot;笔记&quot;</title>'))
  assert.ok(html.includes('.base { color: red; }'))
  assert.ok(html.includes('.collected { color: blue; }'))
  assert.ok(html.indexOf('.base') < html.indexOf('.collected'), '兜底样式在采集样式之前，等特异度时采集样式获胜')
  assert.ok(html.includes('ready-document-export-body'))
  assert.ok(html.includes('正文'))

  // 分页合同（真实 Electron 冒烟证明过行为：base-chrome 的 html/body
  // height:100%+overflow:hidden 会把打印裁成单页，flex 列不参与分页截断）：
  // 打印覆盖层必须（1）强制释放 html/body 的高度与溢出钳制，（2）把预览壳/
  // 正文从 flex 列降级为块布局。这两条丢了导出就退化成"只有第一屏"。
  const printOverrides = html.slice(html.indexOf('.collected'))
  assert.ok(/html,\s*body\s*{[^}]*overflow:\s*visible\s*!important/s.test(printOverrides), '打印层释放 html/body 溢出钳制')
  assert.ok(/html,\s*body\s*{[^}]*height:\s*auto\s*!important/s.test(printOverrides), '打印层释放 html/body 高度钳制')
  assert.ok(
    /\.note-preview-shell,\s*[^{]*\.note-preview-body\s*{[^}]*display:\s*block\s*!important/s.test(printOverrides),
    '预览壳与正文降级为块布局参与分页',
  )

  const light = buildExportHtmlDocument({
    title: 't',
    bodyHtml: '<div></div>',
    baseCss: '',
    collectedCss: '',
    darkTheme: false,
  })
  assert.ok(!light.includes('data-theme'))
})
