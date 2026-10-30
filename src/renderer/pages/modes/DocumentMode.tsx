import { DraftBootNotice, DraftControls } from '../../modules/document/drafts/DraftControls'
import { initializeDrafts, reportDraftError, useDraftUI, watchDraftVault } from '../../modules/document/drafts/runtime'
import { readingPositionKey } from '../../stores/objectPresentationState'
import { registerReturnPosition } from '../../modules/workbench/reference-return'
import { LibraryTab, OpenEpubInLibrary } from '../../modules/library/navigation'
import '../../design/next/tokens.css'
import '../../design/next/glass.css'
import '../../modules/library/shelf.css'
import '../../modules/library/reader.css'
import '../../modules/library/reader/page.css'
import '../../modules/library/library.css'
import '../../modules/document/database/database.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, memo, Suspense } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { computeDesiredRoots, useWorkspace } from '../../stores/useWorkspace'
import {
  isImagePreviewPath,
  useDocTabs,
  type DocTab,
  type DocumentPaneTarget,
} from '../../stores/useDocTabs'
import { PageDocumentEditor } from '../../modules/document/page-ui/PageDocumentEditor'
import DocumentVerticalTabRail from '../../components/document/DocumentVerticalTabRail'
import FilePreview from '../../components/document/FilePreview'
import DraggableModeSwitch from '../../components/document/DraggableModeSwitch'
import DocumentFloatingPanels, { DocumentPanelToggleButtons } from '../../components/document/DocumentFloatingPanels'
import DocumentExportButton from '../../components/document/DocumentExportButton'
import DocumentBookReadingButton from '../../components/document/book/DocumentBookReadingButton'
import DocumentBookReadingView from '../../components/document/book/DocumentBookReadingView'
import {
  isBookReadablePath,
  isBookReadingSessionVisible,
  shouldFinalizeBookReadingSession,
} from '../../modules/document/book/bookTabEligibility'
import { READY_DOCUMENT_REVEAL_EVENT } from '../../modules/agent/document-quote-navigation'
import {
  addReadyContextReferenceToAgentInput,
  showReferenceToInputMenu,
} from '../../modules/agent/chat-input-bridge'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import { useRafResizeDrag } from '../../modules/workbench/useRafResizeDrag'
import { freezeVisibleDocumentLayoutWidths } from '../../modules/document/documentLayoutFreeze'
import { shouldHandleSelectedDocument } from '../../modules/document/documentSelectionOpen'
import {
  readDocumentReadingPositionMap,
  saveDocumentReadingPosition,
  type DocumentScrollAnchorSnapshot,
} from '../../modules/document/documentScrollAnchor'
import {
  captureElementScroll,
  findCurrentScrollElement,
  findScrollCandidates,
  restoreElementScroll,
  trackDocumentScrollPosition,
} from '../../modules/document/documentScrollRuntime'
import {
  type ExternalRefreshInFlightRequest,
  refreshCleanDocumentTabsFromDisk,
  shouldRefreshDocumentTabForDirectoryChange,
  shouldRefreshDocumentTabOnActivation,
} from '../../modules/document/documentExternalRefresh'
import { invalidateImageGalleryDirectories } from '../../modules/document/imageGalleryDirectoryCache'
import { subscribeDocumentDirectoryChanges } from '../../modules/document/directoryChangeBridge'
import { registerBeforeQuitFlushHandler } from '../../modules/app/beforeQuitFlushRegistry'
import { releaseClosedBoardHandles } from '../../modules/document/boardHandleRegistry'
import {
  canAcceptDocumentPaneDrop,
  getDocumentPaneDropPath,
} from '../../modules/document/documentPaneDrop'
import {
  endUntitledDocTabDragSession,
  setUntitledDocTabDragPayload,
} from '../../components/layout/fileTreeExternalDrop'
import { getFileAppearanceColorValue } from '../../stores/fileAppearance'
import { startBrowserLocalMediaNativeFileDrag } from '../../modules/browser/localMediaDragBridge'
import { getFileExtension } from '../../utils/path'
import { getDocumentTabFileTypeColor } from '../../modules/document/documentTabPresentation'
import {
  areRetainedDocumentEditorPropsEqual,
  resolveRetainedDocumentScene,
  type RetainedDocumentEditorProps,
} from '../../modules/document/documentSceneRetention'
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

