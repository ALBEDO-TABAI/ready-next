import { randomUUID } from 'node:crypto'

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

export class SkillTaskRunRepository {
  constructor(private readonly dbManager: SkillTaskRunDatabaseAccessor) {}

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

  update(id: string, patch: Partial<SkillTaskRunRecord>): void {
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
    if ('status' in patch) assign('status', patch.status)
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
    if ('finishedAt' in patch) assign('finished_at', patch.finishedAt)

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
    const statuses = params.includeDone
      ? "'running', 'blocked', 'failed', 'done'"
      : "'running', 'blocked', 'failed'"
    filters.push(`status IN (${statuses})`)
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const row = db.prepare(`
      SELECT * FROM skill_task_runs
      ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SkillTaskRunRow>(...values)
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
