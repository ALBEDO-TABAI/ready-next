import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('TopBar right padding follows the chat panel gutter via CSS variable, not a fixed 14px', () => {
  const topbar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(
    topbar,
    /paddingRight:\s*`calc\(var\(--workbench-right-gutter, 0px\) \+ \$\{WORKBENCH_TOPBAR_PADDING_RIGHT\}px\)`/,
  )
  assert.match(
    workbench,
    /'--workbench-right-gutter'[^}]*\$\{chatShellWidth\}px/,
  )
})

test('overlayLockCount self-heals after 600ms so a leaked lock cannot strand the BrowserView hidden', () => {
  const source = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(source, /OVERLAY_LOCK_SELF_HEAL_MS\s*=\s*600/)
  assert.match(source, /pendingSelfHealTimers/)
  assert.match(source, /overlayLockCount self-healed after/)
})

test('RitualOverlay unmount cleanup releases any held BrowserView mask', () => {
  const source = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')

  assert.match(
    source,
    /useEffect\(\(\) => \(\) => \{[\s\S]*?if \(maskActiveRef\.current\)[\s\S]*?endBrowserMask/,
  )
})

test('withRitual short-circuits while a panel is being resized, so no overlay interferes with drag', () => {
  const source = readWorkspaceFile('src/renderer/modules/overlay/useRitualOverlay.ts')

  assert.match(source, /setPanelResizingSignal/)
  assert.match(source, /if \(panelResizingActive\) \{/)
  assert.match(source, /return await workFn\(args\)/)
})

test('WorkbenchMode wires the panel-resize signal into the shared ritual gate', () => {
  const source = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(source, /setPanelResizingSignal\(resizing\)/)
  assert.match(source, /onResizeStateChange=\{handlePanelResizeStateChange\}/)
})
