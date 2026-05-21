import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { setDocumentWriteIndexHook } from '../document-engine/ipc-handler'
import { getWorkerDbBridge } from '../database/worker-bridge'
import {
  SearchEngine,
  probeFts5Availability,
} from './indexer'
import {
  createFileWatcher,
  FileWatcherRegistry,
  isInotifyExhaustionError,
} from './file-watcher'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import {
  noteSearchWorkerSuccess,
  recordSearchWorkerFallback,
} from './worker-fallback-observer'
import { sourceIndexGroup } from './ipc/source-index-group'
import { searchQueryGroup } from './ipc/query-group'
import type { IpcDisposeHandle } from './ipc/types'

interface SearchIPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

let searchEngine: SearchEngine | null = null

// perf-rescue B7: process-wide registry of active chokidar watchers. Keyed
// by the id we hand back to the renderer (`wch-<hex>`). The registry is
// intentionally module-scoped because watchers outlive any single IPC call —
// the renderer starts on workspace open and stops on workspace close, which
// could be hours later. Tests construct their own registries.
const fileWatchers = new FileWatcherRegistry()

export function getSearchEngine(): SearchEngine | null {
  return searchEngine
}

export function getFileWatcherRegistry(): FileWatcherRegistry {
  return fileWatchers
}

/**
 * Stage V V2.4a — dispose handle returned by `sourceIndexGroup.register`.
 * The 5 source-index channels (`document:listSources`, `document:indexDocument`,
 * `document:reindexAllSources`, `document:reindexWorkspace`,
 * `document:cancelReindex`) live in `ipc/source-index-group.ts`; the host
 * keeps the dispose handle so a re-entrant `setupSearchIPC` (dev-reload)
 * can drop the prior registration before the next one binds.
 */
let sourceIndexGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.4b — dispose handle returned by `searchQueryGroup.register`.
 * The 3 query channels (`document:searchIndex`, `document:getBacklinks`,
 * `document:getGraph`) live in `ipc/query-group.ts`; the host keeps the
 * dispose handle so a re-entrant `setupSearchIPC` (dev-reload) can drop
 * the prior registration before the next one binds.
 */
let searchQueryGroupDispose: IpcDisposeHandle | null = null

