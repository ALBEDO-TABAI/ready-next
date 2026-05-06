import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench mode switching routes through the shared ritual overlay and deletes the per-mode freeze-frame chrome', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const resizeFreeze = readWorkspaceFile('src/renderer/modules/browser/useBrowserResizeFreeze.ts')
  const ritualHook = readWorkspaceFile('src/renderer/modules/overlay/useRitualOverlay.ts')
  const browserMask = readWorkspaceFile('src/renderer/modules/overlay/browserViewMask.ts')
  const ritualOverlay = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')

  assert.match(workbenchMode, /import \{ withRitual \} from '\.\.\/modules\/overlay\/useRitualOverlay'/)
  assert.match(workbenchMode, /await withRitual\('mode-switch'/)
  assert.match(workbenchMode, /signalReady\(\)/)
  assert.doesNotMatch(workbenchMode, /const MODE_TRANSITION_DURATION_MS\s*=\s*350/)
  assert.doesNotMatch(workbenchMode, /transitionTimerRef\.current\s*=\s*window\.setTimeout/)

  assert.match(ritualHook, /export type RitualStage = 'mode-switch' \| 'theme-transition'/)
  assert.match(ritualHook, /export type RitualPhase = 'idle' \| 'entering' \| 'holding' \| 'leaving'/)
  assert.match(ritualHook, /MODE_SWITCH_TIMELINE/)
  assert.match(ritualHook, /export async function withRitual/)
  assert.match(ritualHook, /signalReady/)
  assert.match(ritualHook, /prefers-reduced-motion/)

  assert.match(browserMask, /export const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'/)
  assert.match(browserMask, /export function beginBrowserMask/)
  assert.match(browserMask, /export async function endBrowserMask/)
  assert.match(browserMask, /requestAnimationFrame/)

  assert.match(ritualOverlay, /beginBrowserMask\(\)/)
  assert.match(ritualOverlay, /endBrowserMask\(\)/)
  assert.match(ritualOverlay, /data-ritual-overlay/)
  assert.match(ritualOverlay, /data-phase=/)

  assert.doesNotMatch(outlet, /MODE_SCENE_TRANSITION/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_OFFSET_PERCENT/)
  assert.doesNotMatch(outlet, /MODE_ENTERING_OFFSET_PERCENT/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_FADE_OPACITY/)
  assert.doesNotMatch(outlet, /MODE_FINISHING_SAFETY_MS/)
  assert.doesNotMatch(outlet, /resolveSceneTransform/)
  assert.doesNotMatch(outlet, /resolveSceneOpacity/)
  assert.doesNotMatch(outlet, /handleLeavingTransformEnd/)
  assert.doesNotMatch(outlet, /prepareAnimationFrame/)

  assert.doesNotMatch(browserMode, /browser-resize-shell-freeze/)
  assert.doesNotMatch(browserMode, /BROWSER_CAPTURE_FREEZE_EVENT/)
  assert.doesNotMatch(browserMode, /FREEZE_FRAME_CONFIG/)
  assert.doesNotMatch(browserMode, /shouldShowFreezeFrame/)
  assert.doesNotMatch(browserMode, /freezeFrameAnimRef/)

  assert.match(resizeFreeze, /captureStableFrame/)
  assert.doesNotMatch(resizeFreeze, /BROWSER_CAPTURE_FREEZE_EVENT/)
})
