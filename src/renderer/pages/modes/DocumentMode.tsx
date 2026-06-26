import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { computeDesiredRoots, useWorkspace } from '../../stores/useWorkspace'
import { isImagePreviewPath, useDocTabs, type DocTab, type DocumentPaneTarget } from '../../stores/useDocTabs'
import MarkdownEditor from '../../components/document/MarkdownEditor'
import DocumentTabRail from '../../components/document/DocumentTabRail'
import FilePreview from '../../components/document/FilePreview'
import DraggableModeSwitch from '../../components/document/DraggableModeSwitch'
import DocumentFloatingPanels, { DocumentPanelToggleButtons } from '../../components/document/DocumentFloatingPanels'
import { READY_DOCUMENT_REVEAL_EVENT } from '../../modules/agent/document-quote-navigation'
import {
  addReadyContextReferenceToAgentInput,
  showReferenceToInputMenu,
} from '../../modules/agent/chat-input-bridge'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
} from '../../modules/workbench/chrome'
import { useRafResizeDrag } from '../../modules/workbench/useRafResizeDrag'
import { freezeVisibleDocumentLayoutWidths } from '../../modules/document/documentLayoutFreeze'
import {
  captureMarkdownLineAnchor,
  readDocumentReadingPositionMap,
  resolveMarkdownLineFromAnchor,
  saveDocumentReadingPosition,
  type DocumentScrollAnchorSnapshot,
} from '../../modules/document/documentScrollAnchor'
import {
  isReloadableTextDocumentPath,
  shouldRefreshDocumentTabForDirectoryChange,
} from '../../modules/document/documentExternalRefresh'
import {
  canAcceptDocumentPaneDrop,
  getDocumentPaneDropPath,
} from '../../modules/document/documentPaneDrop'
import { startBrowserLocalMediaNativeFileDrag } from '../../modules/browser/localMediaDragBridge'
import { getFileExtension } from '../../utils/path'
import { isEbookExtension } from '../../../shared/ebook'
import { isReadyBoardFile } from '../../../shared/ready-board'
import type { FileEmergenceReadingProgressKind } from '../../../shared/file-emergence'
import { isLocalHtmlFilePath } from '../../modules/browser/localHtmlFileOpen'
import {
  recordFileEmergenceActivity,
  recordFileEmergenceReadingSession,
} from '../../modules/file-emergence/fileEmergenceClient'
import {
  isReadingSessionPath,
  readProgressForPath,
} from '../../modules/file-emergence/readingIntentContext'

const UniverSheet = lazy(() => import('../../components/document/UniverSheet'))
const BoardEditor = lazy(() => import('../../components/document/BoardEditor'))

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

function getElementContentOffset(container: HTMLElement, child: HTMLElement, containerTop?: number): number {
  const resolvedContainerTop = containerTop ?? container.getBoundingClientRect().top
  const childRect = child.getBoundingClientRect()
  return childRect.top - resolvedContainerTop + container.scrollTop
}

type ReadingSessionDraft = {
  path: string
  startedAt: number
  lastInteractionAt: number
  activeMs: number
  progressStart: number | null
  progressKind: FileEmergenceReadingProgressKind | null
}

const READING_SESSION_IDLE_TIMEOUT_MS = 120_000
const READING_SESSION_MIN_ACTIVE_MS = 30_000

function captureReadingProgress(path: string): {
  ratio: number | null
  kind: FileEmergenceReadingProgressKind | null
} {
  const progress = readProgressForPath(path)
  return {
    ratio: typeof progress?.progressRatio === 'number' ? progress.progressRatio : null,
    kind: progress?.kind ?? null,
  }
}

