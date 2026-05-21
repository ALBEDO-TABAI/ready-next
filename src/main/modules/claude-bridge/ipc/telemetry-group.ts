// Stage V V2.1j — TelemetryGroup channel group.
//
// Bundles the single channel that carries renderer-emitted metric events back
// into the main-process metric logger:
//
//   agent:emitRendererMetric (whitelisted renderer metric name + payload bag)
//
// Handler body is lifted VERBATIM from `ipc-handler.ts` (V2.1j is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the renderer metric stream keeps reaching
// `logAgentMetric` unchanged).
//
// The group owns ONE channel today, which still earns its own file because:
//   • the dep surface is distinct from every other V2.1 group (a name-allowlist
//     predicate + a metric logger function, no runtime methods at all)
//   • telemetry is a separate domain — future renderer-side metric channels
//     (e.g. ack of a card render, perf marks) would land here, not in the
//     run-control / projection / lifecycle groups
//   • the dispose lifecycle is independent: the renderer treats metric
//     emission as fire-and-forget, so the group can be torn down without
//     coordinating with task-card / scope-run UI mounts
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound to small host-local functions
// (an allowlist predicate + a metric-logger forward) rather than
// composition-root singletons. `engine-deps.ts` is reserved for true
// singletons; mixed/bound surfaces stay on the per-group interface where
// they belong.
import type { IpcMain } from 'electron'
import type { RendererAgentMetricName } from '../../../../shared/renderer-agent-metrics'
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
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Both fields are bound forwards into shared helpers:
 *   • `isRendererAgentMetricName` lives in `src/shared/renderer-agent-metrics.ts`
 *     and gates the whitelisted metric names so a renderer cannot inject
 *     arbitrary strings into the metric stream.
 *   • `logAgentMetric` lives in `src/main/modules/agent-control/metrics.ts`
 *     and is the main-side sink for the structured metric event.
 *
 * The host binds these per `setupAgentIPC` invocation so the group never
 * imports either module directly (keeps the boundary clean and the dep
 * surface explicit).
 */
export interface TelemetryGroupDeps {
  /**
   * Bound predicate — narrows the renderer-supplied `name` to the
   * `RendererAgentMetricName` allowlist. Returning `false` causes the handler
   * to reject the IPC with `Unknown renderer metric name` (verbatim from the
   * pre-extraction inline handler).
   */
  isRendererAgentMetricName(value: unknown): value is RendererAgentMetricName
  /**
   * Bound `logAgentMetric` forward — appends a structured metric event with
   * `source: 'renderer'` plus any renderer-supplied payload bag. Fire-and-
   * forget on the main side; the handler resolves `{success: true}` once the
   * log call returns.
   */
  logAgentMetric(name: RendererAgentMetricName, payload: Record<string, unknown>): void
}

const CHANNELS = [
  'agent:emitRendererMetric',
] as const

export const telemetryGroup: IpcChannelGroup<TelemetryGroupDeps> = {
  namespace: 'agent:telemetry',

  register(ipcMain: IpcMain, deps: TelemetryGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:emitRendererMetric', (_, payload: {
      name?: unknown
      payload?: Record<string, unknown>
    }): IPCResponse => {
      const name = payload?.name
      if (!deps.isRendererAgentMetricName(name)) {
        return { success: false, error: 'Unknown renderer metric name' }
      }
      deps.logAgentMetric(name, {
        source: 'renderer',
        ...(payload.payload && typeof payload.payload === 'object' ? payload.payload : {}),
      })
      return { success: true }
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
export const _telemetryGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
