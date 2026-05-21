// Stage V V2.3f — document-engine WatchGroup channel cluster.
//
// Bundles the 1 channel that drives renderer-initiated workspace folder
// watching plus its companion push emitter:
//
//   document:watchDirectories  (request → sync watcher set per sender,
//                                returns the normalized watched paths)
//   document:directoryChanged  (push → debounced fs.watch events fanned
//                                back to the originating sender)
//
// Handler body + supporting session helpers are lifted VERBATIM from
// `ipc-handler.ts` (V2.3f follows the V2.3a/V2.3b/V2.3c/V2.3d/V2.3e move
// + thin-wrapper shape). The handler does NOT import electron's
// BrowserWindow / dialog / shell surfaces; it touches only the request
// event's `sender` (typed via electron's own `WebContents`) and the node
// fs primitives.
//
// PUSH-SIDE DECISION (recorded for the V5 IPC contract gate):
//   `session.sender.send('document:directoryChanged', …)` moves into this
//   file alongside the request handler because:
//     • the push site has no caller outside the watcher lifecycle (no
//       other module emits `document:directoryChanged`);
//     • the V5 gate (`scripts/check-ipc-contract.cjs`) detects PUSH via
//       a textual `*.sender.send('literal', …)` scan across all `.ts`
//       sources, so relocating the call from `ipc-handler.ts` to
//       `ipc/watch-group.ts` keeps the channel literal visible on the
//       main side and the preload-side `ipcRenderer.on('document:directoryChanged', …)`
//       (`src/preload/index.ts`) continues to satisfy the pair.
//   The host therefore loses BOTH the request handler AND the push
//   emitter; the only watch-related state that stays on `ipc-handler.ts`
//   is the import of `FSWatcher`/`watch`/`statSync`/`existsSync` IF other
//   handlers still need them (they do — `document:read` and the file I/O
//   group share `existsSync`/`statSync`).
//
// The group ships a single channel because the watcher session lifecycle
// (per-sender Map of `FSWatcher`s + debounced pending-paths set + the
// `sender.once('destroyed')` cleanup hook) is genuinely owned by this one
// channel; bundling another channel here would force its handlers to
// reach into a session model they do not consume.
import { existsSync, statSync, watch, type FSWatcher } from 'fs'
import type { IpcMain, WebContents } from 'electron'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps. The watch handler reads only the engine mock flag (to
 * short-circuit dialog-free unit runs) plus an injectable debounce window
 * so tests can pin a deterministic flush interval. Everything else
 * (fs.watch, sender.send) is a direct node/electron primitive that does
 * NOT belong on the dep surface: lifting them would force tests to mock
 * the standard library to no benefit, and the V5 gate's textual
 * `sender.send` scan requires the call site to stay literal.
 */
export interface WatchGroupDeps {
  /** Whether the engine is running in mock mode (no real fs.watch). */
  readonly useMock: boolean
  /**
   * Debounce window (ms) between an `fs.watch` callback firing and the
   * batched `document:directoryChanged` push. Defaults to 140ms, the value
   * the inline handler shipped pre-extraction. Tests pin a smaller window
   * so they can drive the push synchronously without sleeping.
   */
  readonly debounceMs?: number
}

const CHANNELS = ['document:watchDirectories'] as const

const DEFAULT_DEBOUNCE_MS = 140

/**
 * Per-sender session state — one entry per WebContents that has called
 * `document:watchDirectories` at least once. Cleaned up either via
 * `sender.once('destroyed')` (renderer reload / window close) or via
 * `dispose()` when `setupDocumentIPC` re-enters on dev reload.
 */
type DirectoryWatchSession = {
  sender: WebContents
  watchers: Map<string, FSWatcher>
  debounceTimer: NodeJS.Timeout | null
  pendingPaths: Set<string>
}

