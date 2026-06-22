import type { IpcMain } from 'electron'
import {
  confirmSpecialistBlueprintCreateWithToken,
  requestSpecialistBlueprintConfirmationForCreate,
  runSpecialistBlueprintAdmissionForCreate,
  type SpecialistBlueprintAdmissionResponse,
  type SpecialistBlueprintConfirmCreateResponse,
  type SpecialistBlueprintConfirmCreateDeps,
  type SpecialistBlueprintConfirmationResponse,
  type SpecialistBlueprintUnverifiedSemanticReviewAck,
} from '../../agent-control/agents/specialist-blueprint-confirm-create'
import type {
  SpecialistAgentBlueprint,
} from '../../../../shared/agent-specialist-blueprint'
import {
  validateSpecialistAgentBlueprintShape,
} from '../../../../shared/agent-specialist-blueprint'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

export type AgentSpecialistBlueprintGroupDeps = SpecialistBlueprintConfirmCreateDeps

const CHANNELS = [
  'agent:specialistBlueprint:list',
  'agent:specialistBlueprint:upsertDraft',
  'agent:specialistBlueprint:runAdmission',
  'agent:specialistBlueprint:requestConfirmation',
  'agent:specialistBlueprint:confirmCreate',
  'agent:specialistBlueprint:reject',
  'agent:specialistBlueprint:expire',
] as const

function cleanString(value: unknown): string {
  return String(value || '').trim()
}

function parseBlueprint(value: unknown): SpecialistAgentBlueprint {
  const shape = validateSpecialistAgentBlueprintShape(value)
  if (!shape.ok) throw new Error(shape.reason)
  return value as SpecialistAgentBlueprint
}

function parseUnverifiedAck(value: unknown): SpecialistBlueprintUnverifiedSemanticReviewAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'unverified_semantic_review') return null
  if (typeof record.contentHash !== 'string' || !record.contentHash.trim()) return null
  return {
    kind: 'unverified_semantic_review',
    contentHash: record.contentHash.trim(),
  }
}

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

    ipcMain.handle('agent:specialistBlueprint:upsertDraft', (_, payload: { blueprint?: unknown }): IPCResponse<SpecialistAgentBlueprint> => {
      try {
        const blueprint = parseBlueprint(payload?.blueprint)
        if (blueprint.status === 'confirmed') throw new Error('confirmed blueprint cannot be upserted as draft')
        if (deps.getBlueprintStore().get(blueprint.blueprintId)?.status === 'confirmed') {
          throw new Error('confirmed blueprint cannot be overwritten')
        }
        return { success: true, data: deps.getBlueprintStore().upsert(blueprint) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:runAdmission', async (_, payload: { blueprint?: unknown; blueprintId?: string }): Promise<IPCResponse<SpecialistBlueprintAdmissionResponse>> => {
      try {
        const blueprint = payload?.blueprint
          ? parseBlueprint(payload.blueprint)
          : deps.getBlueprintStore().get(cleanString(payload?.blueprintId))
        if (!blueprint) throw new Error('blueprint not found')
        return { success: true, data: await runSpecialistBlueprintAdmissionForCreate(deps, blueprint) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:requestConfirmation', async (_, payload: {
      blueprintId?: string
      sessionId?: string
      runId?: string | null
      unverifiedSemanticReviewAck?: unknown
    }): Promise<IPCResponse<SpecialistBlueprintConfirmationResponse>> => {
      try {
        const blueprintId = cleanString(payload?.blueprintId)
        return { success: true, data: await requestSpecialistBlueprintConfirmationForCreate(deps, {
          blueprintId,
          sessionId: cleanString(payload?.sessionId),
          runId: payload?.runId ?? null,
          unverifiedSemanticReviewAck: parseUnverifiedAck(payload?.unverifiedSemanticReviewAck),
        }) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:confirmCreate', (_, payload: { blueprintId?: string; sessionId?: string; runId?: string | null; tokenId?: string; migrateCardRelPaths?: string[] }): IPCResponse<SpecialistBlueprintConfirmCreateResponse> => {
      try {
        const blueprintId = cleanString(payload?.blueprintId)
        return { success: true, data: confirmSpecialistBlueprintCreateWithToken(deps, {
          blueprintId,
          tokenId: cleanString(payload?.tokenId),
          sessionId: cleanString(payload?.sessionId),
          runId: payload?.runId ?? null,
          migrateCardRelPaths: Array.isArray(payload?.migrateCardRelPaths) ? payload.migrateCardRelPaths : [],
        }) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:reject', (_, payload: { blueprintId?: string }): IPCResponse<SpecialistAgentBlueprint> => {
      try {
        const blueprint = deps.getBlueprintStore().patch(cleanString(payload?.blueprintId), { status: 'rejected' })
        return { success: true, data: blueprint }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:expire', (_, payload: { blueprintId?: string }): IPCResponse<SpecialistAgentBlueprint> => {
      try {
        const blueprint = deps.getBlueprintStore().patch(cleanString(payload?.blueprintId), { status: 'expired' })
        return { success: true, data: blueprint }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
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
