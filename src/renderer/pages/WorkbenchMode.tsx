import { useEffect, useCallback, useRef, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace, type SidePanelWidthKey, reconcileWorkspaceWatchersFromStore, getNextSidePanelVariant } from '../stores/useWorkspace'
import { useMode, type WorkbenchMode as WorkbenchModeType } from '../stores/useMode'
import { useDocTabs } from '../stores/useDocTabs'
import TopBar from '../components/layout/TopBar'
import IconRail from '../components/layout/IconRail'
import SidePanel, { type SidePanelVariant } from '../components/layout/SidePanel'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
import ChatPanel from '../components/agent/ChatPanel'
import { ScheduledTasksWorkspace } from '../components/agent/scheduled-tasks/ScheduledTasksWorkspace'
import type { ScheduledTasksSummary } from '../components/agent/scheduled-tasks/ScheduledTasksPanel'
import GraphWorkspace, { type GraphWorkspaceRequest } from '../components/graph/GraphWorkspace'
import { invalidateGraphWorkspace } from '../components/graph/graph-session'
import StatusBar from '../components/layout/StatusBar'
import { LiquidSceneProvider } from '../components/ui/LiquidGlassScene'
import { WORKBENCH_EDGE_RAIL_SIZE } from '../modules/workbench/chrome'
import { READY_WORKBENCH_MODE_CHANGE_EVENT } from '../modules/workbench/mode-transition'
import { resolveWorkbenchSplitToggle } from '../modules/workbench/mode-split'
import { resolveWorkbenchPanelShortcutAction } from '../modules/workbench/panel-shortcuts'
import { useRafResizeDrag } from '../modules/workbench/useRafResizeDrag'
import { useTogglePanelWithResize } from '../modules/workbench/useTogglePanelWithResize'
import { resolveModeTransitionStrategy } from '../modules/workbench/modeTransitionStrategy'
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from '../modules/browser/resize-events'
import { freezeVisibleDocumentLayoutWidths } from '../modules/document/documentLayoutFreeze'
import { readStorage } from '../utils/storage'
import type { BrowserHostLayoutPhase } from '../../shared/browser-view-layout'
import { nextIntentId } from '../../shared/browser-view-intent'
import { createModeSwitchAckWaiter } from '../modules/browser/modeSwitchAckWaiter'
import { withRitual, setPanelResizingSignal } from '../modules/overlay/useRitualOverlay'
import { useAgent } from '../stores/useAgent'
import '../styles/scheduled-tasks.css'
import '../styles/knowledge-graph.css'

