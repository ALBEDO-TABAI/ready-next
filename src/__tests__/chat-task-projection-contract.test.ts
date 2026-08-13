import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task projection wiring is a source-surface integration contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('chat task cards merge task projections and expose user-facing status and recovery hints', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  // Stage V V1.1 — pure projection / badge helpers extracted from
  // ChatPanel.tsx to `chat-panel/helpers/{projection,badges}.ts`. The
  // ChatPanel-side field-destructure / IPC / store / draft wiring is
  // unchanged and continues to live in ChatPanel.tsx.
  const projectionHelpers = readWorkspaceFile('src/renderer/components/agent/chat-panel/helpers/projection.ts')
  const badgeHelpers = readWorkspaceFile('src/renderer/components/agent/chat-panel/helpers/badges.ts')
  const viewModel = readWorkspaceFile('src/renderer/modules/agent/taskCardViewModel.ts')
  // Stage V V1.6 — TaskCard + ToolTraceCard moved to
  // `chat-panel/task/TaskCard.tsx`; warning / recovery badge renders
  // now live in that file. V1.7 contract retarget: keep the
  // badge-shape assertions, but grep
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
  const taskInteraction = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts',
  )
  const taskToolSnapshot = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx',
  )
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')

  assert.match(chatPanel, /const \[persistedTaskProjections, setPersistedTaskProjections\] = useState/)
  assert.match(chatPanel, /window\.electronAPI\.agent\.listTaskProjections\(scope\.id\)/)
  assert.match(chatPanel, /liveTaskRuns=\{currentScopeTaskRuns\}/)
  assert.match(chatPanelBody, /liveTaskRuns=\{liveTaskRuns\}/)
  assert.match(taskToolSnapshot, /liveTaskRuns: TaskCardRun\[]/)
  assert.match(taskToolSnapshot, /function newerTaskSnapshot\(/)
  assert.match(taskToolSnapshot, /newerTaskSnapshot\(snapshot, liveTaskRuns\)/)
  assert.match(projectionHelpers, /function resolveProjectionForTaskRun\(/)
  assert.match(projectionHelpers, /run\.taskId/)
  assert.match(projectionHelpers, /run\.taskContinuation\?\.taskId/)
  assert.match(projectionHelpers, /persistedRun\?\.taskId/)
  assert.match(projectionHelpers, /function isStalePausedProjection\(/)
  assert.match(projectionHelpers, /function isLiveProjectionCandidate\(/)
  assert.match(projectionHelpers, /function selectFallbackProjection\(/)
  assert.match(projectionHelpers, /item\.status === 'completed' && \(item\.recentArtifacts\?\.length \|\| 0\) > 0/)
  assert.match(projectionHelpers, /function activeChildRunTitle\(/)
  assert.match(projectionHelpers, /taskTitle:\s*activeChildRunTitle\(row\)/)
  assert.doesNotMatch(projectionHelpers, /taskTitle:\s*`后台技能任务/)
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
  assert.doesNotMatch(taskMerge, /resumableActions:\s*\(run\.resumableActions && run\.resumableActions\.length > 0\)\s*\?\s*run\.resumableActions\s*:\s*\(projection\?\.resumableActions \|\| \[\]\)/)
  assert.doesNotMatch(taskInteraction, /setComposerDraft\(/)
  assert.doesNotMatch(taskInteraction, /continuationIntent:/)
  assert.doesNotMatch(chatPanel, /Task ID:/)
  assert.match(badgeHelpers, /function taskTypeBadgeLabel\(/)
  assert.match(badgeHelpers, /function interactionStateBadgeLabel\(/)
  assert.match(badgeHelpers, /function recoveryBadgeLabel\(/)
  assert.match(taskCard, /progressLabelAlreadyHasPercent/)
  assert.match(taskCard, /!progressLabelAlreadyHasPercent/)
  assert.match(taskCard, /run\.budgetWarningLevel/)
  assert.match(taskCard, /run\.recoveryHistory && run\.recoveryHistory\.length > 0/)
  assert.doesNotMatch(taskCard, /run\.budgetUsagePercent != null/)
  assert.doesNotMatch(taskCard, /run\.stepBudget/)
  assert.doesNotMatch(taskCard, /run\.degradationReason/)
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

test('task cards expose no retry or continuation producer', () => {
  const taskInteraction = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts',
  )
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  const taskPanel = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.doesNotMatch(taskInteraction, /handleRetryTask|handleContinueDetachedTask/)
  assert.doesNotMatch(taskCard, /onRetry|onContinueDetachedTask|继续后台任务|重新发起/)
  assert.doesNotMatch(taskPanel, /handleRetryProjection|重新发起/)
})

test('chat detached tasks keep query and cancel but expose no continuation action', () => {
  const taskInteraction = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts',
  )
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')

  assert.match(taskInteraction, /const handleCancelDetachedTask = useCallback/)
  assert.match(taskInteraction, /cancelDetachedSkillTask\(detachedTaskId, _scopeId\)/)
  assert.doesNotMatch(taskInteraction, /handleContinueDetachedTask/)
  assert.doesNotMatch(taskCard, /onContinueDetachedTask/)
  assert.doesNotMatch(taskCard, /继续后台任务/)
})

test('chat child-run exposes exact cancellation without a public resume path', () => {
  const taskInteraction = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers.ts',
  )

  assert.match(taskInteraction, /const handleCancelChildRun = useCallback\(async/)
  assert.match(taskInteraction, /window\.electronAPI\.agent\.cancelChildRun\(childRunId\)/)
  assert.doesNotMatch(taskInteraction, /handleContinueChildRun/)
  assert.doesNotMatch(taskInteraction, /window\.electronAPI\.agent\.resumeRun/)
})

test('compact task open-session button is wired to load the owning conversation', () => {
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const chatPanelBody = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  const taskCard = readWorkspaceFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')
  const taskToolSnapshot = readWorkspaceFile(
    'src/renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot.tsx',
  )

  assert.match(taskToolSnapshot, /onOpenScope: \(scopeId: string\) => void/)
  assert.match(taskToolSnapshot, /onOpenScope={onOpenScope}/)
  assert.match(chatPanelBody, /onOpenScope={onOpenScope}/)
  assert.match(chatPanel, /onOpenScope={handleLoadConversation}/)
  assert.match(chatPanel, /lookupSessionByConversation\(state, convId\)/)
  assert.match(chatPanel, /state\.setActiveSessionId\(existingSessionId\)/)
  assert.match(chatPanel, /void loadConversation\(convId\)/)
  assert.match(chatPanel, /const visibleTaskScopeIds = useMemo/)
  assert.match(chatPanel, /sessionOrder/)
  assert.match(chatPanel, /sessions\[sessionId\]\?\.conversationId/)
  assert.match(chatPanel, /if \(!visibleTaskScopeIds\.has\(run\.scopeId\)\) continue/)
  assert.match(chatPanel, /for \(const run of mergedTaskRuns\)/)
  assert.match(chatPanel, /\$\{run\.scopeId\}:\$\{getTaskRunDisplayKey\(run\)\}/)
  assert.match(taskCard, /const shouldShowOpenScopeButton = Boolean\(compact && run\.scopeId !== sessionId\)/)
  assert.match(taskCard, /shouldShowOpenScopeButton && \(/)
  assert.doesNotMatch(taskCard, /\{compact && \(/)
})
