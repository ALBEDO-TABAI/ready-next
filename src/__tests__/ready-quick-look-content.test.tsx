import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { ReadyRef } from '../shared/ready-ref'

// W6 T2/T3: a quick look shows the object's content, never its path; ⌘K shows titles and Chinese types and offers
// ↵ / ⌥↵ / ⌘↵. Real QuickLook, QuickSwitcher, stores and navigation; Main (electronAPI) answers with fixed data.
const year = new Date().getFullYear()
async function setup(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'w6-look', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const acks = new Set<(ack: { intentId: number }) => void>()
  const databaseContent = '---\nready_database: {}\n---\n选题与发布节奏。\n'
  const api = {
    browser: {
      onIntentAck: (cb: (ack: { intentId: number }) => void) => { acks.add(cb); return () => acks.delete(cb) },
      sendIntent: (intent: { intentId: number }) => queueMicrotask(() => acks.forEach(cb => cb({ intentId: intent.intentId }))),
      listFastCardItems: async () => ({ success: true, data: [{ id: 'card', kind: 'text', createdAt: Date.parse(`${year}-11-11T09:30:00`), text: '一个好的筛子，应该先理解你在做什么。', source: { pageUrl: 'https://example.com/a/0', pageTitle: '本地模型的新进展' } }] }),
    },
    objects: {
      onMoved: () => () => {},
      locate: async (id: string) => ({ objectId: id, path: `/vault/${id === 'db' ? '选题库' : id}.${id === 'board' ? 'canvas' : 'md'}`, revision: 1 }),
      resolvePath: async (path: string) => ({ objectId: path.includes('选题库') ? 'db' : 'page', path, revision: 1 }),
      preview: async (ref: ReadyRef) => ref.kind === 'canvas'
        ? { kind: 'canvas', title: '灵感', nodes: [{ id: 'a', x: 80, y: 80, width: 260, height: 140, title: '筛子' }, { id: 'b', x: 380, y: 60, width: 260, height: 140, title: '注意力才是稀缺品。' }, { id: 'c', x: 700, y: 120, width: 260, height: 140, title: '把卡片排成提纲' }] }
        : ref.kind === 'web' ? { kind: 'web', title: '官网', url: ref.url, excerpts: [{ id: 'e', text: '真正稀缺的是注意力。', note: '开头用' }] }
          : { kind: 'book', book: { id: 'book', title: '城市漫游者', author: '白', format: 'txt' },
            passage: { text: '城市像一本摊开的书', prefix: '他开始注意那些被忽略的招牌。', suffix: '，每一条巷子都是脚注。', chapterTitle: '第一章 街道的记忆', note: '这个比喻留着', located: true } },
    },
    document: {
      readFile: async (path: string) => ({ success: true, content: path.includes('选题库') ? databaseContent : '# 页面\n\n正文' }),
      searchIndex: async () => ({ success: true, data: { items: searchItems, stats: { returned: 4, elapsedMs: 1 }, degraded: false } }),
    },
    databasePreview: async () => ({ kind: 'database', total: 5,
      definition: { version: 1, source: '选题库', fields: { 状态: { id: 'status', name: '状态', type: 'select', options: ['想法', '写作中'] }, 日期: { id: 'date', name: '日期', type: 'date' } }, views: [{ id: 'table', name: '表格', type: 'table' }] },
      view: { id: 'table', name: '表格', type: 'table' },
      rows: [
        { id: 'r1', title: 'RSS 的筛子理论', version: 'v', values: {}, cells: { $title: { status: 'value', value: 'RSS 的筛子理论' }, status: { status: 'value', value: '写作中' }, date: { status: 'value', value: `${year}-11-14` } } },
        { id: 'r2', title: '日历即时间轴', version: 'v', values: {}, cells: { $title: { status: 'value', value: '日历即时间轴' }, status: { status: 'value', value: '想法' }, date: { status: 'error', code: 'invalid', message: '日期无效' } } },
      ] }),
    documentPages: { states: async () => ({ ok: true, value: [] }), onChanged: () => () => {} },
    rss: {
      readArticle: async () => ({ success: true, data: { article: { id: 'a1', title: 'RSS 没有死，只是换了读法', source: '演示订阅源', link: 'https://example.com/a/7', summary: '订阅不是问题，读法才是。' } } }),
      sieveRelevance: async () => ({ success: true, data: { score: 82, because: 'work', reason: '和你在写的筛子直接相关', workRef: 'RSS 的筛子理论', summaryOnly: false } }),
    },
    calendarLinkage: { day: async ({ date }: { date: string }) => ({ date, timeZone: 'UTC', items: [
      { id: 'e', kind: 'events', title: '选题会', detail: '10:00', ref: { kind: 'event', id: 'meeting' } },
      { id: 'd', kind: 'documents', title: '新书发布', ref: { kind: 'page', id: 'page' } },
    ] }) },
    agent: {
      listConversationScopes: async () => ({ success: true, data: [{ id: 'chat', title: '筛子讨论' }] }),
      getConversationScopeMessages: async () => ({ success: true, data: [{ id: 'q', role: 'user', content: '筛子应该先看什么？', meta: { runId: 'r' } }, { id: 'a', role: 'assistant', content: '先看**你在做什么**，再决定给你看什么。', meta: { runId: 'r' } }] }),
    },
  }
  const searchItems = [
    { path: 'ready://read/book/book#c0%3A0%2B1', name: '城市漫游者', title: '城市漫游者', typeLabel: '书', sourceType: 'book', nameMatch: true, snippet: '', tagsHit: [], linksHit: [] },
    { path: '/vault/选题库.md', name: '选题库.md', title: '选题库', typeLabel: '数据库', sourceType: 'document', nameMatch: true, snippet: '', tagsHit: [], linksHit: [] },
    { path: 'ready://doc/page/book#%5Ehl-1', name: '城市漫游者 · 第一章', title: '城市漫游者 · 第一章', typeLabel: '划线', sourceType: 'highlight', nameMatch: false, snippet: '', tagsHit: [], linksHit: [] },
    { path: 'ready://fastcard/card', name: '一个好的筛子', title: '一个好的筛子', typeLabel: '收集', sourceType: 'fastcard', nameMatch: false, snippet: '', tagsHit: [], linksHit: [] },
  ]
  Object.defineProperty(dom.window, 'electronAPI', { value: api })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { useMode } = await import('../renderer/stores/useMode')
  const stores = [useDocTabs, useWorkspace, useMode]
  const restore = stores.map(store => { const state = store.getState(); return () => store.setState(state, true) })
  useDocTabs.setState({ tabs: [], activeTabId: '', focusedPaneTabId: null, splitTabId: null })
  // A plausible library root: validateWorkspaceRoot refuses shallow system folders.
  useWorkspace.setState({ workspaceRoot: '/private/tmp/w6-look/vault', pinnedFolders: ['/private/tmp/w6-look/vault'] })
  dom.window.addEventListener('ready:workbench-mode-change-request', event => useMode.setState({ workbenchMode: (event as CustomEvent).detail.mode }))
  t.after(async () => {
    await act(async () => root.unmount()); await new Promise(resolve => setTimeout(resolve, 20)); restore.forEach(fn => fn()); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  })
  const settle = async () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5)) })
  const look = async (reference: ReadyRef) => {
    const { QuickLook } = await import('../renderer/modules/workbench/object-ui/QuickLook')
    await act(async () => root.render(<QuickLook reference={reference} onClose={() => {}} />)); await settle()
    const panel = dom.window.document.querySelector<HTMLElement>('.rn-ql')
    assert.ok(panel, `quick look for ${reference.kind}`)
    assert.doesNotMatch(panel.textContent!, /\/vault\//, `${reference.kind}: never a path`)
    return panel
  }
  const all = (panel: Element, selector: string) => [...panel.querySelectorAll(selector)].map(node => node.textContent)
  return { dom, root, look, all, settle, useDocTabs, useWorkspace, useMode }
}

