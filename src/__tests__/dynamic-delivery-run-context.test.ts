import assert from 'node:assert/strict'
import test from 'node:test'

import { MemorySession } from '@openai/agents'

import { DeliveryOutputBuffer } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-output-buffer'
import { DeliveryRunContextStore } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-run-context'

function state() {
  return {
    version: 1 as const,
    stateRevision: 0,
    decision: 'verify_only' as const,
    parentGeneration: 0,
    packages: [],
    verifier: { status: 'pending' as const, repaired: false },
    usage: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      usageSource: 'missing' as const, providerCallCount: 0, missingCallCount: 0,
    },
  }
}

test('run contexts isolate usage, accumulate each provider call once, and close cleanly', () => {
  const store = new DeliveryRunContextStore()
  const session = new MemorySession({ sessionId: 'committed' })
  const context = store.create({
    runId: 'run-a', taskId: 'task-a', userRequestVerbatim: 'test request', decision: 'verify_only', state: state(),
    committedSession: session, ownerSession: session, transaction: null,
    outputBuffer: new DeliveryOutputBuffer(), workerReports: [], canonicalReceiptItems: [], evidenceResources: [],
    pendingAcceptance: null,
  })

  assert.equal(store.get('run-a'), context)
  store.addUsage('run-a', { inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  store.addUsage('run-a', { inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  assert.deepEqual(store.snapshotUsage('run-a'), {
    inputTokens: 13, outputTokens: 6, totalTokens: 19,
    usageSource: 'provider', providerCallCount: 2, missingCallCount: 0,
  })
  assert.throws(() => store.create({
    runId: 'run-a', taskId: 'other', userRequestVerbatim: 'test request', decision: 'verify_only', state: state(),
    committedSession: session, ownerSession: session, transaction: null,
    outputBuffer: null, workerReports: [], canonicalReceiptItems: [], evidenceResources: [],
    pendingAcceptance: null,
  }), /duplicate run context/)

  store.close('run-a')
  assert.equal(store.get('run-a'), null)
  assert.equal(store.snapshotUsage('run-a'), null)
})
