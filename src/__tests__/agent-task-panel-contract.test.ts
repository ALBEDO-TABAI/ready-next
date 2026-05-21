import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: renderer task-panel wiring has no stable DOM harness in node tests
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel feeds message-level task snapshots into chat messages instead of fixed top task sections', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const taskToolSnapshot = readWorkspaceFile('src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx')
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  const store = readWorkspaceFile('src/renderer/stores/useAgent.ts')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')

  // V1.6/V1.8 follow-up: buildTaskCardViewModel + createDefaultTaskDisclosureState +
  // expanded-disclosure derivation now live in TaskCard.tsx / TaskToolSnapshot.tsx
  assert.match(taskCard, /buildTaskCardViewModel/)
  assert.doesNotMatch(chatPanel, /<TaskSection title="当前任务">/)
  assert.doesNotMatch(chatPanel, /<TaskSection title="后台任务">/)
  assert.match(chatPanelBody, /messageTaskSnapshots=\{messageTaskSnapshots\}/)
  assert.match(chatPanelBody, /messageToolTraceSnapshots=\{messageToolTraceSnapshots\}/)
  assert.match(chatPanelBody, /pendingTaskRun=\{pendingTaskRun\}/)
  assert.match(chatPanelBody, /pendingToolTrace=\{pendingToolTrace\}/)
  assert.match(taskToolSnapshot, /const expanded = Boolean\(taskDisclosureState\[key\]\?\.overview\)/)
  assert.doesNotMatch(chatPanel, /onCancelExecution=/)
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
  const taskToolSnapshot = readWorkspaceFile('src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx')
  const runtimeDriver = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')

  assert.match(chatPanel, /parseSerializedTaskSnapshot/)
  // V1.8 follow-up: meta?.taskSnapshot/toolTraceSnapshot + currentTaskRun.responseMessageId moved to TaskToolSnapshot.tsx
  assert.match(taskToolSnapshot, /message\.meta\?\.taskSnapshot/)
  assert.match(taskToolSnapshot, /message\.meta\?\.toolTraceSnapshot/)
  assert.match(taskToolSnapshot, /currentTaskRun\.responseMessageId/)
  assert.match(runtimeDriver, /responseSegmentBreakPending/)
  assert.match(runtimeDriver, /responseSegmentToolTraceStart/)
})
