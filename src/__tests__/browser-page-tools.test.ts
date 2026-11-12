import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { isProbablyReaderable } from '@mozilla/readability'
import { BrowserPageToolsService, type PageToolsContents } from '../main/modules/browser-engine/page-tools-service'
import { PAGE_CAPABILITIES_SCRIPT } from '../main/modules/browser-engine/page-capabilities-script'
import { MAX_READER_DOM_BYTES } from '../main/modules/browser-engine/read-tab'
import { setupBrowserShellDataIPC } from '../main/modules/browser-engine/ipc-shell-data'
import { BrowserSuggestionService } from '../main/modules/browser-engine/suggestion-service'
import type { BrowserFoundInPage, BrowserPageCapabilities, BrowserPageCapabilitiesChanged } from '../shared/browser-shell'
import { BrowserAppShortcutBridgeService } from '../main/modules/browser-engine/app-shortcut-service'
import { resolveReadyAppShortcut } from '../shared/app-shortcuts'

const prose = 'An article with enough content to be readable, about the rendered document and its local state. '.repeat(15)
class Contents extends EventEmitter implements PageToolsContents {
  url = 'https://example.test/article'
  destroyed = false
  dom = new JSDOM(`<html lang="en"><title>Rendered title</title><article><p>${prose}</p></article></html>`, { url: this.url, runScripts: 'outside-only' })
  executions: { world: number; code: string }[] = []
  stopped: string[] = []
  finds: { text: string; options?: Electron.FindInPageOptions }[] = []
  evaluate: (code: string) => Promise<unknown> = async code => this.dom.window.eval(code)
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
  executeJavaScriptInIsolatedWorld(world: number, scripts: Electron.WebSource[]) {
    this.executions.push({ world, code: scripts[0].code })
    this.dom.window.TextEncoder = TextEncoder
    return this.evaluate(scripts[0].code).then(result => structuredClone(result))
  }
  findInPage(text: string, options?: Electron.FindInPageOptions) { this.finds.push({ text, options }); return this.finds.length }
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection') { this.stopped.push(action) }
}
function fixture() {
  const found: BrowserFoundInPage[] = [], changed: BrowserPageCapabilitiesChanged[] = [], errors: unknown[] = []
  const contents = new Contents()
  const pages = new BrowserPageToolsService({ found: data => found.push(data), changed: data => changed.push(data), log: error => errors.push(error) })
  pages.bind('tab', contents)
  const handlers = new Map<string, (_event: unknown, input: unknown) => unknown>()
  setupBrowserShellDataIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, pages, new BrowserSuggestionService({
    tabs: () => [], data: { getSetting: () => undefined, getBookmarks: () => [], getHistory: () => [] },
    fetch: async () => { assert.fail('no network') },
  }))
  const invoke = (name: string, input: unknown) => handlers.get(name)!(null, input)
  return { pages, contents, found, changed, errors, invoke, close: () => { pages.disposeTab('tab'); contents.dom.window.close() } }
}

test('real IPC find/stop routes options and only emits current request results; navigation/disposal clear find', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.invoke('browser:findInPage', { tabId: 'tab', text: 'Word', forward: false, findNext: true, matchCase: true }), { success: true, requestId: 1 })
    assert.deepEqual(f.contents.finds, [{ text: 'Word', options: { forward: false, findNext: true, matchCase: true } }])
    const result = { requestId: 1, matches: 5, activeMatchOrdinal: 2, finalUpdate: true }
    f.contents.emit('found-in-page', {}, result)
    assert.deepEqual(f.found, [{ tabId: 'tab', ...result }])
    f.contents.emit('did-start-navigation', {}, f.contents.url, false, false)
    assert.equal(f.contents.stopped.length, 0, 'subframe navigation leaves main find alone')
    f.contents.emit('did-start-navigation', {}, f.contents.url, false, true)
    assert.deepEqual(f.contents.stopped, ['clearSelection'])
    f.contents.emit('found-in-page', {}, result)
    assert.equal(f.found.length, 1)
    f.invoke('browser:findInPage', { tabId: 'tab', text: 'next' })
    f.invoke('browser:stopFindInPage', { tabId: 'tab', action: 'keepSelection' })
    assert.equal(f.contents.stopped.at(-1), 'keepSelection')
    f.pages.disposeTab('tab')
    assert.equal(f.contents.listenerCount('found-in-page'), 0)
    assert.deepEqual(f.invoke('browser:findInPage', { tabId: 'tab', text: 'x' }), { success: false, error: 'tab_missing' })
    assert.throws(() => f.invoke('browser:findInPage', { tabId: 'tab', text: '' }))
  } finally { f.close() }
})

