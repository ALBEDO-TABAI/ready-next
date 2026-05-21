// Stage V V2.3a — shared IpcChannelGroup skeleton (document-engine scope).
//
// Background: `src/main/modules/document-engine/ipc-handler.ts` has grown
// past 1300 LOC mixing document mark CRUD, file I/O, dialog flows, parsing,
// directory watching, workspace import/export and shell-launch helpers into
// one `setupDocumentIPC` body. Stage V §3 V2.3 mirrors the V2.2 rss-engine
// extraction: each document-engine channel cluster moves into its own file
// behind a single shared interface so:
//
//   • each group owns its own per-group `Deps` (a subset of the engine-level
//     `EngineDeps` composition root — no god-deps object every handler drags
//     around)
//   • registration + teardown live next to each other (`register` returns an
//     `IpcDisposeHandle` whose `dispose()` calls `ipcMain.removeHandler` for
//     every channel the group registered — symmetric with the dev-reload
//     pattern `setupDocumentIPC` already follows when re-binding handlers)
//   • the V5 IPC contract gate keeps working because the channel literals
//     stay in real `ipcMain.handle('foo', …)` call sites (just moved files)
//
// Each group lives under `src/main/modules/document-engine/ipc/` and is
// wired from `ipc-handler.ts` via a `register(ipcMain, deps)` call; the
// host stores the returned dispose handle so re-entry into
// `setupDocumentIPC` (dev reload) releases everything cleanly before the
// next registration.
//
// Mirror of `src/main/modules/rss-engine/ipc/types.ts` from V2.2a — kept as
// a separate file inside document-engine to avoid cross-engine import
// coupling.
import type { IpcMain } from 'electron'

/**
 * Handle returned from `IpcChannelGroup.register`. Calling `dispose()` MUST
 * call `ipcMain.removeHandler(channel)` for every channel the group
 * registered, so re-running `setupDocumentIPC` (dev-reload) leaves the host
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
 * state, a sub-store, or a single domain — e.g. document mark CRUD, file
 * read/write, directory watcher, parse pipelines, workspace import/export).
 *
 * `namespace` is a human-readable label only (used in logs / dispose
 * ordering decisions); it does NOT have to match the channel prefixes
 * one-for-one when a group fuses two adjacent prefixes.
 *
 * The `Deps` type parameter is per-group: MarkGroup needs the marks
 * repository factory + mock flag; future FileGroup will need the write-index
 * hook and binary detector; etc. This keeps each group testable in isolation
 * with a minimal fake — the test only stubs what that specific group
 * consumes.
 */
export interface IpcChannelGroup<Deps> {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: Deps): IpcDisposeHandle
}
