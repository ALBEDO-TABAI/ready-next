import type { MapPlanRouteInput, MapPlaceInput } from '../tools/schemas/map-schemas'
import type {
  AlongRouteRecommendation,
  MapRouteWidgetSpec,
  PlaceCandidate,
  RoutePlannerClient,
  RoutePlannerResult,
  RouteSummary,
  TransportMode,
} from './types'
import { MapPlannerError } from './types'

function toRad(value: number): number {
  return value * Math.PI / 180
}

function parseLocation(location: string): { lng: number; lat: number } | null {
  const [lng, lat] = location.split(',').map((part) => Number(part.trim()))
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lng, lat }
}

function isLocationString(value: string): boolean {
  const location = parseLocation(value)
  if (!location) return false
  return location.lng >= -180 && location.lng <= 180 && location.lat >= -90 && location.lat <= 90
}

function distanceMeters(a: string, b: string): number {
  const p1 = parseLocation(a)
  const p2 = parseLocation(b)
  if (!p1 || !p2) return Number.MAX_SAFE_INTEGER
  const r = 6371000
  const dLat = toRad(p2.lat - p1.lat)
  const dLng = toRad(p2.lng - p1.lng)
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function routePolylinePoints(route: RouteSummary): string[] {
  return route.polyline
    .split(';')
    .map((point) => point.trim())
    .filter((point) => parseLocation(point))
}

function samplePolyline(route: RouteSummary, count: number): string[] {
  const points = routePolylinePoints(route)
  if (points.length === 0) return []
  if (points.length <= count) return points
  const samples: string[] = []
  for (let i = 1; i <= count; i += 1) {
    const index = Math.min(points.length - 1, Math.max(0, Math.round((points.length - 1) * i / (count + 1))))
    samples.push(points[index]!)
  }
  return Array.from(new Set(samples))
}

function dedupePlaces(places: PlaceCandidate[]): PlaceCandidate[] {
  const seen = new Set<string>()
  const result: PlaceCandidate[] = []
  for (const place of places) {
    const key = place.id || place.location || `${place.name}|${place.address || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(place)
  }
  return result
}

function normalizePlaceName(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[（）()]/g, '')
    .toLowerCase()
}

function shouldCrossCheckPoiAmbiguity(text: string, place: PlaceCandidate): boolean {
  const normalizedInput = normalizePlaceName(text)
  const normalizedResolved = normalizePlaceName(place.name)
  return /(火车站|高铁站|机场|公园|医院|学校|大学|商场|会场|园区|大厦)$/.test(normalizedInput)
    || normalizedResolved !== normalizedInput
}

function ambiguousCandidatesFromPoiCrossCheck(
  geocode: PlaceCandidate,
  pois: PlaceCandidate[],
): PlaceCandidate[] {
  const candidates = dedupePlaces([geocode, ...pois])
  if (candidates.length < 2) return []
  const geocodeLocation = parseLocation(geocode.location)
  if (!geocodeLocation) return candidates.slice(0, 5)
  return candidates
    .filter((candidate, index) => index === 0 || distanceMeters(geocode.location, candidate.location) <= 5000)
    .slice(0, 5)
}

function closestPolylineDistance(place: PlaceCandidate, route: RouteSummary): number {
  const points = routePolylinePoints(route)
  if (points.length === 0) return Number.MAX_SAFE_INTEGER
  return Math.min(...points.map((point) => distanceMeters(place.location, point)))
}

function combineRoutes(mode: TransportMode, segments: RouteSummary[]): RouteSummary {
  return {
    transportMode: mode,
    distanceM: segments.reduce((sum, route) => sum + route.distanceM, 0),
    durationSec: segments.reduce((sum, route) => sum + route.durationSec, 0),
    polyline: segments.map((route) => route.polyline).filter(Boolean).join(';'),
    steps: segments.flatMap((route) => route.steps),
    segments,
  }
}

function routeReason(detourDurationSec: number, detourDistanceM: number): string {
  const minutes = Math.max(0, Math.round(detourDurationSec / 60))
  const distanceKm = (Math.max(0, detourDistanceM) / 1000).toFixed(1)
  if (minutes <= 3) return `几乎不绕路，额外约 ${minutes} 分钟 / ${distanceKm} 公里。`
  if (minutes <= 10) return `绕路成本较低，额外约 ${minutes} 分钟 / ${distanceKm} 公里。`
  return `需要明显绕路，额外约 ${minutes} 分钟 / ${distanceKm} 公里。`
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  const result: T[][] = []
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]!
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) {
      result.push([head, ...tail])
    }
  }
  return result
}

function pathCost(order: number[], matrix: number[][]): number {
  let cost = 0
  for (let i = 0; i < order.length - 1; i += 1) {
    cost += matrix[order[i]!]?.[order[i + 1]!] ?? Number.MAX_SAFE_INTEGER
  }
  return cost
}

function exactWaypointOrder(waypointCount: number, matrix: number[][]): number[] {
  const waypointIndices = Array.from({ length: waypointCount }, (_, index) => index + 1)
  let best = waypointIndices
  let bestCost = Number.MAX_SAFE_INTEGER
  for (const perm of permutations(waypointIndices)) {
    const order = [0, ...perm, waypointCount + 1]
    const cost = pathCost(order, matrix)
    if (cost < bestCost) {
      bestCost = cost
      best = perm
    }
  }
  return best.map((index) => index - 1)
}

function approximateWaypointOrder(waypointCount: number, matrix: number[][]): number[] {
  const unvisited = new Set(Array.from({ length: waypointCount }, (_, index) => index + 1))
  const order: number[] = []
  let current = 0
  while (unvisited.size > 0) {
    let best: number | null = null
    let bestCost = Number.MAX_SAFE_INTEGER
    for (const candidate of unvisited) {
      const cost = matrix[current]?.[candidate] ?? Number.MAX_SAFE_INTEGER
      if (cost < bestCost) {
        best = candidate
        bestCost = cost
      }
    }
    if (best === null) break
    order.push(best)
    unvisited.delete(best)
    current = best
  }

  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < order.length - 1; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const candidate = [...order]
        candidate.splice(i, j - i + 1, ...candidate.slice(i, j + 1).reverse())
        const currentCost = pathCost([0, ...order, waypointCount + 1], matrix)
        const candidateCost = pathCost([0, ...candidate, waypointCount + 1], matrix)
        if (candidateCost < currentCost) {
          order.splice(0, order.length, ...candidate)
          improved = true
        }
      }
    }
  }
  return order.map((index) => index - 1)
}

export class RoutePlanner {
  constructor(private readonly client: RoutePlannerClient) {}

  async plan(input: MapPlanRouteInput, planId: string): Promise<RoutePlannerResult> {
    const warnings: string[] = []
    const mode = input.transportMode || 'driving'
    const origin = await this.resolvePlace(input.origin, input.city, '起点')
    const destination = await this.resolvePlace(input.destination, input.city, '终点')
    const waypoints = await Promise.all((input.waypoints || []).map((item, index) =>
      this.resolvePlace(item, input.city, `途经点 ${index + 1}`)))
    const baselineRoute = await this.client.direction({ origin, destination, mode })

    const { selectedRoute, waypointOrder } = await this.planWaypoints({
      origin,
      destination,
      waypoints,
      baselineRoute,
      mode,
      warnings,
    })
    const recommendations = input.alongRouteSearch
      ? await this.findAlongRouteRecommendations({
        input,
        origin,
        destination,
        baselineRoute,
        mode,
      })
      : []
    const widgetSpec = this.buildWidgetSpec({
      origin,
      destination,
      waypoints,
      recommendations,
      mapImagePath: undefined,
    })
    const documentDraftMarkdown = buildMarkdown({
      input,
      origin,
      destination,
      baselineRoute,
      selectedRoute,
      recommendations,
      waypointOrder,
      warnings,
      metrics: this.client.metrics(),
    })

    return {
      input,
      planId,
      origin,
      destination,
      waypoints,
      baselineRoute,
      selectedRoute,
      recommendations,
      waypointOrder,
      widgetSpec,
      documentDraftMarkdown,
      warnings,
    }
  }

  private async resolvePlace(input: MapPlaceInput, city: string | undefined, label: string): Promise<PlaceCandidate> {
    if (typeof input !== 'string') {
      return {
        name: input.name || label,
        location: input.location,
        source: 'input',
      }
    }
    const text = input.trim()
    if (isLocationString(text)) {
      return {
        name: label,
        location: text,
        source: 'input',
      }
    }
    const geocodes = await this.client.geocode(text, city)
    if (geocodes.length === 1) {
      const geocode = geocodes[0]!
      if (shouldCrossCheckPoiAmbiguity(text, geocode)) {
        const candidates = ambiguousCandidatesFromPoiCrossCheck(
          geocode,
          await this.client.placeText(text, city),
        )
        if (candidates.length > 1) {
          throw new MapPlannerError('place_ambiguous', `${label}“${text}”存在多个可能地点，请选择一个。`, candidates)
        }
      }
      return geocode
    }
    if (geocodes.length > 1) {
      throw new MapPlannerError('place_ambiguous', `${label}“${text}”存在多个可能地点，请选择一个。`, geocodes.slice(0, 5))
    }
    const pois = await this.client.placeText(text, city)
    if (pois.length === 1) return pois[0]!
    if (pois.length > 1) {
      throw new MapPlannerError('place_ambiguous', `${label}“${text}”存在多个可能地点，请选择一个。`, pois.slice(0, 5))
    }
    throw new MapPlannerError('place_not_found', `没有找到${label}：${text}`)
  }

  private async planWaypoints(params: {
    origin: PlaceCandidate
    destination: PlaceCandidate
    waypoints: PlaceCandidate[]
    baselineRoute: RouteSummary
    mode: TransportMode
    warnings: string[]
  }): Promise<{ selectedRoute: RouteSummary; waypointOrder?: number[] }> {
    if (params.waypoints.length === 0) {
      return { selectedRoute: params.baselineRoute }
    }

    if (params.mode === 'bicycling') {
      params.warnings.push('多点顺序优化的距离矩阵使用高德 distance 接口近似计算，骑行模式结果请二次确认。')
    }
    if (params.waypoints.length > 8) {
      params.warnings.push('途经点超过 8 个，已使用近似算法，可能非全局最优。')
    }

    const points = [params.origin, ...params.waypoints, params.destination]
    const matrix = await this.client.distanceMatrix(points, params.mode)
    const waypointOrder = params.waypoints.length <= 5
      ? exactWaypointOrder(params.waypoints.length, matrix)
      : approximateWaypointOrder(params.waypoints.length, matrix)
    if (params.waypoints.length > 8) {
      const routeOrder = [0, ...waypointOrder.map((index) => index + 1), params.waypoints.length + 1]
      return {
        selectedRoute: {
          transportMode: params.mode,
          distanceM: params.baselineRoute.distanceM,
          durationSec: Math.max(params.baselineRoute.durationSec, Math.round(pathCost(routeOrder, matrix))),
          polyline: params.baselineRoute.polyline,
          steps: [],
        },
        waypointOrder,
      }
    }
    const orderedWaypoints = waypointOrder.map((index) => params.waypoints[index]!)
    const orderedPoints = [params.origin, ...orderedWaypoints, params.destination]
    const segments: RouteSummary[] = []
    for (let index = 0; index < orderedPoints.length - 1; index += 1) {
      segments.push(await this.client.direction({
        origin: orderedPoints[index]!,
        destination: orderedPoints[index + 1]!,
        mode: params.mode,
      }))
    }
    return {
      selectedRoute: combineRoutes(params.mode, segments),
      waypointOrder,
    }
  }

  private async findAlongRouteRecommendations(params: {
    input: MapPlanRouteInput
    origin: PlaceCandidate
    destination: PlaceCandidate
    baselineRoute: RouteSummary
    mode: TransportMode
  }): Promise<AlongRouteRecommendation[]> {
    const search = params.input.alongRouteSearch
    if (!search) return []
    const samplePoints = samplePolyline(params.baselineRoute, search.samplePoints)
    const places = dedupePlaces((await Promise.all(samplePoints.map((location) =>
      this.client.placeAround({
        keyword: search.keyword,
        location,
        radiusM: search.radiusM,
        limit: search.maxCandidates,
      })))).flat())
    if (places.length === 0) {
      throw new MapPlannerError('poi_not_found', `路线周边没有找到“${search.keyword}”。`)
    }
    const shortList = places
      .map((place) => ({ place, distance: closestPolylineDistance(place, params.baselineRoute) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.min(5, search.maxCandidates))
      .map((item) => item.place)

    const recommendations: AlongRouteRecommendation[] = []
    for (const place of shortList) {
      const first = await this.client.direction({ origin: params.origin, destination: place, mode: params.mode })
      const second = await this.client.direction({ origin: place, destination: params.destination, mode: params.mode })
      const route = combineRoutes(params.mode, [first, second])
      const detourDistanceM = route.distanceM - params.baselineRoute.distanceM
      const detourDurationSec = route.durationSec - params.baselineRoute.durationSec
      recommendations.push({
        place,
        route,
        detourDistanceM,
        detourDurationSec,
        reason: routeReason(detourDurationSec, detourDistanceM),
      })
    }
    return recommendations
      .sort((a, b) => a.detourDurationSec - b.detourDurationSec || a.detourDistanceM - b.detourDistanceM)
      .slice(0, search.maxRecommendations)
  }

  buildWidgetSpec(params: {
    origin: PlaceCandidate
    destination: PlaceCandidate
    waypoints: PlaceCandidate[]
    recommendations: AlongRouteRecommendation[]
    mapImagePath?: string
  }): MapRouteWidgetSpec {
    return {
      type: 'map_route_static',
      title: `${params.origin.name} → ${params.destination.name}`,
      mapImagePath: params.mapImagePath,
      markers: [
        { label: '起点', location: params.origin.location, kind: 'origin' },
        ...params.waypoints.map((point, index) => ({
          label: `途经 ${index + 1}`,
          location: point.location,
          kind: 'waypoint' as const,
        })),
        ...params.recommendations.map((item, index) => ({
          label: `推荐 ${index + 1}`,
          location: item.place.location,
          kind: 'recommendation' as const,
        })),
        { label: '终点', location: params.destination.location, kind: 'destination' },
      ],
      recommendations: params.recommendations.map((item) => ({
        name: item.place.name,
        address: item.place.address,
        detourDurationSec: item.detourDurationSec,
        detourDistanceM: item.detourDistanceM,
        reason: item.reason,
      })),
    }
  }
}

function minutes(sec: number): string {
  return `${Math.round(sec / 60)} 分钟`
}

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} 公里`
}

export function buildMarkdown(params: {
  input: MapPlanRouteInput
  origin: PlaceCandidate
  destination: PlaceCandidate
  baselineRoute: RouteSummary
  selectedRoute: RouteSummary
  recommendations: AlongRouteRecommendation[]
  waypointOrder?: number[]
  warnings: string[]
  metrics: ReturnType<RoutePlannerClient['metrics']>
}): string {
  const lines = [
    '# 行程路线方案',
    '',
    '## 需求摘要',
    `- 起点：${params.origin.name}`,
    `- 终点：${params.destination.name}`,
    `- 交通方式：${params.input.transportMode || 'driving'}`,
    `- 优化偏好：${params.input.optimizationGoal || 'balanced'}`,
    params.input.alongRouteSearch ? `- 顺路搜索：${params.input.alongRouteSearch.keyword}` : '- 顺路搜索：未指定',
    '',
    '## 推荐结论',
    `- 推荐路线总距离：${km(params.selectedRoute.distanceM)}`,
    `- 推荐路线预计用时：${minutes(params.selectedRoute.durationSec)}`,
    `- 基准路线：${km(params.baselineRoute.distanceM)} / ${minutes(params.baselineRoute.durationSec)}`,
    '',
    '## 路线明细',
    `- 起点：${params.origin.name}（${params.origin.location}）`,
    ...(params.waypointOrder
      ? [`- 途经点顺序：${params.waypointOrder.map((index) => `输入第 ${index + 1} 个`).join(' → ')}`]
      : []),
    `- 终点：${params.destination.name}（${params.destination.location}）`,
    '',
    '## 顺路候选',
    ...(params.recommendations.length > 0
      ? params.recommendations.flatMap((item, index) => [
        `- ${index + 1}. ${item.place.name}`,
        `  - 地址：${item.place.address || '未返回'}`,
        `  - 评分：${item.place.rating || '未返回'}`,
        `  - 人均：${item.place.cost || '未返回'}`,
        `  - 绕路：${minutes(item.detourDurationSec)} / ${km(item.detourDistanceM)}`,
        `  - 推荐理由：${item.reason}`,
      ])
      : ['- 未请求或未返回顺路候选。']),
    '',
    '## 地图标注',
    '- 地图静态图会作为 artifact 附带生成。',
    '',
    '## 注意事项',
    '- 数据来自高德地图。',
    '- 实时路况、营业状态可能变化。',
    '- 关键出行请打开高德 App 二次确认。',
    ...params.warnings.map((warning) => `- ${warning}`),
    '',
    '## 调试信息',
    `- API 调用次数：geocode ${params.metrics.apiCalls.geocode} / direction ${params.metrics.apiCalls.direction} / place_around ${params.metrics.apiCalls.place_around} / distance ${params.metrics.apiCalls.distance} / staticmap ${params.metrics.apiCalls.staticmap}`,
    `- 总耗时：${params.metrics.elapsedMs}ms`,
    `- 缓存命中：${params.metrics.cacheHits}`,
    `- 数据时间：${new Date().toISOString()}`,
    '',
  ]
  return lines.join('\n')
}
