import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel wires session recall search and attach APIs into the inline chat flow', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')

  assert.match(chatPanel, /searchSessionRecall/)
  assert.match(chatPanel, /listAttachedSessionRecallContexts/)
  assert.match(chatPanel, /attachSessionRecallContext/)
  assert.match(chatPanel, /detachSessionRecallContext/)
  assert.match(chatPanel, /sessionRecallResults/)
  assert.match(chatPanel, /attachedSessionRecallCapsules/)
  assert.match(chatPanel, /sessionRecallResults=\{visibleSessionRecallResults\}/)
  assert.match(chatPanel, /attachedSessionRecallConversationIds=/)
  assert.doesNotMatch(chatPanel, /搜索旧会话/)

  assert.match(chatHeader, /placeholder="搜旧会话标题、消息、任务摘要或附件名"/)
  assert.match(chatHeader, /sessionRecallResults\.map/)
  assert.match(chatHeader, /onAttachSessionRecall/)

  assert.match(preload, /searchSessionRecall:/)
  assert.match(preload, /listAttachedSessionRecallContexts:/)
  assert.match(preload, /attachSessionRecallContext:/)
  assert.match(preload, /detachSessionRecallContext:/)

  assert.match(electronTypes, /searchSessionRecall:/)
  assert.match(electronTypes, /listAttachedSessionRecallContexts:/)
  assert.match(electronTypes, /attachSessionRecallContext:/)
  assert.match(electronTypes, /detachSessionRecallContext:/)

  assert.match(directChat, /searchSessionRecall:\s*\(payload/)
  assert.match(directChat, /listRecentSessions:\s*\(payload/)
  assert.match(directChat, /getMemoryRepository:\s*\(\)/)
  assert.match(directChat, /getPromptAssembly:\s*\(\)/)
})
