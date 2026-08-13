import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import {
  buildExecutionToolState,
  hasExplicitSetupCommandIntent,
  resolveExecutionIntentContext
} from '../main/modules/agent-control/execution-intent-resolver'

test('resolveExecutionIntentContext preserves document follow-up context and widget intent', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '把这个趋势图改成蓝色，并保留原来的布局\n### Widget 更新上下文',
  })
  const result = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: ['请在文档里插入一个趋势图组件'],
    lastDocumentContextInput: '请在文档里插入一个趋势图组件',
  })

  assert.match(result.contextualUserInput, /趋势图组件/)
  assert.equal(result.hasWidgetTargetContext, true)
  assert.equal(result.documentWidgetTaskKind, 'update')
  assert.equal(result.hasDocumentEnvironment, false)
})

test('buildExecutionToolState enables browser tools only after browser decision is ready', () => {
  const browserEnvelope = buildRequestEnvelope({ userText: '帮我上传图片并提交' })
  const browserIntent = classifyIntent(browserEnvelope)
  const initial = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '帮我上传图片并提交',
    userInstructionText: '帮我上传图片并提交',
    intentClassification: browserIntent,
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
  })

  const browserReady = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '帮我上传图片并提交',
    userInstructionText: '帮我上传图片并提交',
    intentClassification: browserIntent,
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'browser_upload_workflow',
  })

  assert.equal(initial.toolPolicy.allowBrowserTools, false)
  assert.equal(browserReady.toolPolicy.allowBrowserTools, true)
})

test('resolveExecutionIntentContext keeps live external info lookups out of document routing even if recent history mentioned widgets', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '今天广州天气怎么样\n\n## 最近会话摘要\n刚才在更新 stock_price_chart widget',
  })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: ['更新当前文档里的 stock_price_chart widget：把边框去掉'],
    lastDocumentContextInput: '更新当前文档里的 stock_price_chart widget：把边框去掉',
  })

  assert.equal(context.userInstructionText, '今天广州天气怎么样')
  assert.equal(context.intentClassification.primaryDomain, 'research')
  assert.equal(context.hasDocumentEnvironment, false)
  assert.equal(context.documentWidgetTaskKind, null)
})

test('resolveExecutionIntentContext upgrades a provided generic intent when the current text names a registered skill', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '使用@[Video Expert Analyzer (VNext)]分析这个 YouTube 视频',
  })
  const genericIntent = classifyIntent(requestEnvelope)
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: [],
    intentClassification: genericIntent,
    registeredSkillTokens: ['videoexpertanalyzervnext'],
  })

  assert.equal(genericIntent.primaryDomain, 'generic')
  assert.equal(context.intentClassification.primaryDomain, 'skill')
})

test('resolveExecutionIntentContext keeps a previous widget context from hiding an explicit registered skill', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '再重试一次',
  })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: ['使用@[Video Expert Analyzer (VNext)]分析这个 YouTube 视频'],
    lastDocumentContextInput: '更新当前文档里的趋势图 widget：把边框去掉',
    intentClassification: classifyIntent(requestEnvelope),
    registeredSkillTokens: ['videoexpertanalyzervnext'],
  })

  assert.equal(context.intentClassification.primaryDomain, 'skill')
  assert.match(context.contextualUserInput, /Video Expert Analyzer/)
})

test('buildExecutionToolState uses research APIs for live info and only adds browser tools when the browser surface is already trusted', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '明天广州天气怎么样',
  })
  const intent = classifyIntent(requestEnvelope)
  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '明天广州天气怎么样',
    userInstructionText: '明天广州天气怎么样',
    intentClassification: intent,
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    browserHostAvailable: true,
    feishuConnected: true,
  })

  const browserSurfaceState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '明天广州天气怎么样',
    userInstructionText: '明天广州天气怎么样',
    intentClassification: intent,
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'browser_workflow',
    browserHostAvailable: true,
    feishuConnected: true,
  })

  assert.equal(state.toolPolicy.allowBrowserTools, false)
  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('general_research'))
  assert.ok(!state.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.equal(browserSurfaceState.toolPolicy.allowBrowserTools, true)
  assert.ok(browserSurfaceState.capabilityResolution.visibleCapabilityGroupIds.includes('general_research'))
  assert.ok(browserSurfaceState.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
})

test('buildExecutionToolState suppresses rss, calendar, and feishu tools for generic local design requests', () => {
  const genericEnvelope = buildRequestEnvelope({
    userText: '帮我整理一个三层卡片关系图，输出 SVG，并补两行说明文字',
  })
  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '帮我整理一个三层卡片关系图，输出 SVG，并补两行说明文字',
    userInstructionText: '帮我整理一个三层卡片关系图，输出 SVG，并补两行说明文字',
    intentClassification: classifyIntent(genericEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })

  assert.equal(state.capabilityResolution.visibleCapabilityGroupIds.includes('rss'), false)
  assert.equal(state.capabilityResolution.visibleCapabilityGroupIds.includes('calendar'), false)
  assert.equal(state.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), false)
})

