import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import {
  ChevronRight, ChevronDown, ArrowLeft, Minus, Plus,
  FileText, Folder, FolderOpen, Image, Film, FileSpreadsheet, Pen, Music2,
} from 'lucide-react'
import { useWorkspace, type FileItem } from '../../stores/useWorkspace'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { toLocalFileUrl } from '../../utils/dragDrop'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

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
  'ini', 'cfg', 'conf', 'properties', 'plist',
  'log', 'lock', 'tldr',
])

const DOCUMENT_EXTS = new Set(['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'html', 'htm'])
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
      ? <FolderOpen className="w-[14px] h-[14px]" style={{ color: '#C9A962' }} />
      : <Folder className="w-[14px] h-[14px]" style={{ color: '#C9A962' }} />
  }
  const kind = getFileKind(item)
  if (kind === 'image') return <Image className="w-[14px] h-[14px]" style={{ color: '#34D399' }} />
  if (kind === 'video') return <Film className="w-[14px] h-[14px]" style={{ color: '#F5A623' }} />
  if (kind === 'audio') return <Music2 className="w-[14px] h-[14px]" style={{ color: '#5B8DEF' }} />
  if (kind === 'spreadsheet') return <FileSpreadsheet className="w-[14px] h-[14px]" style={{ color: '#5B8DEF' }} />
  if (kind === 'design') return <Pen className="w-[14px] h-[14px]" style={{ color: '#5B8DEF' }} />
  return <FileText className="w-[14px] h-[14px]" style={{ color: '#5B8DEF' }} />
}

interface WorkspaceDragPayload {
  type: 'file' | 'folder'
  path: string
  name: string
  ext?: string
  size?: number
  isDirectory: boolean
}

