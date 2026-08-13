import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { AIModelConfig } from '../shared/ai-providers'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'
import { GENERAL_RESEARCH_TOOL_NAMES } from '../main/modules/tools/general-research-tool-defs'
import { resolveReadyToolTurnSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'

const CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
}

test('weather intent in a non-browser workbench has research tools without visible Browser control', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '今天广州天气怎么样'
  let capability: CapabilityResolution | null = null
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: text,
    sessionId: 'scope-weather-first-turn',
    scopeId: 'scope-weather-first-turn',
    config: CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    requestEnvelope: buildRequestEnvelope({
      userText: text,
      trustedEnvironment: { workbenchMode: 'document' },
    }),
    onCapabilityResolution: (resolved) => { capability = resolved },
  })
  const names = definitions.map((definition) => definition.name)
  const diagnostic = JSON.stringify({
    names,
    requested: capability?.intentRequestedCapabilityGroupIds,
    visible: capability?.visibleCapabilityGroupIds,
    suppressed: capability?.suppressedCapabilityGroupIds,
  })

  assert.deepEqual(
    names.sort(),
    [...GENERAL_RESEARCH_TOOL_NAMES, 'use_browser'].sort(),
    diagnostic,
  )
})

test('weather intent in Browser workbench stays on the compact research API surface', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '查一下未来广州一周天气'
  const resolutionInput = {
    message: text,
    sessionId: 'scope-weather-browser-workbench',
    scopeId: 'scope-weather-browser-workbench',
    config: CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    requestEnvelope: buildRequestEnvelope({
      userText: text,
      trustedEnvironment: {
        workbenchMode: 'browser',
        browserPageRef: {
          tabId: 'tab-weather',
          physicalTargetToken: 'physical-weather',
          mainFrameDocumentToken: 'document-weather',
        },
      },
    }),
  }
  const definitions = executor.listDefaultToolDefinitionsForTurn(resolutionInput)

  assert.deepEqual(
    definitions.map((definition) => definition.name).sort(),
    [...GENERAL_RESEARCH_TOOL_NAMES, 'use_browser'].sort(),
  )

  const frozen = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-weather-browser-workbench',
    authorizationId: 'authorization-weather-browser-workbench',
    authorization: resolutionInput.authorization,
    source: {
      listDefaultToolDefinitionsForTurn: () => definitions as never,
      listCodexThreadToolDefinitions: () => definitions as never,
    },
    resolutionInput,
  })
  assert.deepEqual(
    frozen.readyTurnToolAuthorization.allowedToolNames,
    [...GENERAL_RESEARCH_TOOL_NAMES].sort(),
  )
})

test('an explicit current-page request still receives Browser tools', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '总结一下当前打开的网页'
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: text,
    sessionId: 'scope-current-browser-page',
    scopeId: 'scope-current-browser-page',
    config: CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    requestEnvelope: buildRequestEnvelope({
      userText: text,
      trustedEnvironment: {
        workbenchMode: 'browser',
        browserPageRef: {
          tabId: 'tab-current',
          physicalTargetToken: 'physical-current',
          mainFrameDocumentToken: 'document-current',
        },
      },
    }),
  })
  const names = definitions.map((definition) => definition.name)

  assert.ok(names.includes('browser_read'))
  assert.ok(names.includes('browser_snapshot'))
})
