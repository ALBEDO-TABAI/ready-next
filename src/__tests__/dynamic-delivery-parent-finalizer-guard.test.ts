import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDynamicDeliveryFinalizerBlocker } from '../main/modules/agent-control/runtime-core/run-finalizer'
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
