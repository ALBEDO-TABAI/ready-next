import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

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
  // 2026-10-02 设置页视觉重整：内容直接落在窗口玻璃底上（与工作台同源），不再额外铺整块画布；
  // 卡片与控件统一走 settings-surfaces.css 的 sx-* 体系，不再逐个挂 glass-surface-card。
  assert.match(settingsPage, /<div className="flex-1 min-w-0 overflow-hidden">\s*<div\s+key=\{currentSection\?\.id \|\| 'unknown'\}\s+data-liquid-shell="settings-content"/)
  assert.doesNotMatch(settingsPage, /sx-canvas/)
  assert.match(settingsPage, /className="settings-ai-panel/)
  assert.match(settingsPage, /settings-ai-light-card/)

  const styles = readRendererStyles()
  assert.doesNotMatch(styles, /--settings-list-item-bg\s*:/)
  assert.match(styles, /\.settings-page-shell\s*\{[\s\S]*?isolation:\s*isolate;[\s\S]*?background:\s*transparent;/)
  assert.doesNotMatch(styles, /--settings-page-clear-bg\s*:/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='settings-content'\]\s*\{[\s\S]*?background:/)
  assert.match(styles, /html:root \.workbench-mode-root\s*\{[^}]*background:\s*transparent/)
  assert.match(styles, /html:root \[data-liquid-shell='settings-sidebar'\],[\s\S]*?html:root \[data-liquid-shell='settings-content'\],[\s\S]*?html:root \[data-liquid-scroll-root\]\s*\{[\s\S]*?contain:\s*paint;[\s\S]*?isolation:\s*isolate;[\s\S]*?transform:\s*translateZ\(0\);[\s\S]*?backface-visibility:\s*hidden;/)

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

test('settings navigation items keep the transparent backdrop and leave hover / current state to shared classes', () => {
  const settingsTheme = readWorkspaceFile('src/renderer/components/settings/settings-theme.ts')
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const surfaces = readWorkspaceFile('src/renderer/styles/settings-surfaces.css')

  // 导航项 inline 只留透明度，不写 background / border：hover 与当前态由 sx-nav-item 类统一驱动（inline 会盖掉 :hover）。
  const listItemStyle = settingsTheme.match(/export function settingsListItemStyle\(active: boolean\): CSSProperties \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(listItemStyle, 'settingsListItemStyle stays exported')
  assert.doesNotMatch(listItemStyle, /\b(?:background|border|boxShadow)\s*:/)
  assert.doesNotMatch(settingsTheme, /--settings-list-item-bg/)
  assert.match(settingsPage, /aria-current=\{isActive \? 'page' : undefined\}[\s\S]*?className="sx-nav-item"/)
  assert.match(surfaces, /\.sx-nav-item:hover:not\(\[aria-current='page'\]\)\s*\{[\s\S]*?background:\s*var\(--sx-raised-hover\)/)
  assert.match(surfaces, /\.sx-nav-item\[aria-current='page'\]\s*\{[\s\S]*?background:\s*var\(--sx-raised-bg\);[\s\S]*?box-shadow:\s*var\(--sx-raised-shadow\)/)
})

test('file tree scroll root opts into the Chromium 148 liquid glass repaint guard', () => {
  const fileTree = readWorkspaceFile('src/renderer/components/layout/FileTree.tsx')
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const styles = readRendererStyles()

  assert.match(fileTree, /data-liquid-scroll-root="file-tree"/)
  assert.match(fileTree, /requestFileTreeSurfaceRefresh/)
  assert.match(fileTree, /scheduleFileTreeSurfaceRefresh/)
  assert.match(fileTree, /onMouseMove=\{handleFileTreeSurfaceMotion\}/)
  assert.match(fileTree, /onScroll=\{handleFileTreeSurfaceScroll\}/)
  assert.match(fileTree, /onMouseLeave=\{scheduleFileTreeSurfaceRefresh\}/)
  assert.match(chatMessages, /data-liquid-scroll-root="chat-messages"/)
  assert.doesNotMatch(chatMessages, /MaskImage|maskImage/)
  assert.match(styles, /html:root \[data-liquid-scroll-root\]\s*\{[\s\S]*?contain:\s*paint;[\s\S]*?transform:\s*translateZ\(0\)/)
})

test('workbench side and chat panels stay transparent while slots use the shared neutral glass tokens', () => {
  const styles = readRendererStyles()
  const sidePanel = readWorkspaceFile('src/renderer/components/layout/SidePanel.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(styles, /\.workbench-panel-frame\[data-side-panel-variant='files'\]\s*\{[\s\S]*?background:\s*var\(--workbench-side-panel-bg\)/)
  // html:root now includes the FastCard window without a separate selector.
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-side-panel-bg:\s*transparent;/)
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(222,\s*222,\s*220,\s*0\.64\);/)
  // c17b8883 Polish liquid glass workbench controls — 槽位内阴影收敛 0.11 → 0.10
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(24,\s*39,\s*77,\s*0\.10\)/)
  assert.match(sidePanel, /background:\s*'transparent'/)
  assert.match(chatPanel, /background:\s*'transparent'/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?background:/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?backdrop-filter:/)
})

test('shared settings theme maps every inline constant onto the sx glass tokens', () => {
  const settingsTheme = readWorkspaceFile('src/renderer/components/settings/settings-theme.ts')
  const surfaces = readWorkspaceFile('src/renderer/styles/settings-surfaces.css')
  const index = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(index, /@import '\.\/settings-surfaces\.css';/)
  assert.match(settingsTheme, /SETTINGS_CARD_STYLE: CSSProperties = \{[\s\S]*?background: 'var\(--sx-card-bg\)'/)
  assert.match(settingsTheme, /SETTINGS_INPUT_STYLE: CSSProperties = \{[\s\S]*?background: 'var\(--sx-slot-bg\)'/)
  assert.match(settingsTheme, /SETTINGS_PRIMARY_BUTTON_STYLE: CSSProperties = \{[\s\S]*?background: 'var\(--sx-ink\)'/)
  // 极简层次：分组卡只是一层半透明白玻璃 + 柔和投影，不画外框；整页不再铺额外画布。
  const cardBlock = surfaces.match(/\n {2}\.sx-card \{[\s\S]*?\n {2}\}/)?.[0] ?? ''
  assert.match(cardBlock, /background:\s*var\(--sx-card-bg\)/)
  assert.doesNotMatch(cardBlock, /\bborder\s*:/)
  assert.doesNotMatch(surfaces, /\.sx-canvas|--sx-canvas/)
  // 选中只用「被托起的白玻璃」填充表达（与导航选中同配方），不用线框圈选。
  const selectedOption = surfaces.match(/\.sx-option:is\(\[aria-checked='true'\], \[aria-pressed='true'\], \.is-active\) \{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(selectedOption, /background:\s*var\(--sx-raised-bg\);[\s\S]*?box-shadow:\s*var\(--sx-raised-shadow\)/)
  assert.doesNotMatch(selectedOption, /border|0 0 0 \d/)
  // 输入是无边框的凹陷槽，聚焦时被托起，不画强调色线框。
  const inputFocus = surfaces.match(/\.sx-input:focus,\s*\.sx-select:focus,\s*\.sx-textarea:focus \{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(inputFocus, /background:\s*var\(--sx-slot-bg-focus\)/)
  assert.doesNotMatch(inputFocus, /border|--sx-focus-ring/)
  // 强调色纪律：主按钮与「开」状态走墨色，设置页设计系统里不出现成功绿。
  assert.match(surfaces, /\.sx-btn--primary\s*\{[\s\S]*?background:\s*var\(--sx-ink\)/)
  assert.match(surfaces, /\.sx-switch\[data-checked='true'\]\s*\{[\s\S]*?background:\s*var\(--sx-ink\)/)
  assert.doesNotMatch(surfaces, /--color-green/)
})

test('shared liquid glass surfaces remain real backdrop blur instead of flat paint', () => {
  const styles = readRendererStyles()

  assert.match(styles, /\.glass-surface-panel,[\s\S]*?\.glass-surface-card,[\s\S]*?\.glass-surface-floating\s*\{[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-medium\)\) saturate\(var\(--surface-saturate\)\)/)
  assert.match(styles, /\.glass-surface-card\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--lg-material-card\) 58%, transparent\)[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-soft\)\) saturate\(var\(--surface-saturate\)\)/)
  assert.match(styles, /\.glass-surface-floating\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--lg-material-floating\) 62%, transparent\)[\s\S]*?backdrop-filter:\s*blur\(var\(--lg-blur-strong\)\) saturate\(var\(--surface-saturate\)\)/)
})

test('compact utility settings opt into short control slots so labels do not collapse into vertical stacks', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const settingsShared = readWorkspaceFile('src/renderer/pages/settings/settings-shared.tsx')
  const shortcutCatalog = readWorkspaceFile('src/shared/app-shortcuts.ts')

  // Note: storage section (cacheSize / clearCache) is rendered via the dynamic
  // StorageSettingsPanel since D1; it manages its own layout and no longer
  // participates in the legacy slotWidth contract.
  // 331cacf4 refactor(settings): unify settings UI with workbench design language —
  // 逐项 slotWidth: 'short' 退役，统一为共享 SETTINGS_ROW_CONTROL_MIN_WIDTH 短槽；
  // 快捷键/版本行走 readonly 渲染分支，检查更新走 button 分支，两者都吃同一 minWidth。
  assert.doesNotMatch(settingsPage, /slotWidth/)
  assert.match(settingsShared, /export const SETTINGS_ROW_CONTROL_MIN_WIDTH = 136/)
  // 2026-10-02 视觉重整：只读值走 sx-value（快捷键拆成 kbd 键帽），按钮走 settingsButtonClass；
  // 行与行在同一张 sx-card 里用发丝线分隔，控件列靠 sx-row__control 右对齐。
  assert.match(settingsPage, /case 'readonly':[\s\S]*?<ShortcutKeys value=[\s\S]*?className="sx-value"/)
  assert.match(settingsPage, /case 'button':[\s\S]*?className=\{settingsButtonClass\(/)
  assert.match(settingsPage, /settings: READY_SHORTCUT_GUIDE\.map\(\(item\) => \(\{ \.\.\.item, type: 'readonly' as const \}\)\)/)
  assert.match(shortcutCatalog, /id: 'captureWindow'/)
  assert.match(shortcutCatalog, /id: 'sendMessage'/)
  assert.match(shortcutCatalog, /id: 'toggleSidebar'/)
  assert.match(shortcutCatalog, /id: 'switchMode'/)
  assert.doesNotMatch(shortcutCatalog, /id: 'newTask'/)
  assert.doesNotMatch(shortcutCatalog, /id: 'globalSearch'/)
  assert.match(settingsPage, /id: 'version'[\s\S]*?type: 'readonly'/)
  assert.match(settingsPage, /id: 'checkUpdate'[\s\S]*?type: 'button'/)
})
