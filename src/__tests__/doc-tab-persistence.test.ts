import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { createDraftFixture } from './helpers/ready-drafts-fixture'
import { captureLegacyDrafts, migrateLegacyDrafts, getDocTabDraftStorageKey } from '../renderer/modules/document/drafts/migration'
import { configureDrafts, drafts, useDraftUI } from '../renderer/modules/document/drafts/runtime'

const values = new Map<string, string>()
const writes: Array<{ op: 'set' | 'remove'; key: string; value?: string }> = []
const windowListeners = new Map<string, Array<() => void>>()
const idleCallbacks = new Map<number, () => void>()
let nextIdleCallbackId = 0

const localStorageMock = {
  get length() { return values.size },
  key: (i: number) => [...values.keys()][i] ?? null,
  clear: () => values.clear(),
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
  requestIdleCallback: (callback: () => void) => {
    const id = ++nextIdleCallbackId
    idleCallbacks.set(id, callback)
    return id
  },
  cancelIdleCallback: (id: number) => idleCallbacks.delete(id),
}
;(globalThis as typeof globalThis & { document: unknown }).document = {
  visibilityState: 'visible',
  addEventListener: () => undefined,
}

const {
  flushPendingDocTabDrafts,
  flushPendingDocTabMetadata,
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

let fixture = createDraftFixture()
async function resetStore(): Promise<void> {
  await flushPendingDocTabDrafts().catch(() => {})
  flushPendingDocTabMetadata()
  values.clear()
  writes.length = 0
  idleCallbacks.clear()
  useDocTabs.setState({
    tabs: [baseTab],
    tabGroups: [],
    activeTabId: baseTab.id,
    splitTabId: null,
    focusedPaneTabId: baseTab.id,
    documentSplitRatio: 50,
    pendingReveal: null,
  })
  fixture = createDraftFixture()
  configureDrafts({ ...fixture.port, tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
  })
  useDraftUI.setState({ boot: 'ready', error: '' })
  flushPendingDocTabMetadata()
  writes.length = 0
}

describe('document tab persistence', () => {
  beforeEach(resetStore)

  it('keeps large drafts out of localStorage and flushes them to Main on page hide', async () => {
    const largeDraft = `large-draft:${'x'.repeat(500_000)}`
    useDocTabs.getState().updateTabContent(baseTab.id, largeDraft)

    assert.equal(writes.some((write) => write.key === METADATA_KEY), false)
    flushPendingDocTabMetadata()
    const metadataWrite = writes.find((write) => write.op === 'set' && write.key === METADATA_KEY)
    assert.ok(metadataWrite?.value)
    assert.equal(metadataWrite.value.includes('large-draft:'), false)
    assert.ok(metadataWrite.value.length < 2_000)
    assert.equal(writes.some((write) => write.op === 'set' && write.key === getDocTabDraftStorageKey(baseTab.id)), false)

    for (const listener of windowListeners.get('pagehide') || []) listener()
    await flushPendingDocTabDrafts()
    assert.equal([...fixture.drafts.values()][0].content, largeDraft)
    assert.equal(values.has(getDocTabDraftStorageKey(baseTab.id)), false)

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

  it('refuses to close an unconfirmed draft when Main fails, then closes after retry', async () => {
    const create = fixture.api.create
    fixture.api.create = async () => ({ ok: false, code: 'failed', message: 'disk full' })
    useDocTabs.getState().updateTabContent(baseTab.id, 'must remain visible')
    useDocTabs.getState().closeTab(baseTab.id)
    await assert.rejects(flushPendingDocTabDrafts(), /disk full/)
    assert.equal(useDocTabs.getState().tabs[0].content, 'must remain visible')
    fixture.api.create = create
    await flushPendingDocTabDrafts()
    useDocTabs.getState().closeTab(baseTab.id)
    assert.ok(!useDocTabs.getState().tabs.some(tab => tab.id === baseTab.id))
    assert.equal([...fixture.drafts.values()][0].content, 'must remain visible')
  })

  it('coalesces rapid metadata-only transitions into one storage write', () => {
    useDocTabs.getState().renameTab(baseTab.id, 'one.md')
    useDocTabs.getState().renameTab(baseTab.id, 'two.md')
    useDocTabs.getState().setDocumentSplitRatio(61)
    assert.equal(writes.filter((write) => write.key === METADATA_KEY).length, 0)

    flushPendingDocTabMetadata()
    const metadataWrites = writes.filter((write) => write.op === 'set' && write.key === METADATA_KEY)
    assert.equal(metadataWrites.length, 1)
    const persisted = JSON.parse(metadataWrites[0].value || '{}') as {
      state?: { tabs?: Array<{ title: string }>; documentSplitRatio?: number }
    }
    assert.equal(persisted.state?.tabs?.[0]?.title, 'two.md')
    assert.equal(persisted.state?.documentSplitRatio, 61)
  })

  it('waits for a quiet typing window before requesting an idle metadata write', async () => {
    useDocTabs.getState().renameTab(baseTab.id, 'one.md')
    await new Promise((resolve) => setTimeout(resolve, 80))
    useDocTabs.getState().renameTab(baseTab.id, 'two.md')
    await new Promise((resolve) => setTimeout(resolve, 80))

    assert.equal(idleCallbacks.size, 0)
    assert.equal(writes.filter((write) => write.key === METADATA_KEY).length, 0)

    await new Promise((resolve) => setTimeout(resolve, 130))
    assert.equal(idleCallbacks.size, 1)
    const [idleId, idleCallback] = idleCallbacks.entries().next().value as [number, () => void]
    idleCallbacks.delete(idleId)
    idleCallback()

    const metadataWrites = writes.filter((write) => write.op === 'set' && write.key === METADATA_KEY)
    assert.equal(metadataWrites.length, 1)
    const persisted = JSON.parse(metadataWrites[0].value || '{}') as {
      state?: { tabs?: Array<{ title: string }> }
    }
    assert.equal(persisted.state?.tabs?.[0]?.title, 'two.md')
  })

  it('flushes metadata within the maximum window during continuous updates', async () => {
    let index = 0
    const updates = setInterval(() => {
      index += 1
      useDocTabs.getState().renameTab(baseTab.id, `continuous-${index}.md`)
    }, 40)

    await new Promise((resolve) => setTimeout(resolve, 650))
    clearInterval(updates)

    assert.equal(writes.filter((write) => write.op === 'set' && write.key === METADATA_KEY).length, 1)
    flushPendingDocTabMetadata()
    const metadataWrites = writes.filter((write) => write.op === 'set' && write.key === METADATA_KEY)
    assert.equal(metadataWrites.length, 2)
    const latest = metadataWrites.at(-1)
    const persisted = JSON.parse(latest?.value || '{}') as { state?: { tabs?: Array<{ title: string }> } }
    assert.equal(persisted.state?.tabs?.[0]?.title, `continuous-${index}.md`)
  })

  it('persists only changed content and never metadata-only updates', async () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-a')
    await flushPendingDocTabDrafts()
    useDocTabs.getState().renameTab(baseTab.id, 'renamed.md')
    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-a')
    await flushPendingDocTabDrafts()
    assert.equal(fixture.saved.length, 0)
    useDocTabs.getState().updateTabContent(baseTab.id, 'draft-b')
    await flushPendingDocTabDrafts()
    assert.deepEqual(fixture.saved, ['draft-b'])
    assert.equal(values.has(getDocTabDraftStorageKey(baseTab.id)), false)
  })

  it('hydrates a clean disk buffer atomically and refuses to overwrite dirty content', async () => {
    const snapshots: Array<{ content: string; isDirty: boolean }> = []
    const unsubscribe = useDocTabs.subscribe(state => {
      const tab = state.tabs.find(item => item.id === baseTab.id)!
      snapshots.push({ content: tab.content, isDirty: tab.isDirty })
    })
    useDocTabs.getState().hydrateTabContentFromDisk(baseTab.id, 'from-disk')
    unsubscribe()
    assert.deepEqual(snapshots, [{ content: 'from-disk', isDirty: false }])
    assert.equal(fixture.drafts.size, 0)
    useDocTabs.getState().updateTabContent(baseTab.id, 'unsaved')
    useDocTabs.getState().hydrateTabContentFromDisk(baseTab.id, 'external')
    assert.equal(useDocTabs.getState().tabs[0].content, 'unsaved')
    await flushPendingDocTabDrafts()
  })

  it('commits only the written snapshot and preserves newer typing durably', async () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'older-snapshot')
    await flushPendingDocTabDrafts()
    useDocTabs.getState().updateTabContent(baseTab.id, 'newer-typing')
    assert.equal(useDocTabs.getState().commitTabSaveSnapshot(baseTab.id, 'older-snapshot', 'older-snapshot'), false)
    await flushPendingDocTabDrafts()
    assert.equal(useDocTabs.getState().tabs[0].content, 'newer-typing')
    assert.equal(useDocTabs.getState().tabs[0].isDirty, true)
    assert.ok([...fixture.drafts.values()].some(draft => draft.content === 'newer-typing' && draft.state === 'editing'))
  })

  it('closing retains the durable draft; restart restores the matching tab', async () => {
    useDocTabs.getState().updateTabContent(baseTab.id, 'recover-me')
    await flushPendingDocTabDrafts()
    flushPendingDocTabMetadata()
    const stored = JSON.parse(values.get(METADATA_KEY)!)
    delete stored.state.tabs[0].draftId
    const metadata = JSON.stringify(stored)
    useDocTabs.getState().closeTab(baseTab.id)
    assert.equal(fixture.discarded.length, 0)
    values.set(METADATA_KEY, metadata)
    await useDocTabs.persist.rehydrate()
    await drafts.restore()
    assert.equal(useDocTabs.getState().tabs[0].content, 'recover-me')
    assert.equal(useDocTabs.getState().tabs[0].isDirty, true)
    assert.equal(fixture.drafts.size, 1, 'rehydration must not create a second draft')
  })

  it('migrates embedded and separate legacy bodies before restoring, including empty content', async () => {
    values.set(METADATA_KEY, JSON.stringify({ version: 3, state: { tabs: [
      { ...baseTab, content: 'embedded', isDirty: true },
      { ...baseTab, id: 'empty', path: null, content: 'older', isDirty: true },
    ], activeTabId: baseTab.id } }))
    values.set(getDocTabDraftStorageKey('empty'), '')
    captureLegacyDrafts(localStorageMock)
    await useDocTabs.persist.rehydrate()
    await migrateLegacyDrafts(localStorageMock, fixture.api)
    await drafts.restore()
    assert.equal(useDocTabs.getState().tabs[0].content, 'embedded')
    assert.equal(useDocTabs.getState().tabs[1].content, '')
    assert.equal(useDocTabs.getState().tabs[1].isDirty, true)
    assert.equal(values.has(getDocTabDraftStorageKey('empty')), false)
    await migrateLegacyDrafts(localStorageMock, fixture.api)
    assert.equal(fixture.drafts.size, 2)
  })
})
