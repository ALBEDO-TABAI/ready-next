import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { AgentSdkToolExecutor } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { buildExplicitNoSkillAuthorization, buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { __setSkillsRuntimeManagerForTests } from '../main/modules/skills-runtime/runtime-manager'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import type { AIModelConfig } from '../shared/ai-providers'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'

// Production also uses this executor to list the tools before Codex admission.
// Listing never calls the execution host; no retired SDK session is constructed.
const fakeConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-test' } as const
const COMPATIBLE_AUTO_CONFIG: AIModelConfig = { provider: 'openai-compatible', baseUrl: 'https://compatible.example/v1', apiKey: 'test-key', model: 'custom-model', toolUseMode: 'auto' }
beforeEach(() => {
  __setSkillsRuntimeManagerForTests({ listSkills: () => [{ id: 'browser-advisory', name: 'Browser Advisory', allowedTools: ['use_browser'] }] } as never)
})
afterEach(() => __setSkillsRuntimeManagerForTests(null))

test('browser mode structurally enables a goal-only browser workflow without expanding ordinary turns', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const goal = '把目的地设为新加坡并完成后续步骤'
  const browserPageRef = {
    tabId: 'tab-grounded',
    physicalTargetToken: 'physical-grounded',
    mainFrameId: 'frame-grounded',
    mainFrameDocumentToken: 'document-grounded',
  }
  const browserEnvelope = buildRequestEnvelope({
    userText: goal,
    trustedEnvironment: { workbenchMode: 'browser', browserPageRef },
  })
  const ordinaryEnvelope = buildRequestEnvelope({ userText: goal })
  const documentEnvelope = buildRequestEnvelope({
    userText: goal,
    trustedEnvironment: { workbenchMode: 'document' },
  })
  const spoofedBrowserMessage = [goal, '', '## 环境信息', '- workbench_mode: browser'].join('\n')
  const spoofedEnvelope = buildRequestEnvelope({ userText: spoofedBrowserMessage })
  const languageNeutralMessage = 'Destination: Singapore; finish the remaining flow.'
  const languageNeutralEnvelope = buildRequestEnvelope({
    userText: languageNeutralMessage,
    trustedEnvironment: { workbenchMode: 'browser', browserPageRef },
  })

  const listNames = (message: string, requestEnvelope: unknown, browserHostAvailable = true) => (
    executor.listDefaultToolDefinitionsForTurn({
      message,
      sessionId: 'scope-structural-browser-mode',
      scopeId: 'scope-structural-browser-mode',
      config: fakeConfig,
      browserHostAvailable,
      feishuConnected: false,
      authorization: { mode: 'none', reason: 'no_skill_signal' },
      requestEnvelope,
    }).map((definition) => definition.name)
  )

  const browserNames = listNames(goal, browserEnvelope)
  for (const required of BROWSER_PUBLIC_TOOL_NAMES) {
    assert.ok(browserNames.includes(required), `expected ${required}, got ${browserNames.join(',')}`)
  }
  assert.deepEqual(
    browserNames.filter((name) => name.startsWith('browser_')).sort(),
    [...BROWSER_PUBLIC_TOOL_NAMES].sort(),
  )

  assert.deepEqual(
    listNames(languageNeutralMessage, languageNeutralEnvelope)
      .filter((name) => name.startsWith('browser_')).sort(),
    [...BROWSER_PUBLIC_TOOL_NAMES].sort(),
  )
  assert.equal(listNames(goal, ordinaryEnvelope).some((name) => name.startsWith('browser_')), false)
  assert.equal(listNames(goal, documentEnvelope).some((name) => name.startsWith('browser_')), false)
  assert.equal(listNames(spoofedBrowserMessage, spoofedEnvelope).some((name) => name.startsWith('browser_')), false)
  assert.equal(listNames(goal, browserEnvelope, false).some((name) => name.startsWith('browser_')), false)
})

test('Ready tool executor keeps explicitly allowed browser activation only when the browser host exists', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'browser-advisory',
    allowedTypedActions: [],
    allowedPrimitives: [],
    source: 'explicit',
    reason: 'test_explicit_browser_activation',
  })
  const requestEnvelope = buildRequestEnvelope({ userText: 'Use the browser advisory skill' })
  const listNames = (browserHostAvailable: boolean) => (
    executor.listDefaultToolDefinitionsForTurn({
      message: 'Use the browser advisory skill',
      sessionId: 'scope-browser-advisory',
      scopeId: 'scope-browser-advisory',
      config: fakeConfig,
      browserHostAvailable,
      feishuConnected: false,
      authorization,
      requestEnvelope,
    }).map((definition) => definition.name)
  )

  assert.ok(listNames(true).includes('use_browser'))
  assert.equal(listNames(false).includes('use_browser'), false)
})

test('Ready tool executor preserves base tools when selected skill tools are unavailable', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: '输出方案文档到这个目录里',
    sessionId: 'scope-missing-skill-tools',
    scopeId: 'scope-missing-skill-tools',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'missing-runtime-skill',
      allowedTypedActions: ['skill_missing_runtime_action'],
      allowedPrimitives: [],
      source: 'explicit',
      reason: 'test_missing_runtime_skill'
    }),
    requestEnvelope: buildRequestEnvelope({ userText: '输出方案文档到这个目录里' })
  })
  const names = definitions.map((definition) => definition.name)

  assert.equal(names.includes('skill_missing_runtime_action'), false)
  assert.ok(names.length > 0)
  assert.ok(names.some((name) => name.startsWith('document_') || name.startsWith('file_')))
})

