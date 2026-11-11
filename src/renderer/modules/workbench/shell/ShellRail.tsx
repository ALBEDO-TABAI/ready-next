import {
  IconCalendar,
  IconCalendarFilled,
  IconFileText,
  IconFileTextFilled,
  IconFolder,
  IconFolderFilled,
  IconLayoutSidebarRight,
  IconLink,
  IconPuzzle,
  IconPuzzleFilled,
  IconReplace,
  IconRss,
  IconSearch,
  IconSettings,
  IconSitemap,
  IconSitemapFilled,
  IconStack2,
  IconWorld,
  IconWorldFilled,
} from '@tabler/icons-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import MorphIconRailGroup from '../../../components/motion/MorphIconRailGroup'
import type { WorkbenchMode } from '../../../stores/useMode'
import { useFastCard } from '../../../stores/useFastCard'
import { requestWorkbenchModeOpen } from '../mode-transition'
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

// Global panels that still live in the sidebar slot until their own homes land (W2-T5/T6, batch B6):
// the files view moves into the document navigator, find-and-replace becomes a result page, skills
// open as a page, backlinks merge into the relations panel, the graph opens full-size.
// The ids are the sidebar panel variants themselves.
export type ShellPanelId = 'files' | 'search' | 'skills' | 'backlinks' | 'graph'
const PANEL_ITEMS: { id: ShellPanelId; label: string; icon: typeof IconFolder; activeIcon?: typeof IconFolder }[] = [
  { id: 'files', label: '文件', icon: IconFolder, activeIcon: IconFolderFilled },
  { id: 'search', label: '查找与替换', icon: IconReplace },
  { id: 'skills', label: '技能中心', icon: IconPuzzle, activeIcon: IconPuzzleFilled },
  { id: 'backlinks', label: '反向链接', icon: IconLink },
  { id: 'graph', label: '关系图谱', icon: IconSitemap, activeIcon: IconSitemapFilled },
]

export interface ShellRailProps {
  mode: WorkbenchMode
  splitMode: WorkbenchMode | null
  onModeChange: (mode: WorkbenchMode) => void
  /** ⌥-click (or ⇧-click) opens the mode beside the current one. */
  onSplitToggle: (mode: WorkbenchMode) => void
  activePanel: ShellPanelId
  panelOpen: boolean
  onPanelClick: (panel: ShellPanelId) => void
  assistantOpen: boolean
  onAssistantOpen: () => void
}

// 收集 opens the FastCard shelf, which lives with the browser until it becomes a shell-level bar (W4-T5).
function toggleCollect() {
  const fastCard = useFastCard.getState()
  if (fastCard.panelOpen) { fastCard.collapse(); return }
  requestWorkbenchModeOpen('browser')
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
            expanded
            onSelect={handleModeSelect}
            layoutId="shell-rail-modes"
          />
        </div>
        <span className="shell-rail__rule" aria-hidden="true" />
        <div className="icon-rail-slider-shell">
          <MorphIconRailGroup
            items={PANEL_ITEMS}
            activeId={props.activePanel}
            expanded={props.panelOpen}
            onSelect={id => props.onPanelClick(id as ShellPanelId)}
            layoutId="shell-rail-panels"
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
