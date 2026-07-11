import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

const fakeConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-test' } as const

function projection(): TaskProjectionRecord {
  const now = new Date().toISOString()
  return {
    taskId: 'task-live', scopeId: 'scope-live', runId: 'run-live', taskType: 'research',
    module: 'system', status: 'running', interactionState: 'running', waitingFor: 'none',
    steps: [], ownerAgentId: 'butler', taskOrigin: 'user_root',
    executionBinding: {
      schemaVersion: 1, runId: 'run-live', ownerAgentIdAtStart: 'butler', runOrigin: 'initial',
      kind: 'registered_agent', requestedAgentId: 'butler', effectiveAgentId: 'butler',
      executionMaterialHash: 'butler-hash', ownerAssignmentSource: 'conversation_active',
      executionSelectionSource: 'task_owner', resolutionKind: 'direct',
    },
    createdAt: now, updatedAt: now,
  }
}

async function runScenario(
  t: TestContext,
  verdicts: Array<'accept' | 'repair' | 'block'>,
  options: { message?: string; deliveryMode?: 'standard' | 'adaptive'; failOwner?: boolean } = {},
) {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  let row = projection()
  const runMeta = new Map<string, Record<string, unknown>>()
  const calls: string[] = []
  let verifierIndex = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    runAgent: async (params) => {
      calls.push(params.agentName)
      if (options.failOwner && params.agentName === 'butler::scope-live') {
        params.onTextDelta('hidden draft')
        throw new Error('provider unavailable')
      }
      if (params.agentName === 'dynamic-delivery-verifier') {
        const verdict = verdicts[Math.min(verifierIndex++, verdicts.length - 1)]
        return {
          finalText: JSON.stringify({
            version: 1, verdict,
            gaps: verdict === 'accept' ? [] : [{ kind: 'text', description: 'fix the conclusion' }],
            summary: verdict,
          }),
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        }
      }
      if (params.agentName === 'dynamic-delivery-owner-repair') {
        return { finalText: 'repaired answer', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }
      }
      params.onTextDelta('candidate answer')
      return { finalText: 'candidate answer', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }
    },
  })
  const store = {
    get: () => row,
    update: (_taskId: string, patch: Partial<TaskProjectionRecord>) => { row = { ...row, ...patch } },
    reduceDeliveryState: (input: {
      reduce: (state: NonNullable<TaskProjectionRecord['deliveryState']>) => NonNullable<TaskProjectionRecord['deliveryState']>
    }) => {
      if (!row.deliveryState) throw new Error('delivery state missing')
      const next = input.reduce(row.deliveryState)
      row = { ...row, deliveryState: next }
      return next
    },
  }
  runtime.setRuntime({
    getTaskProjection: () => row,
    getTaskProjectionStore: () => store,
    getTaskProjectionStoreForFinalize: () => store,
    listAgentProfileSummaries: () => [],
    getPersistedActivePlan: () => null,
    persistActivePlan: () => undefined,
    getRunMetaRepository: () => ({
      get: (id: string) => runMeta.get(id) ?? null,
      create: (value: Record<string, unknown>) => { runMeta.set(String(value.runId), value); return value },
      update: (id: string, patch: Record<string, unknown>) => {
        const value = { ...(runMeta.get(id) ?? {}), ...patch }; runMeta.set(id, value); return value
      },
    }),
  } as never)
  const outputs: Array<{ chunk: string; type: string }> = []
  const runtimeErrors: unknown[] = []
  runtime.on('output', (event) => outputs.push({ chunk: event.chunk, type: event.type }))
  runtime.on('error', (event) => runtimeErrors.push(event))
  runtime.newSession('butler::scope-live', 'system prompt')
  const message = options.message ?? '研究这份材料并给结论'
  const result = await runtime.sendMessage('butler::scope-live', message, 'run-live', {
    taskId: 'task-live', publicSessionId: 'scope-live',
    requestEnvelope: buildRequestEnvelope({ userText: message, contextRefIds: ['resource-one'] }),
    intentClassification: { primaryDomain: 'research', mentionedDomains: [], confidence: 1 },
    taskBudgetRuntime: {
      taskType: 'research', budget: { taskType: 'research', maxIterations: 4, maxToolCalls: 4, maxParallelToolGroups: 1 },
      usage: { iterationsUsed: 0, toolCallsUsed: 0, parallelToolGroupsUsed: 0 },
      stepBudget: null, warningLevel: 'none', frozen: true, bootstrapBudget: false,
    },
    executionBinding: row.executionBinding,
    deliveryMode: options.deliveryMode ?? 'adaptive',
  })
  const deliveryContext = (runtime as unknown as {
    dynamicDelivery: { contexts: { get: (runId: string) => unknown } }
  }).dynamicDelivery.contexts.get('run-live')
  return { calls, outputs, runtimeErrors, row, result, deliveryContext }
}