test('W6 T2 quick look renders content: database rows, a board in miniature, a highlight in its context, an article with its reason', async t => {
  const h = await setup(t)
  let panel = await h.look({ kind: 'page', id: 'db' })
  assert.match(panel.querySelector('.rn-ql__kind')!.textContent!, /数据库/)
  assert.deepEqual(h.all(panel, '.rn-ql-table th'), ['标题', '状态', '日期'])
  assert.deepEqual(h.all(panel, '.rn-ql-table tbody tr:first-child td'), ['RSS 的筛子理论', '写作中', '11月14日'])
  assert.deepEqual(h.all(panel, '.rn-ql-table tbody tr:last-child td'), ['日历即时间轴', '想法', '日期无效'], 'a calculation error stays visible')
  assert.match(panel.textContent!, /前 2 行，共 5 行 · 表格视图/)

  panel = await h.look({ kind: 'canvas', id: 'board' })
  const board = panel.querySelector('.rn-ql-board')!
  assert.equal(board.getAttribute('role'), 'img'); assert.equal(board.getAttribute('aria-label'), '画板缩略图：3 张卡片')
  const cards = [...board.querySelectorAll<HTMLElement>('.rn-ql-board__card')]
  assert.deepEqual(cards.map(card => card.textContent), ['筛子', '注意力才是稀缺品。', '把卡片排成提纲'])
  const left = (card: HTMLElement) => parseFloat(card.style.left)
  assert.ok(left(cards[0]) < left(cards[1]) && left(cards[1]) < left(cards[2]), 'cards keep their order on the board')
  assert.ok(cards.every(card => parseFloat(card.style.left) >= 0 && parseFloat(card.style.left) + parseFloat(card.style.width) <= 100), 'every card fits the thumbnail')

  panel = await h.look({ kind: 'page', id: 'book', anchor: '^hl-1' })
  assert.match(panel.querySelector('.rn-ql__kind')!.textContent!, /划线/)
  assert.equal(panel.querySelector('.rn-ql-book__title')!.textContent, '城市漫游者')
  assert.equal(panel.querySelector('.rn-ql-book__author')!.textContent, '白')
  assert.equal(panel.querySelector('.rn-ql-book__chapter')!.textContent, '第一章 街道的记忆')
  assert.equal(panel.querySelector('.rn-ql-passage mark')!.textContent, '城市像一本摊开的书')
  assert.deepEqual(h.all(panel, '.rn-ql-passage__context'), ['他开始注意那些被忽略的招牌。', '，每一条巷子都是脚注。'])
  assert.equal(panel.querySelector('.rn-ql-annotation')!.textContent, '这个比喻留着')

  panel = await h.look({ kind: 'rss-item', id: 'a1' })
  assert.equal(panel.querySelector('.rn-ql__title')!.textContent, 'RSS 没有死，只是换了读法')
  const source = panel.querySelector<HTMLAnchorElement>('.rn-ql-meta [data-ready-ref-capsule]')!
  assert.equal(source.getAttribute('aria-label'), '网页 演示订阅源', 'the source is a capsule to the original')
  assert.equal(panel.querySelector('.rn-ql-summary')!.textContent, '订阅不是问题，读法才是。')
  assert.equal(panel.querySelector('.rn-ql-reason')!.textContent, '你在做的《RSS 的筛子理论》和你在写的筛子直接相关')
})

