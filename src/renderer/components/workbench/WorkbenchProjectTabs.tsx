import type { DragEvent, MouseEvent, ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { MorphTabButton, MorphTabStrip } from '../motion/MorphTabStrip'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_MAX_WIDTH,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'

export interface WorkbenchProjectTabItem {
  id: string
  label: string
  title?: string
  dotColor?: string
  active?: boolean
  secondaryActive?: boolean
  dirty?: boolean
}

interface WorkbenchProjectTabsProps {
  layoutId: string
  tabs: WorkbenchProjectTabItem[]
  onTabClick: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onTabClose?: (id: string, event: MouseEvent<HTMLElement>) => void
  onNewTab?: () => void | Promise<void>
  onTabDragStart?: (event: DragEvent<HTMLButtonElement>, id: string) => void
  onTabDragOver?: (event: DragEvent<HTMLButtonElement>, index: number) => void
  onTabDrop?: (event: DragEvent<HTMLButtonElement>, index: number) => void
  onTabDragEnd?: (event: DragEvent<HTMLButtonElement>) => void
  renderAfterTabs?: ReactNode
  rightActions?: ReactNode
}

export default function WorkbenchProjectTabs({
  layoutId,
  tabs,
  onTabClick,
  onTabClose,
  onNewTab,
  onTabDragStart,
  onTabDragOver,
  onTabDrop,
  onTabDragEnd,
  renderAfterTabs,
  rightActions,
}: WorkbenchProjectTabsProps) {
  const activeTabHeight = WORKBENCH_TAB_ROW_HEIGHT - 1
  const inactiveTabHeight = Math.max(28, WORKBENCH_TAB_ROW_HEIGHT - 6)
  const inlineNewTabButton = onNewTab ? (
    <button
      onClick={() => void onNewTab()}
      className="flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
      style={{ width: 26, height: 26, borderRadius: 6, alignSelf: 'center', marginLeft: 4 }}
      title="新建"
    >
      <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
    </button>
  ) : null

  return (
    <div
      className="glass-surface-panel flex items-center justify-between flex-shrink-0"
      style={{
        height: WORKBENCH_TAB_ROW_HEIGHT,
        borderBottom: '1px solid var(--border-default)',
        background: 'var(--surface-toolbar-bg)',
      }}
    >
      <div
        className="flex items-end h-full min-w-0 overflow-hidden"
        style={{ paddingLeft: WORKBENCH_HEADER_EDGE_X }}
      >
        <MorphTabStrip
          layoutId={layoutId}
          className="flex min-w-0 items-end h-full overflow-hidden gap-[1px]"
        >
          {tabs.map((tab, index) => {
            const isActive = Boolean(tab.active)
            const isSecondaryActive = Boolean(tab.secondaryActive) && !isActive
            return (
              <div key={tab.id} className="relative flex min-w-0 flex-1 items-end" style={{ maxWidth: WORKBENCH_TAB_MAX_WIDTH }}>
                <MorphTabButton
                  layoutId={layoutId}
                  active={isActive}
                  secondaryActive={isSecondaryActive}
                  draggable={Boolean(onTabDragStart)}
                  onDragStart={onTabDragStart ? (event) => onTabDragStart(event, tab.id) : undefined}
                  onDragOver={onTabDragOver ? (event) => onTabDragOver(event, index) : undefined}
                  onDrop={onTabDrop ? (event) => onTabDrop(event, index) : undefined}
                  onDragEnd={onTabDragEnd}
                  onClick={(event) => onTabClick(tab.id, event)}
                  className="group relative flex min-w-0 flex-1 cursor-pointer items-center rounded-t-[8px] px-[10px] text-[12px] transition-all duration-150"
                  style={{
                    gap: 6,
                    height: isActive ? activeTabHeight : inactiveTabHeight,
                    background: isActive || isSecondaryActive ? 'var(--surface-card-bg)' : 'transparent',
                    color: isActive || isSecondaryActive ? 'var(--text-title)' : 'var(--text-gray)',
                    borderBottom: isActive
                      ? '1px solid var(--surface-card-bg)'
                      : isSecondaryActive
                        ? '2px solid var(--color-blue)'
                        : '1px solid transparent',
                    alignSelf: 'flex-end',
                  }}
                  contentClassName="relative z-[1] flex min-w-0 flex-1 items-center gap-[6px]"
                  title={tab.title}
                >
                  {tab.dotColor ? (
                    <span
                      className="flex-shrink-0 rounded-full"
                      style={{ width: 8, height: 8, background: tab.dotColor }}
                    />
                  ) : null}
                  <span className="truncate flex-1 min-w-0" style={{ lineHeight: '28px' }}>
                    {tab.label}
                    {tab.dirty ? <span className="ml-0.5" style={{ color: 'var(--text-light)' }}>●</span> : null}
                  </span>
                  {onTabClose ? (
                    <span
                      role="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onTabClose(tab.id, event)
                      }}
                      className="rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-all cursor-pointer flex-shrink-0"
                      style={{ padding: 2 }}
                      title="Close"
                    >
                      <X style={{ width: 10, height: 10 }} strokeWidth={2} />
                    </span>
                  ) : null}
                </MorphTabButton>
              </div>
            )
          })}
        </MorphTabStrip>

        {inlineNewTabButton}
        {renderAfterTabs}
      </div>

      {rightActions ? (
        <div
          className="flex items-center flex-shrink-0"
          style={{ gap: 8, paddingLeft: 8, paddingRight: WORKBENCH_HEADER_EDGE_X }}
        >
          {rightActions}
        </div>
      ) : null}
    </div>
  )
}
