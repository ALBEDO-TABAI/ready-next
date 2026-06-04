import { useMemo, useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight, ChevronDown, Minus, Plus,
  FileText, Folder, FolderOpen, Image, Film, FileSpreadsheet, Pen, Music2, Globe, BookOpen,
  FilePlus2, FolderPlus, Copy, RefreshCw, Trash2, Loader2, AlertTriangle, Check, ListMinus,
  AtSign,
} from 'lucide-react'
import Modal from '../ui/Modal'
import { useWorkspace, type FileItem } from '../../stores/useWorkspace'
import { addReadyContextReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import { useDocTabs } from '../../stores/useDocTabs'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { toLocalFileUrl } from '../../utils/dragDrop'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import type { NativeContextMenuItem } from '../../../shared/native-context-menu'
import { FolderPreview } from './FolderPreview'
import { describeFolderPreview } from './folderPreviewModel'
import {
  buildFloatingMenuItemStyle,
  buildFloatingMenuSurfaceStyle,
} from '../ui/floatingMenuStyles'
import {
  clampDropMenuPositionToBoundary,
  dispatchFileTreeExternalDropAction,
  getActiveRssItemDragPayload,
  isLikelyVideoDropPayload,
  parseBrowserTabDragPayload,
  parseRssItemDragPayload,
  parseWebDownloadDragPayload,
  resolveFileTreeDropTarget,
  shouldKeepFileTreeDropHintOnLeave,
  type FileTreeDropTarget,
  type FileTreeAnalysisPlaceholderStatus,
  type FileTreeExternalDropAction,
  type FileTreeExternalDropPayload,
  type WebDownloadDragPayload,
} from './fileTreeExternalDrop'
import { getActiveBrowserTabDragPayload } from '../../modules/browser/browserTabDragSession'
import { EBOOK_EXTENSIONS, isEbookExtension } from '../../../shared/ebook'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../../modules/browser/localHtmlFileOpen'
import { requestWorkbenchModeChange } from '../../modules/workbench/mode-transition'
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

const FILE_TREE_SURFACE_REFRESH_DELAY_MS = 120

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

function fileIcon(item: FileItem, _expanded = false) {
  // 文件夹始终用 Folder。展开/折叠状态已由 chevron 表达，避免 Folder ↔ FolderOpen
  // 在小尺寸（14px）下因笔触差异让顶层与子层视觉不一致。
  const iconStyle = { color: 'var(--text-muted)' }
  const iconStroke = 1.75
  if (item.isDirectory) {
    return <Folder className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  }
  const kind = getFileKind(item)
  if (kind === 'image') return <Image className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'video') return <Film className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'audio') return <Music2 className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'spreadsheet') return <FileSpreadsheet className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  if (isEbookExtension(getFileExt(item))) return <BookOpen className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  if (kind === 'design') return <Pen className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
  return <FileText className="w-[14px] h-[14px]" style={iconStyle} strokeWidth={iconStroke} />
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

interface FileTreeExternalDropMenuState {
  x: number
  y: number
  payload: FileTreeExternalDropPayload
  target: FileTreeDropTarget
}

interface PutDragDataOptions {
  useNativeFileDrag?: boolean
  onNativeFileDragStart?: (payload: WorkspaceDragPayload) => void
}

function hasNativeFileDrop(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files')
}

function hasRememberedNativeFileDrag(
  payload: WorkspaceDragPayload | null,
  targetDir: string,
): payload is WorkspaceDragPayload {
  return Boolean(payload && canMoveToDirectory(payload, targetDir))
}

