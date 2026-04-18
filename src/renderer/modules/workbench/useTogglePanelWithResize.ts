import { useCallback, useEffect, useRef } from 'react'
import {
  PANEL_RESIZE_STATE_EVENT,
  type PanelResizeStateDetail,
} from '../browser/resize-events'

const PANEL_TOGGLE_SAFETY_MS = 260

function dispatchPanelResize(resizing: boolean): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<PanelResizeStateDetail>(PANEL_RESIZE_STATE_EVENT, {
      detail: { resizing, reason: 'click-toggle' },
    }),
  )
}

export function useTogglePanelWithResize(
  panelSelector: string,
  toggle: () => void,
  options?: { safetyMs?: number },
): () => void {
  const safetyMs = options?.safetyMs ?? PANEL_TOGGLE_SAFETY_MS
  const tokenRef = useRef(0)
  const safetyTimerRef = useRef<number | null>(null)
  const transitionListenerRef = useRef<{
    element: HTMLElement
    handler: (event: TransitionEvent) => void
  } | null>(null)

  const clearSafetyTimer = useCallback(() => {
    if (safetyTimerRef.current !== null) {
      window.clearTimeout(safetyTimerRef.current)
      safetyTimerRef.current = null
    }
  }, [])

  const clearTransitionListener = useCallback(() => {
    const entry = transitionListenerRef.current
    if (!entry) return
    entry.element.removeEventListener('transitionend', entry.handler as EventListener)
    transitionListenerRef.current = null
  }, [])

  const settle = useCallback((resolvingToken: number) => {
    if (resolvingToken !== tokenRef.current) return
    clearSafetyTimer()
    clearTransitionListener()
    tokenRef.current = 0
    dispatchPanelResize(false)
  }, [clearSafetyTimer, clearTransitionListener])

  useEffect(() => () => {
    if (tokenRef.current !== 0) {
      clearSafetyTimer()
      clearTransitionListener()
      tokenRef.current = 0
      dispatchPanelResize(false)
    }
  }, [clearSafetyTimer, clearTransitionListener])

  return useCallback(() => {
    if (typeof window === 'undefined') {
      toggle()
      return
    }

    clearSafetyTimer()
    clearTransitionListener()

    const token = ++tokenRef.current

    dispatchPanelResize(true)
    toggle()

    const element = document.querySelector<HTMLElement>(panelSelector)
    if (element) {
      const handler = (event: TransitionEvent) => {
        if (event.target !== element) return
        if (event.propertyName !== 'width') return
        settle(token)
      }
      element.addEventListener('transitionend', handler as EventListener)
      transitionListenerRef.current = { element, handler }
    }

    safetyTimerRef.current = window.setTimeout(() => {
      safetyTimerRef.current = null
      settle(token)
    }, safetyMs)
  }, [clearSafetyTimer, clearTransitionListener, panelSelector, safetyMs, settle, toggle])
}
