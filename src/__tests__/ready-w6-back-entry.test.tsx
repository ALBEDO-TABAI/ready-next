import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { importWithoutStyles } from './utils/import-without-styles'
import type { NavigationEntry } from '../shared/navigation-history'

// W6 T7 (§4) and §2.3: the one way back in every mode, 今日 as a tab over the current entry, and ⌘K with nothing typed.
// Real components, stores and history; Main (electronAPI) answers with fixed data.
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
// The theme store (read by the keyboard hook) asks for the system theme.
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const globals = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, localStorage: dom.window.localStorage,
  // jsdom has no layout observer.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
}
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'w6-back', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
const revealed: string[] = []
const acks = new Set<(ack: { intentId: number }) => void>()
Object.defineProperty(dom.window, 'electronAPI', { value: {
  // The switcher waits for the native web layer to acknowledge hiding.
  browser: { onIntentAck: (callback: (ack: { intentId: number }) => void) => { acks.add(callback); return () => acks.delete(callback) },
    sendIntent: (intent: { intentId: number }) => { queueMicrotask(() => acks.forEach(callback => callback({ intentId: intent.intentId }))) } },
  navigationHistory: memoryNavigationAPI(),
  // A page's file is named after its title.
  objects: { onMoved: () => () => {}, resolvePath: async (path: string) => ({ objectId: path === '/vault/新书发布.md' ? 'launch' : path.split('/').pop()!.split('.')[0], path, revision: 1 }),
    locate: async (id: string) => ({ objectId: id, path: `/vault/${id === 'launch' ? '新书发布' : id}.md`, revision: 1 }) },
  calendar: { revealEvent: async (id: string) => { revealed.push(id); return { success: true } }, snapshot: async () => ({ success: true, data: { events: [{ id: 'cover', title: '封面评审' }], calendars: [] } }) },
  rss: { readArticle: async () => ({ success: true, data: { article: { id: 'article', title: '一个人的出版社', revision: 'r1' } } }) },
  documentPages: { tree: async () => ({ ok: true, value: { objectId: 'vault', children: [] } }), states: async () => ({ ok: true, value: [] }), onChanged: () => () => {} },
  document: { readFile: async () => ({ success: true, content: '# 页面' }), searchIndex: async () => ({ success: true, data: { items: [], stats: { returned: 0, elapsedMs: 1 }, degraded: false } }) },
} })
dom.window.addEventListener('ready:workbench-mode-change-request', event => useMode.setState({ workbenchMode: (event as CustomEvent).detail.mode }))

const { NavigationBackEntry, InkTopbar, InkTabStrip, ObjectUIHost } = await importWithoutStyles(async () => ({
  ...await import('../renderer/modules/workbench/NavigationBackEntry'),
  ...await import('../renderer/modules/document/ink/InkTopbar'),
  ...await import('../renderer/modules/document/ink/InkTabStrip'),
  ...await import('../renderer/modules/workbench/object-ui/ObjectUIHost'),
}))
const { navigationHistory, navigateBack, navigateForward } = await import('../renderer/modules/workbench/navigation-history')
const { ShellSidebarSlotProvider } = await import('../renderer/modules/workbench/shell/ShellSidebar')
const { useMode } = await import('../renderer/stores/useMode')
const { useDocTabs } = await import('../renderer/stores/useDocTabs')
const { useInkLayout } = await import('../renderer/modules/document/ink/layout-state')
const stores = [useMode, useDocTabs, useInkLayout]
const restore = stores.map(store => { const state = store.getState(); return () => store.setState(state, true) })
const { createRoot } = await import('react-dom/client')
const root = createRoot(dom.window.document.getElementById('root')!)
test.after(async () => {
  await act(async () => root.unmount())
  restore.forEach(fn => fn())
  dom.window.close()
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
})

const body = dom.window.document.body
const all = (selector: string) => [...body.querySelectorAll<HTMLElement>(selector)]
const render = (node: React.ReactNode) => act(async () => root.render(node))
const change = (update: () => void) => act(async () => update())
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); await new Promise(resolve => setTimeout(resolve, 20)) })
const entry = (mode: NavigationEntry['mode'], ref: NavigationEntry['ref'], title: string): NavigationEntry => ({ mode, ref, title, openedAt: Date.now(), anchor: [] })
const MODES = ['browser', 'document', 'rss', 'calendar'] as const
function Panes({ focused = 'rss' }: { focused?: typeof MODES[number] }) {
  return <ShellSidebarSlotProvider value={{ element: null, mode: focused, motion: null }}>
    {MODES.map(mode => <section key={mode} data-pane={mode}><NavigationBackEntry mode={mode} /></section>)}
  </ShellSidebarSlotProvider>
}
const backLabels = () => all('[data-navigation-back]').map(node => [node.dataset.navigationBack, node.querySelector('[aria-label^="返回 "]')?.textContent ?? null, !!node.querySelector('[aria-label^="前进到 "]')])

