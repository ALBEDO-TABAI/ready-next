import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Electron auto-updater registration is main-process lifecycle glue; this pins the singleton contract that prevents duplicate ipcMain.handle registration on macOS window recreation.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('auto updater IPC and listeners are registered once while status targets the current window', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  assert.match(mainIndex, /let autoUpdaterConfigured = false/)
  assert.match(mainIndex, /let autoUpdaterStatusWindow: BrowserWindow \| null = null/)
  assert.match(mainIndex, /autoUpdaterStatusWindow = mainWindow[\s\S]*if \(autoUpdaterConfigured\) return[\s\S]*autoUpdaterConfigured = true/)
  assert.match(mainIndex, /const updaterConfigPath = join\(process\.resourcesPath, 'app-update\.yml'\)/)
  assert.match(mainIndex, /if \(!updaterConfigAvailable\)[\s\S]*Update configuration is not available in this build/)
  assert.match(mainIndex, /const targetWindow = autoUpdaterStatusWindow[\s\S]*targetWindow\.webContents\.send\('update-status'/)
  assert.match(mainIndex, /ipcMain\.handle\('app:check-update'/)
  assert.match(mainIndex, /ipcMain\.handle\('app:install-update'/)
})
