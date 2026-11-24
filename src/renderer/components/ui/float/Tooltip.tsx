import type { FocusEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { anchorOf, closeFloat, isFloatOpen, openFloat, type FloatPlacement } from './float-store'

// Tooltip (W1 §5): an ink chip after a short pause on hover or keyboard focus; never takes focus.
const TOOLTIP_ID = 'rn-tooltip'
/** The pause before a hover hint appears; the reference capsule's preview waits the same. */
export const TOOLTIP_DELAY_MS = 450
/** Once a hint has shown, the next one along a toolbar shows at once if the pointer gets there within this time. */
export const TOOLTIP_WARM_MS = 600
let timer: number | undefined
let warmUntil = 0

function show(target: HTMLElement, text: ReactNode, hint: string | undefined, placement: FloatPlacement) {
  window.clearTimeout(timer)
  const delay = performance.now() < warmUntil ? 0 : TOOLTIP_DELAY_MS
  timer = window.setTimeout(() => {
    if (!target.isConnected) return
    openFloat({
      id: TOOLTIP_ID, anchor: anchorOf(target), placement, offset: 6, noFocus: true, bare: true, role: 'tooltip', dismissOnOutside: true,
      render: () => <div className="rn-tooltip">{text}{hint && <span className="rn-tooltip__hint">{hint}</span>}</div>,
    })
  }, delay)
}

function hide() {
  window.clearTimeout(timer)
  if (isFloatOpen(TOOLTIP_ID)) warmUntil = performance.now() + TOOLTIP_WARM_MS
  closeFloat(TOOLTIP_ID)
}

/** Spread onto any element: `<IconButton {...tooltip('关闭', '⌘W')} />`. */
export function tooltip(text: ReactNode, hint?: string, placement: FloatPlacement = 'bottom') {
  return {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => show(event.currentTarget, text, hint, placement),
    onMouseLeave: hide,
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, text, hint, placement) },
    onBlur: hide,
    // A press puts the hint away without warming the next one: the pointer is busy, not browsing.
    onPointerDown: () => { window.clearTimeout(timer); closeFloat(TOOLTIP_ID) },
  }
}
