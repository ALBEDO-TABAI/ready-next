import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from './resize-events'

const FREEZE_RELEASE_DELAY_MS = 220
const cachedFreezeFramesByTabId = new Map<string, BrowserResizeFreezeFrame>()

export interface BrowserResizeFreezeFrame {
  src: string
}

interface UseBrowserResizeFreezeParams {
  isElectron: boolean
  isActive: boolean
  browserRuntimeReady: boolean
  activeTabId: string | null
  surfaceRef: RefObject<HTMLDivElement | null>
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
}

export function useBrowserResizeFreeze({
  isElectron,
  isActive,
  browserRuntimeReady,
  activeTabId,
  surfaceRef,
  sendBoundsImmediate,
}: UseBrowserResizeFreezeParams) {
  const [freezeFrame, setFreezeFrameState] = useState<BrowserResizeFreezeFrame | null>(null)
  const [cachedFreezeFrame, setCachedFreezeFrameState] = useState<BrowserResizeFreezeFrame | null>(() => (activeTabId ? cachedFreezeFramesByTabId.get(activeTabId) ?? null : null))
  const freezeFrameRef = useRef<BrowserResizeFreezeFrame | null>(null)
  const cachedFreezeFrameRef = useRef<BrowserResizeFreezeFrame | null>(cachedFreezeFrame)
  const activeTabIdRef = useRef(activeTabId)
  const resizingRef = useRef(false)
  const captureSessionRef = useRef(0)
  const releaseTimerRef = useRef<number | null>(null)
  const settleTimerRefs = useRef<number[]>([])

  const setFreezeFrame = useCallback((next: BrowserResizeFreezeFrame | null) => {
    freezeFrameRef.current = next
    setFreezeFrameState(next)
  }, [])

  const setCachedFreezeFrameForTab = useCallback((tabId: string | null, next: BrowserResizeFreezeFrame | null) => {
    if (tabId) {
      if (next) {
        cachedFreezeFramesByTabId.set(tabId, next)
      } else {
        cachedFreezeFramesByTabId.delete(tabId)
      }
    } else if (!next) {
      cachedFreezeFramesByTabId.clear()
    }

    if (activeTabIdRef.current !== tabId) return

    cachedFreezeFrameRef.current = next
    setCachedFreezeFrameState(next)
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

  const clearCachedFreezeFrame = useCallback((tabId: string | null = activeTabIdRef.current) => {
    setCachedFreezeFrameForTab(tabId, null)
  }, [setCachedFreezeFrameForTab])

  const captureSnapshot = useCallback(async () => {
    if (!isElectron || !surfaceRef.current) return null

    // 使用 captureViewportSnapshot 捕获 BrowserView，而不是主窗口
    const result = await window.electronAPI?.browser?.captureViewportSnapshot?.()
    if (!result?.success || !result.data) return null

    return { src: `data:image/png;base64,${result.data}` }
  }, [isElectron, surfaceRef])

  const recaptureFreezeFrame = useCallback(async (sessionId: number) => {
    if (!isElectron || !isActive || !browserRuntimeReady || !surfaceRef.current) return

    const nextFrame = await captureSnapshot()
    if (!nextFrame) return
    if (captureSessionRef.current !== sessionId) return

    setCachedFreezeFrameForTab(activeTabIdRef.current, nextFrame)
    setFreezeFrame(nextFrame)
  }, [browserRuntimeReady, captureSnapshot, isActive, isElectron, setCachedFreezeFrameForTab, setFreezeFrame, surfaceRef])

  const captureStableFrame = useCallback(async () => {
    if (!isElectron || !surfaceRef.current) return

    const nextFrame = await captureSnapshot()
    if (!nextFrame) return

    setCachedFreezeFrameForTab(activeTabIdRef.current, nextFrame)
  }, [captureSnapshot, isElectron, setCachedFreezeFrameForTab, surfaceRef])

  const handleResizeStart = useCallback(() => {
    resizingRef.current = true
    clearSettleTimers()
    clearReleaseTimer()

    const sessionId = captureSessionRef.current + 1
    captureSessionRef.current = sessionId
    void recaptureFreezeFrame(sessionId)
  }, [clearReleaseTimer, clearSettleTimers, recaptureFreezeFrame])

  const handleResizeEnd = useCallback(async () => {
    resizingRef.current = false
    const settleSessionId = captureSessionRef.current

    if (!freezeFrameRef.current) return

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
  }, [activeTabId, clearReleaseTimer, clearSettleTimers, recaptureFreezeFrame, setFreezeFrame])

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
    activeTabIdRef.current = activeTabId
    cachedFreezeFrameRef.current = activeTabId ? cachedFreezeFramesByTabId.get(activeTabId) ?? null : null
    setCachedFreezeFrameState(cachedFreezeFrameRef.current)
  }, [activeTabId])

  useEffect(() => {
    if (isElectron && isActive && browserRuntimeReady) return
    // 只清空临时 freezeFrame，不清空 cachedFreezeFrame
    // cachedFreezeFrame 用于模式切换时的冻结帧显示
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
    cachedFreezeFrame,
    captureStableFrame,
    clearCachedFreezeFrame,
    freezeFrame,
  }
}
