import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent-sdk-budget-runtime declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-budget-runtime transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function createResearchTool(): ToolDefinition {
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
    description: 'Search test source',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    ...deps,
  })
}

test('Agent SDK runtime uses live task budget runtime for maxTurns and tool-call usage', async () => {
  let seenMaxTurns = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () => createToolExecutionOutput('search result', {
      shape: 'json',
      data: { ok: true },
    }),
    runAgent: async ({ tools, maxTurns, onTextDelta }) => {
      seenMaxTurns = maxTurns
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'budget proof' }))
      onTextDelta('done')
      return { finalText: 'done' }
    },
  })
  runtime.newSession('butler::scope-sdk-budget-runtime', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-budget-runtime',
    'research budget proof',
    'run-sdk-budget-runtime',
    {
      publicSessionId: 'scope-sdk-budget-runtime',
      taskId: 'task-sdk-budget-runtime',
      taskBudgetRuntime: createTaskBudgetRuntime('research'),
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'research')
  assert.equal(seenMaxTurns, 75)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.taskType, 'research')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 1)
  assert.equal(result.executionDiagnostics?.budget?.toolCallsUsed, 1)
  assert.equal(result.executionDiagnostics?.budgetUsagePercent, 2)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'none')
})

test('Agent SDK runtime surfaces exhausted budget warning after recorded tool results', async () => {
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () => createToolExecutionOutput('search result', {
      shape: 'json',
      data: { ok: true },
    }),
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
      await sdkTool.invoke({}, JSON.stringify({ query: 'two' }))
      onTextDelta('done')
      return { finalText: 'done' }
    },
  })
  runtime.newSession('butler::scope-sdk-budget-exhausted', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-budget-exhausted',
    'research budget exhausted proof',
    'run-sdk-budget-exhausted',
    {
      publicSessionId: 'scope-sdk-budget-exhausted',
      taskId: 'task-sdk-budget-exhausted',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 2,
          maxToolCalls: 2,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0,
        },
      }),
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
  assert.equal(result.executionDiagnostics?.budgetUsagePercent, 100)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'exhausted')
  const continuation = result.projectionTruth?.projectionPatch?.taskContinuation as {
    outputDir?: string
    runStatePath?: string
  } | undefined
  assert.ok(continuation?.outputDir)
  assert.ok(continuation?.runStatePath)
  const state = JSON.parse(await readFile(continuation.runStatePath, 'utf8')) as {
    taskId?: string
    terminalReason?: string
    budgetRuntime?: { usage?: { toolCallsUsed?: number } }
    sessionSnapshot?: unknown[]
    requiredCapabilityGroups?: string[]
    requiredToolNames?: string[]
  }
  assert.equal(state.taskId, 'task-sdk-budget-exhausted')
  assert.equal(state.terminalReason, 'checkpoint_budget')
  assert.equal(state.budgetRuntime?.usage?.toolCallsUsed, 2)
  assert.ok(Array.isArray(state.sessionSnapshot))
  assert.deepEqual(state.requiredCapabilityGroups, ['general_research'])
  assert.deepEqual(state.requiredToolNames, ['web_search'])
})

test('Agent SDK runtime injects budget warning steering into the next tool result', async () => {
  const returnedToolResults: string[] = []
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () => createToolExecutionOutput('search result', {
      shape: 'json',
      data: { ok: true },
    }),
    runAgent: async ({ tools }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'one' })))
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'two' })))
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'three' })))
      return { finalText: 'done' }
    },
  })
  runtime.newSession('butler::scope-sdk-budget-warning', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-budget-warning',
    'research warning proof',
    'run-sdk-budget-warning',
    {
      publicSessionId: 'scope-sdk-budget-warning',
      taskId: 'task-sdk-budget-warning',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 4,
          maxToolCalls: 4,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0,
        },
      }),
    },
  )

  assert.equal(result.success, true)
  assert.match(returnedToolResults[2] || '', /预算提醒/)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'warning')
})

