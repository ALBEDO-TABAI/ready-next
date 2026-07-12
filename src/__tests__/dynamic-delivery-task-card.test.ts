import assert from 'node:assert/strict'
import test from 'node:test'

import { dynamicDeliveryVerifierLabel } from '../renderer/components/agent/chat-panel/task/TaskCard'

test('terminal task cards never claim an independent review is still pending', () => {
  assert.equal(dynamicDeliveryVerifierLabel('error', 'pending'), '')
  assert.equal(dynamicDeliveryVerifierLabel('done', 'pending'), '')
  assert.equal(dynamicDeliveryVerifierLabel('cancelled', 'pending'), '')
  assert.equal(dynamicDeliveryVerifierLabel('tool_running', 'pending'), '等待独立复核')
})
