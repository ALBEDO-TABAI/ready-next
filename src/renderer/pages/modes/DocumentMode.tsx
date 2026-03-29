import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import MarkdownEditor from '../../components/document/MarkdownEditor'
import DocumentTabRail from '../../components/document/DocumentTabRail'
import FilePreview from '../../components/document/FilePreview'
import DraggableModeSwitch from '../../components/document/DraggableModeSwitch'
import { READY_DOCUMENT_REVEAL_EVENT } from '../../modules/agent/document-quote-navigation'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
} from '../../modules/workbench/chrome'
import { getFileExtension } from '../../utils/path'
import {
  normalizeDocumentViewMode,
  type DocumentViewMode,
} from '../../components/document/document-view-modes'

const UniverSheet = lazy(() => import('../../components/document/UniverSheet'))

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return getFileExtension(path)
}

const getFileTypeColor = (path: string | null): string => {
  const ext = getFileExt(path)
  if (['md', 'txt', 'docx'].includes(ext)) return '#E97A2B' // orange - docs
  if (['xlsx', 'csv', 'xls'].includes(ext)) return '#34D399' // green - sheets
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '#8B5CF6' // purple - images
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return '#EB5757' // red - video
  if (ext === 'pdf') return '#EB5757' // red - pdf
  return '#5B8DEF' // blue - default
}

function formatDocumentOpenError(message: string): string {
  const normalized = message.trim()
  if (!normalized) return '无法打开文档：未知错误。'
  if (normalized.startsWith('无法打开文档')) return normalized
  return `无法打开文档：${normalized}`
}

// --- SplitResizeHandle ---
function SplitResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    let lastX = e.clientX

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta !== 0) onResizeRef.current(delta)
    }
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing')
    }

    document.body.classList.add('resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return <div className="resize-handle" onMouseDown={handleMouseDown} />
}

// --- Tab content router ---
function DocumentEditor({
  tab,
  viewMode,
}: {
  tab: DocTab
  viewMode: DocumentViewMode
}) {
  const normalizedViewMode = useMemo(() => normalizeDocumentViewMode(tab.path, viewMode), [tab.path, viewMode])
  const ext = useMemo(() => getFileExt(tab.path), [tab.path])
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext)
  const isPdf = ext === 'pdf'
  const isXlsx = ['xlsx', 'csv', 'xls'].includes(ext)

  if (isImage || isVideo || isPdf) {
    return <FilePreview tab={tab} />
  }

  if (isXlsx) {
    return (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>}>
        <UniverSheet tab={tab} />
      </Suspense>
    )
  }

  // Markdown / text / docx / default
  return (
    <MarkdownEditor
      tab={tab}
      viewMode={normalizedViewMode}
    />
  )
}

// --- DocumentMode main component ---
interface DocumentModeProps {
  isActive?: boolean
  isMotionSettled?: boolean
}

