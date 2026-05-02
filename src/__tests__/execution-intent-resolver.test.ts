import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { buildExecutionToolState, resolveExecutionIntentContext } from '../main/modules/agent-control/execution-intent-resolver'

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
  assert.equal(context.intentClassification.primaryDomain, 'browser')
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

test('buildExecutionToolState keeps browser tools visible for live external info lookups even before browser workflow planning is attached', () => {
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

  assert.equal(state.toolPolicy.allowBrowserTools, true)
  assert.ok(state.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
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
