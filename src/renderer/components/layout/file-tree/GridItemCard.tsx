import type React from 'react'
import { IconFolder as Folder } from '@tabler/icons-react'
import type { FileItem } from '../../../stores/useWorkspace'
import { getFileAppearanceColorValue, type FileAppearance } from '../../../stores/fileAppearance'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import { FolderPreview } from '../FolderPreview'
import { describeFolderPreview } from '../folderPreviewModel'
import { FileAppearanceColorDot, CustomFileIcon, fileIcon } from './file-icons'
import { formatSize, getFileKind } from './file-kinds'
import { putDragData } from './drag-utils'

export function GridItemCard({
  item,
  isActive,
  isDropTarget,
  browserDropLine,
  thumbnailSize,
  folderChildren,
  folderChildrenLoaded,
  dragMovable,
  dragItems,
  appearance,
  onOpen,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  item: FileItem
  isActive: boolean
  isDropTarget: boolean
  browserDropLine?: 'before' | 'after' | null
  thumbnailSize: number
  folderChildren?: FileItem[]
  folderChildrenLoaded?: boolean
  dragMovable?: boolean
  dragItems?: FileItem[]
  appearance?: FileAppearance
  onOpen: () => void
  onSelect: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const kind = getFileKind(item)
  const canPreviewImage = kind === 'image' && !item.isDirectory
  const previewHeight = Math.max(52, Math.round(thumbnailSize * 0.62))
  const folderPreviewLoaded = item.isDirectory ? (folderChildrenLoaded ?? false) : true
  const isDropAccent = isDropTarget || Boolean(browserDropLine)
  const appearanceColor = getFileAppearanceColorValue(appearance?.color)
  const customIcon = appearance?.icon

  return (
    <button
      draggable
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
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          onSelect(e)
          return
        }
        onOpen()
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      data-file-grid-card="true"
      data-selected={isActive ? 'true' : undefined}
      className="content-surface-card rounded-[8px] border text-left transition-[background-color,border-color,box-shadow] hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]"
      style={{
        position: 'relative',
        padding: '8px 8px 10px',
        borderColor: isDropAccent ? 'var(--color-blue)' : isActive ? 'var(--files-panel-state-active-border)' : appearanceColor ?? 'var(--border-default)',
        background: isDropTarget ? 'var(--color-blue-light)' : isActive ? 'var(--files-panel-state-active-bg)' : 'var(--bg-primary)',
        boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : undefined,
      }}
    >
      <FileAppearanceColorDot
        appearance={appearance}
        size={9}
        style={{ position: 'absolute', top: 7, right: 7, zIndex: 4 }}
      />
      {browserDropLine && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: 8,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--color-blue)',
              boxShadow: '0 0 0 2px rgba(255,255,255,0.76), 0 4px 12px rgba(59,130,246,0.24)',
              zIndex: 3,
              top: browserDropLine === 'before' ? -4 : undefined,
              bottom: browserDropLine === 'after' ? -4 : undefined,
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: 18,
              right: 8,
              height: 3,
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-blue) 88%, rgba(255,255,255,0.24))',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.28), 0 4px 12px rgba(59,130,246,0.18)',
              zIndex: 3,
              top: browserDropLine === 'before' ? -1 : undefined,
              bottom: browserDropLine === 'after' ? -1 : undefined,
            }}
          />
        </>
      )}
      <div
        className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-content)] flex items-center justify-center overflow-hidden"
        style={{ height: previewHeight }}
      >
        {customIcon ? (
          <CustomFileIcon icon={customIcon} size={Math.max(28, Math.min(46, Math.round(previewHeight * 0.5)))} />
        ) : item.isDirectory ? (
          <FolderPreview
            childrenItems={folderChildren ?? []}
            previewHeight={previewHeight}
            isLoaded={folderPreviewLoaded}
          />
        ) : canPreviewImage ? (
          <img src={toLocalFileUrl(item.path)} alt={item.name} className="max-h-full max-w-full object-cover" />
        ) : (
          fileIcon(item, false, appearance, 18)
        )}
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-title)] truncate px-1" title={item.name}>{item.name}</p>
      <p className="text-[10px] text-[var(--text-light)] px-1">
        {item.isDirectory
          ? describeFolderPreview(folderChildren ?? [], { isLoaded: folderPreviewLoaded })
          : formatSize(item.size) || '-'}
      </p>
    </button>
  )
}
