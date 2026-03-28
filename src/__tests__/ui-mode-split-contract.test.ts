import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('calendar and browser modes delegate presentation to focused shell components', () => {
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(calendarMode, /import CalendarWorkbenchShell/)
  assert.match(calendarMode, /import \{ useCalendarQuickCreate \} from/)
  assert.doesNotMatch(calendarMode, /function ViewSelector/)
  assert.match(calendarMode, /<CalendarWorkbenchShell/)
  assert.match(calendarShell, /import CalendarViewSelector from/)
  assert.match(calendarMode, /useCalendarQuickCreate\(/)

  assert.match(browserMode, /import BrowserModeEmptyState from/)
  assert.match(browserMode, /<BrowserModeEmptyState/)
})
