import {
  IconCalendar,
  IconCalendarFilled,
  IconFileText,
  IconFileTextFilled,
  IconLayoutSidebarRight,
  IconRss,
  IconSearch,
  IconSettings,
  IconStack2,
  IconWorld,
  IconWorldFilled,
} from '@tabler/icons-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import MorphIconRailGroup from '../../../components/motion/MorphIconRailGroup'
import type { WorkbenchMode } from '../../../stores/useMode'
import { useFastCard } from '../../../stores/useFastCard'
import './shell.css'
import { SHELL_RAIL_WIDTH } from '../../../../shared/workbench-shell-geometry'

// The icon rail of the Ready Next shell (W2 §2.1): mode switching on top, global actions at the
// bottom. Selected glyphs follow the user's rule (white glow; closed shapes fill, open strokes thicken).

const MODE_ITEMS: { id: WorkbenchMode; label: string; hint: string; icon: typeof IconWorld; activeIcon?: typeof IconWorld }[] = [
  { id: 'browser', label: '浏览器', hint: '⌘1', icon: IconWorld, activeIcon: IconWorldFilled },
  { id: 'document', label: '文档', hint: '⌘2', icon: IconFileText, activeIcon: IconFileTextFilled },
  { id: 'rss', label: '资讯', hint: '⌘3', icon: IconRss },
  { id: 'calendar', label: '日历', hint: '⌘4', icon: IconCalendar, activeIcon: IconCalendarFilled },
]

export interface ShellRailProps {
  mode: WorkbenchMode
  splitMode: WorkbenchMode | null
  onModeChange: (mode: WorkbenchMode) => void
  /** ⌥-click (or ⇧-click) opens the mode beside the current one. */
  onSplitToggle: (mode: WorkbenchMode) => void
  assistantOpen: boolean
  onAssistantOpen: () => void
  /** The sidebar is on screen (docked or slid out). While it is collapsed the selected glyph loses its tile (DL8). */
  sidebarShown: boolean
}

// 收集 opens the FastCard shelf where the person is (W4 §6): a drawer in the document, 资讯 and calendar modes,
// the overlay window over the native web layer in the browser.
function toggleCollect() {
  const fastCard = useFastCard.getState()
  if (fastCard.panelOpen) { fastCard.collapse(); return }
  void fastCard.open()
}

function RailButton({ label, onClick, children, badge }: { label: string; onClick: () => void; children: ReactNode; badge?: number }) {
  return (
    <button type="button" className="shell-rail__button" title={label} aria-label={label} onClick={onClick}>
      {children}
      {badge ? <span className="shell-rail__badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  )
}

export default function ShellRail(props: ShellRailProps) {
  const navigate = useNavigate()
  const stagedCount = useFastCard(state => state.items.length)
  const handleModeSelect = (id: string, event: MouseEvent<HTMLButtonElement>) => {
    const mode = id as WorkbenchMode
    if (event.altKey || event.shiftKey) {
      props.onSplitToggle(mode)
      return
    }
    props.onModeChange(mode)
  }

  return (
    <nav
      className="shell-rail"
      data-shell-region="rail"
      data-liquid-shell="icon-rail"
      aria-label="工具栏"
      style={{ width: SHELL_RAIL_WIDTH, minWidth: SHELL_RAIL_WIDTH } as CSSProperties}
    >
      <div className="shell-rail__group" role="group" aria-label="模式">
        <div className="icon-rail-slider-shell">
          <MorphIconRailGroup
            items={MODE_ITEMS}
            activeId={props.mode}
            secondaryId={props.splitMode}
            expanded={props.sidebarShown}
            onSelect={handleModeSelect}
            layoutId="shell-rail-modes"
          />
        </div>
      </div>
      <div className="shell-rail__group" role="group" aria-label="全局">
        <RailButton label="搜索 ⌘K" onClick={() => window.dispatchEvent(new CustomEvent('ready:open-quick-switcher'))}><IconSearch className="shell-rail__glyph" strokeWidth={1.8} /></RailButton>
        <RailButton label="收集" onClick={toggleCollect} badge={stagedCount}><IconStack2 className="shell-rail__glyph" strokeWidth={1.8} /></RailButton>
        {!props.assistantOpen && (
          <RailButton label="助手 Tab" onClick={props.onAssistantOpen}><IconLayoutSidebarRight className="shell-rail__glyph" strokeWidth={1.8} /></RailButton>
        )}
        <RailButton label="设置 ⌘," onClick={() => navigate('/settings')}><IconSettings className="shell-rail__glyph" strokeWidth={1.8} /></RailButton>
      </div>
    </nav>
  )
}
