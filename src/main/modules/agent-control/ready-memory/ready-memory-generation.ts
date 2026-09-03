import { createHash, randomUUID } from 'node:crypto'

import { canonicalReadyMemoryJson } from './ready-memory-contract'
import { ReadyMemoryGenerationStore, readyMemoryGenerationDigest } from './ready-memory-generation-store'
import { ReadyMemoryRepository, ReadyMemoryRepositoryError } from './ready-memory-repository'
import type { ReadyMemoryCategory, ReadyMemoryEntry, ReadyMemoryJob } from './ready-memory-types'
import {
  READY_MEMORY_CONSOLIDATION_ACTION_LIMIT,
  READY_MEMORY_CONSOLIDATION_CONTRACT,
  READY_MEMORY_CONSOLIDATION_ENTRY_LIMIT,
  READY_MEMORY_CONSOLIDATION_INPUT_CHARS,
  READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS,
  READY_MEMORY_CONSOLIDATION_OUTPUT_TOKENS,
  READY_MEMORY_CONSOLIDATION_SOURCE_LIMIT,
  READY_MEMORY_EXTRACTION_CANDIDATE_LIMIT,
  READY_MEMORY_EXTRACTION_CONTRACT,
  READY_MEMORY_EXTRACTION_EVIDENCE_LIMIT,
  READY_MEMORY_EXTRACTION_INPUT_CHARS,
  READY_MEMORY_EXTRACTION_INPUT_CONTRACT,
  READY_MEMORY_EXTRACTION_OUTPUT_CHARS,
  READY_MEMORY_EXTRACTION_OUTPUT_TOKENS,
  READY_MEMORY_LEASE_MS,
  READY_MEMORY_MAX_TTL_DAYS,
  READY_MEMORY_MIN_TTL_DAYS,
  READY_MEMORY_PROVIDER_REQUEST_CONTRACT,
  READY_MEMORY_RECOVERY_COOLDOWN_MS,
  READY_MEMORY_SOURCE_SUMMARY_CHARS,
  READY_MEMORY_SUBMISSION_RECEIPT_CONTRACT,
  type ReadyMemoryConsolidationAction,
  type ReadyMemoryConsolidationEntry,
  type ReadyMemoryConsolidationInput,
  type ReadyMemoryConsolidationOutput,
  type ReadyMemoryConsolidationSource,
  type ReadyMemoryEvidenceLoader,
  type ReadyMemoryEvidenceRef,
  type ReadyMemoryEvidenceSegment,
  type ReadyMemoryExtractionCandidate,
  type ReadyMemoryExtractionOutput,
  type ReadyMemoryGenerationProvider,
  type ReadyMemoryFrozenProfile,
  type ReadyMemoryProviderRecovery,
  type ReadyMemoryProviderRequest,
  type ReadyMemoryProviderSubmission,
  type ReadyMemoryProviderUsage,
  type ReadyMemorySourceEligibility,
  type ReadyMemorySourceEnqueueResult,
  type ReadyMemorySubmissionReceipt,
  type ReadyMemoryWorkerResult,
} from './ready-memory-generation-types'
import type { ReadyMemoryStateChange } from '../../../../shared/ready-memory'
import { publishReadyMemoryStateChangeIfAdvanced } from './ready-memory-state-events'

const RESULT_RECEIPT_CONTRACT = 'ready-memory-provider-result:v1'
const SOURCE_CONTRACT = 'ready-memory-source:v1'
const CATEGORIES = new Set<ReadyMemoryCategory>([
  'preference', 'fact', 'project', 'workflow', 'other',
])

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function charLength(value: string): number {
  return Array.from(value).length
}

function rawDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requiredText(value: unknown, maxChars = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string') throw new Error('ready_memory_generation_invalid')
  const normalized = value.trim()
  if (!normalized || charLength(normalized) > maxChars) {
    throw new Error('ready_memory_generation_invalid')
  }
  return normalized
}

function requiredEvidenceText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim() || charLength(value) > maxChars) {
    throw new Error('ready_memory_generation_invalid')
  }
  return value
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('ready_memory_generation_invalid')
  }
}

function assertSafeText(value: string): void {
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bsk-[a-z0-9_-]{12,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[a-z0-9]{20,}\b/i,
    /\bgithub_pat_[a-z0-9_]{20,}\b/i,
    /\bxoxb-[a-z0-9-]{20,}\b/i,
    /\bnpm_[a-z0-9]{20,}\b/i,
    /\bpypi-[a-z0-9_-]{20,}\b/i,
    /\beyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+\b/i,
    /(?:password|passwd|pwd|token|secret|api[_ -]?key|密码|密钥|令牌|验证码)\s*[:=：]\s*\S{4,}/i,
    /(?:authorization|bearer)\s*[:= ]\s*[a-z0-9._~+/=-]{8,}/i,
    /(?:\botp\b|one[- ]time password|验证码).{0,16}\b\d{4,8}\b/i,
    /(?:身份证(?:号)?|passport(?: number)?|护照号)\s*[:=：]?\s*[a-z0-9]{8,18}/i,
  ]
  const instructionPatterns = [
    /^\s*(?:system|developer)\s*:/im,
    /<\/?(?:system|developer)(?:>|\s)/i,
    /\bignore (?:all )?(?:previous|prior) instructions?\b/i,
    /(?:忽略|无视)(?:之前|以上|先前).{0,8}(?:指令|要求|消息)/,
    /(?:系统|开发者)(?:指令|消息)\s*[:：]/,
  ]
  if ([...secretPatterns, ...instructionPatterns].some((pattern) => pattern.test(value))) {
    throw new Error('ready_memory_unsafe_content')
  }
}

