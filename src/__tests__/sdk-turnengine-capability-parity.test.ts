import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import type { AIModelConfig } from '../shared/ai-providers'
import type { BrowserTaskDecisionMode } from '../shared/browser-agent-task'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import {
  hasCurrentDocumentContextResource,
  hasLocalDocumentResource,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import { computeCapabilityFloors } from '../main/modules/agent-control/domain-adapters/capability-floors'
import { getPolicyOpenAIToolBundle, type ToolPolicy } from '../main/modules/agent-control/tool-policy/execution-tool-config'
import {
  prepareInitialRun,
  reconcileAfterBrowserDecision,
} from '../main/modules/agent-control/domain-adapters/run-capability-controller'
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { resolveSkillHintRelevanceForTurn } from '../main/modules/agent-control/runtime-core/agent-sdk-skill-intent-utils'
import { resolveSemanticSkillAuthorizationForTurn } from '../main/modules/agent-control/runtime-core/skill-turn-authorization-resolver'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
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
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

test.before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
test.after(() => __setScopeContextEpochDatabaseForTests(null))

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

function groundedBrowserEnvelope(userText: string) {
  return buildRequestEnvelope({
    userText,
    trustedEnvironment: {
      workbenchMode: 'browser',
      browserPageRef: {
        tabId: 'tab-live-sdk-parity',
        physicalTargetToken: 'physical-live-sdk-parity',
        mainFrameId: '0',
        mainFrameDocumentToken: 'document-live-sdk-parity',
      },
    },
  })
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

test('live SDK exposes the complete typed Browser surface for a grounded workflow', () => {
  const userText = '打开 https://example.com 并阅读当前页面内容'
  const names = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: groundedBrowserEnvelope(userText),
  }).filter((name) => name.startsWith('browser_'))

  assert.deepEqual(names, [...BROWSER_PUBLIC_TOOL_NAMES].sort())
})

test('live SDK gives a goal-only grounded request the same complete Browser surface', () => {
  const userText = '在网页上替我把目的地设为新加坡并完成后续步骤'
  const names = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: groundedBrowserEnvelope(userText),
  }).filter((name) => name.startsWith('browser_'))

  assert.deepEqual(names, [...BROWSER_PUBLIC_TOOL_NAMES].sort())
})

test('live SDK Browser exposure does not branch on recalled or current request wording', () => {
  const userText = [
    '阅读当前网页',
    '## 最近会话摘要',
    '旧任务曾要求使用 CDP、清理 session 和修改 permission。',
  ].join('\n')
  const names = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: groundedBrowserEnvelope('阅读当前网页'),
  }).filter((name) => name.startsWith('browser_'))

  const explicit = '使用 CDP 查看当前页的 Performance 指标'
  const explicitNames = listLiveSdkDefaultToolNames({
    userText: explicit,
    requestEnvelope: groundedBrowserEnvelope(explicit),
  }).filter((name) => name.startsWith('browser_'))
  assert.deepEqual(names, [...BROWSER_PUBLIC_TOOL_NAMES].sort())
  assert.deepEqual(explicitNames, names)
})

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

test('grounded collection requests keep the complete Browser surface', () => {
  const userText = [
    '继续采集',
    '',
    '### 浏览页面引用',
    '标题: 示例页面',
    'URL: https://example.test/',
  ].join('\n')
  const toolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: groundedBrowserEnvelope(userText),
  })

  assert.ok(toolNames.includes('browser_collect'))
  assert.ok(toolNames.includes('ask_user_questions'))
  assert.ok(toolNames.includes('browser_click'))
  assert.ok(toolNames.includes('browser_type'))
})

