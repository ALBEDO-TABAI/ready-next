import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../../stores/useMode'
import { useFastCard } from '../../../stores/useFastCard'
import { openToday } from '../../today/open-today'
import { SHELL_ACTION_EVENT } from '../commands/shell-actions'
import { useNavigatorMotion } from './navigator-motion'

/**
 * The shell's one sidebar slot (W2 §2.2): which mode's navigator shows (the current mode, or in split
 * view the pane last used), and the value the navigators read (the slot element, that mode, and while it changes the
 * vertical motion between the two navigators, V23).
 */
export function useShellSidebarSlot({ workbenchMode, splitMode, animate }: {
  workbenchMode: WorkbenchMode
  splitMode: WorkbenchMode | null
  /** The change moves (an animated mode change with the sidebar on screen); otherwise the navigators swap at once. */
  animate: boolean
}) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [focusedPane, setFocusedPane] = useState<'primary' | 'split'>('primary')
  useEffect(() => { if (!splitMode) setFocusedPane('primary') }, [splitMode])
  const mode = splitMode && focusedPane === 'split' ? splitMode : workbenchMode
  const motion = useNavigatorMotion(mode, animate)
  const value = useMemo(() => ({ element, mode, motion }), [element, mode, motion])
  return { value, mode, setElement, focusPrimary: () => setFocusedPane('primary'), focusSplit: () => setFocusedPane('split') }
}

/**
 * Shell actions from ⌘K, the navigators and the assistant's header (W2 §3.1). The shell owns the
 * sidebar and assistant switches and the full-size views; theme and settings are handled by the
 * keyboard hook and the object UI.
 */
export function useShellActions(handlers: {
  toggleSidebar(): void
  toggleAssistant(): void
  openSkills(): void
  openGraph(): void
  openFindReplace(): void
}) {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const onAction = (event: WindowEventMap['ready:shell-action']) => {
      const h = latest.current
      switch (event.detail.action) {
        case 'toggle-sidebar': h.toggleSidebar(); break
        case 'toggle-assistant': h.toggleAssistant(); break
        case 'open-today': openToday(); break
        case 'open-skills': h.openSkills(); break
        case 'open-graph': h.openGraph(); break
        case 'open-find-replace': h.openFindReplace(); break
        case 'open-fastcard': void useFastCard.getState().open(); break
      }
    }
    window.addEventListener(SHELL_ACTION_EVENT, onAction)
    return () => window.removeEventListener(SHELL_ACTION_EVENT, onAction)
  }, [])
}
