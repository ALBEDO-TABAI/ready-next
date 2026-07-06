import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import type { AIModelConfig } from '../shared/ai-providers'
import type { BrowserTaskDecisionMode } from '../shared/browser-agent-task'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import {
  prepareInitialRun,
  reconcileAfterBrowserDecision,
} from '../main/modules/agent-control/domain-adapters/run-capability-controller'
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  clearLastReferenceSkill,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import {
  resolveExecutionIntentContext,
  resolveIntentCapabilityGroupModes,
  type ExecutionIntentContext,
} from '../main/modules/agent-control/execution-intent-resolver'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

const VISION_DENIED_CONFIG: AIModelConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'unknown-model',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

type CapabilityCase = {
  name: string
  userText: string
  browserDecisionMode: BrowserTaskDecisionMode
  config?: AIModelConfig
  authorization?: SkillToolAuthorization
  preferredSkillToolNames?: string[] | null
  context?: Partial<ExecutionIntentContext>
  expectedToolPolicy?: {
    allowBrowserTools?: boolean
    allowDocumentTools?: boolean
    preferredSkillToolNames?: string[] | null
  }
  expectedArbitration?: {
    resolutionAppliedIncludes?: string
  }
}

function buildContext(userText: string, overrides: Partial<ExecutionIntentContext> = {}): ExecutionIntentContext {
  const requestEnvelope = buildRequestEnvelope({ userText })
  return {
    requestEnvelope,
    intentClassification: classifyIntent(requestEnvelope),
    contextualUserInput: requestEnvelope.primaryInstruction,
    userInstructionText: requestEnvelope.primaryInstruction,
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    ...overrides,
  }
}

function buildControllerResolution(testCase: CapabilityCase) {
  return prepareInitialRun({
    config: testCase.config || BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: testCase.preferredSkillToolNames ?? null,
    authorization: testCase.authorization || buildExplicitNoSkillAuthorization('no_skill_signal'),
    executionIntentContext: buildContext(testCase.userText, testCase.context),
    browserDecisionMode: testCase.browserDecisionMode,
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    hostContext: {
      userText: testCase.userText,
    },
  })
}

function listLiveSdkDefaultToolNames(input: {
  userText: string
  sessionId?: string
  requestEnvelope?: unknown
  authorization?: SkillToolAuthorization
}): string[] {
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
  })
  const privateRuntime = runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: AIModelConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: SkillToolAuthorization
        requestEnvelope?: unknown
      }) => Array<{ name: string }>
    }
  }
  return privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
    message: input.userText,
    sessionId: input.sessionId || 'scope-live-sdk-parity',
    scopeId: input.sessionId || 'scope-live-sdk-parity',
    config: BASE_CONFIG,
    browserHostAvailable: true,
    feishuConnected: true,
    authorization: input.authorization || buildExplicitNoSkillAuthorization('p9c_live_sdk_tool_list'),
    requestEnvelope: input.requestEnvelope,
  }).map((definition) => definition.name).sort()
}

