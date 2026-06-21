import type { IpcMain } from 'electron'
import {
  deriveSpecialistAgentFromBlueprint,
  type AgentFactoryRegistry,
  type DeriveSpecialistAgentResult,
} from '../../agent-control/agents/agent-factory'
import {
  SpecialistBlueprintConfirmationStore,
} from '../../agent-control/agents/specialist-blueprint-confirmation'
import {
  hashSpecialistBlueprintReviewContent,
  materializeSpecialistBlueprintForReview,
} from '../../agent-control/agents/specialist-blueprint-review-content'
import {
  runSpecialistFoundationSemanticReview,
  type SpecialistFoundationSemanticReviewDeps,
} from '../../agent-control/agents/specialist-foundation-semantic-judge'
import { SpecialistBlueprintStore } from '../../agent-control/agents/specialist-blueprint-store'
import type { BeliefCardStore } from '../../agent-control/knowledge/belief-card-store'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintStatus,
  SpecialistFoundationSemanticReview,
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

export interface SpecialistBlueprintAdmissionResponse {
  blueprint: SpecialistAgentBlueprint
  verdict: SpecialistBlueprintAdmissionVerdict
  missing: string[]
}

export interface SpecialistBlueprintConfirmationResponse {
  blueprint: SpecialistAgentBlueprint
  tokenId: string
  contentHash: string
}

export interface SpecialistBlueprintConfirmCreateResponse {
  blueprint: SpecialistAgentBlueprint
  result: DeriveSpecialistAgentResult
}

export interface AgentSpecialistBlueprintGroupDeps {
  getBlueprintStore(): SpecialistBlueprintStore
  getConfirmationStore(): SpecialistBlueprintConfirmationStore
  getBeliefCardStore(): BeliefCardStore | null
  getAgentRegistry(): AgentFactoryRegistry
  runSemanticFoundationJudge?: SpecialistFoundationSemanticReviewDeps['judge']
  semanticFoundationJudgeUnavailableReason?: string
  semanticFoundationJudgeTimeoutMs?: number
  now?: () => Date
}

interface SpecialistBlueprintUnverifiedSemanticReviewAck {
  kind: 'unverified_semantic_review'
  contentHash: string
}

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

function statusForVerdict(verdict: SpecialistBlueprintAdmissionVerdict): SpecialistBlueprintStatus {
  if (verdict.kind === 'clarify') return 'needs_clarification'
  if (verdict.kind === 'admit') return 'staged'
  return 'rejected'
}

