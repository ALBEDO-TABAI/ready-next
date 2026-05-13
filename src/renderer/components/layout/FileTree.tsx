import { useMemo, useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight, ChevronDown, Minus, Plus,
  FileText, Folder, FolderOpen, Image, Film, FileSpreadsheet, Pen, Music2, Globe, BookOpen,
  FilePlus2, FolderPlus, Copy, RefreshCw, Trash2,
} from 'lucide-react'
import { useWorkspace, type FileItem } from '../../stores/useWorkspace'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { toLocalFileUrl } from '../../utils/dragDrop'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { FolderPreview } from './FolderPreview'
import { describeFolderPreview } from './folderPreviewModel'
import {
  buildFloatingMenuItemStyle,
  buildFloatingMenuSurfaceStyle,
} from '../ui/floatingMenuStyles'
import {
  clampDropMenuPositionToBoundary,
  parseBrowserTabDragPayload,
  resolveBrowserTabDropTarget,
  shouldKeepBrowserTabDropHintOnLeave,
  type BrowserTabDragPayload,
  type BrowserTabDropTarget,
} from './fileTreeBrowserTabDrop'
import { getActiveBrowserTabDragPayload } from '../../modules/browser/browserTabDragSession'
import { EBOOK_EXTENSIONS, isEbookExtension } from '../../../shared/ebook'
import './filesPanelFloatingMenu.css'

const ALLOWED_EXTENSIONS = new Set([
  'md', 'txt', 'pdf', 'docx', 'doc', 'rtf', 'odt',
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

interface FileTreeProps {
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

function getFileExt(item: FileItem): string {
  const ext = item.name.split('.').pop()?.toLowerCase()
  return ext || ''
}

function getFileKind(item: FileItem): FileKind {
  if (item.isDirectory) return 'folder'
  const ext = getFileExt(item)
  if (ext === 'tldr') return 'design'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  if (CODE_EXTS.has(ext)) return 'code'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet'
  return 'other'
}

function passesFilter(item: FileItem, filters: FileFilterMap): boolean {
  return filters[getFileKind(item)] ?? true
}

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function fileIcon(item: FileItem, expanded = false) {
  if (item.isDirectory) {
    return expanded
      ? <FolderOpen className="w-[14px] h-[14px]" style={{ color: 'var(--color-gold)' }} />
      : <Folder className="w-[14px] h-[14px]" style={{ color: 'var(--color-gold)' }} />
  }
  const kind = getFileKind(item)
  if (kind === 'image') return <Image className="w-[14px] h-[14px]" style={{ color: 'var(--color-green)' }} />
  if (kind === 'video') return <Film className="w-[14px] h-[14px]" style={{ color: 'var(--color-orange)' }} />
  if (kind === 'audio') return <Music2 className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />
  if (kind === 'spreadsheet') return <FileSpreadsheet className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />
  if (isEbookExtension(getFileExt(item))) return <BookOpen className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />
  if (kind === 'design') return <Pen className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />
  return <FileText className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />
}

interface WorkspaceDragPayload {
  type: 'file' | 'folder'
  path: string
  name: string
  ext?: string
  size?: number
  isDirectory: boolean
  movable: boolean
}

interface RSSDragPayload {
  type: 'rss-item'
  id: string
  name: string
  title?: string
  link: string
  summary?: string
  source?: string
  publishedAt?: string
}

type BrowserTabDropAction = 'web-clip' | 'content-study' | 'copy-analysis' | 'visual-analysis'

interface BrowserTabDropMenuState {
  x: number
  y: number
  payload: BrowserTabDragPayload
  target: BrowserTabDropTarget
}

function putDragData(e: React.DragEvent, item: FileItem, movable = true) {
  const ext = getFileExt(item)
  const payload: WorkspaceDragPayload = {
    type: item.isDirectory ? 'folder' : 'file',
    path: item.path,
    name: item.name,
    ext,
    size: item.size,
    isDirectory: item.isDirectory,
    movable,
  }
  const serialized = JSON.stringify(payload)
  e.dataTransfer.setData('application/x-ready-drag', serialized)
  e.dataTransfer.setData('application/x-ready-file', serialized)
  e.dataTransfer.setData('application/x-ready-workspace-item', serialized)
  e.dataTransfer.setData('text/plain', item.path)
  e.dataTransfer.setData('text/uri-list', `file://${encodeURI(item.path)}`)
  e.dataTransfer.effectAllowed = 'copyMove'
}

function parseWorkspaceDragPayload(dataTransfer: DataTransfer): WorkspaceDragPayload | null {
  const raw = dataTransfer.getData('application/x-ready-workspace-item')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as WorkspaceDragPayload
    if (!parsed.path || !parsed.name) return null
    return parsed
  } catch {
    return null
  }
}

function parseRSSDragPayload(dataTransfer: DataTransfer): RSSDragPayload | null {
  const raw = dataTransfer.getData('application/x-ready-drag')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RSSDragPayload
    if (parsed.type !== 'rss-item') return null
    if (!parsed.id || !parsed.name || !parsed.link) return null
    return parsed
  } catch {
    return null
  }
}

function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const normalized = dir.replace(/[\\/]+$/, '')
  return `${normalized}${separator}${name}`
}

function canMoveToDirectory(source: WorkspaceDragPayload, targetDir: string): boolean {
  if (!targetDir || !source.path) return false
  if (source.movable === false) return false
  if (source.path === targetDir) return false
  const currentParent = source.path.replace(/[\\/][^\\/]+$/, '') || '/'
  if (currentParent === targetDir) return false
  if (source.isDirectory) {
    if (targetDir.startsWith(`${source.path}/`) || targetDir.startsWith(`${source.path}\\`)) {
      return false
    }
  }
  return true
}

function hasMatchingDescendant(
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

function InlineInput({
  defaultValue,
  onConfirm,
  onCancel
}: {
  defaultValue: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    inputRef.current?.focus()
    const dotIdx = defaultValue.lastIndexOf('.')
    inputRef.current?.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length)
  }, [defaultValue])

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim()) onConfirm(value.trim())
        else onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
        if (e.key === 'Escape') onCancel()
        e.stopPropagation()
      }}
      className="w-full px-1 py-0.5 text-[12px] border border-[var(--color-blue)] rounded bg-[var(--bg-primary)] outline-none"
    />
  )
}

