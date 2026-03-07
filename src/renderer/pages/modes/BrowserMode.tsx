import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { Globe, Plus, AlertTriangle, CheckCircle, RefreshCw, X, Trash2, ExternalLink, Clock } from 'lucide-react'
import BrowserTabBar from '../../components/browser/BrowserTabBar'
import BrowserAddressBar from '../../components/browser/BrowserAddressBar'
import { useMode } from '../../stores/useMode'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'

type PanelType = 'bookmarks' | 'downloads' | 'history' | null

interface BookmarkItem {
  id: string
  url: string
  title: string
  favicon: string | null
  created_at: number
}

interface HistoryItem {
  id: string
  url: string
  title: string
  favicon?: string | null
  domain?: string
  visit_count?: number
  last_visit_time?: number
  visited_at: number
}

interface DownloadItem {
  id: string
  url: string
  filename: string
  save_path: string
  total_bytes: number
  received_bytes: number
  state: string
  mime_type?: string | null
  error?: string | null
  end_time?: number | null
  can_resume?: number
  created_at: number
}

interface TabUpdateEvent {
  type: 'title' | 'navigate' | 'loading' | 'error' | 'meta'
  tabId: string
  title?: string
  url?: string
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string
}

interface AdblockState {
  enabled: boolean
  previewEnabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

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
  const contentRef = useRef<HTMLDivElement>(null)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI
  const shownDomainsRef = useRef<Set<string>>(new Set())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boundsRafRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const lastSentBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastBoundsSentAtRef = useRef(0)
  const layoutTransitionUntilRef = useRef(0)
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
    const result = await window.electronAPI?.browser?.getAdblockState()
    if (result?.success && result.data) {
      setAdblockState(result.data as AdblockState)
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

  // == Bounds management ==
  // BrowserView is a native OS-level overlay, NOT in the DOM.
  // We must keep its bounds pixel-perfect with the content area at all times.
  const sendBoundsImmediate = useCallback((options?: { forceExact?: boolean }) => {
    if (!isElectron || !contentRef.current) return
    const CHAT_PANEL_RESIZE_HANDLE_WIDTH = 4
    const rect = contentRef.current.getBoundingClientRect()
    const shellRect = contentRef.current.closest('[data-workbench-shell="true"]')?.getBoundingClientRect()
    const shellRight = shellRect?.right ?? window.innerWidth
    const chatPanelRect = document.querySelector<HTMLElement>('[data-chat-panel-root="true"]')?.getBoundingClientRect()
    const chatPanelVisuallyOccupiesSpace = Boolean(chatPanelRect && chatPanelRect.width > CHAT_PANEL_RESIZE_HANDLE_WIDTH + 1)
    const safeRightFromDom = chatPanelVisuallyOccupiesSpace && chatPanelRect
      ? chatPanelRect.left - CHAT_PANEL_RESIZE_HANDLE_WIDTH
      : Number.POSITIVE_INFINITY
    const safeRightFromState = chatPanelVisible
      ? shellRight - chatPanelWidth - CHAT_PANEL_RESIZE_HANDLE_WIDTH
      : shellRight
    const safeRight = chatPanelVisuallyOccupiesSpace
      ? Math.min(shellRight, safeRightFromDom)
      : Math.min(shellRight, safeRightFromState)
    const x = Math.round(rect.left)
    const y = Math.round(rect.top)
    const exactWidth = Math.round(Math.max(0, safeRight - rect.left))
    const height = Math.round(rect.height)
    if (exactWidth <= 0 || height <= 0) return

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const isManualResizing = document.body.classList.contains('resizing')
    const isLayoutTransitionActive = now < layoutTransitionUntilRef.current
    const shouldSoftenResize = !options?.forceExact && (isManualResizing || isLayoutTransitionActive)
    const widthStep = isManualResizing ? 24 : 36
    const minSendInterval = isManualResizing ? 28 : 42
    const width = shouldSoftenResize
      ? Math.max(1, Math.floor(exactWidth / widthStep) * widthStep || exactWidth)
      : exactWidth

    const last = lastSentBoundsRef.current
    if (shouldSoftenResize && last) {
      const widthDelta = Math.abs(width - last.width)
      const xDelta = Math.abs(x - last.x)
      const elapsed = now - lastBoundsSentAtRef.current
      if (elapsed < minSendInterval && widthDelta < widthStep && xDelta < 10) {
        return
      }
    }

    const boundsKey = `${x}:${y}:${width}:${height}`
    if (lastBoundsKeyRef.current === boundsKey) return
    lastBoundsKeyRef.current = boundsKey
    lastSentBoundsRef.current = { x, y, width, height }
    lastBoundsSentAtRef.current = now
    window.electronAPI?.browser?.updateBounds({
      x,
      y,
      width,
      height,
    })
  }, [chatPanelVisible, chatPanelWidth, isElectron])

  const sendBounds = useCallback((options?: { forceExact?: boolean }) => {
    if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null
      sendBoundsImmediate(options)
    })
  }, [sendBoundsImmediate])

  // Observe content area size changes + window resize
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      sendBounds()
    })
    observer.observe(el)
    const handleResize = () => sendBounds()
    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
      if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    }
  }, [sendBounds])

  // Layout transition sync: quantize live width updates during panel animation,
  // then send an exact correction once the layout settles.
  useEffect(() => {
    if (workbenchMode !== 'browser') return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    layoutTransitionUntilRef.current = now + 380
    if (document.body.classList.contains('resizing')) {
      sendBounds()
      return
    }
    const timers = [
      window.setTimeout(() => sendBounds(), 0),
      window.setTimeout(() => sendBounds(), 120),
      window.setTimeout(() => sendBounds(), 240),
      window.setTimeout(() => sendBounds({ forceExact: true }), 380),
    ]
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    activePanel,
    workbenchMode,
    sendBounds,
  ])

  // Show/hide BrowserView when workbenchMode changes
  useEffect(() => {
    if (!isElectron) return
    if (workbenchMode === 'browser') {
      window.electronAPI?.browser?.showActive()
      // Delay first bounds send slightly to let layout settle
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
    } else {
      window.electronAPI?.browser?.hideAll()
    }
  }, [workbenchMode, isElectron, sendBoundsImmediate])

  // Only hide BrowserView for true full-page error states.
  const hasError = !!activeTab?.error
  useEffect(() => {
    if (!isElectron || workbenchMode !== 'browser') return
    if (hasError) {
      window.electronAPI?.browser?.hideAll()
    } else {
      window.electronAPI?.browser?.showActive()
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
    }
  }, [hasError, isElectron, workbenchMode, sendBoundsImmediate])

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
      if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
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

      {/* Loading bar — placed OUTSIDE contentRef so it renders above native BrowserView */}
      {activeTab?.loading && (
        <div className="h-0.5 flex-shrink-0 relative overflow-hidden" style={{ background: 'var(--border-default)' }}>
          <div
            className="h-full rounded-r absolute top-0 left-0"
            style={{
              background: 'var(--color-blue)',
              animation: 'browserContentProgress 1.5s ease-in-out infinite',
            }}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Browser Content Area — BrowserView renders here natively */}
        <div
          ref={contentRef}
          className="relative min-w-0 flex-1"
          onDragOver={handleContentDragOver}
          onDrop={handleContentDrop}
        >
          {/* BrowserView is positioned by Electron over this area */}
          {!isElectron && (
            <div className="absolute inset-0 flex items-center justify-center text-[var(--text-light)]">
              <div className="text-center">
                <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-[13px]">Browser requires Electron environment</p>
              </div>
            </div>
          )}

          {/* Error page overlay — BrowserView is hidden via useEffect when error is active */}
          {activeTab?.error && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: 'var(--bg-content)' }}
            >
              <div className="text-center" style={{ maxWidth: 360 }}>
                <AlertTriangle
                  className="mx-auto mb-4"
                  style={{ width: 48, height: 48, color: 'var(--color-orange)' }}
                  strokeWidth={1.5}
                />
                <p className="text-[15px] font-medium mb-2" style={{ color: 'var(--text-title)' }}>
                  Page failed to load
                </p>
                <p className="text-[12px] mb-4" style={{ color: 'var(--text-gray)', lineHeight: 1.6 }}>
                  {activeTab.error}
                </p>
                <button
                  onClick={handleRetry}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors hover:bg-[var(--color-blue-light)]"
                  style={{
                    color: 'var(--color-blue)',
                    fontSize: 13,
                    border: '1px solid var(--color-blue)',
                    background: 'transparent',
                  }}
                >
                  <RefreshCw style={{ width: 14, height: 14 }} strokeWidth={2} />
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Task 7: Cookie persistence toast */}
          {toastVisible && (
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--surface-floating-bg)',
                color: 'var(--text-body)',
                padding: '8px 16px',
                borderRadius: 8,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                zIndex: 30,
                animation: 'cookieToastFade 3s ease-in-out forwards',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                border: '1px solid var(--surface-border)',
                backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
                WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
              }}
            >
              <CheckCircle
                style={{ width: 16, height: 16, color: 'var(--color-green)', flexShrink: 0 }}
                strokeWidth={2}
              />
              已保存登录状态
            </div>
          )}
        </div>

        {activePanel && (
          <aside
            className="content-surface-panel flex h-full w-[320px] flex-shrink-0 flex-col overflow-hidden border-l"
            style={{
              borderColor: 'var(--border-default)',
              background: 'var(--surface-panel-bg)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div
              className="glass-surface-panel flex items-center justify-between"
              style={{
                padding: '10px 14px',
                background: 'var(--surface-toolbar-bg)',
                borderBottom: '1px solid var(--border-default)',
              }}
            >
              <div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
                  {activePanel === 'bookmarks' ? '收藏夹' : activePanel === 'downloads' ? '下载' : '历史记录'}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                  {activePanel === 'bookmarks'
                    ? `${bookmarks.length} 条收藏`
                    : activePanel === 'downloads'
                      ? `${downloads.length} 条下载`
                      : `${historyItems.length} 条记录`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activePanel === 'bookmarks' && selectedBookmarkUrl && (
                  <>
                    <button
                      onClick={() => void handleNavigateFromPanel(selectedBookmarkUrl)}
                      className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--color-blue)' }}
                    >
                      打开
                    </button>
                    <button
                      onClick={() => void handleRemoveBookmark(selectedBookmarkUrl)}
                      className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--color-red)' }}
                    >
                      移除
                    </button>
                  </>
                )}
                {activePanel === 'history' && historyItems.length > 0 && (
                  <button
                    onClick={handleClearHistory}
                    className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--color-red)' }}
                  >
                    清空
                  </button>
                )}
                {activePanel === 'downloads' && downloads.length > 0 && (
                  <button
                    onClick={handleClearDownloads}
                    className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--color-red)' }}
                  >
                    清空
                  </button>
                )}
                <button
                  onClick={() => setActivePanel(null)}
                  className="flex items-center justify-center rounded hover:bg-[var(--bg-hover)] transition-colors"
                  style={{ width: 22, height: 22 }}
                >
                  <X style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                </button>
              </div>
            </div>

            <div
              className="flex items-center justify-between border-b px-3 py-2"
              style={{
                borderColor: 'var(--border-default)',
                background: 'var(--surface-card-bg)',
              }}
            >
              <div>
                <div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Adblock
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                  {adblockState.enabled ? '已开启' : '已关闭'} · 已拦截 {adblockState.networkBlockedCount} 次
                </div>
              </div>
              <button
                onClick={handleToggleAdblock}
                className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: adblockState.enabled ? 'var(--color-blue)' : 'var(--color-orange)' }}
              >
                {adblockState.enabled ? '关闭' : '开启'}
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {activePanel === 'bookmarks' && (
                bookmarks.length === 0 ? (
                  <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
                    <div className="text-center">
                      <Globe className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                      <p className="text-[12px]">暂无收藏</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-2">
                    {bookmarks.map((item) => {
                      const isSelected = selectedBookmarkUrl === item.url
                      return (
                        <div
                          key={item.id}
                          className="mb-1 cursor-pointer rounded-[10px] border px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                          style={{
                            borderColor: isSelected ? 'var(--color-blue)' : 'transparent',
                            background: isSelected ? 'var(--color-blue-light)' : 'transparent',
                          }}
                          onClick={() => setSelectedBookmarkUrl(item.url)}
                          onDoubleClick={() => void handleNavigateFromPanel(item.url)}
                        >
                          <div className="flex items-center gap-3">
                            <Globe style={{ width: 14, height: 14, flexShrink: 0 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.title}</div>
                              <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>{item.url}</div>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              )}

              {activePanel === 'history' && (
                historyItems.length === 0 ? (
                  <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
                    <div className="text-center">
                      <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                      <p className="text-[12px]">暂无历史记录</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-2">
                    {historyItems.map(item => (
                      <div
                        key={item.id}
                        className="mb-1 flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                        onClick={() => void handleNavigateFromPanel(item.url)}
                      >
                        <Globe style={{ width: 14, height: 14, flexShrink: 0 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.title}</div>
                          <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>{item.url}</div>
                        </div>
                        <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-light)' }}>
                          {new Date((item.last_visit_time || item.visited_at) * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}

              {activePanel === 'downloads' && (
                downloads.length === 0 ? (
                  <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
                    <div className="text-center">
                      <ExternalLink className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                      <p className="text-[12px]">暂无下载</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-2">
                    {downloads.map(item => (
                      <div
                        key={item.id}
                        className="mb-1 rounded-[10px] px-3 py-2"
                        style={{ background: 'var(--surface-card-bg)' }}
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.filename}</div>
                            <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>
                              {item.state === 'completed' ? '已完成' : item.state === 'cancelled' ? '已取消' : '下载中...'}
                              {item.total_bytes > 0 && ` · ${(item.total_bytes / 1024 / 1024).toFixed(1)} MB`}
                              {item.mime_type ? ` · ${item.mime_type}` : ''}
                            </div>
                            {item.error && (
                              <div className="truncate text-[10px]" style={{ color: 'var(--color-red)' }}>
                                {item.error}
                              </div>
                            )}
                          </div>
                          <span
                            className="text-[10px] flex-shrink-0 px-2 py-0.5 rounded-full"
                            style={{
                              background: item.state === 'completed' ? 'var(--color-green-light)' : 'var(--bg-canvas)',
                              color: item.state === 'completed' ? 'var(--color-green)' : 'var(--text-light)',
                            }}
                          >
                            {item.state === 'completed' ? '完成' : item.state === 'cancelled' ? '取消' : `${Math.round((item.received_bytes / Math.max(item.total_bytes, 1)) * 100)}%`}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </aside>
        )}

        <style>{`
          @keyframes browserContentProgress {
            0% { width: 5%; }
            50% { width: 65%; }
            100% { width: 95%; }
          }
          @keyframes cookieToastFade {
            0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
            10% { opacity: 1; transform: translateX(-50%) translateY(0); }
            80% { opacity: 1; transform: translateX(-50%) translateY(0); }
            100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
          }
        `}</style>
      </div>
    </div>
  )
}
