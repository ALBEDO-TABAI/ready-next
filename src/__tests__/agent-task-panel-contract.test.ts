import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel feeds message-level task snapshots into chat messages instead of fixed top task sections', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const store = readWorkspaceFile('src/renderer/stores/useAgent.ts')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')

  assert.match(chatPanel, /buildTaskCardViewModel/)
  assert.match(chatPanel, /createDefaultTaskDisclosureState/)
  assert.doesNotMatch(chatPanel, /<TaskSection title="当前任务">/)
  assert.doesNotMatch(chatPanel, /<TaskSection title="后台任务">/)
  assert.match(chatPanel, /messageTaskSnapshots=\{messageTaskSnapshots\}/)
  assert.match(chatPanel, /messageToolTraceSnapshots=\{messageToolTraceSnapshots\}/)
  assert.match(chatPanel, /pendingTaskRun=\{pendingTaskRun\}/)
  assert.match(chatPanel, /pendingToolTrace=\{pendingToolTrace\}/)
  assert.match(viewModel, /title:\s*'计划与步骤'/)
  assert.match(viewModel, /title:\s*'执行细节'/)
  assert.match(viewModel, /title:\s*'产物'/)
  assert.match(viewModel, /title:\s*'记忆'/)
  assert.match(store, /taskDisclosureState:/)
  assert.match(store, /setTaskSectionExpanded:/)
  assert.match(store, /toggleTaskSection:/)
})

test('chat panel can recover task snapshots from persisted assistant message metadata and current live runs', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatPanel, /parseSerializedTaskSnapshot/)
  assert.match(chatPanel, /message\.meta\?\.taskSnapshot/)
  assert.match(chatPanel, /message\.meta\?\.toolTraceSnapshot/)
  assert.match(chatPanel, /currentTaskRun\.responseMessageId/)
})
