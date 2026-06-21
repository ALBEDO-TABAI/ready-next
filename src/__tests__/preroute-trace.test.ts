import assert from 'node:assert/strict'
import test from 'node:test'

import { decideSessionPreroute, type PrerouteOwnedTaskRef } from '../main/modules/agent-control/agents/session-preroute'
import { buildSessionPrerouteTrace, pushSessionPrerouteTraceSafely, SessionPrerouteTraceRingBuffer } from '../main/modules/agent-control/agents/session-preroute-trace'
import type { AgentSystemStudioRoutingCard } from '../shared/agent-system-studio'

const NOW = new Date('2026-06-19T00:00:00.000Z')

function routingCard(overrides: Partial<AgentSystemStudioRoutingCard>): AgentSystemStudioRoutingCard {
  return {
    relPath: 'knowledge/routing-writer.md',
    title: '路由：写作',
    description: '写作请求',
    status: 'active',
    targetAgentId: 'writer',
    targetStatus: 'active',
    triggers: ['写作'],
    disabledReason: null,
    ...overrides,
  }
}

test('preroute trace records why no handoff happened without changing preroute result', () => {
  const inventory = [
    routingCard({ targetAgentId: 'draft', disabledReason: 'card_staged', status: 'staged', triggers: ['草稿'] }),
    routingCard({ targetAgentId: 'collector', disabledReason: 'missing_triggers', triggers: null }),
    routingCard({ targetAgentId: 'retired', disabledReason: 'target_inactive', targetStatus: 'retired', triggers: ['退休'] }),
  ]
  const result = decideSessionPreroute({
    firstMessage: '帮我看看日历',
    recentOwnedTasks: [],
    routingCards: [],
    isAgentActive: () => false,
    mode: 'suggest',
  })
  const trace = buildSessionPrerouteTrace({
    id: 'trace-1',
    now: NOW,
    firstMessage: '帮我看看日历',
    mode: 'suggest',
    result,
    recentOwnedTasks: [],
    routingInventory: inventory,
    isAgentActive: () => false,
  })
  assert.equal(result.effect, 'none')
  assert.deepEqual(trace.reasons, ['no_keyword_match', 'card_staged', 'missing_triggers', 'target_inactive'])
})

test('preroute trace records suggest-only and routing-off reasons', () => {
  const suggestResult = decideSessionPreroute({
    firstMessage: '写作大纲',
    recentOwnedTasks: [],
    routingCards: [{ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['写作'] }],
    isAgentActive: (agentId) => agentId === 'writer',
    mode: 'suggest',
  })
  const suggestTrace = buildSessionPrerouteTrace({
    id: 'trace-2',
    now: NOW,
    firstMessage: '写作大纲',
    mode: 'suggest',
    result: suggestResult,
    recentOwnedTasks: [],
    routingInventory: [routingCard({})],
    isAgentActive: (agentId) => agentId === 'writer',
  })
  assert.deepEqual(suggestTrace.reasons, ['suggest_only'])

  const offResult = decideSessionPreroute({
    firstMessage: '写作大纲',
    recentOwnedTasks: [],
    routingCards: [{ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['写作'] }],
    isAgentActive: (agentId) => agentId === 'writer',
    mode: 'off',
  })
  const offTrace = buildSessionPrerouteTrace({
    id: 'trace-3',
    now: NOW,
    firstMessage: '写作大纲',
    mode: 'off',
    result: offResult,
    recentOwnedTasks: [],
    routingInventory: [],
    isAgentActive: (agentId) => agentId === 'writer',
  })
  assert.deepEqual(offTrace.reasons, ['routing_off'])
})

test('preroute trace records inactive state owner and ring buffer keeps recent order', () => {
  const task: PrerouteOwnedTaskRef = {
    taskId: 'task-1',
    status: 'blocked',
    interactionState: null,
    summary: '旧任务',
    blockerCategory: null,
    ownerAgentId: 'retired-agent',
  }
  const result = decideSessionPreroute({
    firstMessage: '继续刚才的任务',
    recentOwnedTasks: [task],
    routingCards: [],
    isAgentActive: () => false,
    mode: 'suggest',
  })
  const trace = buildSessionPrerouteTrace({
    id: 'trace-4',
    now: NOW,
    firstMessage: '继续刚才的任务',
    mode: 'suggest',
    result,
    recentOwnedTasks: [task],
    routingInventory: [],
    isAgentActive: () => false,
  })
  assert.ok(trace.reasons.includes('state_owner_inactive'))

  const ring = new SessionPrerouteTraceRingBuffer(2)
  ring.push({ ...trace, id: 'old' })
  ring.push({ ...trace, id: 'middle' })
  ring.push({ ...trace, id: 'new' })
  assert.deepEqual(ring.listRecent(2).map((item) => item.id), ['new', 'middle'])
})

test('safe trace push swallows inventory failures after preroute computes a valid result', () => {
  const result = decideSessionPreroute({
    firstMessage: '写作大纲',
    recentOwnedTasks: [],
    routingCards: [{ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['写作'] }],
    isAgentActive: (agentId) => agentId === 'writer',
    mode: 'suggest',
  })
  const warnings: string[] = []
  let pushed = 0
  assert.doesNotThrow(() => {
    pushSessionPrerouteTraceSafely({
      sink: { push: () => { pushed += 1 } },
      id: 'trace-safe',
      now: NOW,
      firstMessage: '写作大纲',
      mode: 'suggest',
      result,
      recentOwnedTasks: [],
      getRoutingInventory: () => {
        throw new Error('inventory unavailable')
      },
      isAgentActive: (agentId) => agentId === 'writer',
      warn: (message) => warnings.push(message),
    })
  })
  assert.equal(result.effect, 'suggest')
  assert.equal(result.decision.tier, 'precedent')
  assert.equal(pushed, 0)
  assert.match(warnings.join('\n'), /session-preroute-trace/)
})
