import { useCallback, useEffect, useState } from 'react'

import type { BookmarkItem } from './types'
import type { BrowserTab } from '../../stores/useBrowserTabs'

interface UseBrowserPanelDataParams {
  isElectron: boolean
  activeTab: BrowserTab | null
}

export function useBrowserPanelData({
  isElectron,
  activeTab,
}: UseBrowserPanelDataParams) {
  const [isBookmarked, setIsBookmarked] = useState(false)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])

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

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onBookmarksChanged(async () => {
      await refreshBookmarks()
      if (activeTab?.url) {
        const current = await window.electronAPI?.browser?.isBookmarked(activeTab.url)
        setIsBookmarked(current?.bookmarked || false)
      }
    })
    return () => { cleanup?.() }
  }, [activeTab?.url, isElectron, refreshBookmarks])

  return {
    isBookmarked,
    bookmarks,
    handleToggleBookmark,
    handleToggleBookmarkForTab,
  }
}
