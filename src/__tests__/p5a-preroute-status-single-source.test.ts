import assert from 'node:assert/strict'
import test from 'node:test'

import { hasContinuableTaskRef } from '../shared/agent-followup-intent'
import { SKILL_CHILD_RUN_OPEN_STATUSES } from '../shared/skill-child-run-status'
import {
  decideSessionPreroute,
  type PrerouteOwnedTaskRef,
} from '../main/modules/agent-control/agents/session-preroute'
import { buildSessionPrerouteTrace } from '../main/modules/agent-control/agents/session-preroute-trace'
import { isOpenTaskStatus, OPEN_TASK_STATUSES } from '../main/modules/agent-control/contracts/task-open-status'

const task = (overrides: Partial<PrerouteOwnedTaskRef> = {}): PrerouteOwnedTaskRef => ({
  taskId: 'task-queued',
  status: 'queued',
  interactionState: null,
  summary: '继续做素材整理',
  nextAction: null,
  blockerCategory: null,
  ownerAgentId: 'writer',
  ...overrides,
})

const base = {
  routingCards: [],
  isAgentActive: (agentId: string) => agentId === 'writer',
  mode: 'suggest' as const,
}

test('P5a open task status source is derived from child-run statuses', () => {
  assert.deepEqual(OPEN_TASK_STATUSES, SKILL_CHILD_RUN_OPEN_STATUSES)
  assert.deepEqual([...OPEN_TASK_STATUSES], [
    'queued',
    'running',
    'recoverable_paused',
    'budget_paused',
    'blocked',
  ])
  assert.equal(isOpenTaskStatus('queued'), true)
  assert.equal(isOpenTaskStatus('completed'), false)
  assert.equal(isOpenTaskStatus('active'), false)
})

test('queued owned task can trigger state-tier preroute for continuation and status requests', () => {
  for (const firstMessage of ['继续', '怎么样了？']) {
    const result = decideSessionPreroute({
      ...base,
      firstMessage,
      recentOwnedTasks: [task()],
    })
    assert.equal(result.decision.tier, 'state')
    assert.equal(result.decision.targetAgentId, 'writer')
    assert.equal(result.effect, 'suggest')
  }
})

test('terminal task statuses do not count as continuable or open', () => {
  const completed = task({ status: 'completed' })
  assert.equal(hasContinuableTaskRef([completed]), false)

  const result = decideSessionPreroute({
    ...base,
    firstMessage: '继续',
    recentOwnedTasks: [completed],
  })
  assert.equal(result.decision.tier, 'fallback')
  assert.equal(result.effect, 'none')
})

test('preroute trace uses the same queued-task source for inactive owner reasons', () => {
  const queuedInactiveOwner = task({ ownerAgentId: 'retired-writer' })
  const result = decideSessionPreroute({
    ...base,
    firstMessage: '继续',
    recentOwnedTasks: [queuedInactiveOwner],
    isAgentActive: () => false,
  })
  const trace = buildSessionPrerouteTrace({
    id: 'p5a-trace',
    now: new Date('2026-06-20T00:00:00.000Z'),
    firstMessage: '继续',
    mode: 'suggest',
    result,
    recentOwnedTasks: [queuedInactiveOwner],
    routingInventory: [],
    isAgentActive: () => false,
  })
  assert.equal(result.decision.tier, 'fallback')
  assert.ok(trace.reasons.includes('state_owner_inactive'))
})

test('off mode returns explicit fallback none without considering hits', () => {
  const result = decideSessionPreroute({
    ...base,
    mode: 'off',
    firstMessage: '继续写作',
    recentOwnedTasks: [task()],
    routingCards: [{ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['写作'] }],
  })
  assert.equal(result.effect, 'none')
  assert.equal(result.decision.tier, 'fallback')
  assert.equal(result.decision.targetAgentId, 'butler')
  assert.equal(result.decision.reason, 'routing_off')
})
