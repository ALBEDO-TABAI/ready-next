import type { MouseEvent as ReactMouseEvent } from 'react'
import { openFloat, type FloatAnchor, type FloatPlacement } from './float-store'
import { MenuList, type MenuEntry } from './Menu'

export function openMenu(anchor: FloatAnchor, items: MenuEntry[], options: { placement?: FloatPlacement; label?: string; parent?: string; id?: string } = {}) {
  return openFloat({
    id: options.id,
    anchor,
    placement: options.placement ?? 'bottom-start',
    parent: options.parent,
    // The list inside carries role="menu" and the label.
    render: close => <MenuList items={items} label={options.label} onDone={close} />,
  })
}

/** Opens the same menu at the pointer; the native context menu is suppressed. */
export function openContextMenu(event: ReactMouseEvent | MouseEvent, items: MenuEntry[], label?: string) {
  event.preventDefault()
  const point = { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }
  return openMenu(point, items, { placement: 'bottom-start', label })
}
