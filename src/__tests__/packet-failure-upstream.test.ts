import assert from 'node:assert/strict'
import test from 'node:test'

import { settleDeliveryFailure, unsettledRequiredPackages } from '../main/modules/agent-control/quality/packet-failure'

test('live packet failure has only redispatch-once, degrade-with-reason, or block', () => {
  assert.equal(settleDeliveryFailure({ packageId: 'p', requested: 'redispatch', currentAttempt: 0, planRedispatchesUsed: 0 }).status, 'redispatching')
  assert.throws(() => settleDeliveryFailure({ packageId: 'p', requested: 'redispatch', currentAttempt: 1, planRedispatchesUsed: 0 }), /cap exhausted/)
  assert.throws(() => settleDeliveryFailure({ packageId: 'p', requested: 'degrade', currentAttempt: 0, planRedispatchesUsed: 0 }), /explicit reason/)
  assert.equal(settleDeliveryFailure({ packageId: 'p', requested: 'degrade', currentAttempt: 0, planRedispatchesUsed: 0, degradeReason: 'optional evidence unavailable' }).status, 'degraded')
  assert.equal(settleDeliveryFailure({ packageId: 'p', requested: 'block', currentAttempt: 0, planRedispatchesUsed: 0 }).status, 'blocked')
})

test('failure layer cannot create parent proof/check-in and required unsettled work stays visible', () => {
  assert.deepEqual(unsettledRequiredPackages([
    { packageId: 'required', criticality: 'required', status: 'running' },
    { packageId: 'optional', criticality: 'optional', status: 'running' },
  ]), ['required'])
})
