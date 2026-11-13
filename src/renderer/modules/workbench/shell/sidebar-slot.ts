import { createContext, useContext } from 'react'
import type { WorkbenchMode } from '../../../stores/useMode'

export interface ShellSidebarSlot {
  element: HTMLElement | null
  /** The mode whose navigator is shown: the current mode, or in split view the pane last used. */
  mode: WorkbenchMode
}

export const ShellSidebarSlotContext = createContext<ShellSidebarSlot>({ element: null, mode: 'document' })
/** The mode the person is working in: the current mode, or in split view the pane last used. */
export const useShellFocusedMode = () => useContext(ShellSidebarSlotContext).mode
