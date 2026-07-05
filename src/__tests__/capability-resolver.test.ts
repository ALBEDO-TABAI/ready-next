import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import {
  CAPABILITY_GROUPS,
  getCapabilityGroup,
} from '../shared/ai-capability-groups'
import { resolveCapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

test('capability groups define required reserved and host-only entries', () => {
  const groupIds = CAPABILITY_GROUPS.map((group) => group.id)

  assert.deepEqual(groupIds, [
    'browser_interaction',
    'browser_content_tasks',
    'document',
    'file_management',
    'rss',
    'calendar',
    'skills',
    'memory',
    'session_recall',
    'pet',
    'channel_feishu',
    'general_research',
    'map_planning',
    'system_host',
    'design_reserved',
    'mcp',
    'agent_interaction',
    'skill_install',
    // Phase I（2026-07-05）—— 远程会话回传（channel_send_file）：仅
    // channelScopeBound 的 run 可见，见下方专项断言。
    'channel_outbound',
  ])

  assert.equal(getCapabilityGroup('system_host')?.exposure, 'host_only')
  assert.equal(getCapabilityGroup('design_reserved')?.availability, 'inactive')
  assert.equal(getCapabilityGroup('mcp')?.exposure, 'model_visible')
  assert.equal(getCapabilityGroup('mcp')?.settingsVisible, false)
  assert.equal(getCapabilityGroup('agent_interaction')?.exposure, 'model_visible')
  assert.equal(getCapabilityGroup('agent_interaction')?.defaultMode, 'on')
  assert.deepEqual(getCapabilityGroup('agent_interaction')?.defaultProfiles, ['local_chat'])
  assert.equal(getCapabilityGroup('skill_install')?.exposure, 'model_visible')
  assert.equal(getCapabilityGroup('skill_install')?.defaultMode, 'on')
  assert.equal(getCapabilityGroup('skill_install')?.settingsVisible, false)
  assert.deepEqual(getCapabilityGroup('skill_install')?.defaultProfiles, ['local_chat'])
})

test('resolver suppresses all model-visible groups when provider tool calling is disabled', () => {
  const resolution = resolveCapabilityResolution({
    config: {
      ...BASE_CONFIG,
      toolUseMode: 'off',
    },
    profile: 'local_chat',
    browserDecisionMode: 'browser_workflow',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: true,
    },
  })

  assert.deepEqual(resolution.visibleCapabilityGroupIds, [])
  assert.ok(resolution.hostOnlyCapabilityIds.includes('system_host'))
  assert.equal(resolution.groupStates.browser_interaction.status, 'suppressed')
  assert.equal(resolution.groupStates.browser_interaction.reason, 'provider_disabled_tools')
  assert.equal(resolution.groupStates.channel_feishu.status, 'suppressed')
  assert.equal(resolution.groupStates.channel_feishu.reason, 'provider_disabled_tools')
})

test('resolver differentiates browser interaction and browser content task visibility by run intent', () => {
  const uploadResolution = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'browser_upload_workflow',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
  })

  const researchResolution = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'browser_workflow',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
  })

  assert.ok(uploadResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(uploadResolution.visibleCapabilityGroupIds.includes('browser_content_tasks'))
  assert.equal(uploadResolution.groupStates.browser_content_tasks.reason, 'enabled')

  assert.ok(researchResolution.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(researchResolution.visibleCapabilityGroupIds.includes('browser_content_tasks'))
})

test('collection intent exposes browser groups via intentGroupModes WITHOUT a browser_workflow decision (WP1 decoupling)', () => {
  // free_tool_loop decision mode: by default browser groups are suppressed…
  const withoutIntent = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: { browserHostAvailable: true, feishuConnected: false },
  })
  assert.ok(!withoutIntent.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(!withoutIntent.visibleCapabilityGroupIds.includes('browser_content_tasks'))

  // …but collection intent surfaces them via intentGroupModes, decision mode unchanged.
  const withIntent = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: { browserHostAvailable: true, feishuConnected: false },
    intentGroupModes: { browser_interaction: true, browser_content_tasks: true },
  })
  assert.ok(withIntent.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(withIntent.visibleCapabilityGroupIds.includes('browser_content_tasks'))
})

test('collection intent never overrides host availability (no browser host → still hidden)', () => {
  const noHost = resolveCapabilityResolution({
    config: BASE_CONFIG,
    profile: 'local_chat',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: { browserHostAvailable: false, feishuConnected: false },
    intentGroupModes: { browser_interaction: true, browser_content_tasks: true },
  })
  assert.ok(!noHost.visibleCapabilityGroupIds.includes('browser_interaction'))
  assert.ok(!noHost.visibleCapabilityGroupIds.includes('browser_content_tasks'))
})

test('resolver marks feishu group unavailable when channel runtime is disconnected', () => {
  const resolution = resolveCapabilityResolution({
    config: {
      ...BASE_CONFIG,
      capabilityModes: {
        channel_feishu: 'on',
      },
    },
    profile: 'remote_channel',
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
  })

  assert.ok(!resolution.visibleCapabilityGroupIds.includes('channel_feishu'))
  assert.equal(resolution.groupStates.channel_feishu.status, 'unavailable')
  assert.equal(resolution.groupStates.channel_feishu.reason, 'environment_unavailable')
})
