// Stage V V2.1c — AgentLifecycle channel group.
//
// Bundles the 5 channels that drive the agent-loop lifecycle from the
// renderer:
//
//   agent:send        (push a turn at a global agent + sessionId)
//   agent:newSession  (clear in-flight state + start a fresh session)
//   agent:kill        (stop generation for an agent + sessionId)
//   agent:sendScoped  (push a turn at a scope-run + optional continuation)
//   agent:compactSession (manual memory-session compaction for a public session)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1c is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// All five channels live in one group because they share:
//   • the same domain concept (agent-loop lifecycle from the renderer side)
//   • the same dispose lifecycle (renderer treats them as one boot phase)
//   • a closely-coupled dep surface (orchestrator + runtime + per-session
//     cancellation closures created fresh per `setupAgentIPC` invocation)
//
// Per-group deps are NOT a `Pick<EngineDeps>` because the dep surface here
// mixes engine-level singletons (orchestrator + runtime sendScoped) with
// host-local closures (cancelToolActionRequestsBySession,
// cleanupSkillSessionState, cancelSkillSessionPendingInteractions, log).
// `engine-deps.ts` is reserved for true composition-root singletons; mixed
// surfaces stay on the per-group interface where they belong. The same
// rationale applies to `ToolEventGroup` (see file header there).
import type { IpcMain } from 'electron'
import type { MultimodalBlock } from '../direct-chat'
import type { ReadyAgentOrchestrator } from '../../agent-control/runtime-core/orchestrator'
import type { SendScopedUserMessage } from '../../agent-control/send-scoped-confirmation'
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
  /**
   * Stage V V3.5 — structured error tag for `session_limit_exceeded`.
   * `code: 'SESSION_LIMIT'` lets the renderer pattern-match the failure
   * without relying on `error` message parsing; `maxSessions` echoes
   * the cap so the renderer can render a deterministic message even if
   * the cap changes in the future.
   */
  code?: string
  maxSessions?: number
}

/**
 * Stage V V3.5 — narrow predicate for the structured
 * `session_limit_exceeded` error thrown by
 * `ReadyAgentOrchestrator.send()` / `newSession()`. The orchestrator
 * builds the Error with `code: 'SESSION_LIMIT'` + `maxSessions` so the
 * IPC layer can echo them back to the renderer without re-parsing the
 * message string (R12 defense-in-depth).
 */
function isSessionLimitError(error: unknown): error is Error & {
  code: 'SESSION_LIMIT'
  maxSessions: number
} {
  return (
    error instanceof Error &&
    error.message === 'session_limit_exceeded' &&
    (error as { code?: unknown }).code === 'SESSION_LIMIT' &&
    typeof (error as { maxSessions?: unknown }).maxSessions === 'number'
  )
}

/**
 * Result shape from `runtime.sendScoped(payload)`. Mirrored locally for the
 * same reason as `IPCResponse`: avoid a back import from runtime types into
 * the lifted handler body.
 */
interface SendScopedResult {
  success: boolean
  error?: string
  errorKind?: string
  persistence?: unknown
}

/**
 * Payload accepted by `agent:sendScoped`. Mirrors the inline anonymous type
 * that lived inside `ipc-handler.ts`; lifting verbatim so the handler body
 * stays byte-for-byte identical.
 */
