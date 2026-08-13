import assert from 'node:assert/strict'
import test from 'node:test'

import { _agentSystemStudioGroupChannelsForTest } from '../main/modules/claude-bridge/ipc/agent-system-studio-group'

test('historical Studio has no preroute simulation channel', () => {
  assert.deepEqual(_agentSystemStudioGroupChannelsForTest, [
    'agent:systemStudio:getSnapshot',
    'agent:systemStudio:stageContentEdit',
    'agent:systemStudio:confirmContentEdit',
    'agent:systemStudio:rejectContentEdit',
  ])
  assert.equal(_agentSystemStudioGroupChannelsForTest.includes('agent:systemStudio:simulateRouting'), false)
})
