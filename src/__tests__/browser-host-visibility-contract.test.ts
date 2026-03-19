import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser host visibility is explicitly gated and browser bounds support top inset while side/chat panels get rounded outer frames', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const tabShell = readWorkspaceFile('src/main/modules/browser-engine/tab-shell-service.ts')
  const lifecycle = readWorkspaceFile('src/main/modules/browser-engine/tab-lifecycle-service.ts')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(preload, /hideActiveHost:\s*\(\)\s*=> ipcRenderer\.invoke\('browser:hideActiveHost'\)/)
  assert.match(electronTypes, /hideActiveHost:\s*\(\)\s*=> Promise<\{ success: boolean \}>/)
  assert.match(ipcShell, /hideActiveHost\(\): \{ success: boolean \}/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:hideActiveHost'/)
  assert.match(tabShell, /hideActiveHostOnly\(\): \{ success: boolean \}/)
  assert.match(lifecycle, /shouldShow:\s*boolean/)
  assert.match(lifecycle, /if \(shouldShow && this\.host\.shouldPresentHosts\(\)\)/)

  assert.match(boundsHook, /topInset:\s*number/)
  assert.match(boundsHook, /const y = Math\.round\(rect\.top - topInset\)/)
  assert.match(boundsHook, /const height = Math\.round\(rect\.height \+ topInset\)/)
  assert.match(browserMode, /WORKBENCH_TOOLBAR_ROW_HEIGHT/)
  assert.match(browserMode, /topInset:\s*WORKBENCH_TOOLBAR_ROW_HEIGHT/)
  assert.match(workbenchMode, /browser\.hideActiveHost\(\)/)

  assert.match(sidePanel, /className="workbench-panel-frame/)
  assert.match(chatPanel, /className="workbench-panel-frame/)
  assert.match(styles, /\.workbench-panel-frame\s*\{/)
  assert.match(styles, /border-radius:\s*var\(--workbench-canvas-radius\);/)
})
