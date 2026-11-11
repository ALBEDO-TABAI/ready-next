import { OBJECT_APPEARANCES_KEY, initializeObjectPresentation, projectObjectAppearances, resolvePresentationObject, subscribeObjectPresentation } from './objectPresentationState'
import { create } from 'zustand'
import { readJsonStorage, readStorage, removeStorage, writeJsonStorage, writeStorage } from '../utils/storage'
import {
  validateWorkspaceRoot,
  type WorkspaceValidationResult,
} from '../../shared/workspace-validation'
import type { DocumentWatcherFailedEvent } from '../../shared/document-index-events'
import {
  clearFileAppearanceForPath,
  normalizeFileAppearanceMap,
  removeFileAppearancePath,
  withFileAppearanceColor,
  withFileAppearanceIcon,
  type FileAppearanceColor,
  type FileAppearanceMap,
} from './fileAppearance'

export interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: Date
}

interface SidePanelWidths {
  // The shell's one sidebar: a single width for every mode (W2 §2.2).
  shared: number
}

export interface WorkspaceWatcherFailure {
  workspaceRoot: string
  message: string
  hint?: string
}

export interface WorkspaceWatcherReconcileResult {
  failures: WorkspaceWatcherFailure[]
}

interface WorkspaceState {
  // State
  workspaceRoot: string | null
  currentPath: string
  files: FileItem[]
  selectedFile: string | null
  fileAppearances: FileAppearanceMap
  objectAppearances: FileAppearanceMap
  expandedDirs: Set<string>
  dirChildren: Map<string, FileItem[]>
  pinnedFolders: string[]
  sidebarVisible: boolean
  sidePanelWidths: SidePanelWidths
  skillsSplitRatio: number
  chatPanelVisible: boolean
  chatPanelWidth: number
  renamingPath: string | null
  creatingType: 'file' | 'folder' | null
  creatingPath: string | null
  watcherFailure: WorkspaceWatcherFailure | null

  // Navigation
  setCurrentPath: (path: string) => void
  setFiles: (files: FileItem[]) => void
  selectFile: (path: string | null) => void
  toggleSidebar: () => void
  setSidePanelWidth: (width: number) => void
  setSkillsSplitRatio: (ratio: number) => void
  toggleChatPanel: () => void
  refreshFiles: () => Promise<void>
  toggleDir: (path: string) => Promise<void>
  loadDirChildren: (path: string) => Promise<FileItem[]>
  revealFile: (path: string) => Promise<void>

  // Workspace
  setWorkspaceRoot: (path: string) => WorkspaceValidationResult
  pickWorkspaceRoot: () => Promise<WorkspaceValidationResult>
  clearWorkspace: () => void
  openFolderDialog: () => Promise<void>
  addPinnedFolder: (path: string) => void
  removePinnedFolder: (path: string) => void
  loadSavedWorkspace: (folders: string[]) => void

  // File operations
  createFile: (name: string) => Promise<boolean>
  createFolder: (name: string) => Promise<boolean>
  renameItem: (oldPath: string, newName: string) => Promise<boolean>
  deleteItem: (path: string) => Promise<boolean>
  moveItem: (src: string, dest: string) => Promise<boolean>
  showInFolder: (path: string) => Promise<void>
  copyPathToClipboard: (path: string) => void
  setFileColor: (path: string, color: FileAppearanceColor | null) => Promise<void>
  setFileIcon: (path: string, icon: string | null) => Promise<void>
  clearFileAppearance: (path: string) => Promise<void>

  // Inline editing state
  startRenaming: (path: string) => void
  cancelRenaming: () => void
  startCreating: (type: 'file' | 'folder') => void
  cancelCreating: () => void
}

