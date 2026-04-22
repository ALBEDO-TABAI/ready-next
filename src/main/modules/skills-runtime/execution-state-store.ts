import { randomBytes, randomUUID } from 'crypto'
import type {
  ExecutionBlocker,
  ExecutionFrame,
  SkillArtifact,
  SkillDefinition,
  SkillExecutionDetail,
  SkillExecutionError,
  SkillExecutionState,
  SkillExecutionStepRecord,
  SkillInputValue,
} from '../../../shared/skill-execution-types'

interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface DatabaseConnection {
  prepare(sql: string): DatabaseStatement
}

interface ExecutionRow {
  id: string
  skill_id: string
  entry_action: string
  session_id: string | null
  source: string
  status: string
  started_at: string
  updated_at: string
  finished_at: string | null
  current_step_id: string | null
  compiled_skill_json: string
  current_blocker_json: string | null
  last_frame_json: string | null
  errors_json: string | null
  step_outputs_json: string | null
  confirmations_json: string | null
  inputs_json: string | null
}

interface StepRow {
  id: string
  execution_id: string
  step_id: string
  attempt: number
  status: string
  started_at: string
  finished_at: string | null
  result_json: string | null
  message: string | null
}

interface ArtifactRow {
  id: string
  execution_id: string
  step_id: string
  artifact_id: string
  label: string | null
  kind: string | null
  path: string | null
  mime_type: string | null
  metadata_json: string | null
  created_at: string
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Phase 4 — prefix-style skill execution id ("e-" + 8 hex chars, 4B space).
 *
 * Makes skill execution ids self-describing in logs so they're easy to tell
 * apart from scope ids / request ids / task ids. Old `randomUUID()` rows
 * remain valid; `getExecution(id)` uses plain `WHERE id = ?` so both formats
 * coexist indefinitely.
 */
export function generateSkillExecutionId(): string {
  return `e-${randomBytes(4).toString('hex')}`
}

export class ExecutionStateStore {
  constructor(private readonly db: DatabaseConnection) {}

  createExecution(params: {
    definition: SkillDefinition
    entryAction: string
    sessionId?: string | null
    inputs?: Record<string, SkillInputValue>
  }): SkillExecutionState {
    // persistState uses ON CONFLICT(id) DO UPDATE, so a raw id collision would
    // silently overwrite an existing execution instead of throwing. Pre-check
    // with a SELECT in a small retry loop to keep creates strictly additive.
    // better-sqlite3 serializes writes, so the check-then-insert is atomic.
    let attempts = 0
    let id = generateSkillExecutionId()
    while (attempts < 3) {
      const existing = this.db
        .prepare('SELECT id FROM skill_executions WHERE id = ?')
        .get<{ id: string }>(id)
      if (!existing) break
      id = generateSkillExecutionId()
      attempts += 1
    }
    if (attempts === 3) {
      throw new Error('Failed to generate unique skill execution id after 3 attempts')
    }
    const now = nowIso()
    const state: SkillExecutionState = {
      id,
      skillId: params.definition.id,
      entryAction: params.entryAction,
      sessionId: params.sessionId || null,
      source: params.definition.source,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      currentStepId: params.definition.workflow?.initialStep || null,
      compiledSkill: params.definition,
      blocker: null,
      lastFrame: null,
      errors: [],
      stepOutputs: {},
      confirmations: {},
      inputs: params.inputs || {},
    }
    this.persistState(state)
    return state
  }

