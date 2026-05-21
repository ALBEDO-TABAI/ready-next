import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { shouldEnforcePetToolRetry } from '../main/modules/agent-control/pet-tool-loop-policy'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

test('pet tool loop retries when the model replies without creating a sticky note', () => {
  const intent = classifyIntent(buildRequestEnvelope({ userText: '贴到便利贴里面' }))

  assert.equal(shouldEnforcePetToolRetry({
    intent,
    allowedToolNames: ['pet_show_sticky_note'],
    toolCallsCount: 0,
  }), true)
  assert.equal(shouldEnforcePetToolRetry({
    intent,
    allowedToolNames: ['pet_show_sticky_note'],
    toolCallsCount: 1,
  }), false)
  assert.equal(shouldEnforcePetToolRetry({
    intent,
    allowedToolNames: [],
    toolCallsCount: 0,
  }), false)
})
