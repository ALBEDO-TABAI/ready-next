import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { memoryNavigationAPI } from './utils/navigation-memory'

test('real open and return chain crosses four modes, restores scroll, prioritizes tab history and ignores input', async () => {
  const dom = new JSDOM('<div data-workbench-mode-panel="document"><div id="scroll"></div></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'nav', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const navigation = memoryNavigationAPI()
  Object.assign(dom.window, { electronAPI: { navigationHistory: navigation,
    objects: { onMoved: () => () => {}, locate: async (id: string) => ({ objectId: id, path: `/vault/${id}.md`, revision: 1 }), resolvePath: async (path: string) => ({ objectId: path.split('/').pop()!.replace('.md', ''), path, revision: 1 }) },
    rss: { readArticle: async () => ({ success: true, data: { article: { title: '新书发布', revision: 'r1' } } }) },
    calendar: { snapshot: async () => ({ success: true, data: { events: [{ id: 'meeting', title: '会议' }] } }), revealEvent: async () => ({ success: true }) },
    browser: { createTab: async () => ({ success: true, tabId: 'browser' }) },
    library: { get: async () => ({ success: true, data: { status: 'ready', books: [] } }) },
  } })
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { navigationHistory, navigateBack, navigateForward, navigationStatus } = await import('../renderer/modules/workbench/navigation-history')
  const { useMode } = await import('../renderer/stores/useMode')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const before = useDocTabs.getState(), beforeMode = useMode.getState()
  dom.window.addEventListener('ready:workbench-mode-change-request', e => useMode.setState({ workbenchMode: (e as CustomEvent).detail.mode }))
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({ tabs: [{ id: 'origin', objectId: 'origin', objectBinding: { status: 'resolved' }, path: '/vault/origin.md', title: '原页', content: '', isDirty: false }], activeTabId: 'origin', splitTabId: null })
  try {
    await openReadyRef({ kind: 'page', id: 'origin' })
    const scroll = dom.window.document.getElementById('scroll')!; scroll.scrollTop = 234
    await openReadyRef({ kind: 'rss-item', id: 'article' })
    await openReadyRef({ kind: 'event', id: 'meeting' })
    await openReadyRef({ kind: 'web', url: 'https://example.test' })
    const length = navigationHistory.getSnapshot().entries.length
    dom.window.dispatchEvent(new dom.window.Event('scroll')); dom.window.dispatchEvent(new dom.window.Event('input'))
    assert.equal(navigationHistory.getSnapshot().entries.length, length)
    await navigateBack(); assert.equal(useMode.getState().workbenchMode, 'calendar')
    assert.equal(navigationStatus().backTitle, '新书发布')
    await navigateBack(); assert.equal(useMode.getState().workbenchMode, 'rss')
    scroll.scrollTop = 0
    await navigateBack(); assert.equal(useMode.getState().workbenchMode, 'document'); assert.equal(scroll.scrollTop, 234)
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/origin.md')
    const { openInCurrentTab } = await import('../renderer/modules/document/ink/layout-state')
    openInCurrentTab('/vault/second.md')
    await new Promise(resolve => setTimeout(resolve, 0)); await navigationHistory.load()
    assert.equal(navigationStatus().backTitle, 'origin')
    await navigateBack()
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/origin.md')
    await navigateForward()
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/second.md')
    await openReadyRef({ kind: 'page', id: 'third' })
    await Promise.all([navigateBack(), navigateBack()])
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/origin.md', 'rapid keys choose their local target after the previous key completes')
    await Promise.all([navigateForward(), navigateForward()])
    assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path, '/vault/third.md')
    const state = navigationHistory.getSnapshot()
    await assert.rejects(openReadyRef('ready://read/book/missing#c0:0+1'), /书籍不存在/)
    assert.deepEqual(navigationHistory.getSnapshot(), state)
    useMode.setState({ workbenchMode: 'browser' }); assert.equal(navigationStatus().canBack, true, 'manual mode switch does not erase history')
  } finally {
    useDocTabs.setState(before, true); useMode.setState(beforeMode, true)
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})
export const __breaksInvariants = ['renderer.navigation-stores-restored-after-isolated-reference-test'] as const
