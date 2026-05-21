import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'
import { MapPlanRouteSchema, type MapPlanRouteInput } from './schemas/map-schemas'

export const MAP_TOOL_NAMES: readonly string[] = ['map_plan_route'] as const

const MAP_PLAN_ROUTE_PARAMETERS = {
  type: 'object',
  properties: {
    city: { type: 'string', description: '城市名，可用于消除地址歧义。' },
    origin: {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            location: { type: 'string', description: '高德 GCJ-02 坐标，格式为 lng,lat。' },
          },
          required: ['location'],
          additionalProperties: false,
        },
      ],
      description: '起点名称、地址或已解析坐标。',
    },
    destination: {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            location: { type: 'string', description: '高德 GCJ-02 坐标，格式为 lng,lat。' },
          },
          required: ['location'],
          additionalProperties: false,
        },
      ],
      description: '终点名称、地址或已解析坐标。',
    },
    waypoints: {
      type: 'array',
      description: '途经点，最多 16 个。',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              location: { type: 'string', description: '高德 GCJ-02 坐标，格式为 lng,lat。' },
            },
            required: ['location'],
            additionalProperties: false,
          },
        ],
      },
    },
    transportMode: buildToolParamSchema({
      name: 'transportMode',
      type: 'string',
      description: '交通方式。v1 仅支持 driving、walking、bicycling。',
      required: false,
      enum: ['driving', 'walking', 'bicycling'],
    }),
    optimizationGoal: buildToolParamSchema({
      name: 'optimizationGoal',
      type: 'string',
      description: '优化目标。least_detour 仅能和 alongRouteSearch 一起使用。',
      required: false,
      enum: ['fastest', 'shortest', 'least_detour', 'balanced'],
    }),
    alongRouteSearch: {
      type: 'object',
      description: '顺路搜索条件。',
      properties: {
        keyword: { type: 'string', description: '顺路搜索关键词，例如 咖啡、晚餐、便利店。' },
        radiusM: { type: 'number', description: '每个采样点周边搜索半径，单位米，默认 1500。' },
        maxCandidates: { type: 'number', description: '最多评估候选数，默认 8。' },
        maxRecommendations: { type: 'number', description: '最多推荐数，默认 3。' },
        samplePoints: { type: 'number', description: '沿路线采样点数量，默认 3，上限 5。' },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      description: '输出选项。',
      properties: {
        includeMarkdown: { type: 'boolean', description: '是否生成 Markdown 草稿和 artifact。' },
        includeStaticMap: { type: 'boolean', description: '是否生成静态地图 PNG。' },
        includeWidgetSpec: { type: 'boolean', description: '是否返回地图信息卡规格。' },
      },
      additionalProperties: false,
    },
  },
  required: ['origin', 'destination'],
  additionalProperties: false,
}

const MAP_PLAN_ROUTE_DESCRIPTION = [
  '规划高德地图路线，支持起点到终点、途经点顺序优化、顺路地点搜索、绕路时间计算，并生成 Markdown/JSON/静态地图 artifact。',
  '只暴露这一层高阶工具；不要自行拼接高德 URL。',
].join('\n')

export function getMapAnthropicTools(): Array<Record<string, unknown>> {
  return [
    normalizeAnthropicToolSchema({
      name: 'map_plan_route',
      description: MAP_PLAN_ROUTE_DESCRIPTION,
      input_schema: MAP_PLAN_ROUTE_PARAMETERS,
    }),
  ]
}

export function getMapOpenAITools(): Array<Record<string, unknown>> {
  return [
    normalizeOpenAIToolSchema({
      type: 'function',
      function: {
        name: 'map_plan_route',
        description: MAP_PLAN_ROUTE_DESCRIPTION,
        parameters: MAP_PLAN_ROUTE_PARAMETERS,
      },
    }),
  ]
}

export interface MapToolContext {
  abortSignal?: AbortSignal
  sessionId?: string
  amapConfig?: {
    enabled: boolean
    baseUrl: string
    apiKey: string
  } | null
  outputsRoot?: string
  requestModuleToolAction?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

function createMapResultOutput(result: Record<string, unknown>): ToolExecutionOutput {
  return createToolExecutionOutput(JSON.stringify(result), {
    shape: 'json',
    data: result,
  })
}

function createMapFailure(errorKind: string, message: string, extra?: Record<string, unknown>): ToolExecutionOutput {
  return createMapResultOutput({
    ok: false,
    errorKind,
    message,
    ...(extra || {}),
  })
}

export async function executeMapTool(
  toolName: string,
  args: Record<string, unknown>,
  context: MapToolContext = {},
): Promise<ToolExecutionOutput> {
  if (toolName !== 'map_plan_route') {
    return createMapFailure('tool_not_registered', `Unknown map tool: ${toolName}`)
  }

  const parsed = MapPlanRouteSchema.safeParse(args)
  if (!parsed.success) {
    return createMapFailure('input_validation', '地图工具输入不完整或格式不合法。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)),
        code: issue.code,
        message: issue.message,
      })),
    })
  }

  const input = parsed.data as MapPlanRouteInput
  if (input.optimizationGoal === 'least_detour' && !input.alongRouteSearch) {
    return createMapFailure('input_validation', 'least_detour 只能和 alongRouteSearch 一起使用。')
  }

  const [{ ExternalServiceStore }, { getSkillsRuntimeManager }, { planMapRoute }] = await Promise.all([
    import('../settings-engine/external-service-store'),
    import('../skills-runtime/runtime-manager'),
    import('../map-engine'),
  ])

  const amapConfig = Object.prototype.hasOwnProperty.call(context, 'amapConfig')
    ? context.amapConfig
    : new ExternalServiceStore().getAmapConfig()
  if (!amapConfig?.enabled || !amapConfig.apiKey) {
    const message = amapConfig?.apiKey && !amapConfig.enabled
      ? '高德地图 API Key 已保存，但服务还没启用。请在 Ready 设置页的外部服务中打开“高德地图”的启用开关并保存。'
      : '高德地图 API Key 还没配置。请在 Ready 设置页的外部服务中启用“高德地图”并填写新 key。'
    return createMapFailure(
      'amap_not_configured',
      message,
    )
  }

  const runtimeInfo = getSkillsRuntimeManager().getRuntimeInfo()
  const result = await planMapRoute(input, {
    amapConfig,
    outputsRoot: context.outputsRoot || runtimeInfo.outputsRoot,
    signal: context.abortSignal,
    sessionId: context.sessionId,
    requestModuleToolAction: context.requestModuleToolAction,
  })
  return createMapResultOutput(result as unknown as Record<string, unknown>)
}
