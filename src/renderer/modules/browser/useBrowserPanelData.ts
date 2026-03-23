import { useCallback, useEffect, useState } from 'react'

import type { BookmarkItem, DownloadItem, HistoryItem, PanelType } from './types'
import type { BrowserTab } from '../../stores/useBrowserTabs'

interface UseBrowserPanelDataParams {
  isElectron: boolean
  activePanel: PanelType
  setActivePanel: React.Dispatch<React.SetStateAction<PanelType>>
  activeTab: BrowserTab | null
  activeTabId: string | null
  updateTab: (tabId: string, patch: Partial<BrowserTab>) => void
  setUrlInput: (value: string) => void
}

export function useBrowserPanelData({
  isElectron,
  activePanel,
  setActivePanel,
  activeTab,
  activeTabId,
  updateTab,
  setUrlInput,
}: UseBrowserPanelDataParams) {
  const [isBookmarked, setIsBookmarked] = useState(false)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [selectedBookmarkUrl, setSelectedBookmarkUrl] = useState('')
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [downloads, setDownloads] = useState<DownloadItem[]>([])

  const refreshBookmarks = useCallback(async () => {
    if (!isElectron) return
    const result = await window.electronAPI?.browser?.getBookmarks()
    if (result?.success && result.data) {
      setBookmarks(result.data as BookmarkItem[])
    }
  }, [isElectron])

  useEffect(() => {
    if (!isElectron || !activeTab?.url) { setIsBookmarked(false); return }
    window.electronAPI?.browser?.isBookmarked(activeTab.url).then((res) => {
      setIsBookmarked(res?.bookmarked || false)
    })
  }, [isElectron, activeTab?.url])

  useEffect(() => {
    void refreshBookmarks()
  }, [refreshBookmarks])

  const toggleBookmarkForTarget = useCallback(async (url: string, title: string) => {
    if (!isElectron) return
    const current = await window.electronAPI?.browser?.isBookmarked(url)
    if (current?.bookmarked) {
      await window.electronAPI?.browser?.removeBookmark(url)
      if (activeTab?.url === url) {
        setIsBookmarked(false)
      }
    } else {
      await window.electronAPI?.browser?.addBookmark(url, title)
      if (activeTab?.url === url) {
        setIsBookmarked(true)
      }
    }
    await refreshBookmarks()
  }, [isElectron, activeTab?.url, refreshBookmarks])

  const handleToggleBookmark = useCallback(async () => {
    if (!isElectron || !activeTab) return
    await toggleBookmarkForTarget(activeTab.url, activeTab.title || activeTab.url)
  }, [isElectron, activeTab, toggleBookmarkForTarget])

  const handleToggleBookmarkForTab = useCallback(async (tab: BrowserTab) => {
    if (!isElectron) return
    await toggleBookmarkForTarget(tab.url, tab.title || tab.url)
  }, [isElectron, toggleBookmarkForTarget])

  const handleTogglePanel = useCallback(async (panel: 'bookmarks' | 'downloads' | 'history') => {
    if (activePanel === panel) {
      setActivePanel(null)
      return
    }
    setActivePanel(panel)
    if (!isElectron) return
    if (panel === 'bookmarks') {
      const res = await window.electronAPI?.browser?.getBookmarks()
      if (res?.success && res.data) {
        setBookmarks(res.data as BookmarkItem[])
        if (res.data.length > 0 && !selectedBookmarkUrl) {
          setSelectedBookmarkUrl((res.data[0] as BookmarkItem).url)
        }
      }
    } else if (panel === 'history') {
      const res = await window.electronAPI?.browser?.getHistory(100)
      if (res?.success && res.data) setHistoryItems(res.data as HistoryItem[])
    } else if (panel === 'downloads') {
      const res = await window.electronAPI?.browser?.getDownloads()
      if (res?.success && res.data) setDownloads(res.data as DownloadItem[])
    }
  }, [activePanel, isElectron, selectedBookmarkUrl, setActivePanel])

  const handleNavigateFromPanel = useCallback(async (url: string) => {
    if (!isElectron || !activeTabId) return
    updateTab(activeTabId, { url, loading: true, error: undefined })
    setUrlInput(url)
    setActivePanel(null)
    await window.electronAPI?.browser?.navigate(activeTabId, url)
  }, [isElectron, activeTabId, updateTab, setUrlInput, setActivePanel])

  const handleRemoveBookmark = useCallback(async (url: string) => {
    if (!isElectron) return
    await window.electronAPI?.browser?.removeBookmark(url)
    setBookmarks((prev) => prev.filter((item) => item.url !== url))
    if (selectedBookmarkUrl === url) {
      setSelectedBookmarkUrl('')
    }
    if (activeTab?.url === url) setIsBookmarked(false)
  }, [isElectron, activeTab?.url, selectedBookmarkUrl])

  const handleClearHistory = useCallback(async () => {
    if (!isElectron) return
    await window.electronAPI?.browser?.clearHistory()
    setHistoryItems([])
  }, [isElectron])

  const handleClearDownloads = useCallback(async () => {
    if (!isElectron) return
    await window.electronAPI?.browser?.clearDownloads()
    setDownloads([])
  }, [isElectron])

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onBookmarksChanged(async () => {
      const res = await window.electronAPI?.browser?.getBookmarks()
      if (res?.success && res.data) {
        const latest = res.data as BookmarkItem[]
        setBookmarks(latest)
        if (!selectedBookmarkUrl && latest.length > 0) {
          setSelectedBookmarkUrl(latest[0].url)
        } else if (selectedBookmarkUrl && !latest.some((item) => item.url === selectedBookmarkUrl)) {
          setSelectedBookmarkUrl(latest[0]?.url || '')
        }
      }
      if (activeTab?.url) {
        const current = await window.electronAPI?.browser?.isBookmarked(activeTab.url)
        setIsBookmarked(current?.bookmarked || false)
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, selectedBookmarkUrl, activeTab?.url])

  return {
    isBookmarked,
    bookmarks,
    selectedBookmarkUrl,
    historyItems,
    downloads,
    setSelectedBookmarkUrl,
    handleToggleBookmark,
    handleToggleBookmarkForTab,
    handleTogglePanel,
    handleNavigateFromPanel,
    handleRemoveBookmark,
    handleClearHistory,
    handleClearDownloads,
  }
}
