import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'

test('EPUB content, chapter links and TOC survive parsing while active content and remote images do not', async () => {
  const dom = new JSDOM('')
  const replacements = { window: dom.window, DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer }
  const previous = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [k, value] of Object.entries(replacements)) Object.defineProperty(globalThis, k, { value, configurable: true })
  try {
    const { loadBook } = await import('../renderer/modules/library/reader/book')
    const zip = new JSZip()
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
    zip.file('OPS/book.opf', '<package><metadata><language>zh</language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
    zip.file('OPS/nav.xhtml', '<html><body><nav><ol><li><a href="one.xhtml#start">开篇</a></li><li><a href="two.xhtml">结尾</a></li></ol></nav></body></html>')
    zip.file('OPS/one.xhtml', '<html><body><h2 id="start">开篇</h2><p>真正的书籍内容</p><a href="two.xhtml#end">下一章</a><script>alert(1)</script><img src="https://example.invalid/tracker.png"/><p onclick="alert(1)">保留文字</p></body></html>')
    zip.file('OPS/two.xhtml', '<html><body><h2 id="end">结尾</h2><p>读完了。</p></body></html>')
    const book = await loadBook(await zip.generateAsync({ type: 'arraybuffer' }), 'epub', '测试书')
    assert.equal(book.chapters.length, 2)
    assert.match(book.chapters[0].html, /真正的书籍内容/)
    assert.match(book.chapters[0].html, /data-href="1#end"/)
    assert.doesNotMatch(book.chapters[0].html, /script|onclick|tracker/)
    assert.deepEqual(book.toc.map(t => [t.label, t.chapter]), [['开篇', 0], ['结尾', 1]])
    assert.deepEqual(book.urls, [])
  } finally {
    for (const [k, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k) }
    dom.window.close()
  }
})
