import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getFilename } from '../utils/path'
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

export interface DocTab {
    id: string
    path: string | null  // null = untitled temp doc
    title: string
    content: string
    isDirty: boolean
    lastActivatedAt?: number | null
    // Renderer-only grouping (mirrors the browser rail). null/absent = ungrouped.
    groupId?: string | null
}

export interface PendingDocReveal {
    path: string
    selection?: string
    lineStart?: number
    lineEnd?: number
    sectionTitle?: string
    requestedAt: number
}

export type DocumentPaneTarget = 'primary' | 'split'

interface DocTabsState {
    tabs: DocTab[]
    tabGroups: TabGroup[]
    activeTabId: string
    splitTabId: string | null
    documentSplitRatio: number
    pendingReveal: PendingDocReveal | null

    openTab: (path: string) => void
    openImageTab: (path: string, options?: { activate?: boolean }) => string | null
    openTabInPane: (path: string, pane: DocumentPaneTarget) => string | null
    createBackgroundTab: (options?: { title?: string; path?: string | null; content?: string }) => string
    ensureTabForPath: (path: string) => string | null
    closeTab: (id: string) => void
    setActiveTab: (id: string) => void
    renameTab: (id: string, title: string) => void
    setTabPath: (id: string, path: string | null) => void
    setTabContent: (id: string, content: string) => void
    appendTabContent: (id: string, content: string) => void
    updateTabContent: (id: string, content: string) => void
    markTabSaved: (id: string) => void
    reorderTabs: (fromIndex: number, toIndex: number) => void
    setSplitTab: (id: string | null) => void
    setDocumentSplitRatio: (ratio: number) => void
    setPendingReveal: (reveal: PendingDocReveal | null) => void
    remapTabPaths: (fromPath: string, toPath: string) => void

    // Group ops — delegate to the pure tab-group-model (single source) and land
    // through the normalize choke. delete-group / new-tab-in-group are orchestrated
    // at the UI layer (they close/create tabs).
    createTabGroupFromDrop: (draggedId: string, targetId: string) => void
    addTabToGroup: (tabId: string, groupId: string) => void
    removeTabFromGroup: (tabId: string) => void
    reorderTabToRank: (movedId: string, toRank: number, intoGroupId: string | null) => void
    renameTabGroup: (groupId: string, name: string) => void
    recolorTabGroup: (groupId: string, color: TabGroupColor) => void
    setTabGroupCollapsed: (groupId: string, collapsed: boolean) => void
    disbandTabGroup: (groupId: string) => void
}

let tabCounter = 0
const makeId = () => `doc-${++tabCounter}`

const STORAGE_KEY = 'ready-doc-tabs-v2'
const IMAGE_PREVIEW_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'])

let docGroupCounter = 0
function syncDocGroupCounter(groups: TabGroup[]): void {
    for (const group of groups) {
        const match = /^grp-(\d+)$/.exec(group.id)
        if (match) docGroupCounter = Math.max(docGroupCounter, Number(match[1]))
    }
}
function nextDocGroupId(): string {
    return `grp-${++docGroupCounter}`
}

function sanitizeDocTabGroup(group: TabGroup): TabGroup | null {
    const id = String(group?.id || '')
    if (!id) return null
    return {
        id,
        name: typeof group.name === 'string' ? group.name : '',
        color: isTabGroupColor(group.color) ? group.color : 'blue',
        collapsed: Boolean(group.collapsed),
    }
}

function toDocGroupModel(tabs: DocTab[], tabGroups: TabGroup[]): GroupModelState {
    const groupOf: Record<string, string | null> = {}
    for (const tab of tabs) groupOf[tab.id] = tab.groupId ?? null
    return { order: tabs.map((tab) => tab.id), groupOf, groups: tabGroups }
}

