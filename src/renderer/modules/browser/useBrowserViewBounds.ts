import { useCallback, useEffect, useRef, type RefObject } from 'react'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

interface UseBrowserViewBoundsParams {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  isActive: boolean
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
  const lastBoundsKeyRef = useRef('')
  const lastSentBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastBoundsSentAtRef = useRef(0)
  const layoutTransitionUntilRef = useRef(0)
  const overlayLockCountRef = useRef(0)

  const sendBoundsImmediate = useCallback(async (options?: { forceExact?: boolean }) => {
    if (!isElectron || !contentRef.current) return
    const chatPanelResizeHandleWidth = 4
    const rect = contentRef.current.getBoundingClientRect()
    const shellRect = contentRef.current.closest('[data-workbench-shell="true"]')?.getBoundingClientRect()
    const shellRight = shellRect?.right ?? window.innerWidth
    const chatPanelRect = document.querySelector<HTMLElement>('[data-chat-panel-root="true"]')?.getBoundingClientRect()
    const chatPanelOccupiesSpace = Boolean(chatPanelRect && chatPanelRect.width > chatPanelResizeHandleWidth + 1)
    const safeRightFromDom = chatPanelOccupiesSpace && chatPanelRect
      ? chatPanelRect.left - chatPanelResizeHandleWidth
      : Number.POSITIVE_INFINITY
    const safeRightFromState = chatPanelVisible
      ? shellRight - chatPanelWidth - chatPanelResizeHandleWidth
      : shellRight
    const safeRight = chatPanelOccupiesSpace
      ? Math.min(shellRight, safeRightFromDom)
      : Math.min(shellRight, safeRightFromState)
    const x = Math.round(rect.left)
    const y = Math.round(rect.top - topInset)
    const exactWidth = Math.round(Math.max(0, safeRight - rect.left))
    const height = Math.round(rect.height + topInset)

    if (exactWidth <= 0 || height <= 0) return

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const isManualResizing = document.body.classList.contains('resizing')
    // 拖拽时使用精确宽度，避免露底
    const width = exactWidth

    // 拖拽时限制更新频率，避免过于频繁
    const minSendInterval = isManualResizing ? 16 : 42
    const last = lastSentBoundsRef.current
    if (isManualResizing && last && !options?.forceExact) {
      const widthDelta = Math.abs(width - last.width)
      const xDelta = Math.abs(x - last.x)
      const elapsed = now - lastBoundsSentAtRef.current
      // 只在变化足够大或时间足够长时才更新
      if (elapsed < minSendInterval && widthDelta < 4 && xDelta < 4) {
        return
      }
    }

    const boundsKey = `${x}:${y}:${width}:${height}`
    if (lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey
    lastSentBoundsRef.current = { x, y, width, height }
    lastBoundsSentAtRef.current = now
    await window.electronAPI?.browser?.updateBounds({ x, y, width, height })
  }, [chatPanelVisible, chatPanelWidth, contentRef, isElectron, topInset])

  const sendBounds = useCallback((options?: { forceExact?: boolean }) => {
    if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null
      sendBoundsImmediate(options)
    })
  }, [sendBoundsImmediate])

  const syncBrowserVisibility = useCallback(async (options?: { forceExact?: boolean }) => {
    if (!isElectron) return
    if (!isActive) return

    const shouldShowBrowserView =
      !hasError && overlayLockCountRef.current === 0

    if (!shouldShowBrowserView) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    await sendBoundsImmediate({ forceExact: options?.forceExact ?? true })
    window.electronAPI?.browser?.showActive()
  }, [hasError, isActive, isElectron, sendBoundsImmediate])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      sendBounds()
    })
    observer.observe(element)

    const handleResize = () => sendBounds()
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
      if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    }
  }, [contentRef, sendBounds])

  useEffect(() => {
    if (!isActive) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    layoutTransitionUntilRef.current = now + 380

    if (document.body.classList.contains('resizing')) {
      sendBounds()
      return
    }

    const timers = [
      window.setTimeout(() => sendBounds(), 0),
      window.setTimeout(() => sendBounds(), 120),
      window.setTimeout(() => sendBounds(), 240),
      window.setTimeout(() => sendBounds({ forceExact: true }), 380),
    ]

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [
    chatPanelVisible,
    chatPanelWidth,
    effectiveSidePanelWidth,
    sendBounds,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    isActive,
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
