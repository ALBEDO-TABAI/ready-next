import assert from 'node:assert/strict'
import test from 'node:test'

import { OriginInteractionBudget, scopedOriginInteractionKey } from '../main/modules/browser-engine/origin-interaction-budget'

test('serializes writes for one origin but not unrelated origins', async () => {
  const budget = new OriginInteractionBudget()
  const events: string[] = []
  let releaseFirst!: () => void
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve })
  const first = budget.runWrite('https://example.com/a', async () => {
    events.push('first:start')
    await firstDone
    events.push('first:end')
    return 1
  })
  const second = budget.runWrite('https://example.com/b', async () => {
    events.push('second')
    return 2
  })
  const other = budget.runWrite('https://other.test/', async () => {
    events.push('other')
    return 3
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['first:start', 'other'])
  releaseFirst()
  await Promise.all([first, second, other])
  assert.deepEqual(events, ['first:start', 'other', 'first:end', 'second'])
})

test('honors Retry-After and blocks all later writes after a challenge', async () => {
  let now = 10_000
  const budget = new OriginInteractionBudget(() => now)
  const limited = budget.record('https://example.com/', { status: 429, retryAfter: 12 })
  assert.equal(limited.cooldownUntil, 22_000)
  now = 22_000
  budget.record('https://example.com/', { challenge: true })
  let called = false
  const blocked = await budget.runWrite('https://example.com/', async () => { called = true })
  assert.equal(blocked.gate.ok, false)
  assert.equal(called, false)
  budget.clearChallenge('https://example.com/')
  const resumed = await budget.runWrite('https://example.com/', async () => 'ok')
  assert.equal(resumed.gate.ok, true)
  assert.equal(resumed.value, 'ok')
})

test('challenge state is isolated by browser profile and conversation scope', async () => {
  const budget = new OriginInteractionBudget()
  const blockedKey = scopedOriginInteractionKey({ profile: 'account-a', scopeId: 'scope-a', origin: 'https://example.com' })
  const otherProfile = scopedOriginInteractionKey({ profile: 'account-b', scopeId: 'scope-a', origin: 'https://example.com' })
  const otherScope = scopedOriginInteractionKey({ profile: 'account-a', scopeId: 'scope-b', origin: 'https://example.com' })
  budget.record(blockedKey, { challenge: true })

  assert.equal((await budget.runWrite(blockedKey, async () => 'blocked')).gate.ok, false)
  assert.equal((await budget.runWrite(otherProfile, async () => 'profile-ok')).value, 'profile-ok')
  assert.equal((await budget.runWrite(otherScope, async () => 'scope-ok')).value, 'scope-ok')
})

test('local locator and validation failures never create an origin cooldown', () => {
  let now = 10_000
  const budget = new OriginInteractionBudget(() => now)
  budget.record('https://example.com/', { actionSucceeded: false })
  now += 1
  const state = budget.record('https://example.com/', { actionSucceeded: false })
  assert.equal(state.consecutiveFailures, 0)
  assert.equal(state.cooldownUntil, 0)
  assert.equal(state.challengeBlocked, false)
})
