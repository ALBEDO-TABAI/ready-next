import { useEffect, useCallback, useRef, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../stores/useWorkspace'
import { useMode, type WorkbenchMode as WorkbenchModeType } from '../stores/useMode'
import TopBar from '../components/layout/TopBar'
import IconRail from '../components/layout/IconRail'
import SidePanel, { type SidePanelVariant } from '../components/layout/SidePanel'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
import ChatPanel from '../components/agent/ChatPanel'
import StatusBar from '../components/layout/StatusBar'
import { LiquidSceneProvider } from '../components/ui/LiquidGlassScene'
import { PANEL_RESIZE_STATE_EVENT } from '../modules/browser/resize-events'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

type TransitionKind = 'horizontal' | 'browser-exit' | 'browser-enter'

interface ModeTransitionState {
  id: number
  src: string
  direction: -1 | 1
  kind: TransitionKind
}

interface ContentMotionState {
  id: number
  direction: -1 | 1
  kind: TransitionKind
  active: boolean
  phase: 'entering' | 'exiting' | 'settled'
}

const WORKBENCH_MODE_ORDER: WorkbenchModeType[] = ['browser', 'document', 'rss', 'calendar']
const WORKBENCH_HORIZONTAL_TRANSITION_DURATION = 0.32
const WORKBENCH_BROWSER_TRANSITION_DURATION = 0.24
const WORKBENCH_TRANSITION_EASE = [0.24, 1, 0.36, 1] as const
const WORKBENCH_SNAPSHOT_REFRESH_DELAY_MS = 96
const WORKBENCH_HORIZONTAL_TRAVEL = '100%'
function ResizeHandle({
  onResize,
  direction = 'right'
}: {
  onResize: (delta: number) => void
  direction?: 'right' | 'left'
}) {
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    let lastX = startX

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta !== 0) {
        onResizeRef.current(direction === 'right' ? delta : -delta)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.dispatchEvent(
        new CustomEvent(PANEL_RESIZE_STATE_EVENT, {
          detail: { resizing: false },
        }),
      )
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('resizing')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.dispatchEvent(
      new CustomEvent(PANEL_RESIZE_STATE_EVENT, {
        detail: { resizing: true },
      }),
    )
  }, [direction])

  return (
    <div
      className="resize-handle"
      onMouseDown={handleMouseDown}
    />
  )
}

function resolveWorkbenchTransitionKind(from: WorkbenchModeType, to: WorkbenchModeType): TransitionKind {
  if (from === 'browser' && to !== 'browser') return 'browser-exit'
  if (from !== 'browser' && to === 'browser') return 'browser-enter'
  return 'horizontal'
}

function resolveWorkbenchModeDirection(from: WorkbenchModeType, to: WorkbenchModeType): -1 | 1 {
  return WORKBENCH_MODE_ORDER.indexOf(to) > WORKBENCH_MODE_ORDER.indexOf(from) ? 1 : -1
}

function getWorkbenchTransitionDuration(kind: TransitionKind): number {
  return kind === 'horizontal' ? WORKBENCH_HORIZONTAL_TRANSITION_DURATION : WORKBENCH_BROWSER_TRANSITION_DURATION
}

function getOverlayExitDuration(kind: TransitionKind): number {
  // Overlay exits faster to avoid blocking the new content
  return kind === 'horizontal'
    ? WORKBENCH_HORIZONTAL_TRANSITION_DURATION
    : WORKBENCH_BROWSER_TRANSITION_DURATION * 0.7
}

function getContentMotionInitialFrame(contentMotion: ContentMotionState | null) {
  if (!contentMotion || contentMotion.phase !== 'entering') {
    return { x: '0%', y: 0, scale: 1, opacity: 1 }
  }

  if (contentMotion.kind === 'browser-enter') {
    return { x: '0%', y: 0, scale: 1, opacity: 1 }
  }

  return {
    x: contentMotion.direction > 0 ? WORKBENCH_HORIZONTAL_TRAVEL : `-${WORKBENCH_HORIZONTAL_TRAVEL}`,
    y: 0,
    scale: 1,
    opacity: 1,
  }
}

function getContentMotionAnimateFrame(contentMotion: ContentMotionState | null) {
  return { x: '0%', y: 0, scale: 1, opacity: 1 }
}

function getOverlayExitFrame(modeTransition: ModeTransitionState) {
  if (modeTransition.kind === 'browser-exit') {
    // For browser exit: fade out the snapshot while keeping position
    return { x: '0%', y: 0, scale: 1, opacity: 0 }
  }

  // For horizontal transitions: slide away
  return {
    x: modeTransition.direction > 0 ? `-${WORKBENCH_HORIZONTAL_TRAVEL}` : WORKBENCH_HORIZONTAL_TRAVEL,
    y: 0,
    scale: 1,
    opacity: 0,
  }
}

