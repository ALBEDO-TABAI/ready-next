import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canonicalCoreCloseoutTestPort } from './helpers/canonical-core-closeout-test-port'

test('agent-sdk-budget-runtime declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-budget-runtime transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test'
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
        query: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    },
    executionVisibility: 'model',
    resultShape: 'json'
  }
}

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    ...deps
  })
}

test('Agent SDK runtime uses live task budget runtime for maxTurns and tool-call usage', async () => {
  let seenMaxTurns = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () =>
      createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true }
      }),
    runAgent: async ({ tools, maxTurns, onTextDelta }) => {
      seenMaxTurns = maxTurns
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'budget proof' }))
      onTextDelta('done')
      return { finalText: 'done' }
    }
  })
  runtime.newSession('butler::scope-sdk-budget-runtime', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-budget-runtime',
    'research budget proof',
    'run-sdk-budget-runtime',
    {
      publicSessionId: 'scope-sdk-budget-runtime',
      taskId: 'task-sdk-budget-runtime',
      taskBudgetRuntime: createTaskBudgetRuntime('research')
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.taskType, 'research')
  assert.equal(seenMaxTurns, 220)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.taskType, 'research')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 1)
  assert.equal(result.executionDiagnostics?.budget?.toolCallsUsed, 1)
  assert.equal(result.executionDiagnostics?.budgetUsagePercent, 0)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'none')
})

test('Agent SDK runtime surfaces exhausted budget warning after recorded tool results', async () => {
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () =>
      createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true }
      }),
    runAgent: async ({ tools, onTextDelta }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
      await sdkTool.invoke({}, JSON.stringify({ query: 'two' }))
      onTextDelta('done')
      return { finalText: 'done' }
    }
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
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.equal(result.success, true)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
  assert.equal(result.executionDiagnostics?.budgetUsagePercent, 100)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'exhausted')
  const continuation = result.projectionTruth?.projectionPatch?.taskContinuation as
    | {
        outputDir?: string
        runStatePath?: string
      }
    | undefined
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
    executeToolCall: async () =>
      createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true }
      }),
    runAgent: async ({ tools }) => {
      const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'one' })))
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'two' })))
      returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query: 'three' })))
      return { finalText: 'done' }
    }
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
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.equal(result.success, true)
  assert.match(returnedToolResults[2] || '', /预算提醒/)
  assert.equal(result.executionDiagnostics?.budgetWarningLevel, 'warning')
})

test('Agent SDK runtime rejects tool effects before crossing the hard call limit', async () => {
  let executions = 0
  const returnedToolResults: string[] = []
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    executeToolCall: async () => {
      executions += 1
      return createToolExecutionOutput('search result', { shape: 'json', data: { ok: true } })
    },
    runAgent: async ({ tools }) => {
      const sdkTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      for (const query of ['one', 'two', 'three']) {
        returnedToolResults.push(await sdkTool.invoke({}, JSON.stringify({ query })))
      }
      return { finalText: 'done' }
    }
  })
  runtime.newSession('butler::scope-sdk-budget-hard-limit', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-budget-hard-limit',
    'research hard limit',
    'run-sdk-budget-hard-limit',
    {
      publicSessionId: 'scope-sdk-budget-hard-limit',
      taskId: 'task-sdk-budget-hard-limit',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 4,
          maxToolCalls: 2,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.equal(executions, 2)
  assert.match(returnedToolResults[2] || '', /budget_exhausted/)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
})

