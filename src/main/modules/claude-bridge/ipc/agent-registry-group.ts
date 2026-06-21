import type { IpcMain } from 'electron'
import type { AgentRegistryRecord, AgentRegistryStatus } from '../../repositories/agent-registry-repository'
import { migrateAgentKnowledgeCards, rollbackAgentKnowledgeCardMigrations } from '../../agent-control/agents/agent-factory'
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
  updateStatus(
    id: string,
    status: Exclude<AgentRegistryStatus, 'active'>,
    options?: { mergedIntoAgentId?: string | null },
  ): AgentRegistryRecord
}

const CHANNELS = [
  'agent:registry:list',
  'agent:registry:listKnowledge',
  'agent:registry:updateStatus',
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
        const id = String(payload?.id || '').trim()
        const dir = agentScopeKnowledgeDir(id)
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

    ipcMain.handle('agent:registry:updateStatus', (_, payload: {
      id?: string
      status?: Exclude<AgentRegistryStatus, 'active'>
      mergedIntoAgentId?: string | null
      migrateCardRelPaths?: string[]
    }): IPCResponse<AgentRegistryRecord> => {
      let migratedCards: Array<{ from: string; to: string }> = []
      let rollbackStore: BeliefCardStore | null = null
      try {
        const status = payload?.status
        if (status !== 'retired' && status !== 'merged') {
          return { success: false, error: 'unsupported lifecycle status', errorKind: 'input_validation' }
        }
        const migrated = Array.isArray(payload?.migrateCardRelPaths)
          ? payload.migrateCardRelPaths.map((item) => String(item || '').trim()).filter(Boolean)
          : []
        if (status === 'merged' && migrated.length > 0) {
          const id = String(payload?.id || '').trim()
          const targetId = String(payload?.mergedIntoAgentId || '').trim()
          const agents = deps.listAgents()
          const source = agents.find((agent) => agent.id === id)
          const target = agents.find((agent) => agent.id === targetId)
          if (!source || source.status !== 'active') {
            return { success: false, error: 'agent not found or inactive', errorKind: 'input_validation' }
          }
          if (!target || target.status !== 'active' || target.id === id) {
            return { success: false, error: 'merged target must be active', errorKind: 'input_validation' }
          }
          const store = deps.getBeliefCardStore()
          if (!store) return { success: false, error: 'Belief card store not available' }
          rollbackStore = store
          migratedCards = migrateAgentKnowledgeCards(store, id, targetId, migrated)
        }
        const record = deps.updateStatus(String(payload?.id || ''), status, {
          mergedIntoAgentId: payload?.mergedIntoAgentId ?? null,
        })
        return { success: true, data: record }
      } catch (error) {
        if (rollbackStore && migratedCards.length > 0) {
          try {
            rollbackAgentKnowledgeCardMigrations(rollbackStore, migratedCards)
          } catch (rollbackError) {
            console.warn('[agent-registry] rollback migrated cards failed:', rollbackError)
          }
        }
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
