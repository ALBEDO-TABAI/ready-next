import { useFileDragRef } from '../../../modules/workbench/file-drag-ref'
import { useState } from 'react'
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react'
import type { FileItem } from '../../../stores/useWorkspace'
import type { FileAppearance } from '../../../stores/fileAppearance'
import { FileAppearanceColorDot, fileIcon } from './file-icons'
import { InlineInput } from './inline-inputs'
import { putDragData } from './drag-utils'

export function FileTreeItem({
  item,
  isActive,
  isExpanded,
  isRenaming,
  isDropTarget,
  isBrowserDropInside,
  browserDropLine,
  isFlashing,
  draggableEnabled,
  dragMovable,
  dragItems,
  appearance,
  depth,
  onToggleDir,
  onOpenFile,
  onSelectFile,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onRenameConfirm,
  onRenameCancel
}: {
  item: FileItem
  isActive: boolean
  isExpanded: boolean
  isRenaming: boolean
  isDropTarget: boolean
  isBrowserDropInside?: boolean
  browserDropLine?: 'before' | 'after' | null
  isFlashing?: boolean
  draggableEnabled?: boolean
  dragMovable?: boolean
  dragItems?: FileItem[]
  appearance?: FileAppearance
  depth: number
  onToggleDir: () => void
  onOpenFile: () => void
  onSelectFile: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onRenameConfirm: (newName: string) => void
  onRenameCancel: () => void
}) {
  const dragRef = useFileDragRef(item.path, item.isDirectory, Number(new Date(item.modified)))
  const lineInset = 12 + depth * 22
  const isBrowserDropAccent = isBrowserDropInside || Boolean(browserDropLine)
  const [isHovered, setIsHovered] = useState(false)

  return (
    <div
      draggable={!!dragRef && (draggableEnabled ?? true)}
      onDragStart={(e) => {
        onDragStart?.(e)
        putDragData(e, item, dragMovable ?? true, {
          selectedItems: dragItems,
        })
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          onSelectFile(e)
          return
        }
        onOpenFile()
      }}
      onContextMenu={onContextMenu}
      data-file-tree-highlighted={
        isActive || (!isActive && !isDropTarget && !isBrowserDropAccent && isHovered)
          ? 'true'
          : undefined
      }
      className={`
        flex items-center gap-[6px] rounded-[8px] text-[13px] cursor-pointer
        transition-[background-color,box-shadow,outline-color] duration-200 ease-out group
        ${isFlashing ? 'file-tree-item-flash-complete' : ''}
      `}
      style={{
        position: 'relative',
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 22}px`,
        ...(isActive
          ? {
              background: 'var(--files-panel-state-active-bg)',
              boxShadow: 'var(--files-panel-state-active-shadow)',
            }
          : {}),
        ...(!isActive && !isDropTarget && !isBrowserDropAccent && isHovered
          ? {
              background: 'var(--files-panel-state-hover-bg)',
              boxShadow: 'var(--files-panel-state-hover-shadow)',
            }
          : {}),
        ...(isDropTarget
          ? { outline: '1px dashed var(--color-blue)', background: 'var(--color-blue-light)' }
          : {}),
        ...(isBrowserDropAccent
          ? {
              background: 'color-mix(in srgb, rgba(255, 255, 255, 0.28) 62%, var(--color-blue-light) 38%)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 48%, rgba(255,255,255,0.62)), 0 4px 14px rgba(59,130,246,0.09)',
              zIndex: 2,
            }
          : {}),
      }}
    >
      {browserDropLine && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: lineInset,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--color-blue)',
              boxShadow: '0 0 0 2px rgba(255,255,255,0.76), 0 4px 12px rgba(59,130,246,0.24)',
              zIndex: 3,
              top: browserDropLine === 'before' ? -2 : undefined,
              bottom: browserDropLine === 'after' ? -2 : undefined,
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: lineInset + 10,
              right: 8,
              height: 3,
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-blue) 88%, rgba(255,255,255,0.24))',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.28), 0 4px 12px rgba(59,130,246,0.18)',
              zIndex: 3,
              top: browserDropLine === 'before' ? 0 : undefined,
              bottom: browserDropLine === 'after' ? 0 : undefined,
            }}
          />
        </>
      )}

      {item.isDirectory ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void onToggleDir()
          }}
          className="w-3 h-3 flex-shrink-0 flex items-center justify-center"
          style={{ color: 'var(--text-light)' }}
        >
          {isExpanded
            ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--text-light)' }} />
            : <ChevronRight className="w-3 h-3" style={{ color: 'var(--text-light)' }} />}
        </button>
      ) : (
        <span className="w-3 flex-shrink-0" />
      )}

      <span
        className="relative flex-shrink-0"
        style={{
          width: 14,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {fileIcon(item, isExpanded, appearance)}
        <FileAppearanceColorDot
          appearance={appearance}
          style={{ position: 'absolute', right: -3, bottom: -3 }}
        />
      </span>

      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <InlineInput
            defaultValue={item.name}
            onConfirm={onRenameConfirm}
            onCancel={onRenameCancel}
          />
        ) : (
          <span
            className="truncate block font-medium"
            style={{ color: isActive ? 'var(--text-title)' : item.isDirectory ? 'var(--text-body)' : 'var(--text-muted)' }}
          >
            {item.name}
          </span>
        )}
      </div>
    </div>
  )
}
