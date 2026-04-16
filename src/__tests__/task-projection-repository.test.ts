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
                  task_type: params[3],
                  module: params[4],
                  status: params[5],
                  interaction_state: params[6],
                  steps_json: params[7],
                  current_step_id: params[8],
                  budget_json: params[9],
                  budget_usage_percent: params[10],
                  recovery_history_json: params[11],
                  blocked_reason: params[12],
                  resumable_actions_json: params[13],
                  continuation_ref_json: params[14],
                  created_at: params[15],
                  updated_at: params[16],
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
    taskType: 'multi_step_task',
    module: 'browser',
    status: 'running',
    interactionState: 'running',
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
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  })

  repository.update('task-1', {
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    budgetUsagePercent: 70,
    blockedReason: '需要确认后继续',
    updatedAt: '2026-04-16T10:01:00.000Z',
  })

  const stored = await repository.get('task-1')
  const listed = await repository.listByScope('scope-1')

  assert.ok(stored)
  assert.equal(stored?.status, 'blocked')
  assert.equal(stored?.interactionState, 'awaiting_confirmation')
  assert.equal(stored?.budgetUsagePercent, 70)
  assert.equal(stored?.budget?.stepBudget?.remainingIterations, 12)
  assert.equal(stored?.recoveryHistory?.[0]?.kind, 'rate_limit')
  assert.equal(stored?.steps[0]?.status, 'running')
  assert.equal(stored?.blockedReason, '需要确认后继续')
  assert.equal(listed.length, 1)
})
