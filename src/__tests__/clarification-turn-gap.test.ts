/**
 * Stage S W6.3 — Clarification turn-gap dispatcher behavior test.
 *
 * Asserts the helper-only contract: `shouldTriggerClarification(ctx)` is
 * true iff the most recent tool batch contained an ask_user call AND a
 * pending ClarificationRequest exists. No turn swallowing, no middleware.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldTriggerClarification } from '../main/modules/agent-control/contracts/clarification-turn-gap'
import type { ClarificationRequest } from '../main/modules/agent-control/contracts/clarification-types'

const sampleRequest: ClarificationRequest = {
  type: 'missing_info',
  question: 'Which timezone are you in?',
  options: null,
  toolCallId: 'tool-call-1',
}

test('returns false when both signals are absent', () => {
  assert.equal(
    shouldTriggerClarification({ toolBatchHadAskUser: false, pendingClarification: null }),
    false,
  )
})

test('returns false when only ask_user fired but no pending request', () => {
  assert.equal(
    shouldTriggerClarification({ toolBatchHadAskUser: true, pendingClarification: null }),
    false,
  )
})

test('returns false when only request is pending but no ask_user fired', () => {
  assert.equal(
    shouldTriggerClarification({
      toolBatchHadAskUser: false,
      pendingClarification: sampleRequest,
    }),
    false,
  )
})

test('returns true when both signals are present', () => {
  assert.equal(
    shouldTriggerClarification({
      toolBatchHadAskUser: true,
      pendingClarification: sampleRequest,
    }),
    true,
  )
})