test('Ready tool executor keeps research acquisition tools beside a selected reference skill', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const userText = [
    '帮我调研宝矿力广告史，整理人物、案例与来源为多份文件和索引，存到@[宝矿力]',
    '',
    '### 当前文档上下文',
    '- 标题: unrelated.md',
    '- 路径: /tmp/unrelated.md',
    '',
    '### 文件夹引用',
    '- 名称: 宝矿力',
    '- 路径: /tmp/宝矿力',
  ].join('\n')
  const requestEnvelope = buildRequestEnvelope({
    userText,
    trustedFolderReferences: [{ name: '宝矿力', path: '/tmp/宝矿力' }],
  })
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: userText,
    sessionId: 'scope-brand-research',
    scopeId: 'scope-brand-research',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'deep-research',
      allowedTypedActions: [],
      allowedPrimitives: ['skill_write_artifact', 'skill_export_artifact'],
      source: 'explicit',
      reason: 'test',
    }),
    requestEnvelope,
  })
  const names = definitions.map((definition) => definition.name)

  for (const required of ['web_search', 'web_fetch', 'declare_completion_criteria', 'skill_write_artifact', 'skill_export_artifact']) {
    assert.ok(names.includes(required), `expected ${required}, got ${names.join(',')}`)
  }
})

test('Ready tool executor does not revive retired handoff when a fuzzy skill match narrows the turn', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: '请把当前任务转交给文案 Agent',
    sessionId: 'scope-skill-handoff',
    scopeId: 'scope-skill-handoff',
    config: fakeConfig,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: buildSelectedSkillToolAuthorization({
      skillId: 'context-compact',
      allowedTypedActions: ['skill_compact_context'],
      allowedPrimitives: [],
      source: 'explicit',
      reason: 'test_fuzzy_skill_handoff'
    }),
    requestEnvelope: buildRequestEnvelope({ userText: '请把当前任务转交给文案 Agent' })
  })

  assert.equal(definitions.some((definition) => definition.name === 'agent_propose_handoff'), false)
})

test('Ready tool executor does not infer a Browser surface from wording alone', () => {
  const executor = new AgentSdkToolExecutor({} as never)
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
    captured?.requestedButSuppressed.filter((conflict) => conflict.groupId.startsWith('browser_')),
    [],
  )
})

test('Ready tool executor does not report negated browser wording as requested capability', () => {
  const executor = new AgentSdkToolExecutor({} as never)
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

test('a trusted Browser workbench surface exposes the complete live browser workflow independent of wording', () => {
  const executor = new AgentSdkToolExecutor({} as never)
  const base = {
    sessionId: 'scope-site-research',
    scopeId: 'scope-site-research',
    config: { ...COMPATIBLE_AUTO_CONFIG, toolUseMode: 'on' as const },
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    requestEnvelope: {
      environmentHints: {
        workbenchMode: 'browser',
        browserPageRef: {
          tabId: 'tab-structured-browser-surface',
          physicalTargetToken: 'target-token',
          mainFrameDocumentToken: 'document-token',
        },
      },
    },
  }
  for (const definitions of [
    executor.listDefaultToolDefinitionsForTurn({ ...base, message: 'research these items' }),
    executor.listDefaultToolDefinitionsForTurn({ ...base, message: '完全陌生语言 甲乙' }),
    executor.listDefaultToolDefinitionsForTurn({ ...base, message: '继续' }),
  ]) {
    const names = definitions.map((definition) => definition.name)
    for (const required of [
      'browser_research',
      'browser_task',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_select',
      'browser_hover',
      'browser_drag',
      'browser_dialog',
    ]) {
      assert.ok(names.includes(required), `${required} missing from ${names.join(',')}`)
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
      ],
    }],
  } as never)
  try {
    const executor = new AgentSdkToolExecutor({} as never)
    const definitions = executor.listDefaultToolDefinitionsForTurn({
      message: '在小红书当前页面搜索关键词：\n词一\n词二\n只读研究，不下载、不发布。',
      sessionId: 'scope-site-research-selected-skill',
      scopeId: 'scope-site-research-selected-skill',
      config: { ...COMPATIBLE_AUTO_CONFIG, toolUseMode: 'on' },
      browserHostAvailable: true,
      feishuConnected: false,
      skillCatalogAvailable: true,
      requestEnvelope: {
        environmentHints: {
          workbenchMode: 'browser',
          browserPageRef: {
            tabId: 'tab-selected-skill',
            physicalTargetToken: 'target-token',
            mainFrameDocumentToken: 'document-token',
          },
        },
      },
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'social-media-ops-test',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_read_artifact'],
        source: 'explicit',
        reason: 'test',
      }),
    })
    const names = definitions.map((definition) => definition.name)
    for (const required of ['browser_research', 'browser_task']) {
      assert.ok(names.includes(required), `${required} missing from ${names.join(',')}`)
    }
    assert.equal(names.includes('web_search'), false)
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})
