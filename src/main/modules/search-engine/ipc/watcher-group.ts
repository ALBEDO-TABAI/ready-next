import { ObjectEventWindow } from '../../object-service/event-window'
import { ObjectRegistry } from '../../object-service/registry'
// Stage V V2.4c — search-engine WatcherGroup channel cluster (M4 IPC split
// final group).
//
// Bundles the 2 channels that drive chokidar-based delta incremental
// indexing:
//
//   document:startWatcher   (workspace open → start chokidar watcher,
//                            route per-file `add`/`change`/`unlink` events
//                            into single-file `indexDocument` / `deletePath`
//                            calls; returns the watcher id the renderer
//                            uses to stop it later)
//   document:stopWatcher    (workspace close → stop watcher by id;
//                            tolerates already-stopped ids — `stop()`
//                            returns `false` when the id is unknown)
//
// Channels share the `document:` IPC prefix per the V5 allowlist; the file
// location reflects ownership (search-engine), not the channel prefix.
//
// Handler bodies are lifted from `ipc-handler.ts` verbatim (V2.4c is a
// move + thin-wrapper: response shaping, inotify-exhaustion hint and the
// per-event swallow in the onChange callback stay on this side; the
// watcher factory + watcher registry run through `EngineDeps` so the group
// does not import `createFileWatcher` / `FileWatcherRegistry` directly).
//
// The 2 channels live in one group because they share:
//   • the same domain concept (chokidar watcher lifecycle for a workspace)
//   • the same dispose lifecycle (renderer wires them together — start on
//     workspace open, stop on workspace close)
//   • the same dep surface (engine getter + watcher factory + watcher
//     registry)
//
// `isInotifyExhaustionError` is imported directly because it's a pure
// predicate over an `unknown` error — no module state, no I/O, no dep
// injection benefit.
import type { IpcMain } from 'electron'
import { isInotifyExhaustionError } from '../file-watcher'
import type { EngineDeps } from './engine-deps'
import { publishDocumentIndexChanged, publishDocumentWatcherFailed } from './document-index-events'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these three members; nothing more is required to
 * exercise the 2 handler bodies.
 */
export type WatcherGroupDeps = Pick<
  EngineDeps,
  | 'getSearchEngine'
  | 'createFileWatcher'
  | 'getFileWatcherRegistry'
>

interface SearchIPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

const CHANNELS = [
  'document:startWatcher',
  'document:stopWatcher',
] as const

export const watcherGroup: IpcChannelGroup<WatcherGroupDeps> = {
  namespace: 'document:watcher',

  register(ipcMain: IpcMain, deps: WatcherGroupDeps): IpcDisposeHandle {
    // setupSearchIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the V2.4a SourceIndexGroup / V2.4b
    // SearchQueryGroup defensive pattern.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle(
      'document:startWatcher',
      async (
        event,
        payload: { workspaceRoot: string },
      ): Promise<SearchIPCResponse<{ watcherId: string; workspaceRoot: string }> & {
        errorKind?: 'invalid_root' | 'enospc' | 'failed' | 'engine_unavailable'
        hint?: string
      }> => {
        const searchEngine = deps.getSearchEngine()
        if (!searchEngine) {
          return { success: false, error: 'search engine unavailable', errorKind: 'engine_unavailable' }
        }
        if (!payload || typeof payload.workspaceRoot !== 'string' || payload.workspaceRoot.length === 0) {
          return { success: false, error: 'workspaceRoot required', errorKind: 'invalid_root' }
        }

        const registry = new ObjectRegistry(searchEngine.getRepository().getConnection())
        const window = new ObjectEventWindow(registry, async (paths, removedPaths) => {
          const engine = deps.getSearchEngine()
          if (!engine) throw new Error('Search engine unavailable during identity settlement')
          const changedPaths = new Set(removedPaths)
          for (const path of paths) {
            const object = registry.find(path)
            if (object?.status === 'present' && object.kind !== 'directory' && object.identity_state !== 'conflict') {
              const result = await engine.indexDocument(payload.workspaceRoot, path)
              if (!result.ok) throw new Error(result.error || 'Incremental indexing failed')
              if (!result.skipped) changedPaths.add(path)
            }
          }
          if (changedPaths.size) publishDocumentIndexChanged(event.sender, { workspaceRoot:payload.workspaceRoot,reason:'incremental',changedPaths:[...changedPaths] })
        })
        const result = await deps.createFileWatcher({
          workspaceRoot: payload.workspaceRoot,
          onChange: ({filePath}) => window.add(filePath),
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

        const registered = deps.getFileWatcherRegistry().add({...result, close:async()=>{await result.close();await window.drain()}}, (failure) => {
          publishDocumentWatcherFailed(event.sender, failure)
        })
        if (!registered) {
          return {
            success: false,
            error: 'file watcher stopped before registration completed',
            errorKind: 'failed',
          }
        }
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
          const stopped = await deps.getFileWatcherRegistry().stop(payload.watcherId)
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
export const _watcherGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
