import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentExecutionProfileResolver } from '../main/modules/agent-control/agents/agent-execution-profile'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

function makeResolver(record: AgentRegistryRecord | null) {
  return new AgentExecutionProfileResolver({
    registry: { get: (id) => id === 'butler' ? record : null },
  })
}

const ready: AgentRegistryRecord = {
  id: 'butler',
  name: 'Ready',
  charter: '主助手',
  personaRef: 'butler',
  status: 'active',
  parentAgentId: null,
  derivationReason: null,
  mergedIntoAgentId: null,
  createdAt: 'now',
}

test('only Ready is conversation-ready and collaboration routing stays retired', () => {
  const resolver = makeResolver(ready)

  assert.deepEqual(resolver.resolveReadiness('butler'), {
    conversationReady: true,
    handoffReady: false,
    autoRoutable: false,
    collaborationReady: false,
    reasons: [],
  })
  assert.deepEqual(resolver.resolveReadiness('analyst'), {
    conversationReady: false,
    handoffReady: false,
    autoRoutable: false,
    collaborationReady: false,
    reasons: ['agent_unavailable'],
  })
})

test('missing or inactive Ready identity fails closed', () => {
  assert.deepEqual(makeResolver(null).resolveReadiness('butler').reasons, ['agent_unavailable'])
  assert.deepEqual(
    makeResolver({ ...ready, status: 'disabled' }).resolveReadiness('butler').reasons,
    ['agent_inactive'],
  )
})
