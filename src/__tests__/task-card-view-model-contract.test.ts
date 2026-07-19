import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTaskCardViewModel, deriveTaskCardRuntimeState } from '../renderer/modules/agent/taskCardViewModel'
import { isStreamingScopeRunState } from '../renderer/modules/agent/scopeRunState'
import { resolveProjectionProgress } from '../renderer/components/agent/chat-panel/helpers/projection'

test('task card view model renders document tasks with generic step sections', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-document-1',
    phase: 'done',
    title: '文档会话',
    taskTitle: '章节改写',
    taskSummary: '已完成：第一部分',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    steps: [
      { id: 'execute', title: '章节改写', status: 'done', updatedAt: '2026-04-09T12:00:00.000Z' },
    ],
    updatedAt: '2026-04-09T12:00:00.000Z',
  }, undefined)

  assert.equal(vm.title, '章节改写')
  assert.equal(vm.summary, '已完成：第一部分')
  assert.equal(vm.currentStep?.title, '章节改写')
  assert.equal(vm.sections.plan.count, 1)
  assert.equal(vm.sections.plan.summary, '当前：章节改写')
})

test('task projection progress falls back to continuation progress', () => {
  const progress = resolveProjectionProgress({
    taskId: 'skill-child:vcr_done',
    scopeId: 'scope-vea',
    runId: 'vcr_done',
    taskType: 'multi_step_task',
    module: 'skill',
    status: 'completed',
    interactionState: 'suspended',
    waitingFor: 'none',
    steps: [],
    resumableActions: ['open_artifact'],
    continuationRef: {
      taskId: 'skill-child:vcr_done',
      blockerType: 'completed',
      progress: {
        stage: 'completed',
        completed: 64,
        total: 64,
        coverage: 1,
        fingerprint: 'fp-complete',
        updatedAt: '2026-05-25T14:37:28.398Z',
        lastError: null,
      },
    },
    recentArtifacts: [],
    createdAt: '2026-05-25T14:00:00.000Z',
    updatedAt: '2026-05-25T14:37:28.398Z',
  } as any)

  assert.equal(progress?.stage, 'completed')
  assert.equal(progress?.completed, 64)
  assert.equal(progress?.total, 64)
})

test('task card view model renders design tasks with generic step sections', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-design-1',
    phase: 'tool_running',
    title: '设计会话',
    taskTitle: '设计任务',
    taskSummary: '主版式已生成',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    steps: [
      { id: 'execute', title: '设计任务', status: 'running', updatedAt: '2026-04-09T12:05:00.000Z' },
    ],
    updatedAt: '2026-04-09T12:05:00.000Z',
  }, undefined)

  assert.equal(vm.title, '设计任务')
  assert.equal(vm.summary, '主版式已生成')
  assert.equal(vm.currentStep?.title, '设计任务')
  assert.equal(vm.sections.plan.count, 1)
})

test('task card view model keeps structured summary primary even when execution diagnostics exist', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-browser-2',
    phase: 'planning',
    title: '浏览器会话',
    taskTitle: '浏览器上传流程',
    taskSummary: '准备开始浏览器上传流程',
    executionDiagnostics: {
      compression: {
        historyCompressed: true,
        toolTraceCompressed: false,
        artifactSummaryUsed: false,
      },
      budget: {
        maxIterations: 24,
        maxToolCalls: 24,
        maxParallelToolGroups: 1,
      },
    },
    updatedAt: '2026-04-10T01:00:00.000Z',
  }, undefined)

  assert.equal(vm.title, '浏览器上传流程')
  assert.equal(vm.summary, '准备开始浏览器上传流程')
})

test('task card view model prefers projection status and steps when available', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-document-2',
    phase: 'done',
    status: 'blocked',
    title: '文档会话',
    taskTitle: '章节改写',
    taskSummary: '等待确认后继续',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    steps: [
      { id: 'execute', title: '章节改写', status: 'blocked', updatedAt: '2026-04-17T10:00:00.000Z' },
    ],
    updatedAt: '2026-04-17T10:00:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '等待补充')
  assert.equal(vm.currentStep?.status, 'blocked')
  assert.equal(vm.sections.plan.summary, '当前：章节改写')
})

