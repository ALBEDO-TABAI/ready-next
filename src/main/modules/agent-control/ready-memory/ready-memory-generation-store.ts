import { createHash } from 'node:crypto'
import type { DatabaseConnection } from '../../database'
import { canonicalReadyMemoryJson } from './ready-memory-contract'
import { ReadyMemoryRepositoryError } from './ready-memory-repository'
import type { ReadyMemoryJob } from './ready-memory-types'
import type {
  ReadyMemoryConsolidationInput,
  ReadyMemoryEvidenceRef,
  ReadyMemoryExtractionOutput,
} from './ready-memory-generation-types'

interface SourceGenerationRow {
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

interface JobPayloadRow {
  job_id: string
  input_payload_json: string | null
  result_receipt_json: string | null
}

export interface ReadyMemoryGenerationSourceRecord {
  sourceId: string
  conversationId: string
  sourceDigest: string
  sourceUpdatedAt: string
  evidenceRefs: ReadyMemoryEvidenceRef[]
  summaryText: string | null
  summaryDigest: string | null
  sealedAt: string | null
  createdAt: string
}

function requiredText(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new ReadyMemoryRepositoryError('invalid_argument')
  return normalized
}

export function readyMemoryGenerationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalReadyMemoryJson(value)).digest('hex')
}

function parseEvidenceRefs(raw: string): ReadyMemoryEvidenceRef[] {
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new ReadyMemoryRepositoryError('invalid_argument')
  return value as ReadyMemoryEvidenceRef[]
}

function mapSource(row: SourceGenerationRow): ReadyMemoryGenerationSourceRecord {
  return {
    sourceId: row.source_id,
    conversationId: row.conversation_id,
    sourceDigest: row.source_digest,
    sourceUpdatedAt: row.source_updated_at,
    evidenceRefs: parseEvidenceRefs(row.evidence_refs_json),
    summaryText: row.summary_text,
    summaryDigest: row.summary_digest,
    sealedAt: row.sealed_at,
    createdAt: row.created_at,
  }
}

export class ReadyMemoryGenerationStore {
  constructor(private readonly db: DatabaseConnection) {}

