import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { taskEventBridge } from '../main/modules/browser-engine/task-event-bridge'
import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { ScriptedAgentRunner } from './helpers/scripted-agent-runner'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('background-task-reminder-injection declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'background-task-reminder-injection transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
}

function inputForTurn(messages: unknown[], turnIndex: number): unknown {
  return messages.find((message) =>
    typeof message === 'object'
    && message !== null
    && (message as { turnIndex?: unknown }).turnIndex === turnIndex
    && Object.prototype.hasOwnProperty.call(message, 'input')
  )
}

describe('background task terminal reminder injection', () => {
  test('injects a terminal task summary into the next model input while the scope has an active run', async () => {
    let sawTerminalReminder = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我继续处理这个后台任务：',
        assertions: () => {
          taskEventBridge.publish({
            taskId: 'task-background-terminal-reminder-red',
            status: 'failed',
            extra: {
              scopeId: 'scope-background-terminal-reminder',
              summary: '批量保存完成 2/3',
              error: '最后 1 条保存失败：403 Forbidden',
            },
          })
        },
      },
      {
        turnIndex: 1,
        response: '已收到后台任务终态。',
        assertions: ({ messages }) => {
          const rawInput = JSON.stringify(inputForTurn(messages, 1))
          sawTerminalReminder =
            /后台任务/.test(rawInput)
            && /task-background-terminal-reminder-red/.test(rawInput)
            && /failed|失败/.test(rawInput)
            && /403 Forbidden/.test(rawInput)
        },
      },
    ])
    const runtime = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-background-terminal-reminder', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-background-terminal-reminder',
      '请继续处理后台任务',
      'run-background-terminal-reminder',
      {
        publicSessionId: 'scope-background-terminal-reminder',
        taskId: 'foreground-task-background-terminal-reminder',
      },
    )

    assert.equal(result.success, true)
    assert.equal(sawTerminalReminder, true)
  })
})
