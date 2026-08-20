import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { resolveReadyToolTurnSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildBrowserAdmissionAuthoritySnapshot } from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import { resolveReadyCapabilityTurnAvailability } from '../main/modules/agent-control/codex-runtime/codex-capability-turn-availability'

const CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
}

const QUERY = '查一下从广州海珠区晓港雅筑出发去韶关罗坑大草原要多久'

function resolveRouteTurn(mapRouteServiceAvailable: boolean) {
  const runtime = new AgentSdkRuntime({ domainAdapters: [] })
  const source = (runtime as unknown as {
    toolExecutor: {
      listDefaultToolDefinitionsForTurn(
        input: Parameters<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>[0]
      ): ReturnType<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>
      listCodexThreadToolDefinitions(): ReturnType<NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>>
    }
  }).toolExecutor
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const pageRef = {
    tabId: 'tab-amap-route',
    physicalTargetToken: 'physical-amap-route',
    mainFrameDocumentToken: 'document-amap-route',
  }
  const resolutionInput = {
    message: QUERY,
    sessionId: 'scope-amap-route',
    scopeId: 'scope-amap-route',
    config: CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    skillCatalogAvailable: true,
    mapRouteServiceAvailable,
    authorization,
    requestEnvelope: buildRequestEnvelope({
      userText: QUERY,
      trustedEnvironment: {
        workbenchMode: 'browser',
        browserPageRef: pageRef,
      },
    }),
  }
  const resolved = resolveReadyToolTurnSnapshot({
    surfaceId: `surface-amap-route-${mapRouteServiceAvailable}`,
    authorizationId: `auth-amap-route-${mapRouteServiceAvailable}`,
    authorization,
    source,
    resolutionInput,
  })
  const resolvedNames = resolved.readyTurnToolAuthorization.allowedToolNames
  const mapRouteMode = resolvedNames.includes('map_plan_route')
    ? 'configured_primary' as const
    : 'public_web_fallback' as const
  const surfaceNames = new Set(resolved.readyToolSurface.toolNames)
  const composed = composeCodexTurnToolSnapshot({
    resolved,
    authorizationId: `final-auth-amap-route-${mapRouteServiceAvailable}`,
    authorization,
    workbenchMode: 'browser',
    browserAdmission: buildBrowserAdmissionAuthoritySnapshot({
      authorityId: `browser-auth-amap-route-${mapRouteServiceAvailable}`,
      activeWorkbenchMode: 'browser',
      currentBrowserPageRef: pageRef,
    }),
    capabilityAvailability: resolveReadyCapabilityTurnAvailability({
      publicResearchProviderAvailable: surfaceNames.has('web_search'),
      calendarHostAvailable: false,
      calendarProductMapped: false,
      workbenchMode: 'browser',
      currentBrowserPageRef: pageRef,
    }),
    mapRouteMode,
  })
  return { composed, resolved }
}

test('configured map service owns a natural route query even when a Browser page is bound', () => {
  const { composed } = resolveRouteTurn(true)
  const names = composed.readyTurnToolAuthorization.allowedToolNames

  assert.ok(names.includes('map_plan_route'), names.join(','))
  assert.ok(names.includes('ask_user_questions'), names.join(','))
  assert.equal(names.includes('web_search'), false, names.join(','))
  assert.equal(names.some((name) => name.startsWith('browser_')), false, names.join(','))
})

test('missing map service exposes only an honest public-web estimate fallback', () => {
  const { composed, resolved } = resolveRouteTurn(false)
  const names = composed.readyTurnToolAuthorization.allowedToolNames

  assert.ok(names.includes('web_search'), names.join(','))
  assert.ok(names.includes('web_fetch'), names.join(','))
  assert.equal(names.includes('map_plan_route'), false, names.join(','))
  assert.equal(names.includes('web_search_domains'), false, names.join(','))
  assert.equal(names.some((name) => name.startsWith('browser_')), false, names.join(','))

  const webSearch = resolved.readyToolSurface.entries.find((entry) => entry.name === 'web_search')
  assert.match(webSearch?.description || '', /公开网页估算/)
  assert.match(webSearch?.description || '', /设置 > 外部服务/)
})
