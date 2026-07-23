import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDeliveryDeadlineTerminalText } from '../main/modules/agent-control/runtime-core/tool-timeout-user-message'
import { createAgentSdkToolExecutionLifecycle } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-execution-lifecycle'
import type { AgentSdkPreparedTurnState } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-execution-types'
import type { DynamicDeliveryDeadlineHandle } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-deadline'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

test('deadline closeout names the interrupted setup command and hides secret values', () => {
  const text = buildDeliveryDeadlineTerminalText({
    toolName: 'run_setup_command',
    args: {
      command: 'lark-cli',
      args: ['config', 'init', '--app-secret', 'super-secret', '--new'],
    },
    startedAtMs: 10_000,
    expectedTimeoutMs: 180_000,
  }, 190_000)

  assert.match(text, /lark-cli config init/)
  assert.match(text, /180 秒执行上限/)
  assert.match(text, /不能视为已经成功/)
  assert.doesNotMatch(text, /super-secret/)
})

test('tool lifecycle preserves the interrupted tool snapshot on delivery abort', () => {
  const abortController = new AbortController()
  const state = { interruptedToolExecution: null } as AgentSdkPreparedTurnState
  const deadline: DynamicDeliveryDeadlineHandle = {
    noteProgress: () => {},
    beginToolExecution: () => 'deadline-token',
    endToolExecution: () => {},
    suspend: () => {},
    resume: () => {},
    dispose: () => {},
  }
  const lifecycle = createAgentSdkToolExecutionLifecycle({
    runId: 'run-1',
    abortController,
    deliveryDeadline: deadline,
    state,
  })
  const definition = {
    name: 'run_setup_command',
    executionTimeoutMs: 600_000,
  } as ToolDefinition
  const token = lifecycle.beginToolExecution?.(definition, {
    command: 'lark-cli',
    args: ['config', 'init', '--new'],
  }) || ''
  abortController.abort(new Error('delivery_wall_clock_exceeded'))
  lifecycle.endToolExecution?.(token, new Error('setup command aborted by user'))

  assert.equal(state.interruptedToolExecution?.toolName, 'run_setup_command')
  assert.equal(state.interruptedToolExecution?.expectedTimeoutMs, 600_000)
})
