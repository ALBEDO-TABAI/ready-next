import assert from 'node:assert/strict'
import test from 'node:test'

import {
  consumeThoroughDeliveryOverride,
  createThoroughDeliveryOverrideLatch,
} from '../renderer/modules/agent/dynamicDeliveryMode'

test('thorough mode is consumed by one send and resets immediately', () => {
  assert.deepEqual(consumeThoroughDeliveryOverride(true), { deliveryMode: 'thorough', nextEnabled: false })
  assert.deepEqual(consumeThoroughDeliveryOverride(false), { deliveryMode: undefined, nextEnabled: false })
})

test('same-tick Boost click is latched before React state can re-render', () => {
  const latch = createThoroughDeliveryOverrideLatch()
  latch.setEnabled(true)
  assert.equal(latch.consume().deliveryMode, 'thorough')
  assert.equal(latch.consume().deliveryMode, undefined)
})
