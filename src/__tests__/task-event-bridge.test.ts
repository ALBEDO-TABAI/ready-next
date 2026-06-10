import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { taskEventBridge, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import {
  __resetBackgroundTaskTerminalReminderForTests,
  __setPendingTaskEventDatabaseForTests,
  listPendingTaskEventsForTests,
  type PendingTaskEventDatabase,
} from '../main/modules/agent-control/system-reminders/background-task-terminal-reminder'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('task-event-bridge declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'task-event-bridge transitive sqlite load')
})


interface PendingRow {
  id: number
  event_payload: string
  task_run_id: string | null
  created_at: number
  consumed: number
}

class PendingTaskEventMemoryDb implements PendingTaskEventDatabase {
  readonly rows: PendingRow[] = []
  private nextId = 1

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO pending_task_events')) {
      return {
        run: (eventPayload: unknown, taskRunId: unknown, createdAt: unknown) => {
          this.rows.push({
            id: this.nextId++,
            event_payload: String(eventPayload),
            task_run_id: taskRunId == null ? null : String(taskRunId),
            created_at: Number(createdAt),
            consumed: 0,
          })
          return { lastInsertRowid: this.rows[this.rows.length - 1].id }
        },
        get: () => undefined,
        all: () => [],
      }
    }
    if (normalized.startsWith('SELECT id, event_payload, task_run_id, created_at, consumed FROM pending_task_events ORDER BY')) {
      return {
        all: () => [...this.rows].sort((left, right) => left.id - right.id),
        run: () => undefined,
        get: () => undefined,
      }
    }
    throw new Error(`unexpected pending_task_events SQL: ${normalized}`)
  }
}

describe('task event bridge', () => {
  it('exports a singleton bridge', () => {
    assert.equal(typeof taskEventBridge.publish, 'function')
    assert.equal(typeof taskEventBridge.scheduleTask, 'function')
  })

  it('publishes events to registered consumers', () => {
    const projectionEvents: TaskEventBridgePayload[] = []
    const agentEvents: TaskEventBridgePayload[] = []
    taskEventBridge.registerProjectionSink((payload) => projectionEvents.push(payload))
    taskEventBridge.registerAgentNotifier((payload) => agentEvents.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-consumers', status: 'completed', extra: { ok: true } }
    taskEventBridge.publish(payload)

    assert.deepEqual(projectionEvents, [payload])
    assert.deepEqual(agentEvents, [payload])
  })

  it('deduplicates repeated taskId and status publishes', () => {
    const events: TaskEventBridgePayload[] = []
    taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-idempotent', status: 'failed' }
    taskEventBridge.publish(payload)
    taskEventBridge.publish(payload)

    assert.deepEqual(events, [payload])
  })

  it('throws when scheduling a task for an unregistered route', () => {
    assert.throws(
      () => taskEventBridge.scheduleTask('task-event-bridge-missing-route', 'missing-route'),
      /missing-route/,
    )
  })

  it('stores terminal events in pending_task_events when no active scope run can receive them', () => {
    __resetBackgroundTaskTerminalReminderForTests()
    const db = new PendingTaskEventMemoryDb()
    __setPendingTaskEventDatabaseForTests(db)

    const payload: TaskEventBridgePayload = {
      taskId: 'task-event-bridge-pending-no-active-run',
      status: 'completed',
      extra: {
        scopeId: 'scope-task-event-bridge-pending',
        summary: '后台任务已完成',
      },
    }
    taskEventBridge.publish(payload)

    const rows = listPendingTaskEventsForTests()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].taskRunId, payload.taskId)
    assert.equal(rows[0].consumed, 0)
    assert.deepEqual(JSON.parse(rows[0].eventPayload), payload)
  })
})
