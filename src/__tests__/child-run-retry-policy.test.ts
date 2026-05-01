import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getChildRunRetryPolicy,
  type ChildRunRetryPolicy,
} from '../main/modules/agent-control/child-run-retry-policy'
import { CANONICAL_SKILL_CHILD_TERMINAL_REASONS } from '../main/modules/agent-control/skill-child-state-machine'
import type { SkillChildRunTerminalReason } from '../main/modules/agent-control/skill-child-run-types'

const EXPECTED_TERMINAL_REASONS: readonly SkillChildRunTerminalReason[] = [
  'completed',
  'checkpoint_budget',
  'checkpoint_background',
  'queued_global_concurrency',
  'launch_stuck',
  'blocked_config',
  'blocked_external',
  'nested_child_run_not_supported',
  'cancelled_user',
  'failed_skill',
  'resume_launch_failed',
  'persistence_failed',
  'child_process_crashed',
  'host_unavailable',
  'tool_not_registered',
  'input_validation',
  'process_restarted',
] as const

test('retry policy exhaustively classifies every canonical terminal reason', () => {
  assert.deepEqual(
    [...CANONICAL_SKILL_CHILD_TERMINAL_REASONS].sort(),
    [...EXPECTED_TERMINAL_REASONS].sort(),
  )

  for (const reason of EXPECTED_TERMINAL_REASONS) {
    const policy = getChildRunRetryPolicy(reason)
    assert.equal(typeof policy.retriable, 'boolean', `${reason} should declare retriable`)
    assert.equal(Number.isInteger(policy.maxAttempts), true, `${reason} should declare maxAttempts`)
    assert.ok(policy.maxAttempts >= 1, `${reason} should allow at least the initial attempt`)
    assert.ok(Array.isArray(policy.backoffMs), `${reason} should declare backoffMs`)
  }
})

test('queued_global_concurrency preserves the RSS 3 attempts with 5 second backoff contract', () => {
  assert.deepEqual(getChildRunRetryPolicy('queued_global_concurrency'), {
    retriable: true,
    maxAttempts: 3,
    backoffMs: [5000, 5000, 5000],
  } satisfies ChildRunRetryPolicy)
})

test('nested_child_run_not_supported is never retriable', () => {
  assert.deepEqual(getChildRunRetryPolicy('nested_child_run_not_supported'), {
    retriable: false,
    maxAttempts: 1,
    backoffMs: [],
  } satisfies ChildRunRetryPolicy)
})

test('resume and persistence launch failures use the bounded two-attempt policy', () => {
  const expected = {
    retriable: true,
    maxAttempts: 2,
    backoffMs: [2000, 10000],
  } satisfies ChildRunRetryPolicy

  assert.deepEqual(getChildRunRetryPolicy('resume_launch_failed'), expected)
  assert.deepEqual(getChildRunRetryPolicy('persistence_failed'), expected)
})

test('host_unavailable and process_restarted use small bounded retry policies', () => {
  assert.deepEqual(getChildRunRetryPolicy('host_unavailable'), {
    retriable: true,
    maxAttempts: 3,
    backoffMs: [2000, 10000, 30000],
  } satisfies ChildRunRetryPolicy)
  assert.deepEqual(getChildRunRetryPolicy('process_restarted'), {
    retriable: true,
    maxAttempts: 2,
    backoffMs: [1000, 5000],
  } satisfies ChildRunRetryPolicy)
})
