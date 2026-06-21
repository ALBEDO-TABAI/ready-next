import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed contract: native BrowserWindow overlay wiring cannot be proven in a unit-level DOM behavior test.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('P7c3 uses a native child window lock overlay rather than a DOM z-index badge', () => {
  const shared = readWorkspaceFile('src/shared/browser-lock-overlay.ts')
  const overlayWindow = readWorkspaceFile('src/main/modules/browser-engine/browser-lock-overlay-window.ts')
  const overlayIpc = readWorkspaceFile('src/main/modules/browser-engine/ipc-browser-lock-overlay.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/browser-engine/ipc-handler.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const overlayPage = readWorkspaceFile('src/renderer/pages/BrowserLockOverlayWindow.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(shared, /BrowserLockOverlaySnapshot/)
  assert.match(overlayWindow, /new BrowserWindow/)
  assert.match(overlayWindow, /parent: this\.options\.mainWindow/)
  assert.match(overlayWindow, /showInactive\(\)/)
  assert.match(overlayWindow, /setAlwaysOnTop\(true, 'floating'\)/)
  assert.match(overlayWindow, /moveTop\(\)/)
  assert.match(overlayWindow, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  assert.match(overlayWindow, /\/#\/browser-lock-overlay/)
  assert.doesNotMatch(overlayWindow, /addBrowserView/)
  assert.doesNotMatch(overlayWindow, /contentView\.addChildView/)

  assert.match(overlayIpc, /browser:lockOverlayShow/)
  assert.match(overlayIpc, /browser:lockOverlayHide/)
  assert.match(ipcHandler, /setupBrowserLockOverlayIPC/)
  assert.match(preload, /showBrowserLockOverlay/)
  assert.match(preload, /onBrowserLockOverlaySnapshot/)
  assert.match(app, /BrowserLockOverlayWindow/)
  assert.match(app, /\/browser-lock-overlay/)
  assert.match(overlayPage, /data-browser-lock-overlay-root/)
  assert.match(overlayPage, /data-p7c3-proof-marker/)
  assert.match(browserMode, /data-browser-content-frame/)
  assert.match(browserMode, /showBrowserLockOverlay/)
  assert.match(browserMode, /hideBrowserLockOverlay/)
})