function putDragData(e: React.DragEvent, item: FileItem, movable = true, options: PutDragDataOptions = {}) {
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
  if (options.useNativeFileDrag && !item.isDirectory && window.electronAPI?.startNativeFileDrag) {
    e.preventDefault()
    options.onNativeFileDragStart?.(payload)
    window.electronAPI.startNativeFileDrag([item.path])
    return
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

function getTargetDirFromDropTarget(target: FileTreeDropTarget): string {
  return target.kind === 'inside-directory' ? target.dirPath : target.containerPath
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
  isFlashing,
  draggableEnabled,
  dragMovable,
  depth,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onNativeFileDragStart,
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
  depth: number
  onToggleDir: () => void
  onOpenFile: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onNativeFileDragStart?: (payload: WorkspaceDragPayload) => void
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
        onDragStart?.(e)
        putDragData(e, item, dragMovable ?? true, {
          useNativeFileDrag: true,
          onNativeFileDragStart,
        })
      }}
      onDragEnd={onDragEnd}
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
        ${isFlashing ? 'file-tree-item-flash-complete' : ''}
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
          ? <Folder className="w-[14px] h-[14px]" style={{ color: 'var(--text-muted)' }} />
          : <FileText className="w-[14px] h-[14px]" style={{ color: 'var(--text-muted)' }} />}
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
  browserDropLine,
  thumbnailSize,
  folderChildren,
  folderChildrenLoaded,
  dragMovable,
  onOpen,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onNativeFileDragStart,
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
  onOpen: () => void
  onDoubleClick?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onNativeFileDragStart?: (payload: WorkspaceDragPayload) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const kind = getFileKind(item)
  const canPreviewImage = kind === 'image' && !item.isDirectory
  const previewHeight = Math.max(52, Math.round(thumbnailSize * 0.62))
  const folderPreviewLoaded = item.isDirectory ? (folderChildrenLoaded ?? false) : true
  const isDropAccent = isDropTarget || Boolean(browserDropLine)

  return (
    <button
      draggable
      onDragStart={(e) => {
        onDragStart?.(e)
        putDragData(e, item, dragMovable ?? true, {
          useNativeFileDrag: true,
          onNativeFileDragStart,
        })
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onOpen}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className="content-surface-card rounded-[10px] border text-left transition-[background-color,border-color] hover:bg-[var(--bg-hover)]"
      style={{
        position: 'relative',
        padding: '8px 8px 10px',
        borderColor: isDropAccent ? 'var(--color-blue)' : isActive ? 'var(--color-blue)' : 'var(--border-default)',
        background: isDropTarget ? 'var(--color-blue-light)' : isActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
      }}
    >
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

/**
 * Non-selectable background-task placeholder row. Web clip / content study
 * remove themselves when the real file appears; RSS analysis rows follow the
 * persisted job progress until success or failure.
 */
type PendingPlaceholderKind = 'clip' | 'study' | 'analysis-copy' | 'analysis-visual' | 'download'
type PendingPlaceholderStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_for_clip'
  | 'skipped'
  | FileTreeAnalysisPlaceholderStatus

function isAnalysisPlaceholderKind(kind?: PendingPlaceholderKind): boolean {
  return kind === 'analysis-copy' || kind === 'analysis-visual'
}

function isActiveAnalysisStatus(status: PendingPlaceholderStatus): boolean {
  return status === 'queued' || status === 'running_script' || status === 'running_subagent'
}

function clampProgress(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

function pendingPlaceholderLabel(kind: PendingPlaceholderKind, status: PendingPlaceholderStatus): string {
  if (kind === 'download') {
    if (status === 'running') return '正在下载'
    if (status === 'completed' || status === 'success') return '已下载'
    if (status === 'skipped') return '已跳过'
    return '下载失败'
  }

  if (kind === 'study') {
    if (status === 'waiting_for_clip') return '等待剪藏'
    if (status === 'running') return '生成学习笔记'
    if (status === 'completed' || status === 'success') return '已生成笔记'
    if (status === 'skipped') return '已跳过'
    return '笔记失败'
  }

  if (kind === 'analysis-copy' || kind === 'analysis-visual') {
    const subject = kind === 'analysis-copy' ? '文案' : '视觉'
    if (status === 'queued') return `${subject}排队`
    if (status === 'paused') return `${subject}暂停`
    if (status === 'running_script') return kind === 'analysis-copy' ? '提取文案' : '分析画面'
    if (status === 'running_subagent') return '生成报告'
    if (status === 'success' || status === 'completed') return `${subject}完成`
    if (status === 'skipped') return '已跳过'
    return `${subject}失败`
  }

  if (status === 'running') return '正在剪藏'
  if (status === 'completed' || status === 'success') return '已剪藏'
  if (status === 'waiting_for_clip' || status === 'queued') return '等待中'
  if (status === 'skipped') return '已跳过'
  return '剪藏失败'
}

function PendingClipRow({
  status,
  urlHost,
  title,
  errorMessage,
  message,
  progress,
  depth,
  kind = 'clip',
}: {
  status: PendingPlaceholderStatus
  urlHost: string
  title: string
  errorMessage?: string
  message?: string | null
  progress?: number
  depth: number
  kind?: PendingPlaceholderKind
}) {
  const isFailure = status === 'failed' || status === 'skipped'
  const isComplete = status === 'completed' || status === 'success'
  const isActive =
    status === 'running'
    || status === 'waiting_for_clip'
    || status === 'queued'
    || status === 'running_script'
    || status === 'running_subagent'
  const isAnalysis = isAnalysisPlaceholderKind(kind)
  const progressValue = clampProgress(progress)
  const baseStyle: React.CSSProperties = {
    padding: '6px 8px',
    paddingLeft: `${8 + depth * 22}px`,
    opacity: isFailure ? 0.85 : isComplete ? 0.78 : 0.72,
    pointerEvents: 'none',
    userSelect: 'none',
    cursor: 'default',
    background: isFailure ? 'color-mix(in srgb, var(--color-rose-light, #fee2e2) 36%, transparent)' : 'transparent',
    boxShadow:
      isComplete
        ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-green, #10b981) 38%, transparent)'
        : isFailure
          ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-rose, #f43f5e) 32%, transparent)'
          : 'inset 0 0 0 1px rgba(148, 163, 184, 0.22)',
  }
  const label = pendingPlaceholderLabel(kind, status)
  return (
    <div
      aria-disabled
      aria-live={status === 'failed' ? 'polite' : undefined}
      className="rounded-[8px] text-[13px]"
      style={baseStyle}
    >
      <div className="flex items-center gap-[6px]">
        <span
          aria-hidden
          className="flex items-center justify-center"
          style={{ width: 16, height: 16 }}
        >
          {isActive ? (
            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} strokeWidth={2} />
          ) : isComplete ? (
            <Check style={{ width: 14, height: 14, color: 'var(--color-green, #10b981)' }} strokeWidth={2.5} />
          ) : status === 'paused' ? (
            <ListMinus style={{ width: 14, height: 14, color: 'var(--color-orange, #f59e0b)' }} strokeWidth={2.4} />
          ) : (
            <AlertTriangle style={{ width: 14, height: 14, color: 'var(--color-rose, #f43f5e)' }} strokeWidth={2.4} />
          )}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}
          >
            <span style={{ flexShrink: 0, fontStyle: 'normal', fontVariant: 'all-small-caps', letterSpacing: '0.04em' }}>
              {label}
            </span>
            {isAnalysis && progressValue !== null && (
              <span style={{ flexShrink: 0, fontSize: 11, fontStyle: 'normal', color: 'var(--text-light)' }}>
                {progressValue}%
              </span>
            )}
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title || urlHost}
            </span>
          </div>

          {isAnalysis && progressValue !== null && (
            <div
              aria-hidden
              style={{
                marginTop: 4,
                height: 3,
                borderRadius: 999,
                overflow: 'hidden',
                background: 'rgba(148, 163, 184, 0.18)',
              }}
            >
              <div
                style={{
                  width: `${progressValue}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: isFailure
                    ? 'var(--color-rose, #f43f5e)'
                    : isComplete
                      ? 'var(--color-green, #10b981)'
                      : 'var(--color-blue, #3b82f6)',
                  transition: 'width 240ms ease',
                }}
              />
            </div>
          )}

          {isAnalysis && message && !isFailure && (
            <div
              title={message}
              style={{
                marginTop: 2,
                fontSize: 11,
                color: 'var(--text-light)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {message}
            </div>
          )}
        </div>

        {(status === 'failed' || status === 'skipped') && errorMessage && (
          <span
            title={errorMessage}
            style={{
              fontSize: 11,
              color: 'var(--color-rose, #f43f5e)',
              maxWidth: 140,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  )
}

export interface PendingClipPlaceholder {
  taskId: string
  targetDir: string
  urlHost: string
  title: string
  status: PendingPlaceholderStatus
  copiedPath?: string
  errorMessage?: string
  message?: string | null
  progress?: number
  jobId?: string
  itemId?: string
  outputDir?: string
  reportPath?: string | null
  createdAt: number
  /** Discriminates clip-side placeholder vs study-side placeholder (when
   * the action was 'content-study') and RSS analysis placeholders. */
  kind?: PendingPlaceholderKind
}

interface FileTreeRSSAnalysisJob {
  id: string
  status: FileTreeAnalysisPlaceholderStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
}

function mapAnalysisJobToPlaceholderPatch(job: FileTreeRSSAnalysisJob): Partial<PendingClipPlaceholder> {
  return {
    status: job.status,
    progress: Number(job.progress) || 0,
    message: job.message,
    errorMessage: job.error || undefined,
    outputDir: job.outputDir,
    reportPath: job.reportPath,
    copiedPath: job.reportPath || job.outputDir,
  }
}

function isTrackedAnalysisPlaceholder(placeholder: PendingClipPlaceholder): boolean {
  return isAnalysisPlaceholderKind(placeholder.kind) && Boolean(placeholder.jobId)
}

function analysisPlaceholderTerminalDelay(status: PendingPlaceholderStatus): number | null {
  if (status === 'success' || status === 'completed') return 2600
  if (status === 'failed' || status === 'skipped') return 6000
  return null
}

function buildAnalysisJobKey(placeholders: PendingClipPlaceholder[]): string {
  return placeholders
    .filter((p) => isTrackedAnalysisPlaceholder(p) && isActiveAnalysisStatus(p.status))
    .map((p) => p.jobId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join('|')
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
  fileTreeDropTarget,
  flashingPath,
  pendingClips,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onItemDragStart,
  onItemDragEnd,
  onNativeFileDragStart,
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
  fileTreeDropTarget: FileTreeDropTarget | null
  flashingPath: string | null
  pendingClips: PendingClipPlaceholder[]
  onToggleDir: (path: string) => Promise<void>
  onOpenFile: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onItemDragStart: () => void
  onItemDragEnd: () => void
  onNativeFileDragStart: (payload: WorkspaceDragPayload) => void
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

  const placeholdersForThisFolder = pendingClips.filter((p) => p.targetDir === containerPath)
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
      {placeholdersForThisFolder.map((p) => (
        <PendingClipRow
          key={p.taskId}
          status={p.status}
            urlHost={p.urlHost}
            title={p.title}
            errorMessage={p.errorMessage}
            message={p.message}
            progress={p.progress}
            depth={depth}
            kind={p.kind}
          />
      ))}
      {visibleItems.map((item) => {
        const isExpanded = expandedDirs.has(item.path)
        const children = dirChildren.get(item.path) || []
        const browserDropLine =
          fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === item.path
            ? 'before'
            : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === item.path
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
                fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path
              }
              browserDropLine={browserDropLine}
              isFlashing={flashingPath === item.path}
              depth={depth}
              onToggleDir={() => onToggleDir(item.path)}
              onOpenFile={() => onOpenFile(item)}
              onContextMenu={(e) => onContextMenu(e, item)}
              onDragStart={onItemDragStart}
              onDragEnd={onItemDragEnd}
              onNativeFileDragStart={onNativeFileDragStart}
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
                fileTreeDropTarget={fileTreeDropTarget}
                flashingPath={flashingPath}
                pendingClips={pendingClips}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                onItemDragStart={onItemDragStart}
                onItemDragEnd={onItemDragEnd}
                onNativeFileDragStart={onNativeFileDragStart}
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
    workspaceRoot,
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
    refreshFiles,
    deleteItem,
    removePinnedFolder,
    clearWorkspace,
    loadSavedWorkspace,
  } = useWorkspace()

  const { setWorkbenchMode } = useMode()

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'fs' | 'unpin'; path: string; name: string } | null>(null)
  const [externalDropMenu, setExternalDropMenu] = useState<FileTreeExternalDropMenuState | null>(null)
  const [flashingTargetPath, setFlashingTargetPath] = useState<string | null>(null)
  const flashClearTimerRef = useRef<number | null>(null)
  /**
   * Pending background clips, surfaced as placeholder rows in the FileTree so
   * the user gets immediate "处理中" feedback before any file actually appears
   * on disk. Keyed by taskId. `targetDir` decides which folder the row lives
   * in; `status` controls the visual (running / completed / failed). Cleared
   * when the actual file lands (FS watcher) or after a short failure delay.
   */
  const [pendingClips, setPendingClips] = useState<PendingClipPlaceholder[]>([])
  const pendingClipRemoveTimersRef = useRef<Map<string, number>>(new Map())
  const pendingClipsRef = useRef<PendingClipPlaceholder[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [moveDropTargetDir, setMoveDropTargetDir] = useState<string | null>(null)
  const [fileTreeDropTarget, setFileTreeDropTarget] = useState<FileTreeDropTarget | null>(null)
  const [internalGridPath, setInternalGridPath] = useState<string | null>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const gridPreviewLoadingRef = useRef(new Set<string>())
  const activeNativeFileDragRef = useRef<WorkspaceDragPayload | null>(null)
  const nativeFileDragClearTimerRef = useRef<number | null>(null)
  const fileTreeSurfaceRefreshTimerRef = useRef<number | null>(null)
  const queryLower = query.trim().toLowerCase()
  const effectiveGridPath = gridPath !== undefined ? gridPath : internalGridPath
  const setEffectiveGridPath = onGridPathChange ?? setInternalGridPath
  const activeAnalysisJobKey = useMemo(() => buildAnalysisJobKey(pendingClips), [pendingClips])

  const clearNativeFileDragSource = useCallback(() => {
    activeNativeFileDragRef.current = null
    if (nativeFileDragClearTimerRef.current !== null) {
      window.clearTimeout(nativeFileDragClearTimerRef.current)
      nativeFileDragClearTimerRef.current = null
    }
  }, [])

  const rememberNativeFileDragSource = useCallback((payload: WorkspaceDragPayload) => {
    clearNativeFileDragSource()
    activeNativeFileDragRef.current = payload
    nativeFileDragClearTimerRef.current = window.setTimeout(() => {
      clearNativeFileDragSource()
    }, 15000)
  }, [clearNativeFileDragSource])

  const clearFileTreeDragState = useCallback(() => {
    setIsDragOver(false)
    setMoveDropTargetDir(null)
    setFileTreeDropTarget(null)
  }, [])

  const clearAllFileTreeDragState = useCallback(() => {
    clearFileTreeDragState()
    clearNativeFileDragSource()
  }, [clearFileTreeDragState, clearNativeFileDragSource])

  const requestFileTreeSurfaceRefresh = useCallback(() => {
    const refresh = window.electronAPI?.window?.refreshTransparentSurface
    if (!refresh) return
    void refresh()
  }, [])

  const scheduleFileTreeSurfaceRefresh = useCallback(() => {
    if (fileTreeSurfaceRefreshTimerRef.current !== null) {
      window.clearTimeout(fileTreeSurfaceRefreshTimerRef.current)
    }
    fileTreeSurfaceRefreshTimerRef.current = window.setTimeout(() => {
      fileTreeSurfaceRefreshTimerRef.current = null
      requestFileTreeSurfaceRefresh()
    }, FILE_TREE_SURFACE_REFRESH_DELAY_MS)
  }, [requestFileTreeSurfaceRefresh])

  const handleFileTreeSurfaceScroll = useCallback(() => {
    scheduleFileTreeSurfaceRefresh()
  }, [scheduleFileTreeSurfaceRefresh])

  const handleFileTreeSurfaceMotion = useCallback(() => {
    scheduleFileTreeSurfaceRefresh()
  }, [scheduleFileTreeSurfaceRefresh])

  useEffect(() => {
    return () => {
      if (fileTreeSurfaceRefreshTimerRef.current !== null) {
        window.clearTimeout(fileTreeSurfaceRefreshTimerRef.current)
        fileTreeSurfaceRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    pendingClipsRef.current = pendingClips
  }, [pendingClips])

  useEffect(() => {
    const handleDragCleanup = () => clearAllFileTreeDragState()
    const handleVisibilityCleanup = () => {
      if (document.visibilityState === 'hidden') {
        clearAllFileTreeDragState()
      }
    }

    window.addEventListener('dragend', handleDragCleanup)
    window.addEventListener('drop', handleDragCleanup)
    window.addEventListener('blur', handleDragCleanup)
    document.addEventListener('visibilitychange', handleVisibilityCleanup)

    return () => {
      window.removeEventListener('dragend', handleDragCleanup)
      window.removeEventListener('drop', handleDragCleanup)
      window.removeEventListener('blur', handleDragCleanup)
      document.removeEventListener('visibilitychange', handleVisibilityCleanup)
      clearNativeFileDragSource()
    }
  }, [clearAllFileTreeDragState, clearNativeFileDragSource])

  const shouldPreserveDropHint = useCallback((event: React.DragEvent<HTMLElement>) => {
    const currentTarget = event.currentTarget
    const nextTarget = event.relatedTarget as Node | null
    const rect = currentTarget.getBoundingClientRect()

    return shouldKeepFileTreeDropHintOnLeave({
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

  // Background task subscribers keep file-tree placeholders in sync with work
  // that runs outside the right-side agent chat.
  const schedulePlaceholderRemoval = useCallback((taskId: string, delayMs: number) => {
    const existing = pendingClipRemoveTimersRef.current.get(taskId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      setPendingClips((prev) => prev.filter((p) => p.taskId !== taskId))
      pendingClipRemoveTimersRef.current.delete(taskId)
    }, delayMs)
    pendingClipRemoveTimersRef.current.set(taskId, timer)
  }, [])

  const flashCompletedPath = useCallback((path?: string | null) => {
    if (!path) return
    setFlashingTargetPath(path)
    if (flashClearTimerRef.current !== null) {
      window.clearTimeout(flashClearTimerRef.current)
    }
    flashClearTimerRef.current = window.setTimeout(() => {
      setFlashingTargetPath(null)
      flashClearTimerRef.current = null
    }, 2500)
  }, [])

  useEffect(() => {
    const cleanupStudy = window.electronAPI?.browser?.onContentStudyUpdate?.((data) => {
      if (!data || typeof data !== 'object') return
      const update = data as {
        kind?: string
        taskId: string
        status: string
        url?: string
        copiedPath?: string
        errorKind?: string
        errorMessage?: string
      }
      if (update.kind !== 'study') return
      if (update.status === 'waiting_for_clip') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId ? { ...p, status: 'waiting_for_clip' } : p,
          ),
        )
      } else if (update.status === 'running') {
        setPendingClips((prev) =>
          prev.map((p) => (p.taskId === update.taskId ? { ...p, status: 'running' } : p)),
        )
      } else if (update.status === 'completed') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId
              ? { ...p, status: 'completed', copiedPath: update.copiedPath }
              : p,
          ),
        )
        schedulePlaceholderRemoval(update.taskId, 1500)
        flashCompletedPath(update.copiedPath)
      } else if (update.status === 'failed' || update.status === 'skipped') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId
              ? {
                  ...p,
                  status: update.status as 'failed' | 'skipped',
                  errorMessage: update.errorMessage || update.errorKind || '失败',
                }
              : p,
          ),
        )
        schedulePlaceholderRemoval(update.taskId, 4000)
      }
    })
    const cleanup = window.electronAPI?.browser?.onClipBackgroundUpdate?.((data) => {
      if (!data || typeof data !== 'object') return
      const update = data as { taskId: string; status: string; url?: string; targetHint?: string }
      if (update.status === 'running') {
        console.info('[obsidian-web-clip] background running', update.taskId, update.url, '→', update.targetHint)
      } else if (update.status === 'completed') {
        const completed = data as {
          taskId: string
          savedPath: string
          preset: { id: string; name: string }
          suggestedVaultRelativePath: string
          copiedPath?: string
          assetPaths?: string[]
          imageDownloadFailures?: number
          copyError?: { kind: string; message: string }
        }
        console.info(
          '[obsidian-web-clip] background completed',
          completed.taskId,
          '→',
          completed.copiedPath || completed.savedPath,
          `(preset: ${completed.preset.id}, vault-rel: ${completed.suggestedVaultRelativePath}, ` +
            `assets: ${completed.assetPaths?.length || 0}, ` +
            `imgFail: ${completed.imageDownloadFailures || 0})`,
        )
        if (completed.copyError) {
          console.warn(
            '[obsidian-web-clip] materialize to dragged folder failed:',
            completed.copyError.kind,
            completed.copyError.message,
          )
        }
        // Update placeholder to "completed" and arm flash on the NEW file.
        // We keep the placeholder briefly so the user sees an explicit
        // "完成" beat; the FS watcher will surface the real file at copiedPath
        // within ~100-500ms and our flash CSS triggers when the new row
        // first renders with isFlashing=true.
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === completed.taskId ? { ...p, status: 'completed', copiedPath: completed.copiedPath } : p,
          ),
        )
        schedulePlaceholderRemoval(completed.taskId, 1200)
        flashCompletedPath(completed.copiedPath)
      } else if (update.status === 'failed') {
        const failed = data as { taskId: string; errorKind: string; recoverable: boolean; errorDetail?: { message?: string } }
        console.warn(
          '[obsidian-web-clip] background failed',
          failed.taskId,
          failed.errorKind,
          'recoverable=' + failed.recoverable,
          failed.errorDetail,
        )
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === failed.taskId
              ? { ...p, status: 'failed', errorMessage: failed.errorDetail?.message || failed.errorKind }
              : p,
          ),
        )
        schedulePlaceholderRemoval(failed.taskId, 4000)
      }
    })
    return () => {
      cleanup?.()
      cleanupStudy?.()
      if (flashClearTimerRef.current !== null) {
        window.clearTimeout(flashClearTimerRef.current)
        flashClearTimerRef.current = null
      }
      for (const timer of pendingClipRemoveTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      pendingClipRemoveTimersRef.current.clear()
    }
  }, [flashCompletedPath, schedulePlaceholderRemoval])

  useEffect(() => {
    if (!activeAnalysisJobKey) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const tracked = pendingClipsRef.current.filter((p) =>
        isTrackedAnalysisPlaceholder(p) && isActiveAnalysisStatus(p.status),
      )
      if (tracked.length === 0) return

      try {
        const result = await window.electronAPI?.rss?.listItemAnalysisJobs?.({ limit: 200 })
        if (disposed || !result?.success || !result.data) return

        const jobsById = new Map(result.data.map((job) => [job.id, job]))
        const terminalUpdates: Array<{ taskId: string; delayMs: number; flashPath?: string | null }> = []

        for (const placeholder of pendingClipsRef.current) {
          if (!isTrackedAnalysisPlaceholder(placeholder) || !placeholder.jobId) continue
          const job = jobsById.get(placeholder.jobId)
          if (!job) continue
          const delayMs = analysisPlaceholderTerminalDelay(job.status)
          if (delayMs !== null) {
            terminalUpdates.push({
              taskId: placeholder.taskId,
              delayMs,
              flashPath: job.status === 'success' ? job.reportPath || job.outputDir : null,
            })
          }
        }

        setPendingClips((prev) =>
          prev.map((placeholder) => {
            if (!isTrackedAnalysisPlaceholder(placeholder) || !placeholder.jobId) return placeholder
            const job = jobsById.get(placeholder.jobId)
            return job ? { ...placeholder, ...mapAnalysisJobToPlaceholderPatch(job) } : placeholder
          }),
        )

        for (const update of terminalUpdates) {
          schedulePlaceholderRemoval(update.taskId, update.delayMs)
          flashCompletedPath(update.flashPath)
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(tick, 1400)
        }
      }
    }

    void tick()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [activeAnalysisJobKey, flashCompletedPath, schedulePlaceholderRemoval])

  const handleOpenFile = useCallback((item: FileItem) => {
    if (item.isDirectory) {
      selectFile(item.path)
      if (viewMode === 'tree') {
        void toggleDir(item.path)
      }
      return
    }

    const ext = item.name.split('.').pop()?.toLowerCase() || ''
    selectFile(item.path)
    if (isLocalHtmlFilePath(item.path)) {
      void openLocalHtmlFileInBrowser(item.path, item.name).then((opened) => {
        if (opened) requestWorkbenchModeChange('browser')
      })
      return
    }

    const modeMap: Record<string, WorkbenchMode> = {
      md: 'document', txt: 'document', json: 'document', ts: 'document', tsx: 'document',
      js: 'document', css: 'document', docx: 'document', xlsx: 'document',
      png: 'document', jpg: 'document', jpeg: 'document', webp: 'document', svg: 'document', gif: 'document',
      bmp: 'document', ico: 'document',
      pdf: 'document',
      epub: 'document', mobi: 'document', azw: 'document', azw3: 'document', fb2: 'document', cbz: 'document',
      tldr: 'document'
    }
    if (modeMap[ext]) {
      useDocTabs.getState().openTab(item.path)
      setWorkbenchMode(modeMap[ext])
    }
  }, [selectFile, setWorkbenchMode, toggleDir, viewMode])

  const moveWorkspaceItem = useCallback(async (payload: WorkspaceDragPayload, targetDir: string) => {
    if (!canMoveToDirectory(payload, targetDir)) return
    const nextPath = joinPath(targetDir, payload.name)
    if (nextPath === payload.path) return
    await moveItem(payload.path, nextPath)
  }, [moveItem])

  const getExternalDropPayload = useCallback(
    (dataTransfer: DataTransfer): FileTreeExternalDropPayload | null => {
      const raw = dataTransfer.getData('application/x-ready-drag')
      const browserTab = parseBrowserTabDragPayload(raw) ?? getActiveBrowserTabDragPayload()
      if (browserTab) return browserTab
      const rssItem = parseRssItemDragPayload(raw) ?? getActiveRssItemDragPayload()
      if (rssItem) return rssItem
      return parseWebDownloadDragPayload(dataTransfer)
    },
    [],
  )

  const handleWebDownloadDrop = useCallback((payload: WebDownloadDragPayload, target: FileTreeDropTarget) => {
    const targetDir = getTargetDirFromDropTarget(target)
    const taskId = `download-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    let urlHost = payload.url
    try {
      urlHost = new URL(payload.url).host || payload.url
    } catch {
      // silent-catch: URL parse fallback for clip-task placeholder host hint; raw URL is shown if parse fails. No user-facing impact.
      urlHost = payload.url
    }
    setPendingClips((prev) => [
      ...prev,
      {
        taskId,
        targetDir,
        urlHost,
        title: payload.name || payload.title || urlHost,
        status: 'running',
        createdAt: Date.now(),
        kind: 'download',
      },
    ])

    const fail = (message: string) => {
      setPendingClips((prev) =>
        prev.map((item) => (item.taskId === taskId ? { ...item, status: 'failed', errorMessage: message } : item)),
      )
      schedulePlaceholderRemoval(taskId, 4000)
    }

    if (payload.unsupportedReason) {
      fail(payload.unsupportedReason)
      return
    }

    void (async () => {
      try {
        const result = await window.electronAPI?.browser?.downloadUrlToDirectory?.({
          url: payload.url,
          targetDir,
          sourcePageUrl: payload.sourcePageUrl,
          suggestedName: payload.suggestedName,
        })
        if (!result?.success) {
          fail(result?.error || '下载失败')
          return
        }
        const savedPath = result.savePath || ''
        setPendingClips((prev) =>
          prev.map((item) =>
            item.taskId === taskId
              ? {
                  ...item,
                  title: result.filename || item.title,
                  status: 'completed',
                  copiedPath: savedPath,
                }
              : item,
          ),
        )
        await refreshFiles()
        await loadDirChildren(targetDir)
        flashCompletedPath(savedPath)
        schedulePlaceholderRemoval(taskId, 1800)
      } catch (error) {
        // silent-catch: failure is surfaced to renderer via fail() callback which drives the placeholder's visible error state. Re-throw would re-fire the IIFE.
        fail(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [flashCompletedPath, loadDirChildren, refreshFiles, schedulePlaceholderRemoval])

  const handleResolvedExternalDrop = useCallback((
    payload: FileTreeExternalDropPayload,
    target: FileTreeDropTarget,
    x: number,
    y: number,
  ) => {
    setContextMenu(null)
    if (payload.type === 'web-download-url') {
      handleWebDownloadDrop(payload, target)
      return
    }
    setExternalDropMenu({ x, y, payload, target })
  }, [handleWebDownloadDrop])

  const handleDirectoryDrop = useCallback((e: React.DragEvent, dirPath: string) => {
    const nativePayload = activeNativeFileDragRef.current
    if (hasRememberedNativeFileDrag(nativePayload, dirPath)) {
      e.preventDefault()
      e.stopPropagation()
      clearAllFileTreeDragState()
      void moveWorkspaceItem(nativePayload, dirPath)
      return
    }

    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      e.preventDefault()
      e.stopPropagation()
      setMoveDropTargetDir(null)
      setFileTreeDropTarget(null)
      handleResolvedExternalDrop(
        externalPayload,
        {
          kind: 'inside-directory',
          dirPath,
          itemPath: dirPath,
          containerPath: dirPath,
        },
        e.clientX,
        e.clientY,
      )
      return
    }

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (!payload || !canMoveToDirectory(payload, dirPath)) return
    e.preventDefault()
    e.stopPropagation()
    setMoveDropTargetDir(null)
    setFileTreeDropTarget(null)
    void moveWorkspaceItem(payload, dirPath)
  }, [clearAllFileTreeDragState, getExternalDropPayload, handleResolvedExternalDrop, moveWorkspaceItem])

  const handleItemDragOver = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const nativePayload = activeNativeFileDragRef.current
    if (item.isDirectory && hasRememberedNativeFileDrag(nativePayload, item.path)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (moveDropTargetDir !== item.path) setMoveDropTargetDir(item.path)
      setFileTreeDropTarget(null)
      return
    }

    const workspacePayload = parseWorkspaceDragPayload(e.dataTransfer)
    if (item.isDirectory && workspacePayload && canMoveToDirectory(workspacePayload, item.path)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (moveDropTargetDir !== item.path) setMoveDropTargetDir(item.path)
      setFileTreeDropTarget(null)
      return
    }

    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setMoveDropTargetDir(null)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setFileTreeDropTarget(
        resolveFileTreeDropTarget({
          itemPath: item.path,
          isDirectory: item.isDirectory,
          containerPath,
          pointerY: e.clientY,
          rectTop: rect.top,
          rectHeight: rect.height,
        }),
      )
    }
  }, [getExternalDropPayload, moveDropTargetDir])

  const handleItemDragLeave = useCallback((e: React.DragEvent, item: FileItem) => {
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) return

    if (moveDropTargetDir === item.path) {
      setMoveDropTargetDir(null)
    }

    if (fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path) {
      setFileTreeDropTarget(null)
      return
    }

    if (
      (fileTreeDropTarget?.kind === 'insert-before' || fileTreeDropTarget?.kind === 'insert-after') &&
      fileTreeDropTarget.anchorPath === item.path
    ) {
      setFileTreeDropTarget(null)
    }
  }, [fileTreeDropTarget, moveDropTargetDir, shouldPreserveDropHint])

  const handleItemDrop = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      e.preventDefault()
      e.stopPropagation()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const target = resolveFileTreeDropTarget({
        itemPath: item.path,
        isDirectory: item.isDirectory,
        containerPath,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
      })
      setMoveDropTargetDir(null)
      setFileTreeDropTarget(null)
      handleResolvedExternalDrop(externalPayload, target, e.clientX, e.clientY)
      return
    }

    if (item.isDirectory) {
      handleDirectoryDrop(e, item.path)
    }
  }, [getExternalDropPayload, handleDirectoryDrop, handleResolvedExternalDrop])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const nativePayload = activeNativeFileDragRef.current
    if (hasRememberedNativeFileDrag(nativePayload, currentPath)) {
      e.dataTransfer.dropEffect = 'move'
      setIsDragOver(false)
      return
    }

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      e.dataTransfer.dropEffect = 'move'
      return
    }
    if (getExternalDropPayload(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(false)
      setMoveDropTargetDir(null)
      setFileTreeDropTarget((current) => {
        if (
          current?.kind === 'inside-directory' &&
          current.dirPath === currentPath &&
          current.itemPath === currentPath
        ) {
          return current
        }
        return {
          kind: 'inside-directory',
          dirPath: currentPath,
          itemPath: currentPath,
          containerPath: currentPath,
        }
      })
      return
    }
    if (hasNativeFileDrop(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [currentPath, getExternalDropPayload])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) {
      return
    }
    clearFileTreeDragState()
  }, [clearFileTreeDragState, shouldPreserveDropHint])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    clearFileTreeDragState()
    const lastDropTarget = fileTreeDropTarget
    const nativePayload = activeNativeFileDragRef.current
    if (hasRememberedNativeFileDrag(nativePayload, currentPath)) {
      clearNativeFileDragSource()
      await moveWorkspaceItem(nativePayload, currentPath)
      return
    }

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      await moveWorkspaceItem(payload, currentPath)
      return
    }

    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      // Fallback target for drops landing in blank container space (no row
      // or directory was the hover target). Without this the drop menu
      // silently fails to appear, which is confusing — the user expects the
      // drop to apply to the folder they're currently viewing.
      const resolvedTarget: FileTreeDropTarget =
        lastDropTarget ?? {
          kind: 'inside-directory',
          dirPath: currentPath,
          itemPath: currentPath,
          containerPath: currentPath,
        }
      handleResolvedExternalDrop(externalPayload, resolvedTarget, e.clientX, e.clientY)
      return
    }

    const droppedFiles = e.dataTransfer.files
    if (!droppedFiles || droppedFiles.length === 0) return
    clearNativeFileDragSource()
    if (typeof window !== 'undefined' && window.electronAPI) {
      for (let i = 0; i < droppedFiles.length; i++) {
        const p = window.electronAPI.getFilePathFromDrop(droppedFiles[i])
        if (p) addPinnedFolder(p)
      }
    }
  }, [addPinnedFolder, clearFileTreeDragState, clearNativeFileDragSource, fileTreeDropTarget, currentPath, getExternalDropPayload, handleResolvedExternalDrop, moveWorkspaceItem])

  const handleExternalDropAction = useCallback(
    (action: FileTreeExternalDropAction) => {
      if (!externalDropMenu) return
      const { payload, target } = externalDropMenu
      setExternalDropMenu(null)
      void dispatchFileTreeExternalDropAction({
        payload,
        action,
        target,
        onPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [...prev, { ...placeholder, kind: 'clip' }])
        },
        onPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status === 'failed') {
            schedulePlaceholderRemoval(taskId, 4000)
          }
        },
        onStudyPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [
            ...prev,
            { ...placeholder, kind: 'study', status: 'waiting_for_clip' },
          ])
        },
        onStudyPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status === 'failed' || patch.status === 'skipped') {
            schedulePlaceholderRemoval(taskId, 4000)
          }
        },
        onAnalysisPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [
            ...prev,
            {
              ...placeholder,
              kind: placeholder.action === 'copy' ? 'analysis-copy' : 'analysis-visual',
            },
          ])
        },
        onAnalysisPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status) {
            const delayMs = analysisPlaceholderTerminalDelay(patch.status)
            if (delayMs !== null) {
              schedulePlaceholderRemoval(taskId, delayMs)
            }
          }
          if (patch.status === 'success') {
            flashCompletedPath(patch.copiedPath || patch.reportPath || patch.outputDir)
          }
        },
      })
    },
    [externalDropMenu, flashCompletedPath, schedulePlaceholderRemoval],
  )

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
          fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === folderPath
            ? 'before'
            : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === folderPath
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
                fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === folderPath
              }
              browserDropLine={browserDropLine}
              isFlashing={flashingTargetPath === folderPath}
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
              onDragStart={clearFileTreeDragState}
              onDragEnd={clearAllFileTreeDragState}
              onNativeFileDragStart={rememberNativeFileDragSource}
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
                fileTreeDropTarget={fileTreeDropTarget}
                flashingPath={flashingTargetPath}
                pendingClips={pendingClips}
                onToggleDir={toggleDir}
                onOpenFile={handleOpenFile}
                onContextMenu={(e, item) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                onItemDragStart={clearFileTreeDragState}
                onItemDragEnd={clearAllFileTreeDragState}
                onNativeFileDragStart={rememberNativeFileDragSource}
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
            className="ready-glass-button text-[13px]"
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
        fileTreeDropTarget={fileTreeDropTarget}
        flashingPath={flashingTargetPath}
        pendingClips={pendingClips}
        onToggleDir={toggleDir}
        onOpenFile={handleOpenFile}
        onContextMenu={(e, item) => {
          e.preventDefault()
          e.stopPropagation()
          setContextMenu({ x: e.clientX, y: e.clientY, item })
        }}
        onItemDragStart={clearFileTreeDragState}
        onItemDragEnd={clearAllFileTreeDragState}
        onNativeFileDragStart={rememberNativeFileDragSource}
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
                  ? <Folder className="w-[16px] h-[16px]" style={{ color: 'var(--text-muted)' }} />
                  : <FileText className="w-[16px] h-[16px]" style={{ color: 'var(--text-muted)' }} />}
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
          {gridItems.map((item) => {
            const browserDropLine =
              fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === item.path
                ? 'before'
                : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === item.path
                  ? 'after'
                  : null

            return (
              <GridItemCard
                key={item.path}
                item={item}
                isActive={selectedFile === item.path}
                isDropTarget={
                  item.isDirectory &&
                  (
                    moveDropTargetDir === item.path ||
                    (fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path)
                  )
                }
                browserDropLine={browserDropLine}
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
                onDragStart={clearFileTreeDragState}
                onDragEnd={clearAllFileTreeDragState}
                onNativeFileDragStart={rememberNativeFileDragSource}
                onDragOver={(e) => handleItemDragOver(e, item, gridContainerPath)}
                onDragLeave={(e) => handleItemDragLeave(e, item)}
                onDrop={(e) => handleItemDrop(e, item, gridContainerPath)}
              />
            )
          })}
        </div>
      </>
    )
  }

  return (
    <div
      ref={treeRootRef}
      data-liquid-scroll-root="file-tree"
      className="panel-hover-scrollbar flex-1 overflow-auto relative"
      style={{ padding: '6px 8px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseMove={handleFileTreeSurfaceMotion}
      onScroll={handleFileTreeSurfaceScroll}
      onMouseLeave={scheduleFileTreeSurfaceRefresh}
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
          pinnedFolders={pinnedFolders}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
          onRequestDelete={({ path, name }) => setPendingDelete({ kind: 'fs', path, name })}
          onRequestUnpin={({ path, name }) => setPendingDelete({ kind: 'unpin', path, name })}
          workspaceRoot={workspaceRoot}
        />
      )}

      <Modal
        open={pendingDelete !== null}
        mode="confirm"
        danger
        title={pendingDelete?.kind === 'unpin'
          ? '从列表中移除'
          : '删除文件'}
        message={
          pendingDelete?.kind === 'unpin'
            ? `确定从文件管理列表里移除 "${pendingDelete.name}" 吗？不会删除磁盘上的实际文件夹。`
            : pendingDelete
              ? `确定删除 "${pendingDelete.name}" 吗？此操作不可恢复。`
              : ''
        }
        confirmLabel={pendingDelete?.kind === 'unpin'
          ? '移除'
          : '删除'}
        cancelLabel="取消"
        onConfirm={() => {
          if (!pendingDelete) return
          if (pendingDelete.kind === 'fs') {
            void deleteItem(pendingDelete.path)
          } else {
            const nextPinnedFolders = pinnedFolders.filter((folderPath) => folderPath !== pendingDelete.path)
            if (pendingDelete.path === workspaceRoot) {
              if (nextPinnedFolders.length > 0) loadSavedWorkspace(nextPinnedFolders)
              else clearWorkspace()
            } else {
              removePinnedFolder(pendingDelete.path)
            }
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {externalDropMenu && (
        <FileTreeExternalDropMenu
          menu={externalDropMenu}
          boundaryRect={treeRootRef.current?.getBoundingClientRect() ?? null}
          onAction={handleExternalDropAction}
          onClose={() => setExternalDropMenu(null)}
        />
      )}

    </div>
  )
}

function FileTreeExternalDropMenu({
  menu,
  boundaryRect,
  onAction,
  onClose,
}: {
  menu: FileTreeExternalDropMenuState
  boundaryRect: DOMRect | null
  onAction: (action: FileTreeExternalDropAction) => void
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
  const actionItems = useMemo(() => {
    const items: Array<{
      id: FileTreeExternalDropAction
      label: string
      icon: React.ReactNode
    }> = [
      {
        id: 'web-clip',
        label: '网页剪藏',
        icon: <Globe style={{ width: 15, height: 15 }} />,
      },
      {
        id: 'content-study',
        label: '内容学习',
        icon: <BookOpen style={{ width: 15, height: 15 }} />,
      },
      {
        id: 'copy-analysis',
        label: '文案分析',
        icon: <FileText style={{ width: 15, height: 15 }} />,
      },
    ]
    if (isLikelyVideoDropPayload(menu.payload)) {
      items.push({
        id: 'visual-analysis',
        label: '视觉分析',
        icon: <Image style={{ width: 15, height: 15 }} />,
      })
    }
    return items
  }, [menu.payload])

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
  pinnedFolders,
  onClose,
  onOpenFile,
  onRequestDelete,
  onRequestUnpin,
  workspaceRoot,
}: {
  contextMenu: { x: number; y: number; item: FileItem | null }
  pinnedFolders: string[]
  onClose: () => void
  onOpenFile: (item: FileItem) => void
  onRequestDelete: (info: { path: string; name: string }) => void
  onRequestUnpin: (info: { path: string; name: string }) => void
  workspaceRoot: string | null
}) {
  const {
    startRenaming,
    copyPathToClipboard,
    startCreating,
    showInFolder,
    refreshFiles,
  } = useWorkspace()
  const pinnedFolderSet = useMemo(() => new Set(pinnedFolders), [pinnedFolders])

  const nativeMenuAvailable = Boolean(
    typeof window !== 'undefined' && window.electronAPI?.ui?.showNativeContextMenu,
  )

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
        },
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
      {
        id: 'referenceToInput',
        label: '引用到输入框',
        icon: <AtSign style={{ width: 16, height: 16 }} />,
        onClick: () => {
          void addReadyContextReferenceToAgentInput({
            type: 'file',
            name: item.name,
            path: item.path,
            size: item.size,
            isDirectory: item.isDirectory,
          })
        },
      },
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
      ...(pinnedFolderSet.has(item.path) || item.path === workspaceRoot ? [
        {
          id: 'removeFromList',
          label: '从列表中移除',
          icon: <ListMinus style={{ width: 16, height: 16 }} />,
          onClick: () => onRequestUnpin({ path: item.path, name: item.name }),
        },
      ] : []),
      { id: 'sep4', label: '', separator: true },
      {
        id: 'delete',
        label: '删除',
        icon: <Trash2 style={{ width: 16, height: 16 }} />,
        danger: true,
        onClick: () => onRequestDelete({ path: item.path, name: item.name })
      }
    ]
  }, [onOpenFile, startRenaming, copyPathToClipboard, startCreating, showInFolder, refreshFiles, pinnedFolderSet, workspaceRoot, onRequestDelete, onRequestUnpin])

  const contextItems = useMemo(() => getContextItems(contextMenu.item), [contextMenu.item, getContextItems])

  const toNativeContextItems = useCallback((items: ContextMenuItem[]): NativeContextMenuItem[] => {
    const iconTextById: Record<string, string> = {
      open: '↩',
      referenceToInput: '@',
      rename: '✎',
      copyPath: '⧉',
      newFile: '+',
      newFolder: '⊞',
      showInFinder: '↗',
      refresh: '↻',
      removeFromList: '−',
      delete: '⌫',
    }
    const acceleratorById: Record<string, string> = {
      rename: 'Enter',
      copyPath: 'Alt+Command+C',
    }
    return items.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: !item.disabled,
      separator: item.separator,
      iconText: item.separator ? undefined : iconTextById[item.id],
      accelerator: item.separator ? undefined : acceleratorById[item.id],
    }))
  }, [])

  // ref 模式：useEffect 只在菜单首次打开（坐标变化）时跑，避免父组件 inline
  // 函数引用变化导致 cancelled=true、用户已经选了的 onClick 永远不触发。
  const liveRef = useRef({ contextItems, onClose, toNativeContextItems })
  liveRef.current = { contextItems, onClose, toNativeContextItems }

  useEffect(() => {
    if (!nativeMenuAvailable) return
    let invoked = false
    const itemsAtOpen = liveRef.current.contextItems
    const actionById = new Map(
      itemsAtOpen
        .filter((item) => !item.separator)
        .map((item) => [item.id, item]),
    )
    void window.electronAPI.ui?.showNativeContextMenu({
      x: contextMenu.x,
      y: contextMenu.y,
      items: liveRef.current.toNativeContextItems(itemsAtOpen),
    }).then((result) => {
      invoked = true
      const close = liveRef.current.onClose
      if (!result?.success || !result.selectedId) {
        close()
        return
      }
      const item = actionById.get(result.selectedId)
      if (!item || item.disabled) {
        close()
        return
      }
      item.onClick?.()
      close()
    }).catch(() => {
      invoked = true
      liveRef.current.onClose()
    })

    return () => {
      // 卸载时若菜单还没回调（用户尚未选择），主动让 UI 收起；如果 promise
      // 已 resolved（invoked=true），无需再做任何事——onClick 已经跑过。
      if (!invoked) {
        liveRef.current.onClose()
      }
    }
  }, [contextMenu.x, contextMenu.y, nativeMenuAvailable])

  if (nativeMenuAvailable) {
    return null
  }

  return (
    <ContextMenu
      items={contextItems}
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
    />
  )
}
