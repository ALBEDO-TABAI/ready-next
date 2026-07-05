import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings page keeps the main workbench transparent shell structure', () => {
  // 合同随实现同步：2026-07-05 Settings.tsx 面板拆分，settings-ai-panel / settings-ai-light-card 锚点移至 settings/AISettingsPanel.tsx 与 settings/settings-shared.tsx（三文件都扫，断言不变量不动）。
  const settingsPage = [
    readWorkspaceFile('src/renderer/pages/Settings.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/AISettingsPanel.tsx'),
    readWorkspaceFile('src/renderer/pages/settings/settings-shared.tsx'),
  ].join('\n')

  assert.match(settingsPage, /data-liquid-shell="settings-header"/)
  assert.match(settingsPage, /data-liquid-shell="settings-sidebar"/)
  assert.match(settingsPage, /data-liquid-shell="settings-content"/)
  assert.match(settingsPage, /className="settings-page-shell flex h-full flex-col overflow-hidden"/)
  assert.match(settingsPage, /key=\{currentSection\?\.id \|\| 'unknown'\}[\s\S]*data-liquid-shell="settings-content"/)
  assert.match(settingsPage, /refreshTransparentSurface/)
  assert.match(settingsPage, /requestAnimationFrame\(\(\) => \{[\s\S]*requestSettingsSurfaceRefresh\(\)/)
  assert.match(settingsPage, /onMouseMove=\{handleSettingsSurfaceMotion\}/)
  assert.match(settingsPage, /onScroll=\{handleSettingsSurfaceScroll\}/)
  assert.match(settingsPage, /onMouseLeave=\{scheduleSettingsSurfaceRefresh\}/)
  assert.match(settingsPage, /sendIntent\(\{[\s\S]*kind: 'hide-all'[\s\S]*reason: 'overlay-open'/)
  assert.doesNotMatch(settingsPage, /data-liquid-shell="settings-header"[\s\S]*glass-surface-panel/)
  assert.match(settingsPage, /panel-hover-scrollbar flex-shrink-0 overflow-auto/)
  assert.match(settingsPage, /glass-surface-card/)
  assert.match(settingsPage, /className="settings-ai-panel/)
  assert.match(settingsPage, /settings-ai-light-card/)

  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  assert.doesNotMatch(styles, /--settings-list-item-bg\s*:/)
  assert.match(styles, /\.settings-page-shell\s*\{[\s\S]*?isolation:\s*isolate;[\s\S]*?background:\s*transparent;/)
  assert.doesNotMatch(styles, /--settings-page-clear-bg\s*:/)
  assert.doesNotMatch(styles, /html\[data-skin='liquid-glass'\] \[data-liquid-shell='settings-content'\]\s*\{[\s\S]*?background:/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.workbench-mode-root\s*\{[^}]*background:\s*transparent/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \[data-liquid-shell='settings-sidebar'\],[\s\S]*?html\[data-skin='liquid-glass'\] \[data-liquid-shell='settings-content'\],[\s\S]*?html\[data-skin='liquid-glass'\] \[data-liquid-scroll-root\]\s*\{[\s\S]*?contain:\s*paint;[\s\S]*?isolation:\s*isolate;[\s\S]*?transform:\s*translateZ\(0\);[\s\S]*?backface-visibility:\s*hidden;/)

  const main = readWorkspaceFile('src/main/index.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  assert.match(main, /ipcMain\.handle\('window:refreshTransparentSurface'/)
  assert.match(main, /ready-to-show'[\s\S]*refreshMainWindowTransparentSurface/)
  assert.doesNotMatch(main, /setBounds\(\{ \.\.\.bounds, width: bounds\.width \+ 1 \}/)
  assert.match(main, /invalidateShadow\(\)/)
  assert.match(main, /webContents\.invalidate\(\)/)
  assert.match(preload, /refreshTransparentSurface:\s*\(\) => ipcRenderer\.invoke\('window:refreshTransparentSurface'\)/)
  assert.match(rendererTypes, /refreshTransparentSurface:\s*\(\) => Promise<void>/)
})

test('settings navigation items keep the main workbench transparent glass backdrop', () => {
  const settingsTheme = readWorkspaceFile('src/renderer/components/settings/settings-theme.ts')

  assert.match(settingsTheme, /background:\s*'transparent'/)
  assert.doesNotMatch(settingsTheme, /--settings-list-item-bg/)
  assert.match(settingsTheme, /backdropFilter:\s*'none'/)
  assert.match(settingsTheme, /WebkitBackdropFilter:\s*'none'/)
})

test('file tree scroll root opts into the Chromium 148 liquid glass repaint guard', () => {
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(fileTree, /data-liquid-scroll-root="file-tree"/)
  assert.match(fileTree, /requestFileTreeSurfaceRefresh/)
  assert.match(fileTree, /scheduleFileTreeSurfaceRefresh/)
  assert.match(fileTree, /onMouseMove=\{handleFileTreeSurfaceMotion\}/)
  assert.match(fileTree, /onScroll=\{handleFileTreeSurfaceScroll\}/)
  assert.match(fileTree, /onMouseLeave=\{scheduleFileTreeSurfaceRefresh\}/)
  assert.match(chatMessages, /data-liquid-scroll-root="chat-messages"/)
  assert.doesNotMatch(chatMessages, /MaskImage|maskImage/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \[data-liquid-scroll-root\]\s*\{[\s\S]*?contain:\s*paint;[\s\S]*?transform:\s*translateZ\(0\)/)
})

test('workbench side and chat panels stay transparent while slots use the shared neutral glass tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const sliderStyles = readWorkspaceFile('src/renderer/styles/workbench-sliders.css')
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(styles, /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?background:\s*var\(--workbench-side-panel-bg\)/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-side-panel-bg:\s*transparent;/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(222,\s*222,\s*220,\s*0\.64\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(24,\s*39,\s*77,\s*0\.11\)/)
  assert.match(sliderStyles, /html\[data-skin='liquid-glass'\] \.icon-rail-slider\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-bg\)/)
  assert.match(sliderStyles, /html\[data-skin='liquid-glass'\] \.draggable-mode-tabs\s*\{[\s\S]*?background:\s*var\(--workbench-rail-slot-bg\)/)
  assert.match(sidePanel, /background:\s*'transparent'/)
  assert.match(chatPanel, /background:\s*'transparent'/)
  assert.doesNotMatch(styles, /html\[data-skin='liquid-glass'\] \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?background:/)
  assert.doesNotMatch(styles, /html\[data-skin='liquid-glass'\] \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?backdrop-filter:/)
})

test('shared settings theme keeps glass on outer cards while dense controls stay flat', () => {
  const settingsTheme = readWorkspaceFile('src/renderer/components/settings/settings-theme.ts')

  assert.match(settingsTheme, /var\(--lg-border-soft\)/)
  assert.match(settingsTheme, /var\(--lg-shadow-contact\)/)
  assert.match(settingsTheme, /backdropFilter:/)
  assert.match(settingsTheme, /WebkitBackdropFilter:/)
  assert.match(settingsTheme, /color-mix\(in srgb, var\(--surface-card-bg\)/)
  assert.match(settingsTheme, /SETTINGS_FLAT_CARD_STYLE/)
  assert.match(settingsTheme, /SETTINGS_FLAT_INPUT_STYLE:[\s\S]*backdropFilter:\s*'none'/)
})

test('shared liquid glass surfaces remain real backdrop blur instead of flat paint', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(styles, /\.glass-surface-panel,[\s\S]*?\.glass-surface-card,[\s\S]*?\.glass-surface-floating\s*\{[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-medium\)\) saturate\(var\(--surface-saturate\)\)/)
  assert.match(styles, /\.glass-surface-card\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--lg-material-card\) 58%, transparent\)[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-soft\)\) saturate\(var\(--surface-saturate\)\)/)
  assert.match(styles, /\.glass-surface-floating\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--lg-material-floating\) 62%, transparent\)[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-strong\)\) saturate\(var\(--surface-saturate\)\)/)
})

test('compact utility settings opt into short control slots so labels do not collapse into vertical stacks', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  // Note: storage section (cacheSize / clearCache) is rendered via the dynamic
  // StorageSettingsPanel since D1; it manages its own layout and no longer
  // participates in the legacy slotWidth contract.
  assert.match(settingsPage, /id: 'newTask'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'sendMessage'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'search'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'toggleSidebar'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'switchMode'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'version'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'checkUpdate'[\s\S]*slotWidth: 'short'/)
})
