import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import type { LibraryBook } from '../shared/library'
import type { LibraryAPI } from '../renderer/modules/library/access'

const books: LibraryBook[] = [
  { id: 'a', title: '山海', author: '甲', topic: 'literature', words: 200000, addedAt: 1 },
  { id: 'b', title: '星空', author: '乙', topic: 'science', words: 20000, addedAt: 3 },
  { id: 'c', title: '旧城', author: '丙', topic: 'history', words: 80000, addedAt: 2 },
].map(b => ({ ...b, tags: [], status: '想读', format: 'txt', notePath: `/vault/${b.title}.md`, filePath: `/vault/${b.id}.txt`, source: { kind: 'local' } }))

test('shelf renders, sorts, scopes keys, opens a real text reader and switches to a single page when narrow', async () => {
  const dom = new JSDOM('<button id="outside">外部</button><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const runtimeErrors: unknown[] = []
  dom.window.addEventListener('error', event => runtimeErrors.push(event.error))
  const epub = new JSZip()
  epub.file('META-INF/container.xml', '<container><rootfile full-path="book.opf"/></container>')
  epub.file('book.opf', '<package><manifest><item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>')
  epub.file('ch.xhtml', '<html><body><h2>开始</h2><p>从文件树进入的 EPUB 正文。</p></body></html>')
  const epubBytes = await epub.generateAsync({ type: 'arraybuffer' })
  let width = 1100
  const observers = new Set<() => void>()
  class Observer {
    callback: () => void
    constructor(cb: () => void) { this.callback = cb; observers.add(cb) }
    observe() {}
    disconnect() { observers.delete(this.callback) }
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { get: () => width }, clientHeight: { get: () => 700 } })
  // JSDOM has no graphics device: exercise the production CSS fallback, not a mock flipbook.
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
  const replacements = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    matchMedia: () => ({ matches: true }), getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.requestAnimationFrame(() => callback(performance.now())), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (url: string | URL) => new Response(String(url).endsWith('.epub') ? epubBytes : '第一章 开始\n一段真正的书籍内容。\n第二章 回家\n走过山海，回到家中。'), IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [k, value] of Object.entries(replacements)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true })
  let saved = 0
  let currentBooks = books
  let importPaths: string[] = []
  const api: LibraryAPI = {
    get: async () => ({ success: true, data: { status: 'ready', vaultRoot: '/vault', books: currentBooks, issues: [] } }),
    onChanged: () => () => {},
    importFiles: async paths => {
      importPaths = paths
      const imported: LibraryBook = { ...books[0], id: 'imported', title: '导入书', format: 'epub', filePath: paths[0] }
      currentBooks = [...books, imported]
      return { success: true, data: { imported: [imported], failed: [] } }
    },
    pickAndImport: async () => ({ success: true, data: { imported: [], failed: [] } }),
    updateBook: async ({ id, patch }) => ({ success: true, data: { ...books.find(b => b.id === id)!, ...patch } }),
    getPosition: async () => ({ success: true, data: null }), setPosition: async p => { saved++; return { success: true, data: p } },
    listBookmarks: async () => ({ success: true, data: [] }), setBookmarks: async p => ({ success: true, data: p.bookmarks }),
  }
  // The reader records reading footprints for the calendar (M6-B) while a book is open.
  const sessions: unknown[] = []
  const calendarLayers = {
    beginReading: async (input: unknown) => { sessions.push(input); return { ok: true, value: undefined } },
    endReading: async () => ({ ok: true, value: undefined }),
  }
  Object.assign(dom.window, { electronAPI: { calendarLayers } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    const { Library } = await import('../renderer/modules/library/Library')
    await act(async () => root.render(<Library api={api} />))
    const d = dom.window.document
    const click = async (label: string) => { const b = [...d.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label); assert.ok(b, label); await act(async () => b.click()) }
    const order = () => [...d.querySelectorAll('[data-book]')].map(b => b.getAttribute('data-book'))
    assert.deepEqual(order(), ['a', 'c', 'b'])
    await click('最近'); assert.deepEqual(order(), ['b', 'c', 'a'])
    await click('厚薄'); assert.deepEqual(order(), ['b', 'c', 'a'])
    await click('颜色'); assert.deepEqual(order(), ['a', 'c', 'b'])
    const key = async (el: Element, value: string) => { await act(async () => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))) }
    const outside = d.getElementById('outside')!
    outside.focus(); await key(outside, '/'); assert.equal(d.activeElement, outside)
    await key(outside, 'r'); assert.equal(d.querySelector('[role="dialog"]'), null)
    const library = d.querySelector<HTMLElement>('.rn-library')!
    library.focus(); await key(library, '/'); assert.equal(d.activeElement?.getAttribute('aria-label'), '搜索书架')
    const first = d.querySelector<HTMLElement>('[data-book]')!
    first.focus(); await key(first, 'ArrowRight'); assert.notEqual(d.activeElement, first)
    await act(async () => first.click())
    assert.ok(d.querySelector('[role="dialog"]'))
    await click('翻看封面'); await click('开始阅读')
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    assert.match(d.body.textContent || '', /真正的书籍内容|走过山海/)
    assert.ok(sessions.length > 0, 'opening a book starts a reading session')
    assert.equal(d.querySelector('[aria-label="阅读器"]')?.getAttribute('data-layout'), 'spread')
    width = 500
    await act(async () => { observers.forEach(cb => cb()); await new Promise(r => setTimeout(r, 150)) })
    assert.equal(d.querySelector('[aria-label="阅读器"]')?.getAttribute('data-layout'), 'single')
    outside.focus(); await key(outside, 't'); await key(outside, 'b')
    assert.equal(d.querySelector('[aria-label="目录"]'), null)
    assert.match(d.body.textContent || '', /书签 0/)
    const reader = d.querySelector<HTMLElement>('[aria-label="阅读器"]')!
    reader.focus(); await key(reader, 't'); assert.ok(d.querySelector('[aria-label="目录"]'))
    await key(reader, 'b'); assert.match(d.body.textContent || '', /取下书签/)
    assert.ok(saved > 0)
    await key(reader, 't')
    await click('下一页')
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    assert.match(d.querySelector('.rd-dock')?.textContent || '', /6 \/ 8/)
    width = 1100
    await act(async () => { observers.forEach(cb => cb()); await new Promise(r => setTimeout(r, 150)) })
    assert.equal(d.querySelector('[aria-label="阅读器"]')?.getAttribute('data-layout'), 'spread')
    // Exercise Ready's real global Save dispatch with the actual system surface mounted.
    let fileWrites = 0
    Object.assign(dom.window, { electronAPI: { library: api, calendarLayers, document: {
      writeFile: async () => { fileWrites++; throw new Error('system tab attempted save') },
      saveFileAs: async () => { fileWrites++; throw new Error('system tab attempted save as') },
    } } })
    const { LibraryTab, OpenEpubInLibrary } = await import('../renderer/modules/library/navigation')
    const { useDocTabs } = await import('../renderer/stores/useDocTabs')
    const { useMode } = await import('../renderer/stores/useMode')
    const { useKeyboardShortcuts } = await import('../renderer/hooks/useKeyboardShortcuts')
    const { MemoryRouter } = await import('react-router-dom')
    const tabId = useDocTabs.getState().openLibraryTab()
    useMode.getState().setAppMode('workbench'); useMode.getState().setWorkbenchMode('document')
    function Shortcuts() { useKeyboardShortcuts(); return null }
    await act(async () => root.render(<MemoryRouter initialEntries={['/workbench']}><Shortcuts /><LibraryTab /></MemoryRouter>))
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })))
    assert.equal(fileWrites, 0)
    assert.equal(useDocTabs.getState().tabs.find(t => t.id === tabId)?.path, null)
    useDocTabs.getState().openTab('/incoming.epub')
    const sourceTabId = useDocTabs.getState().activeTabId
    await act(async () => root.render(<LibraryTab />))
    await act(async () => root.render(<><LibraryTab /><OpenEpubInLibrary path="/incoming.epub" sourceTabId={sourceTabId} /></>))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    assert.deepEqual(importPaths, ['/incoming.epub'])
    assert.equal(useDocTabs.getState().tabs.some(t => t.id === sourceTabId), false)
    assert.equal(useDocTabs.getState().activeTabId, tabId)
    assert.match(d.querySelector('[aria-label="阅读器"]')?.textContent || '', /从文件树进入的 EPUB 正文/)
    await click('下一页')
    await act(async () => root.render(<p>已离开书房</p>))
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    assert.deepEqual(runtimeErrors, [])
  } finally {
    await act(async () => root.unmount())
    for (const [k, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k) }
    dom.window.close()
  }
})
