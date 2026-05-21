// Stage V V2.2a — shared IpcChannelGroup skeleton (rss-engine scope).
//
// Background: `src/main/modules/rss-engine/ipc-handler.ts` had grown past
// 1900 LOC with ~20+ logical groups of channels (source, item, fetch, opml,
// diagnostics, analysis, …) inlined into one `setupRSSIPC` body. Stage V §3
// V2.2 extracts each rss-engine group into its own file behind a single
// shared interface so:
//
//   • each group owns its own per-group `Deps` (a subset of the engine-level
//     `EngineDeps` composition root — no god-deps object every handler drags
//     around)
//   • registration + teardown live next to each other (`register` returns an
//     `IpcDisposeHandle` whose `dispose()` calls `ipcMain.removeHandler` for
//     every channel the group registered — symmetric with the dev-reload
//     pattern `setupRSSIPC` already follows by re-binding handlers)
//   • the V5 IPC contract gate keeps working because the channel literals
//     stay in real `ipcMain.handle('foo', …)` call sites (just moved files)
//
// Each group lives under `src/main/modules/rss-engine/ipc/` and is wired
// from `ipc-handler.ts` via a `register(ipcMain, deps)` call; the host stores
// the returned dispose handle so re-entry into `setupRSSIPC` (dev reload)
// releases everything cleanly before the next registration.
//
// Mirror of `src/main/modules/claude-bridge/ipc/types.ts` from V2.0 — kept as
// a separate file inside rss-engine to avoid cross-engine import coupling.
import type { IpcMain } from 'electron'

/**
 * Handle returned from `IpcChannelGroup.register`. Calling `dispose()` MUST
 * call `ipcMain.removeHandler(channel)` for every channel the group
 * registered, so re-running `setupRSSIPC` (dev-reload) leaves the host
 * without stale handlers.
 *
 * Idempotency requirement: groups SHOULD make `dispose()` safe to call twice
 * (electron's `removeHandler` already no-ops on missing channels, so the
 * default implementation pattern of "loop + try/catch" gives this for free).
 */
export interface IpcDisposeHandle {
  dispose(): void
}

/**
 * One logical cluster of IPC channels (typically 2–8 channels that share
 * state, a sub-store, or a single domain — e.g. rss source CRUD, item
 * inbox/star mutations, fetch lifecycle, opml import/export).
 *
 * `namespace` is a human-readable label only (used in logs / dispose
 * ordering decisions); it does NOT have to match the channel prefixes
 * one-for-one when a group fuses two adjacent prefixes.
 *
 * The `Deps` type parameter is per-group: SourceGroup needs the rss
 * repository; FetchGroup will need the diagnostics + lock; etc. This keeps
 * each group testable in isolation with a minimal fake — the test only stubs
 * what that specific group consumes.
 */
export interface IpcChannelGroup<Deps> {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: Deps): IpcDisposeHandle
}
