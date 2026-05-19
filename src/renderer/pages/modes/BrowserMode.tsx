import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import BrowserModeEmptyState from '../../components/browser/BrowserModeEmptyState'
import BrowserDiagnosticsDock from '../../components/browser/BrowserDiagnosticsDock'
import BrowserHeader from '../../components/browser/BrowserHeader'
import BrowserShellLayout from '../../components/browser/BrowserShellLayout'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { useBrowserDiagnosticsState } from '../../modules/browser/useBrowserDiagnosticsState'
import { useBrowserPanelData } from '../../modules/browser/useBrowserPanelData'
import { useBrowserResizeFreeze } from '../../modules/browser/useBrowserResizeFreeze'
import { useBrowserRuntimeEffects } from '../../modules/browser/useBrowserRuntimeEffects'
import { useBrowserTabActions } from '../../modules/browser/useBrowserTabActions'
import { useBrowserViewBounds } from '../../modules/browser/useBrowserViewBounds'
import {
  extractBrowserDomain,
  isReadyBrowserBlankUrl,
  normalizeBrowserUrlInput,
} from '../../modules/browser/url-utils'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { toFileUrl } from '../../utils/dragDrop'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'
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
  const surfaceReadyTimerRef = useRef<number | null>(null)
  const postActivationHostResyncTimerRef = useRef<number | null>(null)
  const captureTokenConsumedRef = useRef(false)
  const captureTokenExpiryTimerRef = useRef<number | null>(null)
  const wasActiveRef = useRef<boolean>(isActive)
  const previousTabCountRef = useRef(tabs.length)
  const modeRootRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
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
  const activeTab = tabs.find(t => t.id === activeTabId) || null
  const splitTab = splitTabId && splitTabId !== activeTabId ? tabs.find(t => t.id === splitTabId) || null : null
  const currentDomain = activeTab?.domain || extractBrowserDomain(activeTab?.url || '')
  const hasError = !!activeTab?.error
  const isReadyBlankTab = activeTab ? isReadyBrowserBlankUrl(activeTab.url) : false
  const splitTabHasNativeSurface = splitTab ? !splitTab.error && !isReadyBrowserBlankUrl(splitTab.url) : false
  const shouldHideAllBrowserHosts = (hasError || isReadyBlankTab) && !splitTabHasNativeSurface
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
    splitTabId: splitTab?.id || null,
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
  })

  const handleHeaderTabClick = useCallback((id: string, event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey && id !== activeTabId) {
      setSplitTabId(id)
      return
    }
    setSplitTabId(null)
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
    if (!isElectron) return
    if (!shouldPresentBrowserHost || !shouldRevealBrowserHost) return

    const previousTabCount = previousTabCountRef.current
    previousTabCountRef.current = tabs.length
    const tabCountChangedWhileHostAlreadyPresent = previousTabCount > 0 && tabs.length > 0 && previousTabCount !== tabs.length

    const syncVisibleHost = async () => {
      if (!browserRuntimeReady || tabs.length === 0) {
        await syncBrowserVisibility('hidden')
        return
      }
      if (tabCountChangedWhileHostAlreadyPresent) {
        return
      }
      await syncBrowserVisibility('hidden')
      if (activeTabId) {
        await window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
      }
      if (splitTab?.id) {
        await window.electronAPI?.browser?.fitActiveTabToBounds(splitTab.id)
      }
      await syncBrowserVisibility('visible', { forceBoundsSync: true })
    }

    void syncVisibleHost().catch(() => undefined)
  }, [activeTabId, browserRuntimeReady, isElectron, splitTab?.id, syncBrowserVisibility, shouldPresentBrowserHost, shouldRevealBrowserHost, tabs.length])

  useEffect(() => {
    if (!isElectron || !isActive) return
    if (!shouldPresentBrowserHost || !shouldRevealBrowserHost) return
    if (!browserRuntimeReady || tabs.length === 0 || !activeTabId) return
    if (layoutPhase !== 'idle') return

    clearPostActivationHostResyncTimer()
    postActivationHostResyncTimerRef.current = window.setTimeout(() => {
      postActivationHostResyncTimerRef.current = null
      void (async () => {
        await window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
        if (splitTab?.id) {
          await window.electronAPI?.browser?.fitActiveTabToBounds(splitTab.id)
        }
        await syncBrowserVisibility('visible', { forceExact: true, forceBoundsSync: true })
      })().catch(() => undefined)
    }, 180)

    return () => {
      clearPostActivationHostResyncTimer()
    }
  }, [
    activeTabId,
    browserRuntimeReady,
    clearPostActivationHostResyncTimer,
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
    }
  }, [clearCaptureTokenExpiryTimer, clearPostActivationHostResyncTimer, clearSurfaceReadyTimer])

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
          <BrowserHeader
            isActive={isActive}
            tabs={tabs}
            activeTabId={activeTabId}
            splitTabId={splitTab?.id || null}
            urlInput={urlInput}
            loading={activeTab?.loading || false}
            canGoBack={activeTab?.canGoBack || false}
            canGoForward={activeTab?.canGoForward || false}
            isBookmarked={isBookmarked}
            bookmarkedUrls={bookmarks.map((item) => item.url)}
            onTabClick={handleHeaderTabClick}
            onTabClose={handleCloseTab}
            onNewTab={handleNewTab}
            onReorder={handleReorder}
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
            onToggleBookmarkForTab={handleToggleBookmarkForTab}
            onShowUtilityMenu={handleShowUtilityMenu}
          />

          <div
            style={{
              position: 'relative',
              zIndex: 1,
            }}
            className="flex min-h-0 flex-1"
          >
            {splitTab && activeTab ? (
              <div className="flex h-full min-w-0 flex-1 overflow-hidden" ref={splitContainerRef} style={{ gap: 0 }}>
                <div
                  ref={primarySplitPaneRef}
                  className="flex min-w-0 flex-col overflow-hidden"
                  style={{ flexBasis: `${browserSplitRatio}%`, flexShrink: 0, flexGrow: 0 }}
                >
                  <BrowserShellLayout
                    isElectron={isElectron}
                    contentRef={contentRef}
                    activeTab={activeTab}
                    toastVisible={toastVisible}
                    onDragOver={handleContentDragOver}
                    onDrop={(event) => handleContentDrop(event, activeTab.id)}
                    onRetry={() => void handleRetry(activeTab.id)}
                  />
                </div>
                <BrowserSplitResizeHandle
                  onResize={handleSplitResize}
                  onResizeStateChange={handleSplitResizeStateChange}
                />
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <BrowserShellLayout
                    isElectron={isElectron}
                    contentRef={splitContentRef}
                    activeTab={splitTab}
                    toastVisible={false}
                    onDragOver={handleContentDragOver}
                    onDrop={(event) => handleContentDrop(event, splitTab.id)}
                    onRetry={() => void handleRetry(splitTab.id)}
                  />
                </div>
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

          {/* 浏览器过渡遮罩 - 动画结束后但浏览器未准备好时显示 */}
          {!isBrowserHostFullyVisible && (
            <div
              className="browser-transition-mask"
              style={{
                position: 'absolute',
                top: WORKBENCH_TAB_ROW_HEIGHT,
                left: 0,
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
                left: 0,
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
