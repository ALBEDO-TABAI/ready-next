import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings page uses dedicated liquid shell surfaces across header, navigation, and content', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(settingsPage, /data-liquid-shell="settings-header"/)
  assert.match(settingsPage, /data-liquid-shell="settings-sidebar"/)
  assert.match(settingsPage, /data-liquid-shell="settings-content"/)
  assert.doesNotMatch(settingsPage, /data-liquid-shell="settings-header"[\s\S]*glass-surface-panel/)
  assert.match(settingsPage, /panel-hover-scrollbar flex-shrink-0 overflow-auto/)
  assert.match(settingsPage, /glass-surface-card/)
})

test('shared settings theme tokens define glassy cards and controls', () => {
  const settingsTheme = readWorkspaceFile('src/renderer/components/settings/settings-theme.ts')

  assert.match(settingsTheme, /var\(--lg-border-soft\)/)
  assert.match(settingsTheme, /var\(--lg-shadow-contact\)/)
  assert.match(settingsTheme, /backdropFilter:/)
  assert.match(settingsTheme, /WebkitBackdropFilter:/)
  assert.match(settingsTheme, /color-mix\(in srgb, var\(--surface-card-bg\)/)
})

test('compact utility settings opt into short control slots so labels do not collapse into vertical stacks', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(settingsPage, /id: 'cacheSize'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'newTask'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'sendMessage'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'search'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'toggleSidebar'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'switchMode'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'version'[\s\S]*slotWidth: 'short'/)
  assert.match(settingsPage, /id: 'checkUpdate'[\s\S]*slotWidth: 'short'/)
})
