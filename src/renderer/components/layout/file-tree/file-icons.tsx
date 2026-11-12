import {
  BookOpen,
  FileSpreadsheet,
  FileText,
  Folder,
  Film,
  Music2,
  Pencil as Pen,
  Image,
} from 'lucide-react'
import type { FileItem } from '../../../stores/useWorkspace'
import {
  getFileAppearanceColorValue,
  type FileAppearance,
} from '../../../stores/fileAppearance'
import { isEbookExtension } from '../../../../shared/ebook'
import { getFileExt, getFileKind } from './file-kinds'
// The colours people give their files are content colours (stores/fileAppearance.ts); load their palette
// wherever the tree draws them, independent of whether the document module has been opened.
import '../../../modules/document/content-palette.css'

export function FileAppearanceColorDot({
  appearance,
  size = 7,
  style,
}: {
  appearance?: FileAppearance
  size?: number
  style?: React.CSSProperties
}) {
  const color = getFileAppearanceColorValue(appearance?.color)
  if (!color) return null
  return (
    <span
      aria-hidden
      style={{
        display: 'block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        border: '1px solid var(--rn-sheet)',
        ...style,
      }}
    />
  )
}

export function CustomFileIcon({ icon, size }: { icon: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(11, Math.round(size * 0.9)),
        lineHeight: 1,
        color: 'inherit',
      }}
    >
      {icon}
    </span>
  )
}

export function fileIcon(item: FileItem, _expanded = false, appearance?: FileAppearance, iconSize = 14) {
  const customIcon = appearance?.icon
  if (customIcon) return <CustomFileIcon icon={customIcon} size={iconSize} />

  // 文件夹始终用 Folder。展开/折叠状态已由 chevron 表达，避免 Folder ↔ FolderOpen
  // 在小尺寸（14px）下因笔触差异让顶层与子层视觉不一致。
  // The icon takes its row's colour, like ListRow: ink-2 at rest, the accent text on the current row (W1 DL8).
  const iconStyle = { color: 'currentColor', width: iconSize, height: iconSize }
  const iconStroke = 1.5
  if (item.isDirectory) {
    return <Folder style={iconStyle} strokeWidth={iconStroke} />
  }
  const kind = getFileKind(item)
  if (kind === 'image') return <Image style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'video') return <Film style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'audio') return <Music2 style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'spreadsheet') return <FileSpreadsheet style={iconStyle} strokeWidth={iconStroke} />
  if (isEbookExtension(getFileExt(item))) return <BookOpen style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'design') return <Pen style={iconStyle} strokeWidth={iconStroke} />
  return <FileText style={iconStyle} strokeWidth={iconStroke} />
}
