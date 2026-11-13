import { useContext, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkbenchMode } from '../../../stores/useMode'
import { ShellSidebarSlotContext } from './sidebar-slot'

// The shell's one sidebar (W2 §2.2). The shell owns the column — width, collapse, the narrow-window
// card — and each mode renders its own navigator into it through <ShellNavigator>. A portal
// keeps the navigator inside its module's React tree (stores, providers, keyboard handlers bubble
// as before) while the DOM sits in the shell column. Navigators of modes that are not showing stay
// mounted but hidden, so their scroll position and expanded state survive a mode switch; a switch moves them
// vertically, in the rail's direction (V23). The current mode's rail icon and ⌘B open and close the sidebar (V13, V23).

export const ShellSidebarSlotProvider = ShellSidebarSlotContext.Provider

export function ShellNavigator({ mode, label, scopeClassName, children }: {
  mode: WorkbenchMode
  label: string
  /** The module's root class, for module stylesheets scoped under it (e.g. `.ready-calendar`). */
  scopeClassName?: string
  children: ReactNode
}) {
  const slot = useContext(ShellSidebarSlotContext)
  if (!slot.element) return null
  const shown = slot.mode === mode
  // While the shown navigator changes (V23) the old one stays on screen until it has left, inert; then it is hidden.
  const leaving = !shown && slot.motion?.from === mode
  const motion = leaving ? 'leave' : shown && slot.motion ? 'enter' : undefined
  return createPortal(
    <section
      className={`shell-navigator${scopeClassName ? ` ${scopeClassName}` : ''}`}
      data-shell-navigator={mode}
      data-nav-motion={motion}
      data-nav-direction={motion ? slot.motion?.direction : undefined}
      aria-label={label}
      hidden={!shown && !leaving}
      inert={leaving || undefined}
    >
      {children}
    </section>,
    slot.element,
  )
}

export interface ShellSidebarProps {
  mode: WorkbenchMode
  panelWidth: number
  /** docked: a column of the shell row; floating: a card over the content (narrow windows, V14). */
  presentation: 'docked' | 'floating'
  floatingOpen: boolean
  /** Closes the card: Esc, or a pointer-down outside it (the sidebar's switches toggle it themselves). */
  onFloatingClose: () => void
  slotRef: (element: HTMLElement | null) => void
}

/** Where a pointer-down does not close the card: the rail's mode icons (they toggle it themselves) and floats opened from it. */
const CARD_KEEPERS = '[data-shell-sidebar-control], [data-float-id]'

export default function ShellSidebar({ mode, panelWidth, presentation, floatingOpen, onFloatingClose, slotRef }: ShellSidebarProps): ReactNode {
  const floating = presentation === 'floating'
  const cardOpen = floating && floatingOpen
  const asideRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!cardOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || asideRef.current?.contains(target) || target.closest?.(CARD_KEEPERS)) return
      onFloatingClose()
    }
    // An open float handles its own Esc first and stops it there.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onFloatingClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [cardOpen, onFloatingClose])
  return (
    <aside
      ref={asideRef}
      data-liquid-shell="side-panel"
      data-shell-sidebar="true"
      data-shell-sidebar-mode={mode}
      data-side="left"
      data-open={floating ? String(floatingOpen) : undefined}
      // The card over the browser makes the native web view step aside while it is open (W1 DL4).
      data-ready-native-overlay={cardOpen ? 'shell-sidebar' : undefined}
      data-collapsed={!floating && panelWidth === 0 ? 'true' : undefined}
      className={`shell-sidebar workbench-panel-frame${floating ? ' shell-float-drawer rn-float' : ''}`}
      style={{ width: panelWidth, minWidth: panelWidth }}
      aria-label="侧栏"
    >
      {/* Docked, the navigator sits in a panel like the content's (V18); the card is a float of its own. */}
      <div ref={slotRef} className={`shell-sidebar__slot${floating ? '' : ' rn-panel'}`} />
    </aside>
  )
}
