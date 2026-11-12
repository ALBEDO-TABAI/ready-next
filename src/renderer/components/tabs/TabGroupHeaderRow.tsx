import { useRef, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react'
import type { TabGroup } from '../../../shared/tab-groups'
import { tabGroupColorSoft, tabGroupPillBackground, tabGroupPillTextColor } from './tab-group-visuals'
import { IconButton } from '../ui'
// Group colours are user-content colours; the palette is otherwise loaded only with the document mode.
import '../../modules/document/content-palette.css'

// Shared group header row: a solid color pill (caret + name) that toggles collapse on click
// and opens the edit menu on right-click, plus hover-revealed new-tab / edit actions at
// the row's right. The whole row doubles as the "drop tab onto this group" target.
export default function TabGroupHeaderRow({
  group,
  isDropTarget,
  onToggleCollapsed,
  onNewTabInGroup,
  onEdit,
  onDragOver,
  onDrop,
}: {
  group: TabGroup
  isDropTarget: boolean
  onToggleCollapsed: () => void
  onNewTabInGroup: () => void
  // Receives the header ROW rect so hosts can anchor the edit menu under the pill.
  onEdit: (anchor: DOMRect) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const Caret = group.collapsed ? ChevronRight : ChevronDown
  const openEditor = () => {
    const el = rowRef.current
    if (el) onEdit(el.getBoundingClientRect())
  }
  return (
    <div
      ref={rowRef}
      className="relative flex flex-shrink-0 items-center"
      style={{ height: 28, paddingLeft: 6, paddingRight: 6, gap: 2 }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        // Mouse clicks must not focus the pill — the global :focus-visible outline would
        // linger as a stray ring after toggling. Keyboard focus still works.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleCollapsed}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openEditor() }}
        title={group.collapsed ? '展开群组' : '折叠群组'}
        className="flex min-w-0 items-center gap-[3px] transition-[box-shadow,filter] hover:brightness-[1.06] active:brightness-[0.97]"
        style={{
          height: 20,
          borderRadius: 6,
          padding: '0 8px 0 5px',
          background: tabGroupPillBackground(group.color),
          color: tabGroupPillTextColor(group.color),
          // A tag on the glass has no shadow of its own (DL1); a drop target rings in its colour.
          boxShadow: isDropTarget
            ? `0 0 0 2.5px ${tabGroupColorSoft(group.color, 45)}`
            : 'none',
        }}
      >
        <Caret style={{ width: 11, height: 11 }} className="flex-shrink-0" strokeWidth={2.75} />
        <span className="min-w-0 truncate text-[11px] font-semibold" style={{ lineHeight: '20px', letterSpacing: '0.01em' }}>
          {group.name || '未命名群组'}
        </span>
      </button>
      <span className="min-w-0 flex-1" />
      {/* Always visible while the flyout is up (the flyout itself is hover-summoned, so a
          second hover gate here just reads as "the buttons are missing" — and Edge keeps
          them visible during pane interaction). */}
      <IconButton
        size="sm"
        title="群组中新建标签页"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onNewTabInGroup}
        icon={<Plus aria-hidden="true" />}
      />
      <IconButton
        size="sm"
        title="群组选项"
        onMouseDown={(event) => event.preventDefault()}
        onClick={openEditor}
        icon={<Pencil aria-hidden="true" />}
      />
    </div>
  )
}
