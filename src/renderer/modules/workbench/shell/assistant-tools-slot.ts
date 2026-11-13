import { createContext, useContext } from 'react'

// The shell's element over the top-right corner (V17). The assistant's header buttons render into it through a portal,
// so the same buttons stay on screen in both states: a row on the docked panel's head line, or a column in the right
// strip while the assistant is collapsed or floats as a card. Null outside the workbench shell.
export const ShellAssistantToolsContext = createContext<HTMLElement | null>(null)
export const useShellAssistantTools = () => useContext(ShellAssistantToolsContext)