function clampDocumentSplitRatio(ratio: number): number {
  return Math.max(20, Math.min(80, ratio))
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
type DocumentEditorProps = RetainedDocumentEditorProps<DocTab> & { bookReading: boolean }

const DocumentEditor = memo(function DocumentEditor({
  tab,
  viewMode,
  previewEditable,
  previewFocusWidgetTitle,
  onVisibleLineChange,
  onActivate,
  isFocused,
  isSceneVisible,
  bookReading,
}: DocumentEditorProps) {
  const ext = useMemo(() => (tab.path ? getFileExtension(tab.path) : ''), [tab.path])
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)
  const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext)
  const isPdf = ext === 'pdf'
  const isEbook = isEbookExtension(ext)
  const isXlsx = ['xlsx', 'csv', 'xls'].includes(ext)

  if (tab.kind === 'library') return <LibraryTab />
  if (tab.path && tab.objectBinding?.status !== 'resolved') return <div role="status">{tab.objectBinding?.status === 'failed' ? `无法打开文件：${tab.objectBinding.message}` : '正在确认文件位置…'}</div>
  if (ext === 'epub' && tab.path) return <OpenEpubInLibrary path={tab.path} sourceTabId={tab.id} />

  if (isReadyBoardFile(tab.path)) {
    return (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>}>
        <BoardEditor tab={tab} onActivate={onActivate} isFocused={isFocused} />
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
    <PageDocumentEditor
      bookReading={bookReading}
      isSceneVisible={isSceneVisible}
      tab={tab}
      viewMode={viewMode}
      previewEditable={previewEditable}
      previewFocusWidgetTitle={previewFocusWidgetTitle}
      onVisibleLineChange={onVisibleLineChange}
      onActivate={onActivate}
    />
  )
}, (previous, next) => previous.bookReading === next.bookReading && areRetainedDocumentEditorPropsEqual(previous, next))

// --- DocumentMode main component ---
interface DocumentModeProps {
  isActive?: boolean
  isSceneVisible?: boolean
  isMotionSettled?: boolean
}