test('buildExecutionToolState keeps rss and feishu tools available only when user intent is explicit', () => {
  const rssEnvelope = buildRequestEnvelope({
    userText: '帮我抓取这个 RSS 订阅源的最近文章并分析',
  })
  const rssState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '帮我抓取这个 RSS 订阅源的最近文章并分析',
    userInstructionText: '帮我抓取这个 RSS 订阅源的最近文章并分析',
    intentClassification: classifyIntent(rssEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })

  const feishuEnvelope = buildRequestEnvelope({
    userText: '把结果发到飞书群里，并更新飞书文档',
  })
  const feishuState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '把结果发到飞书群里，并更新飞书文档',
    userInstructionText: '把结果发到飞书群里，并更新飞书文档',
    intentClassification: classifyIntent(feishuEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })

  assert.equal(rssState.capabilityResolution.visibleCapabilityGroupIds.includes('rss'), true)
  assert.equal(rssState.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), false)
  assert.equal(feishuState.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), true)
  assert.equal(feishuState.capabilityResolution.visibleCapabilityGroupIds.includes('rss'), false)
})

test('local Feishu CLI intent does not request the sidecar-backed channel_feishu surface', () => {
  const envelope = buildRequestEnvelope({
    userText: '用飞书 CLI 读取并更新这份文档',
  })
  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: envelope.primaryInstruction,
    userInstructionText: envelope.primaryInstruction,
    intentClassification: classifyIntent(envelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })

  assert.equal(state.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), false)
  assert.equal(state.capabilityResolution.requestedButSuppressed.some(
    (conflict) => conflict.groupId === 'channel_feishu',
  ), false)

  const negativeText = '不要用飞书 CLI，直接读取这份飞书文档'
  const negativeEnvelope = buildRequestEnvelope({ userText: negativeText })
  const negativeState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: negativeText,
    userInstructionText: negativeText,
    intentClassification: classifyIntent(negativeEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })
  assert.equal(negativeState.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), true)

  for (const mentionOnlyText of [
    'Read the Feishu document mentioning lark-cli.',
    "Summarize the Feishu document titled 'lark-cli installation guide'.",
    '总结飞书文档《lark-cli 更新说明》',
    '阅读标题为“lark-cli 更新文档”的表格',
    '总结名为“飞书 CLI 登录状态说明”的文档',
    'not using lark-cli to update the Feishu document',
    '不是用飞书 CLI 更新文档',
    "don't run lark-cli to update the Feishu document",
    'do not execute feishu-cli to update the Feishu document',
    "I don't want lark-cli to update the Feishu document",
    '我不是要用飞书 CLI 更新文档',
    '用飞书 CLI 更新本地文件',
    'Use lark-cli to read this local file',
  ]) {
    const mentionOnlyEnvelope = buildRequestEnvelope({ userText: mentionOnlyText })
    const mentionOnlyState = buildExecutionToolState({
      supportsToolCalls: true,
      hasVideoInputs: false,
      hasIncomingVideo: false,
      keepToolsWithVideo: false,
      preferredSkillToolNames: null,
      contextualUserInput: mentionOnlyText,
      userInstructionText: mentionOnlyText,
      intentClassification: classifyIntent(mentionOnlyEnvelope),
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
      browserDecisionMode: 'free_tool_loop',
      capabilityProfile: 'local_chat',
      feishuConnected: true,
    })
    assert.equal(
      mentionOnlyState.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'),
      true,
      mentionOnlyText,
    )
  }
})