export function setupSearchIPC(): void {
  const rawDb = getDatabase().getRawDb()
  if (!rawDb) {
    console.warn('[search-engine] database unavailable; global search disabled')
    searchEngine = null
  } else {
    const fts5Available = probeFts5Availability(rawDb)
    searchEngine = new SearchEngine(rawDb, { fts5Available })
    if (!fts5Available) {
      console.warn('[search-engine] FTS5 not available — running in degraded mode')
    }
  }

  setDocumentWriteIndexHook((path, content) => {
    if (!searchEngine) return
    const root = searchEngine.findWorkspaceRootForPath(path)
    if (!root) return
    void searchEngine.indexDocument(root, path, content).catch((error) => {
      console.warn('[search-engine] indexDocument hook failed', error)
    })
  })

  // Stage V V2.4a — 5 source-index channels (`document:listSources`,
  // `document:indexDocument`, `document:reindexAllSources`,
  // `document:reindexWorkspace`, `document:cancelReindex`) moved into
  // `sourceIndexGroup`. The group handles dev-reload removeHandler
  // pre-clear internally; we hold the dispose handle so a future cleanup
  // hook (or the next setupSearchIPC entry) can drop them on shutdown.
  // Re-binding on dev reload first calls `dispose()` on the prior handle
  // so listener slots stay clean.
  if (sourceIndexGroupDispose) {
    try { sourceIndexGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    sourceIndexGroupDispose = null
  }
  sourceIndexGroupDispose = sourceIndexGroup.register(ipcMain, {
    getSearchEngine: () => searchEngine,
    getWorkerBridge: () => getWorkerDbBridge(),
    validateWorkspaceRoot: (picked) => validateWorkspaceRoot(picked),
    recordSearchWorkerFallback: (payload) => recordSearchWorkerFallback(payload),
    noteSearchWorkerSuccess: () => noteSearchWorkerSuccess(),
  })

  // Stage V V2.4b — 3 query channels (`document:searchIndex`,
  // `document:getBacklinks`, `document:getGraph`) moved into
  // `searchQueryGroup`. The group handles dev-reload removeHandler
  // pre-clear internally; we hold the dispose handle so a future cleanup
  // hook (or the next setupSearchIPC entry) can drop them on shutdown.
  if (searchQueryGroupDispose) {
    try { searchQueryGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    searchQueryGroupDispose = null
  }
  searchQueryGroupDispose = searchQueryGroup.register(ipcMain, {
    getSearchEngine: () => searchEngine,
    getWorkerBridge: () => getWorkerDbBridge(),
    validateWorkspaceRoot: (picked) => validateWorkspaceRoot(picked),
    recordSearchWorkerFallback: (payload) => recordSearchWorkerFallback(payload),
    noteSearchWorkerSuccess: () => noteSearchWorkerSuccess(),
  })

  // -------------------------------------------------------------------------
  // perf-rescue B7: chokidar file watcher for delta incremental indexing.
  // Renderer calls startWatcher when a workspace becomes active (A2 picker)
  // and stopWatcher on workspace close. The handler routes file change events
  // to single-file `indexDocument` calls — no full rescans.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    'document:startWatcher',
    async (
      _event,
      payload: { workspaceRoot: string },
    ): Promise<SearchIPCResponse<{ watcherId: string; workspaceRoot: string }> & {
      errorKind?: 'invalid_root' | 'enospc' | 'failed' | 'engine_unavailable'
      hint?: string
    }> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
      }
      if (!payload || typeof payload.workspaceRoot !== 'string' || payload.workspaceRoot.length === 0) {
        return { success: false, error: 'workspaceRoot required', errorKind: 'invalid_root' }
      }

      const result = await createFileWatcher({
        workspaceRoot: payload.workspaceRoot,
        onChange: async ({ filePath, kind, workspaceRoot }) => {
          if (!searchEngine) return
          try {
            if (kind === 'unlink') {
              // Delete the row from documents (+ FTS via cascade trigger).
              // ensureWorkspace is idempotent — INSERT OR IGNORE + SELECT —
              // and we already validated the root before starting the watcher
              // so the workspace is guaranteed to exist by this point.
              const repo = searchEngine.getRepository()
              const wsId = repo.ensureWorkspace(workspaceRoot)
              repo.deletePath(wsId, filePath)
              return
            }
            // add / change → re-index this single file. The indexer's own
            // `decideFileForIndex` filter will reject binary / oversized
            // files, so we don't pre-filter here.
            await searchEngine.indexDocument(workspaceRoot, filePath)
          } catch (error) {
            // Per-event errors must not crash the watcher. Logged inside the
            // indexer via `logSearch`; we just swallow here.
            void error
          }
        },
      })

      // Discriminate handle vs error by the presence of `id` (handle) /
      // `kind` (error). Using `'kind' in result` narrows correctly because
      // FileWatcherHandle has no `kind` property.
      if ('kind' in result) {
        const hint = result.kind === 'enospc'
          ? 'Linux inotify watch limit exhausted — run: sudo sysctl fs.inotify.max_user_watches=524288'
          : undefined
        return {
          success: false,
          error: result.message,
          errorKind: result.kind,
          ...(hint ? { hint } : {}),
        }
      }

      fileWatchers.add(result)
      return {
        success: true,
        data: { watcherId: result.id, workspaceRoot: result.workspaceRoot },
      }
    },
  )

  ipcMain.handle(
    'document:stopWatcher',
    async (
      _event,
      payload: { watcherId: string },
    ): Promise<SearchIPCResponse<{ stopped: boolean }>> => {
      if (!payload || typeof payload.watcherId !== 'string') {
        return { success: false, error: 'watcherId required' }
      }
      try {
        const stopped = await fileWatchers.stop(payload.watcherId)
        return { success: true, data: { stopped } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // ENOSPC during close shouldn't happen in practice (close releases
        // descriptors) but if some platform raises it we still report ok=false.
        if (isInotifyExhaustionError(error)) {
          return { success: false, error: `inotify error during close: ${message}` }
        }
        return { success: false, error: message }
      }
    },
  )
}

/**
 * Cleanly close every active watcher. Called from `before-quit` so chokidar
 * releases its kqueue/FSEvents/inotify handles before Electron tears the
 * process down.
 */
export async function shutdownFileWatchers(): Promise<number> {
  return fileWatchers.stopAll()
}
