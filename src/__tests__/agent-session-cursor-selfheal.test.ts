import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemorySession, type AgentInputItem } from '@openai/agents'

import { AgentSessionInputController } from '../main/modules/agent-control/runtime-core/agent-session-input-controller'
import { classifySdkRuntimeError } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'
import {
  addRunUsage,
  mergeRunUsage,
} from '../main/modules/agent-control/runtime-core/run-usage-accumulator'
import { usageFromModelResponses } from '../main/modules/agent-control/runtime-core/agent-sdk-provider-runner'
import { buildCanonicalCoreCloseoutMessage } from '../main/modules/repositories/canonical-core-closeout-message'
import { workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function captureMetrics(): { metrics: AgentMetricEvent[]; restore: () => void } {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => { metrics.push(event) })
  return { metrics, restore: () => __setMetricSinkForTests(null) }
}

function controllerWith(checkpoint: { finalInput: AgentInputItem[] } | null): AgentSessionInputController {
  const record = checkpoint
    ? {
        finalInput: checkpoint.finalInput,
        finalInputDigest: workflowDigest(checkpoint.finalInput),
        sdkSourceItemCount: checkpoint.finalInput.length,
        sdkSourcePrefixDigest: workflowDigest(checkpoint.finalInput),
      }
    : null
  const repository = { current: () => record } as never
  const runtimeContext = {
    taskId: 'task-selfheal',
    runId: 'run-selfheal',
    activatedCapabilityGroups: ['browser'],
    browserWorkflowRoute: { browserTaskId: 'browser-task-selfheal', requestAnchorSnapshotDigest: 'digest' },
    browserObservationGaps: [],
  } as never
  return new AgentSessionInputController(repository, runtimeContext, null)
}

const userItem = (text: string): AgentInputItem => ({ role: 'user', content: text }) as AgentInputItem

test('prepareRunnerSession is a no-op when the session already matches the clean checkpoint', async () => {
  const finalInput = [userItem('原始请求'), userItem('第二条')]
  const controller = controllerWith({ finalInput })
  const session = new MemorySession({ initialItems: structuredClone(finalInput) as AgentInputItem[] })
  const { metrics, restore } = captureMetrics()
  try {
    await controller.prepareRunnerSession(session)
  } finally {
    restore()
  }
  assert.deepEqual(await session.getItems(), finalInput)
  assert.equal(metrics.some((event) => event.metric === 'owner_local_runner_session_rebased'), false)
})

test('prepareRunnerSession rebuilds a drifted session from the clean checkpoint and records the rebase', async () => {
  const finalInput = [userItem('原始请求'), userItem('研究状态')]
  const controller = controllerWith({ finalInput })
  const session = new MemorySession({
    initialItems: [userItem('原始请求'), userItem('被改写的历史'), userItem('多余项')] as AgentInputItem[],
  })
  const { metrics, restore } = captureMetrics()
  try {
    await controller.prepareRunnerSession(session)
  } finally {
    restore()
  }
  assert.deepEqual(await session.getItems(), finalInput, 'session must be rebased to the checkpoint final input')
  const rebased = metrics.find((event) => event.metric === 'owner_local_runner_session_rebased')
  assert.ok(rebased, 'rebase must be observable for root-cause tracking')
  assert.equal(rebased?.previousItemCount, 3)
  assert.equal(rebased?.checkpointItemCount, 2)
  const filtered = controller.latestFilteredInput()
  assert.deepEqual(filtered, finalInput, 'provider boundary must be reset to the checkpoint truth')
})

test('prepareRunnerSession stays inert without a browser route or checkpoint', async () => {
  const noCheckpoint = controllerWith(null)
  const session = new MemorySession({ initialItems: [userItem('自由会话')] as AgentInputItem[] })
  await noCheckpoint.prepareRunnerSession(session)
  assert.deepEqual(await session.getItems(), [userItem('自由会话')])
})

test('cursor mismatch classifies as persistence_failed per contracts §6, not generic blocked_external', () => {
  const classified = classifySdkRuntimeError(new Error('owner_local_session_source_cursor_mismatch'))
  assert.equal(classified.terminalReason, 'persistence_failed')
  assert.equal(classified.userMessagePrefix, 'SDK 会话保存失败')
  const boundary = classifySdkRuntimeError(new Error('browser_route_clean_boundary_missing'))
  assert.equal(boundary.terminalReason, 'persistence_failed')
})

test('suspension notices occupy a checkpoint-scoped canonical id, never the run terminal id', () => {
  const notice = buildCanonicalCoreCloseoutMessage({
    parentTaskId: 'task-1',
    ownerRunId: 'run-1',
    conversationId: 'conv-1',
    finalText: '等待确认',
    timestamp: '2026-07-22T00:00:00.000Z',
    terminalReason: 'checkpoint_manual',
    checkpointId: 'ckpt-9',
  })
  const terminal = buildCanonicalCoreCloseoutMessage({
    parentTaskId: 'task-1',
    ownerRunId: 'run-1',
    conversationId: 'conv-1',
    finalText: '最终回复',
    timestamp: '2026-07-22T00:00:01.000Z',
    terminalReason: 'done',
  })
  assert.equal(notice.id, 'assistant:task-1:run-1:checkpoint:ckpt-9')
  assert.equal(terminal.id, 'assistant:task-1:run-1:terminal')
  assert.notEqual(notice.id, terminal.id, 'a pending notice must not preempt the terminal message id')
})

test('lastRequestInputTokens tracks the latest provider request instead of the run sum', () => {
  const first = addRunUsage(null, {
    inputTokens: 100_000, outputTokens: 10, totalTokens: 100_010, lastRequestInputTokens: 100_000,
  })
  const second = addRunUsage(first, {
    inputTokens: 120_000, outputTokens: 20, totalTokens: 120_020, lastRequestInputTokens: 120_000,
  })
  assert.equal(second.inputTokens, 220_000, 'cumulative billing stays a sum')
  assert.equal(second.lastRequestInputTokens, 120_000, 'context indicator source stays the last request')
  const merged = mergeRunUsage(second, {
    inputTokens: 50_000, outputTokens: 5, totalTokens: 50_005, lastRequestInputTokens: 50_000,
    usageSource: 'provider', providerCallCount: 1, missingCallCount: 0,
  })
  assert.equal(merged?.inputTokens, 270_000)
  assert.equal(merged?.lastRequestInputTokens, 50_000)

  const usage = usageFromModelResponses([
    { usage: { inputTokens: 39_499, outputTokens: 1, totalTokens: 39_500 } },
    { usage: { inputTokens: 108_920, outputTokens: 2, totalTokens: 108_922 } },
  ] as never)
  assert.equal(usage?.inputTokens, 148_419, 'run billing sums every request')
  assert.equal(usage?.lastRequestInputTokens, 108_920, 'indicator reads the final request only')
})
