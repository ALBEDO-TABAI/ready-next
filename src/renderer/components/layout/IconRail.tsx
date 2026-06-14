import {
  IconFolder,
  IconLink,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconSitemap,
} from '@tabler/icons-react'
import { type CSSProperties, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import MorphIconRailGroup from '../motion/MorphIconRailGroup'
import { useTheme } from '../../stores/useTheme'
import { useRitualOverlayStore } from '../../modules/overlay/useRitualOverlay'
import {
  WORKBENCH_EDGE_RAIL_SIZE,
  WORKBENCH_EDGE_RAIL_SLOT_INSET_X,
  WORKBENCH_EDGE_RAIL_SLOT_SIZE,
} from '../../modules/workbench/chrome'
import type { NativeContextMenuItem } from '../../../shared/native-context-menu'

interface IconRailProps {
  activeIcon?: string
  onIconClick?: (icon: string) => void
  hidden?: boolean
  expanded?: boolean
}

type SettingsMenuItem = 'user' | 'theme' | 'settings'

const topIcons = [
  { id: 'folder', icon: IconFolder, label: '文件' },
  { id: 'search', icon: IconSearch, label: '搜索' },
  { id: 'skills', icon: IconPuzzle, label: '技能中心' },
  { id: 'backlinks', icon: IconLink, label: '反向链接' },
  { id: 'graph', icon: IconSitemap, label: '关系图谱' },
]

export default function IconRail({ activeIcon = 'folder', onIconClick, hidden = false, expanded = true }: IconRailProps) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const { resolvedTheme, toggleTheme } = useTheme()
  const isThemeRitualRunning = useRitualOverlayStore(
    (state) => state.session?.stage === 'theme-transition',
  )
  const handleClick = (id: string) => onIconClick?.(id)

  const handleSettingsMenuItem = (item: SettingsMenuItem) => {
    if (item === 'theme') {
      if (!isThemeRitualRunning) toggleTheme()
      return
    }

    onIconClick?.(item)
  }

  const handleSettingsButtonClick = async () => {
    const button = settingsButtonRef.current
    const api = typeof window !== 'undefined' ? window.electronAPI?.ui : null
    if (!button || !api?.showNativeContextMenu) {
      onIconClick?.('settings')
      return
    }

    const rect = button.getBoundingClientRect()
    const items: NativeContextMenuItem[] = [
      { id: 'user', label: '用户', iconKey: 'user' },
      {
        id: 'theme',
        label: '切换',
        iconKey: resolvedTheme === 'dark' ? 'theme-dark' : 'theme-light',
        enabled: !isThemeRitualRunning,
      },
      { id: 'settings', label: '设置', iconKey: 'settings' },
    ]
    const estimatedHeight = 90

    setSettingsMenuOpen(true)
    const result = await api.showNativeContextMenu({
      x: Math.max(8, Math.round(rect.right + 8)),
      y: Math.max(8, Math.round(rect.bottom - estimatedHeight)),
      items,
      presentation: 'floating',
    }).catch(() => null)
    setSettingsMenuOpen(false)

    const selectedId = result?.selectedId
    if (selectedId === 'user' || selectedId === 'theme' || selectedId === 'settings') {
      handleSettingsMenuItem(selectedId)
    }
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
      <div
        className="relative flex flex-col"
        style={{ paddingLeft: WORKBENCH_EDGE_RAIL_SLOT_INSET_X + 2 }}
      >
        <motion.button
          ref={settingsButtonRef}
          onClick={handleSettingsButtonClick}
          title="设置"
          aria-label="设置"
          aria-expanded={settingsMenuOpen}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.97, y: 0 }}
          className="w-[34px] h-[34px] rounded-[8px] flex items-center justify-center text-[var(--text-gray)] hover:text-[var(--text-body)] hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-[background-color,color,transform] duration-200 ease-out"
          style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}
        >
          <IconSettings className="w-[15px] h-[15px]" strokeWidth={1.8} />
        </motion.button>

      </div>
    </div>
  )
}