test('capabilities inspect declared feeds with baseURI/protocol/dedupe and match Mozilla readerability', async () => {
  const f = fixture()
  try {
    f.contents.dom.window.document.head.innerHTML += `<base href="https://cdn.test/news/"><link rel="alternate stylesheet" type="application/rss+xml" href="feed.xml" title="RSS"><link rel="alternate" type="application/atom+xml" href="feed.xml#same"><link rel="alternate" type="application/feed+json" href="/feed.json"><link rel="alternate" type="application/json" href="/metadata.json"><link rel="alternate" type="application/json" title="JSON Feed" href="/json"><link rel="alternate" type="application/rss+xml" href="javascript:alert(1)"><link rel="alternate" type="application/rss+xml" href="file:///x"><link rel="alternate" type="application/rss+xml">`
    const result = await f.invoke('browser:getPageCapabilities', { tabId: 'tab' })
    assert.deepEqual(result, { url: f.contents.url, readable: true, feeds: [
      { url: 'https://cdn.test/news/feed.xml', title: 'RSS', type: 'application/rss+xml' },
      { url: 'https://cdn.test/feed.json', title: '', type: 'application/feed+json' },
      { url: 'https://cdn.test/json', title: 'JSON Feed', type: 'application/json' },
    ] })
    await f.invoke('browser:getPageCapabilities', { tabId: 'tab' })
    assert.equal(f.contents.executions.length, 1)
    assert.equal(f.contents.executions[0].world, 1004)
    for (const html of [`<p>${prose}</p>`, `<p hidden>${prose}</p>`, `<p class="comment">${prose}</p>`, `<li><p>${prose}</p></li>`, `<div>${prose}<br></div>`, '<p>Short</p>']) {
      f.contents.dom.window.document.body.innerHTML = html
      const observed: BrowserPageCapabilities = f.contents.dom.window.eval(PAGE_CAPABILITIES_SCRIPT)
      assert.equal(observed.readable, isProbablyReaderable(f.contents.dom.window.document), html.slice(0, 40))
    }
    f.contents.url = 'file:///private/local'
    assert.deepEqual(await f.pages.capabilities('tab'), { url: f.contents.url, readable: false, feeds: [] })
    assert.equal(f.contents.executions.length, 1)
  } finally { f.close() }
})

test('finish-load and same-page navigation debounce capability pushes and discard old-document results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  try {
    f.contents.emit('did-finish-load')
    f.contents.emit('did-finish-load')
    t.mock.timers.tick(150)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.changed.length, 1)
    assert.equal(f.changed[0].tabId, 'tab')
    f.contents.dom.reconfigure({ url: 'https://example.test/article#new' })
    f.contents.url = 'https://example.test/article#new'
    f.contents.emit('did-navigate-in-page', {}, f.contents.url, true)
    t.mock.timers.tick(150)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.changed.length, 2)
    assert.equal(f.changed[1].url, f.contents.url)
    let finish!: (data: unknown) => void
    f.contents.evaluate = () => new Promise(resolve => { finish = resolve })
    f.contents.emit('did-finish-load')
    t.mock.timers.tick(150)
    f.contents.emit('did-start-navigation', {}, 'https://example.test/next', false, true)
    finish({ url: f.contents.url, readable: true, feeds: [] })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.changed.length, 2)
  } finally { f.close() }
})