test('Agent SDK budget continuation restores checkpoint session snapshot and unfreezes budget runtime', async () => {
  let continuationRef: { outputDir?: string; runStatePath?: string } | undefined
  {
    const runtime = createRuntime({
      listToolDefinitions: () => [createResearchTool()],
      executeToolCall: async () =>
        createToolExecutionOutput('search result', {
          shape: 'json',
          data: { ok: true }
        }),
      runAgent: async ({ tools }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
        await sdkTool.invoke({}, JSON.stringify({ query: 'two' }))
        return { finalText: 'done' }
      }
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
            reservedToolCalls: 0
          }
        })
      }
    )
    continuationRef = checkpoint.projectionTruth?.projectionPatch
      ?.taskContinuation as typeof continuationRef
  }

  assert.ok(continuationRef?.runStatePath)
  const state = JSON.parse(await readFile(continuationRef.runStatePath, 'utf8')) as Record<
    string,
    unknown
  >
  state.sessionSnapshot = [{ role: 'user', content: 'CHECKPOINT_MARKER' }]
  state.budgetRuntime = {
    ...(state.budgetRuntime as Record<string, unknown>),
    frozen: true
  }
  await writeFile(continuationRef.runStatePath, JSON.stringify(state, null, 2), 'utf8')

  let restoredItemsText = ''
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    runAgent: async ({ session }) => {
      restoredItemsText = JSON.stringify(await session.getItems())
      return { finalText: 'continued' }
    }
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
        runStatePath: continuationRef.runStatePath
      }
    }
  )

  assert.equal(continued.success, true)
  assert.equal(continued.status, 'done')
  assert.match(restoredItemsText, /CHECKPOINT_MARKER/)
  assert.equal(continued.executionDiagnostics?.taskBudgetRuntime?.frozen, false)
  assert.equal(continued.executionDiagnostics?.taskBudgetRuntime?.usage.toolCallsUsed, 2)
  const continuedBudget = continued.executionDiagnostics?.taskBudgetRuntime
  assert.ok(continuedBudget)
  assert.ok(continuedBudget.budget.maxToolCalls - continuedBudget.usage.toolCallsUsed >= 2)
})

test('Agent SDK budget continuation collapses concurrent continues for the same checkpoint', async () => {
  let continuationRef: { outputDir?: string; runStatePath?: string } | undefined
  {
    const runtime = createRuntime({
      listToolDefinitions: () => [createResearchTool()],
      executeToolCall: async () =>
        createToolExecutionOutput('search result', {
          shape: 'json',
          data: { ok: true }
        }),
      runAgent: async ({ tools }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'one' }))
        return { finalText: 'checkpoint' }
      }
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
            reservedToolCalls: 0
          }
        })
      }
    )
    continuationRef = checkpoint.projectionTruth?.projectionPatch
      ?.taskContinuation as typeof continuationRef
  }

  assert.ok(continuationRef?.runStatePath)
  let resumeRuns = 0
  let releaseResume!: () => void
  let markResumeStarted!: () => void
  const resumeStarted = new Promise<void>((resolve) => {
    markResumeStarted = resolve
  })
  const runtime = createRuntime({
    listToolDefinitions: () => [createResearchTool()],
    runAgent: async () => {
      resumeRuns += 1
      markResumeStarted()
      await new Promise<void>((release) => {
        releaseResume = release
      })
      return { finalText: 'continued' }
    }
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(),
    getRunMetaRepository: () => ({
      get: (runId: string) => runMeta.get(runId) ?? null,
      create: (input: Record<string, unknown>) => {
        runMeta.set(String(input.runId), { ...input })
        return input
      },
      update: (runId: string, patch: Record<string, unknown>) => {
        const next = { ...(runMeta.get(runId) || {}), ...patch }
        runMeta.set(runId, next)
        return next
      }
    })
  } as never)
  runtime.newSession('butler::scope-sdk-budget-single-flight', 'system prompt')
  const continuationIntent = {
    taskId: 'task-sdk-budget-single-flight',
    outputDir: continuationRef.outputDir,
    runStatePath: continuationRef.runStatePath
  }
  const first = runtime.sendMessage(
    'butler::scope-sdk-budget-single-flight',
    '继续',
    'run-sdk-budget-single-flight-2',
    {
      publicSessionId: 'scope-sdk-budget-single-flight',
      taskId: 'task-sdk-budget-single-flight',
      continuationIntent
    }
  )

  await resumeStarted
  const second = await runtime.sendMessage(
    'butler::scope-sdk-budget-single-flight',
    '继续',
    'run-sdk-budget-single-flight-3',
    {
      publicSessionId: 'scope-sdk-budget-single-flight',
      taskId: 'task-sdk-budget-single-flight',
      continuationIntent
    }
  )
  releaseResume()
  const firstResult = await first
  assert.equal(resumeRuns, 1)
  assert.equal(second.success, true)
  assert.equal(second.status, 'checkpoint')
  assert.equal(second.terminalReason, 'checkpoint_budget')
  assert.equal(runMeta.get('run-sdk-budget-single-flight-3')?.status, 'checkpoint')
  assert.match(second.finalText, /已经在继续执行/)
  assert.equal(firstResult.success, true)
})

