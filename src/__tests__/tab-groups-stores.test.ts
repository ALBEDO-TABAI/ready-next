import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createJSONStorage } from 'zustand/middleware'

import {
  type BrowserTab,
  mergeBackendTabsPreservingGroups,
  useBrowserTabs,
} from '../renderer/stores/useBrowserTabs'
import { useDocTabs } from '../renderer/stores/useDocTabs'

function btab(id: string, groupId?: string | null): BrowserTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id.toUpperCase(),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

function seedBrowser(ids: string[]): void {
  const store = useBrowserTabs.getState()
  store.setTabs(ids.map((id) => btab(id)))
  store.setActiveTabId(ids[0] ?? null)
}

function groupIdOf(id: string): string | null {
  return useBrowserTabs.getState().tabs.find((t) => t.id === id)?.groupId ?? null
}

describe('mergeBackendTabsPreservingGroups (P0: the reconcile that must not wipe groups)', () => {
  it('preserves local groupId by id while taking backend metadata', () => {
    const local = [btab('a', 'g1'), btab('b', 'g1'), btab('c', null)]
    const backend = [
      { ...btab('a'), title: 'A-NEW' },
      { ...btab('b'), title: 'B-NEW' },
      { ...btab('c'), title: 'C-NEW' },
    ]
    const merged = mergeBackendTabsPreservingGroups(local, backend)
    assert.equal(merged.find((t) => t.id === 'a')?.groupId, 'g1', 'local groupId preserved')
    assert.equal(merged.find((t) => t.id === 'a')?.title, 'A-NEW', 'backend metadata wins')
    assert.equal(merged.find((t) => t.id === 'c')?.groupId ?? null, null)
  })

  it('appends backend-new tabs ungrouped and drops backend-removed tabs', () => {
    const local = [btab('a', 'g1'), btab('b', 'g1')]
    const backend = [btab('a'), btab('z')] // b removed on backend, z is new
    const merged = mergeBackendTabsPreservingGroups(local, backend)
    assert.deepEqual(merged.map((t) => t.id), ['a', 'z'])
    assert.equal(merged.find((t) => t.id === 'z')?.groupId ?? null, null)
  })
})

describe('useBrowserTabs group methods', () => {
  afterEach(() => seedBrowser(['a', 'b', 'c']))

  it('createTabGroupFromDrop groups the two tabs and adds a group', () => {
    seedBrowser(['a', 'b', 'c'])
    useBrowserTabs.getState().createTabGroupFromDrop('c', 'b')
    const s = useBrowserTabs.getState()
    assert.equal(s.tabGroups.length, 1)
    const gid = s.tabGroups[0].id
    assert.equal(groupIdOf('b'), gid)
    assert.equal(groupIdOf('c'), gid)
    // b and c are contiguous in flat order
    const idx = s.tabs.map((t) => t.id)
    assert.equal(Math.abs(idx.indexOf('b') - idx.indexOf('c')), 1)
  })

  it('addTabToGroup / removeTabFromGroup move membership', () => {
    seedBrowser(['a', 'b', 'c'])
    useBrowserTabs.getState().createTabGroupFromDrop('b', 'a') // group {a,b}
    const gid = useBrowserTabs.getState().tabGroups[0].id
    useBrowserTabs.getState().addTabToGroup('c', gid)
    assert.equal(groupIdOf('c'), gid)
    useBrowserTabs.getState().removeTabFromGroup('c')
    assert.equal(groupIdOf('c'), null)
  })

  it('closing a group member drops the group only when it becomes empty', () => {
    seedBrowser(['a', 'b', 'c'])
    useBrowserTabs.getState().createTabGroupFromDrop('b', 'a') // group {a,b}
    useBrowserTabs.getState().removeTab('a')
    assert.equal(useBrowserTabs.getState().tabGroups.length, 1, 'b still holds the group')
    useBrowserTabs.getState().removeTab('b')
    assert.equal(useBrowserTabs.getState().tabGroups.length, 0, 'empty group is dropped')
  })

  it('a backend reconcile through the merge helper preserves the group (the P0 scenario)', () => {
    seedBrowser(['a', 'b', 'c'])
    useBrowserTabs.getState().createTabGroupFromDrop('b', 'a') // group {a,b}
    const before = useBrowserTabs.getState()
    const gid = before.tabGroups[0].id
    // Simulate restoreExistingTabs / syncTabsFromBackend: backend tabs carry NO groupId.
    const backend = before.tabs.map((t) => ({ ...btab(t.id), title: `${t.title}!` }))
    useBrowserTabs.getState().setTabs(mergeBackendTabsPreservingGroups(before.tabs, backend))
    const after = useBrowserTabs.getState()
    assert.equal(after.tabGroups.length, 1, 'group survives the reconcile')
    assert.equal(after.tabs.find((t) => t.id === 'a')?.groupId, gid)
    assert.equal(after.tabs.find((t) => t.id === 'b')?.groupId, gid)
  })

  it('tolerates a groups-less snapshot (additive v1 load)', () => {
    useBrowserTabs.getState().setTabs([btab('a'), btab('b')]) // no groupId, no groups
    assert.deepEqual(useBrowserTabs.getState().tabGroups, [])
  })

  it('disbandTabGroup keeps the tabs and drops the group', () => {
    seedBrowser(['a', 'b', 'c'])
    useBrowserTabs.getState().createTabGroupFromDrop('b', 'a')
    const gid = useBrowserTabs.getState().tabGroups[0].id
    useBrowserTabs.getState().disbandTabGroup(gid)
    const s = useBrowserTabs.getState()
    assert.equal(s.tabGroups.length, 0)
    assert.equal(groupIdOf('a'), null)
    assert.equal(groupIdOf('b'), null)
    assert.equal(s.tabs.length, 3)
  })
})

