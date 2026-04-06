import { useCallback } from 'react'

import type { BrowserTab } from '../../stores/useBrowserTabs'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'

interface UseBrowserTabActionsParams {
  isElectron: boolean
  activeTab: BrowserTab | null
  activeTabId: string | null
  normalizeUrl: (input: string) => string
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
  setTabs: (tabs: BrowserTab[]) => void
  setActiveTabId: (tabId: string | null) => void
  setUrlInput: (value: string) => void
  addTab: (tab: BrowserTab) => void
  updateTab: (tabId: string, patch: Partial<BrowserTab>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
}

export function useBrowserTabActions({
  isElectron,
  activeTab,
  activeTabId,
  normalizeUrl,
  sendBoundsImmediate,
  setTabs,
  setActiveTabId,
  setUrlInput,
  addTab,
  updateTab,
  reorderTabs,
}: UseBrowserTabActionsParams) {
  const syncTabsFromBackend = useCallback(async () => {
    if (!isElectron) return
    const backendTabs = await window.electronAPI?.browser?.getTabs?.()
    if (!Array.isArray(backendTabs)) return

    const hydratedTabs: BrowserTab[] = backendTabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title || 'New Tab',
      loading: false,
      canGoBack: Boolean(tab.canGoBack),
      canGoForward: Boolean(tab.canGoForward),
      domain: tab.domain || extractBrowserDomain(tab.url),
      favicon: tab.favicon || undefined,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      error: undefined,
    }))

