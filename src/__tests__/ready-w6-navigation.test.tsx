import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { RSSQuerySchema } from '../shared/rss-workspace'
import type { ReadyRef } from '../shared/ready-ref'
import { conversationTurn } from '../shared/conversation-preview'
import { searchPresentation, SEARCH_TYPE_LABELS } from '../shared/search-presentation'

test('W6 every ReadyRef opens its destination and exposes preview content', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true }
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'w6', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { loadObjectPreview } = await import('../renderer/modules/workbench/object-ui/preview')
  const { useMode } = await import('../renderer/stores/useMode')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useFastCard } = await import('../renderer/stores/useFastCard')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { useRSSSession } = await import('../renderer/stores/useRSSSession')
  const { useLibraryRequest } = await import('../renderer/modules/library/reader/navigation-state')
  const { useConversationReveal } = await import('../renderer/modules/agent/conversation-navigation')
  const stores = [useMode, useDocTabs, useFastCard, useAgent, useWorkspace, useRSSSession, useLibraryRequest, useConversationReveal]
  const restore = stores.map(store => { const state = store.getState(); return () => store.setState(state, true) })
  t.after(() => { restore.forEach(fn => fn()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } dom.window.close() })
  const query = { ...RSSQuerySchema.parse({ search: '目标', filter: 'starred' }), expectedRevision: 3 }
  const view = { query, total: 1, items: [{ id: 'article', title: '文章标题' }], revision: 3, unreadTotal: 0, definitions: [], lastFetchAt: null, nextCursor: null }
  const messages = [{ id: 'q', role: 'user', content: '指定问题', timestamp: '2026-11-12', meta: { runId: 'run' } },
    { id: 'a', role: 'assistant', content: '指定回答', timestamp: '2026-11-12', meta: { runId: 'run' } },
    { id: 'later', role: 'user', content: '之后的问题', timestamp: '2026-11-13', meta: { runId: 'later' } }]
  const scope = { id: 'chat', title: '对话', agent: 'butler', sourceKind: 'local', sourceId: 'app', threadKey: 'chat', meta: {}, createdAt: '2026-11-12', updatedAt: '2026-11-12', messageVisibilityEpoch: 0 }
  let calendarTarget = '', webUrl = '', queryStale = false
  Object.assign(dom.window, { electronAPI: { navigationHistory: memoryNavigationAPI(),
    objects: { onMoved: () => () => {}, resolvePath: async (path: string) => ({ objectId: path.split('/').pop()!.split('.')[0], path, revision: 1 }), locate: async (id: string) => ({ objectId: id, path: `/fixture/${id}.${id === 'canvas' ? 'canvas' : id === 'binary' ? 'pdf' : 'md'}`, revision: 1 }),
      preview: async (ref: ReadyRef) => ref.kind === 'canvas' ? { kind: 'canvas', title: '画板', nodes: [{ id: 'node', title: '画板卡片', x: 0, y: 0, width: 100, height: 100 }] }
        : ref.kind === 'web' ? { kind: 'web', title: '网页标题', url: ref.url, excerpts: [{ id: 'h', text: '网页摘录', note: '' }] }
          : { kind: 'book', book: { id: 'book', title: '书名', author: '作者', coverPath: '/fixture/cover.png' }, passage: { text: '书中原文', prefix: '前文', suffix: '后文', located: true } } },
    document: { readFile: async (path: string) => path.endsWith('.pdf') ? { success: true, data: { type: 'binary', category: 'pdf', extension: 'pdf', localUrl: 'local-file://fixture/file.pdf', bytes: new Uint8Array([37,80,68,70]) } } : ({ success: true, content: path.includes('database') ? '---\nready_database: {}\n---' : '# 页面正文' }) },
    databasePreview: async () => ({ kind: 'database', view: { id: 'default' }, rows: [{ id: 'row', title: '第一行' }], total: 1 }),
    library: { get: async () => ({ success: true, data: { status: 'ready', books: [{ id: 'book', format: 'txt' }] } }) },
    browser: { createTab: async (url: string) => { webUrl = url; return { success: true, tabId: 'web' } }, listFastCardItems: async () => ({ success: true, data: [{ id: 'card', kind: 'text', title: '收集', text: '暂存内容', createdAt: 1 }] }) },
    calendar: { revealDay: async (date: string) => { calendarTarget = date; return { success: true } }, revealEvent: async (id: string) => { calendarTarget = id; return { success: true } }, snapshot: async () => ({ success: true, data: { events: [{ id: 'event', title: '日程内容', description: '日程说明', start: '2026-11-12', end: '2026-11-13', allDay: true }] } }) },
    calendarLinkage: { day: async () => ({ date: '2026-11-12', timeZone: 'UTC', items: [{ id: 'e', title: '当天日程', kind: 'events', ref: { kind: 'event', id: 'event' } }] }) },
    rss: { readArticle: async () => ({ success: true, data: { article: { id: 'article', title: '文章标题', source: '来源', summary: '文章摘要', revision: 'r1' } } }),
      queryItems: async () => queryStale ? { success: false, error: 'cursor_stale' } : { success: true, data: view },
      sieveRelevance: async () => ({ success: true, data: { reason: '与你的阅读相关', score: 80, because: 'interest', workRef: null, summaryOnly: true } }),
      readDigests: async () => ({ success: true, data: { view: 'entries', report: { scopeLabel: '刊物' }, entries: [{ source: { title: '摘要条目', quote: '摘要内容' } }] } }) },
    agent: { listConversationScopes: async () => ({ success: true, data: [scope] }), getConversationScopeMessages: async () => ({ success: true, data: messages }) },
  } })
  dom.window.addEventListener('ready:workbench-mode-change-request', event => useMode.setState({ workbenchMode: (event as CustomEvent).detail.mode }))
  const cases: Array<{ ref: ReadyRef; mode: 'document' | 'rss' | 'calendar' | 'browser'; text: string; check(): void }> = [
    ...['page', 'file', 'canvas'].map(kind => ({ ref: { kind, id: kind } as ReadyRef, mode: 'document' as const, text: kind === 'canvas' ? '画板卡片' : '页面正文', check: () => assert.equal(useWorkspace.getState().selectedFile, `/fixture/${kind}.${kind === 'canvas' ? 'canvas' : 'md'}`) })),
    { ref: { kind: 'file', id: 'binary' }, mode: 'document', text: 'PDF', check: () => assert.equal(useWorkspace.getState().selectedFile, '/fixture/binary.pdf') },
    { ref: { kind: 'page', id: 'database' }, mode: 'document', text: '第一行', check: () => assert.equal(useWorkspace.getState().selectedFile, '/fixture/database.md') },
    { ref: { kind: 'book-location', book: 'book', loc: 'c0:0+2' }, mode: 'document', text: '书中原文', check: () => assert.equal(useLibraryRequest.getState().target?.book, 'book') },
    { ref: { kind: 'event', id: 'event' }, mode: 'calendar', text: '日程说明', check: () => assert.equal(calendarTarget, 'event') },
    { ref: { kind: 'day', date: '2026-11-12' }, mode: 'calendar', text: '当天日程', check: () => assert.equal(calendarTarget, '2026-11-12') },
    { ref: { kind: 'web', url: 'https://example.com' }, mode: 'browser', text: '网页摘录', check: () => assert.equal(webUrl, 'https://example.com') },
    { ref: { kind: 'rss-item', id: 'article' }, mode: 'rss', text: '文章摘要', check: () => assert.equal(useRSSSession.getState().pendingReveal?.reference.kind, 'article') },
    { ref: { kind: 'rss-digest', id: 'digest', offset: 0, limit: 10 }, mode: 'rss', text: '摘要内容', check: () => assert.equal(useRSSSession.getState().pendingReveal?.reference.kind, 'digest') },
    { ref: { kind: 'rss-query', query }, mode: 'rss', text: '文章标题', check: () => assert.deepEqual(useRSSSession.getState().pendingReveal?.reference, { kind: 'query', query }) },
    { ref: { kind: 'conversation', id: 'chat', run: 'run' }, mode: 'calendar', text: '指定回答', check: () => { assert.equal(useAgent.getState().currentScopeId, 'chat'); assert.equal(useConversationReveal.getState().target?.messageId, 'q'); assert.equal(useWorkspace.getState().chatPanelVisible, true) } },
    { ref: { kind: 'fastcard', id: 'card' }, mode: 'calendar', text: '暂存内容', check: () => { assert.equal(useFastCard.getState().panelOpen, true); assert.equal(useFastCard.getState().revealTarget?.id, 'card') } },
  ]
  for (const entry of cases) await t.test(entry.ref.kind + ('id' in entry.ref ? ':' + entry.ref.id : ''), async () => {
    useMode.setState({ workbenchMode: 'calendar' }); useDocTabs.setState({ tabs: [], activeTabId: null })
    await openReadyRef(entry.ref)
    assert.equal(useMode.getState().workbenchMode, entry.mode); entry.check()
    const preview = await loadObjectPreview(entry.ref)
    assert.equal(preview.state, 'ready')
    assert.ok(preview.state === 'ready' && preview.body.includes(entry.text), JSON.stringify(preview))
  })
  await t.test('Today draft preserves live edits; pending calibration opens and previews its own proposal', async () => {
    const draft = { draftId: 'draft', tabId: 'draft-tab', title: '未保存', state: 'editing', content: '磁盘草稿' }
    Object.assign(dom.window.electronAPI, { documentDrafts: { read: async () => ({ ok: true, value: draft }) } })
    useDocTabs.setState({ tabs: [{ id: 'draft-tab', draftId: 'draft', path: null, title: '未保存', content: '尚未落盘的新修改', isDirty: true }], activeTabId: 'draft-tab' })
    await openReadyRef({ kind: 'draft', id: 'draft' })
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === 'draft-tab')?.content, '尚未落盘的新修改')
    const preview = await loadObjectPreview({ kind: 'draft', id: 'draft' })
    assert.equal(preview.state === 'ready' && preview.body, '尚未落盘的新修改')
    Object.assign(dom.window.electronAPI.rss, { sieveCalibration: async () => ({ success: true, data: { week: '2026-11-09', status: 'pending', text: '关注新书', explanation: '最近阅读' } }) })
    await openReadyRef({ kind: 'rss-calibration', id: '2026-11-09' })
    assert.equal(useRSSSession.getState().requestedCalibration, '2026-11-09')
    const calibration = await loadObjectPreview({ kind: 'rss-calibration', id: '2026-11-09' })
    assert.equal(calibration.state === 'ready' && calibration.body, '关注新书\n最近阅读')
    await assert.rejects(openReadyRef({ kind: 'rss-calibration', id: '2026-11-02' }), /提案已失效/)
  })
  await t.test('query replacement removes old filters; stale query fails before navigation', async () => {
    useRSSSession.getState().setQuery({ sourceId: 'old', categoryId: 'old' })
    useRSSSession.getState().replaceQuery(query, view)
    assert.equal(useRSSSession.getState().query.sourceId, undefined)
    assert.equal(useRSSSession.getState().query.categoryId, undefined)
    assert.equal(useRSSSession.getState().query.search, '目标')
    queryStale = true; useMode.setState({ workbenchMode: 'document' })
    await assert.rejects(openReadyRef({ kind: 'rss-query', query }), /cursor_stale/)
    assert.equal(useMode.getState().workbenchMode, 'document')
  })
  await t.test('FastCard scrolls in the drawer and the overlay, including repeated requests', async () => {
    const { createRoot } = await import('react-dom/client')
    const { FastCardShelf } = await import('../renderer/modules/fastcard/FastCardShelf')
    const { default: FastCardOverlayWindow } = await import('../renderer/pages/FastCardOverlayWindow')
    const scrolled: string[] = []
    dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.dataset.fastcardId || '') }
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => { await openReadyRef({ kind: 'fastcard', id: 'card' }); root.render(<FastCardShelf visible />) })
      assert.deepEqual(scrolled, ['card']); assert.equal(dom.window.document.activeElement?.getAttribute('data-fastcard-id'), 'card')
      await act(async () => { await openReadyRef({ kind: 'fastcard', id: 'card' }) }); assert.deepEqual(scrolled, ['card', 'card'])
      Object.assign(window.electronAPI.browser, { getFastCardOverlaySnapshot: async () => ({ success: true, data: { mode: 'fastcard', items: useFastCard.getState().items, revealTarget: useFastCard.getState().revealTarget } }) })
      await act(async () => root.render(<FastCardOverlayWindow />))
      assert.deepEqual(scrolled, ['card', 'card', 'card'])
    } finally { await act(async () => root.unmount()) }
  })
  await t.test('failed browser creation never opens the system browser', async () => {
    const { openWebpageInBrowser } = await import('../renderer/modules/browser/openWebpageInBrowser')
    Object.assign(window.electronAPI.browser, { createTab: async () => ({ success: false }) })
    dom.window.open = () => { throw new Error('system browser must not open') }
    useMode.setState({ workbenchMode: 'calendar' })
    assert.equal(await openWebpageInBrowser('https://example.com/failure'), false)
    assert.equal(useMode.getState().workbenchMode, 'calendar')
  })
  await assert.rejects(openReadyRef({ kind: 'conversation', id: 'chat', run: 'missing' }), /不存在/)
  await assert.rejects(openReadyRef({ kind: 'fastcard', id: 'missing' }), /无法打开/)
})

test('W6 type labels and authored titles; conversation preview never substitutes a later run', () => {
  assert.deepEqual(Object.values(SEARCH_TYPE_LABELS), ['页面', '数据库', '画板', '书', '划线', '资讯', '日程', '对话', '书签', '收集', '命令'])
  assert.deepEqual(searchPresentation({ name: '笔记.md', path: '/笔记.md', sourceType: 'document' }), { title: '笔记', typeLabel: '页面' })
  assert.equal(searchPresentation({ name: 'v1.2', path: 'ready://rss/item/a', sourceType: 'rss' }).title, 'v1.2')
  assert.throws(() => conversationTurn([{ id: 'q', role: 'user', content: '后来', meta: { runId: 'other' } }], 'missing'), /不存在/)
})

export const __breaksInvariants = ['renderer stores and DOM restored after isolated navigation test'] as const
