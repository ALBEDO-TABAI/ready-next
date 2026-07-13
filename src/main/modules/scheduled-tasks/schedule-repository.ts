import type {
  ScheduleMissedPolicy,
  ScheduleOccurrenceClaimStatus,
  ScheduleSpecV1,
  ScheduleTriggerSource,
} from '../../../shared/scheduled-tasks'
import { assertOccurrenceTransition, createScheduledOccurrenceId } from './schedule-occurrence-state'
import { assertValidScheduleSpec } from './schedule-spec'

interface Statement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

function changed(result: unknown): boolean {
  return Boolean((result as { changes?: number } | null)?.changes)
}

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): Statement
}

interface DatabaseAccessor {
  getRawDb(): RawDatabase | null
}

interface ScheduleRow {
  id: string
  name: string
  instruction: string
  schedule_spec_version: 1
  schedule_spec_json: string
  timezone: string
  scope_id: string | null
  scope_mode: 'dedicated' | 'existing'
  agent_id: string
  workspace_roots_json: string
  enabled: number
  next_run_at: string | null
  last_occurrence_at: string | null
  missed_policy: ScheduleMissedPolicy
  migration_state: 'needs_scope' | 'needs_schedule_review' | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface OccurrenceRow {
  id: string
  schedule_id: string
  scheduled_for: string
  triggered_at: string
  trigger_source: ScheduleTriggerSource
  claim_status: ScheduleOccurrenceClaimStatus
  attempt: number
  run_id: string | null
  task_id: string | null
  delay_ms: number
  started_at: string | null
  finished_at: string | null
  error_kind: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface ScheduledTaskDefinition {
  id: string
  name: string
  instruction: string
  scheduleSpecVersion: 1
  scheduleSpec: ScheduleSpecV1
  timezone: string
  scopeId: string | null
  scopeMode: 'dedicated' | 'existing'
  agentId: string
  workspaceRoots: string[]
  enabled: boolean
  nextRunAt: string | null
  lastOccurrenceAt: string | null
  missedPolicy: ScheduleMissedPolicy
  migrationState: 'needs_scope' | 'needs_schedule_review' | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface ScheduledTaskOccurrence {
  id: string
  scheduleId: string
  scheduledFor: string
  triggeredAt: string
  triggerSource: ScheduleTriggerSource
  claimStatus: ScheduleOccurrenceClaimStatus
  attempt: number
  runId: string | null
  taskId: string | null
  delayMs: number
  startedAt: string | null
  finishedAt: string | null
  errorKind: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateScheduledTaskInput {
  id: string
  name: string
  instruction: string
  scheduleSpec: ScheduleSpecV1
  timezone: string
  scopeId: string
  scopeMode: 'dedicated' | 'existing'
  agentId: string
  workspaceRoots?: string[]
  enabled?: boolean
  nextRunAt?: string | null
  missedPolicy?: ScheduleMissedPolicy
  now?: string
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T
}

function mapSchedule(row: ScheduleRow): ScheduledTaskDefinition {
  return {
    id: row.id, name: row.name, instruction: row.instruction,
    scheduleSpecVersion: row.schedule_spec_version,
    scheduleSpec: parseJson<ScheduleSpecV1>(row.schedule_spec_json), timezone: row.timezone,
    scopeId: row.scope_id, scopeMode: row.scope_mode, agentId: row.agent_id,
    workspaceRoots: parseJson<string[]>(row.workspace_roots_json), enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at, lastOccurrenceAt: row.last_occurrence_at,
    missedPolicy: row.missed_policy, migrationState: row.migration_state,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
  }
}

function mapOccurrence(row: OccurrenceRow): ScheduledTaskOccurrence {
  return {
    id: row.id, scheduleId: row.schedule_id, scheduledFor: row.scheduled_for,
    triggeredAt: row.triggered_at, triggerSource: row.trigger_source,
    claimStatus: row.claim_status, attempt: row.attempt, runId: row.run_id,
    taskId: row.task_id, delayMs: row.delay_ms, startedAt: row.started_at,
    finishedAt: row.finished_at, errorKind: row.error_kind,
    errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class ScheduleRepository {
  constructor(private readonly database: DatabaseAccessor) {}

  private db(): RawDatabase {
    const db = this.database.getRawDb()
    if (!db) throw new Error('Schedule database is not available')
    return db
  }

  create(input: CreateScheduledTaskInput): ScheduledTaskDefinition {
    if (!input.scopeId.trim()) throw new Error('Scheduled tasks require a scope')
    assertValidScheduleSpec(input.scheduleSpec, input.timezone)
    const now = input.now || new Date().toISOString()
    this.db().prepare(`INSERT INTO scheduled_tasks (
      id, name, instruction, schedule_spec_version, schedule_spec_json, timezone,
      scope_id, scope_mode, agent_id, workspace_roots_json, enabled, next_run_at,
      last_occurrence_at, missed_policy, migration_state, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)`).run(
      input.id, input.name, input.instruction, JSON.stringify(input.scheduleSpec), input.timezone,
      input.scopeId, input.scopeMode, input.agentId, JSON.stringify(input.workspaceRoots || []), input.enabled === false ? 0 : 1,
      input.nextRunAt ?? null, input.missedPolicy || 'coalesce_latest', now, now,
    )
    return this.get(input.id)!
  }

  get(id: string): ScheduledTaskDefinition | null {
    const row = this.db().prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND deleted_at IS NULL').get<ScheduleRow>(id)
    return row ? mapSchedule(row) : null
  }

  list(): ScheduledTaskDefinition[] {
    return this.db().prepare('SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all<ScheduleRow>().map(mapSchedule)
  }

  listEnabled(): ScheduledTaskDefinition[] {
    return this.db().prepare('SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL AND enabled = 1 ORDER BY next_run_at')
      .all<ScheduleRow>().map(mapSchedule)
  }

  listDue(now: string): ScheduledTaskDefinition[] {
    return this.db().prepare(`SELECT * FROM scheduled_tasks
      WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at`).all<ScheduleRow>(now).map(mapSchedule)
  }

  countScheduledExecutionClaims(scheduleId: string): number {
    const row = this.db().prepare(`SELECT COUNT(*) AS count FROM agent_schedule_occurrences
      WHERE schedule_id = ? AND trigger_source_key = 'scheduled'
        AND claim_status IN ('queued', 'dispatching', 'dispatched', 'dispatch_failed', 'blocked_target')`)
      .get<{ count: number }>(scheduleId)
    return Number(row?.count || 0)
  }

  update(id: string, patch: Partial<Omit<CreateScheduledTaskInput, 'id' | 'now'>> & {
    lastOccurrenceAt?: string | null
    migrationState?: ScheduledTaskDefinition['migrationState']
  }, now = new Date().toISOString()): ScheduledTaskDefinition | null {
    const existing = this.get(id)
    if (!existing) return null
    const scheduleSpec = patch.scheduleSpec ?? existing.scheduleSpec
    const timezone = patch.timezone ?? existing.timezone
    const scopeId = patch.scopeId ?? existing.scopeId
    if (patch.enabled !== false && !scopeId) throw new Error('Enabled scheduled tasks require a scope')
    assertValidScheduleSpec(scheduleSpec, timezone)
    this.db().prepare(`UPDATE scheduled_tasks SET
      name = ?, instruction = ?, schedule_spec_json = ?, timezone = ?, scope_id = ?, scope_mode = ?, agent_id = ?,
      workspace_roots_json = ?, enabled = ?, next_run_at = ?, last_occurrence_at = ?,
      missed_policy = ?, migration_state = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(
      patch.name ?? existing.name, patch.instruction ?? existing.instruction, JSON.stringify(scheduleSpec), timezone,
      scopeId, patch.scopeMode ?? existing.scopeMode, patch.agentId ?? existing.agentId, JSON.stringify(patch.workspaceRoots ?? existing.workspaceRoots),
      patch.enabled === undefined ? Number(existing.enabled) : Number(patch.enabled),
      patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
      patch.lastOccurrenceAt === undefined ? existing.lastOccurrenceAt : patch.lastOccurrenceAt,
      patch.missedPolicy ?? existing.missedPolicy,
      patch.migrationState === undefined ? existing.migrationState : patch.migrationState, now, id,
    )
    return this.get(id)
  }

  setNextRunAt(id: string, nextRunAt: string | null, now = new Date().toISOString()): boolean {
    return changed(this.db().prepare('UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(nextRunAt, now, id))
  }

  delete(id: string, now = new Date().toISOString()): boolean {
    return changed(this.db().prepare(`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL,
      deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(now, now, id))
  }

  reconcile(input: {
    scheduleId: string
    triggeredAt: string
    triggerSource: Exclude<ScheduleTriggerSource, 'manual'>
    nextRunAt: string | null
    disableAfterReconcile?: boolean
    occurrences: Array<{
      scheduledFor: string
      claimStatus: Extract<ScheduleOccurrenceClaimStatus, 'queued' | 'skipped_missed' | 'skipped_coalesced'>
      delayMs: number
    }>
  }): ScheduledTaskOccurrence[] {
    const db = this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      const schedule = db.prepare(`SELECT id FROM scheduled_tasks
        WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`).get<{ id: string }>(input.scheduleId)
      if (!schedule) {
        db.exec('ROLLBACK')
        return []
      }
      const insertedIds: string[] = []
      for (const occurrence of input.occurrences) {
        const id = createScheduledOccurrenceId({
          scheduleId: input.scheduleId,
          scheduledFor: occurrence.scheduledFor,
          triggerSource: input.triggerSource,
        })
        const result = db.prepare(`INSERT OR IGNORE INTO agent_schedule_occurrences (
          id, schedule_id, scheduled_for, triggered_at, trigger_source, trigger_source_key,
          claim_status, attempt, delay_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, 0, ?, ?, ?)`).run(
          id, input.scheduleId, occurrence.scheduledFor, input.triggeredAt, input.triggerSource,
          occurrence.claimStatus, Math.max(0, occurrence.delayMs), input.triggeredAt, input.triggeredAt,
        )
        if (changed(result)) insertedIds.push(id)
      }
      const latest = input.occurrences.reduce<string | null>((value, occurrence) => (
        value === null || occurrence.scheduledFor > value ? occurrence.scheduledFor : value
      ), null)
      db.prepare(`UPDATE scheduled_tasks SET next_run_at = ?, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
        last_occurrence_at = CASE
        WHEN ? IS NULL THEN last_occurrence_at
        WHEN last_occurrence_at IS NULL OR last_occurrence_at < ? THEN ? ELSE last_occurrence_at END,
        updated_at = ? WHERE id = ?`).run(
        input.nextRunAt, Number(Boolean(input.disableAfterReconcile)), latest, latest, latest,
        input.triggeredAt, input.scheduleId,
      )
      db.exec('COMMIT')
      return insertedIds.map((id) => this.getOccurrence(id)!).filter(Boolean)
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }

  claimDue(input: {
    scheduleId: string
    scheduledFor: string
    triggeredAt: string
    triggerSource: ScheduleTriggerSource
    nextRunAt: string | null
    delayMs?: number
    claimStatus?: Extract<ScheduleOccurrenceClaimStatus, 'queued' | 'skipped_missed' | 'skipped_coalesced'>
    occurrenceId?: string
  }): ScheduledTaskOccurrence | null {
    const db = this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      const schedule = db.prepare(`SELECT id FROM scheduled_tasks
        WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`).get<{ id: string }>(input.scheduleId)
      if (!schedule) {
        db.exec('ROLLBACK')
        return null
      }
      const id = input.occurrenceId || (input.triggerSource === 'manual'
        ? null
        : createScheduledOccurrenceId(input as Parameters<typeof createScheduledOccurrenceId>[0]))
      if (!id) throw new Error('Manual occurrences require an occurrenceId')
      const sourceKey = input.triggerSource === 'manual' ? `manual:${id}` : 'scheduled'
      const inserted = db.prepare(`INSERT OR IGNORE INTO agent_schedule_occurrences (
        id, schedule_id, scheduled_for, triggered_at, trigger_source, trigger_source_key,
        claim_status, attempt, delay_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
        id, input.scheduleId, input.scheduledFor, input.triggeredAt, input.triggerSource, sourceKey,
        input.claimStatus || 'queued', Math.max(0, input.delayMs || 0), input.triggeredAt, input.triggeredAt,
      )
      db.prepare(`UPDATE scheduled_tasks SET next_run_at = ?, last_occurrence_at = CASE
        WHEN last_occurrence_at IS NULL OR last_occurrence_at < ? THEN ? ELSE last_occurrence_at END,
        updated_at = ? WHERE id = ?`).run(
        input.nextRunAt, input.scheduledFor, input.scheduledFor, input.triggeredAt, input.scheduleId,
      )
      db.exec('COMMIT')
      if (!changed(inserted)) return null
      return this.getOccurrence(id)
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }

  getOccurrence(id: string): ScheduledTaskOccurrence | null {
    const row = this.db().prepare('SELECT * FROM agent_schedule_occurrences WHERE id = ?').get<OccurrenceRow>(id)
    return row ? mapOccurrence(row) : null
  }

  listRecoverableOccurrences(): ScheduledTaskOccurrence[] {
    return this.db().prepare(`SELECT * FROM agent_schedule_occurrences
      WHERE claim_status IN ('queued', 'dispatching') ORDER BY scheduled_for, created_at`)
      .all<OccurrenceRow>().map(mapOccurrence)
  }

  listRecoverable(): ScheduledTaskOccurrence[] {
    return this.listRecoverableOccurrences()
  }

  listHistory(scheduleId: string, limit = 50): ScheduledTaskOccurrence[] {
    return this.db().prepare(`SELECT * FROM agent_schedule_occurrences
      WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all<OccurrenceRow>(scheduleId, Math.max(1, Math.min(200, Math.floor(limit)))).map(mapOccurrence)
  }

  updateOccurrenceStatus(id: string, status: ScheduleOccurrenceClaimStatus, patch: {
    runId?: string | null
    taskId?: string | null
    errorKind?: string | null
    errorMessage?: string | null
    finishedAt?: string | null
    now?: string
  } = {}): ScheduledTaskOccurrence | null {
    const existing = this.getOccurrence(id)
    if (!existing) return null
    if (existing.claimStatus === status) return existing
    assertOccurrenceTransition(existing.claimStatus, status)
    const now = patch.now || new Date().toISOString()
    const result = this.db().prepare(`UPDATE agent_schedule_occurrences SET
      claim_status = ?, attempt = attempt + CASE WHEN ? = 'dispatching' THEN 1 ELSE 0 END,
      run_id = ?, task_id = ?, started_at = CASE WHEN ? = 'dispatching' THEN ? ELSE started_at END,
      finished_at = ?, error_kind = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND claim_status = ?`).run(
      status, status, patch.runId === undefined ? existing.runId : patch.runId,
      patch.taskId === undefined ? existing.taskId : patch.taskId, status, now,
      patch.finishedAt === undefined ? existing.finishedAt : patch.finishedAt,
      patch.errorKind === undefined ? existing.errorKind : patch.errorKind,
      patch.errorMessage === undefined ? existing.errorMessage : patch.errorMessage,
      now, id, existing.claimStatus,
    )
    return changed(result) ? this.getOccurrence(id) : null
  }

  requeueDispatching(id: string, now = new Date().toISOString()): ScheduledTaskOccurrence | null {
    const occurrence = this.getOccurrence(id)
    if (!occurrence || occurrence.claimStatus !== 'dispatching') return null
    return this.updateOccurrenceStatus(id, 'queued', { now })
  }
}
