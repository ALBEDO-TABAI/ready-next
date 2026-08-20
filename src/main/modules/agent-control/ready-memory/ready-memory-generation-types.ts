import type {
  ReadyMemoryCategory,
  ReadyMemoryEntry,
  ReadyMemoryJob,
  ReadyMemorySource,
} from './ready-memory-types'

export const READY_MEMORY_EXTRACTION_CONTRACT = 'ready-memory-extraction:v1' as const
export const READY_MEMORY_CONSOLIDATION_CONTRACT = 'ready-memory-consolidation:v1' as const
export const READY_MEMORY_EXTRACTION_INPUT_CONTRACT = 'ready-memory-extraction-input:v1' as const
export const READY_MEMORY_PROVIDER_REQUEST_CONTRACT = 'ready-memory-provider-request:v1' as const
export const READY_MEMORY_SUBMISSION_RECEIPT_CONTRACT = 'ready-memory-submission-receipt:v1' as const

export const READY_MEMORY_EXTRACTION_INPUT_CHARS = 24_000
export const READY_MEMORY_EXTRACTION_OUTPUT_CHARS = 8_000
export const READY_MEMORY_EXTRACTION_OUTPUT_TOKENS = 2_000
export const READY_MEMORY_EXTRACTION_EVIDENCE_LIMIT = 64
export const READY_MEMORY_EXTRACTION_CANDIDATE_LIMIT = 16
export const READY_MEMORY_SOURCE_SUMMARY_CHARS = 4_000

export const READY_MEMORY_CONSOLIDATION_INPUT_CHARS = 32_000
export const READY_MEMORY_CONSOLIDATION_OUTPUT_CHARS = 12_000
export const READY_MEMORY_CONSOLIDATION_OUTPUT_TOKENS = 3_000
export const READY_MEMORY_CONSOLIDATION_SOURCE_LIMIT = 32
export const READY_MEMORY_CONSOLIDATION_ENTRY_LIMIT = 64
export const READY_MEMORY_CONSOLIDATION_ACTION_LIMIT = 32

export const READY_MEMORY_MIN_TTL_DAYS = 30
export const READY_MEMORY_MAX_TTL_DAYS = 365
export const READY_MEMORY_LEASE_MS = 5 * 60 * 1_000
export const READY_MEMORY_RECOVERY_COOLDOWN_MS = 60 * 1_000

export type ReadyMemoryEvidenceRole = 'user' | 'assistant'

export interface ReadyMemoryEvidenceSegment {
  ref: string
  role: ReadyMemoryEvidenceRole
  content: string
  createdAt: string
}

export interface ReadyMemoryEvidenceRef {
  ref: string
  role: ReadyMemoryEvidenceRole
  contentDigest: string
  createdAt: string
}

export interface ReadyMemoryEvidenceLoader {
  load(refs: ReadyMemoryEvidenceRef[]): Promise<ReadyMemoryEvidenceSegment[]>
}

export interface ReadyMemorySourceEligibility {
  terminalStatus: 'succeeded'
  sealed: true
  localRoot: true
  temporary: false
  hasUntrustedExternalContext: false
}

export interface ReadyMemoryExtractionCandidate {
  candidateId: string
  category: ReadyMemoryCategory
  content: string
  confidence: number
  stability: 'stable'
  ttlDays: number
  evidenceRefs: Array<{
    ref: string
    role: ReadyMemoryEvidenceRole
  }>
}

export interface ReadyMemoryExtractionOutput {
  contract: typeof READY_MEMORY_EXTRACTION_CONTRACT
  summary: string
  candidates: ReadyMemoryExtractionCandidate[]
}

export interface ReadyMemoryConsolidationSource {
  sourceId: string
  summaryDigest: string
  summary: string
  candidates: ReadyMemoryExtractionCandidate[]
}

export interface ReadyMemoryConsolidationEntry {
  entryId: string
  category: ReadyMemoryCategory
  content: string
  contentDigest: string
  origin: ReadyMemoryEntry['origin']
  pinned: boolean
  sourceRefs: string[]
  updatedAt: string
}

