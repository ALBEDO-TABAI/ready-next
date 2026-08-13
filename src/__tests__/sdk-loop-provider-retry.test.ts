import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test, { after, before } from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { classifyExecutionError } from '../main/modules/claude-bridge/error-classifier'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { handleAgentSdkTurnError, shouldCheckpointProviderFailure } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-closeout'
import { buildProviderHttpError } from '../main/modules/claude-bridge/provider-terminal-error'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

test('sdk-loop-provider-retry declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'sdk-loop-provider-retry transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test'
} as const

function createRuntime(runAgent: AgentSdkRuntimeDeps['runAgent']): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)
}

test('stream-cut shapes classify as transient (single policy source)', () => {
  assert.equal(
    classifyExecutionError(new Error('ERR_STREAM_PREMATURE_CLOSE: Premature close')).kind,
    'transient'
  )
  assert.equal(classifyExecutionError(new Error('fetch failed')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('terminated')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('HTTP 429 too many requests')).kind, 'rate_limit')
})

test('two 429s then success keeps the run alive with exactly two retries', async () => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    if (calls <= 2) throw new Error('HTTP 429 Too Many Requests')
    return { finalText: '成功了。', toolTrace: [] }
  })
  runtime.newSession('butler::scope-retry', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-retry', '查个东西', 'run-retry-1', {})
  assert.equal(result.success, true)
  assert.equal(calls, 3)
  assert.equal(result.finalText.includes('成功了'), true)
})

test('persistent 5xx exhausts retries and surfaces a classified failure', async () => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    throw new Error('HTTP 503 Service Unavailable')
  })
  runtime.on('error', () => {})
  runtime.newSession('butler::scope-retry-fail', 'system prompt')
  const result = await runtime.sendMessage(
    'butler::scope-retry-fail',
    '查个东西',
    'run-retry-2',
    {}
  )
  assert.equal(result.success, false)
  // 1 initial + maxAttempts(6) retries = 7 calls（2026-07-23 transient 上限 3→6）
  assert.equal(calls, 7)
})

test('retry exhaustion becomes resumable only when a durable Browser checkpoint path exists', () => {
  const error = new Error('HTTP 503 Service Unavailable') as Error & {
    __readyProviderRequestRetryExhausted?: boolean
  }
  error.__readyProviderRequestRetryExhausted = true
  assert.equal(shouldCheckpointProviderFailure(error, true), true)
  assert.equal(shouldCheckpointProviderFailure(error, false), false)
  assert.equal(shouldCheckpointProviderFailure(new Error('HTTP 503 Service Unavailable'), true), false)
})

test('retry-exhausted provider failure closes through the durable Browser checkpoint callback', async () => {
  const error = buildProviderHttpError({
    httpStatus: 503,
    errorBody: 'Service Unavailable',
  }) as Error & {
    __readyProviderRequestRetryExhausted?: boolean
  }
  error.__readyProviderRequestRetryExhausted = true
  let capturedDiagnostics: Record<string, unknown> | null = null
  const expected = {
    success: true,
    status: 'checkpoint' as const,
    terminalReason: 'blocked_tool_error' as const,
    finalText: '浏览器进度已保存',
  }
  const result = await handleAgentSdkTurnError({
    error,
    name: 'butler::scope-provider-transfer',
    runId: 'run-provider-transfer',
    taskId: 'task-provider-transfer',
    sessionId: 'scope-provider-transfer',
    runStartedAt: Date.now(),
    runHandle: { abortInitiator: null },
    abortController: new AbortController(),
    usedTools: ['browser_read'],
    transcriptEvents: [],
    projectionPatches: [],
    runMetaBudgetRuntime: null,
    runMetaProviderDiagnostics: null,
    runMetaUsage: null,
    longSkillCheckpoint: null,
    finalText: '',
    documentTargetGuardForRecovery: null,
    requiresLocalDocumentExcerptForRecovery: false,
    requiresLocalDocumentWriteForRecovery: false,
    hasSuccessfulLocalDocumentSourceReadForRecovery: false,
    fileReadExcerptCheckpointForRecovery: null,
    hasSuccessfulDocumentTargetMutation: false,
    hasSuccessfulToolProgress: true,
    lastDocumentSaveSuccessText: null,
    finishProviderTransferCheckpoint: async (diagnostics) => {
      capturedDiagnostics = diagnostics as unknown as Record<string, unknown>
      return expected
    },
  } as never)

  assert.equal(result, expected)
  assert.equal(capturedDiagnostics?.lastProviderFailureHttpStatus, 503)
  assert.equal(capturedDiagnostics?.lastProviderFailureErrorKind, 'transient')
})