test('task card view model surfaces skill output artifacts', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-skill-vea',
    phase: 'done',
    status: 'done',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '视频分析已完成',
    waitingFor: 'none',
    resumableActions: ['open_artifact'],
    recentArtifacts: [
      {
        id: 'artifact-1',
        module: 'skill',
        kind: 'artifact',
        label: 'run_state.json',
        path: '/tmp/video/out/run_state.json',
        createdAt: '2026-04-17T10:00:00.000Z',
        meta: { outputKey: 'runStatePath' },
      },
      {
        id: 'artifact-2',
        module: 'skill',
        kind: 'artifact',
        label: 'scene_scores.json',
        path: '/tmp/video/out/scene_scores.json',
        createdAt: '2026-04-17T10:00:00.000Z',
        meta: { outputKey: 'sceneScoresPath' },
      },
    ],
    updatedAt: '2026-04-17T10:00:00.000Z',
  }, undefined)

  assert.equal(vm.sections.artifacts.count, 2)
  assert.equal(vm.sections.artifacts.summary, 'run_state.json')
})

test('task card view model does not show blocked background work as completed', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-skill-background',
    phase: 'done',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '预算耗尽但后台仍在跑',
    waitingFor: 'background',
    resumableActions: ['none'],
    blockedReason: '预算耗尽但后台仍在跑',
    updatedAt: '2026-04-28T01:00:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '后台运行中')
})

test('task card view model does not show resumable background work as completed', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-skill-background-continue',
    phase: 'done',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '预算耗尽但后台仍在跑',
    waitingFor: 'background',
    resumableActions: ['continue', 'cancel'],
    blockedReason: '预算耗尽但后台仍在跑',
    updatedAt: '2026-04-28T01:00:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '后台运行中')
})

test('task card view model keeps explicit background signal above completed turn status', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-background-completed-turn',
    phase: 'done',
    status: 'completed',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '当前回合已结束，后台任务仍在运行',
    waitingFor: 'background',
    taskContinuation: {
      taskId: 'task-background-completed-turn',
      blockerType: 'background_running',
    },
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-04-28T01:00:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '后台运行中')
})

test('task card view model does not show completed parent when a child task is still running', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-parent-with-running-child',
    phase: 'done',
    status: 'done',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '父任务已交接',
    steps: [{
      id: 'parent-step',
      title: '后台分析',
      status: 'done',
      updatedAt: '2026-04-28T01:00:00.000Z',
      childTasks: [{
        taskId: 'detached-child',
        taskType: 'multi_step_task',
        status: 'running',
        summary: '后台仍在运行',
        updatedAt: '2026-04-28T01:05:00.000Z',
      }],
    } as any],
    updatedAt: '2026-04-28T01:05:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '后台运行中')
})

test('task card runtime state distinguishes background running, budget paused, done, waiting, and failed', () => {
  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-background',
    phase: 'done',
    status: 'blocked',
    title: '视频分析',
    waitingFor: 'background',
    taskContinuation: {
      taskId: 'task-background',
      blockerType: 'background_running',
      detachedTaskId: 'dst-1234',
    },
    canResume: true,
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'background_running',
    statusLabel: '后台运行中',
    actionSet: ['continue', 'open_artifact', 'cancel'],
  })

  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-budget',
    phase: 'checkpoint',
    status: 'blocked',
    title: '视频分析',
    waitingFor: 'none',
    taskContinuation: {
      taskId: 'task-budget',
      blockerType: 'budget_paused',
      pauseReason: 'budget_exhausted',
      outputDir: '/tmp/vea',
      runStatePath: '/tmp/vea/run_state.json',
    },
    canResume: true,
    resumableActions: ['continue', 'retry', 'cancel'],
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'budget_paused',
    statusLabel: '预算已暂停',
    actionSet: ['continue', 'retry', 'cancel'],
  })

  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-waiting',
    phase: 'checkpoint',
    status: 'blocked',
    title: '等待确认',
    waitingFor: 'confirmation',
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'waiting_input',
    statusLabel: '等待补充',
    actionSet: ['continue', 'cancel'],
  })

  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-done',
    phase: 'done',
    status: 'done',
    title: '已完成',
    waitingFor: 'none',
    recentArtifacts: [{
      id: 'artifact',
      module: 'skill',
      kind: 'artifact',
      label: 'report.md',
      path: '/tmp/report.md',
      createdAt: '2026-04-28T01:00:00.000Z',
    }],
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'done',
    statusLabel: '已完成',
    actionSet: ['open_artifact'],
  })

  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-cancelled',
    phase: 'cancelled',
    status: 'killed',
    title: '已取消',
    waitingFor: 'none',
    resumableActions: ['none'],
    canResume: false,
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'done',
    statusLabel: '已停止',
    actionSet: [],
  })

  assert.deepEqual(deriveTaskCardRuntimeState({
    scopeId: 'scope-failed',
    phase: 'error',
    status: 'failed',
    title: '失败',
    error: 'API key invalid',
    canResume: true,
    updatedAt: '2026-04-28T01:00:00.000Z',
  }), {
    visualState: 'failed',
    statusLabel: '失败',
    actionSet: ['retry', 'cancel', 'open_artifact'],
  })
})

