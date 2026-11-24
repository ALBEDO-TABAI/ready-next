import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { closeAllFloats, closeFloat, floatAncestors, getFloats, subscribeFloats, type FloatEntry } from './float-store'
import { leaveAsGhost } from '../leave'

// The one float implementation of Ready Next (W1 §4–§5, DL4): FloatHost renders the stack kept in
// float-store.ts (openFloat, closeFloat, …). Every frame carries data-ready-native-overlay, so the
// native web view steps aside while a float covers it and comes back when it closes.
// Motion (motion language M2): a frame arrives from the side of its anchor (data-float-motion, primitives.css) and,
// once closed, leaves as a fading copy (leave.ts).

/** Which way a placed frame arrives: from its anchor towards where it opened. */
export type FloatMotion = 'down' | 'up' | 'right' | 'left' | 'pop' | 'fade'

/** Mounted once for the whole app. */
export function FloatHost() {
  const entries = useSyncExternalStore(subscribeFloats, getFloats)
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const stack = getFloats()
      const target = event.target as HTMLElement
      const inside = target.closest?.('[data-float-id]')?.getAttribute('data-float-id') ?? null
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        if (entry.id === inside || (inside && floatAncestors(stack.find(item => item.id === inside)).includes(entry.id))) break
        if (entry.dismissOnOutside === false) break
        if (target.closest?.(`[data-float-anchor="${entry.id}"]`)) break
        closeFloat(entry.id)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      const stack = getFloats()
      if (event.key !== 'Escape' || !stack.length || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closeFloat(stack[stack.length - 1].id)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); closeAllFloats() }
  }, [])
  return createPortal(<>{entries.map((entry, index) => <FloatFrame key={entry.id} entry={entry} z={2000 + index * 2} />)}</>, document.body)
}

function motionOf(entry: FloatEntry, anchor: { top: number; bottom: number; left: number; right: number }, pos: { left: number; top: number }): FloatMotion {
  // A bare float brings its own surface and may place fixed content by the viewport (the canvas slideshow): a transform
  // on the frame would become their containing block, so it only fades.
  if (entry.role === 'tooltip' || entry.bare) return 'fade'
  if (entry.placement === 'center') return 'pop'
  if (entry.placement === 'right-start' || entry.placement === 'left-start') return pos.left >= anchor.right ? 'right' : 'left'
  return pos.top >= anchor.bottom ? 'down' : 'up'
}

function place(entry: FloatEntry, element: HTMLElement) {
  const anchor = typeof entry.anchor === 'function' ? entry.anchor() : entry.anchor
  const width = element.offsetWidth
  const height = element.offsetHeight
  const box = entry.bounds ? (typeof entry.bounds === 'function' ? entry.bounds() : entry.bounds) : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const offset = entry.offset ?? 6
  const margin = 8
  let left = anchor.left
  let top = anchor.bottom + offset
  switch (entry.placement ?? 'bottom-start') {
    case 'bottom-end': left = anchor.right - width; break
    case 'bottom': left = (anchor.left + anchor.right - width) / 2; break
    case 'top-start': top = anchor.top - height - offset; break
    case 'top': top = anchor.top - height - offset; left = (anchor.left + anchor.right - width) / 2; break
    case 'right-start': left = anchor.right + offset; top = anchor.top; if (left + width > box.right - margin) left = anchor.left - width - offset; break
    case 'left-start': left = anchor.left - width - offset; top = anchor.top; break
    case 'center': return { left: (box.left + box.right - width) / 2, top: Math.max(box.top + margin, box.top + (box.bottom - box.top) * 0.18) }
  }
  if (top + height > box.bottom - margin) {
    const above = anchor.top - height - offset
    top = above >= box.top + margin ? above : Math.max(box.top + margin, box.bottom - margin - height)
  }
  return { left: Math.max(box.left + margin, Math.min(left, box.right - margin - width)), top: Math.max(box.top + margin, top) }
}

function FloatFrame({ entry, z }: { entry: FloatEntry; z: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; motion: FloatMotion } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    const update = () => {
      const at = place(entry, element)
      const anchor = typeof entry.anchor === 'function' ? entry.anchor() : entry.anchor
      setPos(previous => {
        // The way it arrived stays put when the frame is placed again (a resize, new content).
        const motion = previous?.motion ?? motionOf(entry, anchor, at)
        return previous && previous.left === at.left && previous.top === at.top && previous.motion === motion ? previous : { ...at, motion }
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [entry])
  const focused = useRef<FloatEntry | null>(null)
  useEffect(() => {
    if (entry.noFocus || !pos || focused.current === entry) return
    focused.current = entry
    const element = ref.current!
    ;(element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus({ preventScroll: true })
  }, [entry, pos])
  // Closed: the frame (and its dimmed page) fade out as copies while the real ones are already gone.
  useLayoutEffect(() => {
    const element = ref.current
    const dim = backdrop.current
    return () => { leaveAsGhost(dim); leaveAsGhost(element) }
  }, [])
  const close = () => closeFloat(entry.id)
  return <>
    {entry.modal && <div ref={backdrop} className="rn-dialog-backdrop" data-ready-native-overlay="float-backdrop" style={{ zIndex: z }} onPointerDown={close} />}
    <div
      ref={ref}
      data-float-id={entry.id}
      data-float-motion={pos?.motion}
      data-ready-native-overlay="float"
      role={entry.role}
      aria-label={entry.label}
      aria-modal={entry.modal || undefined}
      tabIndex={-1}
      className={`rn-ui${entry.bare ? '' : ' rn-float'}${entry.className ? ` ${entry.className}` : ''}`}
      style={{ position: 'fixed', zIndex: z + 1, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden', outline: 'none', ...entry.style }}
    >
      {entry.render(close)}
    </div>
  </>
}
