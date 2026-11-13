import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('settings shell keeps the top bar merged with the glass, hides sidebar scrollbars until hover, and marks the current section with the shared row', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')
  const settingsCss = readWorkspaceFile('src/renderer/pages/settings/settings.css')

  assert.doesNotMatch(settingsPage, /data-liquid-shell="settings-header"[\s\S]*glass-surface-panel/)
  assert.match(settingsPage, /className="settings-page__nav panel-hover-scrollbar"/)
  assert.match(settingsCss, /\.settings-page__nav \{[^}]*scrollbar-gutter:\s*stable/)
  // B13：当前分区由共用 ListRow 着色（信号色淡底与文字，图标随文字），不再在图标上单独写颜色。
  assert.match(settingsPage, /<ListRow[\s\S]*?icon=\{<Icon \/>\}[\s\S]*?current=\{activeSection === section\.id\}/)
  // 顶部是一条与技能中心同高的带（--rn-band-h）。
  assert.match(settingsCss, /\.settings-page__header \{[^}]*height:\s*var\(--rn-band-h\)/)
})

test('settings content header drops the english eyebrow and icon, keeps the heading flush with the content rail, and matches the section gap rhythm', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.doesNotMatch(settingsPage, /Ready Preferences/)
  assert.doesNotMatch(settingsPage, /<currentSection\.icon/)
  // 设置页节奏调整：区块头下间距 20 → 24（与面板拆分同波设计更新）
  assert.match(settingsPage, /marginBottom:\s*24/)
  const settingsCss = readWorkspaceFile('src/renderer/pages/settings/settings.css')
  // V7：标题级 20/28，字重 500。
  assert.match(settingsCss, /\.settings-page__section-title \{[^}]*font:\s*500 var\(--rn-t-title\)\/var\(--rn-lh-title\) var\(--rn-font-ui\);[^}]*letter-spacing:\s*-0\.01em/)
  assert.match(settingsCss, /\.settings-page__section-desc \{[^}]*margin:\s*var\(--rn-s1\) 0 0/)
})