export interface ReadyMemoryConsolidationInput {
  contract: typeof READY_MEMORY_CONSOLIDATION_CONTRACT
  stateRevision: number
  sources: ReadyMemoryConsolidationSource[]
  entries: ReadyMemoryConsolidationEntry[]
}

export type ReadyMemoryConsolidationAction =
  | {
      action: 'add'
      candidateRefs: string[]
      category: ReadyMemoryCategory
      content: string
      confidence: number
      ttlDays: number
    }
  | {
      action: 'supersede'
      candidateRefs: string[]
      supersedeEntryIds: string[]
      category: ReadyMemoryCategory
      content: string
      confidence: number
      ttlDays: number
    }
  | {
      action: 'ignore'
      candidateRefs: string[]
      reason: string
    }

export interface ReadyMemoryConsolidationOutput {
  contract: typeof READY_MEMORY_CONSOLIDATION_CONTRACT
  actions: ReadyMemoryConsolidationAction[]
}

export interface ReadyMemoryProviderUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface ReadyMemoryProviderRequest {
  contract: typeof READY_MEMORY_PROVIDER_REQUEST_CONTRACT
  requestId: string
  jobId: string
  kind: 'extraction' | 'consolidation'
  model: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  revocationRevision: number
  recoveryProtocol: 'query-only-by-remote-id:v1'
  budgetLane: 'memory'
  inputJson: string
  inputDigest: string
  maxInputChars: number
  maxOutputChars: number
  maxOutputTokens: number
  outputContract: typeof READY_MEMORY_EXTRACTION_CONTRACT | typeof READY_MEMORY_CONSOLIDATION_CONTRACT
}

export interface ReadyMemoryFrozenProfile {
  model: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
}

export type ReadyMemoryProviderSubmission =
  | {
      state: 'completed'
      remoteId: string
      outputText: string
      usage: ReadyMemoryProviderUsage
    }
  | { state: 'accepted'; remoteId: string }
  | { state: 'unknown'; remoteId?: string }
  | { state: 'failed'; remoteId?: string; error: string; outputText?: string; usage?: ReadyMemoryProviderUsage }

export type ReadyMemoryProviderRecovery =
  | {
      state: 'completed'
      remoteId: string
      outputText: string
      usage: ReadyMemoryProviderUsage
    }
  | { state: 'pending'; remoteId?: string }
  | { state: 'not_found'; remoteId?: string }
  | { state: 'unknown'; remoteId?: string }
  | { state: 'failed'; remoteId?: string; error: string; outputText?: string; usage?: ReadyMemoryProviderUsage }

export interface ReadyMemoryGenerationProvider {
  submit(request: ReadyMemoryProviderRequest): Promise<ReadyMemoryProviderSubmission>
  recover(request: ReadyMemoryProviderRequest, remoteId: string | null): Promise<ReadyMemoryProviderRecovery>
}

export interface ReadyMemorySubmissionReceipt {
  contract: typeof READY_MEMORY_SUBMISSION_RECEIPT_CONTRACT
  budgetLane: 'memory'
  request: ReadyMemoryProviderRequest
  requestDigest: string
  mayHaveCommitted: boolean
}

export type ReadyMemorySourceEnqueueResult =
  | { enqueued: false; reason: 'generation_disabled' | 'contribution_disabled' | 'ineligible' | 'unsafe' }
  | { enqueued: boolean; reason: 'enqueued' | 'duplicate'; source: ReadyMemorySource; job: ReadyMemoryJob }

export type ReadyMemoryWorkerResult =
  | { kind: 'disabled' | 'busy' | 'idle' }
  | { kind: 'reconciled'; jobId: string; jobKind: ReadyMemoryJob['jobKind'] }
  | { kind: 'submitted'; jobId: string; providerState: ReadyMemoryProviderSubmission['state'] }
  | { kind: 'recovered'; jobId: string; providerState: ReadyMemoryProviderRecovery['state'] }
