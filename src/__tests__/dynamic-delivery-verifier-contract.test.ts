import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDeliveryVerification } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-verifier'

test('malformed verifier output blocks safely instead of leaving verification pending', () => {
  for (const raw of ['not json', '{"version":"1","verdict":"accept","gaps":[],"summary":"ok"}', '{"version":1,"verdict":"reject","gaps":[],"summary":"no"}']) {
    const verdict = parseDeliveryVerification(raw)
    assert.equal(verdict.verdict, 'block')
    assert.equal(verdict.gaps.length > 0, true)
  }
})

test('valid verifier output remains accepted', () => {
  const verdict = parseDeliveryVerification('{"version":1,"verdict":"accept","gaps":[],"summary":"verified"}')
  assert.equal(verdict.verdict, 'accept')
})
