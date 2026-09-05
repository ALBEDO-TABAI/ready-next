import assert from 'node:assert/strict'
import test from 'node:test'
import { assertFreshRootProviderCaptures, freshRootCases } from '../codex-runtime/fresh-root-installed-proof.mjs'

function fixture() {
  const proofs = freshRootCases.map(({ label }) => ({
    label, failedLogicalTurns: 1, failedGatewayRequests: 1, frozenRetryLimit: 6, failedProviderAttempts: 7,
  }))
  const captures = proofs.flatMap(({ label, failedProviderAttempts }) => [
    ...Array.from({ length: failedProviderAttempts }, () => ({ label, round: 1,
      kind: 'fresh_root_failure', stage: 'provider_failure_injected' })),
    { label, round: 2, kind: 'fresh_root_recovery' },
    { label, round: 3, kind: 'fresh_root_continuation' },
  ])
  return { proofs, captures }
}

test('one logical failed turn accounts for all attempts within its frozen gateway retry budget', () => {
  const { proofs, captures } = fixture()
  assert.equal(assertFreshRootProviderCaptures(captures, proofs), 18)
})

for (const defect of ['missing_attempt', 'duplicate_recovery', 'missing_continuation', 'wrong_failure_stage', 'foreign_label', 'budget_mismatch', 'duplicate_turn']) {
  test(`fresh-root acceptance rejects ${defect} instead of weakening the denominator`, () => {
    const { proofs, captures } = fixture()
    if (defect === 'missing_attempt') captures.shift()
    if (defect === 'duplicate_recovery') captures.push({ ...captures.find((row) => row.kind === 'fresh_root_recovery') })
    if (defect === 'missing_continuation') captures.pop()
    if (defect === 'wrong_failure_stage') captures[0].stage = 'unverified'
    if (defect === 'foreign_label') captures[0].label = 'F99'
    if (defect === 'budget_mismatch') proofs[0].frozenRetryLimit = 5
    if (defect === 'duplicate_turn') proofs[0].failedLogicalTurns = 2
    assert.throws(() => assertFreshRootProviderCaptures(captures, proofs), /fresh-root/)
  })
}
