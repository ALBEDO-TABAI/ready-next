import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { AIModelConfig } from '../shared/ai-providers'
import type { CapabilityResolution } from '../main/modules/agent-control/domain-adapters/capability-resolver'

const CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
}

test('weather intent in a non-browser workbench has Browser tools on the first turn', () => {
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

  assert.ok(names.includes('browser_search'), diagnostic)
  assert.ok(names.includes('browser_read'), diagnostic)
  assert.equal(names.includes('use_browser'), false)
})
