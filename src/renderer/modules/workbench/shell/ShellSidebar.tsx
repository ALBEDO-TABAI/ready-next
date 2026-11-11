import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconLayoutSidebarLeftCollapse, IconPin } from '@tabler/icons-react'
import type { WorkbenchMode } from '../../../stores/useMode'

// The shell's one sidebar (W2 §2.2). The shell owns the column — width, collapse, the narrow-window
// slide-out — and each mode renders its own navigator into it through <ShellNavigator>. A portal
// keeps the navigator inside its module's React tree (stores, providers, keyboard handlers bubble
// as before) while the DOM sits in the shell column. Navigators of modes that are not showing stay
// mounted but hidden, so their scroll position and expanded state survive a mode switch.

interface ShellSidebarSlot {
  element: HTMLElement | null
  /** The mode whose navigator is shown: the current mode, or in split view the pane last used. */
  mode: WorkbenchMode
  /** A collapsed sidebar is peeking on a wide window: the header button pins it instead of collapsing. */
  pinnable: boolean
  /** The shell's one sidebar switch (the same as ⌘B). */
  toggle: () => void
}

const ShellSidebarSlotContext = createContext<ShellSidebarSlot>({ element: null, mode: 'document', pinnable: false, toggle: () => {} })
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
  return createPortal(
    <section
      className={`shell-navigator${scopeClassName ? ` ${scopeClassName}` : ''}`}
      data-shell-navigator={mode}
      aria-label={label}
      hidden={!shown}
    >
      {children}
    </section>,
    slot.element,
  )
}

export interface ShellSidebarProps {
  mode: WorkbenchMode
  panelWidth: number
  /** docked: a column of the shell row; floating: a slide-out over the content (narrow windows, W2 §2.5). */
  presentation: 'docked' | 'floating'
  floatingOpen: boolean
  /** Left offset of the slide-out (the rail's width). */
  floatingInset: number
  /** Opens the slide-out (hovering the window's left edge) and closes it (leaving the panel). */
  onFloatingPeek: (open: boolean) => void
  /** Collapsed on a wide window: the left edge still brings the sidebar out while the pointer rests there. */
  peekable: boolean
  slotRef: (element: HTMLElement | null) => void
}

export default function ShellSidebar({ mode, panelWidth, presentation, floatingOpen, floatingInset, onFloatingPeek, peekable, slotRef }: ShellSidebarProps): ReactNode {
  const floating = presentation === 'floating'
  return (
    <>
      {(floating || peekable) && !floatingOpen && (
        <div className="shell-edge-reveal" style={{ left: floatingInset }} aria-hidden="true" onMouseEnter={() => onFloatingPeek(true)} />
      )}
      <aside
        data-liquid-shell="side-panel"
        data-shell-sidebar="true"
        data-shell-sidebar-mode={mode}
        data-side="left"
        data-open={floating ? String(floatingOpen) : undefined}
        // A slide-out over the browser makes the native web view step aside while it is open (W1 DL4).
        data-ready-native-overlay={floating && floatingOpen ? 'shell-sidebar' : undefined}
        className={`shell-sidebar workbench-panel-frame${floating ? ' shell-float-drawer' : ''}`}
        onMouseLeave={floating ? () => onFloatingPeek(false) : undefined}
        style={{
          width: panelWidth,
          minWidth: panelWidth,
          ...(floating ? { left: floatingInset } : null),
          ...(panelWidth === 0 ? { borderWidth: 0 } : null),
        }}
        aria-label="侧栏"
      >
        <div ref={slotRef} className="shell-sidebar__slot" />
      </aside>
    </>
  )
}

export function useShellNavigatorMode(): WorkbenchMode {
  return useContext(ShellSidebarSlotContext).mode
}

/** The collapse button in a navigator's header: collapses the docked sidebar, or pins a slide-out. */
export function ShellSidebarToggle({ className = 'shell-sidebar-toggle' }: { className?: string }) {
  const { pinnable, toggle } = useContext(ShellSidebarSlotContext)
  const label = pinnable ? '固定侧栏' : '收起侧栏'
  return (
    <button type="button" className={className} title={label} aria-label={label} onClick={toggle}>
      {pinnable ? <IconPin size={16} strokeWidth={1.7} aria-hidden="true" /> : <IconLayoutSidebarLeftCollapse size={17} strokeWidth={1.7} aria-hidden="true" />}
    </button>
  )
}
