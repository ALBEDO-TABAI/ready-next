import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import {
  _resetAskUserQuestionsBridgeForTests,
  registerAskUserQuestionsCardEmitter,
  registerAskUserQuestionsCardPersistor,
} from '../main/modules/agent-control/ask-user/ask-user-questions-bridge'
import {
  _resetAskUserQuestionsStoreForTests,
  getAskUserQuestionsStore,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import type { AIModelConfig } from '../shared/ai-providers'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'

const COMPATIBLE_AUTO_CONFIG: AIModelConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://compatible.example/v1',
  apiKey: 'test-key',
  model: 'custom-model',
  toolUseMode: 'auto',
}

function reportBrowserProviderConflict(
  params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
): [] {
  params.onCapabilityResolution?.(resolveCapabilityResolution({
    config: params.config,
    profile: 'local_chat',
    browserDecisionMode: 'browser_workflow',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
  }))
  return []
}

test('default SDK executor reports the same suppressed browser groups that it used to build the tool surface', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): unknown[]
    }
  }).toolExecutor
  let captured: CapabilityResolution | null = null
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: '我授权你使用浏览器工具',
    sessionId: 'scope-default-resolution',
    scopeId: 'scope-default-resolution',
    config: COMPATIBLE_AUTO_CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    onCapabilityResolution: (resolution) => { captured = resolution },
  })

  assert.deepEqual(definitions, [])
  assert.deepEqual(
    captured?.requestedButSuppressed.map((conflict) => [conflict.groupId, conflict.reason]),
    [
      ['browser_interaction', 'provider_disabled_tools'],
    ],
  )
})

test('default SDK executor does not report negated browser wording as requested capability', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): unknown[]
    }
  }).toolExecutor
  let captured: CapabilityResolution | null = null

  executor.listDefaultToolDefinitionsForTurn({
    message: '不要使用浏览器工具，直接回答',
    sessionId: 'scope-negated-browser',
    scopeId: 'scope-negated-browser',
    config: COMPATIBLE_AUTO_CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    onCapabilityResolution: (resolution) => { captured = resolution },
  })

  assert.deepEqual(
    captured?.intentRequestedCapabilityGroupIds.filter((groupId) => groupId.startsWith('browser_')),
    [],
  )
  assert.deepEqual(
    captured?.requestedButSuppressed.filter((conflict) => conflict.groupId.startsWith('browser_')),
    [],
  )
})

test('SDK live turn routes explicit tool authorization through one card and never calls the model on the old tool surface', async () => {
  _resetAskUserQuestionsStoreForTests()
  const store = getAskUserQuestionsStore()
  registerAskUserQuestionsCardPersistor(() => undefined)
  registerAskUserQuestionsCardEmitter((card) => {
    queueMicrotask(() => {
      store.resolve(card.cardId, {
        answers: [{ id: 'tool_calling_consent', answer: '开启工具调用' }],
        answeredAt: Date.now(),
      })
    })
  })

  let modelCalled = false
  const updates: unknown[] = []
  const runtime = new AgentSdkRuntime({
    domainAdapters: [],
    loadAIConfig: () => ({
      ok: true,
      config: COMPATIBLE_AUTO_CONFIG,
      reason: 'present',
      activeProfileId: 'compatible-profile-a',
    }),
    listToolDefinitions: reportBrowserProviderConflict,
    runAgent: async () => {
      modelCalled = true
      return { finalText: 'should not run' }
    },
    setActiveToolUseMode: async (request) => {
      updates.push(request)
      return { applied: true, previousMode: 'auto', alreadyEnabled: false }
    },
  })
  runtime.newSession('operator::scope-consent-runtime', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'operator::scope-consent-runtime',
      '我授权你使用浏览器工具',
      'run-consent-runtime',
      { publicSessionId: 'scope-consent-runtime', taskId: 'task-consent-runtime' },
    )

    assert.equal(modelCalled, false)
    assert.equal(updates.length, 1)
    assert.equal(
      (updates[0] as { expectedFingerprint?: { activeProfileId?: string } })
        .expectedFingerprint?.activeProfileId,
      'compatible-profile-a',
    )
    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.match(result.finalText, /请重发上一条任务/)
    assert.equal(store.size(), 0)
  } finally {
    runtime.stopGeneration('operator::scope-consent-runtime')
    _resetAskUserQuestionsBridgeForTests()
    _resetAskUserQuestionsStoreForTests()
  }
})

test('SDK live turn passes the exact capability conflict into ephemeral model instructions', async () => {
  let capturedInstructions = ''
  const runtime = new AgentSdkRuntime({
    domainAdapters: [],
    loadAIConfig: () => ({ ok: true, config: COMPATIBLE_AUTO_CONFIG, reason: 'present' }),
    listToolDefinitions: reportBrowserProviderConflict,
    runAgent: async (params) => {
      capturedInstructions = params.instructions
      return { finalText: '当前工具调用处于关闭状态。' }
    },
  })
  runtime.newSession('operator::scope-conflict-reminder', 'system prompt')

  try {
    const result = await runtime.sendMessage(
      'operator::scope-conflict-reminder',
      '请用浏览器查看当前页面',
      'run-conflict-reminder',
      { publicSessionId: 'scope-conflict-reminder', taskId: 'task-conflict-reminder' },
    )

    assert.equal(result.success, true)
    assert.match(capturedInstructions, /ready:system-reminder:tool-capability-conflict/)
    assert.match(capturedInstructions, /当前模型配置关闭了工具调用/)
    assert.match(capturedInstructions, /不得声称“已收到授权”/)
    assert.doesNotMatch(JSON.stringify(await (
      runtime as unknown as {
        sessionManager: { get(name: string): { sdkSession: { getItems(): Promise<unknown[]> } } }
      }
    ).sessionManager.get('operator::scope-conflict-reminder').sdkSession.getItems()), /tool-capability-conflict/)
  } finally {
    runtime.stopGeneration('operator::scope-conflict-reminder')
  }
})
