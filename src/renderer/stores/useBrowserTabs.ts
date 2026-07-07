import { create } from 'zustand'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'
import { isTabGroupColor, pickNextGroupColor, type TabGroup, type TabGroupColor } from '../../shared/tab-groups'
import {
  addToGroup,
  createGroupFromDrop,
  disbandGroup,
  type GroupModelState,
  normalizeGroupState,
  recolorGroup,
  removeFromGroup,
  renameGroup,
  reorderTab,
  setGroupCollapsed,
} from '../../shared/tab-group-model'

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  domain?: string
  favicon?: string
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  error?: string
  // Renderer-only grouping (the main process never learns about it). null/absent = ungrouped.
  groupId?: string | null
}

interface BrowserTabsState {
  tabs: BrowserTab[]
  tabGroups: TabGroup[]
  activeTabId: string | null
  splitTabId: string | null
  browserSplitRatio: number
  urlInput: string

  setTabs: (tabs: BrowserTab[] | ((prev: BrowserTab[]) => BrowserTab[])) => void
  setActiveTabId: (id: string | null | ((prev: string | null) => string | null)) => void
  setSplitTabId: (id: string | null) => void
  setBrowserSplitRatio: (ratio: number) => void
  setUrlInput: (input: string) => void
  addTab: (tab: BrowserTab) => void
  addTabAfterOpener: (tab: BrowserTab, openerTabId: string | null) => void
  removeTab: (id: string) => void
  updateTab: (id: string, updates: Partial<BrowserTab>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void

  // Group ops — all delegate to the pure tab-group-model (single source) and land
  // through sanitizeSnapshot (which re-normalizes + persists). delete-group /
  // new-tab-in-group are orchestrated at the UI layer (they close/create tabs).
  createTabGroupFromDrop: (draggedId: string, targetId: string) => void
  addTabToGroup: (tabId: string, groupId: string) => void
  removeTabFromGroup: (tabId: string) => void
  reorderTabToRank: (movedId: string, toRank: number, intoGroupId: string | null) => void
  renameTabGroup: (groupId: string, name: string) => void
  recolorTabGroup: (groupId: string, color: TabGroupColor) => void
  setTabGroupCollapsed: (groupId: string, collapsed: boolean) => void
  disbandTabGroup: (groupId: string) => void
}

interface BrowserTabsSnapshot {
  tabs: BrowserTab[]
  tabGroups: TabGroup[]
  activeTabId: string | null
  splitTabId: string | null
  browserSplitRatio: number
  urlInput: string
}

const BROWSER_TABS_SNAPSHOT_KEY = 'ready-browser-tabs-v1'

let groupCounter = 0
function syncGroupCounter(groups: TabGroup[]): void {
  for (const group of groups) {
    const match = /^grp-(\d+)$/.exec(group.id)
    if (match) groupCounter = Math.max(groupCounter, Number(match[1]))
  }
}
function nextGroupId(): string {
  return `grp-${++groupCounter}`
}

function sanitizeBrowserTab(tab: BrowserTab): BrowserTab {
  return {
    id: String(tab.id || ''),
    url: String(tab.url || ''),
    title: String(tab.title || 'New Tab'),
    loading: Boolean(tab.loading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    domain: tab.domain || undefined,
    favicon: tab.favicon || undefined,
    owner: tab.owner,
    required: Boolean(tab.required),
    activity: tab.activity,
    lastAuditedAt: typeof tab.lastAuditedAt === 'number' ? tab.lastAuditedAt : null,
    error: tab.error || undefined,
    groupId: typeof tab.groupId === 'string' && tab.groupId ? tab.groupId : null,
  }
}

function sanitizeTabGroup(group: TabGroup): TabGroup | null {
  const id = String(group?.id || '')
  if (!id) return null
  return {
    id,
    name: typeof group.name === 'string' ? group.name : '',
    color: isTabGroupColor(group.color) ? group.color : 'blue',
    collapsed: Boolean(group.collapsed),
  }
}

function toGroupModel(tabs: BrowserTab[], tabGroups: TabGroup[]): GroupModelState {
  const groupOf: Record<string, string | null> = {}
  for (const tab of tabs) groupOf[tab.id] = tab.groupId ?? null
  return { order: tabs.map((tab) => tab.id), groupOf, groups: tabGroups }
}

function applyGroupModel(tabs: BrowserTab[], model: GroupModelState): { tabs: BrowserTab[]; tabGroups: TabGroup[] } {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const nextTabs: BrowserTab[] = []
  for (const id of model.order) {
    const tab = byId.get(id)
    if (tab) nextTabs.push({ ...tab, groupId: model.groupOf[id] ?? null })
  }
  return { tabs: nextTabs, tabGroups: model.groups }
}

function sanitizeSnapshot(snapshot: BrowserTabsSnapshot): BrowserTabsSnapshot {
  const rawTabs = Array.isArray(snapshot.tabs)
    ? snapshot.tabs.map((tab) => sanitizeBrowserTab(tab)).filter((tab) => tab.id && tab.url)
    : []
  const rawGroups = Array.isArray(snapshot.tabGroups)
    ? snapshot.tabGroups.map((group) => sanitizeTabGroup(group)).filter((group): group is TabGroup => group !== null)
    : []

  // Enforce group invariants (I1–I3) and derive the contiguous flat order. This is
  // the single write choke for the browser store: every mutator lands here.
  const model = normalizeGroupState(toGroupModel(rawTabs, rawGroups))
  const { tabs, tabGroups } = applyGroupModel(rawTabs, model)
  syncGroupCounter(tabGroups)

  const activeTabId = tabs.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : tabs[0]?.id || null
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  const splitTabId = snapshot.splitTabId && snapshot.splitTabId !== activeTabId && tabs.some((tab) => tab.id === snapshot.splitTabId)
    ? snapshot.splitTabId
    : null

  return {
    tabs,
    tabGroups,
    activeTabId,
    splitTabId,
    browserSplitRatio: Math.max(20, Math.min(80, Number(snapshot.browserSplitRatio) || 50)),
    urlInput: typeof snapshot.urlInput === 'string'
      ? snapshot.urlInput
      : activeTab?.url || '',
  }
}

// Reconcile a backend (main-process) tab set into the renderer store WITHOUT losing
// renderer-only grouping. Main is authoritative for the member set + metadata;
// renderer is authoritative for flat order + groupId. Used by ALL three
// backend→renderer setTabs paths (sync / restore / rebuild) so a reconcile never
// wipes groups. Orphaned groups are dropped by sanitizeSnapshot's normalize.
export function mergeBackendTabsPreservingGroups(
  localTabs: BrowserTab[],
  backendTabs: BrowserTab[],
): BrowserTab[] {
  const localById = new Map(localTabs.map((tab) => [tab.id, tab]))
  const backendById = new Map(backendTabs.map((tab) => [tab.id, tab]))
  const merged: BrowserTab[] = []
  for (const local of localTabs) {
    const backend = backendById.get(local.id)
    if (!backend) continue // removed on the backend
    merged.push({ ...backend, groupId: local.groupId ?? null })
  }
  for (const backend of backendTabs) {
    if (!localById.has(backend.id)) merged.push({ ...backend, groupId: null })
  }
  return merged
}

function readBrowserTabsSnapshot(): BrowserTabsSnapshot {
  return sanitizeSnapshot(readJsonStorage(BROWSER_TABS_SNAPSHOT_KEY, {
    tabs: [],
    tabGroups: [],
    activeTabId: null,
    splitTabId: null,
    browserSplitRatio: 50,
    urlInput: '',
  } satisfies BrowserTabsSnapshot))
}

function persistBrowserTabsSnapshot(snapshot: BrowserTabsSnapshot): void {
  writeJsonStorage(BROWSER_TABS_SNAPSHOT_KEY, sanitizeSnapshot(snapshot))
}

const initialBrowserTabsSnapshot = readBrowserTabsSnapshot()

export const useBrowserTabs = create<BrowserTabsState>((set) => {
  // Build the persisted-shape snapshot from a next {tabs, tabGroups} plus the
  // current state's non-tab fields, then sanitize (normalize groups) + persist.
  const commit = (
    state: BrowserTabsState,
    next: { tabs: BrowserTab[]; tabGroups: TabGroup[] },
  ): BrowserTabsSnapshot => {
    const nextState = sanitizeSnapshot({
      tabs: next.tabs,
      tabGroups: next.tabGroups,
      activeTabId: state.activeTabId,
      splitTabId: state.splitTabId,
      browserSplitRatio: state.browserSplitRatio,
      urlInput: state.urlInput,
    })
    persistBrowserTabsSnapshot(nextState)
    return nextState
  }

  const applyOp = (state: BrowserTabsState, model: GroupModelState): BrowserTabsSnapshot =>
    commit(state, applyGroupModel(state.tabs, model))

  return {
    tabs: initialBrowserTabsSnapshot.tabs,
    tabGroups: initialBrowserTabsSnapshot.tabGroups,
    activeTabId: initialBrowserTabsSnapshot.activeTabId,
    splitTabId: initialBrowserTabsSnapshot.splitTabId,
    browserSplitRatio: initialBrowserTabsSnapshot.browserSplitRatio,
    urlInput: initialBrowserTabsSnapshot.urlInput,

    setTabs: (tabsOrUpdater) =>
      set((state) => {
        const nextTabs = typeof tabsOrUpdater === 'function' ? tabsOrUpdater(state.tabs) : tabsOrUpdater
        return commit(state, { tabs: nextTabs, tabGroups: state.tabGroups })
      }),

    setActiveTabId: (idOrUpdater) =>
      set((state) => {
        const nextActiveTabId = typeof idOrUpdater === 'function' ? idOrUpdater(state.activeTabId) : idOrUpdater
        const nextState = sanitizeSnapshot({
          tabs: state.tabs,
          tabGroups: state.tabGroups,
          activeTabId: nextActiveTabId,
          splitTabId: state.splitTabId,
          browserSplitRatio: state.browserSplitRatio,
          urlInput: state.urlInput,
        })
        persistBrowserTabsSnapshot(nextState)
        return nextState
      }),

    setSplitTabId: (id) =>
      set((state) => {
        const nextState = sanitizeSnapshot({
          tabs: state.tabs,
          tabGroups: state.tabGroups,
          activeTabId: state.activeTabId,
          splitTabId: id,
          browserSplitRatio: state.browserSplitRatio,
          urlInput: state.urlInput,
        })
        persistBrowserTabsSnapshot(nextState)
        return nextState
      }),

    setBrowserSplitRatio: (ratio) =>
      set((state) => {
        const nextState = {
          ...state,
          browserSplitRatio: Math.max(20, Math.min(80, ratio)),
        }
        persistBrowserTabsSnapshot(nextState)
        return nextState
      }),

    setUrlInput: (input) =>
      set((state) => {
        if (state.urlInput === input) return state
        const nextState = {
          ...state,
          urlInput: input,
        }
        persistBrowserTabsSnapshot(nextState)
        return nextState
      }),

    addTab: (tab) =>
      set((state) => commit(state, { tabs: [...state.tabs, tab], tabGroups: state.tabGroups })),

    // Insert a newly-opened tab right after its opener, inheriting the opener's group
    // (Phase 4). Appends when the opener is absent. commit() re-normalizes so the group
    // stays contiguous (the new tab lands adjacent to its opener inside the run).
    addTabAfterOpener: (tab, openerTabId) =>
      set((state) => {
        const openerIndex = openerTabId ? state.tabs.findIndex((item) => item.id === openerTabId) : -1
        if (openerIndex === -1) {
          return commit(state, { tabs: [...state.tabs, tab], tabGroups: state.tabGroups })
        }
        const opener = state.tabs[openerIndex]
        const inserted = [...state.tabs]
        inserted.splice(openerIndex + 1, 0, { ...tab, groupId: opener.groupId ?? null })
        return commit(state, { tabs: inserted, tabGroups: state.tabGroups })
      }),

    removeTab: (id) =>
      set((state) => {
        const nextState = sanitizeSnapshot({
          tabs: state.tabs.filter((tab) => tab.id !== id),
          tabGroups: state.tabGroups,
          activeTabId: state.activeTabId === id ? null : state.activeTabId,
          splitTabId: state.splitTabId === id ? null : state.splitTabId,
          browserSplitRatio: state.browserSplitRatio,
          urlInput: state.urlInput,
        })
        persistBrowserTabsSnapshot(nextState)
        return nextState
      }),

    updateTab: (id, updates) =>
      set((state) =>
        commit(state, {
          tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...updates } : tab)),
          tabGroups: state.tabGroups,
        })),

    reorderTabs: (fromIndex, toIndex) =>
      set((state) => {
        const newTabs = [...state.tabs]
        const [moved] = newTabs.splice(fromIndex, 1)
        newTabs.splice(toIndex, 0, moved)
        return commit(state, { tabs: newTabs, tabGroups: state.tabGroups })
      }),

    createTabGroupFromDrop: (draggedId, targetId) =>
      set((state) => {
        const color = pickNextGroupColor(state.tabGroups.map((group) => group.color))
        const group: TabGroup = { id: nextGroupId(), name: '', color, collapsed: false }
        return applyOp(state, createGroupFromDrop(toGroupModel(state.tabs, state.tabGroups), draggedId, targetId, group))
      }),

    addTabToGroup: (tabId, groupId) =>
      set((state) => applyOp(state, addToGroup(toGroupModel(state.tabs, state.tabGroups), tabId, groupId))),

    removeTabFromGroup: (tabId) =>
      set((state) => applyOp(state, removeFromGroup(toGroupModel(state.tabs, state.tabGroups), tabId))),

    reorderTabToRank: (movedId, toRank, intoGroupId) =>
      set((state) => applyOp(state, reorderTab(toGroupModel(state.tabs, state.tabGroups), movedId, toRank, intoGroupId))),

    renameTabGroup: (groupId, name) =>
      set((state) => applyOp(state, renameGroup(toGroupModel(state.tabs, state.tabGroups), groupId, name))),

    recolorTabGroup: (groupId, color) =>
      set((state) => applyOp(state, recolorGroup(toGroupModel(state.tabs, state.tabGroups), groupId, color))),

    setTabGroupCollapsed: (groupId, collapsed) =>
      set((state) => applyOp(state, setGroupCollapsed(toGroupModel(state.tabs, state.tabGroups), groupId, collapsed))),

    disbandTabGroup: (groupId) =>
      set((state) => applyOp(state, disbandGroup(toGroupModel(state.tabs, state.tabGroups), groupId))),
  }
})
