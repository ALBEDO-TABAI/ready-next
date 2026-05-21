import type { ZodObject, ZodRawShape } from 'zod'
import { z } from 'zod'

const LngLatSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, 'location must be "lng,lat"')
  .describe('高德 GCJ-02 坐标，格式为 lng,lat')

const PlaceInputSchema = z.union([
  z.string().min(1).describe('地点名称或地址'),
  z.object({
    name: z.string().optional().describe('地点显示名称'),
    location: LngLatSchema,
  }).describe('已解析地点'),
])

export const MapPlanRouteSchema = z.object({
  city: z.string().optional().describe('城市名，可用于消除地址歧义'),
  origin: PlaceInputSchema.describe('起点'),
  destination: PlaceInputSchema.describe('终点'),
  waypoints: z.array(PlaceInputSchema).max(16).optional().describe('途经点，最多 16 个'),
  transportMode: z.enum(['driving', 'walking', 'bicycling']).optional().default('driving').describe('交通方式'),
  optimizationGoal: z.enum(['fastest', 'shortest', 'least_detour', 'balanced']).optional().default('balanced').describe('优化目标'),
  alongRouteSearch: z.object({
    keyword: z.string().min(1).describe('顺路搜索关键词，例如 咖啡、晚餐、便利店'),
    radiusM: z.number().positive().max(50000).optional().default(1500).describe('每个采样点周边搜索半径，单位米'),
    maxCandidates: z.number().int().positive().max(20).optional().default(8).describe('最多评估候选数'),
    maxRecommendations: z.number().int().positive().max(10).optional().default(3).describe('最多推荐数'),
    samplePoints: z.number().int().positive().max(5).optional().default(3).describe('沿路线采样点数量，上限 5'),
  }).optional().describe('沿路线搜索条件'),
  output: z.object({
    includeMarkdown: z.boolean().optional().default(true).describe('是否生成 Markdown 草稿和 artifact'),
    includeStaticMap: z.boolean().optional().default(true).describe('是否生成静态地图 PNG'),
    includeWidgetSpec: z.boolean().optional().default(true).describe('是否返回地图信息卡规格'),
  }).optional().default({
    includeMarkdown: true,
    includeStaticMap: true,
    includeWidgetSpec: true,
  }).describe('输出选项'),
})

export type MapPlanRouteInput = z.infer<typeof MapPlanRouteSchema>
export type MapPlaceInput = z.infer<typeof PlaceInputSchema>

export const MAP_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  map_plan_route: MapPlanRouteSchema as unknown as ZodObject<ZodRawShape>,
}
