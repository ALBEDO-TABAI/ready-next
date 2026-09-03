import type { IpcMain } from 'electron'
import { isDeepStrictEqual } from 'node:util'

import {
  parseCreateSessionRequest,
  parseCreateSessionResult,
  parseLifecycleRequest,
  parseLifecycleResult,
  parseProductLifecycleRequest,
  parseStopLifecycleRequest,
  parseSendScopedRequest,
  parseSendScopedResponse,
  type CreateSessionRequest,
  type CreateSessionResult,
  type LifecycleRequest,
  type LifecycleResult,
  type ProductLifecycleRequest,
  type StopLifecycleRequest,
  type SendScopedRequest,
  type SendScopedResponse,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'
import type { LifecycleOperationProjectionV2 } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'

export interface AgentLifecycleGroupDeps {
  sendScoped(payload: SendScopedRequest): Promise<SendScopedResponse>
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>
  resetSession(request: ProductLifecycleRequest): Promise<LifecycleResult>
  stopSession(request: StopLifecycleRequest): Promise<LifecycleResult>
  closeSession(request: ProductLifecycleRequest): Promise<LifecycleResult>
  compactSession(request: LifecycleRequest): Promise<LifecycleResult>
  readLifecycleSnapshot?: (request: LifecycleRequest) => LifecycleOperationProjectionV2
  log(message: string): void
}

function validateActionRequest(
  deps: AgentLifecycleGroupDeps,
  request: LifecycleRequest & { readyRunId?: string | null },
  action: keyof LifecycleOperationProjectionV2['actions'],
): LifecycleResult | null {
  if (!deps.readLifecycleSnapshot) return null
  const projection = deps.readLifecycleSnapshot({
    aliasId: request.aliasId,
    aliasGeneration: request.aliasGeneration,
  })
  const gate = projection.actions[action]
  const ref = request.actionRequestRef
  const runMatches = ref?.ownerKind !== 'run_owner'
    ? request.readyRunId == null
    : ref.targetReadyRunId === request.readyRunId
  if (gate.availability === 'ready' && gate.requestRef && ref
    && ref.action === action && runMatches
    && ref.digest === gate.requestRef.digest
    && isDeepStrictEqual(ref, gate.requestRef)) return null
  return {
    ok: false,
    action,
    code: 'binding_conflict',
    preserveUi: true,
    aliasId: request.aliasId,
    aliasGeneration: request.aliasGeneration,
    evidenceDigest: projection.evidenceDigest,
  }
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
      const safeReason = result.disposition === 'rejected_before_persistence'
        && /^[A-Za-z0-9_.:-]{1,160}$/.test(result.error)
        ? result.error
        : null
      const rejection = result.disposition === 'rejected_before_persistence'
        ? ` errorKind=${result.errorKind} admissionEvidenceDigest=${result.admissionEvidenceDigest}${safeReason ? ` reason=${safeReason}` : ''}`
        : ''
      deps.log(`[ipc] agent:sendScoped done scopeId=${payload.scopeId} requestId=${payload.requestId} disposition=${result.disposition}${rejection}`)
      return result
    })

    ipcMain.handle('agent:createSession', async (_, rawPayload: unknown): Promise<CreateSessionResult> => (
      parseCreateSessionResult(await deps.createSession(parseCreateSessionRequest(rawPayload)))
    ))

    ipcMain.handle('agent:resetSession', async (_, payload: unknown): Promise<LifecycleResult> => {
      const request = parseProductLifecycleRequest(payload)
      return validateActionRequest(deps, request, 'reset')
        || parseLifecycleResult(await deps.resetSession(request))
    })

    ipcMain.handle('agent:kill', async (_, payload: unknown): Promise<LifecycleResult> => {
      const request = parseStopLifecycleRequest(payload)
      const invalid = validateActionRequest(deps, request, 'stop')
      if (invalid) return invalid
      deps.log(`[ipc] agent:kill start aliasId=${request.aliasId} aliasGeneration=${request.aliasGeneration} readyRunId=${request.readyRunId}`)
      try {
        const result = parseLifecycleResult(await deps.stopSession(request))
        const outcome = result.ok
          ? `action=${result.action}${result.action === 'stop' ? ` terminal=${result.terminal}` : ''}`
          : `code=${result.code}`
        deps.log(`[ipc] agent:kill done aliasId=${request.aliasId} aliasGeneration=${request.aliasGeneration} readyRunId=${request.readyRunId} ok=${result.ok} ${outcome}`)
        return result
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '')
          : 'stop_failed'
        deps.log(`[ipc] agent:kill failed aliasId=${request.aliasId} aliasGeneration=${request.aliasGeneration} readyRunId=${request.readyRunId} code=${/^[A-Za-z0-9_.:-]{1,96}$/.test(code) ? code : 'stop_failed'}`)
        throw error
      }
    })

    ipcMain.handle('agent:closeSession', async (_, payload: unknown): Promise<LifecycleResult> => {
      const request = parseProductLifecycleRequest(payload)
      return validateActionRequest(deps, request, 'close')
        || parseLifecycleResult(await deps.closeSession(request))
    })

    ipcMain.handle('agent:compactSession', async (_, payload: unknown): Promise<LifecycleResult> => {
      const request = parseLifecycleRequest(payload)
      return validateActionRequest(deps, request, 'manual_compact')
        || parseLifecycleResult(await deps.compactSession(request))
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

export const _agentLifecycleGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
