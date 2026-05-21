// Stage V V2.1l — ScheduleGroup channel group.
//
// Bundles the 6 channels that expose the agent-schedule (cron) CRUD + control
// surface used by the Schedules settings UI:
//
//   agent:listSchedules     (read all cron rows — sync)
//   agent:upsertSchedule    (create or replace one cron row)
//   agent:runScheduleNow    (manual one-shot trigger of one cron row)
//   agent:pauseSchedule     (flip enabled=false for one cron row)
//   agent:resumeSchedule    (flip enabled=true for one cron row)
//   agent:deleteSchedule    (remove one cron row)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1l is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the Schedules settings UI does not notice the
// refactor).
//
// All six channels live in one group because they share:
//   • the same domain concept (agent schedule lifecycle: list → upsert →
//     run/pause/resume → delete)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the schedules settings page)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `runtime.*` method)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods (resolved fresh per
// `setupAgentIPC` invocation), not composition-root singletons. `engine-deps.ts`
// is reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import type { CronTask } from '../../agent-control/contracts/types'
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
}

/**
 * Upsert-schedule payload. Mirrors the inline anonymous type from the
 * pre-extraction handler verbatim so the runtime forward stays a one-liner.
 * Also matches `UpsertSchedulePayload` exported from
 * `agent-control/runtime-core/runtime.ts` — kept local to avoid pulling the
 * runtime module into this group's import graph (deps are bound methods, not
 * the runtime class).
 */
export interface UpsertSchedulePayload {
  id?: string
  name: string
  cronExpr: string
  prompt: string
  channelId?: string | null
  enabled?: boolean
  payload?: Record<string, unknown>
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class).
 */
export interface ScheduleGroupDeps {
  /**
   * Bound `runtime.listSchedules` — synchronous, returns all cron rows.
   */
  listSchedules(): CronTask[]
  /**
   * Bound `runtime.upsertSchedule` — async, creates or replaces one cron
   * row and returns the resulting `CronTask`.
   */
  upsertSchedule(payload: UpsertSchedulePayload): Promise<CronTask>
  /**
   * Bound `runtime.runScheduleNow` — async, performs a manual one-shot
   * trigger. Returns `{ success, error? }` (NEVER throws for protocol-level
   * failures — those are surfaced via `success: false`).
   */
  runScheduleNow(id: string): Promise<{ success: boolean; error?: string }>
  /**
   * Bound `runtime.pauseSchedule` — async, flips enabled=false for one
   * cron row. Returns the resulting `CronTask`, or `null` if the schedule
   * does not exist.
   */
  pauseSchedule(id: string): Promise<CronTask | null>
  /**
   * Bound `runtime.resumeSchedule` — async, flips enabled=true for one
   * cron row. Returns the resulting `CronTask`, or `null` if the schedule
   * does not exist.
   */
  resumeSchedule(id: string): Promise<CronTask | null>
  /**
   * Bound `runtime.deleteSchedule` — async, removes one cron row. Returns
   * `true` if a row existed, `false` if not.
   */
  deleteSchedule(id: string): Promise<boolean>
}

const CHANNELS = [
  'agent:listSchedules',
  'agent:upsertSchedule',
  'agent:runScheduleNow',
  'agent:pauseSchedule',
  'agent:resumeSchedule',
  'agent:deleteSchedule',
] as const

export const scheduleGroup: IpcChannelGroup<ScheduleGroupDeps> = {
  namespace: 'agent:schedule',

  register(ipcMain: IpcMain, deps: ScheduleGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:listSchedules', (): IPCResponse => {
      try {
        return { success: true, data: deps.listSchedules() }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:upsertSchedule', async (_, payload: UpsertSchedulePayload): Promise<IPCResponse> => {
      try {
        const schedule = await deps.upsertSchedule(payload)
        return { success: true, data: schedule }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:runScheduleNow', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try {
        const result = await deps.runScheduleNow(payload.id)
        return { success: result.success, error: result.error }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:pauseSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try {
        const schedule = await deps.pauseSchedule(payload.id)
        if (!schedule) return { success: false, error: `Schedule not found: ${payload.id}` }
        return { success: true, data: schedule }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:resumeSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try {
        const schedule = await deps.resumeSchedule(payload.id)
        if (!schedule) return { success: false, error: `Schedule not found: ${payload.id}` }
        return { success: true, data: schedule }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:deleteSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try {
        const removed = await deps.deleteSchedule(payload.id)
        return { success: removed, error: removed ? undefined : `Schedule not found: ${payload.id}` }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
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
export const _scheduleGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
