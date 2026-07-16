import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExplicitToolEnableConsentMessage,
  maybeHandleToolCapabilityConsent,
  TOOL_CALLING_ENABLE_OPTION,
  TOOL_CALLING_KEEP_CLOSED_OPTION,
} from '../main/modules/agent-control/runtime-core/tool-capability-consent'
import {
  fingerprintAIConfig,
  updateActiveToolUseMode,
} from '../main/modules/agent-control/runtime-core/tool-use-mode-config-update'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'
import { normalizeAIConfig, type AIModelConfig } from '../shared/ai-providers'

const CONFIG = normalizeAIConfig<AIModelConfig>({
  provider: 'openai-compatible',
  baseUrl: 'https://compatible.example/v1',
  apiKey: 'secret-test-key',
  model: 'custom-model',
  toolUseMode: 'auto',
})

const CONFLICT = [{
  groupId: 'browser_interaction' as const,
  label: '浏览器交互',
  reason: 'provider_disabled_tools' as const,
}]

function answerOutput(answer: string, answeredVia = 'local_renderer') {
  return createToolExecutionOutput('answered', {
    shape: 'json',
    data: {
      cardId: 'card-consent-1',
      answeredVia,
      answers: [{ id: 'tool_calling_consent', answer }],
    },
  })
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const finalized: Array<Record<string, unknown>> = []
  const emitted: Array<{ text: string; type: string }> = []
  const writes: unknown[] = []
  return {
    finalized,
    emitted,
    writes,
    context: {
      conflicts: CONFLICT,
      supportsToolCalls: false,
      currentConfig: CONFIG,
      activeProfileId: 'profile-a',
      localSettingsConsentAllowed: true,
      userText: '我授权你使用浏览器工具',
      agentName: 'operator',
      sessionId: 'scope-consent',
      runId: 'run-consent',
      taskId: 'task-consent',
      signal: new AbortController().signal,
      emitOutput: (text: string, type: string) => emitted.push({ text, type }),
      finalizeEarlyReturn: async (params: Record<string, unknown>) => {
        finalized.push(params)
        return { finalText: params.finalText } as never
      },
      setActiveToolUseMode: async (request: unknown) => {
        writes.push(request)
        return { applied: true, previousMode: 'auto', alreadyEnabled: false } as const
      },
      ...overrides,
    },
  }
}

test('explicit tool consent requires an affirmative tool target and rejects negation', () => {
  assert.equal(isExplicitToolEnableConsentMessage('我授权你使用浏览器工具'), true)
  assert.equal(isExplicitToolEnableConsentMessage('please enable browser tools'), true)
  assert.equal(isExplicitToolEnableConsentMessage('请打开工具调用开关'), true)
  assert.equal(isExplicitToolEnableConsentMessage('请把工具能力启用'), true)
  assert.equal(isExplicitToolEnableConsentMessage('帮我浏览网页'), false)
  assert.equal(isExplicitToolEnableConsentMessage('请使用浏览器工具告诉我当前打开了哪些标签页'), false)
  assert.equal(isExplicitToolEnableConsentMessage('请打开浏览器并访问这个网页'), false)
  assert.equal(isExplicitToolEnableConsentMessage('请开启浏览器打开网页'), false)
  assert.equal(isExplicitToolEnableConsentMessage('不要开启浏览器工具'), false)
  assert.equal(isExplicitToolEnableConsentMessage('我无法授权浏览器工具'), false)
  assert.equal(isExplicitToolEnableConsentMessage('不代表我允许开启浏览器工具'), false)
  assert.equal(isExplicitToolEnableConsentMessage('I cannot authorize browser tools'), false)
  assert.equal(isExplicitToolEnableConsentMessage('I can’t authorize browser tools'), false)
  assert.equal(isExplicitToolEnableConsentMessage('I am unable to authorize browser tools'), false)
  assert.equal(isExplicitToolEnableConsentMessage('我授权你继续回答'), false)
})

test('confirmed consent updates only through the host setter and ends the old-surface turn', async () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const fixture = makeContext()
    await maybeHandleToolCapabilityConsent(fixture.context as never, {
      askUserQuestions: (async (args, deps) => {
        assert.deepEqual(args.questions[0].options, [
          TOOL_CALLING_ENABLE_OPTION,
          TOOL_CALLING_KEEP_CLOSED_OPTION,
        ])
        assert.equal(deps.responsePolicy, 'local_renderer_only')
        return answerOutput(TOOL_CALLING_ENABLE_OPTION)
      }) as never,
    })

    assert.equal(fixture.writes.length, 1)
    assert.deepEqual(fixture.writes[0], {
      mode: 'on',
      expectedFingerprint: fingerprintAIConfig(CONFIG, 'profile-a'),
    })
    assert.equal(fixture.finalized[0].status, 'done')
    assert.match(String(fixture.finalized[0].finalText), /请重发上一条任务/)
    const audit = metrics.find((event) => event.metric === 'tool_calling_consent_applied')
    assert.equal(audit?.scopeId, 'scope-consent')
    assert.equal(audit?.cardId, 'card-consent-1')
    assert.equal(audit?.previousMode, 'auto')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('keeping tools closed performs no write and completes deterministically', async () => {
  const fixture = makeContext()
  await maybeHandleToolCapabilityConsent(fixture.context as never, {
    askUserQuestions: (async () => answerOutput(TOOL_CALLING_KEEP_CLOSED_OPTION)) as never,
  })

  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.finalized[0].status, 'done')
  assert.match(String(fixture.finalized[0].finalText), /保持关闭/)
})

