import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat panel uses task card view models and disclosure state for folded task sections', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const store = readWorkspaceFile('src/renderer/stores/useAgent.ts')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')

  assert.match(chatPanel, /buildTaskCardViewModel/)
  assert.match(chatPanel, /createDefaultTaskDisclosureState/)
  assert.match(chatPanel, /<TaskSection title="当前任务">/)
  assert.match(chatPanel, /<TaskSection title="后台任务">/)
  assert.match(viewModel, /title:\s*'计划与步骤'/)
  assert.match(viewModel, /title:\s*'执行细节'/)
  assert.match(viewModel, /title:\s*'产物'/)
  assert.match(viewModel, /title:\s*'记忆'/)
  assert.match(store, /taskDisclosureState:/)
  assert.match(store, /setTaskSectionExpanded:/)
  assert.match(store, /toggleTaskSection:/)
})

test('chat panel groups similar background tasks instead of always flattening every card', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')

  assert.match(chatPanel, /TaskGroupCard/)
  assert.match(viewModel, /groupTaskRunsForDisplay/)
  assert.match(viewModel, /2 个子任务|个子任务/)
})
