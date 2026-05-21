import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { normalizeToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import { MAP_TOOL_TIMEOUT_MS, resolveToolExecutionTimeoutMs } from '../main/modules/tools/tool-execution-timeout-policy'
import { executeMapTool, getMapAnthropicTools, getMapOpenAITools } from '../main/modules/tools/map-tools'
import { MapPlanRouteSchema } from '../main/modules/tools/schemas/map-schemas'
import { TASK_TYPES } from '../shared/task-types'

test('map_plan_route schema applies defaults and rejects too many waypoints', () => {
  const parsed = MapPlanRouteSchema.safeParse({
    origin: '北京南站',
    destination: '故宫',
    alongRouteSearch: { keyword: '咖啡' },
  })

  assert.equal(parsed.success, true)
  assert.equal(parsed.data.transportMode, 'driving')
  assert.equal(parsed.data.alongRouteSearch?.radiusM, 1500)
  assert.equal(parsed.data.alongRouteSearch?.maxCandidates, 8)
  assert.equal(parsed.data.alongRouteSearch?.maxRecommendations, 3)
  assert.equal(parsed.data.alongRouteSearch?.samplePoints, 3)

  const tooMany = MapPlanRouteSchema.safeParse({
    origin: 'A',
    destination: 'B',
    waypoints: Array.from({ length: 17 }, (_, index) => `P${index}`),
  })
  assert.equal(tooMany.success, false)
})

test('map tools expose one high-level tool for both providers', () => {
  assert.deepEqual(
    getMapAnthropicTools().map((tool) => tool.name),
    ['map_plan_route'],
  )
  assert.deepEqual(
    getMapOpenAITools().map((tool) => (tool.function as { name: string }).name),
    ['map_plan_route'],
  )
  assert.equal(defaultToolRegistry.getToolDefinitionForExecution('map_plan_route')?.domain, 'map')
})

test('map tool reports configuration and validation failures as structured output', async () => {
  const invalid = normalizeToolExecutionOutput(await executeMapTool('map_plan_route', {
    origin: 'A',
    destination: 'B',
    optimizationGoal: 'least_detour',
  }, { amapConfig: null }))
  assert.equal(invalid.data?.ok, false)
  assert.equal(invalid.data?.errorKind, 'input_validation')

  const unconfigured = normalizeToolExecutionOutput(await executeMapTool('map_plan_route', {
    origin: 'A',
    destination: 'B',
  }, { amapConfig: null }))
  assert.equal(unconfigured.data?.ok, false)
  assert.equal(unconfigured.data?.errorKind, 'amap_not_configured')

  const disabled = normalizeToolExecutionOutput(await executeMapTool('map_plan_route', {
    origin: 'A',
    destination: 'B',
  }, { amapConfig: { enabled: false, baseUrl: 'https://restapi.amap.com', apiKey: 'configured-key' } }))
  assert.equal(disabled.data?.ok, false)
  assert.equal(disabled.data?.errorKind, 'amap_not_configured')
  assert.match(String(disabled.data?.message || ''), /已保存，但服务还没启用/)
})

test('map tool uses serialized write resource policy and does not add TaskType', () => {
  assert.deepEqual(getToolResourceTag('map_plan_route'), { domain: 'map', accessMode: 'write' })
  assert.equal(resolveToolExecutionTimeoutMs('map_plan_route'), MAP_TOOL_TIMEOUT_MS)
  assert.equal((TASK_TYPES as readonly string[]).includes('map_planning'), false)
})
