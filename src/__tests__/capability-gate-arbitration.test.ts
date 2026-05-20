/**
 * Stage S (PR-S6 / W4.1) — capability gate arbitration.
 *
 * Confirms `capabilityResolution.supportsVision` is surfaced from
 * `capability-resolver.ts` and consumed by `run-capability-controller`
 * for arbitration-time branching.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { prepareInitialRun } from '../main/modules/agent-control/domain-adapters/run-capability-controller'
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

const VISION_PROVEN_CONFIG: AIModelConfig = {
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

function buildBaseParams(config: AIModelConfig) {
  const requestEnvelope = buildRequestEnvelope({ userText: 'just a chat' })
  return {
    config,
    capabilityProfile: 'local_chat' as const,
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: 'just a chat',
      userInstructionText: 'just a chat',
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop' as const,
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
    hostContext: { userText: 'just a chat' },
  }
}

test('CapabilityResolution surfaces supportsVision/Thinking/LongContext flags', () => {
  const resolution = resolveCapabilityResolution({
    config: VISION_PROVEN_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: { browserHostAvailable: true, feishuConnected: false },
  })
  assert.equal(typeof resolution.supportsVision, 'boolean')
  assert.equal(resolution.supportsVision, true, 'openai/gpt-4o is vision-proven')

  const denied = resolveCapabilityResolution({
    config: VISION_DENIED_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: { browserHostAvailable: true, feishuConnected: false },
  })
  assert.equal(denied.supportsVision, false, 'openai-compatible defaults conservative false')
  assert.equal(denied.supportsThinking, false, 'openai-compatible defaults conservative false')
})

test('prepareInitialRun branches on capabilityResolution.supportsVision without throwing', () => {
  const proven = prepareInitialRun(buildBaseParams(VISION_PROVEN_CONFIG))
  assert.equal(proven.capabilityResolution.supportsVision, true)

  const denied = prepareInitialRun(buildBaseParams(VISION_DENIED_CONFIG))
  assert.equal(denied.capabilityResolution.supportsVision, false)
})
