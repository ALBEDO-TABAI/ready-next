import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('calendar and browser modes delegate presentation to focused shell components', () => {
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const calendarApp = readWorkspaceFile('src/renderer/modules/calendar/workbench/App.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(calendarMode, /<App active=/)
  assert.match(calendarApp, /<TimeGrid/)
  assert.match(calendarApp, /<MonthGrid/)

  assert.match(browserMode, /import BrowserModeEmptyState from/)
  assert.match(browserMode, /<BrowserModeEmptyState/)
})
