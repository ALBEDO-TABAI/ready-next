import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { FileText, X, Plus, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import MarkdownEditor from '../../components/document/MarkdownEditor'
import FilePreview from '../../components/document/FilePreview'
import { MorphTabButton, MorphTabStrip } from '../../components/motion/MorphTabStrip'

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
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

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
    setDropTargetIndex(index)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndexRef.current !== null && dragIndexRef.current !== index) {
      reorderTabs(dragIndexRef.current, index)
    }
    dragIndexRef.current = null
    setDropTargetIndex(null)
  }, [reorderTabs])

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null
    setDropTargetIndex(null)
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
      {/* Tab Bar & Header Row */}
      <div
        className="glass-surface-panel flex items-center justify-between flex-shrink-0"
        style={{
          height: 42,
          background: 'var(--surface-toolbar-bg)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        {/* Left: File Tabs */}
        <div className="flex items-end h-full min-w-0 flex-1 overflow-hidden" style={{ paddingLeft: 8 }}>
          <MorphTabStrip
            layoutId="document-tabs"
            className="flex items-end h-full min-w-0 flex-1 overflow-hidden gap-[1px]"
          >
            {tabs.map((tab, index) => {
              const isPrimary = tab.id === activeTabId
              const isSplit = tab.id === splitTabId
              const isSplitOnly = isSplit && !isPrimary
              const isActive = isPrimary || isSplitOnly
              const showDropIndicator = dropTargetIndex === index && dragIndexRef.current !== null && dragIndexRef.current !== index
              const dotColor = getFileTypeColor(tab.path)
              return (
                <div key={tab.id} className="relative flex items-end min-w-0 flex-1 max-w-[220px]">
                  {showDropIndicator && (
                    <div
                      className="absolute left-0 top-[6px] bottom-[2px] w-[2px] rounded-full"
                      style={{ background: 'var(--color-blue)', zIndex: 10 }}
                    />
                  )}
                  <MorphTabButton
                    layoutId="document-tabs"
                    active={isPrimary}
                    secondaryActive={isSplitOnly}
                    onClick={(e) => handleTabClick(tab.id, e)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    className="group flex w-full min-w-0 items-center rounded-t-[8px] text-[12px] transition-all duration-150 ease-out"
                    style={{
                      gap: 6,
                      padding: '6px 12px',
                      cursor: 'grab',
                      marginBottom: -1,
                      background: isActive ? 'var(--surface-card-bg)' : 'transparent',
                      color: isActive ? 'var(--text-body)' : 'var(--text-muted)',
                      border: '1px solid var(--border-default)',
                      borderBottom: isPrimary
                        ? '1px solid var(--surface-card-bg)'
                        : isSplitOnly
                          ? '2px solid var(--color-blue)'
                          : '1px solid var(--border-default)',
                    }}
                    contentClassName="relative z-[1] flex min-w-0 flex-1 items-center gap-[6px]"
                    title={`${tab.title}${isSplit ? ' (分栏)' : ''}\n按住 Shift 点击可分栏`}
                  >
                    <span
                      className="flex-shrink-0 rounded-full"
                      style={{ width: 8, height: 8, background: dotColor }}
                    />
                    <span className="truncate flex-1 min-w-0">
                      {tab.title}
                      {tab.isDirty && <span className="ml-0.5" style={{ color: 'var(--text-light)' }}>●</span>}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                      className="rounded transition-all duration-150 ease-out cursor-pointer opacity-0 group-hover:opacity-100 flex-shrink-0 active:scale-[0.95]"
                      style={{ padding: 2, color: 'var(--text-light)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-body)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-light)')}
                    >
                      <X style={{ width: 11, height: 11 }} strokeWidth={2} />
                    </span>
                  </MorphTabButton>
                </div>
              )
            })}
          </MorphTabStrip>

          {/* Add tab button */}
          <button
            onClick={() => openTab('')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, marginLeft: 2, marginBottom: 3 }}
            title="新建文档"
          >
            <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={1.8} />
          </button>
        </div>

        {/* Right: Edit/Preview Switcher */}
        <div className="flex items-center flex-shrink-0" style={{ paddingRight: 16 }}>
          <div
            className="glass-surface-card flex items-center"
            style={{
              background: 'var(--surface-card-bg)',
              borderRadius: 6,
              padding: 2,
              border: '1px solid var(--surface-border)',
            }}
          >
            {(['edit', 'preview'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setEditorMode(mode)}
                className="transition-all duration-150 ease-out"
                style={{
                  padding: '3px 10px',
                  fontSize: 12,
                  borderRadius: 4,
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