const getPathSeparator = (path: string): '/' | '\\' => {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

const isWindowsDriveRoot = (path: string): boolean => /^[A-Za-z]:\\?$/.test(path)

const normalizeDirectoryPath = (path: string): string => {
  if (!path) return path
  const separator = getPathSeparator(path)
  if (separator === '\\') {
    if (isWindowsDriveRoot(path)) {
      return path.endsWith('\\') ? path : `${path}\\`
    }
    return path.replace(/\\+$/, '')
  }
  if (path === '/') return '/'
  return path.replace(/\/+$/, '')
}

// Helper to get dirname
const getDirName = (path: string): string => {
  const separator = getPathSeparator(path)
  const normalized = normalizeDirectoryPath(path)
  if (!normalized) return separator

  if (separator === '\\') {
    if (isWindowsDriveRoot(normalized)) return normalized
    const idx = normalized.lastIndexOf('\\')
    if (idx < 0) return normalized
    if (idx <= 2 && /^[A-Za-z]:/.test(normalized)) {
      return `${normalized.slice(0, 2)}\\`
    }
    return normalized.slice(0, idx)
  }

  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '/' : normalized.slice(0, idx)
}

const joinChildPath = (dir: string, name: string): string => {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const normalized = dir.replace(/[\\/]+$/, '')
  if (!normalized) return `${separator}${name}`
  return `${normalized}${separator}${name}`
}

const isSameOrDescendantPath = (path: string, ancestor: string): boolean => {
  const normalizedPath = normalizeDirectoryPath(path)
  const normalizedAncestor = normalizeDirectoryPath(ancestor)
  if (!normalizedPath || !normalizedAncestor) return false
  if (normalizedPath === normalizedAncestor) return true
  const separator = getPathSeparator(normalizedPath)
  return normalizedPath.startsWith(`${normalizedAncestor}${separator}`)
}

const expandDirsForTarget = (
  targetDir: string,
  expandedDirs: Set<string>,
  pinnedFolders: string[],
): Set<string> => {
  const next = new Set(expandedDirs)
  const normalizedTarget = normalizeDirectoryPath(targetDir)
  if (!normalizedTarget || normalizedTarget === '/') return next

  const pinnedAncestor = pinnedFolders.find((folder) => isSameOrDescendantPath(normalizedTarget, folder))
  let cursor = normalizedTarget

  while (cursor) {
    next.add(cursor)

    if (pinnedAncestor && normalizeDirectoryPath(cursor) === normalizeDirectoryPath(pinnedAncestor)) {
      break
    }

    const parent = getDirName(cursor)
    if (!parent || parent === cursor) break
    if (parent === '/' || isWindowsDriveRoot(parent)) {
      if (!pinnedAncestor) next.add(parent)
      break
    }
    cursor = parent
  }

  return next
}

const isKnownDirectoryPath = (
  path: string | null,
  files: FileItem[],
  dirChildren: Map<string, FileItem[]>,
  pinnedFolders: string[],
): boolean => {
  if (!path) return false
  if (pinnedFolders.includes(path)) return true
  if (files.some((item) => item.path === path && item.isDirectory)) return true
  for (const children of dirChildren.values()) {
    if (children.some((item) => item.path === path && item.isDirectory)) return true
  }
  return false
}

const resolveCreationBaseDir = (state: Pick<
  WorkspaceState,
  'currentPath' | 'workspaceRoot' | 'pinnedFolders' | 'selectedFile' | 'files' | 'dirChildren'
>): string => {
  if (!state.workspaceRoot && state.pinnedFolders.length === 0) return ''
  if (isKnownDirectoryPath(state.selectedFile, state.files, state.dirChildren, state.pinnedFolders)) {
    return state.selectedFile as string
  }

  if (state.selectedFile) {
    return getDirName(state.selectedFile)
  }

  if (state.currentPath && state.currentPath !== '/') {
    return state.currentPath
  }

  if (state.workspaceRoot) {
    return state.workspaceRoot
  }

  if (state.pinnedFolders.length > 0) {
    return state.pinnedFolders[0]
  }

  return state.currentPath
}

// perf-rescue B7 → multi-root (2026-05): keep one chokidar watcher per safe
// workspace root in sync with `(workspaceRoot ∪ pinnedFolders)`. Module-scoped
// state survives HMR the same way the previous single-pair did. Failures
// during start are non-fatal — already-running watchers keep working; the
// user can manually reindex on the failed root after fixing it.
//
// Race contract (see plan):
//   - `intendedRoots` is the latest desired set. Updated synchronously by
//     reconcile/ensure/release entrypoints BEFORE any awaited IPC.
//   - After `startWatcher` resolves, ensure re-checks `intendedRoots.has(root)`
//     — if intent has flipped away, the just-issued watcherId is immediately
//     stopped (rollback) and never recorded.
//   - After `stopWatcher` is about to fire in release, release re-checks
//     intent — if the root was added back during the inflight wait, the
//     wanted watcher is preserved.
const watcherIdsByRoot = new Map<string, string>()
const watcherStartInflight = new Map<string, Promise<WorkspaceWatcherFailure | null>>()
const failedWatchersBeforeResponse = new Map<string, DocumentWatcherFailedEvent>()
let intendedRoots: ReadonlySet<string> = new Set()

function recordWatcherFailure(failure: WorkspaceWatcherFailure): WorkspaceWatcherFailure {
  useWorkspace.setState({ watcherFailure: failure })
  return failure
}

function clearWatcherFailureForRoot(root: string): void {
  if (useWorkspace.getState().watcherFailure?.workspaceRoot === root) {
    useWorkspace.setState({ watcherFailure: null })
  }
}

export function handleWorkspaceWatcherFailure(event: DocumentWatcherFailedEvent): boolean {
  const currentId = watcherIdsByRoot.get(event.workspaceRoot)
  if (currentId === event.watcherId) {
    watcherIdsByRoot.delete(event.workspaceRoot)
    recordWatcherFailure({ workspaceRoot: event.workspaceRoot, message: event.message })
    return true
  }
  if (currentId || !intendedRoots.has(event.workspaceRoot) || !watcherStartInflight.has(event.workspaceRoot)) {
    return false
  }
  failedWatchersBeforeResponse.set(event.watcherId, event)
  recordWatcherFailure({ workspaceRoot: event.workspaceRoot, message: event.message })
  return true
}

export function formatWorkspaceWatcherFailure(failure: WorkspaceWatcherFailure | null): string | null {
  if (!failure) return null
  const detail = failure.hint ?? failure.message
  return `文件变化监听不可用：${failure.workspaceRoot}。${detail} 请重试。`
}

/** Pure: roots that pass `validateWorkspaceRoot`. Unsafe pins still show in
 * the file tree but never feed the indexer / watcher / search subsystem. */
export function computeDesiredRoots(
  state: Pick<WorkspaceState, 'workspaceRoot' | 'pinnedFolders'>,
): string[] {
  const union = state.workspaceRoot
    ? [state.workspaceRoot, ...state.pinnedFolders.filter((p) => p !== state.workspaceRoot)]
    : [...state.pinnedFolders]
  return union.filter((root) => validateWorkspaceRoot(root).ok)
}

async function ensureWatcherFor(root: string): Promise<WorkspaceWatcherFailure | null> {
  if (typeof window === 'undefined' || !window.electronAPI?.document) return null
  const doc = window.electronAPI.document
  if (watcherIdsByRoot.has(root)) return null
  const existing = watcherStartInflight.get(root)
  if (existing) return existing
  if (!doc.startWatcher) return null
  const promise = (async () => {
    try {
      const result = await doc.startWatcher({ workspaceRoot: root })
      const watcherId = result?.success ? result.data?.watcherId : undefined
      const beforeResponseFailure = watcherId
        ? failedWatchersBeforeResponse.get(watcherId)
        : undefined
      if (watcherId) failedWatchersBeforeResponse.delete(watcherId)
      // Race check #1: intent may have flipped away during the await
      // (e.g. user clearWorkspace before chokidar `ready`). Roll back
      // the newly-allocated watcher immediately and skip recording it.
      if (!intendedRoots.has(root)) {
        if (watcherId && doc.stopWatcher) {
          try {
            await doc.stopWatcher({ watcherId })
          } catch (error) {
            console.warn('[workspace] watcher race rollback stopWatcher failed:', error)
          }
        }
        return null
      }
      if (result?.success && watcherId) {
        if (beforeResponseFailure) {
          return recordWatcherFailure({
            workspaceRoot: root,
            message: beforeResponseFailure.message,
          })
        }
        watcherIdsByRoot.set(root, watcherId)
        clearWatcherFailureForRoot(root)
        return null
      } else if (result && !result.success) {
        console.warn('[workspace] startWatcher rejected:', result.errorKind, result.error, result.hint)
        return recordWatcherFailure({
          workspaceRoot: root,
          message: result.error || '文件变化监听启动失败。',
          ...(result.hint ? { hint: result.hint } : {}),
        })
      }
      return recordWatcherFailure({ workspaceRoot: root, message: '文件变化监听未返回有效结果。' })
    } catch (error) {
      console.warn('[workspace] startWatcher failed:', error)
      return recordWatcherFailure({
        workspaceRoot: root,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      watcherStartInflight.delete(root)
    }
  })()
  watcherStartInflight.set(root, promise)
  return promise
}

async function releaseWatcherFor(root: string): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.document) return
  const doc = window.electronAPI.document
  // Strip intent first so any inflight start sees the new state on completion.
  if (intendedRoots.has(root)) {
    intendedRoots = new Set([...intendedRoots].filter((r) => r !== root))
  }
  const inflight = watcherStartInflight.get(root)
  if (inflight) {
    try {
      await inflight
    } catch {
      /* inflight failures are already logged in ensureWatcherFor */
    }
  }
  // Race check #2: intent may have flipped BACK during the inflight await
  // (remove → add of the same root). If so, the watcher we were about to
  // stop is now wanted again — leave it alone.
  if (intendedRoots.has(root)) return
  const id = watcherIdsByRoot.get(root)
  if (!id || !doc.stopWatcher) return
  watcherIdsByRoot.delete(root)
  try {
    await doc.stopWatcher({ watcherId: id })
  } catch (error) {
    console.warn('[workspace] stopWatcher failed:', error)
  }
}

async function releaseAllWatchers(): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.document) return
  const doc = window.electronAPI.document
  // Step A: clear intent synchronously. Any inflight start that resolves after
  // this point will observe the empty intent and roll back.
  intendedRoots = new Set()
  // Step B: drain inflight starts. The await yields control, so a concurrent
  // addPinnedFolder MAY run during this window and re-populate `intendedRoots`.
  const inflightPromises = Array.from(watcherStartInflight.values())
  if (inflightPromises.length > 0) {
    await Promise.all(
      inflightPromises.map((p) => p.catch(() => undefined)),
    )
  }
  // Step C: re-check intent BEFORE stopping anything. If a concurrent caller
  // re-armed the desired set (e.g. clearWorkspace immediately followed by
  // addPinnedFolder(X) — both sync entries, then this releaseAll resumes from
  // its await), `intendedRoots` now reflects the latest wishes. Stop ONLY the
  // watchers that are no longer wanted, so we don't kill freshly-needed ones.
  if (!doc.stopWatcher) {
    for (const root of Array.from(watcherIdsByRoot.keys())) {
      if (!intendedRoots.has(root)) watcherIdsByRoot.delete(root)
    }
    return
  }
  const toStop: Array<{ root: string; id: string }> = []
  for (const [root, id] of watcherIdsByRoot.entries()) {
    if (!intendedRoots.has(root)) toStop.push({ root, id })
  }
  for (const { root } of toStop) {
    watcherIdsByRoot.delete(root)
  }
  await Promise.all(
    toStop.map(async ({ id }) => {
      try {
        await doc.stopWatcher!({ watcherId: id })
      } catch (error) {
        console.warn('[workspace] stopWatcher failed during releaseAll:', error)
      }
    }),
  )
}

