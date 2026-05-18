import { useEffect, useCallback, useRef, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace, type SidePanelWidthKey, reconcileWorkspaceWatchersFromStore } from '../stores/useWorkspace'
import { useMode, type WorkbenchMode as WorkbenchModeType } from '../stores/useMode'
import { useDocTabs } from '../stores/useDocTabs'
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
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from '../modules/browser/resize-events'
import { freezeVisibleDocumentLayoutWidths } from '../modules/document/documentLayoutFreeze'
import { readStorage } from '../utils/storage'
import type { BrowserHostLayoutPhase } from '../../shared/browser-view-layout'
import { withRitual, setPanelResizingSignal } from '../modules/overlay/useRitualOverlay'

const MIN_SIDE_PANEL_WIDTH = 220
const MAX_SIDE_PANEL_WIDTH = 420
const MIN_CHAT_PANEL_WIDTH = 280
const MAX_CHAT_PANEL_WIDTH = 600
const INSTANT_PANEL_TOGGLE_SETTLE_MS = 80

function clampWorkbenchSidePanelWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_SIDE_PANEL_WIDTH
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(MAX_SIDE_PANEL_WIDTH, Math.round(width)))
}

function clampWorkbenchChatPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return 380
  return Math.max(MIN_CHAT_PANEL_WIDTH, Math.min(MAX_CHAT_PANEL_WIDTH, Math.round(width)))
}

function setShellWidth(selector: string, width: number) {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return
  element.style.width = `${width}px`
  element.style.minWidth = `${width}px`
}

function setShellWillChange(selector: string, enabled: boolean) {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return
  if (enabled) {
    element.style.setProperty('will-change', 'width, min-width')
  } else {
    element.style.removeProperty('will-change')
  }
}

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

