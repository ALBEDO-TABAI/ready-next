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
import type { SearchHit } from './query'

interface SearchIPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

let searchEngine: SearchEngine | null = null

export function getSearchEngine(): SearchEngine | null {
  return searchEngine
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
    async (_event, root: string): Promise<SearchIPCResponse<ReindexWorkspaceResult>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required' }
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
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    },
  )

  ipcMain.handle(
    'document:searchIndex',
    async (
      _event,
      payload: { query: string; limit?: number; workspaceRoot?: string; sources?: string[] },
    ): Promise<SearchIPCResponse<{
      items: Array<SearchHit & { sourceType: string; sourceMeta?: Record<string, unknown> | null }>
      stats: { returned: number; elapsedMs: number }
      degraded: boolean
    }>> => {
      if (!searchEngine) {
        return { success: false, error: 'search engine unavailable' }
      }
      if (!payload || typeof payload.query !== 'string') {
        return { success: false, error: 'query required' }
      }
      // perf-rescue B1: FTS scan on multi-GB index — offload to worker.
      try {
        const result = await getWorkerDbBridge().searchDocuments({
          query: payload.query,
          limit: payload.limit,
          workspaceRoot: payload.workspaceRoot,
          sources: payload.sources,
        })
        return { success: true, data: result }
      } catch {
        try {
          const result = await searchEngine.search(payload.query, {
            limit: payload.limit,
            workspaceRoot: payload.workspaceRoot,
            sources: payload.sources,
          })
          return { success: true, data: result }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    },
  )

  ipcMain.handle(
    'document:reindexAllSources',
    async (_event, root: string): Promise<SearchIPCResponse<ReindexAllSourcesResult>> => {
      if (!searchEngine) return { success: false, error: 'search engine unavailable' }
      if (typeof root !== 'string' || root.length === 0) {
        return { success: false, error: 'root path required' }
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
          return { success: false, error: error instanceof Error ? error.message : String(error) }
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
}