function nowIso(deps: AgentSpecialistBlueprintGroupDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function semanticIssueMissing(review: SpecialistFoundationSemanticReview): string[] {
  return review.issues.map((issue) => issue.id)
}

function isCurrentSemanticBlock(review: SpecialistFoundationSemanticReview | undefined, contentHash: string): boolean {
  return review?.status === 'blocked' && review.contentHash === contentHash
}

function acceptsSemanticReview(review: SpecialistFoundationSemanticReview | undefined, contentHash: string): boolean {
  if (!review || review.contentHash !== contentHash) return false
  return (
    (review.status === 'passed' && review.source === 'semantic_judge')
    || (review.status === 'unavailable' && review.source === 'unverified_explicit')
  )
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

function markUnverifiedExplicit(
  deps: AgentSpecialistBlueprintGroupDeps,
  review: SpecialistFoundationSemanticReview,
): SpecialistFoundationSemanticReview {
  return {
    ...review,
    reviewedAt: review.reviewedAt ?? nowIso(deps),
    source: 'unverified_explicit',
    unavailableReason: review.unavailableReason || 'user_acknowledged_unverified_semantic_review',
  }
}

async function admissionFor(
  deps: AgentSpecialistBlueprintGroupDeps,
  blueprint: SpecialistAgentBlueprint,
): Promise<SpecialistBlueprintAdmissionResponse> {
  const current = deps.getBlueprintStore().get(blueprint.blueprintId)
  if (current?.status === 'confirmed') throw new Error('confirmed blueprint cannot be overwritten')
  const canonical = materializeSpecialistBlueprintForReview(deps.getAgentRegistry(), blueprint)
  if (canonical.admissionVerdict.kind !== 'admit') {
    const status = statusForVerdict(canonical.admissionVerdict)
    const next = deps.getBlueprintStore().upsert({
      ...canonical,
      status,
      semanticReview: undefined,
    })
    return {
      blueprint: next,
      verdict: canonical.admissionVerdict,
      missing: canonical.admissionVerdict.kind === 'clarify' ? canonical.admissionVerdict.missing : [],
    }
  }

  const canonicalHash = hashSpecialistBlueprintReviewContent(canonical)
  if (isCurrentSemanticBlock(current?.semanticReview, canonicalHash) && current?.semanticReview) {
    const verdict: SpecialistBlueprintAdmissionVerdict = {
      kind: 'clarify',
      missing: semanticIssueMissing(current.semanticReview),
    }
    const next = deps.getBlueprintStore().upsert({
      ...canonical,
      status: 'needs_clarification',
      admissionVerdict: verdict,
      semanticReview: current.semanticReview,
    })
    return { blueprint: next, verdict, missing: verdict.missing }
  }

  const result = await runSpecialistFoundationSemanticReview(canonical, {
    registry: deps.getAgentRegistry(),
    judge: deps.runSemanticFoundationJudge,
    unavailableReason: deps.semanticFoundationJudgeUnavailableReason,
    timeoutMs: deps.semanticFoundationJudgeTimeoutMs,
    now: deps.now,
  })
  if (result.review.status === 'blocked') {
    const verdict: SpecialistBlueprintAdmissionVerdict = {
      kind: 'clarify',
      missing: semanticIssueMissing(result.review),
    }
    const next = deps.getBlueprintStore().upsert({
      ...result.blueprint,
      status: 'needs_clarification',
      admissionVerdict: verdict,
      semanticReview: result.review,
    })
    return { blueprint: next, verdict, missing: verdict.missing }
  }

  const next = deps.getBlueprintStore().upsert({
    ...result.blueprint,
    status: 'staged',
    semanticReview: result.review,
  })
  return { blueprint: next, verdict: next.admissionVerdict, missing: [] }
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
        return { success: true, data: await admissionFor(deps, blueprint) }
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
        const blueprint = deps.getBlueprintStore().get(blueprintId)
        if (!blueprint) throw new Error('blueprint not found')
        const admission = await admissionFor(deps, blueprint)
        if (admission.verdict.kind !== 'admit') throw new Error(`blueprint admission is not admit: ${admission.verdict.kind}`)
        const review = admission.blueprint.semanticReview
        const reviewedHash = review?.contentHash || hashSpecialistBlueprintReviewContent(admission.blueprint)
        let semanticReview = review
        if (review?.status === 'blocked') throw new Error('blueprint semantic review is blocked')
        if (!review || review.contentHash !== reviewedHash) throw new Error('blueprint semantic review is missing or stale')
        if (review.status === 'unavailable') {
          const ack = parseUnverifiedAck(payload?.unverifiedSemanticReviewAck)
          if (!ack || ack.contentHash !== reviewedHash) {
            throw new Error('blueprint semantic review unavailable; explicit unverified confirmation is required')
          }
          semanticReview = markUnverifiedExplicit(deps, review)
        } else if (review.status !== 'passed') {
          throw new Error(`blueprint semantic review is not passable: ${review.status}`)
        }
        const token = deps.getConfirmationStore().issue({
          blueprintId,
          sessionId: cleanString(payload?.sessionId),
          runId: payload?.runId ?? null,
          blueprintHash: reviewedHash,
          now: deps.now?.(),
        })
        const confirmed = deps.getBlueprintStore().patch(blueprintId, {
          status: 'confirmed',
          admissionVerdict: admission.blueprint.admissionVerdict,
          qualityChecks: admission.blueprint.qualityChecks,
          foundationDocs: admission.blueprint.foundationDocs,
          semanticReview,
          confirmation: {
            tokenId: token.id,
            confirmedAt: token.createdAt,
            usedAt: null,
          },
        })
        return { success: true, data: { blueprint: confirmed, tokenId: token.id, contentHash: reviewedHash } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'input_validation' }
      }
    })

    ipcMain.handle('agent:specialistBlueprint:confirmCreate', (_, payload: { blueprintId?: string; sessionId?: string; runId?: string | null; tokenId?: string; migrateCardRelPaths?: string[] }): IPCResponse<SpecialistBlueprintConfirmCreateResponse> => {
      try {
        const blueprintId = cleanString(payload?.blueprintId)
        const blueprint = deps.getBlueprintStore().get(blueprintId)
        if (!blueprint) throw new Error('blueprint not found')
        if (blueprint.status !== 'confirmed') throw new Error('blueprint must be confirmed')
        const storedBlueprintHash = hashSpecialistBlueprintReviewContent(blueprint)
        const tokenInput = {
          tokenId: cleanString(payload?.tokenId),
          blueprintId,
          sessionId: cleanString(payload?.sessionId),
          runId: payload?.runId ?? null,
          blueprintHash: storedBlueprintHash,
        }
        deps.getConfirmationStore().validate(tokenInput)
        const canonical = materializeSpecialistBlueprintForReview(deps.getAgentRegistry(), blueprint)
        if (canonical.admissionVerdict.kind !== 'admit') {
          throw new Error(`blueprint admission is not admit: ${canonical.admissionVerdict.kind}`)
        }
        const blueprintHash = hashSpecialistBlueprintReviewContent(canonical)
        if (blueprintHash !== storedBlueprintHash) {
          throw new Error('[specialist-blueprint-confirmation] token blueprint content mismatch')
        }
        if (!acceptsSemanticReview(blueprint.semanticReview, blueprintHash)) {
          throw new Error('blueprint semantic review must be passed or explicitly acknowledged before create')
        }
        const store = deps.getBeliefCardStore()
        if (!store) throw new Error('Belief card store not available')
        const result = deriveSpecialistAgentFromBlueprint(deps.getAgentRegistry(), store, {
          blueprint: {
            ...canonical,
            status: 'confirmed',
            confirmation: blueprint.confirmation,
            semanticReview: blueprint.semanticReview,
          },
          confirmationTokenId: tokenInput.tokenId,
          migrateCardRelPaths: Array.isArray(payload?.migrateCardRelPaths) ? payload.migrateCardRelPaths : [],
        })
        const used = deps.getConfirmationStore().consume(tokenInput)
        const confirmed = deps.getBlueprintStore().patch(blueprintId, {
          confirmation: {
            tokenId: used.id,
            confirmedAt: used.createdAt,
            usedAt: used.usedAt,
          },
          adoption: {
            blueprintId,
            createdAgentId: result.agent.id,
            confirmationTokenId: used.id,
            migratedCards: result.migratedCards,
            seedRelPaths: result.seedRelPaths,
            foundationRelPath: result.foundationRelPath || `agents/${result.agent.id}/FOUNDATION.md`,
            routingCardRelPath: result.routingCardRelPath,
            adoptedAt: used.usedAt ?? new Date().toISOString(),
          },
        })
        return { success: true, data: { blueprint: confirmed, result } }
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
