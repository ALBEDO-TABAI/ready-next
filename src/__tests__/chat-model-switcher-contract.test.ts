import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat model switcher only lists allowed presets and keeps a hidden active preset discoverable', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatPanel, /listChatSwitcherProfiles/)
  assert.match(chatPanel, /当前使用中/)
  assert.match(chatPanel, /visibleProfiles/)
  assert.match(chatPanel, /管理显示项/)
  assert.match(chatPanel, /showInChatSwitcher/)
})
