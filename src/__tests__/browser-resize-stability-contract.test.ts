import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser host bounds do not add a second timer hop after renderer-side drag coalescing, so DOM chrome and page surface stay locked together while resizing', () => {
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')

  assert.match(
    hostLayout,
    /applyBounds\(view: BrowserHostView, bounds: BrowserRect, _?syncMode: BrowserBoundsSyncMode = 'settled'\): void \{/,
  )
  assert.match(
    hostLayout,
    /this\.setHostBoundsNow\(view, bounds\)/,
  )
  assert.doesNotMatch(hostLayout, /scheduleHostBounds\(/)
  assert.doesNotMatch(hostLayout, /clearScheduledBounds\(/)
  assert.doesNotMatch(hostLayout, /setTimeout\(\(\) => \{/)
})

test('browser bounds syncing bypasses the extra renderer rAF during active drag while preserving the scheduled path for non-drag transitions', () => {
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
  assert.match(boundsHook, /const dragBoundsSyncRafRef = useRef<number \| null>\(null\)/)
  assert.match(boundsHook, /const panelResizingRef = useRef\(false\)/)
  assert.match(boundsHook, /const panelResizeReasonRef = useRef<PanelResizeReason \| null>\(null\)/)
  assert.match(boundsHook, /const scheduleBoundsSync = useCallback\(/)
  assert.match(boundsHook, /const startDragBoundsSync = useCallback\(/)
  assert.match(boundsHook, /const stopDragBoundsSync = useCallback\(/)
  assert.match(boundsHook, /dragBoundsSyncRafRef\.current = window\.requestAnimationFrame\(tick\)/)
  assert.match(boundsHook, /window\.addEventListener\(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener\)/)
  assert.match(boundsHook, /if \(panelResizeReasonRef\.current === 'drag'\) \{[\s\S]*sendBoundsImmediate\(\{ syncMode: 'transient' \}\)/)
  assert.match(boundsHook, /if \(detail\.resizing\) \{[\s\S]*panelResizingRef\.current = true[\s\S]*panelResizeReasonRef\.current = detail\.reason/)
  assert.match(boundsHook, /if \(detail\.reason === 'drag'\) \{[\s\S]*clearFrameSync\(\)[\s\S]*startDragBoundsSync\(\)[\s\S]*return/)
  assert.match(boundsHook, /panelResizingRef\.current = false[\s\S]*stopDragBoundsSync\(\)[\s\S]*void scheduleBoundsSync\('settled', \{ force: true \}\)/)
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

test('browser mode surface readiness uses captureStableFrame and hides chrome jank via the shared ritual overlay instead of per-mode freeze frames', () => {
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
  assert.match(rafResizeDragHook, /new CustomEvent\(\s*PANEL_RESIZE_STATE_EVENT, \{ detail: \{ resizing: true, reason: 'drag' \} \}\s*\)/)
  assert.match(rafResizeDragHook, /new CustomEvent\(\s*PANEL_RESIZE_STATE_EVENT, \{ detail: \{ resizing: false, reason: 'drag' \} \}\s*\)/)
  assert.match(browserMode, /useBrowserResizeFreeze/)
  assert.match(browserMode, /const \[isBrowserSurfaceReady, setIsBrowserSurfaceReady\] = useState\(false\)/)
  assert.match(browserMode, /const captureTokenExpiryTimerRef = useRef<number \| null>\(null\)/)
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
  assert.match(browserMode, /await syncBrowserVisibility\('visible', \{ forceBoundsSync: true \}\)/)
  assert.match(browserMode, /const hostHasVisibleFrame = await captureStableFrame\(\)/)
  assert.match(browserMode, /if \(hostHasVisibleFrame\) \{[\s\S]*setIsBrowserSurfaceReady\(true\)/)
  assert.doesNotMatch(browserMode, /const BROWSER_SURFACE_READY_DELAY_MS = 16/)
  assert.match(browserMode, /return \(\) => \{\s*clearPostActivationHostResyncTimer\(\)\s*clearCaptureTokenExpiryTimer\(\)\s*clearSurfaceReadyTimer\(\)\s*\}/)
  // Ritual overlay supersedes per-mode freeze frames for mode transitions.
  assert.doesNotMatch(browserMode, /browser-resize-shell-freeze/)
  assert.doesNotMatch(browserMode, /shouldShowFreezeFrame/)
  assert.doesNotMatch(browserMode, /FREEZE_FRAME_CONFIG/)
  assert.doesNotMatch(browserMode, /BROWSER_CAPTURE_FREEZE_EVENT/)
  assert.doesNotMatch(browserMode, /cachedFreezeFrame/)
  assert.doesNotMatch(browserMode, /useEffect\(\(\) => \{\s*if \(!isElectron \|\| isMotionSettled\) return/)
  // captureStableFrame is now token-gated (one capture per 2s window on first idle).
  assert.match(browserMode, /const CAPTURE_TOKEN_WINDOW_MS = 2000/)
  assert.match(browserMode, /if \(captureTokenConsumedRef\.current\) return\s*captureTokenConsumedRef\.current = true/)
  assert.doesNotMatch(browserMode, /window\.setTimeout\([\s\S]{0,100}captureStableFrame\(\)[\s\S]{0,50}\}, 180\)/)
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
