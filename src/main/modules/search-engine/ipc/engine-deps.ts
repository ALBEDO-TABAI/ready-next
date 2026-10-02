// Stage V V2.4a — search-engine engine deps composition root.
//
// `EngineDeps` is the SUPERSET of everything any extracted search-engine
// IPC channel group might need. Each group declares its OWN per-group deps
// interface that is a SUBSET of `EngineDeps` (or, more precisely, of the
// fields the group's handlers actually touch).
//
// Why not pass `EngineDeps` straight into every group?
//   1. Tests for a group should stub only what the group needs — passing
//      the whole engine drags in the worker bridge + workspace validator +
//      fallback observers for handlers that just call one engine method.
//   2. Group-local deps act as a contract: reading a group file shows you
//      the exact handler surface area without scanning the host's wiring.
//   3. Future moves (e.g. lifting a group out of search-engine entirely)
//      are mechanical — copy the group + its deps interface; no implicit
//      coupling via god-deps.
//
// As groups are extracted in V2.4b … V2.4n this file grows. V2.4a populated
// the SourceIndexGroup surface (search engine getter + worker bridge
// facade + workspace validator + worker-fallback observers).
import type { SearchEngine } from '../indexer'
import type {
  ReindexAllSourcesResult,
  ReindexWorkspaceResult,
} from '../indexer'
import type { GraphResult, SearchPayload } from '../../database/worker-bridge'
import type { WorkspaceValidationResult } from '../../../../shared/workspace-validation'
import type {
  FileWatcherHandle,
  FileWatcherOptions,
  FileWatcherRegistry,
  FileWatcherStartError,
} from '../file-watcher'

/**
 * Narrow facade for the worker-db bridge surface SourceIndexGroup consumes.
 * Mirrors the three methods the inline handlers call (`reindexWorkspace`,
 * `reindexAllSources`) so the group does not import
 * `getWorkerDbBridge()` or the full `WorkerDbBridge` interface directly.
 */
export interface SearchWorkerBridgeFacade {
  reindexWorkspace(opts: { root: string }): Promise<ReindexWorkspaceResult>
  reindexAllSources(opts: { root: string }): Promise<ReindexAllSourcesResult>
  /**
   * V2.4b — FTS search offloaded to the worker. SearchQueryGroup calls this
   * before falling back to the in-process engine on bridge failure.
   */
  searchDocuments(opts: {
    query: string
    workspaceRoot?: string
    workspaceRoots?: string[]
    limit?: number
    sources?: string[]
  }): Promise<SearchPayload>
  /**
   * V2.4b — graph BFS offloaded to the worker. SearchQueryGroup surfaces the
   * structured error to the renderer on bridge failure (no in-process
   * fallback path — the renderer handles the error directly).
   */
  getDocumentGraph(opts: {
    workspaceRoot?: string
    centerPath?: string
    depth?: number
  }): Promise<GraphResult>
}

/**
 * Worker-fallback observer payload narrowed to the fields the SourceIndex
 * handlers pass through. Host wires this to
 * `recordSearchWorkerFallback(...)` from `worker-fallback-observer.ts`;
 * lifted to a dep so the group does not import the observer module
 * directly.
 */
export interface SearchWorkerFallbackPayload {
  task: 'reindexWorkspace' | 'reindexAllSources' | 'searchDocuments'
  error: unknown
  workspaceRoot?: string
}


/**
 * Composition root. V2.4a populates only the SourceIndexGroup-relevant
 * fields; later V2.4 sub-stages extend this interface as their groups
 * need new deps.
 *
 * Optional fields are FORBIDDEN here — if a future group can run without a
 * dep, that dep belongs in the group's per-group deps interface (also
 * optional there), NOT here.
 */
export interface EngineDeps {
  /**
   * Resolve the module-scoped `SearchEngine` instance the host owns.
   * Returns `null` when the engine has not been initialised (database
   * unavailable / native gate off) — the handler surfaces the
   * `search engine unavailable` error in that case.
   */
  getSearchEngine(): SearchEngine | null
  /**
   * Resolve the lazy `getWorkerDbBridge()` facade. The host owns the
   * actual bridge construction + worker lifecycle; the group only sees
   * the two methods it needs (`reindexWorkspace`, `reindexAllSources`).
   */
  getWorkerBridge(): SearchWorkerBridgeFacade
  /**
   * Validate a candidate workspace root path with the host's home-dir +
   * accessSync context. Lifted to a dep so the group does not import
   * `validateWorkspaceRoot` directly; the host owns the exact validator
   * binding so tests can stub it without env coupling.
   */
  validateWorkspaceRoot(picked: string): WorkspaceValidationResult
  /**
   * Record a worker-fallback diagnostic so the boundary observer can
   * track how often the worker path is bypassed. Lifted to a dep so the
   * group does not import `worker-fallback-observer.ts` directly.
   */
  recordSearchWorkerFallback(payload: SearchWorkerFallbackPayload): void
  /**
   * Note a successful worker call so the boundary observer can clear
   * sticky-failure backoff. Lifted to a dep so the group does not import
   * `worker-fallback-observer.ts` directly.
   */
  noteSearchWorkerSuccess(): void
  /**
   * V2.4c — start a chokidar file watcher for delta incremental indexing.
   * Lifted to a dep so WatcherGroup does not import `createFileWatcher`
   * directly; the host owns the factory binding so tests can stub watcher
   * construction without spinning up real chokidar handles. Returns a
   * structured `FileWatcherStartError` on validation / inotify failure
   * (caller branches on the `kind` discriminator).
   */
  createFileWatcher(
    options: FileWatcherOptions,
  ): Promise<FileWatcherHandle | FileWatcherStartError>
  /**
   * V2.4c — resolve the module-scoped `FileWatcherRegistry` instance the
   * host owns. WatcherGroup uses this to `add()` newly-started watchers
   * and `stop()` them by id. Lifted to a dep so the group can be exercised
   * against a fresh registry in tests without touching module state.
   */
  getFileWatcherRegistry(): FileWatcherRegistry
}
