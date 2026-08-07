// Stage V V2.1i — RunControlGroup channel group.
//
// Bundles the 5 channels that drive the renderer's "run control" surface
// (background child-runs + scope-run suspend/resume + interactive response):
//
//   agent:listActiveChildRuns    (snapshot of background child-runs, with
//                                 projection diagnostics)
//   agent:cancelChildRun         (cancel a background child-run by id)
//   agent:reportInfrastructureTimeout
//                                 (renderer watchdog reports a stuck foreground run)
//   agent:suspendRun             (pause a scope-run; emits 'suspended' update)
//   agent:resumeRun              (resume a paused scope-run via durable handle)
//   agent:respondToInteraction   (reply to an in-flight interaction request)
//   agent:completeHumanTakeover  (claim one typed Browser takeover receipt)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1i is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the renderer's task-card / control buttons keep
// behaving exactly as before).
//
// All five channels live in one group because they share:
//   • the same domain concept (run-lifecycle control: list / cancel / suspend
//     / resume / respond)
//   • the same dispose lifecycle (renderer mounts task-card controls as one
//     unit; tearing them down together avoids partial dev-reload state)
//   • a closely-coupled dep surface (each handler is a one-line forward to
//     either a `runtime.*` method or a pre-existing `*ForIpc` helper)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods + helper forwarders
// (resolved fresh per `setupAgentIPC` invocation), not composition-root
// singletons. `engine-deps.ts` is reserved for true singletons; mixed/bound
// surfaces stay on the per-group interface where they belong.
import type { IpcMain } from 'electron'
import type { ContinuationIntent } from '../../agent-control/contracts/continuation-state'
import type { ChildRunIpcResponse } from '../active-child-run-ipc'
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
 * Payload for `agent:suspendRun`. Mirrors the inline anonymous type from the
 * pre-extraction handler. `scopeId` is required; `taskId` is optional —
 * `runtime.suspendRun` resolves the target from the scope when omitted.
 */
export interface SuspendRunPayload {
  scopeId: string
  taskId?: string
}

export interface ReportInfrastructureTimeoutPayload {
  scopeId: string
  requestId: string
  elapsedMs?: number
}

export interface ReportInfrastructureTimeoutResult {
  success: boolean
  state?: 'active' | 'stale' | 'not_found' | 'paused_user_input'
  error?: string
  errorKind?: string
  activeRunId?: string | null
}

/**
 * Payload for `agent:resumeRun`. Mirrors the inline anonymous type from the
 * pre-extraction handler verbatim (including the long `continuationIntent`
 * shape) so the IPC boundary keeps every Stage Q durable-handle field — TS
 * strips unknown properties at the boundary, so dropping fields here would
 * silently break `runtime.buildContinuationIntent`'s `canResumeShape` gate.
 */
export interface ResumeRunPayload {
  scopeId: string
  taskId?: string
  requestId?: string
  responseText?: string
  continuationIntent?: {
    taskId: string
    executionId?: string
    stepId?: string
    blockedReason?: string
    responseText?: string
    todoId?: string
    todoTitle?: string
    resumeKind?: 'snapshot' | 'paused' | 'done_residual'
    // Stage Q (Stage 11) — durable handle fields propagated through IPC
    // so `runtime.buildContinuationIntent`'s canResumeShape gate can see
    // them. Without these on the IPC payload type, TS strips them at
    // the boundary and `incoming?.childRunId` reads as undefined.
    childRunId?: string
    detachedTaskId?: string
    taskRunId?: string
    jobId?: string
    skillId?: string
    action?: string
    runStatePath?: string
    outputDir?: string
    progressFingerprint?: string
    pauseReason?: string
  } | null
}

/**
 * Payload for `agent:respondToInteraction`. Mirrors the pre-extraction inline
 * type verbatim. `responseText` is required (empty rejected by runtime); the
 * `continuationIntent` shape matches `ResumeRunPayload`'s (same Stage Q
 * durable-handle fields).
 */
export interface RespondToInteractionPayload {
  scopeId: string
  taskId?: string
  requestId?: string
  responseText: string
  confirmed?: boolean
  continuationIntent?: {
    taskId: string
    executionId?: string
    stepId?: string
    blockedReason?: string
    responseText?: string
    todoId?: string
    todoTitle?: string
    resumeKind?: 'snapshot' | 'paused' | 'done_residual'
    // Stage Q (Stage 11) — durable handle fields (see resumeRun).
    childRunId?: string
    detachedTaskId?: string
    taskRunId?: string
    jobId?: string
    skillId?: string
    action?: string
    runStatePath?: string
    outputDir?: string
    progressFingerprint?: string
    pauseReason?: string
  } | null
}

