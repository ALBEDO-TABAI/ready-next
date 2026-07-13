import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ScheduleDispatchQueue,
  type ScheduleDispatchQueueItem,
} from '../main/modules/scheduled-tasks/schedule-dispatch-queue'

function item(id: string, scheduleId: string, scopeId: string, scheduledFor: string): ScheduleDispatchQueueItem {
  return { occurrenceId: id, scheduleId, scopeId, scheduledFor }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('a busy scope keeps scheduled work queued until the foreground run releases it', async () => {
  let busy = true
  const dispatched: string[] = []
  const queue = new ScheduleDispatchQueue({
    isScopeBusy: () => busy,
    dispatch: async (entry) => { dispatched.push(entry.occurrenceId) },
    markSkippedCoalesced: () => {},
    onDispatchError: () => {},
  })

  await queue.enqueue(item('occ-1', 'schedule-1', 'scope-1', '2026-07-13T09:00:00.000Z'))
  assert.deepEqual(dispatched, [])
  assert.equal(queue.hasPending('scope-1'), true)

  busy = false
  await queue.drain('scope-1')
  assert.deepEqual(dispatched, ['occ-1'])
  assert.equal(queue.hasPending('scope-1'), false)
})

test('one scope dispatches serially and resumes with the earliest valid occurrence', async () => {
  let busy = true
  const dispatched: string[] = []
  const queue = new ScheduleDispatchQueue({
    isScopeBusy: () => busy,
    dispatch: async (entry) => { dispatched.push(entry.occurrenceId) },
    markSkippedCoalesced: () => {},
    onDispatchError: () => {},
  })

  await queue.enqueue(item('late', 'schedule-late', 'scope-1', '2026-07-13T11:00:00.000Z'))
  await queue.enqueue(item('early', 'schedule-early', 'scope-1', '2026-07-13T10:00:00.000Z'))
  busy = false
  await queue.drain('scope-1')

  assert.deepEqual(dispatched, ['early', 'late'])
})

test('a schedule has one active dispatch and coalesces queued occurrences to the latest', async () => {
  const firstDispatch = deferred()
  const dispatched: string[] = []
  const skipped: string[] = []
  const queue = new ScheduleDispatchQueue({
    isScopeBusy: () => false,
    dispatch: async (entry) => {
      dispatched.push(entry.occurrenceId)
      if (entry.occurrenceId === 'occ-1') await firstDispatch.promise
    },
    markSkippedCoalesced: (entry) => { skipped.push(entry.occurrenceId) },
    onDispatchError: () => {},
  })

  const running = queue.enqueue(item('occ-1', 'schedule-1', 'scope-1', '2026-07-13T09:00:00.000Z'))
  queue.enqueue(item('occ-2', 'schedule-1', 'scope-1', '2026-07-13T10:00:00.000Z'))
  queue.enqueue(item('occ-3', 'schedule-1', 'scope-1', '2026-07-13T11:00:00.000Z'))
  queue.enqueue(item('occ-old', 'schedule-1', 'scope-1', '2026-07-13T10:30:00.000Z'))

  assert.deepEqual(dispatched, ['occ-1'])
  assert.deepEqual(skipped, ['occ-2', 'occ-old'])
  firstDispatch.resolve()
  await running
  assert.deepEqual(dispatched, ['occ-1', 'occ-3'])
})

test('different scopes may dispatch independently', async () => {
  const scopeOne = deferred()
  const dispatched: string[] = []
  const queue = new ScheduleDispatchQueue({
    isScopeBusy: () => false,
    dispatch: async (entry) => {
      dispatched.push(entry.occurrenceId)
      if (entry.scopeId === 'scope-1') await scopeOne.promise
    },
    markSkippedCoalesced: () => {},
    onDispatchError: () => {},
  })

  const first = queue.enqueue(item('scope-1-occ', 'schedule-1', 'scope-1', '2026-07-13T09:00:00.000Z'))
  await queue.enqueue(item('scope-2-occ', 'schedule-2', 'scope-2', '2026-07-13T09:00:00.000Z'))
  assert.deepEqual(dispatched, ['scope-1-occ', 'scope-2-occ'])
  scopeOne.resolve()
  await first
})

test('a dispatch failure is reported and does not strand the next occurrence', async () => {
  let busy = true
  const dispatched: string[] = []
  const failed: string[] = []
  const queue = new ScheduleDispatchQueue({
    isScopeBusy: () => busy,
    dispatch: async (entry) => {
      dispatched.push(entry.occurrenceId)
      if (entry.occurrenceId === 'failed') throw new Error('dispatch failed')
    },
    markSkippedCoalesced: () => {},
    onDispatchError: (entry) => { failed.push(entry.occurrenceId) },
  })

  await queue.enqueue(item('after', 'schedule-2', 'scope-1', '2026-07-13T10:00:00.000Z'))
  await queue.enqueue(item('failed', 'schedule-1', 'scope-1', '2026-07-13T09:00:00.000Z'))
  busy = false
  await queue.drain('scope-1')

  assert.deepEqual(dispatched, ['failed', 'after'])
  assert.deepEqual(failed, ['failed'])
})
