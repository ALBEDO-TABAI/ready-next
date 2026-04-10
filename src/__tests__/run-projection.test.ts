import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/run-projection'
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

test('RunProjection stores browser task summaries and structured fields consistently', () => {
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
    phase: 'tool_running',
    latestText: '[计划] 目标：完成网页任务\n[计划] 顺序：resolve_target_page -> ensure_upload -> final_reconcile',
    timestamp: '2026-04-09T10:00:00.000Z',
  })

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
