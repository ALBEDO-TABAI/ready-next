import { useEffect, useRef, type RefObject } from 'react'
import { closeFloat, isFloatOpen, openFloat, type FloatAnchor, type FloatPlacement } from '../../../components/ui'
import { SelectionBar, type SelectionBarProps } from './SelectionBar'

// The selection bar as a float over the words it acts on (资讯, PDF). The book reader shows the same bar in its own
// highlight popover; the web page shows it in the bottom band, because nothing may cover the native page.

const BAR_ID = 'rn-selection-bar'
let owner: object | null = null

/** Above the selection, or below it when the selection is at the top edge. Keeps the selection: no focus. */
export function openSelectionBar(anchor: FloatAnchor | (() => FloatAnchor), props: SelectionBarProps, by: object = {}, placement?: FloatPlacement): void {
  owner = by
  const at = typeof anchor === 'function' ? anchor() : anchor
  openFloat({
    id: BAR_ID, anchor, placement: placement ?? (at.top > 64 ? 'top' : 'bottom'), offset: placement ? 0 : 8, noFocus: true, bare: true, label: '选中的文字',
    onClose: () => { if (owner === by) owner = null },
    render: close => <SelectionBar {...props} onDone={() => { close(); props.onDone?.() }} />,
  })
}
/** Closes the bar only when `by` opened it; another scene's bar stays. */
export function closeSelectionBar(by?: object): void {
  if (by && owner !== by) return
  closeFloat(BAR_ID)
}
export const selectionBarOpen = (by: object) => owner === by && isFloatOpen(BAR_ID)

/**
 * Shows the bar when a selection inside `root` is finished (pointer or keyboard), hides it when the selection goes
 * away, and moves it after scrolling. `read` maps the live selection to a capture; the scene owns that mapping.
 */
export function useSelectionBar(root: RefObject<HTMLElement | null>, { enabled, ...props }: Omit<SelectionBarProps, 'onDone'> & { enabled: boolean }) {
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    const element = root.current
    if (!enabled || !element) return
    const view = element.ownerDocument.defaultView!, by = {}
    let timer = 0
    const selectedRect = () => {
      const selection = view.getSelection()
      if (!selection?.rangeCount || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null
      const rect = range.getBoundingClientRect(), bounds = element.getBoundingClientRect()
      if ((!rect.width && !rect.height) || rect.bottom < bounds.top || rect.top > bounds.bottom) return null
      return rect
    }
    const show = () => {
      const rect = selectedRect()
      if (!rect || !latest.current.read()) { closeSelectionBar(by); return }
      openSelectionBar(rect, {
        read: () => latest.current.read(),
        highlight: () => latest.current.highlight(),
        ask: latest.current.ask && (() => latest.current.ask!()),
        extras: latest.current.extras,
        onDone: () => view.getSelection()?.removeAllRanges(),
      }, by)
    }
    const later = (ms: number) => { view.clearTimeout(timer); timer = view.setTimeout(show, ms) }
    const finished = () => later(0)
    const changed = () => { if (selectionBarOpen(by) && !selectedRect()) closeSelectionBar(by) }
    const scrolled = (event: Event) => {
      const target = event.target
      if (!(target instanceof view.Node) || !(target.contains(element) || element.contains(target))) return
      if (selectionBarOpen(by)) { closeSelectionBar(by); later(160) } else if (timer) later(160)
    }
    element.addEventListener('mouseup', finished)
    element.addEventListener('keyup', finished)
    element.ownerDocument.addEventListener('selectionchange', changed)
    view.addEventListener('scroll', scrolled, true)
    return () => {
      view.clearTimeout(timer)
      element.removeEventListener('mouseup', finished)
      element.removeEventListener('keyup', finished)
      element.ownerDocument.removeEventListener('selectionchange', changed)
      view.removeEventListener('scroll', scrolled, true)
      closeSelectionBar(by)
    }
  }, [root, enabled])
}