test('grounded video requests do not create a wording-specific Browser subset', () => {
  const userText = '看看能不能把网页的视频下载到@[整蛊广告]'
  const toolNames = listLiveSdkDefaultToolNames({
    userText,
    requestEnvelope: groundedBrowserEnvelope(userText),
  })

  assert.ok(toolNames.includes('browser_resources'))
  assert.ok(toolNames.includes('browser_download'))
  assert.ok(toolNames.includes('browser_type'))
  assert.ok(toolNames.includes('browser_eval'))
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
    requestEnvelope: groundedBrowserEnvelope(userText),
    authorization,
  })

  assert.ok(toolNames.includes('skill_read_artifact'))
  assert.ok(toolNames.includes('skill_write_artifact'))
  assert.ok(toolNames.includes('skill_export_artifact'))
  assert.ok(toolNames.includes('browser_resources'))
  assert.ok(toolNames.includes('browser_download'))
  assert.ok(toolNames.includes('browser_type'))
  assert.ok(toolNames.includes('browser_eval'))
})

test('P9C keeps common interaction tools for publish continuations without exposing specialist powers', () => {
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
  const requestEnvelope = groundedBrowserEnvelope('继续')
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
  assert.ok(toolNames.includes('browser_screenshot'))
  assert.ok(toolNames.includes('browser_eval'))
  assert.ok(toolNames.includes('browser_cdp'))
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
  const requestEnvelope = groundedBrowserEnvelope('再试一次')
  const toolNames = listLiveSdkDefaultToolNames({ userText, requestEnvelope })

  assert.ok(toolNames.includes('browser_resources'))
  assert.ok(toolNames.includes('browser_download'))
  assert.ok(toolNames.includes('browser_find'))
  assert.ok(toolNames.includes('browser_upload'))
  assert.ok(toolNames.includes('browser_click'))
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
      messageVisibilityEpoch?: number,
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

test('normal Feishu CLI wording exposes lark-cli as a candidate method, not a code-selected exclusive skill', () => {
  const userText = '用飞书 cli 读一下我名为 测试 0807 的文档，随便新增一列内容并填写一些内容，然后再在我的 第二季度工作总结 文档里润色一下'
  const requestEnvelope = buildRequestEnvelope({ userText })
  const sessionId = 'scope-local-feishu-cli'
  const embeddedSkillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'lark-cli')
  const compiled = compileSkillDefinition({ folderPath: embeddedSkillRoot, source: 'embedded' })
  const larkCli = {
    ...compiled,
    installed: true,
    installStatePath: '',
    managedPath: embeddedSkillRoot,
    manifestValid: true,
  } as any
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [larkCli],
  } as unknown as SkillsRuntimeManager)
  const skillContextOrchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [larkCli],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean,
      skillHintRelevantForTurn?: boolean,
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
      userText,
      sessionId,
      requestEnvelope,
    )
    assert.equal(authorization.mode, 'none')
    if (authorization.mode !== 'none') assert.fail('expected candidate lark-cli authorization')
    assert.equal(authorization.candidateSkillPrimitives?.skillId, 'lark-cli')
    assert.deepEqual(
      [...(authorization.candidateSkillPrimitives?.primitives || [])].sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )

    const toolNames = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
      message: userText,
      sessionId,
      scopeId: sessionId,
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: true,
      authorization,
      requestEnvelope,
    }).map((definition) => definition.name)
    assert.deepEqual(
      toolNames.filter((name) => name.startsWith('skill_')).sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )
    assert.equal(toolNames.includes('run_setup_command'), false)
    assert.equal(toolNames.some((name) => name.startsWith('feishu_')), false)

    const exactNameAuthorization = privateRuntime.resolveSkillAuthorizationForTurn(
      'Use Lark CLI to read the Feishu document.',
      sessionId,
      buildRequestEnvelope({ userText: 'Use Lark CLI to read the Feishu document.' }),
    )
    assert.equal(exactNameAuthorization.mode, 'selected')
    if (exactNameAuthorization.mode === 'selected') {
      assert.equal(exactNameAuthorization.skillId, 'lark-cli')
    }

    const localUploadFollowup = '好，继续，把这个本地附件上传到云盘'
    const localUploadEnvelope = buildRequestEnvelope({ userText: localUploadFollowup })
    const relevance = resolveSkillHintRelevanceForTurn({
      message: localUploadFollowup,
      requestEnvelope: localUploadEnvelope,
      sessionId,
      orchestrator: skillContextOrchestrator,
      localSendImIntent: false,
    })
    assert.equal(relevance.relevant, false)
    assert.equal(relevance.reason, 'local_input_outside_lark_cli_boundary')
    const followupAuthorization = privateRuntime.resolveSkillAuthorizationForTurn(
      localUploadFollowup,
      sessionId,
      localUploadEnvelope,
      false,
      relevance.relevant,
    )
    assert.equal(followupAuthorization.mode, 'none')
    if (followupAuthorization.mode === 'none') {
      assert.equal(followupAuthorization.candidateSkillPrimitives?.skillId, 'lark-cli')
    }
  } finally {
    clearLastReferenceSkill(sessionId)
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('required reference skills derive their exact model tools from manifest authorization', () => {
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills')
  const resolveAuthorization = (skillId: string, userText: string) => {
    const managedPath = join(skillRoot, skillId)
    const compiled = compileSkillDefinition({ folderPath: managedPath, source: 'embedded' })
    const skill = { ...compiled, installed: true, installStatePath: '', managedPath }
    __setSkillsRuntimeManagerForTests({
      listSkills: () => [skill],
    } as unknown as SkillsRuntimeManager)
    return resolveSemanticSkillAuthorizationForTurn({
      mode: 'commit',
      message: userText,
      requestEnvelope: buildRequestEnvelope({ userText }),
      orchestrator: {
        findExplicitlyRequestedSkills: () => [skill],
        buildPreferredSkillToolNames: () => [],
      },
    })
  }

  try {
    const compact = resolveAuthorization('context-compact', '使用 context-compact 压缩当前上下文')
    assert.equal(compact.mode, 'selected')
    if (compact.mode === 'selected') {
      assert.deepEqual([...compact.allowedPrimitives], ['skill_compact_context'])
    }
    const clip = resolveAuthorization(
      'obsidian-web-clip',
      '使用 obsidian-web-clip 保存 https://example.com/article',
    )
    assert.equal(clip.mode, 'selected')
    if (clip.mode === 'selected') {
      assert.deepEqual([...clip.allowedTypedActions], ['web_clip_url'])
    }
    const explanationOnly = resolveAuthorization(
      'obsidian-web-clip',
      '不要保存，只解释为什么不能剪藏 https://example.com/private',
    )
    assert.equal(explanationOnly.mode, 'selected')
    if (explanationOnly.mode === 'selected') {
      assert.deepEqual([...explanationOnly.allowedTypedActions], [])
    }
    const currentPage = resolveAuthorization(
      'obsidian-web-clip',
      '使用 obsidian-web-clip 剪藏当前登录页面',
    )
    assert.equal(currentPage.mode, 'selected')
    if (currentPage.mode === 'selected') {
      assert.deepEqual([...currentPage.allowedTypedActions], [])
      assert.deepEqual([...currentPage.allowedPrimitives], [])
    }
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('Obsidian public URL applicability survives only a real continuation of that path', () => {
  const skillId = 'obsidian-web-clip'
  const managedPath = join(process.cwd(), 'assets', 'embedded-skills', skillId)
  const compiled = compileSkillDefinition({ folderPath: managedPath, source: 'embedded' })
  const skill = { ...compiled, installed: true, installStatePath: '', managedPath }
  const sessionId = 'scope-obsidian-web-clip-applicability'
  clearLastReferenceSkill(sessionId)
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [skill],
  } as unknown as SkillsRuntimeManager)
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (text) => text,
    listSkills: () => [skill],
    resolveSkillToolByAction: () => null,
  })
  const authorize = (userText: string, skillHintRelevantForTurn = false) =>
    resolveSemanticSkillAuthorizationForTurn({
      mode: 'commit',
      message: userText,
      requestEnvelope: buildRequestEnvelope({ userText }),
      sessionId,
      skillHintRelevantForTurn,
      orchestrator,
    })

  try {
    const publicUrl = authorize(`使用 ${skillId} 保存 https://example.com/article`)
    assert.equal(publicUrl.mode, 'selected')
    if (publicUrl.mode === 'selected') {
      assert.deepEqual([...publicUrl.allowedTypedActions], ['web_clip_url'])
    }
    const retry = authorize('继续上次的公共网页剪藏', true)
    assert.equal(retry.mode, 'selected')
    if (retry.mode === 'selected') {
      assert.deepEqual([...retry.allowedTypedActions], ['web_clip_url'])
    }

    const currentPage = authorize(`使用 ${skillId} 剪藏当前登录页面`)
    assert.equal(currentPage.mode, 'selected')
    if (currentPage.mode === 'selected') {
      assert.deepEqual([...currentPage.allowedTypedActions], [])
    }
    const currentPageRetry = authorize('继续', true)
    assert.equal(currentPageRetry.mode, 'selected')
    if (currentPageRetry.mode === 'selected') {
      assert.deepEqual([...currentPageRetry.allowedTypedActions], [])
    }
  } finally {
    clearLastReferenceSkill(sessionId)
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('Obsidian explicit retry restores only predecessor applicability that still exists in the current manifest', () => {
  const skillId = 'obsidian-web-clip'
  const managedPath = join(process.cwd(), 'assets', 'embedded-skills', skillId)
  const compiled = compileSkillDefinition({ folderPath: managedPath, source: 'embedded' })
  const skill = { ...compiled, installed: true, installStatePath: '', managedPath }
  const orchestrator = {
    findExplicitlyRequestedSkills: () => [skill],
    buildPreferredSkillToolNames: () => [],
  }
  const authorize = (applicableToolNames: string[]) => {
    const requestEnvelope = buildRequestEnvelope({ userText: '再试一次' })
    requestEnvelope.resources.push({
      id: `retry-skill:${skillId}`,
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: skillId,
      path: managedPath,
      text: '',
      summary: null,
      order: 0,
      canRead: false,
      canWrite: false,
      applicableToolNames,
    })
    return resolveSemanticSkillAuthorizationForTurn({
      mode: 'commit',
      message: '再试一次',
      requestEnvelope,
      orchestrator,
    })
  }

  try {
    __setSkillsRuntimeManagerForTests({
      listSkills: () => [skill],
    } as unknown as SkillsRuntimeManager)
    const publicUrlRetry = authorize(['web_clip_url'])
    assert.equal(publicUrlRetry.mode, 'selected')
    if (publicUrlRetry.mode === 'selected') {
      assert.deepEqual([...publicUrlRetry.allowedTypedActions], ['web_clip_url'])
    }

    const currentPageRetry = authorize([])
    assert.equal(currentPageRetry.mode, 'selected')
    if (currentPageRetry.mode === 'selected') {
      assert.deepEqual([...currentPageRetry.allowedTypedActions], [])
    }

    __setSkillsRuntimeManagerForTests({
      listSkills: () => [{ ...skill, allowedTools: ['replacement_action'] }],
    } as unknown as SkillsRuntimeManager)
    const removedByCurrentManifest = authorize(['web_clip_url'])
    assert.equal(removedByCurrentManifest.mode, 'selected')
    if (removedByCurrentManifest.mode === 'selected') {
      assert.equal(removedByCurrentManifest.allowedTypedActions.has('web_clip_url'), false)
    }
  } finally {
    __setSkillsRuntimeManagerForTests(null)
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
      0,
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
      messageVisibilityEpoch?: number,
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
      0,
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
      messageVisibilityEpoch?: number,
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
      0,
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
  assert.ok(reconciled.allowedToolNames.includes('browser_upload'))
  assert.ok(reconciled.allowedToolNames.includes('browser_collect'))
  assert.ok(reconciled.allowedToolNames.includes('browser_eval'))
})

// P1-2 — typed envelope skill_reference 是授权第一信源；正则文本候选降为兜底。
function buildTypedRefRuntime(skillRoot: string) {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt', managedPath: skillRoot }]
          : [],
      buildPreferredSkillToolNames: (text: string) =>
        text.includes('ready-human-touch-ppt')
          ? ['skill_run_shell', 'skill_write_artifact', 'skill_read_artifact', 'skill_export_artifact']
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
}

function typedRefPrivate(runtime: AgentSdkRuntime) {
  return runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      messageVisibilityEpoch?: number,
      requestEnvelope?: unknown,
    ) => SkillToolAuthorization
  }
}

test('SDK authorization consumes a typed skill_reference before text heuristics (P1-2)', () => {
  const sessionId = 'scope-p1-2-typed-ref'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  // rawUserText carries NO @[mention] — the skill signal lives ONLY in the typed envelope resource.
  const requestEnvelope = {
    rawUserText: '根据文档生成一个人文感风格 ppt',
    pureUserText: '根据文档生成一个人文感风格 ppt',
    primaryInstruction: '根据文档生成一个人文感风格 ppt',
    resources: [{
      id: 'skill_reference-0-ready-human-touch-ppt',
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: 'ready-human-touch-ppt',
      path: null,
      text: '',
      summary: null,
      order: 0,
      canRead: false,
      canWrite: false,
    }],
  }
  try {
    const authorization = typedRefPrivate(buildTypedRefRuntime(skillRoot))
      .resolveSkillAuthorizationForTurn('根据文档生成一个人文感风格 ppt', sessionId, 0, requestEnvelope)
    assert.equal(authorization.mode, 'selected')
    assert.equal(authorization.skillId, 'ready-human-touch-ppt')
    assert.ok(
      authorization.mode === 'selected' && authorization.reason.startsWith('typed_ref:'),
      `reason should start with typed_ref:, got ${authorization.mode === 'selected' ? authorization.reason : 'none'}`,
    )
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('SDK authorization still selects via text mention when envelope has no skill_reference (P1-2 regression)', () => {
  const sessionId = 'scope-p1-2-text-fallback'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText: '用@[ready-human-touch-ppt]生成 ppt',
    pureUserText: '用@[ready-human-touch-ppt]生成 ppt',
    primaryInstruction: '用@[ready-human-touch-ppt]生成 ppt',
    resources: [],
  }
  try {
    const authorization = typedRefPrivate(buildTypedRefRuntime(skillRoot))
      .resolveSkillAuthorizationForTurn('用@[ready-human-touch-ppt]生成 ppt', sessionId, 0, requestEnvelope)
    assert.equal(authorization.mode, 'selected')
    assert.equal(authorization.skillId, 'ready-human-touch-ppt')
    assert.ok(
      authorization.mode === 'selected' && !authorization.reason.startsWith('typed_ref:'),
      'text-mention path must NOT be labeled typed_ref',
    )
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('SDK authorization stays none when a typed skill_reference names an unknown skill (P1-2)', () => {
  const sessionId = 'scope-p1-2-unknown'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText: '根据文档生成一个 ppt',
    pureUserText: '根据文档生成一个 ppt',
    primaryInstruction: '根据文档生成一个 ppt',
    resources: [{
      id: 'skill_reference-0-no-such-skill',
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: 'no-such-skill',
      path: null,
      text: '',
      summary: null,
      order: 0,
      canRead: false,
      canWrite: false,
    }],
  }
  try {
    const authorization = typedRefPrivate(buildTypedRefRuntime(skillRoot))
      .resolveSkillAuthorizationForTurn('根据文档生成一个 ppt', sessionId, 0, requestEnvelope)
    assert.equal(authorization.mode, 'none')
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('P1-3 floors-based preserve keeps file read tools through skill narrowing on a selected local-document turn', () => {
  // A selected-skill turn narrows the surface to the skill allowed-tools; the P1-3 executor computes
  // capability floors once and keeps them so file_locate/file_read_excerpt survive alongside the skill
  // primitives. The preserve predicate and the registry hard-floor add-back are REDUNDANT backstops in
  // this fixture (the tools are present pre-narrowing), so this only turns RED when BOTH are disabled;
  // the hard-floor loop's unique group-suppression job is isolated in capability-floors.test.ts.
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_run_shell', 'skill_write_artifact', 'skill_export_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const requestEnvelope = {
    rawUserText: '随便处理一下这个',
    pureUserText: '随便处理一下这个',
    primaryInstruction: '随便处理一下这个',
    resources: [{
      id: 'attach-notes', kind: 'attachment', source: 'user_attachment',
      name: 'notes.md', path: '/tmp/notes.md', text: '', summary: null,
      order: 0, canRead: true, canWrite: true,
    }],
  }
  const names = new Set(listLiveSdkDefaultToolNames({
    userText: '随便处理一下这个',
    sessionId: 'scope-p1-3-floor-preserve',
    requestEnvelope,
    authorization,
  }))
  assert.ok(names.has('file_read_excerpt'), `floors preserve must keep file_read_excerpt; got ${[...names].join('|')}`)
  assert.ok(names.has('file_locate'), `floors preserve must keep file_locate; got ${[...names].join('|')}`)
  assert.ok(names.has('skill_read_artifact') && names.has('skill_run_shell'), 'skill floor must stay')
})

test('P1-4 run-capability-controller attaches the same capability floors the SDK path computes (parity)', () => {
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_run_shell', 'skill_write_artifact', 'skill_export_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const userText = ['用文档生成一个人文感 ppt', '', '--- 附件: notes.md ---', '- 路径: /tmp/notes.md'].join('\n')
  const controller = buildControllerResolution({
    name: 'p1-4-floor-parity',
    userText,
    browserDecisionMode: 'chat',
    authorization: skillAuthorization,
    preferredSkillToolNames: ['skill_read_artifact', 'skill_run_shell', 'skill_write_artifact', 'skill_export_artifact'],
  })
  const controllerFloors = controller.toolPolicy.capabilityFloors
  assert.ok(controllerFloors, 'controller toolPolicy must carry capabilityFloors')
  // Honest parity: compare the controller floors against the floors the LIVE executor path computes
  // (hasLocalDocumentResource(message, envelope) / hasCurrentDocumentContextResource), NOT the
  // controller's own envelope-only signal. They agree for a path-present resource (the common case);
  // a path-null-only resource is a documented latent divergence while the controller path is dormant.
  const requestEnvelope = buildRequestEnvelope({ userText })
  const executorFloors = computeCapabilityFloors({
    authorization: skillAuthorization,
    hasLocalDocumentResource: hasLocalDocumentResource(userText, requestEnvelope),
    hasCurrentDocumentContext: hasCurrentDocumentContextResource(requestEnvelope),
  })
  assert.deepEqual([...controllerFloors!.toolNames].sort(), [...executorFloors.toolNames].sort())
  assert.ok(controllerFloors!.toolNames.has('file_read_excerpt'), 'floor must include file_read_excerpt for a local-document turn')
  assert.ok(controllerFloors!.toolNames.has('skill_read_artifact'), 'floor must include the selected skill primitives')
  // Every controller-declared floor must actually be surfaced by the REAL SDK executor path.
  const sdkSurface = new Set(listLiveSdkDefaultToolNames({
    userText,
    sessionId: 'scope-p1-4-parity',
    requestEnvelope,
    authorization: skillAuthorization,
  }))
  for (const floorTool of controllerFloors!.toolNames) {
    assert.ok(sdkSurface.has(floorTool), `controller-declared floor ${floorTool} must be surfaced by the SDK executor path`)
  }
})

test('P1-4 policy bundle preserves floor tools through an active skill allowed-tools filter', () => {
  // A restrictive allowed-tools filter that would strip file_read_excerpt; the capability floor keeps it.
  const policy: ToolPolicy = {
    forceDocumentTool: false,
    allowDocumentTools: true,
    forceDesignTool: false,
    preferredDesignTool: null,
    primaryDesignInstruction: null,
    allowMultipleDesignArtifacts: false,
    preferSectionRewrite: false,
    preferFormatOnly: false,
    allowBrowserTools: false,
    visibleCapabilityGroupIds: ['file_management'],
    activeSkillAllowedTools: ['file_locate'], // restrictive: without the floor only file_locate survives
    capabilityFloors: { toolNames: new Set(['file_read_excerpt']), reasons: ['local_document_resource'] },
  }
  const names = new Set(getPolicyOpenAIToolBundle(policy).toolNames)
  assert.ok(names.has('file_read_excerpt'), 'floor keeps file_read_excerpt despite the restrictive allowed-tools filter')
  assert.ok(names.has('file_locate'), 'the allowed tool stays')
  // A non-floor, non-allowed tool from the same group must still be filtered out.
  assert.equal(names.has('file_move'), false)
})

test('typed skill_reference for an unknown skill does not hijack selection away from a resolvable text mention (P1-2)', () => {
  const sessionId = 'scope-p1-2-no-hijack'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  // Typed ref names an UNKNOWN skill; the text carries a RESOLVABLE @[known] mention. The typed-ref
  // branch must `continue` past the unknown ref and let the text fallback select the known skill —
  // isolating the typed-ref branch (a wrong short-circuit would yield the unknown id or none).
  const requestEnvelope = {
    rawUserText: '用@[ready-human-touch-ppt]生成 ppt',
    pureUserText: '用@[ready-human-touch-ppt]生成 ppt',
    primaryInstruction: '用@[ready-human-touch-ppt]生成 ppt',
    resources: [{
      id: 'skill_reference-0-no-such-skill', kind: 'skill_reference', source: 'explicit_reference',
      name: 'no-such-skill', path: null, text: '', summary: null, order: 0, canRead: false, canWrite: false,
    }],
  }
  try {
    const authorization = typedRefPrivate(buildTypedRefRuntime(skillRoot))
      .resolveSkillAuthorizationForTurn('用@[ready-human-touch-ppt]生成 ppt', sessionId, 0, requestEnvelope)
    assert.equal(authorization.mode, 'selected')
    assert.equal(authorization.skillId, 'ready-human-touch-ppt') // text fallback wins; typed unknown ref did not hijack
    assert.ok(
      authorization.mode === 'selected' && !authorization.reason.startsWith('typed_ref:'),
      'unknown typed ref must not label the turn typed_ref (it fell through to text fallback)',
    )
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('a none-mode turn carrying a typed skill_reference surfaces no authorized skill primitives (executor no-leak)', () => {
  const requestEnvelope = {
    rawUserText: '随便聊两句', pureUserText: '随便聊两句', primaryInstruction: '随便聊两句',
    resources: [{
      id: 'skill_reference-0-ready-human-touch-ppt', kind: 'skill_reference', source: 'explicit_reference',
      name: 'ready-human-touch-ppt', path: null, text: '', summary: null, order: 0, canRead: false, canWrite: false,
    }],
  }
  const names = listLiveSdkDefaultToolNames({
    userText: '随便聊两句',
    sessionId: 'scope-none-leak',
    requestEnvelope,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  for (const primitive of ['skill_read_artifact', 'skill_write_artifact', 'skill_run_shell', 'skill_export_artifact']) {
    assert.equal(names.includes(primitive), false, `none-mode turn leaked ${primitive}; surface=${names.join('|')}`)
  }
})
