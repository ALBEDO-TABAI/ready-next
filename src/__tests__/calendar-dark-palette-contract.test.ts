import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('calendar dark liquid mode uses dedicated shell and schedule palette tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const calendarShell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const miniCalendar = readWorkspaceFile('src/renderer/components/calendar/MiniCalendar.tsx')

  assert.match(styles, /--calendar-shell-bg:/)
  assert.match(styles, /--calendar-shell-border:/)
  assert.match(styles, /--calendar-toolbar-chip-bg:/)
  assert.match(styles, /--calendar-today-accent:/)
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--calendar-shell-bg:/,
  )
  assert.match(calendarShell, /background: 'var\(--calendar-shell-bg\)'/)
  assert.match(calendarShell, /border: '1px solid var\(--calendar-shell-border\)'/)
  assert.match(calendarShell, /background: 'var\(--calendar-sidebar-bg\)'/)
  assert.match(scheduleCss, /--sx-ready-liquid-grid-line:/)
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-liquid-neutral-bg:/,
  )
  assert.match(scheduleCss, /background: var\(--sx-ready-liquid-neutral-bg\) !important;/)
  assert.match(scheduleCss, /background: var\(--calendar-today-accent\) !important;/)
  assert.match(miniCalendar, /var\(--calendar-today-accent\)/)
})