export interface CompleteHumanTakeoverPayload {
  taskId: string
  takeoverId: string
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is either a bound runtime method or a bound forward to a
 * `*ForIpc` helper. Bound by the host so the group never imports
 * `AgentControlRuntime` and stays decoupled from the runtime concrete class.
 *
 * The `continuationIntent` payload type on `resumeRun` / `respondToInteraction`
 * is locally widened to the IPC-side shape (`ResumeRunPayload['continuationIntent']`);
 * the host forwards it directly to `runtime.resumeRun` / `runtime.respondToInteraction`,
 * which type their own param as `ContinuationIntent | null` — the structural
 * field set is identical, only the IPC payload tolerates extra optional
 * fields the runtime ignores. Re-exporting the runtime alias here so the
 * group docs stay legible.
 */
export type { ContinuationIntent }
export interface RunControlGroupDeps {
  /**
   * Bound forward to `listActiveChildRunsForIpc(runtime)` — sync, returns
   * the projection-normalized snapshot (or a structured error payload).
   */
  listActiveChildRuns(): ChildRunIpcResponse
  /**
   * Bound forward to `cancelChildRunForIpc(runtime, payload)` — async,
   * resolves to the close result or a structured error payload.
   */
  cancelChildRun(payload: { childRunId?: string }): Promise<ChildRunIpcResponse>
  /**
   * Bound `runtime.suspendRun` — async, resolves to `{success, error?}`.
   */
  suspendRun(payload: SuspendRunPayload): Promise<{ success: boolean; error?: string; errorKind?: string }>
  /**
   * Bound `runtime.reportInfrastructureTimeout` — async, renderer watchdog
   * report with request-id authority. A stale report is a successful no-op.
   */
  reportInfrastructureTimeout(payload: ReportInfrastructureTimeoutPayload): Promise<ReportInfrastructureTimeoutResult>
  /**
   * Bound `runtime.resumeRun` — async, resolves to `{success, error?, errorKind?}`.
   * The `errorKind` is forwarded so the renderer can distinguish
   * `'not_resumable'` from generic failures.
   */
  resumeRun(payload: ResumeRunPayload): Promise<{ success: boolean; error?: string; errorKind?: string }>
  /**
   * Bound `runtime.respondToInteraction` — async, resolves to
   * `{success, error?, errorKind?}` with the same `errorKind` semantics as
   * `resumeRun`.
   */
  respondToInteraction(payload: RespondToInteractionPayload): Promise<{ success: boolean; error?: string; errorKind?: string }>
  completeHumanTakeover(payload: CompleteHumanTakeoverPayload): Promise<{ success: boolean; error?: string; errorKind?: string }>
}

const CHANNELS = [
  'agent:listActiveChildRuns',
  'agent:cancelChildRun',
  'agent:reportInfrastructureTimeout',
  'agent:suspendRun',
  'agent:resumeRun',
  'agent:respondToInteraction',
  'agent:completeHumanTakeover',
] as const

export const runControlGroup: IpcChannelGroup<RunControlGroupDeps> = {
  namespace: 'agent:runControl',

  register(ipcMain: IpcMain, deps: RunControlGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:listActiveChildRuns', (): IPCResponse => {
      return deps.listActiveChildRuns() as IPCResponse
    })

    ipcMain.handle('agent:cancelChildRun', async (_, payload: { childRunId?: string }): Promise<IPCResponse> => {
      return (await deps.cancelChildRun(payload)) as IPCResponse
    })

    ipcMain.handle('agent:reportInfrastructureTimeout', async (_, payload: ReportInfrastructureTimeoutPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.reportInfrastructureTimeout(payload)
        return {
          success: result.success,
          data: {
            state: result.state,
            activeRunId: result.activeRunId || null,
          },
          error: result.error,
          errorKind: result.errorKind,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:suspendRun', async (_, payload: SuspendRunPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.suspendRun(payload)
        return { success: result.success, error: result.error, errorKind: result.errorKind }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:resumeRun', async (_, payload: ResumeRunPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.resumeRun(payload)
        // Stage Q (Stage 11) — forward errorKind so renderer can distinguish
        // 'not_resumable' from other failures (e.g. show a different
        // toast / disable the button).
        return { success: result.success, error: result.error, errorKind: result.errorKind }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:respondToInteraction', async (_, payload: RespondToInteractionPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.respondToInteraction(payload)
        return { success: result.success, error: result.error, errorKind: result.errorKind }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:completeHumanTakeover', async (_, payload: CompleteHumanTakeoverPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.completeHumanTakeover(payload)
        return { success: result.success, error: result.error, errorKind: result.errorKind }
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
export const _runControlGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
