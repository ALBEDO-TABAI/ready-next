import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: snapshot placement wiring crosses chat rendering and runtime projection surfaces
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
  assert.match(chatMessages, /shouldRenderGlobalToolTraceCapsule/)
})

test('chat messages expose a temporary pending task block while the next reply is still empty', () => {
  const chatMessages = readWorkspaceFile('src/renderer/components/agent/ChatMessages.tsx')

  assert.match(chatMessages, /pendingTaskRun:/)
  assert.match(chatMessages, /pendingToolTrace:/)
  assert.match(chatMessages, /data-chat-pending-task-snapshot/)
  assert.match(chatMessages, /data-chat-pending-tool-trace/)
  assert.match(chatMessages, /streamMsg\.content\.length === 0/)
})

test('task and tool cards stay collapsed by default and only reveal the latest line until expanded', () => {
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')

  assert.match(taskCard, /const summaryPreview = formatSingleLinePreview\(vm\.summary\)/)
  assert.match(taskCard, /\{summaryPreview\}/)
  assert.match(taskCard, /!expanded && latestEvent/)
  assert.match(taskCard, /const latestPreview = formatToolTracePreview\(latestEvent\?\.text\)/)
  assert.match(taskCard, /expanded && vm\.currentStep/)
  assert.match(taskCard, /\{events\.map\(\(event\) =>/)
  assert.doesNotMatch(taskCard, /最近一步：/)
  assert.match(taskCard, /whiteSpace:\s*'nowrap'/)
  assert.match(taskCard, /flexShrink:\s*0/)
  assert.doesNotMatch(taskCard, />\s*停止\s*</)
})
