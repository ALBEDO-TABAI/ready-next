import { useCallback, useEffect, useRef, type RefObject } from 'react'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

interface UseBrowserViewBoundsParams {
  isElectron: boolean
  contentRef: RefObject<HTMLDivElement | null>
  workbenchMode: string
  sidebarVisible: boolean
  sidePanelVariant: string
  effectiveSidePanelWidth: number
  skillsSplitRatio: number
  chatPanelVisible: boolean
  chatPanelWidth: number
  activePanel: string | null
  hasError: boolean
}

export function useBrowserViewBounds({
  isElectron,
  contentRef,
  workbenchMode,
  sidebarVisible,
  sidePanelVariant,
  effectiveSidePanelWidth,
  skillsSplitRatio,
  chatPanelVisible,
  chatPanelWidth,
  activePanel,
  hasError,
}: UseBrowserViewBoundsParams) {
  const boundsRafRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const lastSentBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastBoundsSentAtRef = useRef(0)
  const layoutTransitionUntilRef = useRef(0)
  const overlayLockCountRef = useRef(0)

  const sendBoundsImmediate = useCallback((options?: { forceExact?: boolean }) => {
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
    const y = Math.round(rect.top)
    const exactWidth = Math.round(Math.max(0, safeRight - rect.left))
    const height = Math.round(rect.height)

    if (exactWidth <= 0 || height <= 0) return

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const isManualResizing = document.body.classList.contains('resizing')
    const isLayoutTransitionActive = now < layoutTransitionUntilRef.current
    const shouldSoftenResize = !options?.forceExact && (isManualResizing || isLayoutTransitionActive)
    const widthStep = isManualResizing ? 24 : 36
    const minSendInterval = isManualResizing ? 28 : 42
    const width = shouldSoftenResize
      ? Math.max(1, Math.floor(exactWidth / widthStep) * widthStep || exactWidth)
      : exactWidth

    const last = lastSentBoundsRef.current
    if (shouldSoftenResize && last) {
      const widthDelta = Math.abs(width - last.width)
      const xDelta = Math.abs(x - last.x)
      const elapsed = now - lastBoundsSentAtRef.current
      if (elapsed < minSendInterval && widthDelta < widthStep && xDelta < 10) {
        return
      }
    }

    const boundsKey = `${x}:${y}:${width}:${height}`
    if (lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey
    lastSentBoundsRef.current = { x, y, width, height }
    lastBoundsSentAtRef.current = now
    window.electronAPI?.browser?.updateBounds({ x, y, width, height })
  }, [chatPanelVisible, chatPanelWidth, contentRef, isElectron])

  const sendBounds = useCallback((options?: { forceExact?: boolean }) => {
    if (boundsRafRef.current) cancelAnimationFrame(boundsRafRef.current)
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null
      sendBoundsImmediate(options)
    })
  }, [sendBoundsImmediate])

  const syncBrowserVisibility = useCallback((options?: { forceExact?: boolean }) => {
    if (!isElectron) return

    const shouldShowBrowserView =
      workbenchMode === 'browser' && !hasError && overlayLockCountRef.current === 0

    if (!shouldShowBrowserView) {
      window.electronAPI?.browser?.hideAll()
      return
    }

    window.electronAPI?.browser?.showActive()
    requestAnimationFrame(() => sendBoundsImmediate({ forceExact: options?.forceExact ?? true }))
  }, [hasError, isElectron, sendBoundsImmediate, workbenchMode])

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
    if (workbenchMode !== 'browser') return
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
    activePanel,
    chatPanelVisible,
    chatPanelWidth,
    effectiveSidePanelWidth,
    sendBounds,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    workbenchMode,
  ])

  useEffect(() => {
    syncBrowserVisibility({ forceExact: true })
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

      syncBrowserVisibility({ forceExact: true })
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
