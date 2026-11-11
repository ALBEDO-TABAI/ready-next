import { createContext, useContext } from 'react'
import type { WorkbenchMode } from '../../../stores/useMode'

export interface ShellSidebarSlot {
  element: HTMLElement | null
  /** The mode whose navigator is shown: the current mode, or in split view the pane last used. */
  mode: WorkbenchMode
  /** A collapsed sidebar is peeking on a wide window: the header button pins it instead of collapsing. */
  pinnable: boolean
  /** The shell's one sidebar switch (the same as ⌘B). */
  toggle: () => void
}

export const ShellSidebarSlotContext = createContext<ShellSidebarSlot>({ element: null, mode: 'document', pinnable: false, toggle: () => {} })
/** The mode the person is working in: the current mode, or in split view the pane last used. */
export const useShellFocusedMode = () => useContext(ShellSidebarSlotContext).mode
