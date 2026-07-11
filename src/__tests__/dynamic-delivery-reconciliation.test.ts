import assert from 'node:assert/strict'
import test from 'node:test'

import type { DeliveryStateV1 } from '../shared/dynamic-delivery'
import {
  reconcileInterruptedDeliveryState,
  shouldReconcileInterruptedDeliveryProjection,
} from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-reconciliation'

function interruptedState(): DeliveryStateV1 {
  const binding = {
    schemaVersion: 1 as const, runId: 'run-child', ownerAgentIdAtStart: 'butler', runOrigin: 'workflow_participant' as const,
    kind: 'registered_agent' as const, requestedAgentId: 'analyst', effectiveAgentId: 'analyst',
    executionMaterialHash: 'hash', ownerAssignmentSource: 'parent_task' as const,
    executionSelectionSource: 'workflow_participant' as const, resolutionKind: 'direct' as const,
  }
  return {
    version: 1, stateRevision: 7, decision: 'support_and_verify', parentGeneration: 2,
    packages: [
      { packageId: 'required-running', attempt: 0, childTaskId: 'c1', lifecycleId: 'l1', binding, criticality: 'required', status: 'running', adoptedByOwner: null, evidenceHandleIds: [] },
      { packageId: 'optional-planned', attempt: 0, childTaskId: 'c2', lifecycleId: 'l2', binding, criticality: 'optional', status: 'planned', adoptedByOwner: null, evidenceHandleIds: [] },
      { packageId: 'completed', attempt: 0, childTaskId: 'c3', lifecycleId: 'l3', binding, criticality: 'required', status: 'completed', adoptedByOwner: true, evidenceHandleIds: ['ev-1'] },
    ],
    verifier: { status: 'pending', repaired: false },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, usageSource: 'provider', providerCallCount: 1, missingCallCount: 0 },
  }
}

test('restart reconciliation blocks required work, degrades optional work and never recreates attempts', () => {
  const before = interruptedState()
  const after = reconcileInterruptedDeliveryState(before)
  assert.equal(after.stateRevision, 8)
  assert.equal(after.packages.find((pkg) => pkg.packageId === 'required-running')?.status, 'blocked')
  assert.equal(after.packages.find((pkg) => pkg.packageId === 'optional-planned')?.status, 'degraded')
  assert.equal(after.packages.find((pkg) => pkg.packageId === 'completed')?.status, 'completed')
  assert.deepEqual(after.packages.map((pkg) => [pkg.packageId, pkg.attempt, pkg.childTaskId, pkg.lifecycleId]),
    before.packages.map((pkg) => [pkg.packageId, pkg.attempt, pkg.childTaskId, pkg.lifecycleId]))
  assert.deepEqual(after.packages.find((pkg) => pkg.packageId === 'completed')?.evidenceHandleIds, ['ev-1'])
  assert.equal(after.verifier.status, 'blocked')
})

test('already settled and accepted delivery state is returned unchanged', () => {
  const settled = interruptedState()
  settled.packages = settled.packages.map((pkg) => ({ ...pkg, status: 'completed' }))
  settled.verifier = { status: 'accepted', repaired: false }
  assert.equal(reconcileInterruptedDeliveryState(settled), settled)
})

test('restart reconciliation never rewrites an already terminal parent failure as an app-exit checkpoint', () => {
  assert.equal(shouldReconcileInterruptedDeliveryProjection({ projectionStatus: 'failed', runMetaStatus: 'error' }), false)
  assert.equal(shouldReconcileInterruptedDeliveryProjection({ projectionStatus: 'completed', runMetaStatus: 'done' }), false)
  assert.equal(shouldReconcileInterruptedDeliveryProjection({ projectionStatus: 'running', runMetaStatus: 'running' }), true)
  assert.equal(shouldReconcileInterruptedDeliveryProjection({ projectionStatus: 'running', runMetaStatus: null }), true)
})
