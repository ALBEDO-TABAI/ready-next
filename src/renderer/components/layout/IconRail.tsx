import { Folder, Link2, Moon, Network, Puzzle, Search, Settings, Sun, User } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import MorphIconRailGroup from '../motion/MorphIconRailGroup'
import { useTheme } from '../../stores/useTheme'
import { useRitualOverlayStore } from '../../modules/overlay/useRitualOverlay'
import {
  WORKBENCH_EDGE_RAIL_SIZE,
  WORKBENCH_EDGE_RAIL_SLOT_INSET_X,
  WORKBENCH_EDGE_RAIL_SLOT_SIZE,
} from '../../modules/workbench/chrome'

interface IconRailProps {
  activeIcon?: string
  onIconClick?: (icon: string) => void
  hidden?: boolean
  expanded?: boolean
}

const topIcons = [
  { id: 'folder', icon: Folder, label: '文件' },
  { id: 'search', icon: Search, label: '搜索' },
  { id: 'skills', icon: Puzzle, label: '技能中心' },
  { id: 'backlinks', icon: Link2, label: '反向链接' },
  { id: 'graph', icon: Network, label: '关系图谱' },
]

export default function IconRail({ activeIcon = 'folder', onIconClick, hidden = false, expanded = true }: IconRailProps) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const { resolvedTheme, toggleTheme } = useTheme()
  const isThemeRitualRunning = useRitualOverlayStore(
    (state) => state.session?.stage === 'theme-transition',
  )
  const handleClick = (id: string) => onIconClick?.(id)

  useEffect(() => {
    if (!settingsMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        settingsButtonRef.current?.contains(target) ||
        settingsMenuRef.current?.contains(target)
      ) {
        return
      }
      setSettingsMenuOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [settingsMenuOpen])

  const handleSettingsMenuItem = (item: 'user' | 'theme' | 'settings') => {
    if (item === 'theme') {
      if (!isThemeRitualRunning) toggleTheme()
      setSettingsMenuOpen(false)
      return
    }

    onIconClick?.(item)
    setSettingsMenuOpen(false)
  }

  if (hidden) return null

  return (
    <div
      data-liquid-shell="icon-rail"
      className="flex flex-col justify-between py-[10px]"
      role="toolbar"
      aria-label="工具栏"
      style={{
        width: WORKBENCH_EDGE_RAIL_SIZE,
        minWidth: WORKBENCH_EDGE_RAIL_SIZE,
        '--icon-rail-slot-inset-x': `${WORKBENCH_EDGE_RAIL_SLOT_INSET_X}px`,
        '--icon-rail-slot-size': `${WORKBENCH_EDGE_RAIL_SLOT_SIZE}px`,
        background: 'transparent',
      } as CSSProperties}
    >
      {/* Top Icons */}
      <div className="flex flex-col items-center gap-[6px]">
        <div className="icon-rail-slider-shell">
          <MorphIconRailGroup
            items={topIcons}
            activeId={activeIcon}
            expanded={expanded}
            onSelect={handleClick}
            layoutId="icon-rail-main"
          />
        </div>
      </div>

      {/* Bottom Icons */}
      <div className="relative flex flex-col items-center">
        <motion.button
          ref={settingsButtonRef}
          onClick={() => setSettingsMenuOpen((open) => !open)}
          title="设置"
          aria-label="设置"
          aria-expanded={settingsMenuOpen}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.97, y: 0 }}
          className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[var(--text-gray)] hover:text-[var(--text-body)] hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-[background-color,color,transform] duration-200 ease-out"
          style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}
        >
          <Settings className="w-[15px] h-[15px]" strokeWidth={2} />
        </motion.button>

        {settingsMenuOpen && (
          <div
            ref={settingsMenuRef}
            className="glass-surface-floating ready-floating-menu icon-rail-settings-menu"
            data-icon-rail-settings-menu="true"
          >
            <button
              type="button"
              className="ready-floating-menu-item icon-rail-settings-menu__item"
              onClick={() => handleSettingsMenuItem('user')}
            >
              <User className="w-[13px] h-[13px]" strokeWidth={2} />
              <span>用户</span>
            </button>
            <button
              type="button"
              className="ready-floating-menu-item icon-rail-settings-menu__item"
              onClick={() => handleSettingsMenuItem('theme')}
              disabled={isThemeRitualRunning}
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="w-[13px] h-[13px]" strokeWidth={2} />
              ) : (
                <Moon className="w-[13px] h-[13px]" strokeWidth={2} />
              )}
              <span>日夜切换</span>
            </button>
            <button
              type="button"
              className="ready-floating-menu-item icon-rail-settings-menu__item"
              onClick={() => handleSettingsMenuItem('settings')}
            >
              <Settings className="w-[13px] h-[13px]" strokeWidth={2} />
              <span>设置</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
