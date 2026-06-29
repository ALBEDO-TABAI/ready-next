import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('BrowserView show/hide decisions are consolidated inside useBrowserViewBounds', () => {
  const hook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  // Stage X4 PR-shell-1 — Hook: !isActive must hide via the
  // BrowserViewIntent boundary (`emitHideAll()` → `hide-all` intent)
  // before returning. No silent early-return; no direct `browser.hideAll()`.
  assert.match(
    hook,
    /if \(!isActiveRef\.current\) \{\s*emitHideAll\(\)\s*return\s*\}/,
  )
  assert.match(
    hook,
    /sendIntent\(\{[\s\S]*kind: 'hide-all'[\s\S]*reason: 'overlay-open'[\s\S]*\}\)/,
  )
  // Hook: reactive effect re-fires syncBrowserVisibility when isActive or isVisibleAllowed flip,
  // and visible recovery must wait for stable bounds before showing the native BrowserView.
  assert.match(
    hook,
    /useEffect\(\(\) => \{\s*void syncBrowserVisibility\(\{ forceExact: true, forceBoundsSync: isActive && isVisibleAllowed \}\)\s*\}, \[hasError, isActive, isVisibleAllowed, syncBrowserVisibility\]\)/,
  )
  assert.match(
    hook,
    /forceBoundsSync: isActiveRef\.current && isVisibleAllowedRef\.current/,
  )
  assert.doesNotMatch(hook, /syncBrowserVisibility\(\{ forceExact: true \}\)/)
  assert.match(
    browserMode,
    /if \(layoutPhase !== 'idle'\) return\s*void syncBrowserVisibility\(\{ forceExact: true, forceBoundsSync: true \}\)/,
  )
  assert.doesNotMatch(
    browserMode,
    /if \(layoutPhase !== 'idle'\) return\s*void syncBrowserVisibility\(\{ forceExact: true \}\)/,
  )
  assert.match(
    browserMode,
    /await syncBrowserVisibility\('visible', \{ forceExact: true, forceBoundsSync: true \}\)\s*if \(cancelled\) return\s*clearPostActivationHostResyncTimer\(\)\s*hostPresentedRef\.current = true/,
  )

  // WorkbenchMode: the predictive hideAll inside handleWorkbenchModeChange is gone.
  assert.doesNotMatch(
    workbenchMode,
    /transitionTargetModeRef\.current === 'browser' && nextMode !== 'browser'[\s\S]{0,200}hideAll/,
  )
  // WorkbenchMode: the visibleModes effect that duplicated hideAll is gone.
  assert.doesNotMatch(workbenchMode, /if \(!visibleModes\.includes\('browser'\)\) \{[\s\S]*?hideAll/)
  // Stage X4 PR-shell-1 — WorkbenchMode unmount cleanup emits a
  // `hide-all` BrowserViewIntent (reason = `mode-switch-prepare`) in
  // place of the legacy direct `browser.hideAll()` call.
  assert.match(
    workbenchMode,
    /useEffect\(\(\) => \{\s*return \(\) => \{[\s\S]*sendIntent\(\{[\s\S]*kind: 'hide-all'[\s\S]*reason: 'mode-switch-prepare'/,
  )
  assert.doesNotMatch(workbenchMode, /window\.electronAPI\?\.browser\.hideAll\(\)/)

  // BrowserMode: the !isMotionSettled effect that redundantly hid the view is gone.
  assert.doesNotMatch(browserMode, /if \(!isElectron \|\| isMotionSettled\) return[\s\S]{0,80}hideAll/)
})
