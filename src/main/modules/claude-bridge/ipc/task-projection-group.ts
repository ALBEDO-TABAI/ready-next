// Stage V V2.1f — TaskProjectionGroup channel group.
//
// Bundles the 2 channels that expose task-projection reads to the renderer:
//
//   agent:listTaskProjections (list projections for a conversation scope)
//   agent:getTaskProjection   (one projection by taskId)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1f is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// Both channels live in one group because they share:
//   • the same domain concept (task-projection read surface — the projection
//     UI consolidation contract from Stage O §0.3 is the single source of
//     truth for these reads)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the task-card UI for a scope)
//   • a closely-coupled dep surface (both handlers are a one-line forward to
//     a `runtime.*` projection-store accessor)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods (resolved fresh per
// `setupAgentIPC` invocation), not composition-root singletons. `engine-deps.ts`
// is reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import type { TaskProjectionRecord } from '../../agent-control/contracts/run-contracts'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Local mirror of the host's `IPCResponse` shape. Inlined to avoid a back
 * import from `ipc-handler.ts` (the file we are extracting AWAY from); the
 * shape is stable across the codebase — see `IPCResponse<T>` in the host.
 */
interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
  errorKind?: string
  persistence?: unknown
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class).
 */
export interface TaskProjectionGroupDeps {
  /**
   * Bound `runtime.listTaskProjections` — sync, returns the projection rows
   * for the given conversation scope. The runtime also runs reconciliation
   * against `skill_task_runs` and derives `canResume` per record before
   * returning; both steps live in the runtime, not in this handler.
   */
  listTaskProjections(scopeId: string): TaskProjectionRecord[]
  /**
   * Bound `runtime.getTaskProjection` — sync, returns one projection by
   * taskId (or null if missing). Runtime derives `canResume` on this single
   * path too so direct fetches match the list view (Stage Q §3.4 C10).
   */
  getTaskProjection(taskId: string): TaskProjectionRecord | null
}

const CHANNELS = [
  'agent:listTaskProjections',
  'agent:getTaskProjection',
] as const

export const taskProjectionGroup: IpcChannelGroup<TaskProjectionGroupDeps> = {
  namespace: 'agent:taskProjection',

  register(ipcMain: IpcMain, deps: TaskProjectionGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:listTaskProjections', (_, payload?: { scopeId?: string }): IPCResponse => {
      try {
        const scopeId = String(payload?.scopeId || '').trim()
        if (!scopeId) return { success: true, data: [] }
        return { success: true, data: deps.listTaskProjections(scopeId) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getTaskProjection', (_, payload?: { taskId?: string }): IPCResponse => {
      try {
        const taskId = String(payload?.taskId || '').trim()
        if (!taskId) return { success: false, error: 'taskId is required' }
        const projection = deps.getTaskProjection(taskId)
        if (!projection) return { success: false, error: `Task projection not found: ${taskId}` }
        return { success: true, data: projection }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

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
export const _taskProjectionGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
