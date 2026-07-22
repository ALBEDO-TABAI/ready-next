import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createInitiatorAbort } from '../main/modules/agent-control/runtime-core/agent-sdk-run-lifecycle'
import type { AbortInitiator } from '../main/modules/agent-control/contracts/run-contracts-internal'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canonicalCoreCloseoutTestPort } from './helpers/canonical-core-closeout-test-port'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'

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
  const session = (runtime as unknown as {
    sessionManager: { get: (name: string) => { currentRun: TestRunHandle | null } | undefined }
  }).sessionManager.get(name)
  return session?.currentRun || null
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

test('initiator aborts are recognizable AbortErrors even when the message is process_exit', () => {
  const handle = { abortInitiator: null } as Parameters<typeof createInitiatorAbort>[0]
  const error = createInitiatorAbort(handle, 'process_exit', 'process_exit')
  assert.equal(handle.abortInitiator, 'process_exit')
  assert.equal(error.name, 'AbortError')
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

test('a second ingress cannot implicitly preempt the active owner', async () => {
  const name = 'butler::scope-abort-preempt'
  let firstSignalReadyResolve!: () => void
  const firstSignalReady = new Promise<void>((resolve) => {
    firstSignalReadyResolve = resolve
  })
  let initiatorAtAbort: AbortInitiator | null | undefined
  let runtime!: AgentSdkRuntime
  runtime = createRuntime({
    runAgent: ({ signal }) => {
      firstSignalReadyResolve()
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
  assert.equal(currentRunHandle(runtime, name)?.runId, 'run-preempt-old')
  assert.equal(currentRunHandle(runtime, name)?.abortInitiator, null)
  assert.equal(second.success, false)
  assert.equal(second.terminalReason, 'blocked_external')

  runtime.stopGeneration(name)
  const firstResult = await first

  assert.equal(initiatorAtAbort, 'user_stop')
  assert.equal(firstResult.cancelled, true)
})

test('timeout abort closes through the finalizer with run_meta and run_close reason', async () => {
  const name = 'butler::scope-abort-timeout'
  let signalReadyResolve!: () => void
  const signalReady = new Promise<void>((resolve) => {
    signalReadyResolve = resolve
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const runtime = createRuntime({
      runAgent: ({ signal }) => {
        signalReadyResolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('main_no_progress_timeout')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    })
    runtime.setRuntime({
      ...canonicalCoreCloseoutTestPort((input) => {
        const next = {
          ...(runMeta.get(input.ownerRunId) ?? { runId: input.ownerRunId }),
          status: input.status,
          terminalReason: input.terminalReason,
          initiator: input.initiator,
          durationMs: input.durationMs,
        }
        runMeta.set(input.ownerRunId, next)
      }),
      getRunMetaRepository: () => ({
        get: (runId: string) => runMeta.get(runId) ?? null,
        create: (input: Record<string, unknown>) => {
          runMeta.set(String(input.runId), input)
          return input
        },
        update: (runId: string, patch: Record<string, unknown>) => {
          const next = { ...(runMeta.get(runId) ?? { runId }), ...patch }
          runMeta.set(runId, next)
          return next
        },
      }),
      getTaskProjection: () => null,
      getTaskProjectionStoreForFinalize: () => null,
    } as never)
    runtime.newSession(name, 'system prompt')

    const pending = runtime.sendMessage(name, 'first run', 'run-timeout', {
      publicSessionId: 'scope-abort-timeout',
      taskId: 'task-timeout',
    })
    await signalReady

    runtime.stopGeneration(name, 'timeout')
    const result = await pending

    assert.equal(result.cancelled, true)
    assert.equal(result.terminalReason, 'main_no_progress_timeout')
    assert.deepEqual(
      result.projectionTruth?.transcriptEvents
        .filter((event) => event.kind === 'status')
        .map((event) => [event.status, event.terminalReason]),
      [
        ['working', null],
        ['cancelled', 'main_no_progress_timeout'],
      ],
    )
    const meta = runMeta.get('run-timeout')
    assert.equal(meta?.status, 'cancelled')
    assert.equal(meta?.initiator, 'timeout')
    assert.equal(meta?.terminalReason, 'main_no_progress_timeout')

    const closeMetric = metrics.find((event) => event.metric === 'run_close' && event.runId === 'run-timeout')
    assert.equal(closeMetric?.initiator, 'timeout')
    assert.equal(closeMetric?.terminalReason, 'main_no_progress_timeout')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('delivery wall-clock abort is a delivery failure, not a user cancellation', async () => {
  const runtimeErrors: Array<{ errorKind?: string }> = []
  const runtime = createRuntime({
    runAgent: async () => {
      const error = new Error('delivery_wall_clock_exceeded')
      error.name = 'AbortError'
      throw error
    },
  })
  runtime.on('error', (event) => runtimeErrors.push(event))
  runtime.newSession('butler::scope-delivery-deadline', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-delivery-deadline',
    'research task',
    'run-delivery-deadline',
    {
      publicSessionId: 'scope-delivery-deadline',
      taskId: 'task-delivery-deadline',
      deliveryMode: 'standard',
    },
  )

  assert.equal(result.success, false)
  assert.equal(result.cancelled, false)
  assert.equal(result.terminalReason, 'delivery_failed')
  assert.equal(result.error, 'delivery_wall_clock_exceeded')
  assert.equal(runtimeErrors[0]?.errorKind, 'delivery_failed')
})

test('S0 R3: delivery deadline preserves a durable Browser task as a resumable checkpoint', async () => {
  const projection = {
    taskId: 'task-delivery-browser',
    scopeId: 'scope-delivery-browser',
    runId: 'run-delivery-browser',
    taskType: 'research',
    module: 'browser',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    resumableActions: ['continue', 'cancel'],
    requestAnchor: {
      messageId: 'message-delivery-browser',
      requestDigest: 'request-digest-delivery-browser',
    },
    continuationRef: {
      kind: 'browser_checkpoint',
      checkpointId: 'checkpoint-delivery-browser',
      browserTaskId: 'browser-task-delivery-browser',
    },
    checkpointRefs: {
      cleanBaseCheckpointId: 'clean-delivery-browser',
      suspensionCheckpointId: 'checkpoint-delivery-browser',
    },
  }
  const runtime = createRuntime({
    runAgent: async () => {
      const error = new Error('delivery_wall_clock_exceeded')
      error.name = 'AbortError'
      throw error
    },
  })
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(),
    getRunMetaRepository: () => null,
    getTaskProjection: () => projection,
    getTaskProjectionStore: () => ({
      get: () => projection,
      update: (_taskId: string, patch: Record<string, unknown>) => Object.assign(projection, patch),
    }),
    getTaskProjectionStoreForFinalize: () => ({
      get: () => projection,
      update: (_taskId: string, patch: Record<string, unknown>) => Object.assign(projection, patch),
    }),
  } as never)
  runtime.on('error', () => undefined)
  runtime.newSession('butler::scope-delivery-browser', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-delivery-browser',
    'complete all 18 browser research items',
    'run-delivery-browser',
    {
      publicSessionId: 'scope-delivery-browser',
      taskId: 'task-delivery-browser',
      deliveryMode: 'standard',
      taskBudgetRuntime: createTaskBudgetRuntime('research'),
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'blocked_tool_error')
  assert.equal(projection.taskId, 'task-delivery-browser')
  assert.equal(projection.continuationRef.browserTaskId, 'browser-task-delivery-browser')
})
