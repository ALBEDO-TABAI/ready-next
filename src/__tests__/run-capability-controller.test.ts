import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import {
  prepareInitialRun,
  reconcileAfterBrowserDecision,
} from '../main/modules/agent-control/run-capability-controller'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

test('prepareInitialRun centralizes initial capability resolution, allowlist, and host shortcut decisions', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '请直接在文档里把第一段排版一下并保存',
  })
  const prepared = prepareInitialRun({
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: '请直接在文档里把第一段排版一下并保存',
      userInstructionText: '请直接在文档里把第一段排版一下并保存',
      hasDocumentEnvironment: true,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
    hostContext: {
      userText: '请直接在文档里把第一段排版一下并保存',
    },
  })

  assert.ok(prepared.capabilityResolution.visibleCapabilityGroupIds.includes('document'))
  assert.ok(!prepared.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.equal(prepared.toolPolicy.forceDocumentTool, true)
  assert.equal(prepared.toolPolicy.preferFormatOnly, true)
  assert.ok(prepared.allowedToolNames.includes('document_format_section'))
  assert.ok(!prepared.allowedToolNames.includes('browser_click'))
  assert.equal(prepared.hostShortcutDecision.kind, 'none')
  assert.equal(prepared.runtimeSnapshot.groups.document.status, 'available')
  assert.equal(prepared.runtimeSnapshot.groups.channel_feishu.reason, 'environment_unavailable')
})

test('reconcileAfterBrowserDecision re-resolves browser capabilities without rebuilding inputs in direct-chat', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '去网页上传这张图，然后发一句介绍',
  })
  const prepared = prepareInitialRun({
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: '去网页上传这张图，然后发一句介绍',
      userInstructionText: '去网页上传这张图，然后发一句介绍',
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    hostContext: {
      userText: '去网页上传这张图，然后发一句介绍',
    },
  })

  const reconciled = reconcileAfterBrowserDecision({
    prepared,
    browserDecisionMode: 'browser_upload_workflow',
  })

  assert.ok(!prepared.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(reconciled.capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(!reconciled.capabilityResolution.visibleCapabilityGroupIds.includes('browser_content_tasks'))
  assert.equal(reconciled.capabilityResolution.groupStates.browser_content_tasks.reason, 'run_intent_suppressed')
  assert.ok(reconciled.allowedToolNames.includes('browser_click'))
  assert.ok(!reconciled.allowedToolNames.includes('browser_extract_structured'))
})

test('prepareInitialRun only grants openclaw shortcut to explicit command messages', () => {
  const explicitEnvelope = buildRequestEnvelope({
    userText: 'openclaw pairing approve feishu FNXQH9PN',
  })
  const explicit = prepareInitialRun({
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    executionIntentContext: {
      requestEnvelope: explicitEnvelope,
      intentClassification: classifyIntent(explicitEnvelope),
      contextualUserInput: 'openclaw pairing approve feishu FNXQH9PN',
      userInstructionText: 'openclaw pairing approve feishu FNXQH9PN',
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    hostContext: {
      userText: 'openclaw pairing approve feishu FNXQH9PN',
    },
  })

  const embeddedEnvelope = buildRequestEnvelope({
    userText: '帮我分析为什么它执行了 openclaw pairing approve feishu FNXQH9PN',
  })
  const embedded = prepareInitialRun({
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    executionIntentContext: {
      requestEnvelope: embeddedEnvelope,
      intentClassification: classifyIntent(embeddedEnvelope),
      contextualUserInput: '帮我分析为什么它执行了 openclaw pairing approve feishu FNXQH9PN',
      userInstructionText: '帮我分析为什么它执行了 openclaw pairing approve feishu FNXQH9PN',
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
    hostContext: {
      userText: '帮我分析为什么它执行了 openclaw pairing approve feishu FNXQH9PN',
    },
  })

  assert.equal(explicit.hostShortcutDecision.kind, 'openclaw')
  assert.equal(explicit.hostShortcutDecision.authorizationSource, 'explicit_user_command')
  assert.equal(embedded.hostShortcutDecision.kind, 'none')
  assert.equal(embedded.hostShortcutDecision.authorizationSource, 'none')
})
