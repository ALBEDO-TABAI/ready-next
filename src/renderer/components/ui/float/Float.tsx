import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { closeAllFloats, closeFloat, floatAncestors, getFloats, subscribeFloats, type FloatEntry } from './float-store'

// The one float implementation of Ready Next (W1 §4–§5, DL4): FloatHost renders the stack kept in
// float-store.ts (openFloat, closeFloat, …). Every frame carries data-ready-native-overlay, so the
// native web view steps aside while a float covers it and comes back when it closes.

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

function place(entry: FloatEntry, element: HTMLElement) {
  const anchor = typeof entry.anchor === 'function' ? entry.anchor() : entry.anchor
  const width = element.offsetWidth
  const height = element.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  const offset = entry.offset ?? 6
  const margin = 8
  let left = anchor.left
  let top = anchor.bottom + offset
  switch (entry.placement ?? 'bottom-start') {
    case 'bottom-end': left = anchor.right - width; break
    case 'bottom': left = (anchor.left + anchor.right - width) / 2; break
    case 'top-start': top = anchor.top - height - offset; break
    case 'top': top = anchor.top - height - offset; left = (anchor.left + anchor.right - width) / 2; break
    case 'right-start': left = anchor.right + offset; top = anchor.top; if (left + width > vw - margin) left = anchor.left - width - offset; break
    case 'left-start': left = anchor.left - width - offset; top = anchor.top; break
    case 'center': return { left: (vw - width) / 2, top: Math.max(margin, vh * 0.18) }
  }
  if (top + height > vh - margin) {
    const above = anchor.top - height - offset
    top = above >= margin ? above : Math.max(margin, vh - margin - height)
  }
  return { left: Math.max(margin, Math.min(left, vw - margin - width)), top: Math.max(margin, top) }
}

function FloatFrame({ entry, z }: { entry: FloatEntry; z: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    const update = () => setPos(place(entry, element))
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
  const close = () => closeFloat(entry.id)
  return <>
    {entry.modal && <div className="rn-dialog-backdrop" data-ready-native-overlay="float-backdrop" style={{ zIndex: z }} onPointerDown={close} />}
    <div
      ref={ref}
      data-float-id={entry.id}
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