function buildSdkShapedResolution(testCase: CapabilityCase): CapabilityResolution {
  const context = buildContext(testCase.userText, testCase.context)
  const intentModes = resolveIntentCapabilityGroupModes({
    hasTools: true,
    capabilityProfile: 'local_chat',
    contextualUserInput: context.contextualUserInput,
    userInstructionText: context.userInstructionText,
    intentClassification: context.intentClassification,
    hasDocumentEnvironment: context.hasDocumentEnvironment,
    hasWidgetTargetContext: context.hasWidgetTargetContext,
    explicitWidgetCreateIntent: context.explicitWidgetCreateIntent,
    documentWidgetTaskKind: context.documentWidgetTaskKind,
    preferredSkillToolNames: testCase.preferredSkillToolNames ?? null,
    mapSemanticIntent: context.mapSemanticIntent,
  })
  return resolveCapabilityResolution({
    config: testCase.config || BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: testCase.browserDecisionMode,
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    intentGroupModes: intentModes.intentGroupModes,
  })
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function assertCapabilityResolutionParity(
  label: string,
  controller: CapabilityResolution,
  sdk: CapabilityResolution,
): void {
  assert.deepEqual(
    sorted(controller.visibleCapabilityGroupIds),
    sorted(sdk.visibleCapabilityGroupIds),
    `${label}: visible capability groups drifted`,
  )
  assert.deepEqual(
    sorted(controller.suppressedCapabilityGroupIds),
    sorted(sdk.suppressedCapabilityGroupIds),
    `${label}: suppressed capability groups drifted`,
  )
  assert.deepEqual(
    sorted(controller.hostOnlyCapabilityIds),
    sorted(sdk.hostOnlyCapabilityIds),
    `${label}: host-only capability groups drifted`,
  )
  assert.equal(controller.supportsVision === true, sdk.supportsVision === true, `${label}: supportsVision drifted`)

  for (const groupId of Object.keys(controller.groupStates) as CapabilityGroupId[]) {
    assert.equal(
      controller.groupStates[groupId]?.status,
      sdk.groupStates[groupId]?.status,
      `${label}: ${groupId} status drifted`,
    )
    assert.equal(
      controller.groupStates[groupId]?.reason,
      sdk.groupStates[groupId]?.reason,
      `${label}: ${groupId} reason drifted`,
    )
  }
}

function assertControllerToolPolicy(
  testCase: CapabilityCase,
  controller: ReturnType<typeof buildControllerResolution>,
): void {
  const expected = testCase.expectedToolPolicy
  if (!expected) return
  if (typeof expected.allowBrowserTools === 'boolean') {
    assert.equal(
      controller.toolPolicy.allowBrowserTools,
      expected.allowBrowserTools,
      `${testCase.name}: controller allowBrowserTools drifted`,
    )
  }
  if (typeof expected.allowDocumentTools === 'boolean') {
    assert.equal(
      controller.toolPolicy.allowDocumentTools,
      expected.allowDocumentTools,
      `${testCase.name}: controller allowDocumentTools drifted`,
    )
  }
  if ('preferredSkillToolNames' in expected) {
    assert.deepEqual(
      controller.toolPolicy.preferredSkillToolNames,
      expected.preferredSkillToolNames,
      `${testCase.name}: controller preferredSkillToolNames drifted`,
    )
  }
}

const SELECTED_SKILL_AUTHORIZATION = buildSelectedSkillToolAuthorization({
  skillId: 'video-copy-analyzer',
  allowedTypedActions: [],
  allowedPrimitives: ['skill_ask_user'],
  source: 'explicit',
  reason: 'p6e_parity_test',
})

const parityCases: CapabilityCase[] = [
  {
    name: 'free tool loop without browser intent',
    userText: '你好，先简单回答一句',
    browserDecisionMode: 'free_tool_loop',
    expectedToolPolicy: {
      allowBrowserTools: false,
      allowDocumentTools: false,
      preferredSkillToolNames: null,
    },
  },
  {
    name: 'browser workflow exposes browser interaction and content tasks',
    userText: '打开网页并提取列表里的字段',
    browserDecisionMode: 'browser_workflow',
    expectedToolPolicy: {
      allowBrowserTools: true,
      allowDocumentTools: false,
      preferredSkillToolNames: null,
    },
  },
  {
    name: 'browser upload workflow exposes interaction and power/content tasks',
    userText: '去网页上传这张图片',
    browserDecisionMode: 'browser_upload_workflow',
    expectedToolPolicy: {
      allowBrowserTools: true,
      allowDocumentTools: false,
      preferredSkillToolNames: null,
    },
  },
  {
    name: 'selected skill exposes skill capability',
    userText: '@[Video Copy Analyzer] 分析这个视频文案',
    browserDecisionMode: 'free_tool_loop',
    preferredSkillToolNames: ['skill_ask_user'],
    authorization: SELECTED_SKILL_AUTHORIZATION,
    expectedToolPolicy: {
      allowBrowserTools: false,
      allowDocumentTools: false,
      preferredSkillToolNames: ['skill_ask_user'],
    },
  },
  {
    name: 'research intent exposes general research capability',
    userText: '比较北京几个 IT 园区的产业特色和适合入驻的公司类型',
    browserDecisionMode: 'free_tool_loop',
    expectedToolPolicy: {
      allowBrowserTools: false,
      allowDocumentTools: false,
      preferredSkillToolNames: null,
    },
  },
  {
    name: 'vision-denied config stays conservative on both paths',
    userText: '你好，先简单回答一句',
    browserDecisionMode: 'free_tool_loop',
    config: VISION_DENIED_CONFIG,
    expectedToolPolicy: {
      allowBrowserTools: false,
      allowDocumentTools: false,
      preferredSkillToolNames: null,
    },
  },
  {
    name: 'document widget arbitration demotes browser workflow',
    userText: '把当前信息卡的标题字号调大一点',
    browserDecisionMode: 'browser_workflow',
    context: {
      hasWidgetTargetContext: true,
      documentWidgetTaskKind: 'update',
    },
    expectedToolPolicy: {
      allowBrowserTools: false,
      allowDocumentTools: true,
      preferredSkillToolNames: null,
    },
    expectedArbitration: {
      resolutionAppliedIncludes: 'demote_browser_decision:browser_workflow->free_tool_loop',
    },
  },
]

test('P6e keeps controller and SDK-shaped capability resolution in parity for representative turns', () => {
  for (const testCase of parityCases) {
    const controller = buildControllerResolution(testCase)
    const sdk = buildSdkShapedResolution({
      ...testCase,
      browserDecisionMode: testCase.expectedArbitration ? 'free_tool_loop' : testCase.browserDecisionMode,
    })

    assertCapabilityResolutionParity(testCase.name, controller.capabilityResolution, sdk)
    assertControllerToolPolicy(testCase, controller)

    if (testCase.expectedArbitration?.resolutionAppliedIncludes) {
      assert.ok(
        controller.arbitration.resolutionApplied.includes(testCase.expectedArbitration.resolutionAppliedIncludes),
        `${testCase.name}: expected arbitration marker missing`,
      )
    }
  }
})

test('P6e documents the SDK default-tools boundary for collection exposure', () => {
  const sdkCollection = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    intentGroupModes: {
      browser_interaction: true,
      browser_content_tasks: true,
    },
  })

  assert.ok(sdkCollection.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(sdkCollection.visibleCapabilityGroupIds.includes('browser_content_tasks'))
  assert.equal(sdkCollection.groupStates.browser_interaction.reason, 'enabled')
  assert.equal(sdkCollection.groupStates.browser_content_tasks.reason, 'enabled')
})

