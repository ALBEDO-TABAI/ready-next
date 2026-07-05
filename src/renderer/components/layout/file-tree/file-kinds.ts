import type { FileItem } from '../../../stores/useWorkspace'
import { EBOOK_EXTENSIONS } from '../../../../shared/ebook'

const ALLOWED_EXTENSIONS = new Set([
  'md', 'txt', 'pdf', 'docx', 'doc', 'rtf', 'odt', 'readyboard',
  'ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'scss', 'less',
  'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h',
  'yaml', 'yml', 'toml', 'xml', 'sql', 'sh', 'bash', 'zsh',
  'vue', 'svelte', 'astro', 'env', 'gitignore',
  'htm', 'svg',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'tiff',
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus',
  'xlsx', 'xls', 'csv', 'tsv',
  ...EBOOK_EXTENSIONS,
  'ini', 'cfg', 'conf', 'properties', 'plist',
  'log', 'lock', 'tldr',
])

export const FILE_TREE_SURFACE_REFRESH_DELAY_MS = 120

const DOCUMENT_EXTS = new Set(['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'html', 'htm', ...EBOOK_EXTENSIONS])
const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'yaml', 'yml', 'toml', 'xml', 'sql', 'sh', 'bash', 'zsh', 'vue', 'svelte', 'astro', 'ini', 'cfg', 'conf', 'properties', 'log'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'tiff', 'svg'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'])
const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])

export type FileKind = 'folder' | 'document' | 'code' | 'image' | 'video' | 'audio' | 'spreadsheet' | 'design' | 'other'
export type FileViewMode = 'tree' | 'grid'
export type FileFilterMap = Record<FileKind, boolean>
export const DEFAULT_FILE_FILTERS: FileFilterMap = {
  folder: true,
  document: true,
  code: true,
  image: true,
  video: true,
  audio: true,
  spreadsheet: true,
  design: true,
  other: true,
}

export interface FileTreeProps {
  query?: string
  filters?: FileFilterMap
  viewMode?: FileViewMode
  thumbnailSize?: number
  gridPath?: string | null
  onGridPathChange?: (path: string | null) => void
  onThumbnailSizeChange?: (size: number) => void
  onResultCountChange?: (count: number) => void
}

export function isFileAllowed(item: FileItem): boolean {
  if (item.isDirectory) return true
  const ext = item.name.split('.').pop()?.toLowerCase()
  if (!ext || ext === item.name.toLowerCase()) return true
  return ALLOWED_EXTENSIONS.has(ext)
}

export function getFileExt(item: FileItem): string {
  const ext = item.name.split('.').pop()?.toLowerCase()
  return ext || ''
}

export function getParentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

export function getFileKind(item: FileItem): FileKind {
  if (item.isDirectory) return 'folder'
  const ext = getFileExt(item)
  if (ext === 'readyboard' || ext === 'tldr') return 'design'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  if (CODE_EXTS.has(ext)) return 'code'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet'
  return 'other'
}

export function passesFilter(item: FileItem, filters: FileFilterMap): boolean {
  return filters[getFileKind(item)] ?? true
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

export function hasMatchingDescendant(
  dirPath: string,
  queryLower: string,
  filters: FileFilterMap,
  dirChildren: Map<string, FileItem[]>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(dirPath)) return false
  visited.add(dirPath)
  const children = dirChildren.get(dirPath) || []
  for (const child of children) {
    if (!isFileAllowed(child) || !passesFilter(child, filters)) continue
    if (child.name.toLowerCase().includes(queryLower)) return true
    if (child.isDirectory && hasMatchingDescendant(child.path, queryLower, filters, dirChildren, visited)) {
      return true
    }
  }
  return false
}

export function getVisibleTreeItems(
  items: FileItem[],
  expandedDirs: Set<string>,
  dirChildren: Map<string, FileItem[]>,
  queryLower: string,
  filters: FileFilterMap,
): FileItem[] {
  const result: FileItem[] = []
  for (const item of items) {
    if (!isFileAllowed(item)) continue
    if (!passesFilter(item, filters)) continue
    if (queryLower && !item.name.toLowerCase().includes(queryLower) && !(
      item.isDirectory && hasMatchingDescendant(item.path, queryLower, filters, dirChildren)
    )) {
      continue
    }
    result.push(item)
    if (item.isDirectory && expandedDirs.has(item.path)) {
      result.push(...getVisibleTreeItems(dirChildren.get(item.path) || [], expandedDirs, dirChildren, queryLower, filters))
    }
  }
  return result
}
