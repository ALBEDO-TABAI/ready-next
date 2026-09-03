import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexHeadActionProjection } from '../shared/ipc-contracts/agent-runtime'
import { mergeProductTurnActionProjections } from '../renderer/modules/agent/productTurnReceipt'
import { makeProductTurnActionProjection } from './product-turn-action-projection-fixture'

const head: CodexHeadActionProjection = {
  kind: 'scope_head', scopeId: 'scope-1', ownerRunId: null, historyState: 'ready',
  actionHeadIdentity: { aliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'b', headRevision: 1 },
  closedByLifecycleRef: null,
  actions: { send_new_message: { availability: 'ready', blockers: [], consequence: null } },
  actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 1 },
  evidenceDigest: '1'.repeat(64),
}

test('a late older memory projection cannot overwrite the newer retry gate', () => {
  const older = makeProductTurnActionProjection({ readyRunId: 'run-1', retryAvailability: 'ready' })
  const newer = {
    ...older,
    currentReadyMemoryRef: {
      ...older.currentReadyMemoryRef,
      stateRevision: 2,
      modelVisiblePayloadEmpty: false,
    },
    productTurnActionProjectionVersion: {
      ...older.productTurnActionProjectionVersion,
      readyMemoryStateRevision: 2,
    },
    retry_failed_task: {
      availability: 'not_applicable' as const,
      blockers: ['current_memory_restatement_required'],
      consequence: null,
    },
    evidenceDigest: '8'.repeat(64),
  }
  const withNewer = mergeProductTurnActionProjections({ workbenchMode: 'browser', existing: {}, incoming: [newer], head })
  const afterLateOlder = mergeProductTurnActionProjections({ workbenchMode: 'browser',
    existing: withNewer, incoming: [older], head,
  })
  assert.equal(
    afterLateOlder['run-1'].currentReadyMemoryRef?.stateRevision,
    2,
  )
  assert.equal(afterLateOlder['run-1'].retry_failed_task.availability, 'not_applicable')
})
