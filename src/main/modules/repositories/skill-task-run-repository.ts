import { randomUUID } from 'node:crypto'

import type {
  SkillChildRunPayload,
  SkillChildRunStatus,
  SkillChildRunParentNextHint,
} from '../agent-control/skills/skill-child-run-types'
import { validateSkillChildRunTransition } from '../agent-control/skills/skill-child-state-machine'

export type SkillTaskRunStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'
export type SkillTaskRunInteractionState =
  | 'running'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'human_takeover'
  | 'suspended'
  | 'resuming'

export interface SkillTaskRunStep {
  id: string
  title?: string
  status: 'pending' | 'running' | 'blocked' | 'done' | 'error'
  detail?: string | null
  updatedAt: string
}

export interface SkillTaskRunArtifact {
  id: string
  module?: string
  kind: string
  label: string
  path?: string | null
  createdAt: string
  meta?: Record<string, unknown>
}

/**
 * Stage 6 L1 contract: ledger writers split into a public funnel (`update`)
 * which is *forbidden* from touching status/finishedAt, plus the internal
 * methods `createChildRun` and `updateChildRun` which own those fields. The
 * public patch shape excludes the two managed fields at the type level so
 * that static analysis catches misuse before runtime.
 */
export type NoStatusUpdatePatch = Omit<Partial<SkillTaskRunRecord>, 'status' | 'finishedAt'>

export interface SkillTaskRunRecord {
  id: string
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  runId?: string | null
  skillId: string
  skillName?: string | null
  action: string
  toolName?: string | null
  runKind: 'typed_action' | 'primitive' | 'detached' | 'manual' | string
  status: SkillTaskRunStatus
  interactionState: SkillTaskRunInteractionState
  goalText?: string | null
  resourceRefs?: unknown[]
  params?: Record<string, unknown> | null
  steps: SkillTaskRunStep[]
  currentStepId?: string | null
  artifacts: SkillTaskRunArtifact[]
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  failureKind?: string | null
  failureDetail?: string | null
  jobId?: string | null
  detachedTaskId?: string | null
  resumePayload?: Record<string, unknown> | null
  createdAt: string
  startedAt?: string | null
  updatedAt: string
  finishedAt?: string | null
}

interface SkillTaskRunStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface SkillTaskRunRawDatabase {
  prepare(sql: string): SkillTaskRunStatement
}

interface SkillTaskRunDatabaseAccessor {
  getRawDb(): SkillTaskRunRawDatabase | null
}

