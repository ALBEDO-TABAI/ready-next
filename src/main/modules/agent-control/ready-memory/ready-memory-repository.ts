import { createHash } from 'node:crypto'
import type { DatabaseConnection } from '../../database/connection'
import {
  READY_MEMORY_READ_RECEIPT_CONTRACT,
  READY_MEMORY_SNAPSHOT_CONTRACT,
  READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS,
  READY_MEMORY_SNAPSHOT_ENTRY_LIMIT,
  READY_MEMORY_SUMMARY_BUDGET_CHARS,
  type ReadyMemoryCategory,
  type ReadyMemoryConversationPolicy,
  type ReadyMemoryEnqueueResult,
  type ReadyMemoryEntry,
  type ReadyMemoryEntryStatus,
  type ReadyMemoryGlobalPolicy,
  type ReadyMemoryJob,
  type ReadyMemoryJobStatus,
  type ReadyMemoryReadReceipt,
  type ReadyMemoryRevocationReason,
  type ReadyMemorySnapshot,
  type ReadyMemorySnapshotEntry,
  type ReadyMemorySource,
} from './ready-memory-types'

type RunResult = { changes?: number }
interface PolicyRow {
  use_memories: number
  generate_memories: number
  state_revision: number
  revocation_revision: number
  last_revocation_reason: ReadyMemoryRevocationReason | null
  updated_at: string
}
interface ConversationPolicyRow {
  contribute_to_memories: number
  state_revision: number
  updated_at: string
}
interface EntryRow {
  entry_id: string
  category: ReadyMemoryCategory
  content: string
  content_digest: string
  origin: 'manual' | 'consolidated'
  confidence: number
  pinned: number
  status: ReadyMemoryEntryStatus
  superseded_by_entry_id: string | null
  expires_at: string | null
  source_refs_json: string
  state_revision: number
  revocation_revision: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}
interface SourceRow {
  source_id: string
  conversation_id: string
  source_digest: string
  source_updated_at: string
  evidence_refs_json: string
  summary_text: string | null
  summary_digest: string | null
  sealed_at: string | null
  created_at: string
}
interface JobRow {
  job_id: string
  job_kind: 'extraction' | 'consolidation'
  source_id: string | null
  input_digest: string
  status: ReadyMemoryJobStatus
  attempt_count: number
  lease_owner: string | null
  lease_token: string | null
  lease_expires_at: string | null
  provider_request_id: string | null
  submitted_at: string | null
  submission_receipt_json: string | null
  submission_receipt_digest: string | null
  terminal_at: string | null
  result_receipt_json: string | null
  result_receipt_digest: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}
export type ReadyMemoryRepositoryErrorCode =
  | 'invalid_argument'
  | 'entry_not_found'
  | 'entry_not_active'
  | 'entry_pinned'
  | 'source_not_found'
  | 'source_already_sealed'
  | 'job_not_found'
  | 'job_transition_invalid'
  | 'job_lease_invalid'
  | 'turn_binding_not_found'
  | 'turn_snapshot_conflict'
  | 'turn_receipt_conflict'
  | 'snapshot_invalid'
