import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { shouldAnimateWorkbenchModeTransition } from '../renderer/modules/workbench/mode-transition'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('WorkbenchModeOutlet emits visual-state and direction attributes that drive the scene transitions', () => {
  const source = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')

  assert.match(source, /data-mode-visual-state=\{visualState\}/)
  assert.match(source, /data-mode-direction=\{direction\}/)
  // Motion language (2026-11-24): scene-motion.ts keeps every leaving scene with its own direction and timer, so a quick
  // second change neither cuts a fade short nor snaps a scene (behaviour: shell-navigator-motion.test.tsx).
  assert.match(source, /useSceneMotion\(mode, \{ animate: shouldAnimateWorkbenchModeTransition\(transitionPresentation\), order: ALL_WORKBENCH_MODES \}\)/)
  assert.match(source, /direction=\{runtime\.leaving\[modeKey\] \?\? runtime\.direction\}/)
  assert.doesNotMatch(source, /transform: 'translate3d\(0, 0, 0\)',/, 'inline static transform must be removed — CSS drives the slide')
})

test('file-open presentation skips scene motion while ordinary mode switches retain it (reduced motion dissolves)', () => {
  assert.equal(shouldAnimateWorkbenchModeTransition('immediate'), false)
  assert.equal(shouldAnimateWorkbenchModeTransition('animated'), true)
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

test('mode scenes move along the rail axis by transition from a non-zero offset (not a pure fade), interruptible', () => {
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  assert.match(css, /\.workbench-mode-scene \{[\s\S]*?transition: transform var\(--rn-d-2\) var\(--rn-ease-out\), opacity var\(--rn-d-2\) var\(--rn-ease-out\);/)
  assert.match(css, /@starting-style \{[\s\S]*?\[data-mode-visual-state='entering'\]\[data-mode-direction='forward'\] \{ transform: translate3d\(0, var\(--rn-shift-3\), 0\); opacity: 0; \}/)
  assert.match(css, /\[data-mode-visual-state='entering'\]\[data-mode-direction='backward'\] \{ transform: translate3d\(0, calc\(-1 \* var\(--rn-shift-3\)\), 0\); opacity: 0; \}/)
  assert.match(css, /\[data-mode-visual-state='leaving'\] \{[\s\S]*?opacity: 0;[\s\S]*?transition-duration: var\(--rn-d-1\);/)
  assert.doesNotMatch(css, /@keyframes workbench-mode-scene-/, 'keyframes restart from their first frame when interrupted')
})
