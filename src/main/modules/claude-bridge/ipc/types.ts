// Stage V V2.0 — shared IpcChannelGroup skeleton.
//
// Background: `src/main/modules/claude-bridge/ipc-handler.ts` had grown past
// 2000 LOC with ~15 logical groups of channels (askUser, lifecycle, send,
// projection, …) inlined into one `setupAgentIPC` body. Stage V §3 V2 extracts
// each group into its own file behind a single shared interface so:
//
//   • each group owns its own per-group `Deps` (a subset of the engine-level
//     `EngineDeps` composition root — no god-deps object that every handler
//     drags around)
//   • registration + teardown live next to each other (`register` returns an
//     `IpcDisposeHandle` whose `dispose()` calls `ipcMain.removeHandler` for
//     every channel the group registered — symmetric with the dev-reload
//     pattern `setupAgentIPC` already follows)
//   • the V5 IPC contract gate keeps working because the channel literals stay
//     in real `ipcMain.handle('foo', …)` call sites (just moved files)
//
// Each group lives under `src/main/modules/claude-bridge/ipc/` and is wired
// from `ipc-handler.ts` via a `register(ipcMain, deps)` call; the host stores
// the returned dispose handle so `cleanupAgentRuntime` can release everything
// in one place when groups are added.
import type { IpcMain } from 'electron'

/**
 * Handle returned from `IpcChannelGroup.register`. Calling `dispose()` MUST
 * call `ipcMain.removeHandler(channel)` for every channel the group
 * registered, so re-running `setupAgentIPC` (dev-reload) or shutting down
 * (cleanupAgentRuntime) leaves the host without stale handlers.
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
 * state, a sub-store, or a single domain — e.g. agent_interaction askUser,
 * scope-run lifecycle, projection push).
 *
 * `namespace` is a human-readable label only (used in logs / dispose ordering
 * decisions); it does NOT have to match the channel prefixes one-for-one when
 * a group fuses two adjacent prefixes (see AskUserGroup which spans both
 * `skills:askUser:*` and `agent:askUserQuestions:*`).
 *
 * The `Deps` type parameter is per-group: AskUserGroup needs db + stores +
 * metric logger; LifecycleGroup will need the runtime; etc. This keeps each
 * group testable in isolation with a minimal fake — the test only stubs what
 * that specific group consumes.
 */
export interface IpcChannelGroup<Deps> {
  readonly namespace: string
  register(ipcMain: IpcMain, deps: Deps): IpcDisposeHandle
}
