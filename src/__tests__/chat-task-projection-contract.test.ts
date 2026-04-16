import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat task cards merge task projections and expose task-type, status, budget, and recovery hints', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')

  assert.match(chatPanel, /const \[persistedTaskProjections, setPersistedTaskProjections\] = useState/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.listTaskProjections\(scope\.id\)/)
  assert.match(chatPanel, /taskType:\s*projection\?\.taskType/)
  assert.match(chatPanel, /interactionState:\s*projection\?\.interactionState/)
  assert.match(chatPanel, /budgetUsagePercent:\s*projection\?\.budgetUsagePercent/)
  assert.match(chatPanel, /recoveryHistory:\s*projection\?\.recoveryHistory/)
  assert.match(chatPanel, /function taskTypeBadgeLabel\(/)
  assert.match(chatPanel, /function interactionStateBadgeLabel\(/)
  assert.match(chatPanel, /function recoveryBadgeLabel\(/)
  assert.match(chatPanel, /run\.budgetUsagePercent != null/)
  assert.match(chatPanel, /run\.recoveryHistory && run\.recoveryHistory\.length > 0/)
  assert.match(viewModel, /taskType\?:/)
  assert.match(viewModel, /interactionState\?:/)
  assert.match(viewModel, /budgetUsagePercent\?:/)
  assert.match(viewModel, /recoveryHistory\?:/)
})
