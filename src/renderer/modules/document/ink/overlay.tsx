import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Ported from Inkwell's overlay host: one stack of popovers (menus, pickers, tooltips) placed against an anchor.
// Frames carry data-ready-native-overlay so the browser view hides beneath them, and ink-scope for the tokens.
export type Anchor = DOMRect | { left: number; top: number; right: number; bottom: number; width?: number; height?: number }
export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'right-start' | 'left-start' | 'left-center' | 'right-center' | 'top' | 'center'

export interface PopoverSpec {
  id?: string
  anchor: Anchor | (() => Anchor)
  placement?: Placement
  offset?: number
  render: (close: () => void) => ReactNode
  onClose?: () => void
  /** dim background, e.g. a dialog */
  modal?: boolean
  clearBackdrop?: boolean
  /** close when clicking outside (default true) */
  dismissOnOutside?: boolean
  /** keep focus where it is */
  noFocus?: boolean
  className?: string
  style?: CSSProperties
  /** parent popover id: children close with the parent, and clicks inside children keep the parent open */
  parent?: string
  zIndex?: number
  /** label for assistive technology */
  label?: string
}

interface Entry extends PopoverSpec { id: string }
let stack: Entry[] = []
const subs = new Set<() => void>()
const emit = () => { stack = [...stack]; subs.forEach(listener => listener()) }
let seq = 0

export function openPopover(spec: PopoverSpec): string {
  const id = spec.id || `pop-${++seq}`
  closePopover(id, true)
  stack.push({ ...spec, id })
  emit()
  return id
}
export function closePopover(id: string, silent = false) {
  const index = stack.findIndex(entry => entry.id === id)
  if (index < 0) return
  const removed = stack.filter((entry, i) => i >= index && (i === index || isDescendant(entry, id)))
  stack = stack.filter(entry => !removed.includes(entry))
  if (!silent) removed.reverse().forEach(entry => entry.onClose?.())
  emit()
}
function isDescendant(entry: Entry, id: string): boolean {
  let parent = entry.parent
  while (parent) { if (parent === id) return true; parent = stack.find(item => item.id === parent)?.parent }
  return false
}
export function closeAllPopovers() { [...stack].reverse().forEach(entry => closePopover(entry.id)) }
export function isPopoverOpen(id?: string) { return id ? stack.some(entry => entry.id === id) : stack.length > 0 }
const getStack = () => stack

/** Mounted by the document shell while its scene is visible. */
export function OverlayHost() {
  const entries = useSyncExternalStore(listener => { subs.add(listener); return () => { subs.delete(listener) } }, getStack)
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!stack.length) return
      const target = event.target as HTMLElement
      const inside = target.closest?.('[data-popover-id]')?.getAttribute('data-popover-id')
      // Close every popover above the one clicked, or all of them when the click is outside.
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]
        if (entry.id === inside) break
        if (inside && isDescendantId(inside, entry.id)) break
        if (entry.dismissOnOutside === false) break
        if (target.closest?.(`[data-popover-anchor="${entry.id}"]`)) break
        closePopover(entry.id)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stack.length && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation()
        closePopover(stack[stack.length - 1].id)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); closeAllPopovers() }
  }, [])
  return createPortal(<>{entries.map((entry, index) => <PopoverFrame key={entry.id} entry={entry} z={(entry.zIndex ?? 1000) + index} />)}</>, document.body)
}
function isDescendantId(child: string, ancestor: string) {
  let parent = stack.find(entry => entry.id === child)?.parent
  while (parent) { if (parent === ancestor) return true; parent = stack.find(entry => entry.id === parent)?.parent }
  return false
}