function isTemporaryFact(value: string): boolean {
  return /\b(?:today|tomorrow|tonight|one[- ]time|this time|right now|this week|next week|(?:the )?(?:last|next|recent) few days)\b/i.test(value)
    || /(?:今天|明天|今晚|本周|下周|最近几天|近几天|本次|一次性|刚才|当前价格|临时验证码)/.test(value)
}

function uniqueStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) {
    throw new Error('ready_memory_generation_invalid')
  }
  const result = value.map((item) => requiredText(item, 256))
  if (new Set(result).size !== result.length) throw new Error('ready_memory_generation_invalid')
  return result
}

function validConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('ready_memory_generation_invalid')
  }
  return value
}

function validTtlDays(value: unknown): number {
  if (!Number.isSafeInteger(value)
    || Number(value) < READY_MEMORY_MIN_TTL_DAYS
    || Number(value) > READY_MEMORY_MAX_TTL_DAYS) {
    throw new Error('ready_memory_generation_invalid')
  }
  return Number(value)
}

function parseCandidate(
  value: unknown,
  evidenceRefs: ReadonlyMap<string, ReadyMemoryEvidenceRef['role']>,
): ReadyMemoryExtractionCandidate {
  if (!isRecord(value) || !exactKeys(value, [
    'candidateId', 'category', 'confidence', 'content', 'evidenceRefs', 'stability', 'ttlDays',
  ])) throw new Error('ready_memory_generation_invalid')
  const candidateId = requiredText(value.candidateId, 128)
  if (!/^[a-z0-9._:-]+$/i.test(candidateId) || !CATEGORIES.has(value.category as ReadyMemoryCategory)) {
    throw new Error('ready_memory_generation_invalid')
  }
  const content = requiredText(value.content, 2_000)
  assertSafeText(content)
  if (value.stability !== 'stable' || isTemporaryFact(content)) {
    throw new Error('ready_memory_temporary_candidate')
  }
  const refs = uniqueStrings(value.evidenceRefs, 32)
  if (!refs.every((ref) => evidenceRefs.has(ref))) throw new Error('ready_memory_generation_invalid')
  if (!refs.some((ref) => evidenceRefs.get(ref) === 'user')) {
    throw new Error('ready_memory_generation_invalid')
  }
  return {
    candidateId,
    category: value.category as ReadyMemoryCategory,
    content,
    confidence: validConfidence(value.confidence),
    stability: 'stable',
    ttlDays: validTtlDays(value.ttlDays),
    evidenceRefs: refs.map((ref) => ({ ref, role: evidenceRefs.get(ref)! })),
  }
}

function parseExtractionOutput(
  outputText: string,
  evidenceRefs: ReadonlyMap<string, ReadyMemoryEvidenceRef['role']>,
): ReadyMemoryExtractionOutput {
  if (charLength(outputText) > READY_MEMORY_EXTRACTION_OUTPUT_CHARS) {
    throw new Error('ready_memory_generation_output_budget_exceeded')
  }
  assertSafeText(outputText)
  const value = JSON.parse(outputText) as unknown
  if (!isRecord(value) || !exactKeys(value, ['candidates', 'contract', 'summary'])
    || value.contract !== READY_MEMORY_EXTRACTION_CONTRACT
    || !Array.isArray(value.candidates)
    || value.candidates.length > READY_MEMORY_EXTRACTION_CANDIDATE_LIMIT) {
    throw new Error('ready_memory_generation_invalid')
  }
  const summary = requiredText(value.summary, READY_MEMORY_SOURCE_SUMMARY_CHARS)
  assertSafeText(summary)
  if (isTemporaryFact(summary)) throw new Error('ready_memory_temporary_candidate')
  const candidates = value.candidates.map((candidate) => parseCandidate(candidate, evidenceRefs))
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new Error('ready_memory_generation_invalid')
  }
  return { contract: READY_MEMORY_EXTRACTION_CONTRACT, summary, candidates }
}

function parseConsolidationAction(
  value: unknown,
  candidateRefs: Set<string>,
  entryIds: Set<string>,
): ReadyMemoryConsolidationAction {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new Error('ready_memory_generation_invalid')
  }
  const refs = uniqueStrings(value.candidateRefs, READY_MEMORY_EXTRACTION_CANDIDATE_LIMIT * 4)
  if (!refs.every((ref) => candidateRefs.has(ref))) throw new Error('ready_memory_generation_invalid')
  if (value.action === 'ignore') {
    if (!exactKeys(value, ['action', 'candidateRefs', 'reason'])) {
      throw new Error('ready_memory_generation_invalid')
    }
    return { action: 'ignore', candidateRefs: refs, reason: requiredText(value.reason, 500) }
  }
  const commonKeys = ['action', 'candidateRefs', 'category', 'confidence', 'content', 'ttlDays']
  const supersede = value.action === 'supersede'
  if ((!supersede && value.action !== 'add')
    || !exactKeys(value, supersede ? [...commonKeys, 'supersedeEntryIds'] : commonKeys)
    || !CATEGORIES.has(value.category as ReadyMemoryCategory)) {
    throw new Error('ready_memory_generation_invalid')
  }
  const content = requiredText(value.content, 2_000)
  assertSafeText(content)
  if (isTemporaryFact(content)) throw new Error('ready_memory_temporary_candidate')
  const common = {
    candidateRefs: refs,
    category: value.category as ReadyMemoryCategory,
    content,
    confidence: validConfidence(value.confidence),
    ttlDays: validTtlDays(value.ttlDays),
  }
  if (!supersede) return { action: 'add', ...common }
  const supersedeEntryIds = uniqueStrings(value.supersedeEntryIds, 16)
  if (!supersedeEntryIds.every((entryId) => entryIds.has(entryId))) {
    throw new Error('ready_memory_generation_invalid')
  }
  return { action: 'supersede', supersedeEntryIds, ...common }
}

