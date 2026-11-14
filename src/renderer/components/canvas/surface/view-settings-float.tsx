import { anchorOf, closeFloat, isFloatOpen, openFloat } from '../../ui'
import { BoardViewSettings } from './CanvasViewSettings'

export const VIEW_SETTINGS = 'canvas-view-settings'

/** Opens the popover from its button (pressing the button again closes it); it stays inside the board. */
export function toggleViewSettings(button: HTMLElement, onOpenChange: (open: boolean) => void) {
  if (isFloatOpen(VIEW_SETTINGS)) { closeFloat(VIEW_SETTINGS); return }
  onOpenChange(true)
  const board = button.closest<HTMLElement>('[data-canvas-surface]')
  openFloat({
    id: VIEW_SETTINGS, anchor: () => anchorOf(button), placement: 'bottom-end', role: 'dialog', label: '视图设置', className: 'canvas-view-float',
    bounds: board ? () => board.getBoundingClientRect() : undefined,
    onClose: () => { onOpenChange(false); if (button.isConnected) button.focus({ preventScroll: true }) },
    render: () => <BoardViewSettings />,
  })
}
