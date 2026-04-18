import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode relies on layoutPhase-idle resync instead of a 180ms startup timer', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  // The 180ms trailing setTimeout inside syncVisibleHost is gone.
  assert.doesNotMatch(browserMode, /startupHostResyncTimerRef/)
  assert.doesNotMatch(browserMode, /clearStartupHostResyncTimer/)
  assert.doesNotMatch(browserMode, /window\.setTimeout\([\s\S]{0,200}syncBrowserVisibility[\s\S]{0,50}\}, 180\)/)

  // The new reactive trailing-settle effect fires on layoutPhase === 'idle'.
  assert.match(
    browserMode,
    /useEffect\(\(\) => \{\s*if \(!isElectron \|\| !isActive\) return\s*if \(layoutPhase !== 'idle'\) return\s*void syncBrowserVisibility\(\{ forceExact: true \}\)\s*\}, \[isActive, isElectron, layoutPhase, syncBrowserVisibility\]\)/,
  )
})
