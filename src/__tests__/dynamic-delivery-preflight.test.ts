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

test('one semantic target verifies while multiple targets with a ready participant use support', () => {
  assert.equal(decideDynamicDelivery(makeFacts()), 'verify_only')
  assert.equal(decideDynamicDelivery(makeFacts({
    structuredTargetIds: ['resource:a', 'resource:b'],
    contextRefIds: ['resource:a', 'resource:b'],
  })), 'support_and_verify')
})

test('multiple targets without a collaboration-ready participant do not manufacture support', () => {
  assert.equal(decideDynamicDelivery(makeFacts({
    structuredTargetIds: ['resource:a', 'resource:b'],
    contextRefIds: ['resource:a', 'resource:b'],
    profiles: [{ agentId: 'analyst', name: 'Analyst', collaborationReady: false }],
  })), 'verify_only')
})
