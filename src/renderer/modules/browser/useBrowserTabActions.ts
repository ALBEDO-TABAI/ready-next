import { useCallback, useMemo } from 'react'

import type { BrowserTab } from '../../stores/useBrowserTabs'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { createBrowserTabSwitchExecutor } from './browserTabSwitchExecutor'
import { DEFAULT_BROWSER_URL, extractBrowserDomain, isSupportedBrowserNavigationUrl } from './url-utils'

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
      loading: Boolean(tab.loading),
      canGoBack: Boolean(tab.canGoBack),
      canGoForward: Boolean(tab.canGoForward),
      domain: tab.domain || extractBrowserDomain(tab.url),
      favicon: tab.favicon || undefined,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      error: tab.error || undefined,
    }))

    setTabs(hydratedTabs)
    const activeTab = backendTabs.find((tab) => tab.active) || backendTabs[backendTabs.length - 1]
    browserTabActivationSequencer.invalidate()
    setActiveTabId(activeTab?.id || hydratedTabs[hydratedTabs.length - 1]?.id || null)
    setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')
  }, [isElectron, setActiveTabId, setTabs, setUrlInput])

  const executeTabSwitch = useMemo(() => createBrowserTabSwitchExecutor({
    switchTab: async (tabId) => (
      await window.electronAPI?.browser?.switchTab(tabId) as {
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
    ),
    getState: () => {
      const current = useBrowserTabs.getState()
      return {
        activeTabId: current.activeTabId,
        tabs: current.tabs,
      }
    },
    setActiveTabId: (tabId) => {
      setActiveTabId(tabId)
    },
    setUrlInput: (value) => {
      setUrlInput(value)
    },
    updateTab: (tabId, patch) => {
      updateTab(tabId, patch)
    },
    sequencer: browserTabActivationSequencer,
  }), [setActiveTabId, setUrlInput, updateTab])

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
      browserTabActivationSequencer.invalidate()
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
        browserTabActivationSequencer.invalidate()
        setActiveTabId(nextTab.id)
        setUrlInput(nextTab.url === DEFAULT_BROWSER_URL ? '' : nextTab.url)
      } else {
        browserTabActivationSequencer.invalidate()
        setActiveTabId(null)
        setUrlInput('')
      }
    }
    setTabs(remaining)
    await syncTabsFromBackend()
  }, [isElectron, setTabs, setActiveTabId, setUrlInput, syncTabsFromBackend])

  const handleTabClick = useCallback(async (id: string) => {
    if (!isElectron) return
    await executeTabSwitch(id)
    await syncTabsFromBackend()
  }, [executeTabSwitch, isElectron, syncTabsFromBackend])

  const handleNavigate = useCallback(async (url?: string) => {
    if (!isElectron || !activeTabId) return
    const { urlInput: currentInput } = useBrowserTabs.getState()
    const targetUrl = normalizeUrl(url || currentInput)
    if (!isSupportedBrowserNavigationUrl(targetUrl)) {
      updateTab(activeTabId, {
        loading: false,
        error: '浏览器当前只支持网页地址，本地文件请改用文稿或文件区打开。',
      })
      return
    }
    updateTab(activeTabId, { url: targetUrl, loading: true, error: undefined })
    setUrlInput(targetUrl)
    const result = await window.electronAPI?.browser?.navigate(activeTabId, targetUrl)
    if (!result?.success) {
      updateTab(activeTabId, {
        loading: false,
        error: result?.error || '页面打开失败',
      })
    }
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
    const { tabs: currentTabs } = useBrowserTabs.getState()
    const reordered = [...currentTabs]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) return
    reordered.splice(toIndex, 0, moved)
    const orderedTabIds = reordered.map((tab) => tab.id)
    void (async () => {
      const result = await window.electronAPI?.browser?.reorderTabs(orderedTabIds)
      if (result?.success) {
        reorderTabs(fromIndex, toIndex)
      }
    })()
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
