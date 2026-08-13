import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser controller rebinds to newly created windows instead of staying attached to the original main window', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const hostRuntime = readWorkspaceFile('src/main/modules/browser-engine/browser-controller-host-runtime.ts')
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')

  assert.match(hostRuntime, /attachWindow\(mainWindow: BrowserWindow\): void/)
  assert.match(hostLayout, /setMainWindow\(mainWindow: BrowserWindow\): void/)
  assert.match(mainIndex, /if \(!windowIPCRegistered\) \{[\s\S]*const window = mainWindow[\s\S]*setupBrowserIPC\(window, ENABLE_MOCK_SERVICES, \{[\s\S]*browserController = currentBrowserController[\s\S]*windowIPCRegistered = true[\s\S]*\} else \{[\s\S]*browserController\?\.attachWindow\(mainWindow\)/)
  assert.match(mainIndex, /const closedWindow = mainWindow[\s\S]*mainWindow\.on\('closed', \(\) => \{[\s\S]*if \(mainWindow === closedWindow\) \{[\s\S]*mainWindow = null/)
})