interface SkillTaskRunRow {
  id: string
  scope_id: string | null
  session_id: string | null
  agent: string | null
  run_id: string | null
  skill_id: string
  skill_name: string | null
  action: string
  tool_name: string | null
  run_kind: string
  status: SkillTaskRunStatus
  interaction_state: SkillTaskRunInteractionState
  goal_text: string | null
  resource_refs_json: string | null
  params_json: string | null
  steps_json: string
  current_step_id: string | null
  artifacts_json: string
  output_dir: string | null
  run_state_path: string | null
  scene_scores_path: string | null
  delivery_report_path: string | null
  failure_kind: string | null
  failure_detail: string | null
  job_id: string | null
  detached_task_id: string | null
  resume_payload_json: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

export function createSkillTaskRunId(): string {
  return `str-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/**
 * Phase 4 — child-run helpers (source plan §5.2).
 *
 * `skill_task_runs` is reused as the durable parent-visible child-run table.
 * The full child payload lives in `resumePayload.childRun` (a versioned
 * `SkillChildRunPayload`, version=1). The row's `id` column stores the
 * child-run id directly (no `str-` prefix wrapper); legacy `str-…` rows
 * coexist with new `[vsd]…` rows.
 *
 * Rationale for not adding a DB migration: `resumePayload_json` already
 * accepts arbitrary JSON; SQLite supports `json_extract` for the queries we
 * need. A dedicated column is only worth promoting after Phase 5/6 prove
 * that JSON-field queries hurt perf or correctness.
 */

export interface CreateChildRunInput {
  /** Pass an id minted via `createSkillChildRunId('vea' | 'skill' | 'detached')`. */
  childRunId: string
  scopeId: string | null
  sessionId: string | null
  skillId: string
  skillName: string | null
  action: string
  requestedInput: Record<string, unknown>
  singleFlightKey: string
  parentNextHint: SkillChildRunParentNextHint
  outputDir: string
  runStatePath: string
  eventLogPath: string
  status?: SkillChildRunStatus
}

/**
 * `SkillChildRunStatus` is wider than `SkillTaskRunStatus`. Child-run code
 * always reads the canonical status from `resumePayload.childRun.status`;
 * the row's `status` column is a coarse projection that lets the legacy
 * "active" filter (`status IN ('queued','running','blocked')`) keep working
 * without a migration.
 */
function mapChildStatusToRowStatus(status: SkillChildRunStatus): SkillTaskRunStatus {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'recoverable_paused':
    case 'budget_paused':
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'cancelled'
    default:
      return 'blocked'
  }
}

const CHILD_RUN_ACTIVE_STATUSES: ReadonlyArray<SkillChildRunStatus> = [
  'queued',
  'running',
  'recoverable_paused',
  'budget_paused',
  'blocked',
]

const CHILD_RUN_SINGLE_FLIGHT_STATUSES: ReadonlyArray<SkillChildRunStatus> = [
  'queued',
  'running',
  'recoverable_paused',
  'budget_paused',
]

const CHILD_RUN_TERMINAL_STATUSES: ReadonlyArray<SkillChildRunStatus> = [
  'completed',
  'failed',
  'killed',
]

function sessionAbortKey(scopeId: string | null, sessionId: string | null): string {
  return `${scopeId ?? '_'}|${sessionId ?? '_'}`
}

export class SkillTaskRunRepository {
  private readonly sessionAbortSources = new Map<string, AbortController>()

  constructor(private readonly dbManager: SkillTaskRunDatabaseAccessor) {}

  registerSessionAbortController(
    scopeId: string | null,
    sessionId: string | null,
    controller: AbortController,
  ): void {
    this.sessionAbortSources.set(sessionAbortKey(scopeId, sessionId), controller)
  }

  unregisterSessionAbortController(
    scopeId: string | null,
    sessionId: string | null,
    controller?: AbortController,
  ): void {
    const key = sessionAbortKey(scopeId, sessionId)
    if (controller && this.sessionAbortSources.get(key) !== controller) return
    this.sessionAbortSources.delete(key)
  }

  getSessionAbortSignal(scopeId: string | null, sessionId: string | null): AbortSignal | null {
    const exact = this.sessionAbortSources.get(sessionAbortKey(scopeId, sessionId))
    if (exact) return exact.signal
    if (sessionId) {
      const sessionScoped = this.sessionAbortSources.get(sessionAbortKey(sessionId, sessionId))
      if (sessionScoped) return sessionScoped.signal
      const sessionOnly = this.sessionAbortSources.get(sessionAbortKey(sessionId, null))
      if (sessionOnly) return sessionOnly.signal
    }
    return null
  }

  create(record: SkillTaskRunRecord): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')

    db.prepare(`
      INSERT INTO skill_task_runs (
        id, scope_id, session_id, agent, run_id, skill_id, skill_name, action, tool_name, run_kind,
        status, interaction_state, goal_text, resource_refs_json, params_json, steps_json, current_step_id,
        artifacts_json, output_dir, run_state_path, scene_scores_path, delivery_report_path, failure_kind,
        failure_detail, job_id, detached_task_id, resume_payload_json, created_at, started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.scopeId ?? null,
      record.sessionId ?? null,
      record.agent ?? null,
      record.runId ?? null,
      record.skillId,
      record.skillName ?? null,
      record.action,
      record.toolName ?? null,
      record.runKind,
      record.status,
      record.interactionState,
      record.goalText ?? null,
      jsonOrNull(record.resourceRefs || []),
      jsonOrNull(record.params || null),
      JSON.stringify(record.steps || []),
      record.currentStepId ?? null,
      JSON.stringify(record.artifacts || []),
      record.outputDir ?? null,
      record.runStatePath ?? null,
      record.sceneScoresPath ?? null,
      record.deliveryReportPath ?? null,
      record.failureKind ?? null,
      record.failureDetail ?? null,
      record.jobId ?? null,
      record.detachedTaskId ?? null,
      jsonOrNull(record.resumePayload || null),
      record.createdAt,
      record.startedAt ?? null,
      record.updatedAt,
      record.finishedAt ?? null,
    )
  }

