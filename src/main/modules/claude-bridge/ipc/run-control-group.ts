// Supported foreground/background run-control IPC.
// Public scope suspend/resume and checkpoint-successor controls are retired:
// the Codex runtime has no non-user successor admission path.
import type { IpcMain } from 'electron'
import type { ChildRunIpcResponse } from '../active-child-run-ipc'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
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

export interface RunControlGroupDeps {
  listActiveChildRuns(): ChildRunIpcResponse
  cancelChildRun(payload: { childRunId?: string }): Promise<ChildRunIpcResponse>
  reportInfrastructureTimeout(payload: ReportInfrastructureTimeoutPayload): Promise<ReportInfrastructureTimeoutResult>
}

const CHANNELS = [
  'agent:listActiveChildRuns',
  'agent:cancelChildRun',
  'agent:reportInfrastructureTimeout',
] as const

export const runControlGroup: IpcChannelGroup<RunControlGroupDeps> = {
  namespace: 'agent:runControl',

  register(ipcMain: IpcMain, deps: RunControlGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* handler may not exist */ }
    }

    ipcMain.handle('agent:listActiveChildRuns', (): IPCResponse => (
      deps.listActiveChildRuns() as IPCResponse
    ))

    ipcMain.handle('agent:cancelChildRun', async (_, payload: { childRunId?: string }): Promise<IPCResponse> => (
      (await deps.cancelChildRun(payload)) as IPCResponse
    ))

    ipcMain.handle('agent:reportInfrastructureTimeout', async (_, payload: ReportInfrastructureTimeoutPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.reportInfrastructureTimeout(payload)
        return {
          success: result.success,
          data: { state: result.state, activeRunId: result.activeRunId || null },
          error: result.error,
          errorKind: result.errorKind,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* already removed */ }
        }
      },
    }
  },
}

export const _runControlGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
