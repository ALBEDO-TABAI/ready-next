/**
 * Stage S (PR-S11 / W10.2) — RunFeedbackRepository.
 *
 * Backs the `run_feedback` table (migration 036). Per-run user feedback
 * (rating 1-5, optional signal label, optional free-text comment), keyed
 * by `feedbackId`. Foreign-keyed to `run_meta(run_id)`.
 *
 * Repository contract is **upsert by feedbackId**: the same `feedback_id`
 * may be re-submitted (e.g. user revises rating); the row is replaced and
 * `updated_at` advances. CI gate `check-feedback-upsert-shape.cjs` pins
 * the `INSERT … ON CONFLICT(feedback_id) DO UPDATE` shape.
 */
import type { DatabaseConnection } from '../../database'

export type RunFeedbackRating = 1 | 2 | 3 | 4 | 5

export interface RunFeedbackRecord {
  feedbackId: string
  runId: string
  taskId: string | null
  rating: RunFeedbackRating | null
  signal: string | null
  comment: string | null
  createdAt: number
  updatedAt: number
}

export interface RunFeedbackUpsertInput {
  feedbackId: string
  runId: string
  taskId?: string | null
  rating?: RunFeedbackRating | null
  signal?: string | null
  comment?: string | null
}

export interface RunFeedbackListOptions {
  runId?: string
  taskId?: string
  limit?: number
}

interface RunFeedbackRow {
  feedback_id: string
  run_id: string
  task_id: string | null
  rating: number | null
  signal: string | null
  comment: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: RunFeedbackRow): RunFeedbackRecord {
  return {
    feedbackId: row.feedback_id,
    runId: row.run_id,
    taskId: row.task_id,
    rating: (row.rating as RunFeedbackRating | null) ?? null,
    signal: row.signal,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class RunFeedbackRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /**
   * Upsert by `feedback_id`. On INSERT, `created_at` and `updated_at` both
   * receive `now`. On CONFLICT, only `updated_at` advances; `created_at` is
   * preserved via `excluded.created_at` not being referenced in the UPDATE
   * clause (the existing row's `created_at` is kept).
   */
  upsert(input: RunFeedbackUpsertInput, now: number = Date.now()): RunFeedbackRecord {
    const taskId = input.taskId ?? null
    const rating = input.rating ?? null
    const signal = input.signal ?? null
    const comment = input.comment ?? null

    this.db
      .prepare(
        `INSERT INTO run_feedback (
          feedback_id, run_id, task_id, rating, signal, comment, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feedback_id) DO UPDATE SET
          run_id = excluded.run_id,
          task_id = excluded.task_id,
          rating = excluded.rating,
          signal = excluded.signal,
          comment = excluded.comment,
          updated_at = excluded.updated_at`
      )
      .run(
        input.feedbackId,
        input.runId,
        taskId,
        rating,
        signal,
        comment,
        now,
        now,
      )

    const row = this.db
      .prepare(`SELECT * FROM run_feedback WHERE feedback_id = ?`)
      .get(input.feedbackId) as RunFeedbackRow | undefined
    if (!row) {
      // Should be unreachable: we just wrote the row.
      throw new Error(
        `[run-feedback-repository] upsert: row not found after write: ${input.feedbackId}`,
      )
    }
    return rowToRecord(row)
  }

  /**
   * Convenience alias for `upsert`. New feedback rows always go through
   * upsert so re-submissions remain idempotent.
   */
  create(input: RunFeedbackUpsertInput, now: number = Date.now()): RunFeedbackRecord {
    return this.upsert(input, now)
  }

  get(feedbackId: string): RunFeedbackRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM run_feedback WHERE feedback_id = ?`)
      .get(feedbackId) as RunFeedbackRow | undefined
    return row ? rowToRecord(row) : null
  }

  /** Patch update — same upsert semantics; `feedback_id` must already exist. */
  update(
    feedbackId: string,
    patch: Partial<Omit<RunFeedbackRecord, 'feedbackId' | 'createdAt' | 'updatedAt'>>,
    now: number = Date.now(),
  ): RunFeedbackRecord | null {
    const existing = this.get(feedbackId)
    if (!existing) return null
    return this.upsert(
      {
        feedbackId,
        runId: patch.runId ?? existing.runId,
        taskId: patch.taskId ?? existing.taskId,
        rating: patch.rating ?? existing.rating,
        signal: patch.signal ?? existing.signal,
        comment: patch.comment ?? existing.comment,
      },
      now,
    )
  }

  delete(feedbackId: string): boolean {
    const result = this.db.prepare(`DELETE FROM run_feedback WHERE feedback_id = ?`).run(
      feedbackId,
    ) as { changes: number }
    return result.changes > 0
  }

  list(options: RunFeedbackListOptions = {}): RunFeedbackRecord[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (options.runId !== undefined) {
      conditions.push('run_id = ?')
      params.push(options.runId)
    }
    if (options.taskId !== undefined) {
      conditions.push('task_id = ?')
      params.push(options.taskId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : ''
    const sql = `SELECT * FROM run_feedback ${where} ORDER BY updated_at DESC ${limit}`.trim()

    const rows = this.db.prepare(sql).all(...params) as RunFeedbackRow[]
    return rows.map(rowToRecord)
  }
}