async function reconcileWatchers(desired: readonly string[]): Promise<WorkspaceWatcherReconcileResult> {
  intendedRoots = new Set(desired)
  const visibleFailure = useWorkspace.getState().watcherFailure
  if (visibleFailure && !intendedRoots.has(visibleFailure.workspaceRoot)) {
    useWorkspace.setState({ watcherFailure: null })
  }
  const current = new Set(watcherIdsByRoot.keys())
  const toStop: string[] = []
  for (const root of current) {
    if (!intendedRoots.has(root)) toStop.push(root)
  }
  const toStart: string[] = []
  for (const root of intendedRoots) {
    if (!watcherIdsByRoot.has(root) && !watcherStartInflight.has(root)) {
      toStart.push(root)
    }
  }
  const results = await Promise.all([
    ...toStop.map(async (root) => {
      await releaseWatcherFor(root)
      return null
    }),
    ...toStart.map((root) => ensureWatcherFor(root)),
  ])
  return {
    failures: results.filter((failure): failure is WorkspaceWatcherFailure => failure !== null),
  }
}

/** Single external entry point for boot / WorkbenchMode reconcile.
 * External callers do not compose root sets themselves — `computeDesiredRoots`
 * is the only place the union rule lives. */
export async function reconcileWorkspaceWatchersFromStore(): Promise<WorkspaceWatcherReconcileResult> {
  return reconcileWatchers(computeDesiredRoots(useWorkspace.getState()))
}

