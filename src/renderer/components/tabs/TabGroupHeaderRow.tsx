import { useRef, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react'
import type { TabGroup } from '../../../shared/tab-groups'
import { tabGroupColorSoft, tabGroupPillBackground, tabGroupPillTextColor } from './tab-group-visuals'
import { IconButton } from '../ui'
// Group colours are user-content colours; the palette is otherwise loaded only with the document mode.
import '../../modules/document/content-palette.css'

// Shared group header row: a row the size of a tab row, filled with the group's quiet colour (caret +
// name toggle collapse on click, right-click opens the edit menu), with new-tab / edit actions at
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
      data-tab-group-header={group.id}
      className="browser-tab-list__group-head"
      style={{
        background: tabGroupPillBackground(group.color),
        color: tabGroupPillTextColor(group.color),
        // No shadow or edge of its own (DL1); a drop target rings in its colour.
        boxShadow: isDropTarget ? `0 0 0 2.5px ${tabGroupColorSoft(group.color, 45)}` : 'none',
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        // Mouse clicks must not focus the row — the global :focus-visible outline would
        // linger as a stray ring after toggling. Keyboard focus still works.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleCollapsed}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openEditor() }}
        title={group.collapsed ? '展开分组' : '折叠分组'}
        className="browser-tab-list__group-toggle"
      >
        <span className="browser-tab-list__glyph"><Caret style={{ width: 13, height: 13 }} strokeWidth={2.25} /></span>
        <span className="browser-tab-list__group-name">{group.name || '未命名分组'}</span>
      </button>
      {/* Always visible while the flyout is up (the flyout itself is hover-summoned, so a
          second hover gate here just reads as "the buttons are missing" — and Edge keeps
          them visible during pane interaction). */}
      <IconButton
        size="sm"
        title="分组中新建标签页"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onNewTabInGroup}
        icon={<Plus aria-hidden="true" />}
      />
      <IconButton
        size="sm"
        title="分组选项"
        onMouseDown={(event) => event.preventDefault()}
        onClick={openEditor}
        icon={<Pencil aria-hidden="true" />}
      />
    </div>
  )
}
