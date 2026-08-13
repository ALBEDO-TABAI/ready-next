import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexSidecarRecoveryExhaustedError,
  CodexSidecarRecoveryOwner,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-recovery-owner'

for (const initializationFailure of [
  'gateway_listen_failed',
  'codex_main_process_identity_unavailable',
]) {
  test(`${initializationFailure} is owned before boot and the same Main is ready after the second initialization`, async () => {
    const events: string[] = []
    let initializationCount = 0
    const owner = new CodexSidecarRecoveryOwner({
      maxAttempts: 3,
      async bootOnce() {
        initializationCount += 1
        events.push(`initialize:${initializationCount}`)
        if (initializationCount === 1) throw new Error(initializationFailure)
        return true
      },
      async settleFailedAttempt() { events.push('settle') },
      resetAttemptBudget() {},
      shouldRetryFailure() { return true },
    })

    assert.equal(await owner.recover({ trigger: 'initial_start' }), true)
    assert.deepEqual(events, ['initialize:1', 'settle', 'initialize:2'])
    assert.equal(await owner.ensureReadyForUserIngress(), true)
    assert.equal(initializationCount, 2)
  })
}

test('recovery owner serializes callers, settles the first failed boot, and lets the same Main send after the second', async () => {
  let releaseFirst!: () => void
  const firstAttempt = new Promise<void>((resolve) => { releaseFirst = resolve })
  let bootCount = 0
  let activeBoots = 0
  let maxActiveBoots = 0
  let settleCount = 0
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      bootCount += 1
      activeBoots += 1
      maxActiveBoots = Math.max(maxActiveBoots, activeBoots)
      try {
        if (bootCount === 1) {
          await firstAttempt
          throw new Error('sidecar_spawn_failed')
        }
        return true
      } finally {
        activeBoots -= 1
      }
    },
    async settleFailedAttempt() { settleCount += 1 },
    resetAttemptBudget() { throw new Error('unexpected_budget_reset') },
    shouldRetryFailure() { return true },
  })

  const first = owner.recover({ trigger: 'unexpected_close' })
  const second = owner.recover({ trigger: 'unexpected_close' })
  assert.equal(first, second)
  releaseFirst()

  assert.equal(await first, true)
  assert.equal(bootCount, 2)
  assert.equal(settleCount, 1)
  assert.equal(maxActiveBoots, 1)
  assert.equal(owner.readSnapshot().state, 'ready')

  let admittedMessages = 0
  if (await owner.ensureReadyForUserIngress()) admittedMessages += 1
  assert.equal(admittedMessages, 1)
  assert.equal(bootCount, 2)
})

test('exhausted recovery remains visible and an explicit user retry resets the same supervisor budget', async () => {
  let allowBoot = false
  let bootCount = 0
  let settleCount = 0
  let resetCount = 0
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      bootCount += 1
      if (!allowBoot) throw new Error('sidecar_spawn_failed')
      return true
    },
    async settleFailedAttempt() { settleCount += 1 },
    resetAttemptBudget() { resetCount += 1 },
    shouldRetryFailure() { return true },
  })

  await assert.rejects(
    owner.recover({ trigger: 'initial_start' }),
    (error: unknown) => error instanceof CodexSidecarRecoveryExhaustedError,
  )
  assert.deepEqual(owner.readSnapshot(), {
    state: 'exhausted',
    trigger: 'initial_start',
    attempt: 3,
    failureCode: 'sidecar_spawn_failed',
  })
  assert.equal(bootCount, 3)
  assert.equal(settleCount, 3)

  allowBoot = true
  assert.equal(await owner.ensureReadyForUserIngress(), true)
  assert.equal(resetCount, 1)
  assert.equal(bootCount, 4)
  assert.equal(owner.readSnapshot().state, 'ready')
})

test('failed lease settlement stops the sequence before another spawn', async () => {
  let bootCount = 0
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      bootCount += 1
      throw new Error('sidecar_connection_closed_during_initialize')
    },
    async settleFailedAttempt() { throw new Error('lease_settlement_unproven') },
    resetAttemptBudget() {},
    shouldRetryFailure() { return true },
  })

  await assert.rejects(owner.recover({ trigger: 'initial_start' }), /sidecar_recovery_exhausted/)
  assert.equal(bootCount, 1)
  assert.equal(owner.readSnapshot().failureCode, 'sidecar_failed_attempt_settlement_unproven')
})

test('explicit retry proves a previously failed settlement before resetting the budget or spawning', async () => {
  const events: string[] = []
  let bootCount = 0
  let settleCount = 0
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      bootCount += 1
      events.push(`boot:${bootCount}`)
      if (bootCount === 1) throw new Error('sidecar_connection_closed_during_initialize')
      return true
    },
    async settleFailedAttempt() {
      settleCount += 1
      events.push(`settle:${settleCount}`)
      if (settleCount === 1) throw new Error('lease_settlement_unproven')
    },
    resetAttemptBudget() { events.push('reset') },
    shouldRetryFailure() { return true },
  })

  await assert.rejects(owner.recover({ trigger: 'initial_start' }), /sidecar_recovery_exhausted/)
  assert.deepEqual(events, ['boot:1', 'settle:1'])

  assert.equal(await owner.ensureReadyForUserIngress(), true)
  assert.deepEqual(events, ['boot:1', 'settle:1', 'settle:2', 'reset', 'boot:2'])
})

test('unexpected-close recovery never retries an unproven prerequisite until explicit ingress retry', async () => {
  const events: string[] = []
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      events.push('boot')
      return true
    },
    async settleFailedAttempt() { events.push('settle-retry') },
    resetAttemptBudget() { events.push('reset') },
    shouldRetryFailure() { return true },
  })

  await assert.rejects(owner.recover({
    trigger: 'unexpected_close',
    prerequisite: Promise.reject(new Error('transient_tree_zero_proof_failure')),
  }), /sidecar_recovery_exhausted/)
  assert.deepEqual(events, [])
  assert.equal(await owner.ensureReadyForUserIngress(), true)
  assert.deepEqual(events, ['settle-retry', 'reset', 'boot'])
})

test('a non-sidecar global failure is settled once and never converted into a restart loop', async () => {
  let bootCount = 0
  let settleCount = 0
  const owner = new CodexSidecarRecoveryOwner({
    maxAttempts: 3,
    async bootOnce() {
      bootCount += 1
      throw new Error('product_recovery_failed')
    },
    async settleFailedAttempt() { settleCount += 1 },
    resetAttemptBudget() { throw new Error('unexpected_budget_reset') },
    shouldRetryFailure() { return false },
  })

  await assert.rejects(owner.recover({ trigger: 'initial_start' }), /product_recovery_failed/)
  assert.equal(bootCount, 1)
  assert.equal(settleCount, 1)
  assert.equal(owner.readSnapshot().state, 'blocked')
  await assert.rejects(owner.ensureReadyForUserIngress(), /product_recovery_failed/)
  assert.equal(bootCount, 1)
})
