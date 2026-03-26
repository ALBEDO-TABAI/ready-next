import { Folder, Search, Puzzle, Settings } from 'lucide-react'
import { motion } from 'framer-motion'
import MorphIconRailGroup from '../motion/MorphIconRailGroup'
import { WORKBENCH_EDGE_RAIL_SIZE } from '../../modules/workbench/chrome'

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
]

export default function IconRail({ activeIcon = 'folder', onIconClick, hidden = false, expanded = true }: IconRailProps) {
  const handleClick = (id: string) => onIconClick?.(id)

  // Task 4: Conditionally hidden for image/video modes
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
        background: 'transparent',
      }}
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
      <div className="flex flex-col items-center">
        <motion.button
          onClick={() => onIconClick?.('settings')}
          title="设置"
          aria-label="设置"
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.97, y: 0 }}
          className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[var(--text-gray)] hover:text-[var(--text-body)] hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-all duration-200 ease-out"
          style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}
        >
          <Settings className="w-[15px] h-[15px]" strokeWidth={2} />
        </motion.button>
      </div>
    </div>
  )
}
