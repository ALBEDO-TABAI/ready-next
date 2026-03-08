import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { Globe, Plus } from 'lucide-react'
import BrowserTabBar from '../../components/browser/BrowserTabBar'
import BrowserAddressBar from '../../components/browser/BrowserAddressBar'
import BrowserShellLayout from '../../components/browser/BrowserShellLayout'
import { useBrowserViewBounds } from '../../modules/browser/useBrowserViewBounds'
import type {
  AdblockState,
  BrowserDiagnosticsData,
  BookmarkItem,
  DownloadItem,
  HistoryItem,
  PanelType,
  TabUpdateEvent,
} from '../../modules/browser/types'
import { useMode } from '../../stores/useMode'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'

const DEFAULT_URL = 'https://gemini.google.com'
const SEARCH_URL = 'https://www.google.com/search?q='

// Task 7: Domains that commonly require login — toast shown after load completes
const LOGIN_DOMAINS = [
  'google.com', 'youtube.com', 'github.com', 'twitter.com', 'x.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'notion.so',
  'slack.com', 'discord.com', 'reddit.com', 'amazon.com', 'netflix.com',
  'bilibili.com', 'zhihu.com', 'weibo.com', 'taobao.com', 'jd.com',
  'douyin.com', 'baidu.com', 'feishu.cn', 'dingtalk.com',
]

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname
    const parts = hostname.split('.')
    if (parts.length >= 2) return parts.slice(-2).join('.')
    return hostname
  } catch {
    return ''
  }
}

function isLikelyAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

