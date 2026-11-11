import { useCallback, useMemo } from 'react'

import type { BrowserTab } from '../../stores/useBrowserTabs'
import { mergeBackendTabsPreservingGroups, useBrowserTabs } from '../../stores/useBrowserTabs'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import { filterBrowserLocalMediaUploadPaths } from '../../../shared/browser-local-media-upload'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { createBrowserTabSwitchExecutor } from './browserTabSwitchExecutor'
import { DEFAULT_BROWSER_URL, extractBrowserDomain, isSupportedBrowserNavigationUrl } from './url-utils'

// A background tab (created with { background: true }) lands in the store asynchronously
// via the browser:tabOpened push (onTabOpened → addTab). Poll until it lists so a
// follow-up group op (which no-ops on an unknown tab id) sequences after it.
async function waitForTabListed(tabId: string, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!useBrowserTabs.getState().tabs.some((tab) => tab.id === tabId)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return true
}

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
  onLocalMediaUploadStatus?: (status: { kind: 'uploading' | 'success' | 'error'; message: string } | null) => void
  onLocalMediaUploadSettled?: () => void
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
  onLocalMediaUploadStatus,
  onLocalMediaUploadSettled,
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
      profile: tab.profile || null,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      error: tab.error || undefined,
    }))

    // Preserve renderer-only grouping across the backend reconcile (main is
    // authoritative for the member set + metadata, renderer for order + groupId).
    setTabs(mergeBackendTabsPreservingGroups(useBrowserTabs.getState().tabs, hydratedTabs))
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
        profile?: string | null
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
    const { tabs: currentTabs, activeTabId: currentActive } = useBrowserTabs.getState()
    const remaining = currentTabs.filter((tab) => tab.id !== id)
    const isClosingLastTab = currentTabs.length <= 1 || remaining.length === 0

    if (isClosingLastTab) {
      const result = await window.electronAPI?.browser?.createTab(DEFAULT_BROWSER_URL) as { success: boolean; tabId?: string } | undefined
      if (!result?.success || !result.tabId) return

      const replacementTab: BrowserTab = {
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
      browserTabActivationSequencer.invalidate()
      setTabs([replacementTab])
      setActiveTabId(result.tabId)
      setUrlInput('')
      await window.electronAPI?.browser?.closeTab(id)
      await syncTabsFromBackend()
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
      return
    }

    await window.electronAPI?.browser?.closeTab(id)
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
  }, [isElectron, sendBoundsImmediate, setTabs, setActiveTabId, setUrlInput, syncTabsFromBackend])

  const handleTabClick = useCallback(async (id: string) => {
    if (!isElectron) return
    await executeTabSwitch(id)
    await syncTabsFromBackend()
  }, [executeTabSwitch, isElectron, syncTabsFromBackend])

  const handleNavigate = useCallback(async (url?: string, options?: { tabId?: string | null }) => {
    if (!isElectron) return
    const { urlInput: currentInput } = useBrowserTabs.getState()
    const targetUrl = normalizeUrl(url || currentInput)
    const targetTabId = options?.tabId ?? activeTabId
    if (!isSupportedBrowserNavigationUrl(targetUrl)) {
      if (targetTabId) {
        updateTab(targetTabId, {
          loading: false,
          error: '浏览器当前支持网页地址和本地 HTML 文件；其他本地文件请改用文稿或文件区打开。',
        })
      }
      return
    }

    if (!targetTabId) {
      await sendBoundsImmediate({ forceExact: true })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const created = await window.electronAPI?.browser?.createTab(targetUrl) as { success: boolean; tabId?: string } | undefined
      if (created?.success && created.tabId) {
        const newTab: BrowserTab = {
          id: created.tabId,
          url: targetUrl,
          title: 'Loading...',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          domain: extractBrowserDomain(targetUrl),
          owner: 'manual',
          required: false,
          activity: 'idle',
        }
        addTab(newTab)
        browserTabActivationSequencer.invalidate()
        setActiveTabId(created.tabId)
        setUrlInput(targetUrl === DEFAULT_BROWSER_URL ? '' : targetUrl)
        await syncTabsFromBackend()
        requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
      }
      return
    }

    updateTab(targetTabId, { url: targetUrl, loading: true, error: undefined })
    if (targetTabId === activeTabId) {
      setUrlInput(targetUrl)
    }
    const result = await window.electronAPI?.browser?.navigate(targetTabId, targetUrl)
    if (!result?.success) {
      updateTab(targetTabId, {
        loading: false,
        error: result?.error || '页面打开失败',
      })
    }
  }, [isElectron, activeTabId, normalizeUrl, updateTab, setUrlInput, sendBoundsImmediate, addTab, setActiveTabId, syncTabsFromBackend])

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

  const handleContentDrop = useCallback((event: React.DragEvent<HTMLDivElement>, tabId?: string | null) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(event.dataTransfer)
    if (droppedFiles.length > 0) {
      event.preventDefault()
      const uploadPaths = filterBrowserLocalMediaUploadPaths(droppedFiles)
      if (uploadPaths.length > 0) {
        onLocalMediaUploadSettled?.()
        onLocalMediaUploadStatus?.({
          kind: 'uploading',
          message: uploadPaths.length > 1 ? `正在上传 ${uploadPaths.length} 个素材...` : '正在上传素材...',
        })
        const uploadPromise = window.electronAPI?.browser?.uploadLocalMediaFiles?.({
          tabId: tabId ?? activeTabId,
          files: uploadPaths,
        })
        if (!uploadPromise) {
          onLocalMediaUploadStatus?.({
            kind: 'error',
            message: '当前环境不能直接上传素材',
          })
          onLocalMediaUploadSettled?.()
          return
        }
        void uploadPromise.then((result) => {
          if (result?.success) {
            onLocalMediaUploadStatus?.({
              kind: 'success',
              message: result.method === 'drop' ? '已把素材拖入网页' : '已把素材交给网页上传',
            })
            return
          }
          onLocalMediaUploadStatus?.({
            kind: 'error',
            message: result?.error || '网页没有接住这个素材',
          })
        }).catch((error) => {
          onLocalMediaUploadStatus?.({
            kind: 'error',
            message: error instanceof Error ? error.message : '素材上传失败',
          })
        }).finally(() => {
          onLocalMediaUploadSettled?.()
        })
        return
      }
      void handleNavigate(toFileUrl(droppedFiles[0].path), { tabId })
      return
    }

    const rawText = event.dataTransfer.getData('text/plain')?.trim()
    if (!rawText) return
    event.preventDefault()
    void handleNavigate(rawText, { tabId })
  }, [activeTabId, handleNavigate, onLocalMediaUploadSettled, onLocalMediaUploadStatus])

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

  const handleRetry = useCallback(async (tabId?: string | null) => {
    const targetTabId = tabId ?? activeTabId
    if (!isElectron || !targetTabId) return
    const { tabs: currentTabs } = useBrowserTabs.getState()
    const tab = currentTabs.find((item) => item.id === targetTabId)
    if (tab) {
      updateTab(targetTabId, { loading: true, error: undefined })
      await window.electronAPI?.browser?.navigate(targetTabId, tab.url)
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

  // ---- Tab groups (renderer-only) ----
  // Groups never cross to the main process. But every group op that changes the FLAT
  // order (create/add/remove/reorder) writes the resulting order back to the backend so
  // getTabs() stays in sync (C-ORDER); the merge helper then preserves groupId across
  // reconciles. rename/recolor/collapse/disband don't touch flat order and are wired
  // straight to the store in BrowserMode.
  const writeBackFlatOrder = useCallback(async () => {
    const flatIds = useBrowserTabs.getState().tabs.map((tab) => tab.id)
    await window.electronAPI?.browser?.reorderTabs(flatIds)
  }, [])

  const handleCreateGroup = useCallback((draggedId: string, targetId: string) => {
    useBrowserTabs.getState().createTabGroupFromDrop(draggedId, targetId)
    void writeBackFlatOrder()
  }, [writeBackFlatOrder])

  const handleAddToGroup = useCallback((tabId: string, groupId: string) => {
    useBrowserTabs.getState().addTabToGroup(tabId, groupId)
    void writeBackFlatOrder()
  }, [writeBackFlatOrder])

  const handleReorderToRank = useCallback((movedId: string, toRank: number, intoGroupId: string | null) => {
    useBrowserTabs.getState().reorderTabToRank(movedId, toRank, intoGroupId)
    void writeBackFlatOrder()
  }, [writeBackFlatOrder])

  // delete-group closes every member tab. Store-layer orchestration (crosses the id
  // layer + IPC), NOT the pure model. Never-empty: if the group holds every tab, a
  // survivor is created FIRST — backend closeTab has no last-tab replacement.
  const handleDeleteGroup = useCallback(async (groupId: string) => {
    if (!isElectron) return
    const { tabs: currentTabs } = useBrowserTabs.getState()
    const members = currentTabs.filter((tab) => (tab.groupId ?? null) === groupId)
    if (members.length === 0) return
    const remaining = currentTabs.filter((tab) => (tab.groupId ?? null) !== groupId)
    if (remaining.length === 0) {
      await sendBoundsImmediate({ forceExact: true })
      const created = await window.electronAPI?.browser?.createTab(DEFAULT_BROWSER_URL) as { success: boolean; tabId?: string } | undefined
      if (!created?.success || !created.tabId) return
      // Seed the survivor locally BEFORE closing members so the renderer store never
      // transiently hits 0 tabs — which would unmount the rail (→ empty state) and close
      // the overlay flyout mid-interaction (mirrors handleCloseTab's last-tab path).
      const survivor: BrowserTab = {
        id: created.tabId,
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
      browserTabActivationSequencer.invalidate()
      addTab(survivor)
      setActiveTabId(created.tabId)
      setUrlInput('')
    }
    for (const member of members) {
      await window.electronAPI?.browser?.closeTab(member.id)
    }
    // Backend reselects active; the merge helper drops the closed members and
    // sanitizeSnapshot's normalize drops the now-orphaned group (I3).
    await syncTabsFromBackend()
    requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
  }, [addTab, isElectron, sendBoundsImmediate, setActiveTabId, setUrlInput, syncTabsFromBackend])

  // new-tab-in-group creates a BACKGROUND tab (no focus steal, mirrors Phase 0), waits
  // for it to list, then moves it into the group and writes the flat order back.
  const handleNewTabInGroup = useCallback(async (groupId: string) => {
    if (!isElectron) return
    await sendBoundsImmediate({ forceExact: true })
    const created = await window.electronAPI?.browser?.createTab(DEFAULT_BROWSER_URL, { background: true }) as { success: boolean; tabId?: string } | undefined
    if (!created?.success || !created.tabId) return
    const listed = await waitForTabListed(created.tabId)
    if (!listed) return
    useBrowserTabs.getState().addTabToGroup(created.tabId, groupId)
    await writeBackFlatOrder()
    requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
  }, [isElectron, sendBoundsImmediate, writeBackFlatOrder])

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
    handleReorderToRank,
    handleCreateGroup,
    handleAddToGroup,
    handleDeleteGroup,
    handleNewTabInGroup,
    handlePrint,
  }
}