function WorkbenchSplitResizeHandle({
  onResize,
  onResizeStateChange,
}: {
  onResize: (delta: number) => void
  onResizeStateChange?: (resizing: boolean) => void
}) {
  const handleMouseDown = useRafResizeDrag({
    onDelta: onResize,
    direction: 'right',
    onResizeStateChange,
    dispatchPanelResizeEvent: true,
  })

  return (
    <div
      className="workbench-split-resize-handle"
      onMouseDown={handleMouseDown}
    >
      <span className="workbench-split-resize-handle__grip" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} />
        ))}
      </span>
    </div>
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
  const documentSplitTabId = useDocTabs(s => s.splitTabId)
  const navigate = useNavigate()
  const sceneRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const liveSidebarWidthRef = useRef(sidePanelWidths.shared)
  const liveChatPanelWidthRef = useRef(chatPanelWidth)
  const restoreDocumentLayoutFreezeRef = useRef<(() => void) | null>(null)
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null)
  const [isMotionSettled, setIsMotionSettled] = useState(true)
  const [isPanelResizing, setIsPanelResizing] = useState(false)
  const [browserLayoutMotionPhase, setBrowserLayoutMotionPhase] = useState<BrowserHostLayoutPhase>('idle')
  const transitionTargetModeRef = useRef<WorkbenchModeType>(workbenchMode)
  const browserLayoutPhase = isPanelResizing ? 'dragging' : browserLayoutMotionPhase

  const isSidebarContentVisible = sidebarVisible
  const chatPanelState: 'expanded' | 'collapsed' = chatPanelVisible ? 'expanded' : 'collapsed'
  const hasDocumentSplitPane = Boolean(documentSplitTabId) && (workbenchMode === 'document' || splitMode === 'document')
  const hasVisibleDocumentMode = workbenchMode === 'document' || splitMode === 'document'
  const panelWidthTransitionMode = hasDocumentSplitPane ? 'instant' : 'animated'
  const panelToggleSettleMs = hasDocumentSplitPane ? INSTANT_PANEL_TOGGLE_SETTLE_MS : undefined

  useEffect(() => {
    transitionTargetModeRef.current = workbenchMode
  }, [workbenchMode])

  useEffect(() => {
    const nextWidth = clampWorkbenchSidePanelWidth(sidePanelWidths.shared)
    liveSidebarWidthRef.current = nextWidth
    if (sidebarVisible) {
      setShellWidth("[data-liquid-shell='side-panel']", nextWidth)
    }
  }, [sidePanelWidths.shared, sidebarVisible])

  useEffect(() => {
    const nextWidth = clampWorkbenchChatPanelWidth(chatPanelWidth)
    liveChatPanelWidthRef.current = nextWidth
    if (chatPanelVisible) {
      setShellWidth("[data-liquid-shell='chat-panel']", nextWidth)
    }
  }, [chatPanelVisible, chatPanelWidth])

  useEffect(() => {
    const setDocumentLayoutFrozen = (frozen: boolean) => {
      if (!frozen) {
        restoreDocumentLayoutFreezeRef.current?.()
        restoreDocumentLayoutFreezeRef.current = null
        return
      }

      if (!hasVisibleDocumentMode) return
      restoreDocumentLayoutFreezeRef.current?.()
      restoreDocumentLayoutFreezeRef.current = freezeVisibleDocumentLayoutWidths()
    }

    const handlePanelResizeState = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      setDocumentLayoutFrozen(Boolean(detail?.resizing))
    }

    window.addEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
    return () => {
      window.removeEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
      setDocumentLayoutFrozen(false)
    }
  }, [hasVisibleDocumentMode])

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
        // Re-validate the persisted root on every launch — if it was set
        // before the validation rules existed (e.g. legacy auto-home from
        // bb529f1), drop it so the user is re-prompted.
        const result = useWorkspace.getState().setWorkspaceRoot(savedRoot)
        if (result.ok) {
          setWorkspaceInitError(null)
          // setWorkspaceRoot already triggers reconcile; the call below is
          // a redundant no-op on this branch but kept for symmetry.
          await reconcileWorkspaceWatchersFromStore()
          return
        }
        // Saved root is no longer acceptable — clear and fall through to
        // the first-time picker UX.
        try { window.localStorage?.removeItem('ready-workspace-root') } catch { /* ignore */ }
        console.warn('[workspace] Dropped persisted root:', result.reason, result.message)
      }

      // No (valid) saved root → leave workspaceRoot null. NEVER auto-fallback
      // to homedir; that triggers the bb529f1 681K-file index storm.
      setWorkspaceInitError(null)

      // Cold-start watcher rehydrate: `pinnedFolders` came back from
      // localStorage during store init, but store init does NOT trigger the
      // mutation-site reconcile. This call ensures every safe pinned folder
      // gets its watcher even when there's no (or an invalidated) workspaceRoot.
      await reconcileWorkspaceWatchersFromStore()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('Workspace init failed:', message)
      setWorkspaceInitError(`工作台初始化失败：${message}`)
    }
  }, [])

  useEffect(() => {
    void initializeWorkspace()
  }, [initializeWorkspace])

  const handlePanelResizeStateChange = useCallback((resizing: boolean) => {
    setIsPanelResizing(resizing)
    setPanelResizingSignal(resizing)
  }, [])

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
    const nextWidth = clampWorkbenchSidePanelWidth(liveSidebarWidthRef.current + delta)
    liveSidebarWidthRef.current = nextWidth
    setShellWidth("[data-liquid-shell='side-panel']", nextWidth)
  }, [sidePanelVariant])

  const handleChatResize = useCallback((delta: number) => {
    const nextWidth = clampWorkbenchChatPanelWidth(liveChatPanelWidthRef.current + delta)
    liveChatPanelWidthRef.current = nextWidth
    setShellWidth("[data-liquid-shell='chat-panel']", nextWidth)
  }, [])

  const handleSidebarResizeStateChange = useCallback((resizing: boolean) => {
    if (resizing) {
      liveSidebarWidthRef.current = clampWorkbenchSidePanelWidth(useWorkspace.getState().sidePanelWidths.shared)
      setShellWillChange("[data-liquid-shell='side-panel']", true)
      handlePanelResizeStateChange(true)
      return
    }

    setShellWillChange("[data-liquid-shell='side-panel']", false)
    const nextWidth = clampWorkbenchSidePanelWidth(liveSidebarWidthRef.current)
    liveSidebarWidthRef.current = nextWidth
    if (['files', 'search', 'skills', 'backlinks', 'graph'].includes(sidePanelVariant)) {
      setSidePanelWidth(sidePanelVariant as SidePanelWidthKey, nextWidth)
    }
    handlePanelResizeStateChange(false)
  }, [handlePanelResizeStateChange, setSidePanelWidth, sidePanelVariant])

  const handleChatResizeStateChange = useCallback((resizing: boolean) => {
    if (resizing) {
      liveChatPanelWidthRef.current = clampWorkbenchChatPanelWidth(useWorkspace.getState().chatPanelWidth)
      setShellWillChange("[data-liquid-shell='chat-panel']", true)
      handlePanelResizeStateChange(true)
      return
    }

    setShellWillChange("[data-liquid-shell='chat-panel']", false)
    const nextWidth = clampWorkbenchChatPanelWidth(liveChatPanelWidthRef.current)
    liveChatPanelWidthRef.current = nextWidth
    useWorkspace.setState({ chatPanelWidth: nextWidth })
    handlePanelResizeStateChange(false)
  }, [handlePanelResizeStateChange])

  const handleToggleChatPanelWithResize = useTogglePanelWithResize(
    "[data-liquid-shell='chat-panel']",
    toggleChatPanel,
    { safetyMs: panelToggleSettleMs },
  )
  const handleToggleSidebarWithResize = useTogglePanelWithResize(
    "[data-liquid-shell='side-panel']",
    toggleSidebar,
    { safetyMs: panelToggleSettleMs },
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

  useEffect(() => () => {
    setPanelResizingSignal(false)
  }, [])

  const handleWorkbenchModeChange = useCallback(async function handleWorkbenchModeChange(nextMode: WorkbenchModeType) {
    const strategy = resolveModeTransitionStrategy(workbenchMode, nextMode)

    if (splitMode) {
      setWorkbenchMode(nextMode)
      return
    }

    if (strategy === 'same-mode') return

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

          <div
            className="flex flex-1 overflow-hidden"
            data-workbench-shell="true"
            data-panel-width-transition={panelWidthTransitionMode}
          >
            <IconRail activeIcon={activeIcon} onIconClick={handleIconClick} hidden={hideIconRail} expanded={sidebarVisible} />
            <SidePanel
              variant={sidePanelVariant}
              panelWidth={sidebarShellWidth}
              contentVisible={isSidebarContentVisible}
            />

            {showSidebarResizeHandle && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" onResizeStateChange={handleSidebarResizeStateChange} />
            )}

            {splitMode ? (
              <div
                className="workbench-split-layout flex-1 flex min-w-0"
                ref={splitContainerRef}
                data-workbench-split-layout="true"
              >
                <div
                  className="workbench-split-pane flex flex-col min-w-0"
                  style={{
                    flexBasis: `${workbenchSplitRatio}%`,
                    flexShrink: 0,
                    flexGrow: 0,
                    background: 'transparent',
                  }}
                >
                  <WorkbenchModeOutlet
                    mode={workbenchMode}
                    mountedModes={[workbenchMode]}
                    isMotionSettled={isMotionSettled}
                    browserLayoutPhase={browserLayoutPhase}
                  />
                </div>
                <WorkbenchSplitResizeHandle
                  onResize={handleSplitResize}
                  onResizeStateChange={handlePanelResizeStateChange}
                />
                <div className="workbench-split-pane flex-1 flex flex-col min-w-0" style={{ background: 'transparent' }}>
                  <WorkbenchModeOutlet
                    mode={splitMode}
                    mountedModes={[splitMode]}
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
              <ResizeHandle onResize={handleChatResize} direction="left" onResizeStateChange={handleChatResizeStateChange} />
            )}

            <ChatPanel shellWidth={chatShellWidth} panelState={chatPanelState} onTogglePanel={handleToggleChatPanelWithResize} />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
