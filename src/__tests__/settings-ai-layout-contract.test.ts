import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ai settings panel exposes four top-level model categories and per-preset switcher visibility controls', () => {
  const settingsPage = readWorkspaceFile('src/renderer/pages/Settings.tsx')

  assert.match(settingsPage, /OpenAI/)
  assert.match(settingsPage, /Anthropic/)
  assert.match(settingsPage, /Gemini/)
  assert.match(settingsPage, /自定义/)
  assert.match(settingsPage, /showInChatSwitcher/)
  assert.match(settingsPage, /在切换面板显示/)
  assert.match(settingsPage, /模型列表/)
  assert.match(settingsPage, /添加模型 ID/)
  assert.match(settingsPage, /设为默认/)
  assert.match(settingsPage, /高级设置/)
  assert.match(settingsPage, /自定义预设/)
})