function parseConsolidationOutput(
  outputText: string,
  input: ReadyMemoryConsolidationInput,
): ReadyMemoryConsolidationOutput {
  if (charLength(outputText) > READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS) {
    throw new Error('ready_memory_generation_output_budget_exceeded')
  }
  assertSafeText(outputText)
  const value = JSON.parse(outputText) as unknown
  if (!isRecord(value) || !exactKeys(value, ['actions', 'contract'])
    || value.contract !== READY_MEMORY_CONSOLIDATION_CONTRACT
    || !Array.isArray(value.actions)
    || value.actions.length > READY_MEMORY_CONSOLIDATION_ACTION_LIMIT) {
    throw new Error('ready_memory_generation_invalid')
  }
  const candidateRefs = new Set(input.sources.flatMap((source) =>
    source.candidates.map((candidate) => `${source.sourceId}:${candidate.candidateId}`)))
  const entryIds = new Set(input.entries.map((entry) => entry.entryId))
  const actions = value.actions.map((action) => parseConsolidationAction(action, candidateRefs, entryIds))
  const actedCandidates = actions.flatMap((action) => action.candidateRefs)
  if (new Set(actedCandidates).size !== actedCandidates.length
    || actedCandidates.length !== candidateRefs.size) {
    throw new Error('ready_memory_generation_invalid')
  }
  return { contract: READY_MEMORY_CONSOLIDATION_CONTRACT, actions }
}

function assertUsage(usage: ReadyMemoryProviderUsage, maxOutputTokens: number): void {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.totalTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('ready_memory_usage_invalid')
  }
  if (usage.inputTokens + usage.outputTokens !== usage.totalTokens
    || usage.outputTokens > maxOutputTokens) throw new Error('ready_memory_usage_invalid')
}

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString()
}

function resultReceipt(input: {
  state: 'completed' | 'accepted' | 'unknown' | 'failed' | 'not_found'
  remoteId?: string
  outputText?: string
  outputDigest?: string
  retainOutputText?: boolean
  effectsDiscarded?: 'revoked' | 'corpus_changed'
  usage?: ReadyMemoryProviderUsage
  error?: string
}): Record<string, unknown> {
  return {
    contract: RESULT_RECEIPT_CONTRACT,
    providerState: input.state,
    remoteId: input.remoteId || null,
    outputText: input.retainOutputText === false ? null : input.outputText || null,
    outputDigest: input.outputDigest || (input.outputText ? rawDigest(input.outputText) : null),
    usage: input.usage || null,
    usageStatus: input.usage ? 'recorded' : 'unknown',
    error: input.error || null,
    effectsDiscarded: input.effectsDiscarded || null,
    queryRequired: input.state === 'accepted' || input.state === 'unknown',
  }
}

function findResultReceipt(value: unknown, state?: string): JsonObject | null {
  if (!isRecord(value)) return null
  if (value.contract === RESULT_RECEIPT_CONTRACT
    && (!state || value.providerState === state)) return value
  return findResultReceipt(value.recoveryReceipt, state)
    || findResultReceipt(value.unknownReceipt, state)
}

function assertProviderRequest(value: unknown): asserts value is ReadyMemoryProviderRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'budgetLane', 'contract', 'inputDigest', 'inputJson', 'jobId', 'kind', 'maxInputChars',
    'maxOutputChars', 'maxOutputTokens', 'model', 'outputContract', 'requestId',
    'recoveryProtocol', 'revocationRevision', 'upstreamProfileSnapshotDigest', 'upstreamProfileSnapshotRef',
  ]) || value.contract !== READY_MEMORY_PROVIDER_REQUEST_CONTRACT
    || value.budgetLane !== 'memory'
    || value.recoveryProtocol !== 'query-only-by-remote-id:v1'
    || !['extraction', 'consolidation'].includes(String(value.kind))) {
    throw new Error('ready_memory_submission_receipt_invalid')
  }
  const extraction = value.kind === 'extraction'
  const limits = extraction
    ? [READY_MEMORY_EXTRACTION_INPUT_CHARS, READY_MEMORY_EXTRACTION_OUTPUT_CHARS,
        READY_MEMORY_EXTRACTION_OUTPUT_TOKENS, READY_MEMORY_EXTRACTION_CONTRACT]
    : [READY_MEMORY_CONSOLIDATION_INPUT_CHARS, READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS,
        READY_MEMORY_CONSOLIDATION_OUTPUT_TOKENS, READY_MEMORY_CONSOLIDATION_CONTRACT]
  const inputJson = requiredText(value.inputJson, Number(limits[0]))
  assertSafeText(inputJson)
  try {
    JSON.parse(inputJson)
  } catch {
    throw new Error('ready_memory_submission_receipt_invalid')
  }
  if (requiredText(value.requestId, 256) !== value.requestId
    || requiredText(value.jobId, 256) !== value.jobId
    || requiredText(value.model, 128) !== value.model
    || requiredText(value.upstreamProfileSnapshotRef, 256) !== value.upstreamProfileSnapshotRef
    || !/^[0-9a-f]{64}$/.test(String(value.upstreamProfileSnapshotDigest))
    || !Number.isSafeInteger(value.revocationRevision) || Number(value.revocationRevision) < 0
    || value.inputDigest !== rawDigest(inputJson)
    || value.maxInputChars !== limits[0]
    || value.maxOutputChars !== limits[1]
    || value.maxOutputTokens !== limits[2]
    || value.outputContract !== limits[3]) {
    throw new Error('ready_memory_submission_receipt_invalid')
  }
}

