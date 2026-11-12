import type { MouseEvent as ReactMouseEvent } from 'react'
import { anchorOf, closeFloat, isFloatOpen, openFloat, type FloatAnchor, type FloatPlacement } from './float-store'
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

/**
 * Opens a menu from a toolbar button, or closes it when it is already open (the button carries
 * data-float-anchor={id}, so pressing it does not count as a click outside). Closing hands focus back to the button,
 * so the surface's own keys keep working after a choice. onOpenChange drives the button's aria-expanded.
 */
export function toggleMenu(button: HTMLElement, menu: { id: string; label: string; items: MenuEntry[]; placement: FloatPlacement; onOpenChange?(open: boolean): void }) {
  if (isFloatOpen(menu.id)) { closeFloat(menu.id); return }
  menu.onOpenChange?.(true)
  openFloat({
    id: menu.id,
    anchor: () => anchorOf(button),
    placement: menu.placement,
    onClose: () => { menu.onOpenChange?.(false); if (button.isConnected) button.focus({ preventScroll: true }) },
    render: close => <MenuList items={menu.items} label={menu.label} onDone={close} />,
  })
}
