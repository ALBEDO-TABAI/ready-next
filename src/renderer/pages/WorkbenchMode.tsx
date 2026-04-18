import { useEffect, useCallback, useRef, useMemo, useState } from 'react'
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
import { WORKBENCH_EDGE_RAIL_SIZE } from '../modules/workbench/chrome'
import { WORKBENCH_PANEL_MOTION_DURATION_MS } from '../modules/workbench/panel-motion'
import { READY_WORKBENCH_MODE_CHANGE_EVENT } from '../modules/workbench/mode-transition'
import { resolveWorkbenchPanelShortcutAction } from '../modules/workbench/panel-shortcuts'
import { readStorage } from '../utils/storage'
import type { BrowserHostLayoutPhase } from '../../shared/browser-view-layout'

function ResizeHandle({
  onResize,
  direction = 'right',
  onResizeStateChange,
}: {
  onResize: (delta: number) => void
  direction?: 'right' | 'left'
  onResizeStateChange?: (resizing: boolean) => void
}) {
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    let lastX = startX
    let pendingDelta = 0
    let rafId: number | null = null

    const flushPendingDelta = () => {
      rafId = null
      if (pendingDelta === 0) return
      const delta = pendingDelta
      pendingDelta = 0
      onResizeRef.current(direction === 'right' ? delta : -delta)
    }

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta !== 0) {
        pendingDelta += delta
        if (rafId === null) {
          rafId = window.requestAnimationFrame(flushPendingDelta)
        }
      }
    }

    const handleMouseUp = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        flushPendingDelta()
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeStateChange?.(false)
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
    onResizeStateChange?.(true)
    window.dispatchEvent(
      new CustomEvent(PANEL_RESIZE_STATE_EVENT, {
        detail: { resizing: true },
      }),
    )
  }, [direction, onResizeStateChange])

  return (
    <div
      className="resize-handle"
      onMouseDown={handleMouseDown}
    />
  )
}

// D方案：简单的过渡状态管理
const MODE_TRANSITION_DURATION_MS = 350
const PANEL_CONTENT_TRANSITION_MS = WORKBENCH_PANEL_MOTION_DURATION_MS
const SIDEBAR_CONTENT_TRANSITION_MS = WORKBENCH_PANEL_MOTION_DURATION_MS