function parseSubmissionReceipt(value: unknown): ReadyMemorySubmissionReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    'budgetLane', 'contract', 'mayHaveCommitted', 'request', 'requestDigest',
  ]) || value.contract !== READY_MEMORY_SUBMISSION_RECEIPT_CONTRACT
    || value.budgetLane !== 'memory' || typeof value.mayHaveCommitted !== 'boolean'
    || !isRecord(value.request) || typeof value.requestDigest !== 'string') {
    throw new Error('ready_memory_submission_receipt_invalid')
  }
  assertProviderRequest(value.request)
  const request = value.request
  if (readyMemoryGenerationDigest(request) !== value.requestDigest) {
    throw new Error('ready_memory_submission_receipt_invalid')
  }
  return value as unknown as ReadyMemorySubmissionReceipt
}

export class ReadyMemoryGenerationCoordinator {
  constructor(private readonly dependencies: {
    repository: ReadyMemoryRepository
    store: ReadyMemoryGenerationStore
    provider: ReadyMemoryGenerationProvider
    evidenceLoader: ReadyMemoryEvidenceLoader
    workerId: string
    resolveProfile: (now: string) => ReadyMemoryFrozenProfile
    isIdle?: () => boolean | Promise<boolean>
    makeId?: (prefix: string) => string
    onStateChanged?: (event: ReadyMemoryStateChange) => void
    onStateChangePublishError?: (error: unknown) => void
  }) {}

  enqueueSuccessfulSource(input: {
    sourceId: string
    conversationId: string
    sourceUpdatedAt: string
    evidence: ReadyMemoryEvidenceSegment[]
    eligibility: ReadyMemorySourceEligibility
    jobId?: string
    createdAt: string
  }): ReadyMemorySourceEnqueueResult {
    if (!this.dependencies.repository.getGlobalPolicy().generateMemories) {
      return { enqueued: false, reason: 'generation_disabled' }
    }
    if (input.eligibility.terminalStatus !== 'succeeded' || !input.eligibility.sealed
      || !input.eligibility.localRoot || input.eligibility.temporary
      || input.eligibility.hasUntrustedExternalContext) {
      return { enqueued: false, reason: 'ineligible' }
    }
    let refs: ReadyMemoryEvidenceRef[]
    let sourceId: string
    let conversationId: string
    try {
      sourceId = requiredText(input.sourceId, 256)
      conversationId = requiredText(input.conversationId, 256)
      assertTimestamp(input.sourceUpdatedAt)
      assertTimestamp(input.createdAt)
      refs = this.validateEvidence(input.evidence).map((segment) => ({
        ref: segment.ref,
        role: segment.role,
        contentDigest: rawDigest(segment.content),
        createdAt: segment.createdAt,
      }))
    } catch {
      return { enqueued: false, reason: 'unsafe' }
    }
    if (!this.dependencies.repository.getConversationPolicy(conversationId).contributeToMemories) {
      return { enqueued: false, reason: 'contribution_disabled' }
    }
    const sourceDigest = readyMemoryGenerationDigest({
      contract: SOURCE_CONTRACT,
      conversationId,
      sourceUpdatedAt: input.sourceUpdatedAt,
      evidenceRefs: refs,
    })
    const result = this.dependencies.repository.enqueueExtractionForSuccessfulSource({
      sourceId,
      conversationId,
      sourceDigest,
      sourceUpdatedAt: input.sourceUpdatedAt,
      evidenceRefs: refs,
      jobId: input.jobId || this.makeId('memory-extraction'),
      createdAt: input.createdAt,
    })
    if (!result.source || !result.job) {
      return { enqueued: false, reason: 'generation_disabled' }
    }
    return { enqueued: result.enqueued, reason: result.reason, source: result.source, job: result.job }
  }

  async runOnce(now: string): Promise<ReadyMemoryWorkerResult> {
    const before = this.dependencies.repository.getGlobalPolicy()
    try {
      return await this.runOnceWithFrozenState(now)
    } finally {
      publishReadyMemoryStateChangeIfAdvanced({
        before,
        after: this.dependencies.repository.getGlobalPolicy(),
        reason: 'generation',
        publish: this.dependencies.onStateChanged,
        onError: this.dependencies.onStateChangePublishError,
      })
    }
  }

  private async runOnceWithFrozenState(now: string): Promise<ReadyMemoryWorkerResult> {
    assertTimestamp(now)
    this.dependencies.repository.expireMemories(now)
    if (!(await (this.dependencies.isIdle?.() ?? true))) return { kind: 'busy' }

    const unapplied = this.dependencies.store.findSucceededUnappliedJob()
    if (unapplied) {
      this.reconcileJob(unapplied, now)
      if (unapplied.jobKind === 'extraction') this.ensureNextConsolidation(now)
      return { kind: 'reconciled', jobId: unapplied.jobId, jobKind: unapplied.jobKind }
    }

    const recoverable = this.dependencies.store.findRecoverableJob(
      new Date(Date.parse(now) - READY_MEMORY_RECOVERY_COOLDOWN_MS).toISOString(),
    )
    if (recoverable) return this.recoverJob(recoverable, now)

    if (!this.dependencies.repository.getGlobalPolicy().generateMemories) return { kind: 'disabled' }

    this.dependencies.repository.recoverExpiredLeases(now)
    this.ensureNextConsolidation(now)
    const leaseToken = this.makeId('memory-lease')
    const job = this.dependencies.repository.leaseNextJob({
      leaseOwner: this.dependencies.workerId,
      leaseToken,
      leasedAt: now,
      leaseExpiresAt: new Date(Date.parse(now) + READY_MEMORY_LEASE_MS).toISOString(),
    })
    if (!job) return { kind: 'idle' }
    return this.submitJob(job, leaseToken, now)
  }

