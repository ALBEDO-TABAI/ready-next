import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChildRunCircuitBreaker,
  isChildRunCircuitBreakerEnabled,
  shouldCountChildRunCircuitBreakerFailure,
} from '../main/modules/agent-control/child-run-circuit-breaker'
import type { SkillChildCloseEvent } from '../main/modules/agent-control/skill-child-run-types'

function closeWithStatus(status: SkillChildCloseEvent['status']): SkillChildCloseEvent {
  return {
    childRunId: 'vCB000001',
    skillId: 'video-expert-analyzer',
    status,
    terminalReason: status === 'completed' ? 'completed' : 'failed_skill',
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: null,
  }
}

test('breaker opens after threshold failures in the window and cools down', () => {
  let now = 1_000
  const breaker = new ChildRunCircuitBreaker({
    windowMs: 5 * 60_000,
    failureThreshold: 3,
    cooldownMs: 15 * 60_000,
    now: () => now,
    enabled: true,
  })

  assert.equal(breaker.check('same-target').allowed, true)
  breaker.recordFailure('same-target')
  breaker.recordFailure('same-target')
  assert.equal(breaker.check('same-target').allowed, true)

  const opened = breaker.recordFailure('same-target')
  assert.equal(opened.opened, true)
  const blocked = breaker.check('same-target')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'cooldown')
  assert.equal(blocked.cooldownUntil, now + 15 * 60_000)

  now += 15 * 60_000 + 1
  assert.equal(breaker.check('same-target').allowed, true)
})

test('old failures outside the rolling window do not trip the breaker', () => {
  let now = 1_000
  const breaker = new ChildRunCircuitBreaker({
    windowMs: 100,
    failureThreshold: 2,
    cooldownMs: 1_000,
    now: () => now,
    enabled: true,
  })

  breaker.recordFailure('same-target')
  now += 101
  const opened = breaker.recordFailure('same-target')

  assert.equal(opened.opened, false)
  assert.equal(breaker.check('same-target').allowed, true)
})

test('kill switch disables breaker checks and failure recording', () => {
  assert.equal(isChildRunCircuitBreakerEnabled('0'), false)
  assert.equal(isChildRunCircuitBreakerEnabled('false'), false)
  assert.equal(isChildRunCircuitBreakerEnabled('off'), false)
  assert.equal(isChildRunCircuitBreakerEnabled(undefined), true)

  const breaker = new ChildRunCircuitBreaker({
    windowMs: 100,
    failureThreshold: 1,
    cooldownMs: 1_000,
    now: () => 1_000,
    enabled: false,
  })

  breaker.recordFailure('same-target')
  assert.equal(breaker.check('same-target').allowed, true)
})

test('only failed child-run close events count as breaker failures', () => {
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('failed')), true)
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('completed')), false)
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('killed')), false)
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('budget_paused')), false)
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('recoverable_paused')), false)
  assert.equal(shouldCountChildRunCircuitBreakerFailure(closeWithStatus('blocked')), false)
})
