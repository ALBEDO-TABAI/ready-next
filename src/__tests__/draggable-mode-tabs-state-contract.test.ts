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
  assert.match(source, /const writeThumbPos = useCallback\(\(pos: number\) => \{[\s\S]*el\.style\.setProperty\('--dmt-thumb-pos', String\(pos\)\)/)
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
  assert.match(styles, /\.draggable-mode-tabs__thumb\s*\{[\s\S]*transform:\s*translateX\(calc\(var\(--dmt-thumb-pos[\s\S]*\* 100%\)\)/)
  assert.match(styles, /--dmt-icon-index/)
  assert.match(styles, /--dmt-icon-proximity/)
  assert.match(styles, /color-mix\(in srgb,\s*var\(--color-blue/)

  // Per-icon index is passed through style for the CSS variable cascade.
  assert.match(source, /\['--dmt-icon-index' as string\]:\s*String\(index\)/)
})