test('P9C checks the live SDK default tool list exposes only the collection subset', () => {
  const userText = [
    '继续采集',
    '',
    '### 浏览页面引用',
    '标题: 示例页面',
    'URL: https://example.test/',
  ].join('\n')
  const toolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: buildRequestEnvelope({ userText }),
  })

  assert.ok(toolNames.includes('browser_visible_collect'))
  assert.ok(toolNames.includes('ask_user_questions'))
  assert.equal(toolNames.includes('browser_click'), false)
  assert.equal(toolNames.includes('browser_type'), false)
})

test('P9C exposes browser resource tools for webpage video download requests', () => {
  const userText = '看看能不能把网页的视频下载到@[整蛊广告]'
  const toolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: buildRequestEnvelope({ userText }),
  })

  assert.ok(toolNames.includes('browser_inspect_resources'))
  assert.ok(toolNames.includes('browser_resolve_video'))
  assert.ok(toolNames.includes('browser_download_urls'))
  assert.equal(toolNames.includes('browser_type'), false)
  assert.equal(toolNames.includes('browser_execute_js'), false)
})

test('P9C keeps browser resource tools when a reference skill is selected', () => {
  const userText = '看看能不能把网页的视频下载到@[整蛊广告]'
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'obsidian-web-clip',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact', 'skill_export_artifact'],
    source: 'active_task',
    reason: 'reference_hint',
  })
  const toolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: buildRequestEnvelope({ userText }),
    authorization,
  })

  assert.ok(toolNames.includes('skill_read_artifact'))
  assert.ok(toolNames.includes('skill_write_artifact'))
  assert.ok(toolNames.includes('skill_export_artifact'))
  assert.ok(toolNames.includes('browser_inspect_resources'))
  assert.ok(toolNames.includes('browser_resolve_video'))
  assert.ok(toolNames.includes('browser_download_urls'))
  assert.equal(toolNames.includes('browser_type'), false)
  assert.equal(toolNames.includes('browser_execute_js'), false)
})

