import { Folder, Search, Puzzle, Settings } from 'lucide-react'
import { motion } from 'framer-motion'
import MorphIconRailGroup from '../motion/MorphIconRailGroup'
import { useTheme } from '../../stores/useTheme'

interface IconRailProps {
  activeIcon?: string
  onIconClick?: (icon: string) => void
  hidden?: boolean
}

const topIcons = [
  { id: 'folder', icon: Folder, label: '文件' },
  { id: 'search', icon: Search, label: '搜索' },
  { id: 'skills', icon: Puzzle, label: '技能中心' },
]

export default function IconRail({ activeIcon = 'folder', onIconClick, hidden = false }: IconRailProps) {
  const handleClick = (id: string) => onIconClick?.(id)
  const skin = useTheme((state) => state.skin)
  const isLiquid = skin === 'liquid-glass'

  // Task 4: Conditionally hidden for image/video modes
  if (hidden) return null

  return (
    <div
      className="glass-surface-panel flex flex-col justify-between py-[10px] border-r border-[var(--border-default)]"
      role="toolbar"
      aria-label="工具栏"
      style={{
        width: 44,
        minWidth: 44,
        background: 'var(--surface-panel-bg)',
      }}
    >
      {/* Top Icons */}
      <div className="flex flex-col items-center gap-[6px]">
        <MorphIconRailGroup
          items={topIcons}
          activeId={activeIcon}
          onSelect={handleClick}
          layoutId="icon-rail-main"
          className="flex flex-col items-center gap-[6px]"
        />
      </div>

      {/* Bottom Icons */}
      <div className="flex flex-col items-center">
        <motion.button
          onClick={() => onIconClick?.('settings')}
          title="设置"
          aria-label="设置"
          whileHover={isLiquid ? { y: -1 } : undefined}
          whileTap={isLiquid ? { scale: 0.97, y: 0 } : undefined}
          className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[var(--text-gray)] hover:text-[var(--text-body)] active:scale-[0.98] transition-all duration-200 ease-out"
        >
          <Settings className="w-[15px] h-[15px]" strokeWidth={2} />
        </motion.button>
      </div>
    </div>
  )
}
