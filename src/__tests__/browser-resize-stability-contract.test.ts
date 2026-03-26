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
  assert.match(browserMode, /surfaceRef:\s*shellRef/)
  assert.doesNotMatch(browserShellLayout, /browser-resize-freeze-frame/)
  assert.match(freezeHook, /surfaceRef: RefObject<HTMLDivElement \| null>/)
  assert.match(freezeHook, /captureWindowSnapshot/)
  assert.match(freezeHook, /const FREEZE_RELEASE_DELAY_MS = 220/)
  assert.match(freezeHook, /window\.setTimeout\(\(\) => \{\s*void sendBoundsImmediate\(\{ forceExact: true \}\)/)
  assert.doesNotMatch(freezeHook, /captureViewportSnapshot/)
  assert.doesNotMatch(freezeHook, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.match(preload, /captureWindowSnapshot:\s*\(bounds: \{ x: number; y: number; width: number; height: number \}\)\s*=>\s*ipcRenderer\.invoke\('browser:captureWindowSnapshot', bounds\)/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:captureWindowSnapshot', async \(_, bounds: \{ x: number; y: number; width: number; height: number \}\) => \{/)
  assert.match(ipcHandler, /async captureWindowSnapshot\(bounds: BrowserRect\): Promise<\{ success: boolean; data\?: string; error\?: string \}>/)
})
