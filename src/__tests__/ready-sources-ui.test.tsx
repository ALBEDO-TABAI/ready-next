import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { JSDOM } from 'jsdom'
import { WEB_SOURCE_SELECTION_SCRIPT } from '../main/modules/library-engine/source-document-ipc'
import { importWithoutStyles } from './utils/import-without-styles'

// Real selection ranges, the shared selection bar and its toast; only the process boundary is substituted.
test('划线 in the shared bar: 资讯 sends the scoped reading range, the web page sends its tab, failures are reported', async t => {
  const dom = new JSDOM('<div id="root"></div><div id="body"><span data-ready-reading-run="0" data-ready-reading-block="0">甲乙丙丁</span></div>', { url: 'http://127.0.0.1', runScripts: 'outside-only' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, ResizeObserver: class { observe() {} disconnect() {} } })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => { flushSync(() => root.unmount()); await new Promise(resolve => setImmediate(resolve)); dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const calls: unknown[] = []
  const saved = { persistence: 'saved', version: 'v1', sourcePath: '/vault/文章/文章.md', highlights: [], anchors: 'synced' }
  Object.defineProperty(dom.window, 'electronAPI', { value: { sourceAnnotations: {
    rss: async (input: unknown) => { calls.push(input); return { success: true, data: saved } },
    web: async (input: unknown) => { calls.push(input); return { success: false, error: '网页已切换，请重新选择' } },
  } } })
  const { SelectionBar } = await importWithoutStyles(() => import('../renderer/modules/workbench/selection-bar/SelectionBar'))
  const { ToastHost } = await importWithoutStyles(() => import('../renderer/components/ui'))
  const { highlightReadingSelection, readingSelectionCapture } = await import('../renderer/modules/rss/reading-selection')
  const { highlightWebSelection, webSelectionCapture } = await import('../renderer/modules/browser/web-selection-bar')
  const body = dom.window.document.getElementById('body') as HTMLDivElement
  const selected = dom.window.document.createRange(); selected.setStart(body.firstChild!.firstChild!, 1); selected.setEnd(body.firstChild!.firstChild!, 3)
  dom.window.getSelection()!.addRange(selected)
  const article = { id: 'article', title: '文章', revision: 'version' }
  const read = () => readingSelectionCapture(body, article, dom.window.getSelection())
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const click = (label: string) => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[data-ready-selection-bar] button')).find(node => node.textContent === label)!.click()
  const toast = () => Array.from(dom.window.document.querySelectorAll('.rn-toast')).at(-1)
  flushSync(() => root.render(createElement('div', null, createElement(SelectionBar, { read, highlight: () => highlightReadingSelection(read()) }), createElement(ToastHost))))
  click('划线'); await settle(); flushSync(() => {})
  assert.partialDeepStrictEqual(calls[0], { itemId: 'article', expectedRevision: 'version', range: { start: { run: 0, offset: 1 }, end: { run: 0, offset: 3 } } })
  assert.match(toast()!.textContent!, /^已划线到来源页/)
  const web = { tabId: 'tab', text: '网页文字', url: 'http://127.0.0.1/page', title: '本地网页' }
  assert.equal(webSelectionCapture({ ...web, url: 'file:///private/page.html' }), null, 'only http and https pages are web references')
  flushSync(() => root.render(createElement('div', null, createElement(SelectionBar, { read: () => webSelectionCapture(web), highlight: () => highlightWebSelection(web) }), createElement(ToastHost))))
  click('划线'); await settle(); flushSync(() => {})
  assert.deepEqual(calls[1], { tabId: 'tab' })
  assert.equal(toast()!.getAttribute('data-tone'), 'bad')
  assert.match(toast()!.textContent!, /网页已切换，请重新选择/)
})

test('web capture binds an actual DOM selection to exact text and surrounding context', () => {
  const dom = new JSDOM('<title>本地网页</title><body><p>前文 <strong>选中文字</strong> 后文</p></body>', { url: 'http://127.0.0.1/page', runScripts: 'outside-only' })
  try {
    const range = dom.window.document.createRange(); range.selectNodeContents(dom.window.document.querySelector('strong')!)
    dom.window.getSelection()!.addRange(range)
    const captured = dom.window.eval(WEB_SOURCE_SELECTION_SCRIPT)
    assert.equal(captured.exact, '选中文字'); assert.equal(captured.text.slice(captured.start, captured.end), captured.exact)
    assert.equal(captured.text, '前文 选中文字 后文')
    dom.window.getSelection()!.removeAllRanges()
    assert.throws(() => dom.window.eval(WEB_SOURCE_SELECTION_SCRIPT), /请先在网页中选中文字/)
  } finally { dom.window.close() }
})