    setTabs(hydratedTabs)
    const activeTab = backendTabs.find((tab) => tab.active) || backendTabs[backendTabs.length - 1]
    setActiveTabId(activeTab?.id || hydratedTabs[hydratedTabs.length - 1]?.id || null)
    setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')
  }, [isElectron, setActiveTabId, setTabs, setUrlInput])

  const handleNewTab = useCallback(async () => {
    if (!isElectron) return
    await sendBoundsImmediate({ forceExact: true })
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    const result = await window.electronAPI?.browser?.createTab(DEFAULT_BROWSER_URL) as { success: boolean; tabId?: string } | undefined
    if (result?.success && result.tabId) {
      const newTab: BrowserTab = {
        id: result.tabId,
        url: DEFAULT_BROWSER_URL,
        title: 'New Tab',
        loading: true,
        canGoBack: false,
        canGoForward: false,
        domain: extractBrowserDomain(DEFAULT_BROWSER_URL),
        owner: 'manual',
        required: false,
        activity: 'idle',
      }
      addTab(newTab)
      setActiveTabId(result.tabId)
      setUrlInput('')
      await syncTabsFromBackend()
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
    }
  }, [isElectron, sendBoundsImmediate, addTab, setActiveTabId, setUrlInput, syncTabsFromBackend])

  const handleCloseTab = useCallback(async (id: string) => {
    if (!isElectron) return
    await window.electronAPI?.browser?.closeTab(id)
    const { tabs: currentTabs, activeTabId: currentActive } = useBrowserTabs.getState()
    const remaining = currentTabs.filter((tab) => tab.id !== id)
    if (id === currentActive) {
      if (remaining.length > 0) {
        const nextTab = remaining[remaining.length - 1]
        setActiveTabId(nextTab.id)
        setUrlInput(nextTab.url === DEFAULT_BROWSER_URL ? '' : nextTab.url)
      } else {
        setActiveTabId(null)
        setUrlInput('')
      }
    }
    setTabs(remaining)
    await syncTabsFromBackend()
  }, [isElectron, setTabs, setActiveTabId, setUrlInput, syncTabsFromBackend])

  const handleTabClick = useCallback(async (id: string) => {
    const { activeTabId: currentActive, tabs: currentTabs } = useBrowserTabs.getState()
    if (!isElectron || id === currentActive) return
    const result = await window.electronAPI?.browser?.switchTab(id) as {
      success: boolean
      url?: string
      title?: string
      domain?: string
      favicon?: string | null
      owner?: 'manual' | 'agent'
      required?: boolean
      activity?: 'idle' | 'running' | 'attention'
      lastAuditedAt?: number | null
      canGoBack?: boolean
      canGoForward?: boolean
    } | undefined
    if (result?.success) {
      setActiveTabId(id)
      const tab = currentTabs.find((item) => item.id === id)
      if (tab) setUrlInput(tab.url === DEFAULT_BROWSER_URL ? '' : tab.url)
      updateTab(id, {
        url: result.url || tab?.url || '',
        title: result.title || tab?.title || '',
        domain: result.domain,
        favicon: result.favicon || undefined,
        owner: result.owner,
        required: result.required,
        activity: result.activity,
        lastAuditedAt: result.lastAuditedAt,
        canGoBack: result.canGoBack || false,
        canGoForward: result.canGoForward || false,
      })
      await syncTabsFromBackend()
    }
  }, [isElectron, setActiveTabId, setUrlInput, updateTab, syncTabsFromBackend])

  const handleNavigate = useCallback(async (url?: string) => {
    if (!isElectron || !activeTabId) return
    const { urlInput: currentInput } = useBrowserTabs.getState()
    const targetUrl = normalizeUrl(url || currentInput)
    updateTab(activeTabId, { url: targetUrl, loading: true, error: undefined })
    setUrlInput(targetUrl)
    await window.electronAPI?.browser?.navigate(activeTabId, targetUrl)
  }, [isElectron, activeTabId, normalizeUrl, updateTab, setUrlInput])

  const handleContentDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(event.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleContentDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(event.dataTransfer)
    if (droppedFiles.length > 0) {
      event.preventDefault()
      void handleNavigate(toFileUrl(droppedFiles[0].path))
      return
    }

    const rawText = event.dataTransfer.getData('text/plain')?.trim()
    if (!rawText) return
    event.preventDefault()
    void handleNavigate(rawText)
  }, [handleNavigate])

  const handleGoBack = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    await window.electronAPI?.browser?.goBack(activeTabId)
  }, [isElectron, activeTabId])

  const handleGoForward = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    await window.electronAPI?.browser?.goForward(activeTabId)
  }, [isElectron, activeTabId])

  const handleRefresh = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    updateTab(activeTabId, { loading: true, error: undefined })
    await window.electronAPI?.browser?.reload(activeTabId)
  }, [isElectron, activeTabId, updateTab])

  const handleRetry = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    const { tabs: currentTabs } = useBrowserTabs.getState()
    const tab = currentTabs.find((item) => item.id === activeTabId)
    if (tab) {
      updateTab(activeTabId, { loading: true, error: undefined })
      await window.electronAPI?.browser?.navigate(activeTabId, tab.url)
    }
  }, [isElectron, activeTabId, updateTab])

  const handleUrlFocus = useCallback(() => {
    if (activeTab) {
      setUrlInput(activeTab.url === DEFAULT_BROWSER_URL ? '' : activeTab.url)
    }
  }, [activeTab, setUrlInput])

  const handleUrlBlur = useCallback(() => {
    const current = useBrowserTabs.getState()
    const tab = current.tabs.find((item) => item.id === current.activeTabId)
    if (!tab) return
    current.setUrlInput(tab.url === DEFAULT_BROWSER_URL ? '' : tab.url)
  }, [])

  const handleOpenExternal = useCallback(() => {
    if (activeTab) window.open(activeTab.url, '_blank')
  }, [activeTab])

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    reorderTabs(fromIndex, toIndex)
  }, [reorderTabs])

  const handlePrint = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    await window.electronAPI?.browser?.print(activeTabId)
  }, [isElectron, activeTabId])

  return {
    handleNewTab,
    handleCloseTab,
    handleTabClick,
    handleNavigate,
    handleContentDragOver,
    handleContentDrop,
    handleGoBack,
    handleGoForward,
    handleRefresh,
    handleRetry,
    handleUrlFocus,
    handleUrlBlur,
    handleOpenExternal,
    handleReorder,
    handlePrint,
  }
}