test('adaptive live path keeps candidate hidden until fresh verifier accepts', async (t) => {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  const { calls, outputs, row, result } = await runScenario(t, ['accept'])
  assert.deepEqual(calls, ['butler::scope-live', 'dynamic-delivery-verifier'])
  assert.equal(outputs.filter((entry) => entry.type === 'text').map((entry) => entry.chunk).join(''), 'candidate answer')
  assert.equal(row.deliveryState?.verifier.status, 'accepted')
  assert.equal(result.finalText, 'candidate answer')
})

test('all twelve release fixtures execute standard/adaptive through the live runtime seam', async (t) => {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  const fixturePath = fileURLToPath(new URL('./fixtures/dynamic-delivery/fixtures.json', import.meta.url))
  const fixtures = (JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    fixtures: Array<{ id: string; userRequest: string }>
  }).fixtures
  assert.equal(fixtures.length, 12)
  for (const fixture of fixtures) {
    const standard = await runScenario(t, ['accept'], { message: fixture.userRequest, deliveryMode: 'standard' })
    assert.equal(standard.calls.includes('dynamic-delivery-verifier'), false, `${fixture.id}: standard extra call`)
    assert.equal(standard.result.finalText, 'candidate answer', `${fixture.id}: standard baseline`)
    const adaptive = await runScenario(t, ['accept'], { message: fixture.userRequest, deliveryMode: 'adaptive' })
    assert.equal(adaptive.calls.includes('dynamic-delivery-verifier'), true, `${fixture.id}: adaptive verifier`)
    assert.equal(adaptive.result.finalText, 'candidate answer', `${fixture.id}: adaptive accepted output`)
    assert.equal(adaptive.row.deliveryState?.verifier.status, 'accepted', `${fixture.id}: accepted state`)
  }
})

test('adaptive live reject leaks no candidate output', async (t) => {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  const { outputs, row, result } = await runScenario(t, ['block'])
  assert.equal(outputs.filter((entry) => entry.type === 'text').map((entry) => entry.chunk).join(''), '')
  assert.equal(row.deliveryState?.verifier.status, 'blocked')
  assert.notEqual(result.finalText, 'candidate answer')
})

test('adaptive live repair releases only the accepted replacement', async (t) => {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  const { calls, outputs, row, result } = await runScenario(t, ['repair', 'accept'])
  assert.deepEqual(calls, ['butler::scope-live', 'dynamic-delivery-verifier', 'dynamic-delivery-owner-repair', 'dynamic-delivery-verifier'])
  assert.equal(outputs.filter((entry) => entry.type === 'text').map((entry) => entry.chunk).join(''), 'repaired answer')
  assert.equal(row.deliveryState?.verifier.repaired, true)
  assert.equal(result.finalText, 'repaired answer')
})

test('owner provider failure discards the hidden candidate and closes the delivery context', async (t) => {
  skipIfSqliteUnavailable(t, 'dynamic-delivery-live transitive sqlite load')
  const { outputs, runtimeErrors, result, deliveryContext } = await runScenario(t, ['accept'], { failOwner: true })
  assert.equal(result.success, false)
  assert.equal(runtimeErrors.length, 1)
  assert.equal(outputs.some((entry) => entry.type === 'text' && entry.chunk.includes('hidden draft')), false)
  assert.equal(deliveryContext, null)
})