function FileTreeItem({
  item,
  isActive,
  isExpanded,
  isRenaming,
  isDropTarget,
  isBrowserDropInside,
  browserDropLine,
  draggableEnabled,
  dragMovable,
  depth,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onDragStart,
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
  draggableEnabled?: boolean
  dragMovable?: boolean
  depth: number
  onToggleDir: () => void
  onOpenFile: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onRenameConfirm: (newName: string) => void
  onRenameCancel: () => void
}) {
  const lineInset = 12 + depth * 22
  const isBrowserDropAccent = isBrowserDropInside || Boolean(browserDropLine)
  const [isHovered, setIsHovered] = useState(false)

  return (
    <div
      draggable={draggableEnabled ?? true}
      onDragStart={(e) => {
        putDragData(e, item, dragMovable ?? true)
        onDragStart?.(e)
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onOpenFile()}
      onContextMenu={onContextMenu}
      className={`
        flex items-center gap-[6px] rounded-[8px] text-[13px] cursor-pointer
        transition-[background-color,box-shadow,outline-color] duration-200 ease-out group
      `}
      style={{
        position: 'relative',
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 22}px`,
        ...(isActive
          ? {
              background: 'rgba(255, 255, 255, 0.36)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.36), 0 1px 2px rgba(15,23,42,0.03)',
            }
          : {}),
        ...(!isActive && !isDropTarget && !isBrowserDropAccent && isHovered
          ? {
              background: 'rgba(255, 255, 255, 0.28)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.24)',
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

      <span className="flex-shrink-0">{fileIcon(item, isExpanded)}</span>

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

function InlineCreateRow({
  type,
  depth,
  onConfirm,
  onCancel,
}: {
  type: 'file' | 'folder'
  depth: number
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  return (
    <div
      className="flex items-center gap-[6px] rounded-[8px]"
      style={{
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 22}px`,
        background: 'var(--bg-hover)',
      }}
    >
      <span className="w-3 flex-shrink-0" />
      <span className="flex-shrink-0">
        {type === 'folder'
          ? <Folder className="w-[14px] h-[14px]" style={{ color: 'var(--color-gold)' }} />
          : <FileText className="w-[14px] h-[14px]" style={{ color: 'var(--color-blue)' }} />}
      </span>
      <div className="flex-1 min-w-0">
        <InlineInput
          defaultValue={type === 'folder' ? '新建文件夹' : '新建文件.md'}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  )
}

