import assert from 'node:assert/strict'
import test from 'node:test'

import { persistableCalendarEventId } from '../shared/calendar-event-identity'
import {
  createProductionProductActionHandlers,
} from '../main/modules/agent-control/codex-runtime/codex-product-action-handlers'
import { CodexProductActionError } from '../main/modules/agent-control/codex-runtime/codex-product-action-requester'
import type { DatabaseManager } from '../main/modules/database'
import { flatDomainStores } from './helpers/flat-domain-stores'

function fakeDb(overrides?: Record<string, unknown>): DatabaseManager {
  const events = new Map<string, Record<string, unknown>>()
  const base = {
    getRSSStats: () => ({ totalItems: 3, unreadItems: 1 }),
    getRSSSources: () => [{ id: 'src-1', name: '科技' }],
    getRSSItemsByIds: (ids: string[]) => ids.includes('item-1')
      ? [{ id: 'item-1', source_id: 'src-1', title: '标题', link: 'https://example.com', summary: '摘要' }]
      : [],
    getNonRecurringEventsInWindow: () => [],
    getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    getCalendarSources: () => [{ id: 'cal-1' }],
    createCalendarEvent: (input: Record<string, unknown>) => {
      const id = 'event-created'
      events.set(id, { id, ...input })
      return id
    },
    getCalendarEventById: (id: string) => events.get(id) || null,
    updateCalendarEvent: (id: string, updates: Record<string, unknown>) => {
      const current = events.get(id)
      if (current) events.set(id, { ...current, ...updates })
    },
    deleteCalendarEvent: (id: string) => { events.delete(id) },
    ...overrides,
  }
  return flatDomainStores(base) as unknown as DatabaseManager
}

function handlers(overrides?: {
  db?: DatabaseManager
  rss?: Partial<Parameters<typeof createProductionProductActionHandlers>[0]['rss']>
  renderer?: (payload: { tool: string }) => Promise<Record<string, unknown>>
  targets?: Parameters<typeof createProductionProductActionHandlers>[0]['targets']
  listed?: string[]
}) {
  const rendererCalls: string[] = []
  const listed: string[] = [...(overrides?.listed || [])]
  const dispatch = createProductionProductActionHandlers({
    database: overrides?.db || fakeDb(),
    rss: {
      async fetchUpdates() {
        return { success: true, data: { fetched: 2, errors: [] } }
      },
      async addSource() {
        return { ok: true, data: { id: 'src-new' } }
      },
      async analyzeItem() {
        return { ok: true, summary: '分析已启动', status: 'queued' }
      },
      ...overrides?.rss,
    },
    requestRendererToolAction: async (payload) => {
      rendererCalls.push(payload.tool)
      if (overrides?.renderer) return overrides.renderer(payload)
      return { ok: true, summary: payload.tool }
    },
    targets: overrides?.targets,
    sessionId: 'session',
    runId: 'run',
    codexThreadId: 'thread',
    codexTurnId: 'turn',
    codexCallId: 'call',
    readyActionId: 'action',
    actionIdentityDigest: 'digest',
    abortSignal: new AbortController().signal,
    recordListedCalendarEventIds: (ids) => {
      listed.splice(0, listed.length, ...ids)
    },
    listedCalendarEventIds: () => listed,
  }).dispatch
  return { dispatch, rendererCalls, listed }
}

test('calendar create notifies the scheduler hook after durable write', async () => {
  const mutated: string[] = []
  const renderer: string[] = []
  const created = await createProductionProductActionHandlers({
    database: fakeDb(),
    rss: {
      async fetchUpdates() { return { success: true, data: {} } },
      async addSource() { return { ok: true } },
      async analyzeItem() { return { ok: true } },
    },
    requestRendererToolAction: async (payload) => {
      renderer.push(payload.tool)
      return { ok: true }
    },
    onCalendarMutated: (eventId) => { mutated.push(eventId) },
    sessionId: 's',
    runId: 'r',
    codexThreadId: 't',
    codexTurnId: 'u',
    codexCallId: 'c',
    readyActionId: 'a',
    actionIdentityDigest: 'd',
    abortSignal: new AbortController().signal,
  }).dispatch('calendar.createEvent', {
    title: '会',
    startTime: '2026-08-15T13:00:00Z',
    endTime: '2026-08-15T14:00:00Z',
  })
  assert.equal(created.ok, true)
  assert.deepEqual(mutated, ['event-created'])
  assert.deepEqual(renderer, ['calendar.reloadWindow'])
})

