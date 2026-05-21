import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task projection wiring is a source-surface integration contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat task cards merge task projections and expose task-type, status, budget, and recovery hints', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  // Stage V V1.1 — pure projection / badge helpers extracted from
  // ChatPanel.tsx to `chat-panel/helpers/{projection,badges}.ts`. The
  // ChatPanel-side field-destructure / IPC / store / draft wiring is
  // unchanged and continues to live in ChatPanel.tsx.
  const projectionHelpers = readWorkspaceFile('src/renderer/components/agent/chat-panel/helpers/projection.ts')
  const badgeHelpers = readWorkspaceFile('src/renderer/components/agent/chat-panel/helpers/badges.ts')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')
  // Stage V V1.6 — TaskCard + ToolTraceCard moved to
  // `chat-panel/task/TaskCard.tsx`; budget / step-budget / warning /
  // degradation / recovery badge renders now live in that file. V1.7
  // contract retarget: keep the badge-shape assertions, but grep
  // TaskCard.tsx instead of ChatPanel.tsx for those specific reads.
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  // Stage V V1.7 — `mergedTaskRuns` 4-pass merge body moved to
  // `chat-panel/task-merge/use-task-run-merge.ts`. The projection-only
  // field-mapping assertions (taskTitle / taskSummary / steps / status /
  // taskType / interactionState / budget*/ degradation / recovery /
  // continuation / blockedReason) now grep the hook surface.
  const taskMerge = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-merge/use-task-run-merge.ts',
  )

  assert.match(chatPanel, /const \[persistedTaskProjections, setPersistedTaskProjections\] = useState/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.listTaskProjections\(scope\.id\)/)
  assert.match(projectionHelpers, /function resolveProjectionForTaskRun\(/)
  assert.match(projectionHelpers, /run\.taskId/)
  assert.match(projectionHelpers, /run\.taskContinuation\?\.taskId/)
  assert.match(projectionHelpers, /persistedRun\?\.taskId/)
  assert.match(projectionHelpers, /function isStalePausedProjection\(/)
  assert.match(projectionHelpers, /function isLiveProjectionCandidate\(/)
  assert.match(projectionHelpers, /function selectFallbackProjection\(/)
  assert.match(projectionHelpers, /item\.status === 'done' && \(item\.recentArtifacts\?\.length \|\| 0\) > 0/)
  assert.doesNotMatch(taskMerge, /persistedTaskProjections\[run\.scopeId\]\?\[0\]/)
  assert.match(taskMerge, /taskTitle:\s*projection\?\.taskTitle\s*\?\? null/)
  assert.match(taskMerge, /taskSummary:\s*projection\?\.taskSummary\s*\?\? null/)
  assert.match(projectionHelpers, /function normalizeProjectionSteps\(/)
  assert.match(taskMerge, /steps:\s*normalizeProjectionSteps\(projection\?\.steps\)\s*\?\? \[\]/)
  assert.match(taskMerge, /currentStepId:\s*projection\?\.currentStepId\s*\?\? null/)
  assert.match(taskMerge, /recentArtifacts:\s*projection\?\.recentArtifacts\s*\?\? \[\]/)
  assert.doesNotMatch(taskMerge, /blockedReason:\s*projection\?\.blockedReason\s*\|\|\s*run\.blockedReason/)
  assert.match(taskMerge, /status:\s*projection\?\.status/)
  assert.match(taskMerge, /taskType:\s*projection\?\.taskType/)
  assert.match(taskMerge, /interactionState:\s*projection\?\.interactionState/)
  assert.match(taskMerge, /budgetUsagePercent:\s*projection\?\.budgetUsagePercent/)
  assert.match(taskMerge, /stepBudget:\s*projection\?\.budget\?\.stepBudget/)
  assert.match(taskMerge, /budgetWarningLevel:\s*projection\?\.budgetWarningLevel/)
  assert.match(taskMerge, /degradationReason:\s*projection\?\.degradationReason/)
  assert.match(taskMerge, /recoveryHistory:\s*projection\?\.recoveryHistory/)
  assert.match(taskMerge, /taskContinuation:\s*projection\?\.continuationRef\s*\?\? null/)
  assert.match(taskMerge, /blockedReason:\s*projection\?\.blockedReason\s*\?\? null/)
  assert.match(projectionHelpers, /projection\.waitingFor/)
  assert.doesNotMatch(taskMerge, /waitingFor:\s*projection\?\.status === 'blocked'/)
  assert.match(chatPanel, /detachedTaskId:\s*run\?\.taskContinuation\?\.detachedTaskId/)
  assert.match(chatPanel, /runStatePath:\s*run\?\.taskContinuation\?\.runStatePath/)
  assert.match(chatPanel, /outputDir:\s*run\?\.taskContinuation\?\.outputDir/)
  assert.doesNotMatch(taskMerge, /resumableActions:\s*\(run\.resumableActions && run\.resumableActions\.length > 0\)\s*\?\s*run\.resumableActions\s*:\s*\(projection\?\.resumableActions \|\| \[\]\)/)
  assert.match(chatPanel, /setComposerDraft\(/)
  assert.match(chatPanel, /continuationIntent:/)
  assert.doesNotMatch(chatPanel, /Task ID:/)
  assert.match(badgeHelpers, /function taskTypeBadgeLabel\(/)
  assert.match(badgeHelpers, /function interactionStateBadgeLabel\(/)
  assert.match(badgeHelpers, /function recoveryBadgeLabel\(/)
  assert.match(taskCard, /run\.budgetUsagePercent != null/)
  assert.match(taskCard, /run\.stepBudget/)
  assert.match(taskCard, /run\.budgetWarningLevel/)
  assert.match(taskCard, /run\.degradationReason/)
  assert.match(taskCard, /run\.recoveryHistory && run\.recoveryHistory\.length > 0/)
  assert.doesNotMatch(chatPanel, /继续前上下文：/)
  assert.match(viewModel, /taskType\?:/)
  assert.match(viewModel, /status\?:/)
  assert.match(viewModel, /interactionState\?:/)
  assert.match(viewModel, /budgetUsagePercent\?:/)
  assert.match(viewModel, /stepBudget\?:/)
  assert.match(viewModel, /budgetWarningLevel\?:/)
  assert.match(viewModel, /degradationReason\?:/)
  assert.match(viewModel, /recoveryHistory\?:/)
  assert.match(viewModel, /recentArtifacts\?:/)
})

test('chat detached continue preserves structured continuation handles', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')

  assert.match(chatPanel, /const handleContinueDetachedTask = useCallback/)
  assert.match(chatPanel, /item\.taskContinuation\?\.detachedTaskId === detachedTaskId/)
  assert.match(chatPanel, /item\.taskContinuation\?\.taskId === detachedTaskId/)
  assert.match(chatPanel, /pauseReason: 'background_running'/)
  assert.match(chatPanel, /const continuationRun:/)
  assert.match(chatPanel, /setComposerDraft\(`继续后台任务 \$\{detachedTaskId\}`,\s*buildRunContinuationIntent\(continuationRun\) \|\| null\)/)
  assert.doesNotMatch(chatPanel, /setInputValue\(`继续后台任务 \$\{detachedTaskId\}`/)
})
