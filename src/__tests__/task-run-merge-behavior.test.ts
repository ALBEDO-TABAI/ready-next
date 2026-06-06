import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationScope } from '../renderer/modules/agent/types'
import { mergeTaskRuns } from '../renderer/components/agent/chat-panel/task-merge/use-task-run-merge'
import type { PersistedTaskProjection } from '../renderer/components/agent/chat-panel/helpers/projection'

function makeScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'mimo',
    title: '视频分析会话',
    sourceKind: 'local',
    sourceId: 'local',
    threadKey: 'thread-1',
    meta: {},
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
  }
}

function makeProjection(childRunId: string, updatedAt: string): PersistedTaskProjection {
  return {
    taskId: `skill-child:${childRunId}`,
    scopeId: 'scope-1',
    runId: `run-${childRunId}`,
    taskType: 'continuation',
    module: 'skill',
    taskTitle: `继续 ${childRunId}`,
    taskSummary: `等待继续 ${childRunId}`,
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'agent_result',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: `skill-child:${childRunId}`,
      childRunId,
      skillId: 'video-expert-analyzer',
      action: 'continue',
    },
    progress: null,
    recentArtifacts: [],
    canResume: true,
    createdAt: updatedAt,
    updatedAt,
  }
}

test('mergeTaskRuns keeps multiple persisted projections in the same scope visible', () => {
  const runs = mergeTaskRuns({
    activeChildRuns: [],
    currentScopeId: 'scope-1',
    filteredScopes: [makeScope()],
    inMemoryTaskRuns: [],
    persistedScopeRuns: [],
    persistedTaskProjections: {
      'scope-1': [
        makeProjection('child-a', '2026-05-27T00:00:02.000Z'),
        makeProjection('child-b', '2026-05-27T00:00:01.000Z'),
      ],
    },
  })

  assert.equal(runs.length, 2)
  assert.deepEqual(
    runs.map((run) => run.taskId),
    ['skill-child:child-a', 'skill-child:child-b'],
  )

  const byChildRunId = new Map(runs.map((run) => [run.taskContinuation?.childRunId, run]))
  assert.equal(byChildRunId.get('child-a')?.canResume, true)
  assert.equal(byChildRunId.get('child-b')?.canResume, true)
  assert.deepEqual(byChildRunId.get('child-a')?.resumableActions, ['continue', 'cancel'])
  assert.deepEqual(byChildRunId.get('child-b')?.resumableActions, ['continue', 'cancel'])
})

test('mergeTaskRuns preserves browser module on persisted browser collection projections', () => {
  const browserProjection: PersistedTaskProjection = {
    taskId: 'browser-task-visible-1',
    scopeId: 'scope-1',
    runId: 'browser-task-card-1',
    taskType: 'multi_step_task',
    module: 'browser',
    taskTitle: '浏览器逐张点开采集',
    taskSummary: '等待验证后继续',
    status: 'recoverable_paused',
    interactionState: 'suspended',
    waitingFor: 'verification',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: [],
    continuationRef: null,
    progress: { stage: 'recoverable_paused', total: 5, completed: 2, coverage: 0.4, fingerprint: null, updatedAt: '2026-05-27T00:00:00.000Z' },
    recentArtifacts: [],
    canResume: false,
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
  }

  const runs = mergeTaskRuns({
    activeChildRuns: [],
    currentScopeId: 'scope-1',
    filteredScopes: [makeScope()],
    inMemoryTaskRuns: [],
    persistedScopeRuns: [],
    persistedTaskProjections: { 'scope-1': [browserProjection] },
  })

  assert.equal(runs.length, 1)
  assert.equal(runs[0].module, 'browser')
  assert.equal(runs[0].taskId, 'browser-task-visible-1')
  assert.equal(runs[0].waitingFor, 'verification')
})
