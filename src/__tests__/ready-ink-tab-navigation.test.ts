import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('document navigation replaces the current tab in place, keeps unsaved work and walks per-tab history', async () => {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { openInCurrentTab, goBack, goForward, useInkHistory, useInkLayout } = await import('../renderer/modules/document/ink/layout-state')
  const before = useDocTabs.getState()
  const paths = () => useDocTabs.getState().tabs.map(tab => tab.path)
  const activePath = () => useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path
  useDocTabs.setState({
    tabs: [
      { id: 'left', title: 'left.md', path: '/vault/left.md', content: '左', isDirty: false },
      { id: 'a', title: 'a.md', path: '/vault/a.md', content: 'A', isDirty: false },
      { id: 'right', title: 'right.md', path: '/vault/right.md', content: '右', isDirty: false },
    ],
    activeTabId: 'a',
    splitTabId: null,
  })
  try {
    openInCurrentTab('/vault/b.md')
    assert.deepEqual(paths(), ['/vault/left.md', '/vault/b.md', '/vault/right.md'], 'the page replaces the tab in its own slot')
    assert.deepEqual(useInkHistory.getState(), { canBack: true, canForward: false })

    openInCurrentTab('/vault/c.md')
    goBack()
    assert.equal(activePath(), '/vault/b.md')
    assert.deepEqual(useInkHistory.getState(), { canBack: true, canForward: true })
    goBack()
    assert.equal(activePath(), '/vault/a.md')
    assert.deepEqual(paths(), ['/vault/left.md', '/vault/a.md', '/vault/right.md'], 'history walks the same tab')
    goForward(); goForward()
    assert.equal(activePath(), '/vault/c.md')
    assert.deepEqual(useInkHistory.getState(), { canBack: true, canForward: false })

    // Another tab has its own history.
    useDocTabs.getState().setActiveTab('left')
    assert.deepEqual(useInkHistory.getState(), { canBack: false, canForward: false })

    // An open page is activated rather than duplicated; ⌘-click opens a new tab.
    openInCurrentTab('/vault/right.md')
    assert.equal(activePath(), '/vault/right.md')
    assert.equal(paths().length, 3)
    openInCurrentTab('/vault/d.md', { newTab: true })
    assert.deepEqual(paths(), ['/vault/left.md', '/vault/c.md', '/vault/right.md', '/vault/d.md'])

    // Unsaved work is never replaced.
    const dirtyId = useDocTabs.getState().activeTabId!
    useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === dirtyId ? { ...tab, isDirty: true } : tab) }))
    openInCurrentTab('/vault/e.md')
    assert.ok(useDocTabs.getState().tabs.some(tab => tab.id === dirtyId && tab.path === '/vault/d.md'), 'the unsaved tab stays open')
    assert.equal(activePath(), '/vault/e.md')

    // An empty new tab is taken over by the first page opened in it.
    useDocTabs.getState().openTab('')
    const count = paths().length
    openInCurrentTab('/vault/f.md')
    assert.equal(paths().length, count, 'the blank tab became the page')
    assert.equal(activePath(), '/vault/f.md')

    // 今日 is a tab of its own (W6 §5.1): a page opened from it takes a tab and leaves the page behind 今日 alone…
    useInkLayout.getState().setHome(true)
    openInCurrentTab('/vault/g.md')
    assert.equal(useInkLayout.getState().home, false, 'opening a page leaves 今日')
    assert.deepEqual(paths().slice(-2), ['/vault/f.md', '/vault/g.md'])
    assert.equal(activePath(), '/vault/g.md')
    // …except a blank tab, which the first page takes over as before.
    useDocTabs.getState().openTab('')
    useInkLayout.getState().setHome(true)
    const total = paths().length
    openInCurrentTab('/vault/h.md')
    assert.equal(paths().length, total, 'the blank tab became the page')
    assert.equal(activePath(), '/vault/h.md')
  } finally {
    useDocTabs.setState(before, true)
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
