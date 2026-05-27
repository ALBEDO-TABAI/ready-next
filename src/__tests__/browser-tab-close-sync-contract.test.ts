import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser closeTab pushes a closed event so renderer persistence cannot keep stale tabs', () => {
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/modules/browser/types.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')

  assert.match(ipcShell, /ipcMain\.handle\('browser:closeTab', \(event, tabId: string\) =>/)
  assert.match(ipcShell, /event\.sender\.send\('browser:tabUpdate', \{[\s\S]*type: 'closed'[\s\S]*tabId,[\s\S]*activeTabId: controller\.activeTabId/)
  assert.match(runtimeHook, /case 'closed': \{[\s\S]*store\.removeTab\(event\.tabId\)[\s\S]*nextStore\.setActiveTabId\(nextActiveTabId\)[\s\S]*finalStore\.setUrlInput/)
  assert.match(rendererTypes, /type: 'title' \| 'navigate' \| 'loading' \| 'error' \| 'meta' \| 'closed'/)
  assert.match(electronTypes, /type: 'title' \| 'navigate' \| 'loading' \| 'error' \| 'meta' \| 'closed'/)
})
