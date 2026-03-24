import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser host visibility is explicitly gated and browser bounds keep BrowserView below the DOM-only browser header while side/chat panels get rounded outer frames', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const browserShellLayout = readWorkspaceFile('src/renderer/components/browser/BrowserShellLayout.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const ipcData = readWorkspaceFile('src/main/modules/browser-engine/ipc-data.ts')
  const tabShell = readWorkspaceFile('src/main/modules/browser-engine/tab-shell-service.ts')
  const lifecycle = readWorkspaceFile('src/main/modules/browser-engine/tab-lifecycle-service.ts')
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(preload, /hideAll:\s*\(\)\s*=> ipcRenderer\.invoke\('browser:hideAll'\)/)
  assert.match(electronTypes, /hideAll:\s*\(\)\s*=> Promise<\{ success: boolean \}>/)
  assert.match(preload, /showUtilityMenu:\s*\(payload: BrowserUtilityMenuRequest\)\s*=> ipcRenderer\.invoke\('browser:showUtilityMenu', payload\)/)
  assert.match(electronTypes, /showUtilityMenu:\s*\(payload: BrowserUtilityMenuRequest\)\s*=> Promise<\{ success: boolean; error\?: string \}>/)
  assert.match(ipcShell, /hideAllHosts\(\): \{ success: boolean \}/)
  assert.match(ipcShell, /ipcMain\.handle\('browser:hideAll'/)
  assert.match(ipcData, /ipcMain\.handle\('browser:showUtilityMenu'/)
  assert.match(tabShell, /hideAllHosts\(\): \{ success: boolean \}/)
  assert.match(tabShell, /this\.host\.hideHost\(activeTab\.view\)/)
  assert.match(hostLayout, /hideHost\(view: BrowserHostView\): void \{[\s\S]*this\.setHostBoundsNow\(view, this\.offscreenBounds\)/)
  assert.match(lifecycle, /shouldShow:\s*boolean/)
  assert.match(lifecycle, /if \(shouldShow && this\.host\.shouldPresentHosts\(\)\)/)

  assert.match(boundsHook, /topInset:\s*number/)
  assert.match(boundsHook, /const y = Math\.round\(rect\.top - topInset\)/)
  assert.match(boundsHook, /const height = Math\.round\(rect\.height \+ topInset\)/)
  assert.match(browserMode, /topInset:\s*0/)
  assert.doesNotMatch(browserMode, /topInset:\s*WORKBENCH_TOOLBAR_ROW_HEIGHT/)
  assert.doesNotMatch(browserMode, /const \[activePanel, setActivePanel\] = useState/)
  assert.doesNotMatch(browserMode, /activePanel,/)
  assert.doesNotMatch(boundsHook, /activePanel:/)
  assert.doesNotMatch(browserShellLayout, /BrowserSidePanel/)
  assert.match(workbenchMode, /browser\.hideAll\(\)/)
  assert.doesNotMatch(workbenchMode, /browser\.hideActiveHost\(\)/)

  assert.match(sidePanel, /className="workbench-panel-frame/)
  assert.match(chatPanel, /className="workbench-panel-frame/)
  assert.match(styles, /\.workbench-panel-frame\s*\{/)
  assert.match(styles, /border-radius:\s*var\(--workbench-canvas-radius\);/)
})
