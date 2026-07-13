import assert from 'node:assert/strict'
import test from 'node:test'

import { FrozenCallStore, type FrozenCallDb } from '../main/modules/agent-control/safety/frozen-call-store'
import { recoverScheduledOccurrenceAfterRestart } from '../main/modules/scheduled-tasks/schedule-recovery'
import type { ScheduledTaskOccurrence } from '../main/modules/scheduled-tasks/schedule-repository'

const occurrence: ScheduledTaskOccurrence = {
  id: 'occ-crashed', scheduleId: 'schedule-crashed', scheduledFor: '2026-07-13T09:00:00Z',
  triggeredAt: '2026-07-13T09:00:01Z', triggerSource: 'timer', claimStatus: 'dispatching', attempt: 1,
  runId: 'run-scheduled-occ-crashed', taskId: 'task-scheduled-occ-crashed', delayMs: 1000,
  startedAt: '2026-07-13T09:00:01Z', finishedAt: null, errorKind: null, errorMessage: null,
  createdAt: '2026-07-13T09:00:01Z', updatedAt: '2026-07-13T09:00:01Z',
}

test('a force-quit while dispatching becomes interrupted on restart and is never re-enqueued', () => {
  const events: string[] = []
  const result = recoverScheduledOccurrenceAfterRestart(occurrence, {
    markInterrupted: (item) => events.push(`interrupted:${item.id}:interrupted_restart`),
    enqueue: (item) => events.push(`queued:${item.id}`),
  })

  assert.equal(result, 'interrupted')
  assert.deepEqual(events, ['interrupted:occ-crashed:interrupted_restart'])
})

test('a queued occurrence survives restart and is re-enqueued exactly once', () => {
  const events: string[] = []
  const queued = { ...occurrence, id: 'occ-queued', claimStatus: 'queued' as const, attempt: 0 }
  const result = recoverScheduledOccurrenceAfterRestart(queued, {
    markInterrupted: (item) => events.push(`interrupted:${item.id}`),
    enqueue: (item) => events.push(`queued:${item.id}`),
  })

  assert.equal(result, 'requeued')
  assert.deepEqual(events, ['queued:occ-queued'])
})

test('a scheduled high-risk confirmation left pending by a crash expires on restart', () => {
  const rows = new Map<string, { status: string; runId: string; taskId: string }>([[
    'confirmation-scheduled',
    { status: 'pending', runId: occurrence.runId!, taskId: occurrence.taskId! },
  ]])
  const db: FrozenCallDb = {
    prepare: (sql) => ({
      run: () => {
        if (/UPDATE pending_confirmations SET status = 'expired' WHERE status = 'pending'/i.test(sql)) {
          for (const row of rows.values()) if (row.status === 'pending') row.status = 'expired'
        }
      },
    }),
  }

  void new FrozenCallStore(db)

  assert.equal(rows.get('confirmation-scheduled')?.status, 'expired')
  assert.equal(rows.get('confirmation-scheduled')?.runId, 'run-scheduled-occ-crashed')
  assert.equal(rows.get('confirmation-scheduled')?.taskId, 'task-scheduled-occ-crashed')
})
