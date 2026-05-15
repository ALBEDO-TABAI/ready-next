import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
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
import { useRafResizeDrag } from '../../modules/workbench/useRafResizeDrag'
import { freezeVisibleDocumentLayoutWidths } from '../../modules/document/documentLayoutFreeze'
import {
  captureMarkdownLineAnchor,
  resolveMarkdownLineFromAnchor,
  type DocumentScrollAnchorSnapshot,
} from '../../modules/document/documentScrollAnchor'
import { getFileExtension } from '../../utils/path'
import { isEbookExtension } from '../../../shared/ebook'

const UniverSheet = lazy(() => import('../../components/document/UniverSheet'))

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return getFileExtension(path)
}

function estimateTextareaLineHeight(element: HTMLElement): number {
  const styles = window.getComputedStyle(element)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.6 : 24
}

function captureTextareaAnchor(element: HTMLElement, content: string): Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'> | null {
  if (!(element instanceof HTMLTextAreaElement)) return null
  const lineNumber = Math.floor(element.scrollTop / estimateTextareaLineHeight(element)) + 1
  const anchor = captureMarkdownLineAnchor(content, lineNumber)
  return anchor
    ? { anchorTitle: anchor.title, anchorOrdinal: anchor.ordinal, anchorProgress: anchor.progress }
    : null
}

function getElementContentOffset(container: HTMLElement, child: HTMLElement): number {
  const containerRect = container.getBoundingClientRect()
  const childRect = child.getBoundingClientRect()
  return childRect.top - containerRect.top + container.scrollTop
}

function capturePreviewAnchor(element: HTMLElement): Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'> | null {
  const headings = Array.from(element.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
  if (headings.length === 0) return null
  const headingCounts = new Map<string, number>()
  const contentTop = element.scrollTop + 8
  let nearest: HTMLElement | null = null
  let nearestIndex = 0
  const ordinals = headings.map((heading) => {
    const title = heading.dataset.readyHeadingTitle || ''
    const ordinal = headingCounts.get(title) || 0
    headingCounts.set(title, ordinal + 1)
    return ordinal
  })
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    const top = getElementContentOffset(element, heading)
    if (top <= contentTop + 16) {
      nearest = heading
      nearestIndex = index
      continue
    }
    if (!nearest) {
      nearest = heading
      nearestIndex = index
    }
    break
  }
  if (!nearest) return null
  const sectionStart = getElementContentOffset(element, nearest)
  const nextHeading = headings[nearestIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading)
    : Math.max(element.scrollHeight, sectionStart + element.clientHeight)
  const sectionLength = Math.max(1, sectionEnd - sectionStart)
  const progress = Math.max(0, Math.min(1, (contentTop - sectionStart) / sectionLength))
  return {
    anchorTitle: nearest.dataset.readyHeadingTitle || null,
    anchorOrdinal: ordinals[nearestIndex] || 0,
    anchorProgress: progress,
  }
}

function captureElementScroll(element: HTMLElement, content: string): DocumentScrollAnchorSnapshot {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  const top = Math.max(0, Math.min(element.scrollTop, maxScroll))
  const anchor = captureTextareaAnchor(element, content) || capturePreviewAnchor(element)
  return {
    top,
    ratio: maxScroll > 0 ? top / maxScroll : 0,
    maxScroll,
    anchorTitle: anchor?.anchorTitle || null,
    anchorOrdinal: anchor?.anchorOrdinal ?? null,
    anchorProgress: anchor?.anchorProgress ?? null,
  }
}

