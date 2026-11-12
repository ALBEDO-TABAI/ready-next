import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act, useRef, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { BrowserSuggestions } from '../shared/browser-shell'
import { importWithoutAssets } from './utils/import-without-styles'

// W7 T8 interface: 设置 › 浏览器, the address suggestions, ⌘F and 订阅. Real components and hooks; Main is a stand-in that
// answers the same calls and records them.

const { BrowserSearchSettingsPanel } = await importWithoutAssets(() => import('../renderer/pages/settings/BrowserSearchSettingsPanel'))
const { useAddressSuggestions, flattenSuggestions } = await importWithoutAssets(() => import('../renderer/modules/browser/useAddressSuggestions'))
const { useBrowserFind } = await importWithoutAssets(() => import('../renderer/modules/browser/useBrowserFind'))
const { default: BrowserSubscribeButton } = await importWithoutAssets(() => import('../renderer/components/browser/BrowserSubscribeButton'))
const ui = await importWithoutAssets(() => import('../renderer/components/ui'))

async function mount(t: TestContext, electronAPI: Record<string, unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { electronAPI })
  const globals = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => { ui.closeAllFloats(); root.unmount() })
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const render = async (node: React.ReactNode) => { await act(async () => root.render(<>{node}<ui.FloatHost /></>)) }
  const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const body = dom.window.document.body
  const setValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const key = async (target: EventTarget, init: KeyboardEventInit) => {
    await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
  }
  return { dom, body, render, settle, setValue, key }
}

test('设置 › 浏览器: suggestions start off and say what they would send; choices are saved through settings', async t => {
  const saved: Array<[string, string]> = []
  const api = {
    getAll: async () => ({ success: true, data: {} as Record<string, string> }),
    set: async (key: string, value: string) => { saved.push([key, value]); return key === 'browser.searchEngine' && !/^(google|bing|duckduckgo|baidu|https?:)/.test(value) ? { success: false, error: 'invalid' } : { success: true } },
  }
  const { body, render, settle, setValue } = await mount(t, {})
  await render(<BrowserSearchSettingsPanel api={api} />)
  await settle()
  const toggle = body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="搜索建议"]')!
  assert.equal(toggle.getAttribute('aria-checked'), 'false')
  assert.match(body.textContent ?? '', /输入的文字会随打随发给 Google/)
  assert.match(body.textContent ?? '', /不发给任何人/)

  const select = body.querySelector<HTMLSelectElement>('select[aria-label="搜索引擎"]')!
  await act(async () => { select.value = 'duckduckgo'; select.dispatchEvent(new (globalThis as unknown as { window: Window }).window.Event('change', { bubbles: true })) })
  await settle()
  assert.deepEqual(saved.at(-1), ['browser.searchEngine', 'duckduckgo'])
  assert.match(body.textContent ?? '', /发给 DuckDuckGo/)

  await act(async () => { toggle.click() })
  await settle()
  assert.deepEqual(saved.at(-1), ['browser.searchSuggestions', 'true'])
  assert.equal(toggle.getAttribute('aria-checked'), 'true')

  // A custom template without %s is refused here and never saved.
  await act(async () => { select.value = 'custom'; select.dispatchEvent(new (globalThis as unknown as { window: Window }).window.Event('change', { bubbles: true })) })
  const field = body.querySelector<HTMLInputElement>('input[aria-label="自定义搜索地址"]')!
  await setValue(field, 'https://example.com/search')
  const count = saved.length
  await act(async () => { [...body.querySelectorAll('button')].find(button => button.textContent === '保存')!.click() })
  assert.equal(saved.length, count)
  assert.match(body.querySelector('[role="alert"]')?.textContent ?? '', /%s/)
  await setValue(field, 'https://example.com/search?q=%s')
  await act(async () => { [...body.querySelectorAll('button')].find(button => button.textContent === '保存')!.click() })
  await settle()
  assert.deepEqual(saved.at(-1), ['browser.searchEngine', 'https://example.com/search?q=%s'])
  assert.match(body.textContent ?? '', /没有建议服务，所以打开也不会发送/)
})