  /**
   * Stage 6 L1 contract: status (and the derived `finishedAt`) are managed
   * exclusively by `createChildRun` / `updateChildRun`. Public `update` callers
   * may not touch either field — the type system narrows the patch shape and
   * a runtime guard catches any dynamic abuse (e.g. test fakes that bypass TS).
   */
  update(id: string, patch: NoStatusUpdatePatch): void {
    if ('status' in patch || 'finishedAt' in patch) {
      throw new Error(
        'SkillTaskRunRepository.update cannot mutate status/finishedAt; use updateChildRun()',
      )
    }
    this.updateRowInternal(id, patch, { allowStatus: false })
  }

  /**
   * Stage 6 L1 contract: in addition to `createChildRun` / `updateChildRun`,
   * `updateRowSync` is a sanctioned status writer used by `skill-task-tracker.ts`
   * to mirror lifecycle events into `skill_task_runs` rows that are not backed
   * by a `SkillChildRunPayload`. The L1 CI gate (`check-ledger-writer-funnel.cjs`)
   * whitelists this method by name and confines its callers to the tracker
   * file plus this repository's own `updateChildRun` indirection.
   */
  updateRowSync(id: string, patch: Partial<SkillTaskRunRecord>): void {
    this.updateRowInternal(id, patch, { allowStatus: true })
  }

  private updateRowInternal(
    id: string,
    patch: Partial<SkillTaskRunRecord>,
    opts: { allowStatus: boolean },
  ): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')

    const updates: Array<[string, unknown]> = []
    const assign = (column: string, value: unknown): void => {
      updates.push([column, value ?? null])
    }

    if ('scopeId' in patch) assign('scope_id', patch.scopeId)
    if ('sessionId' in patch) assign('session_id', patch.sessionId)
    if ('agent' in patch) assign('agent', patch.agent)
    if ('runId' in patch) assign('run_id', patch.runId)
    if ('skillId' in patch) assign('skill_id', patch.skillId)
    if ('skillName' in patch) assign('skill_name', patch.skillName)
    if ('action' in patch) assign('action', patch.action)
    if ('toolName' in patch) assign('tool_name', patch.toolName)
    if ('runKind' in patch) assign('run_kind', patch.runKind)
    if (opts.allowStatus && 'status' in patch) assign('status', patch.status)
    if ('interactionState' in patch) assign('interaction_state', patch.interactionState)
    if ('goalText' in patch) assign('goal_text', patch.goalText)
    if ('resourceRefs' in patch) assign('resource_refs_json', jsonOrNull(patch.resourceRefs || []))
    if ('params' in patch) assign('params_json', jsonOrNull(patch.params || null))
    if ('steps' in patch) assign('steps_json', JSON.stringify(patch.steps || []))
    if ('currentStepId' in patch) assign('current_step_id', patch.currentStepId)
    if ('artifacts' in patch) assign('artifacts_json', JSON.stringify(patch.artifacts || []))
    if ('outputDir' in patch) assign('output_dir', patch.outputDir)
    if ('runStatePath' in patch) assign('run_state_path', patch.runStatePath)
    if ('sceneScoresPath' in patch) assign('scene_scores_path', patch.sceneScoresPath)
    if ('deliveryReportPath' in patch) assign('delivery_report_path', patch.deliveryReportPath)
    if ('failureKind' in patch) assign('failure_kind', patch.failureKind)
    if ('failureDetail' in patch) assign('failure_detail', patch.failureDetail)
    if ('jobId' in patch) assign('job_id', patch.jobId)
    if ('detachedTaskId' in patch) assign('detached_task_id', patch.detachedTaskId)
    if ('resumePayload' in patch) assign('resume_payload_json', jsonOrNull(patch.resumePayload || null))
    if ('createdAt' in patch) assign('created_at', patch.createdAt)
    if ('startedAt' in patch) assign('started_at', patch.startedAt)
    if ('updatedAt' in patch) assign('updated_at', patch.updatedAt)
    if (opts.allowStatus && 'finishedAt' in patch) assign('finished_at', patch.finishedAt)

