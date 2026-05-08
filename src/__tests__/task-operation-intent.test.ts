import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTaskOperationIntent } from '../main/modules/agent-control/task-operation-intent'

test('task operation intent separates restart-same-goal from continuation', () => {
  const intent = resolveTaskOperationIntent({
    texts: ['从头来过，再跑一遍这次任务'],
    retryOnlyTurnDetected: true,
    configRepairTurnDetected: false,
    progressFollowupTurnDetected: false,
  })

  assert.equal(intent.kind, 'restart_same_goal')
})

test('task operation intent recognizes progress reset without an exact restart phrase', () => {
  const intent = resolveTaskOperationIntent({
    texts: ['把这轮进度清掉，按刚才目标重新执行'],
    retryOnlyTurnDetected: true,
    configRepairTurnDetected: false,
    progressFollowupTurnDetected: false,
  })

  assert.equal(intent.kind, 'restart_same_goal')
  assert.ok(intent.signals.includes('reset_boundary'))
  assert.ok(intent.signals.includes('same_goal_reference'))
})

test('task operation intent keeps plain continue on the resume path', () => {
  const intent = resolveTaskOperationIntent({
    texts: ['继续任务'],
    retryOnlyTurnDetected: true,
    configRepairTurnDetected: false,
    progressFollowupTurnDetected: false,
  })

  assert.equal(intent.kind, 'continue_existing')
})

test('task operation intent keeps retry-without-reset on the resume path', () => {
  const intent = resolveTaskOperationIntent({
    texts: ['你再试一次'],
    retryOnlyTurnDetected: true,
    configRepairTurnDetected: false,
    progressFollowupTurnDetected: false,
  })

  assert.equal(intent.kind, 'continue_existing')
})
