import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('user chat entries stay right-anchored while message text reads left-aligned', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /alignItems:\s*'flex-end'/)
  assert.match(
    chatMessages,
    /msg\.content && <div style=\{\{\s*whiteSpace:\s*'pre-wrap',\s*textAlign:\s*'left'\s*\}\}>\{msg\.content\}<\/div>/
  )
  assert.doesNotMatch(
    chatMessages,
    /msg\.content && <div style=\{\{\s*whiteSpace:\s*'pre-wrap',\s*textAlign:\s*'right'/
  )
})

test('chat messages render a subtle divider between user and agent entries', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /data-chat-message-divider="true"/)
  assert.match(chatMessages, /rgba\(255,\s*255,\s*255,\s*0\.[0-9]+\)/)
})
