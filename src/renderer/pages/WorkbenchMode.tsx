import { useEffect, useCallback, useRef, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../stores/useWorkspace'
import { useMode, type WorkbenchMode as WorkbenchModeType } from '../stores/useMode'
import TopBar from '../components/layout/TopBar'
import IconRail from '../components/layout/IconRail'
import SidePanel, { type SidePanelVariant } from '../components/layout/SidePanel'
import WorkbenchModeOutlet from '../components/layout/WorkbenchModeOutlet'
import ChatPanel from '../components/agent/ChatPanel'
import StatusBar from '../components/layout/StatusBar'
import { LiquidSceneProvider } from '../components/ui/LiquidGlassScene'
import { PANEL_RESIZE_STATE_EVENT } from '../modules/browser/resize-events'
import { READY_WORKBENCH_MODE_CHANGE_EVENT } from '../modules/workbench/mode-transition'
import { resolveWorkbenchPanelShortcutAction } from '../modules/workbench/panel-shortcuts'
import { readStorage } from '../utils/storage'

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
      window.dispatchEvent(
        new CustomEvent(PANEL_RESIZE_STATE_EVENT, {
          detail: { resizing: false },
        }),
      )
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('resizing')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.dispatchEvent(
      new CustomEvent(PANEL_RESIZE_STATE_EVENT, {
        detail: { resizing: true },
      }),
    )
  }, [direction])

  return (
    <div
      className="resize-handle"
      onMouseDown={handleMouseDown}
    />
  )
}

// D方案：简单的过渡状态管理
const MODE_TRANSITION_DURATION_MS = 350

