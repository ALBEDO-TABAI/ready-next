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
    /applyBounds\(view: BrowserHostView, bounds: BrowserRect, syncMode: BrowserBoundsSyncMode = 'settled'\): void \{/,
  )
  assert.match(
    hostLayout,
    /if \(syncMode === 'transient'\) \{[\s\S]*this\.scheduleHostBounds\(view, bounds\)/,
  )
  assert.match(
    hostLayout,
    /this\.clearScheduledBounds\(view\)[\s\S]*this\.setHostBoundsNow\(view, bounds\)/,
  )
})

test('browser bounds syncing does not skip fine-grained drag updates and bypasses extra frame delay while the user is resizing panels', () => {
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(
    boundsHook,
    /const buildBoundsSignature = \(bounds: MeasuredBounds, syncMode: BrowserBoundsSyncMode\) =>/,
  )
  assert.match(
    boundsHook,
    /`\$\{syncMode\}:\$\{bounds\.x\}:\$\{bounds\.y\}:\$\{bounds\.width\}:\$\{bounds\.height\}`/,
  )
  assert.match(boundsHook, /const frameSyncRequestRef = useRef<PendingBoundsSyncRequest \| null>\(null\)/)
  assert.match(boundsHook, /const panelResizingRef = useRef\(false\)/)
  assert.match(boundsHook, /const scheduleBoundsSync = useCallback\(/)
  assert.match(boundsHook, /window\.addEventListener\(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener\)/)
  assert.match(boundsHook, /if \(detail\.resizing\) \{[\s\S]*panelResizingRef\.current = true/)
  assert.match(boundsHook, /panelResizingRef\.current = false[\s\S]*void scheduleBoundsSync\('settled', \{ force: true \}\)/)
  assert.match(boundsHook, /subscribeWorkbenchWindowResize/)
  assert.doesNotMatch(boundsHook, /const startBoundsTracking = useCallback/)
  assert.doesNotMatch(boundsHook, /boundsTrackingRafRef/)
  assert.doesNotMatch(boundsHook, /window\.addEventListener\('resize', handleResize\)/)
})

test('high-frequency browser bounds syncing uses a fire-and-forget IPC path instead of waiting on invoke round-trips', () => {
  const preload = readWorkspaceFile('src/preload/index.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')

  assert.match(preload, /updateBounds:\s*\(bounds: \{ x: number; y: number; width: number; height: number; syncMode\?: BrowserBoundsSyncMode \}\)\s*=>\s*\{[\s\S]*ipcRenderer\.send\('browser:updateBounds', bounds\)/)
  assert.match(electronTypes, /syncMode\?: BrowserBoundsSyncMode/)
  assert.match(ipcShell, /ipcMain\.on\('browser:updateBounds', \(_, bounds: \{ x: number; y: number; width: number; height: number; syncMode\?: BrowserBoundsSyncMode \}\) => \{/)
})

test('browser mode prefers cached stable frames during workbench motion and refreshes them after the live host settles', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const rafResizeDragHook = readWorkspaceFile('src/renderer/modules/workbench/useRafResizeDrag.ts')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const browserShellLayout = readWorkspaceFile('src/renderer/components/browser/BrowserShellLayout.tsx')
  const freezeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserResizeFreeze.ts')
  const hostedPreviewBoundsHook = readWorkspaceFile('src/renderer/modules/browser/useHostedPreviewBounds.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/browser-engine/ipc-handler.ts')

  assert.match(workbenchMode, /useRafResizeDrag/)
  assert.match(workbenchMode, /dispatchPanelResizeEvent: true/)
  assert.match(rafResizeDragHook, /PANEL_RESIZE_STATE_EVENT/)
  assert.match(rafResizeDragHook, /new CustomEvent\(\s*PANEL_RESIZE_STATE_EVENT, \{ detail: \{ resizing: true \} \}\s*\)/)
  assert.match(rafResizeDragHook, /new CustomEvent\(\s*PANEL_RESIZE_STATE_EVENT, \{ detail: \{ resizing: false \} \}\s*\)/)
  assert.match(browserMode, /useBrowserResizeFreeze/)
  assert.match(browserMode, /browser-resize-shell-freeze/)
  assert.match(browserMode, /className="browser-resize-shell-freeze"[\s\S]*top:\s*WORKBENCH_TAB_ROW_HEIGHT/)
  assert.match(browserMode, /className="browser-resize-shell-freeze"[\s\S]*borderRadius:\s*'0 0 var\(--workbench-canvas-radius\) var\(--workbench-canvas-radius\)'/)
  assert.match(browserMode, /const visibleFreezeFrame = freezeFrame \?\? cachedFreezeFrame/)
  assert.match(browserMode, /const shouldUseNeutralFreezeFrameExit = !freezeFrame && Boolean\(cachedFreezeFrame\?\.src\)/)
  assert.match(browserMode, /const \[isBrowserSurfaceReady, setIsBrowserSurfaceReady\] = useState\(false\)/)
  assert.match(browserMode, /const stableFrameRefreshTimerRef = useRef<number \| null>\(null\)/)
  assert.match(browserMode, /layoutPhase !== 'idle'/)
  assert.match(browserMode, /if \(tabs\.length === 0\) \{/)
  assert.match(browserMode, /const modeRootRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(browserMode, /surfaceRef:\s*contentRef/)
  assert.doesNotMatch(browserMode, /surfaceRef:\s*shellRef/)
  assert.match(browserMode, /<div ref=\{modeRootRef\} className="workbench-mode-root relative">/)
  assert.match(browserMode, /<BrowserHeader/)
  assert.match(browserMode, /activeTabId,/)
  assert.match(browserMode, /const surfaceReadyTimerRef = useRef<number \| null>\(null\)/)
  assert.match(browserMode, /const clearSurfaceReadyTimer = useCallback\(\(\) => \{/)
  assert.match(browserMode, /setIsBrowserSurfaceReady\(false\)/)
  assert.match(browserMode, /await syncBrowserVisibility\(\{ forceExact: true \}\)/)
  assert.match(browserMode, /await new Promise\(\(resolve\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => resolve\(undefined\)\)\)\)/)
  assert.match(browserMode, /const hostHasVisibleFrame = await captureStableFrame\(\)/)
  assert.match(browserMode, /if \(hostHasVisibleFrame\) \{[\s\S]*setIsBrowserSurfaceReady\(true\)/)
  assert.doesNotMatch(browserMode, /const BROWSER_SURFACE_READY_DELAY_MS = 16/)
  assert.match(browserMode, /return \(\) => \{[\s\S]*clearSurfaceReadyTimer\(\)[\s\S]*\}/)
  assert.match(browserMode, /const shouldShowFreezeFrame = Boolean\(visibleFreezeFrame\?\.src\) && \(layoutPhase !== 'idle' \|\| !isBrowserSurfaceReady \|\| Boolean\(freezeFrame\)\)/)
  assert.match(browserMode, /const targetBlur = shouldUseNeutralFreezeFrameExit \? 0 : FREEZE_FRAME_CONFIG\.blurEndPx/)
  assert.match(browserMode, /const targetScale = shouldUseNeutralFreezeFrameExit \? 1 : FREEZE_FRAME_CONFIG\.scaleEnd/)
  assert.match(browserMode, /const handleCaptureFreeze = \(\) => \{\s*if \(!isActive\) return\s*void captureStableFrame\(\)\s*\}/)
  // hide-during-motion decision now lives inside useBrowserViewBounds.syncBrowserVisibility (reacts to isVisibleAllowed prop)
  assert.doesNotMatch(browserMode, /useEffect\(\(\) => \{\s*if \(!isElectron \|\| isMotionSettled\) return/)
  assert.match(browserMode, /if \(!isActive \|\| layoutPhase !== 'idle' \|\| !isBrowserHostFullyVisible \|\| activeTab\?\.loading\) return/)
  assert.doesNotMatch(browserMode, /if \(previousShouldPrepareBrowserHostRef\.current && !shouldPrepareBrowserHost\) \{[\s\S]*captureStableFrame\(\)/)
  assert.doesNotMatch(workbenchMode, /window\.dispatchEvent\(new CustomEvent\('ready:browser-capture-freeze'\)\)/)
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

  assert.match(hostedPreviewBoundsHook, /const frameRafRef = useRef<number \| null>\(null\)/)
  assert.match(hostedPreviewBoundsHook, /const settleTimerRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/)
  assert.match(hostedPreviewBoundsHook, /const panelResizingRef = useRef\(false\)/)
  assert.match(hostedPreviewBoundsHook, /const scheduleSync = useCallback\(/)
  assert.match(hostedPreviewBoundsHook, /window\.addEventListener\(PANEL_RESIZE_STATE_EVENT, handlePanelResize as EventListener\)/)
  assert.match(hostedPreviewBoundsHook, /subscribeWorkbenchWindowResize/)
  assert.doesNotMatch(hostedPreviewBoundsHook, /const startBoundsTracking = useCallback/)
  assert.doesNotMatch(hostedPreviewBoundsHook, /const trackDuration = 400/)
  assert.doesNotMatch(hostedPreviewBoundsHook, /window\.addEventListener\('resize', onResize\)/)
})
