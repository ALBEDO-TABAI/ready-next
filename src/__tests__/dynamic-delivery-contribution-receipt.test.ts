import assert from 'node:assert/strict'
import test from 'node:test'

import type { DeliveryPackageState } from '../shared/dynamic-delivery'
import { isRegisteredContributionAdoptable } from '../main/modules/agent-control/runtime-core/dynamic-delivery/contribution-receipt'

const base = {
  packageId: 'pkg', attempt: 0, childTaskId: 'child', lifecycleId: 'life', criticality: 'required',
  status: 'completed', adoptedByOwner: null, evidenceHandleIds: ['proof-1'],
  binding: {
    schemaVersion: 1, runId: 'child-run', ownerAgentIdAtStart: 'owner', runOrigin: 'workflow_participant',
    kind: 'registered_agent', requestedAgentId: 'analyst', effectiveAgentId: 'analyst',
    executionMaterialHash: 'hash', ownerAssignmentSource: 'parent_task',
    executionSelectionSource: 'task_owner', resolutionKind: 'direct',
  },
} as DeliveryPackageState

test('only completed registered contributions with durable used evidence are eligible for adoption', () => {
  assert.equal(isRegisteredContributionAdoptable(base, new Set(['proof-1'])), true)
  assert.equal(isRegisteredContributionAdoptable({ ...base, status: 'degraded' }, new Set(['proof-1'])), false)
  assert.equal(isRegisteredContributionAdoptable({ ...base, evidenceHandleIds: [] }, new Set(['proof-1'])), false)
  assert.equal(isRegisteredContributionAdoptable({ ...base, binding: { ...base.binding, kind: 'ephemeral' } }, new Set(['proof-1'])), false)
  assert.equal(isRegisteredContributionAdoptable(base, new Set()), false)
})
