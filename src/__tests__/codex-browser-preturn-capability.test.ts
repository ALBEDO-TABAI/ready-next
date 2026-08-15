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
  const names = definitions.map((definition) => definition.name)

  assert.ok(GENERAL_RESEARCH_TOOL_NAMES.every((name) => names.includes(name)), names.join(','))
  assert.ok(names.includes('browser_read'), names.join(','))
  assert.equal(names.includes('use_browser'), false, names.join(','))

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
  assert.ok(frozen.readyTurnToolAuthorization.allowedToolNames.includes('web_search'))
  assert.ok(frozen.readyTurnToolAuthorization.allowedToolNames.includes('browser_read'))
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

test('current-page research still receives Browser tools', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '研究一下当前打开的网页'
  const resolutionInput = {
    message: text,
    sessionId: 'scope-current-page-research',
    scopeId: 'scope-current-page-research',
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
          tabId: 'tab-current-research',
          physicalTargetToken: 'physical-current-research',
          mainFrameDocumentToken: 'document-current-research',
        },
      },
    }),
  }
  const definitions = executor.listDefaultToolDefinitionsForTurn(resolutionInput)
  const names = definitions.map((definition) => definition.name)

  assert.ok(names.includes('browser_task'))
  assert.ok(names.includes('browser_read'))
})

test('current-page notes keep Browser tools even when the page content mentions weather', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '总结一下当前小红书页面关于广州天气的笔记'
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: text,
    sessionId: 'scope-current-page-weather-notes',
    scopeId: 'scope-current-page-weather-notes',
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
          tabId: 'tab-xhs-weather-notes',
          physicalTargetToken: 'physical-xhs-weather-notes',
          mainFrameDocumentToken: 'document-xhs-weather-notes',
        },
      },
    }),
  })
  const names = definitions.map((definition) => definition.name)

  assert.ok(names.includes('browser_read'), names.join(','))
  assert.ok(names.includes('browser_snapshot'), names.join(','))
})

test('current-page weather notes keep Browser tools without a platform name', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '看看当前页面这篇广州天气预报并总结'
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: text,
    sessionId: 'scope-current-page-weather-article',
    scopeId: 'scope-current-page-weather-article',
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
          tabId: 'tab-weather-article',
          physicalTargetToken: 'physical-weather-article',
          mainFrameDocumentToken: 'document-weather-article',
        },
      },
    }),
  })
  const names = definitions.map((definition) => definition.name)

  assert.ok(names.includes('browser_read'), names.join(','))
})

test('an explicit current-page exclusion keeps public weather search', () => {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const executor = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        params: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): Array<{ name: string }>
    }
  }).toolExecutor
  const text = '不要看小红书当前页，直接查天气'
  const definitions = executor.listDefaultToolDefinitionsForTurn({
    message: text,
    sessionId: 'scope-exclude-current-page-weather',
    scopeId: 'scope-exclude-current-page-weather',
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
          tabId: 'tab-xhs-exclude',
          physicalTargetToken: 'physical-xhs-exclude',
          mainFrameDocumentToken: 'document-xhs-exclude',
        },
      },
    }),
  })
  const names = definitions.map((definition) => definition.name)

  assert.ok(names.includes('web_search'), names.join(','))
})
