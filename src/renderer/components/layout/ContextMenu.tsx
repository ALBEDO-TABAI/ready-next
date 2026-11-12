import { useEffect, useRef, type ReactNode } from 'react'
import { closeFloat, openFloat } from '../ui/float/float-store'
import { MenuList, type MenuEntry } from '../ui/float/Menu'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
  /** Kept for callers; the shared float host always renders above the page. */
  portal?: boolean
  /** Keep the menu inside this rectangle (e.g. the assistant panel) when it fits. */
  boundary?: { left: number; top: number; right: number; bottom: number }
}

const MENU_WIDTH = 200
const EDGE = 8

/**
 * The declarative context menu of the shell and its callers (file tree fallback, the assistant's selection, the
 * document editor, skills), drawn by the shared float (W1 §5, DS3/DS4): one menu implementation app-wide, with the
 * float's material, keyboard (↑/↓, Enter, Esc, type-ahead) and native web layer hand-off. The menu opens when the
 * component mounts at (x, y) and its items are read when they are chosen, so a caller that re-renders while the menu
 * is open neither reopens nor loses it. Esc, a click outside or a choice closes it and calls onClose.
 */
export default function ContextMenu({ items, x, y, onClose, boundary }: ContextMenuProps) {
  const latest = useRef({ items, onClose })
  latest.current = { items, onClose }
  const boundaryKey = boundary ? `${boundary.left},${boundary.top},${boundary.right},${boundary.bottom}` : ''

  useEffect(() => {
    const area = boundary ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    const left = Math.min(Math.max(x, area.left + EDGE), Math.max(area.left + EDGE, area.right - MENU_WIDTH - EDGE))
    const top = Math.max(y, area.top + EDGE)
    const entries: MenuEntry[] = latest.current.items.map(item => item.separator
      ? { kind: 'separator' as const }
      : {
          id: item.id,
          label: item.label,
          icon: item.icon,
          hint: item.shortcut,
          danger: item.danger,
          disabled: item.disabled,
          onSelect: () => latest.current.items.find(candidate => candidate.id === item.id)?.onClick?.(),
        })
    let unmounting = false
    const id = openFloat({
      anchor: { left, top, right: left, bottom: top },
      placement: 'bottom-start',
      render: close => <MenuList items={entries} onDone={close} />,
      onClose: () => { if (!unmounting) latest.current.onClose() },
    })
    return () => { unmounting = true; closeFloat(id) }
    // A new position (or area) is a new menu; items are read from `latest` when chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, boundaryKey])

  return null
}
