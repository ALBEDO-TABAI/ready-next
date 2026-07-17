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
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { resolveBrowserWorkIntent } from '../shared/browser-work-intent'
import { ToolConsentRetryCoordinator } from '../main/modules/agent-control/runtime-core/tool-consent-retry-coordinator'
import { __setSkillsRuntimeManagerForTests } from '../main/modules/skills-runtime/runtime-manager'

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

test('site research and its bare continuation expose the complete live browser workflow', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0] & {
        recentBrowserWorkIntent?: ReturnType<typeof resolveBrowserWorkIntent>
      }): Array<{ name: string }>
    }
  }).toolExecutor
  const original = '在小红书当前页面搜索关键词：\n词一\n词二\n这是只读研究任务，不发布、不点赞、不评论、不关注。请完整处理全部2个关键词。'
  const base = {
    sessionId: 'scope-site-research',
    scopeId: 'scope-site-research',
    config: { ...COMPATIBLE_AUTO_CONFIG, toolUseMode: 'on' as const },
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  }
  for (const definitions of [
    executor.listDefaultToolDefinitionsForTurn({ ...base, message: original }),
    executor.listDefaultToolDefinitionsForTurn({ ...base, message: '在小红书搜索：甲、乙' }),
    executor.listDefaultToolDefinitionsForTurn({
      ...base,
      message: '继续',
      recentBrowserWorkIntent: resolveBrowserWorkIntent(original),
    }),
  ]) {
    const names = definitions.map((definition) => definition.name)
    for (const required of ['browser_research', 'browser_task', 'browser_click', 'browser_type', 'browser_press_key']) {
      assert.ok(names.includes(required), `${required} missing from ${names.join(',')}`)
    }
    for (const forbidden of ['web_search', 'web_fetch', 'web_clip_url']) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not bypass current-site research`)
    }
  }
})

test('selected advisory skill cannot remove site-research control and continuation tools', () => {
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [{
      id: 'social-media-ops-test',
      allowedTools: [
        'browser_tabs',
        'browser_navigate',
        'browser_search',
        'browser_snapshot',
        'browser_find',
        'browser_read',
        'browser_screenshot',
        'browser_wait',
        'browser_scroll',
        'browser_request_takeover',
      ],
    }],
  } as never)
  try {
    const runtime = new AgentSdkRuntime({ domainAdapters: [] })
    const executor = (runtime as unknown as {
      toolExecutor: {
        listDefaultToolDefinitionsForTurn(params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]): Array<{ name: string }>
      }
    }).toolExecutor
    const definitions = executor.listDefaultToolDefinitionsForTurn({
      message: '在小红书当前页面搜索关键词：\n词一\n词二\n只读研究，不下载、不发布。',
      sessionId: 'scope-site-research-selected-skill',
      scopeId: 'scope-site-research-selected-skill',
      config: { ...COMPATIBLE_AUTO_CONFIG, toolUseMode: 'on' },
      browserHostAvailable: true,
      feishuConnected: false,
      skillCatalogAvailable: true,
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'social-media-ops-test',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_read_artifact'],
        source: 'explicit',
        reason: 'test',
      }),
    })
    const names = definitions.map((definition) => definition.name)
    for (const required of ['browser_research', 'browser_task', 'browser_request_takeover']) {
      assert.ok(names.includes(required), `${required} missing from ${names.join(',')}`)
    }
    assert.equal(names.includes('web_search'), false)
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
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
    assert.match(result.finalText, /已开启工具调用/)
    assert.equal(store.size(), 0)
  } finally {
    runtime.stopGeneration('operator::scope-consent-runtime')
    _resetAskUserQuestionsBridgeForTests()
    _resetAskUserQuestionsStoreForTests()
  }
})

test('disabled tools -> confirm dispatches the verbatim blocked request exactly once on a fresh run', async () => {
  _resetAskUserQuestionsStoreForTests()
  const store = getAskUserQuestionsStore()
  registerAskUserQuestionsCardPersistor(() => undefined)
  registerAskUserQuestionsCardEmitter((card) => {
    queueMicrotask(() => store.resolve(card.cardId, {
      answers: [{ id: 'tool_calling_consent', answer: '开启工具调用' }],
      answeredAt: Date.now(),
    }))
  })
  const originalRequest = [
    '再试一次，帮我在小红书这里搜索下面这些关键词，找找其中的爆款笔记整理下来标题和内容，然后再筛选出适合这个账号的选题有哪些：',
    ...Array.from({ length: 18 }, (_, index) => `${index + 1} query-${index + 1}`),
  ].join('\n')
  const dispatched: Array<Record<string, unknown>> = []
  const runtime = new AgentSdkRuntime({
    domainAdapters: [],
    loadAIConfig: () => ({
      ok: true,
      config: COMPATIBLE_AUTO_CONFIG,
      reason: 'present',
      activeProfileId: 'compatible-profile-a',
    }),
    listToolDefinitions: reportBrowserProviderConflict,
    runAgent: async () => ({ finalText: '当前工具调用处于关闭状态。' }),
    setActiveToolUseMode: async () => ({ applied: true, previousMode: 'auto', alreadyEnabled: false }),
    dispatchToolConsentRetry: async (input) => { dispatched.push(input) },
  })
  runtime.newSession('operator::scope-consent-retry', 'system prompt')

  try {
    await runtime.sendMessage(
      'operator::scope-consent-retry',
      originalRequest,
      'run-blocked-original',
      { publicSessionId: 'scope-consent-retry', taskId: 'task-original' },
    )
    await runtime.sendMessage(
      'operator::scope-consent-retry',
      '我授权你使用浏览器工具',
      'run-consent-retry',
      { publicSessionId: 'scope-consent-retry', taskId: 'task-consent' },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].message, originalRequest)
    assert.equal(dispatched[0].scopeId, 'scope-consent-retry')
    assert.equal(dispatched[0].taskId, 'task-original')
    assert.equal(dispatched[0].runOrigin, 'continuation')
    assert.match(String(dispatched[0].requestId), /^tool-consent-retry-run-blocked-original-/)
  } finally {
    runtime.stopGeneration('operator::scope-consent-retry')
    _resetAskUserQuestionsBridgeForTests()
    _resetAskUserQuestionsStoreForTests()
  }
})

test('tool consent retry is bounded, reuses one request identity, and expires its pending work', async () => {
  const coordinator = new ToolConsentRetryCoordinator()
  coordinator.remember({
    scopeId: 'scope-retry-bounds',
    sourceRunId: 'run-retry-bounds',
    agentName: 'operator::scope-retry-bounds',
    content: '原始请求',
    taskId: 'task-retry-bounds',
  })
  const requestIds: string[] = []
  const dispatch = coordinator.createDispatch('scope-retry-bounds', async (input) => {
    requestIds.push(input.requestId)
    throw new Error('temporary failure')
  })
  assert.ok(dispatch)
  dispatch?.()
  const deadline = Date.now() + 1_000
  while (requestIds.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(requestIds.length, 3)
  assert.equal(new Set(requestIds).size, 1)
  assert.equal(coordinator.createDispatch('scope-retry-bounds', async () => undefined), undefined)

  let now = 0
  const expiring = new ToolConsentRetryCoordinator(() => now, 100)
  expiring.remember({
    scopeId: 'scope-expired',
    sourceRunId: 'run-expired',
    agentName: 'operator',
    content: 'expired',
    taskId: 'task-expired',
  })
  now = 101
  assert.equal(expiring.createDispatch('scope-expired', async () => undefined), undefined)
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