function capturePreviewAnchor(element: HTMLElement): Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'> | null {
  const headings = Array.from(element.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
  if (headings.length === 0) return null
  const headingCounts = new Map<string, number>()
  const contentTop = element.scrollTop + 8
  const containerTop = element.getBoundingClientRect().top
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
    const top = getElementContentOffset(element, heading, containerTop)
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
  const sectionStart = getElementContentOffset(element, nearest, containerTop)
  const nextHeading = headings[nearestIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading, containerTop)
    : Math.max(element.scrollHeight, sectionStart + element.clientHeight)
  const sectionLength = Math.max(1, sectionEnd - sectionStart)
  const progress = Math.max(0, Math.min(1, (contentTop - sectionStart) / sectionLength))
  return {
    anchorTitle: nearest.dataset.readyHeadingTitle || null,
    anchorOrdinal: ordinals[nearestIndex] || 0,
    anchorProgress: progress,
  }
}

function captureElementScroll(
  element: HTMLElement,
  content: string,
  options?: { includeAnchor?: boolean },
): DocumentScrollAnchorSnapshot {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  const top = Math.max(0, Math.min(element.scrollTop, maxScroll))
  const anchor = options?.includeAnchor === false
    ? null
    : captureTextareaAnchor(element, content) || capturePreviewAnchor(element)
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
  const containerTop = element.getBoundingClientRect().top
  let seenOrdinal = 0
  const targetIndex = headings.findIndex((heading) => {
    if (heading.dataset.readyHeadingTitle !== snapshot.anchorTitle) return false
    const matches = seenOrdinal === (snapshot.anchorOrdinal || 0)
    seenOrdinal += 1
    return matches
  })
  const target = targetIndex >= 0 ? headings[targetIndex] : null
  if (!target) return false
  const sectionStart = getElementContentOffset(element, target, containerTop)
  const nextHeading = headings[targetIndex + 1] || null
  const sectionEnd = nextHeading
    ? getElementContentOffset(element, nextHeading, containerTop)
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
  window.setTimeout(restore, 900)
  window.setTimeout(restore, 1600)
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
  if (['md', 'txt', 'docx'].includes(ext)) return 'var(--ready-document-tab-doc-dot, #E97A2B)' // orange - docs
  if (['xlsx', 'csv', 'xls'].includes(ext)) return '#34D399' // green - sheets
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '#8B5CF6' // purple - images
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return '#EB5757' // red - video
  if (ext === 'pdf') return '#EB5757' // red - pdf
  return '#5B8DEF' // blue - default
}

