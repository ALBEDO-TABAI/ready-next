import test from 'node:test'
import assert from 'node:assert/strict'

import {
  InvalidCloseEventError,
  freezeSkillChildCloseEvent,
  validateSkillChildCloseInvariant,
} from '../main/modules/agent-control/skill-child-close-event-freeze'
import type {
  MutableSkillChildCloseEvent,
  SkillChildRunTerminalReason,
} from '../main/modules/agent-control/skill-child-run-types'

type CloseStatus = MutableSkillChildCloseEvent['status']

interface PairCase {
  status: CloseStatus
  reason: SkillChildRunTerminalReason
}

const ALLOWED_PAIRS: PairCase[] = [
  { status: 'completed', reason: 'completed' },
  { status: 'failed', reason: 'tool_not_registered' },
  { status: 'failed', reason: 'nested_child_run_not_supported' },
  { status: 'failed', reason: 'host_unavailable' },
  { status: 'failed', reason: 'persistence_failed' },
  { status: 'failed', reason: 'resume_launch_failed' },
  { status: 'failed', reason: 'failed_skill' },
  { status: 'failed', reason: 'child_process_crashed' },
  { status: 'failed', reason: 'launch_stuck' },
  { status: 'failed', reason: 'input_validation' },
  { status: 'killed', reason: 'cancelled_user' },
  { status: 'killed', reason: 'process_restarted' },
  { status: 'recoverable_paused', reason: 'queued_global_concurrency' },
  { status: 'recoverable_paused', reason: 'process_restarted' },
  { status: 'recoverable_paused', reason: 'checkpoint_background' },
  { status: 'budget_paused', reason: 'checkpoint_budget' },
  { status: 'budget_paused', reason: 'checkpoint_background' },
  { status: 'blocked', reason: 'blocked_external' },
  { status: 'blocked', reason: 'blocked_config' },
]

const FORBIDDEN_PAIRS: PairCase[] = [
  { status: 'completed', reason: 'failed_skill' },
  { status: 'failed', reason: 'process_restarted' },
  { status: 'failed', reason: 'cancelled_user' },
  { status: 'killed', reason: 'failed_skill' },
  { status: 'recoverable_paused', reason: 'cancelled_user' },
  { status: 'budget_paused', reason: 'failed_skill' },
  { status: 'blocked', reason: 'completed' },
  { status: 'completed', reason: 'tool_not_registered' },
]

function makeCloseEvent(status: CloseStatus, reason: SkillChildRunTerminalReason): MutableSkillChildCloseEvent {
  return {
    childRunId: 'test-child',
    skillId: 'test-skill',
    status,
    terminalReason: reason,
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

test('validateSkillChildCloseInvariant accepts every allowed (status, terminalReason) pair', () => {
  for (const { status, reason } of ALLOWED_PAIRS) {
    assert.doesNotThrow(
      () => validateSkillChildCloseInvariant(status, reason),
      `expected (${status}, ${reason}) to be allowed`,
    )
  }
})

test('validateSkillChildCloseInvariant rejects forbidden pairs with InvalidCloseEventError', () => {
  for (const { status, reason } of FORBIDDEN_PAIRS) {
    assert.throws(
      () => validateSkillChildCloseInvariant(status, reason),
      (err) => err instanceof InvalidCloseEventError && err.status === status && err.terminalReason === reason,
      `expected (${status}, ${reason}) to throw InvalidCloseEventError`,
    )
  }
})

test('freezeSkillChildCloseEvent throws on a forbidden pair before freezing', () => {
  const event = makeCloseEvent('failed', 'process_restarted')
  assert.throws(
    () => freezeSkillChildCloseEvent(event),
    InvalidCloseEventError,
  )
  assert.equal(Object.isFrozen(event), false, 'event must not be frozen when validation fails')
})

test('freezeSkillChildCloseEvent freezes a valid event', () => {
  const event = makeCloseEvent('completed', 'completed')
  const frozen = freezeSkillChildCloseEvent(event)
  assert.equal(Object.isFrozen(frozen), true)
  assert.equal(frozen.status, 'completed')
})
