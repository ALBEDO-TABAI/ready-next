import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  normalizeBrowserUrlInput,
} from '../../modules/browser/url-utils'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { toFileUrl } from '../../utils/dragDrop'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'

const BROWSER_CAPTURE_FREEZE_EVENT = 'ready:browser-capture-freeze'

// 冻结帧过渡动画配置
const FREEZE_FRAME_CONFIG = {
  fadeDurationMs: 180,        // 淡出持续时间
  blurStartPx: 0,            // 起始模糊度
  blurEndPx: 2,              // 结束模糊度（轻微模糊增强丝滑感）
  scaleStart: 1,             // 起始缩放
  scaleEnd: 0.998,           // 结束缩放（轻微缩小增强深度感）
}

// 新增：切换动画相关 props
interface BrowserModeProps {
  isActive?: boolean
  isMotionSettled?: boolean
}

export default function BrowserMode({
  isActive = true,
  isMotionSettled = true,
}: BrowserModeProps) {
  // Persistent browser tab state — survives mode switches
  const {
    tabs, activeTabId, urlInput,
    setTabs, setActiveTabId, setUrlInput,
    addTab, updateTab, reorderTabs,
  } = useBrowserTabs()
  const [isBrowserSurfaceReady, setIsBrowserSurfaceReady] = useState(false)
  const isAddressEditingRef = useRef(false)
  const hostVisibleRef = useRef(false)
  const surfaceReadyTimerRef = useRef<number | null>(null)
  const startupHostResyncTimerRef = useRef<number | null>(null)
  const modeRootRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI

  const sidebarVisible = useWorkspace(s => s.sidebarVisible)
  const sidePanelVariant = useWorkspace(s => s.sidePanelVariant)
  const sidePanelWidths = useWorkspace(s => s.sidePanelWidths)
  const skillsSplitRatio = useWorkspace(s => s.skillsSplitRatio)
  const chatPanelVisible = useWorkspace(s => s.chatPanelVisible)
  const chatPanelWidth = useWorkspace(s => s.chatPanelWidth)
  const effectiveSidePanelWidth = sidePanelWidths.shared
  const activeTab = tabs.find(t => t.id === activeTabId) || null
  const currentDomain = activeTab?.domain || extractBrowserDomain(activeTab?.url || '')
  const hasError = !!activeTab?.error
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

  const previousShouldPrepareBrowserHostRef = useRef(shouldPrepareBrowserHost)
  const { sendBoundsImmediate, syncBrowserVisibility } = useBrowserViewBounds({
    isElectron,
    contentRef,
    isActive: shouldPrepareBrowserHost,
    isVisibleAllowed: isMotionSettled, // D方案：水平滚动动画期间禁止 BrowserView 显示
    hostVisibleRef,
    topInset: 0,
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    hasError,
  })

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
    handleNewTab,
  })
  hostVisibleRef.current = browserRuntimeReady && tabs.length > 0

  const {
    cachedFreezeFrame,
    captureStableFrame,
    freezeFrame,
  } = useBrowserResizeFreeze({
    isElectron,
    isActive,
    browserRuntimeReady,
    activeTabId,
    surfaceRef: shellRef,
    sendBoundsImmediate,
  })
  const visibleFreezeFrame = freezeFrame ?? cachedFreezeFrame
  const shouldUseNeutralFreezeFrameExit = !freezeFrame && Boolean(cachedFreezeFrame?.src)
  // 关键修复：在切换动画期间（!isMotionSettled）或浏览器未准备好时，显示冻结帧
  const shouldShowFreezeFrame = Boolean(visibleFreezeFrame?.src) && (!isMotionSettled || !isBrowserSurfaceReady || Boolean(freezeFrame))

  // 监听离开浏览器模式前的截图请求
  useEffect(() => {
    if (!isElectron) return

    const handleCaptureFreeze = () => {
      if (!isActive) return
      void captureStableFrame()
    }

    window.addEventListener(BROWSER_CAPTURE_FREEZE_EVENT, handleCaptureFreeze)
    return () => {
      window.removeEventListener(BROWSER_CAPTURE_FREEZE_EVENT, handleCaptureFreeze)
    }
  }, [isActive, isElectron, captureStableFrame])

  // 关键修复：在 isActive 变为 false 前（离开浏览器模式前）捕获截图
  // 使用 useLayoutEffect 确保在 DOM 变化前执行
  useLayoutEffect(() => {
    if (!isElectron) return

    // 只有当从 active 变为 inactive 时才捕获
    if (previousShouldPrepareBrowserHostRef.current && !shouldPrepareBrowserHost) {
      // 立即捕获截图，此时 BrowserView 还在显示
      void captureStableFrame()
    }
    previousShouldPrepareBrowserHostRef.current = shouldPrepareBrowserHost
  }, [captureStableFrame, isElectron, shouldPrepareBrowserHost])

  // Startup placeholder: 有过冻结帧时显示冻结帧，而不是 loading
  const shouldShowStartupPlaceholder =
    !activeTab?.error &&
    !shouldShowFreezeFrame &&
    (!browserRuntimeReady || !isBrowserSurfaceReady)

  const clearSurfaceReadyTimer = useCallback(() => {
    if (surfaceReadyTimerRef.current) {
      window.clearTimeout(surfaceReadyTimerRef.current)
      surfaceReadyTimerRef.current = null
    }
  }, [])

  const clearStartupHostResyncTimer = useCallback(() => {
    if (startupHostResyncTimerRef.current) {
      window.clearTimeout(startupHostResyncTimerRef.current)
      startupHostResyncTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isElectron || isMotionSettled) return

    // 切换滑动期间只隐藏原生 BrowserView，避免在位移中的壳层区域上重抓冻结帧，
    // 否则会把左侧文件面板等错位画面缓存进浏览器区域里。
    void window.electronAPI?.browser?.hideAll?.()
  }, [isElectron, isMotionSettled])

  useEffect(() => {
    if (!shouldRevealBrowserHost || !browserRuntimeReady) {
      clearSurfaceReadyTimer()
      setIsBrowserSurfaceReady(false)
    }
  }, [browserRuntimeReady, clearSurfaceReadyTimer, shouldRevealBrowserHost])

  useEffect(() => {
    if (!isElectron) return
    if (!shouldPresentBrowserHost || !shouldRevealBrowserHost) return

    let cancelled = false

    const syncVisibleHost = async () => {
      if (!browserRuntimeReady || tabs.length === 0) {
        await window.electronAPI?.browser?.hideAll?.()
        return
      }
      await window.electronAPI?.browser?.hideAll?.()
      await sendBoundsImmediate({ forceExact: true })
      if (activeTabId) {
        await window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
      }
      await sendBoundsImmediate({ forceExact: true })
      await syncBrowserVisibility({ forceExact: true })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
      clearStartupHostResyncTimer()
      startupHostResyncTimerRef.current = window.setTimeout(() => {
        startupHostResyncTimerRef.current = null
        if (cancelled) return
        void (async () => {
          if (activeTabId) {
            await window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
          }
          await sendBoundsImmediate({ forceExact: true })
          await syncBrowserVisibility({ forceExact: true })
        })().catch(() => undefined)
      }, 180)
      if (cancelled) return
      const hostHasVisibleFrame = await captureStableFrame()
      if (cancelled) return
        if (hostHasVisibleFrame) {
          setIsBrowserSurfaceReady(true)
          return
        }
      clearSurfaceReadyTimer()
      surfaceReadyTimerRef.current = window.setTimeout(() => {
        if (cancelled) return
        surfaceReadyTimerRef.current = null
        setIsBrowserSurfaceReady(true)
      }, 48)
    }

        void syncVisibleHost().catch(() => undefined)

        return () => {
          cancelled = true
          clearStartupHostResyncTimer()
          clearSurfaceReadyTimer()
        }
  }, [activeTabId, browserRuntimeReady, clearStartupHostResyncTimer, clearSurfaceReadyTimer, isElectron, sendBoundsImmediate, syncBrowserVisibility, shouldPresentBrowserHost, shouldRevealBrowserHost, tabs.length])

  useEffect(() => {
    return () => {
      clearStartupHostResyncTimer()
      clearSurfaceReadyTimer()
    }
  }, [clearStartupHostResyncTimer, clearSurfaceReadyTimer])

  // 冻结帧高级淡出动画状态（模糊 + 缩放 + 透明度）
  const [freezeFrameStyle, setFreezeFrameStyle] = useState({
    opacity: 1,
    filter: 'blur(0px)',
    transform: 'scale(1)',
  })
  const prevShouldShowRef = useRef(shouldShowFreezeFrame)
  const freezeFrameAnimRef = useRef<number | null>(null)

  const clearFreezeFrameAnim = useCallback(() => {
    if (freezeFrameAnimRef.current !== null) {
      cancelAnimationFrame(freezeFrameAnimRef.current)
      freezeFrameAnimRef.current = null
    }
  }, [])

  useEffect(() => {
    clearFreezeFrameAnim()

    if (prevShouldShowRef.current && !shouldShowFreezeFrame) {
      // 开始高级淡出：透明度 + 轻微模糊 + 轻微缩放
      const startTime = performance.now()
      const duration = FREEZE_FRAME_CONFIG.fadeDurationMs

      const animate = (now: number) => {
        const elapsed = now - startTime
        const progress = Math.min(elapsed / duration, 1)
        // 使用 ease-out-quart 缓动
        const easeOut = 1 - Math.pow(1 - progress, 4)

        const opacity = 1 - easeOut
        const targetBlur = shouldUseNeutralFreezeFrameExit ? 0 : FREEZE_FRAME_CONFIG.blurEndPx
        const targetScale = shouldUseNeutralFreezeFrameExit ? 1 : FREEZE_FRAME_CONFIG.scaleEnd
        const blur = FREEZE_FRAME_CONFIG.blurStartPx + (targetBlur - FREEZE_FRAME_CONFIG.blurStartPx) * easeOut
        const scale = FREEZE_FRAME_CONFIG.scaleStart + (targetScale - FREEZE_FRAME_CONFIG.scaleStart) * easeOut

        setFreezeFrameStyle({
          opacity,
          filter: `blur(${blur}px)`,
          transform: `scale(${scale})`,
        })

        if (progress < 1) {
          freezeFrameAnimRef.current = requestAnimationFrame(animate)
          return
        }

        freezeFrameAnimRef.current = null
        prevShouldShowRef.current = shouldShowFreezeFrame
      }

      freezeFrameAnimRef.current = requestAnimationFrame(animate)
      return () => {
        clearFreezeFrameAnim()
      }
    }

    setFreezeFrameStyle({
      opacity: 1,
      filter: 'blur(0px)',
      transform: 'scale(1)',
    })
    prevShouldShowRef.current = shouldShowFreezeFrame
    return undefined
  }, [clearFreezeFrameAnim, shouldShowFreezeFrame, shouldUseNeutralFreezeFrameExit])

  useEffect(() => {
    return () => {
      clearFreezeFrameAnim()
    }
  }, [clearFreezeFrameAnim])

  // 只要有冻结帧数据就渲染，通过 style 控制显隐
  const shouldRenderFreezeFrame = Boolean(visibleFreezeFrame?.src) && (shouldShowFreezeFrame || freezeFrameStyle.opacity > 0)

  // Task 4: Empty state — no tabs
  if (tabs.length === 0) {
    return (
      <BrowserModeEmptyState
        onNewTab={handleNewTab}
        contentRef={contentRef}
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
            urlInput={urlInput}
            loading={activeTab?.loading || false}
            canGoBack={activeTab?.canGoBack || false}
            canGoForward={activeTab?.canGoForward || false}
            isBookmarked={isBookmarked}
            bookmarkedUrls={bookmarks.map((item) => item.url)}
            onTabClick={handleTabClick}
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
            <BrowserShellLayout
              isElectron={isElectron}
              contentRef={contentRef}
              activeTab={activeTab}
              toastVisible={toastVisible}
              onDragOver={handleContentDragOver}
              onDrop={handleContentDrop}
              onRetry={() => void handleRetry()}
            />
            <BrowserDiagnosticsDock
              browserDiagnostics={browserDiagnostics}
              onContinue={handleContinueBrowserTask}
              onRetry={handleRetryBrowserTask}
              onOpenTarget={handleOpenBrowserTarget}
              onRefresh={() => void refreshAdblockState()}
            />
          </div>

          {shouldRenderFreezeFrame && visibleFreezeFrame ? (
            <div
              className="browser-resize-shell-freeze"
              style={{
                position: 'absolute',
                top: WORKBENCH_TAB_ROW_HEIGHT,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 40,
                pointerEvents: 'none',
                overflow: 'hidden',
                borderRadius: '0 0 var(--workbench-canvas-radius) var(--workbench-canvas-radius)',
                opacity: freezeFrameStyle.opacity,
                filter: freezeFrameStyle.filter,
                transform: freezeFrameStyle.transform,
                willChange: freezeFrameStyle.opacity < 1 ? 'opacity, filter, transform' : 'auto',
                transition: 'none', // 使用 JS 动画，不用 CSS transition
              }}
            >
              <img
                src={visibleFreezeFrame.src}
                alt=""
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  objectFit: 'fill',
                  userSelect: 'none',
                }}
              />
            </div>
          ) : null}

          {/* 浏览器过渡遮罩 - 动画结束后但浏览器未准备好时显示（有过冻结帧时不显示，避免遮挡） */}
          {!shouldShowFreezeFrame && !isBrowserHostFullyVisible && (
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
