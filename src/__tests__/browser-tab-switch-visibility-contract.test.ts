import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode keeps startup host recovery separate from ordinary tab switches so tab activation does not hide the browser host first', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(
    browserMode,
    /useEffect\(\(\) => \{\s*if \(!isElectron\) return\s*if \(!shouldPresentBrowserHost \|\| !shouldRevealBrowserHost\) return[\s\S]*const syncVisibleHost = async \(\) => \{[\s\S]*await syncBrowserVisibility\('hidden'\)[\s\S]*await syncBrowserVisibility\('visible', \{ forceBoundsSync: true \}\)/,
  )

  assert.match(
    browserMode,
    /useEffect\(\(\) => \{\s*if \(!isElectron \|\| !isActive\) return\s*if \(!shouldPresentBrowserHost \|\| !shouldRevealBrowserHost\) return\s*if \(!browserRuntimeReady \|\| tabs\.length === 0 \|\| !activeTabId\) return[\s\S]*fitActiveTabToBounds\(activeTabId\)[\s\S]*syncBrowserVisibility\('visible', \{ forceExact: true, forceBoundsSync: true \}\)/,
  )

  assert.doesNotMatch(
    browserMode,
    /\}, \[activeTabId, browserRuntimeReady, isElectron, syncBrowserVisibility, shouldPresentBrowserHost, shouldRevealBrowserHost, tabs.length\]\)/,
  )
})
