import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab reorder updates both renderer order and main-process tab order through an explicit IPC path', () => {
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const tabActions = readWorkspaceFile('src/renderer/modules/browser/useBrowserTabActions.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const tabRuntime = readWorkspaceFile('src/main/modules/browser-engine/browser-controller-tab-runtime.ts')

  assert.match(preload, /reorderTabs:\s*\(tabIds: string\[\]\)\s*=> ipcRenderer\.invoke\('browser:reorderTabs', tabIds\)/)
  assert.match(electronTypes, /reorderTabs:\s*\(tabIds: string\[\]\)\s*=> Promise<\{ success: boolean; error\?: string \}>/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:reorderTabs', \(_, tabIds: string\[\]\) =>/)
  assert.match(tabRuntime, /reorderTabs\(tabIds: string\[\]\): \{ success: boolean; error\?: string \}/)
  assert.match(tabActions, /const orderedTabIds = reordered\.map\(\(tab\) => tab\.id\)/)
  assert.match(tabActions, /await window\.electronAPI\?\.browser\?\.reorderTabs\(orderedTabIds\)/)
})
