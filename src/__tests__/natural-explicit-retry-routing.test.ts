import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveNaturalExplicitRetry,
  type RetryRouteMessage,
} from '../renderer/modules/agent/explicit-retry-routing'
import type { ProductTurnReceipt } from '../shared/ipc-contracts/agent-runtime'
import { withReceiptV3Fields } from './product-turn-action-projection-fixture'

const failedMessage: RetryRouteMessage = {
  type: 'agent',
  meta: { runId: 'run-failed', terminalReason: 'blocked_external' },
}

function receipt(overrides: Partial<ProductTurnReceipt> = {}): ProductTurnReceipt {
  return {
    ...withReceiptV3Fields({ readyRunId: 'run-failed', retryAvailability: 'ready' }),
    readyRunId: 'run-failed',
    readyTaskId: 'task-failed',
    readyScopeId: 'scope-retry',
    messageVisibilityEpoch: 0,
    revision: 1,
    terminal: 'error',
    canonicalMessage: {
      id: 'assistant-failed',
      role: 'assistant',
      content: 'failed',
      timestamp: '2026-08-21T11:00:00.000Z',
      meta: {},
    },
    canonicalMessageDigest: 'a'.repeat(64),
    tools: [],
    artifacts: [],
    memory: null,
    contextUsage: null,
    failure: {
      kind: 'persistence',
      effectState: 'none',
      evidenceRefs: [],
    },
    publicationSealDigest: null,
    presentationDigest: 'b'.repeat(64),
    ...overrides,
  }
}

test('bare retry resolves the latest failed visible turn to an exact explicit retry receipt', async () => {
  const route = await resolveNaturalExplicitRetry({
    content: '重试',
    attachmentCount: 0,
    messages: [failedMessage],
    scopeId: 'scope-retry',
    readProductTurnPresentation: async (readyRunId) => ({
      success: true,
      data: receipt({ readyRunId }),
    }),
  })
  assert.deepEqual(route, {
    kind: 'resolved',
    explicitRetry: {
      predecessorRunId: 'run-failed',
      predecessorPresentationDigest: 'b'.repeat(64),
    },
  })
})

test('natural retry does not bind after a newer success or when new input is present', async () => {
  let reads = 0
  const readProductTurnPresentation = async () => {
    reads += 1
    return { success: true as const, data: receipt() }
  }
  assert.deepEqual(await resolveNaturalExplicitRetry({
    content: '重试',
    attachmentCount: 0,
    messages: [failedMessage, { type: 'agent', meta: { runId: 'run-done', terminalReason: 'done' } }],
    scopeId: 'scope-retry',
    readProductTurnPresentation,
  }), { kind: 'not_applicable' })
  assert.deepEqual(await resolveNaturalExplicitRetry({
    content: '重试',
    attachmentCount: 0,
    workbenchResourceCount: 1,
    messages: [failedMessage],
    scopeId: 'scope-retry',
    readProductTurnPresentation,
  }), { kind: 'resource_restatement_required' })
  assert.deepEqual(await resolveNaturalExplicitRetry({
    content: '重试并总结另一个网页',
    attachmentCount: 0,
    messages: [failedMessage],
    scopeId: 'scope-retry',
    readProductTurnPresentation,
  }), { kind: 'not_applicable' })
  assert.deepEqual(await resolveNaturalExplicitRetry({
    content: '再试一次',
    attachmentCount: 1,
    messages: [failedMessage],
    scopeId: 'scope-retry',
    readProductTurnPresentation,
  }), { kind: 'resource_restatement_required' })
  assert.equal(reads, 0)
})

test('a retry cue fails closed when the canonical predecessor receipt cannot be verified', async () => {
  assert.deepEqual(await resolveNaturalExplicitRetry({
    content: '再试一次',
    attachmentCount: 0,
    messages: [failedMessage],
    scopeId: 'scope-retry',
    readProductTurnPresentation: async () => ({
      success: true,
      data: receipt({ readyScopeId: 'other-scope' }),
    }),
  }), { kind: 'unavailable' })
})


test('continuation words remain ordinary input in the Renderer too', async () => {
  for (const content of ['继续', '接着做', 'continue', 'resume', '重试并总结另一个网页']) {
    assert.deepEqual(await resolveNaturalExplicitRetry({
      content, attachmentCount: 0, messages: [failedMessage], scopeId: 'scope-retry',
      readProductTurnPresentation: async () => { throw new Error('must_not_read_retry_receipt') },
    }), { kind: 'not_applicable' }, content)
  }
})