function applyDocGroupModel(tabs: DocTab[], model: GroupModelState): { tabs: DocTab[]; tabGroups: TabGroup[] } {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]))
    const nextTabs: DocTab[] = []
    for (const id of model.order) {
        const tab = byId.get(id)
        if (tab) nextTabs.push({ ...tab, groupId: model.groupOf[id] ?? null })
    }
    return { tabs: nextTabs, tabGroups: model.groups }
}

// Normalize {tabs, tabGroups} against the group invariants (I1–I3). The doc store's
// mutators use raw set(), so any mutator that changes membership / order / groupId
// must route its result through this choke — otherwise e.g. closing a group's last
// member leaves an orphan group until reload. Idempotent.
function normalizeDocGroups(tabs: DocTab[], tabGroups: TabGroup[]): { tabs: DocTab[]; tabGroups: TabGroup[] } {
    const groups = tabGroups.map(sanitizeDocTabGroup).filter((group): group is TabGroup => group !== null)
    const applied = applyDocGroupModel(tabs, normalizeGroupState(toDocGroupModel(tabs, groups)))
    syncDocGroupCounter(applied.tabGroups)
    return applied
}

function applyDocGroupOp(state: DocTabsState, model: GroupModelState): Pick<DocTabsState, 'tabs' | 'tabGroups'> {
    return applyDocGroupModel(state.tabs, model)
}

export function normalizeDocTabPathKey(path: string | null | undefined): string | null {
    if (!path) return null
    const normalized = path.normalize('NFC').replace(/\\/g, '/')
    if (!normalized) return null
    const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    const driveMatch = withoutTrailingSlash.match(/^([A-Za-z]):(\/.*)?$/)
    if (driveMatch) {
        return `${driveMatch[1].toLowerCase()}:${driveMatch[2] || ''}`
    }
    return withoutTrailingSlash
}

function getPathExtension(path: string | null | undefined): string {
    if (!path) return ''
    const name = path.replace(/\\/g, '/').split('/').pop() || path
    const index = name.lastIndexOf('.')
    return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function isImagePreviewPath(path: string | null | undefined): boolean {
    return IMAGE_PREVIEW_EXTENSIONS.has(getPathExtension(path))
}

function getParentPathKey(path: string | null | undefined): string | null {
    const pathKey = normalizeDocTabPathKey(path)
    if (!pathKey) return null
    const index = pathKey.lastIndexOf('/')
    if (index <= 0) return '/'
    return pathKey.slice(0, index)
}

function syncTabCounterFromTabs(tabs: DocTab[]) {
    const maxId = tabs.reduce((max, tab) => {
        const match = tab.id.match(/^doc-(\d+)$/)
        const numeric = match ? Number(match[1]) : 0
        return Number.isFinite(numeric) ? Math.max(max, numeric) : max
    }, 0)
    tabCounter = Math.max(tabCounter, maxId)
}

function remapDocTabPath(path: string | null, fromPath: string, toPath: string): string | null {
    if (!path) return path
    const pathKey = normalizeDocTabPathKey(path)
    const fromKey = normalizeDocTabPathKey(fromPath)
    if (!pathKey || !fromKey) return path
    if (pathKey === fromKey) return toPath
    if (pathKey.startsWith(`${fromKey}/`)) {
        const separator = toPath.includes('\\') && !toPath.includes('/') ? '\\' : '/'
        const base = toPath.replace(/[\\/]+$/, '')
        const suffix = pathKey.slice(fromKey.length).replace(/\//g, separator)
        return `${base}${suffix}`
    }
    return path
}

function ensureDocumentTabForPath(tabs: DocTab[], path: string): { tabs: DocTab[]; id: string } {
    const pathKey = normalizeDocTabPathKey(path)
    const existing = pathKey ? tabs.find(t => normalizeDocTabPathKey(t.path) === pathKey) : undefined
    if (existing) {
        return { tabs, id: existing.id }
    }

    const id = makeId()
    const title = getFilename(path)
    return {
        tabs: [
            ...tabs,
            {
                id,
                path,
                title,
                content: '',
                isDirty: false,
                lastActivatedAt: null,
            },
        ],
        id,
    }
}

function ensureImagePreviewTabForPath(tabs: DocTab[], path: string): { tabs: DocTab[]; id: string } {
    const dirKey = getParentPathKey(path)
    if (!dirKey) return ensureDocumentTabForPath(tabs, path)
    const pathKey = normalizeDocTabPathKey(path)
    const existing = tabs.find(t => isImagePreviewPath(t.path) && getParentPathKey(t.path) === dirKey)
    if (existing) {
        if (normalizeDocTabPathKey(existing.path) === pathKey) {
            return { tabs, id: existing.id }
        }
        return {
            tabs: tabs.map(t =>
                t.id === existing.id
                    ? { ...t, path, title: getFilename(path), content: '', isDirty: false }
                    : t
            ),
            id: existing.id,
        }
    }
    return ensureDocumentTabForPath(tabs, path)
}

function markTabActivated(tabs: DocTab[], id: string, now = Date.now()): DocTab[] {
    return tabs.map((tab) => tab.id === id ? { ...tab, lastActivatedAt: now } : tab)
}

function ensureTabsState(
    state: Pick<DocTabsState, 'tabs' | 'activeTabId' | 'splitTabId' | 'documentSplitRatio'> & { tabGroups?: TabGroup[] },
) {
    const rawTabs = state.tabs.length > 0
        ? state.tabs
        : [{ id: 'doc-1', path: null, title: '新文档', content: '', isDirty: false }]
    syncTabCounterFromTabs(rawTabs)
    const { tabs, tabGroups } = normalizeDocGroups(rawTabs, Array.isArray(state.tabGroups) ? state.tabGroups : [])
    const activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0].id
    const splitTabId = state.splitTabId && tabs.some((tab) => tab.id === state.splitTabId) ? state.splitTabId : null
    return {
        tabs,
        tabGroups,
        activeTabId,
        splitTabId,
        documentSplitRatio: Math.max(20, Math.min(80, state.documentSplitRatio || 50)),
    }
}

const fallbackStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
}