test('a changed active config is never overwritten after the user answers', async () => {
  const fixture = makeContext({
    setActiveToolUseMode: async () => ({ applied: false, reason: 'config_changed' as const }),
  })
  await maybeHandleToolCapabilityConsent(fixture.context as never, {
    askUserQuestions: (async () => answerOutput(TOOL_CALLING_ENABLE_OPTION)) as never,
  })

  assert.equal(fixture.finalized[0].status, 'error')
  assert.equal(fixture.finalized[0].terminalReason, 'blocked_config')
  assert.match(fixture.emitted[0].text, /活跃模型配置已切换/)
})

test('a remote answer can never approve a local settings change', async () => {
  const fixture = makeContext()
  await maybeHandleToolCapabilityConsent(fixture.context as never, {
    askUserQuestions: (async () => answerOutput(
      TOOL_CALLING_ENABLE_OPTION,
      'remote_channel',
    )) as never,
  })

  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.finalized[0].status, 'error')
  assert.match(fixture.emitted[0].text, /只能在本机 Ready 中确认/)
})

test('remote-bound sessions are directed to local settings without creating a card', async () => {
  const fixture = makeContext({ localSettingsConsentAllowed: false })
  let asks = 0
  await maybeHandleToolCapabilityConsent(fixture.context as never, {
    askUserQuestions: (async () => {
      asks += 1
      return answerOutput(TOOL_CALLING_ENABLE_OPTION)
    }) as never,
  })

  assert.equal(asks, 0)
  assert.deepEqual(fixture.writes, [])
  assert.match(fixture.emitted[0].text, /远程会话不能修改本机模型配置/)
})

test('card cancellation terminates the run without changing settings', async () => {
  const fixture = makeContext()
  await maybeHandleToolCapabilityConsent(fixture.context as never, {
    askUserQuestions: (async () => {
      throw new ToolDomainError('user_cancelled', 'cancelled')
    }) as never,
  })

  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.finalized[0].status, 'cancelled')
  assert.equal(fixture.finalized[0].terminalReason, 'cancelled_user')
})

test('host update re-reads the active config, changes one field, and fails closed on fingerprint drift', () => {
  let current = { ...CONFIG, baseUrl: 'https://compatible.example' }
  const saved: AIModelConfig[] = []
  const repository = {
    getAIConfig: () => current,
    setAIConfig: (config: AIModelConfig) => {
      saved.push(config)
      current = config
    },
  }
  const request = { mode: 'on' as const, expectedFingerprint: fingerprintAIConfig(current) }

  assert.deepEqual(updateActiveToolUseMode(repository, request), {
    applied: true,
    previousMode: 'auto',
    alreadyEnabled: false,
  })
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], {
    ...CONFIG,
    baseUrl: 'https://compatible.example',
    toolUseMode: 'on',
  })

  current = { ...current, model: 'different-model' }
  assert.deepEqual(updateActiveToolUseMode(repository, request), {
    applied: false,
    reason: 'config_changed',
  })
  assert.equal(saved.length, 1)
})

test('host update rejects a different active profile even when endpoint and model match', () => {
  let activeProfileId = 'profile-a'
  let current = { ...CONFIG }
  const saved: AIModelConfig[] = []
  const repository = {
    getAIConfig: () => current,
    getActiveAIProfileId: () => activeProfileId,
    setAIConfig: (config: AIModelConfig) => {
      saved.push(config)
      current = config
    },
  }
  const request = {
    mode: 'on' as const,
    expectedFingerprint: fingerprintAIConfig(current, activeProfileId),
  }

  activeProfileId = 'profile-b'
  assert.deepEqual(updateActiveToolUseMode(repository, request), {
    applied: false,
    reason: 'config_changed',
  })
  assert.deepEqual(saved, [])
})

test('consent flow stays dormant without both a provider conflict and disabled tool support', async () => {
  const noConflict = makeContext({ conflicts: [] })
  const enabled = makeContext({ supportsToolCalls: true })
  let asks = 0
  const ask = (async () => {
    asks += 1
    return answerOutput(TOOL_CALLING_ENABLE_OPTION)
  }) as never

  assert.equal(await maybeHandleToolCapabilityConsent(noConflict.context as never, { askUserQuestions: ask }), null)
  assert.equal(await maybeHandleToolCapabilityConsent(enabled.context as never, { askUserQuestions: ask }), null)
  assert.equal(asks, 0)
})
