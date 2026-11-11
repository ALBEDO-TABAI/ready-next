import type { FocusEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { anchorOf, closeFloat, openFloat, type FloatPlacement } from './float-store'

// Tooltip (W1 §5): an ink chip after a short pause on hover or keyboard focus; never takes focus.
const TOOLTIP_ID = 'rn-tooltip'
const DELAY_MS = 450
let timer: number | undefined

function show(target: HTMLElement, text: ReactNode, hint: string | undefined, placement: FloatPlacement) {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    if (!target.isConnected) return
    openFloat({
      id: TOOLTIP_ID, anchor: anchorOf(target), placement, offset: 6, noFocus: true, bare: true, role: 'tooltip', dismissOnOutside: true,
      render: () => <div className="rn-tooltip">{text}{hint && <span className="rn-tooltip__hint">{hint}</span>}</div>,
    })
  }, DELAY_MS)
}

function hide() {
  window.clearTimeout(timer)
  closeFloat(TOOLTIP_ID)
}

/** Spread onto any element: `<IconButton {...tooltip('关闭', '⌘W')} />`. */
export function tooltip(text: ReactNode, hint?: string, placement: FloatPlacement = 'bottom') {
  return {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => show(event.currentTarget, text, hint, placement),
    onMouseLeave: hide,
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, text, hint, placement) },
    onBlur: hide,
    onPointerDown: hide,
  }
}
