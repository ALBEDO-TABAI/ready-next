import { create } from 'zustand'
import { readJsonStorage, writeJsonStorage } from '../utils/storage'

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
  splitTabId: string | null
  browserSplitRatio: number
  urlInput: string

  setTabs: (tabs: BrowserTab[] | ((prev: BrowserTab[]) => BrowserTab[])) => void
  setActiveTabId: (id: string | null | ((prev: string | null) => string | null)) => void
  setSplitTabId: (id: string | null) => void
  setBrowserSplitRatio: (ratio: number) => void
  setUrlInput: (input: string) => void
  addTab: (tab: BrowserTab) => void
  removeTab: (id: string) => void
  updateTab: (id: string, updates: Partial<BrowserTab>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
}

interface BrowserTabsSnapshot {
  tabs: BrowserTab[]
  activeTabId: string | null
  splitTabId: string | null
  browserSplitRatio: number
  urlInput: string
}

const BROWSER_TABS_SNAPSHOT_KEY = 'ready-browser-tabs-v1'

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
  }
}

function sanitizeSnapshot(snapshot: BrowserTabsSnapshot): BrowserTabsSnapshot {
  const tabs = Array.isArray(snapshot.tabs)
    ? snapshot.tabs
      .map((tab) => sanitizeBrowserTab(tab))
      .filter((tab) => tab.id && tab.url)
    : []
  const activeTabId = tabs.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : tabs[0]?.id || null
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  const splitTabId = snapshot.splitTabId && snapshot.splitTabId !== activeTabId && tabs.some((tab) => tab.id === snapshot.splitTabId)
    ? snapshot.splitTabId
    : null

  return {
    tabs,
    activeTabId,
    splitTabId,
    browserSplitRatio: Math.max(20, Math.min(80, Number(snapshot.browserSplitRatio) || 50)),
    urlInput: typeof snapshot.urlInput === 'string'
      ? snapshot.urlInput
      : activeTab?.url || '',
  }
}

function readBrowserTabsSnapshot(): BrowserTabsSnapshot {
  return sanitizeSnapshot(readJsonStorage(BROWSER_TABS_SNAPSHOT_KEY, {
    tabs: [],
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

export const useBrowserTabs = create<BrowserTabsState>((set) => ({
  tabs: initialBrowserTabsSnapshot.tabs,
  activeTabId: initialBrowserTabsSnapshot.activeTabId,
  splitTabId: initialBrowserTabsSnapshot.splitTabId,
  browserSplitRatio: initialBrowserTabsSnapshot.browserSplitRatio,
  urlInput: initialBrowserTabsSnapshot.urlInput,

  setTabs: (tabsOrUpdater) =>
    set((state) => {
      const nextTabs = typeof tabsOrUpdater === 'function' ? tabsOrUpdater(state.tabs) : tabsOrUpdater
      const nextState = sanitizeSnapshot({
        tabs: nextTabs,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        browserSplitRatio: state.browserSplitRatio,
        urlInput: state.urlInput,
      })
      persistBrowserTabsSnapshot(nextState)
      return nextState
    }),

  setActiveTabId: (idOrUpdater) =>
    set((state) => {
      const nextActiveTabId = typeof idOrUpdater === 'function' ? idOrUpdater(state.activeTabId) : idOrUpdater
      const nextState = sanitizeSnapshot({
        tabs: state.tabs,
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
    set((state) => {
      const nextState = sanitizeSnapshot({
        tabs: [...state.tabs, tab],
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        browserSplitRatio: state.browserSplitRatio,
        urlInput: state.urlInput,
      })
      persistBrowserTabsSnapshot(nextState)
      return nextState
    }),

  removeTab: (id) =>
    set((state) => {
      const nextState = sanitizeSnapshot({
        tabs: state.tabs.filter((tab) => tab.id !== id),
        activeTabId: state.activeTabId === id ? null : state.activeTabId,
        splitTabId: state.splitTabId === id ? null : state.splitTabId,
        browserSplitRatio: state.browserSplitRatio,
        urlInput: state.urlInput,
      })
      persistBrowserTabsSnapshot(nextState)
      return nextState
    }),

  updateTab: (id, updates) =>
    set((state) => {
      const nextState = sanitizeSnapshot({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...updates } : tab)),
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        browserSplitRatio: state.browserSplitRatio,
        urlInput: state.urlInput,
      })
      persistBrowserTabsSnapshot(nextState)
      return nextState
    }),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const newTabs = [...state.tabs]
      const [moved] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, moved)
      const nextState = sanitizeSnapshot({
        tabs: newTabs,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        browserSplitRatio: state.browserSplitRatio,
        urlInput: state.urlInput,
      })
      persistBrowserTabsSnapshot(nextState)
      return nextState
    }),
}))
