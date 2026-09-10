import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { BrowserHostLayoutPhase } from '../../../shared/browser-view-layout'
import { nextIntentId } from '../../../shared/browser-view-intent'
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
  cadence: 'transient' | 'settled'
  force?: boolean
  trailingSettled?: boolean
}

const buildBoundsSignature = (bounds: MeasuredBounds) =>
  `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`

const buildSplitBoundsSignature = (
  bounds: MeasuredBounds,
  activeTabId?: string | null,
  splitTabId?: string | null,
  splitBounds?: MeasuredBounds | null,
) => [
  buildBoundsSignature(bounds),
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
  const splitTabIdRef = useRef(splitTabId && splitTabId !== activeTabId ? splitTabId : null)

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

  useEffect(() => {
    const currentSplitTabId = splitTabId && splitTabId !== activeTabId ? splitTabId : null
    const previousSplitTabId = splitTabIdRef.current
    if (
      isElectron &&
      previousSplitTabId &&
      previousSplitTabId !== currentSplitTabId &&
      previousSplitTabId !== activeTabId
    ) {
      window.electronAPI?.browser?.sendIntent({
        kind: 'hide',
        intentId: nextIntentId(),
        tabId: previousSplitTabId,
        reason: 'split-collapse',
      })
    }
    splitTabIdRef.current = currentSplitTabId
  }, [activeTabId, isElectron, splitTabId])

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

  const sendBoundsImmediate = useCallback(async (options?: { forceExact?: boolean }) => {
    const bounds = measureBounds()
    if (!bounds) return

    const splitBounds = splitTabId && splitTabId !== activeTabId ? measureSplitBounds() : null
    const boundsKey = buildSplitBoundsSignature(bounds, activeTabId, splitTabId, splitBounds)
    if (!options?.forceExact && lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey

    // Stage X4 PR-shell-1 — emit declarative BrowserViewIntent. Primary
    // and (when split is active and a secondary pane was measured)
    // secondary fire within the same call so the main side applies both
    // in one tick.
    if (activeTabId) {
      window.electronAPI?.browser?.sendIntent({
        kind: 'set-bounds',
        intentId: nextIntentId(),
        tabId: activeTabId,
        bounds: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
      })
    }
    if (splitBounds && splitTabId && splitTabId !== activeTabId) {
      window.electronAPI?.browser?.sendIntent({
        kind: 'secondary-set-bounds',
        intentId: nextIntentId(),
        tabId: splitTabId,
        bounds: { x: splitBounds.x, y: splitBounds.y, w: splitBounds.width, h: splitBounds.height },
      })
    }
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

      void sendBoundsImmediate()
      dragBoundsSyncRafRef.current = window.requestAnimationFrame(tick)
    }

    dragBoundsSyncRafRef.current = window.requestAnimationFrame(tick)
  }, [isElectron, sendBoundsImmediate])

  const scheduleBoundsSync = useCallback((cadence: 'transient' | 'settled' = 'settled', options?: {
    force?: boolean
    trailingSettled?: boolean
  }) => {
    if (!isElectron || !isActiveRef.current || !isVisibleAllowedRef.current) return

    const previousRequest = frameSyncRequestRef.current
    frameSyncRequestRef.current = {
      cadence:
        previousRequest?.cadence === 'settled' || cadence === 'settled'
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
      }).then(() => {
        if (!request.trailingSettled || panelResizingRef.current || request.cadence === 'settled') return

        clearSettleSyncTimeout()
        settleSyncTimeoutRef.current = window.setTimeout(() => {
          settleSyncTimeoutRef.current = null
          void sendBoundsImmediate({ forceExact: true })
        }, 64)
      })
    })
  }, [clearSettleSyncTimeout, isElectron, sendBoundsImmediate])

  const sendBounds = useCallback((options?: { forceExact?: boolean }) => {
    const cadence = panelResizingRef.current ? 'transient' : (layoutPhaseRef.current === 'idle' ? 'settled' : 'transient')
    scheduleBoundsSync(cadence, {
      force: options?.forceExact,
      trailingSettled: !panelResizingRef.current && cadence === 'transient',
    })
  }, [scheduleBoundsSync])

  const syncBrowserVisibility = useCallback(async (
    phaseOrOptions?: 'hidden' | 'visible' | { forceExact?: boolean; forceBoundsSync?: boolean },
    maybeOptions?: { forceExact?: boolean; forceBoundsSync?: boolean },
  ) => {
    if (!isElectron) return
    const phase: 'auto' | 'hidden' | 'visible' =
      typeof phaseOrOptions === 'string' ? phaseOrOptions : 'auto'
    const options = (typeof phaseOrOptions === 'string' ? maybeOptions : phaseOrOptions) ?? {}

    const requestToken = ++visibilitySyncTokenRef.current

    // Stage X4 PR-shell-1 — emit declarative `hide-all` intent instead
    // of directly calling main-side hideAll. Reason classifier maps the
    // phase: explicit hidden / inactive / blocked / overlay-lock all
    // collapse onto `overlay-open` (the closest existing reason); a
    // dedicated `mode-inactive` reason can be added later if needed.
    const emitHideAll = () => {
      window.electronAPI?.browser?.sendIntent({
        kind: 'hide-all',
        intentId: nextIntentId(),
        reason: 'overlay-open',
      })
    }

    if (phase === 'hidden') {
      emitHideAll()
      return
    }

    if (!isActiveRef.current) {
      emitHideAll()
      return
    }

    if (!isVisibleAllowedRef.current) {
      emitHideAll()
      return
    }

    const shouldShowBrowserView =
      !hasErrorRef.current && overlayLockCountRef.current === 0

    if (!hostVisibleRef.current || !shouldShowBrowserView) {
      emitHideAll()
      return
    }

    await sendBoundsImmediate({
      forceExact: options.forceExact ?? true,
    })
    if (requestToken !== visibilitySyncTokenRef.current) return

    if (options.forceBoundsSync) {
      // Wait until the measured content bounds stop moving before revealing the host. On mode
      // entrance the surrounding layout (rail / side panels / canvas) settles over several
      // frames (x marches e.g. 9 → 319 → 325 → 329); revealing mid-settle shows the native
      // BrowserView at an intermediate x and then snaps it to the final x while visible. Looping
      // until two consecutive frames measure identically — and keeping the hidden view's bounds
      // tracking the moving layout meanwhile — guarantees the first visible frame is final.
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        const signature = (bounds: MeasuredBounds | null) =>
          bounds ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}` : 'null'
        // The entrance is an ease-out slide, so each rounded x lingers ~1-2 frames near the end
        // (…327, 327, 329, 329, 329…). Requiring a longer unchanged streak skips those tail
        // plateaus and only fires at the true rest (which holds indefinitely). MAX caps the wait
        // so a never-settling layout still reveals eventually.
        const REQUIRED_STABLE_FRAMES = 4
        const MAX_SETTLE_FRAMES = 30
        let previousSignature = signature(measureBounds())
        let stableFrames = 0
        for (let frame = 0; frame < MAX_SETTLE_FRAMES; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          if (requestToken !== visibilitySyncTokenRef.current) return
          const currentSignature = signature(measureBounds())
          if (currentSignature === previousSignature) {
            stableFrames += 1
            if (stableFrames >= REQUIRED_STABLE_FRAMES) break
            continue
          }
          stableFrames = 0
          previousSignature = currentSignature
          // Keep the (still hidden) view tracking the moving layout so the eventual show is a no-op move.
          await sendBoundsImmediate({ forceExact: true })
          if (requestToken !== visibilitySyncTokenRef.current) return
        }
        await sendBoundsImmediate({ forceExact: true })
        if (requestToken !== visibilitySyncTokenRef.current) return
      }
    }

    const shouldStillShowBrowserView =
      !hasErrorRef.current && overlayLockCountRef.current === 0
    if (!isActiveRef.current || !isVisibleAllowedRef.current || !hostVisibleRef.current || !shouldStillShowBrowserView) {
      emitHideAll()
      return
    }

    if (activeTabId) {
      const measured = measureBounds()
      window.electronAPI?.browser?.sendIntent({
        kind: 'show',
        intentId: nextIntentId(),
        tabId: activeTabId,
        bounds: measured
          ? { x: measured.x, y: measured.y, w: measured.width, h: measured.height }
          : { x: 0, y: 0, w: 0, h: 0 },
        reason: 'tab-activate',
      })
    }
  }, [activeTabId, hostVisibleRef, isElectron, measureBounds, sendBoundsImmediate])

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
      if (!isActiveRef.current || !isVisibleAllowedRef.current) return
      // ResizeObserver already runs after layout and before paint. An extra rAF
      // leaves the native page one frame behind the animated DOM panel.
      if (panelResizingRef.current) {
        clearFrameSync()
        void sendBoundsImmediate()
        return
      }
      sendBounds()
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
    void syncBrowserVisibility({ forceExact: true, forceBoundsSync: isActive && isVisibleAllowed })
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
      const detail = (event as CustomEvent<{ locked?: boolean; persistent?: boolean; alreadyHidden?: boolean }>).detail
      if (!detail) return

      if (detail.locked) {
        overlayLockCountRef.current += 1
        if (detail.persistent) {
          void syncBrowserVisibility({ forceExact: true, forceBoundsSync: false })
          return
        }
        const selfHealTimer = window.setTimeout(() => {
          const index = pendingSelfHealTimers.indexOf(selfHealTimer)
          if (index >= 0) pendingSelfHealTimers.splice(index, 1)
          if (overlayLockCountRef.current > 0) {
            overlayLockCountRef.current -= 1
            console.warn('[ready] overlayLockCount self-healed after', OVERLAY_LOCK_SELF_HEAL_MS, 'ms')
            void syncBrowserVisibility({
              forceExact: true,
              forceBoundsSync: isActiveRef.current && isVisibleAllowedRef.current,
            })
          }
        }, OVERLAY_LOCK_SELF_HEAL_MS)
        pendingSelfHealTimers.push(selfHealTimer)
        if (detail.alreadyHidden) return
      } else {
        overlayLockCountRef.current = Math.max(0, overlayLockCountRef.current - 1)
        if (!detail.persistent) cancelOldestSelfHeal()
      }

      void syncBrowserVisibility({
        forceExact: true,
        forceBoundsSync: isActiveRef.current && isVisibleAllowedRef.current,
      })
    }

    window.addEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
    return () => {
      window.removeEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
      for (const timer of pendingSelfHealTimers) window.clearTimeout(timer)
      pendingSelfHealTimers.length = 0
    }
  }, [syncBrowserVisibility])

  useEffect(() => () => {
    if (!isElectron) return
    visibilitySyncTokenRef.current += 1
    window.electronAPI?.browser?.sendIntent({
      kind: 'hide-all',
      intentId: nextIntentId(),
      reason: 'mode-switch-prepare',
    })
  }, [isElectron])

  return {
    sendBounds,
    sendBoundsImmediate,
    syncBrowserVisibility,
  }
}
