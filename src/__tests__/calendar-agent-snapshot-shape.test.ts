/**
 * Lock the shape of the `calendar.captureSession` snapshot that the
 * agent handler returns to the model.
 *
 * Why a dedicated shape test:
 *   Pre-fix, the handler dropped every L0-L4 field added after the
 *   initial schema (location / reminders / recurrenceRule / instance-of),
 *   so the model could create rich events and then read back its own
 *   creation and not see the new fields. The fix was to extend
 *   `serializeEvent`. This test pins the resulting key set so future
 *   refactors cannot silently shrink it.
 *
 * It ALSO pins the documented degradation: event-level timezone fields
 * (`startTz / endTz`) are deliberately OMITTED while L4 sits at
 * "display-layer timezone only; event-level timezone NOT complete"
 * (see `rrule-engine.ts` docstring). Bringing tz into the snapshot
 * BEFORE event-level tz is real would expose the model to a value the
 * rest of the app cannot uphold — so this assertion is intentional, not
 * an oversight. When event-level tz lands, this test must be updated as
 * part of the change.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCalendarAgentHandler } from '../renderer/modules/calendar/calendar-agent-handler'
import type { CalendarEvent } from '../renderer/components/calendar/schedule-x-utils'

/** Build a calendar event with every field downstream code might set. */
function makeRichEvent(): CalendarEvent {
  return {
    id: 'evt-rec#1779526800',
    title: '团队周会',
    startTime: new Date(Date.UTC(2026, 4, 17, 9, 0, 0)),
    endTime: new Date(Date.UTC(2026, 4, 17, 10, 0, 0)),
    calendarId: 'work',
    color: '#5B8DEF',
    description: '周一例会',
    location: '会议室 A',
    allDay: false,
    contentType: 'video',
    platform: ['xiaohongshu'],
    publishStatus: 'draft',
    reminders: [{ offsetMinutes: -15, method: 'notification' }],
    recurrenceRule: 'FREQ=WEEKLY;COUNT=10',
    instanceOf: 'evt-rec',
    occurrenceStart: 1779526800,
    overrideKind: 'single',
  } as CalendarEvent
}

async function captureSnapshot() {
  const event = makeRichEvent()
  const handler = createCalendarAgentHandler({
    currentDate: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
    viewType: 'month',
    editingEvent: null,
    sources: [{ id: 'work', name: '工作', color: '#5B8DEF', enabled: true, type: 'local' } as never],
    getEvents: () => [event],
    loadCalendarData: async () => undefined,
    setConflictState: () => undefined,
    markSessionMutation: () => undefined,
    getDateRange: () => ({
      start: new Date(Date.UTC(2026, 4, 1, 0, 0, 0)),
      end: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)),
    }),
    calendarApi: undefined,
  })
  const result = await handler({
    action: 'calendar.captureSession',
    args: {},
  }) as { events: Array<Record<string, unknown>>; visibleEvents: Array<Record<string, unknown>> }
  return { result, event }
}

/** Required key set the snapshot MUST surface. Adding to this set is a
 *  contract change; removing from it is a regression of audit issue #3. */
const REQUIRED_KEYS = new Set([
  'id',
  'title',
  'startTime',
  'endTime',
  'calendarId',
  'color',
  'description',
  'location',
  'allDay',
  'reminders',
  'recurrenceRule',
  'instanceOf',
  'occurrenceStart',
  'overrideKind',
  'contentType',
  'platform',
  'publishStatus',
])

/** Keys that are intentionally OMITTED because the feature they would
 *  surface is not actually complete. Adding any of these to the snapshot
 *  MUST be accompanied by closing the corresponding L4 gap. */
const FORBIDDEN_KEYS = new Set(['startTz', 'endTz'])

test('captureSession snapshot exposes every required field', async () => {
  const { result } = await captureSnapshot()
  assert.ok(Array.isArray(result.events) && result.events.length === 1)
  const snapshot = result.events[0]
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in snapshot, `snapshot missing required key "${key}"`)
  }
})

test('captureSession snapshot deliberately OMITS event-level timezone fields', async () => {
  const { result } = await captureSnapshot()
  const snapshot = result.events[0]
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(
      !(key in snapshot),
      `snapshot must NOT carry "${key}" — event-level timezone is documented as NOT complete (rrule-engine.ts L4 degradation note). Adding tz to the snapshot requires first closing the L4 gap (real per-event tz editing + DST-correct rrule expansion).`,
    )
  }
})

test('captureSession snapshot field VALUES match the source event (no silent drop)', async () => {
  const { result, event } = await captureSnapshot()
  const snapshot = result.events[0]
  // Spot-check the fields that pre-fix were silently dropped: location,
  // reminders, recurrenceRule, instanceOf, occurrenceStart, overrideKind.
  assert.equal(snapshot.location, event.location)
  assert.deepEqual(snapshot.reminders, event.reminders)
  assert.equal(snapshot.recurrenceRule, event.recurrenceRule)
  assert.equal(snapshot.instanceOf, event.instanceOf)
  assert.equal(snapshot.occurrenceStart, event.occurrenceStart)
  assert.equal(snapshot.overrideKind, event.overrideKind)
})

test('captureSession snapshot has exactly the expected key set (frozen contract)', async () => {
  const { result } = await captureSnapshot()
  const snapshot = result.events[0]
  const actualKeys = new Set(Object.keys(snapshot))
  // Every actual key must be either required or some other declared
  // field (today the snapshot has no extras beyond REQUIRED_KEYS; if a
  // future change adds new keys, this test must be updated alongside).
  for (const key of actualKeys) {
    assert.ok(
      REQUIRED_KEYS.has(key),
      `unexpected key "${key}" in snapshot — if intentionally added, update REQUIRED_KEYS and document the contract change`,
    )
  }
  // And every required key must appear (covered by the first test, but
  // double-checked here so the frozen-set assertion is bidirectional).
  for (const key of REQUIRED_KEYS) {
    assert.ok(actualKeys.has(key), `frozen contract missing key "${key}"`)
  }
})
