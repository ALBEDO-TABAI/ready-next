import type { CSSProperties, ReactNode } from 'react'

// Float state (W1 §4–§5, DL4): the stack of open menus, popovers, dialogs and tooltips, grown from
// ink's overlay host; FloatHost (Float.tsx) renders it. At most two layers stack: opening a float
// that is not a child of an open one closes the others first.

export type FloatAnchor = { left: number; top: number; right: number; bottom: number }
export type FloatPlacement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top' | 'right-start' | 'left-start' | 'center'

export interface FloatSpec {
  id?: string
  anchor: FloatAnchor | (() => FloatAnchor)
  placement?: FloatPlacement
  offset?: number
  render: (close: () => void) => ReactNode
  onClose?: () => void
  /** Dims the page behind it (dialogs). */
  modal?: boolean
  /** Close on a click outside (default true). */
  dismissOnOutside?: boolean
  /** Leave focus where it is (tooltips, inline pickers). */
  noFocus?: boolean
  /** Without the float material (a tooltip brings its own chip). */
  bare?: boolean
  /** A float opened from inside another one stays open with it and closes with it. */
  parent?: string
  role?: 'dialog' | 'menu' | 'tooltip' | 'listbox'
  label?: string
  className?: string
  style?: CSSProperties
}

export interface FloatEntry extends FloatSpec { id: string }
let stack: FloatEntry[] = []
const listeners = new Set<() => void>()
const emit = () => { stack = [...stack]; listeners.forEach(listener => listener()) }
let seq = 0

const ancestors = (entry: FloatEntry | undefined): string[] => {
  const out: string[] = []
  let parent = entry?.parent
  while (parent) { out.push(parent); parent = stack.find(item => item.id === parent)?.parent }
  return out
}

export function openFloat(spec: FloatSpec): string {
  const id = spec.id || `float-${++seq}`
  closeFloat(id, true)
  // Tooltips sit outside the layer rule: hovering inside an open menu must not close it.
  if (spec.role !== 'tooltip') {
    const keep = new Set(spec.parent ? [spec.parent, ...ancestors(stack.find(entry => entry.id === spec.parent))] : [])
    for (const entry of [...stack].reverse()) if (!keep.has(entry.id) && entry.role !== 'tooltip') closeFloat(entry.id)
  }
  stack.push({ ...spec, id })
  emit()
  return id
}

export function closeFloat(id: string, silent = false) {
  if (!stack.some(entry => entry.id === id)) return
  const removed = stack.filter(entry => entry.id === id || ancestors(entry).includes(id))
  stack = stack.filter(entry => !removed.includes(entry))
  if (!silent) [...removed].reverse().forEach(entry => entry.onClose?.())
  emit()
}

export function closeAllFloats() { [...stack].reverse().forEach(entry => closeFloat(entry.id)) }
export function isFloatOpen(id?: string) { return id ? stack.some(entry => entry.id === id) : stack.length > 0 }
export function anchorOf(element: Element): FloatAnchor { return element.getBoundingClientRect() }

export function subscribeFloats(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getFloats(): readonly FloatEntry[] { return stack }
export const floatAncestors = (entry: FloatEntry | undefined) => ancestors(entry)
