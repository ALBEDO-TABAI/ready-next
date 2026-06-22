import {
  deriveSpecialistAgentFromBlueprint,
  type AgentFactoryRegistry,
  type DeriveSpecialistAgentResult,
} from './agent-factory'
import {
  SpecialistBlueprintConfirmationStore,
} from './specialist-blueprint-confirmation'
import {
  hashSpecialistBlueprintReviewContent,
  materializeSpecialistBlueprintForReview,
} from './specialist-blueprint-review-content'
import {
  runSpecialistFoundationSemanticReview,
  type SpecialistFoundationSemanticReviewDeps,
} from './specialist-foundation-semantic-judge'
import { SpecialistBlueprintStore } from './specialist-blueprint-store'
import type { BeliefCardStore } from '../knowledge/belief-card-store'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintStatus,
  SpecialistFoundationSemanticReview,
} from '../../../../shared/agent-specialist-blueprint'

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

export interface SpecialistBlueprintConfirmCreateDeps {
  getBlueprintStore(): SpecialistBlueprintStore
  getConfirmationStore(): SpecialistBlueprintConfirmationStore
  getBeliefCardStore(): BeliefCardStore | null
  getAgentRegistry(): AgentFactoryRegistry
  runSemanticFoundationJudge?: SpecialistFoundationSemanticReviewDeps['judge']
  semanticFoundationJudgeUnavailableReason?: string
  semanticFoundationJudgeTimeoutMs?: number
  now?: () => Date
}

export interface SpecialistBlueprintUnverifiedSemanticReviewAck {
  kind: 'unverified_semantic_review'
  contentHash: string
}

function statusForVerdict(verdict: SpecialistBlueprintAdmissionVerdict): SpecialistBlueprintStatus {
  if (verdict.kind === 'clarify') return 'needs_clarification'
  if (verdict.kind === 'admit') return 'staged'
  return 'rejected'
}

