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
  assert.match(settingsPage, /className="settings-page-shell rn-ui flex h-full flex-col overflow-hidden"/)
  assert.match(settingsPage, /key=\{currentSection\?\.id \|\| 'unknown'\}[\s\S]*data-liquid-shell="settings-content"/)
  assert.match(settingsPage, /refreshTransparentSurface/)
  assert.match(settingsPage, /requestAnimationFrame\(\(\) => \{[\s\S]*requestSettingsSurfaceRefresh\(\)/)
  assert.match(settingsPage, /onMouseMove=\{handleSettingsSurfaceMotion\}/)
  assert.match(settingsPage, /onScroll=\{handleSettingsSurfaceScroll\}/)
  assert.match(settingsPage, /onMouseLeave=\{scheduleSettingsSurfaceRefresh\}/)
  assert.match(settingsPage, /sendIntent\(\{[\s\S]*kind: 'hide-all'[\s\S]*reason: 'overlay-open'/)
  assert.doesNotMatch(settingsPage, /data-liquid-shell="settings-header"[\s\S]*glass-surface-panel/)
  assert.match(settingsPage, /className="settings-page__nav panel-hover-scrollbar"/)
  // 2026-10-02 设置页视觉重整：内容直接落在窗口玻璃底上（与工作台同源），不再额外铺整块画布；
  // B13：版式在 pages/settings/settings.css（只用 --rn-*），控件是共用基元，不再逐个挂 glass-surface-card。
  assert.match(settingsPage, /<div className="flex-1 min-w-0 overflow-hidden">\s*<div\s+key=\{currentSection\?\.id \|\| 'unknown'\}\s+data-liquid-shell="settings-content"/)
  assert.doesNotMatch(settingsPage, /sx-canvas/)
  assert.match(settingsPage, /className="settings-ai-panel/)
  assert.match(settingsPage, /settings-ai-light-card/)

  const styles = readRendererStyles()
  assert.doesNotMatch(styles, /--settings-list-item-bg\s*:/)
  assert.match(styles, /\.settings-page-shell\s*\{[\s\S]*?isolation:\s*isolate;[\s\S]*?background:\s*transparent;/)
  assert.doesNotMatch(styles, /--settings-page-clear-bg\s*:/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='settings-content'\]\s*\{[\s\S]*?background:/)
  assert.match(styles, /\.workbench-mode-root\s*\{[^}]*background:\s*transparent/)
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

test('settings navigation is the shared ListRow: current section in the signal colour, no inline paint', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const primitives = readWorkspaceFile('src/renderer/components/ui/primitives.css')

  // B13（W1 §5）：分区是 ListRow，分组标题是 SectionHeader；当前分区与外壳侧栏的导航器同一个样子（DL5），
  // inline 不写 background / border / color，悬停与当前态全由基元的类驱动。
  const nav = settingsPage.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? ''
  assert.match(nav, /<SectionHeader className="sx-nav-group-label"/)
  assert.match(nav, /<ListRow[\s\S]*?className="sx-nav-item"[\s\S]*?current=\{activeSection === section\.id\}/)
  assert.doesNotMatch(nav, /style=\{\{[^}]*(?:background|border|color)/)
  assert.match(primitives, /\.rn-row\[aria-current\]:not\(\[aria-current='false'\]\)\s*\{[^}]*background:\s*var\(--rn-accent-soft\);[^}]*color:\s*var\(--rn-accent-text\)/)
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
  const sidePanel = readWorkspaceFile('src/renderer/modules/workbench/shell/ShellSidebar.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  // html:root now includes the FastCard window without a separate selector.
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-side-panel-bg:\s*transparent;/)
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-rail-slot-bg:\s*rgba\(222,\s*222,\s*220,\s*0\.64\);/)
  // c17b8883 Polish liquid glass workbench controls — 槽位内阴影收敛 0.11 → 0.10
  assert.match(styles, /html:root\s*\{[\s\S]*?--workbench-rail-slot-shadow:\s*[\s\S]*?inset 0 1\.5px 3px rgba\(24,\s*39,\s*77,\s*0\.10\)/)
  assert.match(sidePanel, /className=\{`shell-sidebar workbench-panel-frame/)
  const shellStyles = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')
  assert.match(shellStyles, /\.shell-sidebar:not\(\.shell-float-drawer\)\s*\{\s*background:\s*transparent;\s*box-shadow:\s*none;/)
  assert.match(chatPanel, /background:\s*'transparent'/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?background:/)
  assert.doesNotMatch(styles, /html:root \[data-liquid-shell='chat-panel'\],[\s\S]*?\[data-liquid-shell='side-panel'\]:not\(\[data-side-panel-variant='hidden'\]\)\s*\{[\s\S]*?backdrop-filter:/)
})

test('settings layout is on the --rn-* tokens: no private palette, cards are paper, controls are the shared primitives', () => {
  const settingsCss = readWorkspaceFile('src/renderer/pages/settings/settings.css')
  const settingsShared = readWorkspaceFile('src/renderer/pages/settings/settings-shared.tsx')
  const index = readWorkspaceFile('src/renderer/styles/index.css')

  // W1 §3.2：设置的 --sx-* 映射到 --rn-* 后删除；旧样式文件与 inline 兼容层一起退役。
  assert.match(index, /@import '\.\.\/pages\/settings\/settings\.css';/)
  assert.doesNotMatch(index, /settings-surfaces/)
  assert.throws(() => readWorkspaceFile('src/renderer/styles/settings-surfaces.css'))
  assert.throws(() => readWorkspaceFile('src/renderer/components/settings/settings-theme.ts'))
  assert.doesNotMatch(readRendererStyles(), /--sx-[a-z]/)
  // 一组设置是一张纸（DL2）：不透明纸色、纸的圆角与贴地影，不画外框。
  const cardBlock = settingsCss.match(/\n {2}\.sx-card \{[\s\S]*?\n {2}\}/)?.[0] ?? ''
  assert.match(cardBlock, /background:\s*var\(--rn-sheet\)/)
  assert.match(cardBlock, /box-shadow:\s*var\(--rn-sheet-shadow\)/)
  assert.doesNotMatch(cardBlock, /\bborder\s*:/)
  // 选中的单选卡与分段控件的选中项同一个样子，不用线框圈选，也不用信号色。
  const selectedOption = settingsCss.match(/\.sx-option:is\(\[aria-checked='true'\], \[aria-pressed='true'\], \.is-active\) \{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(selectedOption, /background:\s*var\(--rn-sheet\);[\s\S]*?box-shadow:\s*var\(--rn-card-shadow\)/)
  assert.doesNotMatch(selectedOption, /border|accent/)
  // 私有按钮、开关、分段、输入都不在了：设置页的控件就是 components/ui 的基元（W1 §5）。
  assert.doesNotMatch(settingsShared, /settingsButtonClass|SettingsSwitch\b|SettingsSegmented|sx-btn|sx-switch(?!-label)|sx-seg|sx-input/)
  assert.doesNotMatch(settingsCss, /\.sx-(?:btn|switch|seg|input|select|textarea|check|dialog|scrim)(?![\w-])/)
  assert.doesNotMatch(settingsCss, /backdrop-filter|--color-|--text-|--sx-/)
})

test('floats blur through the float material; the legacy shell surfaces carry no blur of their own (W1 §4)', () => {
  const styles = readRendererStyles()

  // B13: backdrop-filter lives in the material classes (and the composer's lens) only.
  const materials = readWorkspaceFile('src/renderer/design/next/materials.css')
  assert.match(materials, /\.rn-float\s*\{[\s\S]*?backdrop-filter:\s*blur\(var\(--rn-glass-blur\)\) saturate\(var\(--rn-glass-sat\)\)/)
  for (const selector of ['glass-surface-panel', 'glass-surface-card', 'content-surface-panel', 'ready-app-liquid-panel', 'ready-floating-menu']) {
    for (const block of styles.matchAll(new RegExp(`\\.${selector}[^{,]*\\{([^}]*)\\}`, 'g'))) {
      assert.doesNotMatch(block[1], /backdrop-filter:\s*blur/, `${selector} must not blur on its own`)
    }
  }
  assert.doesNotMatch(styles, /\.glass-surface-floating\s*\{/)
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
  // 2026-10-02 视觉重整：只读值走 sx-value（快捷键拆成 Kbd 键帽），按钮是共用的 Button（B13）；
  // 行与行在同一张 sx-card 里用发丝线分隔，控件列靠 sx-row__control 右对齐。
  assert.match(settingsPage, /case 'readonly':[\s\S]*?<ShortcutKeys value=[\s\S]*?className="sx-value"/)
  assert.match(settingsPage, /case 'button':[\s\S]*?<Button\b/)
  assert.match(settingsPage, /settings: READY_SHORTCUT_GUIDE\.map\(\(item\) => \(\{ \.\.\.item, type: 'readonly' as const \}\)\)/)
  assert.match(shortcutCatalog, /id: 'capture-window'/)
  assert.match(shortcutCatalog, /id: 'toggle-sidebar'/)
  for (const mode of ['browser', 'document', 'rss', 'calendar']) {
    assert.ok(shortcutCatalog.includes(`id: 'switch-${mode}'`))
  }
  assert.doesNotMatch(shortcutCatalog, /id: 'newTask'/)
  assert.doesNotMatch(shortcutCatalog, /id: 'globalSearch'/)
  assert.match(settingsPage, /id: 'version'[\s\S]*?type: 'readonly'/)
  assert.match(settingsPage, /id: 'checkUpdate'[\s\S]*?type: 'button'/)
})
