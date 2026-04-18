import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('useRafResizeDrag coalesces mousemove deltas through requestAnimationFrame', () => {
  const hookSource = readWorkspaceFile('src/renderer/modules/workbench/useRafResizeDrag.ts')

  // Must accumulate deltas and flush once per animation frame.
  assert.match(hookSource, /pendingDelta/)
  assert.match(hookSource, /window\.requestAnimationFrame/)
  assert.match(hookSource, /window\.cancelAnimationFrame/)

  // Must toggle body.resizing class on start and clear on end.
  assert.match(hookSource, /document\.body\.classList\.add\('resizing'\)/)
  assert.match(hookSource, /document\.body\.classList\.remove\('resizing'\)/)

  // PANEL_RESIZE_STATE_EVENT dispatch must be gated behind an option so
  // DocumentMode's split handle doesn't unnecessarily pulse BrowserView
  // consumers.
  assert.match(hookSource, /dispatchPanelResizeEvent/)
})

test('WorkbenchMode and DocumentMode share the RAF resize hook', () => {
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')

  assert.match(workbench, /useRafResizeDrag/)
  assert.match(documentMode, /useRafResizeDrag/)

  // Neither file may ship its own inline mousemove-to-RAF implementation now.
  assert.doesNotMatch(workbench, /let pendingDelta = 0/)
  assert.doesNotMatch(documentMode, /let pendingDelta = 0/)
})
