import assert from 'node:assert/strict'
import test from 'node:test'

import { createProductionProductActionHandlers } from '../main/modules/agent-control/codex-runtime/codex-product-action-handlers'
import { DatabaseManager } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('isolated calendar write through the production handler readbacks by id', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-workbench-surface-native')) return
  const database = new DatabaseManager(true)
  try {
    const calendarId = database.calendar.addCalendarSource({ name: '测试日历', color: '#000000' })
    const { dispatch } = createProductionProductActionHandlers({
      database,
      rss: {
        async fetchUpdates() {
          return { success: true, data: { running: true, fetched: 0 } }
        },
        async addSource() {
          return { ok: false, error: 'unused' }
        },
        async analyzeItem() {
          return { ok: false, errorKind: 'unused' }
        },
      },
      requestRendererToolAction: async () => ({ ok: false }),
      sessionId: 'session',
      runId: 'run-native',
      codexThreadId: 'thread',
      codexTurnId: 'turn',
      codexCallId: 'call',
      readyActionId: 'action',
      actionIdentityDigest: 'digest',
      abortSignal: new AbortController().signal,
    })
    const inFlight = await dispatch('rss.fetchUpdates', {})
    assert.equal(inFlight.ok, false)
    assert.equal(inFlight.errorKind, 'rss_fetch_in_progress')

    const created = await dispatch('calendar.createEvent', {
      title: '明天下午的会',
      startTime: '2026-08-15T13:00:00+08:00',
      endTime: '2026-08-15T14:00:00+08:00',
      calendarId,
      reminders: [{ offsetMinutes: -15, method: 'notification' }],
    })
    assert.equal(created.ok, true)
    const eventId = String(created.eventId)
    const readback = database.calendar.getCalendarEventById(eventId)
    assert.equal(readback?.title, '明天下午的会')
    assert.deepEqual(readback?.reminders, [{ offsetMinutes: -15, method: 'notification' }])
    database.calendar.deleteCalendarEvent(eventId)
    assert.equal(database.calendar.getCalendarEventById(eventId), null)
  } finally {
    database.close()
  }
})