test('W6 T2 the rarer kinds: the day lists capsules, a web page its excerpts, a turn its question and answer, a FastCard the card', async t => {
  const h = await setup(t)
  let panel = await h.look({ kind: 'day', date: `${year}-11-12` })
  assert.deepEqual(h.all(panel, '.rn-ql-group h3'), ['日程', '文档日期'])
  assert.deepEqual([...panel.querySelectorAll('.rn-ql-group [data-ready-ref-capsule]')].map(a => a.getAttribute('aria-label')), ['日程 选题会', '页面 新书发布'])
  panel = await h.look({ kind: 'web', url: 'https://example.com/' })
  assert.equal(panel.querySelector('.rn-ql-url')!.textContent, 'https://example.com/')
  assert.equal(panel.querySelector('.rn-ql-excerpts .rn-ql-passage')!.textContent, '真正稀缺的是注意力。')
  panel = await h.look({ kind: 'conversation', id: 'chat', run: 'r' })
  assert.equal(panel.querySelector('.rn-ql-turn__question p')!.textContent, '筛子应该先看什么？')
  assert.equal(panel.querySelector('.rn-ql-turn__answer strong')!.textContent, '你在做什么')
  panel = await h.look({ kind: 'fastcard', id: 'card' })
  assert.equal(panel.querySelector('.rn-ql-summary')!.textContent, '一个好的筛子，应该先理解你在做什么。')
  assert.equal(panel.querySelector('.rn-ql-meta [data-ready-ref-capsule]')!.getAttribute('aria-label'), '网页 本地模型的新进展')
})

