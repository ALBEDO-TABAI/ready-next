export const SPECIALIST_BLUEPRINT_SOURCES = [
  'conversation',
  'manual',
  'emergence-candidate',
] as const

export type SpecialistBlueprintSource = (typeof SPECIALIST_BLUEPRINT_SOURCES)[number]

export type SpecialistBlueprintAdmissionVerdict =
  | { kind: 'admit' }
  | { kind: 'clarify'; missing: string[] }
  | { kind: 'reject_duplicate'; existingAgentId: string }
  | { kind: 'reject_unsafe'; reason: string }
  | { kind: 'reject_too_broad'; reason: string }
  | { kind: 'reject_premature'; reason: string }

export const SPECIALIST_BLUEPRINT_STATUSES = [
  'draft',
  'needs_clarification',
  'staged',
  'confirmed',
  'rejected',
  'expired',
] as const

export type SpecialistBlueprintStatus = (typeof SPECIALIST_BLUEPRINT_STATUSES)[number]

export interface SpecialistBlueprintKnowledgeSeed {
  title: string
  body: string
  evidenceRefs: string[]
}

export interface SpecialistBlueprintClarificationAnswer {
  id: string
  question: string
  answer: string
}

export interface SpecialistBlueprintQualityCheck {
  check: string
  pass: boolean
  blocking?: boolean
  message?: string
}

export const SPECIALIST_BLUEPRINT_SOURCE_MESSAGE_UNAVAILABLE_REASONS = [
  'message_id_unavailable',
  'request_envelope_missing_message_id',
  'legacy_message_shape',
] as const

export type SpecialistBlueprintSourceMessageUnavailableReason =
  (typeof SPECIALIST_BLUEPRINT_SOURCE_MESSAGE_UNAVAILABLE_REASONS)[number]

export const SPECIALIST_FOUNDATION_SEMANTIC_ISSUES = [
  'scope_too_generic',
  'role_not_operational',
  'main_split_unclear',
  'weak_non_goals',
  'weak_task_examples',
  'weak_inputs_outputs',
  'tool_boundary_underexplained',
  'memory_policy_unclear',
  'knowledge_lacks_evidence',
  'foundation_echoes_request',
  'lifecycle_unclear',
] as const

export type SpecialistFoundationSemanticIssueId = (typeof SPECIALIST_FOUNDATION_SEMANTIC_ISSUES)[number]

export type SpecialistFoundationSemanticReviewStatus =
  | 'not_run'
  | 'passed'
  | 'blocked'
  | 'unavailable'

export type SpecialistFoundationSemanticReviewSource =
  | 'semantic_judge'
  | 'unverified_explicit'
  | 'not_available'

export interface SpecialistFoundationSemanticIssue {
  id: SpecialistFoundationSemanticIssueId
  message: string
  clarificationQuestion?: string
}

export interface SpecialistFoundationSemanticReview {
  status: SpecialistFoundationSemanticReviewStatus
  contentHash: string
  reviewedAt: string | null
  issues: SpecialistFoundationSemanticIssue[]
  unavailableReason?: string
  source: SpecialistFoundationSemanticReviewSource
}

export interface SpecialistBlueprintInferredScope {
  slug: string
  displayName: string
  domain: string
  routingTriggers: string[]
}

export interface SpecialistBlueprintFoundationDocs {
  status: 'staged'
  charter: string
  rulesText: string
  knowledgeSeeds: SpecialistBlueprintKnowledgeSeed[]
  toolSafetyNotes: string
  foundationText: string
}

export interface SpecialistBlueprintProvenance {
  userRequestVerbatim: string
  sourceSessionId: string | null
  sourceRunId: string | null
  sourceMessageId: string | null
  sourceMessageUnavailableReason?: SpecialistBlueprintSourceMessageUnavailableReason | null
  createdAt: string
}

export interface SpecialistBlueprintConfirmationAudit {
  tokenId: string | null
  confirmedAt: string | null
  usedAt: string | null
}

export interface SpecialistBlueprintMigratedCard {
  from: string
  to: string
}

export interface SpecialistBlueprintAdoptionAudit {
  blueprintId: string
  createdAgentId: string
  confirmationTokenId: string
  migratedCards: SpecialistBlueprintMigratedCard[]
  seedRelPaths: string[]
  foundationRelPath: string
  routingCardRelPath: string
  adoptedAt: string
}

