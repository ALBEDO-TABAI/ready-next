import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANONICAL_SKILL_CHILD_TERMINAL_REASONS,
  classifySkillChildRunStatus,
  coerceSkillChildTerminalReason,
  isSkillChildRunResumable,
  isSkillChildRunTerminalReason,
} from '../main/modules/agent-control/skill-child-state-machine'
import type {
  ChildWaitResult,
  SkillChildCloseEvent,
  SkillChildRunStatus,
  SkillChildRunTerminalReason,
} from '../main/modules/agent-control/skill-child-run-types'

function makeCloseEvent(overrides?: Partial<SkillChildCloseEvent>): SkillChildCloseEvent {
  return {
    childRunId: 'scr-test-1',
    skillId: 'video-expert-analyzer',
    status: 'failed',
    terminalReason: 'infra_error',
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
    error: {
      kind: 'infra_error',
      message: 'failed',
    },
    ...overrides,
  }
}

test('state machine accepts canonical terminal reasons and rejects ad-hoc reasons', () => {
  const expected: SkillChildRunTerminalReason[] = [
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
    'infra_error',
    'child_process_crashed',
    'host_unavailable',
    'tool_not_registered',
    'input_validation',
    'process_restarted',
  ]

  assert.deepEqual(
    [...CANONICAL_SKILL_CHILD_TERMINAL_REASONS].sort(),
    [...expected].sort(),
  )
  for (const reason of expected) {
    assert.equal(isSkillChildRunTerminalReason(reason), true, `${reason} should be accepted`)
  }

  for (const reason of ['await_timeout', 'blocked', 'random_runtime_word']) {
    assert.equal(isSkillChildRunTerminalReason(reason), false, `${reason} should be rejected`)
  }
})

test('legacy infra_error crash payload coerces to child_process_crashed', () => {
  const close = makeCloseEvent({
    error: {
      kind: 'child_process_crashed',
      message: 'child process exited unexpectedly',
    },
  })

  assert.equal(coerceSkillChildTerminalReason(close), 'child_process_crashed')
})

test('legacy infra_error host payload coerces to host_unavailable', () => {
  const close = makeCloseEvent({
    error: {
      kind: 'host_unavailable',
      message: 'tool host is unavailable',
    },
  })

  assert.equal(coerceSkillChildTerminalReason(close), 'host_unavailable')
})

test('legacy infra_error tool admission payload coerces to tool_not_registered', () => {
  const close = makeCloseEvent({
    error: {
      kind: 'tool_not_registered',
      message: 'requested tool is not registered',
    },
  })

  assert.equal(coerceSkillChildTerminalReason(close), 'tool_not_registered')
})

test('legacy infra_error input validation payload coerces to input_validation', () => {
  const close = makeCloseEvent({
    error: {
      kind: 'input_validation',
      message: 'input failed validation',
    },
  })

  assert.equal(coerceSkillChildTerminalReason(close), 'input_validation')
})

test('observer timeout is a wait result and not a terminal reason', () => {
  const waitResult: ChildWaitResult = {
    kind: 'observer_timeout',
    childRunId: 'scr-test-1',
    elapsedMs: 10_000,
  }

  assert.equal(waitResult.kind, 'observer_timeout')
  assert.equal(isSkillChildRunTerminalReason('observer_timeout'), false)
  assert.equal(isSkillChildRunTerminalReason('await_timeout'), false)
})

test('blocked child is not directly resumable', () => {
  const status: SkillChildRunStatus = 'blocked'

  assert.equal(classifySkillChildRunStatus(status), 'blocked')
  assert.equal(isSkillChildRunResumable(status), false)
})

test('budget_paused and recoverable_paused children are resumable', () => {
  assert.equal(classifySkillChildRunStatus('budget_paused'), 'paused')
  assert.equal(classifySkillChildRunStatus('recoverable_paused'), 'paused')
  assert.equal(isSkillChildRunResumable('budget_paused'), true)
  assert.equal(isSkillChildRunResumable('recoverable_paused'), true)
})
