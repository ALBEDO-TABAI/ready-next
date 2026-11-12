import {
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music2,
  Pen,
} from 'lucide-react'

import { toLocalFileUrl } from '../../utils/dragDrop'
import {
  getFolderPreviewLabel,
  type FolderPreviewItemLike,
  type FolderPreviewKind,
  selectFolderPreviewItems,
} from './folderPreviewModel'

// A folder's preview tiles are quiet areas on the thumbnail: the kind shows in the icon, not in a colour of its
// own (W1 DL5/DL6 — no decorative hues).
const PREVIEW_TILE_TONE = { background: 'var(--rn-fill)', color: 'var(--rn-ink-3)' } as const

function previewIcon(kind: FolderPreviewKind) {
  if (kind === 'folder') return Folder
  if (kind === 'image') return ImageIcon
  if (kind === 'video') return Film
  if (kind === 'audio') return Music2
  if (kind === 'spreadsheet') return FileSpreadsheet
  if (kind === 'design') return Pen
  return FileText
}

export function FolderPreview({
  childrenItems,
  previewHeight,
  isLoaded = true,
}: {
  childrenItems: FolderPreviewItemLike[]
  previewHeight: number
  isLoaded?: boolean
}) {
  const entries = isLoaded ? selectFolderPreviewItems(childrenItems) : []
  const hasImageEntry = entries.some((entry) => entry.kind === 'image')

  if (!isLoaded) {
    return (
      <div
        data-folder-preview="true"
        data-folder-preview-loading="true"
        className="grid h-full w-full gap-[6px]"
        style={{
          height: previewHeight,
          padding: 6,
          boxSizing: 'border-box',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        }}
      >
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="rounded-[6px]"
            style={{ background: 'var(--rn-fill)' }}
          />
        ))}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div
        data-folder-preview="true"
        data-folder-preview-empty="true"
        className="h-full w-full flex flex-col items-center justify-center gap-[4px]"
        style={{ height: previewHeight }}
      >
        <Folder className="h-[16px] w-[16px]" style={{ color: 'var(--rn-ink-3)' }} />
        <span className="text-[9px]" style={{ color: 'var(--rn-ink-3)' }}>空文件夹</span>
      </div>
    )
  }

  const gridColumns = entries.length === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))'
  const gridRows = entries.length <= 2 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))'

  if (!hasImageEntry) {
    return (
      <div
        data-folder-preview="true"
        data-folder-preview-compact="true"
        className="grid h-full w-full gap-[6px]"
        style={{
          height: previewHeight,
          padding: 6,
          boxSizing: 'border-box',
          gridTemplateColumns: gridColumns,
          gridTemplateRows: gridRows,
        }}
      >
        {entries.map((entry) => {
          const tone = PREVIEW_TILE_TONE
          return (
            <div
              key={entry.path}
              data-folder-preview-tile-kind={entry.kind}
              title={entry.name}
              className="flex items-center justify-center rounded-[8px] px-[8px] py-[6px] text-[9px] font-medium text-center"
              style={{
                background: tone.background,
                color: 'var(--rn-ink-2)',
                lineHeight: 1.15,
              }}
            >
              <span className="line-clamp-2 break-words">{getFolderPreviewLabel(entry)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      data-folder-preview="true"
      className="grid h-full w-full gap-[6px]"
      style={{
        height: previewHeight,
        padding: 6,
        boxSizing: 'border-box',
        gridTemplateColumns: gridColumns,
        gridTemplateRows: gridRows,
      }}
    >
      {entries.map((entry) => {
        const Icon = previewIcon(entry.kind)
        const tone = PREVIEW_TILE_TONE
        const showLabel = entry.kind !== 'image'
        return (
          <div
            key={entry.path}
            data-folder-preview-tile-kind={entry.kind}
            title={entry.name}
            className="relative overflow-hidden rounded-[6px]"
            style={{
              background: tone.background,
            }}
          >
            {entry.kind === 'image' ? (
              <img
                src={toLocalFileUrl(entry.path)}
                alt={entry.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Icon className="h-[16px] w-[16px]" style={{ color: tone.color }} />
              </div>
            )}
            {showLabel && (
              <div
                className="pointer-events-none absolute inset-x-[4px] bottom-[3px] truncate text-[8px]"
                style={{ color: 'var(--rn-ink-2)' }}
              >
                {getFolderPreviewLabel(entry)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
