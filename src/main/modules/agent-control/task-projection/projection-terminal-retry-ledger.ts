import { createHash } from 'node:crypto'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../contracts/types'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from '../contracts/run-contracts'

export const TERMINAL_PROJECTION_RETRY_MAX_ATTEMPTS = 3

export type PendingProjectionSyncStatus = 'pending' | 'exhausted'

export interface PendingProjectionSyncPayload {
  summary: ScopeRunSummary
  eventPayload: ScopeRunEventPayload
  projectionTruth: ProjectionTruthSnapshot | null
}

export interface PendingProjectionSyncRow {
  id: string
  status: PendingProjectionSyncStatus
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  payload: PendingProjectionSyncPayload
  createdAt: string
  updatedAt: string
}

interface PendingProjectionSyncStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface PendingProjectionSyncRawDatabase {
  prepare(sql: string): PendingProjectionSyncStatement
}

interface PendingProjectionSyncDatabaseAccessor {
  getRawDb(): PendingProjectionSyncRawDatabase | null
}

interface PendingProjectionSyncDbRow {
  id: string
  status: PendingProjectionSyncStatus
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  payload_json: string
  created_at: string
  updated_at: string
}

export interface PendingProjectionSyncUpsertInput {
  summary: ScopeRunSummary
  eventPayload: ScopeRunEventPayload
  projectionTruth?: ProjectionTruthSnapshot | null
  error: unknown
  now?: Date
}

export interface PendingProjectionSyncFailureResult {
  row: PendingProjectionSyncRow
  exhausted: boolean
}

export interface PendingProjectionSyncDrainResult {
  attempted: number
  succeeded: number
  failed: number
  exhausted: number
}

export interface PendingProjectionSyncDrainMetric {
  name: 'projection.sync_retry_succeeded' | 'projection.sync_retry_failed' | 'projection.sync_exhausted'
  payload: Record<string, unknown>
}