test('readTab extracts the current rendered DOM locally, removes private drafts and executable markup, and returns RSS reader fields', async () => {
  const f = fixture()
  try {
    const doc = f.contents.dom.window.document
    doc.head.innerHTML += '<meta name="author" content="Writer"><meta property="og:site_name" content="News"><meta property="article:published_time" content="2026-11-12T00:00:00Z"><meta name="csrf-token" content="PRIVATE-TOKEN">'
    doc.querySelector('article')!.innerHTML += '<p>DOM-ONLY logged-in paragraph</p><p contenteditable="true">PRIVATE-DRAFT</p><input value="PRIVATE-INPUT"><textarea>PRIVATE-TEXTAREA</textarea><script>EXECUTABLE</script><p onclick="EVIL()">Safe paragraph</p><a href="javascript:EVIL()">Unsafe link</a><img src="file:///private/image"><img src="javascript:EVIL()"><img src="https://example.test/safe.jpg" onerror="EVIL()">'
    const result = await f.pages.read('tab')
    assert.equal(result.success, true)
    if (!result.success) return assert.fail(result.error)
    assert.match(result.data.text, /DOM-ONLY logged-in paragraph/)
    assert.doesNotMatch(result.data.text, /PRIVATE|EXECUTABLE|EVIL|onclick|onerror|file:\/\/|javascript:/)
    assert.match(result.data.text, /https:\/\/example.test\/safe.jpg/)
    assert.equal(result.data.url, f.contents.url)
    assert.equal(result.data.title, 'Rendered title')
    assert.equal(result.data.byline, 'Writer')
    assert.equal(result.data.siteName, 'News')
    assert.equal(result.data.publishedAt, Date.parse('2026-11-12T00:00:00Z'))
    assert.equal(result.data.lang, 'en')
    assert.equal(result.data.article.link, f.contents.url)
    assert.equal(result.data.body.status, 'ready')
    assert.equal(result.data.textKind, 'body')
    assert.equal(result.data.totalLength, result.data.text.length)
    assert.equal(result.data.nextOffset, null)
    assert.equal(f.contents.executions.length, 1)
    assert.equal(f.contents.executions[0].world, 1004)
    assert.ok(doc.querySelector('script'), 'live DOM was never mutated')
  } finally { f.close() }
})

test('readTab rejects missing/unsupported/empty/oversized/changed pages with explicit reasons', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.invoke('browser:readTab', { tabId: 'missing' }), { success: false, error: 'tab_missing' })
    f.contents.url = 'file:///x'
    assert.deepEqual(await f.pages.read('tab'), { success: false, error: 'unsupported_protocol' })
    assert.equal(f.contents.executions.length, 0)
    f.contents.url = 'https://example.test/article'
    f.contents.dom.window.document.body.innerHTML = ''
    assert.deepEqual(await f.pages.read('tab'), { success: false, error: 'not_readable' })
    f.contents.dom.window.document.body.textContent = 'x'.repeat(MAX_READER_DOM_BYTES + 1)
    assert.deepEqual(await f.pages.read('tab'), { success: false, error: 'too_large' })
    f.contents.dom.window.document.body.innerHTML = `<article><p>${prose}</p></article>`
    f.contents.evaluate = async code => { const raw = f.contents.dom.window.eval(code); f.contents.emit('did-start-navigation', {}, f.contents.url, false, true); return raw }
    assert.deepEqual(await f.pages.read('tab'), { success: false, error: 'page_changed' })
    f.contents.evaluate = async () => { throw new Error('webContents destroyed') }
    assert.deepEqual(await f.pages.read('tab'), { success: false, error: 'extraction_failed' })
    assert.equal(f.errors.length, 1)
  } finally { f.close() }
})

test('browser shortcuts are scoped and native page input forwards through the existing app event', () => {
  const sent: unknown[] = []
  const bridge = new BrowserAppShortcutBridgeService({ sendToRenderer: (channel, payload) => sent.push({ channel, payload }) })
  for (const [key, shift, action] of [['f', false, 'browser-find'], ['g', false, 'browser-find-next'], ['g', true, 'browser-find-previous']] as const) {
    const input: Electron.Input = { type: 'keyDown', key, code: `Key${key.toUpperCase()}`, meta: true, control: false, shift, alt: false, isAutoRepeat: false }
    assert.equal(bridge.isAppShortcutInput(input), true)
    bridge.dispatchAppShortcut(input)
    assert.equal(resolveReadyAppShortcut({ key, metaKey: true, shiftKey: shift }, 'browser'), action)
    assert.equal(resolveReadyAppShortcut({ key, metaKey: true, shiftKey: shift }, 'canvas'), null)
  }
  assert.equal(sent.length, 3)
  assert.deepEqual(sent[0], { channel: 'app:shortcut', payload: { key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } })
})
