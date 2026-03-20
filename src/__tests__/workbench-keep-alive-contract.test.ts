import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench outlet keeps all primary modes mounted and toggles visibility with CSS instead of motion-driven remount logic', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(outlet, /const ALL_WORKBENCH_MODES: WorkbenchMode\[\] = \['browser', 'document', 'rss', 'calendar'\]/)
  assert.match(outlet, /\{ALL_WORKBENCH_MODES\.map\(\(mountedMode\) => \{/)
  assert.match(outlet, /isActive \? 'flex' : 'hidden'/)
  assert.match(outlet, /aria-hidden=\{!isActive\}/)
  assert.doesNotMatch(outlet, /motion\.div/)
  assert.doesNotMatch(outlet, /useState<WorkbenchMode\[\]>/)
})

test('rss and calendar modes gate heavyweight work behind foreground activity when kept alive', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssMode, /export default function RSSMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(rssMode, /const shouldPoll = isActive && hasHydrated/)
  assert.match(rssMode, /if \(!isActive\) \{/)
  assert.match(rssMode, /!cancelled && !hasHydrated[\s\S]*setHasHydrated\(true\)/)

  assert.match(calendarMode, /export default function CalendarMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(calendarMode, /const \[hasActivated, setHasActivated\] = useState\(/)
  assert.match(calendarMode, /if \(!hasActivated\) return/)

  assert.match(documentMode, /export default function DocumentMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(previewBrowser, /export default function PreviewBrowser\(\{ item, onClose, isActive = true \}:/)
  assert.match(previewBrowser, /if \(!isActive\) \{[\s\S]*previewClose/)
})
