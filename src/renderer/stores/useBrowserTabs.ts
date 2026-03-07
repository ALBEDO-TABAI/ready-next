import { create } from 'zustand'

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
}

interface BrowserTabsState {
  tabs: BrowserTab[]
  activeTabId: string | null
  urlInput: string

  setTabs: (tabs: BrowserTab[] | ((prev: BrowserTab[]) => BrowserTab[])) => void
  setActiveTabId: (id: string | null | ((prev: string | null) => string | null)) => void
  setUrlInput: (input: string) => void
  addTab: (tab: BrowserTab) => void
  removeTab: (id: string) => void
  updateTab: (id: string, updates: Partial<BrowserTab>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
}

export const useBrowserTabs = create<BrowserTabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  urlInput: '',

  setTabs: (tabsOrUpdater) =>
    set((state) => ({
      tabs: typeof tabsOrUpdater === 'function' ? tabsOrUpdater(state.tabs) : tabsOrUpdater,
    })),

  setActiveTabId: (idOrUpdater) =>
    set((state) => ({
      activeTabId: typeof idOrUpdater === 'function' ? idOrUpdater(state.activeTabId) : idOrUpdater,
    })),

  setUrlInput: (input) => set({ urlInput: input }),

  addTab: (tab) =>
    set((state) => ({ tabs: [...state.tabs, tab] })),

  removeTab: (id) =>
    set((state) => ({ tabs: state.tabs.filter((t) => t.id !== id) })),

  updateTab: (id, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const newTabs = [...state.tabs]
      const [moved] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, moved)
      return { tabs: newTabs }
    }),
}))
