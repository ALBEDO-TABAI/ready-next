import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { ReadyRef } from '../shared/ready-ref'

async function setup(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'm5c-test', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  let autoAck = true
  const listeners = new Set<(ack: { intentId: number }) => void>(), intents: number[] = [], locks: boolean[] = []
  dom.window.addEventListener('ready:browser-overlay-lock', event => locks.push((event as CustomEvent).detail.locked))
  let deleted = false
  const api = {
    browser: { onIntentAck: (cb: (ack: { intentId: number }) => void) => { listeners.add(cb); return () => listeners.delete(cb) }, sendIntent: (intent: { intentId: number }) => { intents.push(intent.intentId); if (autoAck) queueMicrotask(() => listeners.forEach(cb => cb({ intentId: intent.intentId }))) }, listFastCardItems: async () => ({ success: true, data: [{ id: 'card', title: '卡片标题', text: '卡片内容' }] }) },
    objects: { onMoved: () => () => {}, locate: async (id: string) => deleted || id === 'gone' ? null : ({ objectId: id, path: `/fixture/${id}.md`, revision: 1 }), resolvePath: async (path: string) => ({ objectId: 'page', path, revision: 1 }) },
    document: { readFile: async () => ({ success: true, content: '# 磁盘正文' }), searchIndex: async (_input: { query: string }) => ({ success: true, data: { items: [] as ReturnType<typeof hit>[], stats: { returned: 0, elapsedMs: 1 }, degraded: false } }) },
    documentPages: { states: async () => ({ ok: true, value: [] }), onChanged: (_cb: () => void) => () => {} },
    library: { get: async () => ({ success: true, data: { status: 'ready', books: [{ id: 'book', title: '书名', author: '作者', format: 'epub', status: '在读' }] } }) },
    calendar: { snapshot: async () => ({ success: true, data: { events: [{ id: 'event', calendarId: 'cal', title: '会议', start: '2026-10-31', end: '2026-11-01', allDay: true }], calendars: [] } }) },
    rss: {
      readArticle: async () => ({ success: true, data: { article: { title: '文章标题', summary: '文章摘要' } } }),
      readExcerpt: async () => ({ success: true, data: { text: '准确片段' } }),
      queryItems: async () => ({ success: true, data: { total: 1, items: [{ title: '查询文章' }] } }),
      readDigests: async () => ({ success: true, data: { view: 'entries', report: { scopeLabel: '刊物' }, entries: [{ source: { title: '条目', quote: '依据' } }] } }),
    },
    agent: { listConversationScopes: async () => ({ success: true, data: [{ id: 'chat', title: '对话' }] }), getConversationScopeMessages: async () => ({ success: true, data: [{ content: '会话正文' }] }) },
    objectRelations: { query: async (_id: string) => ({ ok: true, value: { outgoing: [{ id: 'a', title: '未找到', ref: null, sourceType: 'unresolved', reason: '尚未解析', relation: 'wikilink' }], incoming: [{ id: 'b', title: '来源页面', ref: { kind: 'page', id: 'source' }, sourceType: 'page', reason: null, relation: 'wikilink' }], backlinkCount: 1, truncated: false } }) },
  }
  Object.defineProperty(dom.window, 'electronAPI', { value: api })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  useDocTabs.setState({ tabs: [], activeTabId: '', focusedPaneTabId: null, splitTabId: null })
  useWorkspace.setState({ workspaceRoot: '/private/tmp/m5c/vault', pinnedFolders: ['/private/tmp/m5c/vault'] })
  t.after(async () => { await act(async () => root.unmount()); await new Promise(resolve => setTimeout(resolve, 40)); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  return { dom, api, intents, locks, useDocTabs, useWorkspace,
    deleted: () => { deleted = true }, autoAck: (value: boolean) => { autoAck = value }, ack: (intentId: number) => listeners.forEach(cb => cb({ intentId })),
    render: async (node: React.ReactNode) => { await act(async () => root.render(node)) },
    text: () => dom.window.document.body.textContent || '',
    input: async (value: string) => { await act(async () => { const input = dom.window.document.querySelector('input')!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) },
    key: async (key: string) => { await act(async () => dom.window.document.querySelector('input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))) },
  }
}
function hit(name: string, path = `ready://doc/page/${name}`) { return { path, name, sourceType: 'document', nameMatch: true, snippet: '', tagsHit: [], linksHit: [] } }

test('M5-C switcher searches shared query, discards late responses, selects with keyboard and opens through real stores', async t => {
  const ui = await setup(t)
  const { ObjectUIHost } = await import('../renderer/modules/workbench/object-ui/ObjectUIHost')
  const pending = new Map<string, (value: Awaited<ReturnType<typeof ui.api.document.searchIndex>>) => void>()
  ui.api.document.searchIndex = input => new Promise(resolve => pending.set(input.query, resolve))
  await ui.render(<ObjectUIHost onSettings={() => {}} />)
  await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })))
  await ui.input('old'); await ui.input('new')
  assert.deepEqual([...pending.keys()], ['old', 'new'], ui.text())
  const respond = async (query: string, names: string[]) => act(async () => pending.get(query)!({ success: true, data: { items: names.map(name => hit(name)), stats: { returned: names.length, elapsedMs: 1 }, degraded: false } }))
  await respond('new', ['new-one', 'new-two'])
  await respond('old', ['old-result'])
  assert.match(ui.text(), /new-two/); assert.doesNotMatch(ui.text(), /old-result/)
  await ui.key('ArrowDown'); await ui.key('Enter')
  assert.equal(ui.useWorkspace.getState().selectedFile, '/fixture/new-two.md')
  assert.equal(ui.dom.window.document.querySelector('[role=dialog]'), null)
  await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })))
  assert.match(ui.text(), /最近打开/); assert.doesNotMatch(ui.text(), /old-result/)
})

