import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { canonicalCoreCloseoutTestPort } from './helpers/canonical-core-closeout-test-port'
import { enabledSdkTools } from './utils/sdk-tool-visibility'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

const config = {
  provider: 'openai-compatible',
  baseUrl: 'https://example.com/v1/messages',
  apiKey: 'test-key',
  model: 'test-model',
} as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function createRunMetaLedger(readCurrentEpoch: () => number) {
  const rows = new Map<string, Record<string, unknown>>()
  let acceptedUpdates = 0
  return {
    rows,
    acceptedUpdates: () => acceptedUpdates,
    repository: {
      get(runId: string) {
        return rows.get(runId) ?? null
      },
      create(input: Record<string, unknown>) {
        const record = { ...input }
        rows.set(String(input.runId), record)
        return record
      },
      update(runId: string, patch: Record<string, unknown>) {
        const existing = rows.get(runId)
        if (!existing || existing.messageVisibilityEpoch !== readCurrentEpoch()) return null
        acceptedUpdates += 1
        const record = { ...existing, ...patch, runId }
        rows.set(runId, record)
        return record
      },
    },
  }
}

function createDeferredToolDefinition(): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Test deferred web search',
    schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'text',
  }
}

test('SDK deferred provider return cannot publish or persist after reset', async () => {
  let currentEpoch = 0
  let canonicalCommits = 0
  const providerEntered = deferred<void>()
  const releaseProvider = deferred<void>()
  const ledger = createRunMetaLedger(() => currentEpoch)
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ onTextDelta }) => {
      providerEntered.resolve()
      await releaseProvider.promise
      onTextDelta('reset-stale-provider-text')
      return { finalText: 'reset-stale-provider-text' }
    },
  })
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(() => { canonicalCommits += 1 }),
    getRunMetaRepository: () => ledger.repository,
    getConversationScope: () => ({ messageVisibilityEpoch: currentEpoch }),
    publishScopeRunEvent: () => undefined,
  } as never)
  const outputs: Array<Record<string, unknown>> = []
  const statuses: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []
  runtime.on('output', (event) => outputs.push(event))
  runtime.on('status', (event) => statuses.push(event))
  runtime.on('error', (event) => errors.push(event))

  const internalName = 'butler::scope-sdk-reset'
  runtime.newSession(internalName, 'system prompt')
  const pending = runtime.sendMessage(internalName, 'hello', 'run-sdk-reset', {
    publicSessionId: 'scope-sdk-reset',
    messageVisibilityEpoch: 0,
    taskId: 'task-sdk-reset',
  })
  await providerEntered.promise

  currentEpoch = 1
  runtime.resetSessionContext(internalName, 'scope-sdk-reset', 1)
  const eventCountsAtReset = [outputs.length, statuses.length, errors.length]
  const acceptedUpdatesAtReset = ledger.acceptedUpdates()
  releaseProvider.resolve()
  const result = await pending

  assert.equal(result.cancelled, true)
  assert.deepEqual([outputs.length, statuses.length, errors.length], eventCountsAtReset)
  assert.equal(ledger.acceptedUpdates(), acceptedUpdatesAtReset)
  assert.equal(canonicalCommits, 0)
  assert.equal(ledger.rows.get('run-sdk-reset')?.status, 'running')
})