test('in-flight RSS fetch is not a completed refresh', async () => {
  const { dispatch } = handlers({
    rss: {
      async fetchUpdates() {
        return { success: true, data: { fetched: 1, running: true } }
      },
    },
  })
  const result = await dispatch('rss.fetchUpdates', {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'rss_fetch_in_progress')
})

test('rss.analyzeItem stays on Main and does not call the renderer bridge', async () => {
  let analyzed = 0
  const { dispatch, rendererCalls } = handlers({
    targets: { rssItemId: 'item-1' },
    rss: {
      async analyzeItem(input) {
        analyzed += 1
        assert.equal(input.itemId, 'item-1')
        assert.equal(input.analysisType, 'copy')
        return { ok: true, summary: '分析已启动', status: 'queued' }
      },
    },
  })
  const result = await dispatch('rss.analyzeItem', { analysisType: 'copy' })
  assert.equal(result.ok, true)
  assert.equal(analyzed, 1)
  assert.deepEqual(rendererCalls, [])
})

test('calendar list uses the recurrence-expanding window APIs', async () => {
  let usedLegacy = false
  let usedWindow = false
  const db = fakeDb({
    getCalendarEvents: () => {
      usedLegacy = true
      return []
    },
    getNonRecurringEventsInWindow: () => {
      usedWindow = true
      return [{
        id: 'evt-1',
        title: '单次',
        start_time: 1,
        end_time: 2,
        calendar_id: 'cal-1',
      }] as never
    },
  } as Partial<DatabaseManager>)
  const { dispatch, listed } = handlers({ db })
  const result = await dispatch('calendar.listWindow', {
    start: '2026-08-10T00:00:00Z',
    end: '2026-08-16T00:00:00Z',
  })
  assert.equal(result.ok, true)
  assert.equal(usedLegacy, false)
  assert.equal(usedWindow, true)
  assert.deepEqual(listed, ['evt-1'])
})

test('calendar list rejects oversized model windows', async () => {
  const { dispatch } = handlers()
  await assert.rejects(
    () => dispatch('calendar.listWindow', { start: '2026-01-01', end: '2028-01-02' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'codex_calendar_window_span_invalid',
  )
})

test('calendar update injects the typed event id and rejects conflicts', async () => {
  const db = fakeDb()
  db.calendar.createCalendarEvent({
    calendar_id: 'cal-1',
    title: '原',
    start_time: 1,
    end_time: 2,
  })
  const { dispatch } = handlers({
    db,
    targets: { calendarEventId: 'event-created' },
  })
  const updated = await dispatch('calendar.updateEvent', { title: '新标题' })
  assert.equal(updated.ok, true)
  assert.equal(updated.eventId, 'event-created')
  await assert.rejects(
    () => dispatch('calendar.updateEvent', { id: 'other' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_event_conflict',
  )
})

test('calendar update without a typed target only accepts a unique list receipt', async () => {
  const db = fakeDb()
  db.calendar.createCalendarEvent({
    calendar_id: 'cal-1',
    title: '唯一',
    start_time: 1,
    end_time: 2,
  })
  const { dispatch } = handlers({ db, listed: ['event-created'] })
  const updated = await dispatch('calendar.updateEvent', { title: '改名' })
  assert.equal(updated.ok, true)
  await assert.rejects(
    () => dispatch('calendar.deleteEvent', { id: 'guessed' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_event_not_in_receipt',
  )
})

test('calendar list exposes persistable parent ids and accepts synthetic instance ids on write', async () => {
  assert.equal(persistableCalendarEventId('parent#1710000000'), 'parent')
  const db = fakeDb()
  db.calendar.createCalendarEvent({
    calendar_id: 'cal-1',
    title: '周会',
    start_time: 1,
    end_time: 2,
  })
  const { dispatch } = handlers({ db, listed: ['event-created'] })
  const updated = await dispatch('calendar.updateEvent', {
    id: 'event-created#1710000000',
    title: '周会改名',
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.eventId, 'event-created')
})

test('malformed reminders fail closed instead of wiping the event', async () => {
  const { dispatch } = handlers()
  await assert.rejects(
    () => dispatch('calendar.createEvent', {
      title: '会',
      startTime: '2026-08-15T13:00:00Z',
      endTime: '2026-08-15T14:00:00Z',
      reminders: [{ offsetMinutes: 1.5, method: 'notification' }],
    }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_reminders_invalid',
  )
})

test('calendar create persists reminders and reads them back', async () => {
  const db = fakeDb()
  const { dispatch } = handlers({ db })
  const created = await dispatch('calendar.createEvent', {
    title: '带提醒的会',
    startTime: '2026-08-15T13:00:00Z',
    endTime: '2026-08-15T14:00:00Z',
    reminders: [{ offsetMinutes: -15, method: 'notification' }],
  })
  assert.equal(created.ok, true)
  assert.deepEqual(created.reminders, [{ offsetMinutes: -15, method: 'notification' }])
})
