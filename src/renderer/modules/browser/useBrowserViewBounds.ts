import { useCallback, useEffect, useRef, type RefObject } from 'react'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

interface UseBrowserViewBoundsParams {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  isActive: boolean
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

export function useBrowserViewBounds({
  isElectron,
  contentRef,
  isActive,
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
  const boundsRafRef = useRef<number | null>(null)
  const boundsTrackingRafRef = useRef<number | null>(null)
  const boundsTrackingTimeoutRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const overlayLockCountRef = useRef(0)

  const sendBoundsImmediate = useCallback(async (_options?: { forceExact?: boolean }) => {
    if (!isElectron || !contentRef.current) return
    const rect = contentRef.current.getBoundingClientRect()
    const x = Math.round(rect.left)
    const y = Math.round(rect.top - topInset)
    const exactWidth = Math.round(rect.width)
    const height = Math.round(rect.height + topInset)

    if (exactWidth <= 0 || height <= 0) return

    const width = exactWidth
    const boundsKey = `${x}:${y}:${width}:${height}`
    if (lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey
    await window.electronAPI?.browser?.updateBounds({ x, y, width, height })
  }, [contentRef, isElectron, topInset])

  const stopBoundsTracking = useCallback(() => {
    if (boundsTrackingRafRef.current) {
      cancelAnimationFrame(boundsTrackingRafRef.current)
      boundsTrackingRafRef.current = null
    }
    if (boundsTrackingTimeoutRef.current) {
      window.clearTimeout(boundsTrackingTimeoutRef.current)
      boundsTrackingTimeoutRef.current = null
    }
  }, [])

  const startBoundsTracking = useCallback((durationMs = 420) => {
    if (!isElectron || !isActive) return

    stopBoundsTracking()
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const tick = () => {
      void sendBoundsImmediate({ forceExact: true })

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const isManualResizing = document.body.classList.contains('resizing')
      if (isManualResizing || now - startedAt < durationMs) {
        boundsTrackingRafRef.current = requestAnimationFrame(tick)
        return
      }

      boundsTrackingRafRef.current = null
      boundsTrackingTimeoutRef.current = window.setTimeout(() => {
        void sendBoundsImmediate({ forceExact: true })
        boundsTrackingTimeoutRef.current = null
      }, 48)
    }

    boundsTrackingRafRef.current = requestAnimationFrame(tick)
  }, [isActive, isElectron, sendBoundsImmediate, stopBoundsTracking])

  const sendBounds = useCallback((options?: { forceExact?: boolean }) => {
    if (document.body.classList.contains('resizing')) {
      void sendBoundsImmediate({ forceExact: true })
      return
    }
    if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null
      void sendBoundsImmediate(options)
    })
  }, [sendBoundsImmediate])

  const syncBrowserVisibility = useCallback(async (options?: { forceExact?: boolean }) => {
    if (!isElectron) return
    if (!isActive) return

    const shouldShowBrowserView =
      !hasError && overlayLockCountRef.current === 0

    if (!hostVisibleRef.current || !shouldShowBrowserView) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    await sendBoundsImmediate({ forceExact: options?.forceExact ?? true })
    window.electronAPI?.browser?.showActive()
  }, [hasError, hostVisibleRef, isActive, isElectron, sendBoundsImmediate])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return

    const handleBoundsShift = () => {
      if (document.body.classList.contains('resizing') && boundsTrackingRafRef.current === null) {
        startBoundsTracking(160)
      }
      sendBounds()
    }

    const observer = new ResizeObserver(handleBoundsShift)
    observer.observe(element)

    const handleResize = () => handleBoundsShift()
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
      if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
      stopBoundsTracking()
    }
  }, [contentRef, sendBounds, startBoundsTracking, stopBoundsTracking])

  useEffect(() => {
    if (!isActive) return
    startBoundsTracking()

    return () => {
      stopBoundsTracking()
    }
  }, [
    chatPanelVisible,
    chatPanelWidth,
    effectiveSidePanelWidth,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    isActive,
    startBoundsTracking,
    stopBoundsTracking,
  ])

  useEffect(() => {
    void syncBrowserVisibility({ forceExact: true })
  }, [syncBrowserVisibility])

  useEffect(() => {
    const handleOverlayLock = (event: Event) => {
      const detail = (event as CustomEvent<{ locked?: boolean }>).detail
      if (!detail) return

      if (detail.locked) {
        overlayLockCountRef.current += 1
      } else {
        overlayLockCountRef.current = Math.max(0, overlayLockCountRef.current - 1)
      }

      void syncBrowserVisibility({ forceExact: true })
    }

    window.addEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
    return () => {
      window.removeEventListener(BROWSER_OVERLAY_LOCK_EVENT, handleOverlayLock as EventListener)
    }
  }, [syncBrowserVisibility])

  return {
    sendBounds,
    sendBoundsImmediate,
  }
}