test('Agent SDK maxTurns never exceeds the remaining iteration budget', async () => {
  let calls = 0
  let seenMaxTurns = 0
  const runtime = createRuntime({
    runAgent: async ({ maxTurns }) => {
      calls += 1
      seenMaxTurns = maxTurns
      return { finalText: 'one turn only' }
    }
  })
  runtime.newSession('butler::scope-sdk-iteration-hard-limit', 'system prompt')

  await runtime.sendMessage(
    'butler::scope-sdk-iteration-hard-limit',
    'one iteration',
    'run-sdk-iteration-hard-limit',
    {
      publicSessionId: 'scope-sdk-iteration-hard-limit',
      taskId: 'task-sdk-iteration-hard-limit',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 1,
          maxToolCalls: 100,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.equal(calls, 1)
  assert.equal(seenMaxTurns, 1)
})

test('Agent SDK checkpoints before model execution when iteration budget is already exhausted', async () => {
  let calls = 0
  const runtime = createRuntime({
    runAgent: async () => {
      calls += 1
      return { finalText: 'must not run' }
    }
  })
  runtime.newSession('butler::scope-sdk-iteration-exhausted', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-iteration-exhausted',
    'continue',
    'run-sdk-iteration-exhausted',
    {
      publicSessionId: 'scope-sdk-iteration-exhausted',
      taskId: 'task-sdk-iteration-exhausted',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 1,
          maxToolCalls: 100,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0
        },
        usage: { iterationsUsed: 1, toolCallsUsed: 0, parallelToolGroupsUsed: 0 }
      })
    }
  )

  assert.equal(calls, 0)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_budget')
})

test('Agent SDK charges model iterations reported by a failed provider run', async () => {
  let calls = 0
  const runtime = createRuntime({
    runAgent: async () => {
      calls += 1
      throw Object.assign(new Error('Max turns (1) exceeded'), { iterationsUsed: 1 })
    }
  })
  runtime.newSession('butler::scope-sdk-iteration-error', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-iteration-error',
    'continue',
    'run-sdk-iteration-error',
    {
      publicSessionId: 'scope-sdk-iteration-error',
      taskId: 'task-sdk-iteration-error',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 1,
          maxToolCalls: 100,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.equal(calls, 1)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.iterationsUsed, 1)
})

test('Agent SDK recomputes maxTurns after a failed attempt consumes iteration budget', async () => {
  const seenMaxTurns: number[] = []
  const runtime = createRuntime({
    runAgent: async ({ maxTurns }) => {
      seenMaxTurns.push(maxTurns)
      if (seenMaxTurns.length === 1) {
        throw Object.assign(new Error('HTTP 429 Too Many Requests'), { iterationsUsed: 1 })
      }
      return { finalText: 'done', iterationsUsed: 1 }
    }
  })
  runtime.newSession('butler::scope-sdk-retry-iteration-budget', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-sdk-retry-iteration-budget',
    'continue',
    'run-sdk-retry-iteration-budget',
    {
      publicSessionId: 'scope-sdk-retry-iteration-budget',
      taskId: 'task-sdk-retry-iteration-budget',
      taskBudgetRuntime: createTaskBudgetRuntime('research', {
        budget: {
          maxIterations: 2,
          maxToolCalls: 100,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0
        }
      })
    }
  )

  assert.deepEqual(seenMaxTurns, [2, 1])
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.iterationsUsed, 2)
})

