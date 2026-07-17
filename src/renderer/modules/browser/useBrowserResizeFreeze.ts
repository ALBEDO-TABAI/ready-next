import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import { BoundedLruCache } from '../../../shared/bounded-lru'
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from './resize-events'
import { subscribeWorkbenchWindowResize } from '../workbench/windowResize'

const FREEZE_RELEASE_DELAY_MS = 220
const WINDOW_RESIZE_SETTLE_DELAY_MS = 120
const cachedFreezeFramesByKey = new BoundedLruCache<string, BrowserResizeFreezeFrame>(6)

export interface BrowserResizeFreezeFrame {
  src: string
}

interface UseBrowserResizeFreezeParams {
  isElectron: boolean
  isActive: boolean
  browserRuntimeReady: boolean
  activeTabId: string | null
  freezeCacheKey?: string | null
  surfaceRef: RefObject<HTMLDivElement | null>
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
}

export function useBrowserResizeFreeze({
  isElectron,
  isActive,
  browserRuntimeReady,
  activeTabId,
  freezeCacheKey = activeTabId,
  surfaceRef,
  sendBoundsImmediate,
}: UseBrowserResizeFreezeParams) {
  const resolvedFreezeCacheKey = freezeCacheKey || activeTabId
  const [freezeFrame, setFreezeFrameState] = useState<BrowserResizeFreezeFrame | null>(null)
  const freezeFrameRef = useRef<BrowserResizeFreezeFrame | null>(null)
  const cachedFreezeFrameRef = useRef<BrowserResizeFreezeFrame | null>(
    resolvedFreezeCacheKey ? cachedFreezeFramesByKey.get(resolvedFreezeCacheKey) ?? null : null,
  )
  const activeTabIdRef = useRef(activeTabId)
  const freezeCacheKeyRef = useRef(resolvedFreezeCacheKey)
  const previousFreezeCacheKeyRef = useRef(resolvedFreezeCacheKey)
  const resizingRef = useRef(false)
  const windowResizingRef = useRef(false)
  const captureSessionRef = useRef(0)
  const releaseTimerRef = useRef<number | null>(null)
  const settleTimerRefs = useRef<number[]>([])
  const windowResizeEndTimerRef = useRef<number | null>(null)

  const setFreezeFrame = useCallback((next: BrowserResizeFreezeFrame | null) => {
    freezeFrameRef.current = next
    setFreezeFrameState(next)
  }, [])

  const setCachedFreezeFrameForKey = useCallback((cacheKey: string | null, next: BrowserResizeFreezeFrame | null) => {
    if (cacheKey) {
      if (next) {
        cachedFreezeFramesByKey.set(cacheKey, next)
      } else {
        cachedFreezeFramesByKey.delete(cacheKey)
      }
    } else if (!next) {
      cachedFreezeFramesByKey.clear()
    }

    if (freezeCacheKeyRef.current !== cacheKey) return

    cachedFreezeFrameRef.current = next
  }, [])

  const clearSettleTimers = useCallback(() => {
    if (settleTimerRefs.current.length > 0) {
      settleTimerRefs.current.forEach((timer) => window.clearTimeout(timer))
      settleTimerRefs.current = []
    }
  }, [])

  const clearReleaseTimer = useCallback(() => {
    if (releaseTimerRef.current) {
      window.clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
  }, [])

  const clearWindowResizeEndTimer = useCallback(() => {
    if (windowResizeEndTimerRef.current) {
      window.clearTimeout(windowResizeEndTimerRef.current)
      windowResizeEndTimerRef.current = null
    }
  }, [])

  const resetFreeze = useCallback(() => {
    clearSettleTimers()
    clearReleaseTimer()
    clearWindowResizeEndTimer()
    windowResizingRef.current = false
    setFreezeFrame(null)
  }, [clearReleaseTimer, clearSettleTimers, clearWindowResizeEndTimer, setFreezeFrame])

  const clearCachedFreezeFrame = useCallback((cacheKey: string | null = freezeCacheKeyRef.current) => {
    setCachedFreezeFrameForKey(cacheKey, null)
  }, [setCachedFreezeFrameForKey])

  const captureSnapshot = useCallback(async () => {
    if (!isElectron || !surfaceRef.current) return null

    const rect = surfaceRef.current.getBoundingClientRect()
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
    if (bounds.width <= 0 || bounds.height <= 0) return null

    const result = await window.electronAPI?.browser?.captureWindowSnapshot?.(bounds)
    if (!result?.success || !result.data) return null

    return { src: `data:image/png;base64,${result.data}` }
  }, [isElectron, surfaceRef])

  const recaptureFreezeFrame = useCallback(async (sessionId: number) => {
    if (!isElectron || !isActive || !browserRuntimeReady || !surfaceRef.current) return

    const nextFrame = await captureSnapshot()
    if (!nextFrame) return
    if (captureSessionRef.current !== sessionId) return

    setCachedFreezeFrameForKey(freezeCacheKeyRef.current, nextFrame)
    setFreezeFrame(nextFrame)
  }, [browserRuntimeReady, captureSnapshot, isActive, isElectron, setCachedFreezeFrameForKey, setFreezeFrame, surfaceRef])

  const captureStableFrame = useCallback(async () => {
    if (!isElectron || !surfaceRef.current) return false
    const cacheKey = freezeCacheKeyRef.current
    if (!cacheKey) return false

    const nextFrame = await captureSnapshot()
    if (!nextFrame) return false

    setCachedFreezeFrameForKey(cacheKey, nextFrame)
    return true
  }, [captureSnapshot, isElectron, setCachedFreezeFrameForKey, surfaceRef])

  const handleResizeStart = useCallback(() => {
    resizingRef.current = true
    clearSettleTimers()
    clearReleaseTimer()

    const sessionId = captureSessionRef.current + 1
    captureSessionRef.current = sessionId
    if (cachedFreezeFrameRef.current) {
      setFreezeFrame(cachedFreezeFrameRef.current)
      return
    }
    void recaptureFreezeFrame(sessionId)
  }, [clearReleaseTimer, clearSettleTimers, recaptureFreezeFrame, setFreezeFrame])

  const handleResizeEnd = useCallback(async () => {
    resizingRef.current = false
    const settleSessionId = captureSessionRef.current

    await sendBoundsImmediate({ forceExact: true })
    if (activeTabId) {
      await window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    void recaptureFreezeFrame(settleSessionId)

    clearSettleTimers()
    settleTimerRefs.current = [
      window.setTimeout(() => {
        if (activeTabId) {
          void window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
        }
        void recaptureFreezeFrame(settleSessionId)
      }, 80),
      window.setTimeout(() => {
        if (activeTabId) {
          void window.electronAPI?.browser?.fitActiveTabToBounds(activeTabId)
        }
        void recaptureFreezeFrame(settleSessionId)
      }, 160),
    ]

    clearReleaseTimer()
    releaseTimerRef.current = window.setTimeout(() => {
      captureSessionRef.current += 1
      if (!resizingRef.current) {
        setFreezeFrame(null)
      }
      releaseTimerRef.current = null
    }, FREEZE_RELEASE_DELAY_MS)
  }, [activeTabId, clearReleaseTimer, clearSettleTimers, recaptureFreezeFrame, sendBoundsImmediate, setFreezeFrame])

  useEffect(() => {
    const handleResizeState = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      if (!detail) return
      if (detail.reason !== 'drag') return
      if (detail.resizing) {
        handleResizeStart()
        return
      }
      void handleResizeEnd()
    }

    window.addEventListener(PANEL_RESIZE_STATE_EVENT, handleResizeState as EventListener)
    return () => {
      window.removeEventListener(PANEL_RESIZE_STATE_EVENT, handleResizeState as EventListener)
    }
  }, [handleResizeEnd, handleResizeStart])

  useEffect(() => {
    if (!isElectron) return
    return subscribeWorkbenchWindowResize(() => {
      if (!isActive || !browserRuntimeReady || !activeTabIdRef.current) return
      if (!windowResizingRef.current) {
        windowResizingRef.current = true
        handleResizeStart()
      }
      clearWindowResizeEndTimer()
      windowResizeEndTimerRef.current = window.setTimeout(() => {
        windowResizeEndTimerRef.current = null
        windowResizingRef.current = false
        void handleResizeEnd()
      }, WINDOW_RESIZE_SETTLE_DELAY_MS)
    })
  }, [browserRuntimeReady, clearWindowResizeEndTimer, handleResizeEnd, handleResizeStart, isActive, isElectron])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
    freezeCacheKeyRef.current = resolvedFreezeCacheKey
    cachedFreezeFrameRef.current = resolvedFreezeCacheKey ? cachedFreezeFramesByKey.get(resolvedFreezeCacheKey) ?? null : null
  }, [activeTabId, resolvedFreezeCacheKey])

  useEffect(() => {
    const previousCacheKey = previousFreezeCacheKeyRef.current
    previousFreezeCacheKeyRef.current = resolvedFreezeCacheKey
    if (!previousCacheKey || previousCacheKey === resolvedFreezeCacheKey) return
    if (!resolvedFreezeCacheKey || !isElectron || !isActive || !browserRuntimeReady) return

    let cancelled = false
    let settleFrame: number | null = null
    const layoutFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        if (!cancelled) void captureStableFrame()
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(layoutFrame)
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame)
    }
  }, [browserRuntimeReady, captureStableFrame, isActive, isElectron, resolvedFreezeCacheKey])

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !freezeFrame) return
    const previous = {
      image: surface.style.backgroundImage,
      position: surface.style.backgroundPosition,
      repeat: surface.style.backgroundRepeat,
      size: surface.style.backgroundSize,
    }
    surface.style.backgroundImage = `url("${freezeFrame.src}")`
    surface.style.backgroundPosition = 'center'
    surface.style.backgroundRepeat = 'no-repeat'
    surface.style.backgroundSize = '100% 100%'
    return () => {
      surface.style.backgroundImage = previous.image
      surface.style.backgroundPosition = previous.position
      surface.style.backgroundRepeat = previous.repeat
      surface.style.backgroundSize = previous.size
    }
  }, [freezeFrame, surfaceRef])

  useEffect(() => {
    if (isElectron && isActive && browserRuntimeReady) return
    setFreezeFrame(null)
  }, [browserRuntimeReady, isActive, isElectron, setFreezeFrame])

  useEffect(() => {
    if (activeTabId) return
    clearCachedFreezeFrame(null)
  }, [activeTabId, clearCachedFreezeFrame])

  useEffect(() => {
    return () => {
      resetFreeze()
    }
  }, [resetFreeze])

  return {
    captureStableFrame,
  }
}
