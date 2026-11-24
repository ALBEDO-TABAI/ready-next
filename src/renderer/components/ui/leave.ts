import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

// Leaving (motion language M2–M3, docs/superpowers/plans/2026-11-24-ready-next-motion-language-implementation.md):
// a float or toast that closes is gone at once — focus is back where it was, nothing under the pointer — and an inert
// copy of how it looked fades out in its place, so the change is still seen. The copy carries no ids, no float id and
// no handlers, and it does not hold the native web view masked: the page comes back at once and takes clicks, covering
// the part of the fade that lies over it.

export const LEAVING_ATTRIBUTE = 'data-rn-leaving'
/** Longest a copy may stay if its animation never runs (a hidden document, an interrupted style). */
const LEAVE_FALLBACK_MS = 400

export function leaveAsGhost(element: HTMLElement | null | undefined, options: { zIndex?: number } = {}): HTMLElement | null {
  const view = element?.ownerDocument?.defaultView
  if (!element?.isConnected || !view) return null
  const style = view.getComputedStyle(element)
  const opacity = style.opacity === '' ? 1 : Number(style.opacity)
  if (style.visibility === 'hidden' || style.display === 'none' || !(opacity > 0.02)) return null
  const rect = element.getBoundingClientRect()
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (!rect.width || !rect.height || !width || !height) return null

  // What only the live element knows, read before it goes: scroll offsets, and the current frame of running animations
  // (the copy's own animations are switched off, which would otherwise snap e.g. a loading line to its end).
  const liveNodes = [element, ...element.querySelectorAll<HTMLElement>('*')]
  const scrolled = liveNodes.map(node => (node.scrollTop || node.scrollLeft ? [node.scrollTop, node.scrollLeft] as const : null))
  const frozen = liveNodes.map(node => {
    if (node === element || !node.getAnimations?.().length) return null
    const computed = view.getComputedStyle(node)
    return { transform: computed.transform, opacity: computed.opacity, translate: computed.translate, scale: computed.scale }
  })
  const ghost = element.cloneNode(true) as HTMLElement
  // A clone keeps attributes, not live state: copy what was typed, so a search field does not go blank as it leaves.
  const fields = element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((field, index) => {
    const live = fields[index]
    if (!live) return
    if (field.type === 'checkbox' || field.type === 'radio') (field as HTMLInputElement).checked = (live as HTMLInputElement).checked
    else field.value = live.value
  })
  const ghostNodes = [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]
  ghostNodes.forEach((node, index) => {
    const state = frozen[index]
    if (state) Object.assign(node.style, state)
  })
  // No duplicate ids for lookups while the copy fades (ids inside an SVG stay, its url(#…) paints refer to them), no
  // float identity, and no claim on the native web view.
  for (const node of ghostNodes) {
    if (!node.closest('svg') || node === ghost) node.removeAttribute('id')
    node.removeAttribute('data-float-id')
    node.removeAttribute('data-float-anchor')
    node.removeAttribute('data-ready-native-overlay')
  }
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute(LEAVING_ATTRIBUTE, '')
  ghost.inert = true
  // Where it is seen now, mid-entrance included: the layout box centred on the visible box, scaled as it is drawn.
  const scale = rect.width / width
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left + (rect.width - width) / 2}px`,
    top: `${rect.top + (rect.height - height) / 2}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${width}px`,
    height: `${height}px`,
    // Its measured size, whatever percentages its classes resolve to under body.
    minWidth: `${width}px`,
    maxWidth: `${width}px`,
    minHeight: `${height}px`,
    maxHeight: `${height}px`,
    margin: '0',
    boxSizing: 'border-box',
    transform: Math.abs(scale - 1) > 0.002 ? `scale(${scale})` : 'none',
    transformOrigin: '50% 50%',
    opacity: String(opacity),
    visibility: 'visible',
    pointerEvents: 'none',
    zIndex: String(options.zIndex ?? (style.zIndex === 'auto' ? 0 : style.zIndex)),
  } satisfies Partial<CSSStyleDeclaration>)
  // Shown once the element has really gone (React removes it right after this cleanup, before paint). Still there means
  // it was not leaving — a StrictMode re-run, a ref swapped on a live node — and the copy is dropped.
  queueMicrotask(() => {
    if (element.isConnected) return
    element.ownerDocument.body.appendChild(ghost)
    ghostNodes.forEach((node, index) => {
      const offset = scrolled[index]
      if (offset) { node.scrollTop = offset[0]; node.scrollLeft = offset[1] }
    })
    const remove = () => { view.clearTimeout(timer); ghost.remove() }
    const timer = view.setTimeout(remove, LEAVE_FALLBACK_MS)
    ghost.addEventListener('animationend', event => { if (event.target === ghost) remove() })
  })
  return ghost
}

/**
 * A callback ref for an element that comes and goes while its component stays (`{open && <aside ref={leaving} …>}`):
 * when React detaches it, it leaves as a fading copy.
 */
export function useLeavingRef<T extends HTMLElement>(options: { zIndex?: number } = {}) {
  const latest = useRef(options)
  latest.current = options
  return useCallback((node: T | null) => {
    if (!node) return
    return () => { leaveAsGhost(node, latest.current) }
  }, [])
}

/** The element behind `ref` leaves as a fading copy when the component unmounts. */
export function useLeaveAsGhost(ref: RefObject<HTMLElement | null>, options: { zIndex?: number } = {}) {
  const latest = useRef(options)
  latest.current = options
  // Once per mount: a cleanup on any other change would copy an element that is still there.
  useLayoutEffect(() => {
    const element = ref.current
    return () => { leaveAsGhost(element, latest.current) }
  }, [ref])
}
