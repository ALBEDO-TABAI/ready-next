/**
 * Behavior tests for `sync-scheduler.ts`.
 *
 * Pure-logic tests — DI inject for clock, fetch, DB, scheduleAt so we
 * never touch sqlite, the network, or real setTimeout. The scheduler is
 * the unit under test; we exercise success path + every failure path +
 * the dedup / delete / re-arm semantics.
 *
 * §6.17 behavior-test discipline: every test calls the real scheduler
 * factory and asserts on observable side effects.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSyncScheduler,
  type SyncSchedulerHandle,
  type SyncResult,
} from '../main/modules/calendar-engine/sync-scheduler'
import type { ImportedEvent } from '../main/modules/calendar-engine/ics-importer'

// ----- helpers ----------------------------------------------------------

interface ScheduledCall {
  epochSec: number
  fn: () => void
  cancelled: boolean
}

function makeFakeScheduleAt(calls: ScheduledCall[]) {
  return (epochSec: number, fn: () => void): SyncSchedulerHandle => {
    const entry: ScheduledCall = { epochSec, fn, cancelled: false }
    calls.push(entry)
    return { cancel() { entry.cancelled = true } }
  }
}

/**
 * Build a fixture-friendly ImportedEvent. The sync scheduler doesn't
 * inspect most fields — it dedupes by `uid` and forwards everything
 * else to the host's `upsertImportedEvent` callback — so defaults are
 * fine for almost every test.
 */
function makeImported(uid: string, overrides: Partial<ImportedEvent> = {}): ImportedEvent {
  return {
    uid,
    title: `Title for ${uid}`,
    description: null,
    location: null,
    startTime: 1779497400,
    endTime: 1779501000,
    allDay: false,
    startTz: null,
    endTz: null,
    recurrenceRule: null,
    ...overrides,
  }
}

/**
 * Build a fixture ICS body containing one VEVENT per supplied event.
 * Real fetch returns ICS text, parser turns it into ImportedEvent[],
 * scheduler stores it. We avoid serializing every field — the real
 * parser is unit-tested elsewhere; here we just need the round-trip.
 */
function makeIcsBody(events: ImportedEvent[]): string {
  const parts = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Sync//EN']
  for (const e of events) {
    parts.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `SUMMARY:${e.title}`,
      // Use a fixed wall-clock so the test doesn't depend on what
      // unixSecondsFrom() returns. The scheduler doesn't compare event
      // times — only UIDs — so any valid stamp works.
      'DTSTART:20260517T010000Z',
      'DTEND:20260517T020000Z',
      'END:VEVENT',
    )
  }
  parts.push('END:VCALENDAR')
  return parts.join('\r\n')
}

// ----- syncOne success path ---------------------------------------------