const MIN_SIDE_PANEL_WIDTH = 220
const MAX_SIDE_PANEL_WIDTH = 420
const MIN_CHAT_PANEL_WIDTH = 280
const MAX_CHAT_PANEL_WIDTH = 600
const INSTANT_PANEL_TOGGLE_SETTLE_MS = 80
const TRANSPARENT_SURFACE_REFRESH_DELAYS_MS = [240, 900] as const

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
    sidePanelWidths: rawSidePanelWidths,
    sidebarVisible,
    chatPanelVisible,
    chatPanelWidth: rawChatPanelWidth,
    sidePanelVariant,
    setSidePanelVariant,
    renamingPath,
    creatingType,
    workspaceRoot,
    pinnedFolders,
  } = useWorkspace()
  const { agents, currentAgent, currentScopeId, loadConversation } = useAgent()
  const chatPanelWidth = clampWorkbenchChatPanelWidth(rawChatPanelWidth)
  const sidePanelWidths = useMemo(
    () => ({ ...rawSidePanelWidths, shared: clampWorkbenchSidePanelWidth(rawSidePanelWidths.shared) }),
    [rawSidePanelWidths],
  )
  const { workbenchMode, splitMode, workbenchSplitRatio, setWorkbenchSplitRatio, setWorkbenchMode, setSplitMode } = useMode()
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
  const [scheduledTasksOpen, setScheduledTasksOpen] = useState(false)
  const [graphWorkspaceRequest, setGraphWorkspaceRequest] = useState<GraphWorkspaceRequest | null>(null)
  const [scheduledTasksSummary, setScheduledTasksSummary] = useState<ScheduledTasksSummary>({
    enabledCount: 0,
    attentionCount: 0,
  })
  const transitionTargetModeRef = useRef<WorkbenchModeType>(workbenchMode)
  const workbenchSurfaceRefreshTimersRef = useRef<number[]>([])
  const browserLayoutPhase = isPanelResizing ? 'dragging' : browserLayoutMotionPhase
  const scheduledWorkspaceRoots = useMemo(() => (
    workspaceRoot
      ? [workspaceRoot, ...pinnedFolders.filter((path) => path !== workspaceRoot)]
      : pinnedFolders
  ), [pinnedFolders, workspaceRoot])

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
    const subscribe = window.electronAPI?.document?.onIndexChanged
    if (!subscribe) return
    let timer: number | null = null
    const pendingRoots = new Set<string>()
    const unsubscribe = subscribe((event) => {
      pendingRoots.add(event.workspaceRoot)
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        const roots = [...pendingRoots]
        pendingRoots.clear()
        void Promise.all(roots.map((root) => invalidateGraphWorkspace(root)))
      }, 50)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  const clearScheduledWorkbenchSurfaceRefresh = useCallback(() => {
    workbenchSurfaceRefreshTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    workbenchSurfaceRefreshTimersRef.current = []
  }, [])

  const scheduleWorkbenchSurfaceRefresh = useCallback(() => {
    clearScheduledWorkbenchSurfaceRefresh()
    const refresh = window.electronAPI?.window?.refreshTransparentSurface
    if (!refresh) return

    workbenchSurfaceRefreshTimersRef.current = TRANSPARENT_SURFACE_REFRESH_DELAYS_MS.map((delay) => (
      window.setTimeout(() => {
        void refresh()
      }, delay)
    ))
  }, [clearScheduledWorkbenchSurfaceRefresh])

  const handleGraphWorkspaceOpen = useCallback((request: GraphWorkspaceRequest) => {
    setScheduledTasksOpen(false)
    setGraphWorkspaceRequest(request)
  }, [])

  const handleScheduledTasksToggle = useCallback(() => {
    setGraphWorkspaceRequest(null)
    setScheduledTasksOpen((value) => !value)
  }, [])

  useEffect(() => {
    scheduleWorkbenchSurfaceRefresh()
    return clearScheduledWorkbenchSurfaceRefresh
  }, [clearScheduledWorkbenchSurfaceRefresh, scheduleWorkbenchSurfaceRefresh])

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
    if (icon === 'user') {
      navigate('/settings?section=user-profiles')
      return
    }

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

  // Stage X4 PR-shell-2 — in-flight mode-switch ack waiter. The ref
  // holds the active waiter's `cancel` handle so a rapid second mode
  // click orphans the first waiter (per plan §9 line 684).
  const pendingModeSwitchAckCancelRef = useRef<(() => void) | null>(null)

  const handleWorkbenchModeChange = useCallback(async function handleWorkbenchModeChange(nextMode: WorkbenchModeType) {
    const strategy = resolveModeTransitionStrategy(workbenchMode, nextMode)

    if (splitMode) {
      setWorkbenchMode(nextMode)
      scheduleWorkbenchSurfaceRefresh()
      return
    }

    if (strategy === 'same-mode') return

    if (strategy === 'dom-only') {
      transitionTargetModeRef.current = nextMode
      setWorkbenchMode(nextMode)
      scheduleWorkbenchSurfaceRefresh()
      return
    }

    // Stage X4 PR-shell-2 — orphan any in-flight ack waiter from a
    // previous click so its late ack is dropped per stale-id rule.
    pendingModeSwitchAckCancelRef.current?.()
    pendingModeSwitchAckCancelRef.current = null

    setIsMotionSettled(false)
    let didCommitModeChange = false
    try {
      await withRitual('mode-switch', async ({ signalReady }) => {
        const comingFromBrowser = transitionTargetModeRef.current === 'browser' && nextMode !== 'browser'
        const enteringBrowser = transitionTargetModeRef.current !== 'browser' && nextMode === 'browser'
        if (comingFromBrowser) setBrowserLayoutMotionPhase('leaving')
        else if (enteringBrowser) setBrowserLayoutMotionPhase('entering')

        // PR-shell-2 ordered ritual: when leaving browser, emit
        // `hide-all` first and wait for the matching ack (100 ms cap)
        // BEFORE flipping renderer mode so the native BrowserView is
        // off-top by the time the DOM-only overlay mounts.
        if (comingFromBrowser) {
          const ackSource = window.electronAPI?.browser?.onIntentAck
          const intentId = nextIntentId()
          window.electronAPI?.browser?.sendIntent({
            kind: 'hide-all',
            intentId,
            reason: 'mode-switch-prepare',
          })
          if (ackSource) {
            const waiter = createModeSwitchAckWaiter(ackSource, intentId)
            pendingModeSwitchAckCancelRef.current = waiter.cancel
            try {
              await waiter.wait
            } finally {
              if (pendingModeSwitchAckCancelRef.current === waiter.cancel) {
                pendingModeSwitchAckCancelRef.current = null
              }
            }
          }
        }

        transitionTargetModeRef.current = nextMode
        setWorkbenchMode(nextMode)
        didCommitModeChange = true
        signalReady()
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        throw error
      }
    } finally {
      setBrowserLayoutMotionPhase('idle')
      setIsMotionSettled(true)
      if (didCommitModeChange) scheduleWorkbenchSurfaceRefresh()
    }
  }, [scheduleWorkbenchSurfaceRefresh, setWorkbenchMode, splitMode, workbenchMode])

  const handleWorkbenchSplitToggle = useCallback((mode: WorkbenchModeType) => {
    setSplitMode(resolveWorkbenchSplitToggle({
      workbenchMode,
      splitMode,
      requestedMode: mode,
    }))
  }, [setSplitMode, splitMode, workbenchMode])

  useEffect(() => {
    return () => {
      // Stage X4 PR-shell-1 — unmount cleanup hides all hosts via the
      // BrowserViewIntent boundary; reason = `mode-switch-prepare`
      // because the renderer is tearing down its mode-aware shell.
      window.electronAPI?.browser?.sendIntent({
        kind: 'hide-all',
        intentId: nextIntentId(),
        reason: 'mode-switch-prepare',
      })
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
      if (handledAction === 'cycle-side-panel') {
        const { sidePanelVariant: current, sidebarVisible: visible, setSidePanelVariant: applyVariant } = useWorkspace.getState()
        applyVariant(getNextSidePanelVariant(current))
        if (!visible) {
          handleToggleSidebarWithResize()
        }
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

          <TopBar />

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
              onGraphWorkspaceOpen={handleGraphWorkspaceOpen}
              graphWorkspaceOpen={graphWorkspaceRequest !== null}
            />

            {showSidebarResizeHandle && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" onResizeStateChange={handleSidebarResizeStateChange} />
            )}

            <div
              className="relative flex flex-1 min-w-0 overflow-hidden"
              style={{ background: 'transparent' }}
            >
              {splitMode ? (
                <div
                  className="workbench-split-layout flex-1 flex min-w-0"
                  ref={splitContainerRef}
                  data-workbench-split-layout="true"
                  data-workbench-content-backdrop="true"
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
                      suspended={graphWorkspaceRequest !== null}
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
                      suspended={graphWorkspaceRequest !== null}
                    />
                  </div>
                </div>
              ) : (
                <div className="relative flex flex-1 flex-col min-w-0 overflow-hidden" data-workbench-content-backdrop="true">
                  <WorkbenchModeOutlet
                    mode={workbenchMode}
                    isMotionSettled={isMotionSettled}
                    browserLayoutPhase={browserLayoutPhase}
                    suspended={graphWorkspaceRequest !== null}
                  />
                </div>
              )}

              <ScheduledTasksWorkspace
                open={scheduledTasksOpen}
                onClose={() => setScheduledTasksOpen(false)}
                currentScopeId={currentScopeId}
                currentAgentId={currentAgent || 'butler'}
                workspaceRoots={scheduledWorkspaceRoots}
                agentOptions={agents.map((agent) => ({ id: agent.name, name: agent.displayName }))}
                onSummaryChange={setScheduledTasksSummary}
                onOpenOccurrence={(occurrence) => {
                  void window.electronAPI.scheduledTasks.get(occurrence.scheduleId).then((response) => {
                    if (response.success && response.data.scopeId) {
                      void loadConversation(response.data.scopeId)
                      setScheduledTasksOpen(false)
                    }
                  })
                }}
              />
              {graphWorkspaceRequest && (
                <GraphWorkspace
                  request={graphWorkspaceRequest}
                  workspaceRoot={workspaceRoot}
                  onClose={() => setGraphWorkspaceRequest(null)}
                />
              )}
            </div>

            {showChatResizeHandle && (
              <ResizeHandle onResize={handleChatResize} direction="left" onResizeStateChange={handleChatResizeStateChange} />
            )}

            <ChatPanel
              shellWidth={chatShellWidth}
              panelState={chatPanelState}
              workbenchMode={workbenchMode}
              splitMode={splitMode}
              onWorkbenchModeChange={handleWorkbenchModeChange}
              onWorkbenchSplitToggle={handleWorkbenchSplitToggle}
              onTogglePanel={handleToggleChatPanelWithResize}
              scheduledTasksOpen={scheduledTasksOpen}
              scheduledTasksSummary={scheduledTasksSummary}
              onScheduledTasksToggle={handleScheduledTasksToggle}
            />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
