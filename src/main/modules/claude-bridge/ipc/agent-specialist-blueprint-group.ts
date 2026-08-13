import type { IpcMain } from 'electron'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface AgentSpecialistBlueprintGroupDeps {
  getBlueprintStore(): { list(): SpecialistAgentBlueprint[] }
}

const CHANNELS = ['agent:specialistBlueprint:list'] as const

export const agentSpecialistBlueprintGroup: IpcChannelGroup<AgentSpecialistBlueprintGroupDeps> = {
  namespace: 'agent:specialistBlueprint',

  register(ipcMain: IpcMain, deps: AgentSpecialistBlueprintGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }
    ipcMain.handle('agent:specialistBlueprint:list', (): IPCResponse<SpecialistAgentBlueprint[]> => {
      try {
        return { success: true, data: deps.getBlueprintStore().list() }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _agentSpecialistBlueprintGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
