import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('PanelResizeStateDetail carries a required reason discriminator so consumers can distinguish click-toggle from drag', () => {
  const source = readWorkspaceFile('src/renderer/modules/browser/resize-events.ts')

  assert.match(source, /export type PanelResizeReason = 'drag' \| 'click-toggle'/)
  assert.match(
    source,
    /export interface PanelResizeStateDetail\s*\{[\s\S]*?resizing:\s*boolean[\s\S]*?reason:\s*PanelResizeReason[\s\S]*?\}/,
  )
})

test('click-toggle produces click-toggle reason and drag handle produces drag reason', () => {
  const togglePanel = readWorkspaceFile('src/renderer/modules/workbench/useTogglePanelWithResize.ts')
  const rafResizeDrag = readWorkspaceFile('src/renderer/modules/workbench/useRafResizeDrag.ts')

  assert.match(togglePanel, /detail:\s*\{\s*resizing,\s*reason:\s*'click-toggle'\s*\}/)
  assert.match(rafResizeDrag, /detail:\s*\{\s*resizing:\s*true,\s*reason:\s*'drag'\s*\}/)
  assert.match(rafResizeDrag, /detail:\s*\{\s*resizing:\s*false,\s*reason:\s*'drag'\s*\}/)
})

test('freeze-frame pipeline only runs on drag-reason panel events, eliminating snapshot IPCs on click-toggle', () => {
  const source = readWorkspaceFile('src/renderer/modules/browser/useBrowserResizeFreeze.ts')

  assert.match(
    source,
    /const handleResizeState = \(event: Event\) => \{[\s\S]*?if \(detail\.reason !== 'drag'\) return[\s\S]*?if \(detail\.resizing\)/,
  )
})

test('browser bounds prop-watch and ResizeObserver both keep drag synced while deduping non-drag panel resize', () => {
  const source = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(
    source,
    /const handleBoundsShift = \(\) => \{\s*if \(panelResizeReasonRef\.current === 'drag'\) \{[\s\S]*?clearFrameSync\(\)[\s\S]*?void sendBoundsImmediate\(\)[\s\S]*?return[\s\S]*?\}/,
  )
  assert.match(
    source,
    /if \(panelResizingRef\.current && frameSyncRequestRef\.current !== null\) return/,
  )
  assert.match(
    source,
    /if \(!isActive\) \{[\s\S]*?clearFrameSync\(\)[\s\S]*?clearSettleSyncTimeout\(\)[\s\S]*?stopDragBoundsSync\(\)[\s\S]*?return[\s\S]*?\}\s*if \(panelResizingRef\.current\) return\s*sendBounds\(\{ forceExact: true \}\)/,
  )
})
