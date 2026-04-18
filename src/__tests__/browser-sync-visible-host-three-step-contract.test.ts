import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('BrowserMode syncVisibleHost collapses to three explicit steps: hidden → fitActiveTabToBounds → visible(forceBoundsSync)', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(
    browserMode,
    /const syncVisibleHost = async \(\) => \{[\s\S]*await syncBrowserVisibility\('hidden'\)[\s\S]*if \(activeTabId\) \{[\s\S]*fitActiveTabToBounds\(activeTabId\)[\s\S]*\}[\s\S]*await syncBrowserVisibility\('visible', \{ forceBoundsSync: true \}\)/,
  )

  // The old pre-hide + double sendBoundsImmediate pair is gone.
  assert.doesNotMatch(
    browserMode,
    /await window\.electronAPI\?\.browser\?\.hideAll\?\.\(\)\s*\n\s*await sendBoundsImmediate\(\{ forceExact: true \}\)/,
  )
  assert.doesNotMatch(
    browserMode,
    /await sendBoundsImmediate\(\{ forceExact: true \}\)\s*\n\s*await syncBrowserVisibility\(\{ forceExact: true \}\)/,
  )

  // The double-rAF wait moved into syncBrowserVisibility when forceBoundsSync is set.
  assert.doesNotMatch(
    browserMode,
    /await new Promise\(\(resolve\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => resolve\(undefined\)\)\)\)/,
  )
})

test('syncBrowserVisibility internalises bounds sync + double rAF when called as visible(forceBoundsSync)', () => {
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(
    boundsHook,
    /phaseOrOptions\?: 'hidden' \| 'visible' \| \{ forceExact\?: boolean; syncMode\?: BrowserBoundsSyncMode; forceBoundsSync\?: boolean \}/,
  )
  assert.match(boundsHook, /if \(phase === 'hidden'\) \{\s*window\.electronAPI\?\.browser\?\.hideAll\(\)/)
  assert.match(
    boundsHook,
    /if \(options\.forceBoundsSync\) \{[\s\S]*window\.requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(\(\) => resolve\(\)\)\)/,
  )
})
