import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode relies on layoutPhase-idle resync instead of a 180ms startup timer', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  // Trailing settle remains reactive on layoutPhase === 'idle'.
  assert.match(
    browserMode,
    /useEffect\(\(\) => \{\s*if \(!isElectron \|\| !isActive\) return\s*if \(layoutPhase !== 'idle'\) return\s*void syncBrowserVisibility\(\{ forceExact: true \}\)\s*\}, \[isActive, isElectron, layoutPhase, syncBrowserVisibility\]\)/,
  )

  // Startup / new-active-tab recovery keeps a delayed post-activation resync
  // so restored tabs and freshly created tabs do not stay hidden until the user
  // clicks another tab.
  assert.match(browserMode, /const postActivationHostResyncTimerRef = useRef<number \| null>\(null\)/)
  assert.match(browserMode, /const clearPostActivationHostResyncTimer = useCallback\(\(\) => \{/)
  assert.match(
    browserMode,
    /useEffect\(\(\) => \{\s*if \(!isElectron \|\| !isActive\) return\s*if \(!shouldPresentBrowserHost \|\| !shouldRevealBrowserHost\) return\s*if \(!browserRuntimeReady \|\| tabs\.length === 0 \|\| !activeTabId\) return\s*if \(layoutPhase !== 'idle'\) return[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*fitActiveTabToBounds\(activeTabId\)[\s\S]*syncBrowserVisibility\('visible', \{ forceExact: true, forceBoundsSync: true \}\)/,
  )
})