const GROUPS: BrowserSuggestions = {
  tabs: [{ tabId: 'tab-2', title: '筛子与阅读', url: 'http://127.0.0.1/blog/sieve', favicon: null, browserTaskId: 'bt-1' }],
  bookmarks: [{ title: '设计参考', url: 'https://example.com/design', favicon: null }],
  history: [{ title: 'JSON Canvas', url: 'https://jsoncanvas.org/', favicon: null, visitCount: 3, lastVisitedAt: 1 }],
  search: ['筛子 是什么'],
}

test('address suggestions: typing asks Main (newest answer wins), ↓ and Enter pick, focus alone asks nothing', async t => {
  const asked: string[] = []
  const answers = new Map<string, (groups: BrowserSuggestions) => void>()
  const { body, render, settle, key, setValue } = await mount(t, {
    browser: { suggest: ({ query }: { query: string }) => { asked.push(query); return new Promise<BrowserSuggestions>(resolve => answers.set(query, resolve)) } },
  })
  const picked: string[] = []
  function Field() {
    const [value, setText] = useState('http://127.0.0.1/')
    const [editing, setEditing] = useState(false)
    const anchor = useRef<HTMLDivElement>(null)
    const suggestions = useAddressSuggestions({ anchorRef: anchor, query: value, editing, onPick: item => picked.push(`${item.kind}:${item.kind === 'tab' ? item.tabId : item.title}`) })
    return <div ref={anchor}><input aria-label="地址" value={value} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
      onChange={event => { suggestions.onTyped(); setText(event.target.value) }}
      onKeyDown={event => { if (suggestions.onKeyDown(event)) return; if (event.key === 'Enter') picked.push(`typed:${value}`) }} /></div>
  }
  await render(<Field />)
  const input = body.querySelector<HTMLInputElement>('input')!
  await act(async () => { input.focus() })
  await settle(100)
  assert.deepEqual(asked, [], 'focusing the field (address selected) asks for nothing')
  await setValue(input, '筛')
  await settle(80)
  await setValue(input, '筛子')
  await settle(80)
  answers.get('筛子')!(GROUPS)
  await settle()
  answers.get('筛')?.({ ...GROUPS, tabs: [] })
  await settle()
  const options = [...body.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="地址建议"] [role="option"]')]
  assert.deepEqual(options.map(option => option.dataset.suggestionKind), ['tab', 'bookmark', 'history', 'search'], 'the late answer for 筛 did not replace 筛子')
  assert.deepEqual([...body.querySelectorAll('.rn-menu__group')].map(node => node.textContent), ['已打开的标签', '收藏', '历史', '搜索建议'])
  assert.equal(options[0].querySelector('.rn-address-suggestions__meta')?.textContent, '助手的标签')
  await key(input, { key: 'ArrowDown' })
  await key(input, { key: 'ArrowDown' })
  assert.equal(body.querySelectorAll('[role="option"][aria-selected="true"]').length, 1)
  await key(input, { key: 'Enter' })
  assert.deepEqual(picked, ['bookmark:设计参考'])
  assert.equal(body.querySelector('[role="listbox"][aria-label="地址建议"]'), null, 'the list closes after a pick')
  assert.equal(flattenSuggestions(GROUPS).length, 4)
})

