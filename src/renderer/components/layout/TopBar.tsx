import { useCallback } from 'react'
import { Search, PanelLeftClose, Globe, FileText, Pen, Scissors, Rss, Calendar, Moon, Sun } from 'lucide-react'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useTheme } from '../../stores/useTheme'
import ModeSlider from './ModeSlider'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'
import MorphSegmentedControl, { type MorphSegmentedItem } from '../motion/MorphSegmentedControl'

const modes: { id: WorkbenchMode; label: string; icon: React.ElementType }[] = [
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'document', label: '文档', icon: FileText },
  { id: 'design', label: '设计', icon: Pen },
  { id: 'video', label: '剪辑', icon: Scissors },
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

  const modeItems: MorphSegmentedItem[] = modes.map((mode, index) => {
    const isPrimary = workbenchMode === mode.id
    const isSplitOnly = splitMode === mode.id && splitMode !== workbenchMode
    const isActive = isPrimary || isSplitOnly
    return {
      id: mode.id,
      label: mode.label,
      icon: mode.icon,
      active: isPrimary,
      secondaryActive: isSplitOnly,
      role: 'tab',
      tabIndex: isActive ? 0 : -1,
      title: `${mode.label}${isSplitOnly ? ' (分屏)' : ''}${!isActive ? '\n按住 Shift 点击可分屏' : ''}`,
      onClick: (e) => handleModeClick(mode.id, e),
      onKeyDown: (e) => handleTabKeyDown(e, index),
    }
  })

  return (
    <div
      className="h-[38px] flex items-center justify-between drag-region glass-surface-panel"
      style={{
        background: 'var(--surface-toolbar-bg)',
        height: 40,
        paddingLeft: 76,
        paddingRight: 14,
        boxShadow: 'var(--shadow-md)',
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      {/* Left: Mode Slider + Mode Tabs */}
      <div className="flex items-center gap-4 no-drag min-w-0">
        <ModeSlider />

        {appMode === 'workbench' && (
          <div
            className="glass-surface-card morph-segmented-track flex items-center gap-1 rounded-[12px] p-[2px]"
            role="tablist"
            aria-label="工作台模式"
            style={{ maxWidth: 'calc(100vw - 350px)', overflowX: 'auto' }}
          >
            <MorphSegmentedControl
              layoutId="topbar-modes"
              items={modeItems}
              className="flex items-center gap-[4px]"
              itemClassName="relative flex h-[30px] items-center justify-center rounded-[11px] px-[16px]"
              itemStyle={{ flexShrink: 0, minWidth: 72 }}
              contentClassName="relative z-[1] flex h-full items-center justify-center gap-[7px] text-[12px] leading-none"
            />
          </div>
        )}
      </div>

      {/* Right: Search + User + Toggle */}
      <div className="flex items-center gap-[10px] no-drag">
        <button
          title="全局搜索 (Cmd+K)"
          aria-label="全局搜索"
          onClick={() => showAlert('全局搜索功能即将推出', '提示')}
          className="p-1.5 rounded-lg transition-all duration-200 ease-out active:scale-[0.98]"
          style={{ color: 'var(--text-gray)' }}
        >
          <Search style={{ width: 15, height: 15 }} strokeWidth={2} />
        </button>

        <button
          title="用户设置"
          aria-label="用户设置"
          onClick={() => showAlert('用户菜单即将推出', '提示')}
          className="flex items-center justify-center active:scale-[0.98] transition-all duration-200 ease-out"
          style={{
            width: 24, height: 24,
            borderRadius: 12,
            background: 'var(--color-blue-light)'
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-blue)' }}>U</span>
        </button>

        <button
          onClick={toggleTheme}
          title={resolvedTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          aria-label={resolvedTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          className="p-1.5 rounded-lg transition-all duration-200 ease-out active:scale-[0.98]"
          style={{ color: 'var(--text-gray)' }}
        >
          {resolvedTheme === 'dark'
            ? <Sun style={{ width: 15, height: 15 }} strokeWidth={2} />
            : <Moon style={{ width: 15, height: 15 }} strokeWidth={2} />
          }
        </button>

        <button
          onClick={onToggleChatPanel}
          title="收起/展开聊天面板"
          aria-label="收起/展开聊天面板"
          className="p-1.5 rounded-lg transition-all duration-200 ease-out active:scale-[0.98]"
          style={{ color: 'var(--text-gray)' }}
        >
          <PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={2} />
        </button>
      </div>

      {/* Modal dialog for coming-soon alerts */}
      <Modal {...modalProps} />
    </div>
  )
}
