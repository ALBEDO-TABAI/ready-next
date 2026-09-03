import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RSSAutoRefreshScheduler,
  setupRSSAutoRefreshIPC,
  type RSSAutoRefreshFetchResult,
} from '../main/modules/rss-engine/auto-refresh-scheduler'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

interface ScheduledTask {
  delayMs: number
  callback: () => void
  cancelled: boolean
}

function createHarness(input?: {
  now?: number
  intervalMs?: number
  lastCompletedAt?: number | null
  fetchResult?: RSSAutoRefreshFetchResult
}) {
  let now = input?.now ?? 1_000
  let intervalMs = input?.intervalMs ?? 200
  let lastCompletedAt = input?.lastCompletedAt ?? null
  let fetchResult: RSSAutoRefreshFetchResult = input?.fetchResult ?? {
    success: true,
    data: { fetched: 2, message: 'Fetched 2 items' },
  }
  const scheduled: ScheduledTask[] = []
  const published: Array<ReturnType<RSSAutoRefreshScheduler['getSnapshot']>> = []
  let fetchCalls = 0

  const scheduler = new RSSAutoRefreshScheduler({
    now: () => now,
    readIntervalMs: () => intervalMs,
    readLastCompletedAt: () => lastCompletedAt,
    runFetchAll: async () => {
      fetchCalls += 1
      lastCompletedAt = now
      return fetchResult
    },
    schedule: (delayMs, callback) => {
      const task = { delayMs, callback, cancelled: false }
      scheduled.push(task)
      return task
    },
    cancel: (handle) => {
      ;(handle as ScheduledTask).cancelled = true
    },
    publish: (snapshot) => published.push(snapshot),
  })

  return {
    scheduler,
    scheduled,
    published,
    get fetchCalls() { return fetchCalls },
    setNow(value: number) { now = value },
    setIntervalMs(value: number) { intervalMs = value },
    setLastCompletedAt(value: number | null) { lastCompletedAt = value },
    setFetchResult(value: RSSAutoRefreshFetchResult) { fetchResult = value },
  }
}

test('cold start runs immediately when the last fetchAll is overdue', () => {
  const harness = createHarness({ now: 1_000, intervalMs: 200, lastCompletedAt: 700 })

  harness.scheduler.start()

  assert.equal(harness.scheduled.length, 1)
  assert.equal(harness.scheduled[0].delayMs, 0)
})

test('cold start waits only for the remaining interval when fetchAll is still fresh', () => {
  const harness = createHarness({ now: 1_000, intervalMs: 200, lastCompletedAt: 900 })

  harness.scheduler.start()

  assert.equal(harness.scheduled.length, 1)
  assert.equal(harness.scheduled[0].delayMs, 100)
})

test('manual mode schedules no background work', () => {
  const harness = createHarness({ intervalMs: 0, lastCompletedAt: 900 })

  harness.scheduler.start()

  assert.equal(harness.scheduled.length, 0)
  assert.equal(harness.scheduler.getSnapshot().nextRunAt, null)
})

test('setting changes cancel the old timer and immediately recompute the due time', () => {
  const harness = createHarness({ now: 1_000, intervalMs: 200, lastCompletedAt: 900 })
  harness.scheduler.start()

  harness.setIntervalMs(500)
  harness.scheduler.onSettingChanged()

  assert.equal(harness.scheduled[0].cancelled, true)
  assert.equal(harness.scheduled[1].delayMs, 400)
})

test('a completed manual fetchAll replaces the old timer using the latest completion time', () => {
  const harness = createHarness({ now: 1_000, intervalMs: 200, lastCompletedAt: 900 })
  harness.scheduler.start()

  harness.setLastCompletedAt(1_000)
  harness.scheduler.onFetchAllCompleted(
    new Date(1_000).toISOString(),
    { success: true, data: { fetched: 2, message: 'manual done' } },
  )

  assert.equal(harness.scheduled[0].cancelled, true)
  assert.equal(harness.scheduled[1].delayMs, 200)
  assert.equal(harness.scheduled.filter((task) => !task.cancelled).length, 1)
})

test('fetchAll completion callbacks during an automatic run do not create a second timer', async () => {
  const scheduled: ScheduledTask[] = []
  let scheduler: RSSAutoRefreshScheduler
  scheduler = new RSSAutoRefreshScheduler({
    now: () => 1_000,
    readIntervalMs: () => 200,
    readLastCompletedAt: () => null,
    runFetchAll: async () => {
      scheduler.onFetchAllCompleted(
        new Date(1_000).toISOString(),
        { success: true, data: { fetched: 1, message: 'done' } },
      )
      return { success: true, data: { fetched: 1, message: 'done' } }
    },
    schedule: (delayMs, callback) => {
      const task = { delayMs, callback, cancelled: false }
      scheduled.push(task)
      return task
    },
    cancel: (handle) => {
      ;(handle as ScheduledTask).cancelled = true
    },
    publish: () => undefined,
  })
  scheduler.start()

  await scheduled[0].callback()

  assert.equal(scheduled.length, 2)
  assert.equal(scheduled[1].cancelled, false)
  assert.equal(scheduled[1].delayMs, 200)
})

