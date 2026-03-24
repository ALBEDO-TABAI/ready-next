import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import MarkdownEditor from '../../components/document/MarkdownEditor'
import FilePreview from '../../components/document/FilePreview'
import WorkbenchProjectTabs from '../../components/workbench/WorkbenchProjectTabs'
import { READY_DOCUMENT_REVEAL_EVENT } from '../../modules/agent/document-quote-navigation'
import { getFileExtension } from '../../utils/path'
import {
  getDocumentViewModeOptions,
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
export default function DocumentMode() {
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
  const [editorMode, setEditorMode] = useState<DocumentViewMode>('rich')

  // Open the file selected in SidePanel
  useEffect(() => {
    if (!selectedFile) {
      clearDocumentOpenError()
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
  }, [selectedFile, openTab, setDocumentOpenError, clearDocumentOpenError])

  useEffect(() => {
    const handler = () => {
      setEditorMode('source')
    }
    window.addEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId)
  const splitTab = splitTabId ? tabs.find(t => t.id === splitTabId) : null
  const activeTabPathLabel = activeTab?.path || activeTab?.title || '未打开文档'
  const availableViewModes = useMemo(
    () => getDocumentViewModeOptions(activeTab?.path ?? null),
    [activeTab?.path],
  )
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
      <div className="flex-1 min-h-0 px-3 pb-3 pt-2">
        <div className="workbench-canvas-shell flex min-h-0 h-full flex-col">
          <WorkbenchProjectTabs
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
            rightActions={availableViewModes.length > 1 ? (
              <div
                className="glass-surface-card flex items-center"
                style={{
                  background: 'var(--bg-content)',
                  borderRadius: 8,
                  padding: 2,
                  border: '1px solid transparent',
                  height: 30,
                }}
              >
                {availableViewModes.map((mode) => (
                  <button
                    key={mode.mode}
                    onClick={() => setEditorMode(mode.mode)}
                    className="transition-all duration-150 ease-out"
                    title={mode.description}
                    style={{
                      padding: '0 12px',
                      height: 26,
                      fontSize: 12,
                      borderRadius: 6,
                      fontWeight: 500,
                      ...(resolvedEditorMode === mode.mode ? {
                        background: 'var(--color-blue-light)',
                        color: 'var(--color-blue)',
                        boxShadow: 'none',
                        border: '1px solid transparent',
                      } : {
                        background: 'transparent',
                        color: 'var(--text-muted)',
                        border: '1px solid transparent',
                      }),
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            ) : undefined}
          />

          {documentOpenError && (
            <div
              className="mx-3 mt-2 rounded-[8px] px-3 py-2 text-[12px]"
              style={{
                background: 'var(--color-orange-light)',
                color: 'var(--color-orange)',
              }}
              title={documentOpenError.path}
            >
              {documentOpenError.message}
            </div>
          )}

          <div
            className="flex items-center min-w-0"
            style={{
              height: 30,
              paddingLeft: 18,
              paddingRight: 18,
              background: 'var(--bg-content)',
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
