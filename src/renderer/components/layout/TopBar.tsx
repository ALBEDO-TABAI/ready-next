import { useCallback } from 'react'
import { PanelLeftClose, Moon, Sun } from 'lucide-react'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useTheme } from '../../stores/useTheme'
import { useWorkspace } from '../../stores/useWorkspace'
import { useRitualOverlayStore } from '../../modules/overlay/useRitualOverlay'
import ModeSlider from './ModeSlider'
import DraggableModeTabs from './DraggableModeTabs'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'
import { IconButton } from '../ui/IconButton'
import {
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_LEFT,
  WORKBENCH_TOPBAR_PADDING_RIGHT,
} from '../../modules/workbench/chrome'
import { resolveWorkbenchSplitToggle } from '../../modules/workbench/mode-split'

interface TopBarProps {
  onToggleChatPanel?: () => void
  onWorkbenchModeChange?: (mode: WorkbenchMode) => void | Promise<void>
}

export default function TopBar({ onToggleChatPanel, onWorkbenchModeChange }: TopBarProps) {
  const { appMode, workbenchMode, splitMode, setWorkbenchMode, setSplitMode } = useMode()
  const { modalProps, showAlert } = useModal()
  const { resolvedTheme, toggleTheme } = useTheme()
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const isThemeRitualRunning = useRitualOverlayStore(
    (state) => state.session?.stage === 'theme-transition',
  )

  const handleModeChange = useCallback((mode: WorkbenchMode) => {
    if (onWorkbenchModeChange) {
      void onWorkbenchModeChange(mode)
      return
    }
    setWorkbenchMode(mode)
  }, [onWorkbenchModeChange, setWorkbenchMode])

  const handleSplitModeToggle = useCallback((mode: WorkbenchMode) => {
    setSplitMode(resolveWorkbenchSplitToggle({
      workbenchMode,
      splitMode,
      requestedMode: mode,
    }))
  }, [setSplitMode, splitMode, workbenchMode])

  return (
    <div
      data-liquid-shell="topbar"
      className="flex items-center justify-between drag-region"
      style={{
        background: 'transparent',
        height: WORKBENCH_TOPBAR_HEIGHT,
        paddingLeft: WORKBENCH_TOPBAR_PADDING_LEFT,
        paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT,
        borderBottom: '1px solid transparent',
        boxShadow: 'none',
      }}
    >
      {/* Left: Mode Slider + Mode Tabs */}
      <div className="flex items-center gap-3 no-drag min-w-0">
        <ModeSlider />
        {appMode === 'workbench' && (
          <DraggableModeTabs
            activeMode={workbenchMode}
            splitMode={splitMode}
            onChange={handleModeChange}
            onSplitToggle={handleSplitModeToggle}
          />
        )}
      </div>

      {/* Right: User + Toggle */}
      <div className="flex items-center gap-[6px] no-drag flex-shrink-0">
        <button
          data-liquid-button="solid"
          title="用户设置"
          aria-label="用户设置"
          onClick={() => showAlert('用户菜单即将推出', '提示')}
          className="flex h-6 w-6 items-center justify-center rounded-xl active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out hover:bg-[var(--bg-hover)]"
          style={{
            flexShrink: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-blue)', lineHeight: 1 }}>U</span>
        </button>

        <IconButton
          icon={resolvedTheme === 'dark' ? <Sun style={{ width: 15, height: 15 }} strokeWidth={2} /> : <Moon style={{ width: 15, height: 15 }} strokeWidth={2} />}
          onClick={toggleTheme}
          disabled={isThemeRitualRunning}
          title={resolvedTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />

        {chatPanelVisible && (
          <IconButton
            icon={<PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={2} />}
            onClick={onToggleChatPanel}
            title="收起/展开聊天面板"
            style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
          />
        )}
      </div>

      {/* Modal dialog for coming-soon alerts */}
      <Modal {...modalProps} />
    </div>
  )
}
