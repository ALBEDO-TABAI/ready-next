import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { PANEL_RESIZE_STATE_EVENT } from '../browser/resize-events'

export interface UseRafResizeDragOptions {
  onDelta: (delta: number) => void
  direction?: 'right' | 'left'
  onResizeStateChange?: (resizing: boolean) => void
  /**
   * When true, emit PANEL_RESIZE_STATE_EVENT on start/end so downstream
   * consumers (BrowserView bounds sync, preview browser) can freeze their
   * work. Off by default — opt in from handles wrapping BrowserView hosts.
   */
  dispatchPanelResizeEvent?: boolean
}

/**
 * Shared pointer-drag handler that coalesces mousemove deltas into a single
 * rAF-driven onDelta callback, toggles body.resizing class, and (optionally)
 * broadcasts PANEL_RESIZE_STATE_EVENT. Used by the main workbench resize
 * handles and by DocumentMode's split resize handle.
 */
export function useRafResizeDrag(options: UseRafResizeDragOptions) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  return useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const {
      direction = 'right',
      onResizeStateChange,
      dispatchPanelResizeEvent = false,
    } = optionsRef.current

    let lastX = event.clientX
    let pendingDelta = 0
    let rafId: number | null = null
    const sign = direction === 'right' ? 1 : -1

    const flushPending = () => {
      rafId = null
      if (pendingDelta === 0) return
      const delta = pendingDelta
      pendingDelta = 0
      optionsRef.current.onDelta(sign * delta)
    }

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta === 0) return
      pendingDelta += delta
      if (rafId === null) {
        rafId = window.requestAnimationFrame(flushPending)
      }
    }

    const handleMouseUp = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        flushPending()
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeStateChange?.(false)
      if (dispatchPanelResizeEvent) {
        window.dispatchEvent(
          new CustomEvent(PANEL_RESIZE_STATE_EVENT, { detail: { resizing: false } }),
        )
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('resizing')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    onResizeStateChange?.(true)
    if (dispatchPanelResizeEvent) {
      window.dispatchEvent(
        new CustomEvent(PANEL_RESIZE_STATE_EVENT, { detail: { resizing: true } }),
      )
    }
  }, [])
}