    if (updates.length === 0) return

    const setClause = updates.map(([column]) => `${column} = ?`).join(', ')
    db.prepare(`UPDATE skill_task_runs SET ${setClause} WHERE id = ?`).run(
      ...updates.map(([, value]) => value),
      id,
    )
  }

  get(id: string): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ? LIMIT 1').get<SkillTaskRunRow>(id)
    return row ? this.mapRow(row) : null
  }

  listByScope(scopeId: string, limit = 50): SkillTaskRunRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE scope_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all<SkillTaskRunRow>(scopeId, limit).map((row) => this.mapRow(row))
  }

  listActiveBySession(sessionId: string, limit = 20): SkillTaskRunRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE session_id = ?
        AND status IN ('queued', 'running', 'blocked')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all<SkillTaskRunRow>(sessionId, limit).map((row) => this.mapRow(row))
  }

  findLatestRecoverable(params: {
    sessionId?: string | null
    scopeId?: string | null
    skillId?: string | null
    includeDone?: boolean
  }): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const filters: string[] = []
    const values: unknown[] = []
    if (params.sessionId) {
      filters.push('session_id = ?')
      values.push(params.sessionId)
    }
    if (params.scopeId) {
      filters.push('scope_id = ?')
      values.push(params.scopeId)
    }
    if (params.skillId) {
      filters.push('skill_id = ?')
      values.push(params.skillId)
    }
    const query = (statuses: string): SkillTaskRunRow | undefined => {
      const scopedFilters = [...filters, `status IN (${statuses})`]
      const where = scopedFilters.length > 0 ? `WHERE ${scopedFilters.join(' AND ')}` : ''
      return db.prepare(`
        SELECT * FROM skill_task_runs
        ${where}
        ORDER BY updated_at DESC
        LIMIT 1
      `).get<SkillTaskRunRow>(...values)
    }
    const row = params.includeDone
      ? query("'running', 'blocked'") || query("'failed', 'done'")
      : query("'running', 'blocked', 'failed'")
    return row ? this.mapRow(row) : null
  }

  findByDetachedTaskId(detachedTaskId: string): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const row = db.prepare(
      'SELECT * FROM skill_task_runs WHERE detached_task_id = ? ORDER BY updated_at DESC LIMIT 1',
    ).get<SkillTaskRunRow>(detachedTaskId)
    return row ? this.mapRow(row) : null
  }

  /**
   * Phase 4 — insert a new child-run row whose `id` is the child-run id and
   * whose `resumePayload.childRun` carries the versioned payload. The legacy
   * status column is set to a coarse projection of the child status so the
   * existing active-row filters keep working.
   */
  createChildRun(input: CreateChildRunInput): SkillTaskRunRecord {
    const status: SkillChildRunStatus = input.status || 'queued'
    const nowIso = new Date().toISOString()
    const payload: SkillChildRunPayload = {
      version: 1,
      childRunId: input.childRunId,
      // Phase 4 only mints VEA child runs in practice, but the payload's
      // `kind` is best-effort derived from the id prefix to stay consistent
      // with `getSkillChildRunKind` without forcing callers to repeat it.
      kind: (input.childRunId.charAt(0) === 'v'
        ? 'vea'
        : input.childRunId.charAt(0) === 's'
          ? 'skill'
          : 'detached'),
      parentScopeId: input.scopeId,
      parentSessionId: input.sessionId,
      skillId: input.skillId,
      skillName: input.skillName,
      requestedAction: input.action,
      requestedInput: input.requestedInput,
      singleFlightKey: input.singleFlightKey,
      parentNextHint: input.parentNextHint,
      outputDir: input.outputDir,
      runStatePath: input.runStatePath,
      eventLogPath: input.eventLogPath,
      status,
      closeEvent: null,
    }

    const record: SkillTaskRunRecord = {
      id: input.childRunId,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      agent: null,
      runId: null,
      skillId: input.skillId,
      skillName: input.skillName,
      action: input.action,
      toolName: null,
      runKind: 'child_run',
      status: mapChildStatusToRowStatus(status),
      interactionState: 'running',
      goalText: null,
      resourceRefs: [],
      params: input.requestedInput,
      steps: [],
      currentStepId: null,
      artifacts: [],
      outputDir: input.outputDir,
      runStatePath: input.runStatePath,
      sceneScoresPath: null,
      deliveryReportPath: null,
      failureKind: null,
      failureDetail: null,
      jobId: null,
      detachedTaskId: null,
      resumePayload: { childRun: payload as unknown as Record<string, unknown> },
      createdAt: nowIso,
      startedAt: null,
      updatedAt: nowIso,
      finishedAt: null,
    }

    this.create(record)
    return record
  }

  /**
   * Phase 4 — patch the child-run payload. Reads the row, merges the patch
   * into `resumePayload.childRun`, mirrors `status` to the row column when
   * provided, and writes back via the existing `update` path.
   */
  updateChildRun(childRunId: string, patch: Partial<SkillChildRunPayload>): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const existing = this.get(childRunId)
    if (!existing) {
      throw new Error(`updateChildRun: no row for child-run id ${childRunId}`)
    }
    const currentPayload = (existing.resumePayload || {}) as Record<string, unknown>
    const currentChild = (currentPayload.childRun || {}) as Record<string, unknown>
    const nextChild = { ...currentChild, ...patch } as unknown as SkillChildRunPayload
    const nextResumePayload = { ...currentPayload, childRun: nextChild as unknown as Record<string, unknown> }
    const nowIso = new Date().toISOString()

    const updatePatch: Partial<SkillTaskRunRecord> = {
      resumePayload: nextResumePayload,
      updatedAt: nowIso,
    }

    if (patch.status !== undefined) {
      validateSkillChildRunTransition(currentChild.status, patch.status)
      updatePatch.status = mapChildStatusToRowStatus(patch.status)
      if (CHILD_RUN_TERMINAL_STATUSES.includes(patch.status)) {
        updatePatch.finishedAt = nowIso
      }
    }
    if (patch.outputDir !== undefined) updatePatch.outputDir = patch.outputDir
    if (patch.runStatePath !== undefined) updatePatch.runStatePath = patch.runStatePath

    this.updateRowInternal(childRunId, updatePatch, { allowStatus: true })
  }

  /**
   * Phase 4 — find the most recently updated in-flight row whose
   * `resumePayload.childRun.singleFlightKey` matches. Blocked rows remain
   * visible to task recovery, but they are not single-flight candidates:
   * after the blocker is repaired a later action must not be forced back
   * through the stale blocked lifecycle.
   */
  findLatestChildRunByKey(singleFlightKey: string): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const placeholders = CHILD_RUN_SINGLE_FLIGHT_STATUSES.map(() => '?').join(', ')
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE json_extract(resume_payload_json, '$.childRun.singleFlightKey') = ?
        AND json_extract(resume_payload_json, '$.childRun.status') IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(singleFlightKey, ...CHILD_RUN_SINGLE_FLIGHT_STATUSES)
    return row ? this.mapRow(row) : null
  }

  /**
   * T8 (B child-loop, wave 3) — exact-match lookup helpers used by
   * `loadSkillRunContract` to bind a contract to the EXACT child-run row
   * the request points at. Two children running the same skill against
   * different targets in one session must resolve to distinct rows; a
   * different-skill row sharing an outputDir must NEVER be attached.
   *
   * These helpers are exact identity lookups and intentionally include
   * terminal rows so contract rebuilding can recover the child-run id and
   * close event after completion.
   * The optional `skillId` narrows the result so callers never accidentally
   * attach a child whose skill differs from the contract request.
   */
  findChildRunByRunStatePath(opts: {
    runStatePath: string
    skillId?: string | null
  }): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const filters: string[] = ['run_state_path = ?']
    const values: unknown[] = [opts.runStatePath]
    if (opts.skillId) {
      filters.push('skill_id = ?')
      values.push(opts.skillId)
    }
    const where = filters.join(' AND ')
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(...values)
    return row ? this.mapRow(row) : null
  }

  findChildRunByOutputDir(opts: {
    outputDir: string
    skillId?: string | null
  }): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const filters: string[] = ['output_dir = ?']
    const values: unknown[] = [opts.outputDir]
    if (opts.skillId) {
      filters.push('skill_id = ?')
      values.push(opts.skillId)
    }
    const where = filters.join(' AND ')
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(...values)
    return row ? this.mapRow(row) : null
  }

  findChildRunBySingleFlightKey(opts: {
    singleFlightKey: string
    skillId?: string | null
  }): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const filters: string[] = [
      "json_extract(resume_payload_json, '$.childRun.singleFlightKey') = ?",
    ]
    const values: unknown[] = [opts.singleFlightKey]
    if (opts.skillId) {
      filters.push('skill_id = ?')
      values.push(opts.skillId)
    }
    const where = filters.join(' AND ')
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(...values)
    return row ? this.mapRow(row) : null
  }

  /**
   * Phase 4 — find the most recently updated ACTIVE child-run row for a
   * given `skillId` (optionally narrowed by session/scope). Mirrors the
   * status filter from `findLatestChildRunByKey`.
   */
  findLatestChildRunBySkill(opts: {
    sessionId?: string | null
    scopeId?: string | null
    skillId: string
  }): SkillTaskRunRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const filters: string[] = ['skill_id = ?']
    const values: unknown[] = [opts.skillId]
    if (opts.sessionId) {
      filters.push('session_id = ?')
      values.push(opts.sessionId)
    }
    if (opts.scopeId) {
      filters.push('scope_id = ?')
      values.push(opts.scopeId)
    }
    const placeholders = CHILD_RUN_ACTIVE_STATUSES.map(() => '?').join(', ')
    filters.push(`json_extract(resume_payload_json, '$.childRun.status') IN (${placeholders})`)
    const where = filters.join(' AND ')
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(...values, ...CHILD_RUN_ACTIVE_STATUSES)
    return row ? this.mapRow(row) : null
  }

  private mapRow(row: SkillTaskRunRow): SkillTaskRunRecord {
    return {
      id: row.id,
      scopeId: row.scope_id,
      sessionId: row.session_id,
      agent: row.agent,
      runId: row.run_id,
      skillId: row.skill_id,
      skillName: row.skill_name,
      action: row.action,
      toolName: row.tool_name,
      runKind: row.run_kind,
      status: row.status,
      interactionState: row.interaction_state,
      goalText: row.goal_text,
      resourceRefs: safeParse(row.resource_refs_json, []),
      params: safeParse(row.params_json, null),
      steps: safeParse(row.steps_json, []),
      currentStepId: row.current_step_id,
      artifacts: safeParse(row.artifacts_json, []),
      outputDir: row.output_dir,
      runStatePath: row.run_state_path,
      sceneScoresPath: row.scene_scores_path,
      deliveryReportPath: row.delivery_report_path,
      failureKind: row.failure_kind,
      failureDetail: row.failure_detail,
      jobId: row.job_id,
      detachedTaskId: row.detached_task_id,
      resumePayload: safeParse(row.resume_payload_json, null),
      createdAt: row.created_at,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    }
  }
}
