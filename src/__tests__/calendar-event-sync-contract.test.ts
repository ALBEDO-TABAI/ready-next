import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('schedule-x sync reruns when calendar events change so new events appear immediately', () => {
  const hook = readWorkspaceFile('src/renderer/modules/calendar/useScheduleXCalendar.ts')

  assert.match(hook, /events:\s*CalendarEvent\[\]/)
  assert.match(hook, /const filteredEvents = events\.filter/)
  assert.match(hook, /\}, \[enabledSourceIds, events, isActive, sxReady\]\)/)
})
