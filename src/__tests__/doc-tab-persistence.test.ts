import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

const values = new Map<string, string>()
const writes: Array<{ op: 'set' | 'remove'; key: string; value?: string }> = []
const windowListeners = new Map<string, Array<() => void>>()

const localStorageMock = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value)
    writes.push({ op: 'set', key, value })
  },
  removeItem: (key: string) => {
    values.delete(key)
    writes.push({ op: 'remove', key })
  },
}

;(globalThis as typeof globalThis & { localStorage: typeof localStorageMock }).localStorage = localStorageMock
;(globalThis as typeof globalThis & { window: unknown }).window = {
  addEventListener: (event: string, listener: () => void) => {
    windowListeners.set(event, [...(windowListeners.get(event) || []), listener])
  },
}
;(globalThis as typeof globalThis & { document: unknown }).document = {
  visibilityState: 'visible',
  addEventListener: () => undefined,
}

const {
  flushPendingDocTabDrafts,
  getDocTabDraftStorageKey,
  useDocTabs,
} = await import('../renderer/stores/useDocTabs')

const METADATA_KEY = 'ready-doc-tabs-v2'
const baseTab = {
  id: 'doc-persist',
  path: '/tmp/persist.md',
  title: 'persist.md',
  content: '',
  isDirty: false,
}

function resetStore(): void {
  flushPendingDocTabDrafts()
  values.clear()
  writes.length = 0
  useDocTabs.setState({
    tabs: [baseTab],
    tabGroups: [],
    activeTabId: baseTab.id,
    splitTabId: null,
    documentSplitRatio: 50,
    pendingReveal: null,
  })
  writes.length = 0
}