export default function DocumentMode({
  isActive = true,
  isMotionSettled = true,
}: DocumentModeProps) {
  const {
    selectedFile,
    documentOpenError,
    setDocumentOpenError,
    clearDocumentOpenError,
  } = useWorkspace()
  const {
    tabs, activeTabId, splitTabId, splitRatio,
    openTab, closeTab, setActiveTab, setSplitTab, setSplitRatio,
    reorderTabs,
  } = useDocTabs()

  const splitContainerRef = useRef<HTMLDivElement>(null)
  // 映射：edit -> source (源码), preview -> rich (排版)
  const [uiMode, setUiMode] = useState<'edit' | 'preview'>('preview')
  const [hasActivated, setHasActivated] = useState(isActive)

  // 将 UI 模式映射到实际的文档视图模式
  const editorMode: DocumentViewMode = uiMode === 'edit' ? 'source' : 'rich'

  useEffect(() => {
    if (isActive) {
      setHasActivated(true)
    }
  }, [isActive])

  // Open the file selected in SidePanel
  useEffect(() => {
    if (!hasActivated || !selectedFile) {
      if (!selectedFile) clearDocumentOpenError()
      return undefined
    }

    let disposed = false
    void (async () => {
      if (!window.electronAPI?.document?.stat) {
        if (!disposed) {
          setDocumentOpenError(selectedFile, formatDocumentOpenError('当前环境不支持文档状态检查。'))
        }
        return
      }
      const result: {
        success: boolean
        error?: string
        data?: { isDirectory?: boolean }
        stat?: { isDirectory?: boolean }
      } = await window.electronAPI.document.stat(selectedFile).catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : '读取文档状态失败',
      }))
      const isDirectory = result.data?.isDirectory ?? result.stat?.isDirectory ?? false
      if (disposed) return
      if (!result.success) {
        setDocumentOpenError(selectedFile, formatDocumentOpenError(result.error || '读取文档状态失败'))
        return
      }
      if (isDirectory) {
        setDocumentOpenError(selectedFile, formatDocumentOpenError('该路径是目录，无法作为文档打开。'))
        return
      }
      clearDocumentOpenError()
      openTab(selectedFile)
    })()

    return () => {
      disposed = true
    }
  }, [hasActivated, selectedFile, openTab, setDocumentOpenError, clearDocumentOpenError])

  useEffect(() => {
    const handler = () => {
      setUiMode('edit') // 切换到编辑模式（源码）
    }
    window.addEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId)
  const splitTab = splitTabId ? tabs.find(t => t.id === splitTabId) : null
  const activeTabPathLabel = activeTab?.path || activeTab?.title || '未打开文档'
  const resolvedEditorMode = useMemo(
    () => normalizeDocumentViewMode(activeTab?.path ?? null, editorMode),
    [activeTab?.path, editorMode],
  )

  // Tab click handler
  const handleTabClick = useCallback((id: string, e: React.MouseEvent) => {
    if (e.shiftKey && id !== activeTabId) {
      setSplitTab(id)
    } else {
      setActiveTab(id)
    }
  }, [activeTabId, setActiveTab, setSplitTab])

  // Drag & drop reorder
  const dragIndexRef = useRef<number | null>(null)
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    // Attach ready-drag data for cross-component drop (e.g. ChatPanel)
    const tab = tabs[index]
    if (tab && tab.path) {
      const ext = getFileExt(tab.path)
      const data = JSON.stringify({
        type: 'doc-tab' as const,
        path: tab.path,
        name: tab.title,
        ext: ext ? `.${ext}` : undefined,
      })
      e.dataTransfer.setData('application/x-ready-drag', data)
    }
  }, [tabs])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    void index
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndexRef.current !== null && dragIndexRef.current !== index) {
      reorderTabs(dragIndexRef.current, index)
    }
    dragIndexRef.current = null
  }, [reorderTabs])

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null
  }, [])

  // Split resize
  const handleSplitResize = useCallback((delta: number) => {
    if (!splitContainerRef.current) return
    const containerWidth = splitContainerRef.current.offsetWidth
    if (containerWidth <= 0) return
    const deltaPercent = (delta / containerWidth) * 100
    setSplitRatio(splitRatio + deltaPercent)
  }, [splitRatio, setSplitRatio])

  return (
    <div className="workbench-mode-root">
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div className="workbench-canvas-shell flex min-h-0 h-full flex-col">
          <DocumentTabRail
            layoutId="document-tabs"
            tabs={tabs.map((tab) => {
              const isPrimary = tab.id === activeTabId
              const isSplit = tab.id === splitTabId
              const isSplitOnly = isSplit && !isPrimary
              return {
                id: tab.id,
                label: tab.title,
                title: `${tab.title}${isSplit ? ' (分栏)' : ''}\n按住 Shift 点击可分栏`,
                dotColor: isPrimary ? getFileTypeColor(tab.path) : undefined,
                active: isPrimary,
                secondaryActive: isSplitOnly,
                dirty: tab.isDirty,
              }
            })}
            onTabClick={(id, event) => handleTabClick(id, event)}
            onTabClose={(id) => closeTab(id)}
            onNewTab={() => openTab('')}
            onTabDragStart={(event, id) => {
              const index = tabs.findIndex((tab) => tab.id === id)
              if (index >= 0) handleDragStart(event, index)
            }}
            onTabDragOver={handleDragOver}
            onTabDrop={handleDrop}
            onTabDragEnd={handleDragEnd}
            rightActions={
              <DraggableModeSwitch
                mode={uiMode}
                onChange={setUiMode}
              />
            }
          />

          {documentOpenError && (
            <div
              className="mx-3 mt-2 rounded-[8px] px-3 py-2 text-[12px]"
              style={{
                background: 'var(--color-orange-light)',
                color: 'var(--color-orange)',
              }}
            >
              {documentOpenError}
            </div>
          )}

          <div
            className="document-path-bar flex items-center min-w-0"
            style={{
              height: 30,
              paddingLeft: 18,
              paddingRight: 18,
              background: 'var(--workbench-liquid-chrome-bg, color-mix(in srgb, var(--bg-content) 18%, transparent))',
            }}
          >
            <div
              className="min-w-0 ml-auto"
              style={{
                fontSize: 11,
                color: 'var(--text-light)',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textAlign: 'right',
              }}
              title={activeTabPathLabel}
            >
              {activeTabPathLabel}
            </div>
          </div>

          {/* Content Area */}
          {splitTab && activeTab ? (
            <div className="flex-1 flex min-w-0 overflow-hidden" ref={splitContainerRef} style={{ gap: 10 }}>
              <div
                className="flex flex-col min-w-0 overflow-hidden"
                style={{ flexBasis: `${splitRatio}%`, flexShrink: 0, flexGrow: 0 }}
              >
                <DocumentEditor
                  key={activeTab.id}
                  tab={activeTab}
                  viewMode={resolvedEditorMode}
                />
              </div>
              <SplitResizeHandle onResize={handleSplitResize} />
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <DocumentEditor
                  key={splitTab.id}
                  tab={splitTab}
                  viewMode={resolvedEditorMode}
                />
              </div>
            </div>
          ) : activeTab ? (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <DocumentEditor
                key={activeTab.id}
                tab={activeTab}
                viewMode={resolvedEditorMode}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
              <div className="text-center">
                <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-[13px]">点击左侧文件打开文档</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
