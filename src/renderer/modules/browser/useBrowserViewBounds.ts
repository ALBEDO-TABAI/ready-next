import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { BrowserBoundsSyncMode, BrowserHostLayoutPhase, BrowserViewRect } from '../../../shared/browser-view-layout'
import { subscribeWorkbenchWindowResize } from '../workbench/windowResize'
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeReason, type PanelResizeStateDetail } from './resize-events'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'
const OVERLAY_LOCK_SELF_HEAL_MS = 1000
const HOST_RECOVERY_SETTLE_MS = 120

interface UseBrowserViewBoundsParams {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  splitContentRef?: RefObject<HTMLDivElement | null>
  activeTabId?: string | null
  splitTabId?: string | null
  isActive: boolean
  layoutPhase: BrowserHostLayoutPhase
  isVisibleAllowed?: boolean
  hostVisibleRef: RefObject<boolean>
  topInset: number
  sidebarVisible: boolean
  sidePanelVariant: string
  effectiveSidePanelWidth: number
  skillsSplitRatio: number
  chatPanelVisible: boolean
  chatPanelWidth: number
  hasError: boolean
}

interface MeasuredBounds {
  x: number
  y: number
  width: number
  height: number
}

interface PendingBoundsSyncRequest {
  syncMode: BrowserBoundsSyncMode
  force?: boolean
  trailingSettled?: boolean
}

const buildBoundsSignature = (bounds: MeasuredBounds, syncMode: BrowserBoundsSyncMode) =>
  `${syncMode}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`

const buildSplitBoundsSignature = (
  bounds: MeasuredBounds,
  syncMode: BrowserBoundsSyncMode,
  activeTabId?: string | null,
  splitTabId?: string | null,
  splitBounds?: MeasuredBounds | null,
) => [
  buildBoundsSignature(bounds, syncMode),
  activeTabId || '',
  splitTabId || '',
  splitBounds ? `${splitBounds.x}:${splitBounds.y}:${splitBounds.width}:${splitBounds.height}` : '',
].join(':')