test('⌘F: the bar opens, typing finds in the visible tab, ⌘G steps, matches of an old request are ignored, Esc clears', async t => {
  const calls: Array<{ kind: string; request: Record<string, unknown> }> = []
  let found: ((event: { tabId: string; requestId: number; matches: number; activeMatchOrdinal: number; finalUpdate: boolean }) => void) | null = null
  let requestId = 0
  const { body, render, settle, setValue, key, dom } = await mount(t, {
    browser: {
      findInPage: async (request: Record<string, unknown>) => { calls.push({ kind: 'find', request }); return { success: true, requestId: ++requestId } },
      stopFindInPage: async (request: Record<string, unknown>) => { calls.push({ kind: 'stop', request }); return { success: true } },
      onFoundInPage: (handler: typeof found) => { found = handler; return () => { found = null } },
    },
    app: { onShortcut: () => () => {} },
  })
  function Host({ tabId }: { tabId: string }) {
    const { bar } = useBrowserFind({ isActive: true, tabId })
    return <div>{bar}</div>
  }
  await render(<Host tabId="tab-1" />)
  assert.equal(body.querySelector('[data-browser-find-bar]'), null)
  await key(dom.window, { key: 'f', metaKey: true })
  await settle(20)
  const input = body.querySelector<HTMLInputElement>('[data-browser-find-bar] input')!
  assert.ok(input, '⌘F opens the bar')
  await setValue(input, '筛子')
  await settle(160)
  assert.deepEqual(calls.at(-1), { kind: 'find', request: { tabId: 'tab-1', text: '筛子', findNext: false, forward: true } })
  await act(async () => { found!({ tabId: 'tab-1', requestId: 1, matches: 3, activeMatchOrdinal: 1, finalUpdate: true }) })
  assert.equal(body.querySelector('.rn-find-bar__count')?.textContent, '1/3')
  await key(dom.window, { key: 'g', metaKey: true })
  await settle()
  assert.deepEqual(calls.at(-1)?.request, { tabId: 'tab-1', text: '筛子', findNext: true, forward: true })
  await act(async () => { found!({ tabId: 'tab-1', requestId: 1, matches: 9, activeMatchOrdinal: 9, finalUpdate: true }) })
  assert.equal(body.querySelector('.rn-find-bar__count')?.textContent, '1/3', 'an answer to an older request is ignored')
  await act(async () => { found!({ tabId: 'tab-1', requestId: 2, matches: 3, activeMatchOrdinal: 2, finalUpdate: true }) })
  assert.equal(body.querySelector('.rn-find-bar__count')?.textContent, '2/3')
  await key(input, { key: 'Enter', shiftKey: true })
  await settle()
  assert.deepEqual(calls.at(-1)?.request, { tabId: 'tab-1', text: '筛子', findNext: true, forward: false })
  await key(input, { key: 'Escape' })
  await settle()
  assert.deepEqual(calls.at(-1), { kind: 'stop', request: { tabId: 'tab-1', action: 'clearSelection' } })
  assert.equal(body.querySelector('[data-browser-find-bar]'), null)
  // Another tab closes the bar.
  await key(dom.window, { key: 'f', metaKey: true })
  await settle(20)
  assert.ok(body.querySelector('[data-browser-find-bar]'))
  await render(<Host tabId="tab-2" />)
  assert.equal(body.querySelector('[data-browser-find-bar]'), null)
})

test('订阅: shown for a declared feed, one click adds it through 资讯, then 已订阅', async t => {
  const added: unknown[] = []
  const sources: Array<{ id: string; name: string; url: string }> = [{ id: 's0', name: '旧源', url: 'https://old.example.com/feed' }]
  const { body, render, settle } = await mount(t, {
    rss: {
      getSources: async () => ({ success: true, mock: false, data: sources }),
      addSource: async (source: { name: string; url: string }) => { added.push(source); sources.push({ id: 's1', ...source }); return { success: true, mock: false, data: { id: 's1', name: source.name } } },
    },
  })
  const feeds = [{ url: 'http://127.0.0.1/blog/feed.xml', title: '筛子小站', type: 'application/rss+xml' }]
  await render(<BrowserSubscribeButton feeds={feeds} pageTitle="筛子与阅读" />)
  await settle()
  const button = body.querySelector<HTMLButtonElement>('[data-browser-subscribe]')!
  assert.equal(button.textContent, '订阅')
  await act(async () => { button.click() })
  await settle()
  assert.deepEqual(added, [{ name: '筛子小站', url: 'http://127.0.0.1/blog/feed.xml' }])
  assert.equal(button.textContent, '已订阅')
  assert.equal(button.getAttribute('aria-disabled'), 'true')
  await act(async () => { button.click() })
  assert.equal(added.length, 1, 'subscribed feeds are not added twice')
  await render(<BrowserSubscribeButton feeds={[]} pageTitle="x" />)
  assert.equal(body.querySelector('[data-browser-subscribe]'), null)
})

