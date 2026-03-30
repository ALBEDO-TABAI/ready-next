import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat messages render task snapshots directly under agent replies', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /messageTaskSnapshots:\s*Record<string,/)
  assert.match(chatMessages, /messageToolTraceSnapshots:\s*Record<string,/)
  assert.match(chatMessages, /msg\.type === 'agent'/)
  assert.match(chatMessages, /messageTaskSnapshots\[msg\.id\]/)
  assert.match(chatMessages, /messageToolTraceSnapshots\[msg\.id\]/)
  assert.match(chatMessages, /data-chat-message-task-snapshot/)
  assert.match(chatMessages, /data-chat-message-tool-trace/)
})

test('chat messages expose a temporary pending task block while the next reply is still empty', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /pendingTaskRun:/)
  assert.match(chatMessages, /pendingToolTrace:/)
  assert.match(chatMessages, /data-chat-pending-task-snapshot/)
  assert.match(chatMessages, /data-chat-pending-tool-trace/)
  assert.match(chatMessages, /streamMsg\.content\.length === 0/)
})
