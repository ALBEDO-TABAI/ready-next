import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveShellLayout } from '../../../../shared/workbench-shell-geometry'

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

export interface ShellPresentationInput {
  sidebarVisible: boolean
  chatPanelVisible: boolean
  sidebarWidth: number
  chatPanelWidth: number
  /** Toggles the remembered (docked) sidebar state, with the shell's resize choreography. */
  toggleDockedSidebar: () => void
  /** Toggles the remembered (docked) assistant state, with the shell's resize choreography. */
  toggleDockedAssistant: () => void
}

/**
 * How the sidebar and the assistant are presented at the current window width (W2 §2.5, V14). On narrow
 * windows the assistant becomes a drawer and the sidebar a floating card; both start closed and are
 * transient, so the remembered docked state is untouched and returns when the window widens. On a wide
 * window a collapsed sidebar is simply collapsed. Tab, ⌘B, the rail and the assistant's corner button all go
 * through the toggles here, so each column stays one switch.
 */
export function useShellPresentation(input: ShellPresentationInput) {
  const [assistantDrawerOpen, setAssistantDrawerOpen] = useState(false)
  const [sidebarCardOpen, setSidebarCardOpen] = useState(false)
  const windowWidth = useWindowWidth()
  const layout = resolveShellLayout({
    windowWidth,
    sidebarOpen: input.sidebarVisible,
    sidebarWidth: input.sidebarWidth,
    assistantOpen: input.chatPanelVisible,
    assistantWidth: input.chatPanelWidth,
  })
  // How each column would be shown if it were open now: on a narrow window opening a collapsed
  // column floats it rather than flipping the remembered (docked) state.
  const ifOpen = resolveShellLayout({
    windowWidth,
    sidebarOpen: true,
    sidebarWidth: input.sidebarWidth,
    assistantOpen: true,
    assistantWidth: input.chatPanelWidth,
  })
  const sidebarFloating = layout.sidebar === 'floating' || (layout.sidebar === 'hidden' && ifOpen.sidebar === 'floating')
  // The card belongs to the narrow window: once the sidebar can dock again it goes, and the remembered state shows.
  useEffect(() => { if (!sidebarFloating) setSidebarCardOpen(false) }, [sidebarFloating])
  const assistantFloating = layout.assistant === 'floating' || (layout.assistant === 'hidden' && ifOpen.assistant === 'floating')
  const docked = useRef(input)
  docked.current = input

  const toggleAssistant = useCallback(() => {
    if (assistantFloating) setAssistantDrawerOpen(open => !open)
    else docked.current.toggleDockedAssistant()
  }, [assistantFloating])
  const toggleSidebar = useCallback(() => {
    if (sidebarFloating) setSidebarCardOpen(open => !open)
    else docked.current.toggleDockedSidebar()
  }, [sidebarFloating])
  const closeSidebarCard = useCallback(() => setSidebarCardOpen(false), [])

  const assistantVisible = assistantFloating ? assistantDrawerOpen : input.chatPanelVisible
  return {
    layout,
    sidebarFloating,
    sidebarCardOpen,
    closeSidebarCard,
    /** The sidebar is on screen: docked, or its card open on a narrow window. */
    sidebarShown: sidebarFloating ? sidebarCardOpen : layout.sidebar === 'docked',
    assistantFloating,
    assistantDrawerOpen,
    closeAssistantDrawer: () => setAssistantDrawerOpen(false),
    assistantVisible,
    toggleAssistant,
    toggleSidebar,
    /** Width each panel renders at: a floating panel keeps its size, a hidden one has none. */
    sidebarPanelWidth: sidebarFloating || layout.sidebar === 'docked' ? input.sidebarWidth : 0,
    assistantPanelWidth: assistantFloating || layout.assistant === 'docked' ? input.chatPanelWidth : 0,
    /** Resize handles only exist between docked columns. */
    sidebarResizable: layout.sidebar === 'docked',
    assistantResizable: layout.assistant === 'docked',
    chatPanelState: (assistantVisible ? 'expanded' : 'collapsed') as 'expanded' | 'collapsed',
  }
}