function putDragData(e: React.DragEvent, item: FileItem) {
  const ext = getFileExt(item)
  const payload: WorkspaceDragPayload = {
    type: item.isDirectory ? 'folder' : 'file',
    path: item.path,
    name: item.name,
    ext,
    size: item.size,
    isDirectory: item.isDirectory,
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
  draggableEnabled,
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
  draggableEnabled?: boolean
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
  return (
    <div
      draggable={draggableEnabled ?? true}
      onDragStart={(e) => {
        putDragData(e, item)
        onDragStart?.(e)
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => item.isDirectory ? onToggleDir() : onOpenFile()}
      onContextMenu={onContextMenu}
      className={`
        flex items-center gap-[6px] rounded-[8px] text-[13px] cursor-pointer
        transition-all duration-200 ease-out group
        ${isActive ? '' : 'hover:bg-black/5'}
      `}
      style={{
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 22}px`,
        ...(isActive ? { background: '#E8E8E8' } : {}),
        ...(isDropTarget
          ? { outline: '1px dashed var(--color-blue)', background: 'var(--color-blue-light)' }
          : {}),
      }}
    >
      {item.isDirectory ? (
        isExpanded
          ? <ChevronDown className="w-3 h-3 flex-shrink-0" style={{ color: '#6A6A6A' }} />
          : <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: '#6A6A6A' }} />
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
            style={{ color: isActive ? '#1A1A1A' : item.isDirectory ? '#333333' : '#7A7A7A' }}
          >
            {item.name}
          </span>
        )}
      </div>
    </div>
  )
}

function GridItemCard({
  item,
  isActive,
  isDropTarget,
  thumbnailSize,
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

  return (
    <button
      draggable
      onDragStart={(e) => {
        putDragData(e, item)
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onOpen}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className="rounded-[10px] border text-left transition-all hover:bg-[var(--bg-hover)]"
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
        {canPreviewImage ? (
          <img src={toLocalFileUrl(item.path)} alt={item.name} className="max-h-full max-w-full object-cover" />
        ) : (
          fileIcon(item, false)
        )}
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-title)] truncate px-1" title={item.name}>{item.name}</p>
      <p className="text-[10px] text-[var(--text-light)] px-1">{item.isDirectory ? '文件夹' : formatSize(item.size) || '-'}</p>
    </button>
  )
}

function FileTreeRecursive({
  items,
  depth,
  selectedFile,
  expandedDirs,
  dirChildren,
  renamingPath,
  queryLower,
  filters,
  moveDropTargetDir,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onDirectoryDragOver,
  onDirectoryDragLeave,
  onDirectoryDrop,
  onRenameConfirm,
  onRenameCancel
}: {
  items: FileItem[]
  depth: number
  selectedFile: string | null
  expandedDirs: Set<string>
  dirChildren: Map<string, FileItem[]>
  renamingPath: string | null
  queryLower: string
  filters: FileFilterMap
  moveDropTargetDir: string | null
  onToggleDir: (path: string) => Promise<void>
  onOpenFile: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onDirectoryDragOver: (e: React.DragEvent, dirPath: string) => void
  onDirectoryDragLeave: (e: React.DragEvent, dirPath: string) => void
  onDirectoryDrop: (e: React.DragEvent, dirPath: string) => void
  onRenameConfirm: (path: string, newName: string) => void
  onRenameCancel: () => void
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
      {visibleItems.map((item) => {
        const isExpanded = expandedDirs.has(item.path)
        const children = dirChildren.get(item.path) || []
        return (
          <div key={item.path}>
            <FileTreeItem
              item={item}
              isActive={selectedFile === item.path}
              isExpanded={isExpanded}
              isRenaming={renamingPath === item.path}
              isDropTarget={item.isDirectory && moveDropTargetDir === item.path}
              depth={depth}
              onToggleDir={() => onToggleDir(item.path)}
              onOpenFile={() => onOpenFile(item)}
              onContextMenu={(e) => onContextMenu(e, item)}
              onDragOver={(e) => item.isDirectory && onDirectoryDragOver(e, item.path)}
              onDragLeave={(e) => item.isDirectory && onDirectoryDragLeave(e, item.path)}
              onDrop={(e) => item.isDirectory && onDirectoryDrop(e, item.path)}
              onRenameConfirm={(newName) => onRenameConfirm(item.path, newName)}
              onRenameCancel={onRenameCancel}
            />
            {item.isDirectory && isExpanded && children.length > 0 && (
              <FileTreeRecursive
                items={children}
                depth={depth + 1}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                renamingPath={renamingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                onDirectoryDragOver={onDirectoryDragOver}
                onDirectoryDragLeave={onDirectoryDragLeave}
                onDirectoryDrop={onDirectoryDrop}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
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
    pinnedFolders,
    currentPath,
    toggleDir,
    selectFile,
    setCurrentPath,
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
  const [isDragOver, setIsDragOver] = useState(false)
  const [moveDropTargetDir, setMoveDropTargetDir] = useState<string | null>(null)
  const [gridPath, setGridPath] = useState<string | null>(null)
  const queryLower = query.trim().toLowerCase()

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
    selectFile(item.path)
    const ext = item.name.split('.').pop()?.toLowerCase() || ''
    const modeMap: Record<string, WorkbenchMode> = {
      md: 'document', txt: 'document', json: 'document', ts: 'document', tsx: 'document',
      js: 'document', css: 'document', html: 'document', docx: 'document', xlsx: 'document',
      png: 'document', jpg: 'document', jpeg: 'document', webp: 'document', svg: 'document', gif: 'document',
      bmp: 'document', ico: 'document',
      mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', ogg: 'video', m4v: 'video',
      mp3: 'video', wav: 'video', aac: 'video', flac: 'video', m4a: 'video', wma: 'video', opus: 'video',
      pdf: 'document',
      tldr: 'document'
    }
    if (modeMap[ext]) {
      setWorkbenchMode(modeMap[ext])
    }
  }, [selectFile, setWorkbenchMode])

  const moveWorkspaceItem = useCallback(async (payload: WorkspaceDragPayload, targetDir: string) => {
    if (!canMoveToDirectory(payload, targetDir)) return
    const nextPath = joinPath(targetDir, payload.name)
    if (nextPath === payload.path) return
    await moveItem(payload.path, nextPath)
  }, [moveItem])

  const handleDirectoryDragOver = useCallback((e: React.DragEvent, dirPath: string) => {
    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (!payload || !canMoveToDirectory(payload, dirPath)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (moveDropTargetDir !== dirPath) setMoveDropTargetDir(dirPath)
  }, [moveDropTargetDir])

  const handleDirectoryDragLeave = useCallback((e: React.DragEvent, dirPath: string) => {
    e.stopPropagation()
    if (moveDropTargetDir === dirPath) setMoveDropTargetDir(null)
  }, [moveDropTargetDir])

  const handleDirectoryDrop = useCallback((e: React.DragEvent, dirPath: string) => {
    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (!payload || !canMoveToDirectory(payload, dirPath)) return
    e.preventDefault()
    e.stopPropagation()
    setMoveDropTargetDir(null)
    void moveWorkspaceItem(payload, dirPath)
  }, [moveWorkspaceItem])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      e.dataTransfer.dropEffect = 'move'
      return
    }
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [currentPath])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setMoveDropTargetDir(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setMoveDropTargetDir(null)

    const payload = parseWorkspaceDragPayload(e.dataTransfer)
    if (payload && canMoveToDirectory(payload, currentPath)) {
      await moveWorkspaceItem(payload, currentPath)
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
  }, [addPinnedFolder, currentPath, moveWorkspaceItem])

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
              draggableEnabled={false}
              depth={0}
              onToggleDir={() => toggleDir(folderPath)}
              onOpenFile={() => { }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setContextMenu({ x: e.clientX, y: e.clientY, item: pinnedItem })
              }}
              onDragOver={(e) => handleDirectoryDragOver(e, folderPath)}
              onDragLeave={(e) => handleDirectoryDragLeave(e, folderPath)}
              onDrop={(e) => handleDirectoryDrop(e, folderPath)}
              onRenameConfirm={(newName) => renameItem(folderPath, newName)}
              onRenameCancel={cancelRenaming}
            />
            {isExpanded && children.length > 0 && (
              <FileTreeRecursive
                items={children}
                depth={1}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                renamingPath={renamingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                onToggleDir={toggleDir}
                onOpenFile={handleOpenFile}
                onContextMenu={(e, item) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                onDirectoryDragOver={handleDirectoryDragOver}
                onDirectoryDragLeave={handleDirectoryDragLeave}
                onDirectoryDrop={handleDirectoryDrop}
                onRenameConfirm={(path, newName) => renameItem(path, newName)}
                onRenameCancel={cancelRenaming}
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
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-[13px] font-medium active:scale-[0.98] transition-all duration-200 ease-out"
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
        depth={0}
        selectedFile={selectedFile}
        expandedDirs={expandedDirs}
        dirChildren={dirChildren}
        renamingPath={renamingPath}
        queryLower={queryLower}
        filters={filters}
        moveDropTargetDir={moveDropTargetDir}
        onToggleDir={toggleDir}
        onOpenFile={handleOpenFile}
        onContextMenu={(e, item) => {
          e.preventDefault()
          e.stopPropagation()
          setContextMenu({ x: e.clientX, y: e.clientY, item })
        }}
        onDirectoryDragOver={handleDirectoryDragOver}
        onDirectoryDragLeave={handleDirectoryDragLeave}
        onDirectoryDrop={handleDirectoryDrop}
        onRenameConfirm={(path, newName) => renameItem(path, newName)}
        onRenameCancel={cancelRenaming}
      />
    )
  }

  // Collect items for grid view based on gridPath navigation
  const gridItems = useMemo(() => {
    // If user has navigated into a subdirectory via grid
    if (gridPath) {
      const children = dirChildren.get(gridPath) || []
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
  }, [gridPath, pinnedFolders, filteredCurrentItems, filters, queryLower, dirChildren])

  // Compute grid back path
  const gridParentPath = useMemo(() => {
    if (!gridPath) return null
    // Check if gridPath is a pinned root
    if (pinnedFolders.includes(gridPath)) return '' // back to root
    const idx = gridPath.lastIndexOf('/')
    if (idx <= 0) return ''
    return gridPath.slice(0, idx)
  }, [gridPath, pinnedFolders])

  const gridNavigateInto = useCallback(async (dirPath: string) => {
    // Ensure children are loaded
    if (!dirChildren.has(dirPath)) {
      await loadDirChildren(dirPath)
    }
    setGridPath(dirPath)
  }, [dirChildren, loadDirChildren])

  const gridNavigateBack = useCallback(() => {
    if (gridParentPath === '') {
      setGridPath(null) // back to root
    } else if (gridParentPath) {
      setGridPath(gridParentPath)
    }
  }, [gridParentPath])

  const gridDisplayPath = useMemo(() => {
    if (!gridPath) return null
    return gridPath.split('/').pop() || gridPath
  }, [gridPath])

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
          {gridPath !== null && (
            <button
              onClick={gridNavigateBack}
              title="返回上一级"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 6,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-primary)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <ArrowLeft style={{ width: 13, height: 13 }} />
            </button>
          )}
          {gridDisplayPath && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={gridPath || ''}>
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
                  color: '#AAAAAA', cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                <Minus style={{ width: 11, height: 11 }} />
              </button>
              <div
                style={{
                  position: 'relative', width: 56, height: 6, borderRadius: 3,
                  background: 'rgba(0,0,0,0.04)',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.06)',
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
                    background: 'rgba(0,0,0,0.08)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute', top: '50%',
                    left: `${((thumbnailSize - 80) / 140) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 10, height: 10, borderRadius: '50%',
                    background: '#F5F3EE',
                    boxShadow: '0 0.5px 2px rgba(0,0,0,0.15)',
                    border: '1px solid #E0DDD6',
                  }}
                />
              </div>
              <button
                onClick={() => onThumbnailSizeChange(Math.min(220, thumbnailSize + 20))}
                title="放大缩略图"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 4,
                  color: '#AAAAAA', cursor: 'pointer',
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
          {gridItems.map((item) => (
            <GridItemCard
              key={item.path}
              item={item}
              isActive={selectedFile === item.path}
              isDropTarget={item.isDirectory && moveDropTargetDir === item.path}
              thumbnailSize={thumbnailSize}
              onOpen={() => {
                if (item.isDirectory) {
                  selectFile(item.path)
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
      className="flex-1 overflow-auto relative"
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

      {creatingType && (
        <div className="px-2 py-1">
          <div className="flex items-center gap-1">
            {creatingType === 'folder'
              ? <Folder className="w-4 h-4 text-[var(--color-blue)] flex-shrink-0" />
              : <FileText className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
            }
            <InlineInput
              defaultValue={creatingType === 'folder' ? '新建文件夹' : '新建文件.md'}
              onConfirm={(name) => {
                if (creatingType === 'folder') void createFolder(name)
                else void createFile(name)
              }}
              onCancel={cancelCreating}
            />
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
    </div>
  )
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
        { id: 'newFile', label: '新建文件', onClick: () => startCreating('file') },
        { id: 'newFolder', label: '新建文件夹', onClick: () => startCreating('folder') },
        { id: 'sep1', label: '', separator: true },
        { id: 'refresh', label: '刷新', onClick: () => void refreshFiles() }
      ]
    }
    return [
      ...(item.isDirectory ? [] : [
        { id: 'open', label: '打开', onClick: () => onOpenFile(item) }
      ]),
      { id: 'sep1', label: '', separator: true },
      { id: 'rename', label: '重命名', shortcut: 'Enter', onClick: () => startRenaming(item.path) },
      { id: 'copyPath', label: '复制路径', shortcut: '⌥⌘C', onClick: () => copyPathToClipboard(item.path) },
      { id: 'sep2', label: '', separator: true },
      { id: 'newFile', label: '新建文件', onClick: () => startCreating('file') },
      { id: 'newFolder', label: '新建文件夹', onClick: () => startCreating('folder') },
      { id: 'sep3', label: '', separator: true },
      { id: 'showInFinder', label: '在 Finder 中显示', onClick: () => void showInFolder(item.path) },
      { id: 'sep4', label: '', separator: true },
      {
        id: 'delete', label: '删除', danger: true, onClick: () => {
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