function readDocumentPanelOpenState(key: string): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage?.getItem(key) === '1'
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
  onVisibleLineChange,
  onActivate,
}: {
  tab: DocTab
  viewMode: 'edit' | 'preview'
  previewFocusWidgetTitle?: string | null
  onVisibleLineChange?: (line: number | null) => void
  onActivate?: () => void
}) {
  const ext = useMemo(() => getFileExt(tab.path), [tab.path])
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext)
  const isPdf = ext === 'pdf'
  const isEbook = isEbookExtension(ext)
  const isXlsx = ['xlsx', 'csv', 'xls'].includes(ext)

  if (isReadyBoardFile(tab.path)) {
    return (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>}>
        <BoardEditor tab={tab} />
      </Suspense>
    )
  }

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
      onVisibleLineChange={onVisibleLineChange}
      onActivate={onActivate}
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
  const { selectedFile, workspaceRoot, pinnedFolders } = useWorkspace()
  const {
    tabs, activeTabId, splitTabId, documentSplitRatio,
    openTab, closeTab, setActiveTab, setSplitTab, setDocumentSplitRatio,
    reorderTabs, updateTabContent, markTabSaved, setPendingReveal, openTabInPane,
    openImageTab, ensureTabForPath,
  } = useDocTabs()

  const splitContainerRef = useRef<HTMLDivElement>(null)
  const primarySplitPaneRef = useRef<HTMLDivElement>(null)
  const scrollSnapshotsRef = useRef<Map<string, DocumentScrollAnchorSnapshot>>(readDocumentReadingPositionMap())
  const documentSplitRatioRef = useRef(documentSplitRatio)
  const liveDocumentSplitRatioRef = useRef(documentSplitRatio)
  const restoreDocumentLayoutFreezeRef = useRef<(() => void) | null>(null)
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('preview')
  const [previewFocusWidgetTitle, setPreviewFocusWidgetTitle] = useState<string | null>(null)
  const [hasActivated, setHasActivated] = useState(isActive)
  const [outlinePanelOpen, setOutlinePanelOpen] = useState(() => readDocumentPanelOpenState('ready-document-outline-panel-open'))
  const [marksPanelOpen, setMarksPanelOpen] = useState(() => readDocumentPanelOpenState('ready-document-marks-panel-open'))
  const [panelTargetTabId, setPanelTargetTabId] = useState<string | null>(activeTabId)
  const [visibleLineByTabId, setVisibleLineByTabId] = useState<Record<string, number | null>>({})
  const [documentPaneDropTarget, setDocumentPaneDropTarget] = useState<DocumentPaneTarget | null>(null)
  const documentWorkspaceRoots = useMemo(
    () => computeDesiredRoots({ workspaceRoot, pinnedFolders }),
    [pinnedFolders, workspaceRoot],
  )
  const documentWorkspaceRootsRef = useRef<string[]>(documentWorkspaceRoots)
  const readingSessionRef = useRef<ReadingSessionDraft | null>(null)

  useEffect(() => {
    documentWorkspaceRootsRef.current = documentWorkspaceRoots
  }, [documentWorkspaceRoots])

  useEffect(() => {
    if (isActive) {
      setHasActivated(true)
    }
  }, [isActive])

  useEffect(() => {
    window.localStorage?.setItem('ready-document-outline-panel-open', outlinePanelOpen ? '1' : '0')
  }, [outlinePanelOpen])

  useEffect(() => {
    window.localStorage?.setItem('ready-document-marks-panel-open', marksPanelOpen ? '1' : '0')
  }, [marksPanelOpen])

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
        setEditorMode('preview')
        openTab(selectedFile)
        return
      }
      const result = await window.electronAPI.document.stat(selectedFile).catch(() => null)
      const isDirectory = result?.data?.isDirectory ?? result?.stat?.isDirectory ?? false
      if (!disposed && result?.success && !isDirectory && !isLocalHtmlFilePath(selectedFile)) {
        setEditorMode('preview')
        const activeTab = tabs.find((tab) => tab.id === activeTabId)
        const keepBoardActive = isReadyBoardFile(activeTab?.path) && !isReadyBoardFile(selectedFile)
        if (isImagePreviewPath(selectedFile)) {
          openImageTab(selectedFile, { activate: !keepBoardActive })
        } else if (keepBoardActive) {
          ensureTabForPath(selectedFile)
        } else {
          openTab(selectedFile)
        }
        await recordFileEmergenceActivity({
          path: selectedFile,
          eventType: 'open',
          source: 'document_mode',
          workspaceRoots: documentWorkspaceRoots,
        })
      }
    })()

    return () => {
      disposed = true
    }
  }, [activeTabId, documentWorkspaceRoots, ensureTabForPath, hasActivated, openImageTab, openTab, selectedFile, tabs])

  useEffect(() => {
    const handler = () => {
      setEditorMode('edit')
    }
    window.addEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_DOCUMENT_REVEAL_EVENT, handler as EventListener)
  }, [])

  useEffect(() => {
    const clearDropTarget = () => setDocumentPaneDropTarget(null)
    window.addEventListener('dragend', clearDropTarget)
    window.addEventListener('drop', clearDropTarget)
    return () => {
      window.removeEventListener('dragend', clearDropTarget)
      window.removeEventListener('drop', clearDropTarget)
    }
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId)
  const splitTab = splitTabId ? tabs.find(t => t.id === splitTabId) : null
  const activeTabPathLabel = activeTab?.path || activeTab?.title || '未打开文档'
  const panelTargetTab = useMemo(() => {
    const visibleTabs = [activeTab, splitTab].filter((tab): tab is DocTab => Boolean(tab))
    return visibleTabs.find((tab) => tab.id === panelTargetTabId) || activeTab || splitTab || null
  }, [activeTab, panelTargetTabId, splitTab])
  const panelTargetLine = panelTargetTab ? visibleLineByTabId[panelTargetTab.id] ?? null : null
  const tabByScrollKey = useMemo(() => {
    const next = new Map<string, DocTab>()
    tabs.forEach((tab) => next.set(tab.path || tab.id, tab))
    return next
  }, [tabs])

  useEffect(() => {
    const visibleIds = [activeTab?.id, splitTab?.id].filter((id): id is string => Boolean(id))
    setPanelTargetTabId((current) => (current && visibleIds.includes(current) ? current : activeTab?.id ?? splitTab?.id ?? null))
  }, [activeTab?.id, splitTab?.id])

  const markReadingSessionInteraction = useCallback(() => {
    const session = readingSessionRef.current
    if (!session) return
    const now = Date.now()
    const delta = Math.max(0, now - session.lastInteractionAt)
    session.activeMs += Math.min(delta, READING_SESSION_IDLE_TIMEOUT_MS)
    session.lastInteractionAt = now
  }, [])

  const flushReadingSession = useCallback(async () => {
    const session = readingSessionRef.current
    if (!session) return
    markReadingSessionInteraction()
    readingSessionRef.current = null
    if (session.activeMs < READING_SESSION_MIN_ACTIVE_MS) return
    const progressEnd = captureReadingProgress(session.path)
    await recordFileEmergenceReadingSession({
      path: session.path,
      source: 'document_mode',
      workspaceRoots: documentWorkspaceRootsRef.current,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      activeMs: session.activeMs,
      progressStart: session.progressStart,
      progressEnd: progressEnd.ratio,
      progressKind: progressEnd.kind ?? session.progressKind,
    })
  }, [markReadingSessionInteraction])

  useEffect(() => {
    if (!isActive || !activeTab?.path || !isReadingSessionPath(activeTab.path)) return undefined
    const startedAt = Date.now()
    const progress = captureReadingProgress(activeTab.path)
    readingSessionRef.current = {
      path: activeTab.path,
      startedAt,
      lastInteractionAt: startedAt,
      activeMs: 0,
      progressStart: progress.ratio,
      progressKind: progress.kind,
    }
    return () => {
      void flushReadingSession()
    }
  }, [activeTab?.path, flushReadingSession, isActive])

  useEffect(() => {
    if (!isActive) return undefined
    const handleInteraction = () => markReadingSessionInteraction()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void flushReadingSession()
      else handleInteraction()
    }
    const handleFlush = () => { void flushReadingSession() }
    window.addEventListener('keydown', handleInteraction)
    window.addEventListener('pointerdown', handleInteraction)
    window.addEventListener('pointermove', handleInteraction)
    window.addEventListener('scroll', handleInteraction, true)
    window.addEventListener('pagehide', handleFlush)
    window.addEventListener('beforeunload', handleFlush)
    document.addEventListener('selectionchange', handleInteraction)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('keydown', handleInteraction)
      window.removeEventListener('pointerdown', handleInteraction)
      window.removeEventListener('pointermove', handleInteraction)
      window.removeEventListener('scroll', handleInteraction, true)
      window.removeEventListener('pagehide', handleFlush)
      window.removeEventListener('beforeunload', handleFlush)
      document.removeEventListener('selectionchange', handleInteraction)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushReadingSession, isActive, markReadingSessionInteraction])

  useEffect(() => {
    const api = window.electronAPI?.fileEmergence
    if (!api?.onFlushReadingSessions || !api.ackReadingSessionsFlushed) return undefined
    return api.onFlushReadingSessions((requestId) => {
      void flushReadingSession().finally(() => {
        api.ackReadingSessionsFlushed(requestId)
      })
    })
  }, [flushReadingSession])

  useEffect(() => {
    const openIds = new Set(tabs.map((tab) => tab.id))
    setVisibleLineByTabId((current) => {
      const next: Record<string, number | null> = {}
      let changed = false
      Object.entries(current).forEach(([id, line]) => {
        if (openIds.has(id)) {
          next[id] = line
        } else {
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [tabs])

  const refreshCleanTextTabsFromDisk = useCallback(async (candidateTabs: DocTab[]) => {
    if (!window.electronAPI?.document?.readFile) return
    for (const candidate of candidateTabs) {
      if (!candidate.path || candidate.isDirty || !isReloadableTextDocumentPath(candidate.path)) continue
      const result = await window.electronAPI.document.readFile(candidate.path).catch(() => null)
      if (!result?.success) continue
      const current = useDocTabs.getState().tabs.find((item) => item.id === candidate.id)
      if (!current || current.path !== candidate.path || current.isDirty) continue
      const nextContent = result.content || ''
      if (current.content === nextContent) continue
      updateTabContent(current.id, nextContent)
      markTabSaved(current.id)
    }
  }, [markTabSaved, updateTabContent])

  useEffect(() => {
    if (!isActive) return
    const visibleTabs = [activeTab, splitTab].filter((tab): tab is DocTab => Boolean(tab))
    void refreshCleanTextTabsFromDisk(visibleTabs)
  }, [activeTab?.id, isActive, refreshCleanTextTabsFromDisk, splitTab?.id])

  useEffect(() => {
    if (!window.electronAPI?.document?.onDirectoryChange) return undefined
    const unsubscribe = window.electronAPI.document.onDirectoryChange((event) => {
      const changedPaths = Array.isArray(event?.paths) ? event.paths : []
      if (changedPaths.length === 0) return
      const candidates = useDocTabs
        .getState()
        .tabs
        .filter((tab) => shouldRefreshDocumentTabForDirectoryChange(tab, changedPaths))
      if (candidates.length > 0) {
        void refreshCleanTextTabsFromDisk(candidates)
      }
    })
    return () => unsubscribe()
  }, [refreshCleanTextTabsFromDisk])

  const captureDocumentScrollScope = useCallback((scope: HTMLElement, options?: { includeAnchor?: boolean }) => {
    const key = scope.dataset.readyDocumentScrollKey
    if (!key) return
    const element = findCurrentScrollElement(scope)
    if (!element) return
    const snapshot = captureElementScroll(element, tabByScrollKey.get(key)?.content || '', options)
    scrollSnapshotsRef.current.set(key, snapshot)
    saveDocumentReadingPosition(key, snapshot)
  }, [tabByScrollKey])

  const captureVisibleDocumentScrollPositions = useCallback((options?: { includeAnchor?: boolean }) => {
    document.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => {
      captureDocumentScrollScope(scope, options)
    })
  }, [captureDocumentScrollScope])

  useEffect(() => {
    if (!isActive) {
      captureVisibleDocumentScrollPositions()
    }
  }, [captureVisibleDocumentScrollPositions, isActive])

  useEffect(() => {
    const flush = () => captureVisibleDocumentScrollPositions()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      flush()
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [captureVisibleDocumentScrollPositions])

  useEffect(() => {
    if (!isActive) return undefined
    const scopes = Array.from(document.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]'))
    const timers = new Map<HTMLElement, number>()
    const cleanups: Array<() => void> = []

    scopes.forEach((scope) => {
      const handler = () => {
        const previous = timers.get(scope)
        if (previous) window.clearTimeout(previous)
        const timer = window.setTimeout(() => {
          timers.delete(scope)
          captureDocumentScrollScope(scope)
        }, 220)
        timers.set(scope, timer)
      }
      findScrollCandidates(scope).forEach((element) => {
        element.addEventListener('scroll', handler, { passive: true })
        cleanups.push(() => element.removeEventListener('scroll', handler))
      })
    })

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      cleanups.forEach((cleanup) => cleanup())
      captureVisibleDocumentScrollPositions()
    }
  }, [activeTabId, captureDocumentScrollScope, captureVisibleDocumentScrollPositions, editorMode, isActive, splitTabId])

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

  const handlePanelReveal = useCallback((lineStart: number, lineEnd?: number | null) => {
    if (!panelTargetTab?.path) return
    setPendingReveal({
      path: panelTargetTab.path,
      lineStart,
      lineEnd: lineEnd ?? lineStart,
      requestedAt: Date.now(),
    })
  }, [panelTargetTab?.path, setPendingReveal])

  const handlePanelTargetLineChange = useCallback((tabId: string, line: number | null) => {
    setVisibleLineByTabId((current) => (
      current[tabId] === line ? current : { ...current, [tabId]: line }
    ))
  }, [])

  const handlePaneActivate = useCallback((tabId: string) => {
    setPanelTargetTabId(tabId)
  }, [])

  const replaceDocumentPaneFromDrop = useCallback(async (path: string, pane: DocumentPaneTarget) => {
    const result = await window.electronAPI?.document?.stat?.(path).catch(() => null)
    const isDirectory = result?.data?.isDirectory ?? result?.stat?.isDirectory ?? false
    if (result?.success && isDirectory) return

    captureVisibleDocumentScrollPositions()
    setEditorMode('preview')
    const nextTabId = openTabInPane(path, pane)
    if (nextTabId) {
      setPanelTargetTabId(nextTabId)
    }
  }, [captureVisibleDocumentScrollPositions, openTabInPane])

  const handleDocumentPaneDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, pane: DocumentPaneTarget) => {
    if (!canAcceptDocumentPaneDrop(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDocumentPaneDropTarget(pane)
  }, [])

  const handleDocumentPaneDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>, pane: DocumentPaneTarget) => {
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    setDocumentPaneDropTarget((current) => (current === pane ? null : current))
  }, [])

  const handleDocumentPaneDrop = useCallback((event: React.DragEvent<HTMLDivElement>, pane: DocumentPaneTarget) => {
    const path = getDocumentPaneDropPath(event.dataTransfer)
    if (!path) return
    event.preventDefault()
    event.stopPropagation()
    setDocumentPaneDropTarget(null)
    void replaceDocumentPaneFromDrop(path, pane)
  }, [replaceDocumentPaneFromDrop])

  // Tab click handler
  const handleTabClick = useCallback((id: string, e: React.MouseEvent) => {
    captureVisibleDocumentScrollPositions()
    if (e.shiftKey && id !== activeTabId) {
      setSplitTab(id)
      setPanelTargetTabId(id)
    } else {
      setActiveTab(id)
      setPanelTargetTabId(id)
    }
  }, [activeTabId, captureVisibleDocumentScrollPositions, setActiveTab, setSplitTab])

  // Drag & drop reorder
  const dragIndexRef = useRef<number | null>(null)
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'copyMove'
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
      e.dataTransfer.setData('application/x-ready-document-tab', data)
      e.dataTransfer.setData('application/x-ready-drag', data)
      e.dataTransfer.setData('text/plain', tab.path)
      e.dataTransfer.setData('text/uri-list', `file://${encodeURI(tab.path)}`)
      startBrowserLocalMediaNativeFileDrag(e)
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

  const handleTabContextMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, id: string) => {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    event.preventDefault()
    event.stopPropagation()
    void showReferenceToInputMenu({ x: event.clientX, y: event.clientY }).then((selected) => {
      if (!selected) return
      void addReadyContextReferenceToAgentInput({
        type: 'doc-tab',
        name: tab.title,
        title: tab.title,
        path: tab.path,
        tabId: tab.id,
        content: tab.content,
        ext: getFileExt(tab.path),
        size: tab.content.length,
        dirty: tab.isDirty,
      })
    })
  }, [tabs])

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
      captureVisibleDocumentScrollPositions({ includeAnchor: false })
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
            onNewTab={() => {
              setEditorMode('preview')
              openTab('')
            }}
            onTabDragStart={(event, id) => {
              const index = tabs.findIndex((tab) => tab.id === id)
              if (index >= 0) handleDragStart(event, index)
            }}
            onTabDragOver={handleDragOver}
            onTabDrop={handleDrop}
            onTabDragEnd={handleDragEnd}
            onTabContextMenu={handleTabContextMenu}
            rightActions={
              <>
                <DocumentPanelToggleButtons
                  outlineOpen={outlinePanelOpen}
                  marksOpen={marksPanelOpen}
                  onToggleOutline={() => setOutlinePanelOpen((value) => !value)}
                  onToggleMarks={() => setMarksPanelOpen((value) => !value)}
                  rail
                />
                <DraggableModeSwitch
                  mode={editorMode}
                  onChange={handleEditorModeChange}
                />
              </>
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
          <div className="relative flex-1 min-h-0 overflow-hidden">
            {splitTab && activeTab ? (
              <div className="h-full flex min-w-0 overflow-hidden" ref={splitContainerRef} style={{ gap: 0 }}>
                <div
                  ref={primarySplitPaneRef}
                  className={`document-pane-drop-target flex flex-col min-w-0 overflow-hidden${documentPaneDropTarget === 'primary' ? ' is-document-pane-drop-target' : ''}`}
                  style={{ flexBasis: `${documentSplitRatio}%`, flexShrink: 0, flexGrow: 0 }}
                  onFocusCapture={() => handlePaneActivate(activeTab.id)}
                  onPointerDownCapture={() => handlePaneActivate(activeTab.id)}
                  onDragOverCapture={(event) => handleDocumentPaneDragOver(event, 'primary')}
                  onDragLeaveCapture={(event) => handleDocumentPaneDragLeave(event, 'primary')}
                  onDropCapture={(event) => handleDocumentPaneDrop(event, 'primary')}
                >
                  <DocumentEditor
                    key={activeTab.id}
                    tab={activeTab}
                    viewMode={editorMode}
                    previewFocusWidgetTitle={previewFocusWidgetTitle}
                    onVisibleLineChange={(line) => handlePanelTargetLineChange(activeTab.id, line)}
                    onActivate={() => handlePaneActivate(activeTab.id)}
                  />
                </div>
                <SplitResizeHandle
                  onResize={handleSplitResize}
                  onResizeStateChange={handleSplitResizeStateChange}
                />
                <div
                  className={`document-pane-drop-target flex-1 flex flex-col min-w-0 overflow-hidden${documentPaneDropTarget === 'split' ? ' is-document-pane-drop-target' : ''}`}
                  onFocusCapture={() => handlePaneActivate(splitTab.id)}
                  onPointerDownCapture={() => handlePaneActivate(splitTab.id)}
                  onDragOverCapture={(event) => handleDocumentPaneDragOver(event, 'split')}
                  onDragLeaveCapture={(event) => handleDocumentPaneDragLeave(event, 'split')}
                  onDropCapture={(event) => handleDocumentPaneDrop(event, 'split')}
                >
                  <DocumentEditor
                    key={splitTab.id}
                    tab={splitTab}
                    viewMode={editorMode}
                    previewFocusWidgetTitle={previewFocusWidgetTitle}
                    onVisibleLineChange={(line) => handlePanelTargetLineChange(splitTab.id, line)}
                    onActivate={() => handlePaneActivate(splitTab.id)}
                  />
                </div>
              </div>
            ) : activeTab ? (
              <div
                className="h-full flex flex-col min-w-0 overflow-hidden"
                onFocusCapture={() => handlePaneActivate(activeTab.id)}
                onPointerDownCapture={() => handlePaneActivate(activeTab.id)}
              >
                <DocumentEditor
                  key={activeTab.id}
                  tab={activeTab}
                  viewMode={editorMode}
                  previewFocusWidgetTitle={previewFocusWidgetTitle}
                  onVisibleLineChange={(line) => handlePanelTargetLineChange(activeTab.id, line)}
                  onActivate={() => handlePaneActivate(activeTab.id)}
                />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-[var(--text-muted)]">
                <div className="text-center">
                  <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="text-[13px]">点击左侧文件打开文档</p>
                </div>
              </div>
            )}

            {panelTargetTab && (
              <DocumentFloatingPanels
                documentPath={panelTargetTab.path}
                documentTitle={panelTargetTab.title}
                content={panelTargetTab.content}
                activeLine={panelTargetLine}
                outlineOpen={outlinePanelOpen}
                marksOpen={marksPanelOpen}
                onToggleOutline={() => setOutlinePanelOpen((value) => !value)}
                onToggleMarks={() => setMarksPanelOpen((value) => !value)}
                onReveal={handlePanelReveal}
                showToggles={false}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