export const useDocTabs = create<DocTabsState>()(persist((set, get) => ({
    tabs: [
        {
            id: makeId(),
            path: null,
            title: '新文档',
            content: '',
            isDirty: false,
            lastActivatedAt: null,
        }
    ],
    tabGroups: [],
    activeTabId: 'doc-1',
    splitTabId: null,
    documentSplitRatio: 50,
    pendingReveal: null,

    openTab: (path: string) => {
        const { tabs } = get()

        // Empty path = create new blank tab
        if (!path) {
            const id = makeId()
            set({
                tabs: [...tabs, { id, path: null, title: '新文档', content: '', isDirty: false }],
                activeTabId: id,
            })
            return
        }

        const next = ensureDocumentTabForPath(tabs, path)
        set({
            tabs: markTabActivated(next.tabs, next.id),
            activeTabId: next.id,
        })
    },

    openImageTab: (path: string, options) => {
        if (!path || !isImagePreviewPath(path)) return null
        const { tabs } = get()
        const next = ensureImagePreviewTabForPath(tabs, path)
        const updates: Partial<DocTabsState> = { tabs: next.tabs }
        if (options?.activate !== false) {
            updates.tabs = markTabActivated(next.tabs, next.id)
            updates.activeTabId = next.id
        }
        set(updates)
        return next.id
    },

    openTabInPane: (path: string, pane: DocumentPaneTarget) => {
        if (!path) return null

        const { tabs, activeTabId, splitTabId } = get()
        const next = ensureDocumentTabForPath(tabs, path)

        if (pane === 'primary') {
            if (next.id === splitTabId) {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: next.id,
                    splitTabId: activeTabId,
                })
                return next.id
            }

            set({
                tabs: markTabActivated(next.tabs, next.id),
                activeTabId: next.id,
            })
            return next.id
        }

        if (next.id === activeTabId) {
            if (splitTabId) {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: splitTabId,
                    splitTabId: next.id,
                })
            } else {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: next.id,
                })
            }
            return next.id
        }

        set({
            tabs: markTabActivated(next.tabs, next.id),
            splitTabId: next.id,
        })
        return next.id
    },

    createBackgroundTab: (options) => {
        const path = options?.path || null
        const title = path ? getFilename(path) : (options?.title?.trim() || '新文档')
        const id = makeId()
        set({
            tabs: [
                ...get().tabs,
                {
                    id,
                    path,
                    title,
                    content: options?.content || '',
                    isDirty: Boolean(options?.content),
                    lastActivatedAt: null,
                },
            ],
        })
        return id
    },

    ensureTabForPath: (path: string) => {
        if (!path) return null
        const { tabs } = get()
        const next = ensureDocumentTabForPath(tabs, path)
        if (next.tabs !== tabs) set({ tabs: next.tabs })
        return next.id
    },

    closeTab: (id: string) => {
        const { tabs, tabGroups, activeTabId, splitTabId } = get()
        const remaining = tabs.filter(t => t.id !== id)

        // If no tabs left, create a new blank one (and clear groups).
        if (remaining.length === 0) {
            const newId = makeId()
            set({
                tabs: [{ id: newId, path: null, title: '新文档', content: '', isDirty: false }],
                tabGroups: [],
                activeTabId: newId,
                splitTabId: null,
            })
            return
        }

        // Normalize so closing a group's last member drops the now-orphaned group
        // immediately (no reload needed) and any group stays contiguous.
        const normalized = normalizeDocGroups(remaining, tabGroups)
        const updates: Partial<DocTabsState> = { tabs: normalized.tabs, tabGroups: normalized.tabGroups }

        // If closed tab was the split tab, clear split
        if (splitTabId === id) {
            updates.splitTabId = null
        }

        // If closed tab was active, switch to neighbor
        if (activeTabId === id) {
            const oldIndex = tabs.findIndex(t => t.id === id)
            const newActive = remaining[Math.min(oldIndex, remaining.length - 1)]
            updates.activeTabId = newActive.id
            updates.tabs = markTabActivated(normalized.tabs, newActive.id)
        }

        set(updates)
    },

    setActiveTab: (id: string) => {
        set({ tabs: markTabActivated(get().tabs, id), activeTabId: id, splitTabId: null })
    },

    renameTab: (id: string, title: string) => {
        const nextTitle = title.trim() || '新文档'
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, title: nextTitle } : t
            )
        })
    },

    setTabPath: (id: string, path: string | null) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, path, title: path ? getFilename(path) : t.title } : t
            )
        })
    },

    setTabContent: (id: string, content: string) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, content, isDirty: true } : t
            )
        })
    },

    appendTabContent: (id: string, content: string) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, content: `${t.content}${content}`, isDirty: true } : t
            )
        })
    },

    updateTabContent: (id: string, content: string) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, content, isDirty: true } : t
            )
        })
    },

    markTabSaved: (id: string) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, isDirty: false } : t
            )
        })
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
        const { tabs: current, tabGroups } = get()
        const tabs = [...current]
        const [moved] = tabs.splice(fromIndex, 1)
        tabs.splice(toIndex, 0, moved)
        const normalized = normalizeDocGroups(tabs, tabGroups)
        set({ tabs: normalized.tabs, tabGroups: normalized.tabGroups })
    },

    setSplitTab: (id: string | null) => {
        set({ tabs: id ? markTabActivated(get().tabs, id) : get().tabs, splitTabId: id })
    },

    setDocumentSplitRatio: (ratio: number) => {
        set({ documentSplitRatio: Math.max(20, Math.min(80, ratio)) })
    },

    setPendingReveal: (reveal: PendingDocReveal | null) => {
        set({ pendingReveal: reveal })
    },

    remapTabPaths: (fromPath: string, toPath: string) => {
        set({
            tabs: get().tabs.map((tab) => {
                const nextPath = remapDocTabPath(tab.path, fromPath, toPath)
                if (nextPath === tab.path) return tab
                return {
                    ...tab,
                    path: nextPath,
                    title: nextPath ? getFilename(nextPath) : tab.title,
                }
            }),
        })
    },

    createTabGroupFromDrop: (draggedId, targetId) => {
        const state = get()
        const color = pickNextGroupColor(state.tabGroups.map((group) => group.color))
        const group: TabGroup = { id: nextDocGroupId(), name: '', color, collapsed: false }
        set(applyDocGroupOp(state, createGroupFromDrop(toDocGroupModel(state.tabs, state.tabGroups), draggedId, targetId, group)))
    },

    addTabToGroup: (tabId, groupId) => {
        const state = get()
        set(applyDocGroupOp(state, addToGroup(toDocGroupModel(state.tabs, state.tabGroups), tabId, groupId)))
    },

    removeTabFromGroup: (tabId) => {
        const state = get()
        set(applyDocGroupOp(state, removeFromGroup(toDocGroupModel(state.tabs, state.tabGroups), tabId)))
    },

    reorderTabToRank: (movedId, toRank, intoGroupId) => {
        const state = get()
        set(applyDocGroupOp(state, reorderTab(toDocGroupModel(state.tabs, state.tabGroups), movedId, toRank, intoGroupId)))
    },

    renameTabGroup: (groupId, name) => {
        const state = get()
        set(applyDocGroupOp(state, renameGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId, name)))
    },

    recolorTabGroup: (groupId, color) => {
        const state = get()
        set(applyDocGroupOp(state, recolorGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId, color)))
    },

    setTabGroupCollapsed: (groupId, collapsed) => {
        const state = get()
        set(applyDocGroupOp(state, setGroupCollapsed(toDocGroupModel(state.tabs, state.tabGroups), groupId, collapsed)))
    },

    disbandTabGroup: (groupId) => {
        const state = get()
        set(applyDocGroupOp(state, disbandGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId)))
    },
}), {
    name: STORAGE_KEY,
    version: 3,
    storage: createJSONStorage(() => (typeof localStorage !== 'undefined' ? localStorage : fallbackStorage)),
    partialize: (state) => {
        const tabs = state.tabs.map((tab) => {
            if (tab.path && !tab.isDirty) {
                return { ...tab, content: '' }
            }
            return tab
        })
        return {
            tabs,
            tabGroups: state.tabGroups,
            activeTabId: state.activeTabId,
            splitTabId: state.splitTabId,
            documentSplitRatio: state.documentSplitRatio,
        }
    },
    onRehydrateStorage: () => (state) => {
      if (!state) return
      const next = ensureTabsState({
        tabs: state.tabs,
        tabGroups: state.tabGroups,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        documentSplitRatio: state.documentSplitRatio,
      })
      state.tabs = next.tabs
      state.tabGroups = next.tabGroups
      state.activeTabId = next.activeTabId
      state.splitTabId = next.splitTabId
      state.documentSplitRatio = next.documentSplitRatio
    },
    migrate: (persistedState) => {
      const state = persistedState as (Partial<DocTabsState> & { splitRatio?: number }) | undefined
      if (!state) return persistedState
      const legacyDocumentSplitRatio = typeof state.documentSplitRatio === 'number'
        ? state.documentSplitRatio
        : typeof state.splitRatio === 'number'
          ? state.splitRatio
          : 50
      // v2 → v3 adds tab groups (renderer-only). Older snapshots have no tabGroups
      // and no tab.groupId → they normalize to "no groups", a clean additive upgrade.
      const next = ensureTabsState({
        tabs: Array.isArray(state.tabs) ? state.tabs : [],
        tabGroups: Array.isArray(state.tabGroups) ? state.tabGroups : [],
        activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : '',
        splitTabId: typeof state.splitTabId === 'string' ? state.splitTabId : null,
        documentSplitRatio: legacyDocumentSplitRatio,
      })
      const { splitRatio: _legacySplitRatio, ...rest } = state
      return {
        ...rest,
        ...next,
      }
    },
}))
