import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('DraggableModeTabs writes thumb position through CSS variables and does not trigger per-RAF React reconciliation', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  // Thumb position lives in a CSS variable, not React state.
  assert.match(source, /const writeThumbMetrics = useCallback\(\(pos: number, span = thumbSpanRef\.current\) => \{[\s\S]*el\.style\.setProperty\('--dmt-thumb-pos', String\(pos\)\)[\s\S]*el\.style\.setProperty\('--dmt-thumb-span', String\(span\)\)/)
  assert.doesNotMatch(source, /const \[position, setPosition\] = useState/)
  assert.doesNotMatch(source, /setPosition\(/)

  // Stale-callback guard for slider animations.
  assert.match(source, /const animationIdRef = useRef\(0\)/)
  assert.match(source, /const animationId = \+\+animationIdRef\.current/)
  assert.match(source, /if \(animationId !== animationIdRef\.current\) return/)

  // React renders bounded: only mount / isDragging flip / snapIndex sync.
  assert.match(source, /const \[snapIndex, setSnapIndex\] = useState\(/)
  assert.match(source, /const \[isDragging, setIsDragging\] = useState\(false\)/)

  // Capture-freeze hover heuristics removed.
  assert.doesNotMatch(source, /BROWSER_CAPTURE_FREEZE_EVENT/)
  assert.doesNotMatch(source, /handleIconHover/)
  assert.doesNotMatch(source, /handleIconLeave/)
  assert.doesNotMatch(source, /captureFreezeTimerRef/)

  // CSS drives thumb translateX and icon color via CSS variables.
  assert.match(styles, /\.draggable-mode-tabs__thumb\s*\{[\s\S]*width:\s*calc\(\(\(100% - 4px\) \/ 4\) \* var\(--dmt-thumb-span/)
  assert.match(styles, /\.draggable-mode-tabs__thumb\s*\{[\s\S]*transform:\s*translateX\(calc\(var\(--dmt-thumb-pos[\s\S]*100% \/ var\(--dmt-thumb-span/)
  assert.match(styles, /--dmt-icon-index/)
  assert.match(styles, /--dmt-icon-shift/)
  assert.match(styles, /--dmt-icon-proximity/)

  // Per-icon visual index and reordering shift are passed through style for the CSS variable cascade.
  assert.match(source, /\['--dmt-icon-index' as string\]:\s*String\(visualIndex\)/)
  assert.match(source, /\['--dmt-icon-shift' as string\]:\s*String\(visualIndex - index\)/)
})
