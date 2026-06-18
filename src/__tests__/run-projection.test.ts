import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import type { ProjectionTruthSnapshot } from '../main/modules/agent-control/contracts/run-contracts'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: '2026-04-09T10:00:00.000Z',
    updatedAt: '2026-04-09T10:00:00.000Z',
    lastMessageAt: '2026-04-09T10:00:00.000Z',
  }
}

test('RunProjection does not derive browser task metadata from legacy planning text without structured truth', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const planningSummary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    latestText: '[计划] 目标：完成网页任务\n[计划] 顺序：resolve_target_page -> ensure_upload -> final_reconcile',
    timestamp: '2026-04-09T10:00:00.000Z',
  })

  assert.ok(planningSummary)
  assert.equal(planningSummary?.taskTitle, null)
  assert.equal(planningSummary?.currentStepId, null)
  assert.equal(planningSummary?.waitingFor, 'none')
  assert.deepEqual(planningSummary?.resumableActions, [])
  assert.deepEqual(planningSummary?.steps, [])
  assert.equal(planningSummary?.taskSummary, '[计划] 目标：完成网页任务\n[计划] 顺序：resolve_target_page -> ensure_upload -> final_reconcile')

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    taskTitle: '完成网页任务',
    taskSummary: '上传附件：页面已出现上传卡片',
    currentStepId: 'ensure_upload',
    blockedReason: '页面未确认进入运行态',
    resumableActions: ['retry', 'cancel'],
    taskContinuation: {
      executionId: 'scope-1',
      stepId: 'ensure_upload',
      blockerType: 'browser_workflow',
      targetUrl: 'https://jimeng.example.com/workspace',
    },
    timestamp: '2026-04-09T10:00:05.000Z',
  })

  assert.ok(summary)
  assert.equal(summary?.taskTitle, '完成网页任务')
  assert.equal(summary?.taskSummary, '上传附件：页面已出现上传卡片')
  assert.equal(summary?.currentStepId, 'ensure_upload')
  assert.equal(summary?.blockedReason, '页面未确认进入运行态')
  assert.deepEqual(summary?.resumableActions, ['retry', 'cancel'])
  assert.equal(summary?.taskContinuation?.targetUrl, 'https://jimeng.example.com/workspace')
})

test('RunProjection keeps legacy skill execution text as plain latest text without reconstructing task state', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    latestText: [
      'Execution ID: exec-1',
      'Skill: video-copy-analyzer',
      'Current step: collect_input',
      'Blocker: need_input - 请选择视频风格',
    ].join('\n'),
    timestamp: '2026-04-09T10:00:00.000Z',
  })

  assert.ok(summary)
  assert.equal(summary?.taskTitle, null)
  assert.equal(summary?.currentStepId, null)
  assert.equal(summary?.waitingFor, 'none')
  assert.deepEqual(summary?.resumableActions, [])
  assert.deepEqual(summary?.steps, [])
  assert.equal(summary?.blockedReason, null)
})

test('RunProjection keeps structured task summary primary while preserving execution diagnostics', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const summary = projection.recordEvent({
    type: 'started',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'planning',
    latestText: '压缩后的 prompt 预览',
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
    timestamp: '2026-04-10T01:00:00.000Z',
  })

  assert.equal(summary?.taskSummary, '准备开始浏览器上传流程')
  assert.equal(summary?.executionDiagnostics?.compression?.historyCompressed, true)
  assert.equal(summary?.executionDiagnostics?.budget?.maxIterations, 24)
})

test('RunProjection still prefers structured projection truth when legacy browser text is present', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const truth: ProjectionTruthSnapshot = {
    projectionPatch: {
      taskTitle: '浏览器上传流程',
      taskSummary: '上传附件：页面已出现上传卡片',
      steps: [
        {
          id: 'ensure_upload',
          title: '上传附件',
          status: 'running',
          updatedAt: '2026-04-10T01:00:00.000Z',
        },
      ],
      currentStepId: 'ensure_upload',
      waitingFor: 'none',
      resumableActions: ['cancel'],
      blockedReason: null,
    },
    transcriptEvents: [],
  }

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    latestText: '[阶段] 步骤 1/3 上传附件：页面已出现上传卡片',
    timestamp: '2026-04-10T01:00:00.000Z',
  }, truth)

  assert.equal(summary?.taskTitle, '浏览器上传流程')
  assert.equal(summary?.taskSummary, '上传附件：页面已出现上传卡片')
  assert.equal(summary?.currentStepId, 'ensure_upload')
  assert.deepEqual(summary?.steps.map((step) => step.id), ['ensure_upload'])
})

test('RunProjection preserves recent media even when later non-media artifacts arrive', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const artifacts = [
    { id: 'img-1', module: 'browser', kind: 'image', label: '图 1', path: '/tmp/1.jpg', mimeType: 'image/jpeg', createdAt: '2026-04-10T01:00:01.000Z' },
    { id: 'img-2', module: 'browser', kind: 'image', label: '图 2', path: '/tmp/2.jpg', mimeType: 'image/jpeg', createdAt: '2026-04-10T01:00:02.000Z' },
    { id: 'img-3', module: 'browser', kind: 'image', label: '图 3', path: '/tmp/3.jpg', mimeType: 'image/jpeg', createdAt: '2026-04-10T01:00:03.000Z' },
    { id: 'img-4', module: 'browser', kind: 'image', label: '图 4', path: '/tmp/4.jpg', mimeType: 'image/jpeg', createdAt: '2026-04-10T01:00:04.000Z' },
    { id: 'doc-1', module: 'document', kind: 'artifact', label: '说明', path: '/tmp/readme.md', mimeType: 'text/markdown', createdAt: '2026-04-10T01:00:05.000Z' },
  ]

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    recentArtifacts: artifacts,
    timestamp: '2026-04-10T01:00:05.000Z',
  })

  assert.deepEqual(summary?.recentArtifacts?.map((artifact) => artifact.id), [
    'img-1',
    'img-2',
    'img-3',
    'img-4',
    'doc-1',
  ])
})

