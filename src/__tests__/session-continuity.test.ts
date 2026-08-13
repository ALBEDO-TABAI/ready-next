import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import * as sessionContinuityModule from '../main/modules/agent-control/session/session-continuity'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
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
} from '../main/modules/agent-control/session/session-continuity'

const TEST_STORAGE_PATH = join(tmpdir(), 'ready-session-continuity-persisted.json')

beforeEach(() => {
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never })
  __setSessionContinuityStoragePathForTests(TEST_STORAGE_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __setScopeContextEpochDatabaseForTests(null)
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
      grantedStepBudgetSafetyFloor: false,
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

test('skill run continuity preserves resume fields while loading legacy success records', () => {
  writeFileSync(TEST_STORAGE_PATH, JSON.stringify({
    version: 3,
    recentBrowserActions: [],
    browserWorkflowStates: [],
    recentSkillRuns: [
      {
        sessionId: 'scope-skill',
        records: [
          {
            toolName: 'skill_video_expert_pipeline',
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            success: true,
            summary: '旧 success 记录',
            updatedAt: 1000,
          },
        ],
      },
    ],
  }), 'utf8')

  __reloadSessionContinuityFromDiskForTests()
  assert.equal(getLatestSkillRun('scope-skill')?.success, true)

  rememberSkillRun('scope-skill', {
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    success: false,
    status: 'blocked',
    runKind: 'detached',
    taskRunId: 'str-budget',
    detachedTaskId: 'dst-budget',
    jobId: 'job-budget',
    outputDir: '/tmp/vea-budget',
    runStatePath: '/tmp/vea-budget/run_state.json',
    pauseReason: 'budget_exhausted',
    resumePayload: {
      detachedTaskId: 'dst-budget',
      runStatePath: '/tmp/vea-budget/run_state.json',
      outputDir: '/tmp/vea-budget',
    },
    summary: '预算暂停，等待继续',
    updatedAt: 2000,
  })

  __resetSessionContinuityForTests({ keepPersisted: true })
  __reloadSessionContinuityFromDiskForTests()

  const latest = getLatestSkillRun('scope-skill')
  assert.equal(latest?.status, 'blocked')
  assert.equal(latest?.runKind, 'detached')
  assert.equal(latest?.taskRunId, 'str-budget')
  assert.equal(latest?.detachedTaskId, 'dst-budget')
  assert.equal(latest?.jobId, 'job-budget')
  assert.equal(latest?.outputDir, '/tmp/vea-budget')
  assert.equal(latest?.runStatePath, '/tmp/vea-budget/run_state.json')
  assert.equal(latest?.pauseReason, 'budget_exhausted')
  assert.equal(latest?.resumePayload?.detachedTaskId, 'dst-budget')
  assert.equal(JSON.parse(readFileSync(TEST_STORAGE_PATH, 'utf8')).version, 5)
})

test('session continuity isolates reset epochs while preserving same-epoch stop continuity', () => {
  const scopeId = 'scope-context-epoch'
  rememberBrowserAction(scopeId, 'search', '新加坡天气', { messageVisibilityEpoch: 0 })
  rememberBrowserWorkflowState(scopeId, {
    url: 'https://example.test/weather',
    title: 'Weather',
    workflowKind: 'research',
    stage: 'reading',
    evidence: [],
    running: true,
    uploadMounted: false,
    promptFilled: false,
    status: 'running',
    canResume: true,
    lastEvidence: [],
  }, { messageVisibilityEpoch: 0 })
  rememberSkillRun(scopeId, {
    toolName: 'skill_old_context',
    skillId: 'old-context-skill',
    action: 'run',
    success: false,
    status: 'blocked',
    summary: 'old context',
  }, { messageVisibilityEpoch: 0 })
  rememberContinuationState(scopeId, {
    taskId: 'task-old-context',
    scopeId,
    runId: 'run-old-context',
    taskType: 'short_task',
    interactionState: 'suspended',
    steps: [],
    resumableActions: ['continue'],
    continuationRef: {
      taskId: 'task-old-context',
      taskRunId: 'skill-task-old-context',
      skillId: 'old-context-skill',
    },
  }, { messageVisibilityEpoch: 0 })

  // Stop only rolls the Codex alias. The message context epoch is unchanged,
  // so all continuity remains visible.
  assert.equal(getRecentBrowserActions(scopeId, { messageVisibilityEpoch: 0 }).length, 1)
  assert.equal(getBrowserWorkflowState(scopeId, { messageVisibilityEpoch: 0 })?.title, 'Weather')
  assert.equal(getLatestSkillRun(scopeId, { messageVisibilityEpoch: 0 })?.skillId, 'old-context-skill')
  assert.equal(getContinuationState(scopeId, { messageVisibilityEpoch: 0 })?.taskId, 'task-old-context')

  // Reset advances the message context epoch. Old records remain durable but
  // every current getter must fail closed for the new context.
  assert.deepEqual(getRecentBrowserActions(scopeId, { messageVisibilityEpoch: 1 }), [])
  assert.equal(getBrowserWorkflowState(scopeId, { messageVisibilityEpoch: 1 }), null)
  assert.equal(getLatestSkillRun(scopeId, { messageVisibilityEpoch: 1 }), null)
  assert.equal(getContinuationState(scopeId, { messageVisibilityEpoch: 1 }), null)
  assert.deepEqual(listContinuationStates(scopeId, { messageVisibilityEpoch: 1 }), [])

  // A late writer owned by the old run cannot populate the new context.
  rememberSkillRun(scopeId, {
    toolName: 'skill_late_old_context',
    skillId: 'late-old-context-skill',
    action: 'run',
    success: false,
    status: 'blocked',
    summary: 'late old context',
  }, { messageVisibilityEpoch: 0, currentMessageVisibilityEpoch: 1 })
  assert.equal(getLatestSkillRun(scopeId, { messageVisibilityEpoch: 1 }), null)
})

test('resume selection prefers active task handles over old recent skill runs and honors expected task identity', () => {
  rememberSkillRun('scope-resume', {
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    success: false,
    summary: '旧失败记录',
    updatedAt: 3000,
  })

  const activeTaskRun = {
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    success: false,
    status: 'running',
    runKind: 'typed_action',
    taskRunId: 'str-active',
    outputDir: '/tmp/active',
    runStatePath: '/tmp/active/run_state.json',
    summary: '后台任务还在运行',
    updatedAt: 1000,
  }
  const pausedSupervisor = {
    toolName: 'skill_video_expert_pipeline',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    success: false,
    status: 'blocked',
    runKind: 'detached',
    taskRunId: 'str-paused',
    detachedTaskId: 'dst-paused',
    jobId: 'job-paused',
    outputDir: '/tmp/paused',
    runStatePath: '/tmp/paused/run_state.json',
    pauseReason: 'budget_exhausted',
    resumePayload: { detachedTaskId: 'dst-paused' },
    summary: '预算暂停任务',
    updatedAt: 500,
  }

  const selectedActive = (sessionContinuityModule as any).resolveSkillRunForResume({
    sessionId: 'scope-resume',
    candidates: [activeTaskRun],
  })
  assert.equal(selectedActive?.taskRunId, 'str-active')

  const selectedByIdentity = (sessionContinuityModule as any).resolveSkillRunForResume({
    sessionId: 'scope-resume',
    expectedTaskId: 'dst-paused',
    candidates: [activeTaskRun, pausedSupervisor],
  })
  assert.equal(selectedByIdentity?.detachedTaskId, 'dst-paused')
  assert.equal(selectedByIdentity?.pauseReason, 'budget_exhausted')
})
