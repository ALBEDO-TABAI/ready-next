import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser host bounds are applied immediately during layout updates so DOM chrome and page surface stay locked together while resizing', () => {
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')

  assert.match(
    hostLayout,
    /applyBounds\(view: BrowserHostView, bounds: BrowserRect\): void \{[\s\S]*this\.setHostBoundsNow\(view, bounds\)/,
  )
  assert.doesNotMatch(
    hostLayout,
    /applyBounds\(view: BrowserHostView, bounds: BrowserRect\): void \{[\s\S]*this\.scheduleHostBounds\(view, bounds\)/,
  )
})

test('browser bounds syncing does not skip fine-grained drag updates and bypasses extra frame delay while the user is resizing panels', () => {
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(
    boundsHook,
    /if \(document\.body\.classList\.contains\('resizing'\)\) \{[\s\S]*sendBoundsImmediate\(\{ forceExact: true \}\)/,
  )
  assert.doesNotMatch(boundsHook, /widthDelta < 4/)
  assert.doesNotMatch(boundsHook, /xDelta < 4/)
})

test('high-frequency browser bounds syncing uses a fire-and-forget IPC path instead of waiting on invoke round-trips', () => {
  const preload = readWorkspaceFile('src/preload/index.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')

  assert.match(preload, /updateBounds:\s*\(bounds: \{ x: number; y: number; width: number; height: number \}\)\s*=>\s*\{[\s\S]*ipcRenderer\.send\('browser:updateBounds', bounds\)/)
  assert.match(ipcShell, /ipcMain\.on\('browser:updateBounds', \(_, bounds: \{ x: number; y: number; width: number; height: number \}\) => \{/)
})

test('browser mode can freeze the live page into a DOM snapshot during panel drags so native content does not visibly jitter under the shell', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const browserShellLayout = readWorkspaceFile('src/renderer/components/browser/BrowserShellLayout.tsx')
  const freezeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserResizeFreeze.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/browser-engine/ipc-handler.ts')

  assert.match(workbenchMode, /PANEL_RESIZE_STATE_EVENT/)
  assert.match(workbenchMode, /new CustomEvent\(PANEL_RESIZE_STATE_EVENT, \{[\s\S]*resizing: true/)
  assert.match(workbenchMode, /new CustomEvent\(PANEL_RESIZE_STATE_EVENT, \{[\s\S]*resizing: false/)
  assert.match(browserMode, /useBrowserResizeFreeze/)
  assert.match(browserMode, /browser-resize-shell-freeze/)
  assert.match(browserMode, /const visibleFreezeFrame = freezeFrame \?\? cachedFreezeFrame/)
  assert.match(browserMode, /const shouldUseNeutralFreezeFrameExit = !freezeFrame && Boolean\(cachedFreezeFrame\?\.src\)/)
  assert.match(browserMode, /const \[isBrowserSurfaceReady, setIsBrowserSurfaceReady\] = useState\(false\)/)
  assert.match(browserMode, /if \(tabs\.length === 0\) \{/)
  assert.match(browserMode, /const modeRootRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(browserMode, /surfaceRef:\s*shellRef/)
  assert.match(browserMode, /<div ref=\{modeRootRef\} className="workbench-mode-root relative">/)
  assert.match(browserMode, /<BrowserHeader/)
  assert.match(browserMode, /activeTabId,/)
  assert.match(browserMode, /const surfaceReadyTimerRef = useRef<number \| null>\(null\)/)
  assert.match(browserMode, /const clearSurfaceReadyTimer = useCallback\(\(\) => \{/)
  assert.match(browserMode, /setIsBrowserSurfaceReady\(false\)/)
  assert.match(browserMode, /await syncBrowserVisibility\(\{ forceExact: true \}\)/)
  assert.match(browserMode, /await new Promise\(\(resolve\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => resolve\(undefined\)\)\)\)/)
  assert.match(browserMode, /const BROWSER_SURFACE_READY_DELAY_MS = 16/)
  assert.match(browserMode, /surfaceReadyTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*setIsBrowserSurfaceReady\(true\)[\s\S]*\}, BROWSER_SURFACE_READY_DELAY_MS\)/)
  assert.match(browserMode, /return \(\) => \{[\s\S]*clearSurfaceReadyTimer\(\)[\s\S]*\}/)
  assert.match(browserMode, /const shouldShowFreezeFrame = Boolean\(visibleFreezeFrame\?\.src\) && \(!isMotionSettled \|\| !isBrowserSurfaceReady \|\| Boolean\(freezeFrame\)\)/)
  assert.match(browserMode, /const targetBlur = shouldUseNeutralFreezeFrameExit \? 0 : FREEZE_FRAME_CONFIG\.blurEndPx/)
  assert.match(browserMode, /const targetScale = shouldUseNeutralFreezeFrameExit \? 1 : FREEZE_FRAME_CONFIG\.scaleEnd/)
  assert.match(browserMode, /const handleCaptureFreeze = \(\) => \{\s*if \(!isActive\) return\s*void captureStableFrame\(\)\s*\}/)
  assert.match(browserMode, /useEffect\(\(\) => \{\s*if \(!isElectron \|\| isMotionSettled\) return/)
  assert.match(browserMode, /useEffect\(\(\) => \{[\s\S]*void window\.electronAPI\?\.browser\?\.hideAll\?\.\(\)[\s\S]*\}, \[isElectron, isMotionSettled\]\)/)
  assert.doesNotMatch(browserMode, /if \(!shouldRevealBrowserHost \|\| !browserRuntimeReady \|\| !activeTabId \|\| activeTab\?\.loading\) return[\s\S]*captureStableFrame\(\)/)
  assert.doesNotMatch(browserMode, /window\.setInterval\(\(\) => \{[\s\S]*captureStableFrame\(\)[\s\S]*\}, 30000\)/)
  assert.doesNotMatch(browserMode, /if \(!isMotionSettled\) \{[\s\S]*captureStableFrame\(\)\.then\(\(\) => \{/)
  assert.doesNotMatch(browserShellLayout, /freezeOverlay\?: ReactNode/)
  assert.doesNotMatch(browserShellLayout, /\{freezeOverlay\}/)
  assert.doesNotMatch(browserShellLayout, /browser-resize-freeze-frame/)
  assert.doesNotMatch(browserShellLayout, /maskSurfaceUntilReady\?: boolean/)
  assert.doesNotMatch(browserShellLayout, /browser-surface-mask/)
  assert.match(freezeHook, /surfaceRef: RefObject<HTMLDivElement \| null>/)
  assert.match(freezeHook, /activeTabId: string \| null/)
  assert.match(freezeHook, /const \[cachedFreezeFrame, setCachedFreezeFrameState\] = useState<BrowserResizeFreezeFrame \| null>\(\(\) => \(activeTabId \? cachedFreezeFramesByTabId\.get\(activeTabId\) \?\? null : null\)\)/)
  assert.match(freezeHook, /const cachedFreezeFramesByTabId = new Map<string, BrowserResizeFreezeFrame>\(\)/)
  assert.match(freezeHook, /activeTabIdRef\.current = activeTabId/)
  assert.match(freezeHook, /setCachedFreezeFrameForTab\(activeTabIdRef\.current, nextFrame\)/)
  assert.match(freezeHook, /if \(activeTabId\) return/)
  assert.match(freezeHook, /clearCachedFreezeFrame\(null\)/)
  assert.doesNotMatch(freezeHook, /return \(\) => \{[\s\S]*clearCachedFreezeFrame\(\)/)
  assert.match(freezeHook, /captureWindowSnapshot/)
  assert.match(freezeHook, /const FREEZE_RELEASE_DELAY_MS = 220/)
  assert.match(freezeHook, /const recaptureFreezeFrame = useCallback\(async \(sessionId: number\) => \{/)
  assert.match(freezeHook, /const settleSessionId = captureSessionRef\.current/)
  assert.match(freezeHook, /void recaptureFreezeFrame\(settleSessionId\)/)
  assert.match(freezeHook, /cachedFreezeFrame,/)
  assert.match(freezeHook, /captureStableFrame,/)
  assert.match(freezeHook, /fitActiveTabToBounds/)
  assert.match(ipcHandler, /view\.webContents\.setZoomFactor\(zoomFactor\)/)
  assert.doesNotMatch(ipcHandler, /root\.style\.zoom =/)
  assert.doesNotMatch(freezeHook, /captureViewportSnapshot/)
  assert.doesNotMatch(freezeHook, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.match(preload, /fitActiveTabToBounds:\s*\(tabId\?: string \| null\)\s*=>\s*ipcRenderer\.invoke\('browser:fitActiveTabToBounds', tabId\)/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:fitActiveTabToBounds', async \(_, tabId\?: string \| null\) => \{/)
  assert.match(ipcHandler, /async fitActiveTabToBounds\(tabId\?: string \| null\): Promise<\{ success: boolean; zoomFactor\?: number; error\?: string \}>/)
  assert.match(preload, /captureWindowSnapshot:\s*\(bounds: \{ x: number; y: number; width: number; height: number \}\)\s*=>\s*ipcRenderer\.invoke\('browser:captureWindowSnapshot', bounds\)/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:captureWindowSnapshot', async \(_, bounds: \{ x: number; y: number; width: number; height: number \}\) => \{/)
  assert.match(ipcHandler, /async captureWindowSnapshot\(bounds: BrowserRect\): Promise<\{ success: boolean; data\?: string; error\?: string \}>/)
})
