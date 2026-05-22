import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat model switcher only lists allowed presets and keeps a hidden active preset discoverable', () => {
  const modelSelector = readWorkspaceFile('src/renderer/components/agent/chat-panel/model-selector/ModelSelector.tsx')

  assert.match(modelSelector, /listChatSwitcherProfiles/)
  assert.match(modelSelector, /当前使用中/)
  assert.match(modelSelector, /visibleProfiles/)
  assert.match(modelSelector, /管理显示项/)
  assert.match(modelSelector, /showInChatSwitcher/)
})
