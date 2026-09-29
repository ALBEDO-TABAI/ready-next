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
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'

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
