import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExecutionToolState, resolveExecutionIntentContext } from '../main/modules/agent-control/execution-intent-resolver'

test('resolveExecutionIntentContext preserves document follow-up context and widget intent', () => {
  const result = resolveExecutionIntentContext({
    userText: '把这个趋势图改成蓝色，并保留原来的布局\n### Widget 更新上下文',
    pureUserInput: '把这个趋势图改成蓝色，并保留原来的布局',
    previousInputs: ['请在文档里插入一个趋势图组件'],
    lastDocumentContextInput: '请在文档里插入一个趋势图组件',
  })

  assert.match(result.contextualUserInput, /趋势图组件/)
  assert.equal(result.hasWidgetTargetContext, true)
  assert.equal(result.documentWidgetTaskKind, 'update')
  assert.equal(result.hasDocumentEnvironment, false)
})

test('buildExecutionToolState enables browser tools only after browser decision is ready', () => {
  const initial = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    contextualUserInput: '帮我上传图片并提交',
    userInstructionText: '帮我上传图片并提交',
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
  const context = resolveExecutionIntentContext({
    userText: '今天广州天气怎么样\n\n## 最近会话摘要\n刚才在更新 stock_price_chart widget',
    pureUserInput: '今天广州天气怎么样',
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
