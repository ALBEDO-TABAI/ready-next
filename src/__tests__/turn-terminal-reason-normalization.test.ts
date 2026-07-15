import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TURN_TERMINAL_REASONS,
  normalizeTurnTerminalReason,
} from '../main/modules/agent-control/runtime-core/turn-frame'

test('scope-run terminal normalization accepts every shared turn terminal reason', () => {
  for (const reason of TURN_TERMINAL_REASONS) {
    assert.equal(normalizeTurnTerminalReason(reason), reason)
  }
  assert.equal(normalizeTurnTerminalReason('unknown_terminal_reason'), null)
  assert.equal(normalizeTurnTerminalReason(null), null)
})

test('adjudication and proof terminal reasons cannot disappear in the IPC normalization path', () => {
  for (const reason of [
    'adjudication_degraded',
    'proof_gap',
    'delivery_failed',
    'tool_unavailable',
    'no_artifact',
    'browser_transaction_unconfirmed',
    'context_overflow',
  ] as const) {
    assert.equal(normalizeTurnTerminalReason(reason), reason)
  }
})
