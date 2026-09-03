// Stage V V2.4a — search-engine SourceIndexGroup channel cluster.
//
// Bundles the 4 channels that drive workspace-wide indexing + per-document
// indexing + source-type discovery:
//
//   document:listSources         (list registered source types — synchronous
//                                 read from the in-process engine)
//   document:indexDocument       (index one file → returns documentId or
//                                 `skipped`/`error`)
//   document:reindexAllSources   (full multi-source reindex of a workspace,
//                                 worker first → in-process fallback)
//   document:reindexWorkspace    (file-system reindex of a workspace root,
//                                 worker first → in-process fallback)
//
// Channels use the `document:` IPC prefix because the renderer-facing
// search surface was registered under the document namespace per the V5
// allowlist; the file location reflects ownership (search-engine), not
// the channel prefix.
//
// Handler bodies are lifted from `ipc-handler.ts` verbatim (V2.4a is a
// move + thin-wrapper: response shaping, defense-in-depth root
// validation and worker → in-process fallback ordering stay on this
// side; the worker bridge + worker-fallback observers + workspace
// validator run through `EngineDeps` so the group does not import the
// worker-bridge / observer modules directly).
//
// The 4 channels live in one group because they share:
//   • the same domain concept (search-index lifecycle for a workspace)
//   • the same dispose lifecycle (renderer wires them together — start
//     reindex on workspace open)
//   • the same dep surface (engine getter + worker bridge facade +
//     workspace validator + worker-fallback observers)
// `document:searchIndex` / `document:getBacklinks` / `document:getGraph`
// stay in the host for now — those belong in a separate
// SearchQueryGroup (V2.4b) because they consume the FTS surface and
// independent diagnostic gating.
import type { IpcMain } from 'electron'
import { FS_SOURCE_TYPE } from '../../../../shared/search-source-types'
import type {
  ReindexAllSourcesResult,
  ReindexWorkspaceResult,
} from '../indexer'
import type { EngineDeps } from './engine-deps'
import { publishDocumentIndexChanged } from './document-index-events'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these five members; nothing more is required to
 * exercise the 5 handler bodies.
 */
export type SourceIndexGroupDeps = Pick<
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
  'document:listSources',
  'document:indexDocument',
  'document:reindexAllSources',
  'document:reindexWorkspace',
] as const

export const sourceIndexGroup: IpcChannelGroup<SourceIndexGroupDeps> = {
  namespace: 'document:sourceIndex',

  register(ipcMain: IpcMain, deps: SourceIndexGroupDeps): IpcDisposeHandle {
    // setupSearchIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // the document-engine groups (V2.3a) and rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle(
      'document:reindexWorkspace',
      async (event, root: string): Promise<SearchIPCResponse<ReindexWorkspaceResult> & {
        errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
        validationReason?: string
      }> => {
        const searchEngine = deps.getSearchEngine()
        if (!searchEngine) {
          return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
        }
        if (typeof root !== 'string' || root.length === 0) {
          return { success: false, error: 'root path required', errorKind: 'invalid_root' }
        }
        // Defense-in-depth: even if the renderer's computeDesiredRoots filter
        // is bypassed (older callers, tests, future code paths), we never let
        // the indexer touch a forbidden tree like `~` / `/Users/<x>`.
        const validation = deps.validateWorkspaceRoot(root)
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
          const result = await deps.getWorkerBridge().reindexWorkspace({ root })
          deps.noteSearchWorkerSuccess()
          if (result.ok && (result.indexed > 0 || result.removed > 0)) {
            publishDocumentIndexChanged(event.sender, {
              workspaceRoot: root,
              reason: 'rebuild',
              changedPaths: [],
            })
          }
          return { success: true, data: result }
        } catch (workerError) {
          // Stage U / U8.1 — log fallback so we can see how often the worker
          // boundary is bypassed. Fallback behavior itself is unchanged.
          deps.recordSearchWorkerFallback({ task: 'reindexWorkspace', error: workerError, workspaceRoot: root })
          try {
            const result = await searchEngine.reindexWorkspace({ root })
            if (result.ok && (result.indexed > 0 || result.removed > 0)) {
              publishDocumentIndexChanged(event.sender, {
                workspaceRoot: root,
                reason: 'rebuild',
                changedPaths: [],
              })
            }
            return { success: true, data: result }
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'failed' }
          }
        }
      },
    )

    ipcMain.handle(
      'document:reindexAllSources',
      async (event, root: string): Promise<SearchIPCResponse<ReindexAllSourcesResult> & {
        errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
        validationReason?: string
      }> => {
        const searchEngine = deps.getSearchEngine()
        if (!searchEngine) return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
        if (typeof root !== 'string' || root.length === 0) {
          return { success: false, error: 'root path required', errorKind: 'invalid_root' }
        }
        // Same defense-in-depth gate as document:reindexWorkspace. Forbidden
        // roots never enter the worker / fallback search engine.
        const validation = deps.validateWorkspaceRoot(root)
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
          const result = await deps.getWorkerBridge().reindexAllSources({ root })
          deps.noteSearchWorkerSuccess()
          const fsResult = result.perSource[FS_SOURCE_TYPE]
          if (result.ok && fsResult && (fsResult.indexed > 0 || fsResult.removed > 0)) {
            publishDocumentIndexChanged(event.sender, {
              workspaceRoot: root,
              reason: 'rebuild',
              changedPaths: [],
            })
          }
          return { success: true, data: result }
        } catch (workerError) {
          deps.recordSearchWorkerFallback({ task: 'reindexAllSources', error: workerError, workspaceRoot: root })
          try {
            const result = await searchEngine.reindexAllSources({ root })
            const fsResult = result.perSource[FS_SOURCE_TYPE]
            if (result.ok && fsResult && (fsResult.indexed > 0 || fsResult.removed > 0)) {
              publishDocumentIndexChanged(event.sender, {
                workspaceRoot: root,
                reason: 'rebuild',
                changedPaths: [],
              })
            }
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
        const searchEngine = deps.getSearchEngine()
        if (!searchEngine) return { success: false, error: 'search engine unavailable' }
        return { success: true, data: { sources: searchEngine.listSourceTypes() } }
      },
    )

    ipcMain.handle(
      'document:indexDocument',
      async (
        event,
        payload: { path: string; root?: string; content?: string },
      ): Promise<SearchIPCResponse<{ ok: boolean; documentId?: number; skipped?: boolean; error?: string }>> => {
        const searchEngine = deps.getSearchEngine()
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
          if (result.ok && !result.skipped) {
            publishDocumentIndexChanged(event.sender, {
              workspaceRoot: root,
              reason: 'incremental',
              changedPaths: [payload.path],
            })
          }
          return { success: true, data: result }
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
export const _sourceIndexGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
