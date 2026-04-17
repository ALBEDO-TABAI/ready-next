import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import * as sessionContinuityModule from '../main/modules/agent-control/session-continuity'
import {
  __reloadSessionContinuityFromDiskForTests,
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  forgetSession,
  getContinuationState,
  getBrowserWorkflowState,
  getLatestSkillRun,
  getRecentBrowserActions,
  listContinuationStates,
  rememberBrowserAction,
  rememberContinuationState,
  rememberBrowserWorkflowState,
  rememberSkillRun,
} from '../main/modules/agent-control/session-continuity'

const TEST_STORAGE_PATH = join(tmpdir(), 'ready-session-continuity-persisted.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_STORAGE_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  rmSync(TEST_STORAGE_PATH, { force: true })
})

test('browser workflow state survives an in-memory reset by reloading from disk', () => {
  rememberBrowserWorkflowState('scope-persisted', {
    url: 'https://jimeng.example.com/workspace',
    title: '即梦工作台',
    workflowKind: 'upload_generate',
    stage: 'submit',
    attachmentName: 'poster.png',
    promptPreview: '做一张温暖的美食海报',
    evidence: ['preview_visible', 'prompt_matched'],
    running: false,
    uploadMounted: true,
    promptFilled: true,
    status: 'failed',
    canResume: true,
    lastFailureReason: '页面未确认进入运行态',
  })

  __resetSessionContinuityForTests({ keepPersisted: true })
  __reloadSessionContinuityFromDiskForTests()

  const restored = getBrowserWorkflowState('scope-persisted')
  assert.equal(restored?.url, 'https://jimeng.example.com/workspace')
  assert.equal(restored?.workflowKind, 'upload_generate')
  assert.equal(restored?.canResume, true)
  assert.equal(restored?.lastFailureReason, '页面未确认进入运行态')
})

test('continuation state survives an in-memory reset by reloading from disk', () => {
  rememberContinuationState('scope-persisted', {
    taskId: 'task-prev',
    scopeId: 'scope-persisted',
    runId: 'run-prev',
    module: 'skill',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [
      {
        id: 'approve',
        title: '确认继续执行',
        description: '等待确认',
        status: 'running',
        updatedAt: '2026-04-17T00:00:00.000Z',
      },
    ],
    currentStepId: 'approve',
    blockedReason: '等待确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev',
      executionId: 'exec-prev',
      stepId: 'approve',
      blockerType: 'need_confirmation',
    },
    budget: {
      taskType: 'short_task',
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 5,
      iterationsUsed: 9,
      toolCallsUsed: 4,
      parallelToolGroupsUsed: 1,
    },
    budgetRuntime: {
      taskType: 'continuation',
      budget: {
        maxIterations: 24,
        maxToolCalls: 24,
        maxParallelToolGroups: 5,
        reservedToolCalls: 0,
      },
      usage: {
        iterationsUsed: 9,
        toolCallsUsed: 4,
        parallelToolGroupsUsed: 1,
      },
      stepBudget: {
        stepId: 'approve',
        maxIterations: 6,
        remainingIterations: 2,
      },
      warningLevel: 'warning',
      frozen: false,
      bootstrapBudget: false,
    },
    restoreDiagnostics: {
      inheritedBudget: true,
      restoredUsage: true,
      grantedIterationSafetyFloor: false,
      grantedToolCallSafetyFloor: false,
    },
  })

  __resetSessionContinuityForTests({ keepPersisted: true })
  __reloadSessionContinuityFromDiskForTests()

  const restored = getContinuationState('scope-persisted')
  assert.equal(restored?.taskId, 'task-prev')
  assert.equal(restored?.currentStepId, 'approve')
  assert.equal(restored?.budgetRuntime?.usage.iterationsUsed, 9)
})

test('session continuity keeps multiple continuation snapshots per scope and restores them by task id', () => {
  ;(sessionContinuityModule as any).rememberContinuationState('scope-persisted', {
    taskId: 'task-prev-1',
    scopeId: 'scope-persisted',
    runId: 'run-prev-1',
    module: 'skill',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: 'approve-1',
    blockedReason: '等待第一次确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev-1',
      executionId: 'exec-prev-1',
      stepId: 'approve-1',
      blockerType: 'need_confirmation',
    },
  }, { updatedAt: 1000 })
  ;(sessionContinuityModule as any).rememberContinuationState('scope-persisted', {
    taskId: 'task-prev-2',
    scopeId: 'scope-persisted',
    runId: 'run-prev-2',
    module: 'browser',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: 'approve-2',
    blockedReason: '等待第二次确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev-2',
      executionId: 'exec-prev-2',
      stepId: 'approve-2',
      blockerType: 'need_confirmation',
    },
  }, { updatedAt: 2000 })

  const latest = getContinuationState('scope-persisted')
  const firstTask = (sessionContinuityModule as any).getContinuationState('scope-persisted', { taskId: 'task-prev-1' })
  const secondTask = (sessionContinuityModule as any).getContinuationState('scope-persisted', { taskId: 'task-prev-2' })
  const allStates = (sessionContinuityModule as any).listContinuationStates('scope-persisted')

  assert.equal(latest?.taskId, 'task-prev-2')
  assert.equal(firstTask?.taskId, 'task-prev-1')
  assert.equal(secondTask?.taskId, 'task-prev-2')
  assert.deepEqual(
    Array.isArray(allStates) ? allStates.map((state: { taskId: string }) => state.taskId) : null,
    ['task-prev-2', 'task-prev-1'],
  )

  __resetSessionContinuityForTests({ keepPersisted: true })
  __reloadSessionContinuityFromDiskForTests()

  const restoredFirstTask = (sessionContinuityModule as any).getContinuationState('scope-persisted', { taskId: 'task-prev-1' })
  assert.equal(restoredFirstTask?.taskId, 'task-prev-1')
})