  atomic<T>(operation: () => T): T {
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

  getSource(sourceId: string): ReadyMemoryGenerationSourceRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM ready_memory_sources WHERE source_id = ?',
    ).get<SourceGenerationRow>(requiredText(sourceId))
    return row ? mapSource(row) : null
  }

  listSealedSources(): ReadyMemoryGenerationSourceRecord[] {
    return this.db.prepare(`
      SELECT * FROM ready_memory_sources
      WHERE summary_digest IS NOT NULL AND sealed_at IS NOT NULL
      ORDER BY sealed_at ASC, source_id ASC
    `).all<SourceGenerationRow>().map(mapSource)
  }

  listAttemptedConsolidationSourceDigests(): Set<string> {
    const rows = this.db.prepare(`
      SELECT job_id, input_payload_json, result_receipt_json FROM ready_memory_jobs
      WHERE job_kind = 'consolidation' AND input_payload_json IS NOT NULL
    `).all<JobPayloadRow>()
    const result = new Set<string>()
    for (const row of rows) {
      if (row.result_receipt_json
        && row.result_receipt_json.includes('"effectsDiscarded":"corpus_changed"')) continue
      const payload = JSON.parse(row.input_payload_json || 'null') as Partial<ReadyMemoryConsolidationInput> | null
      if (!payload || !Array.isArray(payload.sources)) {
        throw new ReadyMemoryRepositoryError('invalid_argument')
      }
      for (const source of payload.sources) {
        if (typeof source?.summaryDigest !== 'string') {
          throw new ReadyMemoryRepositoryError('invalid_argument')
        }
        result.add(source.summaryDigest)
      }
    }
    return result
  }

  createConsolidationJob(input: {
    jobId: string
    payload: ReadyMemoryConsolidationInput
    inputDigest: string
    createdAt: string
  }): ReadyMemoryJob | null {
    const payloadJson = canonicalReadyMemoryJson(input.payload)
    return this.atomic(() => {
      this.db.prepare(`
        INSERT INTO ready_memory_jobs (
          job_id, job_kind, source_id, input_digest, input_payload_json,
          status, attempt_count, lease_owner, lease_token, lease_expires_at,
          provider_request_id, submitted_at, submission_receipt_json,
          submission_receipt_digest, terminal_at, result_receipt_json,
          result_receipt_digest, effects_applied_at, last_error, created_at, updated_at
        ) VALUES (?, 'consolidation', NULL, ?, ?, 'pending', 0,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(job_kind, input_digest) DO NOTHING
      `).run(requiredText(input.jobId), input.inputDigest, payloadJson, input.createdAt, input.createdAt)
      return this.getJobByInput('consolidation', input.inputDigest)
    })
  }

  getJobInputPayload(jobId: string): ReadyMemoryConsolidationInput | null {
    const row = this.db.prepare(`
      SELECT input_payload_json FROM ready_memory_jobs WHERE job_id = ?
    `).get<{ input_payload_json: string | null }>(requiredText(jobId))
    if (!row?.input_payload_json) return null
    return JSON.parse(row.input_payload_json) as ReadyMemoryConsolidationInput
  }

  findSucceededUnappliedJob(): ReadyMemoryJob | null {
    const row = this.db.prepare(`
      SELECT job_id FROM ready_memory_jobs
      WHERE status = 'succeeded' AND effects_applied_at IS NULL
      ORDER BY terminal_at ASC, job_id ASC LIMIT 1
    `).get<{ job_id: string }>()
    return row ? this.requireJob(row.job_id) : null
  }

  findRecoverableJob(eligibleBefore: string): ReadyMemoryJob | null {
    const row = this.db.prepare(`
      SELECT job_id FROM ready_memory_jobs
      WHERE status IN ('submitted', 'unknown') AND updated_at <= ?
      ORDER BY submitted_at ASC, job_id ASC LIMIT 1
    `).get<{ job_id: string }>(eligibleBefore)
    return row ? this.requireJob(row.job_id) : null
  }

  deferRecovery(input: {
    jobId: string
    providerRequestId: string
    receipt: Record<string, unknown>
    checkedAt: string
  }): ReadyMemoryJob {
    const receiptJson = canonicalReadyMemoryJson(input.receipt)
    const receiptDigest = readyMemoryGenerationDigest(input.receipt)
    const result = this.db.prepare(`
      UPDATE ready_memory_jobs
      SET status = 'unknown', terminal_at = COALESCE(terminal_at, ?),
          result_receipt_json = ?, result_receipt_digest = ?, updated_at = ?
      WHERE job_id = ? AND provider_request_id = ? AND status IN ('submitted', 'unknown')
    `).run(input.checkedAt, receiptJson, receiptDigest, input.checkedAt,
      requiredText(input.jobId), requiredText(input.providerRequestId)) as { changes?: number }
    if (Number(result.changes || 0) !== 1) {
      throw new ReadyMemoryRepositoryError('job_transition_invalid')
    }
    return this.requireJob(input.jobId)
  }

  releaseUnsubmittedLease(input: {
    jobId: string
    leaseToken: string
    releasedAt: string
  }): void {
    const result = this.db.prepare(`
      UPDATE ready_memory_jobs
      SET status = 'pending', lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'leased' AND lease_token = ?
    `).run(input.releasedAt, requiredText(input.jobId), requiredText(input.leaseToken)) as { changes?: number }
    if (Number(result.changes || 0) !== 1) {
      throw new ReadyMemoryRepositoryError('job_transition_invalid')
    }
  }

  markEffectsApplied(jobId: string, appliedAt: string): void {
    const result = this.db.prepare(`
      UPDATE ready_memory_jobs
      SET effects_applied_at = COALESCE(effects_applied_at, ?), updated_at = ?
      WHERE job_id = ? AND status = 'succeeded'
    `).run(appliedAt, appliedAt, requiredText(jobId)) as { changes?: number }
    if (Number(result.changes || 0) !== 1) {
      throw new ReadyMemoryRepositoryError('job_transition_invalid')
    }
  }

  markNoOutputEffectsApplied(jobId: string, appliedAt: string): void {
    this.db.prepare(`
      UPDATE ready_memory_jobs
      SET effects_applied_at = COALESCE(effects_applied_at, ?), updated_at = ?
      WHERE job_id = ? AND status = 'no_output'
    `).run(appliedAt, appliedAt, requiredText(jobId))
  }

  discardSucceededEffects(
    jobId: string,
    appliedAt: string,
    reason: 'revoked' | 'corpus_changed',
  ): void {
    const current = this.requireJob(jobId)
    const receipt = { completedReceipt: current.resultReceipt, effectsDiscarded: reason }
    const receiptJson = canonicalReadyMemoryJson(receipt)
    const result = this.db.prepare(`
      UPDATE ready_memory_jobs
      SET status = 'no_output', result_receipt_json = ?, result_receipt_digest = ?,
          effects_applied_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'succeeded' AND effects_applied_at IS NULL
    `).run(receiptJson, readyMemoryGenerationDigest(receipt), appliedAt, appliedAt,
      requiredText(jobId)) as { changes?: number }
    if (Number(result.changes || 0) !== 1) {
      throw new ReadyMemoryRepositoryError('job_transition_invalid')
    }
  }

  parseSealedExtraction(source: ReadyMemoryGenerationSourceRecord): ReadyMemoryExtractionOutput {
    if (!source.summaryText || !source.summaryDigest || !source.sealedAt) {
      throw new ReadyMemoryRepositoryError('source_not_found')
    }
    return JSON.parse(source.summaryText) as ReadyMemoryExtractionOutput
  }

  private getJobByInput(kind: ReadyMemoryJob['jobKind'], digest: string): ReadyMemoryJob | null {
    const row = this.db.prepare(`
      SELECT job_id FROM ready_memory_jobs WHERE job_kind = ? AND input_digest = ?
    `).get<{ job_id: string }>(kind, digest)
    return row ? this.requireJob(row.job_id) : null
  }

  private requireJob(jobId: string): ReadyMemoryJob {
    const row = this.db.prepare('SELECT * FROM ready_memory_jobs WHERE job_id = ?')
      .get<Record<string, unknown>>(requiredText(jobId))
    if (!row) throw new ReadyMemoryRepositoryError('job_not_found')
    const parseObject = (raw: unknown): Record<string, unknown> | null => {
      if (typeof raw !== 'string') return null
      return JSON.parse(raw) as Record<string, unknown>
    }
    return {
      jobId: String(row.job_id),
      jobKind: row.job_kind as ReadyMemoryJob['jobKind'],
      sourceId: typeof row.source_id === 'string' ? row.source_id : null,
      inputDigest: String(row.input_digest),
      status: row.status as ReadyMemoryJob['status'],
      attemptCount: Number(row.attempt_count),
      leaseOwner: typeof row.lease_owner === 'string' ? row.lease_owner : null,
      leaseToken: typeof row.lease_token === 'string' ? row.lease_token : null,
      leaseExpiresAt: typeof row.lease_expires_at === 'string' ? row.lease_expires_at : null,
      providerRequestId: typeof row.provider_request_id === 'string' ? row.provider_request_id : null,
      submittedAt: typeof row.submitted_at === 'string' ? row.submitted_at : null,
      submissionReceipt: parseObject(row.submission_receipt_json),
      submissionReceiptDigest: typeof row.submission_receipt_digest === 'string'
        ? row.submission_receipt_digest : null,
      terminalAt: typeof row.terminal_at === 'string' ? row.terminal_at : null,
      resultReceipt: parseObject(row.result_receipt_json),
      resultReceiptDigest: typeof row.result_receipt_digest === 'string'
        ? row.result_receipt_digest : null,
      lastError: typeof row.last_error === 'string' ? row.last_error : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