function restoreAnchorScroll(element: HTMLElement, snapshot: DocumentScrollAnchorSnapshot, content: string): boolean {
  if (!snapshot.anchorTitle) return false

  if (element instanceof HTMLTextAreaElement) {
    const line = resolveMarkdownLineFromAnchor(content, snapshot)
    if (!line) return false
    element.scrollTop = Math.max(0, Math.round((line - 1) * estimateTextareaLineHeight(element)))
    return true
  }

  const headings = Array.from(element.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
  let seenOrdinal = 0
  const targetIndex = headings.findIndex((heading) => {
    if (heading.dataset.readyHeadingTitle !== snapshot.anchorTitle) return false
    const matches = seenOrdinal === (snapshot.anchorOrdinal || 0)
    seenOrdinal += 1
    return matches
  })
  const target = targetIndex >= 0 ? headings[targetIndex] : null
  if (!target) return false
  const sectionStart = getElementContentOffset(element, target)
  const nextHeading = headings[targetIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading)
    : Math.max(element.scrollHeight, sectionStart + element.clientHeight)
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  const progress = Math.max(0, Math.min(1, snapshot.anchorProgress ?? 0))
  const nextTop = sectionStart + (sectionEnd - sectionStart) * progress - 8
  element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
  return true
}

function restoreElementScroll(element: HTMLElement, snapshot: DocumentScrollAnchorSnapshot, content: string) {
  const restore = () => {
    if (restoreAnchorScroll(element, snapshot, content)) return
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
    const nextTop = snapshot.maxScroll === maxScroll ? snapshot.top : snapshot.ratio * maxScroll
    element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
  }
  restore()
  requestAnimationFrame(restore)
  requestAnimationFrame(() => requestAnimationFrame(restore))
  window.setTimeout(restore, 160)
  window.setTimeout(restore, 420)
}

function findScrollCandidates(scope: HTMLElement): HTMLElement[] {
  return [
    scope.querySelector('textarea'),
    scope.querySelector('.document-preview-surface'),
    scope.querySelector('.document-editor-surface'),
    scope,
  ].filter((element): element is HTMLElement => element instanceof HTMLElement)
}

function findCurrentScrollElement(scope: HTMLElement): HTMLElement | null {
  const candidates = findScrollCandidates(scope)
  return candidates.find((element) => element.scrollTop > 0)
    || candidates.find((element) => element.scrollHeight > element.clientHeight)
    || null
}

function clampDocumentSplitRatio(ratio: number): number {
  return Math.max(20, Math.min(80, ratio))
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
function SplitResizeHandle({
  onResize,
  onResizeStateChange,
}: {
  onResize: (delta: number) => void
  onResizeStateChange?: (resizing: boolean) => void
}) {
  const handleMouseDown = useRafResizeDrag({ onDelta: onResize, onResizeStateChange })
  return (
    <div
      className="document-split-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整文档分栏宽度"
      onMouseDown={handleMouseDown}
    >
      <span className="document-split-resize-handle__grip" aria-hidden="true" />
    </div>
  )
}

// --- Tab content router ---
function DocumentEditor({
  tab,
  viewMode,
  previewFocusWidgetTitle,
}: {
  tab: DocTab
  viewMode: 'edit' | 'preview'
  previewFocusWidgetTitle?: string | null
}) {
  const ext = useMemo(() => getFileExt(tab.path), [tab.path])
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext)
  const isPdf = ext === 'pdf'
  const isEbook = isEbookExtension(ext)
  const isXlsx = ['xlsx', 'csv', 'xls'].includes(ext)

  if (isImage || isVideo || isPdf || isEbook) {
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
      viewMode={viewMode}
      previewFocusWidgetTitle={previewFocusWidgetTitle}
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
  const { selectedFile } = useWorkspace()
  const {
    tabs, activeTabId, splitTabId, documentSplitRatio,
    openTab, closeTab, setActiveTab, setSplitTab, setDocumentSplitRatio,
    reorderTabs,
  } = useDocTabs()

  const splitContainerRef = useRef<HTMLDivElement>(null)
  const primarySplitPaneRef = useRef<HTMLDivElement>(null)
  const scrollSnapshotsRef = useRef<Map<string, DocumentScrollAnchorSnapshot>>(new Map())
  const documentSplitRatioRef = useRef(documentSplitRatio)
  const liveDocumentSplitRatioRef = useRef(documentSplitRatio)
  const restoreDocumentLayoutFreezeRef = useRef<(() => void) | null>(null)
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('edit')
  const [previewFocusWidgetTitle, setPreviewFocusWidgetTitle] = useState<string | null>(null)
  const [hasActivated, setHasActivated] = useState(isActive)

  useEffect(() => {
    if (isActive) {
      setHasActivated(true)
    }
  }, [isActive])

  useEffect(() => {
    const nextRatio = clampDocumentSplitRatio(documentSplitRatio)
    documentSplitRatioRef.current = nextRatio
    liveDocumentSplitRatioRef.current = nextRatio
    if (primarySplitPaneRef.current) {
      primarySplitPaneRef.current.style.flexBasis = `${nextRatio}%`
    }
  }, [documentSplitRatio])

  // Open the file selected in SidePanel
  useEffect(() => {
    if (!hasActivated || !selectedFile) return undefined

    let disposed = false
    void (async () => {
      if (!window.electronAPI?.document?.stat) {
        openTab(selectedFile)
        return
      }
      const result = await window.electronAPI.document.stat(selectedFile).catch(() => null)
      const isDirectory = result?.data?.isDirectory ?? result?.stat?.isDirectory ?? false
      if (!disposed && result?.success && !isDirectory) {
        openTab(selectedFile)
      }
    })()

    return () => {
      disposed = true
    }
  }, [hasActivated, selectedFile, openTab])

  useEffect(() => {
    const handler = () => {
      setEditorMode('edit')
    }
    window.addEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId)
  const splitTab = splitTabId ? tabs.find(t => t.id === splitTabId) : null
  const activeTabPathLabel = activeTab?.path || activeTab?.title || '未打开文档'
  const tabByScrollKey = useMemo(() => {
    const next = new Map<string, DocTab>()
    tabs.forEach((tab) => next.set(tab.path || tab.id, tab))
    return next
  }, [tabs])

  const captureVisibleDocumentScrollPositions = useCallback(() => {
    document.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => {
      const key = scope.dataset.readyDocumentScrollKey
      if (!key) return
      const element = findCurrentScrollElement(scope)
      if (!element) return
      scrollSnapshotsRef.current.set(key, captureElementScroll(element, tabByScrollKey.get(key)?.content || ''))
    })
  }, [tabByScrollKey])

  const restoreVisibleDocumentScrollPositions = useCallback(() => {
    document.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => {
      const key = scope.dataset.readyDocumentScrollKey
      if (!key) return
      const snapshot = scrollSnapshotsRef.current.get(key)
      if (!snapshot) return
      const content = tabByScrollKey.get(key)?.content || ''
      findScrollCandidates(scope).forEach((element) => restoreElementScroll(element, snapshot, content))
    })
  }, [tabByScrollKey])

  useLayoutEffect(() => {
    restoreVisibleDocumentScrollPositions()
  }, [activeTabId, editorMode, restoreVisibleDocumentScrollPositions, splitTabId])

  const handleEditorModeChange = useCallback((nextMode: 'edit' | 'preview') => {
    if (nextMode === editorMode) return
    captureVisibleDocumentScrollPositions()
    setEditorMode(nextMode)
  }, [captureVisibleDocumentScrollPositions, editorMode])

  // Tab click handler
  const handleTabClick = useCallback((id: string, e: React.MouseEvent) => {
    captureVisibleDocumentScrollPositions()
    if (e.shiftKey && id !== activeTabId) {
      setSplitTab(id)
    } else {
      setActiveTab(id)
    }
  }, [activeTabId, captureVisibleDocumentScrollPositions, setActiveTab, setSplitTab])

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
    const nextRatio = clampDocumentSplitRatio(liveDocumentSplitRatioRef.current + deltaPercent)
    liveDocumentSplitRatioRef.current = nextRatio
    if (primarySplitPaneRef.current) {
      primarySplitPaneRef.current.style.flexBasis = `${nextRatio}%`
    }
  }, [])

  const handleSplitResizeStateChange = useCallback((resizing: boolean) => {
    if (resizing) {
      captureVisibleDocumentScrollPositions()
      restoreDocumentLayoutFreezeRef.current?.()
      restoreDocumentLayoutFreezeRef.current = freezeVisibleDocumentLayoutWidths()
      liveDocumentSplitRatioRef.current = documentSplitRatioRef.current
      primarySplitPaneRef.current?.style.setProperty('will-change', 'flex-basis')
      return
    }

    primarySplitPaneRef.current?.style.removeProperty('will-change')
    const nextRatio = clampDocumentSplitRatio(liveDocumentSplitRatioRef.current)
    documentSplitRatioRef.current = nextRatio
    setDocumentSplitRatio(nextRatio)
    restoreDocumentLayoutFreezeRef.current?.()
    restoreDocumentLayoutFreezeRef.current = null
    requestAnimationFrame(restoreVisibleDocumentScrollPositions)
  }, [captureVisibleDocumentScrollPositions, restoreVisibleDocumentScrollPositions, setDocumentSplitRatio])

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
                mode={editorMode}
                onChange={handleEditorModeChange}
              />
            }
          />

          <div
            className="document-path-bar flex items-center min-w-0"
            style={{
              height: 30,
              paddingLeft: 18,
              paddingRight: 18,
              background: 'var(--workbench-module-surface-bg)',
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
            <div className="flex-1 flex min-w-0 overflow-hidden" ref={splitContainerRef} style={{ gap: 0 }}>
              <div
                ref={primarySplitPaneRef}
                className="flex flex-col min-w-0 overflow-hidden"
                style={{ flexBasis: `${documentSplitRatio}%`, flexShrink: 0, flexGrow: 0 }}
              >
                <DocumentEditor
                  key={activeTab.id}
                  tab={activeTab}
                  viewMode={editorMode}
                  previewFocusWidgetTitle={previewFocusWidgetTitle}
                />
              </div>
              <SplitResizeHandle
                onResize={handleSplitResize}
                onResizeStateChange={handleSplitResizeStateChange}
              />
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <DocumentEditor
                  key={splitTab.id}
                  tab={splitTab}
                  viewMode={editorMode}
                  previewFocusWidgetTitle={previewFocusWidgetTitle}
                />
              </div>
            </div>
          ) : activeTab ? (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <DocumentEditor
                key={activeTab.id}
                tab={activeTab}
                viewMode={editorMode}
                previewFocusWidgetTitle={previewFocusWidgetTitle}
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
