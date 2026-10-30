import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('shared book open validates before switching; return restores tab and position; manual switching clears it', async () => {
  const dom = new JSDOM('<div data-workbench-mode-panel="document"><div id="scroll"></div></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { useReferenceReturn, returnFromReference, registerReturnPosition, clearReferenceReturn } = await import('../renderer/modules/workbench/reference-return')
  const { useLibraryRequest } = await import('../renderer/modules/library/reader/navigation-state')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { shouldHandleSelectedDocument } = await import('../renderer/modules/document/documentSelectionOpen')
  const oldWorkspace = useWorkspace.getState()
  const { useMode } = await import('../renderer/stores/useMode')
  const oldRequest = useLibraryRequest.getState()
  const oldTabs = useDocTabs.getState(), oldMode = useMode.getState()
  const scroll = dom.window.document.getElementById('scroll')!
  scroll.scrollTop = 234
  let top = 150
  const stop = registerReturnPosition('document', () => { const captured = top; return () => { top = captured } })
  Object.defineProperty(dom.window, 'electronAPI', { value: { library: { get: async () => ({ success: true, data: { status: 'ready', books: [{ id: 'book', format: 'txt' }] } }) } } })
  dom.window.addEventListener('ready:workbench-mode-change-request', (e) => useMode.getState().setWorkbenchMode((e as CustomEvent).detail.mode))
  useWorkspace.getState().selectFile('/vault/old.md')
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({ tabs: [{ id: 'origin', title: '原文档', path: null, content: '正文', isDirty: false }], activeTabId: 'origin', splitTabId: null })
  try {
    await assert.rejects(openReadyRef('ready://read/book/missing#c0:0+1'), /书籍不存在/)
    assert.equal(useDocTabs.getState().activeTabId, 'origin')
    await openReadyRef('ready://read/book/book#c1:12+3')
    assert.equal(useDocTabs.getState().tabs.find(t => t.id === useDocTabs.getState().activeTabId)?.kind, 'library')
    assert.equal(shouldHandleSelectedDocument({ isActive: true, selectedFile: useWorkspace.getState().selectedFile, tabs: useDocTabs.getState().tabs, activeTabId: useDocTabs.getState().activeTabId }), false, 'old sidebar selection must not reopen over the library')
    assert.deepEqual(useLibraryRequest.getState().target, { book: 'book', location: { chapter: 1, from: 12, to: 15 } })
    top = 0; scroll.scrollTop = 0
    returnFromReference()
    assert.equal(useDocTabs.getState().activeTabId, 'origin')
    assert.equal(top, 150)
    assert.equal(scroll.scrollTop, 234)
    assert.equal(useReferenceReturn.getState().entry, null)
    useMode.getState().setWorkbenchMode('rss')
    await openReadyRef('ready://read/book/book#c0:1+2')
    assert.equal(useMode.getState().workbenchMode, 'document')
    assert.equal(useReferenceReturn.getState().entry?.mode, 'rss')
    returnFromReference()
    assert.equal(useMode.getState().workbenchMode, 'rss')
    await openReadyRef('ready://read/book/book#c0:1+2')
    assert.ok(useReferenceReturn.getState().entry)
    // Only the most recent jump is kept, not the earlier RSS origin.
    await openReadyRef('ready://read/book/book#c1:2+2')
    assert.equal(useReferenceReturn.getState().entry?.mode, 'document')
    useMode.getState().setWorkbenchMode('calendar')
    assert.equal(useReferenceReturn.getState().entry, null)
  } finally {
    clearReferenceReturn(); stop(); useLibraryRequest.setState(oldRequest, true); useWorkspace.setState(oldWorkspace, true); useDocTabs.setState(oldTabs, true); useMode.setState(oldMode, true)
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})

export const __breaksInvariants = ['renderer.navigation-stores-restored-after-isolated-reference-test'] as const
