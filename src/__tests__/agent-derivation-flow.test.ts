import assert from 'node:assert/strict'
import test from 'node:test'

import { _agentRegistryGroupChannelsForTest } from '../main/modules/claude-bridge/ipc/agent-registry-group'
import { _agentSpecialistBlueprintGroupChannelsForTest } from '../main/modules/claude-bridge/ipc/agent-specialist-blueprint-group'

test('legacy derivation and creation channels are absent from the retained audit groups', () => {
  const channels = [..._agentRegistryGroupChannelsForTest, ..._agentSpecialistBlueprintGroupChannelsForTest]
  assert.deepEqual(channels, [
    'agent:registry:list',
    'agent:registry:listKnowledge',
    'agent:specialistBlueprint:list',
  ])
  assert.equal(channels.some((channel) => channel.startsWith('agent:derivation:')), false)
  assert.equal(channels.some((channel) => /confirm|create|update|delete/i.test(channel)), false)
})
