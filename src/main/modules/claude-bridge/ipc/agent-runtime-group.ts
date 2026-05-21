// Stage V V2.1d — AgentRuntime channel group.
//
// Bundles the 3 read-only channels that expose runtime/capability/channel
// snapshots to the renderer:
//
//   agent:getRuntimeStatus              (heartbeat + sidecar + channel counts)
//   agent:getCapabilityRuntimeSnapshot  (capability matrix for current model)
//   agent:listChannels                  (raw `agent_channels` rows)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1d is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and downstream renderer flows do not notice the refactor).
//
// All three channels live in one group because they share:
//   • the same domain concept (introspect the agent runtime from the renderer)
//   • the same dispose lifecycle (renderer treats them as one boot phase —
//     status + capability are usually polled together by the workbench shell)
//   • a closely-coupled dep surface (every handler is a one-line forward to a
//     `runtime.*` method)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the
// `AgentLifecycleGroup`: the dep surface is bound runtime methods (resolved
// fresh per `setupAgentIPC` invocation), not composition-root singletons.
// `engine-deps.ts` is reserved for true singletons; mixed/bound surfaces stay
// on the per-group interface where they belong.
import type { IpcMain } from 'electron'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { CapabilityRuntimeSnapshot } from '../../../../shared/ai-capability-runtime'
import type { AgentChannelConfig, AgentRuntimeStatus } from '../../agent-control/contracts/types'
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
export interface AgentRuntimeGroupDeps {
  /**
   * Bound `runtime.getRuntimeStatus` — async, returns the heartbeat + sidecar
   * + channel-count snapshot used by the workbench shell to drive the
   * runtime-status badge.
   */
  getRuntimeStatus(): Promise<AgentRuntimeStatus>
  /**
   * Bound `runtime.getCapabilityRuntimeSnapshot` — async, returns the
   * capability matrix for the current (or override) model config. Drives
   * tool-availability UI hints in the renderer.
   */
  getCapabilityRuntimeSnapshot(config?: AIModelConfig): Promise<CapabilityRuntimeSnapshot>
  /**
   * Bound `runtime.listChannels` — sync, returns the raw `agent_channels`
   * rows. Used by settings UI + channel-picker surfaces.
   */
  listChannels(): AgentChannelConfig[]
}

const CHANNELS = [
  'agent:getRuntimeStatus',
  'agent:getCapabilityRuntimeSnapshot',
  'agent:listChannels',
] as const

export const agentRuntimeGroup: IpcChannelGroup<AgentRuntimeGroupDeps> = {
  namespace: 'agent:runtime',

  register(ipcMain: IpcMain, deps: AgentRuntimeGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:getRuntimeStatus', async (): Promise<IPCResponse> => {
      try {
        const status = await deps.getRuntimeStatus()
        return { success: true, data: status }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:getCapabilityRuntimeSnapshot', async (_, config?: AIModelConfig): Promise<IPCResponse> => {
      try {
        const snapshot = await deps.getCapabilityRuntimeSnapshot(config)
        return { success: true, data: snapshot }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:listChannels', (): IPCResponse => {
      try {
        return { success: true, data: deps.listChannels() }
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
export const _agentRuntimeGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
