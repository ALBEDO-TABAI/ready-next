// Stage V V2.1b — ToolEvent channel group.
//
// Bundles the two channels that carry tool-execution diagnostics from the
// renderer back into the main-process runtime:
//
//   tools:logToolEvent              (fire-and-forget log line — `ipcMain.on`)
//   agent:completeToolActionRequest (renderer ack for a design tool action)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1b is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// The two channels live in one group despite the prefix split (`tools:*` vs
// `agent:*`) because they share:
//   • a single concept — diagnostics about an in-flight tool action lifecycle
//   • the same dispose lifecycle (renderer treats them as one boot phase)
//   • a closely-coupled dep surface (the `pendingToolActionRequests` Map +
//     `releasePendingRequest` closure live in the same `setupAgentIPC` scope)
//
// Per-group deps are NOT a `Pick<EngineDeps>` because the dep surface here is
// host-local runtime state (a Map + closure created fresh per
// `setupAgentIPC` invocation), not engine-wide singletons. `engine-deps.ts`
// is reserved for true composition-root singletons; host-local closures stay
// on the per-group interface where they belong.
import type { IpcMain } from 'electron'
import { appendFileSync } from 'fs'
import { getLogPath } from '../../../utils/platform'
import { appendToolEventLog, type ToolEventLogPayload } from '../../tools/tool-event-log'
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
 * Pending entry held in the host's `pendingToolActionRequests` Map. The
 * handler only needs `resolve` / `reject`; the rest of the record (timer,
 * agent, sessionId) is managed by the host's lifecycle helpers.
 */
export interface PendingToolActionEntry {
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
}

/**
 * Per-group deps. Host-local closures + Map, not engine-wide singletons —
 * see file header for why this is not `Pick<EngineDeps, …>`.
 *
 * `pendingToolActionRequests` and `releasePendingRequest` are passed by
 * reference; mutations the handler makes (delete on ack) are observed by the
 * host's other code paths (kill / newSession sweep) immediately.
 */
export interface ToolEventGroupDeps {
  pendingToolActionRequests: Map<string, PendingToolActionEntry>
  releasePendingRequest(requestId: string): void
}

const HANDLE_CHANNELS = [
  'agent:completeToolActionRequest',
] as const

const LISTENER_CHANNELS = [
  'tools:logToolEvent',
] as const

export const toolEventGroup: IpcChannelGroup<ToolEventGroupDeps> = {
  namespace: 'tools:logToolEvent+agent:completeToolActionRequest',

  register(ipcMain: IpcMain, deps: ToolEventGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler /
    // listener so re-registration does not throw or double-fire. Mirrors the
    // pre-extraction defensive `removeAllListeners` + `removeHandler` calls
    // in `ipc-handler.ts`.
    for (const channel of LISTENER_CHANNELS) {
      try { ipcMain.removeAllListeners(channel) } catch { /* ignore — channel may not have listeners */ }
    }
    for (const channel of HANDLE_CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // `tools:logToolEvent` is fire-and-forget (renderer uses `send`, not
    // `invoke`); `ipcMain.on` is the matching listener signature. Bodies <
    // 4 lines and side-effect only — no Promise to return.
    ipcMain.on('tools:logToolEvent', (_event, payload: ToolEventLogPayload) => {
      if (!payload || typeof payload !== 'object') return
      appendToolEventLog(payload)
    })

    // `agent:completeToolActionRequest` is the renderer's ack for a design
    // tool action issued by `requestRendererToolAction` (host side). It must:
    //   1. look up the pending request entry (Map lives in the host scope so
    //      kill / newSession sweeps can cancel through the same Map)
    //   2. release the slot (clears timer + reverse index)
    //   3. resolve OR reject the pending Promise based on the renderer payload
    //   4. on success, opportunistically persist `runCapture` diagnostic for
    //      design-run debugging (best-effort — errors swallowed)
    ipcMain.handle('agent:completeToolActionRequest', async (_, payload: {
      requestId: string
      handled: boolean
      payload?: Record<string, unknown>
      error?: string
    }): Promise<IPCResponse<{ acknowledged: boolean }>> => {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      const pending = deps.pendingToolActionRequests.get(requestId)
      if (!pending) {
        return { success: false, error: `Unknown tool action request: ${requestId}` }
      }
      deps.releasePendingRequest(requestId)
      if (payload?.error) {
        pending.reject(new Error(payload.error))
      } else if (!payload?.handled) {
        pending.reject(new Error(`Renderer did not handle tool action request: ${requestId}`))
      } else {
        const resultPayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {}
        try {
          const capture = (resultPayload as { runCapture?: unknown }).runCapture
          if (capture && typeof capture === 'object') {
            appendFileSync(getLogPath('ready-design-run-captures.ndjson'), `${JSON.stringify(capture)}\n`)
          }
        } catch {
          // ignore diagnostic persistence failures
        }
        pending.resolve(resultPayload)
      }
      return { success: true, data: { acknowledged: true } }
    })

    return {
      dispose(): void {
        for (const channel of LISTENER_CHANNELS) {
          try { ipcMain.removeAllListeners(channel) } catch { /* ignore — already cleared */ }
        }
        for (const channel of HANDLE_CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertions). */
export const _toolEventGroupHandleChannelsForTest: ReadonlyArray<string> = HANDLE_CHANNELS
export const _toolEventGroupListenerChannelsForTest: ReadonlyArray<string> = LISTENER_CHANNELS