export type SpecialistBlueprintToolBoundaryMode = 'allow' | 'deny' | 'confirm'

export interface SpecialistBlueprintToolBoundary {
  mode: SpecialistBlueprintToolBoundaryMode
  notes: string
}

export interface SpecialistBlueprintToolBoundaries {
  browser: SpecialistBlueprintToolBoundary
  write: SpecialistBlueprintToolBoundary
  externalSend: SpecialistBlueprintToolBoundary
  longMemory: SpecialistBlueprintToolBoundary
}

export interface SpecialistBlueprintTaskExamples {
  suitable: string[]
  unsuitable: string[]
}

export interface SpecialistAgentBlueprint {
  blueprintId: string
  status: SpecialistBlueprintStatus
  inferredScope: SpecialistBlueprintInferredScope
  foundationDocs: SpecialistBlueprintFoundationDocs
  provenance: SpecialistBlueprintProvenance
  confirmation: SpecialistBlueprintConfirmationAudit
  rolePersona: string
  taskExamples: SpecialistBlueprintTaskExamples
  mainVsSpecialistSplit: string
  toolBoundaries: SpecialistBlueprintToolBoundaries
  memoryProfilePolicy: string
  lifecycleNotes: string
  specialistId: string
  displayName: string
  charter: string
  intendedDomain: string
  nonGoals: string[]
  recurringTasks: string[]
  requiredInputs: string[]
  expectedOutputs: string[]
  routingTriggers: string[]
  routingActivateOnCreate: boolean
  seedRulesText: string
  knowledgeSeeds: SpecialistBlueprintKnowledgeSeed[]
  migrationCandidates: string[]
  toolSafetyNotes: string
  source: SpecialistBlueprintSource
  userRequestVerbatim: string
  clarificationAnswers: SpecialistBlueprintClarificationAnswer[]
  admissionVerdict: SpecialistBlueprintAdmissionVerdict
  qualityChecks: SpecialistBlueprintQualityCheck[]
  semanticReview?: SpecialistFoundationSemanticReview
  adoption?: SpecialistBlueprintAdoptionAudit
}

export const SPECIALIST_BLUEPRINT_REQUIRED_FIELDS: ReadonlyArray<keyof SpecialistAgentBlueprint> = [
  'blueprintId',
  'status',
  'inferredScope',
  'foundationDocs',
  'provenance',
  'confirmation',
  'rolePersona',
  'taskExamples',
  'mainVsSpecialistSplit',
  'toolBoundaries',
  'memoryProfilePolicy',
  'lifecycleNotes',
  'specialistId',
  'displayName',
  'charter',
  'intendedDomain',
  'nonGoals',
  'recurringTasks',
  'requiredInputs',
  'expectedOutputs',
  'routingTriggers',
  'routingActivateOnCreate',
  'seedRulesText',
  'knowledgeSeeds',
  'migrationCandidates',
  'toolSafetyNotes',
  'source',
  'userRequestVerbatim',
  'clarificationAnswers',
  'admissionVerdict',
  'qualityChecks',
]

export function isSpecialistBlueprintSource(value: unknown): value is SpecialistBlueprintSource {
  return (SPECIALIST_BLUEPRINT_SOURCES as readonly unknown[]).includes(value)
}

export function isSpecialistBlueprintStatus(value: unknown): value is SpecialistBlueprintStatus {
  return (SPECIALIST_BLUEPRINT_STATUSES as readonly unknown[]).includes(value)
}

export function isSpecialistBlueprintAdmissionVerdict(value: unknown): value is SpecialistBlueprintAdmissionVerdict {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'admit') return true
  if (kind === 'clarify') return Array.isArray((value as { missing?: unknown }).missing)
  if (kind === 'reject_duplicate') return typeof (value as { existingAgentId?: unknown }).existingAgentId === 'string'
  if (kind === 'reject_unsafe' || kind === 'reject_too_broad' || kind === 'reject_premature') {
    return typeof (value as { reason?: unknown }).reason === 'string'
  }
  return false
}

export function isSpecialistBlueprintToolBoundaryMode(value: unknown): value is SpecialistBlueprintToolBoundaryMode {
  return value === 'allow' || value === 'deny' || value === 'confirm'
}

export function isSpecialistFoundationSemanticIssueId(value: unknown): value is SpecialistFoundationSemanticIssueId {
  return (SPECIALIST_FOUNDATION_SEMANTIC_ISSUES as readonly unknown[]).includes(value)
}