export class ReadyMemoryRepositoryError extends Error {
  constructor(readonly code: ReadyMemoryRepositoryErrorCode, message: string = code) {
    super(message)
    this.name = 'ReadyMemoryRepositoryError'
  }
}
function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new ReadyMemoryRepositoryError('invalid_argument')
      result[key] = canonicalValue(item)
    }
    return result
  }
  throw new ReadyMemoryRepositoryError('invalid_argument')
}
function canonicalReadyMemoryJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}
function parseArray(raw: string): unknown[] {
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new ReadyMemoryRepositoryError('invalid_argument')
  return value
}
function parseStringArray(raw: string): string[] {
  const value = parseArray(raw)
  if (!value.every((item) => typeof item === 'string')) {
    throw new ReadyMemoryRepositoryError('invalid_argument')
  }
  return value as string[]
}
function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReadyMemoryRepositoryError('invalid_argument')
  }
  return value as Record<string, unknown>
}
function requiredText(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new ReadyMemoryRepositoryError('invalid_argument')
  return normalized
}
function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new ReadyMemoryRepositoryError('invalid_argument')
}
function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new ReadyMemoryRepositoryError('invalid_argument')
  }
}
function sortedUnique(values: string[]): string[] {
  const normalized = values.map(requiredText)
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right, 'en'))
}
function charLength(value: string): number {
  return Array.from(value).length
}
function truncateChars(value: string, limit: number): string {
  if (limit <= 0) return ''
  const chars = Array.from(value)
  if (chars.length <= limit) return value
  if (limit === 1) return '…'
  return `${chars.slice(0, limit - 1).join('')}…`
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function mapPolicy(row: PolicyRow): ReadyMemoryGlobalPolicy {
  return {
    useMemories: row.use_memories === 1,
    generateMemories: row.generate_memories === 1,
    stateRevision: row.state_revision,
    revocationRevision: row.revocation_revision,
    lastRevocationReason: row.last_revocation_reason,
    updatedAt: row.updated_at,
  }
}
function mapEntry(row: EntryRow): ReadyMemoryEntry {
  return {
    entryId: row.entry_id,
    category: row.category,
    content: row.content,
    contentDigest: row.content_digest,
    origin: row.origin,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    status: row.status,
    supersededByEntryId: row.superseded_by_entry_id,
    expiresAt: row.expires_at,
    sourceRefs: parseStringArray(row.source_refs_json),
    stateRevision: row.state_revision,
    revocationRevision: row.revocation_revision,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
function mapSource(row: SourceRow): ReadyMemorySource {
  return {
    sourceId: row.source_id,
    conversationId: row.conversation_id,
    sourceDigest: row.source_digest,
    sourceUpdatedAt: row.source_updated_at,
    evidenceRefs: parseArray(row.evidence_refs_json),
    summaryText: row.summary_text,
    summaryDigest: row.summary_digest,
    sealedAt: row.sealed_at,
    createdAt: row.created_at,
  }
}
function mapJob(row: JobRow): ReadyMemoryJob {
  return {
    jobId: row.job_id,
    jobKind: row.job_kind,
    sourceId: row.source_id,
    inputDigest: row.input_digest,
    status: row.status,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    providerRequestId: row.provider_request_id,
    submittedAt: row.submitted_at,
    submissionReceipt: parseObject(row.submission_receipt_json),
    submissionReceiptDigest: row.submission_receipt_digest,
    terminalAt: row.terminal_at,
    resultReceipt: parseObject(row.result_receipt_json),
    resultReceiptDigest: row.result_receipt_digest,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export class ReadyMemoryRepository {
  constructor(private readonly db: DatabaseConnection) {}
  private atomic<T>(operation: () => T): T {
    if (this.db.inTransaction) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private readGlobalPolicyRow(): PolicyRow {
    const row = this.db.prepare(`
      SELECT use_memories, generate_memories, state_revision, revocation_revision,
             last_revocation_reason, updated_at
      FROM ready_memory_policies WHERE policy_key = 'global'
    `).get<PolicyRow>()
    if (!row) throw new ReadyMemoryRepositoryError('invalid_argument', 'global memory policy missing')
    return row
  }

  private bumpGlobalState(
    updatedAt: string,
    revocationReason: ReadyMemoryRevocationReason | null,
  ): ReadyMemoryGlobalPolicy {
    assertTimestamp(updatedAt)
    this.db.prepare(`
      UPDATE ready_memory_policies
      SET state_revision = state_revision + 1,
          revocation_revision = revocation_revision + ?,
          last_revocation_reason = CASE WHEN ? IS NULL
            THEN last_revocation_reason ELSE ? END,
          updated_at = ?
      WHERE policy_key = 'global'
    `).run(revocationReason ? 1 : 0, revocationReason, revocationReason, updatedAt)
    return mapPolicy(this.readGlobalPolicyRow())
  }
  getGlobalPolicy(): ReadyMemoryGlobalPolicy {
    return mapPolicy(this.readGlobalPolicyRow())
  }

  setGlobalPolicy(input: {
    useMemories?: boolean
    generateMemories?: boolean
    updatedAt: string
  }): ReadyMemoryGlobalPolicy {
    assertTimestamp(input.updatedAt)
    return this.atomic(() => {
      const current = this.getGlobalPolicy()
      const nextUse = input.useMemories ?? current.useMemories
      const nextGenerate = input.generateMemories ?? current.generateMemories
      if (nextUse === current.useMemories && nextGenerate === current.generateMemories) return current
      const revoked = (current.useMemories && !nextUse) || (current.generateMemories && !nextGenerate)
      const reason = current.useMemories && !nextUse ? 'use_off'
        : current.generateMemories && !nextGenerate ? 'generate_off' : null
      this.db.prepare(`
        UPDATE ready_memory_policies
        SET use_memories = ?, generate_memories = ?,
            state_revision = state_revision + 1,
            revocation_revision = revocation_revision + ?,
            last_revocation_reason = COALESCE(?, last_revocation_reason),
            updated_at = ?
        WHERE policy_key = 'global'
      `).run(nextUse ? 1 : 0, nextGenerate ? 1 : 0, revoked ? 1 : 0, reason, input.updatedAt)
      return this.getGlobalPolicy()
    })
  }
  getConversationPolicy(conversationId: string): ReadyMemoryConversationPolicy {
    const normalizedId = requiredText(conversationId)
    const row = this.db.prepare(`
      SELECT contribute_to_memories, state_revision, updated_at
      FROM ready_memory_policies
      WHERE policy_key = ? AND scope_kind = 'conversation'
    `).get<ConversationPolicyRow>(`conversation:${normalizedId}`)
    if (!row) {
      return {
        conversationId: normalizedId,
        contributeToMemories: false,
        stateRevision: 0,
        updatedAt: null,
      }
    }
    return {
      conversationId: normalizedId,
      contributeToMemories: row.contribute_to_memories === 1,
      stateRevision: row.state_revision,
      updatedAt: row.updated_at,
    }
  }
  setConversationContribution(input: {
    conversationId: string
    contributeToMemories: boolean
    updatedAt: string
  }): ReadyMemoryConversationPolicy {
    const conversationId = requiredText(input.conversationId)
    assertTimestamp(input.updatedAt)
    return this.atomic(() => {
      const current = this.getConversationPolicy(conversationId)
      if (current.stateRevision > 0 && current.contributeToMemories === input.contributeToMemories) {
        return current
      }
      if (current.stateRevision === 0) {
        this.db.prepare(`
          INSERT INTO ready_memory_policies (
            policy_key, scope_kind, conversation_id, use_memories, generate_memories,
            contribute_to_memories, state_revision, revocation_revision,
            last_revocation_reason, updated_at
          ) VALUES (?, 'conversation', ?, NULL, NULL, ?, 1, 0, NULL, ?)
        `).run(`conversation:${conversationId}`, conversationId,
          input.contributeToMemories ? 1 : 0, input.updatedAt)
      } else {
        this.db.prepare(`
          UPDATE ready_memory_policies
          SET contribute_to_memories = ?, state_revision = state_revision + 1, updated_at = ?
          WHERE policy_key = ?
        `).run(input.contributeToMemories ? 1 : 0, input.updatedAt,
          `conversation:${conversationId}`)
      }
      return this.getConversationPolicy(conversationId)
    })
  }
  addManualMemory(input: {
    entryId: string
    category: ReadyMemoryCategory
    content: string
    pinned?: boolean
    expiresAt?: string | null
    createdAt: string
  }): ReadyMemoryEntry {
    const entryId = requiredText(input.entryId)
    const content = requiredText(input.content)
    assertTimestamp(input.createdAt)
    if (input.expiresAt) assertTimestamp(input.expiresAt)
    if (input.pinned && input.expiresAt) throw new ReadyMemoryRepositoryError('invalid_argument')
    return this.atomic(() => {
      const policy = this.bumpGlobalState(input.createdAt, null)
      this.db.prepare(`
        INSERT INTO ready_memory_entries (
          entry_id, category, content, content_digest, origin, confidence, pinned,
          status, superseded_by_entry_id, expires_at, source_refs_json,
          state_revision, revocation_revision, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'manual', 1.0, ?, 'active', NULL, ?, '[]', ?, ?, NULL, ?, ?)
      `).run(entryId, input.category, content, sha256(content), input.pinned ? 1 : 0,
        input.expiresAt ?? null, policy.stateRevision, policy.revocationRevision,
        input.createdAt, input.createdAt)
      return this.requireEntry(entryId)
    })
  }

  addConsolidatedMemory(input: {
    entryId: string
    category: ReadyMemoryCategory
    content: string
    confidence: number
    sourceRefs: string[]
    expiresAt: string
    createdAt: string
  }): ReadyMemoryEntry {
    const entryId = requiredText(input.entryId)
    const content = requiredText(input.content)
    const sourceRefs = sortedUnique(input.sourceRefs)
    if (sourceRefs.length === 0 || sourceRefs.length > 32
      || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    assertTimestamp(input.expiresAt)
    assertTimestamp(input.createdAt)
    return this.atomic(() => {
      for (const sourceId of sourceRefs) {
        if (!this.db.prepare('SELECT 1 FROM ready_memory_sources WHERE source_id = ?').get(sourceId)) {
          throw new ReadyMemoryRepositoryError('source_not_found')
        }
      }
      const policy = this.bumpGlobalState(input.createdAt, null)
      this.db.prepare(`
        INSERT INTO ready_memory_entries (
          entry_id, category, content, content_digest, origin, confidence, pinned,
          status, superseded_by_entry_id, expires_at, source_refs_json,
          state_revision, revocation_revision, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'consolidated', ?, 0, 'active', NULL, ?, ?, ?, ?, NULL, ?, ?)
      `).run(entryId, input.category, content, sha256(content), input.confidence,
        input.expiresAt, canonicalReadyMemoryJson(sourceRefs), policy.stateRevision,
        policy.revocationRevision, input.createdAt, input.createdAt)
      return this.requireEntry(entryId)
    })
  }

  editMemory(input: {
    entryId: string
    category?: ReadyMemoryCategory
    content?: string
    expiresAt?: string | null
    updatedAt: string
  }): ReadyMemoryEntry {
    assertTimestamp(input.updatedAt)
    return this.atomic(() => {
      const current = this.requireEntry(input.entryId)
      if (current.status !== 'active') throw new ReadyMemoryRepositoryError('entry_not_active')
      const category = input.category ?? current.category
      const content = input.content === undefined ? current.content : requiredText(input.content)
      const expiresAt = input.expiresAt === undefined ? current.expiresAt : input.expiresAt
      if (expiresAt) assertTimestamp(expiresAt)
      if (current.pinned && expiresAt) throw new ReadyMemoryRepositoryError('entry_pinned')
      if (category === current.category && content === current.content && expiresAt === current.expiresAt) {
        return current
      }
      const policy = this.bumpGlobalState(input.updatedAt, 'edit')
      this.db.prepare(`
        UPDATE ready_memory_entries
        SET category = ?, content = ?, content_digest = ?, expires_at = ?, origin = 'manual', confidence = 1.0,
            state_revision = ?, revocation_revision = ?, updated_at = ?
        WHERE entry_id = ? AND status = 'active'
      `).run(category, content, sha256(content), expiresAt, policy.stateRevision,
        policy.revocationRevision, input.updatedAt, current.entryId)
      return this.requireEntry(current.entryId)
    })
  }

  setMemoryPinned(entryId: string, pinned: boolean, updatedAt: string): ReadyMemoryEntry {
    assertTimestamp(updatedAt)
    return this.atomic(() => {
      const current = this.requireEntry(entryId)
      if (current.status !== 'active') throw new ReadyMemoryRepositoryError('entry_not_active')
      if (pinned && current.expiresAt) throw new ReadyMemoryRepositoryError('entry_pinned')
      if (current.pinned === pinned) return current
      const policy = this.bumpGlobalState(updatedAt, null)
      this.db.prepare(`
        UPDATE ready_memory_entries
        SET pinned = ?, state_revision = ?, revocation_revision = ?, updated_at = ?
        WHERE entry_id = ? AND status = 'active'
      `).run(pinned ? 1 : 0, policy.stateRevision, policy.revocationRevision,
        updatedAt, current.entryId)
      return this.requireEntry(current.entryId)
    })
  }

  deleteMemory(entryId: string, deletedAt: string): boolean {
    assertTimestamp(deletedAt)
    return this.atomic(() => {
      const existing = this.getEntry(entryId)
      if (!existing) return false
      this.bumpGlobalState(deletedAt, 'delete')
      this.db.prepare('DELETE FROM ready_memory_entries WHERE entry_id = ?').run(existing.entryId)
      return true
    })
  }

  resetMemories(resetAt: string): void {
    assertTimestamp(resetAt)
    this.atomic(() => {
      this.bumpGlobalState(resetAt, 'reset')
      this.db.exec(`
        DELETE FROM ready_memory_entries;
        DELETE FROM ready_memory_jobs WHERE status NOT IN ('submitted', 'unknown');
        DELETE FROM ready_memory_sources WHERE source_id NOT IN (
          SELECT source_id FROM ready_memory_jobs WHERE source_id IS NOT NULL
        );
      `)
    })
  }

  supersedeMemory(entryId: string, supersededByEntryId: string, updatedAt: string): ReadyMemoryEntry {
    assertTimestamp(updatedAt)
    return this.atomic(() => {
      const current = this.requireEntry(entryId)
      const replacement = this.requireEntry(supersededByEntryId)
      if (current.status !== 'active' || replacement.status !== 'active') {
        throw new ReadyMemoryRepositoryError('entry_not_active')
      }
      if (current.pinned) throw new ReadyMemoryRepositoryError('entry_pinned')
      const policy = this.bumpGlobalState(updatedAt, 'supersede')
      this.db.prepare(`
        UPDATE ready_memory_entries
        SET status = 'superseded', superseded_by_entry_id = ?,
            state_revision = ?, revocation_revision = ?, updated_at = ?
        WHERE entry_id = ? AND status = 'active'
      `).run(replacement.entryId, policy.stateRevision, policy.revocationRevision,
        updatedAt, current.entryId)
      return this.requireEntry(current.entryId)
    })
  }

  expireMemories(now: string): number {
    assertTimestamp(now)
    return this.atomic(() => {
      const due = this.db.prepare(`
        SELECT COUNT(*) AS count FROM ready_memory_entries
        WHERE status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
      `).get<{ count: number }>(now)?.count ?? 0
      if (due === 0) return 0
      const policy = this.bumpGlobalState(now, 'expire')
      const result = this.db.prepare(`
        UPDATE ready_memory_entries
        SET status = 'expired', state_revision = ?, revocation_revision = ?, updated_at = ?
        WHERE status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(policy.stateRevision, policy.revocationRevision, now, now)
      return changes(result)
    })
  }

  getEntry(entryId: string): ReadyMemoryEntry | null {
    const row = this.db.prepare(
      'SELECT * FROM ready_memory_entries WHERE entry_id = ?',
    ).get<EntryRow>(requiredText(entryId))
    return row ? mapEntry(row) : null
  }
  private requireEntry(entryId: string): ReadyMemoryEntry {
    const entry = this.getEntry(entryId)
    if (!entry) throw new ReadyMemoryRepositoryError('entry_not_found')
    return entry
  }
  listEntries(statuses: ReadyMemoryEntryStatus[] = ['active', 'superseded', 'expired']): ReadyMemoryEntry[] {
    if (statuses.length === 0) return []
    const allowed = new Set<ReadyMemoryEntryStatus>(['active', 'superseded', 'expired'])
    if (!statuses.every((status) => allowed.has(status))) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    const placeholders = statuses.map(() => '?').join(', ')
    return this.db.prepare(`
      SELECT * FROM ready_memory_entries WHERE status IN (${placeholders})
      ORDER BY pinned DESC,
        CASE origin WHEN 'manual' THEN 0 ELSE 1 END,
        updated_at DESC, entry_id ASC
    `).all<EntryRow>(...statuses).map(mapEntry)
  }
  buildSnapshot(now: string): ReadyMemorySnapshot {
    assertTimestamp(now)
    const policy = this.getGlobalPolicy()
    const rows = policy.useMemories
      ? this.db.prepare(`
          SELECT * FROM ready_memory_entries
          WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY pinned DESC,
            CASE origin WHEN 'manual' THEN 0 ELSE 1 END,
            updated_at DESC, entry_id ASC
          LIMIT ?
        `).all<EntryRow>(now, READY_MEMORY_SNAPSHOT_ENTRY_LIMIT + 1)
      : []
    const selected: ReadyMemoryEntry[] = []
    let snapshotContentChars = 0
    for (const row of rows.slice(0, READY_MEMORY_SNAPSHOT_ENTRY_LIMIT)) {
      const entry = mapEntry(row)
      const contentChars = charLength(entry.content)
      if (snapshotContentChars + contentChars > READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS) break
      selected.push(entry)
      snapshotContentChars += contentChars
    }
    const entries: ReadyMemorySnapshotEntry[] = selected.map((entry) => ({
      entryId: entry.entryId,
      category: entry.category,
      content: entry.content,
      contentDigest: entry.contentDigest,
      origin: entry.origin,
      pinned: entry.pinned,
      sourceRefs: [...entry.sourceRefs],
      stateRevision: entry.stateRevision,
    }))
    const sourceRefs = sortedUnique(selected.flatMap((entry) => entry.sourceRefs))
    const summaryParts: string[] = []
    const summaryEntryIds: string[] = []
    let remaining = READY_MEMORY_SUMMARY_BUDGET_CHARS
    let contentTruncated = false
    for (const entry of selected) {
      const prefix = entry.pinned ? '[fixed]' : entry.origin === 'manual' ? '[manual]' : '[memory]'
      const separator = summaryParts.length === 0 ? '' : '\n'
      const line = `${prefix} ${entry.content}`
      const available = remaining - charLength(separator)
      if (available <= 0) {
        contentTruncated = true
        break
      }
      const rendered = truncateChars(line, available)
      summaryParts.push(`${separator}${rendered}`)
      summaryEntryIds.push(entry.entryId)
      remaining -= charLength(separator) + charLength(rendered)
      if (rendered !== line) {
        contentTruncated = true
        break
      }
    }
    const summary = summaryParts.join('')
    const core = {
      contract: READY_MEMORY_SNAPSHOT_CONTRACT as typeof READY_MEMORY_SNAPSHOT_CONTRACT,
      enabled: policy.useMemories,
      stateRevision: policy.stateRevision,
      revocationRevision: policy.revocationRevision,
      lastRevocationReason: policy.lastRevocationReason,
      frozenAt: now,
      summaryBudgetChars: READY_MEMORY_SUMMARY_BUDGET_CHARS as typeof READY_MEMORY_SUMMARY_BUDGET_CHARS,
      summaryChars: charLength(summary),
      summary,
      summaryEntryIds,
      entries,
      sourceRefs,
      truncated: rows.length > selected.length || contentTruncated,
    }
    return deepFreeze({ ...core, snapshotDigest: sha256(canonicalReadyMemoryJson(core)) })
  }
  searchSnapshot(
    snapshot: ReadyMemorySnapshot,
    query: string,
    limit = 20,
  ): ReadyMemorySnapshotEntry[] {
    this.assertSnapshot(snapshot)
    const normalizedQuery = requiredText(query).toLocaleLowerCase('en')
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    if (!snapshot.enabled) return []
    return snapshot.entries
      .filter((entry) => entry.content.toLocaleLowerCase('en').includes(normalizedQuery))
      .slice(0, safeLimit)
  }
  createReadReceipt(
    snapshot: ReadyMemorySnapshot,
    readEntryIds: string[],
    readAt: string,
  ): ReadyMemoryReadReceipt {
    this.assertSnapshot(snapshot)
    assertTimestamp(readAt)
    const allowed = new Set(snapshot.entries.map((entry) => entry.entryId))
    const ordered = sortedUnique(readEntryIds)
    if (!ordered.every((entryId) => allowed.has(entryId))) {
      throw new ReadyMemoryRepositoryError('snapshot_invalid')
    }
    const core = {
      contract: READY_MEMORY_READ_RECEIPT_CONTRACT,
      snapshotDigest: snapshot.snapshotDigest,
      stateRevision: snapshot.stateRevision,
      revocationRevision: snapshot.revocationRevision,
      readEntryIds: ordered,
      readAt,
    }
    return deepFreeze({ ...core, receiptDigest: sha256(canonicalReadyMemoryJson(core)) })
  }
  private assertSnapshot(snapshot: ReadyMemorySnapshot): void {
    const { snapshotDigest, ...core } = snapshot
    if (snapshot.contract !== READY_MEMORY_SNAPSHOT_CONTRACT
      || snapshot.summaryBudgetChars !== READY_MEMORY_SUMMARY_BUDGET_CHARS
      || charLength(snapshot.summary) > READY_MEMORY_SUMMARY_BUDGET_CHARS
      || snapshot.entries.reduce((sum, entry) => sum + charLength(entry.content), 0)
        > READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS
      || sha256(canonicalReadyMemoryJson(core)) !== snapshotDigest) {
      throw new ReadyMemoryRepositoryError('snapshot_invalid')
    }
  }

  freezeSnapshotForTurn(readyRunId: string, snapshot: ReadyMemorySnapshot, updatedAt: string): boolean {
    const runId = requiredText(readyRunId)
    assertTimestamp(updatedAt)
    this.assertSnapshot(snapshot)
    return this.atomic(() => {
      const result = this.db.prepare(`
        UPDATE codex_turn_bindings
        SET ready_memory_snapshot_json = ?, ready_memory_snapshot_digest = ?,
            ready_memory_state_revision = ?, ready_memory_revocation_revision = ?,
            revision = revision + 1, updated_at = ?
        WHERE ready_run_id = ? AND ready_memory_snapshot_digest IS NULL
      `).run(canonicalReadyMemoryJson(snapshot), snapshot.snapshotDigest,
        snapshot.stateRevision, snapshot.revocationRevision, updatedAt, runId)
      if (changes(result) === 1) return true
      const existing = this.db.prepare(`
        SELECT ready_memory_snapshot_digest AS digest
        FROM codex_turn_bindings WHERE ready_run_id = ?
      `).get<{ digest: string | null }>(runId)
      if (!existing) throw new ReadyMemoryRepositoryError('turn_binding_not_found')
      if (existing.digest === snapshot.snapshotDigest) return false
      throw new ReadyMemoryRepositoryError('turn_snapshot_conflict')
    })
  }

  recordReadReceiptForTurn(
    readyRunId: string,
    snapshot: ReadyMemorySnapshot,
    receipt: ReadyMemoryReadReceipt,
    updatedAt: string,
  ): boolean {
    const runId = requiredText(readyRunId)
    assertTimestamp(updatedAt)
    this.assertSnapshot(snapshot)
    const { receiptDigest, ...core } = receipt
    if (receipt.contract !== READY_MEMORY_READ_RECEIPT_CONTRACT
      || snapshot.snapshotDigest !== receipt.snapshotDigest
      || sha256(canonicalReadyMemoryJson(core)) !== receiptDigest) {
      throw new ReadyMemoryRepositoryError('snapshot_invalid')
    }
    return this.atomic(() => {
      const result = this.db.prepare(`
        UPDATE codex_turn_bindings
        SET ready_memory_read_receipt_json = ?, ready_memory_read_receipt_digest = ?,
            revision = revision + 1, updated_at = ?
        WHERE ready_run_id = ?
          AND ready_memory_snapshot_digest = ?
          AND ready_memory_state_revision = ?
          AND ready_memory_revocation_revision = ?
          AND ready_memory_read_receipt_digest IS NULL
      `).run(canonicalReadyMemoryJson(receipt), receipt.receiptDigest, updatedAt, runId,
        receipt.snapshotDigest, receipt.stateRevision, receipt.revocationRevision)
      if (changes(result) === 1) {
        const ids = sortedUnique([...snapshot.summaryEntryIds, ...receipt.readEntryIds])
        if (ids.length > 0) this.db.prepare(`
          UPDATE ready_memory_entries SET last_used_at = ?
          WHERE entry_id IN (${ids.map(() => '?').join(', ')})
        `).run(updatedAt, ...ids)
        return true
      }
      const existing = this.db.prepare(`
        SELECT ready_memory_snapshot_digest AS snapshot_digest,
               ready_memory_read_receipt_digest AS receipt_digest
        FROM codex_turn_bindings WHERE ready_run_id = ?
      `).get<{ snapshot_digest: string | null; receipt_digest: string | null }>(runId)
      if (!existing) throw new ReadyMemoryRepositoryError('turn_binding_not_found')
      if (existing.snapshot_digest !== receipt.snapshotDigest) {
        throw new ReadyMemoryRepositoryError('turn_snapshot_conflict')
      }
      if (existing.receipt_digest === receipt.receiptDigest) return false
      throw new ReadyMemoryRepositoryError('turn_receipt_conflict')
    })
  }

  enqueueExtractionForSuccessfulSource(input: {
    sourceId: string
    conversationId: string
    sourceDigest: string
    sourceUpdatedAt: string
    evidenceRefs: unknown[]
    jobId: string
    createdAt: string
  }): ReadyMemoryEnqueueResult {
    const sourceId = requiredText(input.sourceId)
    const conversationId = requiredText(input.conversationId)
    const jobId = requiredText(input.jobId)
    assertDigest(input.sourceDigest)
    assertTimestamp(input.sourceUpdatedAt)
    assertTimestamp(input.createdAt)
    const evidenceRefsJson = canonicalReadyMemoryJson(input.evidenceRefs)
    if (input.evidenceRefs.length > 128 || evidenceRefsJson.length > 32768) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    return this.atomic(() => {
      if (!this.getGlobalPolicy().generateMemories) {
        return { enqueued: false, reason: 'generation_disabled', source: null, job: null }
      }
      this.db.prepare(`
        INSERT INTO ready_memory_sources (
          source_id, conversation_id, source_digest, source_updated_at,
          evidence_refs_json, summary_text, summary_digest, sealed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT(source_digest) DO NOTHING
      `).run(sourceId, conversationId, input.sourceDigest, input.sourceUpdatedAt,
        evidenceRefsJson, input.createdAt)
      const sourceRow = this.db.prepare(
        'SELECT * FROM ready_memory_sources WHERE source_digest = ?',
      ).get<SourceRow>(input.sourceDigest)
      if (!sourceRow) throw new ReadyMemoryRepositoryError('source_not_found')
      const insert = this.db.prepare(`
        INSERT INTO ready_memory_jobs (
          job_id, job_kind, source_id, input_digest, status, attempt_count,
          lease_owner, lease_token, lease_expires_at, provider_request_id,
          submitted_at, submission_receipt_json, submission_receipt_digest,
          terminal_at, result_receipt_json, result_receipt_digest,
          last_error, created_at, updated_at
        ) VALUES (?, 'extraction', ?, ?, 'pending', 0,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(job_kind, input_digest) DO NOTHING
      `).run(jobId, sourceRow.source_id, input.sourceDigest, input.createdAt, input.createdAt)
      const jobRow = this.db.prepare(`
        SELECT * FROM ready_memory_jobs
        WHERE job_kind = 'extraction' AND input_digest = ?
      `).get<JobRow>(input.sourceDigest)
      if (!jobRow) throw new ReadyMemoryRepositoryError('job_not_found')
      return {
        enqueued: changes(insert) === 1,
        reason: changes(insert) === 1 ? 'enqueued' : 'duplicate',
        source: mapSource(sourceRow),
        job: mapJob(jobRow),
      }
    })
  }

  getJob(jobId: string): ReadyMemoryJob | null {
    const row = this.db.prepare(
      'SELECT * FROM ready_memory_jobs WHERE job_id = ?',
    ).get<JobRow>(requiredText(jobId))
    return row ? mapJob(row) : null
  }

  recoverExpiredLeases(now: string): number {
    assertTimestamp(now)
    return this.atomic(() => changes(this.db.prepare(`
      UPDATE ready_memory_jobs
      SET status = 'pending', lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE status = 'leased' AND lease_expires_at <= ?
    `).run(now, now)))
  }

  leaseNextJob(input: {
    leaseOwner: string
    leaseToken: string
    leasedAt: string
    leaseExpiresAt: string
  }): ReadyMemoryJob | null {
    const leaseOwner = requiredText(input.leaseOwner)
    const leaseToken = requiredText(input.leaseToken)
    assertTimestamp(input.leasedAt)
    assertTimestamp(input.leaseExpiresAt)
    if (input.leaseExpiresAt <= input.leasedAt) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    return this.atomic(() => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM ready_memory_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC, job_id ASC LIMIT 1
      `).get<{ job_id: string }>()
      if (!candidate) return null
      const result = this.db.prepare(`
        UPDATE ready_memory_jobs
        SET status = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'pending'
      `).run(leaseOwner, leaseToken, input.leaseExpiresAt, input.leasedAt, candidate.job_id)
      if (changes(result) !== 1) return null
      return this.getJob(candidate.job_id)
    })
  }

  markJobSubmitted(input: {
    jobId: string
    leaseToken: string
    providerRequestId: string
    receipt: Record<string, unknown>
    submittedAt: string
    expectedRevocationRevision: number
  }): ReadyMemoryJob {
    const jobId = requiredText(input.jobId)
    const leaseToken = requiredText(input.leaseToken)
    const providerRequestId = requiredText(input.providerRequestId)
    assertTimestamp(input.submittedAt)
    const receiptJson = canonicalReadyMemoryJson(input.receipt)
    const receiptDigest = sha256(receiptJson)
    return this.atomic(() => {
      const policy = this.getGlobalPolicy()
      if (!policy.generateMemories || policy.revocationRevision !== input.expectedRevocationRevision) {
        throw new ReadyMemoryRepositoryError('job_transition_invalid') }
      const result = this.db.prepare(`
        UPDATE ready_memory_jobs
        SET status = 'submitted', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, provider_request_id = ?, submitted_at = ?,
            submission_receipt_json = ?, submission_receipt_digest = ?, updated_at = ?
        WHERE job_id = ? AND status = 'leased' AND lease_token = ?
          AND lease_expires_at > ?
      `).run(providerRequestId, input.submittedAt, receiptJson, receiptDigest, input.submittedAt,
        jobId, leaseToken, input.submittedAt)
      if (changes(result) !== 1) throw new ReadyMemoryRepositoryError('job_lease_invalid')
      return this.requireJob(jobId)
    })
  }

  recordJobTerminal(input: {
    jobId: string
    providerRequestId: string
    status: 'succeeded' | 'no_output' | 'failed' | 'unknown'
    receipt: Record<string, unknown>
    error?: string | null
    terminalAt: string
  }): ReadyMemoryJob {
    const jobId = requiredText(input.jobId)
    const providerRequestId = requiredText(input.providerRequestId)
    assertTimestamp(input.terminalAt)
    if (input.status === 'failed' && !input.error?.trim()) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    if (input.status !== 'failed' && input.error) {
      throw new ReadyMemoryRepositoryError('invalid_argument')
    }
    return this.atomic(() => {
      const current = this.requireJob(jobId)
      if (current.providerRequestId !== providerRequestId
        || !['submitted', 'unknown'].includes(current.status)) {
        if (current.status === input.status) {
          const sameReceipt = canonicalReadyMemoryJson(current.resultReceipt)
            === canonicalReadyMemoryJson(input.receipt)
          if (sameReceipt && current.providerRequestId === providerRequestId) return current
        }
        throw new ReadyMemoryRepositoryError('job_transition_invalid')
      }
      if (current.status === 'unknown' && input.status === 'unknown') return current
      const receipt = current.status === 'unknown'
        ? { unknownReceipt: current.resultReceipt, recoveryReceipt: input.receipt }
        : input.receipt
      const receiptJson = canonicalReadyMemoryJson(receipt)
      const receiptDigest = sha256(receiptJson)
      const result = this.db.prepare(`
        UPDATE ready_memory_jobs
        SET status = ?, terminal_at = ?, result_receipt_json = ?,
            result_receipt_digest = ?, last_error = ?, updated_at = ?
        WHERE job_id = ? AND provider_request_id = ? AND status = ?
      `).run(input.status, input.terminalAt, receiptJson, receiptDigest,
        input.status === 'failed' ? input.error!.trim() : null,
        input.terminalAt, jobId, providerRequestId, current.status)
      if (changes(result) !== 1) throw new ReadyMemoryRepositoryError('job_transition_invalid')
      return this.requireJob(jobId)
    })
  }

  sealSourceSummary(input: {
    sourceId: string
    jobId: string
    summaryText: string
    sealedAt: string
  }): ReadyMemorySource {
    const sourceId = requiredText(input.sourceId)
    const jobId = requiredText(input.jobId)
    const summaryText = requiredText(input.summaryText)
    assertTimestamp(input.sealedAt)
    return this.atomic(() => {
      const job = this.requireJob(jobId)
      if (job.status !== 'succeeded' || job.sourceId !== sourceId) {
        throw new ReadyMemoryRepositoryError('job_transition_invalid')
      }
      const digest = sha256(summaryText)
      const result = this.db.prepare(`
        UPDATE ready_memory_sources
        SET summary_text = ?, summary_digest = ?, sealed_at = ?
        WHERE source_id = ? AND summary_digest IS NULL
      `).run(summaryText, digest, input.sealedAt, sourceId)
      const source = this.db.prepare(
        'SELECT * FROM ready_memory_sources WHERE source_id = ?',
      ).get<SourceRow>(sourceId)
      if (!source) throw new ReadyMemoryRepositoryError('source_not_found')
      if (changes(result) === 0 && source.summary_digest !== digest) {
        throw new ReadyMemoryRepositoryError('source_already_sealed')
      }
      return mapSource(source)
    })
  }

  private requireJob(jobId: string): ReadyMemoryJob {
    const job = this.getJob(jobId)
    if (!job) throw new ReadyMemoryRepositoryError('job_not_found')
    return job
  }
}