test('W6 T3 ⌘K: titles without extensions and Chinese types; ↵ opens, ⌥↵ quick-looks, ⌘↵ opens in a new tab', async t => {
  const h = await setup(t)
  const { ObjectUIHost } = await import('../renderer/modules/workbench/object-ui/ObjectUIHost')
  await act(async () => h.root.render(<ObjectUIHost onSettings={() => {}} />))
  const press = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = h.dom.window) => {
    await act(async () => { target.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) }); await h.settle()
  }
  const field = () => h.dom.window.document.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const type = async (value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new h.dom.window.Event('input', { bubbles: true })) })
    await h.settle()
  }
  await press('k', { metaKey: true }); await type('城市')
  const rows = [...h.dom.window.document.querySelectorAll('.rn-switch-item')].slice(0, 4)
  assert.deepEqual(rows.map(row => [row.querySelector('.rn-switch-name')!.textContent, row.querySelector('.rn-switch-type')!.textContent]),
    [['城市漫游者', '书'], ['选题库', '数据库'], ['城市漫游者 · 第一章', '划线'], ['一个好的筛子', '收集']])
  assert.doesNotMatch(h.dom.window.document.querySelector('#ready-object-results')!.textContent!, /\.md\b/)
  assert.match(h.dom.window.document.querySelector('.rn-switch-foot')!.textContent!, /⌘↵ 新标签打开/)

  // ⌥↵ on the book: a quick look of the book instead of opening it.
  await press('Enter', { altKey: true }, field())
  assert.equal(h.dom.window.document.querySelector('input[role="combobox"]'), null)
  assert.equal(h.dom.window.document.querySelector('.rn-ql-book__title')?.textContent, '城市漫游者')
  await press('Escape')

  // ⌘↵ on the database keeps the current document tab and opens a tab of its own.
  h.useMode.setState({ workbenchMode: 'document' })
  h.useDocTabs.setState({ tabs: [{ id: 'current', path: '/vault/current.md', title: 'current', content: '', isDirty: false }], activeTabId: 'current' })
  await press('k', { metaKey: true }); await type('城市')
  await press('ArrowDown', {}, field()); await press('Enter', { metaKey: true }, field())
  assert.deepEqual(h.useDocTabs.getState().tabs.map(tab => tab.path), ['/vault/current.md', '/vault/选题库.md'])
  // ↵ on it again, from the current tab: the link navigates that tab, as in Inkwell.
  h.useDocTabs.setState({ tabs: [{ id: 'current', path: '/vault/current.md', title: 'current', content: '', isDirty: false }], activeTabId: 'current' })
  await press('k', { metaKey: true }); await type('城市')
  await press('ArrowDown', {}, field()); await press('Enter', {}, field())
  assert.deepEqual(h.useDocTabs.getState().tabs.map(tab => tab.path), ['/vault/选题库.md'])
})

export const __breaksInvariants = ['renderer navigation stores restored after the isolated quick look test'] as const
