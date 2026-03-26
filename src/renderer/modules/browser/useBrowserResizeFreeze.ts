import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from './resize-events'

const FREEZE_RELEASE_DELAY_MS = 220

export interface BrowserResizeFreezeFrame {
  src: string
}

interface UseBrowserResizeFreezeParams {
  isElectron: boolean
  isActive: boolean
  browserRuntimeReady: boolean
  surfaceRef: RefObject<HTMLDivElement | null>
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
}

export function useBrowserResizeFreeze({
  isElectron,
  isActive,
  browserRuntimeReady,
  surfaceRef,
  sendBoundsImmediate,
}: UseBrowserResizeFreezeParams) {
  const [freezeFrame, setFreezeFrameState] = useState<BrowserResizeFreezeFrame | null>(null)
  const freezeFrameRef = useRef<BrowserResizeFreezeFrame | null>(null)
  const resizingRef = useRef(false)
  const captureSessionRef = useRef(0)
  const releaseTimerRef = useRef<number | null>(null)
  const settleTimerRefs = useRef<number[]>([])

  const setFreezeFrame = useCallback((next: BrowserResizeFreezeFrame | null) => {
    freezeFrameRef.current = next
    setFreezeFrameState(next)
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

  const resetFreeze = useCallback(() => {
    clearSettleTimers()
    clearReleaseTimer()
    setFreezeFrame(null)
  }, [clearReleaseTimer, clearSettleTimers, setFreezeFrame])

  const captureFreezeFrame = useCallback(async (sessionId: number) => {
    if (!isElectron || !isActive || !browserRuntimeReady || !surfaceRef.current) return

    const rect = surfaceRef.current.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width <= 0 || height <= 0) return

    const result = await window.electronAPI?.browser?.captureWindowSnapshot({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    })
    if (!result?.success || !result.data) return
    if (!resizingRef.current || captureSessionRef.current !== sessionId) return

    setFreezeFrame({ src: `data:image/png;base64,${result.data}` })
  }, [browserRuntimeReady, isActive, isElectron, setFreezeFrame, surfaceRef])

  const handleResizeStart = useCallback(() => {
    resizingRef.current = true
    clearSettleTimers()
    clearReleaseTimer()

    const sessionId = captureSessionRef.current + 1
    captureSessionRef.current = sessionId
    void captureFreezeFrame(sessionId)
  }, [captureFreezeFrame, clearReleaseTimer, clearSettleTimers])

  const handleResizeEnd = useCallback(async () => {
    resizingRef.current = false
    captureSessionRef.current += 1

    if (!freezeFrameRef.current) return

    await sendBoundsImmediate({ forceExact: true })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))

    clearSettleTimers()
    settleTimerRefs.current = [
      window.setTimeout(() => {
        void sendBoundsImmediate({ forceExact: true })
      }, 80),
      window.setTimeout(() => {
        void sendBoundsImmediate({ forceExact: true })
      }, 160),
    ]

    clearReleaseTimer()
    releaseTimerRef.current = window.setTimeout(() => {
      if (!resizingRef.current) {
        setFreezeFrame(null)
      }
      releaseTimerRef.current = null
    }, FREEZE_RELEASE_DELAY_MS)
  }, [clearReleaseTimer, clearSettleTimers, sendBoundsImmediate, setFreezeFrame])

  useEffect(() => {
    const handleResizeState = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      if (!detail) return
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
    if (isElectron && isActive && browserRuntimeReady) return
    resetFreeze()
  }, [browserRuntimeReady, isActive, isElectron, resetFreeze])

  useEffect(() => {
    return () => {
      resetFreeze()
    }
  }, [resetFreeze])

  return {
    freezeFrame,
  }
}
