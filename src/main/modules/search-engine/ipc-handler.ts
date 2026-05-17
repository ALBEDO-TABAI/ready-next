import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { setDocumentWriteIndexHook } from '../document-engine/ipc-handler'
import { getWorkerDbBridge } from '../database/worker-bridge'
import {
  SearchEngine,
  probeFts5Availability,
  type ReindexAllSourcesResult,
  type ReindexWorkspaceResult,
} from './indexer'
import {
  createFileWatcher,
  FileWatcherRegistry,
  isInotifyExhaustionError,
} from './file-watcher'
import type { SearchHit } from './query'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'

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

  ipcMain.handle(
    'document:reindexWorkspace',
    async (_event, root: string): Promise<SearchIPCResponse<ReindexWorkspaceResult> & {
      errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
      validationReason?: string
    }> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
      }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required', errorKind: 'invalid_root' }
      }
      // Defense-in-depth: even if the renderer's computeDesiredRoots filter
      // is bypassed (older callers, tests, future code paths), we never let
      // the indexer touch a forbidden tree like `~` / `/Users/<x>`.
      const validation = validateWorkspaceRoot(root)
      if (!validation.ok) {
        return {
          success: false,
          error: validation.message ?? 'unsafe workspace root',
          errorKind: 'invalid_root',
          validationReason: validation.reason,
        }
      }
      // perf-rescue B1: reindex walks the full workspace + writes batches.
      // Run in worker; on bridge failure fall back to in-process engine.
      try {
        const result = await getWorkerDbBridge().reindexWorkspace({ root })
        return { success: true, data: result }
      } catch {
        try {
          const result = await searchEngine.reindexWorkspace({ root })
          return { success: true, data: result }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'failed' }
        }
      }
    },
  )

  ipcMain.handle(
    'document:searchIndex',
    async (
      _event,
      payload: {
        query: string
        limit?: number
        workspaceRoot?: string
        workspaceRoots?: string[]
        sources?: string[]
      },
    ): Promise<SearchIPCResponse<{
      items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
      stats: { returned: number; elapsedMs: number }
      degraded: boolean
    }> & {
      errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
      validationReason?: string
    }> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
      }
      if (!payload || typeof payload.query !== 'string') {
        return { success: false, error: 'query required' }
      }
      // Defense-in-depth: even though the renderer's computeDesiredRoots
      // pre-filters unsafe paths, a buggy or malicious caller could still
      // pass `~` / `/Users/<x>` / `/Volumes/<x>` here. We hard-reject so
      // search never operates on a forbidden tree (even if a stale row for
      // one survives in the DB — engine-side filtering covers that path
      // separately).
      if (typeof payload.workspaceRoot === 'string' && payload.workspaceRoot.length > 0) {
        const validation = validateWorkspaceRoot(payload.workspaceRoot)
        if (!validation.ok) {
          return {
            success: false,
            error: validation.message ?? 'unsafe workspace root',
            errorKind: 'invalid_root',
            validationReason: validation.reason,
          }
        }
      }
      if (Array.isArray(payload.workspaceRoots)) {
        for (const root of payload.workspaceRoots) {
          if (typeof root !== 'string') continue
          const validation = validateWorkspaceRoot(root)
          if (!validation.ok) {
            return {
              success: false,
              error: validation.message ?? 'unsafe workspace root',
              errorKind: 'invalid_root',
              validationReason: validation.reason,
            }
          }
        }
      }
      // perf-rescue B1: FTS scan on multi-GB index — offload to worker.
      try {
        const result = await getWorkerDbBridge().searchDocuments({
          query: payload.query,
          limit: payload.limit,
          workspaceRoot: payload.workspaceRoot,
          workspaceRoots: payload.workspaceRoots,
          sources: payload.sources,
        })
        return { success: true, data: result }
      } catch {
        try {
          const result = await searchEngine.search(payload.query, {
            limit: payload.limit,
            workspaceRoot: payload.workspaceRoot,
            workspaceRoots: payload.workspaceRoots,
            sources: payload.sources,
          })
          return { success: true, data: result }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'failed' }
        }
      }
    },
  )

  ipcMain.handle(
    'document:reindexAllSources',
    async (_event, root: string): Promise<SearchIPCResponse<ReindexAllSourcesResult> & {
      errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
      validationReason?: string
    }> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required', errorKind: 'invalid_root' }
      }
      // Same defense-in-depth gate as document:reindexWorkspace. Forbidden
      // roots never enter the worker / fallback search engine.
      const validation = validateWorkspaceRoot(root)
      if (!validation.ok) {
        return {
          success: false,
          error: validation.message ?? 'unsafe workspace root',
          errorKind: 'invalid_root',
          validationReason: validation.reason,
        }
      }
      // perf-rescue B1: full multi-source reindex — offload to worker.
      try {
        const result = await getWorkerDbBridge().reindexAllSources({ root })
        return { success: true, data: result }
      } catch {
        try {
          const result = await searchEngine.reindexAllSources({ root })
          return { success: true, data: result }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'failed' }
        }
      }
    },
  )

  ipcMain.handle(
    'document:listSources',
    async (): Promise<SearchIPCResponse<{ sources: string[] }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      return { success: true, data: { sources: searchEngine.listSourceTypes() } }
    },
  )

  // perf-rescue B6: cancel any in-flight reindex inside the db-worker. The
  // worker tracks active reindex AbortControllers by request id and aborts
  // them all when this command arrives. No-op if no reindex is running, so
  // it's safe to call defensively (e.g. on workspace close / app quit).
  ipcMain.handle(
    'document:cancelReindex',
    async (): Promise<SearchIPCResponse<{ cancelled: number }>> => {
      try {
        const cancelled = await getWorkerDbBridge().cancelReindex()
        return { success: true, data: { cancelled } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:indexDocument',
    async (
      _event,
      payload: { path: string; root?: string; content?: string },
    ): Promise<SearchIPCResponse<{ ok: boolean; documentId?: number; skipped?: boolean; error?: string }>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) {
        return { success: false, error: 'path required' }
      }
      const root = payload.root && payload.root.length > 0
        ? payload.root
        : searchEngine.findWorkspaceRootForPath(payload.path)
      if (!root) {
        return { success: false, error: 'workspace root not found for path' }
      }
      try {
        const result = await searchEngine.indexDocument(root, payload.path, payload.content)
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:getBacklinks',
    async (
      _event,
      payload: { path: string; limit?: number },
    ): Promise<SearchIPCResponse<{ references: Array<{ path: string; name: string; kind: string }> }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      if (!payload || typeof payload.path !== 'string') return { success: false, error: 'path required' }
      const limit = typeof payload.limit === 'number' ? Math.max(1, Math.min(200, payload.limit)) : 50
      try {
        const db = searchEngine.getRepository().getConnection()
        const target = db
          .prepare('SELECT id FROM documents WHERE path = ? LIMIT 1')
          .get<{ id: number }>(payload.path)
        if (!target) return { success: true, data: { references: [] } }
        const rows = db
          .prepare(
            `SELECT src.path AS path, src.name AS name, dl.kind AS kind
             FROM doc_links dl
             JOIN documents src ON src.id = dl.src_doc_id
             WHERE dl.target_doc_id = ? AND src.source_type = 'document'
             LIMIT ?`,
          )
          .all<{ path: string; name: string; kind: string }>(target.id, limit)
        return { success: true, data: { references: rows } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'document:getGraph',
    async (
      _event,
      payload: { centerPath?: string; depth?: number; workspaceRoot?: string } | undefined,
    ): Promise<SearchIPCResponse<{
      nodes: Array<{ id: string; type: 'doc' | 'tag' | 'ghost'; label: string; sourceType?: string }>
      edges: Array<{ source: string; target: string; kind: string }>
    }>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      const depth = typeof payload?.depth === 'number' ? Math.max(1, Math.min(6, payload.depth)) : 2
      const centerPath = typeof payload?.centerPath === 'string' ? payload.centerPath : undefined
      const workspaceRoot = typeof payload?.workspaceRoot === 'string' ? payload.workspaceRoot : undefined
      // perf-rescue B1: graph reads can hit 681K rows + N BFS round-trips.
      // Offload to worker; renderer doesn't need the in-process fallback path
      // because callers handle the structured error.
      try {
        const result = await getWorkerDbBridge().getDocumentGraph({ depth, centerPath, workspaceRoot })
        return { success: true, data: { nodes: result.nodes, edges: result.edges } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

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
