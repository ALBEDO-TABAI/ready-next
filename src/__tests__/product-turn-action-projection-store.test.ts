import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexHeadActionProjection } from '../shared/ipc-contracts/agent-runtime'
import { mergeProductTurnActionProjections } from '../renderer/modules/agent/productTurnReceipt'
import { makeProductTurnActionProjection } from './product-turn-action-projection-fixture'

const head: CodexHeadActionProjection = {
  kind: 'scope_head', scopeId: 'scope-1', ownerRunId: null,
  historyState: 'ready',
  actionHeadIdentity: {
    aliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'binding-1', headRevision: 1,
  },
  closedByLifecycleRef: null,
  actions: { send_new_message: { availability: 'ready', blockers: [], consequence: null } },
  actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 1 },
  evidenceDigest: '1'.repeat(64),
}

test('per-run projections survive unrelated active-run changes and stale heads are removed', () => {
  const old = makeProductTurnActionProjection({ readyRunId: 'run-old', retryAvailability: 'ready' })
  const current = makeProductTurnActionProjection({ readyRunId: 'run-current', retryAvailability: 'ready' })
  const first = mergeProductTurnActionProjections({ workbenchMode: 'browser', existing: {}, incoming: [old, current], head })
  assert.deepEqual(Object.keys(first).sort(), ['run-current', 'run-old'])

  const nextHead = { ...head, evidenceDigest: '9'.repeat(64) }
  const second = mergeProductTurnActionProjections({ workbenchMode: 'browser', existing: first, incoming: [], head: nextHead })
  assert.deepEqual(second, {})
})
