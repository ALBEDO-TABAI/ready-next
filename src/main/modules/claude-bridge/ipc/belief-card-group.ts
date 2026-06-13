import type { IpcMain } from 'electron'
import type { BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import {
  buildBeliefCardSettingsSnapshot,
  type BeliefCardSettingsSnapshot,
} from '../../agent-control/knowledge/belief-card-settings-view'
import type { MaintenanceRoundStatusSnapshot } from '../../agent-control/maintenance/maintenance-llm-round'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface BeliefCardMaintenanceStatus {
  lifecycleRunning: boolean
  lastLifecycleMaintenanceAt: string | null
  llmRound: MaintenanceRoundStatusSnapshot | null
}

export interface BeliefCardListResponse extends BeliefCardSettingsSnapshot {
  knowledgeSystemEnabled: boolean
  maintenance: BeliefCardMaintenanceStatus
}

export interface BeliefCardTransitionPayload {
  relPath: string
  action: 'approve' | 'reject'
}

export interface BeliefCardGroupDeps {
  getBeliefCardStore(): BeliefCardStore | null
  getKnowledgeSystemEnabled(): boolean
  setKnowledgeSystemEnabled(enabled: boolean): void
  getLifecycleStatus(): { running: boolean; lastMaintenanceAt: Date | null }
  getMaintenanceRoundStatus(): MaintenanceRoundStatusSnapshot | null
}

const CHANNELS = [
  'agent:beliefCards:list',
  'agent:beliefCards:transition',
  'agent:beliefCards:setKnowledgeSystemEnabled',
] as const

function listBeliefCards(deps: BeliefCardGroupDeps): IPCResponse<BeliefCardListResponse> {
  const store = deps.getBeliefCardStore()
  if (!store) return { success: false, error: 'Belief card store not available' }
  const lifecycle = deps.getLifecycleStatus()
  return {
    success: true,
    data: {
      ...buildBeliefCardSettingsSnapshot(store),
      knowledgeSystemEnabled: deps.getKnowledgeSystemEnabled(),
      maintenance: {
        lifecycleRunning: lifecycle.running,
        lastLifecycleMaintenanceAt: lifecycle.lastMaintenanceAt?.toISOString() ?? null,
        llmRound: deps.getMaintenanceRoundStatus(),
      },
    },
  }
}

function sourceTarget(source: string | undefined, prefix: string): string | null {
  if (!source?.startsWith(prefix)) return null
  const relPath = source.slice(prefix.length).trim()
  return relPath || null
}

export const beliefCardGroup: IpcChannelGroup<BeliefCardGroupDeps> = {
  namespace: 'agent:beliefCards',

  register(ipcMain: IpcMain, deps: BeliefCardGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:beliefCards:list', async (): Promise<IPCResponse<BeliefCardListResponse>> => {
      try {
        return listBeliefCards(deps)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle(
      'agent:beliefCards:transition',
      async (_, payload: BeliefCardTransitionPayload): Promise<IPCResponse<BeliefCardListResponse>> => {
        try {
          const store = deps.getBeliefCardStore()
          if (!store) return { success: false, error: 'Belief card store not available' }
          const relPath = String(payload?.relPath || '').trim()
          const current = store.readCard(relPath, { includeStaged: true })
          if (!current) return { success: false, error: 'Belief card not found' }
          if (current.frontmatter.status !== 'staged') {
            return { success: false, error: 'Only staged belief cards can be confirmed' }
          }
          const target = payload?.action === 'approve' ? 'active' : payload?.action === 'reject' ? 'rejected' : null
          if (!target) return { success: false, error: 'Invalid belief card action' }
          if (payload.action === 'approve') {
            const updateTarget = sourceTarget(current.frontmatter.source, 'possible-update-of:')
            if (updateTarget) {
              const base = store.readCard(updateTarget, { includeStaged: true })
              if (!base) return { success: false, error: 'Target site card not found' }
              const mergedBody = [base.body.trim(), '', '## 已确认的站点学习', current.body.trim()].filter(Boolean).join('\n')
              const written = store.writeCard({ relPath: updateTarget, frontmatter: base.frontmatter, body: mergedBody })
              if (!written.ok) return { success: false, error: written.reason }
              if (!store.transition(relPath, 'rejected')) {
                return { success: false, error: 'Belief card transition failed' }
              }
              return listBeliefCards(deps)
            }
            const riskTarget = sourceTarget(current.frontmatter.source, 'possible-risk-update-of:')
            if (riskTarget) {
              if (!store.transition(relPath, 'rejected')) {
                return { success: false, error: 'Belief card transition failed' }
              }
              return listBeliefCards(deps)
            }
          }
          if (!store.transition(relPath, target)) {
            return { success: false, error: 'Belief card transition failed' }
          }
          return listBeliefCards(deps)
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    ipcMain.handle(
      'agent:beliefCards:setKnowledgeSystemEnabled',
      async (_, payload: { enabled?: boolean }): Promise<IPCResponse<BeliefCardListResponse>> => {
        try {
          deps.setKnowledgeSystemEnabled(payload?.enabled !== false)
          return listBeliefCards(deps)
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    return {
      dispose() {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _beliefCardGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
