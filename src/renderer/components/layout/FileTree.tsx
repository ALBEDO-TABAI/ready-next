import { useMemo, useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import {
  IconAlertTriangle as AlertTriangle,
  IconFileText as FileText,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconMinus as Minus,
  IconPhoto as Image,
  IconPlus as Plus,
} from '@tabler/icons-react'
import Modal from '../ui/Modal'
import { computeDesiredRoots, useWorkspace, type FileItem } from '../../stores/useWorkspace'
import { normalizeFileAppearanceIcon } from '../../stores/fileAppearance'
import { isImagePreviewPath, useDocTabs } from '../../stores/useDocTabs'
import type { WorkbenchMode } from '../../stores/useMode'
import {
  dispatchFileTreeExternalDropAction,
  getActiveRssItemDragPayload,
  getActiveUntitledDocTabDragPayload,
  parseBrowserTabDragPayload,
  parseRssItemDragPayload,
  parseUntitledDocTabDragPayload,
  parseWebDownloadDragPayload,
  resolveFileTreeDropTarget,
  resolveInternalMoveDir,
  getTargetDirFromDropTarget,
  canMoveAllToDirectory,
  shouldKeepFileTreeDropHintOnLeave,
  UNTITLED_DOC_TAB_DRAG_MIME,
  type FileTreeDropTarget,
  type FileTreeExternalDropAction,
  type FileTreeExternalDropPayload,
  type UntitledDocTabDragPayload,
  type WebDownloadDragPayload,
} from './fileTreeExternalDrop'
import { saveUntitledDocTabToDirectory } from '../../modules/document/untitledDocSave'
import { getActiveBrowserTabDragPayload } from '../../modules/browser/browserTabDragSession'
import { isReadyBoardFile } from '../../../shared/ready-board'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../../modules/browser/localHtmlFileOpen'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'
import {
  compactFileTreeDeleteTargets,
  computeNextFileTreeSelection,
  type FileTreeDeleteTarget,
} from './fileTreeSelection'
import {
  type WorkspaceDragPayload,
} from './fileTreeDragPayload'
import {
  endWorkspaceDragSession,
} from './workspaceDragSession'
import { buildMoveBlockedNotice } from './fileTreeMoveNotice'
import FileEmergenceSection from './FileEmergenceSection'
import { buildFileEmergenceViewModel } from './fileEmergenceViewModel'
import { recordFileEmergenceActivity, readFileEmergenceEnabled } from '../../modules/file-emergence/fileEmergenceClient'
import { createDeferredSnapshotRefresh, type DeferredSnapshotRefresh } from '../../modules/file-emergence/deferredSnapshotRefresh'
import {
  readFileEmergenceDocumentStateSignature,
  readFileEmergenceProjectContextSignature,
  selectFileEmergenceDocumentStateSignature,
  selectFileEmergenceProjectContextSignature,
} from '../../modules/file-emergence/fileEmergenceTabContext'
import {
  buildCurrentDocumentContext,
  readWorkspaceReadingProgress,
} from '../../modules/file-emergence/readingIntentContext'
import type {
  FileEmergenceReadingProgress,
  FileEmergenceProject,
  FileEmergenceSnapshot,
  FileEmergenceRecordActivityPayload,
} from '../../../shared/file-emergence'
import './filesPanelFloatingMenu.css'
import {
  DEFAULT_FILE_FILTERS,
  FILE_TREE_SURFACE_REFRESH_DELAY_MS,
  getParentDir,
  getVisibleTreeItems,
  hasMatchingDescendant,
  isFileAllowed,
  passesFilter,
  type FileTreeProps,
  type FileFilterMap,
  type FileViewMode,
} from './file-tree/file-kinds'
import { readWorkspaceDragPayloads, hasNativeFileDrop, joinPath, buildSelectedDragItemsByPath, fileTreeDropTargetsEqual } from './file-tree/drag-utils'
import { InlineInput } from './file-tree/inline-inputs'
import { FileTreeItem } from './file-tree/FileTreeItem'
import { GridItemCard } from './file-tree/GridItemCard'
import { FileTreeRecursive } from './file-tree/FileTreeRecursive'
import { mapAnalysisJobToPlaceholderPatch, isActiveAnalysisStatus, isTrackedAnalysisPlaceholder, analysisPlaceholderTerminalDelay, buildAnalysisJobKey, type PendingClipPlaceholder } from './file-tree/pending-placeholder-model'
import { FileColorPalette, FileTreeExternalDropMenu, ContextMenuBridge, type FileAppearanceColorMenuState, type FileTreeExternalDropMenuState } from './file-tree/floating-menus'
import { isActiveReadyBoardTab } from './file-tree/ready-board-tab'
import {
  endGeneratedImageDrag,
  getGeneratedImageDragPayload,
  type GeneratedImageDragPayload,
} from '../../modules/image-generation/generatedImageDrag'

export { DEFAULT_FILE_FILTERS } from './file-tree/file-kinds'
export type { FileFilterMap, FileViewMode } from './file-tree/file-kinds'

function revealWorkbenchModeForFileOpen(mode: WorkbenchMode): void {
  requestWorkbenchModeOpen(mode)
}

export default function FileTree({
  query = '',
  filters = DEFAULT_FILE_FILTERS,
  viewMode = 'tree',
  thumbnailSize = 132,
  gridPath,
  onGridPathChange,
  onThumbnailSizeChange,
  onResultCountChange,
  rootFilter,
  showEmergence = true,
}: FileTreeProps) {
  const {
    files,
    selectedFile,
    fileAppearances,
    expandedDirs,
    dirChildren,
    renamingPath,
    creatingType,
    creatingPath,
    pinnedFolders,
    workspaceRoot,
    currentPath,
    toggleDir,
    selectFile,
    renameItem,
    cancelRenaming,
    createFile,
    createFolder,
    cancelCreating,
    openFolderDialog,
    addPinnedFolder,
    moveItem,
    setFileColor,
    setFileIcon,
    loadDirChildren,
    refreshFiles,
    deleteItem,
    removePinnedFolder,
    clearWorkspace,
    loadSavedWorkspace,
  } = useWorkspace()

  const { openTab } = useDocTabs()

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem | null } | null>(null)
  const [colorMenu, setColorMenu] = useState<FileAppearanceColorMenuState | null>(null)
  const [iconPromptItem, setIconPromptItem] = useState<FileItem | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'fs'; targets: FileTreeDeleteTarget[] }
    | { kind: 'unpin'; path: string; name: string }
    | null
  >(null)
  const [externalDropMenu, setExternalDropMenu] = useState<FileTreeExternalDropMenuState | null>(null)
  const [flashingTargetPath, setFlashingTargetPath] = useState<string | null>(null)
  const flashClearTimerRef = useRef<number | null>(null)
  /**
   * Pending background clips, surfaced as placeholder rows in the FileTree so
   * the user gets immediate "处理中" feedback before any file actually appears
   * on disk. Keyed by taskId. `targetDir` decides which folder the row lives
   * in; `status` controls the visual (running / completed / failed). Cleared
   * when the actual file lands (FS watcher) or after a short failure delay.
   */
  const [pendingClips, setPendingClips] = useState<PendingClipPlaceholder[]>([])
  const pendingClipRemoveTimersRef = useRef<Map<string, number>>(new Map())
  const pendingClipsRef = useRef<PendingClipPlaceholder[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [moveDropTargetDir, setMoveDropTargetDir] = useState<string | null>(null)
  const [fileTreeDropTarget, setFileTreeDropTarget] = useState<FileTreeDropTarget | null>(null)
  const [moveNotice, setMoveNotice] = useState<string | null>(null)
  const moveNoticeTimerRef = useRef<number | null>(null)
  const [internalGridPath, setInternalGridPath] = useState<string | null>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const gridPreviewLoadingRef = useRef(new Set<string>())
  const fileTreeSurfaceRefreshTimerRef = useRef<number | null>(null)
  const fileEmergenceRefreshSchedulerRef = useRef<DeferredSnapshotRefresh | null>(null)
  const selectionAnchorPathRef = useRef<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const queryLower = query.trim().toLowerCase()
  const safeWorkspaceRoots = useMemo(
    () => computeDesiredRoots({ workspaceRoot, pinnedFolders }),
    [workspaceRoot, pinnedFolders],
  )
  const safeWorkspaceRootsKey = safeWorkspaceRoots.join('\n')
  const [fileEmergenceEnabled, setFileEmergenceEnabled] = useState<boolean | null>(null)
  const [fileEmergenceSnapshot, setFileEmergenceSnapshot] = useState<FileEmergenceSnapshot | null>(null)
  const [fileEmergenceReadingProgress, setFileEmergenceReadingProgress] = useState<FileEmergenceReadingProgress[]>([])
  const [fileEmergenceRefreshing, setFileEmergenceRefreshing] = useState(false)
  const fileEmergenceProjectContextSignature = useDocTabs(selectFileEmergenceProjectContextSignature)
  const fileEmergenceDocumentStateSignature = useDocTabs(selectFileEmergenceDocumentStateSignature)
  const fileEmergenceProjectContext = useMemo(
    () => readFileEmergenceProjectContextSignature(fileEmergenceProjectContextSignature),
    [fileEmergenceProjectContextSignature],
  )
  const fileEmergenceDocumentState = useMemo(
    () => readFileEmergenceDocumentStateSignature(fileEmergenceDocumentStateSignature),
    [fileEmergenceDocumentStateSignature],
  )
  const effectiveGridPath = gridPath !== undefined ? gridPath : internalGridPath
  const setEffectiveGridPath = onGridPathChange ?? setInternalGridPath
  const activeAnalysisJobKey = useMemo(() => buildAnalysisJobKey(pendingClips), [pendingClips])

  const clearFileTreeDragState = useCallback(() => {
    setIsDragOver(false)
    setMoveDropTargetDir(null)
    setFileTreeDropTarget(null)
    endWorkspaceDragSession()
  }, [])

  const requestFileTreeSurfaceRefresh = useCallback(() => {
    const refresh = window.electronAPI?.window?.refreshTransparentSurface
    if (!refresh) return
    void refresh()
  }, [])

  const scheduleFileTreeSurfaceRefresh = useCallback(() => {
    if (fileTreeSurfaceRefreshTimerRef.current !== null) {
      window.clearTimeout(fileTreeSurfaceRefreshTimerRef.current)
    }
    fileTreeSurfaceRefreshTimerRef.current = window.setTimeout(() => {
      fileTreeSurfaceRefreshTimerRef.current = null
      requestFileTreeSurfaceRefresh()
    }, FILE_TREE_SURFACE_REFRESH_DELAY_MS)
  }, [requestFileTreeSurfaceRefresh])

  const handleFileTreeSurfaceScroll = useCallback(() => {
    scheduleFileTreeSurfaceRefresh()
  }, [scheduleFileTreeSurfaceRefresh])

  const handleFileTreeSurfaceMotion = useCallback(() => {
    scheduleFileTreeSurfaceRefresh()
  }, [scheduleFileTreeSurfaceRefresh])

  useEffect(() => {
    return () => {
      if (fileTreeSurfaceRefreshTimerRef.current !== null) {
        window.clearTimeout(fileTreeSurfaceRefreshTimerRef.current)
        fileTreeSurfaceRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    pendingClipsRef.current = pendingClips
  }, [pendingClips])

  useEffect(() => {
    let disposed = false
    void (async () => {
      const enabled = await readFileEmergenceEnabled()
      if (!disposed) setFileEmergenceEnabled(enabled)
    })()
    return () => { disposed = true }
  }, [])

  const refreshFileEmergenceSnapshot = useCallback(async (forceRefresh = false) => {
    if (
      !showEmergence ||
      fileEmergenceEnabled !== true ||
      safeWorkspaceRoots.length === 0 ||
      viewMode !== 'tree' ||
      queryLower
    ) {
      return
    }
    if (typeof window === 'undefined' || !window.electronAPI?.fileEmergence?.getSnapshot) return
    setFileEmergenceRefreshing(true)
    try {
      const [result, readingProgress] = await Promise.all([
        window.electronAPI.fileEmergence.getSnapshot({
          workspaceRoots: safeWorkspaceRoots,
          forceRefresh,
          projectContext: fileEmergenceProjectContext,
        }),
        readWorkspaceReadingProgress({ workspaceRoots: safeWorkspaceRoots }),
      ])
      if (result.success && result.data) {
        setFileEmergenceSnapshot(result.data)
        setFileEmergenceReadingProgress(readingProgress)
      } else if (forceRefresh) {
        console.warn('[file-emergence] getSnapshot failed', result.error)
      }
    } finally {
      setFileEmergenceRefreshing(false)
    }
  }, [fileEmergenceEnabled, fileEmergenceProjectContext, queryLower, safeWorkspaceRoots, viewMode, showEmergence])

  const refreshFileEmergenceSnapshotRef = useRef(refreshFileEmergenceSnapshot)
  refreshFileEmergenceSnapshotRef.current = refreshFileEmergenceSnapshot

  useEffect(() => {
    const scheduler = createDeferredSnapshotRefresh(() => {
      void refreshFileEmergenceSnapshotRef.current(false)
    })
    fileEmergenceRefreshSchedulerRef.current = scheduler
    return () => {
      scheduler.cancel()
      if (fileEmergenceRefreshSchedulerRef.current === scheduler) {
        fileEmergenceRefreshSchedulerRef.current = null
      }
    }
  }, [])

  const recordFileActivity = useCallback((payload: Omit<FileEmergenceRecordActivityPayload, 'workspaceRoots'>) => {
    if (fileEmergenceEnabled !== true || safeWorkspaceRoots.length === 0) return
    void (async () => {
      await recordFileEmergenceActivity({
        ...payload,
        workspaceRoots: safeWorkspaceRoots,
      })
      fileEmergenceRefreshSchedulerRef.current?.schedule()
    })()
  }, [fileEmergenceEnabled, safeWorkspaceRoots])

  useEffect(() => {
    void refreshFileEmergenceSnapshotRef.current(false)
  }, [fileEmergenceEnabled, fileEmergenceProjectContextSignature, queryLower, safeWorkspaceRootsKey, viewMode])

  useEffect(() => {
    if (!showEmergence || fileEmergenceEnabled !== true || safeWorkspaceRoots.length === 0) {
      setFileEmergenceReadingProgress([])
      return undefined
    }
    let disposed = false
    void readWorkspaceReadingProgress({ workspaceRoots: safeWorkspaceRoots }).then((records) => {
      if (!disposed) setFileEmergenceReadingProgress(records)
    })
    return () => {
      disposed = true
    }
  }, [fileEmergenceEnabled, safeWorkspaceRoots, safeWorkspaceRootsKey, showEmergence])

  useEffect(() => {
    const handleDragCleanup = () => clearFileTreeDragState()
    const handleVisibilityCleanup = () => {
      if (document.visibilityState === 'hidden') {
        clearFileTreeDragState()
      }
    }

    window.addEventListener('dragend', handleDragCleanup)
    window.addEventListener('drop', handleDragCleanup)
    window.addEventListener('blur', handleDragCleanup)
    document.addEventListener('visibilitychange', handleVisibilityCleanup)

    return () => {
      window.removeEventListener('dragend', handleDragCleanup)
      window.removeEventListener('drop', handleDragCleanup)
      window.removeEventListener('blur', handleDragCleanup)
      document.removeEventListener('visibilitychange', handleVisibilityCleanup)
    }
  }, [clearFileTreeDragState])

  useEffect(() => () => {
    if (moveNoticeTimerRef.current) window.clearTimeout(moveNoticeTimerRef.current)
  }, [])

  const shouldPreserveDropHint = useCallback((event: React.DragEvent<HTMLElement>) => {
    const currentTarget = event.currentTarget
    const nextTarget = event.relatedTarget as Node | null
    const rect = currentTarget.getBoundingClientRect()

    return shouldKeepFileTreeDropHintOnLeave({
      clientX: event.clientX,
      clientY: event.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      relatedTargetInside: Boolean(nextTarget && currentTarget.contains(nextTarget)),
    })
  }, [])

  const filteredCurrentItems = useMemo(() => {
    return files
      .filter(isFileAllowed)
      .filter((item) => passesFilter(item, filters))
      .filter((item) => (queryLower ? item.name.toLowerCase().includes(queryLower) : true))
  }, [files, filters, queryLower])

  useEffect(() => {
    onResultCountChange?.(filteredCurrentItems.length)
  }, [filteredCurrentItems.length, onResultCountChange])

  const treeOrderedItems = useMemo(() => {
    if (pinnedFolders.length > 0) {
      const pinnedItems = pinnedFolders.filter((folderPath) => !rootFilter || rootFilter(folderPath)).map((folderPath) => ({
        name: folderPath.split('/').pop() || folderPath,
        path: folderPath,
        isDirectory: true,
        size: 0,
        modified: new Date(),
      }))
      return getVisibleTreeItems(pinnedItems, expandedDirs, dirChildren, queryLower, filters)
    }
    return getVisibleTreeItems(filteredCurrentItems, expandedDirs, dirChildren, queryLower, filters)
  }, [dirChildren, expandedDirs, filteredCurrentItems, filters, pinnedFolders, queryLower, rootFilter])

  const treeOrderedPaths = useMemo(() => treeOrderedItems.map((item) => item.path), [treeOrderedItems])
  const treeDragItemsByPath = useMemo(
    () => buildSelectedDragItemsByPath(selectedPaths, treeOrderedItems),
    [selectedPaths, treeOrderedItems],
  )

  useEffect(() => {
    if (!selectedFile || selectedPaths.has(selectedFile)) return
    selectionAnchorPathRef.current = selectedFile
    setSelectedPaths(new Set([selectedFile]))
  }, [selectedFile, selectedPaths])

  // Background task subscribers keep file-tree placeholders in sync with work
  // that runs outside the right-side agent chat.
  const schedulePlaceholderRemoval = useCallback((taskId: string, delayMs: number) => {
    const existing = pendingClipRemoveTimersRef.current.get(taskId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      setPendingClips((prev) => prev.filter((p) => p.taskId !== taskId))
      pendingClipRemoveTimersRef.current.delete(taskId)
    }, delayMs)
    pendingClipRemoveTimersRef.current.set(taskId, timer)
  }, [])

  const dismissPendingClip = useCallback((taskId: string) => {
    const existing = pendingClipRemoveTimersRef.current.get(taskId)
    if (existing !== undefined) {
      window.clearTimeout(existing)
      pendingClipRemoveTimersRef.current.delete(taskId)
    }
    setPendingClips((prev) => prev.filter((p) => p.taskId !== taskId))
  }, [])

  const flashCompletedPath = useCallback((path?: string | null) => {
    if (!path) return
    setFlashingTargetPath(path)
    if (flashClearTimerRef.current !== null) {
      window.clearTimeout(flashClearTimerRef.current)
    }
    flashClearTimerRef.current = window.setTimeout(() => {
      setFlashingTargetPath(null)
      flashClearTimerRef.current = null
    }, 2500)
  }, [])

  useEffect(() => {
    const pendingClipRemoveTimers = pendingClipRemoveTimersRef.current
    const cleanupStudy = window.electronAPI?.browser?.onContentStudyUpdate?.((data) => {
      if (!data || typeof data !== 'object') return
      const update = data as {
        kind?: string
        taskId: string
        status: string
        url?: string
        copiedPath?: string
        errorKind?: string
        errorMessage?: string
      }
      if (update.kind !== 'study') return
      if (update.status === 'waiting_for_clip') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId ? { ...p, status: 'waiting_for_clip' } : p,
          ),
        )
      } else if (update.status === 'running') {
        setPendingClips((prev) =>
          prev.map((p) => (p.taskId === update.taskId ? { ...p, status: 'running' } : p)),
        )
      } else if (update.status === 'completed') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId
              ? { ...p, status: 'completed', copiedPath: update.copiedPath }
              : p,
          ),
        )
        schedulePlaceholderRemoval(update.taskId, 1500)
        flashCompletedPath(update.copiedPath)
      } else if (update.status === 'failed' || update.status === 'skipped') {
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === update.taskId
              ? {
                  ...p,
                  status: update.status as 'failed' | 'skipped',
                  errorMessage: update.errorMessage || update.errorKind || '失败',
                }
              : p,
          ),
        )
        schedulePlaceholderRemoval(update.taskId, 4000)
      }
    })
    const cleanup = window.electronAPI?.browser?.onClipBackgroundUpdate?.((data) => {
      if (!data || typeof data !== 'object') return
      const update = data as { taskId: string; status: string; url?: string; targetHint?: string }
      if (update.status === 'running') {
        console.info('[obsidian-web-clip] background running', update.taskId, update.url, '→', update.targetHint)
      } else if (update.status === 'completed') {
        const completed = data as {
          taskId: string
          savedPath: string
          preset: { id: string; name: string }
          suggestedVaultRelativePath: string
          copiedPath?: string
          assetPaths?: string[]
          imageDownloadFailures?: number
          copyError?: { kind: string; message: string }
        }
        console.info(
          '[obsidian-web-clip] background completed',
          completed.taskId,
          '→',
          completed.copiedPath || completed.savedPath,
          `(preset: ${completed.preset.id}, vault-rel: ${completed.suggestedVaultRelativePath}, ` +
            `assets: ${completed.assetPaths?.length || 0}, ` +
            `imgFail: ${completed.imageDownloadFailures || 0})`,
        )
        if (completed.copyError) {
          console.warn(
            '[obsidian-web-clip] materialize to dragged folder failed:',
            completed.copyError.kind,
            completed.copyError.message,
          )
        }
        // Update placeholder to "completed" and arm flash on the NEW file.
        // We keep the placeholder briefly so the user sees an explicit
        // "完成" beat; the FS watcher will surface the real file at copiedPath
        // within ~100-500ms and our flash CSS triggers when the new row
        // first renders with isFlashing=true.
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === completed.taskId
              ? {
                  ...p,
                  status: 'completed',
                  copiedPath: completed.copiedPath,
                  message: completed.imageDownloadFailures && completed.imageDownloadFailures > 0
                    ? `图片未全部保存：${completed.imageDownloadFailures} 张仍为远程链接`
                    : null,
                }
              : p,
          ),
        )
        schedulePlaceholderRemoval(completed.taskId, completed.imageDownloadFailures && completed.imageDownloadFailures > 0 ? 4000 : 1200)
        flashCompletedPath(completed.copiedPath)
      } else if (update.status === 'failed') {
        const failed = data as { taskId: string; errorKind: string; recoverable: boolean; errorDetail?: { message?: string } }
        console.warn(
          '[obsidian-web-clip] background failed',
          failed.taskId,
          failed.errorKind,
          'recoverable=' + failed.recoverable,
          failed.errorDetail,
        )
        setPendingClips((prev) =>
          prev.map((p) =>
            p.taskId === failed.taskId
              ? { ...p, status: 'failed', errorMessage: failed.errorDetail?.message || failed.errorKind }
              : p,
          ),
        )
        schedulePlaceholderRemoval(failed.taskId, 4000)
      }
    })
    return () => {
      cleanup?.()
      cleanupStudy?.()
      if (flashClearTimerRef.current !== null) {
        window.clearTimeout(flashClearTimerRef.current)
        flashClearTimerRef.current = null
      }
      for (const timer of pendingClipRemoveTimers.values()) {
        window.clearTimeout(timer)
      }
      pendingClipRemoveTimers.clear()
    }
  }, [flashCompletedPath, schedulePlaceholderRemoval])

  useEffect(() => {
    if (!activeAnalysisJobKey) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const tracked = pendingClipsRef.current.filter((p) =>
        isTrackedAnalysisPlaceholder(p) && isActiveAnalysisStatus(p.status),
      )
      if (tracked.length === 0) return

      try {
        const result = await window.electronAPI?.rss?.listItemAnalysisJobs?.({ limit: 200 })
        if (disposed || !result?.success || !result.data) return

        const jobsById = new Map(result.data.map((job) => [job.id, job]))
        const terminalUpdates: Array<{ taskId: string; delayMs: number; flashPath?: string | null }> = []

        for (const placeholder of pendingClipsRef.current) {
          if (!isTrackedAnalysisPlaceholder(placeholder) || !placeholder.jobId) continue
          const job = jobsById.get(placeholder.jobId)
          if (!job) continue
          const delayMs = analysisPlaceholderTerminalDelay(job.status)
          if (delayMs !== null) {
            terminalUpdates.push({
              taskId: placeholder.taskId,
              delayMs,
              flashPath: job.status === 'success' ? job.reportPath || job.outputDir : null,
            })
          }
        }

        setPendingClips((prev) =>
          prev.map((placeholder) => {
            if (!isTrackedAnalysisPlaceholder(placeholder) || !placeholder.jobId) return placeholder
            const job = jobsById.get(placeholder.jobId)
            return job ? { ...placeholder, ...mapAnalysisJobToPlaceholderPatch(job) } : placeholder
          }),
        )

        for (const update of terminalUpdates) {
          schedulePlaceholderRemoval(update.taskId, update.delayMs)
          flashCompletedPath(update.flashPath)
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(tick, 1400)
        }
      }
    }

    void tick()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [activeAnalysisJobKey, flashCompletedPath, schedulePlaceholderRemoval])

  const handleOpenFile = useCallback((item: FileItem, source: 'file_tree' | 'emergence' = 'file_tree') => {
    selectionAnchorPathRef.current = item.path
    setSelectedPaths(new Set([item.path]))

    if (item.isDirectory) {
      selectFile(item.path)
      if (viewMode === 'tree') {
        void toggleDir(item.path)
      }
      return
    }

    const ext = item.name.split('.').pop()?.toLowerCase() || ''
    selectFile(item.path)
    if (isReadyBoardFile(item.path) || ext === 'canvas') {
      openTab(item.path)
      recordFileActivity({
        path: item.path,
        eventType: 'open',
        source,
      })
      revealWorkbenchModeForFileOpen('document')
      return
    }
    if (isLocalHtmlFilePath(item.path)) {
      void openLocalHtmlFileInBrowser(item.path, item.name).then((opened) => {
        if (opened) {
          recordFileActivity({
            path: item.path,
            eventType: 'open',
            source,
          })
          revealWorkbenchModeForFileOpen('browser')
        }
      })
      return
    }

    const modeMap: Record<string, WorkbenchMode> = {
      md: 'document', txt: 'document', json: 'document', ts: 'document', tsx: 'document',
      js: 'document', css: 'document', docx: 'document', xlsx: 'document',
      png: 'document', jpg: 'document', jpeg: 'document', webp: 'document', svg: 'document', gif: 'document',
      bmp: 'document', ico: 'document',
      pdf: 'document',
      epub: 'document', mobi: 'document', azw: 'document', azw3: 'document', fb2: 'document', cbz: 'document',
      tldr: 'document'
    }
    if (modeMap[ext]) {
      const keepBoardActive = isActiveReadyBoardTab()
      const docTabs = useDocTabs.getState()
      if (isImagePreviewPath(item.path)) {
        docTabs.openImageTab(item.path, { activate: !keepBoardActive })
      } else if (keepBoardActive) {
        docTabs.ensureTabForPath(item.path)
      } else {
        docTabs.openTab(item.path)
      }
      recordFileActivity({
        path: item.path,
        eventType: 'open',
        source,
      })
      if (!keepBoardActive) {
        revealWorkbenchModeForFileOpen(modeMap[ext])
      }
    }
  }, [openTab, recordFileActivity, selectFile, toggleDir, viewMode])

  const handleCreateBoard = useCallback(async (targetDir: string | null) => {
    const parentDir = targetDir || currentPath
    const vault = await window.electronAPI.vault.get()
    if (vault.status !== 'ready') { window.alert('请先配置资料库'); return }
    const root = vault.root
    if (parentDir !== root && !parentDir.startsWith(root + '/')) { window.alert('请在当前资料库中新建画板'); return }
    const name = `新画板-${Date.now()}`
    const path = `${parentDir.slice(root.length).replace(/^\//, '')}${parentDir === root ? '' : '/'}${name}.canvas`
    const result = await window.electronAPI.canvas.create({ path, operationId: crypto.randomUUID() })
    if (!result.ok) { window.alert(result.error); return }
    await window.electronAPI.canvas.release(result.value.handleId)
    const absolutePath = `${root}/${result.value.path}`
    openTab(absolutePath)
    selectFile(absolutePath)
    await refreshFiles()
    await loadDirChildren(parentDir)
    requestWorkbenchModeOpen('document')
  }, [currentPath, loadDirChildren, openTab, refreshFiles, selectFile])

  const handleSelectFile = useCallback((event: React.MouseEvent, item: FileItem, orderedPaths: readonly string[]) => {
    event.preventDefault()
    event.stopPropagation()
    const baseSelectedPaths = selectedPaths.size > 0
      ? selectedPaths
      : selectedFile
        ? new Set([selectedFile])
        : selectedPaths
    const next = computeNextFileTreeSelection(
      {
        selectedPaths: baseSelectedPaths,
        anchorPath: selectionAnchorPathRef.current,
      },
      {
        path: item.path,
        orderedPaths,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      },
    )
    selectionAnchorPathRef.current = next.anchorPath
    setSelectedPaths(next.selectedPaths)
    if (next.selectedPaths.size === 0) selectFile(null)
  }, [selectFile, selectedFile, selectedPaths])

  const showMoveNotice = useCallback((message: string) => {
    if (moveNoticeTimerRef.current) window.clearTimeout(moveNoticeTimerRef.current)
    setMoveNotice(message)
    moveNoticeTimerRef.current = window.setTimeout(() => {
      setMoveNotice(null)
      moveNoticeTimerRef.current = null
    }, 4200)
  }, [])

  const moveWorkspaceItems = useCallback(async (payloads: readonly WorkspaceDragPayload[], targetDir: string) => {
    if (!canMoveAllToDirectory(payloads, targetDir)) return
    const dirName = targetDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || targetDir
    const collided: string[] = []
    const failed: string[] = []
    for (const payload of payloads) {
      const nextPath = joinPath(targetDir, payload.name)
      if (nextPath === payload.path) continue
      // Name collision at the destination: the OS-level move refuses to overwrite,
      // and a swallowed failure looks like nothing happened. Detect it up front so we
      // can tell the user exactly why, and never silently drop the move.
      const existing = await window.electronAPI?.document?.stat?.(nextPath).catch(() => null)
      if (existing?.success) {
        collided.push(payload.name)
        continue
      }
      const ok = await moveItem(payload.path, nextPath)
      if (!ok) failed.push(payload.name)
    }
    const notice = buildMoveBlockedNotice({ dirName, collided, failed })
    if (notice) showMoveNotice(notice)
  }, [moveItem, showMoveNotice])

  const getExternalDropPayload = useCallback(
    (dataTransfer: DataTransfer): FileTreeExternalDropPayload | null => {
      const generatedImage = getGeneratedImageDragPayload(dataTransfer)
      if (generatedImage) return generatedImage
      const untitledDocTab = parseUntitledDocTabDragPayload(dataTransfer.getData(UNTITLED_DOC_TAB_DRAG_MIME))
        ?? getActiveUntitledDocTabDragPayload()
      if (untitledDocTab) return untitledDocTab
      const raw = dataTransfer.getData('application/x-ready-drag')
      const browserTab = parseBrowserTabDragPayload(raw) ?? getActiveBrowserTabDragPayload()
      if (browserTab) return browserTab
      const rssItem = parseRssItemDragPayload(raw) ?? getActiveRssItemDragPayload()
      if (rssItem) return rssItem
      return parseWebDownloadDragPayload(dataTransfer)
    },
    [],
  )

  const handleWebDownloadDrop = useCallback((payload: WebDownloadDragPayload, target: FileTreeDropTarget) => {
    const targetDir = getTargetDirFromDropTarget(target)
    const taskId = `download-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    let urlHost = payload.url
    try {
      urlHost = new URL(payload.url).host || payload.url
    } catch {
      // silent-catch: URL parse fallback for clip-task placeholder host hint; raw URL is shown if parse fails. No user-facing impact.
      urlHost = payload.url
    }
    setPendingClips((prev) => [
      ...prev,
      {
        taskId,
        targetDir,
        urlHost,
        title: payload.name || payload.title || urlHost,
        status: 'running',
        createdAt: Date.now(),
        kind: 'download',
      },
    ])

    const fail = (message: string) => {
      setPendingClips((prev) =>
        prev.map((item) => (item.taskId === taskId ? { ...item, status: 'failed', errorMessage: message } : item)),
      )
      schedulePlaceholderRemoval(taskId, 4000)
    }

    if (payload.unsupportedReason) {
      fail(payload.unsupportedReason)
      return
    }

    void (async () => {
      try {
        const result = await window.electronAPI?.browser?.downloadUrlToDirectory?.({
          url: payload.url,
          targetDir,
          sourcePageUrl: payload.sourcePageUrl,
          suggestedName: payload.suggestedName,
        })
        if (!result?.success) {
          fail(result?.error || '下载失败')
          return
        }
        const savedPath = result.savePath || ''
        setPendingClips((prev) =>
          prev.map((item) =>
            item.taskId === taskId
              ? {
                  ...item,
                  title: result.filename || item.title,
                  status: 'completed',
                  copiedPath: savedPath,
                }
              : item,
          ),
        )
        await refreshFiles()
        await loadDirChildren(targetDir)
        flashCompletedPath(savedPath)
        schedulePlaceholderRemoval(taskId, 1800)
      } catch (error) {
        // silent-catch: failure is surfaced to renderer via fail() callback which drives the placeholder's visible error state. Re-throw would re-fire the IIFE.
        fail(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [flashCompletedPath, loadDirChildren, refreshFiles, schedulePlaceholderRemoval])


  const handleUntitledDocTabDrop = useCallback(async (
    payload: UntitledDocTabDragPayload,
    target: FileTreeDropTarget,
  ) => {
    const targetDir = getTargetDirFromDropTarget(target)
    const dirName = targetDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || targetDir
    const result = await saveUntitledDocTabToDirectory(payload.tabId, targetDir)
    if (result.success) {
      showMoveNotice(`已保存「${result.fileName}」到 ${dirName}`)
      return
    }
    // Cancelling the location picker keeps the draft; only real failures are reported.
    if (result.reason !== 'not-untitled' && result.reason !== 'cancelled') {
      showMoveNotice(`保存到 ${dirName} 失败：${result.error || '未知错误'}`)
    }
  }, [showMoveNotice])

  const handleGeneratedImageDrop = useCallback(async (
    payload: GeneratedImageDragPayload,
    target: FileTreeDropTarget,
  ) => {
    const targetDir = getTargetDirFromDropTarget(target)
    const dirName = targetDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || targetDir
    endGeneratedImageDrag()
    showMoveNotice(`正在保存图片到 ${dirName}...`)
    try {
      const result = await window.electronAPI.imageGeneration.persistToDirectory({
        sourcePath: payload.path,
        directoryPath: targetDir,
      })
      if (!result.success || !result.data) {
        showMoveNotice(`保存到 ${dirName} 失败：${result.error || '未知错误'}`)
        return
      }
      await refreshFiles()
      await loadDirChildren(targetDir)
      flashCompletedPath(result.data.path)
      showMoveNotice(`已保存「${result.data.name}」到 ${dirName}`)
    } catch (error) {
      // silent-catch: the IPC failure is surfaced to the user in the file-tree notice and no success state is applied.
      showMoveNotice(`保存到 ${dirName} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [flashCompletedPath, loadDirChildren, refreshFiles, showMoveNotice])

  const handleResolvedExternalDrop = useCallback((
    payload: FileTreeExternalDropPayload,
    target: FileTreeDropTarget,
    x: number,
    y: number,
  ) => {
    setContextMenu(null)
    if (payload.type === 'generated-image') {
      void handleGeneratedImageDrop(payload, target)
      return
    }
    if (payload.type === 'untitled-doc-tab') {
      void handleUntitledDocTabDrop(payload, target)
      return
    }
    if (payload.type === 'web-download-url') {
      handleWebDownloadDrop(payload, target)
      return
    }
    setExternalDropMenu({ x, y, payload, target })
  }, [handleGeneratedImageDrop, handleUntitledDocTabDrop, handleWebDownloadDrop])

  const handleItemDragOver = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const workspacePayloads = readWorkspaceDragPayloads(e.dataTransfer)
    if (workspacePayloads.length > 0) {
      // Internal move: reuse the same precise drop indicator as external drops so the
      // user can confirm exactly where the item lands (insert line between rows, or a
      // highlight for "into this folder") instead of a coarse whole-directory glow.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const candidate = resolveFileTreeDropTarget({
        itemPath: item.path,
        isDirectory: item.isDirectory,
        containerPath,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
      })
      if (canMoveAllToDirectory(workspacePayloads, getTargetDirFromDropTarget(candidate))) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setMoveDropTargetDir(null)
        setFileTreeDropTarget((current) => (fileTreeDropTargetsEqual(current, candidate) ? current : candidate))
        return
      }
      // Not a valid landing spot for this row (e.g. same folder, or into itself): drop the
      // hint and let the drag bubble to the container fallback.
      setMoveDropTargetDir(null)
      setFileTreeDropTarget((current) => (
        (current?.kind === 'inside-directory' && current.itemPath === item.path) ||
        (current?.kind !== 'inside-directory' && current?.anchorPath === item.path)
          ? null
          : current
      ))
      return
    }

    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setMoveDropTargetDir(null)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setFileTreeDropTarget(
        resolveFileTreeDropTarget({
          itemPath: item.path,
          isDirectory: item.isDirectory,
          containerPath,
          pointerY: e.clientY,
          rectTop: rect.top,
          rectHeight: rect.height,
        }),
      )
    }
  }, [getExternalDropPayload])

  const handleItemDragLeave = useCallback((e: React.DragEvent, item: FileItem) => {
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) return

    if (moveDropTargetDir === item.path) {
      setMoveDropTargetDir(null)
    }

    if (fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path) {
      setFileTreeDropTarget(null)
      return
    }

    if (
      (fileTreeDropTarget?.kind === 'insert-before' || fileTreeDropTarget?.kind === 'insert-after') &&
      fileTreeDropTarget.anchorPath === item.path
    ) {
      setFileTreeDropTarget(null)
    }
  }, [fileTreeDropTarget, moveDropTargetDir, shouldPreserveDropHint])

  const handleItemDrop = useCallback((e: React.DragEvent, item: FileItem, containerPath: string) => {
    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      e.preventDefault()
      e.stopPropagation()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const target = resolveFileTreeDropTarget({
        itemPath: item.path,
        isDirectory: item.isDirectory,
        containerPath,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
      })
      setMoveDropTargetDir(null)
      setFileTreeDropTarget(null)
      handleResolvedExternalDrop(externalPayload, target, e.clientX, e.clientY)
      return
    }

    // Internal move: land the item exactly where the indicator showed. An insert line
    // between rows moves into that row's containing folder; a folder highlight moves inside.
    const workspacePayloads = readWorkspaceDragPayloads(e.dataTransfer)
    if (workspacePayloads.length > 0) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const destDir = resolveInternalMoveDir(workspacePayloads, {
        itemPath: item.path,
        isDirectory: item.isDirectory,
        containerPath,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
      })
      if (destDir) {
        e.preventDefault()
        e.stopPropagation()
        setMoveDropTargetDir(null)
        setFileTreeDropTarget(null)
        void moveWorkspaceItems(workspacePayloads, destDir)
      }
    }
  }, [getExternalDropPayload, handleResolvedExternalDrop, moveWorkspaceItems])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const payloads = readWorkspaceDragPayloads(e.dataTransfer)
    if (canMoveAllToDirectory(payloads, currentPath)) {
      e.dataTransfer.dropEffect = 'move'
      return
    }
    if (getExternalDropPayload(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(false)
      setMoveDropTargetDir(null)
      setFileTreeDropTarget((current) => {
        if (
          current?.kind === 'inside-directory' &&
          current.dirPath === currentPath &&
          current.itemPath === currentPath
        ) {
          return current
        }
        return {
          kind: 'inside-directory',
          dirPath: currentPath,
          itemPath: currentPath,
          containerPath: currentPath,
        }
      })
      return
    }
    if (hasNativeFileDrop(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [currentPath, getExternalDropPayload])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (shouldPreserveDropHint(e as React.DragEvent<HTMLElement>)) {
      return
    }
    clearFileTreeDragState()
  }, [clearFileTreeDragState, shouldPreserveDropHint])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const lastDropTarget = fileTreeDropTarget
    const payloads = readWorkspaceDragPayloads(e.dataTransfer)
    clearFileTreeDragState()
    if (canMoveAllToDirectory(payloads, currentPath)) {
      await moveWorkspaceItems(payloads, currentPath)
      return
    }

    const externalPayload = getExternalDropPayload(e.dataTransfer)
    if (externalPayload) {
      // Fallback target for drops landing in blank container space (no row
      // or directory was the hover target). Without this the drop menu
      // silently fails to appear, which is confusing — the user expects the
      // drop to apply to the folder they're currently viewing.
      const resolvedTarget: FileTreeDropTarget =
        lastDropTarget ?? {
          kind: 'inside-directory',
          dirPath: currentPath,
          itemPath: currentPath,
          containerPath: currentPath,
        }
      handleResolvedExternalDrop(externalPayload, resolvedTarget, e.clientX, e.clientY)
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
  }, [addPinnedFolder, clearFileTreeDragState, fileTreeDropTarget, currentPath, getExternalDropPayload, handleResolvedExternalDrop, moveWorkspaceItems])

  const handleExternalDropAction = useCallback(
    (action: FileTreeExternalDropAction) => {
      if (!externalDropMenu) return
      const { payload, target } = externalDropMenu
      setExternalDropMenu(null)
      void dispatchFileTreeExternalDropAction({
        payload,
        action,
        target,
        onPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [...prev, { ...placeholder, kind: 'clip' }])
        },
        onPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status === 'failed') {
            schedulePlaceholderRemoval(taskId, 4000)
          } else if (patch.status === 'completed') {
            schedulePlaceholderRemoval(taskId, 1800)
          }
        },
        onStudyPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [
            ...prev,
            { ...placeholder, kind: 'study', status: 'waiting_for_clip' },
          ])
        },
        onStudyPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status === 'failed' || patch.status === 'skipped') {
            schedulePlaceholderRemoval(taskId, 4000)
          }
        },
        onAnalysisPlaceholderStart: (placeholder) => {
          setPendingClips((prev) => [
            ...prev,
            {
              ...placeholder,
              kind: placeholder.action === 'copy' ? 'analysis-copy' : 'analysis-visual',
            },
          ])
        },
        onAnalysisPlaceholderUpdate: (taskId, patch) => {
          setPendingClips((prev) =>
            prev.map((p) => (p.taskId === taskId ? { ...p, ...patch } : p)),
          )
          if (patch.status) {
            const delayMs = analysisPlaceholderTerminalDelay(patch.status)
            if (delayMs !== null) {
              schedulePlaceholderRemoval(taskId, delayMs)
            }
          }
          if (patch.status === 'success') {
            flashCompletedPath(patch.copiedPath || patch.reportPath || patch.outputDir)
          }
        },
      })
    },
    [externalDropMenu, flashCompletedPath, schedulePlaceholderRemoval],
  )

  const renderTreeContent = () => {
    const emergenceNode = showEmergence && fileEmergenceViewModel ? (
      <FileEmergenceSection
        viewModel={fileEmergenceViewModel}
        isRefreshing={fileEmergenceRefreshing}
        onRefresh={() => { void refreshFileEmergenceSnapshot(true) }}
        onOpenFile={handleOpenEmergenceFile}
        workspaceRoots={safeWorkspaceRoots}
      />
    ) : null

    if (pinnedFolders.length > 0) {
      const visiblePinned = pinnedFolders.filter((folderPath) => {
        if (rootFilter && !rootFilter(folderPath)) return false
        const folderName = folderPath.split('/').pop() || folderPath
        if (!filters.folder) return false
        if (!queryLower) return true
        if (folderName.toLowerCase().includes(queryLower)) return true
        return hasMatchingDescendant(folderPath, queryLower, filters, dirChildren)
      })

      if (visiblePinned.length === 0 && !creatingType) {
        return (
          <>
            {emergenceNode}
            <div className="flex flex-col items-center justify-center py-12 px-4 text-[var(--text-light)]">
              <FileText style={{ width: 28, height: 28 }} className="mb-2 opacity-40" strokeWidth={1.5} />
              <span className="text-[12px] text-[var(--text-muted)]">没有匹配当前筛选的文件</span>
            </div>
          </>
        )
      }

      return (
        <>
          {emergenceNode}
          {visiblePinned.map((folderPath) => {
        const folderName = folderPath.split('/').pop() || folderPath
        const isExpanded = expandedDirs.has(folderPath)
        const children = dirChildren.get(folderPath) || []
        const browserDropLine =
          fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === folderPath
            ? 'before'
            : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === folderPath
              ? 'after'
              : null
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
              isActive={selectedPaths.size > 0 ? selectedPaths.has(folderPath) : selectedFile === folderPath}
              isExpanded={isExpanded}
              isRenaming={renamingPath === folderPath}
              isDropTarget={moveDropTargetDir === folderPath}
              isBrowserDropInside={
                fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === folderPath
              }
              browserDropLine={browserDropLine}
              isFlashing={flashingTargetPath === folderPath}
              dragMovable={false}
              appearance={fileAppearances[folderPath]}
              depth={0}
              onToggleDir={() => toggleDir(folderPath)}
              onOpenFile={() => handleOpenFile(pinnedItem)}
              onSelectFile={(e) => handleSelectFile(e, pinnedItem, treeOrderedPaths)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setContextMenu({ x: e.clientX, y: e.clientY, item: pinnedItem })
              }}
              onDragOver={(e) => handleItemDragOver(e, pinnedItem, currentPath)}
              onDragLeave={(e) => handleItemDragLeave(e, pinnedItem)}
              onDragStart={clearFileTreeDragState}
              onDragEnd={clearFileTreeDragState}
              onDrop={(e) => handleItemDrop(e, pinnedItem, currentPath)}
              onRenameConfirm={(newName) => renameItem(folderPath, newName)}
              onRenameCancel={cancelRenaming}
            />
            {isExpanded && (
              <FileTreeRecursive
                items={children}
                containerPath={folderPath}
                depth={1}
                selectedFile={selectedFile}
                selectedPaths={selectedPaths}
                dragItemsByPath={treeDragItemsByPath}
                orderedPaths={treeOrderedPaths}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                fileAppearances={fileAppearances}
                renamingPath={renamingPath}
                creatingType={creatingType}
                creatingPath={creatingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                fileTreeDropTarget={fileTreeDropTarget}
                flashingPath={flashingTargetPath}
                pendingClips={pendingClips}
                onToggleDir={toggleDir}
                onOpenFile={handleOpenFile}
                onSelectFile={handleSelectFile}
                onContextMenu={(e, item) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                onItemDragStart={clearFileTreeDragState}
                onItemDragEnd={clearFileTreeDragState}
                onItemDragOver={handleItemDragOver}
                onItemDragLeave={handleItemDragLeave}
                onItemDrop={handleItemDrop}
                onRenameConfirm={(path, newName) => renameItem(path, newName)}
                onRenameCancel={cancelRenaming}
                onCreateConfirm={(newName) => {
                  if (creatingType === 'folder') void createFolder(newName)
                  else if (creatingType === 'file') void createFile(newName)
                }}
                onCreateCancel={cancelCreating}
                onDismissPendingClip={dismissPendingClip}
              />
            )}
          </div>
        )
      })}
        </>
      )
    }

    if (filteredCurrentItems.length === 0 && !creatingType) {
      return (
        <>
          {emergenceNode}
          <div className="flex flex-col items-center justify-center py-12 px-4 text-[var(--text-light)]">
            <FolderOpen style={{ width: 32, height: 32 }} className="mb-3 opacity-40" strokeWidth={1.5} />
            <span style={{ fontSize: 15, fontWeight: 600 }} className="text-[var(--text-muted)] mb-1">还没有打开的文件夹</span>
            <span style={{ fontSize: 13 }} className="text-[var(--text-light)] mb-4 text-center">拖入文件夹或点击下方按钮打开</span>
            <button
              onClick={openFolderDialog}
              className="ready-glass-button text-[13px]"
            >
              <FolderOpen style={{ width: 14, height: 14 }} strokeWidth={2} />
              打开文件夹
            </button>
          </div>
        </>
      )
    }

    return (
      <>
        {emergenceNode}
        <FileTreeRecursive
          items={filteredCurrentItems}
          containerPath={currentPath}
          depth={0}
          selectedFile={selectedFile}
          selectedPaths={selectedPaths}
          dragItemsByPath={treeDragItemsByPath}
          orderedPaths={treeOrderedPaths}
          expandedDirs={expandedDirs}
          dirChildren={dirChildren}
          fileAppearances={fileAppearances}
          renamingPath={renamingPath}
          creatingType={creatingType}
          creatingPath={creatingPath}
          queryLower={queryLower}
          filters={filters}
          moveDropTargetDir={moveDropTargetDir}
          fileTreeDropTarget={fileTreeDropTarget}
          flashingPath={flashingTargetPath}
          pendingClips={pendingClips}
          onToggleDir={toggleDir}
          onOpenFile={handleOpenFile}
          onSelectFile={handleSelectFile}
          onContextMenu={(e, item) => {
            e.preventDefault()
            e.stopPropagation()
            setContextMenu({ x: e.clientX, y: e.clientY, item })
          }}
          onItemDragStart={clearFileTreeDragState}
          onItemDragEnd={clearFileTreeDragState}
          onItemDragOver={handleItemDragOver}
          onItemDragLeave={handleItemDragLeave}
          onItemDrop={handleItemDrop}
          onRenameConfirm={(path, newName) => renameItem(path, newName)}
          onRenameCancel={cancelRenaming}
          onCreateConfirm={(newName) => {
            if (creatingType === 'folder') void createFolder(newName)
            else if (creatingType === 'file') void createFile(newName)
          }}
          onCreateCancel={cancelCreating}
          onDismissPendingClip={dismissPendingClip}
        />
      </>
    )
  }

  // Collect items for grid view based on gridPath navigation
  const gridItems = useMemo(() => {
    // If user has navigated into a subdirectory via grid
    if (effectiveGridPath) {
      const children = dirChildren.get(effectiveGridPath) || []
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
  }, [effectiveGridPath, pinnedFolders, filteredCurrentItems, filters, queryLower, dirChildren])

  const gridNavigateInto = useCallback(async (dirPath: string) => {
    // Ensure children are loaded
    if (!dirChildren.has(dirPath)) {
      await loadDirChildren(dirPath)
    }
    setEffectiveGridPath(dirPath)
  }, [dirChildren, loadDirChildren, setEffectiveGridPath])

  const gridDisplayPath = useMemo(() => {
    if (!effectiveGridPath) return null
    return effectiveGridPath.split('/').pop() || effectiveGridPath
  }, [effectiveGridPath])
  const gridContainerPath = effectiveGridPath ?? currentPath
  const gridOrderedPaths = useMemo(() => gridItems.map((item) => item.path), [gridItems])
  const gridDragItemsByPath = useMemo(
    () => buildSelectedDragItemsByPath(selectedPaths, gridItems),
    [selectedPaths, gridItems],
  )
  const visibleItemsByPath = useMemo(() => {
    const items = viewMode === 'grid' ? gridItems : treeOrderedItems
    return new Map(items.map((item) => [item.path, item]))
  }, [gridItems, treeOrderedItems, viewMode])
  const selectedDeleteTargets = useMemo(() => {
    const targets: FileTreeDeleteTarget[] = []
    for (const path of selectedPaths) {
      const item = visibleItemsByPath.get(path)
      if (item) targets.push({ path: item.path, name: item.name })
    }
    return compactFileTreeDeleteTargets(targets)
  }, [selectedPaths, visibleItemsByPath])
  const selectedMoveItems = useMemo(() => {
    const candidates: FileItem[] = []
    for (const path of selectedPaths) {
      const item = visibleItemsByPath.get(path)
      if (item) candidates.push(item)
    }
    const byPath = new Map(candidates.map((item) => [item.path, item]))
    return compactFileTreeDeleteTargets(candidates.map((item) => ({ path: item.path, name: item.name })))
      .map((target) => byPath.get(target.path))
      .filter((item): item is FileItem => Boolean(item))
  }, [selectedPaths, visibleItemsByPath])
  const gridFolderPreviewKey = useMemo(
    () => gridItems.filter((item) => item.isDirectory).map((item) => item.path).join('\u0000'),
    [gridItems],
  )
  const fileEmergenceViewModel = useMemo(
    () => buildFileEmergenceViewModel({
      snapshot: fileEmergenceSnapshot,
      query,
      viewMode,
      workspaceRoots: safeWorkspaceRoots,
      filters,
      currentDocumentContext: fileEmergenceEnabled === true
        ? buildCurrentDocumentContext({
            tabs: fileEmergenceDocumentState.tabs,
            activeTabId: fileEmergenceDocumentState.activeTabId,
            splitTabId: fileEmergenceDocumentState.splitTabId,
            workspaceRoots: safeWorkspaceRoots,
          })
        : null,
      readingProgress: fileEmergenceEnabled === true ? fileEmergenceReadingProgress : [],
    }),
    [
      fileEmergenceDocumentState,
      fileEmergenceEnabled,
      fileEmergenceReadingProgress,
      fileEmergenceSnapshot,
      filters,
      query,
      safeWorkspaceRoots,
      viewMode,
    ],
  )
  const handleOpenEmergenceFile = useCallback((path: string, _project: FileEmergenceProject) => {
    const name = path.split('/').pop() || path
    handleOpenFile({
      name,
      path,
      isDirectory: false,
      size: 0,
      modified: new Date(),
    }, 'emergence')
  }, [handleOpenFile])

  useEffect(() => {
    if (viewMode !== 'grid') return

    const previewPaths = gridFolderPreviewKey ? gridFolderPreviewKey.split('\u0000') : []
    const missingPaths = previewPaths
      .filter((dirPath) => dirPath && !dirChildren.has(dirPath) && !gridPreviewLoadingRef.current.has(dirPath))
      .slice(0, 18)

    if (missingPaths.length === 0) return

    let cancelled = false

    const hydrateFolderPreviews = async () => {
      for (const dirPath of missingPaths) {
        if (cancelled) break
        gridPreviewLoadingRef.current.add(dirPath)
        try {
          await loadDirChildren(dirPath)
        } finally {
          gridPreviewLoadingRef.current.delete(dirPath)
        }
      }
    }

    void hydrateFolderPreviews()

    return () => {
      cancelled = true
    }
  }, [dirChildren, gridFolderPreviewKey, loadDirChildren, viewMode])

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
          {gridDisplayPath && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={effectiveGridPath || ''}>
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
                  color: 'var(--text-placeholder)', cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                <Minus style={{ width: 11, height: 11 }} />
              </button>
              <div
                style={{
                  position: 'relative', width: 56, height: 6, borderRadius: 4,
                  background: 'var(--files-panel-state-hover-bg)',
                  boxShadow: 'var(--files-panel-state-hover-shadow)',
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
                    position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 4,
                    width: `${((thumbnailSize - 80) / 140) * 100}%`,
                    background: 'var(--text-light)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute', top: '50%',
                    left: `${((thumbnailSize - 80) / 140) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 10, height: 10, borderRadius: '50%',
                    background: 'var(--bg-primary)',
                    boxShadow: 'var(--shadow-sm)',
                    border: '1px solid var(--border-default)',
                  }}
                />
              </div>
              <button
                onClick={() => onThumbnailSizeChange(Math.min(220, thumbnailSize + 20))}
                title="放大缩略图"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 4,
                  color: 'var(--text-placeholder)', cursor: 'pointer',
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
          {creatingType && creatingPath === gridContainerPath && (
            <div
              className="content-surface-card rounded-[8px] border"
              style={{
                padding: '8px 8px 10px',
                borderColor: 'var(--files-panel-state-active-border)',
                background: 'var(--files-panel-state-active-bg)',
                boxShadow: 'var(--files-panel-state-active-shadow)',
              }}
            >
              <div
                className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-content)] flex items-center justify-center"
                style={{ height: Math.max(52, Math.round(thumbnailSize * 0.62)) }}
              >
                {creatingType === 'folder'
                  ? <Folder className="w-[16px] h-[16px]" style={{ color: 'var(--text-muted)' }} />
                  : <FileText className="w-[16px] h-[16px]" style={{ color: 'var(--text-muted)' }} />}
              </div>
              <div className="mt-2 px-1">
                <InlineInput
                  defaultValue={creatingType === 'folder' ? '新建文件夹' : '新建文件.md'}
                  onConfirm={(newName) => {
                    if (creatingType === 'folder') void createFolder(newName)
                    else void createFile(newName)
                  }}
                  onCancel={cancelCreating}
                />
              </div>
            </div>
          )}
          {gridItems.map((item) => {
            const browserDropLine =
              fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === item.path
                ? 'before'
                : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === item.path
                  ? 'after'
                  : null

            return (
              <GridItemCard
                key={item.path}
                item={item}
                isActive={selectedPaths.size > 0 ? selectedPaths.has(item.path) : selectedFile === item.path}
                isDropTarget={
                  item.isDirectory &&
                  (
                    moveDropTargetDir === item.path ||
                    (fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path)
                  )
                }
                browserDropLine={browserDropLine}
                thumbnailSize={thumbnailSize}
                folderChildren={item.isDirectory ? dirChildren.get(item.path) : undefined}
                folderChildrenLoaded={item.isDirectory ? dirChildren.has(item.path) : true}
                dragMovable={!pinnedFolders.includes(item.path)}
                dragItems={gridDragItemsByPath.get(item.path)}
                appearance={fileAppearances[item.path]}
                onOpen={() => {
                  if (item.isDirectory) {
                    handleOpenFile(item)
                  } else {
                    handleOpenFile(item)
                  }
                }}
                onSelect={(e) => handleSelectFile(e, item, gridOrderedPaths)}
                onDoubleClick={item.isDirectory ? () => { void gridNavigateInto(item.path) } : undefined}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setContextMenu({ x: e.clientX, y: e.clientY, item })
                }}
                onDragStart={clearFileTreeDragState}
                onDragEnd={clearFileTreeDragState}
                onDragOver={(e) => handleItemDragOver(e, item, gridContainerPath)}
                onDragLeave={(e) => handleItemDragLeave(e, item)}
                onDrop={(e) => handleItemDrop(e, item, gridContainerPath)}
              />
            )
          })}
        </div>
      </>
    )
  }

  return (
    <div
      ref={treeRootRef}
      data-liquid-scroll-root="file-tree"
      className="panel-hover-scrollbar flex-1 overflow-auto relative"
      style={{ padding: '6px 8px' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseMove={handleFileTreeSurfaceMotion}
      onScroll={handleFileTreeSurfaceScroll}
      onMouseLeave={scheduleFileTreeSurfaceRefresh}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-blue-light)] border-2 border-dashed border-[var(--color-blue)] rounded-lg m-1 pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <FolderOpen className="w-6 h-6 text-[var(--color-blue)]" />
            <span className="text-[12px] font-medium text-[var(--color-blue)]">拖放文件到这里</span>
          </div>
        </div>
      )}

      {viewMode === 'grid' ? renderGridContent() : renderTreeContent()}

      {moveNotice && (
        <div
          className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex items-center gap-2 rounded-[10px] px-3 py-2"
          style={{
            background: 'color-mix(in srgb, var(--bg-primary) 88%, rgba(0,0,0,0.06))',
            border: '1px solid color-mix(in srgb, var(--color-amber, #E9A23B) 42%, transparent)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
            color: 'var(--text-title)',
          }}
          role="status"
        >
          <AlertTriangle className="w-[14px] h-[14px] flex-shrink-0" style={{ color: 'var(--color-amber, #E9A23B)' }} />
          <span className="text-[12px] leading-snug">{moveNotice}</span>
        </div>
      )}

      {contextMenu && (
        <ContextMenuBridge
          contextMenu={contextMenu}
          pinnedFolders={pinnedFolders}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
          onCreateBoard={handleCreateBoard}
          selectedDeleteTargets={selectedDeleteTargets}
          selectedMoveItems={selectedMoveItems}
          onRequestDelete={(targets) => setPendingDelete({ kind: 'fs', targets })}
          onRequestUnpin={({ path, name }) => setPendingDelete({ kind: 'unpin', path, name })}
          workspaceRoot={workspaceRoot}
          onOpenColorMenu={(item, x, y) => setColorMenu({ item, x, y })}
          onOpenIconPrompt={(item) => setIconPromptItem(item)}
        />
      )}

      {colorMenu && (
        <FileColorPalette
          menu={colorMenu}
          boundaryRect={treeRootRef.current?.getBoundingClientRect() ?? null}
          selectedColor={fileAppearances[colorMenu.item.path]?.color ?? null}
          onSetColor={(color) => {
            setFileColor(colorMenu.item.path, color)
            setColorMenu(null)
          }}
          onClose={() => setColorMenu(null)}
        />
      )}

      <Modal
        open={pendingDelete !== null}
        mode="confirm"
        danger
        dimBackdrop={false}
        title={pendingDelete?.kind === 'unpin'
          ? '从列表中移除'
          : pendingDelete && pendingDelete.targets.length > 1
            ? `删除 ${pendingDelete.targets.length} 项`
            : '删除文件'}
        message={
          pendingDelete?.kind === 'unpin'
            ? `确定从文件管理列表里移除 "${pendingDelete.name}" 吗？不会删除磁盘上的实际文件夹。`
            : pendingDelete
              ? pendingDelete.targets.length > 1
                ? `确定删除选中的 ${pendingDelete.targets.length} 项吗？此操作不可恢复。`
                : `确定删除 "${pendingDelete.targets[0]?.name || '所选项目'}" 吗？此操作不可恢复。`
              : ''
        }
        confirmLabel={pendingDelete?.kind === 'unpin'
          ? '移除'
          : '删除'}
        cancelLabel="取消"
        onConfirm={() => {
          if (!pendingDelete) return
          if (pendingDelete.kind === 'fs') {
            const targets = pendingDelete.targets
            void (async () => {
              for (const target of targets) {
                await deleteItem(target.path)
              }
              setSelectedPaths(new Set())
              selectionAnchorPathRef.current = null
              selectFile(null)
            })()
          } else {
            const nextPinnedFolders = pinnedFolders.filter((folderPath) => folderPath !== pendingDelete.path)
            if (pendingDelete.path === workspaceRoot) {
              if (nextPinnedFolders.length > 0) loadSavedWorkspace(nextPinnedFolders)
              else clearWorkspace()
            } else {
              removePinnedFolder(pendingDelete.path)
            }
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <Modal
        open={iconPromptItem !== null}
        mode="prompt"
        dimBackdrop={false}
        title="自定图标"
        message="输入一个表情符号或短文字。"
        defaultValue={iconPromptItem ? fileAppearances[iconPromptItem.path]?.icon ?? '' : ''}
        placeholder="📁"
        confirmLabel="应用"
        cancelLabel="取消"
        onConfirm={(value) => {
          if (iconPromptItem) {
            setFileIcon(iconPromptItem.path, normalizeFileAppearanceIcon(value) ?? null)
          }
          setIconPromptItem(null)
        }}
        onCancel={() => setIconPromptItem(null)}
      />

      {externalDropMenu && (
        <FileTreeExternalDropMenu
          menu={externalDropMenu}
          boundaryRect={treeRootRef.current?.getBoundingClientRect() ?? null}
          onAction={handleExternalDropAction}
          onClose={() => setExternalDropMenu(null)}
        />
      )}

    </div>
  )
}