const FAILED_TERMINAL_REASONS = new Set<NonNullable<ScopeRunSummary['terminalReason']>>([
  'failed_skill',
  'resume_launch_failed',
  'persistence_failed',
  'context_overflow',
  'blocked_tool_error',
  'adjudication_degraded',
  'delivery_failed',
  'tool_unavailable',
  'no_artifact',
  'proof_gap',
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toIso(value: Date | undefined): string {
  return (value || new Date()).toISOString()
}

function nextBackoffAt(attempts: number, now: Date): string {
  const seconds = Math.min(300, Math.max(30, attempts * 30))
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

function parseRow(row: PendingProjectionSyncDbRow): PendingProjectionSyncRow {
  return {
    id: row.id,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    nextAttemptAt: row.next_attempt_at || null,
    lastError: row.last_error || null,
    payload: JSON.parse(row.payload_json) as PendingProjectionSyncPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function terminalProjectionStatusFromSummary(
  summary: Pick<ScopeRunSummary, 'terminalReason'>,
): TaskProjectionRecord['status'] | null {
  const reason = summary.terminalReason
  if (!reason) return null
  if (reason === 'done') return 'completed'
  if (reason === 'cancelled_user' || reason === 'cancelled_runtime' || reason === 'main_no_progress_timeout') return 'killed'
  if (FAILED_TERMINAL_REASONS.has(reason)) return 'failed'
  return null
}

export function isTerminalProjectionSyncPayload(summary: Pick<ScopeRunSummary, 'terminalReason'>): boolean {
  return terminalProjectionStatusFromSummary(summary) !== null
}

export function buildPendingProjectionSyncId(summary: ScopeRunSummary, eventPayload: ScopeRunEventPayload): string {
  const taskId = eventPayload.taskId || summary.taskId || summary.taskProjectionId || 'no-task'
  const runId = eventPayload.runId || summary.runId || 'no-run'
  const terminalReason = summary.terminalReason || 'no-terminal-reason'
  const hash = createHash('sha256')
    .update([summary.scopeId, taskId, runId, terminalReason].join('\0'))
    .digest('hex')
    .slice(0, 24)
  return `projection-sync:${hash}`
}

export class PendingProjectionSyncRepository {
  constructor(private readonly dbManager: PendingProjectionSyncDatabaseAccessor) {}

  upsertPending(input: PendingProjectionSyncUpsertInput): PendingProjectionSyncRow | null {
    if (!isTerminalProjectionSyncPayload(input.summary)) return null
    const db = this.requireDb()
    const id = buildPendingProjectionSyncId(input.summary, input.eventPayload)
    const now = input.now || new Date()
    const nowIso = now.toISOString()
    const existing = this.getDbRow(id)
    const payload: PendingProjectionSyncPayload = {
      summary: input.summary,
      eventPayload: input.eventPayload,
      projectionTruth: input.projectionTruth || null,
    }
    db.prepare(`
      INSERT INTO pending_projection_syncs (
        id, status, attempts, next_attempt_at, last_error, payload_json, created_at, updated_at
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'pending',
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      existing?.attempts ?? 0,
      nowIso,
      errorMessage(input.error),
      JSON.stringify(payload),
      existing?.created_at || nowIso,
      nowIso,
    )
    return this.get(id)
  }

  get(id: string): PendingProjectionSyncRow | null {
    const row = this.getDbRow(id)
    return row ? parseRow(row) : null
  }

  listDue(now: Date = new Date(), limit = 5): PendingProjectionSyncRow[] {
    const db = this.resolveDb()
    if (!db) return []
    return db.prepare(`
      SELECT * FROM pending_projection_syncs
      WHERE status = 'pending'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ?
    `).all<PendingProjectionSyncDbRow>(now.toISOString(), limit).map(parseRow)
  }

  markRetryFailure(id: string, error: unknown, now: Date = new Date()): PendingProjectionSyncFailureResult | null {
    const db = this.requireDb()
    const existing = this.get(id)
    if (!existing) return null
    const attempts = existing.attempts + 1
    const exhausted = attempts >= TERMINAL_PROJECTION_RETRY_MAX_ATTEMPTS
    const updatedAt = now.toISOString()
    db.prepare(`
      UPDATE pending_projection_syncs
      SET status = ?,
          attempts = ?,
          next_attempt_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      exhausted ? 'exhausted' : 'pending',
      attempts,
      exhausted ? null : nextBackoffAt(attempts, now),
      errorMessage(error),
      updatedAt,
      id,
    )
    const row = this.get(id)
    return row ? { row, exhausted } : null
  }

  delete(id: string): void {
    const db = this.resolveDb()
    if (!db) return
    db.prepare('DELETE FROM pending_projection_syncs WHERE id = ?').run(id)
  }

  private getDbRow(id: string): PendingProjectionSyncDbRow | undefined {
    const db = this.resolveDb()
    if (!db) return undefined
    return db.prepare('SELECT * FROM pending_projection_syncs WHERE id = ?').get<PendingProjectionSyncDbRow>(id)
  }

  private resolveDb(): PendingProjectionSyncRawDatabase | null {
    return this.dbManager.getRawDb()
  }

  private requireDb(): PendingProjectionSyncRawDatabase {
    const db = this.resolveDb()
    if (!db) throw new Error('pending projection sync database unavailable')
    return db
  }
}

export async function drainPendingProjectionSyncs(params: {
  repository: PendingProjectionSyncRepository
  sync: (payload: PendingProjectionSyncPayload) => Promise<void>
  onMetric?: (metric: PendingProjectionSyncDrainMetric) => void
  now?: Date
  limit?: number
}): Promise<PendingProjectionSyncDrainResult> {
  const now = params.now || new Date()
  const rows = params.repository.listDue(now, params.limit ?? 5)
  const result: PendingProjectionSyncDrainResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    exhausted: 0,
  }
  for (const row of rows) {
    result.attempted += 1
    try {
      await params.sync(row.payload)
      params.repository.delete(row.id)
      result.succeeded += 1
      params.onMetric?.({
        name: 'projection.sync_retry_succeeded',
        payload: { id: row.id, taskId: row.payload.eventPayload.taskId || row.payload.summary.taskId || null },
      })
    } catch (error) {
      result.failed += 1
      const failure = params.repository.markRetryFailure(row.id, error, now)
      if (failure?.exhausted) {
        result.exhausted += 1
        params.onMetric?.({
          name: 'projection.sync_exhausted',
          payload: {
            id: row.id,
            attempts: failure.row.attempts,
            taskId: row.payload.eventPayload.taskId || row.payload.summary.taskId || null,
            reason: errorMessage(error),
          },
        })
      } else {
        params.onMetric?.({
          name: 'projection.sync_retry_failed',
          payload: {
            id: row.id,
            attempts: failure?.row.attempts ?? row.attempts + 1,
            taskId: row.payload.eventPayload.taskId || row.payload.summary.taskId || null,
            reason: errorMessage(error),
          },
        })
      }
    }
  }
  return result
}
