import { useFileDragRef } from '../../../modules/workbench/file-drag-ref'
import type React from 'react'
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
  const dragRef = useFileDragRef(item.path, item.isDirectory, Number(new Date(item.modified)))
  const kind = getFileKind(item)
  const canPreviewImage = kind === 'image' && !item.isDirectory
  const previewHeight = Math.max(52, Math.round(thumbnailSize * 0.62))
  const folderPreviewLoaded = item.isDirectory ? (folderChildrenLoaded ?? false) : true
  const isDropAccent = isDropTarget || Boolean(browserDropLine)
  const appearanceColor = getFileAppearanceColorValue(appearance?.color)
  const customIcon = appearance?.icon

  return (
    <button
      draggable={!!dragRef}
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
      // On the glass the card is only an area (hover fill, the selected one in the selected fill, V5; a drop target
      // in the signal colour's soft fill); the thumbnail inside is the object, a small inlay (V2).
      className="rounded-[var(--rn-r-sm)] border text-left transition-[background-color,border-color] hover:bg-[var(--rn-fill)]"
      style={{
        position: 'relative',
        padding: '8px 8px 10px',
        borderColor: isDropAccent ? 'var(--rn-accent)' : appearanceColor ?? 'transparent',
        background: isDropTarget ? 'var(--rn-accent-soft)' : isActive ? 'var(--rn-fill-2)' : undefined,
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
              background: 'var(--rn-accent)',
              boxShadow: '0 0 0 2px var(--rn-solid)',
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
              background: 'var(--rn-accent)',
              zIndex: 3,
              top: browserDropLine === 'before' ? -1 : undefined,
              bottom: browserDropLine === 'after' ? -1 : undefined,
            }}
          />
        </>
      )}
      <div
        className="rounded-[var(--rn-r-sm)] flex items-center justify-center overflow-hidden"
        style={{ height: previewHeight, background: 'var(--rn-inlay)', boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2)', color: 'var(--rn-ink-3)' }}
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
      <p className="mt-2 text-[11px] truncate px-1" style={{ color: 'var(--rn-ink)', fontWeight: isActive ? 500 : 400 }} title={item.name}>{item.name}</p>
      <p className="text-[11px] px-1" style={{ color: 'var(--rn-ink-3)', fontVariantNumeric: 'tabular-nums' }}>
        {item.isDirectory
          ? describeFolderPreview(folderChildren ?? [], { isLoaded: folderPreviewLoaded })
          : formatSize(item.size) || '-'}
      </p>
    </button>
  )
}
