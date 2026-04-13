import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings shell keeps the top bar visually merged, hides sidebar scrollbars until hover, and tints active icons blue', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.doesNotMatch(settingsPage, /data-liquid-shell="settings-header"[\s\S]*glass-surface-panel/)
  assert.match(settingsPage, /className="panel-hover-scrollbar flex-shrink-0 overflow-auto"/)
  assert.match(settingsPage, /scrollbarGutter:\s*'stable'/)
  assert.match(settingsPage, /<Icon[\s\S]*color:\s*isActive \? 'var\(--color-blue\)' : 'var\(--text-muted\)'/)
})

test('settings content header drops the english eyebrow and icon, keeps the heading flush with the content rail, and matches the section gap rhythm', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.doesNotMatch(settingsPage, /Ready Preferences/)
  assert.doesNotMatch(settingsPage, /<currentSection\.icon/)
  assert.match(settingsPage, /className="mb-7"/)
  assert.match(settingsPage, /display:\s*'flex',\s*flexDirection:\s*'column',\s*gap:\s*4/)
})