test('invalid budget continuation handles stop before model or tool execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-invalid-budget-continuation-'))
  try {
    const budgetRuntime = createTaskBudgetRuntime('research')
    const baseState = {
      version: 1,
      kind: 'agent_sdk_budget_checkpoint',
      resumeKind: 'paused',
      scopeId: 'scope-valid',
      taskId: 'task-valid',
      runId: 'run-original',
      agentName: 'butler',
      taskType: 'research',
      budgetRuntime,
      sessionSnapshot: [],
      requiredCapabilityGroups: [],
      requiredToolNames: [],
      usedToolNames: []
    }
    const corruptPath = join(root, 'corrupt.json')
    const wrongTaskPath = join(root, 'wrong-task.json')
    const wrongScopePath = join(root, 'wrong-scope.json')
    const missingIdentityPath = join(root, 'missing-identity.json')
    const validPath = join(root, 'valid.json')
    await writeFile(corruptPath, '{broken', 'utf8')
    await writeFile(wrongTaskPath, JSON.stringify({ ...baseState, taskId: 'task-other' }), 'utf8')
    await writeFile(
      wrongScopePath,
      JSON.stringify({ ...baseState, scopeId: 'scope-other' }),
      'utf8'
    )
    await writeFile(
      missingIdentityPath,
      JSON.stringify({ ...baseState, scopeId: undefined, taskId: undefined }),
      'utf8'
    )
    await writeFile(validPath, JSON.stringify(baseState), 'utf8')

    const cases: Array<{ label: string; path: string; taskId?: string }> = [
      { label: 'missing', path: join(root, 'missing.json') },
      { label: 'corrupt', path: corruptPath },
      { label: 'wrong-task', path: wrongTaskPath },
      { label: 'wrong-scope', path: wrongScopePath },
      { label: 'current-task-mismatch', path: validPath, taskId: 'task-current' },
      { label: 'missing-identity', path: missingIdentityPath }
    ]
    for (const item of cases) {
      let modelCalls = 0
      let toolCalls = 0
      const runMeta = new Map<string, Record<string, unknown>>()
      const runtime = createRuntime({
        executeToolCall: async () => {
          toolCalls += 1
          return createToolExecutionOutput('unexpected')
        },
        runAgent: async () => {
          modelCalls += 1
          return { finalText: 'unexpected' }
        }
      })
      runtime.setRuntime({
        ...canonicalCoreCloseoutTestPort(),
        getRunMetaRepository: () => ({
          get: (runId: string) => runMeta.get(runId) ?? null,
          create: (input: Record<string, unknown>) => {
            runMeta.set(String(input.runId), { ...input })
            return input
          },
          update: (runId: string, patch: Record<string, unknown>) => {
            const next = { ...(runMeta.get(runId) || {}), ...patch }
            runMeta.set(runId, next)
            return next
          }
        })
      } as never)
      const sessionName = `butler::scope-invalid-${item.label}`
      const runId = `run-invalid-${item.label}`
      runtime.newSession(sessionName, 'system prompt')
      const result = await runtime.sendMessage(sessionName, '继续', runId, {
        publicSessionId: 'scope-valid',
        taskId: item.taskId || 'task-valid',
        continuationIntent: { taskId: 'task-valid', runStatePath: item.path },
      })
      assert.equal(result.status, 'error', item.label)
      assert.equal(result.terminalReason, 'persistence_failed', item.label)
      assert.equal(runMeta.get(runId)?.status, 'error', item.label)
      assert.equal(modelCalls, 0, item.label)
      assert.equal(toolCalls, 0, item.label)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