function GridItemCard({
  item,
  isActive,
  isDropTarget,
  thumbnailSize,
  folderChildren,
  folderChildrenLoaded,
  dragMovable,
  onOpen,
  onDoubleClick,
  onContextMenu,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  item: FileItem
  isActive: boolean
  isDropTarget: boolean
  thumbnailSize: number
  folderChildren?: FileItem[]
  folderChildrenLoaded?: boolean
  dragMovable?: boolean
  onOpen: () => void
  onDoubleClick?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const kind = getFileKind(item)
  const canPreviewImage = kind === 'image' && !item.isDirectory
  const previewHeight = Math.max(52, Math.round(thumbnailSize * 0.62))
  const folderPreviewLoaded = item.isDirectory ? (folderChildrenLoaded ?? false) : true

  return (
    <button
      draggable
      onDragStart={(e) => {
        putDragData(e, item, dragMovable ?? true)
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onOpen}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className="content-surface-card rounded-[10px] border text-left transition-[background-color,border-color] hover:bg-[var(--bg-hover)]"
      style={{
        padding: '8px 8px 10px',
        borderColor: isDropTarget ? 'var(--color-blue)' : isActive ? 'var(--color-blue)' : 'var(--border-default)',
        background: isDropTarget ? 'var(--color-blue-light)' : isActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
      }}
    >
      <div
        className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-content)] flex items-center justify-center overflow-hidden"
        style={{ height: previewHeight }}
      >
        {item.isDirectory ? (
          <FolderPreview
            childrenItems={folderChildren ?? []}
            previewHeight={previewHeight}
            isLoaded={folderPreviewLoaded}
          />
        ) : canPreviewImage ? (
          <img src={toLocalFileUrl(item.path)} alt={item.name} className="max-h-full max-w-full object-cover" />
        ) : (
          fileIcon(item, false)
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

function FileTreeRecursive({
  items,
  containerPath,
  depth,
  selectedFile,
  expandedDirs,
  dirChildren,
  renamingPath,
  creatingType,
  creatingPath,
  queryLower,
  filters,
  moveDropTargetDir,
  browserTabDropTarget,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onItemDragOver,
  onItemDragLeave,
  onItemDrop,
  onRenameConfirm,
  onRenameCancel,
  onCreateConfirm,
  onCreateCancel,
}: {
  items: FileItem[]
  containerPath: string
  depth: number
  selectedFile: string | null
  expandedDirs: Set<string>
  dirChildren: Map<string, FileItem[]>
  renamingPath: string | null
  creatingType: 'file' | 'folder' | null
  creatingPath: string | null
  queryLower: string
  filters: FileFilterMap
  moveDropTargetDir: string | null
  browserTabDropTarget: BrowserTabDropTarget | null
  onToggleDir: (path: string) => Promise<void>
  onOpenFile: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onItemDragOver: (e: React.DragEvent, item: FileItem, containerPath: string) => void
  onItemDragLeave: (e: React.DragEvent, item: FileItem) => void
  onItemDrop: (e: React.DragEvent, item: FileItem, containerPath: string) => void
  onRenameConfirm: (path: string, newName: string) => void
  onRenameCancel: () => void
  onCreateConfirm: (newName: string) => void
  onCreateCancel: () => void
}) {
  const visibleItems = items.filter((item) => {
    if (!isFileAllowed(item)) return false
    if (!passesFilter(item, filters)) return false
    if (!queryLower) return true
    if (item.name.toLowerCase().includes(queryLower)) return true
    if (item.isDirectory) {
      return hasMatchingDescendant(item.path, queryLower, filters, dirChildren)
    }
    return false
  })

  return (
    <>
      {creatingType && creatingPath === containerPath && (
        <InlineCreateRow
          type={creatingType}
          depth={depth}
          onConfirm={onCreateConfirm}
          onCancel={onCreateCancel}
        />
      )}
      {visibleItems.map((item) => {
        const isExpanded = expandedDirs.has(item.path)
        const children = dirChildren.get(item.path) || []
        const browserDropLine =
          browserTabDropTarget?.kind === 'insert-before' && browserTabDropTarget.anchorPath === item.path
            ? 'before'
            : browserTabDropTarget?.kind === 'insert-after' && browserTabDropTarget.anchorPath === item.path
              ? 'after'
              : null
        return (
          <div key={item.path}>
            <FileTreeItem
              item={item}
              isActive={selectedFile === item.path}
              isExpanded={isExpanded}
              isRenaming={renamingPath === item.path}
              isDropTarget={item.isDirectory && moveDropTargetDir === item.path}
              isBrowserDropInside={
                browserTabDropTarget?.kind === 'inside-directory' && browserTabDropTarget.itemPath === item.path
              }
              browserDropLine={browserDropLine}
              depth={depth}
              onToggleDir={() => onToggleDir(item.path)}
              onOpenFile={() => onOpenFile(item)}
              onContextMenu={(e) => onContextMenu(e, item)}
              onDragOver={(e) => onItemDragOver(e, item, containerPath)}
              onDragLeave={(e) => onItemDragLeave(e, item)}
              onDrop={(e) => onItemDrop(e, item, containerPath)}
              onRenameConfirm={(newName) => onRenameConfirm(item.path, newName)}
              onRenameCancel={onRenameCancel}
            />
            {item.isDirectory && isExpanded && (
              <FileTreeRecursive
                items={children}
                containerPath={item.path}
                depth={depth + 1}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                renamingPath={renamingPath}
                creatingType={creatingType}
                creatingPath={creatingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                browserTabDropTarget={browserTabDropTarget}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                onItemDragOver={onItemDragOver}
                onItemDragLeave={onItemDragLeave}
                onItemDrop={onItemDrop}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
                onCreateConfirm={onCreateConfirm}
                onCreateCancel={onCreateCancel}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export default function FileTree({
  query = '',
  filters = DEFAULT_FILE_FILTERS,
  viewMode = 'tree',
  thumbnailSize = 132,
  gridPath,
  onGridPathChange,
  onThumbnailSizeChange,
  onResultCountChange,
}: FileTreeProps) {
  const {
    files,
    selectedFile,
    expandedDirs,
    dirChildren,
    renamingPath,
    creatingType,
    creatingPath,
    pinnedFolders,
    currentPath,
    toggleDir,
    selectFile,
    renameItem,
    cancelRenaming,
    createFile,
    createFolder,
    cancelCreating,
    openFolderDialog,
    addPinnedFolder,
    moveItem,
    loadDirChildren,
  } = useWorkspace()

  const { setWorkbenchMode } = useMode()

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem | null } | null>(null)
  const [rssDropMenu, setRssDropMenu] = useState<{
    x: number
    y: number
    dirPath: string
    payload: RSSDragPayload
  } | null>(null)
  const [browserTabDropMenu, setBrowserTabDropMenu] = useState<BrowserTabDropMenuState | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [moveDropTargetDir, setMoveDropTargetDir] = useState<string | null>(null)
  const [browserTabDropTarget, setBrowserTabDropTarget] = useState<BrowserTabDropTarget | null>(null)
  const [internalGridPath, setInternalGridPath] = useState<string | null>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const gridPreviewLoadingRef = useRef(new Set<string>())
  const queryLower = query.trim().toLowerCase()
  const effectiveGridPath = gridPath !== undefined ? gridPath : internalGridPath
  const setEffectiveGridPath = onGridPathChange ?? setInternalGridPath

  const shouldPreserveDropHint = useCallback((event: React.DragEvent<HTMLElement>) => {
    const currentTarget = event.currentTarget
    const nextTarget = event.relatedTarget as Node | null
    const rect = currentTarget.getBoundingClientRect()

    return shouldKeepBrowserTabDropHintOnLeave({
      clientX: event.clientX,
      clientY: event.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      relatedTargetInside: Boolean(nextTarget && currentTarget.contains(nextTarget)),
    })
  }, [])

  const filteredCurrentItems = useMemo(() => {
    return files
      .filter(isFileAllowed)
      .filter((item) => passesFilter(item, filters))
      .filter((item) => (queryLower ? item.name.toLowerCase().includes(queryLower) : true))
  }, [files, filters, queryLower])

  useEffect(() => {
    onResultCountChange?.(filteredCurrentItems.length)
  }, [filteredCurrentItems.length, onResultCountChange])

  const handleOpenFile = useCallback((item: FileItem) => {
    if (item.isDirectory) {
      selectFile(item.path)
      if (viewMode === 'tree') {
        void toggleDir(item.path)
      }
      return
    }

    selectFile(item.path)
    const ext = item.name.split('.').pop()?.toLowerCase() || ''
    const modeMap: Record<string, WorkbenchMode> = {
      md: 'document', txt: 'document', json: 'document', ts: 'document', tsx: 'document',
      js: 'document', css: 'document', html: 'document', docx: 'document', xlsx: 'document',
      png: 'document', jpg: 'document', jpeg: 'document', webp: 'document', svg: 'document', gif: 'document',
      bmp: 'document', ico: 'document',
      pdf: 'document',
      epub: 'document', mobi: 'document', azw: 'document', azw3: 'document', fb2: 'document', cbz: 'document',
      tldr: 'document'
    }
    if (modeMap[ext]) {
      setWorkbenchMode(modeMap[ext])
    }
  }, [selectFile, setWorkbenchMode, toggleDir, viewMode])

  const moveWorkspaceItem = useCallback(async (payload: WorkspaceDragPayload, targetDir: string) => {
    if (!canMoveToDirectory(payload, targetDir)) return
    const nextPath = joinPath(targetDir, payload.name)
    if (nextPath === payload.path) return
    await moveItem(payload.path, nextPath)
  }, [moveItem])

  const getBrowserTabPayload = useCallback((dataTransfer: DataTransfer) => {
    const raw = dataTransfer.getData('application/x-ready-drag')
    return parseBrowserTabDragPayload(raw) ?? getActiveBrowserTabDragPayload()
  }, [])

  const handleDirectoryDragOver = useCallback((e: React.DragEvent, dirPath: string) => {
    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, dirPath)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (moveDropTargetDir !== dirPath) setMoveDropTargetDir(dirPath)
      setBrowserTabDropTarget(null)
      return
    }
    const browserTabPayload = getBrowserTabPayload(e.dataTransfer)
    if (browserTabPayload) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setMoveDropTargetDir(null)
      setBrowserTabDropTarget({
        kind: 'inside-directory',
        dirPath,
        itemPath: dirPath,
        containerPath: dirPath,
      })
      return
    }
    const rssPayload = parseRSSDragPayload(e.dataTransfer)
    if (!rssPayload) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setBrowserTabDropTarget(null)
    if (moveDropTargetDir !== dirPath) setMoveDropTargetDir(dirPath)
  }, [getBrowserTabPayload, moveDropTargetDir])

  const handleDirectoryDragLeave = useCallback((e: React.DragEvent, dirPath: string) => {
    e.stopPropagation()
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) {
      return
    }
    if (moveDropTargetDir === dirPath) setMoveDropTargetDir(null)
    if (browserTabDropTarget?.kind === 'inside-directory' && browserTabDropTarget.dirPath === dirPath) {
      setBrowserTabDropTarget(null)
    }
  }, [browserTabDropTarget, moveDropTargetDir, shouldPreserveDropHint])

  const handleDirectoryDrop = useCallback((e: React.DragEvent, dirPath: string) => {
    const browserTabPayload = getBrowserTabPayload(e.dataTransfer)
    if (browserTabPayload) {
      e.preventDefault()
      e.stopPropagation()
      setMoveDropTargetDir(null)
      setBrowserTabDropTarget(null)
      setContextMenu(null)
      setRssDropMenu(null)
      setBrowserTabDropMenu({
        x: e.clientX,
        y: e.clientY,
        payload: browserTabPayload,
        target: {
          kind: 'inside-directory',
          dirPath,
          itemPath: dirPath,
          containerPath: dirPath,
        },
      })
      return
    }

    const rssPayload = parseRSSDragPayload(e.dataTransfer)
    if (rssPayload) {
      e.preventDefault()
      e.stopPropagation()
      setMoveDropTargetDir(null)
      setBrowserTabDropTarget(null)
      setContextMenu(null)
      setRssDropMenu({
        x: e.clientX,
        y: e.clientY,
        dirPath,
        payload: rssPayload,
      })
      return
    }

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (!payload || !canMoveToDirectory(payload, dirPath)) return
    e.preventDefault()
    e.stopPropagation()
    setMoveDropTargetDir(null)
    setBrowserTabDropTarget(null)
    void moveWorkspaceItem(payload, dirPath)
  }, [getBrowserTabPayload, moveWorkspaceItem])

  const handleItemDragOver = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const workspacePayload = parseWorkspaceDragPayload(e.dataTransfer)
    if (item.isDirectory && workspacePayload && canMoveToDirectory(workspacePayload, item.path)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (moveDropTargetDir !== item.path) setMoveDropTargetDir(item.path)
      setBrowserTabDropTarget(null)
      return
    }

    const browserTabPayload = getBrowserTabPayload(e.dataTransfer)
    if (browserTabPayload) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setMoveDropTargetDir(null)
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
      setBrowserTabDropTarget(
        resolveBrowserTabDropTarget({
          itemPath: item.path,
          isDirectory: item.isDirectory,
          containerPath,
          pointerY: e.clientY,
          rectTop: rect.top,
          rectHeight: rect.height,
        }),
      )
      return
    }

    if (item.isDirectory && parseRSSDragPayload(e.dataTransfer)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setBrowserTabDropTarget(null)
      if (moveDropTargetDir !== item.path) setMoveDropTargetDir(item.path)
    }
  }, [getBrowserTabPayload, moveDropTargetDir])

  const handleItemDragLeave = useCallback((e: React.DragEvent, item: FileItem) => {
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) return

    if (moveDropTargetDir === item.path) {
      setMoveDropTargetDir(null)
    }

    if (browserTabDropTarget?.kind === 'inside-directory' && browserTabDropTarget.itemPath === item.path) {
      setBrowserTabDropTarget(null)
      return
    }

    if (
      (browserTabDropTarget?.kind === 'insert-before' || browserTabDropTarget?.kind === 'insert-after') &&
      browserTabDropTarget.anchorPath === item.path
    ) {
      setBrowserTabDropTarget(null)
    }
  }, [browserTabDropTarget, moveDropTargetDir, shouldPreserveDropHint])

  const handleItemDrop = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const browserTabPayload = getBrowserTabPayload(e.dataTransfer)
    if (browserTabPayload) {
      e.preventDefault()
      e.stopPropagation()
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
      const target = resolveBrowserTabDropTarget({
        itemPath: item.path,
        isDirectory: item.isDirectory,
        containerPath,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
      })
      setMoveDropTargetDir(null)
      setBrowserTabDropTarget(null)
      setContextMenu(null)
      setRssDropMenu(null)
      setBrowserTabDropMenu({
        x: e.clientX,
        y: e.clientY,
        payload: browserTabPayload,
        target,
      })
      return
    }

    if (item.isDirectory) {
      handleDirectoryDrop(e, item.path)
    }
  }, [getBrowserTabPayload, handleDirectoryDrop])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      e.dataTransfer.dropEffect = 'move'
      return
    }
    if (parseRSSDragPayload(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      return
    }
    if (getBrowserTabPayload(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      return
    }
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [currentPath, getBrowserTabPayload])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) {
      return
    }
    setIsDragOver(false)
    setMoveDropTargetDir(null)
    setBrowserTabDropTarget(null)
    setRssDropMenu(null)
  }, [shouldPreserveDropHint])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setMoveDropTargetDir(null)
    const lastBrowserTabDropTarget = browserTabDropTarget
    setBrowserTabDropTarget(null)
    setRssDropMenu(null)

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      await moveWorkspaceItem(payload, currentPath)
      return
    }

    if (parseRSSDragPayload(e.dataTransfer)) {
      return
    }

    const browserTabPayload = getBrowserTabPayload(e.dataTransfer)
    if (browserTabPayload && lastBrowserTabDropTarget) {
      setContextMenu(null)
      setRssDropMenu(null)
      setBrowserTabDropMenu({
        x: e.clientX,
        y: e.clientY,
        payload: browserTabPayload,
        target: lastBrowserTabDropTarget,
      })
      return
    }

    const droppedFiles = e.dataTransfer.files
    if (!droppedFiles || droppedFiles.length === 0) return
    if (typeof window !== 'undefined' && window.electronAPI) {
      for (let i = 0; i < droppedFiles.length; i++) {
        const p = window.electronAPI.getFilePathFromDrop(droppedFiles[i])
        if (p) addPinnedFolder(p)
      }
    }
  }, [addPinnedFolder, browserTabDropTarget, currentPath, getBrowserTabPayload, moveWorkspaceItem])

  const handleRssDropAction = useCallback(
    async (action: 'web-clip' | 'copy-analysis' | 'visual-analysis') => {
      if (!rssDropMenu) return
      const { dirPath, payload } = rssDropMenu
      setRssDropMenu(null)

      const itemTitle = rssDropMenu.payload.title || rssDropMenu.payload.name
      if (action === 'web-clip') {
        console.info('[rss-drop-action] web clip placeholder', {
          action,
          dirPath,
          title: itemTitle,
          link: payload.link,
        })
        return
      }

      if (!window.electronAPI?.rss?.startItemAnalysis) {
        console.warn('[rss-drop-action] rss.startItemAnalysis not available')
        return
      }

      const mappedAction = action === 'copy-analysis' ? 'copy' : 'visual'
      try {
        const result = await window.electronAPI.rss.startItemAnalysis({
          itemId: payload.id,
          action: mappedAction,
          link: payload.link,
          title: itemTitle,
          targetDir: dirPath,
          source: payload.source,
          summary: payload.summary,
          publishedAt: payload.publishedAt,
        })
        if (!result.success) {
          console.error('[rss-drop-action] failed', result.error)
          return
        }
        console.info('[rss-drop-action] started', {
          action: mappedAction,
          itemId: payload.id,
          outputDir: result.data?.outputDir,
        })
      } catch (error) {
        console.error('[rss-drop-action] start failed', error)
      }
    },
    [rssDropMenu],
  )

  const handleBrowserTabDropAction = useCallback((action: BrowserTabDropAction) => {
    if (!browserTabDropMenu) return
    const { payload, target } = browserTabDropMenu
    setBrowserTabDropMenu(null)

    const targetLabel = target.kind === 'inside-directory'
      ? `folder:${target.dirPath}`
      : `${target.kind}:${target.anchorPath}`

    console.info('[browser-tab-drop-action] placeholder', {
      type: 'browser-tab',
      action,
      target: targetLabel,
      title: payload.title,
      url: payload.url,
      tabId: payload.tabId,
    })
  }, [browserTabDropMenu])

  const renderTreeContent = () => {
    if (pinnedFolders.length > 0) {
      const visiblePinned = pinnedFolders.filter((folderPath) => {
        const folderName = folderPath.split('/').pop() || folderPath
        if (!filters.folder) return false
        if (!queryLower) return true
        if (folderName.toLowerCase().includes(queryLower)) return true
        return hasMatchingDescendant(folderPath, queryLower, filters, dirChildren)
      })

      if (visiblePinned.length === 0 && !creatingType) {
        return (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-[var(--text-light)]">
            <FileText style={{ width: 28, height: 28 }} className="mb-2 opacity-40" strokeWidth={1.5} />
            <span className="text-[12px] text-[var(--text-muted)]">没有匹配当前筛选的文件</span>
          </div>
        )
      }

      return visiblePinned.map((folderPath) => {
        const folderName = folderPath.split('/').pop() || folderPath
        const isExpanded = expandedDirs.has(folderPath)
        const children = dirChildren.get(folderPath) || []
        const browserDropLine =
          browserTabDropTarget?.kind === 'insert-before' && browserTabDropTarget.anchorPath === folderPath
            ? 'before'
            : browserTabDropTarget?.kind === 'insert-after' && browserTabDropTarget.anchorPath === folderPath
              ? 'after'
              : null
        const pinnedItem: FileItem = {
          name: folderName,
          path: folderPath,
          isDirectory: true,
          size: 0,
          modified: new Date(),
        }
        return (
          <div key={folderPath}>
            <FileTreeItem
              item={pinnedItem}
              isActive={selectedFile === folderPath}
              isExpanded={isExpanded}
              isRenaming={renamingPath === folderPath}
              isDropTarget={moveDropTargetDir === folderPath}
              isBrowserDropInside={
                browserTabDropTarget?.kind === 'inside-directory' && browserTabDropTarget.itemPath === folderPath
              }
              browserDropLine={browserDropLine}
              dragMovable={false}
              depth={0}
              onToggleDir={() => toggleDir(folderPath)}
              onOpenFile={() => handleOpenFile(pinnedItem)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setContextMenu({ x: e.clientX, y: e.clientY, item: pinnedItem })
              }}
              onDragOver={(e) => handleItemDragOver(e, pinnedItem, currentPath)}
              onDragLeave={(e) => handleItemDragLeave(e, pinnedItem)}
              onDrop={(e) => handleItemDrop(e, pinnedItem, currentPath)}
              onRenameConfirm={(newName) => renameItem(folderPath, newName)}
              onRenameCancel={cancelRenaming}
            />
            {isExpanded && (
              <FileTreeRecursive
                items={children}
                containerPath={folderPath}
                depth={1}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                renamingPath={renamingPath}
                creatingType={creatingType}
                creatingPath={creatingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                browserTabDropTarget={browserTabDropTarget}
                onToggleDir={toggleDir}
                onOpenFile={handleOpenFile}
                onContextMenu={(e, item) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                onItemDragOver={handleItemDragOver}
                onItemDragLeave={handleItemDragLeave}
                onItemDrop={handleItemDrop}
                onRenameConfirm={(path, newName) => renameItem(path, newName)}
                onRenameCancel={cancelRenaming}
                onCreateConfirm={(newName) => {
                  if (creatingType === 'folder') void createFolder(newName)
                  else if (creatingType === 'file') void createFile(newName)
                }}
                onCreateCancel={cancelCreating}
              />
            )}
          </div>
        )
      })
    }

    if (filteredCurrentItems.length === 0 && !creatingType) {
      return (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-[var(--text-light)]">
          <FolderOpen style={{ width: 32, height: 32 }} className="mb-3 opacity-40" strokeWidth={1.5} />
          <span style={{ fontSize: 15, fontWeight: 600 }} className="text-[var(--text-muted)] mb-1">还没有打开的文件夹</span>
          <span style={{ fontSize: 13 }} className="text-[var(--text-light)] mb-4 text-center">拖入文件夹或点击下方按钮打开</span>
          <button
            onClick={openFolderDialog}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-[13px] font-medium active:scale-[0.98] transition-[filter,transform] duration-200 ease-out"
            style={{ background: 'var(--color-blue)' }}
          >
            <FolderOpen style={{ width: 14, height: 14 }} strokeWidth={2} />
            打开文件夹
          </button>
        </div>
      )
    }

    return (
      <FileTreeRecursive
        items={filteredCurrentItems}
        containerPath={currentPath}
        depth={0}
        selectedFile={selectedFile}
        expandedDirs={expandedDirs}
        dirChildren={dirChildren}
        renamingPath={renamingPath}
        creatingType={creatingType}
        creatingPath={creatingPath}
        queryLower={queryLower}
        filters={filters}
        moveDropTargetDir={moveDropTargetDir}
        browserTabDropTarget={browserTabDropTarget}
        onToggleDir={toggleDir}
        onOpenFile={handleOpenFile}
        onContextMenu={(e, item) => {
          e.preventDefault()
          e.stopPropagation()
          setContextMenu({ x: e.clientX, y: e.clientY, item })
        }}
        onItemDragOver={handleItemDragOver}
        onItemDragLeave={handleItemDragLeave}
        onItemDrop={handleItemDrop}
        onRenameConfirm={(path, newName) => renameItem(path, newName)}
        onRenameCancel={cancelRenaming}
        onCreateConfirm={(newName) => {
          if (creatingType === 'folder') void createFolder(newName)
          else if (creatingType === 'file') void createFile(newName)
        }}
        onCreateCancel={cancelCreating}
      />
    )
  }

  // Collect items for grid view based on gridPath navigation
  const gridItems = useMemo(() => {
    // If user has navigated into a subdirectory via grid
    if (effectiveGridPath) {
      const children = dirChildren.get(effectiveGridPath) || []
      return children
        .filter(isFileAllowed)
        .filter((item) => passesFilter(item, filters))
        .filter((item) => (queryLower ? item.name.toLowerCase().includes(queryLower) : true))
    }
    // Top level: show pinned folders or current dir files
    if (pinnedFolders.length > 0) {
      const result: FileItem[] = []
      for (const folderPath of pinnedFolders) {
        const folderName = folderPath.split('/').pop() || folderPath
        if (!filters.folder) continue
        if (queryLower && !folderName.toLowerCase().includes(queryLower) && !hasMatchingDescendant(folderPath, queryLower, filters, dirChildren)) continue
        result.push({ name: folderName, path: folderPath, isDirectory: true, size: 0, modified: new Date() })
      }
      return result.length > 0 ? result : filteredCurrentItems
    }
    return filteredCurrentItems
  }, [effectiveGridPath, pinnedFolders, filteredCurrentItems, filters, queryLower, dirChildren])

  const gridNavigateInto = useCallback(async (dirPath: string) => {
    // Ensure children are loaded
    if (!dirChildren.has(dirPath)) {
      await loadDirChildren(dirPath)
    }
    setEffectiveGridPath(dirPath)
  }, [dirChildren, loadDirChildren, setEffectiveGridPath])

  const gridDisplayPath = useMemo(() => {
    if (!effectiveGridPath) return null
    return effectiveGridPath.split('/').pop() || effectiveGridPath
  }, [effectiveGridPath])
  const gridContainerPath = effectiveGridPath ?? currentPath
  const gridFolderPreviewKey = useMemo(
    () => gridItems.filter((item) => item.isDirectory).map((item) => item.path).join('\u0000'),
    [gridItems],
  )

  useEffect(() => {
    if (viewMode !== 'grid') return

    const previewPaths = gridFolderPreviewKey ? gridFolderPreviewKey.split('\u0000') : []
    const missingPaths = previewPaths
      .filter((dirPath) => dirPath && !dirChildren.has(dirPath) && !gridPreviewLoadingRef.current.has(dirPath))
      .slice(0, 18)

    if (missingPaths.length === 0) return

    let cancelled = false

    const hydrateFolderPreviews = async () => {
      for (const dirPath of missingPaths) {
        if (cancelled) break
        gridPreviewLoadingRef.current.add(dirPath)
        try {
          await loadDirChildren(dirPath)
        } finally {
          gridPreviewLoadingRef.current.delete(dirPath)
        }
      }
    }

    void hydrateFolderPreviews()

    return () => {
      cancelled = true
    }
  }, [dirChildren, gridFolderPreviewKey, loadDirChildren, viewMode])

  const renderGridContent = () => {
    if (gridItems.length === 0 && !creatingType) {
      return (
        <div className="flex flex-col items-center justify-center py-10 px-4 text-[var(--text-light)]">
          <Image style={{ width: 30, height: 30 }} className="mb-2 opacity-40" strokeWidth={1.5} />
          <span className="text-[12px] text-[var(--text-muted)]">当前目录没有匹配文件</span>
        </div>
      )
    }

    return (
      <>
        {/* Grid navigation bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minHeight: 24 }}>
          {gridDisplayPath && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={effectiveGridPath || ''}>
              {gridDisplayPath}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {/* Thumbnail size controls */}
          {onThumbnailSizeChange && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => onThumbnailSizeChange(Math.max(80, thumbnailSize - 20))}
                title="缩小缩略图"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 4,
                  color: 'var(--text-placeholder)', cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                <Minus style={{ width: 11, height: 11 }} />
              </button>
              <div
                style={{
                  position: 'relative', width: 56, height: 6, borderRadius: 3,
                  background: 'var(--bg-hover)',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)',
                  cursor: 'pointer',
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  const track = e.currentTarget
                  const update = (clientX: number) => {
                    const rect = track.getBoundingClientRect()
                    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
                    onThumbnailSizeChange(Math.round(80 + ratio * 140))
                  }
                  update(e.clientX)
                  const onMove = (ev: MouseEvent) => update(ev.clientX)
                  const onUp = () => {
                    window.removeEventListener('mousemove', onMove)
                    window.removeEventListener('mouseup', onUp)
                  }
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                }}
              >
                <div
                  style={{
                    position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 3,
                    width: `${((thumbnailSize - 80) / 140) * 100}%`,
                    background: 'var(--text-light)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute', top: '50%',
                    left: `${((thumbnailSize - 80) / 140) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 10, height: 10, borderRadius: '50%',
                    background: 'var(--bg-primary)',
                    boxShadow: 'var(--shadow-sm)',
                    border: '1px solid var(--border-default)',
                  }}
                />
              </div>
              <button
                onClick={() => onThumbnailSizeChange(Math.min(220, thumbnailSize + 20))}
                title="放大缩略图"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 4,
                  color: 'var(--text-placeholder)', cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                <Plus style={{ width: 11, height: 11 }} />
              </button>
            </div>
          )}
        </div>

        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))` }}
        >
          {creatingType && creatingPath === gridContainerPath && (
            <div
              className="content-surface-card rounded-[10px] border"
              style={{
                padding: '8px 8px 10px',
                borderColor: 'var(--color-blue)',
                background: 'var(--color-blue-light)',
              }}
            >
              <div
                className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-content)] flex items-center justify-center"
                style={{ height: Math.max(52, Math.round(thumbnailSize * 0.62)) }}
              >
                {creatingType === 'folder'
                  ? <Folder className="w-[16px] h-[16px]" style={{ color: 'var(--color-gold)' }} />
                  : <FileText className="w-[16px] h-[16px]" style={{ color: 'var(--color-blue)' }} />}
              </div>
              <div className="mt-2 px-1">
                <InlineInput
                  defaultValue={creatingType === 'folder' ? '新建文件夹' : '新建文件.md'}
                  onConfirm={(newName) => {
                    if (creatingType === 'folder') void createFolder(newName)
                    else void createFile(newName)
                  }}
                  onCancel={cancelCreating}
                />
              </div>
            </div>
          )}
          {gridItems.map((item) => (
            <GridItemCard
              key={item.path}
              item={item}
              isActive={selectedFile === item.path}
              isDropTarget={
                item.isDirectory &&
                (
                  moveDropTargetDir === item.path ||
                  (browserTabDropTarget?.kind === 'inside-directory' && browserTabDropTarget.itemPath === item.path)
                )
              }
              thumbnailSize={thumbnailSize}
              folderChildren={item.isDirectory ? dirChildren.get(item.path) : undefined}
              folderChildrenLoaded={item.isDirectory ? dirChildren.has(item.path) : true}
              dragMovable={!pinnedFolders.includes(item.path)}
              onOpen={() => {
                if (item.isDirectory) {
                  handleOpenFile(item)
                } else {
                  handleOpenFile(item)
                }
              }}
              onDoubleClick={item.isDirectory ? () => { void gridNavigateInto(item.path) } : undefined}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setContextMenu({ x: e.clientX, y: e.clientY, item })
              }}
              onDragOver={(e) => item.isDirectory && handleDirectoryDragOver(e, item.path)}
              onDragLeave={(e) => item.isDirectory && handleDirectoryDragLeave(e, item.path)}
              onDrop={(e) => item.isDirectory && handleDirectoryDrop(e, item.path)}
            />
          ))}
        </div>
      </>
    )
  }

  return (
    <div
      ref={treeRootRef}
      className="panel-hover-scrollbar flex-1 overflow-auto relative"
      style={{ padding: '6px 8px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-blue-light)] border-2 border-dashed border-[var(--color-blue)] rounded-lg m-1 pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <FolderOpen className="w-6 h-6 text-[var(--color-blue)]" />
            <span className="text-[12px] font-medium text-[var(--color-blue)]">拖放文件到这里</span>
          </div>
        </div>
      )}

      {viewMode === 'grid' ? renderGridContent() : renderTreeContent()}

      {contextMenu && (
        <ContextMenuBridge
          contextMenu={contextMenu}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
        />
      )}

      {browserTabDropMenu && (
        <BrowserTabDropActionMenu
          menu={browserTabDropMenu}
          boundaryRect={treeRootRef.current?.getBoundingClientRect() ?? null}
          onAction={handleBrowserTabDropAction}
          onClose={() => setBrowserTabDropMenu(null)}
        />
      )}

      {rssDropMenu && (
        <ContextMenu
          items={[
            {
              id: 'rss-web-clip',
              label: '网页剪藏',
              onClick: () => handleRssDropAction('web-clip'),
            },
            {
              id: 'rss-copy-analysis',
              label: '文案分析',
              onClick: () => handleRssDropAction('copy-analysis'),
            },
            {
              id: 'rss-visual-analysis',
              label: '视觉分析',
              onClick: () => handleRssDropAction('visual-analysis'),
            },
          ]}
          x={rssDropMenu.x}
          y={rssDropMenu.y}
          onClose={() => setRssDropMenu(null)}
        />
      )}
    </div>
  )
}

