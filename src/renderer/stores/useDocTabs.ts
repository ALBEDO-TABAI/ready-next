import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getFilename } from '../utils/path'

export interface DocTab {
    id: string
    path: string | null  // null = untitled temp doc
    title: string
    content: string
    isDirty: boolean
}

export interface PendingDocReveal {
    path: string
    selection?: string
    lineStart?: number
    lineEnd?: number
    sectionTitle?: string
    requestedAt: number
}

interface DocTabsState {
    tabs: DocTab[]
    activeTabId: string
    splitTabId: string | null
    documentSplitRatio: number
    pendingReveal: PendingDocReveal | null

    openTab: (path: string) => void
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
}

let tabCounter = 0
const makeId = () => `doc-${++tabCounter}`

const STORAGE_KEY = 'ready-doc-tabs-v2'

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

function syncTabCounterFromTabs(tabs: DocTab[]) {
    const maxId = tabs.reduce((max, tab) => {
        const match = tab.id.match(/^doc-(\d+)$/)
        const numeric = match ? Number(match[1]) : 0
        return Number.isFinite(numeric) ? Math.max(max, numeric) : max
    }, 0)
    tabCounter = Math.max(tabCounter, maxId)
}

function ensureTabsState(state: Pick<DocTabsState, 'tabs' | 'activeTabId' | 'splitTabId' | 'documentSplitRatio'>) {
    const tabs = state.tabs.length > 0
        ? state.tabs
        : [{ id: 'doc-1', path: null, title: '新文档', content: '', isDirty: false }]
    syncTabCounterFromTabs(tabs)
    const activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0].id
    const splitTabId = state.splitTabId && tabs.some((tab) => tab.id === state.splitTabId) ? state.splitTabId : null
    return {
        tabs,
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
        }
    ],
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

        const pathKey = normalizeDocTabPathKey(path)
        const existing = pathKey ? tabs.find(t => normalizeDocTabPathKey(t.path) === pathKey) : undefined
        if (existing) {
            set({ activeTabId: existing.id })
            return
        }
        // Create new tab
        const id = makeId()
        const title = getFilename(path)
        const newTab: DocTab = {
            id,
            path,
            title,
            content: '',  // Will be loaded by DocumentEditor
            isDirty: false,
        }
        set({
            tabs: [...tabs, newTab],
            activeTabId: id,
        })
    },

    closeTab: (id: string) => {
        const { tabs, activeTabId, splitTabId } = get()
        const newTabs = tabs.filter(t => t.id !== id)

        // If no tabs left, create a new blank one
        if (newTabs.length === 0) {
            const newId = makeId()
            set({
                tabs: [{ id: newId, path: null, title: '新文档', content: '', isDirty: false }],
                activeTabId: newId,
                splitTabId: null,
            })
            return
        }

        const updates: Partial<DocTabsState> = { tabs: newTabs }

        // If closed tab was the split tab, clear split
        if (splitTabId === id) {
            updates.splitTabId = null
        }

        // If closed tab was active, switch to neighbor
        if (activeTabId === id) {
            const oldIndex = tabs.findIndex(t => t.id === id)
            const newActive = newTabs[Math.min(oldIndex, newTabs.length - 1)]
            updates.activeTabId = newActive.id
        }

        set(updates)
    },

    setActiveTab: (id: string) => {
        set({ activeTabId: id, splitTabId: null })
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
        const tabs = [...get().tabs]
        const [moved] = tabs.splice(fromIndex, 1)
        tabs.splice(toIndex, 0, moved)
        set({ tabs })
    },

    setSplitTab: (id: string | null) => {
        set({ splitTabId: id })
    },

    setDocumentSplitRatio: (ratio: number) => {
        set({ documentSplitRatio: Math.max(20, Math.min(80, ratio)) })
    },

    setPendingReveal: (reveal: PendingDocReveal | null) => {
        set({ pendingReveal: reveal })
    },
}), {
    name: STORAGE_KEY,
    version: 2,
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
            activeTabId: state.activeTabId,
            splitTabId: state.splitTabId,
            documentSplitRatio: state.documentSplitRatio,
        }
    },
    onRehydrateStorage: () => (state) => {
      if (!state) return
      const next = ensureTabsState({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        documentSplitRatio: state.documentSplitRatio,
      })
      state.tabs = next.tabs
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
      const next = ensureTabsState({
        tabs: Array.isArray(state.tabs) ? state.tabs : [],
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
