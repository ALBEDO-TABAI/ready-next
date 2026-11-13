import { createContext, useContext } from 'react'
import type { WorkbenchMode } from '../../../stores/useMode'
import type { ShellNavigatorMotion } from './navigator-motion'

export interface ShellSidebarSlot {
  element: HTMLElement | null
  /** The mode whose navigator is shown: the current mode, or in split view the pane last used. */
  mode: WorkbenchMode
  /** While the shown navigator changes (V23): the one leaving and the direction. */
  motion: ShellNavigatorMotion | null
}

export const ShellSidebarSlotContext = createContext<ShellSidebarSlot>({ element: null, mode: 'document', motion: null })
/** The mode the person is working in: the current mode, or in split view the pane last used. */
export const useShellFocusedMode = () => useContext(ShellSidebarSlotContext).mode
