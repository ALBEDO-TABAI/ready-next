import assert from 'node:assert/strict'
import test from 'node:test'

import { rectanglesIntersect } from '../renderer/modules/overlay/useNativeSurfaceAwareOverlay'
import { didBrowserHideAck } from '../renderer/modules/overlay/browserViewMask'

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

test('native-surface masking is based on real rectangle intersection', () => {
  assert.equal(rectanglesIntersect(rect(0, 0, 400, 300), rect(350, 250, 200, 200)), true)
  assert.equal(rectanglesIntersect(rect(0, 0, 400, 300), rect(400, 0, 200, 200)), false)
  assert.equal(rectanglesIntersect(rect(0, 0, 0, 300), rect(0, 0, 200, 200)), false)
})

test('overlay reveal trusts only a matching browser hide acknowledgement', () => {
  assert.equal(didBrowserHideAck({ outcome: 'ack', intentId: 7 }), true)
  assert.equal(didBrowserHideAck({ outcome: 'timeout', intentId: 7 }), false)
  assert.equal(didBrowserHideAck({ outcome: 'cancelled', intentId: 7 }), false)
})