test('RunProjection clears stale skill blockers when projection truth explicitly sends null', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'checkpoint',
    taskId: 'task-vca',
    blockedReason: '文案分析未完成',
    taskContinuation: {
      taskId: 'task-vca',
      stepId: 'skill_video_copy_analyze#1',
      blockerType: 'error',
    },
    progress: {
      stage: 'running',
      completed: 2,
      total: 5,
      coverage: 0.4,
      fingerprint: 'video-copy:running:2',
      updatedAt: '2026-04-10T01:00:00.000Z',
      lastError: null,
    },
    timestamp: '2026-04-10T01:00:00.000Z',
  })

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'done',
    taskId: 'task-vca',
    timestamp: '2026-04-10T01:01:00.000Z',
  }, {
    projectionPatch: {
      blockedReason: null,
      taskContinuation: null,
      progress: null,
      waitingFor: 'none',
      resumableActions: ['open_artifact'],
    },
    transcriptEvents: [],
  })

  assert.equal(summary?.blockedReason, null)
  assert.equal(summary?.taskContinuation, null)
  assert.equal(summary?.progress, null)
})

test('RunProjection clears stale waiting state when a task finishes without an explicit blocker', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'checkpoint',
    taskId: 'document-task',
    taskTitle: '文档任务',
    taskSummary: '文档未改动，已跳过保存',
    interactionState: 'suspended',
    waitingFor: 'background',
    resumableActions: ['continue', 'cancel'],
    taskContinuation: {
      taskId: 'document-task',
      blockerType: 'background_running',
    },
    blockedReason: '文档未改动，已跳过保存',
    timestamp: '2026-04-10T01:00:00.000Z',
  })

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'done',
    taskId: 'document-task',
    taskSummary: '文档整理完成，现在阅读流畅。',
    timestamp: '2026-04-10T01:01:00.000Z',
  })

  assert.equal(summary?.waitingFor, 'none')
  assert.deepEqual(summary?.resumableActions, [])
  assert.equal(summary?.interactionState, undefined)
  assert.equal(summary?.taskContinuation, null)
  assert.equal(summary?.blockedReason, null)
  assert.equal(summary?.terminalReason, null)
})

test('RunProjection ignores undefined run-state fields instead of clearing active progress', () => {
  const store = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'checkpoint',
    taskId: 'task-vca',
    blockedReason: '后台任务仍在运行',
    taskContinuation: {
      taskId: 'task-vca',
      blockerType: 'background_running',
    },
    progress: {
      stage: 'transcribing',
      completed: 3,
      total: 8,
      coverage: 0.375,
      fingerprint: 'video-copy:transcribing:3',
      updatedAt: '2026-04-10T01:00:00.000Z',
      lastError: null,
    },
    timestamp: '2026-04-10T01:00:00.000Z',
  })

  const summary = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'tool_running',
    taskId: 'task-vca',
    blockedReason: undefined,
    taskContinuation: undefined,
    progress: undefined,
    timestamp: '2026-04-10T01:01:00.000Z',
  } as ScopeRunEventPayload)

  assert.equal(summary?.blockedReason, '后台任务仍在运行')
  assert.equal(summary?.taskContinuation?.blockerType, 'background_running')
  assert.equal(summary?.progress?.stage, 'transcribing')
})

test('RunProjection ignores stale non-started runId events without blocking takeover updates', () => {
  const store = new Map<string, ScopeRunSummary>()
  let writes = 0
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => store.get(scopeId),
    setSummary: (scopeId, summary) => {
      writes += 1
      store.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const started = projection.recordEvent({
    type: 'started',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-new',
    phase: 'planning',
    taskSummary: 'new run planning',
    timestamp: '2026-04-10T02:00:00.000Z',
  })

  assert.equal(started?.runId, 'run-new')
  assert.equal(writes, 1)

  const stale = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-old',
    phase: 'checkpoint',
    taskSummary: 'stale run checkpoint',
    timestamp: '2026-04-10T02:00:01.000Z',
  })

  assert.equal(stale, null)
  assert.equal(writes, 1)
  assert.equal(store.get('scope-1')?.runId, 'run-new')
  assert.equal(store.get('scope-1')?.phase, 'planning')
  assert.equal(store.get('scope-1')?.taskSummary, 'new run planning')

  const takeover = projection.recordEvent({
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    phase: 'takeover',
    taskSummary: 'paused by user',
    timestamp: '2026-04-10T02:00:02.000Z',
  })

  assert.equal(takeover?.runId, 'run-new')
  assert.equal(takeover?.phase, 'takeover')
  assert.equal(takeover?.taskSummary, 'paused by user')
  assert.equal(writes, 2)
})
