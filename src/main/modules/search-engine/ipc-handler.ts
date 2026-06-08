import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { addDocumentWriteListener } from '../document-engine/ipc-handler'
import { getWorkerDbBridge } from '../database/worker-bridge'
import {
  SearchEngine,
  probeFts5Availability,
} from './indexer'
import {
  createFileWatcher,
  FileWatcherRegistry,
} from './file-watcher'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import {
  noteSearchWorkerSuccess,
  recordSearchWorkerFallback,
} from './worker-fallback-observer'
import { sourceIndexGroup } from './ipc/source-index-group'
import { searchQueryGroup } from './ipc/query-group'
import { watcherGroup } from './ipc/watcher-group'
import type { IpcDisposeHandle } from './ipc/types'

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

/**
 * Stage V V2.4c — dispose handle returned by `watcherGroup.register`.
 * The 2 watcher channels (`document:startWatcher`, `document:stopWatcher`)
 * live in `ipc/watcher-group.ts`; the host keeps the dispose handle so a
 * re-entrant `setupSearchIPC` (dev-reload) can drop the prior registration
 * before the next one binds.
 *
 * M4 IPC handler split complete with V2.4c: `setupSearchIPC` no longer
 * contains any inline `ipcMain.handle(...)` call — all 10 search-engine
 * channels now live in their respective `ipc/*-group.ts` files
 * (sourceIndex × 5 / query × 3 / watcher × 2).
 */
let watcherGroupDispose: IpcDisposeHandle | null = null
let documentWriteIndexDispose: (() => void) | null = null

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

  if (documentWriteIndexDispose) {
    try { documentWriteIndexDispose() } catch { /* ignore */ }
    documentWriteIndexDispose = null
  }
  documentWriteIndexDispose = addDocumentWriteListener((path, content) => {
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

  // Stage V V2.4c — 2 watcher channels (`document:startWatcher`,
  // `document:stopWatcher`) moved into `watcherGroup`. The group handles
  // dev-reload removeHandler pre-clear internally; we hold the dispose
  // handle so a future cleanup hook (or the next setupSearchIPC entry)
  // can drop them on shutdown.
  //
  // perf-rescue B7 context (preserved from the original inline handlers):
  // chokidar file watcher for delta incremental indexing. Renderer calls
  // startWatcher when a workspace becomes active (A2 picker) and
  // stopWatcher on workspace close. The handler routes file change events
  // to single-file `indexDocument` calls — no full rescans.
  if (watcherGroupDispose) {
    try { watcherGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    watcherGroupDispose = null
  }
  watcherGroupDispose = watcherGroup.register(ipcMain, {
    getSearchEngine: () => searchEngine,
    createFileWatcher: (options) => createFileWatcher(options),
    getFileWatcherRegistry: () => fileWatchers,
  })
}

/**
 * Cleanly close every active watcher. Called from `before-quit` so chokidar
 * releases its kqueue/FSEvents/inotify handles before Electron tears the
 * process down.
 */
export async function shutdownFileWatchers(): Promise<number> {
  return fileWatchers.stopAll()
}