test('stop waits for an in-flight fetch and suppresses late scheduling and publishing', async () => {
  let resolveFetch: (() => void) | null = null
  const fetchDone = new Promise<void>((resolve) => {
    resolveFetch = resolve
  })
  const scheduled: ScheduledTask[] = []
  const published: unknown[] = []
  const scheduler = new RSSAutoRefreshScheduler({
    now: () => 1_000,
    readIntervalMs: () => 200,
    readLastCompletedAt: () => null,
    runFetchAll: async () => {
      await fetchDone
      return { success: true, data: { fetched: 1, message: 'done' } }
    },
    schedule: (delayMs, callback) => {
      const task = { delayMs, callback, cancelled: false }
      scheduled.push(task)
      return task
    },
    cancel: (handle) => {
      ;(handle as ScheduledTask).cancelled = true
    },
    publish: (snapshot) => published.push(snapshot),
  })
  scheduler.start()
  const running = scheduled[0].callback()
  const stopped = scheduler.stop()

  resolveFetch?.()
  await Promise.all([running, stopped])

  assert.equal(scheduled.length, 1)
  assert.equal(published.length, 0)
  assert.equal(scheduler.getSnapshot().running, false)
  assert.equal(scheduler.getSnapshot().nextRunAt, null)
})

test('partial fetch errors are published as completed with warnings', async () => {
  const harness = createHarness({
    intervalMs: 200,
    fetchResult: {
      success: true,
      data: {
        fetched: 3,
        message: 'Fetched 4 sources, 3 new items',
        errors: ['[Source A] HTTP 429'],
      },
    },
  })
  harness.scheduler.start()

  await harness.scheduled[0].callback()

  assert.equal(harness.fetchCalls, 1)
  assert.equal(harness.published.length, 1)
  assert.equal(harness.published[0].success, true)
  assert.equal(harness.published[0].status, 'completed_with_warnings')
  assert.deepEqual(harness.published[0].errors, ['[Source A] HTTP 429'])
  assert.equal(harness.scheduled[1].delayMs, 200)
})

test('success false is published with its error and remains visible in the snapshot', async () => {
  const harness = createHarness({
    fetchResult: { success: false, error: 'database unavailable' },
  })
  harness.scheduler.start()

  await harness.scheduled[0].callback()

  assert.equal(harness.published[0].success, false)
  assert.deepEqual(harness.published[0].errors, ['database unavailable'])
  assert.equal(harness.scheduler.getSnapshot().message, 'database unavailable')
})

test('a successful manual fetch replaces a stale automatic failure in the Main snapshot', async () => {
  const harness = createHarness({
    fetchResult: { success: false, error: 'temporary upstream failure' },
  })
  harness.scheduler.start()
  await harness.scheduled[0].callback()
  assert.equal(harness.scheduler.getSnapshot().success, false)

  harness.setNow(1_200)
  harness.setLastCompletedAt(1_200)
  harness.scheduler.onFetchAllCompleted(
    new Date(1_200).toISOString(),
    { success: true, data: { fetched: 4, message: 'manual refresh complete' } },
  )

  const snapshot = harness.scheduler.getSnapshot()
  assert.equal(snapshot.success, true)
  assert.equal(snapshot.completedAt, new Date(1_200).toISOString())
  assert.equal(snapshot.fetched, 4)
  assert.deepEqual(snapshot.errors, [])
  assert.equal(harness.scheduled[1].cancelled, true)
  assert.equal(harness.scheduled[2].cancelled, false)
  assert.equal(harness.scheduled[2].delayMs, 200)
})

test('the renderer status IPC returns the scheduler snapshot', async () => {
  let handler: ((event: IpcMainInvokeEvent) => unknown) | null = null
  const ipcMain = {
    removeHandler() {},
    handle(channel: string, nextHandler: (event: IpcMainInvokeEvent) => unknown) {
      assert.equal(channel, 'rss:autoRefreshStatus')
      handler = nextHandler
    },
  } as unknown as IpcMain
  const expected = {
    running: false,
    status: 'completed_with_warnings' as const,
    intervalMs: 60_000,
    nextRunAt: null,
    completedAt: '2026-07-13T04:00:00.000Z',
    success: false,
    fetched: 2,
    message: 'partial',
    errors: ['HTTP 429'],
  }

  setupRSSAutoRefreshIPC(ipcMain, () => expected)
  assert.ok(handler)
  const result = await handler({} as IpcMainInvokeEvent)

  assert.deepEqual(result, { success: true, mock: false, data: expected })
})