export function isSpecialistBlueprintSourceMessageUnavailableReason(
  value: unknown,
): value is SpecialistBlueprintSourceMessageUnavailableReason {
  return (SPECIALIST_BLUEPRINT_SOURCE_MESSAGE_UNAVAILABLE_REASONS as readonly unknown[]).includes(value)
}

function isSemanticReviewStatus(value: unknown): value is SpecialistFoundationSemanticReviewStatus {
  return value === 'not_run' || value === 'passed' || value === 'blocked' || value === 'unavailable'
}

function isSemanticReviewSource(value: unknown): value is SpecialistFoundationSemanticReviewSource {
  return value === 'semantic_judge' || value === 'unverified_explicit' || value === 'not_available'
}

export function validateSpecialistAgentBlueprintShape(value: unknown):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'blueprint must be an object' }
  const record = value as Record<string, unknown>
  for (const field of SPECIALIST_BLUEPRINT_REQUIRED_FIELDS) {
    if (!(field in record)) return { ok: false, reason: `missing field: ${field}` }
  }
  for (const field of [
    'specialistId',
    'displayName',
    'charter',
    'intendedDomain',
    'rolePersona',
    'mainVsSpecialistSplit',
    'memoryProfilePolicy',
    'lifecycleNotes',
    'seedRulesText',
    'toolSafetyNotes',
    'userRequestVerbatim',
  ]) {
    if (typeof record[field] !== 'string') return { ok: false, reason: `${field} must be a string` }
  }
  if (typeof record.blueprintId !== 'string') return { ok: false, reason: 'blueprintId must be a string' }
  if (!isSpecialistBlueprintStatus(record.status)) return { ok: false, reason: 'status is invalid' }
  for (const field of ['nonGoals', 'recurringTasks', 'requiredInputs', 'expectedOutputs', 'routingTriggers', 'knowledgeSeeds', 'migrationCandidates', 'clarificationAnswers', 'qualityChecks']) {
    if (!Array.isArray(record[field])) return { ok: false, reason: `${field} must be an array` }
  }
  for (const field of ['inferredScope', 'foundationDocs', 'provenance', 'confirmation', 'taskExamples', 'toolBoundaries']) {
    if (!record[field] || typeof record[field] !== 'object' || Array.isArray(record[field])) {
      return { ok: false, reason: `${field} must be an object` }
    }
  }
  const taskExamples = record.taskExamples as Record<string, unknown>
  if (!Array.isArray(taskExamples.suitable)) return { ok: false, reason: 'taskExamples.suitable must be an array' }
  if (!Array.isArray(taskExamples.unsuitable)) return { ok: false, reason: 'taskExamples.unsuitable must be an array' }
  if (!(taskExamples.suitable as unknown[]).every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'taskExamples.suitable entries must be strings' }
  }
  if (!(taskExamples.unsuitable as unknown[]).every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'taskExamples.unsuitable entries must be strings' }
  }
  const toolBoundaries = record.toolBoundaries as Record<string, unknown>
  for (const axis of ['browser', 'write', 'externalSend', 'longMemory']) {
    const boundary = toolBoundaries[axis]
    if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
      return { ok: false, reason: `toolBoundaries.${axis} must be an object` }
    }
    const boundaryRecord = boundary as Record<string, unknown>
    if (!isSpecialistBlueprintToolBoundaryMode(boundaryRecord.mode)) {
      return { ok: false, reason: `toolBoundaries.${axis}.mode is invalid` }
    }
    if (typeof boundaryRecord.notes !== 'string') {
      return { ok: false, reason: `toolBoundaries.${axis}.notes must be a string` }
    }
  }
  const inferred = record.inferredScope as Record<string, unknown>
  for (const field of ['slug', 'displayName', 'domain']) {
    if (typeof inferred[field] !== 'string') return { ok: false, reason: `inferredScope.${field} must be a string` }
  }
  if (!Array.isArray(inferred.routingTriggers)) return { ok: false, reason: 'inferredScope.routingTriggers must be an array' }
  const foundation = record.foundationDocs as Record<string, unknown>
  if (foundation.status !== 'staged') return { ok: false, reason: 'foundationDocs.status must be staged' }
  for (const field of ['charter', 'rulesText', 'toolSafetyNotes', 'foundationText']) {
    if (typeof foundation[field] !== 'string') return { ok: false, reason: `foundationDocs.${field} must be a string` }
  }
  if (!Array.isArray(foundation.knowledgeSeeds)) return { ok: false, reason: 'foundationDocs.knowledgeSeeds must be an array' }
  const provenance = record.provenance as Record<string, unknown>
  if (typeof provenance.userRequestVerbatim !== 'string') return { ok: false, reason: 'provenance.userRequestVerbatim must be a string' }
  if (typeof provenance.createdAt !== 'string') return { ok: false, reason: 'provenance.createdAt must be a string' }
  if (provenance.sourceMessageUnavailableReason !== undefined
    && provenance.sourceMessageUnavailableReason !== null
    && !isSpecialistBlueprintSourceMessageUnavailableReason(provenance.sourceMessageUnavailableReason)) {
    return { ok: false, reason: 'provenance.sourceMessageUnavailableReason is invalid' }
  }
  if (typeof record.routingActivateOnCreate !== 'boolean') {
    return { ok: false, reason: 'routingActivateOnCreate must be a boolean' }
  }
  if (!isSpecialistBlueprintSource(record.source)) return { ok: false, reason: 'source is invalid' }
  if (!isSpecialistBlueprintAdmissionVerdict(record.admissionVerdict)) {
    return { ok: false, reason: 'admissionVerdict is invalid' }
  }
  if (record.semanticReview !== undefined) {
    if (!record.semanticReview || typeof record.semanticReview !== 'object' || Array.isArray(record.semanticReview)) {
      return { ok: false, reason: 'semanticReview must be an object' }
    }
    const review = record.semanticReview as Record<string, unknown>
    if (!isSemanticReviewStatus(review.status)) return { ok: false, reason: 'semanticReview.status is invalid' }
    if (typeof review.contentHash !== 'string') return { ok: false, reason: 'semanticReview.contentHash must be a string' }
    if (review.reviewedAt !== null && typeof review.reviewedAt !== 'string') {
      return { ok: false, reason: 'semanticReview.reviewedAt must be a string or null' }
    }
    if (!Array.isArray(review.issues)) return { ok: false, reason: 'semanticReview.issues must be an array' }
    if (!isSemanticReviewSource(review.source)) return { ok: false, reason: 'semanticReview.source is invalid' }
    if (review.unavailableReason !== undefined && typeof review.unavailableReason !== 'string') {
      return { ok: false, reason: 'semanticReview.unavailableReason must be a string' }
    }
    for (const item of review.issues) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'semanticReview.issues entries must be objects' }
      }
      const issue = item as Record<string, unknown>
      if (!isSpecialistFoundationSemanticIssueId(issue.id)) {
        return { ok: false, reason: 'semanticReview.issues entries must use known ids' }
      }
      if (typeof issue.message !== 'string') return { ok: false, reason: 'semanticReview.issues message must be a string' }
      if (issue.clarificationQuestion !== undefined && typeof issue.clarificationQuestion !== 'string') {
        return { ok: false, reason: 'semanticReview.issues clarificationQuestion must be a string' }
      }
    }
  }
  if (record.adoption !== undefined) {
    if (!record.adoption || typeof record.adoption !== 'object' || Array.isArray(record.adoption)) {
      return { ok: false, reason: 'adoption must be an object' }
    }
    const adoption = record.adoption as Record<string, unknown>
    for (const field of ['blueprintId', 'createdAgentId', 'confirmationTokenId', 'foundationRelPath', 'routingCardRelPath', 'adoptedAt']) {
      if (typeof adoption[field] !== 'string') return { ok: false, reason: `adoption.${field} must be a string` }
    }
    for (const field of ['migratedCards', 'seedRelPaths']) {
      if (!Array.isArray(adoption[field])) return { ok: false, reason: `adoption.${field} must be an array` }
    }
    for (const item of adoption.migratedCards as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'adoption.migratedCards entries must be objects' }
      }
      const migration = item as Record<string, unknown>
      if (typeof migration.from !== 'string' || typeof migration.to !== 'string') {
        return { ok: false, reason: 'adoption.migratedCards entries must include from/to strings' }
      }
    }
    if (!(adoption.seedRelPaths as unknown[]).every((item) => typeof item === 'string')) {
      return { ok: false, reason: 'adoption.seedRelPaths entries must be strings' }
    }
  }
  return { ok: true }
}
