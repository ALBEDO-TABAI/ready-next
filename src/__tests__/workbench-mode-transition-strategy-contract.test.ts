import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveModeTransitionStrategy } from '../renderer/modules/workbench/modeTransitionStrategy'
import type { WorkbenchMode } from '../renderer/stores/useMode'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

const MODES: WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']

test('resolveModeTransitionStrategy classifies all 16 (from,to) combinations into same-mode / dom-only / with-browser', () => {
  for (const from of MODES) {
    for (const to of MODES) {
      const strategy = resolveModeTransitionStrategy(from, to)
      if (from === to) {
        assert.equal(strategy, 'same-mode', `${from} -> ${to} should be same-mode`)
      } else if (from === 'browser' || to === 'browser') {
        assert.equal(strategy, 'with-browser', `${from} -> ${to} should be with-browser`)
      } else {
        assert.equal(strategy, 'dom-only', `${from} -> ${to} should be dom-only`)
      }
    }
  }
})

test('WorkbenchMode.tsx routes mode switches through the strategy function and only enters withRitual on with-browser transitions', () => {
  const source = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(source, /import \{ resolveModeTransitionStrategy \} from '\.\.\/modules\/workbench\/modeTransitionStrategy'/)
  assert.match(source, /const strategy = resolveModeTransitionStrategy\(workbenchMode, nextMode\)/)
  assert.match(source, /if \(strategy === 'same-mode'\) return/)
  const splitCollapseIndex = source.search(/if \(splitMode\) \{[\s\S]*?setWorkbenchMode\(nextMode\)[\s\S]*?return[\s\S]*?\}/)
  const sameModeReturnIndex = source.indexOf("if (strategy === 'same-mode') return")
  assert.notEqual(splitCollapseIndex, -1)
  assert.notEqual(sameModeReturnIndex, -1)
  assert.ok(splitCollapseIndex < sameModeReturnIndex)
  assert.match(
    source,
    /if \(strategy === 'dom-only'\) \{[\s\S]*?transitionTargetModeRef\.current = nextMode[\s\S]*?setWorkbenchMode\(nextMode\)[\s\S]*?return[\s\S]*?\}/,
  )
  assert.match(source, /await withRitual\('mode-switch'/)
})

test('RitualOverlay toggles html[data-mode-switching] during mode-switch phases and the slider thumb disables its transition under that attribute', () => {
  const overlay = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')
  const css = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')

  assert.match(overlay, /session\.stage === 'mode-switch'/)
  assert.match(overlay, /setAttribute\('data-mode-switching', 'true'\)/)
  assert.match(overlay, /removeAttribute\('data-mode-switching'\)/)
  assert.match(
    css,
    /html\[data-mode-switching='true'\] \.draggable-mode-tabs__thumb \{\s*transition:\s*none;\s*\}/,
  )
})
