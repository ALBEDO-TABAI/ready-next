import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'

function row(overrides: Record<string, unknown>) {
  return {
    task_id: 'task-1',
    scope_id: 'scope-1',
    message_visibility_epoch: 0,
    run_id: 'run-1',
    parent_task_id: null,
    parent_step_id: null,
    task_type: 'short_task',
    module: 'agent',
    task_title: '任务',
    task_summary: '摘要',
    status: 'blocked',
    interaction_state: null,
    waiting_for: 'none',
    steps_json: '[]',
    current_step_id: null,
    budget_json: null,
    budget_usage_percent: null,
    budget_warning_level: null,
    recovery_history_json: '[]',
    degradation_reason: null,
    blocked_reason: null,
    resumable_actions_json: '[]',
    continuation_ref_json: null,
    progress_json: null,
    recent_artifacts_json: '[]',
    criteria_json: null,
    checkins_json: '[]',
    proof_refs_json: '[]',
    learning_refs_json: '[]',
    owner_agent_id: 'writer',
    packet_role: null,
    context_refs_json: '[]',
    created_at: '2026-06-19T00:00:00.000Z',
    updated_at: '2026-06-19T00:00:00.000Z',
    ...overrides,
  }
}

test('TaskProjectionRepository lists recent tasks by owner agent only', () => {
  const rows = [
    row({ task_id: 'old-writer', owner_agent_id: 'writer', updated_at: '2026-06-19T00:00:00.000Z' }),
    row({ task_id: 'new-writer', owner_agent_id: 'writer', updated_at: '2026-06-19T00:02:00.000Z' }),
    row({ task_id: 'editor-task', owner_agent_id: 'editor', updated_at: '2026-06-19T00:03:00.000Z' }),
    row({ task_id: 'unowned', owner_agent_id: null, updated_at: '2026-06-19T00:04:00.000Z' }),
  ]
  const repository = new TaskProjectionRepository({
    getRawDb() {
      return {
        prepare(sql: string) {
          if (sql.includes('WHERE projection.owner_agent_id = ?')) {
            return {
              run() {},
              get() { return undefined },
              all(ownerAgentId: string, limit: number) {
                return rows
                  .filter((item) => item.owner_agent_id === ownerAgentId)
                  .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
                  .slice(0, limit) as never[]
              },
            }
          }
          return {
            run() {},
            get() { return undefined },
            all() { return [] },
          }
        },
      }
    },
  })
  const listed = repository.listByOwnerAgent('writer', 1)
  assert.deepEqual(listed.map((item) => item.taskId), ['new-writer'])
  assert.equal(repository.listByOwnerAgent('', 10).length, 0)
})
