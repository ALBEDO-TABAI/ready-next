import type { TaskProjectionRecord, TaskProjectionStore } from '../agent-control/run-contracts'

interface TaskProjectionStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface TaskProjectionRawDatabase {
  prepare(sql: string): TaskProjectionStatement
}

interface TaskProjectionDatabaseAccessor {
  getRawDb(): TaskProjectionRawDatabase | null
}

interface TaskProjectionRow {
  task_id: string
  scope_id: string
  run_id: string
  parent_task_id: string | null
  parent_step_id: string | null
  task_type: TaskProjectionRecord['taskType']
  module: string
  task_title: string | null
  task_summary: string | null
  status: TaskProjectionRecord['status']
  interaction_state: TaskProjectionRecord['interactionState']
  steps_json: string
  current_step_id: string | null
  budget_json: string | null
  budget_usage_percent: number | null
  budget_warning_level: string | null
  recovery_history_json: string | null
  degradation_reason: string | null
  blocked_reason: string | null
  resumable_actions_json: string | null
  continuation_ref_json: string | null
  recent_artifacts_json: string | null
  created_at: string
  updated_at: string
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class TaskProjectionRepository implements TaskProjectionStore {
  constructor(private readonly dbManager: TaskProjectionDatabaseAccessor) {}

  create(record: TaskProjectionRecord): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')

    db.prepare(`
      INSERT INTO task_projections (
        task_id, scope_id, run_id, parent_task_id, parent_step_id, task_type, module, task_title, task_summary, status, interaction_state,
        steps_json, current_step_id, budget_json, budget_usage_percent, budget_warning_level,
        recovery_history_json, degradation_reason, blocked_reason, resumable_actions_json,
        continuation_ref_json, recent_artifacts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.scopeId,
      record.runId,
      record.parentTaskId ?? null,
      record.parentStepId ?? null,
      record.taskType,
      record.module,
      record.taskTitle ?? null,
      record.taskSummary ?? null,
      record.status,
      record.interactionState,
      JSON.stringify(record.steps || []),
      record.currentStepId ?? null,
      record.budget ? JSON.stringify(record.budget) : null,
      record.budgetUsagePercent ?? null,
      record.budgetWarningLevel ?? null,
      record.recoveryHistory ? JSON.stringify(record.recoveryHistory) : null,
      record.degradationReason ?? null,
      record.blockedReason ?? null,
      record.resumableActions ? JSON.stringify(record.resumableActions) : null,
      record.continuationRef ? JSON.stringify(record.continuationRef) : null,
      record.recentArtifacts ? JSON.stringify(record.recentArtifacts) : null,
      record.createdAt,
      record.updatedAt,
    )
  }

  update(taskId: string, patch: Partial<TaskProjectionRecord>): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')

    const updates: Array<[string, unknown]> = []
    const assign = (column: string, value: unknown): void => {
      updates.push([column, value ?? null])
    }

    if ('scopeId' in patch) assign('scope_id', patch.scopeId)
    if ('runId' in patch) assign('run_id', patch.runId)
    if ('parentTaskId' in patch) assign('parent_task_id', patch.parentTaskId)
    if ('parentStepId' in patch) assign('parent_step_id', patch.parentStepId)
    if ('taskType' in patch) assign('task_type', patch.taskType)
    if ('module' in patch) assign('module', patch.module)
    if ('taskTitle' in patch) assign('task_title', patch.taskTitle)
    if ('taskSummary' in patch) assign('task_summary', patch.taskSummary)
    if ('status' in patch) assign('status', patch.status)
    if ('interactionState' in patch) assign('interaction_state', patch.interactionState)
    if ('steps' in patch) assign('steps_json', JSON.stringify(patch.steps || []))
    if ('currentStepId' in patch) assign('current_step_id', patch.currentStepId)
    if ('budget' in patch) assign('budget_json', patch.budget ? JSON.stringify(patch.budget) : null)
    if ('budgetUsagePercent' in patch) assign('budget_usage_percent', patch.budgetUsagePercent)
    if ('budgetWarningLevel' in patch) assign('budget_warning_level', patch.budgetWarningLevel)
    if ('recoveryHistory' in patch) assign('recovery_history_json', patch.recoveryHistory ? JSON.stringify(patch.recoveryHistory) : null)
    if ('degradationReason' in patch) assign('degradation_reason', patch.degradationReason)
    if ('blockedReason' in patch) assign('blocked_reason', patch.blockedReason)
    if ('resumableActions' in patch) assign('resumable_actions_json', patch.resumableActions ? JSON.stringify(patch.resumableActions) : null)
    if ('continuationRef' in patch) assign('continuation_ref_json', patch.continuationRef ? JSON.stringify(patch.continuationRef) : null)
    if ('recentArtifacts' in patch) assign('recent_artifacts_json', patch.recentArtifacts ? JSON.stringify(patch.recentArtifacts) : null)
    if ('createdAt' in patch) assign('created_at', patch.createdAt)
    if ('updatedAt' in patch) assign('updated_at', patch.updatedAt)

    if (updates.length === 0) return

    const setClause = updates.map(([column]) => `${column} = ?`).join(', ')
    db.prepare(`UPDATE task_projections SET ${setClause} WHERE task_id = ?`).run(
      ...updates.map(([, value]) => value),
      taskId,
    )
  }

  get(taskId: string): TaskProjectionRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const row = db.prepare(
      'SELECT * FROM task_projections WHERE task_id = ? LIMIT 1',
    ).get<TaskProjectionRow>(taskId)
    return row ? this.mapRow(row) : null
  }

  listByScope(scopeId: string): TaskProjectionRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(
      'SELECT * FROM task_projections WHERE scope_id = ? ORDER BY updated_at DESC',
    ).all<TaskProjectionRow>(scopeId).map((row) => this.mapRow(row))
  }

  listByParentTask(parentTaskId: string): TaskProjectionRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(
      'SELECT * FROM task_projections WHERE parent_task_id = ? ORDER BY updated_at DESC',
    ).all<TaskProjectionRow>(parentTaskId).map((row) => this.mapRow(row))
  }

  deleteByScope(scopeId: string): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    db.prepare('DELETE FROM task_projections WHERE scope_id = ?').run(scopeId)
  }

  private mapRow(row: TaskProjectionRow): TaskProjectionRecord {
    return {
      taskId: row.task_id,
      scopeId: row.scope_id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id ?? null,
      parentStepId: row.parent_step_id ?? null,
      taskType: row.task_type,
      module: row.module,
      taskTitle: row.task_title ?? null,
      taskSummary: row.task_summary ?? null,
      status: row.status,
      interactionState: row.interaction_state,
      steps: safeParse(row.steps_json, []),
      currentStepId: row.current_step_id ?? null,
      budget: safeParse(row.budget_json, null),
      budgetUsagePercent: row.budget_usage_percent ?? null,
      budgetWarningLevel: (row.budget_warning_level || null) as TaskProjectionRecord['budgetWarningLevel'],
      recoveryHistory: safeParse(row.recovery_history_json, []),
      degradationReason: row.degradation_reason ?? null,
      blockedReason: row.blocked_reason ?? null,
      resumableActions: safeParse(row.resumable_actions_json, []),
      continuationRef: safeParse(row.continuation_ref_json, null),
      recentArtifacts: safeParse(row.recent_artifacts_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