export const watchGroup: IpcChannelGroup<WatchGroupDeps> = {
  namespace: 'document:watch',

  register(ipcMain: IpcMain, deps: WatchGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // every V2.3 group (MarkGroup / FileIoGroup / FileMutationGroup /
    // WorkspaceGroup / ParserGroup) and the rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    const debounceMs = typeof deps.debounceMs === 'number' && deps.debounceMs >= 0
      ? deps.debounceMs
      : DEFAULT_DEBOUNCE_MS

    // Sessions are group-scoped (not module-scoped) so dispose() can close
    // every watcher in one pass without reaching across the host. A
    // re-registration after dispose() starts from a clean map.
    const directoryWatchSessions = new Map<number, DirectoryWatchSession>()

    const closeDirectoryWatchSession = (senderId: number) => {
      const session = directoryWatchSessions.get(senderId)
      if (!session) return
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer)
      }
      session.watchers.forEach((watcher) => watcher.close())
      directoryWatchSessions.delete(senderId)
    }

    const ensureDirectoryWatchSession = (sender: WebContents): DirectoryWatchSession => {
      const existing = directoryWatchSessions.get(sender.id)
      if (existing) return existing

      const session: DirectoryWatchSession = {
        sender,
        watchers: new Map<string, FSWatcher>(),
        debounceTimer: null,
        pendingPaths: new Set<string>(),
      }

      sender.once('destroyed', () => {
        closeDirectoryWatchSession(sender.id)
      })

      directoryWatchSessions.set(sender.id, session)
      return session
    }

    const queueDirectoryWatchEvent = (session: DirectoryWatchSession, watchedPath: string) => {
      session.pendingPaths.add(watchedPath)
      if (session.debounceTimer) return

      session.debounceTimer = setTimeout(() => {
        session.debounceTimer = null
        if (session.sender.isDestroyed()) return
        const paths = Array.from(session.pendingPaths)
        session.pendingPaths.clear()
        // PUSH: `document:directoryChanged` — paired with
        // `ipcRenderer.on('document:directoryChanged', …)` in
        // `src/preload/index.ts`. The V5 IPC contract gate matches this
        // literal via its `*.sender.send('literal', …)` scan.
        session.sender.send('document:directoryChanged', {
          paths,
          timestamp: Date.now(),
        })
      }, debounceMs)
    }

    const syncWatchedDirectories = (sender: WebContents, rawPaths: string[]): string[] => {
      const session = ensureDirectoryWatchSession(sender)
      const normalizedPaths = Array.from(
        new Set(
          rawPaths
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .filter((value) => {
              if (!existsSync(value)) return false
              try {
                return statSync(value).isDirectory()
              } catch {
                return false
              }
            }),
        ),
      )

      session.watchers.forEach((watcher, watchedPath) => {
        if (normalizedPaths.includes(watchedPath)) return
        watcher.close()
        session.watchers.delete(watchedPath)
      })

      normalizedPaths.forEach((dirPath) => {
        if (session.watchers.has(dirPath)) return
        try {
          const watcher = watch(dirPath, { persistent: false }, () => {
            queueDirectoryWatchEvent(session, dirPath)
          })
          watcher.on('error', () => {
            watcher.close()
            session.watchers.delete(dirPath)
          })
          session.watchers.set(dirPath, watcher)
        } catch {
          // Ignore unwatchable paths; other directories should continue to work.
        }
      })

      return Array.from(session.watchers.keys())
    }

    ipcMain.handle('document:watchDirectories', async (event, payload: { paths?: string[] }) => {
      try {
        if (deps.useMock) {
          return { success: true, data: { watchedPaths: [] }, mock: true }
        }
        const watchedPaths = syncWatchedDirectories(
          event.sender,
          Array.isArray(payload?.paths) ? payload.paths : [],
        )
        return { success: true, data: { watchedPaths } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose(): void {
        // Close every live watcher before unhooking the channel so renderer
        // reloads (which fire setupDocumentIPC anew) cannot leak file
        // descriptors. Mirror of the per-sender `closeDirectoryWatchSession`
        // path but executed over the full map.
        for (const senderId of Array.from(directoryWatchSessions.keys())) {
          closeDirectoryWatchSession(senderId)
        }
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _watchGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