  private validateEvidence(evidence: ReadyMemoryEvidenceSegment[]): ReadyMemoryEvidenceSegment[] {
    if (!Array.isArray(evidence) || evidence.length === 0
      || evidence.length > READY_MEMORY_EXTRACTION_EVIDENCE_LIMIT) {
      throw new Error('ready_memory_generation_invalid')
    }
    const refs = new Set<string>()
    let chars = 0
    const normalized: ReadyMemoryEvidenceSegment[] = []
    for (const segment of evidence) {
      const ref = requiredText(segment.ref, 256)
      if (!['user', 'assistant'].includes(segment.role)) throw new Error('ready_memory_unsafe_content')
      const content = requiredEvidenceText(segment.content, 8_000)
      assertTimestamp(segment.createdAt)
      assertSafeText(content)
      if (refs.has(ref)) throw new Error('ready_memory_generation_invalid')
      refs.add(ref)
      chars += charLength(content)
      normalized.push({ ref, role: segment.role, content, createdAt: segment.createdAt })
    }
    if (chars > READY_MEMORY_EXTRACTION_INPUT_CHARS) {
      throw new Error('ready_memory_generation_input_budget_exceeded')
    }
    return normalized
  }

  private async buildRequest(job: ReadyMemoryJob, now: string): Promise<ReadyMemoryProviderRequest> {
    let input: unknown
    let maxInputChars: number
    let maxOutputChars: number
    let maxOutputTokens: number
    let outputContract: ReadyMemoryProviderRequest['outputContract']
    if (job.jobKind === 'extraction') {
      if (!job.sourceId) throw new ReadyMemoryRepositoryError('source_not_found')
      const source = this.dependencies.store.getSource(job.sourceId)
      if (!source || source.summaryDigest) throw new ReadyMemoryRepositoryError('source_not_found')
      const loaded = this.validateEvidence(await this.dependencies.evidenceLoader.load(source.evidenceRefs))
      if (loaded.length !== source.evidenceRefs.length) throw new Error('ready_memory_evidence_changed')
      for (let index = 0; index < loaded.length; index += 1) {
        const segment = loaded[index]
        const ref = source.evidenceRefs[index]
        if (!ref || segment.ref !== ref.ref || segment.role !== ref.role
          || segment.createdAt !== ref.createdAt || rawDigest(segment.content) !== ref.contentDigest) {
          throw new Error('ready_memory_evidence_changed')
        }
      }
      input = {
        contract: READY_MEMORY_EXTRACTION_INPUT_CONTRACT,
        sourceId: source.sourceId,
        sourceDigest: source.sourceDigest,
        evidence: loaded,
      }
      maxInputChars = READY_MEMORY_EXTRACTION_INPUT_CHARS
      maxOutputChars = READY_MEMORY_EXTRACTION_OUTPUT_CHARS
      maxOutputTokens = READY_MEMORY_EXTRACTION_OUTPUT_TOKENS
      outputContract = READY_MEMORY_EXTRACTION_CONTRACT
    } else {
      input = this.dependencies.store.getJobInputPayload(job.jobId)
      if (!input || readyMemoryGenerationDigest(input) !== job.inputDigest) {
        throw new Error('ready_memory_consolidation_input_changed')
      }
      maxInputChars = READY_MEMORY_CONSOLIDATION_INPUT_CHARS
      maxOutputChars = READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS
      maxOutputTokens = READY_MEMORY_CONSOLIDATION_OUTPUT_TOKENS
      outputContract = READY_MEMORY_CONSOLIDATION_CONTRACT
    }
    const inputJson = canonicalReadyMemoryJson(input)
    if (charLength(inputJson) > maxInputChars) throw new Error('ready_memory_generation_input_budget_exceeded')
    assertSafeText(inputJson)
    const profile = this.dependencies.resolveProfile(now)
    return {
      contract: READY_MEMORY_PROVIDER_REQUEST_CONTRACT,
      requestId: this.makeId('memory-request'),
      jobId: job.jobId,
      kind: job.jobKind,
      model: requiredText(profile.model, 128),
      upstreamProfileSnapshotRef: requiredText(profile.upstreamProfileSnapshotRef, 256),
      upstreamProfileSnapshotDigest: requiredText(profile.upstreamProfileSnapshotDigest, 64),
      revocationRevision: this.dependencies.repository.getGlobalPolicy().revocationRevision,
      recoveryProtocol: 'query-only-by-remote-id:v1',
      budgetLane: 'memory',
      inputJson,
      inputDigest: rawDigest(inputJson),
      maxInputChars,
      maxOutputChars,
      maxOutputTokens,
      outputContract,
    }
  }