export interface SendScopedPayload {
  scopeId: string
  agent?: string
  message: string | MultimodalBlock[]
  requestId?: string
  userMessage?: SendScopedUserMessage
  continuationIntent?: {
    taskId: string
    executionId?: string
    stepId?: string
    blockedReason?: string
    responseText?: string
    todoId?: string
    todoTitle?: string
    resumeKind?: 'snapshot' | 'paused' | 'done_residual'
    pauseReason?: string
    childRunId?: string
    detachedTaskId?: string
    taskRunId?: string
    jobId?: string
    skillId?: string
    action?: string
    runStatePath?: string
    outputDir?: string
    progressFingerprint?: string
  } | null
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * `orchestrator` is the resolved instance (not a getter) because the host
 * already resolves it before `setupAgentIPC` registers any handlers, so the
 * indirection would be cosmetic only. `sendScoped` is a method reference
 * (bound to the runtime instance by the host) so the group does not need a
 * runtime handle.
 */
export interface AgentLifecycleGroupDeps {
  /**
   * Bound orchestrator instance — used by `agent:send`, `agent:newSession`,
   * and `agent:kill`. The orchestrator's own state machine handles session
   * routing internally.
   */
  orchestrator: ReadyAgentOrchestrator
  /**
   * Bound `runtime.sendScoped` method — async, returns the lifted result
   * shape. Bound by the host so the group never imports `AgentControlRuntime`.
   */
  sendScoped(payload: SendScopedPayload): Promise<SendScopedResult>
  /**
   * Host-local cancel closure — cancels pending renderer tool action requests
   * keyed by (agent, sessionId). Called from `agent:newSession` + `agent:kill`
   * so a session reset / generation stop drops any in-flight design tool
   * requests rather than waiting for the 120s watchdog.
   */
  cancelToolActionRequestsBySession(agent: string, sessionId?: string): void
  /**
   * Host-local skill-session cleanup — called from `agent:newSession` to drop
   * reference hints, projection state, ephemeral store rows, ask-user-question
   * cards (in-memory + DB) for the session being reset.
   */
  cleanupSkillSessionState(sessionId?: string, reason?: string): void
  /**
   * Host-local skill-session cancel — called from `agent:kill` to reject any
   * pending interaction Promises (ephemeral store + ask-user-questions store)
   * for the session being stopped, plus sweep matching DB rows.
   */
  cancelSkillSessionPendingInteractions(sessionId?: string, reason?: string): void
  /**
   * Host log appender (rotating file logger). The lifted bodies log start /
   * result / exception lines; passed through so the group does not import the
   * rotating-logger module directly.
   */
  log(message: string): void
}

const CHANNELS = [
  'agent:send',
  'agent:newSession',
  'agent:kill',
  'agent:sendScoped',
  'agent:compactSession',
] as const

export const agentLifecycleGroup: IpcChannelGroup<AgentLifecycleGroupDeps> = {
  namespace: 'agent:lifecycle',

  register(ipcMain: IpcMain, deps: AgentLifecycleGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // Send message to agent — use direct HTTP streaming.
    ipcMain.handle('agent:send', async (_, { agent, message, sessionId, requestId }: {
      agent: string
      message: string | MultimodalBlock[]
      sessionId?: string
      requestId?: string
    }): Promise<IPCResponse> => {
      deps.log(`agent:send received — agent=${agent}, message=${typeof message === 'string' ? message.slice(0, 50) : `[${message.length} blocks]`}`)
      try {
        const result = await deps.orchestrator.send(agent, message, sessionId, requestId)
        deps.log(`agent:send result — success=${result.success}, error=${result.error}`)
        return {
          success: result.success,
          error: result.success ? undefined : result.error,
          mock: false
        }
      } catch (error) {
        // Stage V V3.5 — structured session-limit error gets a
        // dedicated `code: 'SESSION_LIMIT'` + `maxSessions` echo so the
        // renderer can render a friendly message without parsing
        // `error`. Defense in depth per plan §10 R12: this fires even
        // if the renderer V3.4a disable was bypassed.
        if (isSessionLimitError(error)) {
          deps.log(`agent:send rejected — session_limit_exceeded (max=${error.maxSessions})`)
          return {
            success: false,
            error: 'session_limit_exceeded',
            code: 'SESSION_LIMIT',
            maxSessions: error.maxSessions,
            mock: false,
          }
        }
        const errorMessage = error instanceof Error ? error.message : String(error)
        deps.log(`agent:send exception — ${errorMessage}`)
        return { success: false, error: errorMessage, mock: false }
      }
    })

    // Start a new session.
    ipcMain.handle('agent:newSession', (_, payload: string | { agent: string; sessionId?: string }): IPCResponse<{ cleared: boolean }> => {
      try {
        const agent = typeof payload === 'string' ? payload : payload.agent
        const sessionId = typeof payload === 'string' ? undefined : payload.sessionId
        deps.cancelToolActionRequestsBySession(agent, sessionId)
        deps.cleanupSkillSessionState(sessionId, 'Agent session was reset')
        deps.orchestrator.newSession(agent, sessionId)
        return { success: true, data: { cleared: true } }
      } catch (error) {
        // Stage V V3.5 — same structured surfacing as `agent:send`.
        if (isSessionLimitError(error)) {
          return {
            success: false,
            error: 'session_limit_exceeded',
            code: 'SESSION_LIMIT',
            maxSessions: error.maxSessions,
          }
        }
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    // Kill / stop generation.
    ipcMain.handle('agent:kill', (_, payload: string | { agent: string; sessionId?: string }): IPCResponse<{ killed: boolean }> => {
      try {
        const agent = typeof payload === 'string' ? payload : payload.agent
        const sessionId = typeof payload === 'string' ? undefined : payload.sessionId
        deps.cancelToolActionRequestsBySession(agent, sessionId)
        deps.cancelSkillSessionPendingInteractions(sessionId, 'Agent generation was stopped')
        deps.orchestrator.kill(agent, sessionId)
        return { success: true, data: { killed: true } }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:compactSession', async (_, payload: { agent?: string; sessionId?: string }): Promise<IPCResponse> => {
      try {
        const agent = typeof payload?.agent === 'string' ? payload.agent : ''
        if (!agent) {
          return { success: false, error: 'agent_required' }
        }
        const result = await deps.orchestrator.compactSession(agent, payload.sessionId)
        return { success: true, data: result || {} }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    // Scope-run send — push a turn at an explicit scope-run with optional
    // continuation intent. `runtime.sendScoped` owns the heavy lifting; the
    // handler is a thin wrapper: payload forward + log + result shape.
    ipcMain.handle('agent:sendScoped', async (_, payload: SendScopedPayload): Promise<IPCResponse> => {
      try {
        deps.log(`[ipc] agent:sendScoped start scopeId=${payload.scopeId} requestId=${payload.requestId || 'none'}`)
        const result = await deps.sendScoped(payload)
        deps.log(`[ipc] agent:sendScoped done scopeId=${payload.scopeId} requestId=${payload.requestId || 'none'} success=${result.success} error=${result.error || 'none'}`)
        return {
          success: result.success,
          error: result.error,
          errorKind: result.errorKind,
          persistence: result.persistence,
        }
      } catch (error) {
        deps.log(`[ipc] agent:sendScoped failed scopeId=${payload.scopeId} requestId=${payload.requestId || 'none'} error=${error instanceof Error ? error.message : String(error)}`)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorKind: 'unknown',
        }
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
export const _agentLifecycleGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