export default function WorkbenchMode() {
  const {
    toggleSidebar,
    toggleChatPanel,
    setSidePanelWidth,
    sidePanelWidths,
    sidebarVisible,
    chatPanelVisible,
    sidePanelVariant,
    setSidePanelVariant,
  } = useWorkspace()
  const { workbenchMode, splitMode, splitRatio, setSplitRatio, setWorkbenchMode } = useMode()
  const navigate = useNavigate()
  const sceneRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const workbenchViewportRef = useRef<HTMLDivElement>(null)
  const transitionTimerRef = useRef<number | null>(null)
  const contentMotionFrameRef = useRef<number | null>(null)
  const snapshotRefreshTimerRef = useRef<number | null>(null)
  const snapshotCacheRef = useRef<string | null>(null)
  const snapshotCacheModeRef = useRef<WorkbenchModeType | null>(null)
  const queuedModeRef = useRef<WorkbenchModeType | null>(null)
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null)
  const [modeTransition, setModeTransition] = useState<ModeTransitionState | null>(null)
  const [contentMotion, setContentMotion] = useState<ContentMotionState | null>(null)
  const [isModeTransitionSettled, setIsModeTransitionSettled] = useState(true)
  const browserOverlayLockedRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const shouldLockBrowserOverlay = Boolean(modeTransition)
    if (shouldLockBrowserOverlay === browserOverlayLockedRef.current) return

    browserOverlayLockedRef.current = shouldLockBrowserOverlay
    window.dispatchEvent(
      new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, {
        detail: { locked: shouldLockBrowserOverlay },
      }),
    )
  }, [modeTransition])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined' || !browserOverlayLockedRef.current) return
      browserOverlayLockedRef.current = false
      window.dispatchEvent(
        new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, {
          detail: { locked: false },
        }),
      )
    }
  }, [])

  const clearModeTransitionTimers = useCallback(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
    if (contentMotionFrameRef.current) {
      cancelAnimationFrame(contentMotionFrameRef.current)
      contentMotionFrameRef.current = null
    }
    if (snapshotRefreshTimerRef.current) {
      window.clearTimeout(snapshotRefreshTimerRef.current)
      snapshotRefreshTimerRef.current = null
    }
  }, [])

  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    setSplitRatio(splitRatio + deltaPercent)
  }, [splitRatio, setSplitRatio])

  const initializeWorkspace = useCallback(async () => {
    try {
      const savedRoot = localStorage.getItem('ready-workspace-root')

      if (typeof window === 'undefined' || !window.electronAPI) {
        setWorkspaceInitError('工作台初始化失败：当前环境未提供 Electron 文件系统能力。')
        return
      }

      if (savedRoot) {
        useWorkspace.getState().setWorkspaceRoot(savedRoot)
        setWorkspaceInitError(null)
        return
      }

      const homeResult = await window.electronAPI.document.getHome()
      if (homeResult.success && homeResult.path) {
        useWorkspace.getState().setWorkspaceRoot(homeResult.path)
        setWorkspaceInitError(null)
        return
      }

      setWorkspaceInitError('工作台初始化失败：未能获取默认工作目录。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('Workspace init failed:', message)
      setWorkspaceInitError(`工作台初始化失败：${message}`)
    }
  }, [])

  useEffect(() => {
    void initializeWorkspace()
  }, [initializeWorkspace])

  useEffect(() => {
    return () => {
      clearModeTransitionTimers()
    }
  }, [clearModeTransitionTimers])

  const handleIconClick = (icon: string) => {
    if (icon === 'settings') {
      navigate('/settings')
      return
    }

    const iconVariantMap: Record<string, SidePanelVariant> = {
      folder: 'files',
      search: 'search',
      skills: 'skills',
    }
    const targetVariant = iconVariantMap[icon]
    if (!targetVariant) return

    if (sidebarVisible && sidePanelVariant === targetVariant) {
      toggleSidebar()
      return
    }

    setSidePanelVariant(targetVariant)
    if (!sidebarVisible) {
      toggleSidebar()
    }
  }

  const handleSidebarResize = useCallback((delta: number) => {
    if (!['files', 'search', 'skills'].includes(sidePanelVariant)) return
    const current = sidePanelWidths.shared
    setSidePanelWidth(sidePanelVariant as 'files' | 'search' | 'skills', current + delta)
  }, [setSidePanelWidth, sidePanelVariant, sidePanelWidths])

  const handleChatResize = useCallback((delta: number) => {
    useWorkspace.setState((state) => ({
      chatPanelWidth: Math.max(280, Math.min(600, state.chatPanelWidth + delta))
    }))
  }, [])

  const hideIconRail = false
  const activeIcon = useMemo(() => {
    if (sidePanelVariant === 'search') return 'search'
    if (sidePanelVariant === 'skills') return 'skills'
    return 'folder'
  }, [sidePanelVariant])

  const captureWorkbenchSnapshot = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.captureWindowSnapshot || !workbenchViewportRef.current) {
      return null
    }

    const rect = workbenchViewportRef.current.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width <= 0 || height <= 0) return null

    const result = await window.electronAPI.browser.captureWindowSnapshot({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    }).catch(() => null)

    if (!result?.success || !result.data) return null
    return `data:image/png;base64,${result.data}`
  }, [])

  const refreshWorkbenchSnapshotCache = useCallback(async () => {
    const snapshotSrc = await captureWorkbenchSnapshot()
    if (snapshotSrc) {
      snapshotCacheRef.current = snapshotSrc
      snapshotCacheModeRef.current = workbenchMode
    }
    return snapshotSrc
  }, [captureWorkbenchSnapshot, workbenchMode])

  useEffect(() => {
    if (splitMode || !isModeTransitionSettled) return

    snapshotRefreshTimerRef.current = window.setTimeout(() => {
      snapshotRefreshTimerRef.current = null
      void refreshWorkbenchSnapshotCache()
    }, WORKBENCH_SNAPSHOT_REFRESH_DELAY_MS)

    return () => {
      if (snapshotRefreshTimerRef.current) {
        window.clearTimeout(snapshotRefreshTimerRef.current)
        snapshotRefreshTimerRef.current = null
      }
    }
  }, [isModeTransitionSettled, refreshWorkbenchSnapshotCache, splitMode, workbenchMode])

  const handleWorkbenchModeChange = useCallback(async (nextMode: WorkbenchModeType) => {
    if (nextMode === workbenchMode) {
      queuedModeRef.current = null
      return
    }

    if (splitMode) {
      setWorkbenchMode(nextMode)
      return
    }

    if (!isModeTransitionSettled) {
      queuedModeRef.current = nextMode
      return
    }

    clearModeTransitionTimers()
    queuedModeRef.current = null

    const direction = resolveWorkbenchModeDirection(workbenchMode, nextMode)
    const kind = resolveWorkbenchTransitionKind(workbenchMode, nextMode)

    // 如果从浏览器切出，先捕获浏览器画面作为过渡图
    let snapshotSrc: string | null = null
    if (workbenchMode === 'browser') {
      snapshotSrc = await captureWorkbenchSnapshot()
    }
    // 如果不是从浏览器切出，或者浏览器捕获失败，使用缓存的快照
    if (!snapshotSrc) {
      snapshotSrc = snapshotCacheModeRef.current === workbenchMode
        ? snapshotCacheRef.current
        : await refreshWorkbenchSnapshotCache()
    }

    const transitionId = Date.now()

    setIsModeTransitionSettled(false)

    // Phase 1: Start with overlay visible (current state) and new content entering
    if (snapshotSrc) {
      setModeTransition({
        id: transitionId,
        src: snapshotSrc,
        direction,
        kind,
      })
    }

    // Set entering state for new content
    setContentMotion({
      id: transitionId,
      direction,
      kind,
      active: true,
      phase: 'entering',
    })

    setWorkbenchMode(nextMode)

    // Phase 2: After a brief delay, animate overlay out and content in
    contentMotionFrameRef.current = requestAnimationFrame(() => {
      contentMotionFrameRef.current = null

      // Start content animation to visible
      setContentMotion((current) =>
        current ? { ...current, phase: 'settled' } : current
      )

      // Calculate timing for overlay removal
      const overlayDuration = getOverlayExitDuration(kind) * 1000
      const contentDuration = getWorkbenchTransitionDuration(kind) * 1000

      // Remove overlay slightly before content settles to avoid the "stuck" feeling
      transitionTimerRef.current = window.setTimeout(() => {
        setModeTransition(null)

        // Final settle after content animation completes
        const remainingTime = Math.max(0, contentDuration - overlayDuration + 50)
        transitionTimerRef.current = window.setTimeout(() => {
          setContentMotion(null)
          setIsModeTransitionSettled(true)
          transitionTimerRef.current = null
        }, remainingTime)
      }, Math.max(0, overlayDuration - 80))
    })
  }, [
    captureWorkbenchSnapshot,
    clearModeTransitionTimers,
    isModeTransitionSettled,
    refreshWorkbenchSnapshotCache,
    setWorkbenchMode,
    splitMode,
    workbenchMode,
  ])

  useEffect(() => {
    if (!isModeTransitionSettled) return

    const queuedMode = queuedModeRef.current
    if (!queuedMode) return
    if (queuedMode === workbenchMode) {
      queuedModeRef.current = null
      return
    }

    queuedModeRef.current = null

    void (async () => {
      await refreshWorkbenchSnapshotCache()
      await handleWorkbenchModeChange(queuedMode)
    })()
  }, [handleWorkbenchModeChange, isModeTransitionSettled, refreshWorkbenchSnapshotCache, workbenchMode])

  useEffect(() => {
    const visibleModes = [workbenchMode, splitMode].filter(Boolean)
    if (!visibleModes.includes('browser')) {
      void window.electronAPI?.browser.hideAll()
    }
  }, [splitMode, workbenchMode])

  useEffect(() => {
    return () => {
      void window.electronAPI?.browser.hideAll()
    }
  }, [])

  return (
    <LiquidSceneProvider mouseContainer={sceneRef}>
      <div ref={sceneRef} className="workbench-mode-root relative flex h-full flex-col overflow-hidden">
        <div className="relative z-10 flex h-full flex-col">
          {workspaceInitError && (
            <div
              className="glass-surface-floating mx-3 mt-2 flex items-center justify-between rounded-[12px] px-3 py-2 text-[12px]"
              style={{
                border: '1px solid var(--color-orange)',
                color: 'var(--text-secondary)',
                background: 'color-mix(in srgb, var(--surface-floating-bg) 34%, transparent)',
              }}
            >
              <span>{workspaceInitError}</span>
              <button
                type="button"
                onClick={() => void initializeWorkspace()}
                className="rounded-[8px] px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  border: '1px solid transparent',
                  color: 'var(--text-body)',
                }}
              >
                重试
              </button>
            </div>
          )}

          <TopBar onToggleChatPanel={toggleChatPanel} onWorkbenchModeChange={handleWorkbenchModeChange} />

          <div className="flex flex-1 overflow-hidden" data-workbench-shell="true">
            <IconRail activeIcon={activeIcon} onIconClick={handleIconClick} hidden={hideIconRail} expanded={sidebarVisible} />
            <SidePanel variant={sidePanelVariant} />

            {sidebarVisible && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" />
            )}

            {splitMode ? (
              <div className="flex-1 flex min-w-0" ref={splitContainerRef}>
                <div
                  className="flex flex-col min-w-0"
                  style={{
                    flexBasis: `${splitRatio}%`,
                    flexShrink: 0,
                    flexGrow: 0,
                    background: 'transparent',
                  }}
                >
                  <WorkbenchModeOutlet mode={workbenchMode} isMotionSettled={isModeTransitionSettled} />
                </div>
                <ResizeHandle onResize={handleSplitResize} direction="right" />
                <div className="flex-1 flex flex-col min-w-0" style={{ background: 'transparent' }}>
                  <WorkbenchModeOutlet mode={splitMode} isMotionSettled={isModeTransitionSettled} />
                </div>
              </div>
            ) : (
              <div
                ref={workbenchViewportRef}
                className="relative flex-1 flex flex-col min-w-0 overflow-hidden"
                style={{ background: 'transparent' }}
              >
                <motion.div
                  animate={
                    contentMotion?.phase === 'entering'
                      ? getContentMotionInitialFrame(contentMotion)
                      : getContentMotionAnimateFrame(contentMotion)
                  }
                  transition={
                    contentMotion?.phase === 'entering'
                      ? { duration: 0 }
                      : contentMotion
                        ? {
                            duration: getWorkbenchTransitionDuration(contentMotion.kind),
                            ease: WORKBENCH_TRANSITION_EASE,
                          }
                        : { duration: 0 }
                  }
                  className="relative flex-1 min-h-0"
                  style={{
                    zIndex: 1,
                    willChange: contentMotion ? 'transform, opacity' : 'auto',
                  }}
                >
                  <WorkbenchModeOutlet
                    mode={workbenchMode}
                    isMotionSettled={isModeTransitionSettled}
                  />
                </motion.div>

                {modeTransition && (
                  <motion.div
                    key={modeTransition.id}
                    initial={{ x: '0%', y: 0, scale: 1, opacity: 1 }}
                    animate={getOverlayExitFrame(modeTransition)}
                    transition={{
                      duration: getOverlayExitDuration(modeTransition.kind),
                      ease: WORKBENCH_TRANSITION_EASE,
                    }}
                    className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
                    style={{ background: 'transparent' }}
                  >
                    <img
                      src={modeTransition.src}
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
                  </motion.div>
                )}
              </div>
            )}

            {chatPanelVisible && (
              <ResizeHandle onResize={handleChatResize} direction="left" />
            )}

            <ChatPanel />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
