// Stage V V2.4a — shared IpcChannelGroup skeleton (search-engine scope).
//
// Background: `src/main/modules/search-engine/ipc-handler.ts` mixes source
// listing, single-document indexing, full-workspace + all-source reindex,
// reindex cancellation, search, backlink/graph reads, and a chokidar file
// watcher into one `setupSearchIPC` body. Stage V §3 V2.4 mirrors the V2.2
// rss-engine and V2.3 document-engine extractions: each search-engine
// channel cluster moves into its own file behind a single shared interface
// so:
//
//   • each group owns its own per-group `Deps` (a subset of the engine-level
//     `EngineDeps` composition root — no god-deps object every handler drags
//     around)
//   • registration + teardown live next to each other (`register` returns an
//     `IpcDisposeHandle` whose `dispose()` calls `ipcMain.removeHandler` for
//     every channel the group registered — symmetric with the dev-reload
//     pattern `setupSearchIPC` already follows when re-binding handlers)
//   • the V5 IPC contract gate keeps working because the channel literals
//     stay in real `ipcMain.handle('foo', …)` call sites (just moved files)
//
// Each group lives under `src/main/modules/search-engine/ipc/` and is wired
// from `ipc-handler.ts` via a `register(ipcMain, deps)` call; the host
// stores the returned dispose handle so re-entry into `setupSearchIPC`
// (dev reload) releases everything cleanly before the next registration.
//
// Channels in this engine use the `document:` IPC prefix because the
// renderer-facing search surface was registered under the document
// namespace per the V5 allowlist; the file location reflects ownership
// (search-engine), not the channel prefix.
//
// Mirror of `src/main/modules/document-engine/ipc/types.ts` from V2.3a —
// kept as a separate file inside search-engine to avoid cross-engine
// import coupling.
import type { IpcMain } from 'electron'

/**
 * Handle returned from `IpcChannelGroup.register`. Calling `dispose()` MUST
 * call `ipcMain.removeHandler(channel)` for every channel the group
 * registered, so re-running `setupSearchIPC` (dev-reload) leaves the host
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
 * state, a sub-store, or a single domain — e.g. source-index lifecycle,
 * search query, backlink/graph reads, file watcher control).
 *
 * `namespace` is a human-readable label only (used in logs / dispose
 * ordering decisions); it does NOT have to match the channel prefixes
 * one-for-one when a group fuses two adjacent prefixes (search-engine
 * channels all share the `document:` prefix but belong to distinct
 * groups by responsibility).
 *
 * The `Deps` type parameter is per-group: SourceIndexGroup needs the
 * search engine getter + worker bridge + workspace validator + worker
 * fallback observers; future SearchQueryGroup will need the FTS surface;
 * etc. This keeps each group testable in isolation with a minimal fake —
 * the test only stubs what that specific group consumes.
 */
export interface IpcChannelGroup<Deps> {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: Deps): IpcDisposeHandle
}
