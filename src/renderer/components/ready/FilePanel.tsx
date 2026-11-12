import { writeReadyRefTransfer } from '../../../shared/ready-ref'
import { fileDragRef, prepareFileDragRef } from '../../modules/workbench/file-drag-ref'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, Plus, Folder, FileText, Image, Film, Music, File, FileSpreadsheet, Pen } from 'lucide-react'
import { useWorkspace, type FileItem } from '../../stores/useWorkspace'
import { EmptyState, IconButton, ListRow } from '../ui'

/** Map file extension to Lucide icon */
function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return Folder
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv']
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']
  const docExts = ['md', 'txt', 'doc', 'docx', 'pdf', 'rtf']
  const sheetExts = ['xlsx', 'xls', 'csv']
  const designExts = ['tldr']

  if (imageExts.includes(ext)) return Image
  if (videoExts.includes(ext)) return Film
  if (audioExts.includes(ext)) return Music
  if (docExts.includes(ext)) return FileText
  if (sheetExts.includes(ext)) return FileSpreadsheet
  if (designExts.includes(ext)) return Pen
  return File
}

interface FilePanelProps {
  onFileDrop?: (filePath: string, fileName: string) => void
  onFileOpen?: (filePath: string) => void
}

/**
 * FilePanel (180px) — Right-side file management panel.
 * Shows files from useWorkspace store with search, drag-to-chat, and folder dialog.
 */
export default function FilePanel({ onFileDrop, onFileOpen }: FilePanelProps) {
  const { files, selectedFile, selectFile, refreshFiles, openFolderDialog } = useWorkspace()
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedFile, setHighlightedFile] = useState<string | null>(null)
  const prevFilesCountRef = useRef(files.length)
  useEffect(() => { for (const file of files) void prepareFileDragRef(file.path, file.isDirectory).catch(error => console.warn('[FilePanel] drag identity', error)) }, [files])

  // Load files on mount
  useEffect(() => {
    refreshFiles()
  }, [refreshFiles])

  // Expose highlightFile method via a global event for cross-panel communication
  useEffect(() => {
    const handler = (e: CustomEvent<{ path: string }>) => {
      setHighlightedFile(e.detail.path)
      // Clear highlight after 3s
      setTimeout(() => setHighlightedFile(null), 3000)
    }
    window.addEventListener('ready:highlight-file', handler as EventListener)
    return () => window.removeEventListener('ready:highlight-file', handler as EventListener)
  }, [])

  // Detect new file creation (Task 8) — dispatch event for the Ready conversation
  useEffect(() => {
    if (files.length > prevFilesCountRef.current) {
      const newFiles = files.slice(prevFilesCountRef.current)
      for (const f of newFiles) {
        window.dispatchEvent(
          new CustomEvent('ready:new-file', { detail: { name: f.name, path: f.path } })
        )
      }
    }
    prevFilesCountRef.current = files.length
  }, [files])

  // Filter files by search query
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files
    const q = searchQuery.toLowerCase()
    return files.filter(f => f.name.toLowerCase().includes(q))
  }, [files, searchQuery])

  // Handle file click
  const handleFileClick = useCallback((file: FileItem) => {
    selectFile(file.path)
    if (!file.isDirectory && onFileOpen) {
      onFileOpen(file.path)
    }
  }, [selectFile, onFileOpen])

  // Handle drag start for drag-to-chat
  const handleDragStart = useCallback((e: React.DragEvent, file: FileItem) => {
    writeReadyRefTransfer(e.dataTransfer, fileDragRef(file.path), file.name)
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  // Handle "+" button to open folder dialog
  const handleAddFolder = useCallback(async () => {
    await openFolderDialog()
  }, [openFolderDialog])

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        width: 180,
        // A region on the window glass (DL1): no background of its own, a hairline to its left.
        borderLeft: '1px solid var(--rn-hair)',
        padding: '12px 10px',
        gap: 8
      }}
    >
      {/* Title + file count + add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center" style={{ gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--rn-ink)' }}>文件管理</span>
          <span style={{
            fontSize: 10, color: 'var(--rn-ink-3)',
            background: 'var(--rn-fill)',
            padding: '1px 6px', borderRadius: 8
          }}>
            {filteredFiles.length}
          </span>
        </div>
        <IconButton
          size="sm"
          onClick={handleAddFolder}
          style={{ width: 20, height: 20 }}
          title="打开文件夹"
          icon={<Plus style={{ width: 12, height: 12 }} />}
        />
      </div>

      {/* Search */}
      <div
        className="ready-input-shell flex items-center"
        style={{
          height: 28, borderRadius: 8,
          padding: '0 8px', gap: 4
        }}
      >
        <Search style={{ width: 11, height: 11, color: 'var(--rn-ink-3)' }} strokeWidth={2} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索..."
          className="ready-input-slot-inner flex-1 bg-transparent border-none outline-none"
          style={{ fontSize: 11, color: 'var(--rn-ink)' }}
        />
      </div>

      {/* File List */}
      <div className="flex-1 overflow-auto flex flex-col" style={{ gap: 2 }}>
        {filteredFiles.length === 0 && (
          <EmptyState title={searchQuery ? '无匹配文件' : '暂无文件'} />
        )}
        {filteredFiles.map((file) => {
          const Icon = getFileIcon(file.name, file.isDirectory)
          const isSelected = selectedFile === file.path
          const isHighlighted = highlightedFile === file.path
          return (
            // A navigator row (ListRow): the open file is "where you are" (DL5); a file the assistant just
            // created is marked for 3s in the success tone.
            <ListRow
              key={file.path}
              onClick={() => handleFileClick(file)}
              draggable={!file.isDirectory}
              onDragStart={(e) => handleDragStart(e, file)}
              current={isSelected}
              icon={<Icon style={{ width: 14, height: 14 }} />}
              label={file.name}
              style={{
                cursor: file.isDirectory ? 'pointer' : 'grab',
                ...(isHighlighted
                  ? {
                      background: 'color-mix(in srgb, var(--rn-ok) 12%, transparent)',
                      boxShadow: 'inset 0 0 0 1px var(--rn-ok)',
                      animation: 'pulse 1s ease-in-out 3',
                    }
                  : {}),
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
