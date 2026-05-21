// Stage V V2.4b — search-engine SearchQueryGroup channel cluster.
//
// Bundles the 3 read-side channels that drive the FTS search surface +
// backlink / graph diagnostics:
//
//   document:searchIndex    (FTS scan over the document index — worker
//                            first → in-process fallback)
//   document:getBacklinks   (in-process repository read: `doc_links` join
//                            against `documents` — no worker path because
//                            backlinks are a tiny join, not a full scan)
//   document:getGraph       (graph BFS — worker only; structured error
//                            bubbled to the renderer on bridge failure,
//                            no in-process fallback per the original
//                            inline handler)
//
// Channels share the `document:` IPC prefix per the V5 allowlist; the file
// location reflects ownership (search-engine), not the channel prefix.
//
// Handler bodies are lifted from `ipc-handler.ts` verbatim (V2.4b is a
// move + thin-wrapper: response shaping, defense-in-depth root validation
// and worker → in-process fallback ordering stay on this side; the worker
// bridge + worker-fallback observers + workspace validator run through
// `EngineDeps` so the group does not import the worker-bridge / observer
// modules directly).
//
// The 3 channels live in one group because they share:
//   • the same domain concept (renderer-facing FTS + link-graph reads
//     against the search index)
//   • the same dispose lifecycle (renderer wires them together — query +
//     graph view share the same surface; backlinks panel reads on the
//     same workspace toggle)
//   • the same dep surface (engine getter + worker bridge facade +
//     workspace validator + worker-fallback observers)
import type { IpcMain } from 'electron'
import type { SearchHit } from '../query'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these five members; nothing more is required to
 * exercise the 3 handler bodies.
 */
export type SearchQueryGroupDeps = Pick<
  EngineDeps,
  | 'getSearchEngine'
  | 'getWorkerBridge'
  | 'validateWorkspaceRoot'
  | 'recordSearchWorkerFallback'
  | 'noteSearchWorkerSuccess'
>

interface SearchIPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

const CHANNELS = [
  'document:searchIndex',
  'document:getBacklinks',
  'document:getGraph',
] as const

export const searchQueryGroup: IpcChannelGroup<SearchQueryGroupDeps> = {
  namespace: 'document:query',

  register(ipcMain: IpcMain, deps: SearchQueryGroupDeps): IpcDisposeHandle {
    // setupSearchIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the V2.4a SourceIndexGroup defensive pattern.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

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
        const searchEngine = deps.getSearchEngine()
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
          const validation = deps.validateWorkspaceRoot(payload.workspaceRoot)
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
            const validation = deps.validateWorkspaceRoot(root)
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
          const result = await deps.getWorkerBridge().searchDocuments({
            query: payload.query,
            limit: payload.limit,
            workspaceRoot: payload.workspaceRoot,
            workspaceRoots: payload.workspaceRoots,
            sources: payload.sources,
          })
          deps.noteSearchWorkerSuccess()
          return { success: true, data: result }
        } catch (workerError) {
          deps.recordSearchWorkerFallback({
            task: 'searchDocuments',
            error: workerError,
            workspaceRoot: payload.workspaceRoot,
          })
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
      'document:getBacklinks',
      async (
        _event,
        payload: { path: string; limit?: number },
      ): Promise<SearchIPCResponse<{ references: Array<{ path: string; name: string; kind: string }> }>> => {
        const searchEngine = deps.getSearchEngine()
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
        const searchEngine = deps.getSearchEngine()
        if (!searchEngine) return { success: false, error: 'search engine unavailable' }
        const depth = typeof payload?.depth === 'number' ? Math.max(1, Math.min(6, payload.depth)) : 2
        const centerPath = typeof payload?.centerPath === 'string' ? payload.centerPath : undefined
        const workspaceRoot = typeof payload?.workspaceRoot === 'string' ? payload.workspaceRoot : undefined
        // perf-rescue B1: graph reads can hit 681K rows + N BFS round-trips.
        // Offload to worker; renderer doesn't need the in-process fallback path
        // because callers handle the structured error.
        try {
          const result = await deps.getWorkerBridge().getDocumentGraph({ depth, centerPath, workspaceRoot })
          return { success: true, data: { nodes: result.nodes, edges: result.edges } }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _searchQueryGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