test('a stream cut before candidate commit retries without publishing the interrupted text', async () => {
  let calls = 0
  const visible: string[] = []
  const runtime = createRuntime(async ({ onTextDelta }) => {
    calls += 1
    onTextDelta(calls === 1 ? '半句' : '完整答复')
    if (calls === 1) throw new Error('terminated')
    return { finalText: '完整答复' }
  })
  runtime.on('output', (event) => visible.push(String(event.chunk || '')))
  runtime.on('error', () => undefined)
  runtime.newSession('butler::scope-post-delta-cut', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-post-delta-cut',
    'answer once',
    'run-post-delta-cut',
    {}
  )

  assert.equal(calls, 2)
  assert.equal(result.success, true)
  assert.equal(result.finalText.includes('完整答复'), true)
  assert.equal(visible.join('').includes('半句'), false)
})

test('a transient failure after a real tool result never replays the tool turn', async () => {
  const definition: ToolDefinition = {
    name: 'write_once',
    groupId: 'file_management',
    domain: 'file',
    kind: 'write',
    description: 'write once',
    schema: { type: 'object', properties: {}, additionalProperties: false }
  }
  let modelCalls = 0
  let toolEffects = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [definition],
    executeToolCall: async () => {
      toolEffects += 1
      return createToolExecutionOutput('written', { shape: 'json', data: { ok: true } })
    },
    runAgent: async ({ tools }) => {
      modelCalls += 1
      const writeTool = tools[0] as {
        invoke: (context: unknown, input: string) => Promise<string>
      }
      await writeTool.invoke({}, '{}')
      throw new Error('terminated')
    }
  })
  runtime.on('error', () => undefined)
  runtime.newSession('butler::scope-post-tool-cut', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-post-tool-cut',
    'write once',
    'run-post-tool-cut',
    {}
  )

  assert.equal(result.success, false)
  assert.equal(modelCalls, 1)
  assert.equal(toolEffects, 1)
})

test('aborting provider backoff preserves the requested stop semantics', async () => {
  const cases = [
    { initiator: 'user_stop' as const, status: 'cancelled', reason: 'cancelled_user' },
    { initiator: 'manual_suspend' as const, status: 'checkpoint', reason: 'manual_suspend' },
    { initiator: 'preempted' as const, status: 'cancelled', reason: 'cancelled_runtime' }
  ]
  for (const item of cases) {
    let firstCall!: () => void
    const called = new Promise<void>((resolve) => {
      firstCall = resolve
    })
    const runtime = createRuntime(async () => {
      firstCall()
      throw new Error('HTTP 429 Too Many Requests')
    })
    runtime.newSession(`butler::scope-backoff-${item.initiator}`, 'system prompt')
    const pending = runtime.sendMessage(
      `butler::scope-backoff-${item.initiator}`,
      'wait then stop',
      `run-backoff-${item.initiator}`,
      {}
    )
    await called
    await delay(30)
    const started = Date.now()
    runtime.stopGeneration(`butler::scope-backoff-${item.initiator}`, item.initiator)
    const result = await pending
    assert.ok(Date.now() - started < 150, item.initiator)
    assert.equal(result.status, item.status, item.initiator)
    assert.equal(result.terminalReason, item.reason, item.initiator)
  }
})
