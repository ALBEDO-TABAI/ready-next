import assert from 'node:assert/strict'
import test from 'node:test'

import { consumeThoroughDeliveryOverride } from '../renderer/modules/agent/dynamicDeliveryMode'

test('thorough mode is consumed by one send and resets immediately', () => {
  assert.deepEqual(consumeThoroughDeliveryOverride(true), { deliveryMode: 'thorough', nextEnabled: false })
  assert.deepEqual(consumeThoroughDeliveryOverride(false), { deliveryMode: undefined, nextEnabled: false })
})