function seedDoc(ids: string[]): void {
  useDocTabs.setState({
    tabs: ids.map((id) => ({ id, path: null, title: id, content: '', isDirty: false })),
    tabGroups: [],
    activeTabId: ids[0],
    splitTabId: null,
  })
}

describe('useDocTabs group methods + normalize choke', () => {
  it('createTabGroupFromDrop forms a group', () => {
    seedDoc(['a', 'b', 'c'])
    useDocTabs.getState().createTabGroupFromDrop('c', 'b')
    const s = useDocTabs.getState()
    assert.equal(s.tabGroups.length, 1)
    const gid = s.tabGroups[0].id
    assert.equal(s.tabs.find((t) => t.id === 'b')?.groupId, gid)
    assert.equal(s.tabs.find((t) => t.id === 'c')?.groupId, gid)
  })

  it('closeTab drops the orphaned group WITHOUT a reload (§5.2 red test)', () => {
    seedDoc(['a', 'b', 'c'])
    useDocTabs.getState().createTabGroupFromDrop('c', 'b') // group {b,c}
    useDocTabs.getState().closeTab('b')
    assert.equal(useDocTabs.getState().tabGroups.length, 1, 'c still holds the group')
    useDocTabs.getState().closeTab('c')
    assert.equal(useDocTabs.getState().tabGroups.length, 0, 'closing the last member drops the group in-place')
  })

  it('reorderTabs keeps the group contiguous', () => {
    seedDoc(['a', 'b', 'c', 'd'])
    useDocTabs.getState().createTabGroupFromDrop('c', 'b') // group {b,c}
    const gid = useDocTabs.getState().tabGroups[0].id
    // move d to the front; the b,c group must remain a contiguous run
    useDocTabs.getState().reorderTabs(3, 0)
    const order = useDocTabs.getState().tabs.map((t) => t.id)
    const members = order.filter((id) => useDocTabs.getState().tabs.find((t) => t.id === id)?.groupId === gid)
    assert.deepEqual(members, ['b', 'c'])
    const bIdx = order.indexOf('b')
    const cIdx = order.indexOf('c')
    assert.equal(Math.abs(bIdx - cIdx), 1, `b,c must stay adjacent: ${order.join(',')}`)
  })
})

describe('useDocTabs persistence migration v2 → v3', () => {
  afterEach(() => {
    // Restore the default in-memory storage so the singleton store is clean for
    // any later test importing it.
    useDocTabs.persist.setOptions({ storage: createJSONStorage(() => undefined as unknown as Storage) })
  })

  it('a v2 snapshot migrates additively to v3 with NO data loss (round-trip)', async () => {
    const v2 = JSON.stringify({
      state: {
        tabs: [
          { id: 'doc-1', path: null, title: 'A', content: '', isDirty: false },
          { id: 'doc-2', path: null, title: 'B', content: 'hello', isDirty: true },
        ],
        activeTabId: 'doc-2',
        splitTabId: 'doc-1',
        documentSplitRatio: 40,
      },
      version: 2,
    })
    const mock: Storage = {
      getItem: () => v2,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    }
    useDocTabs.persist.setOptions({ storage: createJSONStorage(() => mock) })
    await useDocTabs.persist.rehydrate()
    const s = useDocTabs.getState()
    // Additive group fields.
    assert.ok(Array.isArray(s.tabGroups), 'tabGroups added by migration')
    assert.equal(s.tabGroups.length, 0)
    // No data loss: every tab + its fields, and the pane/ratio state, round-trip.
    assert.equal(s.tabs.length, 2, 'no tab dropped by migration')
    assert.deepEqual(s.tabs.map((t) => t.title), ['A', 'B'])
    assert.equal(s.tabs.find((t) => t.id === 'doc-2')?.content, 'hello', 'dirty content preserved')
    assert.equal(s.tabs.every((t) => (t.groupId ?? null) === null), true, 'legacy tabs are ungrouped')
    assert.equal(s.activeTabId, 'doc-2')
    assert.equal(s.splitTabId, 'doc-1')
    assert.equal(s.documentSplitRatio, 40)
  })
})