  private async submitJob(
    job: ReadyMemoryJob,
    leaseToken: string,
    now: string,
  ): Promise<ReadyMemoryWorkerResult> {
    let request: ReadyMemoryProviderRequest
    try {
      request = await this.buildRequest(job, now)
    } catch (error) {
      request = this.localRejectionRequest(job)
      try {
        this.persistSubmitted(job, leaseToken, request, now, false)
      } catch {
        this.dependencies.store.releaseUnsubmittedLease({
          jobId: job.jobId, leaseToken, releasedAt: now,
        })
        return { kind: 'disabled' }
      }
      this.dependencies.repository.recordJobTerminal({
        jobId: job.jobId,
        providerRequestId: request.requestId,
        status: 'failed',
        receipt: resultReceipt({ state: 'failed', error: String(error) }),
        error: String(error),
        terminalAt: now,
      })
      return { kind: 'submitted', jobId: job.jobId, providerState: 'failed' }
    }
    try {
      this.persistSubmitted(job, leaseToken, request, now)
    } catch {
      this.dependencies.store.releaseUnsubmittedLease({
        jobId: job.jobId, leaseToken, releasedAt: now,
      })
      return { kind: 'disabled' }
    }
    let response: ReadyMemoryProviderSubmission
    try {
      response = await this.dependencies.provider.submit(request)
    } catch {
      return { kind: 'submitted', jobId: job.jobId, providerState: 'unknown' }
    }
    try {
      this.recordProviderResponse(job, request, response, now)
    } catch (error) {
      this.recordInvalidProviderResult(job, request, error, now, response)
    }
    return { kind: 'submitted', jobId: job.jobId, providerState: response.state }
  }

  private persistSubmitted(
    job: ReadyMemoryJob,
    leaseToken: string,
    request: ReadyMemoryProviderRequest,
    now: string,
    mayHaveCommitted = true,
  ): void {
    const receipt: ReadyMemorySubmissionReceipt = {
      contract: READY_MEMORY_SUBMISSION_RECEIPT_CONTRACT,
      budgetLane: 'memory',
      request,
      requestDigest: readyMemoryGenerationDigest(request),
      mayHaveCommitted,
    }
    this.dependencies.repository.markJobSubmitted({
      jobId: job.jobId,
      leaseToken,
      providerRequestId: request.requestId,
      receipt: receipt as unknown as Record<string, unknown>,
      submittedAt: now,
      expectedRevocationRevision: request.revocationRevision,
    })
  }

  private recordProviderResponse(
    job: ReadyMemoryJob,
    request: ReadyMemoryProviderRequest,
    response: ReadyMemoryProviderSubmission,
    now: string,
  ): void {
    if (response.state === 'completed') {
      requiredText(response.remoteId, 256)
      this.recordCompleted(job, request, response, now)
      return
    }
    if (response.state === 'accepted') requiredText(response.remoteId, 256)
    if (response.state === 'failed') {
      if (response.usage) assertUsage(response.usage, request.maxOutputTokens)
      this.dependencies.repository.recordJobTerminal({
        jobId: job.jobId,
        providerRequestId: request.requestId,
        status: 'failed',
        receipt: resultReceipt({ ...response, retainOutputText: false }),
        error: requiredText(response.error, 2_000),
        terminalAt: now,
      })
      return
    }
    this.dependencies.repository.recordJobTerminal({
      jobId: job.jobId,
      providerRequestId: request.requestId,
      status: 'unknown',
      receipt: resultReceipt(response),
      terminalAt: now,
    })
  }

  private recordCompleted(
    job: ReadyMemoryJob,
    request: ReadyMemoryProviderRequest,
    response: Extract<ReadyMemoryProviderSubmission | ReadyMemoryProviderRecovery, { state: 'completed' }>,
    now: string,
  ): void {
    assertUsage(response.usage, request.maxOutputTokens)
    const policy = this.dependencies.repository.getGlobalPolicy()
    const consolidationInput = job.jobKind === 'consolidation'
      ? this.dependencies.store.getJobInputPayload(job.jobId) : null
    const effectsDiscarded = request.revocationRevision !== policy.revocationRevision
      ? 'revoked' as const
      : job.jobKind === 'consolidation'
        && consolidationInput?.stateRevision !== policy.stateRevision
        ? 'corpus_changed' as const
        : null
    if (effectsDiscarded) {
      this.dependencies.repository.recordJobTerminal({
        jobId: job.jobId,
        providerRequestId: request.requestId,
        status: 'no_output',
        receipt: resultReceipt({ ...response, effectsDiscarded, retainOutputText: false }),
        terminalAt: now,
      })
      this.dependencies.store.markNoOutputEffectsApplied(job.jobId, now)
      return
    }
    const parsed = job.jobKind === 'extraction'
      ? parseExtractionOutput(response.outputText, new Map(
          this.dependencies.store.getSource(job.sourceId || '')?.evidenceRefs
            .map((ref) => [ref.ref, ref.role]) || [],
        ))
      : parseConsolidationOutput(
          response.outputText,
          consolidationInput as ReadyMemoryConsolidationInput,
        )
    const noOutput = job.jobKind === 'consolidation'
      && (parsed as ReadyMemoryConsolidationOutput).actions.length === 0
    this.dependencies.repository.recordJobTerminal({
      jobId: job.jobId,
      providerRequestId: request.requestId,
      status: noOutput ? 'no_output' : 'succeeded',
      receipt: resultReceipt(response),
      terminalAt: now,
    })
    if (noOutput) this.dependencies.store.markNoOutputEffectsApplied(job.jobId, now)
  }

