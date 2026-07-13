import assert from 'node:assert/strict'
import test from 'node:test'

import { ScheduleCoordinator } from '../main/modules/scheduled-tasks/schedule-coordinator'
import type {
  CoordinatedOccurrence,
  CoordinatedSchedule,
  ScheduleCoordinatorRepository,
} from '../main/modules/scheduled-tasks/schedule-coordinator'
import { ScheduleClock } from '../main/modules/scheduled-tasks/schedule-clock'

function createHarness(input: { schedules: CoordinatedSchedule[]; recoverable?: CoordinatedOccurrence[]; now: string }) {
  const reconciliations: Parameters<ScheduleCoordinatorRepository['reconcile']>[0][] = []
  const queued: CoordinatedOccurrence[] = []
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = []
  const repository: ScheduleCoordinatorRepository = {
    listEnabled: () => input.schedules,
    listRecoverable: () => input.recoverable ?? [],
    reconcile: (payload) => {
      reconciliations.push(payload)
      return payload.occurrences.map((item) => ({
        id: `${payload.scheduleId}:${item.scheduledFor}`,
        scheduleId: payload.scheduleId,
        scheduledFor: item.scheduledFor,
        claimStatus: item.claimStatus,
      }))
    },
  }
  const clock = new ScheduleClock({
    now: () => Date.parse(input.now),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false }
      timers.push(timer)
      return timer as unknown as NodeJS.Timeout
    },
    clearTimer: (handle) => { (handle as unknown as { cancelled: boolean }).cancelled = true },
  })
  const coordinator = new ScheduleCoordinator({ repository, clock, now: () => input.now, enqueue: (item) => queued.push(item) })
  return { coordinator, reconciliations, queued, timers }
}

test('cold start recovers durable queued work and schedules the nearest future time without sidecar', async () => {
  const recoverable: CoordinatedOccurrence = { id: 'occ-recover', scheduleId: 'daily', scheduledFor: '2026-07-13T08:00:00Z', claimStatus: 'queued' }
  const harness = createHarness({
    now: '2026-07-13T10:00:00Z',
    recoverable: [recoverable],
    schedules: [{ id: 'daily', spec: { kind: 'calendar', frequency: 'daily', localTime: '12:00' }, timezone: 'UTC', nextRunAt: null, missedPolicy: 'coalesce_latest', claimedExecutionCount: 0 }],
  })
  await harness.coordinator.start()
  assert.equal(harness.queued[0].id, 'occ-recover')
  assert.equal(harness.reconciliations[0].nextRunAt, '2026-07-13T12:00:00Z')
  assert.equal(harness.timers[0].delay, 2 * 60 * 60 * 1000)
})

test('resume after sleep coalesces crossed intervals once through the repository idempotency boundary', async () => {
  const harness = createHarness({
    now: '2026-07-13T10:00:00Z',
    schedules: [{ id: 'interval', spec: { kind: 'interval', every: 60, unit: 'minute', anchorAt: '2026-07-13T00:00:00Z' }, timezone: 'UTC', nextRunAt: '2026-07-13T08:00:00Z', missedPolicy: 'coalesce_latest', claimedExecutionCount: 0 }],
  })
  await harness.coordinator.start()
  await harness.coordinator.reconcile('resume')
  assert.deepEqual(harness.reconciliations[0].occurrences.map((item) => item.claimStatus), ['skipped_coalesced', 'skipped_coalesced', 'queued'])
  assert.equal(harness.reconciliations[0].nextRunAt, '2026-07-13T11:00:00Z')
  assert.equal(harness.reconciliations[1].nextRunAt, '2026-07-13T11:00:00Z')
})

test('stop cancels the one-shot timer and prevents future scheduling', async () => {
  const harness = createHarness({
    now: '2026-07-13T10:00:00Z',
    schedules: [{ id: 'once', spec: { kind: 'once', localDate: '2026-07-13', localTime: '11:00' }, timezone: 'UTC', nextRunAt: null, missedPolicy: 'coalesce_latest', claimedExecutionCount: 0 }],
  })
  await harness.coordinator.start()
  harness.coordinator.stop()
  assert.equal(harness.timers[0].cancelled, true)
})

test('calendar count disables the schedule after the final claimed execution', async () => {
  const harness = createHarness({
    now: '2026-07-13T10:00:00Z',
    schedules: [{
      id: 'limited',
      spec: { kind: 'calendar', frequency: 'daily', localTime: '09:00', count: 2 },
      timezone: 'UTC',
      nextRunAt: '2026-07-13T09:00:00Z',
      missedPolicy: 'coalesce_latest',
      claimedExecutionCount: 1,
    }],
  })
  await harness.coordinator.start()
  assert.equal(harness.reconciliations[0].occurrences.filter((item) => item.claimStatus === 'queued').length, 1)
  assert.equal(harness.reconciliations[0].nextRunAt, null)
  assert.equal(harness.reconciliations[0].disableAfterReconcile, true)
})

test('a due one-time task is disabled only after its durable occurrence is claimed', async () => {
  const harness = createHarness({
    now: '2026-07-13T10:00:00Z',
    schedules: [{
      id: 'once',
      spec: { kind: 'once', localDate: '2026-07-13', localTime: '09:00' },
      timezone: 'UTC',
      nextRunAt: '2026-07-13T09:00:00Z',
      missedPolicy: 'coalesce_latest',
      claimedExecutionCount: 0,
    }],
  })

  await harness.coordinator.start()

  assert.equal(harness.reconciliations[0].occurrences[0]?.claimStatus, 'queued')
  assert.equal(harness.reconciliations[0].nextRunAt, null)
  assert.equal(harness.reconciliations[0].disableAfterReconcile, true)
  assert.equal(harness.queued.length, 1)
})

test('a reschedule requested during reconciliation is not lost', async () => {
  const now = '2026-07-13T10:00:00Z'
  let schedules: CoordinatedSchedule[] = [{
    id: 'old',
    spec: { kind: 'once', localDate: '2026-07-13', localTime: '12:00' },
    timezone: 'UTC',
    nextRunAt: null,
    missedPolicy: 'coalesce_latest',
    claimedExecutionCount: 0,
  }]
  const reconciliations: string[] = []
  let coordinator!: ScheduleCoordinator
  const clock = new ScheduleClock({
    now: () => Date.parse(now),
    setTimer: (() => ({}) as NodeJS.Timeout),
    clearTimer: () => {},
  })
  const repository: ScheduleCoordinatorRepository = {
    listEnabled: () => schedules,
    listRecoverable: () => [],
    reconcile: (payload) => {
      reconciliations.push(payload.scheduleId)
      if (payload.scheduleId === 'old' && reconciliations.length === 1) {
        schedules = [{
          id: 'new',
          spec: { kind: 'once', localDate: '2026-07-13', localTime: '11:00' },
          timezone: 'UTC',
          nextRunAt: null,
          missedPolicy: 'coalesce_latest',
          claimedExecutionCount: 0,
        }]
        void coordinator.reconcile('timer')
      }
      return []
    },
  }
  coordinator = new ScheduleCoordinator({ repository, clock, now: () => now, enqueue: () => {} })

  await coordinator.start()

  assert.deepEqual(reconciliations, ['old', 'new'])
})
