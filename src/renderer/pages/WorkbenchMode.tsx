import { useEffect, useCallback, useRef, useMemo, useState, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { ObjectUIHost } from '../modules/workbench/object-ui/ObjectUIHost'
import { useWorkspace, reconcileWorkspaceWatchersFromStore, formatWorkspaceWatcherFailure } from '../stores/useWorkspace'
import { useMode, type WorkbenchMode as WorkbenchModeType } from '../stores/useMode'
import { useDocTabs } from '../stores/useDocTabs'
import TopBar from '../components/layout/TopBar'
import ShellRail from '../modules/workbench/shell/ShellRail'
import { useShellPresentation } from '../modules/workbench/shell/useShellPresentation'
import ShellSidebar, { ShellSidebarSlotProvider } from '../modules/workbench/shell/ShellSidebar'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
import ChatPanel from '../components/agent/ChatPanel'
import GraphWorkspace, { type GraphWorkspaceRequest } from '../components/graph/GraphWorkspace'
import { invalidateGraphWorkspace } from '../components/graph/graph-session'
import StatusBar from '../components/layout/StatusBar'
import { useShellActions, useShellSidebarSlot } from '../modules/workbench/shell/useShellWiring'
import { useRSSNotificationOpen } from '../modules/rss/notification-open'
import { clampAssistantWidth as clampWorkbenchChatPanelWidth, clampSidebarWidth as clampWorkbenchSidePanelWidth, SHELL_RAIL_WIDTH } from '../../shared/workbench-shell-geometry'
import {
  READY_WORKBENCH_MODE_CHANGE_EVENT,
  resolveBrowserVisibilityTransition,
  resolveWorkbenchModeOpenDecision,
  type WorkbenchModeChangePresentation,
  type WorkbenchModeChangeRequestDetail,
} from '../modules/workbench/mode-transition'
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
import { cancelRitual, withRitual, setPanelResizingSignal } from '../modules/overlay/useRitualOverlay'
import '../styles/knowledge-graph.css'

// Off the startup path: the find-and-replace view loads when it first opens.
const FindReplaceWorkspace = lazy(() => import('../components/search/FindReplaceWorkspace'))

const INSTANT_PANEL_TOGGLE_SETTLE_MS = 80
const TRANSPARENT_SURFACE_REFRESH_DELAYS_MS = [240, 900] as const

function clampWorkbenchSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 50
  return Math.max(20, Math.min(80, ratio))
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
  const toggleSidebar = useWorkspace((state) => state.toggleSidebar)
  const toggleChatPanel = useWorkspace((state) => state.toggleChatPanel)
  const setSidePanelWidth = useWorkspace((state) => state.setSidePanelWidth)
  const rawSidePanelWidths = useWorkspace((state) => state.sidePanelWidths)
  const sidebarVisible = useWorkspace((state) => state.sidebarVisible)
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const rawChatPanelWidth = useWorkspace((state) => state.chatPanelWidth)
  const renamingPath = useWorkspace((state) => state.renamingPath)
  const creatingType = useWorkspace((state) => state.creatingType)
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const watcherFailure = useWorkspace((state) => state.watcherFailure)
  const chatPanelWidth = clampWorkbenchChatPanelWidth(rawChatPanelWidth)
  const sidePanelWidths = useMemo(
    () => ({ ...rawSidePanelWidths, shared: clampWorkbenchSidePanelWidth(rawSidePanelWidths.shared) }),
    [rawSidePanelWidths],
  )
  const workbenchMode = useMode((state) => state.workbenchMode)
  const splitMode = useMode((state) => state.splitMode)
  const workbenchSplitRatio = useMode((state) => state.workbenchSplitRatio)
  const setWorkbenchSplitRatio = useMode((state) => state.setWorkbenchSplitRatio)
  const setWorkbenchMode = useMode((state) => state.setWorkbenchMode)
  const setSplitMode = useMode((state) => state.setSplitMode)
  const documentSplitTabId = useDocTabs(s => s.splitTabId)
  const navigate = useNavigate()
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const splitPrimaryPaneRef = useRef<HTMLDivElement>(null)
  const liveWorkbenchSplitRatioRef = useRef(clampWorkbenchSplitRatio(workbenchSplitRatio))
  const workbenchSplitResizingRef = useRef(false)
  const liveSidebarWidthRef = useRef(sidePanelWidths.shared)
  const liveChatPanelWidthRef = useRef(chatPanelWidth)
  const restoreDocumentLayoutFreezeRef = useRef<(() => void) | null>(null)
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null)
  const [isMotionSettled, setIsMotionSettled] = useState(true)
  const [modeScenePresentation, setModeScenePresentation] = useState<WorkbenchModeChangePresentation>('animated')
  const [isPanelResizing, setIsPanelResizing] = useState(false)
  const [browserLayoutMotionPhase, setBrowserLayoutMotionPhase] = useState<BrowserHostLayoutPhase>('idle')
  const [graphWorkspaceRequest, setGraphWorkspaceRequest] = useState<GraphWorkspaceRequest | null>(null)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const workspaceError = workspaceInitError ?? formatWorkspaceWatcherFailure(watcherFailure)
  const workbenchSurfaceRefreshTimersRef = useRef<number[]>([])
  const browserLayoutPhase = isPanelResizing ? 'dragging' : browserLayoutMotionPhase
  const hasDocumentSplitPane = Boolean(documentSplitTabId) && (workbenchMode === 'document' || splitMode === 'document')
  const hasVisibleDocumentMode = workbenchMode === 'document' || splitMode === 'document'
  const panelWidthTransitionMode = hasDocumentSplitPane ? 'instant' : 'animated'
  const panelToggleSettleMs = hasDocumentSplitPane ? INSTANT_PANEL_TOGGLE_SETTLE_MS : undefined

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
    if (workbenchSplitResizingRef.current) return
    const nextRatio = clampWorkbenchSplitRatio(workbenchSplitRatio)
    liveWorkbenchSplitRatioRef.current = nextRatio
    if (splitPrimaryPaneRef.current) splitPrimaryPaneRef.current.style.flexBasis = `${nextRatio}%`
  }, [workbenchSplitRatio])

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
    const nextRatio = clampWorkbenchSplitRatio(liveWorkbenchSplitRatioRef.current + deltaPercent)
    liveWorkbenchSplitRatioRef.current = nextRatio
    if (splitPrimaryPaneRef.current) splitPrimaryPaneRef.current.style.flexBasis = `${nextRatio}%`
  }, [])

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

  const handleWorkbenchSplitResizeStateChange = useCallback((resizing: boolean) => {
    if (resizing) {
      workbenchSplitResizingRef.current = true
      liveWorkbenchSplitRatioRef.current = clampWorkbenchSplitRatio(useMode.getState().workbenchSplitRatio)
      handlePanelResizeStateChange(true)
      return
    }
    workbenchSplitResizingRef.current = false
    setWorkbenchSplitRatio(liveWorkbenchSplitRatioRef.current)
    handlePanelResizeStateChange(false)
  }, [handlePanelResizeStateChange, setWorkbenchSplitRatio])

  const handleSidebarResize = useCallback((delta: number) => {
    const nextWidth = clampWorkbenchSidePanelWidth(liveSidebarWidthRef.current + delta)
    liveSidebarWidthRef.current = nextWidth
    setShellWidth("[data-liquid-shell='side-panel']", nextWidth)
  }, [])

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
    setSidePanelWidth(nextWidth)
    handlePanelResizeStateChange(false)
  }, [handlePanelResizeStateChange, setSidePanelWidth])

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
  const shell = useShellPresentation({
    sidebarVisible,
    chatPanelVisible,
    sidebarWidth: sidePanelWidths.shared,
    chatPanelWidth,
    toggleDockedSidebar: handleToggleSidebarWithResize,
    toggleDockedAssistant: handleToggleChatPanelWithResize,
  })
  const { toggleSidebar: toggleShellSidebar, toggleAssistant: toggleShellAssistant } = shell
  useRSSNotificationOpen()
  useShellActions({ toggleSidebar: toggleShellSidebar, toggleAssistant: toggleShellAssistant, openSkills: () => navigate('/skills'), openGraph: () => setGraphWorkspaceRequest({}), openFindReplace: () => setFindReplaceOpen(true) })
  const sidebarSlot = useShellSidebarSlot({ workbenchMode, splitMode, collapsed: shell.sidebarCollapsed, slideOut: shell.sidebarSlideOut, toggle: toggleShellSidebar })


  useEffect(() => () => {
    setPanelResizingSignal(false)
  }, [])

  // Stage X4 PR-shell-2 — in-flight mode-switch ack waiter. The ref
  // holds the active waiter's `cancel` handle so a rapid second mode
  // click orphans the first waiter (per plan §9 line 684).
  const pendingModeSwitchAckCancelRef = useRef<(() => void) | null>(null)
  const modeChangeRequestRef = useRef(0)
  const modeScenePresentationResetRef = useRef<number | null>(null)
  const browserHiddenForModeChangeRef = useRef(false)
  const browserVisibilityRecoveryNeededRef = useRef(false)
  const browserVisibilityRecoveryFrameRef = useRef<number | null>(null)

  const beginModeChangeRequest = useCallback(() => {
    const requestId = ++modeChangeRequestRef.current
    cancelRitual('mode-switch')
    pendingModeSwitchAckCancelRef.current?.()
    pendingModeSwitchAckCancelRef.current = null
    if (browserVisibilityRecoveryFrameRef.current !== null) {
      window.cancelAnimationFrame(browserVisibilityRecoveryFrameRef.current)
      browserVisibilityRecoveryFrameRef.current = null
    }
    return requestId
  }, [])

  const reconcileBrowserVisibilityAfterModeDecision = useCallback((
    requestId: number,
    state: { workbenchMode: WorkbenchModeType; splitMode: WorkbenchModeType | null },
  ) => {
    const browserWillBeVisible = state.workbenchMode === 'browser' || state.splitMode === 'browser'
    if (!browserWillBeVisible) {
      browserHiddenForModeChangeRef.current = false
      browserVisibilityRecoveryNeededRef.current = false
      if (browserVisibilityRecoveryFrameRef.current !== null) {
        window.cancelAnimationFrame(browserVisibilityRecoveryFrameRef.current)
        browserVisibilityRecoveryFrameRef.current = null
      }
      return
    }
    if (!browserHiddenForModeChangeRef.current && !browserVisibilityRecoveryNeededRef.current) return

    browserHiddenForModeChangeRef.current = false
    browserVisibilityRecoveryNeededRef.current = true
    setBrowserLayoutMotionPhase('idle')
    setIsMotionSettled(false)
    browserVisibilityRecoveryFrameRef.current = window.requestAnimationFrame(() => {
      browserVisibilityRecoveryFrameRef.current = null
      if (requestId !== modeChangeRequestRef.current) return
      browserVisibilityRecoveryNeededRef.current = false
      setIsMotionSettled(true)
      scheduleWorkbenchSurfaceRefresh()
    })
  }, [scheduleWorkbenchSurfaceRefresh])

  const prepareModeScenePresentation = useCallback((presentation: WorkbenchModeChangePresentation) => {
    if (modeScenePresentationResetRef.current !== null) {
      window.cancelAnimationFrame(modeScenePresentationResetRef.current)
      modeScenePresentationResetRef.current = null
    }
    setModeScenePresentation(presentation)
    if (presentation === 'immediate') {
      modeScenePresentationResetRef.current = window.requestAnimationFrame(() => {
        modeScenePresentationResetRef.current = null
        setModeScenePresentation('animated')
      })
    }
  }, [])

  useEffect(() => () => {
    pendingModeSwitchAckCancelRef.current?.()
    if (browserVisibilityRecoveryFrameRef.current !== null) {
      window.cancelAnimationFrame(browserVisibilityRecoveryFrameRef.current)
    }
    if (modeScenePresentationResetRef.current !== null) {
      window.cancelAnimationFrame(modeScenePresentationResetRef.current)
    }
  }, [])

  const hideBrowserBeforeModeCommit = useCallback(async () => {
    pendingModeSwitchAckCancelRef.current?.()
    pendingModeSwitchAckCancelRef.current = null

    const ackSource = window.electronAPI?.browser?.onIntentAck
    const intentId = nextIntentId()
    browserHiddenForModeChangeRef.current = true
    browserVisibilityRecoveryNeededRef.current = false
    window.electronAPI?.browser?.sendIntent({
      kind: 'hide-all',
      intentId,
      reason: 'mode-switch-prepare',
      expectsAck: true,
    })
    if (!ackSource) return

    const waiter = createModeSwitchAckWaiter(ackSource, intentId)
    pendingModeSwitchAckCancelRef.current = waiter.cancel
    try {
      await waiter.wait
    } finally {
      if (pendingModeSwitchAckCancelRef.current === waiter.cancel) {
        pendingModeSwitchAckCancelRef.current = null
      }
    }
  }, [])

  const handleWorkbenchModeChange = useCallback(async function handleWorkbenchModeChange(
    nextMode: WorkbenchModeType,
    options: { presentation?: WorkbenchModeChangePresentation } = {},
  ) {
    const requestId = beginModeChangeRequest()
    const presentation = options.presentation ?? 'animated'
    const strategy = resolveModeTransitionStrategy(workbenchMode, nextMode)
    const browserVisibilityTransition = resolveBrowserVisibilityTransition(
      { workbenchMode, splitMode },
      { workbenchMode: nextMode, splitMode: null },
    )

    if (splitMode) {
      if (browserVisibilityTransition === 'leaves') {
        await hideBrowserBeforeModeCommit()
        if (requestId !== modeChangeRequestRef.current) return
      }
      prepareModeScenePresentation(presentation)
      setWorkbenchMode(nextMode)
      reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode: nextMode, splitMode: null })
      scheduleWorkbenchSurfaceRefresh()
      return
    }

    if (strategy === 'same-mode') {
      reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode, splitMode })
      return
    }

    if (strategy === 'dom-only') {
      prepareModeScenePresentation(presentation)
      setWorkbenchMode(nextMode)
      reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode: nextMode, splitMode: null })
      scheduleWorkbenchSurfaceRefresh()
      return
    }

    if (presentation === 'immediate') {
      const comingFromBrowser = browserVisibilityTransition === 'leaves'
      const enteringBrowser = browserVisibilityTransition === 'enters'
      setIsMotionSettled(false)
      if (comingFromBrowser) setBrowserLayoutMotionPhase('leaving')
      else if (enteringBrowser) setBrowserLayoutMotionPhase('entering')
      try {
        if (comingFromBrowser) {
          await hideBrowserBeforeModeCommit()
          if (requestId !== modeChangeRequestRef.current) return
        }
        prepareModeScenePresentation('immediate')
        setWorkbenchMode(nextMode)
        reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode: nextMode, splitMode: null })
        scheduleWorkbenchSurfaceRefresh()
      } finally {
        window.requestAnimationFrame(() => {
          if (requestId !== modeChangeRequestRef.current) return
          setBrowserLayoutMotionPhase('idle')
          setIsMotionSettled(true)
        })
      }
      return
    }

    setIsMotionSettled(false)
    let didCommitModeChange = false
    try {
      await withRitual('mode-switch', async ({ signalReady }) => {
        const comingFromBrowser = browserVisibilityTransition === 'leaves'
        const enteringBrowser = browserVisibilityTransition === 'enters'
        if (comingFromBrowser) setBrowserLayoutMotionPhase('leaving')
        else if (enteringBrowser) setBrowserLayoutMotionPhase('entering')

        // PR-shell-2 ordered ritual: when leaving browser, emit
        // `hide-all` first and wait for the matching ack (100 ms cap)
        // BEFORE flipping renderer mode so the native BrowserView is
        // off-top by the time the DOM-only overlay mounts.
        if (comingFromBrowser) {
          await hideBrowserBeforeModeCommit()
          if (requestId !== modeChangeRequestRef.current) return
        }
        if (requestId !== modeChangeRequestRef.current) {
          signalReady()
          return
        }

        prepareModeScenePresentation('animated')
        setWorkbenchMode(nextMode)
        reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode: nextMode, splitMode: null })
        didCommitModeChange = true
        signalReady()
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        throw error
      }
    } finally {
      if (requestId === modeChangeRequestRef.current) {
        setBrowserLayoutMotionPhase('idle')
        setIsMotionSettled(true)
      }
      if (didCommitModeChange) scheduleWorkbenchSurfaceRefresh()
    }
  }, [
    beginModeChangeRequest,
    hideBrowserBeforeModeCommit,
    prepareModeScenePresentation,
    reconcileBrowserVisibilityAfterModeDecision,
    scheduleWorkbenchSurfaceRefresh,
    setWorkbenchMode,
    splitMode,
    workbenchMode,
  ])

  const handleWorkbenchModeOpen = useCallback(async (
    nextMode: WorkbenchModeType,
    presentation: WorkbenchModeChangePresentation,
  ) => {
    const requestId = beginModeChangeRequest()
    const decision = resolveWorkbenchModeOpenDecision({ workbenchMode, splitMode }, nextMode)
    if (decision.kind === 'already-visible') {
      reconcileBrowserVisibilityAfterModeDecision(requestId, { workbenchMode, splitMode })
      return
    }
    if (decision.kind === 'switch-primary') {
      await handleWorkbenchModeChange(decision.workbenchMode, { presentation })
      return
    }

    const browserVisibilityTransition = resolveBrowserVisibilityTransition(
      { workbenchMode, splitMode },
      { workbenchMode, splitMode: decision.splitMode },
    )
    if (browserVisibilityTransition === 'leaves') {
      await hideBrowserBeforeModeCommit()
      if (requestId !== modeChangeRequestRef.current) return
    }
    // This split request supersedes any settle frame owned by an earlier mode
    // request, so it must always publish a fresh unsettled -> settled cycle.
    setIsMotionSettled(false)
    prepareModeScenePresentation(presentation)
    setSplitMode(decision.splitMode)
    reconcileBrowserVisibilityAfterModeDecision(requestId, {
      workbenchMode,
      splitMode: decision.splitMode,
    })
    scheduleWorkbenchSurfaceRefresh()
    window.requestAnimationFrame(() => {
      if (requestId === modeChangeRequestRef.current) setIsMotionSettled(true)
    })
  }, [
    beginModeChangeRequest,
    handleWorkbenchModeChange,
    hideBrowserBeforeModeCommit,
    prepareModeScenePresentation,
    reconcileBrowserVisibilityAfterModeDecision,
    scheduleWorkbenchSurfaceRefresh,
    setSplitMode,
    splitMode,
    workbenchMode,
  ])

  const handleWorkbenchSplitToggle = useCallback((mode: WorkbenchModeType) => {
    const nextSplitMode = resolveWorkbenchSplitToggle({
      workbenchMode,
      splitMode,
      requestedMode: mode,
    })
    const requestId = beginModeChangeRequest()
    void (async () => {
      const browserVisibilityTransition = resolveBrowserVisibilityTransition(
        { workbenchMode, splitMode },
        { workbenchMode, splitMode: nextSplitMode },
      )
      if (browserVisibilityTransition === 'leaves') {
        await hideBrowserBeforeModeCommit()
        if (requestId !== modeChangeRequestRef.current) return
      }
      // Split toggles may invalidate a pending settle frame even when browser
      // visibility itself is unchanged, so this request owns a fresh frame.
      setIsMotionSettled(false)
      prepareModeScenePresentation('animated')
      setSplitMode(nextSplitMode)
      reconcileBrowserVisibilityAfterModeDecision(requestId, {
        workbenchMode,
        splitMode: nextSplitMode,
      })
      scheduleWorkbenchSurfaceRefresh()
      window.requestAnimationFrame(() => {
        if (requestId === modeChangeRequestRef.current) setIsMotionSettled(true)
      })
    })()
  }, [
    beginModeChangeRequest,
    hideBrowserBeforeModeCommit,
    prepareModeScenePresentation,
    reconcileBrowserVisibilityAfterModeDecision,
    scheduleWorkbenchSurfaceRefresh,
    setSplitMode,
    splitMode,
    workbenchMode,
  ])

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
      const detail = (event as CustomEvent<WorkbenchModeChangeRequestDetail>).detail
      const nextMode = detail?.mode
      if (!nextMode) return
      if (detail.placement === 'open') {
        void handleWorkbenchModeOpen(nextMode, detail.presentation ?? 'immediate')
        return
      }
      void handleWorkbenchModeChange(nextMode, { presentation: detail.presentation })
    }

    window.addEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    return () => {
      window.removeEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    }
  }, [handleWorkbenchModeChange, handleWorkbenchModeOpen])

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
        toggleShellSidebar()
        return
      }
      toggleShellAssistant()
    }

    window.addEventListener('keydown', handlePanelShortcut)
    return () => {
      window.removeEventListener('keydown', handlePanelShortcut)
    }
  }, [creatingType, renamingPath, toggleShellSidebar, toggleShellAssistant, handleToggleSidebarWithResize])

  return (
    <>
      {/* M5-C: the one global ⌘K switcher and quick look, mounted once for every mode. */}
      <ObjectUIHost onSettings={() => navigate('/settings')} />
      <div
        className="workbench-mode-root relative flex h-full flex-col overflow-hidden"
      >
        <div className="relative z-10 flex h-full flex-col">
          {workspaceError && (
            <div
              className="glass-surface-floating mx-3 mt-2 flex items-center justify-between rounded-[12px] px-3 py-2 text-[12px]"
              style={{
                border: '1px solid var(--color-orange)',
                color: 'var(--text-secondary)',
                background: 'color-mix(in srgb, var(--surface-floating-bg) 34%, transparent)',
              }}
            >
              <span>{workspaceError}</span>
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

          <ShellSidebarSlotProvider value={sidebarSlot.value}>
          <div
            className="relative flex flex-1 overflow-hidden"
            data-workbench-shell="true"
            data-shell-sidebar-dock={shell.layout.sidebar}
            data-shell-assistant-dock={shell.layout.assistant}
            data-panel-width-transition={panelWidthTransitionMode}
          >
            <ShellRail
              mode={workbenchMode}
              splitMode={splitMode}
              onModeChange={(mode) => { void handleWorkbenchModeChange(mode) }}
              onSplitToggle={handleWorkbenchSplitToggle}
              assistantOpen={shell.assistantVisible}
              onAssistantOpen={shell.toggleAssistant}
            />
            <ShellSidebar
              mode={sidebarSlot.mode}
              panelWidth={shell.sidebarPanelWidth}
              presentation={shell.sidebarSlideOut ? 'floating' : 'docked'}
              floatingOpen={shell.sidebarPeek}
              floatingInset={SHELL_RAIL_WIDTH}
              onFloatingPeek={shell.setSidebarPeek}
              peekable={shell.sidebarCollapsed}
              slotRef={sidebarSlot.setElement}
            />

            {shell.sidebarResizable && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" onResizeStateChange={handleSidebarResizeStateChange} />
            )}

            <div
              className="relative flex flex-1 min-w-0 overflow-hidden"
              style={{ background: 'transparent' }}
              data-shell-region="content"
              onMouseDownCapture={shell.assistantFloating && shell.assistantDrawerOpen ? shell.closeAssistantDrawer : undefined}
            >
              {splitMode ? (
                <div
                  className="workbench-split-layout flex-1 flex min-w-0"
                  ref={splitContainerRef}
                  data-workbench-split-layout="true"
                  data-workbench-content-backdrop="true"
                >
                  <div
                    ref={splitPrimaryPaneRef}
                    onPointerDownCapture={sidebarSlot.focusPrimary}
                    onFocusCapture={sidebarSlot.focusPrimary}
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
                      transitionPresentation={modeScenePresentation}
                      isMotionSettled={isMotionSettled}
                      browserLayoutPhase={browserLayoutPhase}
                      suspended={graphWorkspaceRequest !== null}
                    />
                  </div>
                  <WorkbenchSplitResizeHandle
                    onResize={handleSplitResize}
                    onResizeStateChange={handleWorkbenchSplitResizeStateChange}
                  />
                  <div
                    className="workbench-split-pane flex-1 flex flex-col min-w-0"
                    style={{ background: 'transparent' }}
                    onPointerDownCapture={sidebarSlot.focusSplit}
                    onFocusCapture={sidebarSlot.focusSplit}
                  >
                    <WorkbenchModeOutlet
                      mode={splitMode}
                      mountedModes={[splitMode]}
                      transitionPresentation={modeScenePresentation}
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
                    transitionPresentation={modeScenePresentation}
                    isMotionSettled={isMotionSettled}
                    browserLayoutPhase={browserLayoutPhase}
                    suspended={graphWorkspaceRequest !== null}
                  />
                </div>
              )}

              {graphWorkspaceRequest && (
                <GraphWorkspace
                  request={graphWorkspaceRequest}
                  workspaceRoot={workspaceRoot}
                  onClose={() => setGraphWorkspaceRequest(null)}
                />
              )}
              {findReplaceOpen && <Suspense fallback={null}><FindReplaceWorkspace onClose={() => setFindReplaceOpen(false)} /></Suspense>}
            </div>

            {shell.assistantResizable && (
              <ResizeHandle onResize={handleChatResize} direction="left" onResizeStateChange={handleChatResizeStateChange} />
            )}

            <ChatPanel
              shellWidth={shell.assistantPanelWidth}
              panelState={shell.chatPanelState}
              presentation={shell.assistantFloating ? 'drawer' : 'docked'}
              workbenchMode={workbenchMode}
              onTogglePanel={shell.toggleAssistant}
            />
          </div>
          </ShellSidebarSlotProvider>

          <StatusBar />
        </div>
      </div>
    </>
  )
}
