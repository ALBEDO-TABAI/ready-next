import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentExecutionProfileResolver } from '../main/modules/agent-control/agents/agent-execution-profile'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

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

function resolver() {
  const rows = new Map<string, AgentRegistryRecord>([
    ['butler', ready],
    ['analyst', { ...ready, id: 'analyst', name: '历史专项 Agent', personaRef: 'analyst' }],
  ])
  return new AgentExecutionProfileResolver({
    registry: { get: (id) => rows.get(id) ?? null },
  })
}

test('all execution requests resolve to the single Ready identity', async () => {
  const direct = await resolver().resolve('butler')
  const formerSpecialist = await resolver().resolve('analyst')

  assert.equal(direct.requestedAgentId, 'butler')
  assert.equal(direct.effectiveAgentId, 'butler')
  assert.equal(formerSpecialist.requestedAgentId, 'butler')
  assert.equal(formerSpecialist.effectiveAgentId, 'butler')
  assert.equal(formerSpecialist.name, 'Ready')
  assert.equal(formerSpecialist.personaRef, 'ready-neutral')
  assert.equal(formerSpecialist.personality, '')
  assert.equal(formerSpecialist.rules, '')
  assert.equal(formerSpecialist.knowledgeIndex, '')
  assert.deepEqual(formerSpecialist.allowedKnowledgeRefs, [])
  assert.deepEqual(formerSpecialist.redirectChain, [])
})

test('single Ready bindings cannot record a specialist owner selection', async () => {
  const profile = await resolver().resolve('analyst')
  const binding = resolver().createBinding({
    profile,
    runId: 'run-ready',
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'initial',
    ownerAssignmentSource: 'conversation_active',
  })

  assert.equal(binding.requestedAgentId, 'butler')
  assert.equal(binding.effectiveAgentId, 'butler')
  assert.equal(binding.resolutionKind, 'direct')
})
