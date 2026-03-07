import { useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../stores/useWorkspace'
import { useMode } from '../stores/useMode'
import TopBar from '../components/layout/TopBar'
import IconRail from '../components/layout/IconRail'
import SidePanel, { type SidePanelVariant } from '../components/layout/SidePanel'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
import ChatPanel from '../components/agent/ChatPanel'
import StatusBar from '../components/layout/StatusBar'

// --- Resize Handle ---
function ResizeHandle({
  onResize,
  direction = 'right'
}: {
  onResize: (delta: number) => void
  direction?: 'right' | 'left'
}) {
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    let lastX = startX

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta !== 0) {
        onResizeRef.current(direction === 'right' ? delta : -delta)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('resizing')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [direction])

  return (
    <div
      className="resize-handle"
      onMouseDown={handleMouseDown}
    />
  )
}

export default function WorkbenchMode() {
  const {
    refreshFiles,
    toggleSidebar,
    toggleChatPanel,
    sidebarVisible,
    chatPanelVisible,
    sidePanelVariant,
    sidePanelWidths,
    setSidePanelVariant,
    setSidePanelWidth,
  } = useWorkspace()
  const { workbenchMode, splitMode, splitRatio, setSplitRatio } = useMode()
  const navigate = useNavigate()
  const splitContainerRef = useRef<HTMLDivElement>(null)

  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    setSplitRatio(splitRatio + deltaPercent)
  }, [splitRatio, setSplitRatio])

  // Initialize workspace on mount
  useEffect(() => {
    const initWorkspace = async () => {
      try {
        const savedRoot = localStorage.getItem('ready-workspace-root')

        if (typeof window !== 'undefined' && window.electronAPI) {
          if (savedRoot) {
            useWorkspace.getState().setWorkspaceRoot(savedRoot)
          } else {
            const homeResult = await window.electronAPI.document.getHome()
            if (homeResult.success && homeResult.path) {
              useWorkspace.getState().setWorkspaceRoot(homeResult.path)
            }
          }
        } else {
          await refreshFiles()
        }
      } catch (error) {
        console.warn('Workspace init failed, fallback to mock files')
        await refreshFiles()
      }
    }
    initWorkspace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleIconClick = (icon: string) => {
    if (icon === 'settings') {
      navigate('/settings')
      return
    }

    const iconVariantMap: Record<string, SidePanelVariant> = {
      folder: 'files',
      search: 'search',
      skills: 'skills',
    }
    const targetVariant = iconVariantMap[icon]
    if (!targetVariant) return

    if (sidebarVisible && sidePanelVariant === targetVariant) {
      toggleSidebar()
      return
    }

    setSidePanelVariant(targetVariant)
    if (!sidebarVisible) {
      toggleSidebar()
    }
  }

  const handleSidebarResize = useCallback((delta: number) => {
    if (!['files', 'search', 'skills'].includes(sidePanelVariant)) return
    const key = sidePanelVariant as 'files' | 'search' | 'skills'
    const current = sidePanelWidths[key]
    setSidePanelWidth(key, current + delta)
  }, [setSidePanelWidth, sidePanelVariant, sidePanelWidths])

  const handleChatResize = useCallback((delta: number) => {
    useWorkspace.setState((state) => ({
      chatPanelWidth: Math.max(280, Math.min(600, state.chatPanelWidth + delta))
    }))
  }, [])

  // IconRail always visible
  const hideIconRail = false
  const activeIcon = useMemo(() => {
    if (sidePanelVariant === 'search') return 'search'
    if (sidePanelVariant === 'skills') return 'skills'
    return 'folder'
  }, [sidePanelVariant])

  return (
    <div className="workbench-mode-root flex flex-col h-full">
      {/* TopBar: right button toggles ChatPanel */}
      <TopBar onToggleChatPanel={toggleChatPanel} />

      <div className="flex flex-1 overflow-hidden" data-workbench-shell="true">
        <IconRail activeIcon={activeIcon} onIconClick={handleIconClick} hidden={hideIconRail} />
        <SidePanel variant={sidePanelVariant} />

        {/* Sidebar resize handle */}
        {sidebarVisible && (
          <ResizeHandle onResize={handleSidebarResize} direction="right" />
        )}

        {/* Main Content Area */}
        {splitMode ? (
          /* Split view: primary left, secondary right, draggable divider */
          <div className="flex-1 flex min-w-0" ref={splitContainerRef}>
            <div
              className="flex flex-col min-w-0 bg-[var(--bg-content)]"
              style={{ flexBasis: `${splitRatio}%`, flexShrink: 0, flexGrow: 0 }}
            >
              <WorkbenchModeOutlet mode={workbenchMode} />
            </div>
            <ResizeHandle onResize={handleSplitResize} direction="right" />
            <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg-content)]">
              <WorkbenchModeOutlet mode={splitMode} />
            </div>
          </div>
        ) : (
          /* Single mode */
          <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg-content)]">
            <WorkbenchModeOutlet mode={workbenchMode} />
          </div>
        )}

        {/* Chat panel resize handle */}
        {chatPanelVisible && (
          <ResizeHandle onResize={handleChatResize} direction="left" />
        )}

        <ChatPanel />
      </div>

      <StatusBar />
    </div>
  )
}
