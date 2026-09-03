import assert from 'node:assert/strict'
import test from 'node:test'

import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'
import { applyProductTurnReceipt } from '../renderer/modules/agent/productTurnReceipt'
import { deriveToolTimelineItems } from '../renderer/modules/agent/toolTraceRows'
import { filterUserVisibleToolTraceEvents } from '../renderer/modules/agent/toolTraceVisibility'
import type { ProductTurnReceipt } from '../shared/ipc-contracts/agent-runtime'
import { withReceiptV3Fields } from './product-turn-action-projection-fixture'

function receipt(revision = 4): ProductTurnReceipt {
  return {
    ...withReceiptV3Fields({ readyRunId: 'run-1', ownerTurnRevision: revision }),
    readyRunId: 'run-1',
    readyTaskId: 'task-1',
    readyScopeId: 'scope-1',
    messageVisibilityEpoch: 2,
    revision,
    terminal: 'error',
    canonicalMessage: {
      id: 'assistant:task-1:run-1:terminal',
      conversationId: 'scope-1',
      role: 'assistant',
      content: '本轮未能完成，已有结果已保留。',
      timestamp: '2026-08-18T00:00:00.000Z',
      meta: { runId: 'run-1' },
    },
    canonicalMessageDigest: 'a'.repeat(64),
    tools: [{
      callId: 'call-1',
      toolName: 'web_search',
      state: 'confirmed',
      actionReceiptId: 'receipt-1',
      actionRevision: 2,
      resultDigest: 'b'.repeat(64),
      deliveryAttemptId: 'delivery-1',
      deliveryConfirmed: true,
      summary: 'web_search：已完成并确认返回',
    }],
    artifacts: [],
    memory: null,
    contextUsage: {
      usedInputTokens: 6_400,
      windowTokens: 128_000,
      ratio: 0.05,
      windowSource: 'model',
      source: 'last_model_request',
      timestamp: '2026-08-18T00:00:00.000Z',
    },
    failure: {
      kind: 'transport',
      effectState: 'confirmed',
      evidenceRefs: ['receipt-1', 'delivery-1'],
    },
    publicationSealDigest: null,
    presentationDigest: revision.toString(16).padStart(64, '0'),
  }
}

test('one product receipt restores terminal text and durable tool history after an empty cold state', () => {
  const empty = createEmptyScopeRunState({
    scopeId: 'scope-1',
    agent: 'butler',
    requestId: 'run-1',
  })
  const restored = applyProductTurnReceipt(empty, receipt())
  assert.equal(restored.phase, 'error')
  assert.equal(restored.latestText, '本轮未能完成，已有结果已保留。')
  assert.deepEqual(restored.toolTrace.map((event) => event.kind), ['call', 'result'])
  assert.deepEqual(restored.toolTrace.map((event) => event.text), ['搜索网页', '网页检索完成'])
  assert.deepEqual(restored.toolTrace.map((event) => event.toolName), ['web_search', 'web_search'])
  assert.equal(restored.toolTrace.every((event) => event.hideToolName), true)
  assert.equal(restored.productTurnCanonicalMessageId, 'assistant:task-1:run-1:terminal')
  assert.deepEqual(restored.contextUsage, receipt().contextUsage)
})

test('receipt replay is idempotent and an older revision cannot erase durable history', () => {
  const empty = createEmptyScopeRunState({ scopeId: 'scope-1', agent: 'butler', requestId: 'run-1' })
  const current = applyProductTurnReceipt(empty, receipt(4))
  assert.equal(applyProductTurnReceipt(current, receipt(4)), current)
  assert.equal(applyProductTurnReceipt(current, receipt(3)), current)
})

test('internal delivery tool names are replaced with user-facing history text', () => {
  const internal = receipt()
  internal.tools[0] = { ...internal.tools[0], toolName: 'declare_completion_criteria' }
  const restored = applyProductTurnReceipt(
    createEmptyScopeRunState({ scopeId: 'scope-1', agent: 'butler', requestId: 'run-1' }),
    internal,
  )
  assert.deepEqual(restored.toolTrace.map((event) => event.text), ['确认交付要求', '交付要求已确认'])
  assert.doesNotMatch(restored.toolTrace.map((event) => event.text).join(' '), /declare_completion_criteria/)
})

test('common runtime tools share the live activity vocabulary after restart', () => {
  const common = receipt()
  common.tools = [
    { ...common.tools[0], callId: 'search', toolName: 'session_search' },
    { ...common.tools[0], callId: 'shell', toolName: 'skill_run_shell' },
    { ...common.tools[0], callId: 'browser', toolName: 'browser_read' },
    { ...common.tools[0], callId: 'question', toolName: 'ask_user_questions' },
  ]
  const trace = applyProductTurnReceipt(
    createEmptyScopeRunState({ scopeId: 'scope-1', agent: 'butler', requestId: 'run-1' }),
    common,
  ).toolTrace

  assert.deepEqual(trace.map((event) => event.text), [
    '搜索历史记录', '历史记录检索完成',
    '运行本地命令', '本地命令完成',
    '操作网页', '网页操作完成',
    '确认问题', '问题已确认',
  ])
  assert.equal(trace.every((event) => event.hideToolName), true)
})

test('five same-kind historical calls remain five timeline activities', () => {
  const repeated = receipt()
  repeated.tools = Array.from({ length: 5 }, (_, index) => ({
    ...repeated.tools[0],
    callId: `search-${index}`,
    toolName: 'web_search',
  }))
  const trace = applyProductTurnReceipt(
    createEmptyScopeRunState({ scopeId: 'scope-1', agent: 'butler', requestId: 'run-1' }),
    repeated,
  ).toolTrace
  const items = deriveToolTimelineItems(filterUserVisibleToolTraceEvents(trace))

  assert.equal(items.length, 5)
  assert.equal(items.every((item) => item.toolName === 'web_search' && item.hideToolName), true)
})