test('P9C keeps full browser tools for publish continuations with a reference skill selected', () => {
  const userText = [
    '## 最近会话摘要',
    '上一轮用户要：在小红书网页发布一篇笔记。',
    '',
    '### 浏览页面引用',
    '标题: 小红书创作服务平台',
    'URL: https://creator.xiaohongshu.com/publish/publish',
    '',
    '用户: 继续',
  ].join('\n')
  const requestEnvelope = {
    primaryInstruction: '继续',
    rawUserText: userText,
    resources: [],
  }
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'extract',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact', 'skill_export_artifact'],
    source: 'active_task',
    reason: 'reference_hint',
  })
  const toolNames = listLiveSdkDefaultToolNames({ userText, requestEnvelope, authorization })

  assert.ok(toolNames.includes('skill_read_artifact'))
  assert.ok(toolNames.includes('skill_write_artifact'))
  assert.ok(toolNames.includes('browser_navigate'))
  assert.ok(toolNames.includes('browser_click'))
  assert.ok(toolNames.includes('browser_type'))
  assert.ok(toolNames.includes('browser_capture_viewport'))
  assert.ok(toolNames.includes('browser_power_eval'))
  assert.ok(toolNames.includes('browser_power_cdp'))
})

test('P9C bare retry keeps resource tools despite upload words in recalled context', () => {
  const userText = [
    '## 环境信息',
    '文件管理已授权目录：/Users/user/实验田/测试/lib-a',
    '',
    '## 最近会话摘要',
    '今日已完结：浏览器上传流程 failed',
    '上一轮用户要：看看能不能把网页的视频下载到@[整蛊广告]',
    '',
    '用户: 再试一次',
  ].join('\n')
  const requestEnvelope = {
    primaryInstruction: '再试一次',
    rawUserText: userText,
    resources: [],
  }
  const toolNames = listLiveSdkDefaultToolNames({ userText, requestEnvelope })

  assert.ok(toolNames.includes('browser_inspect_resources'))
  assert.ok(toolNames.includes('browser_resolve_video'))
  assert.ok(toolNames.includes('browser_download_urls'))
  assert.equal(toolNames.includes('browser_list_upload_targets'), false)
  assert.equal(toolNames.includes('browser_upload_scope_attachment'), false)
  assert.equal(toolNames.includes('browser_click'), false)
})

