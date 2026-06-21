import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { isTaskEventBridgeStatus, taskEventBridge, toBridgeStatus, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import type { BrowserCapabilityTaskStatus } from '../main/modules/browser-engine/capability-types'
import {
  __resetBackgroundTaskTerminalReminderForTests,
  __setPendingTaskEventDatabaseForTests,
  listPendingTaskEventsForTests,
  markPendingTaskEventConsumed,
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
    if (normalized.startsWith('SELECT id FROM pending_task_events')) {
      const consumedFilter = normalized.includes('AND consumed = 0')
      return {
        get: (taskRunId: unknown, like: unknown) => {
          const status = String(like).replace(/%/g, '').replace('"status":"', '').replace('"', '')
          const hit = this.rows.find((row) =>
            String(row.task_run_id) === String(taskRunId)
            && row.event_payload.includes(`"status":"${status}"`)
            && (!consumedFilter || row.consumed === 0))
          return hit ? { id: hit.id } : undefined
        },
        run: () => undefined,
        all: () => [],
      }
    }
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
    if (normalized.startsWith('UPDATE pending_task_events SET consumed = 1 WHERE id = ?')) {
      return {
        run: (id: unknown) => {
          const hit = this.rows.find((row) => row.id === Number(id))
          if (hit) hit.consumed = 1
        },
        get: () => undefined,
        all: () => [],
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

  it('maps persisted browser task statuses to bridge publish statuses explicitly', () => {
    const cases: Array<[BrowserCapabilityTaskStatus, ReturnType<typeof toBridgeStatus>]> = [
      ['queued', null],
      ['running', null],
      ['waiting_human', 'waiting_human'],
      ['paused', 'paused'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', null],
    ]

    for (const [status, expected] of cases) {
      assert.equal(toBridgeStatus(status), expected)
    }
    assert.equal(cases.some(([status]) => toBridgeStatus(status) === 'needs_attention'), false)
    assert.equal(isTaskEventBridgeStatus('needs_attention'), true)
    assert.equal(isTaskEventBridgeStatus('cancelled'), false)
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

  it('deduplicates repeated terminal taskId and status publishes', () => {
    const events: TaskEventBridgePayload[] = []
    taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-idempotent', status: 'failed' }
    taskEventBridge.publish(payload)
    taskEventBridge.publish(payload)

    assert.deepEqual(events, [payload])
  })

  it('allows re-enterable statuses through the bridge repeatedly', () => {
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const paused: TaskEventBridgePayload = { taskId: 'task-event-bridge-reentrant', status: 'paused' }
    const needsAttention: TaskEventBridgePayload = { taskId: 'task-event-bridge-reentrant', status: 'needs_attention' }
    taskEventBridge.publish(paused)
    taskEventBridge.publish(paused)
    taskEventBridge.publish(needsAttention)
    taskEventBridge.publish(needsAttention)
    unregister()

    assert.deepEqual(events, [paused, paused, needsAttention, needsAttention])
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

  it('allows a consumed paused event to be enqueued durably again', () => {
    __resetBackgroundTaskTerminalReminderForTests()
    const db = new PendingTaskEventMemoryDb()
    __setPendingTaskEventDatabaseForTests(db)

    const payload: TaskEventBridgePayload = {
      taskId: 'task-event-bridge-paused-reentry',
      status: 'paused',
      extra: {
        scopeId: 'scope-task-event-bridge-paused-reentry',
        summary: '后台任务等待继续',
      },
    }
    taskEventBridge.publish(payload)
    const firstRows = listPendingTaskEventsForTests()
    assert.equal(firstRows.length, 1)

    markPendingTaskEventConsumed(firstRows[0].id)
    taskEventBridge.publish(payload)

    const rows = listPendingTaskEventsForTests()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].consumed, 1)
    assert.equal(rows[1].consumed, 0)
    assert.deepEqual(JSON.parse(rows[1].eventPayload), payload)
  })
})
