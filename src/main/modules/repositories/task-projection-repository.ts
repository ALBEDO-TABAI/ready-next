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
  task_type: TaskProjectionRecord['taskType']
  module: string
  status: TaskProjectionRecord['status']
  interaction_state: TaskProjectionRecord['interactionState']
  steps_json: string
  current_step_id: string | null
  budget_json: string | null
  budget_usage_percent: number | null
  recovery_history_json: string | null
  blocked_reason: string | null
  resumable_actions_json: string | null
  continuation_ref_json: string | null
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
        task_id, scope_id, run_id, task_type, module, status, interaction_state,
        steps_json, current_step_id, budget_json, budget_usage_percent,
        recovery_history_json, blocked_reason, resumable_actions_json,
        continuation_ref_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.scopeId,
      record.runId,
      record.taskType,
      record.module,
      record.status,
      record.interactionState,
      JSON.stringify(record.steps || []),
      record.currentStepId ?? null,
      record.budget ? JSON.stringify(record.budget) : null,
      record.budgetUsagePercent ?? null,
      record.recoveryHistory ? JSON.stringify(record.recoveryHistory) : null,
      record.blockedReason ?? null,
      record.resumableActions ? JSON.stringify(record.resumableActions) : null,
      record.continuationRef ? JSON.stringify(record.continuationRef) : null,
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
    if ('taskType' in patch) assign('task_type', patch.taskType)
    if ('module' in patch) assign('module', patch.module)
    if ('status' in patch) assign('status', patch.status)
    if ('interactionState' in patch) assign('interaction_state', patch.interactionState)
    if ('steps' in patch) assign('steps_json', JSON.stringify(patch.steps || []))
    if ('currentStepId' in patch) assign('current_step_id', patch.currentStepId)
    if ('budget' in patch) assign('budget_json', patch.budget ? JSON.stringify(patch.budget) : null)
    if ('budgetUsagePercent' in patch) assign('budget_usage_percent', patch.budgetUsagePercent)
    if ('recoveryHistory' in patch) assign('recovery_history_json', patch.recoveryHistory ? JSON.stringify(patch.recoveryHistory) : null)
    if ('blockedReason' in patch) assign('blocked_reason', patch.blockedReason)
    if ('resumableActions' in patch) assign('resumable_actions_json', patch.resumableActions ? JSON.stringify(patch.resumableActions) : null)
    if ('continuationRef' in patch) assign('continuation_ref_json', patch.continuationRef ? JSON.stringify(patch.continuationRef) : null)
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

  private mapRow(row: TaskProjectionRow): TaskProjectionRecord {
    return {
      taskId: row.task_id,
      scopeId: row.scope_id,
      runId: row.run_id,
      taskType: row.task_type,
      module: row.module,
      status: row.status,
      interactionState: row.interaction_state,
      steps: safeParse(row.steps_json, []),
      currentStepId: row.current_step_id ?? null,
      budget: safeParse(row.budget_json, null),
      budgetUsagePercent: row.budget_usage_percent ?? null,
      recoveryHistory: safeParse(row.recovery_history_json, []),
      blockedReason: row.blocked_reason ?? null,
      resumableActions: safeParse(row.resumable_actions_json, []),
      continuationRef: safeParse(row.continuation_ref_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
