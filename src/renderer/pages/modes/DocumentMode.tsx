import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import MarkdownEditor from '../../components/document/MarkdownEditor'
import FilePreview from '../../components/document/FilePreview'
import WorkbenchProjectTabs from '../../components/workbench/WorkbenchProjectTabs'
import { WORKBENCH_ROW_PADDING_X, WORKBENCH_TOOLBAR_ROW_HEIGHT } from '../../modules/workbench/chrome'

const UniverSheet = lazy(() => import('../../components/document/UniverSheet'))

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return (path.split('/').pop() || '').split('.').pop()?.toLowerCase() || ''
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
function DocumentEditor({ tab, viewMode }: { tab: DocTab; viewMode: 'edit' | 'preview' }) {
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
  return <MarkdownEditor tab={tab} viewMode={viewMode} />
}

// --- DocumentMode main component ---
export default function DocumentMode() {
  const { selectedFile } = useWorkspace()
  const {
    tabs, activeTabId, splitTabId, splitRatio,
    openTab, closeTab, setActiveTab, setSplitTab, setSplitRatio,
    reorderTabs,
  } = useDocTabs()

  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit')

  // Open the file selected in SidePanel
  useEffect(() => {
    if (selectedFile) {
      openTab(selectedFile)
    }
  }, [selectedFile, openTab])

  const activeTab = tabs.find(t => t.id === activeTabId)
  const splitTab = splitTabId ? tabs.find(t => t.id === splitTabId) : null

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
            dotColor: getFileTypeColor(tab.path),
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
      />

      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{
          height: WORKBENCH_TOOLBAR_ROW_HEIGHT,
          padding: `0 ${WORKBENCH_ROW_PADDING_X}px`,
          background: 'var(--bg-primary)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <div
          className="glass-surface-card flex items-center"
          style={{
            background: 'var(--surface-card-bg)',
            borderRadius: 8,
            padding: 2,
            border: '1px solid var(--surface-border)',
            height: Math.max(30, WORKBENCH_TOOLBAR_ROW_HEIGHT - 6),
          }}
        >
          {(['edit', 'preview'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setEditorMode(mode)}
              className="transition-all duration-150 ease-out"
              style={{
                padding: '0 12px',
                height: 28,
                fontSize: 12,
                borderRadius: 6,
                fontWeight: 500,
                ...(editorMode === mode ? {
                  background: 'var(--surface-floating-bg)',
                  color: 'var(--text-body)',
                  boxShadow: 'var(--lg-shadow-contact)',
                  border: '1px solid var(--surface-border)',
                } : {
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid transparent',
                }),
              }}
            >
              {mode === 'edit' ? '编辑' : '预览'}
            </button>
          ))}
        </div>

        <div
          style={{
            fontSize: 12,
            color: 'var(--text-light)',
            maxWidth: 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={activeTab?.path || activeTab?.title || '未打开文档'}
        >
          {activeTab?.path || activeTab?.title || '未打开文档'}
        </div>
      </div>

      {/* Content Area */}
      {splitTab && activeTab ? (
        <div className="flex-1 flex min-w-0 overflow-hidden" ref={splitContainerRef}>
          <div
            className="flex flex-col min-w-0 overflow-hidden"
            style={{ flexBasis: `${splitRatio}%`, flexShrink: 0, flexGrow: 0 }}
          >
            <DocumentEditor key={activeTab.id} tab={activeTab} viewMode={editorMode} />
          </div>
          <SplitResizeHandle onResize={handleSplitResize} />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <DocumentEditor key={splitTab.id} tab={splitTab} viewMode={editorMode} />
          </div>
        </div>
      ) : activeTab ? (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <DocumentEditor key={activeTab.id} tab={activeTab} viewMode={editorMode} />
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
  )
}
