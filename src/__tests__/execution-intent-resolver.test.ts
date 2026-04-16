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

test('buildExecutionToolState keeps document tools closed for plain informational questions even if recent history mentioned widgets', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '今天广州天气怎么样\n\n## 最近会话摘要\n刚才在更新 stock_price_chart widget',
  })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: ['更新当前文档里的 stock_price_chart widget：把边框去掉'],
    lastDocumentContextInput: '更新当前文档里的 stock_price_chart widget：把边框去掉',
  })

  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: context.contextualUserInput,
    userInstructionText: context.userInstructionText,
    intentClassification: context.intentClassification,
    hasDocumentEnvironment: context.hasDocumentEnvironment,
    hasWidgetTargetContext: context.hasWidgetTargetContext,
    explicitWidgetCreateIntent: context.explicitWidgetCreateIntent,
    documentWidgetTaskKind: context.documentWidgetTaskKind,
    documentWidgetProfile: context.documentWidgetProfile,
    browserDecisionMode: 'free_tool_loop',
  })

  assert.equal(context.userInstructionText, '今天广州天气怎么样')
  assert.equal(state.toolPolicy.forceDocumentTool, false)
  assert.equal(state.toolPolicy.allowDocumentTools, false)
  assert.equal(state.toolPolicy.allowBrowserTools, false)
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