test('the way back names its target in every mode, hides when empty, and steps through the shared history', async () => {
  await change(() => { useDocTabs.setState({ tabs: [], activeTabId: null }); useMode.setState({ workbenchMode: 'rss', splitMode: null }); useInkLayout.setState({ home: false }) })
  await render(<Panes />)
  await act(async () => { await navigationHistory.load() })
  assert.equal(all('[data-navigation-back]').length, 0, 'nothing to go back to: no entry anywhere')

  await act(async () => {
    await navigationHistory.open(entry('document', { kind: 'page', id: 'launch' }, '新书发布'), async () => {})
    await navigationHistory.open(entry('calendar', { kind: 'event', id: 'cover' }, '封面评审'), async () => {})
    await navigationHistory.open(entry('rss', { kind: 'rss-item', id: 'article' }, '一个人的出版社'), async () => {})
  })
  assert.deepEqual(backLabels(), MODES.map(mode => [mode, '封面评审', false]), 'exactly one entry per mode, each “← 封面评审”')
  const button = body.querySelector<HTMLButtonElement>('[data-navigation-back="rss"] [aria-label="返回 封面评审"]')!
  assert.match(button.title, /⌘\[|Ctrl\+\[/, 'the shortcut is named with the target')

  await click(button)
  assert.deepEqual(revealed, ['cover'], 'clicking goes back: the event is revealed')
  assert.equal(useMode.getState().workbenchMode, 'calendar')
  assert.deepEqual(backLabels().find(([mode]) => mode === 'calendar'), ['calendar', '新书发布', true], 'now back to the page, and forward is offered')
  assert.equal(body.querySelector('[data-navigation-back="calendar"] [aria-label^="前进到 "]')!.getAttribute('aria-label'), '前进到 一个人的出版社')

  // ⌘[ runs the same history; the entry follows it.
  await act(async () => { await navigateBack() })
  assert.equal(useMode.getState().workbenchMode, 'document')
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/新书发布.md')
  assert.deepEqual(backLabels().find(([mode]) => mode === 'document'), ['document', null, true], 'at the start: only forward')
  await act(async () => { await navigateForward() })
  assert.equal(useMode.getState().workbenchMode, 'calendar')

  // Split view: the entry sits in the pane being used, not in both.
  await change(() => useMode.setState({ workbenchMode: 'document', splitMode: 'calendar' }))
  await render(<Panes focused="calendar" />)
  assert.deepEqual(all('[data-navigation-back]').map(node => node.dataset.navigationBack), ['calendar'])
  await change(() => useMode.setState({ splitMode: null }))
})

test('on 今日 the entry goes back to where the person was, without moving the history', async () => {
  await render(<Panes focused="document" />)
  const before = navigationHistory.getSnapshot()
  assert.equal(before.entries[before.cursor].title, '封面评审')
  await act(async () => { useMode.setState({ workbenchMode: 'document' }); useInkLayout.getState().setHome(true) })
  assert.deepEqual(backLabels().find(([mode]) => mode === 'document'), ['document', '封面评审', true], '今日 sits over the current entry: back names it')
  // The breadcrumb's first element is the entry; 今日 is the crumb after it.
  await render(<><Panes focused="document" /><InkTopbar tab={null} roots={[]} home sourceMode={false} onSourceMode={() => {}} /></>)
  const left = body.querySelector('.ink-topbar-left')!
  assert.equal(left.firstElementChild?.getAttribute('data-navigation-back'), 'document')
  assert.equal(left.querySelector('.ink-crumb-text')?.textContent, '今日')
  revealed.length = 0
  await click(left.querySelector('[aria-label="返回 封面评审"]')!)
  assert.deepEqual(revealed, ['cover'])
  assert.equal(useMode.getState().workbenchMode, 'calendar')
  assert.equal(navigationHistory.getSnapshot().cursor, before.cursor, 'reopening the current entry keeps the cursor')
  assert.equal(navigationHistory.getSnapshot().entries.length, before.entries.length)
})

test('今日 is the first tab of the document strip; a document tab leaves it, the 今日 tab returns', async () => {
  await change(() => {
    useDocTabs.setState({ tabs: [{ id: 'a', title: 'a.md', path: '/vault/a.md', content: 'A', isDirty: false }], activeTabId: 'a' })
    useMode.setState({ workbenchMode: 'document' }); useInkLayout.setState({ home: true })
  })
  await render(<InkTabStrip active onNewTab={() => {}} />)
  const tabs = () => all('[role="tablist"][aria-label="文档标签"] [role="tab"]')
  assert.deepEqual(tabs().map(tab => [tab.textContent, tab.getAttribute('aria-selected')]), [['今日', 'true'], ['a', 'false']])
  assert.equal(tabs()[0].querySelector('[aria-label^="关闭"]'), null, '今日 cannot be closed')
  await click(tabs()[1])
  assert.equal(useInkLayout.getState().home, false)
  assert.deepEqual(tabs().map(tab => tab.getAttribute('aria-selected')), ['false', 'true'])
  await change(() => useMode.setState({ workbenchMode: 'rss' }))
  await click(tabs()[0])
  assert.equal(useInkLayout.getState().home, true)
  assert.equal(useMode.getState().workbenchMode, 'document', 'the 今日 tab, like the brand dot, opens the document mode')
  assert.equal(all('.ink-return-chip').length + all('[aria-label="后退"]').length, 0, 'the old tab-bar return chip and arrows are gone')
})

test('⌘W on 今日 closes nothing: 今日 is the tab in view and the page behind it stays open', async () => {
  const { useKeyboardShortcuts } = await import('../renderer/hooks/useKeyboardShortcuts')
  const { MemoryRouter } = await import('react-router-dom')
  function Keyboard() { useKeyboardShortcuts(); return null }
  await change(() => {
    useDocTabs.setState({ tabs: [{ id: 'a', title: 'a.md', path: '/vault/a.md', content: 'A', isDirty: false }, { id: 'b', title: 'b.md', path: '/vault/b.md', content: 'B', isDirty: false }], activeTabId: 'b' })
    useMode.setState({ workbenchMode: 'document' }); useInkLayout.setState({ home: true })
  })
  await render(<MemoryRouter initialEntries={['/workbench']}><Keyboard /></MemoryRouter>)
  const closeKey = () => act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true })) })
  await closeKey()
  assert.deepEqual(useDocTabs.getState().tabs.map(tab => tab.id), ['a', 'b'])
  await change(() => useInkLayout.setState({ home: false }))
  await closeKey()
  assert.deepEqual(useDocTabs.getState().tabs.map(tab => tab.id), ['a'], 'off 今日, ⌘W closes the page in view as before')
})

