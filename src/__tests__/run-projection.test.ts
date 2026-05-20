import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import type { ProjectionTruthSnapshot } from '../main/modules/agent-control/run-contracts'
import type { ConversationScope, ScopeRunSummary } from '../main/modules/agent-control/types'

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