const SIDE_PANEL_WIDTHS_KEY = 'ready-side-panel-widths-v2'
const SKILLS_SPLIT_RATIO_KEY = 'ready-skills-split-ratio-v2'
const DEFAULT_SIDE_PANEL_WIDTH = 220
const MIN_SIDE_PANEL_WIDTH = 220
const MAX_SIDE_PANEL_WIDTH = 420
const DEFAULT_SKILLS_SPLIT_RATIO = 0.5
const MIN_SKILLS_SPLIT_RATIO = 0.25
const MAX_SKILLS_SPLIT_RATIO = 0.75

const clampSidePanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) return DEFAULT_SIDE_PANEL_WIDTH
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(MAX_SIDE_PANEL_WIDTH, Math.round(width)))
}

const clampSkillsSplitRatio = (ratio: number): number => {
  if (!Number.isFinite(ratio)) return DEFAULT_SKILLS_SPLIT_RATIO
  return Math.max(MIN_SKILLS_SPLIT_RATIO, Math.min(MAX_SKILLS_SPLIT_RATIO, ratio))
}

const loadSidePanelWidthsFromStorage = (): SidePanelWidths => {
  const fallback: SidePanelWidths = {
    shared: DEFAULT_SIDE_PANEL_WIDTH,
  }
  try {
    const raw = readStorage(SIDE_PANEL_WIDTHS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<SidePanelWidths> | { files?: number; search?: number; skills?: number }

    // 向后兼容：如果是旧格式，取第一个有效值
    if ('files' in parsed || 'search' in parsed || 'skills' in parsed) {
      const oldParsed = parsed as { files?: number; search?: number; skills?: number }
      const width = oldParsed.files ?? oldParsed.search ?? oldParsed.skills ?? fallback.shared
      return { shared: clampSidePanelWidth(width) }
    }

    // 新格式
    const newParsed = parsed as Partial<SidePanelWidths>
    return {
      shared: clampSidePanelWidth(newParsed.shared ?? fallback.shared),
    }
  } catch {
    return fallback
  }
}

const loadSkillsSplitRatioFromStorage = (): number => {
  const raw = readStorage(SKILLS_SPLIT_RATIO_KEY)
  const parsed = raw ? Number(raw) : Number.NaN
  return clampSkillsSplitRatio(parsed)
}

const remapPathAfterMove = (value: string | null, src: string, dest: string): string | null => {
  if (!value) return value
  if (value === src) return dest
  if (value.startsWith(`${src}/`)) return `${dest}${value.slice(src.length)}`
  if (value.startsWith(`${src}\\`)) return `${dest}${value.slice(src.length)}`
  return value
}

export const useWorkspace = create<WorkspaceState>((set, get) => {

  const cleanupRemovedWorkspacePath = async (path: string): Promise<void> => {
    const state = get()
    const parentPath = getDirName(path)
    if (isSameOrDescendantPath(state.currentPath, path)) {
      set({ currentPath: parentPath })
    }
    await get().refreshFiles()
    const currentState = get()
    const cleanedExpanded = new Set<string>()
    currentState.expandedDirs.forEach((dir) => {
      if (!isSameOrDescendantPath(dir, path)) {
        cleanedExpanded.add(dir)
      }
    })
    const fileAppearances = removeFileAppearancePath(currentState.fileAppearances, path)
    set({
      selectedFile: currentState.selectedFile && isSameOrDescendantPath(currentState.selectedFile, path) ? null : currentState.selectedFile,
      expandedDirs: cleanedExpanded,
      fileAppearances,
    })
    await get().loadDirChildren(parentPath)
  }

  return {
  workspaceRoot: null,
  currentPath: '',
  files: [],
  selectedFile: null,
  objectAppearances: normalizeFileAppearanceMap(readJsonStorage(OBJECT_APPEARANCES_KEY, {} as FileAppearanceMap)),
  fileAppearances: {},
  expandedDirs: new Set<string>(),
  dirChildren: new Map<string, FileItem[]>(),
  pinnedFolders: readJsonStorage('ready-pinned-folders', [] as string[]),
  sidebarVisible: true,
  sidePanelWidths: loadSidePanelWidthsFromStorage(),
  skillsSplitRatio: loadSkillsSplitRatioFromStorage(),
  chatPanelVisible: true,
  chatPanelWidth: 380,
  renamingPath: null,
  creatingType: null,
  creatingPath: null,
  watcherFailure: null,

  setCurrentPath: (path) => {
    set({ currentPath: path })
    get().refreshFiles()
  },

  setFiles: (files) => set({ files }),

  selectFile: (path) => set({ selectedFile: path }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

  setSidePanelWidth: (width) => {
    const clamped = clampSidePanelWidth(width)
    set((state) => {
      const next: SidePanelWidths = {
        shared: clamped,
      }
      if (typeof localStorage !== 'undefined') {
        writeJsonStorage(SIDE_PANEL_WIDTHS_KEY, next)
      }
      return { sidePanelWidths: next }
    })
  },

  setSkillsSplitRatio: (ratio) => {
    const next = clampSkillsSplitRatio(ratio)
    if (get().skillsSplitRatio === next) return
    set({ skillsSplitRatio: next })
    if (typeof localStorage !== 'undefined') {
      writeStorage(SKILLS_SPLIT_RATIO_KEY, String(next))
    }
  },

  toggleChatPanel: () => set((state) => ({ chatPanelVisible: !state.chatPanelVisible })),

  loadDirChildren: async (dirPath) => {
    if (!dirPath || (!get().workspaceRoot && get().pinnedFolders.length === 0)) return []
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.document.listFiles(dirPath)
        if (result.success && result.items) {
          const items: FileItem[] = result.items
            .map((item) => ({
              ...item,
              modified: new Date(item.modified)
            }) as FileItem)
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
              return a.name.localeCompare(b.name)
            })
          set((state) => {
            const next = new Map(state.dirChildren)
            next.set(dirPath, items)
            return { dirChildren: next }
          })
          return items
        }
        set((state) => {
          const next = new Map(state.dirChildren)
          next.set(dirPath, [])
          return { dirChildren: next }
        })
      }
    } catch (error) {
      console.warn('Failed to load dir children:', dirPath, error)
      set((state) => {
        const next = new Map(state.dirChildren)
        next.set(dirPath, [])
        return { dirChildren: next }
      })
    }
    return []
  },

  revealFile: async (path) => {
    const parentDir = getDirName(path)
    const parentParentDir = getDirName(parentDir)
    const state = get()
    const expandedDirs = expandDirsForTarget(parentDir, state.expandedDirs, state.pinnedFolders)
    set({ selectedFile: path, expandedDirs })
    await get().refreshFiles()
    if (parentParentDir && parentParentDir !== parentDir) {
      await get().loadDirChildren(parentParentDir)
    }
    await get().loadDirChildren(parentDir)
  },

  toggleDir: async (path) => {
    const { expandedDirs, dirChildren, loadDirChildren } = get()
    const next = new Set(expandedDirs)
    if (next.has(path)) {
      next.delete(path)
      set({ expandedDirs: next })
    } else {
      next.add(path)
      set({ expandedDirs: next })
      // Lazy load children if not cached
      if (!dirChildren.has(path)) {
        await loadDirChildren(path)
      }
    }
  },

  setWorkspaceRoot: (path) => {
    // Reject dangerous / overly-broad roots before they reach the FTS5 indexer.
    // The renderer can't do an fs read-permission probe; main-process callers
    // get an additional accessCheck via the IPC layer.
    const validation = validateWorkspaceRoot(path)
    if (!validation.ok) {
      console.warn('[workspace] setWorkspaceRoot rejected:', validation.reason, validation.message)
      return validation
    }
    const currentPins = get().pinnedFolders
    const pinnedFolders = [path, ...currentPins.filter((folderPath) => folderPath !== path)]
    set({
      workspaceRoot: path,
      currentPath: path,
      expandedDirs: new Set(),
      dirChildren: new Map(),
      selectedFile: null,
      pinnedFolders,
    })
    writeStorage('ready-workspace-root', path)
    writeJsonStorage('ready-pinned-folders', pinnedFolders)
    // Multi-root reconcile: starts watcher for the new primary (and any pinned
    // folders) while stopping watchers no longer in the desired set.
    void reconcileWatchers(computeDesiredRoots(get()))
    get().refreshFiles()
    return validation
  },

  pickWorkspaceRoot: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.document?.openFolder) {
      return { ok: false, reason: 'empty', message: '当前环境未提供文件夹选择能力。' }
    }
    try {
      // validateAsWorkspace=true asks the main process to run validation
      // (with an fs read-permission probe) before returning the path.
      const result = await window.electronAPI.document.openFolder({ validateAsWorkspace: true })
      if (!result.success || !result.path) {
        // Either user cancelled (error: 'cancelled') or validation rejected
        // the pick. In the validation-reject case, `validationReason` is
        // populated and `error` carries the user-facing message.
        return {
          ok: false,
          reason: (result.validationReason as WorkspaceValidationResult['reason']) || 'empty',
          message: result.error || '已取消选择。',
        }
      }
      return get().setWorkspaceRoot(result.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: 'empty', message }
    }
  },

  clearWorkspace: () => {
    set({
      workspaceRoot: null,
      currentPath: '',
      files: [],
      selectedFile: null,
      expandedDirs: new Set(),
      dirChildren: new Map(),
      pinnedFolders: [],
      renamingPath: null,
      creatingType: null,
      creatingPath: null,
      watcherFailure: null,
    })
    removeStorage('ready-workspace-root')
    removeStorage('ready-pinned-folders')
    // Stop every active chokidar watcher; rolls back any inflight starts too.
    void releaseAllWatchers()
  },

  addPinnedFolder: (path) => {
    const { pinnedFolders, workspaceRoot } = get()
    const validation = workspaceRoot ? null : validateWorkspaceRoot(path)
    const shouldPromote = validation?.ok === true
    if (pinnedFolders.includes(path)) {
      if (shouldPromote) {
        set({ workspaceRoot: path, currentPath: path, expandedDirs: new Set(), dirChildren: new Map(), selectedFile: null })
        writeStorage('ready-workspace-root', path)
        // Multi-root: ensure watcher for the (possibly newly-promoted) root
        // and every other safe pinned folder — also stops any stale watchers.
        void reconcileWatchers(computeDesiredRoots(get()))
        get().refreshFiles()
      } else {
        // Already-pinned path: even when not promoted, the watcher set may
        // need a refresh (e.g. cold-start after manual storage edit).
        void reconcileWatchers(computeDesiredRoots(get()))
      }
      return
    }
    const next = [...pinnedFolders, path]
    set({
      pinnedFolders: next,
      ...(shouldPromote
        ? { workspaceRoot: path, currentPath: path, expandedDirs: new Set(), dirChildren: new Map(), selectedFile: null }
        : {}),
    })
    writeJsonStorage('ready-pinned-folders', next)
    if (shouldPromote) {
      writeStorage('ready-workspace-root', path)
      get().refreshFiles()
    }
    // Core bug fix: subsequent pinned folders previously never reached the
    // watcher / index subsystem. The unconditional reconcile below covers the
    // promote and non-promote branches, applying `computeDesiredRoots`'s safety
    // filter so unsafe pins (e.g. `~`) stay browsable but never get watched.
    void reconcileWatchers(computeDesiredRoots(get()))
  },

  removePinnedFolder: (path) => {
    const { pinnedFolders } = get()
    const next = pinnedFolders.filter(p => p !== path)
    set({ pinnedFolders: next })
    writeJsonStorage('ready-pinned-folders', next)
    // If `path === workspaceRoot`, the path is still in the desired set
    // (workspaceRoot is part of the union), so the reconcile won't stop it.
    void reconcileWatchers(computeDesiredRoots(get()))
  },

  loadSavedWorkspace: (folders) => {
    // If the saved workspace's primary folder is dangerous (e.g. a legacy
    // pre-validation entry that pointed at home), refuse to set it as the
    // workspace root. We still keep the pinned folder list so the user can
    // see what was saved.
    const primary = folders[0]
    const validation = primary ? validateWorkspaceRoot(primary) : null
    const safePrimary = validation && validation.ok ? primary : null
    set({
      pinnedFolders: folders,
      expandedDirs: new Set(),
      dirChildren: new Map(),
      selectedFile: null,
      workspaceRoot: safePrimary,
      currentPath: safePrimary || '',
    })
    writeJsonStorage('ready-pinned-folders', folders)
    if (safePrimary) {
      writeStorage('ready-workspace-root', safePrimary)
    } else {
      removeStorage('ready-workspace-root')
      if (validation && !validation.ok) {
        console.warn('[workspace] loadSavedWorkspace dropped unsafe primary:', validation.reason, validation.message)
      }
    }
    // Multi-root: replace the entire watcher set with the saved folders'
    // safe union. Unsafe folders in the saved set still appear in pinned for
    // browsing, but `computeDesiredRoots` filters them out of the watcher set.
    void reconcileWatchers(computeDesiredRoots(get()))
    get().refreshFiles()
  },

  openFolderDialog: async () => {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.openFolder()
        if (result.success && result.path) {
          get().addPinnedFolder(result.path)
        }
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error)
    }
  },

  refreshFiles: async () => {
    try {
      const { currentPath, workspaceRoot, pinnedFolders } = get()
      if (!currentPath || (!workspaceRoot && pinnedFolders.length === 0)) {
        set({ files: [] })
        return
      }

      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.document.listFiles(currentPath)

        if (result.success && result.items) {
          const items: FileItem[] = result.items
            .map((item) => ({
              ...item,
              modified: new Date(item.modified)
            }) as FileItem)
            // Sort: directories first, then by name
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            // Hide dotfiles
            .filter((item) => !item.name.startsWith('.'))

          set({ files: items })
        }
      } else {
        // Mock files for development
        set({
          files: [
            { name: 'documents', path: `${currentPath === '/' ? '' : currentPath}/documents`, isDirectory: true, size: 0, modified: new Date() },
            { name: 'images', path: `${currentPath === '/' ? '' : currentPath}/images`, isDirectory: true, size: 0, modified: new Date() },
            { name: '项目说明.md', path: `${currentPath === '/' ? '' : currentPath}/项目说明.md`, isDirectory: false, size: 2048, modified: new Date() },
            { name: '需求文档.md', path: `${currentPath === '/' ? '' : currentPath}/需求文档.md`, isDirectory: false, size: 4096, modified: new Date() },
            { name: '设计稿.png', path: `${currentPath === '/' ? '' : currentPath}/设计稿.png`, isDirectory: false, size: 102400, modified: new Date() },
            { name: '演示视频.mp4', path: `${currentPath === '/' ? '' : currentPath}/演示视频.mp4`, isDirectory: false, size: 5242880, modified: new Date() },
            { name: '数据表.xlsx', path: `${currentPath === '/' ? '' : currentPath}/数据表.xlsx`, isDirectory: false, size: 8192, modified: new Date() }
          ]
        })
      }
    } catch (error) {
      console.error('Failed to refresh files:', error)
    }
  },

  createFile: async (name) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    if (!targetDir) return false
    const filePath = joinChildPath(targetDir, name)
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.createFile(filePath)
        if (result.success) {
          if (state.currentPath !== targetDir) {
            set({ currentPath: targetDir })
          }
          await get().refreshFiles()
          await get().loadDirChildren(targetDir)
          set({ creatingType: null, creatingPath: null, selectedFile: filePath })
          return true
        }
      } else {
        // Mock: just add to files list
        set((state) => ({
          files: [...state.files, { name, path: filePath, isDirectory: false, size: 0, modified: new Date() }],
          creatingType: null,
          creatingPath: null,
          selectedFile: filePath,
          currentPath: targetDir,
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to create file:', error)
    }
    return false
  },

  createFolder: async (name) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    if (!targetDir) return false
    const folderPath = joinChildPath(targetDir, name)
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.mkdir(folderPath)
        if (result.success) {
          if (state.currentPath !== targetDir) {
            set({ currentPath: targetDir })
          }
          await get().refreshFiles()
          await get().loadDirChildren(targetDir)
          set({ creatingType: null, creatingPath: null, selectedFile: folderPath })
          return true
        }
      } else {
        set((state) => ({
          files: [...state.files, { name, path: folderPath, isDirectory: true, size: 0, modified: new Date() }],
          creatingType: null,
          creatingPath: null,
          selectedFile: folderPath,
          currentPath: targetDir,
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to create folder:', error)
    }
    return false
  },

  renameItem: async (oldPath, newName) => {
    const dir = getDirName(oldPath)
    const newPath = `${dir}/${newName}`
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.rename(oldPath, newPath)
        if (result.success) {
          await get().refreshFiles()
          set({ renamingPath: null })
          return true
        }
      } else {
        set((state) => ({
          files: state.files.map(f =>
            f.path === oldPath ? { ...f, name: newName, path: newPath } : f
          ),
          renamingPath: null,
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to rename:', error)
    }
    return false
  },

  deleteItem: async (path) => {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.deleteItem(path)
        const alreadyGone = !result.success && /not found|enoent/i.test(String(result.error || ''))
        if (result.success || alreadyGone) {
          await cleanupRemovedWorkspacePath(path)
          return true
        }
      } else {
        set((state) => ({
          files: state.files.filter(f => f.path !== path),
          selectedFile: state.selectedFile === path ? null : state.selectedFile,
          fileAppearances: removeFileAppearancePath(state.fileAppearances, path),
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to delete:', error)
    }
    return false
  },

  moveItem: async (src, dest) => {
    try {
      if (src === dest) return true

      if (window.electronAPI) {
        const result = await window.electronAPI.document.moveItem(src, dest)
        if (!result.success) return false

        set((state) => {
          const remappedExpanded = new Set<string>()
          state.expandedDirs.forEach((dir) => {
            remappedExpanded.add(remapPathAfterMove(dir, src, dest) || dir)
          })
          return {
            selectedFile: remapPathAfterMove(state.selectedFile, src, dest),
            currentPath: remapPathAfterMove(state.currentPath, src, dest) || state.currentPath,
            expandedDirs: remappedExpanded,
            dirChildren: new Map(),
          }
        })

        await get().refreshFiles()
        const expanded = Array.from(get().expandedDirs)
        for (const dir of expanded) {
          await get().loadDirChildren(dir)
        }
        return true
      }

      // Mock fallback
      set((state) => ({
        files: state.files.map((f) => {
          if (f.path === src) {
            return {
              ...f,
              path: dest,
              name: dest.split('/').pop() || f.name,
            }
          }
          return f
        }),
        selectedFile: remapPathAfterMove(state.selectedFile, src, dest),
        currentPath: remapPathAfterMove(state.currentPath, src, dest) || state.currentPath,
      }))
      return true
    } catch (error) {
      console.error('Failed to move item:', error)
    }
    return false
  },

  showInFolder: async (path) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.document.showInFolder(path)
      }
    } catch (error) {
      console.error('showInFolder failed:', error)
    }
  },

  copyPathToClipboard: (path) => {
    navigator.clipboard.writeText(path).catch(console.error)
  },

  setFileColor: async (path, color) => {
    const location = await resolvePresentationObject(path)
    const objectAppearances = withFileAppearanceColor(get().objectAppearances, location.objectId, color)
    localStorage.setItem(OBJECT_APPEARANCES_KEY, JSON.stringify(objectAppearances))
    set({ objectAppearances, fileAppearances: projectObjectAppearances(objectAppearances) })
  },

  setFileIcon: async (path, icon) => {
    const location = await resolvePresentationObject(path)
    const objectAppearances = withFileAppearanceIcon(get().objectAppearances, location.objectId, icon)
    localStorage.setItem(OBJECT_APPEARANCES_KEY, JSON.stringify(objectAppearances))
    set({ objectAppearances, fileAppearances: projectObjectAppearances(objectAppearances) })
  },

  clearFileAppearance: async (path) => {
    const location = await resolvePresentationObject(path)
    const objectAppearances = clearFileAppearanceForPath(get().objectAppearances, location.objectId)
    localStorage.setItem(OBJECT_APPEARANCES_KEY, JSON.stringify(objectAppearances))
    set({ objectAppearances, fileAppearances: projectObjectAppearances(objectAppearances) })
  },

  startRenaming: (path) => set({ renamingPath: path }),
  cancelRenaming: () => set({ renamingPath: null }),
  startCreating: (type) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    if (!targetDir) return
    const expandedDirs = expandDirsForTarget(targetDir, state.expandedDirs, state.pinnedFolders)
    if (targetDir !== state.currentPath) {
      set({
        creatingType: type,
        creatingPath: targetDir,
        currentPath: targetDir,
        selectedFile: targetDir,
        expandedDirs,
      })
      void get().refreshFiles()
      void get().loadDirChildren(targetDir)
      return
    }
    set({ creatingType: type, creatingPath: targetDir, expandedDirs })
    if (!state.dirChildren.has(targetDir)) {
      void get().loadDirChildren(targetDir)
    }
  },
  cancelCreating: () => set({ creatingType: null, creatingPath: null })
}})

const syncObjectAppearances = () => {
  const objectAppearances = normalizeFileAppearanceMap(readJsonStorage(OBJECT_APPEARANCES_KEY, {} as FileAppearanceMap))
  useWorkspace.setState({ objectAppearances, fileAppearances: projectObjectAppearances(objectAppearances) })
}
// Restored tabs can bind their objects before this store loads, so project once on subscribe as well.
subscribeObjectPresentation(syncObjectAppearances)
syncObjectAppearances()
if (typeof window !== 'undefined' && window.electronAPI?.objects) {
  void initializeObjectPresentation().catch(error => console.error('[objects] presentation migration failed', error))
}