describe('document tab persistence', () => {
  beforeEach(resetStore)

  it('keeps large drafts out of synchronous metadata writes and flushes them on page hide', () => {
    const largeDraft = `large-draft:${'x'.repeat(500_000)}`
    useDocTabs.getState().updateTabContent(baseTab.id, largeDraft)

    const metadataWrite = writes.find((write) => write.op === 'set' && write.key === METADATA_KEY)
    assert.ok(metadataWrite?.value)
    assert.equal(metadataWrite.value.includes('large-draft:'), false)
    assert.ok(metadataWrite.value.length < 2_000)
    assert.equal(writes.some((write) => write.op === 'set' && write.key === getDocTabDraftStorageKey(baseTab.id)), false)

    for (const listener of windowListeners.get('pagehide') || []) listener()
    assert.equal(values.get(getDocTabDraftStorageKey(baseTab.id)), largeDraft)

    writes.length = 0
    useDocTabs.getState().openTab('/tmp/another.md')
    useDocTabs.getState().setActiveTab(baseTab.id)
    flushPendingDocTabDrafts()

    assert.equal(writes.some((write) => write.op === 'set' && write.key.startsWith('ready-doc-tab-draft-v1:')), false)
    assert.equal(
      writes
        .filter((write) => write.op === 'set' && write.key === METADATA_KEY)
        .some((write) => write.value?.includes('large-draft:')),
      false,
    )
  })

  it('updates draft storage only when document content changes', () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-a')
    flushPendingDocTabDrafts()
    writes.length = 0

    useDocTabs.getState().renameTab(baseTab.id, 'renamed.md')
    useDocTabs.getState().setActiveTab(baseTab.id)
    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-a')
    flushPendingDocTabDrafts()
    assert.equal(writes.some((write) => write.op === 'set' && write.key === getDocTabDraftStorageKey(baseTab.id)), false)

    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-b')
    flushPendingDocTabDrafts()
    assert.equal(
      writes.filter((write) => write.op === 'set' && write.key === getDocTabDraftStorageKey(baseTab.id)).length,
      1,
    )
    assert.equal(values.get(getDocTabDraftStorageKey(baseTab.id)), 'draft-b')
  })

  it('hydrates disk content as one clean state transition without creating a draft', () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'unsaved')
    flushPendingDocTabDrafts()
    writes.length = 0

    const snapshots: Array<{ content: string; isDirty: boolean }> = []
    const unsubscribe = useDocTabs.subscribe((state) => {
      const tab = state.tabs.find((item) => item.id === baseTab.id)
      if (tab) snapshots.push({ content: tab.content, isDirty: tab.isDirty })
    })
    useDocTabs.getState().hydrateTabContentFromDisk(baseTab.id, 'from-disk')
    unsubscribe()

    assert.deepEqual(snapshots, [{ content: 'from-disk', isDirty: false }])
    assert.equal(values.has(getDocTabDraftStorageKey(baseTab.id)), false)
    assert.equal(writes.some((write) => write.op === 'set' && write.key === getDocTabDraftStorageKey(baseTab.id)), false)
    assert.equal(values.get(METADATA_KEY)?.includes('from-disk'), false)
  })

  it('commits only the exact snapshot written to disk and preserves newer typing as a draft', () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'save-snapshot')
    const committed = useDocTabs.getState().commitTabSaveSnapshot(
      baseTab.id,
      'save-snapshot',
      'save-snapshot-with-widget-state',
    )
    assert.equal(committed, true)
    assert.deepEqual(
      useDocTabs.getState().tabs.find((tab) => tab.id === baseTab.id),
      { ...baseTab, content: 'save-snapshot-with-widget-state', isDirty: false },
    )

    useDocTabs.getState().updateTabContent(baseTab.id, 'older-snapshot')
    useDocTabs.getState().updateTabContent(baseTab.id, 'newer-typing')
    const staleCommit = useDocTabs.getState().commitTabSaveSnapshot(
      baseTab.id,
      'older-snapshot',
      'older-snapshot',
    )
    assert.equal(staleCommit, false)
    assert.deepEqual(
      useDocTabs.getState().tabs.find((tab) => tab.id === baseTab.id),
      { ...baseTab, content: 'newer-typing', isDirty: true },
    )
    flushPendingDocTabDrafts()
    assert.equal(values.get(getDocTabDraftStorageKey(baseTab.id)), 'newer-typing')
  })

  it('restores a dirty draft from split metadata and draft records', async () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'recover-me')
    flushPendingDocTabDrafts()
    const metadata = values.get(METADATA_KEY)
    const draft = values.get(getDocTabDraftStorageKey(baseTab.id))
    assert.ok(metadata)
    assert.equal(draft, 'recover-me')

    useDocTabs.setState({
      tabs: [{ ...baseTab, id: 'temporary' }],
      activeTabId: 'temporary',
      splitTabId: null,
    })
    values.set(METADATA_KEY, metadata)
    values.set(getDocTabDraftStorageKey(baseTab.id), draft)

    await useDocTabs.persist.rehydrate()
    const restored = useDocTabs.getState().tabs.find((tab) => tab.id === baseTab.id)
    assert.equal(restored?.content, 'recover-me')
    assert.equal(restored?.isDirty, true)
  })

  it('migrates legacy embedded drafts without losing their content', async () => {
    const legacyDraft = `legacy:${'y'.repeat(200_000)}`
    const legacyUntitled = '# Untitled but recoverable'
    values.clear()
    values.set(METADATA_KEY, JSON.stringify({
      version: 3,
      state: {
        tabs: [
          { ...baseTab, content: legacyDraft, isDirty: true },
          { ...baseTab, id: 'doc-untitled', path: null, title: '新文档', content: legacyUntitled, isDirty: false },
        ],
        tabGroups: [],
        activeTabId: baseTab.id,
        splitTabId: null,
        documentSplitRatio: 50,
      },
    }))

    await useDocTabs.persist.rehydrate()
    const restored = useDocTabs.getState().tabs.find((tab) => tab.id === baseTab.id)
    const restoredUntitled = useDocTabs.getState().tabs.find((tab) => tab.id === 'doc-untitled')
    assert.equal(restored?.content, legacyDraft)
    assert.equal(restored?.isDirty, true)
    assert.equal(restoredUntitled?.content, legacyUntitled)
    assert.equal(values.get(getDocTabDraftStorageKey(baseTab.id)), legacyDraft)
    assert.equal(values.get(getDocTabDraftStorageKey('doc-untitled')), legacyUntitled)
  })
})