export default function WorkbenchMode() {
  const {
    toggleSidebar,
    toggleChatPanel,
    setSidePanelWidth,
    sidePanelWidths,
    sidebarVisible,
    chatPanelVisible,
    chatPanelWidth,
    sidePanelVariant,
    setSidePanelVariant,
    renamingPath,
    creatingType,
  } = useWorkspace()
  const { workbenchMode, splitMode, workbenchSplitRatio, setWorkbenchSplitRatio, setWorkbenchMode } = useMode()
  const navigate = useNavigate()
  const sceneRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null)
  // D方案：仅用于控制 BrowserView 的显示时机
  const [isMotionSettled, setIsMotionSettled] = useState(true)
  const [isPanelResizing, setIsPanelResizing] = useState(false)
  const [browserLayoutMotionPhase, setBrowserLayoutMotionPhase] = useState<BrowserHostLayoutPhase>('idle')
  const [shouldRenderSidebarShell, setShouldRenderSidebarShell] = useState(sidebarVisible)
  const [isSidebarContentVisible, setIsSidebarContentVisible] = useState(sidebarVisible)
  const [chatPanelState, setChatPanelState] = useState<'expanding' | 'expanded' | 'collapsing' | 'collapsed'>(
    chatPanelVisible ? 'expanded' : 'collapsed',
  )
  const transitionTimerRef = useRef<number | null>(null)
  const sidebarShellTimerRef = useRef<number | null>(null)
  const sidebarEnterFrameRef = useRef<number | null>(null)
  const chatPanelStateTimerRef = useRef<number | null>(null)
  const transitionTargetModeRef = useRef<WorkbenchModeType>(workbenchMode)
  const browserLayoutPhase = isPanelResizing ? 'dragging' : browserLayoutMotionPhase

  useEffect(() => {
    transitionTargetModeRef.current = workbenchMode
  }, [workbenchMode])

  useEffect(() => {
    if (sidebarShellTimerRef.current) {
      window.clearTimeout(sidebarShellTimerRef.current)
      sidebarShellTimerRef.current = null
    }
    if (sidebarEnterFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarEnterFrameRef.current)
      sidebarEnterFrameRef.current = null
    }

    if (sidebarVisible) {
      setShouldRenderSidebarShell(true)
      sidebarEnterFrameRef.current = window.requestAnimationFrame(() => {
        sidebarEnterFrameRef.current = null
        setIsSidebarContentVisible(true)
      })
      return
    }

    setIsSidebarContentVisible(false)
    sidebarShellTimerRef.current = window.setTimeout(() => {
      sidebarShellTimerRef.current = null
      setShouldRenderSidebarShell(false)
    }, SIDEBAR_CONTENT_TRANSITION_MS)
  }, [sidebarVisible])

  useEffect(() => {
    if (chatPanelStateTimerRef.current) {
      window.clearTimeout(chatPanelStateTimerRef.current)
      chatPanelStateTimerRef.current = null
    }

    if (chatPanelVisible) {
      setChatPanelState((previous) => {
        if (previous === 'expanded') return previous
        return 'expanding'
      })
      chatPanelStateTimerRef.current = window.setTimeout(() => {
        chatPanelStateTimerRef.current = null
        setChatPanelState('expanded')
      }, PANEL_CONTENT_TRANSITION_MS)
      return
    }

    setChatPanelState((previous) => {
      if (previous === 'collapsed') return previous
      return 'collapsing'
    })
    chatPanelStateTimerRef.current = window.setTimeout(() => {
      chatPanelStateTimerRef.current = null
      setChatPanelState('collapsed')
    }, PANEL_CONTENT_TRANSITION_MS)
  }, [chatPanelVisible])

  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    const currentRatio = useMode.getState().workbenchSplitRatio
    setWorkbenchSplitRatio(currentRatio + deltaPercent)
  }, [setWorkbenchSplitRatio])

  const initializeWorkspace = useCallback(async () => {
    try {
      const savedRoot = readStorage('ready-workspace-root')

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
    const current = useWorkspace.getState().sidePanelWidths.shared
    setSidePanelWidth(sidePanelVariant as 'files' | 'search' | 'skills', current + delta)
  }, [setSidePanelWidth, sidePanelVariant])

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
  const sidebarShellWidth = shouldRenderSidebarShell ? sidePanelWidths.shared : 0
  const showSidebarResizeHandle = shouldRenderSidebarShell
  const chatShellWidth = chatPanelState === 'collapsed' ? WORKBENCH_EDGE_RAIL_SIZE : chatPanelWidth
  const showChatResizeHandle = chatPanelState !== 'collapsed'

  // D方案：简化的模式切换处理
  const handleWorkbenchModeChange = useCallback(function handleWorkbenchModeChange(nextMode: WorkbenchModeType) {
    if (nextMode === workbenchMode) return

    if (splitMode) {
      setWorkbenchMode(nextMode)
      return
    }
    const isRedirectingDuringMotion = !isMotionSettled

    // 清除之前的定时器
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }

    if (!isRedirectingDuringMotion && transitionTargetModeRef.current === 'browser' && nextMode !== 'browser') {
      setBrowserLayoutMotionPhase('leaving')
      void window.electronAPI?.browser.hideAll()
    } else if (!isRedirectingDuringMotion && transitionTargetModeRef.current !== 'browser' && nextMode === 'browser') {
      setBrowserLayoutMotionPhase('entering')
    } else if (transitionTargetModeRef.current === nextMode) {
      setBrowserLayoutMotionPhase('idle')
    }

    // 开始过渡：先标记为未稳定（BrowserView 等需要暂停更新）
    if (!isRedirectingDuringMotion) {
      setIsMotionSettled(false)
    }

    // 执行模式切换
    transitionTargetModeRef.current = nextMode
    setWorkbenchMode(nextMode)

    // 过渡结束后标记为稳定
    transitionTimerRef.current = window.setTimeout(() => {
      setIsMotionSettled(true)
      setBrowserLayoutMotionPhase('idle')
      transitionTimerRef.current = null
    }, MODE_TRANSITION_DURATION_MS)
  }, [isMotionSettled, setWorkbenchMode, splitMode, workbenchMode])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        window.clearTimeout(transitionTimerRef.current)
      }
      if (sidebarShellTimerRef.current) {
        window.clearTimeout(sidebarShellTimerRef.current)
      }
      if (sidebarEnterFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarEnterFrameRef.current)
      }
      if (chatPanelStateTimerRef.current) {
        window.clearTimeout(chatPanelStateTimerRef.current)
      }
    }
  }, [])

  // BrowserView 隐藏控制
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

  useEffect(() => {
    const handleExternalWorkbenchModeChange = (event: Event) => {
      const nextMode = (event as CustomEvent<{ mode?: WorkbenchModeType }>).detail?.mode
      if (!nextMode) return
      handleWorkbenchModeChange(nextMode)
    }

    window.addEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    return () => {
      window.removeEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    }
  }, [handleWorkbenchModeChange])

  useEffect(() => {
    const handlePanelShortcut = (event: KeyboardEvent) => {
      const handledAction = resolveWorkbenchPanelShortcutAction({
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        target: event.target,
        selectionText: window.getSelection()?.toString() ?? '',
        renamingPath,
        creatingType,
      })
      if (!handledAction) return

      event.preventDefault()
      if (handledAction === 'toggle-sidebar') {
        toggleSidebar()
        return
      }
      toggleChatPanel()
    }

    window.addEventListener('keydown', handlePanelShortcut)
    return () => {
      window.removeEventListener('keydown', handlePanelShortcut)
    }
  }, [creatingType, renamingPath, toggleChatPanel, toggleSidebar])

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
            <SidePanel
              variant={sidePanelVariant}
              panelWidth={sidebarShellWidth}
              contentVisible={isSidebarContentVisible}
            />

            {showSidebarResizeHandle && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" onResizeStateChange={setIsPanelResizing} />
            )}

            {splitMode ? (
              <div className="flex-1 flex min-w-0" ref={splitContainerRef}>
                <div
                  className="flex flex-col min-w-0"
                  style={{
                    flexBasis: `${workbenchSplitRatio}%`,
                    flexShrink: 0,
                    flexGrow: 0,
                    background: 'transparent',
                  }}
                >
                  <WorkbenchModeOutlet
                    mode={workbenchMode}
                    isMotionSettled={isMotionSettled}
                    browserLayoutPhase={browserLayoutPhase}
                  />
                </div>
                <ResizeHandle onResize={handleSplitResize} direction="right" onResizeStateChange={setIsPanelResizing} />
                <div className="flex-1 flex flex-col min-w-0" style={{ background: 'transparent' }}>
                  <WorkbenchModeOutlet
                    mode={splitMode}
                    isMotionSettled={isMotionSettled}
                    browserLayoutPhase={browserLayoutPhase}
                  />
                </div>
              </div>
            ) : (
              <div
                className="relative flex-1 flex flex-col min-w-0 overflow-hidden"
                style={{ background: 'transparent' }}
              >
                <WorkbenchModeOutlet
                  mode={workbenchMode}
                  isMotionSettled={isMotionSettled}
                  browserLayoutPhase={browserLayoutPhase}
                />
              </div>
            )}

            {showChatResizeHandle && (
              <ResizeHandle onResize={handleChatResize} direction="left" onResizeStateChange={setIsPanelResizing} />
            )}

            <ChatPanel shellWidth={chatShellWidth} panelState={chatPanelState} />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