test('selected reference-skill authorization exposes export artifact for target-folder delivery', () => {
  const userText = '@[hfp-space-design]生成一版洞穴风门店设计方案，输出到@[hfp空间方案]，文件名 ready-hfp-regression-洞穴风.md。不要追问，直接保存完整文档。'
  const requestEnvelope = buildRequestEnvelope({ userText })
  const sessionId = 'scope-hfp-space-design'
  clearLastReferenceSkill(sessionId)
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [{ id: 'hfp-space-design', name: 'hfp-space-design' }],
      buildPreferredSkillToolNames: () => [
        'skill_ask_user',
        'skill_write_artifact',
        'skill_read_artifact',
        'skill_export_artifact',
      ],
      rememberExplicitReferenceSkillHint: () => rememberLastReferenceSkill(sessionId, {
        id: 'hfp-space-design',
        name: 'hfp-space-design',
      }),
      getCurrentReferenceSkillHint: () => ({ id: 'hfp-space-design', name: 'hfp-space-design' }),
    } as any,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
    ) => SkillToolAuthorization
  }

  try {
    const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
      userText,
      sessionId,
      requestEnvelope,
    )
    if (authorization.mode !== 'selected') {
      assert.fail(`expected selected authorization, got ${authorization.mode}`)
    }
    assert.equal(authorization.allowedPrimitives.has('skill_write_artifact'), true)
    assert.equal(authorization.allowedPrimitives.has('skill_export_artifact'), true)
    assert.equal(authorization.allowedPrimitives.has('skill_ask_user'), false)

    const toolNames = listLiveSdkDefaultToolNames({
      userText,
      sessionId,
      requestEnvelope,
      authorization,
    })
    assert.ok(toolNames.includes('skill_write_artifact'))
    assert.ok(toolNames.includes('skill_export_artifact'))
    assert.equal(toolNames.includes('skill_ask_user'), false)
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('selected reference-skill authorization exposes authorized primitives without legacy hint', () => {
  const userText = '@[hfp-space-design]先只问我做线下门店方案还需要哪些补充信息，不要生成方案。'
  const sessionId = 'scope-hfp-no-legacy-hint'
  clearLastReferenceSkill(sessionId)
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'hfp-space-design',
    allowedTypedActions: [],
    allowedPrimitives: [
      'skill_ask_user',
      'skill_write_artifact',
      'skill_read_artifact',
      'skill_export_artifact',
      'skill_inspect_run_state',
    ],
    source: 'explicit',
    reason: 'explicit_user_mention',
  })

  try {
    const toolNames = listLiveSdkDefaultToolNames({
      userText,
      sessionId,
      requestEnvelope: buildRequestEnvelope({ userText }),
      authorization,
    })

    assert.ok(toolNames.includes('skill_ask_user'))
    assert.ok(toolNames.includes('skill_read_artifact'))
    assert.ok(toolNames.includes('skill_write_artifact'))
    assert.ok(toolNames.includes('skill_export_artifact'))
    assert.equal(getLastReferenceSkill(sessionId), null)
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('SDK authorization uses raw user text when primary instruction strips explicit skill mention', () => {
  const rawUserText = '@[hfp-space-design]生成一版岩洞晨光风线下门店设计方案，输出到@[hfp空间方案]'
  const primaryInstruction = '生成一版岩洞晨光风线下门店设计方案，输出到 hfp空间方案'
  const sessionId = 'scope-hfp-raw-skill-mention'
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText,
    pureUserText: primaryInstruction,
    primaryInstruction,
    resources: [{
      id: 'folder-hfp',
      kind: 'folder_reference',
      source: 'folder_reference',
      name: 'hfp空间方案',
      path: '/tmp/hfp空间方案',
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: true,
    }],
  }
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('@[hfp-space-design]')
          ? [{ id: 'hfp-space-design', name: 'hfp-space-design' }]
          : [],
      buildPreferredSkillToolNames: (text: string) =>
        text.includes('@[hfp-space-design]')
          ? ['skill_ask_user', 'skill_write_artifact', 'skill_read_artifact', 'skill_export_artifact']
          : [],
      rememberExplicitReferenceSkillHint: (text: string, sid?: string) => {
        if (!text.includes('@[hfp-space-design]')) return false
        rememberLastReferenceSkill(sid, { id: 'hfp-space-design', name: 'hfp-space-design' })
        return true
      },
      getCurrentReferenceSkillHint: (sid?: string) => {
        const hint = getLastReferenceSkill(sid)
        return hint ? { id: hint.id, name: hint.name } : null
      },
    } as any,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
    ) => SkillToolAuthorization
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: AIModelConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: SkillToolAuthorization
        requestEnvelope?: unknown
      }) => Array<{ name: string }>
    }
  }

  try {
    const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
      primaryInstruction,
      sessionId,
      requestEnvelope,
    )
    assert.equal(authorization.mode, 'selected')
    assert.equal(getLastReferenceSkill(sessionId)?.id, 'hfp-space-design')
    const toolNames = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
      message: primaryInstruction,
      sessionId,
      scopeId: sessionId,
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: false,
      authorization,
      requestEnvelope,
    }).map((definition) => definition.name)
    assert.ok(toolNames.includes('skill_read_artifact'))
    assert.ok(toolNames.includes('skill_write_artifact'))
    assert.ok(toolNames.includes('skill_export_artifact'))
    assert.equal(toolNames.includes('skill_ask_user'), false)
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('SDK authorization keeps raw skill mention when attachment context strips ready-human-touch token', () => {
  const rawUserText = [
    '用@[BV1vs411e7QF_audiovisual_analysis.md]的内容来生成一个人文感风格 ppt 在相同目录下@[ready-human-touch-ppt]',
    '',
    '--- 附件: BV1vs411e7QF_audiovisual_analysis.md ---',
    '- 路径: /tmp/BV1vs411e7QF_audiovisual_analysis.md',
  ].join('\n')
  const primaryInstruction = '用 BV1vs411e7QF_audiovisual_analysis.md 的内容来生成一个人文感风格 ppt 在相同目录下'
  const sessionId = 'scope-ready-human-touch-raw-skill-mention'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText,
    pureUserText: primaryInstruction,
    primaryInstruction,
    resources: [{
      id: 'attach-analysis',
      kind: 'file_reference',
      source: 'attachment',
      name: 'BV1vs411e7QF_audiovisual_analysis.md',
      path: '/tmp/BV1vs411e7QF_audiovisual_analysis.md',
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: true,
    }],
  }
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt', managedPath: skillRoot }]
          : [],
      buildPreferredSkillToolNames: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? ['skill_ask_user', 'skill_run_shell', 'skill_write_artifact', 'skill_read_artifact', 'skill_export_artifact']
          : [],
      rememberExplicitReferenceSkillHint: (text: string, sid?: string) => {
        if (!text.includes('ready-human-touch-ppt')) return false
        rememberLastReferenceSkill(sid, { id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt' })
        return true
      },
      getCurrentReferenceSkillHint: (sid?: string) => {
        const hint = getLastReferenceSkill(sid)
        return hint ? { id: hint.id, name: hint.name } : null
      },
    } as any,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
    ) => SkillToolAuthorization
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: AIModelConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: SkillToolAuthorization
        requestEnvelope?: unknown
      }) => Array<{ name: string }>
    }
  }

  try {
    const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
      primaryInstruction,
      sessionId,
      requestEnvelope,
    )
    assert.equal(authorization.mode, 'selected')
    assert.equal(authorization.skillId, 'ready-human-touch-ppt')
    assert.equal(authorization.allowedPrimitives.has('skill_run_shell'), true)
    assert.equal(authorization.allowedPrimitives.has('skill_ask_user'), false)

    const toolNames = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
      message: primaryInstruction,
      sessionId,
      scopeId: sessionId,
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: false,
      authorization,
      requestEnvelope,
    }).map((definition) => definition.name)
    assert.ok(toolNames.includes('skill_run_shell'))
    assert.ok(toolNames.includes('skill_read_artifact'))
    assert.ok(toolNames.includes('skill_write_artifact'))
    assert.ok(toolNames.includes('skill_export_artifact'))
    assert.equal(toolNames.includes('skill_ask_user'), false)
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('explicit skill turn with local document attachment keeps document-read floor tools', () => {
  const rawUserText = [
    '用@[BV1vs411e7QF_audiovisual_analysis.md]的内容来生成一个人文感风格 ppt 在相同目录下@[ready-human-touch-ppt]',
    '',
    '--- 附件: BV1vs411e7QF_audiovisual_analysis.md ---',
    '- 路径: /tmp/BV1vs411e7QF_audiovisual_analysis.md',
  ].join('\n')
  const primaryInstruction = '用 BV1vs411e7QF_audiovisual_analysis.md 的内容来生成一个人文感风格 ppt 在相同目录下'
  const sessionId = 'scope-ready-human-touch-doc-read-floor'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText,
    pureUserText: primaryInstruction,
    primaryInstruction,
    resources: [{
      id: 'attach-analysis',
      kind: 'file_reference',
      source: 'attachment',
      name: 'BV1vs411e7QF_audiovisual_analysis.md',
      path: '/tmp/BV1vs411e7QF_audiovisual_analysis.md',
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: true,
    }],
  }
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt', managedPath: skillRoot }]
          : [],
      buildPreferredSkillToolNames: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? ['skill_ask_user', 'skill_run_shell', 'skill_write_artifact', 'skill_read_artifact', 'skill_export_artifact']
          : [],
      rememberExplicitReferenceSkillHint: (text: string, sid?: string) => {
        if (!text.includes('ready-human-touch-ppt')) return false
        rememberLastReferenceSkill(sid, { id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt' })
        return true
      },
      getCurrentReferenceSkillHint: (sid?: string) => {
        const hint = getLastReferenceSkill(sid)
        return hint ? { id: hint.id, name: hint.name } : null
      },
    } as any,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
    ) => SkillToolAuthorization
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: AIModelConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: SkillToolAuthorization
        requestEnvelope?: unknown
      }) => Array<{ name: string }>
    }
  }

  try {
    const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
      primaryInstruction,
      sessionId,
      requestEnvelope,
    )
    assert.equal(authorization.mode, 'selected')
    assert.equal(authorization.skillId, 'ready-human-touch-ppt')
    assert.equal(authorization.allowedPrimitives.has('skill_run_shell'), true)
    assert.equal(authorization.allowedPrimitives.has('skill_ask_user'), false)

    const toolNames = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
      message: primaryInstruction,
      sessionId,
      scopeId: sessionId,
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: false,
      authorization,
      requestEnvelope,
    }).map((definition) => definition.name)
    assert.ok(toolNames.includes('skill_run_shell'))
    assert.ok(toolNames.includes('skill_read_artifact'))
    assert.ok(toolNames.includes('skill_write_artifact'))
    assert.ok(toolNames.includes('skill_export_artifact'))
    assert.equal(toolNames.includes('skill_ask_user'), false)
    const names = new Set(toolNames)
    assert.ok(names.has('file_read_excerpt'), 'doc-read floor: file_read_excerpt must survive skill narrowing')
    assert.ok(names.has('file_locate'), 'doc-read floor: file_locate must survive skill narrowing')
    assert.ok(names.has('skill_read_artifact') && names.has('skill_run_shell'), 'skill tools must stay')
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('document-context continuation keeps document write tools available for short follow-up turns', () => {
  const userText = [
    '再整理一下这篇',
    '',
    '### 当前文档上下文',
    '- 标题: example.md',
    '- 路径: /tmp/example.md',
    '--- 文档摘要开始 ---',
    '每一句散开一行，不好阅读。',
    '--- 文档摘要结束 ---',
  ].join('\n')
  const requestEnvelope = buildRequestEnvelope({ userText })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: [],
    intentClassification: classifyIntent(requestEnvelope),
  })
  const intentModes = resolveIntentCapabilityGroupModes({
    hasTools: true,
    capabilityProfile: 'local_chat',
    contextualUserInput: context.contextualUserInput,
    userInstructionText: context.userInstructionText,
    intentClassification: context.intentClassification,
    hasDocumentEnvironment: context.hasDocumentEnvironment,
    hasWidgetTargetContext: context.hasWidgetTargetContext,
    explicitWidgetCreateIntent: context.explicitWidgetCreateIntent,
    documentWidgetTaskKind: context.documentWidgetTaskKind,
    preferredSkillToolNames: null,
    mapSemanticIntent: context.mapSemanticIntent,
  })
  const liveToolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope,
  })

  assert.equal(context.hasDocumentEnvironment, true)
  assert.equal(intentModes.allowDocumentTools, true)
  assert.equal(intentModes.forceDocumentTool, true)
  assert.ok(liveToolNames.includes('document_switch_tab'))
  assert.ok(liveToolNames.includes('document_set_content'))
  assert.ok(liveToolNames.includes('document_save_tab'))
})

