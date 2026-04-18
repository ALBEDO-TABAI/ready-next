import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('DraggableModeTabs debounces the browser-capture-freeze hover dispatch', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')

  // A delay constant must exist so the dispatch is deferred.
  assert.match(
    source,
    /const\s+CAPTURE_FREEZE_HOVER_DELAY_MS\s*=\s*\d+/,
    'Hover dispatch must be gated by a named delay constant.',
  )

  // Dispatch must live inside a setTimeout, not fire synchronously on mouse enter.
  const dispatchMatches = source.match(/dispatchEvent\(new CustomEvent\(BROWSER_CAPTURE_FREEZE_EVENT\)\)/g) ?? []
  assert.equal(
    dispatchMatches.length,
    1,
    'There must be exactly one browser-capture-freeze dispatch site.',
  )

  const setTimeoutIndex = source.indexOf('setTimeout')
  const dispatchIndex = source.indexOf('dispatchEvent(new CustomEvent(BROWSER_CAPTURE_FREEZE_EVENT))')
  assert.ok(
    setTimeoutIndex >= 0 && setTimeoutIndex < dispatchIndex,
    'The dispatch must be deferred by a setTimeout before it runs.',
  )

  // An onMouseLeave handler must cancel the pending timer so a quick hover-over
  // never produces a capture IPC.
  assert.match(
    source,
    /onMouseLeave=\{handleIconLeave\}/,
    'Icon buttons must bind onMouseLeave to cancel the pending debounce timer.',
  )
  assert.match(
    source,
    /clearCaptureFreezeTimer/,
    'A timer-clearing helper must exist and be invoked on leave/unmount.',
  )
})
