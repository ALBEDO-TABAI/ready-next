import assert from 'node:assert/strict'
import test from 'node:test'

import { decideDynamicDelivery } from '../main/modules/agent-control/runtime-core/dynamic-delivery/collaboration-policy'
import { buildDeliveryPreflightFacts } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-preflight'

function makeFacts(overrides: Record<string, unknown> = {}) {
  return buildDeliveryPreflightFacts({
    mode: 'adaptive',
    taskType: 'research',
    intentDomains: ['research'],
    structuredTargetIds: ['resource:a'],
    groundedWorkerResourceCount: 0,
    contextRefIds: ['resource:a'],
    selectedSkillId: null,
    risk: 'ordinary',
    profiles: [{ agentId: 'analyst', name: 'Analyst', collaborationReady: true }],
    hostCriteria: [{ id: 'c1', kind: 'response_digest', source: 'template', text: '回答目标问题' }],
    budget: {
      totalRunTokenLimit: 72000,
      ownerReservedTokens: 36000,
      remainingTokens: 72000,
      remainingWallClockMs: 120000,
    },
    ...overrides,
  })
}

test('standard and simple tasks stay on the single path', () => {
  assert.equal(decideDynamicDelivery(makeFacts({ mode: 'standard' })), 'single_path')
  assert.equal(decideDynamicDelivery(makeFacts({
    taskType: 'direct_answer',
    intentDomains: [],
    structuredTargetIds: ['answer'],
    contextRefIds: [],
  })), 'single_path')
})

test('unknown facts and exclusive risks fail closed to the single path', () => {
  assert.equal(decideDynamicDelivery(makeFacts({
    contextRefIds: null,
  })), 'single_path')
  for (const risk of ['awaiting_confirmation', 'exclusive_action', 'resource_conflict'] as const) {
    assert.equal(decideDynamicDelivery(makeFacts({ risk })), 'single_path', risk)
  }
})

test('research support requires explicit readable source bodies before Owner execution', () => {
  assert.equal(decideDynamicDelivery(makeFacts()), 'verify_only')
  assert.equal(decideDynamicDelivery(makeFacts({
    structuredTargetIds: ['resource:a', 'resource:b'],
    contextRefIds: ['resource:a', 'resource:b'],
  })), 'verify_only')
  assert.equal(decideDynamicDelivery(makeFacts({
    structuredTargetIds: ['resource:a', 'resource:b'],
    contextRefIds: ['resource:a', 'resource:b'],
    groundedWorkerResourceCount: 2,
  })), 'support_and_verify')
  assert.equal(decideDynamicDelivery(makeFacts({
    taskType: 'multi_step_task',
    intentDomains: ['research', 'document'],
    mode: 'thorough',
    groundedWorkerResourceCount: 0,
  })), 'verify_only', 'cross-domain research cannot bypass the grounded-source gate')
})

test('thorough mode relaxes the target threshold but never invents ungrounded research support', () => {
  assert.equal(decideDynamicDelivery(makeFacts({ mode: 'thorough' })), 'verify_only')
  assert.equal(decideDynamicDelivery(makeFacts({
    mode: 'thorough',
    groundedWorkerResourceCount: 1,
  })), 'support_and_verify')
  assert.equal(decideDynamicDelivery(makeFacts({
    mode: 'thorough',
    taskType: 'short_task',
  })), 'single_path', 'thorough never overrides the atomic-task boundary')
  assert.equal(decideDynamicDelivery(makeFacts({
    mode: 'thorough',
    risk: 'exclusive_action',
  })), 'single_path', 'thorough never overrides safety boundaries')
})

test('multiple targets without a collaboration-ready participant do not manufacture support', () => {
  assert.equal(decideDynamicDelivery(makeFacts({
    structuredTargetIds: ['resource:a', 'resource:b'],
    contextRefIds: ['resource:a', 'resource:b'],
    profiles: [{ agentId: 'analyst', name: 'Analyst', collaborationReady: false }],
  })), 'verify_only')
})
