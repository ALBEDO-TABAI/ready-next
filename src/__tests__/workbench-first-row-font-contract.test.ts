import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document rss and calendar first-row typography matches the browser tab baseline', () => {
  const browserTabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const documentTabRail = readWorkspaceFile('src/renderer/components/document/DocumentTabRail.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const calendarViewSelector = readWorkspaceFile('src/renderer/components/calendar/CalendarViewSelector.tsx')

  assert.match(browserTabRail, /text-\[12px\]/)

  assert.match(documentTabRail, /text-\[12px\]/)
  assert.match(documentMode, /fontSize:\s*12/)

  assert.match(rssFeed, /fontSize:\s*12,\s*fontWeight:\s*500/)
  assert.match(rssFeed, /<h2 style=\{\{ fontSize: 12/)
  assert.match(rssFeed, /text-\[12px\]/)

  assert.match(calendarShell, /fontSize:\s*12,\s*fontWeight:\s*500/)
  assert.match(calendarShell, /<span style=\{\{ fontSize: 12/)
  assert.match(calendarViewSelector, /fontSize:\s*12/)
})