  private async recoverJob(job: ReadyMemoryJob, now: string): Promise<ReadyMemoryWorkerResult> {
    const submission = parseSubmissionReceipt(job.submissionReceipt)
    const unknownReceipt = findResultReceipt(job.resultReceipt)
    const remoteId = typeof unknownReceipt?.remoteId === 'string' ? unknownReceipt.remoteId : null
    let response: ReadyMemoryProviderRecovery
    try {
      response = await this.dependencies.provider.recover(submission.request, remoteId)
    } catch {
      this.dependencies.store.deferRecovery({
        jobId: job.jobId,
        providerRequestId: submission.request.requestId,
        receipt: resultReceipt({ state: 'unknown', remoteId: remoteId || undefined }),
        checkedAt: now,
      })
      return { kind: 'recovered', jobId: job.jobId, providerState: 'unknown' }
    }
    try {
      if (response.state === 'completed') {
        requiredText(response.remoteId, 256)
        this.recordCompleted(job, submission.request, response, now)
      } else if (response.state === 'failed' || response.state === 'not_found') {
        if (response.state === 'failed' && response.usage) {
          assertUsage(response.usage, submission.request.maxOutputTokens)
        }
        const error = response.state === 'not_found'
          ? 'provider_request_not_found_after_uncertain_submission'
          : requiredText(response.error, 2_000)
        this.dependencies.repository.recordJobTerminal({
          jobId: job.jobId,
          providerRequestId: submission.request.requestId,
          status: 'failed',
          receipt: resultReceipt({ ...response, state: response.state, retainOutputText: false }),
          error,
          terminalAt: now,
        })
      } else {
        this.dependencies.store.deferRecovery({
          jobId: job.jobId,
          providerRequestId: submission.request.requestId,
          receipt: resultReceipt({ state: 'unknown', remoteId: response.remoteId }),
          checkedAt: now,
        })
      }
    } catch (error) {
      this.recordInvalidProviderResult(job, submission.request, error, now, response)
    }
    return { kind: 'recovered', jobId: job.jobId, providerState: response.state }
  }

  private recordInvalidProviderResult(
    job: ReadyMemoryJob,
    request: ReadyMemoryProviderRequest,
    error: unknown,
    now: string,
    response?: ReadyMemoryProviderSubmission | ReadyMemoryProviderRecovery,
  ): void {
    const current = this.dependencies.repository.getJob(job.jobId)
    if (!current || !['submitted', 'unknown'].includes(current.status)) throw error
    const message = requiredText(String(error), 2_000)
    let responseUsage: ReadyMemoryProviderUsage | undefined
    try {
      if (response && 'usage' in response && response.usage) {
        assertUsage(response.usage, request.maxOutputTokens)
        responseUsage = response.usage
      }
    } catch { /* invalid usage remains explicitly unknown */ }
    const responseOutput = response && 'outputText' in response
      && typeof response.outputText === 'string' ? response.outputText : undefined
    this.dependencies.repository.recordJobTerminal({
      jobId: job.jobId,
      providerRequestId: request.requestId,
      status: 'failed',
      receipt: resultReceipt({
        state: 'failed', remoteId: response?.remoteId,
        outputDigest: responseOutput ? rawDigest(responseOutput) : undefined,
        retainOutputText: false, usage: responseUsage, error: message,
      }),
      error: message,
      terminalAt: now,
    })
  }

  private reconcileJob(job: ReadyMemoryJob, now: string): void {
    const submission = parseSubmissionReceipt(job.submissionReceipt)
    const policy = this.dependencies.repository.getGlobalPolicy()
    const input = job.jobKind === 'consolidation'
      ? this.dependencies.store.getJobInputPayload(job.jobId) : null
    const effectsDiscarded = submission.request.revocationRevision !== policy.revocationRevision
      ? 'revoked' as const
      : job.jobKind === 'consolidation' && input?.stateRevision !== policy.stateRevision
        ? 'corpus_changed' as const
        : null
    if (effectsDiscarded) {
      this.dependencies.store.discardSucceededEffects(job.jobId, now, effectsDiscarded)
      return
    }
    const completed = findResultReceipt(job.resultReceipt, 'completed')
    const outputText = typeof completed?.outputText === 'string' ? completed.outputText : null
    if (!outputText || completed?.outputDigest !== rawDigest(outputText)) {
      throw new Error('ready_memory_result_receipt_invalid')
    }
    if (job.jobKind === 'extraction') {
      const source = this.dependencies.store.getSource(job.sourceId || '')
      if (!source) throw new ReadyMemoryRepositoryError('source_not_found')
      const parsed = parseExtractionOutput(outputText, new Map(
        source.evidenceRefs.map((ref) => [ref.ref, ref.role]),
      ))
      const sealed = canonicalReadyMemoryJson(parsed)
      this.dependencies.store.atomic(() => {
        this.dependencies.repository.sealSourceSummary({
          sourceId: source.sourceId,
          jobId: job.jobId,
          summaryText: sealed,
          sealedAt: now,
        })
        this.dependencies.store.markEffectsApplied(job.jobId, now)
      })
      return
    }
    if (!input || readyMemoryGenerationDigest(input) !== job.inputDigest) {
      throw new Error('ready_memory_consolidation_input_changed')
    }
    const output = parseConsolidationOutput(outputText, input)
    this.dependencies.store.atomic(() => {
      this.applyConsolidation(job, input, output, now)
      this.dependencies.store.markEffectsApplied(job.jobId, now)
    })
  }

