import { anchorOf, closeFloat, isFloatOpen, MenuList, openFloat, type FloatPlacement, type MenuEntry } from '../../components/ui'

/**
 * Opens a W1 menu from one of the library's toolbar buttons, or closes it when it is already open (the button carries
 * data-float-anchor={id}, so pressing it does not count as a click outside). Closing hands focus back to the button,
 * so the shelf's own keys (F, R, /) keep working after a choice.
 */
export function toggleMenu(button: HTMLElement, menu: { id: string; label: string; items: MenuEntry[]; placement: FloatPlacement; onOpenChange(open: boolean): void }) {
  if (isFloatOpen(menu.id)) { closeFloat(menu.id); return }
  menu.onOpenChange(true)
  openFloat({
    id: menu.id,
    anchor: () => anchorOf(button),
    placement: menu.placement,
    onClose: () => { menu.onOpenChange(false); if (button.isConnected) button.focus({ preventScroll: true }) },
    render: close => <MenuList items={menu.items} label={menu.label} onDone={close} />,
  })
}
