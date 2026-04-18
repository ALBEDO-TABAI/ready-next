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

  // Hook: !isActive must hide before returning (no silent early-return).
  assert.match(
    hook,
    /if \(!isActiveRef\.current\) \{\s*window\.electronAPI\?\.browser\?\.hideAll\(\)\s*return\s*\}/,
  )
  // Hook: reactive effect re-fires syncBrowserVisibility when isActive or isVisibleAllowed flip.
  assert.match(
    hook,
    /useEffect\(\(\) => \{\s*void syncBrowserVisibility\(\{ forceExact: true \}\)\s*\}, \[isActive, isVisibleAllowed, syncBrowserVisibility\]\)/,
  )

  // WorkbenchMode: the predictive hideAll inside handleWorkbenchModeChange is gone.
  assert.doesNotMatch(
    workbenchMode,
    /transitionTargetModeRef\.current === 'browser' && nextMode !== 'browser'[\s\S]{0,200}hideAll/,
  )
  // WorkbenchMode: the visibleModes effect that duplicated hideAll is gone.
  assert.doesNotMatch(workbenchMode, /if \(!visibleModes\.includes\('browser'\)\) \{[\s\S]*?hideAll/)
  // WorkbenchMode: unmount cleanup hideAll is preserved.
  assert.match(workbenchMode, /useEffect\(\(\) => \{\s*return \(\) => \{\s*void window\.electronAPI\?\.browser\.hideAll\(\)/)

  // BrowserMode: the !isMotionSettled effect that redundantly hid the view is gone.
  assert.doesNotMatch(browserMode, /if \(!isElectron \|\| isMotionSettled\) return[\s\S]{0,80}hideAll/)
})
