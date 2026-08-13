import type { IpcMain } from 'electron'
import {
  buildAgentSystemStudioSnapshot,
} from '../../agent-control/agents/specialist-studio-read-model'
import {
  confirmSpecialistContentEdit,
  rejectSpecialistContentEdit,
  stageSpecialistContentEdit,
  type AgentRegistryReader,
  type SpecialistContentEditProposalStore,
} from '../../agent-control/agents/specialist-content-edit-proposals'
import type { BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type {
  AgentSystemStudioConfirmContentEditInput,
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioRejectContentEditInput,
  AgentSystemStudioSnapshot,
  AgentSystemStudioStageContentEditInput,
} from '../../../../shared/agent-system-studio'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

export interface AgentSystemStudioGroupDeps {
  listAgents(): AgentRegistryRecord[]
  getAgentRegistry(): AgentRegistryReader
  getBeliefCardStore(): BeliefCardStore | null
  getContentEditProposalStore(): SpecialistContentEditProposalStore
}

const CHANNELS = [
  'agent:systemStudio:getSnapshot',
  'agent:systemStudio:stageContentEdit',
  'agent:systemStudio:confirmContentEdit',
  'agent:systemStudio:rejectContentEdit',
] as const

export const agentSystemStudioGroup: IpcChannelGroup<AgentSystemStudioGroupDeps> = {
  namespace: 'agent:systemStudio',

  register(ipcMain: IpcMain, deps: AgentSystemStudioGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:systemStudio:getSnapshot', (): IPCResponse<AgentSystemStudioSnapshot> => {
      try {
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available', errorKind: 'store_unavailable' }
        return {
          success: true,
          data: buildAgentSystemStudioSnapshot({
            agents: deps.listAgents(),
            store,
            listContentEditProposals: (agentId) => deps.getContentEditProposalStore().listForAgent(agentId),
          }),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:systemStudio:stageContentEdit', (_, payload: AgentSystemStudioStageContentEditInput): IPCResponse<AgentSystemStudioContentEditProposal> => {
      try {
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available', errorKind: 'store_unavailable' }
        const proposal = stageSpecialistContentEdit({
          registry: deps.getAgentRegistry(),
          store,
          proposalStore: deps.getContentEditProposalStore(),
        }, payload ?? ({} as AgentSystemStudioStageContentEditInput))
        return { success: true, data: proposal }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:systemStudio:confirmContentEdit', (_, payload: AgentSystemStudioConfirmContentEditInput): IPCResponse<AgentSystemStudioContentEditProposal> => {
      try {
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available', errorKind: 'store_unavailable' }
        const proposal = confirmSpecialistContentEdit({
          registry: deps.getAgentRegistry(),
          store,
          proposalStore: deps.getContentEditProposalStore(),
        }, payload?.proposalId ?? '')
        return { success: true, data: proposal }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:systemStudio:rejectContentEdit', (_, payload: AgentSystemStudioRejectContentEditInput): IPCResponse<AgentSystemStudioContentEditProposal> => {
      try {
        const store = deps.getBeliefCardStore()
        if (!store) return { success: false, error: 'Belief card store not available', errorKind: 'store_unavailable' }
        const proposal = rejectSpecialistContentEdit({
          registry: deps.getAgentRegistry(),
          store,
          proposalStore: deps.getContentEditProposalStore(),
        }, payload?.proposalId ?? '')
        return { success: true, data: proposal }
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

export const _agentSystemStudioGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