export function useBrowserViewBounds({
  isElectron,
  contentRef,
  splitContentRef,
  activeTabId,
  splitTabId,
  isActive,
  layoutPhase,
  isVisibleAllowed = true,
  hostVisibleRef,
  topInset,
  sidebarVisible,
  sidePanelVariant,
  effectiveSidePanelWidth,
  skillsSplitRatio,
  chatPanelVisible,
  chatPanelWidth,
  hasError,
}: UseBrowserViewBoundsParams) {
  const frameSyncRafRef = useRef<number | null>(null)
  const frameSyncRequestRef = useRef<PendingBoundsSyncRequest | null>(null)
  const dragBoundsSyncRafRef = useRef<number | null>(null)
  const settleSyncTimeoutRef = useRef<number | null>(null)
  const hostRecoveryTimeoutRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const overlayLockCountRef = useRef(0)
  const visibilitySyncTokenRef = useRef(0)
  const panelResizingRef = useRef(false)
  const panelResizeReasonRef = useRef<PanelResizeReason | null>(null)
  const isActiveRef = useRef(isActive)
  const layoutPhaseRef = useRef(layoutPhase)
  const isVisibleAllowedRef = useRef(isVisibleAllowed)
  const hasErrorRef = useRef(hasError)

  isActiveRef.current = isActive
  layoutPhaseRef.current = layoutPhase
  isVisibleAllowedRef.current = isVisibleAllowed
  hasErrorRef.current = hasError

  const measureElementBounds = useCallback((element: HTMLElement | null): MeasuredBounds | null => {
    if (!isElectron || !element) return null

    const rect = element.getBoundingClientRect()
    const x = Math.round(rect.left)
    const y = Math.round(rect.top - topInset)
    const exactWidth = Math.round(rect.width)
    const height = Math.round(rect.height + topInset)
    if (exactWidth <= 0 || height <= 0) return null

    return { x, y, width: exactWidth, height }
  }, [isElectron, topInset])

  const measureBounds = useCallback((): MeasuredBounds | null => (
    measureElementBounds(contentRef.current)
  ), [contentRef, measureElementBounds])

  const measureSplitBounds = useCallback((): MeasuredBounds | null => (
    measureElementBounds(splitContentRef?.current || null)
  ), [measureElementBounds, splitContentRef])

  const clearFrameSync = useCallback(() => {
    if (frameSyncRafRef.current !== null) {
      window.cancelAnimationFrame(frameSyncRafRef.current)
      frameSyncRafRef.current = null
    }
    frameSyncRequestRef.current = null
  }, [])

  const clearSettleSyncTimeout = useCallback(() => {
    if (settleSyncTimeoutRef.current !== null) {
      window.clearTimeout(settleSyncTimeoutRef.current)
      settleSyncTimeoutRef.current = null
    }
  }, [])

  const clearHostRecoveryTimeout = useCallback(() => {
    if (hostRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(hostRecoveryTimeoutRef.current)
      hostRecoveryTimeoutRef.current = null
    }
  }, [])

  const sendBoundsImmediate = useCallback(async (options?: { forceExact?: boolean; syncMode?: BrowserBoundsSyncMode }) => {
    const bounds = measureBounds()
    if (!bounds) return

    const resolvedSyncMode = options?.syncMode ?? (layoutPhaseRef.current === 'idle' ? 'settled' : 'transient')
    const splitBounds = splitTabId && splitTabId !== activeTabId ? measureSplitBounds() : null
    const boundsKey = buildSplitBoundsSignature(bounds, resolvedSyncMode, activeTabId, splitTabId, splitBounds)
    if (!options?.forceExact && lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey
    const secondaryBounds: BrowserViewRect | null = splitBounds
      ? {
          x: splitBounds.x,
          y: splitBounds.y,
          width: splitBounds.width,
          height: splitBounds.height,
        }
      : null
    await window.electronAPI?.browser?.updateBounds({
      ...bounds,
      tabId: activeTabId ?? null,
      secondaryTabId: secondaryBounds ? splitTabId ?? null : null,
      secondaryBounds,
      syncMode: resolvedSyncMode,
    })
  }, [activeTabId, measureBounds, measureSplitBounds, splitTabId])

  const stopDragBoundsSync = useCallback(() => {
    if (dragBoundsSyncRafRef.current !== null) {
      window.cancelAnimationFrame(dragBoundsSyncRafRef.current)
      dragBoundsSyncRafRef.current = null
    }
  }, [])

  const startDragBoundsSync = useCallback(() => {
    if (!isElectron || dragBoundsSyncRafRef.current !== null) return

    const tick = () => {
      dragBoundsSyncRafRef.current = null
      if (
        !panelResizingRef.current ||
        panelResizeReasonRef.current !== 'drag' ||
        !isActiveRef.current ||
        !isVisibleAllowedRef.current
      ) {
        return
      }

      void sendBoundsImmediate({ syncMode: 'transient' })
      dragBoundsSyncRafRef.current = window.requestAnimationFrame(tick)
    }

    dragBoundsSyncRafRef.current = window.requestAnimationFrame(tick)
  }, [isElectron, sendBoundsImmediate])

  const scheduleBoundsSync = useCallback((syncMode: BrowserBoundsSyncMode = 'settled', options?: {
    force?: boolean
    trailingSettled?: boolean
  }) => {
    if (!isElectron || !isActiveRef.current || !isVisibleAllowedRef.current) return

    const previousRequest = frameSyncRequestRef.current
    frameSyncRequestRef.current = {
      syncMode:
        previousRequest?.syncMode === 'settled' || syncMode === 'settled'
          ? 'settled'
          : 'transient',
      force: previousRequest?.force || options?.force,
      trailingSettled: previousRequest?.trailingSettled || options?.trailingSettled,
    }

    if (frameSyncRafRef.current !== null) return

    frameSyncRafRef.current = window.requestAnimationFrame(() => {
      frameSyncRafRef.current = null
      const request = frameSyncRequestRef.current
      frameSyncRequestRef.current = null
      if (!request) return

      void sendBoundsImmediate({
        forceExact: request.force,
        syncMode: request.syncMode,
      }).then(() => {
        if (!request.trailingSettled || panelResizingRef.current || request.syncMode === 'settled') return

        clearSettleSyncTimeout()
        settleSyncTimeoutRef.current = window.setTimeout(() => {
          settleSyncTimeoutRef.current = null
          void sendBoundsImmediate({ forceExact: true, syncMode: 'settled' })
        }, 64)
      })
    })
  }, [clearSettleSyncTimeout, isElectron, sendBoundsImmediate])

  const sendBounds = useCallback((options?: { forceExact?: boolean; syncMode?: BrowserBoundsSyncMode }) => {
    const effectiveSyncMode = options?.syncMode ?? (panelResizingRef.current ? 'transient' : (layoutPhaseRef.current === 'idle' ? 'settled' : 'transient'))
    scheduleBoundsSync(effectiveSyncMode, {
      force: options?.forceExact,
      trailingSettled: !panelResizingRef.current && effectiveSyncMode === 'transient',
    })
  }, [scheduleBoundsSync])

  const syncBrowserVisibility = useCallback(async (
    phaseOrOptions?: 'hidden' | 'visible' | { forceExact?: boolean; syncMode?: BrowserBoundsSyncMode; forceBoundsSync?: boolean },
    maybeOptions?: { forceExact?: boolean; syncMode?: BrowserBoundsSyncMode; forceBoundsSync?: boolean },
  ) => {
    if (!isElectron) return
    const phase: 'auto' | 'hidden' | 'visible' =
      typeof phaseOrOptions === 'string' ? phaseOrOptions : 'auto'
    const options = (typeof phaseOrOptions === 'string' ? maybeOptions : phaseOrOptions) ?? {}

    const requestToken = ++visibilitySyncTokenRef.current

    if (phase === 'hidden') {
      window.electronAPI?.browser?.hideAll()
      return
    }

    if (!isActiveRef.current) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    if (!isVisibleAllowedRef.current) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    const shouldShowBrowserView =
      !hasErrorRef.current && overlayLockCountRef.current === 0

    if (!hostVisibleRef.current || !shouldShowBrowserView) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    await sendBoundsImmediate({
      forceExact: options.forceExact ?? true,
      syncMode: options.syncMode ?? 'settled',
    })
    if (requestToken !== visibilitySyncTokenRef.current) return

    if (options.forceBoundsSync) {
      await new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
          resolve()
          return
        }
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
      })
      if (requestToken !== visibilitySyncTokenRef.current) return
    }

    const shouldStillShowBrowserView =
      !hasErrorRef.current && overlayLockCountRef.current === 0
    if (!isActiveRef.current || !isVisibleAllowedRef.current || !hostVisibleRef.current || !shouldStillShowBrowserView) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    await window.electronAPI?.browser?.showActive()
  }, [hostVisibleRef, isElectron, sendBoundsImmediate])

  const scheduleHostRecovery = useCallback(() => {
    if (!isElectron || !isActiveRef.current || !isVisibleAllowedRef.current) return
    lastBoundsKeyRef.current = ''
    clearHostRecoveryTimeout()
    void syncBrowserVisibility('visible', { forceExact: true, forceBoundsSync: true })
    hostRecoveryTimeoutRef.current = window.setTimeout(() => {
      hostRecoveryTimeoutRef.current = null
      if (!isActiveRef.current || !isVisibleAllowedRef.current) return
      void syncBrowserVisibility('visible', { forceExact: true, forceBoundsSync: true })
    }, HOST_RECOVERY_SETTLE_MS)
  }, [clearHostRecoveryTimeout, isElectron, syncBrowserVisibility])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return

    const handleBoundsShift = () => {
      if (panelResizeReasonRef.current === 'drag') {
        clearFrameSync()
        void sendBoundsImmediate({ syncMode: 'transient' })
        return
      }
      if (panelResizingRef.current && frameSyncRequestRef.current !== null) return
      sendBounds({
        forceExact: panelResizingRef.current,
      })
    }

    const observer = new ResizeObserver(handleBoundsShift)
    observer.observe(element)
    const unsubscribeWindowResize = subscribeWorkbenchWindowResize(handleBoundsShift)

    return () => {
      observer.disconnect()
      unsubscribeWindowResize()
      clearFrameSync()
      clearSettleSyncTimeout()
      stopDragBoundsSync()
    }
  }, [clearFrameSync, clearSettleSyncTimeout, contentRef, sendBounds, sendBoundsImmediate, stopDragBoundsSync])

  useEffect(() => {
    if (!isActive) {
      panelResizeReasonRef.current = null
      clearFrameSync()
      clearSettleSyncTimeout()
      stopDragBoundsSync()
      return
    }

    if (panelResizingRef.current) return

    sendBounds({ forceExact: true })
  }, [
    chatPanelVisible,
    chatPanelWidth,
    clearFrameSync,
    clearSettleSyncTimeout,
    effectiveSidePanelWidth,
    isActive,
    sendBounds,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    stopDragBoundsSync,
  ])

  useEffect(() => {
    const handlePanelResizeState = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      if (!detail) return

      if (detail.resizing) {
        panelResizingRef.current = true
        panelResizeReasonRef.current = detail.reason
        clearSettleSyncTimeout()
        if (detail.reason === 'drag') {
          clearFrameSync()
          startDragBoundsSync()
          return
        }
        void scheduleBoundsSync('transient', { force: true })
        return
      }

      panelResizingRef.current = false
      panelResizeReasonRef.current = null
      stopDragBoundsSync()
      clearFrameSync()
      clearSettleSyncTimeout()
      void scheduleBoundsSync('settled', { force: true })
    }

    window.addEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
    return () => {
      window.removeEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
      stopDragBoundsSync()
    }
  }, [clearFrameSync, clearSettleSyncTimeout, scheduleBoundsSync, startDragBoundsSync, stopDragBoundsSync])

  useEffect(() => {
    void syncBrowserVisibility({ forceExact: true })
  }, [hasError, isActive, isVisibleAllowed, syncBrowserVisibility])

  useEffect(() => {
    if (!isElectron) return

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      scheduleHostRecovery()
    }
    const handleWindowFocus = () => {
      scheduleHostRecovery()
    }
    const handlePageShow = () => {
      scheduleHostRecovery()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('pageshow', handlePageShow)
      clearHostRecoveryTimeout()
    }
  }, [clearHostRecoveryTimeout, isElectron, scheduleHostRecovery])

  useEffect(() => {
    const pendingSelfHealTimers: number[] = []

    const cancelOldestSelfHeal = () => {
      const timer = pendingSelfHealTimers.shift()
      if (timer !== undefined) window.clearTimeout(timer)
    }

    const handleOverlayLock = (event: Event) => {
      const detail = (event as CustomEvent<{ locked?: boolean }>).detail
      if (!detail) return

      if (detail.locked) {
        overlayLockCountRef.current += 1
        const selfHealTimer = window.setTimeout(() => {
          const index = pendingSelfHealTimers.indexOf(selfHealTimer)
          if (index >= 0) pendingSelfHealTimers.splice(index, 1)
          if (overlayLockCountRef.current > 0) {
            overlayLockCountRef.current -= 1
            console.warn('[ready] overlayLockCount self-healed after', OVERLAY_LOCK_SELF_HEAL_MS, 'ms')
            void syncBrowserVisibility({ forceExact: true })
          }
        }, OVERLAY_LOCK_SELF_HEAL_MS)
        pendingSelfHealTimers.push(selfHealTimer)
      } else {
        overlayLockCountRef.current = Math.max(0, overlayLockCountRef.current - 1)
        cancelOldestSelfHeal()
      }

      void syncBrowserVisibility({ forceExact: true })
    }

    window.addEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
    return () => {
      window.removeEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
      for (const timer of pendingSelfHealTimers) window.clearTimeout(timer)
      pendingSelfHealTimers.length = 0
    }
  }, [syncBrowserVisibility])

  return {
    sendBounds,
    sendBoundsImmediate,
    syncBrowserVisibility,
  }
}
