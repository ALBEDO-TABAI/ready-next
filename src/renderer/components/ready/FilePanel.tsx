import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, Plus, Folder, FileText, Image, Film, Music, File, FileSpreadsheet, Pen } from 'lucide-react'
import { useWorkspace, type FileItem } from '../../stores/useWorkspace'

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

  // Detect new file creation (Task 8) — dispatch event for MeetingChat
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
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    const payload = JSON.stringify({
      type: 'file' as const,
      path: file.path,
      name: file.name,
      ext,
      size: file.size,
    })
    e.dataTransfer.setData('application/x-ready-file', payload)
    e.dataTransfer.setData('application/x-ready-drag', payload)
    e.dataTransfer.setData('text/plain', file.path)
    e.dataTransfer.setData('text/uri-list', `file://${encodeURI(file.path)}`)
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
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border-default)',
        padding: '12px 10px',
        gap: 8
      }}
    >
      {/* Title + file count + add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center" style={{ gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>文件管理</span>
          <span style={{
            fontSize: 10, color: 'var(--text-light)',
            background: 'var(--bg-content)',
            padding: '1px 6px', borderRadius: 8
          }}>
            {filteredFiles.length}
          </span>
        </div>
        <button
          onClick={handleAddFolder}
          className="flex items-center justify-center rounded hover:bg-black/5 transition-colors"
          style={{ width: 20, height: 20 }}
          title="打开文件夹"
        >
          <Plus style={{ width: 12, height: 12 }} className="text-[#999999]" strokeWidth={2} />
        </button>
      </div>

      {/* Search */}
      <div
        className="ready-input-shell flex items-center"
        style={{
          height: 28, borderRadius: 10,
          padding: '0 8px', gap: 4
        }}
      >
        <Search style={{ width: 11, height: 11 }} className="text-[#999999]" strokeWidth={2} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索..."
          className="ready-input-slot-inner flex-1 bg-transparent border-none outline-none"
          style={{ fontSize: 11, color: 'var(--text-body)' }}
        />
      </div>

      {/* File List */}
      <div className="flex-1 overflow-auto flex flex-col" style={{ gap: 2 }}>
        {filteredFiles.length === 0 && (
          <div className="flex items-center justify-center" style={{ padding: '24px 8px' }}>
            <span style={{ fontSize: 11, color: 'var(--text-light)' }}>
              {searchQuery ? '无匹配文件' : '暂无文件'}
            </span>
          </div>
        )}
        {filteredFiles.map((file) => {
          const Icon = getFileIcon(file.name, file.isDirectory)
          const isSelected = selectedFile === file.path
          const isHighlighted = highlightedFile === file.path
          return (
            <button
              key={file.path}
              onClick={() => handleFileClick(file)}
              draggable={!file.isDirectory}
              onDragStart={(e) => handleDragStart(e, file)}
              className="flex items-center w-full rounded-lg transition-colors text-left"
              style={{
                padding: '6px 8px', gap: 6,
                background: isHighlighted
                  ? 'var(--color-green-light)'
                  : isSelected
                    ? 'var(--color-blue-light)'
                    : 'transparent',
                cursor: file.isDirectory ? 'pointer' : 'grab',
                border: isHighlighted ? '1px solid var(--color-green)' : '1px solid transparent',
                animation: isHighlighted ? 'pulse 1s ease-in-out 3' : 'none'
              }}
              onMouseEnter={(e) => {
                if (!isSelected && !isHighlighted) {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.03)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected && !isHighlighted) {
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                }
              }}
            >
              <Icon
                style={{
                  width: 14, height: 14, flexShrink: 0,
                  color: file.isDirectory ? 'var(--color-orange)' : 'var(--text-muted)'
                }}
                strokeWidth={2}
              />
              <span className="truncate" style={{
                fontSize: 11,
                color: isSelected ? 'var(--color-blue)' : 'var(--text-body)'
              }}>
                {file.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