  private applyConsolidation(
    job: ReadyMemoryJob,
    input: ReadyMemoryConsolidationInput,
    output: ReadyMemoryConsolidationOutput,
    now: string,
  ): void {
    const candidateSources = new Map<string, string>()
    for (const source of input.sources) {
      for (const candidate of source.candidates) {
        candidateSources.set(`${source.sourceId}:${candidate.candidateId}`, source.sourceId)
      }
    }
    for (const [index, action] of output.actions.entries()) {
      if (action.action === 'ignore') continue
      const currentEntries = this.dependencies.repository.listEntries(['active'])
      if (currentEntries.some((entry) => entry.contentDigest === rawDigest(action.content))) continue
      let supersedeTargets: ReadyMemoryEntry[] = []
      if (action.action === 'supersede') {
        supersedeTargets = action.supersedeEntryIds
          .map((entryId) => this.dependencies.repository.getEntry(entryId))
          .filter((entry): entry is ReadyMemoryEntry => Boolean(entry) && entry!.status === 'active')
        if (supersedeTargets.length !== action.supersedeEntryIds.length
          || supersedeTargets.some((entry) => entry.origin === 'manual' || entry.pinned)) continue
      }
      const sourceRefs = [...new Set(action.candidateRefs.map((ref) => candidateSources.get(ref)))]
        .filter((sourceId): sourceId is string => Boolean(sourceId)).sort()
      if (sourceRefs.length === 0) continue
      const entryId = `memory-${readyMemoryGenerationDigest({ jobId: job.jobId, index, action }).slice(0, 24)}`
      const existing = this.dependencies.repository.getEntry(entryId)
      if (!existing) {
        this.dependencies.repository.addConsolidatedMemory({
          entryId,
          category: action.category,
          content: action.content,
          confidence: action.confidence,
          sourceRefs,
          expiresAt: addDays(now, action.ttlDays),
          createdAt: now,
        })
      } else if (existing.contentDigest !== rawDigest(action.content)) {
        throw new Error('ready_memory_consolidation_entry_conflict')
      }
      for (const target of supersedeTargets) {
        this.dependencies.repository.supersedeMemory(target.entryId, entryId, now)
      }
    }
  }

  private ensureNextConsolidation(now: string): ReadyMemoryJob | null {
    const stateRevision = this.dependencies.repository.getGlobalPolicy().stateRevision
    const attempted = this.dependencies.store.listAttemptedConsolidationSourceDigests()
    const candidates = this.dependencies.store.listSealedSources()
      .filter((source) => source.summaryDigest && !attempted.has(source.summaryDigest))
    if (candidates.length === 0) return null
    const sources: ReadyMemoryConsolidationSource[] = []
    for (const source of candidates.slice(0, READY_MEMORY_CONSOLIDATION_SOURCE_LIMIT)) {
      const parsed = this.dependencies.store.parseSealedExtraction(source)
      const item = {
        sourceId: source.sourceId,
        summaryDigest: source.summaryDigest!,
        summary: parsed.summary,
        candidates: parsed.candidates,
      }
      const tentative = {
        contract: READY_MEMORY_CONSOLIDATION_CONTRACT,
        stateRevision,
        sources: [...sources, item], entries: [],
      }
      if (charLength(canonicalReadyMemoryJson(tentative)) > 20_000) break
      sources.push(item)
    }
    if (sources.length === 0) throw new Error('ready_memory_consolidation_input_budget_exceeded')
    const entries: ReadyMemoryConsolidationEntry[] = []
    for (const entry of this.dependencies.repository.listEntries(['active'])
      .slice(0, READY_MEMORY_CONSOLIDATION_ENTRY_LIMIT)) {
      const item = {
        entryId: entry.entryId,
        category: entry.category,
        content: entry.content,
        contentDigest: entry.contentDigest,
        origin: entry.origin,
        pinned: entry.pinned,
        sourceRefs: entry.sourceRefs,
        updatedAt: entry.updatedAt,
      }
      const tentative = {
        contract: READY_MEMORY_CONSOLIDATION_CONTRACT,
        stateRevision,
        sources,
        entries: [...entries, item],
      }
      if (charLength(canonicalReadyMemoryJson(tentative)) > READY_MEMORY_CONSOLIDATION_INPUT_CHARS) break
      entries.push(item)
    }
    const payload: ReadyMemoryConsolidationInput = {
      contract: READY_MEMORY_CONSOLIDATION_CONTRACT,
      stateRevision,
      sources,
      entries,
    }
    const inputDigest = readyMemoryGenerationDigest(payload)
    return this.dependencies.store.createConsolidationJob({
      jobId: this.makeId('memory-consolidation'), payload, inputDigest, createdAt: now,
    })
  }

  private localRejectionRequest(job: ReadyMemoryJob): ReadyMemoryProviderRequest {
    const inputJson = canonicalReadyMemoryJson({ localRejection: true, jobId: job.jobId })
    const extraction = job.jobKind === 'extraction'
    return {
      contract: READY_MEMORY_PROVIDER_REQUEST_CONTRACT,
      requestId: this.makeId('memory-local-rejection'),
      jobId: job.jobId,
      kind: job.jobKind,
      model: 'local-rejection',
      upstreamProfileSnapshotRef: 'local-rejection',
      upstreamProfileSnapshotDigest: '0'.repeat(64),
      revocationRevision: this.dependencies.repository.getGlobalPolicy().revocationRevision,
      recoveryProtocol: 'query-only-by-remote-id:v1',
      budgetLane: 'memory',
      inputJson,
      inputDigest: rawDigest(inputJson),
      maxInputChars: extraction ? READY_MEMORY_EXTRACTION_INPUT_CHARS : READY_MEMORY_CONSOLIDATION_INPUT_CHARS,
      maxOutputChars: extraction ? READY_MEMORY_EXTRACTION_OUTPUT_CHARS : READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS,
      maxOutputTokens: extraction ? READY_MEMORY_EXTRACTION_OUTPUT_TOKENS : READY_MEMORY_CONSOLIDATION_OUTPUT_TOKENS,
      outputContract: extraction ? READY_MEMORY_EXTRACTION_CONTRACT : READY_MEMORY_CONSOLIDATION_CONTRACT,
    }
  }

  private makeId(prefix: string): string {
    return this.dependencies.makeId?.(prefix) || `${prefix}-${randomUUID()}`
  }
}