test('阅读视图: the page’s article in 资讯’s reader; 划线 sends only the reading range, Main reads the words itself', async t => {
  const { default: BrowserReadingView } = await importWithoutAssets(() => import('../renderer/components/browser/BrowserReadingView'))
  const { readingRuns } = await import('../shared/rss-reading')
  const markdown = '第一段有一个**重点**词。\n\n第二段说筛子怎样留下好文章。'
  const url = 'https://example.com/blog/sieve'
  const article = { url, title: '筛子与阅读', byline: '白', siteName: 'example.com', publishedAt: Date.UTC(2026, 10, 1), lang: 'zh',
    article: { revision: 'rev-1' }, body: {}, text: markdown, textKind: 'body', offset: 0, totalLength: markdown.length, nextOffset: null }
  let answer: unknown = { success: true, data: article }
  const reads: string[] = [], highlights: unknown[] = []
  const { dom, body, render, settle } = await mount(t, {
    browser: { readTab: async ({ tabId }: { tabId: string }) => { reads.push(tabId); return answer } },
    sourceAnnotations: { webReading: async (input: unknown) => { highlights.push(input); return { success: true, data: { bookId: 'source', sourcePath: '/vault/文章/筛子与阅读.md', version: 'v', highlights: [{ id: 'hl', text: '筛子' }] } } } },
  })
  const closed: string[] = []
  await render(<BrowserReadingView tabId="tab-7" url={url} onClose={() => closed.push('close')} onTranslate={() => {}} />)
  await settle(10)
  const view = body.querySelector<HTMLElement>('[aria-label="阅读视图"]')!
  assert.deepEqual(reads, ['tab-7'])
  assert.equal(view.dataset.browserReadingView, 'ready')
  assert.equal(view.querySelector('.rss-reader-title')?.textContent, '筛子与阅读')
  assert.match(view.querySelector('.rss-reader-source')?.textContent || '', /example\.com· 白· 2026年11月1日/)
  assert.ok(view.querySelector('.rss-reader-body [data-ready-reading-run]'), 'the article is laid out in reading runs, as in 资讯')

  // Select “筛子” in the second paragraph, as a pointer would, and let the shared bar appear over it.
  const run = readingRuns(markdown).find(entry => entry.text.includes('筛子'))!
  const element = view.querySelector<HTMLElement>(`[data-ready-reading-run="${run.id}"]`)!
  const textNode = dom.window.document.createTreeWalker(element, 4).nextNode()!
  const at = textNode.textContent!.indexOf('筛子')
  const range = dom.window.document.createRange(); range.setStart(textNode, at); range.setEnd(textNode, at + 2)
  const rect = { left: 40, top: 200, right: 80, bottom: 220, width: 40, height: 20, x: 40, y: 200, toJSON() {} }
  Object.assign(dom.window.Range.prototype, { getBoundingClientRect: () => rect })
  const bounds = view.querySelector<HTMLElement>('.rss-reader-body')!
  bounds.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 900, width: 800, height: 900, x: 0, y: 0, toJSON() {} })
  dom.window.getSelection()!.removeAllRanges(); dom.window.getSelection()!.addRange(range)
  await act(async () => { bounds.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })) })
  await settle(10)
  const buttons = [...body.querySelectorAll<HTMLButtonElement>('[data-ready-selection-bar] button')]
  assert.deepEqual(buttons.map(button => button.textContent), ['划线', '存入 FastCard', '引用到文档', '问 AI', '保存到画板', '翻译'])
  await act(async () => buttons[0].click())
  await settle(10)
  assert.deepEqual(highlights, [{ tabId: 'tab-7', revision: 'rev-1', range: { start: { run: run.id, offset: at }, end: { run: run.id, offset: at + 2 } } }])

  // Esc goes back to the page; a page that does not read as an article says so, with the way back.
  await act(async () => { view.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  assert.deepEqual(closed, ['close'])
  answer = { success: false, error: 'not_readable' }
  await render(<BrowserReadingView tabId="tab-8" url={url} onClose={() => closed.push('back')} onTranslate={() => {}} />)
  await settle(10)
  const failed = body.querySelector<HTMLElement>('[aria-label="阅读视图"]')!
  assert.equal(failed.querySelector('[role="alert"] span')?.textContent, '这个网页读不出正文。')
  await act(async () => failed.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
  assert.deepEqual(closed, ['close', 'back'])
})
