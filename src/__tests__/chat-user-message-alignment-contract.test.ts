import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('user chat entries stay right-anchored while message text reads left-aligned', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')
  const chatStyles = readWorkspaceFile('src/renderer/styles/chat-utilities.css')

  assert.match(chatMessages, /alignItems:\s*'flex-end'/)
  assert.match(chatMessages, /className="ready-chat-user-message-content"/)
  assert.match(chatStyles, /\.ready-chat-user-message-content\s*\{[\s\S]*?text-align:\s*left;/)
  assert.doesNotMatch(chatStyles, /\.ready-chat-user-message-content\s*\{[\s\S]*?text-align:\s*right;/)
})

test('chat messages render a subtle divider between user and agent entries', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /data-chat-message-divider="true"/)
  assert.match(chatMessages, /rgba\(255,\s*255,\s*255,\s*0\.[0-9]+\)/)
})
