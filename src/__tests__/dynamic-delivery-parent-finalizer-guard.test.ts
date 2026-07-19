import assert from 'node:assert/strict'
import test from 'node:test'

import {
  finalizeRunOutcome,
  resolveDynamicDeliveryFinalizerBlocker,
} from '../main/modules/agent-control/runtime-core/run-finalizer'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { DeliveryStateV1 } from '../shared/dynamic-delivery'

function state(overrides: Partial<DeliveryStateV1> = {}): DeliveryStateV1 {
  return {
    version: 1,
    stateRevision: 0,
    decision: 'verify_only',
    parentGeneration: 0,
    packages: [],
    verifier: { status: 'pending', repaired: false },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'missing',
      providerCallCount: 0,
      missingCallCount: 0,
    },
    ...overrides,
  }
}

test('non-single delivery cannot finalize done before verifier acceptance', () => {
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(state()), 'delivery_verifier_unsettled')
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(state({
    verifier: { status: 'blocked', repaired: false },
  })), 'delivery_verifier_unsettled')
})

test('support delivery also requires every required package to settle', () => {
  const binding = {
    schemaVersion: 1 as const,
    runId: 'child-run',
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'workflow_participant' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: 'analyst',
    effectiveAgentId: 'analyst',
    executionMaterialHash: 'hash',
    ownerAssignmentSource: 'parent_task' as const,
    executionSelectionSource: 'workflow_participant' as const,
    resolutionKind: 'direct' as const,
  }
  const base = state({
    decision: 'support_and_verify',
    verifier: { status: 'accepted', repaired: false },
    packages: [{
      packageId: 'facts',
      attempt: 0,
      childTaskId: 'child',
      lifecycleId: 'life',
      binding,
      criticality: 'required',
      status: 'running',
      adoptedByOwner: null,
      evidenceHandleIds: [],
    }],
  })
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(base), 'delivery_required_package_unsettled')
  base.packages[0]!.status = 'completed'
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(base), null)
})

test('single path is unchanged and accepted verify-only may finalize', () => {
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(null), null)
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(state({ decision: 'single_path' })), null)
  assert.equal(resolveDynamicDeliveryFinalizerBlocker(state({
    verifier: { status: 'accepted', repaired: true },
  })), null)
})

test('sealed accepted delivery state participates in core finalization before it is persisted', async () => {
  const now = new Date('2026-07-18T12:00:00.000Z').toISOString()
  let projection: TaskProjectionRecord = {
    taskId: 'task',
    scopeId: 'scope',
    runId: 'run',
    taskType: 'research',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    taskOrigin: 'user_root',
    deliveryState: state(),
    createdAt: now,
    updatedAt: now,
  }
  const accepted = state({ verifier: { status: 'accepted', repaired: false } })
  let deliveryStateAtCore: DeliveryStateV1 | null = null
  const result = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run',
    taskId: 'task',
    scopeId: 'scope',
    durationMs: 1,
    toolCallsUsed: 0,
    initiator: 'done',
    finalText: '已完成',
    projectionPatch: { deliveryState: accepted },
  }, {
    taskProjectionStore: {
      get: () => projection,
      update: (_taskId, patch) => { projection = { ...projection, ...patch } },
    } as never,
    commitCanonicalCoreCloseout: async (input) => {
      deliveryStateAtCore = input.deliveryState ?? null
      return {
        canonicalMessage: {
          id: 'assistant:task:run:terminal',
          conversationId: 'scope',
          role: 'assistant',
          content: '已完成',
          timestamp: now,
          meta: {},
        },
        canonicalMessageDigest: 'digest',
      }
    },
    writeRunCloseMetric: () => undefined,
  })
  assert.equal(result.status, 'done')
  assert.notEqual(result.terminalReason, 'delivery_verifier_unsettled')
  assert.equal(projection.deliveryState?.verifier.status, 'pending')
  assert.equal(deliveryStateAtCore?.verifier.status, 'accepted')
})