function PopoverFrame({ entry, z }: { entry: Entry; z: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const close = () => closePopover(entry.id)
  useLayoutEffect(() => {
    const element = ref.current!
    const place = () => {
      const anchor = typeof entry.anchor === 'function' ? entry.anchor() : entry.anchor
      const width = element.offsetWidth, height = element.offsetHeight
      const vw = window.innerWidth, vh = window.innerHeight, offset = entry.offset ?? 0, margin = 12
      let left = anchor.left, top = anchor.bottom + offset
      switch (entry.placement || 'bottom-start') {
        case 'bottom-end': left = anchor.right - width; break
        case 'bottom': left = (anchor.left + anchor.right) / 2 - width / 2; break
        case 'top-start': top = anchor.top - height - offset; break
        case 'top': top = anchor.top - height - offset; left = (anchor.left + anchor.right) / 2 - width / 2; break
        case 'right-start': left = anchor.right + offset; top = anchor.top; if (left + width > vw - margin) left = anchor.left - width - offset; break
        case 'left-start': left = anchor.left - width - offset; top = anchor.top; break
        case 'right-center': left = anchor.right + offset; top = (anchor.top + anchor.bottom) / 2 - height / 2; if (left + width > vw - margin) left = anchor.left - width - offset; break
        case 'left-center': left = anchor.left - width - offset; top = (anchor.top + anchor.bottom) / 2 - height / 2; break
        case 'center': left = (vw - width) / 2; top = Math.max(margin, vh * 0.18); break
      }
      if (entry.placement !== 'center') {
        if (top + height > vh - margin) {
          const above = anchor.top - height - offset
          top = above >= margin && !(entry.placement || '').startsWith('right') ? above : Math.max(margin, vh - margin - height)
        }
        left = Math.max(margin, Math.min(left, vw - margin - width))
        top = Math.max(margin, top)
      }
      setPos({ left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [entry])
  const focused = useRef<Entry | null>(null)
  useEffect(() => {
    // An unplaced element cannot take focus, so wait for the position.
    if (entry.noFocus || !pos || focused.current === entry) return
    focused.current = entry
    const element = ref.current!
    const target = element.querySelector<HTMLElement>('[data-autofocus]') || element
    target.focus({ preventScroll: true })
  }, [entry, pos])
  return <>
    {entry.modal && <div className={`ink-modal-backdrop${entry.clearBackdrop ? ' is-clear' : ''}`} data-ready-native-overlay="" style={{ zIndex: z }} onPointerDown={close} />}
    <div
      ref={ref}
      data-popover-id={entry.id}
      data-ready-native-overlay=""
      role={entry.label ? 'dialog' : undefined}
      aria-label={entry.label}
      tabIndex={-1}
      className={`ink-scope ink-popover ${entry.className || ''}`}
      style={{ position: 'fixed', zIndex: z, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden', ...entry.style }}
      onMouseDown={event => { if (entry.noFocus && !(event.target as HTMLElement).closest('input,textarea')) event.preventDefault() }}
    >
      {entry.render(close)}
    </div>
  </>
}

/** Tooltip: a dark chip next to an element after a short delay. */
let tipTimer: number | undefined
export function showTooltip(target: HTMLElement, text: ReactNode, shortcut?: string, placement: Placement = 'bottom') {
  clearTimeout(tipTimer)
  const cancel = () => { clearTimeout(tipTimer); target.removeEventListener('pointerdown', cancel) }
  target.addEventListener('pointerdown', cancel)
  tipTimer = window.setTimeout(() => {
    target.removeEventListener('pointerdown', cancel)
    if (!target.isConnected || !target.matches(':hover') || target.classList.contains('is-open')) return
    openPopover({ id: 'ink-tooltip', anchor: target.getBoundingClientRect(), placement, offset: 6, noFocus: true, zIndex: 5000, className: 'ink-tooltip-wrap',
      render: () => <div className="ink-tooltip"><div>{text}</div>{shortcut && <div className="ink-tooltip-sc">{shortcut}</div>}</div> })
    const leave = () => { closePopover('ink-tooltip'); target.removeEventListener('mouseleave', leave); target.removeEventListener('pointerdown', leave) }
    target.addEventListener('mouseleave', leave); target.addEventListener('pointerdown', leave)
  }, 500)
}
export function tip(text: ReactNode, shortcut?: string, placement?: Placement) {
  return { onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => showTooltip(event.currentTarget, text, shortcut, placement) }
}
