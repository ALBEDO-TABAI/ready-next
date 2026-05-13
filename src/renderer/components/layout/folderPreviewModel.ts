import { EBOOK_EXTENSIONS } from '../../../shared/ebook'

export interface FolderPreviewItemLike {
  name: string
  path: string
  isDirectory: boolean
}

export type FolderPreviewKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'spreadsheet'
  | 'design'
  | 'document'
  | 'other'

export interface FolderPreviewEntry extends FolderPreviewItemLike {
  kind: FolderPreviewKind
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'])
const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])
const DOCUMENT_EXTS = new Set(['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'html', 'htm', ...EBOOK_EXTENSIONS])
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less',
  'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h',
  'yaml', 'yml', 'toml', 'xml', 'sql', 'sh', 'bash', 'zsh',
  'vue', 'svelte', 'astro', 'ini', 'cfg', 'conf', 'properties',
  'log', 'lock', 'env', 'gitignore',
])
const OTHER_ALLOWED_EXTS = new Set(['tldr'])

const PREVIEW_LIMIT = 4

const PREVIEW_PRIORITY: Record<FolderPreviewKind, number> = {
  image: 0,
  video: 1,
  document: 2,
  spreadsheet: 3,
  design: 4,
  audio: 5,
  folder: 6,
  other: 7,
}

function getFileExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext || ''
}

function isSupportedPreviewItem(item: FolderPreviewItemLike): boolean {
  if (!item.name || item.name.startsWith('.')) return false
  if (item.isDirectory) return true

  const ext = getFileExt(item.name)
  if (!ext || ext === item.name.toLowerCase()) return true

  return (
    IMAGE_EXTS.has(ext)
    || VIDEO_EXTS.has(ext)
    || AUDIO_EXTS.has(ext)
    || SPREADSHEET_EXTS.has(ext)
    || DOCUMENT_EXTS.has(ext)
    || CODE_EXTS.has(ext)
    || OTHER_ALLOWED_EXTS.has(ext)
  )
}

function getPreviewKind(item: FolderPreviewItemLike): FolderPreviewKind {
  if (item.isDirectory) return 'folder'

  const ext = getFileExt(item.name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet'
  if (ext === 'tldr') return 'design'
  if (DOCUMENT_EXTS.has(ext) || CODE_EXTS.has(ext) || !ext || ext === item.name.toLowerCase()) return 'document'
  return 'other'
}

export function getFolderPreviewLabel(item: FolderPreviewItemLike): string {
  if (item.isDirectory) return item.name
  const dotIdx = item.name.lastIndexOf('.')
  return dotIdx > 0 ? item.name.slice(0, dotIdx) : item.name
}

export function selectFolderPreviewItems(
  childrenItems: FolderPreviewItemLike[],
  limit = PREVIEW_LIMIT,
): FolderPreviewEntry[] {
  return childrenItems
    .filter(isSupportedPreviewItem)
    .map((item) => ({
      ...item,
      kind: getPreviewKind(item),
    }))
    .sort((a, b) => {
      const priorityDelta = PREVIEW_PRIORITY[a.kind] - PREVIEW_PRIORITY[b.kind]
      if (priorityDelta !== 0) return priorityDelta
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    .slice(0, Math.max(1, limit))
}

export function describeFolderPreview(
  childrenItems: FolderPreviewItemLike[],
  options: { isLoaded?: boolean } = {},
): string {
  if (options.isLoaded === false) return '读取内容中'

  const visibleCount = childrenItems.filter(isSupportedPreviewItem).length
  if (visibleCount === 0) return '空文件夹'
  return `${visibleCount} 项内容`
}