test('local CLI reads do not expose the install/config command while explicit setup still does', () => {
  const readText = '用飞书 CLI 读取并更新这份文档'
  const readEnvelope = buildRequestEnvelope({ userText: readText })
  const readState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: readText,
    userInstructionText: readText,
    intentClassification: classifyIntent(readEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: false,
  })

  const setupText = '帮我安装并配置飞书 CLI'
  const setupEnvelope = buildRequestEnvelope({ userText: setupText })
  const setupState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: setupText,
    userInstructionText: setupText,
    intentClassification: classifyIntent(setupEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: false,
  })

  assert.equal(readState.capabilityResolution.visibleCapabilityGroupIds.includes('command_exec'), false)
  assert.equal(setupState.capabilityResolution.visibleCapabilityGroupIds.includes('command_exec'), true)

  const statusText = '请帮我查看飞书 CLI 有没有登录'
  const statusEnvelope = buildRequestEnvelope({ userText: statusText })
  const statusState = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: statusText,
    userInstructionText: statusText,
    intentClassification: classifyIntent(statusEnvelope),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    capabilityProfile: 'local_chat',
    feishuConnected: true,
  })
  assert.equal(statusState.capabilityResolution.visibleCapabilityGroupIds.includes('command_exec'), false)
  assert.equal(statusState.capabilityResolution.visibleCapabilityGroupIds.includes('channel_feishu'), false)
  assert.equal(hasExplicitSetupCommandIntent('看看飞书 CLI 有没有登录'), false)
  assert.equal(hasExplicitSetupCommandIntent('请帮我查看飞书 CLI 有没有登录'), false)
  assert.equal(hasExplicitSetupCommandIntent('为什么安装飞书 CLI 会超时'), false)
  assert.equal(hasExplicitSetupCommandIntent('用飞书 CLI 更新文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('用飞书 CLI 读取配置文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('读取《安装配置指南》文档时请用飞书 CLI'), false)
  assert.equal(hasExplicitSetupCommandIntent('用飞书 CLI 总结《安装配置指南》文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('总结《飞书 CLI 更新说明》文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('读取《Lark CLI 更新指南》这份飞书文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('阅读标题为“lark-cli 更新文档”的表格'), false)
  assert.equal(hasExplicitSetupCommandIntent('总结名为“飞书 CLI 登录状态说明”的文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不要安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不需要安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不要再安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('无需再安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不必安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('没必要安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent("don't install lark-cli; use the existing lark-cli to read the document"), false)
  assert.equal(hasExplicitSetupCommandIntent("I don't need to install lark-cli, use it to edit the document"), false)
  assert.equal(hasExplicitSetupCommandIntent('No need to install lark-cli; use it to edit the document'), false)
  assert.equal(hasExplicitSetupCommandIntent('别更新 CLI，直接用飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不要配置命令行，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不更新飞书 CLI，直接用它读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不安装飞书 CLI，直接用现有的飞书 CLI 读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('勿配置飞书 CLI，直接读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不要安装飞书 CLI'), false)
  assert.equal(hasExplicitSetupCommandIntent('我明确要求不要在这次任务中使用任何本地飞书 CLI，直接读取飞书文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('Feishu CLI 在这个任务里无论如何都不要用；直接读取文档'), false)
  assert.equal(hasExplicitSetupCommandIntent('不要使用 lark-cli；请安装 npm 包 foo'), true)
  assert.equal(hasExplicitSetupCommandIntent("Don't use lark-cli, install ffmpeg instead"), true)
  assert.equal(hasExplicitSetupCommandIntent('安装飞书 CLI'), true)
  assert.equal(hasExplicitSetupCommandIntent('给飞书 CLI 配置文档权限'), true)
  assert.equal(hasExplicitSetupCommandIntent('帮我安装飞书 CLI，然后读取文档'), true)
  assert.equal(hasExplicitSetupCommandIntent('帮我更新飞书 CLI，再编辑文档'), true)
  assert.equal(hasExplicitSetupCommandIntent('用飞书 CLI 读取文档，然后更新 CLI'), true)
  assert.equal(hasExplicitSetupCommandIntent('用飞书 CLI 更新这个 CLI'), true)
  assert.equal(hasExplicitSetupCommandIntent('先读取安装说明文档并安装飞书 CLI'), true)
  assert.equal(hasExplicitSetupCommandIntent('帮我安装最新版且适合当前 Apple Silicon Mac 的飞书 CLI，然后读取文档'), true)
  assert.equal(hasExplicitSetupCommandIntent('安装失败了，帮我修复飞书 CLI'), true)
})

test('resolveExecutionIntentContext builds a structured document task plan for explicit source-to-target requests', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: [
      '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      '',
      '## 环境信息',
      '- 当前模式: 文档模式',
      '',
      '### 当前文档上下文',
      '- 标题: 新文档.md',
      '- 路径: /tmp/新文档.md',
      '- 类型: md',
      '- 字符数: 200',
      '',
      '--- 文档摘要开始 ---',
      '这里是目标文档摘要',
      '--- 文档摘要结束 ---',
      '',
      '--- 附件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '这里是 storyboard 正文',
    ].join('\n'),
  })

  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: [],
  })

  assert.equal(context.shouldUseDocumentTaskPlan, true)
  assert.equal(context.documentTaskPlan?.jobs.length, 1)
  assert.equal(
    context.documentTaskPlan?.jobs[0].bindings.find((binding) => binding.role === 'primary_source')?.resource.name,
    'storyboard.pdf',
  )
  assert.equal(
    context.documentTaskPlan?.jobs[0].bindings.find((binding) => binding.role === 'target_document')?.resource.name,
    '新文档.md',
  )
})

test('resolveExecutionIntentContext keeps mapSemanticIntent optional and default null', () => {
  const requestEnvelope = buildRequestEnvelope({ userText: '你好' })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: [],
  })

  assert.equal(context.mapSemanticIntent, null)
})

test('buildExecutionToolState admits map capability and secondary document/research/browser groups from map semantic intent', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '从北京南站到故宫怎么走，路上找咖啡并写成文档，同时查评价',
  })
  const intent = classifyIntent(requestEnvelope)
  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: requestEnvelope.pureUserText,
    userInstructionText: requestEnvelope.pureUserText,
    intentClassification: {
      ...intent,
      primaryDomain: 'map',
      mentionedDomains: [...intent.mentionedDomains, 'map'],
    },
    mapSemanticIntent: {
      isMapIntent: true,
      primaryTask: 'along_route_search',
      secondarySignals: ['document_output', 'research_lookup', 'browser_lookup'],
      confidence: 0.8,
    },
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'free_tool_loop',
    browserHostAvailable: true,
    feishuConnected: true,
  })

  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('map_planning'))
  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('document'))
  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('general_research'))
  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
})