function BrowserTabDropActionMenu({
  menu,
  boundaryRect,
  onAction,
  onClose,
}: {
  menu: BrowserTabDropMenuState
  boundaryRect: DOMRect | null
  onAction: (action: BrowserTabDropAction) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y })
  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const surfaceStyle = useMemo(
    () => buildFloatingMenuSurfaceStyle(208, {
      padding: 6,
      zIndex: 260,
    }),
    [],
  )
  const actionItems = useMemo(() => ([
    {
      id: 'web-clip' as const,
      label: '网页剪藏',
      icon: <Globe style={{ width: 15, height: 15 }} />,
    },
    {
      id: 'content-study' as const,
      label: '内容学习',
      icon: <BookOpen style={{ width: 15, height: 15 }} />,
    },
    {
      id: 'copy-analysis' as const,
      label: '文案分析',
      icon: <FileText style={{ width: 15, height: 15 }} />,
    },
    {
      id: 'visual-analysis' as const,
      label: '视觉分析',
      icon: <Image style={{ width: 15, height: 15 }} />,
    },
  ]), [])

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (!boundaryRect) {
      const maxX = Math.max(8, window.innerWidth - rect.width - 8)
      const maxY = Math.max(8, window.innerHeight - rect.height - 8)
      setAdjustedPos({
        x: Math.max(8, Math.min(menu.x, maxX)),
        y: Math.max(8, Math.min(menu.y, maxY)),
      })
      return
    }
    setAdjustedPos(
      clampDropMenuPositionToBoundary({
        x: menu.x,
        y: menu.y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        boundaryLeft: boundaryRect.left,
        boundaryTop: boundaryRect.top,
        boundaryRight: boundaryRect.right,
        boundaryBottom: boundaryRect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    )
  }, [actionItems.length, boundaryRect, menu.x, menu.y])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', handleClick)
      window.addEventListener('contextmenu', handleClick)
    }, 0)
    window.addEventListener('keydown', handleKey)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('contextmenu', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const content = (
    <div
      ref={menuRef}
      className="glass-surface-floating ready-floating-menu"
      style={{
        ...surfaceStyle,
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
      }}
    >
      {actionItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ready-floating-menu-item"
          style={{
            ...buildFloatingMenuItemStyle({ compact: true }),
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 38,
          }}
          onClick={() => onAction(item.id)}
        >
          <span
            style={{
              width: 16,
              height: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-body)',
              flexShrink: 0,
            }}
          >
            {item.icon}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-title)',
              lineHeight: 1.2,
            }}
          >
            {item.label}
          </span>
        </button>
      ))}
    </div>
  )

  return portalRoot ? createPortal(content, portalRoot) : content
}

