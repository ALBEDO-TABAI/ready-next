import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('WorkbenchModeOutlet emits visual-state and direction attributes that drive slide animation', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(source, /data-mode-visual-state=\{visualState\}/)
  assert.match(source, /data-mode-direction=\{direction\}/)
  assert.match(source, /previous: previousMode,/, 'outlet must track previous mode to drive leaving animation')
  assert.match(source, /const direction: ModeDirection = nextIdx >= prevIdx \? 'forward' : 'backward'/)
  assert.doesNotMatch(source, /transform: 'translate3d\(0, 0, 0\)',/, 'inline static transform must be removed — CSS drives the slide')
})

test('ritual overlay uses transparent background on mode-switch so scene translate is visible', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(css, /\[data-ritual-overlay\]\[data-stage='mode-switch'\]\s*\{[^}]*background:\s*transparent/)
  assert.doesNotMatch(
    css,
    /\[data-ritual-overlay\]\s*\{[^}]*background:\s*var\(--workbench-mode-bg/,
    'overlay root must not apply a solid chrome background — only stage-specific rules may',
  )
})

test('workbench mode scene animations translate from non-zero offset (not a pure fade)', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(
    css,
    /@keyframes workbench-mode-scene-enter-from-right\s*\{\s*from\s*\{\s*transform:\s*translate3d\(28%/,
  )
  assert.match(
    css,
    /@keyframes workbench-mode-scene-enter-from-left\s*\{\s*from\s*\{\s*transform:\s*translate3d\(-28%/,
  )
  assert.match(
    css,
    /@keyframes workbench-mode-scene-leave-to-left\s*\{[\s\S]*?to\s*\{\s*transform:\s*translate3d\(-28%/,
  )
  assert.match(
    css,
    /@keyframes workbench-mode-scene-leave-to-right\s*\{[\s\S]*?to\s*\{\s*transform:\s*translate3d\(28%/,
  )
})
