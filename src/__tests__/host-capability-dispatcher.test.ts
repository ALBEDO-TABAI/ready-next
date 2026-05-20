import assert from 'node:assert/strict'
import test from 'node:test'

import { HostCapabilityDispatcher } from '../main/modules/agent-control/domain-adapters/host-capability-dispatcher'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

test('dispatcher executes openclaw as a host-only shortcut outside the normal tool loop', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const dispatcher = new HostCapabilityDispatcher({
    executeHostTool: async (toolName, args) => {
      calls.push({ name: toolName, args })
      return createToolExecutionOutput('配对已批准')
    },
  })

  const result = await dispatcher.dispatch({
    decision: {
      kind: 'openclaw',
      reason: 'pairing_command',
      command: 'openclaw pairing approve feishu 123456',
      authorizationSource: 'explicit_user_command',
    },
    toolContext: {
      allowedToolNames: ['system_run_openclaw'],
    },
  })

  assert.equal(result.handled, true)
  assert.equal(result.outputText, '配对已批准')
  assert.deepEqual(calls, [
    {
      name: 'system_run_openclaw',
      args: { command: 'openclaw pairing approve feishu 123456' },
    },
  ])
})

test('dispatcher refuses openclaw host shortcuts without explicit authorization source', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const dispatcher = new HostCapabilityDispatcher({
    executeHostTool: async (toolName, args) => {
      calls.push({ name: toolName, args })
      return createToolExecutionOutput('should not run')
    },
  })

  const result = await dispatcher.dispatch({
    decision: {
      kind: 'openclaw',
      reason: 'pairing_command',
      command: 'openclaw pairing approve feishu 123456',
      authorizationSource: 'none',
    },
    toolContext: {
      allowedToolNames: ['system_run_openclaw'],
    },
  })

  assert.equal(result.handled, false)
  assert.equal(result.outputText, null)
  assert.deepEqual(calls, [])
})