test('M5-C dirty content replaces both matching and no-longer-matching disk search hits', async t => {
  const ui = await setup(t)
  const { draftSearchResults, mergeDraftResults } = await import('../renderer/modules/workbench/object-ui/query')
  ui.useDocTabs.setState({ tabs: [{ id: 'tab', path: '/fixture/a.md', title: 'Page', content: 'new content', isDirty: true }] })
  const tabs = ui.useDocTabs.getState().tabs
  assert.deepEqual(mergeDraftResults([hit('old', '/fixture/a.md')], draftSearchResults('old', tabs), tabs), [])
  assert.equal(mergeDraftResults([], draftSearchResults('new', tabs), tabs)[0].draft?.tabId, 'tab')
})

test('M5-C previews each reference kind, current unsaved content, deletion and stale object responses', async t => {
  const ui = await setup(t)
  const { QuickLook } = await import('../renderer/modules/workbench/object-ui/QuickLook')
  const close = () => {}
  const cases: Array<[ReadyRef, string]> = [
    [{ kind: 'page', id: 'page' }, '磁盘正文'], [{ kind: 'file', id: 'file' }, '磁盘正文'], [{ kind: 'canvas', id: 'canvas' }, '画板'],
    [{ kind: 'web', url: 'https://example.com' }, 'example.com'], [{ kind: 'day', date: '2026-10-31' }, '2026-10-31'],
    [{ kind: 'book-location', book: 'book', loc: 'chapter:0' }, '作者'], [{ kind: 'event', id: 'event' }, '会议'],
    [{ kind: 'rss-item', id: 'article' }, '文章摘要'], [{ kind: 'rss-digest', id: 'digest', offset: 0, limit: 10 }, '依据'],
    [{ kind: 'rss-query', query: { expectedRevision: 0, scope: 'inbox', filter: 'all', search: '', searchIn: 'title_summary', sort: 'newest', limit: 50 } }, '查询文章'], [{ kind: 'conversation', id: 'chat' }, '会话正文'], [{ kind: 'fastcard', id: 'card' }, '卡片内容'],
  ]
  for (const [reference, text] of cases) { await ui.render(<QuickLook reference={reference} onClose={close} />); assert.ok(ui.text().includes(text), `${reference.kind}: ${ui.text()}`) }
  await act(async () => ui.useDocTabs.setState({ tabs: [{ id: 'dirty', objectId: 'page', path: '/fixture/page.md', title: 'Page', content: '尚未保存的内容', isDirty: true }] }))
  await ui.render(<QuickLook reference={{ kind: 'page', id: 'page' }} onClose={close} />)
  assert.match(ui.text(), /未保存/); assert.match(ui.text(), /尚未保存的内容/); assert.doesNotMatch(ui.text(), /磁盘正文/)
  ui.deleted()
  await ui.render(<QuickLook reference={{ kind: 'page', id: 'page' }} onClose={close} />)
  assert.match(ui.text(), /引用已失效/); assert.doesNotMatch(ui.text(), /尚未保存的内容/)
  let late!: (value: { objectId: string; path: string; revision: number }) => void
  ui.api.objects.locate = () => new Promise(resolve => { late = resolve })
  await ui.render(<QuickLook reference={{ kind: 'page', id: 'late' }} onClose={close} />)
  await ui.render(<QuickLook reference={{ kind: 'web', url: 'https://current.example' }} onClose={close} />)
  await act(async () => late({ objectId: 'late', path: '/fixture/late.md', revision: 1 }))
  assert.match(ui.text(), /current.example/); assert.doesNotMatch(ui.text(), /磁盘正文/)

})

test('M5-C relations group unresolved and incoming pages and open through the unified entry', async t => {
  const ui = await setup(t)
  const { RelationsPanel } = await import('../renderer/modules/workbench/object-ui/RelationsPanel')
  await ui.render(<RelationsPanel objectId="page" />)
  assert.match(ui.text(), /反链 1/); assert.match(ui.text(), /未解析/); assert.match(ui.text(), /来源页面/)
  const button = [...ui.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '来源页面')!
  await act(async () => button.click())
  assert.equal(ui.useWorkspace.getState().selectedFile, '/fixture/source.md')
})

test('M5-C native overlay waits for matching ack, fails closed, and balances close-before-ack locks', async t => {
  const ui = await setup(t)
  const { MaskedObjectOverlay } = await import('../renderer/modules/workbench/object-ui/QuickLook')
  ui.autoAck(false)
  const close = () => {}
  await ui.render(<MaskedObjectOverlay onClose={close}><p>private preview</p></MaskedObjectOverlay>)
  assert.doesNotMatch(ui.text(), /private preview/)
  await act(async () => ui.ack(ui.intents.at(-1)! - 1))
  assert.doesNotMatch(ui.text(), /private preview/)
  await act(async () => ui.ack(ui.intents.at(-1)!))
  assert.match(ui.text(), /private preview/)
  await ui.render(null)
  await ui.render(<MaskedObjectOverlay onClose={close}><p>pending preview</p></MaskedObjectOverlay>)
  await ui.render(null)
  await act(async () => ui.ack(ui.intents.at(-1)!))
  assert.doesNotMatch(ui.text(), /pending preview/)
  assert.equal(ui.locks.filter(Boolean).length, ui.locks.filter(value => !value).length)
  await ui.render(<MaskedObjectOverlay onClose={close}><p>failed preview</p></MaskedObjectOverlay>)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
  assert.doesNotMatch(ui.text(), /failed preview/); assert.match(ui.text(), /未确认隐藏/)
  assert.equal(ui.locks.filter(Boolean).length, ui.locks.filter(value => !value).length)
})
