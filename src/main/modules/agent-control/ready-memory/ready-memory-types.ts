export const READY_MEMORY_SNAPSHOT_CONTRACT = 'ready-memory:v1' as const
export const READY_MEMORY_READ_RECEIPT_CONTRACT = 'ready-memory-read-receipt:v1' as const
export const READY_MEMORY_SUMMARY_BUDGET_CHARS = 2_000
export const READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS = 24_000
export const READY_MEMORY_SNAPSHOT_ENTRY_LIMIT = 64

export type ReadyMemoryCategory = 'preference' | 'fact' | 'project' | 'workflow' | 'other'
export type ReadyMemoryOrigin = 'manual' | 'consolidated'
export type ReadyMemoryEntryStatus = 'active' | 'superseded' | 'expired'
export type ReadyMemoryRevocationReason =
  | 'edit'
  | 'delete'
  | 'reset'
  | 'use_off'
  | 'generate_off'
  | 'supersede'
  | 'expire'

export type ReadyMemoryJobKind = 'extraction' | 'consolidation'
export type ReadyMemoryJobStatus =
  | 'pending'
  | 'leased'
  | 'submitted'
  | 'succeeded'
  | 'no_output'
  | 'failed'
  | 'unknown'

export interface ReadyMemoryGlobalPolicy {
  useMemories: boolean
  generateMemories: boolean
  stateRevision: number
  revocationRevision: number
  lastRevocationReason: ReadyMemoryRevocationReason | null
  updatedAt: string
}

export interface ReadyMemoryConversationPolicy {
  conversationId: string
  contributeToMemories: boolean
  stateRevision: number
  updatedAt: string | null
}

export interface ReadyMemoryEntry {
  entryId: string
  category: ReadyMemoryCategory
  content: string
  contentDigest: string
  origin: ReadyMemoryOrigin
  confidence: number
  pinned: boolean
  status: ReadyMemoryEntryStatus
  supersededByEntryId: string | null
  expiresAt: string | null
  sourceRefs: string[]
  stateRevision: number
  revocationRevision: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ReadyMemorySnapshotEntry {
  entryId: string
  category: ReadyMemoryCategory
  content: string
  contentDigest: string
  origin: ReadyMemoryOrigin
  pinned: boolean
  sourceRefs: string[]
  stateRevision: number
}

export interface ReadyMemorySnapshot {
  contract: typeof READY_MEMORY_SNAPSHOT_CONTRACT
  enabled: boolean
  stateRevision: number
  revocationRevision: number
  lastRevocationReason: ReadyMemoryRevocationReason | null
  frozenAt: string
  summaryBudgetChars: typeof READY_MEMORY_SUMMARY_BUDGET_CHARS
  summaryChars: number
  summary: string
  summaryEntryIds: string[]
  entries: ReadyMemorySnapshotEntry[]
  sourceRefs: string[]
  truncated: boolean
  snapshotDigest: string
}

export interface ReadyMemoryReadReceipt {
  contract: typeof READY_MEMORY_READ_RECEIPT_CONTRACT
  snapshotDigest: string
  stateRevision: number
  revocationRevision: number
  readEntryIds: string[]
  readAt: string
  receiptDigest: string
}

export interface ReadyMemorySource {
  sourceId: string
  conversationId: string
  sourceDigest: string
  sourceUpdatedAt: string
  evidenceRefs: unknown[]
  summaryText: string | null
  summaryDigest: string | null
  sealedAt: string | null
  createdAt: string
}

export interface ReadyMemoryJob {
  jobId: string
  jobKind: ReadyMemoryJobKind
  sourceId: string | null
  inputDigest: string
  status: ReadyMemoryJobStatus
  attemptCount: number
  leaseOwner: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  providerRequestId: string | null
  submittedAt: string | null
  submissionReceipt: Record<string, unknown> | null
  submissionReceiptDigest: string | null
  terminalAt: string | null
  resultReceipt: Record<string, unknown> | null
  resultReceiptDigest: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type ReadyMemoryEnqueueResult =
  | { enqueued: false; reason: 'generation_disabled'; source: null; job: null }
  | { enqueued: boolean; reason: 'enqueued' | 'duplicate'; source: ReadyMemorySource; job: ReadyMemoryJob }
