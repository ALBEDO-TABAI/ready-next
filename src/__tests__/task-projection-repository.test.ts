import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'

test('TaskProjectionRepository persists and updates structured task projection records', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const repository = new TaskProjectionRepository({
    getRawDb() {
      return {
        exec() {},
        close() {},
        prepare(sql: string) {
          if (sql.includes('INSERT INTO task_projections')) {
            return {
              run(...params: unknown[]) {
                rows.set(String(params[0]), {
                  task_id: params[0],
                  scope_id: params[1],
                  run_id: params[2],
                  parent_task_id: params[3],
                  parent_step_id: params[4],
                  task_type: params[5],
                  module: params[6],
                  task_title: params[7],
                  task_summary: params[8],
                  status: params[9],
                  interaction_state: params[10],
                  waiting_for: params[11],
                  steps_json: params[12],
                  current_step_id: params[13],
                  budget_json: params[14],
                  budget_usage_percent: params[15],
                  budget_warning_level: params[16],
                  recovery_history_json: params[17],
                  degradation_reason: params[18],
                  blocked_reason: params[19],
                  resumable_actions_json: params[20],
                  continuation_ref_json: params[21],
                  progress_json: params[22],
                  recent_artifacts_json: params[23],
                  created_at: params[24],
                  updated_at: params[25],
                })
                return { changes: 1 }
              },
              get() {
                return undefined
              },
              all() {
                return []
              },
            }
          }

          if (sql.startsWith('UPDATE task_projections SET')) {
            return {
              run(...params: unknown[]) {
                const taskId = String(params[params.length - 1])
                const current = rows.get(taskId)!
                const setClause = sql.slice('UPDATE task_projections SET '.length, sql.indexOf(' WHERE task_id = ?'))
                const columns = setClause.split(', ').map((item) => item.replace(' = ?', ''))
                columns.forEach((column, index) => {
                  current[column] = params[index]
                })
                rows.set(taskId, current)
                return { changes: 1 }
              },
              get() {
                return undefined
              },
              all() {
                return []
              },
            }
          }

          if (sql.includes('WHERE task_id = ? LIMIT 1')) {
            return {
              run() {
                return { changes: 0 }
              },
              get(taskId: string) {
                return rows.get(taskId) as any
              },
              all() {
                return []
              },
            }
          }

          return {
            run() {
              return { changes: 0 }
            },
            get() {
              return undefined
            },
            all(scopeId: string) {
              return Array.from(rows.values())
                .filter((row) => row.scope_id === scopeId)
                .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))) as any[]
            },
          }
        },
      } as any
    },
  } as any)

  repository.create({
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    taskType: 'multi_step_task',
    module: 'browser',
    taskTitle: '收集素材',
    taskSummary: '正在采集参考链接',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'input',
    steps: [
      {
        id: 'collect',
        description: '收集素材',
        status: 'running',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    currentStepId: 'collect',
    budget: {
      taskType: 'multi_step_task',
      maxIterations: 60,
      maxToolCalls: 60,
      maxParallelToolGroups: 5,
      stepBudget: {
        maxIterations: 20,
        remainingIterations: 12,
      },
    },
    budgetUsagePercent: 40,
    budgetWarningLevel: 'warning',
    recoveryHistory: [
      {
        kind: 'rate_limit',
        source: 'model_request',
        message: '429',
        attempt: 1,
        recovered: true,
        timestamp: '2026-04-16T10:00:01.000Z',
      },
    ],
    blockedReason: null,
    resumableActions: ['cancel'],
    continuationRef: null,
    progress: {
      label: '采集中',
      detail: '已采集 1 条',
      completed: 1,
      total: 3,
    },
    recentArtifacts: [
      {
        id: 'artifact-1',
        module: 'browser',
        kind: 'note',
        label: '采集记录',
        createdAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  } as any)

  repository.update('task-1', {
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    waitingFor: 'confirmation',
    budgetUsagePercent: 70,
    degradationReason: 'browser unavailable',
    blockedReason: '需要确认后继续',
    updatedAt: '2026-04-16T10:01:00.000Z',
  })

  const stored = await repository.get('task-1')
  const listed = await repository.listByScope('scope-1')

  assert.ok(stored)
  assert.equal(stored?.parentTaskId, 'parent-1')
  assert.equal(stored?.parentStepId, 'collect')
  assert.equal(stored?.taskTitle, '收集素材')
  assert.equal(stored?.taskSummary, '正在采集参考链接')
  assert.equal(stored?.status, 'blocked')
  assert.equal(stored?.interactionState, 'awaiting_confirmation')
  assert.equal(stored?.waitingFor, 'confirmation')
  assert.equal(stored?.budgetUsagePercent, 70)
  assert.equal(stored?.budgetWarningLevel, 'warning')
  assert.equal(stored?.budget?.stepBudget?.remainingIterations, 12)
  assert.equal(stored?.recoveryHistory?.[0]?.kind, 'rate_limit')
  assert.equal(stored?.degradationReason, 'browser unavailable')
  assert.equal(stored?.steps[0]?.status, 'running')
  assert.equal(stored?.blockedReason, '需要确认后继续')
  assert.equal(stored?.progress?.label, '采集中')
  assert.equal(stored?.recentArtifacts?.[0]?.label, '采集记录')
  assert.equal(listed.length, 1)
})

test('TaskProjectionRepository supports child-task lookup by parent task id', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const repository = new TaskProjectionRepository({
    getRawDb() {
      return {
        exec() {},
        close() {},
        prepare(sql: string) {
          if (sql.includes('INSERT INTO task_projections')) {
            return {
              run(...params: unknown[]) {
                rows.set(String(params[0]), {
                  task_id: params[0],
                  scope_id: params[1],
                  run_id: params[2],
                  parent_task_id: params[3],
                  parent_step_id: params[4],
                  task_type: params[5],
                  module: params[6],
                  task_title: params[7],
                  task_summary: params[8],
                  status: params[9],
                  interaction_state: params[10],
                  waiting_for: params[11],
                  steps_json: params[12],
                  current_step_id: params[13],
                  budget_json: params[14],
                  budget_usage_percent: params[15],
                  budget_warning_level: params[16],
                  recovery_history_json: params[17],
                  degradation_reason: params[18],
                  blocked_reason: params[19],
                  resumable_actions_json: params[20],
                  continuation_ref_json: params[21],
                  progress_json: params[22],
                  recent_artifacts_json: params[23],
                  created_at: params[24],
                  updated_at: params[25],
                })
                return { changes: 1 }
              },
              get() {
                return undefined
              },
              all(parentTaskId: string) {
                return Array.from(rows.values())
                  .filter((row) => row.parent_task_id === parentTaskId) as any[]
              },
            }
          }

          return {
            run() {
              return { changes: 0 }
            },
            get() {
              return undefined
            },
            all(parentTaskId: string) {
              return Array.from(rows.values())
                .filter((row) => row.parent_task_id === parentTaskId) as any[]
            },
          }
        },
      } as any
    },
  } as any)

  repository.create({
    taskId: 'child-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    taskType: 'direct_answer',
    module: 'document',
    taskTitle: '整理引用',
    taskSummary: '已整理 3 条引用',
    status: 'done',
    interactionState: 'running',
    steps: [],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  } as any)

  repository.create({
    taskId: 'child-2',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    taskType: 'direct_answer',
    module: 'document',
    taskTitle: '补充事实',
    taskSummary: '已补充背景',
    status: 'done',
    interactionState: 'running',
    steps: [],
    createdAt: '2026-04-16T10:01:00.000Z',
    updatedAt: '2026-04-16T10:01:00.000Z',
  } as any)

  const listByParentTask = (repository as any).listByParentTask?.bind(repository)
  assert.equal(typeof listByParentTask, 'function')

  const children = await listByParentTask('parent-1')
  assert.equal(children.length, 2)
  assert.equal(children[0]?.parentTaskId, 'parent-1')
})
