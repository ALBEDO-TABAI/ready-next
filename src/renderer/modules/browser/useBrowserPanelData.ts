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

  // P1.4 — bridge utility-menu "剪藏到资料库" click → preload
  // `clipCurrentTab()` IPC. The menu service emits
  // `browser:clipCurrentTabRequested`; here we react to it. Result is
  // logged for P1 (renderer toast UI is P2.9). Any rejection from the
  // preload call is caught so we don't surface unhandled-promise warnings
  // into the renderer.
  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onClipCurrentTabRequested(() => {
      const promise = window.electronAPI?.browser?.clipCurrentTab()
      if (!promise) return
      promise
        .then((result) => {
          if (!result) return
          if (result.ok && result.savedPath) {
            console.info('[obsidian-web-clip] saved:', result.savedPath, result)
          } else {
            console.warn('[obsidian-web-clip] clip failed:', result.errorKind, result.errorDetail)
          }
        })
        .catch((err) => {
          console.warn('[obsidian-web-clip] clipCurrentTab IPC rejected:', err)
        })
    })
    return () => { cleanup?.() }
  }, [isElectron])

  return {
    isBookmarked,
    bookmarks,
    handleToggleBookmark,
  }
}
