import type { IpcMain } from 'electron'

import {
  parseCreateSessionResult,
  parseLifecycleRequest,
  parseLifecycleResult,
  parseSendScopedRequest,
  parseSendScopedResponse,
  type CreateSessionResult,
  type LifecycleRequest,
  type LifecycleResult,
  type SendScopedRequest,
  type SendScopedResponse,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export interface AgentLifecycleGroupDeps {
  sendScoped(payload: SendScopedRequest): Promise<SendScopedResponse>
  createSession(): Promise<CreateSessionResult>
  resetSession(request: LifecycleRequest): Promise<LifecycleResult>
  stopSession(request: LifecycleRequest): Promise<LifecycleResult>
  closeSession(request: LifecycleRequest): Promise<LifecycleResult>
  compactSession(request: LifecycleRequest): Promise<LifecycleResult>
  log(message: string): void
}

const CHANNELS = [
  'agent:sendScoped',
  'agent:createSession',
  'agent:resetSession',
  'agent:kill',
  'agent:closeSession',
  'agent:compactSession',
] as const

export const agentLifecycleGroup: IpcChannelGroup<AgentLifecycleGroupDeps> = {
  namespace: 'agent:lifecycle',

  register(ipcMain: IpcMain, deps: AgentLifecycleGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* handler may not exist */ }
    }

    ipcMain.handle('agent:sendScoped', async (_, rawPayload: unknown): Promise<SendScopedResponse> => {
      const payload = parseSendScopedRequest(rawPayload)
      deps.log(`[ipc] agent:sendScoped start scopeId=${payload.scopeId} requestId=${payload.requestId}`)
      const result = parseSendScopedResponse(await deps.sendScoped(payload))
      deps.log(`[ipc] agent:sendScoped done scopeId=${payload.scopeId} requestId=${payload.requestId} disposition=${result.disposition}`)
      return result
    })

    ipcMain.handle('agent:createSession', async (): Promise<CreateSessionResult> => (
      parseCreateSessionResult(await deps.createSession())
    ))

    ipcMain.handle('agent:resetSession', async (_, payload: unknown): Promise<LifecycleResult> => (
      parseLifecycleResult(await deps.resetSession(parseLifecycleRequest(payload)))
    ))

    ipcMain.handle('agent:kill', async (_, payload: unknown): Promise<LifecycleResult> => (
      parseLifecycleResult(await deps.stopSession(parseLifecycleRequest(payload)))
    ))

    ipcMain.handle('agent:closeSession', async (_, payload: unknown): Promise<LifecycleResult> => (
      parseLifecycleResult(await deps.closeSession(parseLifecycleRequest(payload)))
    ))

    ipcMain.handle('agent:compactSession', async (_, payload: unknown): Promise<LifecycleResult> => (
      parseLifecycleResult(await deps.compactSession(parseLifecycleRequest(payload)))
    ))

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* already removed */ }
        }
      },
    }
  },
}

export const _agentLifecycleGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
