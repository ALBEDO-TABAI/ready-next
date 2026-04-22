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
import { WORKBENCH_EDGE_RAIL_SIZE } from '../modules/workbench/chrome'
import { READY_WORKBENCH_MODE_CHANGE_EVENT } from '../modules/workbench/mode-transition'
import { resolveWorkbenchPanelShortcutAction } from '../modules/workbench/panel-shortcuts'
import { useRafResizeDrag } from '../modules/workbench/useRafResizeDrag'
import { useTogglePanelWithResize } from '../modules/workbench/useTogglePanelWithResize'
import { resolveModeTransitionStrategy } from '../modules/workbench/modeTransitionStrategy'
import { readStorage } from '../utils/storage'
import type { BrowserHostLayoutPhase } from '../../shared/browser-view-layout'
import { withRitual, setPanelResizingSignal } from '../modules/overlay/useRitualOverlay'

function ResizeHandle({
  onResize,
  direction = 'right',
  onResizeStateChange,
}: {
  onResize: (delta: number) => void
  direction?: 'right' | 'left'
  onResizeStateChange?: (resizing: boolean) => void
}) {
  const handleMouseDown = useRafResizeDrag({
    onDelta: onResize,
    direction,
    onResizeStateChange,
    dispatchPanelResizeEvent: true,
  })

  return (
    <div
      className="resize-handle"
      onMouseDown={handleMouseDown}
    />
  )
}

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
  const [isMotionSettled, setIsMotionSettled] = useState(true)
  const [isPanelResizing, setIsPanelResizing] = useState(false)
  const [browserLayoutMotionPhase, setBrowserLayoutMotionPhase] = useState<BrowserHostLayoutPhase>('idle')
  const transitionTargetModeRef = useRef<WorkbenchModeType>(workbenchMode)
  const browserLayoutPhase = isPanelResizing ? 'dragging' : browserLayoutMotionPhase

  const isSidebarContentVisible = sidebarVisible
  const chatPanelState: 'expanded' | 'collapsed' = chatPanelVisible ? 'expanded' : 'collapsed'

  useEffect(() => {
    transitionTargetModeRef.current = workbenchMode
  }, [workbenchMode])

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
      backlinks: 'backlinks',
      graph: 'graph',
    }
    const targetVariant = iconVariantMap[icon]
    if (!targetVariant) return

    if (sidebarVisible && sidePanelVariant === targetVariant) {
      handleToggleSidebarWithResize()
      return
    }

    setSidePanelVariant(targetVariant)
    if (!sidebarVisible) {
      handleToggleSidebarWithResize()
    }
  }

  const handleSidebarResize = useCallback((delta: number) => {
    if (!['files', 'search', 'skills', 'backlinks', 'graph'].includes(sidePanelVariant)) return
    const current = useWorkspace.getState().sidePanelWidths.shared
    setSidePanelWidth(sidePanelVariant as 'files' | 'search' | 'skills' | 'backlinks' | 'graph', current + delta)
  }, [setSidePanelWidth, sidePanelVariant])

  const handleChatResize = useCallback((delta: number) => {
    useWorkspace.setState((state) => ({
      chatPanelWidth: Math.max(280, Math.min(600, state.chatPanelWidth + delta))
    }))
  }, [])

  const handleToggleChatPanelWithResize = useTogglePanelWithResize(
    "[data-liquid-shell='chat-panel']",
    toggleChatPanel,
  )
  const handleToggleSidebarWithResize = useTogglePanelWithResize(
    "[data-liquid-shell='side-panel']",
    toggleSidebar,
  )

  const hideIconRail = false
  const activeIcon = useMemo(() => {
    if (sidePanelVariant === 'search') return 'search'
    if (sidePanelVariant === 'skills') return 'skills'
    if (sidePanelVariant === 'backlinks') return 'backlinks'
    if (sidePanelVariant === 'graph') return 'graph'
    return 'folder'
  }, [sidePanelVariant])
  const sidebarShellWidth = sidebarVisible ? sidePanelWidths.shared : 0
  const showSidebarResizeHandle = sidebarVisible
  const chatShellWidth = chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE
  const showChatResizeHandle = chatPanelVisible

  const handlePanelResizeStateChange = useCallback((resizing: boolean) => {
    setIsPanelResizing(resizing)
    setPanelResizingSignal(resizing)
  }, [])

  useEffect(() => () => {
    setPanelResizingSignal(false)
  }, [])

  const handleWorkbenchModeChange = useCallback(async function handleWorkbenchModeChange(nextMode: WorkbenchModeType) {
    const strategy = resolveModeTransitionStrategy(workbenchMode, nextMode)
    if (strategy === 'same-mode') return

    if (splitMode) {
      setWorkbenchMode(nextMode)
      return
    }

    if (strategy === 'dom-only') {
      transitionTargetModeRef.current = nextMode
      setWorkbenchMode(nextMode)
      return
    }

    setIsMotionSettled(false)
    try {
      await withRitual('mode-switch', ({ signalReady }) => {
        const comingFromBrowser = transitionTargetModeRef.current === 'browser' && nextMode !== 'browser'
        const enteringBrowser = transitionTargetModeRef.current !== 'browser' && nextMode === 'browser'
        if (comingFromBrowser) setBrowserLayoutMotionPhase('leaving')
        else if (enteringBrowser) setBrowserLayoutMotionPhase('entering')

        transitionTargetModeRef.current = nextMode
        setWorkbenchMode(nextMode)
        signalReady()
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        throw error
      }
    } finally {
      setBrowserLayoutMotionPhase('idle')
      setIsMotionSettled(true)
    }
  }, [setWorkbenchMode, splitMode, workbenchMode])

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
        handleToggleSidebarWithResize()
        return
      }
      handleToggleChatPanelWithResize()
    }

    window.addEventListener('keydown', handlePanelShortcut)
    return () => {
      window.removeEventListener('keydown', handlePanelShortcut)
    }
  }, [creatingType, renamingPath, handleToggleChatPanelWithResize, handleToggleSidebarWithResize])

  return (
    <LiquidSceneProvider mouseContainer={sceneRef}>
      <div
        ref={sceneRef}
        className="workbench-mode-root relative flex h-full flex-col overflow-hidden"
      >
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

          <TopBar onToggleChatPanel={handleToggleChatPanelWithResize} onWorkbenchModeChange={handleWorkbenchModeChange} />

          <div className="flex flex-1 overflow-hidden" data-workbench-shell="true">
            <IconRail activeIcon={activeIcon} onIconClick={handleIconClick} hidden={hideIconRail} expanded={sidebarVisible} />
            <SidePanel
              variant={sidePanelVariant}
              panelWidth={sidebarShellWidth}
              contentVisible={isSidebarContentVisible}
            />

            {showSidebarResizeHandle && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" onResizeStateChange={handlePanelResizeStateChange} />
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
                <ResizeHandle onResize={handleSplitResize} direction="right" onResizeStateChange={handlePanelResizeStateChange} />
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
              <ResizeHandle onResize={handleChatResize} direction="left" onResizeStateChange={handlePanelResizeStateChange} />
            )}

            <ChatPanel shellWidth={chatShellWidth} panelState={chatPanelState} onTogglePanel={handleToggleChatPanelWithResize} />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
