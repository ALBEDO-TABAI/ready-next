import { useCallback } from 'react'
import { PanelLeftClose, Globe, FileText, Rss, Calendar, Moon, Sun } from 'lucide-react'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useTheme } from '../../stores/useTheme'
import { useWorkspace } from '../../stores/useWorkspace'
import ModeSlider from './ModeSlider'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'
import { IconButton } from '../ui/IconButton'
import {
  WORKBENCH_MODE_TRACK_MAX_WIDTH,
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_LEFT,
  WORKBENCH_TOPBAR_PADDING_RIGHT,
} from '../../modules/workbench/chrome'

const modes: { id: WorkbenchMode; label: string; icon: React.ElementType }[] = [
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'document', label: '文档', icon: FileText },
  { id: 'rss', label: 'RSS', icon: Rss },
  { id: 'calendar', label: '日程', icon: Calendar }
]

interface TopBarProps {
  onToggleChatPanel?: () => void
}

export default function TopBar({ onToggleChatPanel }: TopBarProps) {
  const { appMode, workbenchMode, splitMode, setWorkbenchMode, setSplitMode } = useMode()
  const { modalProps, showAlert } = useModal()
  const { resolvedTheme, toggleTheme } = useTheme()
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)

  const handleModeClick = (mode: WorkbenchMode, e: React.MouseEvent) => {
    if (e.shiftKey) {
      if (mode !== workbenchMode) {
        setSplitMode(mode)
      }
    } else {
      setWorkbenchMode(mode)
    }
  }

  /** Keyboard navigation for mode tabs: Arrow keys to move, Enter/Space to activate */
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent, currentIndex: number) => {
    let nextIndex = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (currentIndex + 1) % modes.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (currentIndex - 1 + modes.length) % modes.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextIndex = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      nextIndex = modes.length - 1
    }

    if (nextIndex >= 0) {
      const tabContainer = e.currentTarget.parentElement
      if (tabContainer) {
        const buttons = tabContainer.querySelectorAll<HTMLElement>('[role="tab"]')
        buttons[nextIndex]?.focus()
      }
    }
  }, [])

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
          <div
            role="tablist"
            aria-label="工作台模式"
            className="flex items-center gap-[4px]"
            style={{
              maxWidth: WORKBENCH_MODE_TRACK_MAX_WIDTH,
              overflowX: 'auto',
            }}
          >
            {modes.map((mode, index) => {
              const Icon = mode.icon
              const isPrimary = workbenchMode === mode.id
              const isSplitOnly = splitMode === mode.id && splitMode !== workbenchMode
              const isActive = isPrimary || isSplitOnly

              return (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  title={`${mode.label}${isSplitOnly ? ' (分屏)' : ''}${!isActive ? '\n按住 Shift 点击可分屏' : ''}`}
                  onClick={(event) => handleModeClick(mode.id, event)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  className="mode-tab-button relative flex h-[24px] w-[34px] items-center justify-center rounded-[10px] transition-colors duration-150"
                  style={{
                    flexShrink: 0,
                    border: '1px solid transparent',
                    background: isPrimary
                      ? 'color-mix(in srgb, var(--color-green-light) 58%, transparent)'
                      : isSplitOnly
                        ? 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)'
                        : 'transparent',
                    color: isActive ? 'var(--text-body)' : 'var(--text-gray)',
                  }}
                >
                  <Icon style={{ width: 13, height: 13 }} strokeWidth={2} />
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Right: User + Toggle */}
      <div className="flex items-center gap-[6px] no-drag flex-shrink-0">
        <button
          data-liquid-button="solid"
          title="用户设置"
          aria-label="用户设置"
          onClick={() => showAlert('用户菜单即将推出', '提示')}
          className="flex h-6 w-6 items-center justify-center rounded-xl active:scale-[0.98] transition-all duration-200 ease-out hover:bg-[var(--bg-hover)]"
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
