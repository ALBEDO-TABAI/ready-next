import { getDocTabDraftStorageKey } from '../renderer/modules/document/drafts/migration'
import { useDraftUI } from '../renderer/modules/document/drafts/runtime'
import assert from 'node:assert/strict'
import test from 'node:test'

test('library stays a singleton across restore, refuses content and paths, and never writes a draft', async () => {
  const data = new Map<string, string>()
  const writes: string[] = []
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  } })
  const { useDocTabs, flushPendingDocTabDrafts, flushPendingDocTabMetadata } = await import('../renderer/stores/useDocTabs')
  useDraftUI.setState({ boot: 'ready' })
  try {
    const a = useDocTabs.getState().openLibraryTab()
    useDocTabs.getState().openTab('/test/note.md')
    const b = useDocTabs.getState().openLibraryTab()
    assert.equal(a, b)
    assert.equal(useDocTabs.getState().tabs.filter(t => t.kind === 'library').length, 1)
    useDocTabs.getState().setTabPath(a, '/should-not-save.md')
    useDocTabs.getState().setTabContent(a, 'should not become a draft')
    useDocTabs.getState().appendTabContent(a, 'nor append')
    useDocTabs.getState().hydrateTabContentFromDisk(a, 'nor hydrate')
    assert.equal(useDocTabs.getState().commitTabSaveSnapshot(a, '', 'nor save'), false)
    const tab = useDocTabs.getState().tabs.find(t => t.id === a)!
    assert.equal(tab.path, null)
    assert.equal(tab.content, '')
    assert.equal(tab.isDirty, false)
    const { runRegisteredDocumentSave } = await import('../renderer/modules/document/documentSaveRegistry')
    assert.equal(await runRegisteredDocumentSave(a), true, 'Save is consumed even without a mounted UI')
    flushPendingDocTabDrafts(); flushPendingDocTabMetadata()
    assert.equal(data.has(getDocTabDraftStorageKey(a)), false)
    assert.equal(writes.includes(getDocTabDraftStorageKey(a)), false)
    assert.ok(data.has('ready-doc-tabs-v2'))
    await useDocTabs.persist.rehydrate()
    assert.equal(useDocTabs.getState().openLibraryTab(), a)
    assert.equal(useDocTabs.getState().tabs.filter(t => t.kind === 'library').length, 1)
    useDocTabs.getState().closeTab(a)
    assert.equal(await runRegisteredDocumentSave(a), false, 'closing releases the system save owner')
  } finally {
    flushPendingDocTabDrafts(); flushPendingDocTabMetadata()
    if (before) Object.defineProperty(globalThis, 'localStorage', before)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