test('SDK same-epoch stop still commits its cancellation while provider text stays suppressed', async () => {
  const currentEpoch = 0
  const providerEntered = deferred<void>()
  const releaseProvider = deferred<void>()
  const ledger = createRunMetaLedger(() => currentEpoch)
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ onTextDelta }) => {
      providerEntered.resolve()
      await releaseProvider.promise
      onTextDelta('stopped-provider-text')
      return { finalText: 'stopped-provider-text' }
    },
  })
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(),
    getRunMetaRepository: () => ledger.repository,
    getConversationScope: () => ({ messageVisibilityEpoch: currentEpoch }),
    publishScopeRunEvent: () => undefined,
  } as never)
  const outputs: Array<Record<string, unknown>> = []
  const statuses: Array<Record<string, unknown>> = []
  runtime.on('output', (event) => outputs.push(event))
  runtime.on('status', (event) => statuses.push(event))
  runtime.on('error', () => undefined)

  const internalName = 'butler::scope-sdk-stop'
  runtime.newSession(internalName, 'system prompt')
  const pending = runtime.sendMessage(internalName, 'hello', 'run-sdk-stop', {
    publicSessionId: 'scope-sdk-stop',
    messageVisibilityEpoch: 0,
    taskId: 'task-sdk-stop',
  })
  await providerEntered.promise
  runtime.stopGeneration(internalName, 'user_stop')
  releaseProvider.resolve()
  const result = await pending

  assert.equal(result.cancelled, true)
  assert.ok(ledger.acceptedUpdates() > 0)
  assert.equal(ledger.rows.get('run-sdk-stop')?.status, 'cancelled')
  assert.equal(outputs.some((event) => event.chunk === 'stopped-provider-text'), false)
  assert.ok(statuses.some((event) => event.status === 'cancelled'))
})

test('SDK same-epoch stop suppresses a deferred tool result while publishing one cancellation terminal', async () => {
  const currentEpoch = 0
  const toolEntered = deferred<void>()
  const releaseTool = deferred<void>()
  const ledger = createRunMetaLedger(() => currentEpoch)
  const toolDefinition = createDeferredToolDefinition()
  const scopeEvents: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [toolDefinition],
    executeToolCall: async () => {
      toolEntered.resolve()
      await releaseTool.promise
      return createToolExecutionOutput('late result')
    },
    runAgent: async ({ tools }) => {
      const enabledTools = await enabledSdkTools(tools)
      const sdkTool = enabledTools.find((candidate) => candidate.name === toolDefinition.name) as {
        invoke: (context: unknown, input: string) => Promise<string>
      } | undefined
      assert.ok(sdkTool)
      await sdkTool.invoke({}, JSON.stringify({ query: 'deferred result' }))
      return { finalText: 'tool finished' }
    },
  })
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(),
    getRunMetaRepository: () => ledger.repository,
    getConversationScope: () => ({ messageVisibilityEpoch: currentEpoch }),
    publishScopeRunEvent: (event: Record<string, unknown>) => { scopeEvents.push(event) },
  } as never)
  const statuses: Array<Record<string, unknown>> = []
  runtime.on('output', () => undefined)
  runtime.on('status', (event) => statuses.push(event))
  runtime.on('error', () => undefined)

  const internalName = 'butler::scope-sdk-tool-stop'
  runtime.newSession(internalName, 'system prompt')
  const pending = runtime.sendMessage(internalName, '查一下最新资料', 'run-sdk-tool-stop', {
    publicSessionId: 'scope-sdk-tool-stop',
    messageVisibilityEpoch: 0,
    taskId: 'task-sdk-tool-stop',
  })
  await toolEntered.promise
  const eventCountAtStop = scopeEvents.length
  runtime.stopGeneration(internalName, 'user_stop')
  releaseTool.resolve()
  const result = await pending

  const eventsAfterStop = scopeEvents.slice(eventCountAtStop)
  assert.equal(result.cancelled, true)
  assert.equal(ledger.rows.get('run-sdk-tool-stop')?.status, 'cancelled')
  assert.equal(
    scopeEvents.filter((event) =>
      (event.toolEvent as { kind?: string } | undefined)?.kind === 'call').length,
    1,
  )
  assert.equal(
    eventsAfterStop.some((event) =>
      event.phase === 'responding'
      || (event.toolEvent as { kind?: string } | undefined)?.kind === 'result'),
    false,
  )
  assert.equal(statuses.filter((event) => event.status === 'cancelled').length, 1)
})
