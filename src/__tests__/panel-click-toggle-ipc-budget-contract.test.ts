import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('click-toggle does not route through the freeze-frame pipeline (no captureWindowSnapshot, fitActiveTabToBounds, or recaptureFreezeFrame can be reached from click-toggle events)', () => {
  const freeze = readWorkspaceFile('src/renderer/modules/browser/useBrowserResizeFreeze.ts')

  assert.match(freeze, /if \(detail\.reason !== 'drag'\) return/)
  assert.match(freeze, /captureWindowSnapshot/)
  assert.match(freeze, /fitActiveTabToBounds/)
  assert.match(freeze, /recaptureFreezeFrame/)

  const match = freeze.match(/const handleResizeState = \(event: Event\) => \{([\s\S]*?)\n\s{4}\}/)
  assert.ok(match, 'handleResizeState block not found')
  const body = match[1]
  assert.doesNotMatch(body, /captureWindowSnapshot/)
  assert.doesNotMatch(body, /fitActiveTabToBounds/)
  assert.doesNotMatch(body, /recaptureFreezeFrame/)
})

test('click-toggle bounds sync collapses to a single transient + settled pair (prop-watch and observer early-return while panelResizingRef is true)', () => {
  const bounds = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(
    bounds,
    /if \(panelResizingRef\.current && frameSyncRequestRef\.current !== null\) return/,
  )
  assert.match(bounds, /if \(panelResizingRef\.current\) return\s*sendBounds\(\{ forceExact: true \}\)/)
  assert.match(bounds, /void scheduleBoundsSync\('transient', \{ force: true \}\)/)
  assert.match(bounds, /void scheduleBoundsSync\('settled', \{ force: true \}\)/)
})