export default function DocumentMode({
  isActive = true,
  isSceneVisible = true,
  isMotionSettled = true,
}: DocumentModeProps) {
  const selectedFile = useWorkspace((state) => state.selectedFile)
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const pinnedFolders = useWorkspace((state) => state.pinnedFolders)
  const fileAppearances = useWorkspace((state) => state.fileAppearances)
  const tabs = useDocTabs((state) => state.tabs)
  const tabGroups = useDocTabs((state) => state.tabGroups)
  const activeTabId = useDocTabs((state) => state.activeTabId)
  const splitTabId = useDocTabs((state) => state.splitTabId)
  const focusedPaneTabId = useDocTabs((state) => state.focusedPaneTabId)
  const documentSplitRatio = useDocTabs((state) => state.documentSplitRatio)
  const {
    openTab, closeTab, setActiveTab, setSplitTab, setDocumentSplitRatio,
    hydrateTabContentFromDisk, setPendingReveal, openTabInPane,
    openImageTab, ensureTabForPath, createBackgroundTab,
    createTabGroupFromDrop, addTabToGroup, reorderTabToRank,
    renameTabGroup, recolorTabGroup, setTabGroupCollapsed, disbandTabGroup,
    setFocusedPaneTab,
  } = useDocTabs.getState()

  const draftBoot = useDraftUI(state => state.boot)
  useEffect(() => { void initializeDrafts().catch(reportDraftError); return watchDraftVault() }, [])

  const documentRootRef = useRef<HTMLDivElement>(null)
  // Scroll restoration depends on the root being mounted; after a restart it can mount after the first restore ran.
  const [documentRootElement, setDocumentRootElement] = useState<HTMLDivElement | null>(null)
  const attachDocumentRoot = useCallback((element: HTMLDivElement | null) => {
    documentRootRef.current = element
    setDocumentRootElement(element)
  }, [])
  const pendingScrollFlushesRef = useRef(new Set<() => void>())
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const primarySplitPaneRef = useRef<HTMLDivElement>(null)
  const [scrollSnapshots] = useState(readDocumentReadingPositionMap)
  const documentSplitRatioRef = useRef(documentSplitRatio)
  const liveDocumentSplitRatioRef = useRef(documentSplitRatio)
  const restoreDocumentLayoutFreezeRef = useRef<(() => void) | null>(null)
  const [editorMode, setEditorMode] = useState<'edit' | 'preview'>('preview')
  const [previewFocusWidgetTitle, setPreviewFocusWidgetTitle] = useState<string | null>(null)
  // 阅读模式是当前文档上的只读展示态；原编辑面继续保活。
  const [bookReadingActive, setBookReadingActive] = useState(false)
  const [bookReadingTabId, setBookReadingTabId] = useState<string | null>(null)
  const [outlinePanelOpen, setOutlinePanelOpen] = useState(() => readDocumentPanelOpenState('ready-document-outline-panel-open'))
  const [marksPanelOpen, setMarksPanelOpen] = useState(() => readDocumentPanelOpenState('ready-document-marks-panel-open'))
  const [visibleLineByTabId, setVisibleLineByTabId] = useState<Record<string, number | null>>({})
  const [documentPaneDropTarget, setDocumentPaneDropTarget] = useState<DocumentPaneTarget | null>(null)
  const documentWorkspaceRoots = useMemo(
    () => computeDesiredRoots({ workspaceRoot, pinnedFolders }),
    [pinnedFolders, workspaceRoot],
  )
  const documentWorkspaceRootsRef = useRef<string[]>(documentWorkspaceRoots)
  const readingSessionRef = useRef<ReadingSessionDraft | null>(null)
  const refreshInFlightRef = useRef<Map<string, ExternalRefreshInFlightRequest>>(new Map())
  const pendingExternalRefreshTabIdsRef = useRef<Set<string>>(new Set())
  const retainedDocumentSceneRef = useRef<{
    activeTab: DocTab | null
    splitTab: DocTab | null
    retainActiveEditor: boolean
    retainSplitEditor: boolean
  }>({
    activeTab: null,
    splitTab: null,
    retainActiveEditor: false,
    retainSplitEditor: false,
  })
  const previousSceneVisibleRef = useRef(isSceneVisible)

  useEffect(() => {
    documentWorkspaceRootsRef.current = documentWorkspaceRoots
  }, [documentWorkspaceRoots])

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

  // Open the file selected in SidePanel. Hidden keep-alive modes must not react;
  // the foreground FileTree/search/graph path already opens its target before the
  // selection effect runs, so detect that state and avoid a duplicate stat/open/activity.
  // This must react only to a *new selection* (selectedFile / isActive), never to ongoing tab state — otherwise switching
  // tabs or browsing another image re-fires the effect and snaps the active tab back
  // to the selected file, locking the document view. Tab state and workspace roots are
  // therefore read live at execution time, not through the dependency array.
  useEffect(() => {
    if (!selectedFile) return undefined
    const initialState = useDocTabs.getState()
    if (!shouldHandleSelectedDocument({
      isActive,
      selectedFile,
      tabs: initialState.tabs,
      activeTabId: initialState.activeTabId,
    })) return undefined

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
        const { tabs: currentTabs, activeTabId: currentActiveTabId } = useDocTabs.getState()
        const activeTab = currentTabs.find((tab) => tab.id === currentActiveTabId)
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
          workspaceRoots: documentWorkspaceRootsRef.current,
        })
      }
    })()

    return () => {
      disposed = true
    }
  }, [ensureTabForPath, isActive, openImageTab, openTab, selectedFile])

  useEffect(() => {
    const handler = () => {
      setBookReadingActive(false)
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
  const nextRetainedDocumentScene = resolveRetainedDocumentScene({
    isSceneVisible,
    wasSceneVisible: previousSceneVisibleRef.current,
    activeTab: activeTab || null,
    splitTab: splitTab || null,
    retained: retainedDocumentSceneRef.current,
  })
  useLayoutEffect(() => {
    retainedDocumentSceneRef.current = nextRetainedDocumentScene
    previousSceneVisibleRef.current = isSceneVisible
  }, [isSceneVisible, nextRetainedDocumentScene])
  const renderedActiveTab = nextRetainedDocumentScene.activeTab
  const renderedSplitTab = nextRetainedDocumentScene.splitTab
  const renderActiveEditor = isSceneVisible || nextRetainedDocumentScene.retainActiveEditor
  const renderSplitEditor = isSceneVisible || nextRetainedDocumentScene.retainSplitEditor
  const activeTabPathLabel = activeTab?.path || activeTab?.title || '未打开文档'
  const panelTargetTab = useMemo(() => {
    const visibleTabs = [activeTab, splitTab].filter((tab): tab is DocTab => Boolean(tab))
    return visibleTabs.find((tab) => tab.id === focusedPaneTabId) || activeTab || splitTab || null
  }, [activeTab, focusedPaneTabId, splitTab])
  const panelTargetLine = panelTargetTab ? visibleLineByTabId[panelTargetTab.id] ?? null : null
  const bookReadingEligible = panelTargetTab && panelTargetTab.kind !== 'library' ? isBookReadablePath(panelTargetTab.path) : false
  // Document book mode reads the current buffer; the library owns imported books,
  // chapter pagination and annotations. Neither opens an editor for the other.
  const bookReadingVisible = isBookReadingSessionVisible(
    bookReadingActive,
    bookReadingTabId,
    panelTargetTab?.id ?? null,
    bookReadingEligible,
    isSceneVisible,
  )
  useEffect(() => {
    if (shouldFinalizeBookReadingSession(
      bookReadingActive,
      bookReadingTabId,
      panelTargetTab?.id ?? null,
      isSceneVisible,
    )) {
      setBookReadingActive(false)
      setBookReadingTabId(null)
    }
  }, [bookReadingActive, bookReadingTabId, isSceneVisible, panelTargetTab?.id])
  const tabScrollStructureSignature = tabs.map((tab) => `${tab.id}\u0000${tab.objectId || ''}\u0000${tab.path || ''}`).join('\u0001')
  const tabIdByScrollKey = useMemo(() => {
    const next = new Map<string, string>()
    useDocTabs.getState().tabs.forEach((tab) => next.set(tab.objectId || `draft:${tab.id}`, tab.id))
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabScrollStructureSignature is a deliberate cache-busting key: the memo reads the store via getState() and rebuilds only when tab ids or paths change
  }, [tabScrollStructureSignature])

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

  useEffect(
    () => registerBeforeQuitFlushHandler('document-reading-session', flushReadingSession),
    [flushReadingSession],
  )

  useEffect(() => {
    const openIds = new Set(useDocTabs.getState().tabs.map((tab) => tab.id))
    void releaseClosedBoardHandles(openIds, (expectedBoardId) => (
      window.electronAPI?.board?.setActive?.({ boardId: null, expectedBoardId })
    ))
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
  }, [tabScrollStructureSignature])

  const refreshCleanTextTabsFromDisk = useCallback(async (candidateTabs: DocTab[]) => {
    if (!window.electronAPI?.document?.readFile) return new Set<string>()
    return refreshCleanDocumentTabsFromDisk(candidateTabs, {
      readFile: (path) => window.electronAPI.document.readFile(path),
      getCurrentTab: (id) => useDocTabs.getState().tabs.find((item) => item.id === id) || null,
      hydrateTab: hydrateTabContentFromDisk,
      inFlight: refreshInFlightRef.current,
    })
  }, [hydrateTabContentFromDisk])

  useEffect(() => {
    if (!isActive) return
    const visibleTabs = [activeTab, splitTab]
      .filter((tab): tab is DocTab => Boolean(tab))
      .filter((tab) => pendingExternalRefreshTabIdsRef.current.has(tab.id))
      .filter(shouldRefreshDocumentTabOnActivation)
    if (visibleTabs.length === 0) return
    void refreshCleanTextTabsFromDisk(visibleTabs).then((resolvedIds) => {
      for (const id of resolvedIds) pendingExternalRefreshTabIdsRef.current.delete(id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the visible tab ids or activation change; tab objects are replaced on every edit and must not re-issue the disk refresh check per keystroke (directory change events refresh visible tabs themselves)
  }, [activeTab?.id, isActive, refreshCleanTextTabsFromDisk, splitTab?.id])

  useEffect(() => {
    const unsubscribe = subscribeDocumentDirectoryChanges((event) => {
      const changedPaths = Array.isArray(event?.paths) ? event.paths : []
      if (changedPaths.length === 0) return
      invalidateImageGalleryDirectories(changedPaths)
      const state = useDocTabs.getState()
      const visibleIds = new Set([state.activeTabId, state.splitTabId].filter(Boolean))
      const candidates = state.tabs.filter((tab) => shouldRefreshDocumentTabForDirectoryChange(tab, changedPaths))
      const visibleCandidates = candidates.filter((tab) => isActive && visibleIds.has(tab.id))
      for (const tab of candidates) pendingExternalRefreshTabIdsRef.current.add(tab.id)
      if (visibleCandidates.length > 0) {
        void refreshCleanTextTabsFromDisk(visibleCandidates).then((resolvedIds) => {
          for (const id of resolvedIds) pendingExternalRefreshTabIdsRef.current.delete(id)
        })
      }
    })
    return () => unsubscribe()
  }, [isActive, refreshCleanTextTabsFromDisk])

  const captureDocumentScrollScope = useCallback((scope: HTMLElement, options?: { includeAnchor?: boolean }) => {
    const key = readingPositionKey(scope.dataset.readyDocumentScrollKey || '')
    if (!key) return
    const element = findCurrentScrollElement(scope)
    if (!element) return
    const tabId = tabIdByScrollKey.get(key)
    const content = tabId
      ? useDocTabs.getState().tabs.find((tab) => tab.id === tabId)?.content || ''
      : ''
    const snapshot = captureElementScroll(element, content, options)
    scrollSnapshots.set(key, snapshot)
    saveDocumentReadingPosition(key, snapshot)
  }, [scrollSnapshots, tabIdByScrollKey])

  const captureVisibleDocumentScrollPositions = useCallback((options?: { includeAnchor?: boolean }) => {
    if (bookReadingVisible) return
    pendingScrollFlushesRef.current.forEach((flushPosition) => flushPosition())
    documentRootRef.current?.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => {
      captureDocumentScrollScope(scope, options)
    })
  }, [bookReadingVisible, captureDocumentScrollScope])

  useEffect(() => {
    const flush = () => pendingScrollFlushesRef.current.forEach((flushPosition) => flushPosition())
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
  }, [])

  useEffect(() => {
    if (!isActive || bookReadingVisible) return
    const cleanups: Array<() => void> = []
    documentRootRef.current?.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => {
      const key = readingPositionKey(scope.dataset.readyDocumentScrollKey || '')
      if (!key) return
      const tabId = tabIdByScrollKey.get(key)
      findScrollCandidates(scope).forEach((element) => {
        const tracker = trackDocumentScrollPosition(element,
          () => useDocTabs.getState().tabs.find((tab) => tab.id === tabId)?.content || '',
          (snapshot) => {
            scrollSnapshots.set(key, snapshot)
            saveDocumentReadingPosition(key, snapshot)
          },
        )
        pendingScrollFlushesRef.current.add(tracker.flush)
        cleanups.push(() => {
          tracker.dispose()
          pendingScrollFlushesRef.current.delete(tracker.flush)
        })
      })
    })
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [activeTabId, bookReadingVisible, editorMode, isActive, scrollSnapshots, splitTabId, tabIdByScrollKey])

  const restoreDocumentScrollScopes = useCallback((scopes: Iterable<HTMLElement>) => {
    const cleanups: Array<() => void> = []
    for (const scope of scopes) {
      const key = readingPositionKey(scope.dataset.readyDocumentScrollKey || '')
      if (!key) continue
      const snapshot = scrollSnapshots.get(key) ?? readDocumentReadingPositionMap().get(key)
      if (!snapshot) continue
      const tabId = tabIdByScrollKey.get(key)
      const content = tabId
        ? useDocTabs.getState().tabs.find((tab) => tab.id === tabId)?.content || ''
        : ''
      findScrollCandidates(scope).forEach((element) => {
        cleanups.push(restoreElementScroll(element, snapshot, content))
      })
    }
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [scrollSnapshots, tabIdByScrollKey])

  const restoreVisibleDocumentScrollPositions = useCallback(() => restoreDocumentScrollScopes(
    documentRootRef.current?.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]') ?? [],
  ), [restoreDocumentScrollScopes])

  useEffect(() => {
    const root = documentRootElement
    if (!root || !isSceneVisible || bookReadingVisible || typeof MutationObserver !== 'function') return
    // After a restart a tab binds its object first, and the preview can swap its scroller once content arrives, so the
    // first restore may land on an element that is replaced. Until the reader acts (or a few seconds pass), any change
    // inside a scope re-applies its saved position to the current elements.
    const settling = new Map<HTMLElement, { until: number; cleanup: (() => void) | null; touched: boolean; stop: () => void }>()
    const watch = (scope: HTMLElement) => {
      if (settling.has(scope)) return settling.get(scope)!
      const entry = { until: Date.now() + 5000, cleanup: null as (() => void) | null, touched: false, stop: () => {} }
      const touch = () => { entry.touched = true }
      for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) scope.addEventListener(type, touch, { passive: true, capture: true })
      entry.stop = () => { for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) scope.removeEventListener(type, touch, { capture: true }) }
      settling.set(scope, entry)
      return entry
    }
    const reapply = (scope: HTMLElement) => {
      const entry = watch(scope)
      if (entry.touched || Date.now() > entry.until) return
      entry.cleanup?.()
      entry.cleanup = restoreDocumentScrollScopes([scope])
    }
    root.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((scope) => { watch(scope) })
    const observer = new MutationObserver((records) => {
      const scopes = new Set<HTMLElement>()
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement
        const scope = target?.closest<HTMLElement>('[data-ready-document-scroll-key]')
        if (scope) scopes.add(scope)
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue
          if (node.matches('[data-ready-document-scroll-key]')) scopes.add(node as HTMLElement)
          node.querySelectorAll<HTMLElement>('[data-ready-document-scroll-key]').forEach((inner) => scopes.add(inner))
        }
      }
      scopes.forEach(reapply)
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      settling.forEach((entry) => { entry.cleanup?.(); entry.stop() })
    }
  }, [bookReadingVisible, documentRootElement, isSceneVisible, restoreDocumentScrollScopes])

  useLayoutEffect(() => {
    if (!isSceneVisible || bookReadingVisible || !documentRootElement) return
    return restoreVisibleDocumentScrollPositions()
  }, [activeTabId, bookReadingVisible, documentRootElement, editorMode, isSceneVisible, restoreVisibleDocumentScrollPositions, splitTabId])

  useEffect(() => registerReturnPosition('document', () => {
    captureVisibleDocumentScrollPositions()
    const captured = new Map(scrollSnapshots)
    return () => { captured.forEach((snapshot, key) => scrollSnapshots.set(key, snapshot)) }
  }), [captureVisibleDocumentScrollPositions, scrollSnapshots])

  const handleBookPositionChange = useCallback((key: string, snapshot: DocumentScrollAnchorSnapshot) => {
    const objectKey = readingPositionKey(key)
    if (objectKey) scrollSnapshots.set(objectKey, snapshot)
  }, [scrollSnapshots])

  const handleEditorModeChange = useCallback((nextMode: 'edit' | 'preview') => {
    if (nextMode === editorMode) return
    captureVisibleDocumentScrollPositions()
    setEditorMode(nextMode)
  }, [captureVisibleDocumentScrollPositions, editorMode])

  const handleEditorModeIntent = useCallback((): boolean => {
    if (!bookReadingVisible) return false
    setBookReadingActive(false)
    setBookReadingTabId(null)
    return true
  }, [bookReadingVisible])

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
    setFocusedPaneTab(tabId)
  }, [setFocusedPaneTab])

  const handlePrimaryVisibleLineChange = useCallback((line: number | null) => {
    const tabId = useDocTabs.getState().activeTabId
    if (tabId) handlePanelTargetLineChange(tabId, line)
  }, [handlePanelTargetLineChange])
  const handleSplitVisibleLineChange = useCallback((line: number | null) => {
    const tabId = useDocTabs.getState().splitTabId
    if (tabId) handlePanelTargetLineChange(tabId, line)
  }, [handlePanelTargetLineChange])
  const handlePrimaryActivate = useCallback(() => {
    const tabId = useDocTabs.getState().activeTabId
    if (tabId) handlePaneActivate(tabId)
  }, [handlePaneActivate])
  const handleSplitActivate = useCallback(() => {
    const tabId = useDocTabs.getState().splitTabId
    if (tabId) handlePaneActivate(tabId)
  }, [handlePaneActivate])

  const replaceDocumentPaneFromDrop = useCallback(async (path: string, pane: DocumentPaneTarget) => {
    const result = await window.electronAPI?.document?.stat?.(path).catch(() => null)
    const isDirectory = result?.data?.isDirectory ?? result?.stat?.isDirectory ?? false
    if (result?.success && isDirectory) return

    captureVisibleDocumentScrollPositions()
    setEditorMode('preview')
    openTabInPane(path, pane)
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
    } else {
      setActiveTab(id)
    }
  }, [activeTabId, captureVisibleDocumentScrollPositions, setActiveTab, setSplitTab])

  // Drag & drop reorder
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'copyMove'
    // Attach ready-drag data for cross-component drop (e.g. ChatPanel)
    const tab = useDocTabs.getState().tabs.find((candidate) => candidate.id === id)
    if (tab && tab.path) {
      const ext = getFileExtension(tab.path)
      const data = JSON.stringify({
        type: 'doc-tab' as const,
        path: tab.path,
        name: tab.title,
        title: tab.title,
        tabId: tab.id,
        selection: tab.isDirty ? tab.content : undefined,
        dirty: tab.isDirty,
        ext: ext ? `.${ext}` : undefined,
      })
      e.dataTransfer.setData('application/x-ready-document-tab', data)
      e.dataTransfer.setData('application/x-ready-drag', data)
      e.dataTransfer.setData('text/plain', tab.path)
      e.dataTransfer.setData('text/uri-list', `file://${encodeURI(tab.path)}`)
      startBrowserLocalMediaNativeFileDrag(e)
    } else if (tab && tab.kind !== 'library') {
      // Untitled draft (未保存的新建文档): dropping it onto a file-tree
      // directory confirms the save location.
      setUntitledDocTabDragPayload(e, { tabId: tab.id, title: tab.title })
      e.dataTransfer.setData('application/x-ready-drag', JSON.stringify({
        type: 'doc-tab' as const,
        name: tab.title,
        title: tab.title,
        tabId: tab.id,
        selection: tab.content,
        dirty: true,
      }))
    }
  }, [])

  const handleDragEnd = useCallback(() => {
    endUntitledDocTabDragSession()
  }, [])

  // Delete a group = close its member tabs. closeTab normalizes groups (drops the
  // group once its last member is gone) and keeps the doc store never-empty (a blank
  // untitled tab replaces the last one), so no manual empty-guard is needed.
  const handleDeleteGroup = useCallback((groupId: string) => {
    const memberIds = useDocTabs.getState().tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id)
    for (const id of memberIds) closeTab(id)
  }, [closeTab])

  // New tab in group = create a background (non-activating) untitled tab, then move it
  // into the group's tail (§11.1 default background).
  const handleNewTabInGroup = useCallback((groupId: string) => {
    const newId = createBackgroundTab()
    addTabToGroup(newId, groupId)
  }, [addTabToGroup, createBackgroundTab])

  const handleTabContextMenu = useCallback((event: React.MouseEvent, id: string) => {
    const tab = useDocTabs.getState().tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.kind === 'library') return
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
        ext: tab.path ? getFileExtension(tab.path) : '',
        size: tab.content.length,
        dirty: tab.isDirty,
      })
    })
  }, [])

  const railProjectionSignature = tabs.map((tab) => {
    const appearance = tab.path ? fileAppearances[tab.path] : undefined
    return [
      tab.id,
      tab.path || '',
      tab.title,
      tab.isDirty ? '1' : '0',
      tab.groupId || '',
      tab.id === activeTabId ? '1' : '0',
      tab.id === splitTabId ? '1' : '0',
      appearance?.color || '',
      appearance?.icon || '',
    ].join('\u0000')
  }).join('\u0001')
  const documentRailTabs = useMemo(() => useDocTabs.getState().tabs.map((tab) => {
    const isPrimary = tab.id === useDocTabs.getState().activeTabId
    const isSplit = tab.id === useDocTabs.getState().splitTabId
    const appearance = tab.path ? useWorkspace.getState().fileAppearances[tab.path] : undefined
    return {
      id: tab.id,
      label: tab.title,
      pathLabel: tab.path || undefined,
      title: `${tab.title}${isSplit ? ' (分栏)' : ''}\n按住 Shift 点击可分栏`,
      dotColor: getFileAppearanceColorValue(appearance?.color) ?? getDocumentTabFileTypeColor(tab.path),
      customIcon: appearance?.icon ?? null,
      active: isPrimary,
      secondaryActive: isSplit && !isPrimary,
      dirty: tab.isDirty,
      groupId: tab.groupId ?? null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- railProjectionSignature is a deliberate cache-busting key: the memo reads the stores via getState() and rebuilds only when a rail-visible tab field or file appearance changes
  }), [railProjectionSignature])
  const handleRailTabClose = useCallback((id: string) => closeTab(id), [closeTab])
  const handleRailNewTab = useCallback(() => {
    setEditorMode('preview')
    openTab('')
  }, [openTab])

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

  if (draftBoot !== 'ready') return <DraftBootNotice />

  return (
    <div className="workbench-mode-root" ref={attachDocumentRoot}>
      <DraftControls />
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div className="workbench-canvas-shell document-workbench-canvas-shell flex min-h-0 h-full flex-col">
          {/* Top bar: file path (moved up from the old second row) + panel/mode actions */}
          <div
            className="document-path-bar workbench-tabs-surface glass-surface-panel flex-shrink-0 flex items-center no-drag"
            style={{
              minHeight: WORKBENCH_TAB_ROW_HEIGHT,
              paddingLeft: WORKBENCH_HEADER_EDGE_X,
              paddingRight: WORKBENCH_HEADER_EDGE_X,
              gap: 8,
            }}
          >
            <div
              className="min-w-0 flex-1 truncate"
              style={{ fontSize: 12, color: 'var(--text-light)' }}
              title={activeTabPathLabel}
            >
              {activeTabPathLabel}
            </div>
            {panelTargetTab?.kind !== 'library' && <div className="flex flex-shrink-0 items-center" style={{ gap: 8 }}>
              <DocumentPanelToggleButtons
                outlineOpen={outlinePanelOpen}
                marksOpen={marksPanelOpen}
                onToggleOutline={() => setOutlinePanelOpen((value) => !value)}
                onToggleMarks={() => setMarksPanelOpen((value) => !value)}
                rail
              />
              <DocumentExportButton tab={panelTargetTab} />
              <DocumentBookReadingButton
                active={bookReadingVisible}
                disabled={!bookReadingEligible}
                onToggle={() => {
                  if (bookReadingVisible) {
                    setBookReadingActive(false)
                  } else if (panelTargetTab && bookReadingEligible) {
                    captureVisibleDocumentScrollPositions()
                    setBookReadingTabId(panelTargetTab.id)
                    setBookReadingActive(true)
                  }
                }}
              />
              <DraggableModeSwitch
                mode={editorMode}
                onChange={handleEditorModeChange}
                onModeIntent={handleEditorModeIntent}
              />
            </div>}
          </div>

          <div className="document-workbench-body flex min-h-0 flex-1">
            <DocumentVerticalTabRail
              tabs={documentRailTabs}
              groups={tabGroups}
              onTabClick={handleTabClick}
              onTabClose={handleRailTabClose}
              onNewTab={handleRailNewTab}
              onTabDragStart={handleDragStart}
              onTabDragEnd={handleDragEnd}
              onTabContextMenu={handleTabContextMenu}
              onCreateGroup={createTabGroupFromDrop}
              onAddToGroup={addTabToGroup}
              onReorderToRank={reorderTabToRank}
              onRenameGroup={renameTabGroup}
              onRecolorGroup={recolorTabGroup}
              onSetGroupCollapsed={setTabGroupCollapsed}
              onDisbandGroup={disbandTabGroup}
              onDeleteGroup={handleDeleteGroup}
              onNewTabInGroup={handleNewTabInGroup}
            />

          {/* Content Area — rounded on all four corners so the editor reads as an inset card
              like the browser content viewport. */}
          <div
            className="document-content-frame relative flex-1 min-h-0 overflow-hidden"
            style={{
              borderRadius: 'var(--workbench-canvas-radius)',
              background: 'var(--workbench-module-surface-bg)',
            }}
          >
            <div
              className={bookReadingVisible ? 'h-full min-h-0' : 'contents'}
              style={bookReadingVisible ? { visibility: 'hidden' } : undefined}
              inert={bookReadingVisible || undefined}
              aria-hidden={bookReadingVisible || undefined}
            >
            {renderedSplitTab && renderedActiveTab ? (
              <div className="h-full flex min-w-0 overflow-hidden" ref={splitContainerRef} style={{ gap: 0 }}>
                <div
                  ref={primarySplitPaneRef}
                  className={`document-pane-drop-target flex flex-col min-w-0 overflow-hidden${documentPaneDropTarget === 'primary' ? ' is-document-pane-drop-target' : ''}`}
                  style={{ flexBasis: `${documentSplitRatio}%`, flexShrink: 0, flexGrow: 0 }}
                  onFocusCapture={() => handlePaneActivate(renderedActiveTab.id)}
                  onPointerDownCapture={() => handlePaneActivate(renderedActiveTab.id)}
                  onDragOverCapture={(event) => handleDocumentPaneDragOver(event, 'primary')}
                  onDragLeaveCapture={(event) => handleDocumentPaneDragLeave(event, 'primary')}
                  onDropCapture={(event) => handleDocumentPaneDrop(event, 'primary')}
                >
                  {renderActiveEditor && (
                    <DocumentEditor
                      key={renderedActiveTab.id}
                      bookReading={bookReadingVisible}
                      tab={renderedActiveTab}
                      viewMode={editorMode}
                      previewEditable={editorMode === 'preview'}
                      previewFocusWidgetTitle={previewFocusWidgetTitle}
                      onVisibleLineChange={handlePrimaryVisibleLineChange}
                      onActivate={handlePrimaryActivate}
                      isFocused={!focusedPaneTabId || focusedPaneTabId === renderedActiveTab.id}
                      isSceneVisible={isSceneVisible}
                    />
                  )}
                </div>
                <SplitResizeHandle
                  onResize={handleSplitResize}
                  onResizeStateChange={handleSplitResizeStateChange}
                />
                <div
                  className={`document-pane-drop-target flex-1 flex flex-col min-w-0 overflow-hidden${documentPaneDropTarget === 'split' ? ' is-document-pane-drop-target' : ''}`}
                  onFocusCapture={() => handlePaneActivate(renderedSplitTab.id)}
                  onPointerDownCapture={() => handlePaneActivate(renderedSplitTab.id)}
                  onDragOverCapture={(event) => handleDocumentPaneDragOver(event, 'split')}
                  onDragLeaveCapture={(event) => handleDocumentPaneDragLeave(event, 'split')}
                  onDropCapture={(event) => handleDocumentPaneDrop(event, 'split')}
                >
                  {renderSplitEditor && (
                    <DocumentEditor
                      key={renderedSplitTab.id}
                      bookReading={bookReadingVisible}
                      tab={renderedSplitTab}
                      viewMode={editorMode}
                      previewEditable={editorMode === 'preview'}
                      previewFocusWidgetTitle={previewFocusWidgetTitle}
                      onVisibleLineChange={handleSplitVisibleLineChange}
                      onActivate={handleSplitActivate}
                      isFocused={focusedPaneTabId === renderedSplitTab.id}
                      isSceneVisible={isSceneVisible}
                    />
                  )}
                </div>
              </div>
            ) : renderedActiveTab && renderActiveEditor ? (
              <div
                className="h-full flex flex-col min-w-0 overflow-hidden"
                onFocusCapture={() => handlePaneActivate(renderedActiveTab.id)}
                onPointerDownCapture={() => handlePaneActivate(renderedActiveTab.id)}
              >
                <DocumentEditor
                  key={renderedActiveTab.id}
                  bookReading={bookReadingVisible}
                  tab={renderedActiveTab}
                  viewMode={editorMode}
                  previewEditable={editorMode === 'preview'}
                  previewFocusWidgetTitle={previewFocusWidgetTitle}
                  onVisibleLineChange={handlePrimaryVisibleLineChange}
                  onActivate={handlePrimaryActivate}
                  isFocused={!focusedPaneTabId || focusedPaneTabId === renderedActiveTab.id}
                  isSceneVisible={isSceneVisible}
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
            </div>

            {bookReadingVisible && panelTargetTab && (
              <DocumentBookReadingView
                initialPosition={scrollSnapshots.get(panelTargetTab.objectId || `draft:${panelTargetTab.id}`) ?? readDocumentReadingPositionMap().get(panelTargetTab.objectId || `draft:${panelTargetTab.id}`) ?? null}
                onPositionChange={handleBookPositionChange}
                key={panelTargetTab.id}
                tab={panelTargetTab}
                isSceneVisible={isSceneVisible}
                onExit={() => setBookReadingActive(false)}
              />
            )}

            {isSceneVisible && panelTargetTab && panelTargetTab.kind !== 'library' && (
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
    </div>
  )
}