test('⌘K with nothing typed: 最近打开 from the shared history, then the common commands', async () => {
  await act(async () => {
    await navigationHistory.open(entry('document', { kind: 'file', id: 'report' }, '季度报告.pdf'), async () => {})
    await navigationHistory.open(entry('browser', { kind: 'web', url: 'https://example.com/essay/browser-agents' }, 'https://example.com/essay/browser-agents'), async () => {})
  })
  await change(() => useMode.setState({ workbenchMode: 'document', splitMode: null }))
  await render(<ObjectUIHost onSettings={() => {}} />)
  await act(async () => { dom.window.dispatchEvent(new dom.window.CustomEvent('ready:open-quick-switcher')); await new Promise(resolve => setTimeout(resolve, 30)) })
  const labels = () => all('.rn-switch-label').map(node => node.textContent)
  const rows = () => all('.rn-switch-item').map(item => [item.querySelector('.rn-switch-name')?.textContent, item.querySelector('.rn-switch-type')?.textContent ?? ''])
  assert.deepEqual(labels(), ['最近打开', '常用命令'])
  const recent = rows().slice(0, 5)
  // The tab clicked in the previous test was an open too, and it dropped the article ahead of it.
  assert.deepEqual(recent.map(([name]) => name), ['example.com/essay/browser-agents', '季度报告', 'a', '封面评审', '新书发布'],
    'newest first across the modes, each object once; a file without its extension; an address-only page readable')
  assert.deepEqual(recent.map(([, type]) => type), ['书签', '页面', '页面', '日程', '页面'])
  assert.equal(all('.rn-switch-item .rn-switch-icon svg').length, rows().length, 'every row has its icon')
  const commands = rows().slice(5).map(([name]) => name)
  for (const name of ['今日', '新建页面', '打开 FastCard', '在资料库中查找与替换', '切换主题', '打开设置']) assert.ok(commands.includes(name), `${name} is a common command`)
  assert.ok(!commands.includes('关系图谱') && !commands.includes('切换到日历'), 'only the common commands before typing')
  const input = body.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '关系'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  assert.deepEqual(labels(), ['命令'])
  assert.ok(rows().some(([name]) => name === '关系图谱'), 'typing searches every command')
})

export const __breaksInvariants = ['renderer stores and DOM restored after the isolated back-entry tests'] as const