function ContextMenuBridge({
  contextMenu,
  onClose,
  onOpenFile
}: {
  contextMenu: { x: number; y: number; item: FileItem | null }
  onClose: () => void
  onOpenFile: (item: FileItem) => void
}) {
  const {
    startRenaming,
    copyPathToClipboard,
    startCreating,
    showInFolder,
    deleteItem,
    refreshFiles,
  } = useWorkspace()

  const getContextItems = useCallback((item: FileItem | null): ContextMenuItem[] => {
    if (!item) {
      return [
        {
          id: 'newFile',
          label: '新建文件',
          icon: <FilePlus2 style={{ width: 16, height: 16 }} />,
          onClick: () => startCreating('file')
        },
        {
          id: 'newFolder',
          label: '新建文件夹',
          icon: <FolderPlus style={{ width: 16, height: 16 }} />,
          onClick: () => startCreating('folder')
        },
        { id: 'sep1', label: '', separator: true },
        {
          id: 'refresh',
          label: '刷新',
          icon: <RefreshCw style={{ width: 16, height: 16 }} />,
          onClick: () => void refreshFiles()
        }
      ]
    }
    return [
      ...(item.isDirectory ? [] : [
        {
          id: 'open',
          label: '打开',
          icon: <FileText style={{ width: 16, height: 16 }} />,
          onClick: () => onOpenFile(item)
        }
      ]),
      { id: 'sep1', label: '', separator: true },
      {
        id: 'rename',
        label: '重命名',
        shortcut: 'Enter',
        icon: <Pen style={{ width: 16, height: 16 }} />,
        onClick: () => startRenaming(item.path)
      },
      {
        id: 'copyPath',
        label: '复制路径',
        shortcut: '⌥⌘C',
        icon: <Copy style={{ width: 16, height: 16 }} />,
        onClick: () => copyPathToClipboard(item.path)
      },
      { id: 'sep2', label: '', separator: true },
      {
        id: 'newFile',
        label: '新建文件',
        icon: <FilePlus2 style={{ width: 16, height: 16 }} />,
        onClick: () => startCreating('file')
      },
      {
        id: 'newFolder',
        label: '新建文件夹',
        icon: <FolderPlus style={{ width: 16, height: 16 }} />,
        onClick: () => startCreating('folder')
      },
      { id: 'sep3', label: '', separator: true },
      {
        id: 'showInFinder',
        label: '在 Finder 中显示',
        icon: <FolderOpen style={{ width: 16, height: 16 }} />,
        onClick: () => void showInFolder(item.path)
      },
      { id: 'sep4', label: '', separator: true },
      {
        id: 'delete',
        label: '删除',
        icon: <Trash2 style={{ width: 16, height: 16 }} />,
        danger: true,
        onClick: () => {
          if (confirm(`确定删除 "${item.name}" 吗？`)) {
            void deleteItem(item.path)
          }
        }
      }
    ]
  }, [onOpenFile, startRenaming, copyPathToClipboard, startCreating, showInFolder, deleteItem, refreshFiles])

  return (
    <ContextMenu
      items={getContextItems(contextMenu.item)}
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
    />
  )
}