  listExecutions(limit = 30, sessionId?: string, activeOnly = false): SkillExecutionState[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 30)))
    let sql = 'SELECT * FROM skill_executions'
    const args: unknown[] = []
    const filters: string[] = []
    if (sessionId) {
      filters.push('session_id = ?')
      args.push(sessionId)
    }
    if (activeOnly) {
      filters.push("status IN ('running', 'blocked')")
    }
    if (filters.length > 0) {
      sql += ` WHERE ${filters.join(' AND ')}`
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?'
    args.push(safeLimit)
    const rows = this.db.prepare(sql).all<ExecutionRow>(...args)
    return rows.map((row) => this.mapExecutionRow(row))
  }

  getExecution(id: string): SkillExecutionDetail | null {
    const row = this.db.prepare('SELECT * FROM skill_executions WHERE id = ?').get<ExecutionRow>(id)
    if (!row) return null
    const state = this.mapExecutionRow(row)
    const steps = this.db.prepare(
      'SELECT * FROM skill_execution_steps WHERE execution_id = ? ORDER BY started_at ASC, attempt ASC',
    ).all<StepRow>(id).map((item) => this.mapStepRow(item))
    const artifacts = this.db.prepare(
      'SELECT * FROM skill_execution_artifacts WHERE execution_id = ? ORDER BY created_at ASC',
    ).all<ArtifactRow>(id).map((item) => this.mapArtifactRow(item))
    return { ...state, steps, artifacts }
  }

  updateExecution(state: SkillExecutionState): SkillExecutionState {
    const next: SkillExecutionState = {
      ...state,
      updatedAt: nowIso(),
    }
    if (next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled') {
      next.finishedAt = next.finishedAt || next.updatedAt
    }
    this.persistState(next)
    return next
  }

  recordStepStart(executionId: string, stepId: string, status: SkillExecutionStepRecord['status'] = 'running'): SkillExecutionStepRecord {
    const now = nowIso()
    const currentAttemptRow = this.db.prepare(
      'SELECT MAX(attempt) as max_attempt FROM skill_execution_steps WHERE execution_id = ? AND step_id = ?',
    ).get<{ max_attempt?: number }>(executionId, stepId)
    const attempt = Math.max(0, Number(currentAttemptRow?.max_attempt || 0)) + 1
    const record: SkillExecutionStepRecord = {
      id: randomUUID(),
      executionId,
      stepId,
      attempt,
      status,
      startedAt: now,
      finishedAt: status === 'running' ? null : now,
      result: null,
      message: null,
    }
    this.db.prepare(`
      INSERT INTO skill_execution_steps (
        id, execution_id, step_id, attempt, status, started_at, finished_at, result_json, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.executionId,
      record.stepId,
      record.attempt,
      record.status,
      record.startedAt,
      record.finishedAt || null,
      null,
      null,
    )
    return record
  }

  recordStepFinish(recordId: string, status: SkillExecutionStepRecord['status'], result?: SkillExecutionStepRecord['result'], message?: string | null): void {
    this.db.prepare(`
      UPDATE skill_execution_steps
      SET status = ?, finished_at = ?, result_json = ?, message = ?
      WHERE id = ?
    `).run(
      status,
      nowIso(),
      result ? JSON.stringify(result) : null,
      message || null,
      recordId,
    )
  }

  addArtifacts(executionId: string, stepId: string, artifacts: SkillArtifact[]): void {
    if (artifacts.length === 0) return
    const stmt = this.db.prepare(`
      INSERT INTO skill_execution_artifacts (
        id, execution_id, step_id, artifact_id, label, kind, path, mime_type, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const createdAt = nowIso()
    for (const artifact of artifacts) {
      stmt.run(
        randomUUID(),
        executionId,
        stepId,
        artifact.id,
        artifact.label || null,
        artifact.kind || null,
        artifact.path || null,
        artifact.mimeType || null,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        createdAt,
      )
    }
  }

  resetFromStep(executionId: string, stepId: string): SkillExecutionState | null {
    const detail = this.getExecution(executionId)
    if (!detail) return null
    const workflow = detail.compiledSkill.workflow
    if (!workflow) return null
    const stepIndex = workflow.steps.findIndex((step) => step.id === stepId)
    if (stepIndex < 0) return null
    const stepIds = new Set(workflow.steps.slice(stepIndex).map((step) => step.id))

    this.db.prepare('DELETE FROM skill_execution_steps WHERE execution_id = ? AND step_id IN (SELECT value FROM json_each(?))')
      .run(executionId, JSON.stringify(Array.from(stepIds)))
    this.db.prepare('DELETE FROM skill_execution_artifacts WHERE execution_id = ? AND step_id IN (SELECT value FROM json_each(?))')
      .run(executionId, JSON.stringify(Array.from(stepIds)))

    const nextOutputs = Object.fromEntries(
      Object.entries(detail.stepOutputs).filter(([key]) => !stepIds.has(key)),
    )
    const nextConfirmations = Object.fromEntries(
      Object.entries(detail.confirmations).filter(([key]) => !stepIds.has(key)),
    )
    const nextErrors = detail.errors.filter((error) => !error.stepId || !stepIds.has(error.stepId))
    const nextState: SkillExecutionState = {
      ...detail,
      status: 'running',
      finishedAt: null,
      currentStepId: stepId,
      blocker: null,
      lastFrame: null,
      stepOutputs: nextOutputs,
      confirmations: nextConfirmations,
      errors: nextErrors,
    }
    return this.updateExecution(nextState)
  }

  cancelExecution(executionId: string, message = 'Execution cancelled'): SkillExecutionState | null {
    const state = this.getExecution(executionId)
    if (!state) return null
    const next: SkillExecutionState = {
      ...state,
      status: 'cancelled',
      blocker: {
        type: 'failed',
        executionId,
        skillId: state.skillId,
        stepId: state.currentStepId || undefined,
        message,
      },
      errors: [
        ...state.errors,
        {
          stepId: state.currentStepId || undefined,
          message,
          timestamp: nowIso(),
        } satisfies SkillExecutionError,
      ],
    }
    return this.updateExecution(next)
  }

  /**
   * Phase 4 — TTL sweep for terminal skill_executions rows.
   *
   * Deletes rows older than `retentionDays` whose status is one of
   * `completed / failed / cancelled`. Active rows (`running / blocked`) are
   * never touched. Returns the number of parent rows deleted.
   *
   * The database does NOT have `PRAGMA foreign_keys = ON` enabled, so
   * Migration 018's `ON DELETE CASCADE` is silently a no-op today. We delete
   * child rows (steps + artifacts) explicitly before the parent to avoid
   * leaving orphans. If PRAGMA foreign_keys is ever flipped on later, the
   * explicit deletes here are harmless (rows already gone) — they become
   * idempotent pre-cleanup.
   */
  purgeExpiredExecutions(retentionDays = 7): { deleted: number; cutoff: string } {
    const safeDays = Math.max(1, Math.floor(retentionDays))
    const cutoff = new Date(Date.now() - safeDays * 86_400_000).toISOString()
    const expired = this.db
      .prepare(
        `SELECT id FROM skill_executions
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND finished_at IS NOT NULL
           AND finished_at < ?`,
      )
      .all<{ id: string }>(cutoff)
    if (expired.length === 0) return { deleted: 0, cutoff }
    const ids = expired.map((row) => row.id)
    const placeholders = ids.map(() => '?').join(',')
    this.db
      .prepare(`DELETE FROM skill_execution_artifacts WHERE execution_id IN (${placeholders})`)
      .run(...ids)
    this.db
      .prepare(`DELETE FROM skill_execution_steps WHERE execution_id IN (${placeholders})`)
      .run(...ids)
    const result = this.db
      .prepare(`DELETE FROM skill_executions WHERE id IN (${placeholders})`)
      .run(...ids) as { changes?: number }
    return { deleted: Number(result.changes ?? 0), cutoff }
  }

  private persistState(state: SkillExecutionState): void {
    this.db.prepare(`
      INSERT INTO skill_executions (
        id, skill_id, entry_action, session_id, source, status, started_at, updated_at, finished_at,
        current_step_id, compiled_skill_json, current_blocker_json, last_frame_json, errors_json,
        step_outputs_json, confirmations_json, inputs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        skill_id = excluded.skill_id,
        entry_action = excluded.entry_action,
        session_id = excluded.session_id,
        source = excluded.source,
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        finished_at = excluded.finished_at,
        current_step_id = excluded.current_step_id,
        compiled_skill_json = excluded.compiled_skill_json,
        current_blocker_json = excluded.current_blocker_json,
        last_frame_json = excluded.last_frame_json,
        errors_json = excluded.errors_json,
        step_outputs_json = excluded.step_outputs_json,
        confirmations_json = excluded.confirmations_json,
        inputs_json = excluded.inputs_json
    `).run(
      state.id,
      state.skillId,
      state.entryAction,
      state.sessionId || null,
      state.source,
      state.status,
      state.startedAt,
      state.updatedAt,
      state.finishedAt || null,
      state.currentStepId || null,
      JSON.stringify(state.compiledSkill),
      state.blocker ? JSON.stringify(state.blocker) : null,
      state.lastFrame ? JSON.stringify(state.lastFrame) : null,
      JSON.stringify(state.errors || []),
      JSON.stringify(state.stepOutputs || {}),
      JSON.stringify(state.confirmations || {}),
      JSON.stringify(state.inputs || {}),
    )
  }

  private mapExecutionRow(row: ExecutionRow): SkillExecutionState {
    return {
      id: row.id,
      skillId: row.skill_id,
      entryAction: row.entry_action,
      sessionId: row.session_id,
      source: row.source === 'custom' ? 'custom' : 'embedded',
      status: row.status as SkillExecutionState['status'],
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      currentStepId: row.current_step_id,
      compiledSkill: parseJson<SkillDefinition>(row.compiled_skill_json, {} as SkillDefinition),
      blocker: parseJson<ExecutionBlocker | null>(row.current_blocker_json, null),
      lastFrame: parseJson<ExecutionFrame | null>(row.last_frame_json, null),
      errors: parseJson(row.errors_json, []),
      stepOutputs: parseJson(row.step_outputs_json, {}),
      confirmations: parseJson(row.confirmations_json, {}),
      inputs: parseJson(row.inputs_json, {}),
    }
  }

  private mapStepRow(row: StepRow): SkillExecutionStepRecord {
    return {
      id: row.id,
      executionId: row.execution_id,
      stepId: row.step_id,
      attempt: row.attempt,
      status: row.status as SkillExecutionStepRecord['status'],
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: parseJson(row.result_json, null),
      message: row.message,
    }
  }

  private mapArtifactRow(row: ArtifactRow): SkillArtifact {
    return {
      id: row.artifact_id,
      label: row.label || undefined,
      kind: row.kind || undefined,
      path: row.path || undefined,
      mimeType: row.mime_type || undefined,
      metadata: parseJson(row.metadata_json, undefined),
    }
  }
}