export default function BrowserMode() {
  // Persistent browser tab state — survives mode switches
  const {
    tabs, activeTabId, urlInput,
    setTabs, setActiveTabId, setUrlInput,
    addTab, updateTab, reorderTabs,
  } = useBrowserTabs()
  const [toastVisible, setToastVisible] = useState(false)
  const [activePanel, setActivePanel] = useState<PanelType>(null)
  const [isAddressEditing, setIsAddressEditing] = useState(false)
  const [isBookmarked, setIsBookmarked] = useState(false)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [selectedBookmarkUrl, setSelectedBookmarkUrl] = useState('')
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [adblockState, setAdblockState] = useState<AdblockState>({
    enabled: true,
    previewEnabled: true,
    whitelistDomains: [],
    rulesVersion: 'ready-basic-ads-v1',
    networkBlockedCount: 0,
    lastUpdatedAt: null,
  })
  const [browserDiagnostics, setBrowserDiagnostics] = useState<BrowserDiagnosticsData | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI
  const shownDomainsRef = useRef<Set<string>>(new Set())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevLoadingRef = useRef<Record<string, boolean>>({})

  const workbenchMode = useMode(s => s.workbenchMode)
  const sidebarVisible = useWorkspace(s => s.sidebarVisible)
  const sidePanelVariant = useWorkspace(s => s.sidePanelVariant)
  const sidePanelWidths = useWorkspace(s => s.sidePanelWidths)
  const skillsSplitRatio = useWorkspace(s => s.skillsSplitRatio)
  const chatPanelVisible = useWorkspace(s => s.chatPanelVisible)
  const chatPanelWidth = useWorkspace(s => s.chatPanelWidth)
  const effectiveSidePanelWidth = useMemo(() => {
    if (sidePanelVariant === 'skills') return sidePanelWidths.skills
    if (sidePanelVariant === 'search') return sidePanelWidths.search
    return sidePanelWidths.files
  }, [sidePanelVariant, sidePanelWidths.files, sidePanelWidths.search, sidePanelWidths.skills])
  const activeTab = tabs.find(t => t.id === activeTabId) || null
  const currentDomain = activeTab?.domain || extractDomain(activeTab?.url || '')
  const currentDomainAdblockWhitelisted = useMemo(() => {
    if (!currentDomain) return false
    return adblockState.whitelistDomains.some((domain) => currentDomain === domain || currentDomain.endsWith(`.${domain}`))
  }, [adblockState.whitelistDomains, currentDomain])
  const hasError = !!activeTab?.error
  const { sendBounds, sendBoundsImmediate } = useBrowserViewBounds({
    isElectron,
    contentRef,
    workbenchMode,
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    activePanel,
    hasError,
  })

  // URL helpers — auto-Google for non-URL input (Task 2)
  const normalizeUrl = useCallback((input: string): string => {
    const trimmed = input.trim()
    if (!trimmed) return DEFAULT_URL
    if (trimmed.startsWith('file://')) return trimmed
    if (trimmed.startsWith('local-file://')) {
      const rawPath = decodeURIComponent(trimmed.replace(/^local-file:\/\//, ''))
      return toFileUrl(rawPath)
    }
    if (isLikelyAbsolutePath(trimmed)) return toFileUrl(trimmed)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
    return `${SEARCH_URL}${encodeURIComponent(trimmed)}`
  }, [])

  // == Bookmark, History, Downloads, Print ==

  // Check if current URL is bookmarked
  useEffect(() => {
    if (!isElectron || !activeTab?.url) { setIsBookmarked(false); return }
    window.electronAPI?.browser?.isBookmarked(activeTab.url).then((res) => {
      setIsBookmarked(res?.bookmarked || false)
    })
  }, [isElectron, activeTab?.url])

  const handleToggleBookmark = useCallback(async () => {
    if (!isElectron || !activeTab) return
    if (isBookmarked) {
      await window.electronAPI?.browser?.removeBookmark(activeTab.url)
      setIsBookmarked(false)
    } else {
      await window.electronAPI?.browser?.addBookmark(activeTab.url, activeTab.title || activeTab.url)
      setIsBookmarked(true)
    }
    if (activePanel === 'bookmarks') {
      const res = await window.electronAPI?.browser?.getBookmarks()
      if (res?.success && res.data) setBookmarks(res.data as BookmarkItem[])
    }
  }, [isElectron, activePanel, activeTab, isBookmarked])

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
  }, [activePanel, isElectron, selectedBookmarkUrl])

  const handlePrint = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    await window.electronAPI?.browser?.print(activeTabId)
  }, [isElectron, activeTabId])

  const handleNavigateFromPanel = useCallback(async (url: string) => {
    if (!isElectron || !activeTabId) return
    updateTab(activeTabId, { url, loading: true, error: undefined })
    setUrlInput(url)
    setActivePanel(null)
    await window.electronAPI?.browser?.navigate(activeTabId, url)
  }, [isElectron, activeTabId, updateTab, setUrlInput])

  const handleRemoveBookmark = useCallback(async (url: string) => {
    if (!isElectron) return
    await window.electronAPI?.browser?.removeBookmark(url)
    setBookmarks(prev => prev.filter(b => b.url !== url))
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

  const refreshAdblockState = useCallback(async () => {
    if (!isElectron) return
    const [adblockResult, diagnosticsResult] = await Promise.all([
      window.electronAPI?.browser?.getAdblockState(),
      window.electronAPI?.browser?.getDiagnostics?.(),
    ])
    if (adblockResult?.success && adblockResult.data) {
      setAdblockState(adblockResult.data as AdblockState)
    }
    if (diagnosticsResult?.success && diagnosticsResult.data) {
      setBrowserDiagnostics(diagnosticsResult.data as BrowserDiagnosticsData)
    }
  }, [isElectron])

  const handleToggleAdblock = useCallback(async () => {
    if (!isElectron) return
    const result = await window.electronAPI?.browser?.setAdblockEnabled(!adblockState.enabled, 'all')
    if (result?.success && result.data) {
      setAdblockState(result.data as AdblockState)
    }
  }, [adblockState.enabled, isElectron])

  const handleToggleCurrentSiteAdblock = useCallback(async () => {
    if (!isElectron || !currentDomain) return
    const result = await window.electronAPI?.browser?.toggleAdblockDomain(currentDomain)
    if (result?.success && result.data) {
      setAdblockState(result.data as AdblockState)
    }
  }, [currentDomain, isElectron])

  // == IPC-driven tab operations ==

  const handleNewTab = useCallback(async () => {
    if (!isElectron) return
    const result = await window.electronAPI?.browser?.createTab(DEFAULT_URL) as { success: boolean; tabId?: string } | undefined
    if (result?.success && result.tabId) {
      const newTab: BrowserTab = {
        id: result.tabId,
        url: DEFAULT_URL,
        title: 'New Tab',
        loading: true,
        canGoBack: false,
        canGoForward: false,
        domain: extractDomain(DEFAULT_URL),
        owner: 'manual',
        required: false,
        activity: 'idle',
      }
      addTab(newTab)
      setActiveTabId(result.tabId)
      setUrlInput('')
      // Update bounds after rendering
      requestAnimationFrame(() => sendBounds())
    }
  }, [isElectron, addTab, setActiveTabId, setUrlInput]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCloseTab = useCallback(async (id: string) => {
    if (!isElectron) return
    await window.electronAPI?.browser?.closeTab(id)
    const { tabs: currentTabs, activeTabId: currentActive } = useBrowserTabs.getState()
    const remaining = currentTabs.filter(t => t.id !== id)
    if (id === currentActive) {
      if (remaining.length > 0) {
        const nextTab = remaining[remaining.length - 1]
        setActiveTabId(nextTab.id)
        setUrlInput(nextTab.url === DEFAULT_URL ? '' : nextTab.url)
      } else {
        setActiveTabId(null)
        setUrlInput('')
      }
    }
    setTabs(remaining)
  }, [isElectron, setTabs, setActiveTabId, setUrlInput])

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
      const tab = currentTabs.find(t => t.id === id)
      if (tab) setUrlInput(tab.url === DEFAULT_URL ? '' : tab.url)
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
    }
  }, [isElectron, setActiveTabId, setUrlInput, updateTab])

  const handleNavigate = useCallback(async (url?: string) => {
    if (!isElectron || !activeTabId) return
    const { urlInput: currentInput } = useBrowserTabs.getState()
    const targetUrl = normalizeUrl(url || currentInput)
    updateTab(activeTabId, { url: targetUrl, loading: true, error: undefined })
    setUrlInput(targetUrl)
    await window.electronAPI?.browser?.navigate(activeTabId, targetUrl)
  }, [isElectron, activeTabId, normalizeUrl, updateTab, setUrlInput])

  const handleContentDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleContentDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length > 0) {
      e.preventDefault()
      void handleNavigate(toFileUrl(droppedFiles[0].path))
      return
    }

    const rawText = e.dataTransfer.getData('text/plain')?.trim()
    if (!rawText) return
    e.preventDefault()
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

  // Task 6: Retry after load error
  const handleRetry = useCallback(async () => {
    if (!isElectron || !activeTabId) return
    const { tabs: currentTabs } = useBrowserTabs.getState()
    const tab = currentTabs.find(t => t.id === activeTabId)
    if (tab) {
      updateTab(activeTabId, { loading: true, error: undefined })
      await window.electronAPI?.browser?.navigate(activeTabId, tab.url)
    }
  }, [isElectron, activeTabId, updateTab])

  const handleUrlFocus = useCallback(() => {
    if (activeTab) {
      setUrlInput(activeTab.url === DEFAULT_URL ? '' : activeTab.url)
    }
  }, [activeTab, setUrlInput])

  const handleUrlBlur = useCallback(() => {
    const current = useBrowserTabs.getState()
    const tab = current.tabs.find((item) => item.id === current.activeTabId)
    if (!tab) return
    current.setUrlInput(tab.url === DEFAULT_URL ? '' : tab.url)
  }, [])

  const handleOpenExternal = useCallback(() => {
    if (activeTab) window.open(activeTab.url, '_blank')
  }, [activeTab])

  // Tab drag reorder (Task 3)
  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    reorderTabs(fromIndex, toIndex)
  }, [reorderTabs])

  // Task 6: Listen to tab update events from backend
  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onTabUpdate((data: unknown) => {
      const event = data as TabUpdateEvent
      const store = useBrowserTabs.getState()
      switch (event.type) {
        case 'title':
          store.updateTab(event.tabId, { title: event.title || '' })
          break
        case 'navigate':
          store.updateTab(event.tabId, {
            url: event.url || '',
            domain: event.domain,
            canGoBack: event.canGoBack || false,
            canGoForward: event.canGoForward || false,
            error: undefined,
          })
          // If this is the active tab, sync URL input
          if (store.activeTabId === event.tabId && event.url && !isAddressEditing) {
            store.setUrlInput(event.url === DEFAULT_URL ? '' : event.url)
          }
          break
        case 'loading':
          store.updateTab(event.tabId, { loading: event.loading || false })
          break
        case 'error':
          store.updateTab(event.tabId, {
            loading: false,
            error: event.error || 'Page failed to load',
          })
          break
        case 'meta':
          store.updateTab(event.tabId, {
            domain: event.domain,
            favicon: event.favicon || undefined,
            owner: event.owner,
            required: event.required,
            activity: event.activity,
            lastAuditedAt: event.lastAuditedAt,
          })
          break
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, isAddressEditing])

  // Listen for new-tab requests from main process (middle-click / target=_blank)
  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onNewTabRequest(async (url: string) => {
      const result = await window.electronAPI?.browser?.createTab(url) as { success: boolean; tabId?: string } | undefined
      if (result?.success && result.tabId) {
        const newTab: BrowserTab = {
          id: result.tabId,
          url,
          title: 'Loading...',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          domain: extractDomain(url),
          owner: 'manual',
          required: false,
          activity: 'idle',
        }
        useBrowserTabs.getState().addTab(newTab)
        useBrowserTabs.getState().setActiveTabId(result.tabId)
        useBrowserTabs.getState().setUrlInput(url === DEFAULT_URL ? '' : url)
        requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, sendBoundsImmediate])

  useEffect(() => {
    if (!isElectron) return
    void refreshAdblockState()
    const cleanup = window.electronAPI?.browser?.onAdblockUpdate((data: unknown) => {
      setAdblockState(data as AdblockState)
    })
    return () => { cleanup?.() }
  }, [isElectron, refreshAdblockState])

  useEffect(() => {
    if (!isElectron) return
    void window.electronAPI?.browser?.getDiagnostics?.().then((result) => {
      if (result?.success && result.data) {
        setBrowserDiagnostics(result.data as BrowserDiagnosticsData)
      }
    })
  }, [isElectron, activeTabId, tabs.length, adblockState.networkBlockedCount])

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

  // Task 7: Cookie persistence toast — show after loading completes on login domains
  useEffect(() => {
    tabs.forEach(tab => {
      const wasLoading = prevLoadingRef.current[tab.id]
      // Detect loading transition: true → false, no error
      if (wasLoading && !tab.loading && !tab.error) {
        const domain = extractDomain(tab.url)
        if (
          domain &&
          LOGIN_DOMAINS.some(d => domain === d || domain.endsWith('.' + d)) &&
          !shownDomainsRef.current.has(domain)
        ) {
          shownDomainsRef.current.add(domain)
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          setToastVisible(true)
          toastTimerRef.current = setTimeout(() => {
            setToastVisible(false)
            toastTimerRef.current = null
          }, 3000)
        }
      }
      prevLoadingRef.current[tab.id] = tab.loading
    })
  }, [tabs])

  // On mount: show BrowserView, create initial tab only if none exist yet.
  // When re-mounting (switching back to browser mode), tabs persist in Zustand store
  // so we just need to re-show the active BrowserView and re-sync the URL input.
  useEffect(() => {
    if (!isElectron) return
    const { tabs: currentTabs, activeTabId: currentActive } = useBrowserTabs.getState()
    if (currentTabs.length === 0) {
      handleNewTab()
    } else {
      if (currentActive) {
        window.electronAPI?.browser?.switchTab(currentActive)
      } else {
        window.electronAPI?.browser?.showActive()
      }
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
    }
    return () => {
      // Only hide BrowserView on unmount — tab state persists in store
      window.electronAPI?.browser?.hideAll()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Task 4: Empty state — no tabs
  if (tabs.length === 0) {
    return (
      <div className="workbench-mode-root">
        {/* Tab bar with only the + button */}
        <div
          className="glass-surface-panel flex items-center no-drag"
          style={{
            height: 34,
            padding: '0 8px',
            background: 'var(--surface-toolbar-bg)',
            borderBottom: '1px solid var(--border-default)',
          }}
        >
          <button
            onClick={handleNewTab}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors"
            style={{ width: 26, height: 26, borderRadius: 6 }}
            title="新建标签页"
          >
            <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>

        {/* Empty state content */}
        <div className="flex-1 flex items-center justify-center text-[var(--text-light)]">
          <div className="text-center">
            <Globe className="w-16 h-16 mx-auto mb-4 opacity-20" strokeWidth={1.5} />
            <p className="text-[14px] font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
              当前没有打开的标签页
            </p>
            <button
              onClick={handleNewTab}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors hover:bg-[var(--color-blue-light)]"
              style={{
                color: 'var(--color-blue)',
                fontSize: 13,
                border: '1px solid var(--color-blue)',
                background: 'transparent',
              }}
            >
              <Plus style={{ width: 14, height: 14 }} strokeWidth={2} />
              点击 + 新建标签页
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="workbench-mode-root">
      {/* Task 1: UnifiedTabBar — 34px height, favicon+title+star+close, active blue indicator, + new tab */}
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabClick={handleTabClick}
        onTabClose={handleCloseTab}
        onNewTab={handleNewTab}
        onReorder={handleReorder}
      />

      {/* Address bar with all toolbar buttons */}
      <BrowserAddressBar
        url={activeTab?.url || ''}
        urlInput={urlInput}
        loading={activeTab?.loading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isBookmarked={isBookmarked}
        adblockEnabled={adblockState.enabled}
        adblockDomainWhitelisted={currentDomainAdblockWhitelisted}
        currentDomain={currentDomain}
        activePanel={activePanel}
        onUrlChange={setUrlInput}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onRefresh={handleRefresh}
        onFocus={handleUrlFocus}
        onBlur={handleUrlBlur}
        onEditStart={() => setIsAddressEditing(true)}
        onEditEnd={() => setIsAddressEditing(false)}
        onOpenExternal={handleOpenExternal}
        onToggleBookmark={handleToggleBookmark}
        onToggleAdblock={handleToggleAdblock}
        onToggleCurrentSiteAdblock={handleToggleCurrentSiteAdblock}
        onTogglePanel={handleTogglePanel}
        onPrint={handlePrint}
      />

      <BrowserShellLayout
        isElectron={isElectron}
        contentRef={contentRef}
        activeTab={activeTab}
        activePanel={activePanel}
        bookmarks={bookmarks}
        selectedBookmarkUrl={selectedBookmarkUrl}
        historyItems={historyItems}
        downloads={downloads}
        adblockState={adblockState}
        browserDiagnostics={browserDiagnostics}
        toastVisible={toastVisible}
        currentDomain={currentDomain}
        currentDomainAdblockWhitelisted={currentDomainAdblockWhitelisted}
        onDragOver={handleContentDragOver}
        onDrop={handleContentDrop}
        onRetry={() => void handleRetry()}
        onClosePanel={() => setActivePanel(null)}
        onNavigateFromPanel={(url) => void handleNavigateFromPanel(url)}
        onRemoveBookmark={(url) => void handleRemoveBookmark(url)}
        onClearHistory={() => void handleClearHistory()}
        onClearDownloads={() => void handleClearDownloads()}
        onSelectBookmark={setSelectedBookmarkUrl}
        onToggleAdblock={() => void handleToggleAdblock()}
        onRefreshAdblock={() => void refreshAdblockState()}
        onSyncBounds={() => sendBoundsImmediate({ forceExact: true })}
      />
    </div>
  )
}
