import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BrowserModeEmptyState from '../../components/browser/BrowserModeEmptyState'
import BrowserDiagnosticsDock from '../../components/browser/BrowserDiagnosticsDock'
import { AgentBrowserSupervisionPanel } from '../../components/browser/AgentBrowserSupervisionPanel'
import BrowserTopBar from '../../components/browser/BrowserTopBar'
import VerticalTabRail, { BROWSER_VERTICAL_RAIL_WIDTH } from '../../components/browser/VerticalTabRail'
import BrowserShellLayout from '../../components/browser/BrowserShellLayout'
import { isBrowserSupervisionVisibleTaskStatus } from '../../../shared/browser-task-status'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { useBrowserDiagnosticsState } from '../../modules/browser/useBrowserDiagnosticsState'
import { useBrowserPanelData } from '../../modules/browser/useBrowserPanelData'
import { useBrowserResizeFreeze } from '../../modules/browser/useBrowserResizeFreeze'
import { useBrowserRuntimeEffects } from '../../modules/browser/useBrowserRuntimeEffects'
import { useAgentBrowserSupervision } from '../../modules/browser/useAgentBrowserSupervision'
import { resolveBrowserOwnershipStatus } from '../../modules/browser/browserOwnershipStatus'
import { useBrowserTabActions } from '../../modules/browser/useBrowserTabActions'
import { getBrowserTabFitKey, isFitted, markFitted } from '../../modules/browser/browserTabFitRegistry'
import { planBrowserHostPresentation } from '../../modules/browser/browserHostPresentation'
import { useBrowserViewBounds } from '../../modules/browser/useBrowserViewBounds'
import {
  DEFAULT_BROWSER_URL,
  extractBrowserDomain,
  isReadyBrowserBlankUrl,
  normalizeBrowserUrlInput,
} from '../../modules/browser/url-utils'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useFastCard } from '../../stores/useFastCard'
import { toFileUrl } from '../../utils/dragDrop'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'
import type { BrowserLockOverlaySnapshot } from '../../../shared/browser-lock-overlay'
import {
  buildFastCardItemTags,
  createFastCardId,
  createFastCardMarkdownFilename,
  detectFastCardTargetLanguage,
  renderFastCardMarkdown,
  type BrowserFastCardContextActionEvent,
  type BrowserFastCardImageTarget,
  type BrowserFastCardTarget,
  type BrowserFastCardTextTarget,
  type BrowserFastCardVideoTarget,
  type FastCardOverlayCommand,
  type FastCardOverlaySnapshot,
  type FastCardItem,
  type FastCardResultPanelData,
  type FastCardSource,
  type FastCardVideoMeta,
} from '../../../shared/fastcard'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import { useRafResizeDrag } from '../../modules/workbench/useRafResizeDrag'

// 模式切换的仪式化遮罩接管了"离开浏览器时的截图"这一职责。
// 本组件只需保留 resize 期间的 captureStableFrame 作为 BrowserView 就绪信号。

interface BrowserModeProps {
  isActive?: boolean
  isMotionSettled?: boolean
  layoutPhase?: BrowserHostLayoutPhase
}

function clampBrowserSplitRatio(ratio: number): number {
  return Math.max(20, Math.min(80, ratio))
}

function BrowserSplitResizeHandle({
  onResize,
  onResizeStateChange,
}: {
  onResize: (delta: number) => void
  onResizeStateChange?: (resizing: boolean) => void
}) {
  const handleMouseDown = useRafResizeDrag({
    onDelta: onResize,
    onResizeStateChange,
    dispatchPanelResizeEvent: true,
  })
  return (
    <div
      className="browser-split-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整浏览器双开宽度"
      onMouseDown={handleMouseDown}
    >
      <span className="browser-split-resize-handle__grip" aria-hidden="true" />
    </div>
  )
}

function fastCardSourceFromTarget(target: BrowserFastCardTarget): FastCardSource {
  return {
    pageUrl: target.pageUrl,
    pageTitle: target.pageTitle,
    domain: target.domain || extractBrowserDomain(target.pageUrl || ''),
    tabId: target.tabId,
    capturedAt: target.capturedAt,
  }
}

function finalizeFastCardItem(item: Omit<FastCardItem, 'tags'>): FastCardItem {
  const withTags: FastCardItem = item
  return { ...withTags, tags: buildFastCardItemTags(withTags) }
}

function createTextFastCardItem(target: BrowserFastCardTextTarget): FastCardItem {
  return finalizeFastCardItem({
    id: createFastCardId('text'),
    kind: 'text',
    createdAt: Date.now(),
    text: target.text,
    title: '文字',
    source: fastCardSourceFromTarget(target),
  })
}

function createImageFastCardItem(target: BrowserFastCardImageTarget): FastCardItem {
  return finalizeFastCardItem({
    id: createFastCardId('image'),
    kind: 'image',
    createdAt: Date.now(),
    imageUrl: target.imageUrl,
    alt: target.alt,
    caption: target.caption,
    title: target.caption || target.alt || '图片',
    source: fastCardSourceFromTarget(target),
  })
}

function createVideoFastCardItem(target: BrowserFastCardVideoTarget, video: FastCardVideoMeta): FastCardItem {
  return finalizeFastCardItem({
    id: createFastCardId('video'),
    kind: 'video',
    createdAt: Date.now(),
    title: video.title || target.title || target.pageTitle || '视频',
    source: fastCardSourceFromTarget(target),
    video,
  })
}

