// Stage V V2.1h — DetachedTaskGroup channel group.
//
// Bundles the 4 channels that expose the detached-skill task surface to the
// renderer:
//
//   agent:startDetachedSkillAction    (kick off a skill action in the
//                                      background, returns the tracker record)
//   agent:inspectDetachedSkillTask    (lookup one task by id, scope-gated)
//   agent:listDetachedSkillTasks      (list tasks, optional scope filter)
//   agent:cancelDetachedSkillTask     (cancel one task by id, scope-gated)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1h is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// All four channels live in one group because they share:
//   • the same domain concept (detached-skill task lifecycle:
//     start / inspect / list / cancel)
//   • the same dispose lifecycle (renderer boots them together when the
//     detached-task panel mounts)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `runtime.*` method)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods (resolved fresh per
// `setupAgentIPC` invocation), not composition-root singletons. `engine-deps.ts`
// is reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import type { DetachedSkillTaskRecord } from '../../agent-control/detached-skill-task-tracker'
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
 * Payload for `agent:startDetachedSkillAction`. Mirrors the inline anonymous
 * type from the pre-extraction handler. Only `skillId` + `action` are
 * required; the rest are optional scoping hints forwarded to the tracker.
 */
export interface StartDetachedSkillActionPayload {
  scopeId?: string
  sessionId?: string
  agent?: string
  skillId: string
  action: string
  params?: Record<string, unknown>
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class).
 */
export interface DetachedTaskGroupDeps {
  /**
   * Bound `runtime.startDetachedSkillAction` — sync, returns the new tracker
   * record.
   */
  startDetachedSkillAction(payload: StartDetachedSkillActionPayload): DetachedSkillTaskRecord
  /**
   * Bound `runtime.inspectDetachedSkillTask` — sync, returns the task or
   * `null` when it is missing OR the scope-gate rejects.
   */
  inspectDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null
  /**
   * Bound `runtime.listDetachedSkillTasks` — sync, returns the tracker
   * snapshot optionally filtered by scope.
   */
  listDetachedSkillTasks(payload?: { scopeId?: string }): DetachedSkillTaskRecord[]
  /**
   * Bound `runtime.cancelDetachedSkillTask` — sync, returns the cancelled
   * record or `null` when not found / scope-gated out.
   */
  cancelDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null
}

const CHANNELS = [
  'agent:startDetachedSkillAction',
  'agent:inspectDetachedSkillTask',
  'agent:listDetachedSkillTasks',
  'agent:cancelDetachedSkillTask',
] as const

export const detachedTaskGroup: IpcChannelGroup<DetachedTaskGroupDeps> = {
  namespace: 'agent:detachedTask',

  register(ipcMain: IpcMain, deps: DetachedTaskGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:startDetachedSkillAction', (_, payload: StartDetachedSkillActionPayload): IPCResponse => {
      try {
        return { success: true, data: deps.startDetachedSkillAction(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:inspectDetachedSkillTask', (_, payload: { taskId: string; scopeId?: string }): IPCResponse => {
      try {
        const taskId = String(payload?.taskId || '').trim()
        const scopeId = String(payload?.scopeId || '').trim()
        if (!taskId) return { success: false, error: 'taskId is required' }
        if (!scopeId) return { success: false, error: 'scopeId is required' }
        const task = deps.inspectDetachedSkillTask(taskId, scopeId)
        if (!task) return { success: false, error: `Detached skill task not found: ${taskId}` }
        return { success: true, data: task }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:listDetachedSkillTasks', (_, payload?: { scopeId?: string }): IPCResponse => {
      try {
        return { success: true, data: deps.listDetachedSkillTasks(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:cancelDetachedSkillTask', (_, payload: { taskId: string; scopeId?: string }): IPCResponse => {
      try {
        const taskId = String(payload?.taskId || '').trim()
        const scopeId = String(payload?.scopeId || '').trim()
        if (!taskId) return { success: false, error: 'taskId is required' }
        if (!scopeId) return { success: false, error: 'scopeId is required' }
        const task = deps.cancelDetachedSkillTask(taskId, scopeId)
        if (!task) return { success: false, error: `Detached skill task not found: ${taskId}` }
        return { success: true, data: task }
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
export const _detachedTaskGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