test('blocked_config terminal reason shows failed instead of waiting for supplement', () => {
  const state = deriveTaskCardRuntimeState({
    scopeId: 'scope-blocked-config',
    phase: 'done',
    status: 'done',
    title: '视频分析',
    terminalReason: 'blocked_config',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-05-03T00:00:00.000Z',
  } as any)

  assert.deepEqual(state, {
    visualState: 'failed',
    statusLabel: '失败',
    actionSet: [],
  })
})

test('blocked_external terminal reason still waits for user supplement', () => {
  const state = deriveTaskCardRuntimeState({
    scopeId: 'scope-blocked-external',
    phase: 'done',
    status: 'done',
    title: '视频分析',
    terminalReason: 'blocked_external',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-05-03T00:00:00.000Z',
  } as any)

  assert.deepEqual(state, {
    visualState: 'waiting_input',
    statusLabel: '等待补充',
    actionSet: ['continue', 'cancel'],
  })
})

test('blocked child projections ignore stale background signals', () => {
  const state = deriveTaskCardRuntimeState({
    scopeId: 'scope-blocked-child-background',
    phase: 'done',
    status: 'blocked',
    title: '视频分析',
    terminalReason: 'blocked_external',
    waitingFor: 'background',
    taskContinuation: {
      taskId: 'skill-child:vcr_blocked',
      blockerType: 'blocked_external',
      childRunId: 'vcr_blocked',
    },
    canResume: true,
    resumableActions: ['continue', 'cancel'],
    updatedAt: '2026-05-25T14:37:28.398Z',
  } as any)

  assert.deepEqual(state, {
    visualState: 'waiting_input',
    statusLabel: '等待补充',
    actionSet: ['continue', 'cancel'],
  })
})

test('budget exhausted pause uses the same terminal checkpoint truth for task card and typing state', () => {
  const run = {
    scopeId: 'scope-budget-truth',
    agent: 'assistant',
    requestId: 'run-budget-truth',
    phase: 'checkpoint' as const,
    terminalReason: 'checkpoint_budget' as const,
    status: 'blocked' as const,
    title: '视频分析',
    waitingFor: 'none' as const,
    taskContinuation: {
      taskId: 'task-budget-truth',
      blockerType: 'budget_paused',
      pauseReason: 'budget_exhausted',
      outputDir: '/tmp/vea',
      runStatePath: '/tmp/vea/run_state.json',
    },
    canResume: true,
    resumableActions: ['continue', 'retry', 'cancel'] as const,
    toolTrace: [],
    startedAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:01.000Z',
  }

  assert.ok(
    run.terminalReason === 'checkpoint_budget' || run.terminalReason === 'checkpoint_background',
    'budget_exhausted pause must carry a checkpoint terminal reason',
  )
  assert.deepEqual(deriveTaskCardRuntimeState(run), {
    visualState: 'budget_paused',
    statusLabel: '预算已暂停',
    actionSet: ['continue', 'retry', 'cancel'],
  })
  assert.equal(isStreamingScopeRunState(run), false)
})

test('incomplete checkpoint is paused and resumable without pretending a background worker exists', () => {
  const run = {
    scopeId: 'scope-incomplete-truth',
    agent: 'assistant',
    requestId: 'run-incomplete-truth',
    phase: 'checkpoint' as const,
    terminalReason: 'checkpoint_incomplete' as const,
    status: 'recoverable_paused' as const,
    interactionState: 'suspended' as const,
    waitingFor: 'none' as const,
    blockedReason: '任务进度已保存，可以继续。',
    taskContinuation: {
      kind: 'browser_checkpoint',
      checkpointId: 'checkpoint-incomplete-truth',
      browserTaskId: 'browser-incomplete-truth',
      suspensionReason: 'incomplete',
    },
    canResume: true,
    resumableActions: ['continue', 'cancel'] as const,
    toolTrace: [],
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:01.000Z',
  }

  assert.deepEqual(deriveTaskCardRuntimeState(run), {
    visualState: 'waiting_input',
    statusLabel: '等待继续',
    actionSet: ['continue', 'cancel'],
  })
  assert.equal(isStreamingScopeRunState(run), false)
})
