import assert from 'node:assert/strict'
import test from 'node:test'
import { createDraftFixture } from './helpers/ready-drafts-fixture'

// FX2 contract: metadata is restored synchronously; asynchronous body migration
// must preserve a library opened before Main replies and restore bodies by tabId.
test('opening the library during startup survives legacy migration', async () => {
  const f = createDraftFixture()
  f.storage.setItem('ready-doc-tabs-v2', JSON.stringify({ version: 3, state: {
    tabs: [{ id: 'doc-8', path: null, title: 'Old draft', content: 'original body', isDirty: true },
      { id: 'doc-9', path: '/vault/other.md', title: 'Other', content: '', isDirty: false }],
    activeTabId: 'doc-8',
  } }))
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: f.storage })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, electronAPI: { documentDrafts: f.api },
  } })
  const { useDocTabs, flushPendingDocTabMetadata } = await import('../renderer/stores/useDocTabs')
  const { initializeDrafts, useDraftUI } = await import('../renderer/modules/document/drafts/runtime')
  assert.equal(useDocTabs.persist.hasHydrated(), true)
  assert.equal(useDocTabs.getState().activeTabId, 'doc-8')
  const gate = f.holdCreate()
  const boot = initializeDrafts()
  await gate.started
  const library = useDocTabs.getState().openLibraryTab()
  const duringMigration = useDocTabs.getState()
  flushPendingDocTabMetadata()
  assert.equal(JSON.parse(f.storage.getItem('ready-doc-tabs-v2')!).state.activeTabId, library)
  gate.release()
  await boot
  assert.deepEqual(duringMigration.tabs.map(tab => tab.id), ['doc-8', 'doc-9', library])
  const after = useDocTabs.getState()
  assert.deepEqual(after.tabs.map(tab => tab.id), ['doc-8', 'doc-9', library])
  assert.equal(after.activeTabId, library)
  assert.equal(after.tabs.find(tab => tab.id === 'doc-8')?.content, 'original body')
  assert.equal(useDraftUI.getState().boot, 'ready')
  assert.equal(f.drafts.size, 1)
})