test('clearing one continuation snapshot keeps other tasks in the same scope resumable', () => {
  ;(sessionContinuityModule as any).rememberContinuationState('scope-persisted', {
    taskId: 'task-prev-1',
    scopeId: 'scope-persisted',
    runId: 'run-prev-1',
    module: 'skill',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: 'approve-1',
    blockedReason: '等待第一次确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev-1',
      executionId: 'exec-prev-1',
      stepId: 'approve-1',
      blockerType: 'need_confirmation',
    },
  }, { updatedAt: 1000 })
  ;(sessionContinuityModule as any).rememberContinuationState('scope-persisted', {
    taskId: 'task-prev-2',
    scopeId: 'scope-persisted',
    runId: 'run-prev-2',
    module: 'browser',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: 'approve-2',
    blockedReason: '等待第二次确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev-2',
      executionId: 'exec-prev-2',
      stepId: 'approve-2',
      blockerType: 'need_confirmation',
    },
  }, { updatedAt: 2000 })

  ;(sessionContinuityModule as any).clearContinuationState('scope-persisted', 'task-prev-2')

  const latest = getContinuationState('scope-persisted')
  const firstTask = (sessionContinuityModule as any).getContinuationState('scope-persisted', { taskId: 'task-prev-1' })
  const secondTask = (sessionContinuityModule as any).getContinuationState('scope-persisted', { taskId: 'task-prev-2' })

  assert.equal(latest?.taskId, 'task-prev-1')
  assert.equal(firstTask?.taskId, 'task-prev-1')
  assert.equal(secondTask, null)
})

test('forgetSession clears browser actions, workflow, skill runs, and continuation state together', () => {
  rememberBrowserAction('scope-forget', 'search', '广州天气')
  rememberBrowserWorkflowState('scope-forget', {
    url: 'https://weather.example.com/guangzhou',
    title: '广州天气',
    workflowKind: 'live_info_lookup',
    stage: 'read_result',
    evidence: ['weather_ready'],
    running: false,
    uploadMounted: false,
    promptFilled: false,
    status: 'done',
    canResume: false,
  })
  rememberSkillRun('scope-forget', {
    toolName: 'skill_browser_lookup',
    skillId: 'skill-browser',
    action: 'search_weather',
    success: true,
    summary: '查询广州天气',
  })
  rememberContinuationState('scope-forget', {
    taskId: 'task-forget',
    scopeId: 'scope-forget',
    runId: 'run-forget',
    module: 'browser',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: 'confirm',
    blockedReason: '等待确认',
    resumableActions: ['continue'],
    continuationRef: {
      taskId: 'task-forget',
      executionId: 'exec-forget',
      stepId: 'confirm',
      blockerType: 'need_confirmation',
    },
  })

  forgetSession('scope-forget')

  assert.deepEqual(getRecentBrowserActions('scope-forget'), [])
  assert.equal(getBrowserWorkflowState('scope-forget'), null)
  assert.equal(getLatestSkillRun('scope-forget'), null)
  assert.equal(getContinuationState('scope-forget'), null)
  assert.deepEqual(listContinuationStates('scope-forget'), [])
})

test('session continuity prunes the oldest scopes when the session cap is exceeded', () => {
  for (let index = 0; index < 202; index += 1) {
    rememberBrowserWorkflowState(`scope-${index}`, {
      url: `https://example.com/${index}`,
      title: `Scope ${index}`,
      workflowKind: 'live_info_lookup',
      stage: 'read_result',
      evidence: [`evidence-${index}`],
      running: false,
      uploadMounted: false,
      promptFilled: false,
      status: 'done',
      canResume: false,
      updatedAt: index + 1,
    })
  }

  assert.equal(getBrowserWorkflowState('scope-0'), null)
  assert.equal(getBrowserWorkflowState('scope-1'), null)
  assert.equal(getBrowserWorkflowState('scope-2')?.title, 'Scope 2')
  assert.equal(getBrowserWorkflowState('scope-201')?.title, 'Scope 201')
})

test('session continuity keeps loading legacy payloads that do not contain continuation snapshots', () => {
  writeFileSync(TEST_STORAGE_PATH, JSON.stringify({
    version: 1,
    recentBrowserActions: [],
    browserWorkflowStates: [],
    recentSkillRuns: [],
  }), 'utf8')

  __reloadSessionContinuityFromDiskForTests()

  assert.equal(getContinuationState('scope-persisted'), null)
})

test('session continuity keeps loading legacy version 2 continuation snapshots', () => {
  writeFileSync(TEST_STORAGE_PATH, JSON.stringify({
    version: 2,
    recentBrowserActions: [],
    browserWorkflowStates: [],
    recentSkillRuns: [],
    recentContinuationStates: [
      {
        sessionId: 'scope-persisted',
        state: {
          taskId: 'task-prev',
          scopeId: 'scope-persisted',
          runId: 'run-prev',
          module: 'skill',
          taskType: 'short_task',
          interactionState: 'awaiting_confirmation',
          steps: [],
          currentStepId: 'approve',
          blockedReason: '等待确认',
          resumableActions: ['continue', 'cancel'],
          continuationRef: {
            taskId: 'task-prev',
            executionId: 'exec-prev',
            stepId: 'approve',
            blockerType: 'need_confirmation',
          },
        },
      },
    ],
  }), 'utf8')

  __reloadSessionContinuityFromDiskForTests()

  assert.equal(getContinuationState('scope-persisted')?.taskId, 'task-prev')
})
