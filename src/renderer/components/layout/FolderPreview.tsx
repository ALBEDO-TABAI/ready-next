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

function previewTileTone(kind: FolderPreviewKind): { background: string; color: string } {
  if (kind === 'folder') return { background: 'rgba(221, 171, 78, 0.14)', color: 'var(--color-gold)' }
  if (kind === 'image') return { background: 'rgba(76, 175, 80, 0.12)', color: 'var(--color-green)' }
  if (kind === 'video') return { background: 'rgba(255, 152, 0, 0.12)', color: 'var(--color-orange)' }
  if (kind === 'audio') return { background: 'rgba(59, 130, 246, 0.12)', color: 'var(--color-blue)' }
  if (kind === 'spreadsheet') return { background: 'rgba(59, 130, 246, 0.12)', color: 'var(--color-blue)' }
  if (kind === 'design') return { background: 'rgba(123, 97, 255, 0.12)', color: 'var(--color-blue)' }
  return { background: 'rgba(0, 0, 0, 0.035)', color: 'var(--text-muted)' }
}

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
            style={{ background: 'rgba(0, 0, 0, 0.03)' }}
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
        className="h-full w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-content)] flex flex-col items-center justify-center gap-[4px]"
        style={{ height: previewHeight }}
      >
        <Folder className="h-[16px] w-[16px]" style={{ color: 'var(--color-gold)' }} />
        <span className="text-[9px]" style={{ color: 'var(--text-light)' }}>空文件夹</span>
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
          const tone = previewTileTone(entry.kind)
          return (
            <div
              key={entry.path}
              data-folder-preview-tile-kind={entry.kind}
              title={entry.name}
              className="flex items-center justify-center rounded-[8px] px-[8px] py-[6px] text-[9px] font-medium text-center"
              style={{
                background: tone.background,
                color: entry.kind === 'folder' ? 'color-mix(in srgb, var(--color-gold) 80%, #6b7280 20%)' : 'var(--text-muted)',
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
        const tone = previewTileTone(entry.kind)
        const showLabel = entry.kind !== 'image'
        return (
          <div
            key={entry.path}
            data-folder-preview-tile-kind={entry.kind}
            title={entry.name}
            className="relative overflow-hidden rounded-[6px]"
            style={{
              background: entry.kind === 'image' ? 'var(--bg-content)' : tone.background,
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
                style={{ color: 'var(--text-muted)' }}
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