test('document-context confirmation with subtitle request keeps document write tools available only with document context', () => {
  const plainText = '确认，最好附上子标题'
  const plainTools = listLiveSdkDefaultToolNames({
    userText: plainText,
    requestEnvelope: buildRequestEnvelope({ userText: plainText }),
  })
  const documentText = [
    plainText,
    '',
    '### 当前文档上下文',
    '- 标题: example.md',
    '- 路径: /tmp/example.md',
    '--- 文档摘要开始 ---',
    '整理状态: 待确认',
    '--- 文档摘要结束 ---',
  ].join('\n')
  const documentTools = listLiveSdkDefaultToolNames({
    userText: documentText,
    requestEnvelope: buildRequestEnvelope({ userText: documentText }),
  })

  assert.equal(plainTools.includes('document_set_content'), false)
  assert.equal(plainTools.includes('document_save_tab'), false)
  assert.ok(documentTools.includes('document_set_content'))
  assert.ok(documentTools.includes('document_save_tab'))
})

test('P6e keeps reconcileAfterBrowserDecision parity for late browser upload decisions', () => {
  const prepared = buildControllerResolution({
    name: 'initial upload turn before browser decision',
    userText: '去网页上传这张图片',
    browserDecisionMode: 'free_tool_loop',
  })
  const reconciled = reconcileAfterBrowserDecision({
    prepared,
    browserDecisionMode: 'browser_upload_workflow',
  })
  const uploadContext = buildContext('去网页上传这张图片')
  const sdkUploadIntentModes = resolveIntentCapabilityGroupModes({
    hasTools: true,
    capabilityProfile: 'local_chat',
    contextualUserInput: uploadContext.contextualUserInput,
    userInstructionText: uploadContext.userInstructionText,
    intentClassification: uploadContext.intentClassification,
    hasDocumentEnvironment: uploadContext.hasDocumentEnvironment,
    hasWidgetTargetContext: uploadContext.hasWidgetTargetContext,
    explicitWidgetCreateIntent: uploadContext.explicitWidgetCreateIntent,
    documentWidgetTaskKind: uploadContext.documentWidgetTaskKind,
    preferredSkillToolNames: null,
    mapSemanticIntent: uploadContext.mapSemanticIntent,
  })
  const sdkUpload = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'browser_upload_workflow',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    intentGroupModes: sdkUploadIntentModes.intentGroupModes,
  })

  assertCapabilityResolutionParity('late browser upload reconciliation', reconciled.capabilityResolution, sdkUpload)
  assert.equal(reconciled.toolPolicy.allowBrowserTools, true)
  assert.ok(reconciled.allowedToolNames.includes('browser_click'))
  assert.ok(reconciled.allowedToolNames.includes('browser_extract_structured'))
  assert.ok(reconciled.allowedToolNames.includes('browser_power_eval'))
})
