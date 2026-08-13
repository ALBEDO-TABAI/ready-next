import type { IpcMain } from 'electron'
import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import { agentScopeKnowledgeDir, type BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

export interface AgentRegistryGroupDeps {
  listAgents(): AgentRegistryRecord[]
  getBeliefCardStore(): BeliefCardStore | null
}

const CHANNELS = [
  'agent:registry:list',
  'agent:registry:listKnowledge',
] as const

export interface AgentRegistryKnowledgeCard {
  relPath: string
  title: string
  description: string
  status: string
}

export const agentRegistryGroup: IpcChannelGroup<AgentRegistryGroupDeps> = {
  namespace: 'agent:registry',

  register(ipcMain: IpcMain, deps: AgentRegistryGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:registry:list', (): IPCResponse<AgentRegistryRecord[]> => {
      try {
        return { success: true, data: deps.listAgents() }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:registry:listKnowledge', (_, payload: { id?: string }): IPCResponse<AgentRegistryKnowledgeCard[]> => {
      try {
        const dir = agentScopeKnowledgeDir(String(payload?.id || '').trim())
        if (!dir) return { success: false, error: 'invalid agent id', errorKind: 'input_validation' }
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available' }
        const cards = store.listCards({ dir, includeStaged: true }).map((card) => ({
          relPath: card.relPath,
          title: card.frontmatter.title,
          description: card.frontmatter.description,
          status: card.frontmatter.status,
        }))
        return { success: true, data: cards }
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

export const _agentRegistryGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
