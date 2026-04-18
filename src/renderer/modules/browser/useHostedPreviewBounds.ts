import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from './resize-events'
import { subscribeWorkbenchWindowResize } from '../workbench/windowResize'

export interface HostedPreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UseHostedPreviewBoundsOptions {
  hostRef: RefObject<HTMLElement | null>
  isActive: boolean
  sendBounds: (bounds: HostedPreviewBounds) => void
}

export interface HostedPreviewBoundsApi {
  scheduleSync: (options?: { force?: boolean; trailingFinal?: boolean }) => void
  flush: () => void
}

const SETTLE_TAIL_MS = 64

/**
 * Coalesces BrowserView bounds updates for the RSS preview (or any similar
 * BrowserView hosted inside a DOM container). Replaces the hand-rolled
 * frameSyncRafRef / finalSyncTimeoutRef / pendingSyncOptionsRef that
 * PreviewBrowser used to maintain. The IPC itself stays caller-controlled via
 * `sendBounds`, so this hook does not depend on a specific electron API shape.
 */
export function useHostedPreviewBounds({
  hostRef,
  isActive,
  sendBounds,
}: UseHostedPreviewBoundsOptions): HostedPreviewBoundsApi {
  const sendBoundsRef = useRef(sendBounds)
  sendBoundsRef.current = sendBounds

  const frameRafRef = useRef<number | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingOptionsRef = useRef<{ force: boolean; trailingFinal: boolean } | null>(null)
  const lastBoundsKeyRef = useRef('')
  const panelResizingRef = useRef(false)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  const clearFrameRaf = useCallback(() => {
    if (frameRafRef.current !== null) {
      cancelAnimationFrame(frameRafRef.current)
      frameRafRef.current = null
    }
    pendingOptionsRef.current = null
  }, [])

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  const emit = useCallback((options?: { force?: boolean }) => {
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width <= 0 || height <= 0) return
    const x = Math.round(rect.left)
    const y = Math.round(rect.top)
    const key = `${x}:${y}:${width}:${height}`
    if (!options?.force && lastBoundsKeyRef.current === key) return

    lastBoundsKeyRef.current = key
    sendBoundsRef.current({ x, y, width, height })
  }, [hostRef])

  const scheduleSync = useCallback((options?: { force?: boolean; trailingFinal?: boolean }) => {
    if (!isActiveRef.current) return

    const previous = pendingOptionsRef.current
    pendingOptionsRef.current = {
      force: Boolean(previous?.force || options?.force),
      trailingFinal: Boolean(previous?.trailingFinal || options?.trailingFinal),
    }

    if (frameRafRef.current !== null) return

    frameRafRef.current = requestAnimationFrame(() => {
      frameRafRef.current = null
      const pending = pendingOptionsRef.current
      pendingOptionsRef.current = null
      if (!pending) return

      emit({ force: pending.force })
      if (!pending.trailingFinal || panelResizingRef.current) return

      clearSettleTimer()
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null
        emit({ force: true })
      }, SETTLE_TAIL_MS)
    })
  }, [clearSettleTimer, emit])

  const flush = useCallback(() => {
    clearFrameRaf()
    clearSettleTimer()
  }, [clearFrameRaf, clearSettleTimer])

  // Observe host size + window resize so bounds follow the container.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const handleShift = () => {
      scheduleSync({
        force: panelResizingRef.current,
        trailingFinal: !panelResizingRef.current,
      })
    }

    const observer = new ResizeObserver(handleShift)
    observer.observe(host)
    const unsubscribeWindow = subscribeWorkbenchWindowResize(handleShift)

    return () => {
      observer.disconnect()
      unsubscribeWindow()
      clearFrameRaf()
      clearSettleTimer()
    }
  }, [clearFrameRaf, clearSettleTimer, hostRef, scheduleSync])

  // Freeze trailing syncs while a panel drag is in progress, then push one
  // settled sync after the drag ends.
  useEffect(() => {
    const handlePanelResize = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      if (!detail) return

      if (detail.resizing) {
        panelResizingRef.current = true
        clearSettleTimer()
        scheduleSync({ force: true })
        return
      }

      panelResizingRef.current = false
      clearSettleTimer()
      scheduleSync({ force: true, trailingFinal: true })
    }

    window.addEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResize as EventListener)
    return () => {
      window.removeEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResize as EventListener)
    }
  }, [clearSettleTimer, scheduleSync])

  // Cancel any pending work when the hook deactivates.
  useEffect(() => {
    if (!isActive) {
      clearFrameRaf()
      clearSettleTimer()
    }
  }, [clearFrameRaf, clearSettleTimer, isActive])

  return { scheduleSync, flush }
}
