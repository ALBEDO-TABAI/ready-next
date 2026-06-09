import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AbortInitiator } from '../main/modules/agent-control/contracts/run-contracts-internal'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('abort-initiator-threading declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'abort-initiator-threading transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

type TestRunHandle = {
  runId: string
  abortInitiator: AbortInitiator | null
  abortController: AbortController | null
}

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
}

function currentRunHandle(runtime: AgentSdkRuntime, name: string): TestRunHandle | null {
  const sessions = (runtime as unknown as {
    sessions: Map<string, { currentRun: TestRunHandle | null }>
  }).sessions
  return sessions.get(name)?.currentRun || null
}

const abortInitiatorValues: AbortInitiator[] = [
  'user_stop',
  'preempted',
  'timeout',
  'host_unavailable',
  'budget',
  'error',
  'process_exit',
]

test('AbortInitiator contract includes current and reserved initiators', () => {
  assert.ok(abortInitiatorValues.includes('user_stop'))
  assert.ok(abortInitiatorValues.includes('preempted'))
})

test('stopGeneration records user_stop on the active run handle before aborting', async () => {
  const name = 'butler::scope-abort-user-stop'
  let signalReadyResolve!: () => void
  const signalReady = new Promise<void>((resolve) => {
    signalReadyResolve = resolve
  })
  let initiatorAtAbort: AbortInitiator | null | undefined
  let runtime!: AgentSdkRuntime
  runtime = createRuntime({
    runAgent: ({ signal }) => {
      signalReadyResolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          initiatorAtAbort = currentRunHandle(runtime, name)?.abortInitiator
          const error = new Error('cancelled_user')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
  })
  runtime.newSession(name, 'system prompt')

  const pending = runtime.sendMessage(name, 'first run', 'run-user-stop', {
    publicSessionId: 'scope-abort-user-stop',
    taskId: 'task-user-stop',
  })
  await signalReady
  assert.equal(currentRunHandle(runtime, name)?.abortInitiator, null)

  runtime.stopGeneration(name)
  const result = await pending

  assert.equal(result.cancelled, true)
  assert.equal(initiatorAtAbort, 'user_stop')
})

test('takeover preemption records preempted on the old run handle before aborting', async () => {
  const name = 'butler::scope-abort-preempt'
  let firstSignalReadyResolve!: () => void
  const firstSignalReady = new Promise<void>((resolve) => {
    firstSignalReadyResolve = resolve
  })
  let initiatorAtAbort: AbortInitiator | null | undefined
  let runtime!: AgentSdkRuntime
  const runAgentQueue: NonNullable<AgentSdkRuntimeDeps['runAgent']>[] = [
    ({ signal }) => {
      firstSignalReadyResolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          initiatorAtAbort = currentRunHandle(runtime, name)?.abortInitiator
          const error = new Error('process_restarted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    async () => ({ finalText: 'second run complete' }),
  ]
  runtime = createRuntime({
    runAgent: (params) => {
      const next = runAgentQueue.shift()
      assert.ok(next)
      return next(params)
    },
  })
  runtime.newSession(name, 'system prompt')

  const first = runtime.sendMessage(name, 'first run', 'run-preempt-old', {
    publicSessionId: 'scope-abort-preempt',
    taskId: 'task-preempt-old',
  })
  await firstSignalReady
  assert.equal(currentRunHandle(runtime, name)?.abortInitiator, null)

  const second = await runtime.sendMessage(name, 'second run', 'run-preempt-new', {
    publicSessionId: 'scope-abort-preempt',
    taskId: 'task-preempt-new',
  })
  const firstResult = await first

  assert.equal(initiatorAtAbort, 'preempted')
  assert.equal(firstResult.cancelled, true)
  assert.equal(second.success, true)
  assert.equal(second.finalText, 'second run complete')
})
