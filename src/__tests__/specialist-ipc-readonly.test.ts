import assert from 'node:assert/strict'
import test from 'node:test'

import { _agentRegistryGroupChannelsForTest } from '../main/modules/claude-bridge/ipc/agent-registry-group'
import { _agentSpecialistBlueprintGroupChannelsForTest } from '../main/modules/claude-bridge/ipc/agent-specialist-blueprint-group'

test('specialist blueprint and registry IPC remain historical read APIs only', () => {
  assert.deepEqual(_agentSpecialistBlueprintGroupChannelsForTest, ['agent:specialistBlueprint:list'])
  assert.deepEqual(_agentRegistryGroupChannelsForTest, [
    'agent:registry:list',
    'agent:registry:listKnowledge',
  ])
  const all = [..._agentSpecialistBlueprintGroupChannelsForTest, ..._agentRegistryGroupChannelsForTest]
  for (const suffix of ['confirmCreate', 'upsertDraft', 'runAdmission', 'updateStatus', 'delete']) {
    assert.equal(all.some((channel) => channel.includes(suffix)), false)
  }
})