test('syncOne success: creates rows for every UID and reports counts', async () => {
  const sources = [
    { id: 'src-A', sync_url: 'https://example.test/a.ics', sync_interval: 60 },
  ]
  const upserted: Array<{ sourceId: string; uid: string }> = []
  const deleted: Array<{ sourceId: string; uid: string }> = []
  const results: SyncResult[] = []
  const scheduledCalls: ScheduledCall[] = []
  const ics = makeIcsBody([makeImported('uid-1'), makeImported('uid-2')])

  const scheduler = createSyncScheduler({
    getSources: () => sources,
    fetchIcs: async () => ics,
    importedEventsFor: () => [],
    upsertImportedEvent: (sourceId, ev) => {
      upserted.push({ sourceId, uid: ev.uid })
      return { id: `synthetic-${ev.uid}`, action: 'created' }
    },
    deleteImportedEvent: (sourceId, uid) => {
      deleted.push({ sourceId, uid })
    },
    onSourceSynced: (r) => results.push(r),
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const result = await scheduler.syncOne('src-A')
  assert.equal(result.ok, true)
  assert.equal(result.error, null)
  assert.equal(result.eventsCreated, 2)
  assert.equal(result.eventsUpdated, 0)
  assert.equal(result.eventsRemoved, 0)
  assert.equal(upserted.length, 2)
  assert.equal(deleted.length, 0)
  assert.equal(results.length, 1)
  assert.equal(results[0].sourceId, 'src-A')
})

// ----- fetch failure -----------------------------------------------------

test('syncOne fetch failure: returns ok=false + non-null error without throwing', async () => {
  const scheduledCalls: ScheduledCall[] = []
  const scheduler = createSyncScheduler({
    getSources: () => [{ id: 'src-A', sync_url: 'https://example.test', sync_interval: 60 }],
    fetchIcs: async () => { throw new Error('connect ECONNREFUSED') },
    importedEventsFor: () => [],
    upsertImportedEvent: () => { throw new Error('should not be called') },
    deleteImportedEvent: () => { throw new Error('should not be called') },
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const result = await scheduler.syncOne('src-A')
  assert.equal(result.ok, false)
  assert.ok(result.error && /connect ECONNREFUSED/.test(result.error), 'error message propagated')
  assert.equal(result.eventsCreated, 0)
  assert.equal(result.eventsUpdated, 0)
})

// ----- parse failure -----------------------------------------------------

test('syncOne parse failure: returns ok=false + parse error string', async () => {
  const scheduledCalls: ScheduledCall[] = []
  const scheduler = createSyncScheduler({
    getSources: () => [{ id: 'src-A', sync_url: 'https://example.test', sync_interval: 60 }],
    fetchIcs: async () => 'NOT AN ICS FILE',
    importedEventsFor: () => [],
    upsertImportedEvent: () => { throw new Error('should not be called') },
    deleteImportedEvent: () => { throw new Error('should not be called') },
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const originalWarn = console.warn
  console.warn = () => { /* mute */ }
  try {
    const result = await scheduler.syncOne('src-A')
    assert.equal(result.ok, false)
    assert.ok(result.error && /parse failed/i.test(result.error), 'error message says parse')
  } finally {
    console.warn = originalWarn
  }
})

// ----- dedup: re-sync same UID → update branch --------------------------

test('syncOne dedup: second sync of same UID counts as updated, not created', async () => {
  const scheduledCalls: ScheduledCall[] = []
  // First call returns "created" then second returns "updated" to model
  // the deterministic-id branch in `upsertImportedEvent`.
  let upsertCount = 0
  const ics = makeIcsBody([makeImported('uid-stable')])

  const scheduler = createSyncScheduler({
    getSources: () => [{ id: 'src-A', sync_url: 'https://example.test', sync_interval: 60 }],
    fetchIcs: async () => ics,
    importedEventsFor: () => upsertCount === 0
      ? []
      : [{ uid: 'uid-stable', id: 'synthetic-uid-stable' }],
    upsertImportedEvent: () => {
      upsertCount += 1
      return {
        id: 'synthetic-uid-stable',
        action: upsertCount === 1 ? 'created' : 'updated',
      }
    },
    deleteImportedEvent: () => { /* no-op */ },
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const first = await scheduler.syncOne('src-A')
  assert.equal(first.eventsCreated, 1)
  assert.equal(first.eventsUpdated, 0)

  const second = await scheduler.syncOne('src-A')
  assert.equal(second.eventsCreated, 0)
  assert.equal(second.eventsUpdated, 1)
  assert.equal(second.eventsRemoved, 0)
})

// ----- delete: existing UID not in fetch ---------------------------------

test('syncOne delete: existing UID absent from fetch is dropped via deleteImportedEvent', async () => {
  const deleted: string[] = []
  const scheduledCalls: ScheduledCall[] = []
  // Existing rows include `uid-keep` (still in fetch) + `uid-gone`
  // (absent from fetch). The scheduler should keep the first and
  // delete the second.
  const ics = makeIcsBody([makeImported('uid-keep')])

  const scheduler = createSyncScheduler({
    getSources: () => [{ id: 'src-A', sync_url: 'https://example.test', sync_interval: 60 }],
    fetchIcs: async () => ics,
    importedEventsFor: () => [
      { uid: 'uid-keep', id: 'id-keep' },
      { uid: 'uid-gone', id: 'id-gone' },
    ],
    upsertImportedEvent: (_, ev) => ({ id: ev.uid, action: 'updated' }),
    deleteImportedEvent: (_, uid) => { deleted.push(uid) },
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const result = await scheduler.syncOne('src-A')
  assert.equal(result.eventsRemoved, 1)
  assert.deepEqual(deleted, ['uid-gone'])
})

// ----- syncAll -----------------------------------------------------------

test('syncAll: aggregates per-source ok/failed/totalEvents counts', async () => {
  const sources = [
    { id: 'ok-1', sync_url: 'https://ok-1.test', sync_interval: 60 },
    { id: 'fail-1', sync_url: 'https://fail-1.test', sync_interval: 60 },
    { id: 'no-url', sync_url: null, sync_interval: 60 },
  ]
  const scheduledCalls: ScheduledCall[] = []
  const okIcs = makeIcsBody([makeImported('a'), makeImported('b')])

  const scheduler = createSyncScheduler({
    getSources: () => sources,
    fetchIcs: async (url) => {
      if (/fail-1/.test(url)) throw new Error('boom')
      return okIcs
    },
    importedEventsFor: () => [],
    upsertImportedEvent: (_, ev) => ({ id: ev.uid, action: 'created' }),
    deleteImportedEvent: () => { /* no-op */ },
    now: () => 1779497400,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  const summary = await scheduler.syncAll()
  // 'no-url' is filtered out at the syncAll level (only URL-bearing
  // sources are visited), so ok=1, failed=1, total=2.
  assert.equal(summary.ok, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.totalEvents, 2)
})

// ----- startPeriodic + stop ---------------------------------------------

test('startPeriodic registers one timer per URL-bearing source, stop cancels all', () => {
  const sources = [
    { id: 'a', sync_url: 'https://a.test', sync_interval: 60 },
    { id: 'b', sync_url: 'https://b.test', sync_interval: 30 },
    { id: 'c', sync_url: null, sync_interval: 60 },
  ]
  const scheduledCalls: ScheduledCall[] = []
  const scheduler = createSyncScheduler({
    getSources: () => sources,
    fetchIcs: async () => '',
    importedEventsFor: () => [],
    upsertImportedEvent: (_, ev) => ({ id: ev.uid, action: 'created' }),
    deleteImportedEvent: () => { /* no-op */ },
    now: () => 1000,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  scheduler.startPeriodic()
  // Only a + b have sync_url, so we expect 2 registrations.
  assert.equal(scheduledCalls.length, 2)
  // Intervals: a=60min → +3600s ; b=30min → +1800s.
  const epochs = scheduledCalls.map((c) => c.epochSec).sort((x, y) => x - y)
  assert.deepEqual(epochs, [1000 + 1800, 1000 + 3600])

  scheduler.stop()
  for (const call of scheduledCalls) {
    assert.equal(call.cancelled, true, `timer for ${call.epochSec} cancelled`)
  }
})

test('startPeriodic floors interval at 5 minutes for rude configs', () => {
  const sources = [
    // sync_interval=1 minute is below the 5-minute floor; scheduler
    // should arm at +300s instead.
    { id: 'rude', sync_url: 'https://rude.test', sync_interval: 1 },
  ]
  const scheduledCalls: ScheduledCall[] = []
  const scheduler = createSyncScheduler({
    getSources: () => sources,
    fetchIcs: async () => '',
    importedEventsFor: () => [],
    upsertImportedEvent: (_, ev) => ({ id: ev.uid, action: 'created' }),
    deleteImportedEvent: () => { /* no-op */ },
    now: () => 0,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  scheduler.startPeriodic()
  assert.equal(scheduledCalls.length, 1)
  assert.equal(scheduledCalls[0].epochSec, 300)
})

// ----- source disappears between sync + re-arm --------------------------

test('stop is idempotent and prevents subsequent syncOne from doing work', async () => {
  const sources = [
    { id: 'a', sync_url: 'https://a.test', sync_interval: 60 },
  ]
  let fetchCalled = false
  const scheduledCalls: ScheduledCall[] = []
  const scheduler = createSyncScheduler({
    getSources: () => sources,
    fetchIcs: async () => { fetchCalled = true; return makeIcsBody([]) },
    importedEventsFor: () => [],
    upsertImportedEvent: (_, ev) => ({ id: ev.uid, action: 'created' }),
    deleteImportedEvent: () => { /* no-op */ },
    now: () => 0,
    scheduleAt: makeFakeScheduleAt(scheduledCalls),
  })

  scheduler.stop()
  scheduler.stop() // calling twice must not throw

  const result = await scheduler.syncOne('a')
  assert.equal(result.ok, false)
  assert.ok(result.error && /stopped/i.test(result.error), 'reports stopped')
  assert.equal(fetchCalled, false, 'fetch is not invoked after stop')
})