export default function BrowserMode({
  isActive = true,
  isMotionSettled = true,
  layoutPhase = 'idle',
}: BrowserModeProps) {
  // Persistent browser tab state — survives mode switches
  const {
    tabs, activeTabId, splitTabId, browserSplitRatio, urlInput,
    setTabs, setActiveTabId, setUrlInput,
    setSplitTabId, setBrowserSplitRatio,
    addTab, updateTab, reorderTabs,
  } = useBrowserTabs()
  const [isBrowserSurfaceReady, setIsBrowserSurfaceReady] = useState(false)
  const isAddressEditingRef = useRef(false)
  const hostVisibleRef = useRef(false)
  const hostPresentedRef = useRef(false)
  const surfaceReadyTimerRef = useRef<number | null>(null)
  const postActivationHostResyncTimerRef = useRef<number | null>(null)
  const localMediaUploadStatusTimerRef = useRef<number | null>(null)
  const captureTokenConsumedRef = useRef(false)
  const captureTokenExpiryTimerRef = useRef<number | null>(null)
  const wasActiveRef = useRef<boolean>(isActive)
  const modeRootRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const browserContentFrameRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const splitContentRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const primarySplitPaneRef = useRef<HTMLDivElement>(null)
  const browserSplitRatioRef = useRef(browserSplitRatio)
  const liveBrowserSplitRatioRef = useRef(browserSplitRatio)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI

  const sidebarVisible = useWorkspace(s => s.sidebarVisible)
  const sidePanelVariant = useWorkspace(s => s.sidePanelVariant)
  const sidePanelWidths = useWorkspace(s => s.sidePanelWidths)
  const skillsSplitRatio = useWorkspace(s => s.skillsSplitRatio)
  const chatPanelVisible = useWorkspace(s => s.chatPanelVisible)
  const chatPanelWidth = useWorkspace(s => s.chatPanelWidth)
  const effectiveSidePanelWidth = sidePanelWidths.shared
  const agentSupervision = useAgentBrowserSupervision()
  const [agentPaneCollapsed, setAgentPaneCollapsed] = useState(false)
  const [dismissedAgentTaskId, setDismissedAgentTaskId] = useState<string | null>(null)
  const lastAgentPaneTaskIdRef = useRef<string | null>(null)
  const activeTab = tabs.find(t => t.id === activeTabId) || null
  const splitTab = splitTabId && splitTabId !== activeTabId ? tabs.find(t => t.id === splitTabId) || null : null
  const activeAgentTasks = agentSupervision.tasks.filter((task) => isBrowserSupervisionVisibleTaskStatus(task.status))
  const browserOwnershipStatus = useMemo(() => resolveBrowserOwnershipStatus({
    activeTab,
    agentTabId: agentSupervision.agentTabId,
    activeAgentTaskCount: activeAgentTasks.length,
    controlState: agentSupervision.controlState,
    surfaces: agentSupervision.surfaces,
    activeWriteSurface: agentSupervision.activeWriteSurface,
  }), [activeAgentTasks.length, activeTab, agentSupervision.activeWriteSurface, agentSupervision.agentTabId, agentSupervision.controlState, agentSupervision.surfaces])
  const visibleAgentTask = activeAgentTasks[0] || null
  const agentRuntimeTab = agentSupervision.agentTabId
    ? tabs.find(t => t.id === agentSupervision.agentTabId) || null
    : null
  const agentPaneTaskId = visibleAgentTask?.taskId || (agentRuntimeTab?.activity === 'running' && agentSupervision.agentTabId
    ? `agent-tab:${agentSupervision.agentTabId}`
    : null)
  const agentPaneVisible = Boolean(agentSupervision.agentTabId && agentPaneTaskId && agentPaneTaskId !== dismissedAgentTaskId)
  const agentPaneOpen = agentPaneVisible && !agentPaneCollapsed
  const agentPaneCollapsedVisible = agentPaneVisible && agentPaneCollapsed
  const agentTab = agentPaneOpen ? agentRuntimeTab : null
  const visibleSplitTab = agentTab || splitTab
  const isAgentSplitVisible = Boolean(agentTab)
  const shouldRenderSplitLayout = Boolean(activeTab && (visibleSplitTab || agentPaneCollapsedVisible))
  const currentDomain = activeTab?.domain || extractBrowserDomain(activeTab?.url || '')
  const hasError = !!activeTab?.error
  const isReadyBlankTab = activeTab ? isReadyBrowserBlankUrl(activeTab.url) : false
  const splitTabHasNativeSurface = visibleSplitTab ? !visibleSplitTab.error && !isReadyBrowserBlankUrl(visibleSplitTab.url) : false
  const shouldHideAllBrowserHosts = (hasError || isReadyBlankTab) && !splitTabHasNativeSurface
  const fastCardItems = useFastCard(s => s.items)
  const fastCardPanelOpen = useFastCard(s => s.panelOpen && !s.collapsed)
  const addFastCardItem = useFastCard(s => s.addItem)
  const removeFastCardItem = useFastCard(s => s.removeItem)
  const clearFastCard = useFastCard(s => s.clear)
  const openFastCard = useFastCard(s => s.open)
  const collapseFastCard = useFastCard(s => s.collapse)
  const [fastCardResultPanel, setFastCardResultPanel] = useState<FastCardResultPanelData | null>(null)
  const [localMediaUploadStatus, setLocalMediaUploadStatus] = useState<{ kind: 'uploading' | 'success' | 'error'; message: string } | null>(null)
  const fastCardResultTargetRef = useRef<BrowserFastCardTarget | null>(null)
  const fastCardResultRequestIdRef = useRef(0)
  const setAddressEditing = useCallback((next: boolean) => {
    isAddressEditingRef.current = next
  }, [])
  const handleBrowserEditStart = useCallback(() => {
    setAddressEditing(true)
  }, [setAddressEditing])
  const handleBrowserEditEnd = useCallback(() => {
    setAddressEditing(false)
  }, [setAddressEditing])

  // === 分级显示策略 ===
  // Level 1: 准备层 - 只要当前模式是浏览器，就准备浏览器 Host（更新 bounds）
  const shouldPrepareBrowserHost = isActive
  // Level 2: 显示层 - 动画结束后才真正显示浏览器内容
  const shouldRevealBrowserHost = isActive && isMotionSettled
  const shouldPresentBrowserHost = isActive && isMotionSettled
  // Level 3: 就绪层 - 浏览器 surface 已准备好
  const isBrowserHostFullyVisible = shouldRevealBrowserHost && isBrowserSurfaceReady

  const { sendBoundsImmediate, syncBrowserVisibility } = useBrowserViewBounds({
    isElectron,
    contentRef,
    splitContentRef,
    activeTabId,
    splitTabId: visibleSplitTab?.id || null,
    isActive: shouldPrepareBrowserHost,
    layoutPhase,
    isVisibleAllowed: isMotionSettled, // D方案：水平滚动动画期间禁止 BrowserView 显示
    hostVisibleRef,
    topInset: 0,
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    hasError: shouldHideAllBrowserHosts,
  })

  const clearLocalMediaUploadStatusTimer = useCallback(() => {
    if (localMediaUploadStatusTimerRef.current) {
      window.clearTimeout(localMediaUploadStatusTimerRef.current)
      localMediaUploadStatusTimerRef.current = null
    }
  }, [])

  const publishLocalMediaUploadStatus = useCallback((status: { kind: 'uploading' | 'success' | 'error'; message: string } | null) => {
    clearLocalMediaUploadStatusTimer()
    setLocalMediaUploadStatus(status)
    if (!status || status.kind === 'uploading') return
    localMediaUploadStatusTimerRef.current = window.setTimeout(() => {
      localMediaUploadStatusTimerRef.current = null
      setLocalMediaUploadStatus(null)
    }, 2600)
  }, [clearLocalMediaUploadStatusTimer])

  useEffect(() => {
    if (!isElectron) return
    return window.electronAPI?.browser?.onLocalMediaUploadStatus?.((event) => {
      publishLocalMediaUploadStatus(event.status)
    })
  }, [isElectron, publishLocalMediaUploadStatus])

  useEffect(() => {
    if (!agentPaneTaskId || agentPaneTaskId === lastAgentPaneTaskIdRef.current) return
    lastAgentPaneTaskIdRef.current = agentPaneTaskId
    setAgentPaneCollapsed(false)
    setDismissedAgentTaskId(null)
  }, [agentPaneTaskId])

  useEffect(() => {
    const agentTabId = agentSupervision.agentTabId
    if (!agentTabId || activeTabId !== agentTabId) return
    const fallback = tabs.find((tab) => tab.id !== agentTabId && tab.owner !== 'agent')
    if (!fallback) return
    setActiveTabId(fallback.id)
    setUrlInput(fallback.url === DEFAULT_BROWSER_URL ? '' : fallback.url)
  }, [activeTabId, agentSupervision.agentTabId, setActiveTabId, setUrlInput, tabs])

  useEffect(() => {
    const nextRatio = clampBrowserSplitRatio(browserSplitRatio)
    browserSplitRatioRef.current = nextRatio
    liveBrowserSplitRatioRef.current = nextRatio
  }, [browserSplitRatio])

  // URL helpers — auto-Google for non-URL input (Task 2)
  const normalizeUrl = useCallback((input: string): string => {
    return normalizeBrowserUrlInput(input, toFileUrl)
  }, [])

  const {
    isBookmarked,
    bookmarks,
    handleToggleBookmark,
    handleToggleBookmarkForTab,
  } = useBrowserPanelData({
    isElectron,
    activeTab,
  })

  const {
    toastVisible,
    adblockState,
    browserDiagnostics,
    refreshAdblockState,
  } = useBrowserDiagnosticsState({
    isElectron,
    tabs,
    activeTabId,
    currentDomain,
  })

  const currentDomainAdblockWhitelisted = useMemo(() => {
    if (!currentDomain) return false
    return adblockState.whitelistDomains.some((domain) => currentDomain === domain || currentDomain.endsWith(`.${domain}`))
  }, [adblockState.whitelistDomains, currentDomain])

  const handleShowUtilityMenu = useCallback((kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => {
    if (!isElectron) return

    const currentTabPayload = activeTab
      ? {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title || activeTab.url,
          domain: activeTab.domain || currentDomain,
        }
      : null

    void window.electronAPI?.browser?.showUtilityMenu({
      kind,
      anchorRect: {
        left: anchorRect.left,
        top: anchorRect.top,
        right: anchorRect.right,
        bottom: anchorRect.bottom,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      currentTab: currentTabPayload,
      currentDomain,
      adblockEnabled: adblockState.enabled,
      adblockDomainWhitelisted: currentDomainAdblockWhitelisted,
    })
  }, [activeTab, adblockState.enabled, currentDomain, currentDomainAdblockWhitelisted, isElectron])

  const handleContinueBrowserTask = useCallback(() => {
    const draft = [
      '继续刚才的浏览器任务。',
      browserDiagnostics?.currentTask?.taskTitle ? `任务：${browserDiagnostics.currentTask.taskTitle}` : null,
      browserDiagnostics?.currentTask?.taskSummary ? `当前状态：${browserDiagnostics.currentTask.taskSummary}` : null,
      browserDiagnostics?.lastFailure?.reason ? `上次失败：${browserDiagnostics.lastFailure.reason}` : null,
      '请先复核当前页面状态，再继续。',
    ].filter(Boolean).join('\n')
    appendToAgentInput(draft)
  }, [browserDiagnostics])

  const handleRetryBrowserTask = useCallback(() => {
    const draft = [
      '请重试刚才的浏览器任务。',
      browserDiagnostics?.currentTask?.taskTitle ? `任务：${browserDiagnostics.currentTask.taskTitle}` : null,
      browserDiagnostics?.lastFailure?.reason ? `优先修复：${browserDiagnostics.lastFailure.reason}` : null,
      '开始前先说明你准备如何继续。',
    ].filter(Boolean).join('\n')
    appendToAgentInput(draft)
  }, [browserDiagnostics])

  const {
    handleNewTab,
    handleCloseTab,
    handleTabClick: handleSwitchTab,
    handleNavigate,
    handleContentDragOver,
    handleContentDrop,
    handleGoBack,
    handleGoForward,
    handleRefresh,
    handleRetry,
    handleUrlFocus,
    handleUrlBlur,
    handleReorder,
  } = useBrowserTabActions({
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
    onLocalMediaUploadStatus: publishLocalMediaUploadStatus,
  })

  const handleHeaderTabClick = useCallback((id: string, event: { shiftKey: boolean }) => {
    if (event.shiftKey && id !== activeTabId) {
      setSplitTabId(id)
      return
    }
    void handleSwitchTab(id)
  }, [activeTabId, handleSwitchTab, setSplitTabId])

  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    const nextRatio = clampBrowserSplitRatio(liveBrowserSplitRatioRef.current + deltaPercent)
    liveBrowserSplitRatioRef.current = nextRatio
    primarySplitPaneRef.current?.style.setProperty('flex-basis', `${nextRatio}%`)
  }, [])

  const handleSplitResizeStateChange = useCallback((resizing: boolean) => {
    if (resizing) {
      liveBrowserSplitRatioRef.current = browserSplitRatioRef.current
      primarySplitPaneRef.current?.style.setProperty('will-change', 'flex-basis')
      return
    }
    primarySplitPaneRef.current?.style.removeProperty('will-change')
    const nextRatio = clampBrowserSplitRatio(liveBrowserSplitRatioRef.current)
    browserSplitRatioRef.current = nextRatio
    setBrowserSplitRatio(nextRatio)
  }, [setBrowserSplitRatio])

  const handleOpenBrowserTarget = useCallback(() => {
    const targetUrl = browserDiagnostics?.currentTask?.targetUrl || browserDiagnostics?.continuity?.targetUrl
    if (!targetUrl) return
    void handleNavigate(targetUrl)
  }, [browserDiagnostics, handleNavigate])

  const addVideoTargetToFastCard = useCallback(async (target: BrowserFastCardVideoTarget) => {
    openFastCard()
    const response = await window.electronAPI?.browser?.resolveFastCardVideo?.({ target })
    const fallbackUrl = target.videoUrl || target.sources?.find(Boolean) || target.pageUrl
    const video: FastCardVideoMeta = response?.success && response.data?.video
      ? response.data.video
      : {
        originalUrl: fallbackUrl,
        pageUrl: target.pageUrl,
        posterUrl: target.posterUrl,
        title: target.title || target.pageTitle,
        parseStatus: 'failed',
        error: response?.error || '视频解析未返回结果',
      }
    addFastCardItem(createVideoFastCardItem(target, video))
  }, [addFastCardItem, openFastCard])

  const handleAddTargetToFastCard = useCallback((target: BrowserFastCardTarget) => {
    if (target.kind === 'text') {
      addFastCardItem(createTextFastCardItem(target))
      openFastCard()
      return
    }
    if (target.kind === 'image') {
      addFastCardItem(createImageFastCardItem(target))
      openFastCard()
      return
    }
    void addVideoTargetToFastCard(target)
  }, [addFastCardItem, addVideoTargetToFastCard, openFastCard])

  const runFastCardTranslation = useCallback(async (target: BrowserFastCardTextTarget, targetLanguage: string) => {
    const requestId = ++fastCardResultRequestIdRef.current
    fastCardResultTargetRef.current = target
    setFastCardResultPanel({
      kind: 'translation',
      status: 'loading',
      originalText: target.text,
      targetLanguage,
    })
    const response = await window.electronAPI?.browser?.translateFastCardSelection?.({
      text: target.text,
      targetLanguage,
      source: fastCardSourceFromTarget(target),
    })
    if (requestId !== fastCardResultRequestIdRef.current) return
    if (response?.success && response.data) {
      setFastCardResultPanel({
        kind: 'translation',
        status: 'ready',
        originalText: response.data.originalText,
        translatedText: response.data.translatedText,
        targetLanguage: response.data.targetLanguage,
      })
      return
    }
    setFastCardResultPanel({
      kind: 'translation',
      status: 'error',
      originalText: target.text,
      targetLanguage,
      error: response?.error || '翻译失败',
    })
  }, [])

  const runFastCardImageDescription = useCallback(async (target: BrowserFastCardImageTarget) => {
    const requestId = ++fastCardResultRequestIdRef.current
    fastCardResultTargetRef.current = target
    setFastCardResultPanel({
      kind: 'image-description',
      status: 'loading',
      imageUrl: target.imageUrl,
    })
    const response = await window.electronAPI?.browser?.describeFastCardImage?.({
      imageUrl: target.imageUrl,
      source: fastCardSourceFromTarget(target),
    })
    if (requestId !== fastCardResultRequestIdRef.current) return
    if (response?.success && response.data) {
      setFastCardResultPanel({
        kind: 'image-description',
        status: 'ready',
        imageUrl: response.data.imageUrl,
        description: response.data.description,
      })
      return
    }
    setFastCardResultPanel({
      kind: 'image-description',
      status: 'error',
      imageUrl: target.imageUrl,
      error: response?.error || '反推描述失败',
    })
  }, [])

  const handleFastCardContextAction = useCallback((event: BrowserFastCardContextActionEvent) => {
    if (event.action === 'add-to-fastcard') {
      handleAddTargetToFastCard(event.target)
      return
    }
    if (event.action === 'translate-selection' && event.target.kind === 'text') {
      void runFastCardTranslation(event.target, detectFastCardTargetLanguage(event.target.text))
      return
    }
    if (event.action === 'describe-image' && event.target.kind === 'image') {
      void runFastCardImageDescription(event.target)
    }
  }, [handleAddTargetToFastCard, runFastCardImageDescription, runFastCardTranslation])

  const handleFastCardResultLanguageChange = useCallback((targetLanguage: string) => {
    const target = fastCardResultTargetRef.current
    if (!target || target.kind !== 'text') return
    void runFastCardTranslation(target, targetLanguage)
  }, [runFastCardTranslation])

  const handleAddFastCardResult = useCallback(() => {
    const state = fastCardResultPanel
    const target = fastCardResultTargetRef.current
    if (!state || state.status !== 'ready' || !target) return
    if (state.kind === 'translation' && target.kind === 'text') {
      addFastCardItem(finalizeFastCardItem({
        id: createFastCardId('translation'),
        kind: 'translation',
        createdAt: Date.now(),
        title: '翻译',
        originalText: state.originalText,
        translatedText: state.translatedText,
        targetLanguage: state.targetLanguage,
        source: fastCardSourceFromTarget(target),
      }))
      openFastCard()
      setFastCardResultPanel(null)
      return
    }
    if (state.kind === 'image-description' && target.kind === 'image') {
      addFastCardItem(finalizeFastCardItem({
        id: createFastCardId('image-description'),
        kind: 'image-description',
        createdAt: Date.now(),
        title: '图片反推描述',
        imageUrl: state.imageUrl,
        description: state.description,
        source: fastCardSourceFromTarget(target),
      }))
      openFastCard()
      setFastCardResultPanel(null)
    }
  }, [addFastCardItem, fastCardResultPanel, openFastCard])

  const handleToggleFastCard = useCallback(() => {
    if (fastCardResultPanel) {
      setFastCardResultPanel(null)
      openFastCard()
      return
    }
    if (fastCardPanelOpen) {
      collapseFastCard()
      return
    }
    openFastCard()
  }, [collapseFastCard, fastCardPanelOpen, fastCardResultPanel, openFastCard])

  const handleFastCardSaveMarkdown = useCallback(() => {
    if (fastCardItems.length === 0) return
    const markdown = renderFastCardMarkdown(fastCardItems)
    void window.electronAPI?.document?.saveFileAs?.({
      content: markdown,
      suggestedName: createFastCardMarkdownFilename(),
    })
  }, [fastCardItems])

  const handleFastCardInsertToChat = useCallback(() => {
    if (fastCardItems.length === 0) return
    appendToAgentInput(renderFastCardMarkdown(fastCardItems))
  }, [fastCardItems])

  useEffect(() => {
    if (!isElectron) return
    return window.electronAPI?.browser?.onFastCardContextAction?.(handleFastCardContextAction)
  }, [handleFastCardContextAction, isElectron])

  useEffect(() => {
    if (!isElectron) return
    return window.electronAPI?.browser?.onFastCardOverlayCommand?.((command: FastCardOverlayCommand) => {
      if (command.type === 'collapse') {
        collapseFastCard()
        setFastCardResultPanel(null)
        return
      }
      if (command.type === 'close-result') {
        setFastCardResultPanel(null)
        return
      }
      if (command.type === 'add-result') {
        handleAddFastCardResult()
        return
      }
      if (command.type === 'clear') {
        clearFastCard()
        return
      }
      if (command.type === 'save-markdown') {
        handleFastCardSaveMarkdown()
        return
      }
      if (command.type === 'insert-chat') {
        handleFastCardInsertToChat()
        return
      }
      if (command.type === 'remove-item') {
        removeFastCardItem(command.id)
        return
      }
      if (command.type === 'target-language-change') {
        handleFastCardResultLanguageChange(command.targetLanguage)
      }
    })
  }, [
    clearFastCard,
    collapseFastCard,
    handleAddFastCardResult,
    handleFastCardInsertToChat,
    handleFastCardResultLanguageChange,
    handleFastCardSaveMarkdown,
    isElectron,
    removeFastCardItem,
  ])

  useEffect(() => {
    if (!isElectron) return
    return () => {
      void window.electronAPI?.browser?.hideFastCardOverlay?.()
    }
  }, [isElectron])

  useEffect(() => {
    if (!isElectron) return
    return () => {
      void window.electronAPI?.browser?.hideBrowserLockOverlay?.()
    }
  }, [isElectron])

  useEffect(() => {
    if (!isElectron) return
    const shouldShowOverlay = isActive && (fastCardResultPanel !== null || fastCardPanelOpen)
    if (!shouldShowOverlay) {
      void window.electronAPI?.browser?.hideFastCardOverlay?.()
      return
    }

    let frame = 0
    const sendSnapshot = () => {
      frame = 0
      const element = browserContentFrameRef.current || contentRef.current
      if (!element) {
        void window.electronAPI?.browser?.hideFastCardOverlay?.()
        return
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        void window.electronAPI?.browser?.hideFastCardOverlay?.()
        return
      }
      const snapshot: FastCardOverlaySnapshot = {
        mode: fastCardResultPanel ? 'result' : 'fastcard',
        items: fastCardItems,
        resultPanel: fastCardResultPanel,
        bounds: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      }
      void window.electronAPI?.browser?.showFastCardOverlay?.(snapshot)
    }
    const scheduleSnapshot = () => {
      if (frame) return
      frame = window.requestAnimationFrame(sendSnapshot)
    }

    scheduleSnapshot()
    const observer = new ResizeObserver(scheduleSnapshot)
    const element = browserContentFrameRef.current
    if (element) observer.observe(element)
    window.addEventListener('resize', scheduleSnapshot)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleSnapshot)
    }
  }, [fastCardItems, fastCardPanelOpen, fastCardResultPanel, isActive, isElectron])

  useEffect(() => {
    if (!isElectron) return
    const lockKind = browserOwnershipStatus.kind
    const overlayKind = lockKind === 'user-view' ? null : lockKind
    if (!isActive || !shouldPresentBrowserHost || shouldHideAllBrowserHosts || !overlayKind) {
      void window.electronAPI?.browser?.hideBrowserLockOverlay?.()
      return
    }
    const resolvedOverlayKind = overlayKind

    let frame = 0
    const sendSnapshot = () => {
      frame = 0
      const element = browserContentFrameRef.current || contentRef.current
      if (!element) {
        void window.electronAPI?.browser?.hideBrowserLockOverlay?.()
        return
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        void window.electronAPI?.browser?.hideBrowserLockOverlay?.()
        return
      }
      const snapshot: BrowserLockOverlaySnapshot = {
        kind: resolvedOverlayKind,
        label: browserOwnershipStatus.label,
        detail: browserOwnershipStatus.detail,
        tone: browserOwnershipStatus.tone === 'warning' ? 'warning' : 'agent',
        bounds: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
      }
      void window.electronAPI?.browser?.showBrowserLockOverlay?.(snapshot)
    }
    const scheduleSnapshot = () => {
      if (frame) return
      frame = window.requestAnimationFrame(sendSnapshot)
    }

    scheduleSnapshot()
    const observer = new ResizeObserver(scheduleSnapshot)
    const element = browserContentFrameRef.current
    if (element) observer.observe(element)
    window.addEventListener('resize', scheduleSnapshot)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleSnapshot)
    }
  }, [browserOwnershipStatus, isActive, isElectron, shouldHideAllBrowserHosts, shouldPresentBrowserHost])

  const {
    browserRuntimeReady,
  } = useBrowserRuntimeEffects({
    isElectron,
    isActive,
    isAddressEditingRef,
    sendBoundsImmediate,
  })
  hostVisibleRef.current = browserRuntimeReady && tabs.length > 0

  const {
    captureStableFrame,
  } = useBrowserResizeFreeze({
    isElectron,
    isActive,
    browserRuntimeReady,
    activeTabId,
    surfaceRef: contentRef,
    sendBoundsImmediate,
  })

  const shouldShowStartupPlaceholder =
    !activeTab?.error &&
    (!browserRuntimeReady || !isBrowserSurfaceReady)

  const clearSurfaceReadyTimer = useCallback(() => {
    if (surfaceReadyTimerRef.current) {
      window.clearTimeout(surfaceReadyTimerRef.current)
      surfaceReadyTimerRef.current = null
    }
  }, [])

  const clearPostActivationHostResyncTimer = useCallback(() => {
    if (postActivationHostResyncTimerRef.current) {
      window.clearTimeout(postActivationHostResyncTimerRef.current)
      postActivationHostResyncTimerRef.current = null
    }
  }, [])

  const getFitKeyForTab = useCallback((tabId?: string | null) => {
    if (!tabId) return null
    const element = tabId === splitTab?.id ? splitContentRef.current : contentRef.current
    if (!element) return null
    return getBrowserTabFitKey(element.getBoundingClientRect())
  }, [splitTab?.id])

  const fitBrowserTabIfNeeded = useCallback(async (tabId?: string | null) => {
    if (!tabId) return
    const fitKey = getFitKeyForTab(tabId)
    if (fitKey && isFitted(tabId, fitKey)) return
    const result = await window.electronAPI?.browser?.fitActiveTabToBounds(tabId)
    if (result?.success && fitKey) {
      markFitted(tabId, fitKey)
    }
  }, [getFitKeyForTab])

  const CAPTURE_TOKEN_WINDOW_MS = 2000
  const clearCaptureTokenExpiryTimer = useCallback(() => {
    if (captureTokenExpiryTimerRef.current) {
      window.clearTimeout(captureTokenExpiryTimerRef.current)
      captureTokenExpiryTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!shouldRevealBrowserHost || !browserRuntimeReady) {
      clearSurfaceReadyTimer()
      setIsBrowserSurfaceReady(false)
    }
  }, [browserRuntimeReady, clearSurfaceReadyTimer, shouldRevealBrowserHost])

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      captureTokenConsumedRef.current = false
      clearCaptureTokenExpiryTimer()
      captureTokenExpiryTimerRef.current = window.setTimeout(() => {
        captureTokenExpiryTimerRef.current = null
        captureTokenConsumedRef.current = true
      }, CAPTURE_TOKEN_WINDOW_MS)
    } else if (!isActive && wasActiveRef.current) {
      clearCaptureTokenExpiryTimer()
      captureTokenConsumedRef.current = true
    }
    wasActiveRef.current = isActive
  }, [CAPTURE_TOKEN_WINDOW_MS, clearCaptureTokenExpiryTimer, isActive])

  useEffect(() => {
    if (!isActive) return
    if (!browserRuntimeReady || tabs.length === 0) return
    if (layoutPhase !== 'idle') return
    if (activeTab?.loading) return
    if (captureTokenConsumedRef.current) return
    captureTokenConsumedRef.current = true
    let cancelled = false
    void (async () => {
      const hostHasVisibleFrame = await captureStableFrame()
      if (cancelled) return
      if (hostHasVisibleFrame) {
        setIsBrowserSurfaceReady(true)
        return
      }
      clearSurfaceReadyTimer()
      surfaceReadyTimerRef.current = window.setTimeout(() => {
        surfaceReadyTimerRef.current = null
        setIsBrowserSurfaceReady(true)
      }, 48)
    })()
    return () => { cancelled = true }
  }, [activeTab?.loading, browserRuntimeReady, captureStableFrame, clearSurfaceReadyTimer, isActive, layoutPhase, tabs.length])

  useEffect(() => {
    if (!isElectron || !isActive) return
    if (!shouldRevealBrowserHost || !browserRuntimeReady || tabs.length === 0) return
    if (layoutPhase !== 'idle' || activeTab?.loading || isBrowserSurfaceReady) return
    if (!captureTokenConsumedRef.current) return

    clearSurfaceReadyTimer()
    surfaceReadyTimerRef.current = window.setTimeout(() => {
      surfaceReadyTimerRef.current = null
      setIsBrowserSurfaceReady(true)
    }, 48)
    return () => {
      clearSurfaceReadyTimer()
    }
  }, [
    activeTab?.loading,
    browserRuntimeReady,
    clearSurfaceReadyTimer,
    isActive,
    isBrowserSurfaceReady,
    isElectron,
    layoutPhase,
    shouldRevealBrowserHost,
    tabs.length,
  ])

  useEffect(() => {
    if (!shouldRevealBrowserHost || !browserRuntimeReady || tabs.length === 0 || shouldHideAllBrowserHosts) {
      hostPresentedRef.current = false
    }
  }, [browserRuntimeReady, shouldHideAllBrowserHosts, shouldRevealBrowserHost, tabs.length])

  useEffect(() => {
    if (!isElectron) return
    if (!shouldPresentBrowserHost || !shouldRevealBrowserHost) return

    const presentationPlan = planBrowserHostPresentation({
      shouldPresentBrowserHost,
      shouldRevealBrowserHost,
      canShowBrowserHost: !shouldHideAllBrowserHosts,
      browserRuntimeReady,
      tabCount: tabs.length,
      activeTabId,
      splitTabId: splitTab?.id || null,
      hostAlreadyPresented: hostPresentedRef.current,
    })
    let cancelled = false

    const syncVisibleHost = async () => {
      if (presentationPlan.action === 'skip') return
      if (presentationPlan.action === 'hide') {
        hostPresentedRef.current = false
        await syncBrowserVisibility('hidden')
        return
      }
      await fitBrowserTabIfNeeded(presentationPlan.fitActiveTabId)
      if (presentationPlan.fitSplitTabId) {
        await fitBrowserTabIfNeeded(presentationPlan.fitSplitTabId)
      }
      if (cancelled) return
      if (presentationPlan.action === 'sync-bounds') {
        await syncBrowserVisibility('visible', { forceExact: true })
        if (cancelled) return
        hostPresentedRef.current = true
        return
      }
      await syncBrowserVisibility('visible', { forceExact: true })
      if (cancelled) return
      hostPresentedRef.current = true
    }

    // fire-and-forget: BrowserView visibility/bounds sync; failures self-correct on the next visibility transition or layout effect (BrowserView is a native overlay and is rebuilt on layout change).
    void syncVisibleHost().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeTabId, browserRuntimeReady, fitBrowserTabIfNeeded, isElectron, sendBoundsImmediate, shouldHideAllBrowserHosts, splitTab?.id, syncBrowserVisibility, shouldPresentBrowserHost, shouldRevealBrowserHost, tabs.length])

  useEffect(() => {
    if (!isElectron || !isActive) return
    if (!shouldPresentBrowserHost || !shouldRevealBrowserHost) return
    if (hostPresentedRef.current) return
    if (!browserRuntimeReady || tabs.length === 0 || !activeTabId) return
    if (layoutPhase !== 'idle') return

    clearPostActivationHostResyncTimer()
    postActivationHostResyncTimerRef.current = window.setTimeout(() => {
      postActivationHostResyncTimerRef.current = null
      // fire-and-forget: post-activation BrowserView resync; next layout effect re-issues the bounds sync if this attempt drops.
      void (async () => {
        await fitBrowserTabIfNeeded(activeTabId)
        if (splitTab?.id) {
          await fitBrowserTabIfNeeded(splitTab.id)
        }
        await syncBrowserVisibility('visible', { forceExact: true, forceBoundsSync: true })
        hostPresentedRef.current = true
      })().catch(() => undefined)
    }, 180)

    return () => {
      clearPostActivationHostResyncTimer()
    }
  }, [
    activeTabId,
    browserRuntimeReady,
    clearPostActivationHostResyncTimer,
    fitBrowserTabIfNeeded,
    isActive,
    isElectron,
    layoutPhase,
    splitTab?.id,
    syncBrowserVisibility,
    shouldPresentBrowserHost,
    shouldRevealBrowserHost,
    tabs.length,
  ])

  // Trailing settle: when motion finishes (layoutPhase flips to idle) and the browser is active,
  // sync once more so the host bounds match the final settled layout. Replaces the 180ms setTimeout
  // re-sync that used to fire on every browser entry.
  useEffect(() => {
    if (!isElectron || !isActive) return
    if (layoutPhase !== 'idle') return
    void syncBrowserVisibility({ forceExact: true })
  }, [isActive, isElectron, layoutPhase, syncBrowserVisibility])

  useEffect(() => {
    return () => {
      clearPostActivationHostResyncTimer()
      clearCaptureTokenExpiryTimer()
      clearSurfaceReadyTimer()
      clearLocalMediaUploadStatusTimer()
    }
  }, [clearCaptureTokenExpiryTimer, clearLocalMediaUploadStatusTimer, clearPostActivationHostResyncTimer, clearSurfaceReadyTimer])

  // Task 4: Empty state — no tabs
  if (tabs.length === 0) {
    return (
      <BrowserModeEmptyState
        onNewTab={handleNewTab}
        contentRef={contentRef}
        urlInput={urlInput}
        onUrlChange={setUrlInput}
        onNavigate={() => void handleNavigate()}
        onFocus={handleUrlFocus}
        onBlur={handleUrlBlur}
        onEditStart={handleBrowserEditStart}
        onEditEnd={handleBrowserEditEnd}
        loading={!browserRuntimeReady}
        onShowUtilityMenu={handleShowUtilityMenu}
        fastCardOpen={fastCardPanelOpen || fastCardResultPanel !== null}
        fastCardItemCount={fastCardItems.length}
        onToggleFastCard={handleToggleFastCard}
      />
    )
  }

  return (
      <div ref={modeRootRef} className="workbench-mode-root relative">
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div ref={shellRef} className="workbench-canvas-shell relative flex h-full min-h-0 flex-col">
          <BrowserTopBar
            isActive={isActive}
            activeTab={activeTab}
            urlInput={urlInput}
            loading={activeTab?.loading || false}
            canGoBack={activeTab?.canGoBack || false}
            canGoForward={activeTab?.canGoForward || false}
            isBookmarked={isBookmarked}
            onUrlChange={setUrlInput}
            onNavigate={handleNavigate}
            onGoBack={handleGoBack}
            onGoForward={handleGoForward}
            onRefresh={handleRefresh}
            onFocus={handleUrlFocus}
            onBlur={handleUrlBlur}
            onEditStart={handleBrowserEditStart}
            onEditEnd={handleBrowserEditEnd}
            onToggleBookmark={handleToggleBookmark}
            onShowUtilityMenu={handleShowUtilityMenu}
            fastCardOpen={fastCardPanelOpen || fastCardResultPanel !== null}
            fastCardItemCount={fastCardItems.length}
            onToggleFastCard={handleToggleFastCard}
            ownershipStatus={browserOwnershipStatus}
          />

          <div className="flex min-h-0 flex-1">
            <VerticalTabRail
              isActive={isActive}
              tabs={tabs}
              activeTabId={activeTabId}
              splitTabId={visibleSplitTab?.id || null}
              bookmarkedUrls={bookmarks.map((item) => item.url)}
              onTabClick={handleHeaderTabClick}
              onTabClose={handleCloseTab}
              onNewTab={handleNewTab}
              onReorder={handleReorder}
              onToggleBookmarkForTab={handleToggleBookmarkForTab}
            />

            <div
              ref={browserContentFrameRef}
              data-browser-content-frame=""
              style={{
                position: 'relative',
                zIndex: 1,
              }}
              className="flex min-h-0 flex-1"
            >
            {shouldRenderSplitLayout && activeTab ? (
              <div className="flex h-full min-w-0 flex-1 overflow-hidden" ref={splitContainerRef} style={{ gap: 0 }}>
                <div
                  ref={primarySplitPaneRef}
                  className="flex min-w-0 flex-col overflow-hidden"
                  style={{ flexBasis: agentPaneCollapsedVisible ? 'calc(100% - 164px)' : `${browserSplitRatio}%`, flexShrink: 0, flexGrow: 0 }}
                >
                  <BrowserShellLayout
                    isElectron={isElectron}
                    contentRef={contentRef}
                    activeTab={activeTab}
                    toastVisible={toastVisible}
                    onDragOver={handleContentDragOver}
                    onDrop={(event) => handleContentDrop(event, activeTab.id)}
                    onRetry={() => void handleRetry(activeTab.id)}
                    mediaUploadStatus={localMediaUploadStatus}
                  />
                </div>
                {!agentPaneCollapsedVisible && (
                  <BrowserSplitResizeHandle
                    onResize={handleSplitResize}
                    onResizeStateChange={handleSplitResizeStateChange}
                  />
                )}
                {agentPaneCollapsedVisible ? (
                  <div
                    className="relative flex h-full w-[164px] flex-shrink-0 items-start justify-center overflow-hidden px-2 pt-3"
                    style={{
                      background: 'color-mix(in srgb, var(--surface-card-bg) 90%, transparent)',
                      boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 26%, transparent)',
                    }}
                  >
                    <AgentBrowserSupervisionPanel
                      controlState={agentSupervision.controlState}
                      tasks={agentSupervision.tasks}
                      requestInterruption={agentSupervision.requestInterruption}
                      confirmInterruption={agentSupervision.confirmInterruption}
                      dismissInterruption={agentSupervision.dismissInterruption}
                      surfaces={agentSupervision.surfaces}
                      activeWriteSurface={agentSupervision.activeWriteSurface}
                      variant="collapsedRail"
                      onExpand={() => setAgentPaneCollapsed(false)}
                    />
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                      style={{
                        borderRadius: '0 0 var(--workbench-canvas-radius) 0',
                        boxShadow: 'inset 0 0 18px color-mix(in srgb, var(--color-blue) 12%, transparent)',
                      }}
                    />
                  </div>
                ) : visibleSplitTab ? (
                  <div
                    className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
                    style={isAgentSplitVisible
                      ? {
                          background: 'color-mix(in srgb, var(--surface-card-bg) 88%, transparent)',
                          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 36%, transparent), inset 0 0 18px color-mix(in srgb, var(--color-blue) 16%, transparent)',
                        }
                      : undefined}
                  >
                    {isAgentSplitVisible && (
                      <AgentBrowserSupervisionPanel
                        controlState={agentSupervision.controlState}
                        tasks={agentSupervision.tasks}
                        requestInterruption={agentSupervision.requestInterruption}
                        confirmInterruption={agentSupervision.confirmInterruption}
                        dismissInterruption={agentSupervision.dismissInterruption}
                        surfaces={agentSupervision.surfaces}
                        activeWriteSurface={agentSupervision.activeWriteSurface}
                        variant="pane"
                        onCollapse={() => setAgentPaneCollapsed(true)}
                        onClose={() => {
                          setDismissedAgentTaskId(agentPaneTaskId)
                          setAgentPaneCollapsed(false)
                        }}
                      />
                    )}
                    <BrowserShellLayout
                      isElectron={isElectron}
                      contentRef={splitContentRef}
                      activeTab={visibleSplitTab}
                      toastVisible={false}
                      onDragOver={handleContentDragOver}
                      onDrop={(event) => handleContentDrop(event, visibleSplitTab.id)}
                      onRetry={() => void handleRetry(visibleSplitTab.id)}
                      mediaUploadStatus={localMediaUploadStatus}
                    />
                    {isAgentSplitVisible && (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0"
                        style={{
                          borderRadius: '0 0 var(--workbench-canvas-radius) 0',
                          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 42%, transparent), inset 0 0 24px color-mix(in srgb, var(--color-blue) 18%, transparent)',
                        }}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <BrowserShellLayout
                isElectron={isElectron}
                contentRef={contentRef}
                activeTab={activeTab}
                toastVisible={toastVisible}
                onDragOver={handleContentDragOver}
                onDrop={handleContentDrop}
                onRetry={() => void handleRetry()}
                mediaUploadStatus={localMediaUploadStatus}
              />
            )}
              <BrowserDiagnosticsDock
                browserDiagnostics={browserDiagnostics}
                onContinue={handleContinueBrowserTask}
                onRetry={handleRetryBrowserTask}
                onOpenTarget={handleOpenBrowserTarget}
                onRefresh={() => void refreshAdblockState()}
              />
            </div>
          </div>

          {/* 浏览器过渡遮罩 - 动画结束后但浏览器未准备好时显示 */}
          {!isBrowserHostFullyVisible && (
            <div
              className="browser-transition-mask"
              style={{
                position: 'absolute',
                top: WORKBENCH_TAB_ROW_HEIGHT,
                left: BROWSER_VERTICAL_RAIL_WIDTH,
                right: 0,
                bottom: 0,
                zIndex: 45,
                pointerEvents: 'none',
                borderRadius: '0 0 var(--workbench-canvas-radius) var(--workbench-canvas-radius)',
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
                overflow: 'hidden',
              }}
            >
              {/* 骨架结构 */}
              <div className="flex h-full flex-col">
                {/* 进度条占位（如果加载中） */}
                {activeTab?.loading && (
                  <div className="h-0.5 w-full" style={{ background: 'var(--border-default)' }}>
                    <div
                      className="h-full rounded-r"
                      style={{
                        background: 'var(--color-blue)',
                        width: '60%',
                        animation: 'browserSkeletonProgress 1.5s ease-in-out infinite',
                      }}
                    />
                  </div>
                )}
                {/* 内容区域占位 */}
                <div className="flex-1" style={{ background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))' }} />
              </div>
            </div>
          )}

          {shouldShowStartupPlaceholder && (
            <div
              className="browser-surface-startup-mask"
              style={{
                position: 'absolute',
                top: WORKBENCH_TAB_ROW_HEIGHT,
                left: BROWSER_VERTICAL_RAIL_WIDTH,
                right: 0,
                bottom: 0,
                zIndex: 50,
                pointerEvents: 'none',
                borderRadius: '0 0 var(--workbench-canvas-radius) var(--workbench-canvas-radius)',
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
                backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
                WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  border: '2px solid var(--border-default)',
                  borderTopColor: 'var(--color-blue)',
                  animation: 'browserStartupSpinner 0.8s linear infinite',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