function nowIso(deps: SpecialistBlueprintConfirmCreateDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function semanticIssueMissing(review: SpecialistFoundationSemanticReview): string[] {
  return review.issues.map((issue) => issue.id)
}

function isCurrentSemanticBlock(review: SpecialistFoundationSemanticReview | undefined, contentHash: string): boolean {
  return review?.status === 'blocked' && review.contentHash === contentHash
}

export function acceptsSpecialistBlueprintSemanticReview(
  review: SpecialistFoundationSemanticReview | undefined,
  contentHash: string,
): boolean {
  if (!review || review.contentHash !== contentHash) return false
  return (
    (review.status === 'passed' && review.source === 'semantic_judge')
    || (review.status === 'unavailable' && review.source === 'unverified_explicit')
  )
}

export function markSpecialistBlueprintUnverifiedExplicit(
  deps: SpecialistBlueprintConfirmCreateDeps,
  review: SpecialistFoundationSemanticReview,
): SpecialistFoundationSemanticReview {
  return {
    ...review,
    reviewedAt: review.reviewedAt ?? nowIso(deps),
    source: 'unverified_explicit',
    unavailableReason: review.unavailableReason || 'user_acknowledged_unverified_semantic_review',
  }
}

export async function runSpecialistBlueprintAdmissionForCreate(
  deps: SpecialistBlueprintConfirmCreateDeps,
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

export async function requestSpecialistBlueprintConfirmationForCreate(
  deps: SpecialistBlueprintConfirmCreateDeps,
  payload: {
    blueprintId: string
    sessionId: string
    runId?: string | null
    unverifiedSemanticReviewAck?: SpecialistBlueprintUnverifiedSemanticReviewAck | null
    allowUnverifiedSemanticReview?: boolean
  },
): Promise<SpecialistBlueprintConfirmationResponse> {
  const blueprint = deps.getBlueprintStore().get(payload.blueprintId)
  if (!blueprint) throw new Error('blueprint not found')
  const admission = await runSpecialistBlueprintAdmissionForCreate(deps, blueprint)
  if (admission.verdict.kind !== 'admit') throw new Error(`blueprint admission is not admit: ${admission.verdict.kind}`)
  const review = admission.blueprint.semanticReview
  const reviewedHash = review?.contentHash || hashSpecialistBlueprintReviewContent(admission.blueprint)
  let semanticReview = review
  if (review?.status === 'blocked') throw new Error('blueprint semantic review is blocked')
  if (!review || review.contentHash !== reviewedHash) throw new Error('blueprint semantic review is missing or stale')
  if (review.status === 'unavailable') {
    const ack = payload.unverifiedSemanticReviewAck
    if (!payload.allowUnverifiedSemanticReview && (!ack || ack.contentHash !== reviewedHash)) {
      throw new Error('blueprint semantic review unavailable; explicit unverified confirmation is required')
    }
    semanticReview = markSpecialistBlueprintUnverifiedExplicit(deps, review)
  } else if (review.status !== 'passed') {
    throw new Error(`blueprint semantic review is not passable: ${review.status}`)
  }
  const token = deps.getConfirmationStore().issue({
    blueprintId: payload.blueprintId,
    sessionId: payload.sessionId,
    runId: payload.runId ?? null,
    blueprintHash: reviewedHash,
    now: deps.now?.(),
  })
  const confirmed = deps.getBlueprintStore().patch(payload.blueprintId, {
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
  return { blueprint: confirmed, tokenId: token.id, contentHash: reviewedHash }
}

export function confirmSpecialistBlueprintCreateWithToken(
  deps: SpecialistBlueprintConfirmCreateDeps,
  payload: {
    blueprintId: string
    sessionId: string
    runId?: string | null
    tokenId: string
    migrateCardRelPaths?: string[]
  },
): SpecialistBlueprintConfirmCreateResponse {
  const blueprint = deps.getBlueprintStore().get(payload.blueprintId)
  if (!blueprint) throw new Error('blueprint not found')
  if (blueprint.status !== 'confirmed') throw new Error('blueprint must be confirmed')
  const storedBlueprintHash = hashSpecialistBlueprintReviewContent(blueprint)
  const tokenInput = {
    tokenId: payload.tokenId,
    blueprintId: payload.blueprintId,
    sessionId: payload.sessionId,
    runId: payload.runId ?? null,
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
  if (!acceptsSpecialistBlueprintSemanticReview(blueprint.semanticReview, blueprintHash)) {
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
    migrateCardRelPaths: Array.isArray(payload.migrateCardRelPaths) ? payload.migrateCardRelPaths : [],
  })
  const used = deps.getConfirmationStore().consume(tokenInput)
  const confirmed = deps.getBlueprintStore().patch(payload.blueprintId, {
    confirmation: {
      tokenId: used.id,
      confirmedAt: used.createdAt,
      usedAt: used.usedAt,
    },
    adoption: {
      blueprintId: payload.blueprintId,
      createdAgentId: result.agent.id,
      confirmationTokenId: used.id,
      migratedCards: result.migratedCards,
      seedRelPaths: result.seedRelPaths,
      foundationRelPath: result.foundationRelPath || `agents/${result.agent.id}/FOUNDATION.md`,
      routingCardRelPath: result.routingCardRelPath,
      adoptedAt: used.usedAt ?? new Date().toISOString(),
    },
  })
  return { blueprint: confirmed, result }
}

export async function confirmAndCreateSpecialistBlueprint(
  deps: SpecialistBlueprintConfirmCreateDeps,
  payload: {
    blueprintId: string
    sessionId: string
    runId?: string | null
    allowUnverifiedSemanticReview?: boolean
    migrateCardRelPaths?: string[]
  },
): Promise<SpecialistBlueprintConfirmCreateResponse> {
  const confirmation = await requestSpecialistBlueprintConfirmationForCreate(deps, {
    blueprintId: payload.blueprintId,
    sessionId: payload.sessionId,
    runId: payload.runId ?? null,
    allowUnverifiedSemanticReview: payload.allowUnverifiedSemanticReview,
  })
  return confirmSpecialistBlueprintCreateWithToken(deps, {
    blueprintId: payload.blueprintId,
    sessionId: payload.sessionId,
    runId: payload.runId ?? null,
    tokenId: confirmation.tokenId,
    migrateCardRelPaths: payload.migrateCardRelPaths,
  })
}