test('Agent SDK budget continuation restores checkpoint session snapshot and unfreezes budget runtime', async () => {
  let continuationRef: { outputDir?: string; runStatePath?: string } | undefined
  {
    const runtime = createRuntime({
      listToolDefinitions: () => [createResearchTool()],
      executeToolCall: async () => createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true },
      }),
      runAgent: async ({ tools }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
        await sdkTool.invoke({}, JSON.stringify({ query: 'two' }))
        return { finalText: 'done' }
      },
    })
    runtime.newSession('butler::scope-sdk-budget-continue', 'system prompt')
    const checkpoint = await runtime.sendMessage(
      'butler::scope-sdk-budget-continue',
      'first budget run',
      'run-sdk-budget-continue-1',
      {
        publicSessionId: 'scope-sdk-budget-continue',
        taskId: 'task-sdk-budget-continue',
        taskBudgetRuntime: createTaskBudgetRuntime('research', {
          budget: {
            maxIterations: 2,
            maxToolCalls: 2,
            maxParallelToolGroups: 5,
            reservedToolCalls: 0,
          },
        }),
      },
    )
    continuationRef = checkpoint.projectionTruth?.projectionPatch?.taskContinuation as typeof continuationRef
  }

  assert.ok(continuationRef?.runStatePath)
  const state = JSON.parse(await readFile(continuationRef.runStatePath, 'utf8')) as Record<string, unknown>
  state.sessionSnapshot = [{ role: 'user', content: 'CHECKPOINT_MARKER' }]
  state.budgetRuntime = {
    ...(state.budgetRuntime as Record<string, unknown>),
    frozen: true,
  }
  await writeFile(continuationRef.runStatePath, JSON.stringify(state, null, 2), 'utf8')

  let restoredItemsText = ''
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    runAgent: async ({ session }) => {
      restoredItemsText = JSON.stringify(await session.getItems())
      return { finalText: 'continued' }
    },
  })
  runtime.newSession('butler::scope-sdk-budget-continue', 'system prompt')

  const continued = await runtime.sendMessage(
    'butler::scope-sdk-budget-continue',
    '继续',
    'run-sdk-budget-continue-2',
    {
      publicSessionId: 'scope-sdk-budget-continue',
      taskId: 'task-sdk-budget-continue',
      continuationIntent: {
        taskId: 'task-sdk-budget-continue',
        outputDir: continuationRef.outputDir,
        runStatePath: continuationRef.runStatePath,
      },
    },
  )

  assert.equal(continued.success, true)
  assert.match(restoredItemsText, /CHECKPOINT_MARKER/)
  assert.equal(continued.executionDiagnostics?.taskBudgetRuntime?.frozen, false)
  assert.equal(continued.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
})

test('Agent SDK budget continuation collapses concurrent continues for the same checkpoint', async () => {
  let continuationRef: { outputDir?: string; runStatePath?: string } | undefined
  {
    const runtime = createRuntime({
      listToolDefinitions: () => [createResearchTool()],
      executeToolCall: async () => createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true },
      }),
      runAgent: async ({ tools }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
        return { finalText: 'checkpoint' }
      },
    })
    runtime.newSession('butler::scope-sdk-budget-single-flight', 'system prompt')
    const checkpoint = await runtime.sendMessage(
      'butler::scope-sdk-budget-single-flight',
      'first budget run',
      'run-sdk-budget-single-flight-1',
      {
        publicSessionId: 'scope-sdk-budget-single-flight',
        taskId: 'task-sdk-budget-single-flight',
        taskBudgetRuntime: createTaskBudgetRuntime('research', {
          budget: {
            maxIterations: 1,
            maxToolCalls: 1,
            maxParallelToolGroups: 5,
            reservedToolCalls: 0,
          },
        }),
      },
    )
    continuationRef = checkpoint.projectionTruth?.projectionPatch?.taskContinuation as typeof continuationRef
  }

  assert.ok(continuationRef?.runStatePath)
  let resumeRuns = 0
  let releaseResume!: () => void
  let markResumeStarted!: () => void
  const resumeStarted = new Promise<void>((resolve) => { markResumeStarted = resolve })
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    runAgent: async () => {
      resumeRuns += 1
      markResumeStarted()
      await new Promise<void>((release) => { releaseResume = release })
      return { finalText: 'continued' }
    },
  })
  runtime.newSession('butler::scope-sdk-budget-single-flight', 'system prompt')
  const continuationIntent = {
    taskId: 'task-sdk-budget-single-flight',
    outputDir: continuationRef.outputDir,
    runStatePath: continuationRef.runStatePath,
  }
  const first = runtime.sendMessage(
    'butler::scope-sdk-budget-single-flight',
    '继续',
    'run-sdk-budget-single-flight-2',
    {
      publicSessionId: 'scope-sdk-budget-single-flight',
      taskId: 'task-sdk-budget-single-flight',
      continuationIntent,
    },
  )

  await resumeStarted
  const second = await runtime.sendMessage(
    'butler::scope-sdk-budget-single-flight',
    '继续',
    'run-sdk-budget-single-flight-3',
    {
      publicSessionId: 'scope-sdk-budget-single-flight',
      taskId: 'task-sdk-budget-single-flight',
      continuationIntent,
    },
  )
  releaseResume()
  const firstResult = await first
  assert.equal(resumeRuns, 1)
  assert.equal(second.success, true)
  assert.equal(second.terminalReason, 'checkpoint_budget')
  assert.match(second.finalText, /已经在继续执行/)
  assert.equal(firstResult.success, true)
})