export default function WorkbenchMode() {
  const {
    toggleSidebar,
    toggleChatPanel,
    setSidePanelWidth,
    sidePanelWidths,
    sidebarVisible,
    chatPanelVisible,
    sidePanelVariant,
    setSidePanelVariant,
    renamingPath,
    creatingType,
  } = useWorkspace()
  const { workbenchMode, splitMode, workbenchSplitRatio, setWorkbenchSplitRatio, setWorkbenchMode } = useMode()
  const navigate = useNavigate()
  const sceneRef = useRef<HTMLDivElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null)
  // D方案：仅用于控制 BrowserView 的显示时机
  const [isMotionSettled, setIsMotionSettled] = useState(true)
  const transitionTimerRef = useRef<number | null>(null)

  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    setWorkbenchSplitRatio(workbenchSplitRatio + deltaPercent)
  }, [workbenchSplitRatio, setWorkbenchSplitRatio])

  const initializeWorkspace = useCallback(async () => {
    try {
      const savedRoot = readStorage('ready-workspace-root')

      if (typeof window === 'undefined' || !window.electronAPI) {
        setWorkspaceInitError('工作台初始化失败：当前环境未提供 Electron 文件系统能力。')
        return
      }

      if (savedRoot) {
        useWorkspace.getState().setWorkspaceRoot(savedRoot)
        setWorkspaceInitError(null)
        return
      }

      const homeResult = await window.electronAPI.document.getHome()
      if (homeResult.success && homeResult.path) {
        useWorkspace.getState().setWorkspaceRoot(homeResult.path)
        setWorkspaceInitError(null)
        return
      }

      setWorkspaceInitError('工作台初始化失败：未能获取默认工作目录。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('Workspace init failed:', message)
      setWorkspaceInitError(`工作台初始化失败：${message}`)
    }
  }, [])

  useEffect(() => {
    void initializeWorkspace()
  }, [initializeWorkspace])

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
    const current = sidePanelWidths.shared
    setSidePanelWidth(sidePanelVariant as 'files' | 'search' | 'skills', current + delta)
  }, [setSidePanelWidth, sidePanelVariant, sidePanelWidths])

  const handleChatResize = useCallback((delta: number) => {
    useWorkspace.setState((state) => ({
      chatPanelWidth: Math.max(280, Math.min(600, state.chatPanelWidth + delta))
    }))
  }, [])

  const hideIconRail = false
  const activeIcon = useMemo(() => {
    if (sidePanelVariant === 'search') return 'search'
    if (sidePanelVariant === 'skills') return 'skills'
    return 'folder'
  }, [sidePanelVariant])

  // D方案：简化的模式切换处理
  const handleWorkbenchModeChange = useCallback((nextMode: WorkbenchModeType) => {
    if (nextMode === workbenchMode) return

    if (splitMode) {
      setWorkbenchMode(nextMode)
      return
    }

    // 清除之前的定时器
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current)
    }

    // 关键修复：如果当前是 browser 模式，先触发截图保存当前画面
    if (workbenchMode === 'browser') {
      window.dispatchEvent(new CustomEvent('ready:browser-capture-freeze'))
    }

    // 开始过渡：先标记为未稳定（BrowserView 等需要暂停更新）
    setIsMotionSettled(false)

    // 执行模式切换
    setWorkbenchMode(nextMode)

    // 过渡结束后标记为稳定
    transitionTimerRef.current = window.setTimeout(() => {
      setIsMotionSettled(true)
      transitionTimerRef.current = null
    }, MODE_TRANSITION_DURATION_MS)
  }, [setWorkbenchMode, splitMode, workbenchMode])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        window.clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  // BrowserView 隐藏控制
  useEffect(() => {
    const visibleModes = [workbenchMode, splitMode].filter(Boolean)
    if (!visibleModes.includes('browser')) {
      void window.electronAPI?.browser.hideAll()
    }
  }, [splitMode, workbenchMode])

  useEffect(() => {
    return () => {
      void window.electronAPI?.browser.hideAll()
    }
  }, [])

  useEffect(() => {
    const handleExternalWorkbenchModeChange = (event: Event) => {
      const nextMode = (event as CustomEvent<{ mode?: WorkbenchModeType }>).detail?.mode
      if (!nextMode) return
      handleWorkbenchModeChange(nextMode)
    }

    window.addEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    return () => {
      window.removeEventListener(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener)
    }
  }, [handleWorkbenchModeChange])

  useEffect(() => {
    const handlePanelShortcut = (event: KeyboardEvent) => {
      const handledAction = resolveWorkbenchPanelShortcutAction({
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        selectionText: window.getSelection()?.toString() ?? '',
        renamingPath,
        creatingType,
      })
      if (!handledAction) return

      event.preventDefault()
      if (handledAction === 'toggle-sidebar') {
        toggleSidebar()
        return
      }
      toggleChatPanel()
    }

    window.addEventListener('keydown', handlePanelShortcut)
    return () => {
      window.removeEventListener('keydown', handlePanelShortcut)
    }
  }, [creatingType, renamingPath, toggleChatPanel, toggleSidebar])

  return (
    <LiquidSceneProvider mouseContainer={sceneRef}>
      <div ref={sceneRef} className="workbench-mode-root relative flex h-full flex-col overflow-hidden">
        <div className="relative z-10 flex h-full flex-col">
          {workspaceInitError && (
            <div
              className="glass-surface-floating mx-3 mt-2 flex items-center justify-between rounded-[12px] px-3 py-2 text-[12px]"
              style={{
                border: '1px solid var(--color-orange)',
                color: 'var(--text-secondary)',
                background: 'color-mix(in srgb, var(--surface-floating-bg) 34%, transparent)',
              }}
            >
              <span>{workspaceInitError}</span>
              <button
                type="button"
                onClick={() => void initializeWorkspace()}
                className="rounded-[8px] px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  border: '1px solid transparent',
                  color: 'var(--text-body)',
                }}
              >
                重试
              </button>
            </div>
          )}

          <TopBar onToggleChatPanel={toggleChatPanel} onWorkbenchModeChange={handleWorkbenchModeChange} />

          <div className="flex flex-1 overflow-hidden" data-workbench-shell="true">
            <IconRail activeIcon={activeIcon} onIconClick={handleIconClick} hidden={hideIconRail} expanded={sidebarVisible} />
            <SidePanel variant={sidePanelVariant} />

            {sidebarVisible && (
              <ResizeHandle onResize={handleSidebarResize} direction="right" />
            )}

            {splitMode ? (
              <div className="flex-1 flex min-w-0" ref={splitContainerRef}>
                <div
                  className="flex flex-col min-w-0"
                  style={{
                    flexBasis: `${workbenchSplitRatio}%`,
                    flexShrink: 0,
                    flexGrow: 0,
                    background: 'transparent',
                  }}
                >
                  <WorkbenchModeOutlet mode={workbenchMode} isMotionSettled={isMotionSettled} />
                </div>
                <ResizeHandle onResize={handleSplitResize} direction="right" />
                <div className="flex-1 flex flex-col min-w-0" style={{ background: 'transparent' }}>
                  <WorkbenchModeOutlet mode={splitMode} isMotionSettled={isMotionSettled} />
                </div>
              </div>
            ) : (
              <div
                className="relative flex-1 flex flex-col min-w-0 overflow-hidden"
                style={{ background: 'transparent' }}
              >
                <WorkbenchModeOutlet
                  mode={workbenchMode}
                  isMotionSettled={isMotionSettled}
                />
              </div>
            )}

            {chatPanelVisible && (
              <ResizeHandle onResize={handleChatResize} direction="left" />
            )}

            <ChatPanel />
          </div>

          <StatusBar />
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
