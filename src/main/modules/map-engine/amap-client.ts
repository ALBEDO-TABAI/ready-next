import type {
  AmapRuntimeConfig,
  MapMetrics,
  PlaceCandidate,
  RoutePlannerClient,
  RouteStep,
  RouteSummary,
  TransportMode,
  AlongRouteRecommendation,
} from './types'
import { MapPlannerError } from './types'
import { AmapRateLimitedError, MapRateLimiter } from './rate-limiter'
import { MapRequestCache } from './request-cache'

type ApiCallKind = keyof MapMetrics['apiCalls']

interface AmapJsonResponse {
  status?: string
  info?: string
  infocode?: string
  errcode?: number
  errmsg?: string
  geocodes?: unknown[]
  pois?: unknown[]
  route?: {
    paths?: unknown[]
  }
  data?: {
    paths?: unknown[]
  }
  results?: unknown[]
}

function createMetrics(): MapMetrics {
  return {
    apiCalls: {
      geocode: 0,
      direction: 0,
      place_around: 0,
      distance: 0,
      staticmap: 0,
    },
    elapsedMs: 0,
    cacheHits: 0,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function normalizeBaseUrl(value: string): string {
  const trimmed = String(value || '').trim() || 'https://restapi.amap.com'
  return trimmed.replace(/\/+$/, '')
}

function cacheKey(endpoint: string, params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([key, value]) => key !== 'key' && value !== undefined && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
  return `${endpoint}?${entries.map(([key, value]) => `${key}=${String(value)}`).join('&')}`
}

function normalizeLocation(value: string): string {
  const [lng, lat] = value.split(',').map((part) => Number(part.trim()))
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return value
  return `${lng.toFixed(6)},${lat.toFixed(6)}`
}

function readPoi(candidate: unknown, source: PlaceCandidate['source']): PlaceCandidate | null {
  const record = asRecord(candidate)
  const location = normalizeLocation(asString(record.location))
  if (!location) return null
  const name = asString(record.name) || asString(record.formatted_address) || location
  return {
    id: asString(record.id) || undefined,
    name,
    address: asString(record.address) || asString(record.formatted_address) || undefined,
    location,
    city: asString(record.cityname) || asString(record.city) || undefined,
    district: asString(record.adname) || asString(record.district) || undefined,
    rating: asString(record.biz_ext && asRecord(record.biz_ext).rating) || undefined,
    cost: asString(record.biz_ext && asRecord(record.biz_ext).cost) || undefined,
    source,
  }
}

function combineSignals(signal?: AbortSignal, timeoutMs = 10_000): AbortSignal {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Amap request timeout')), timeoutMs)
  const abort = () => controller.abort(signal?.reason || new Error('Operation aborted'))
  if (signal?.aborted) {
    abort()
  } else {
    signal?.addEventListener('abort', abort, { once: true })
  }
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }, { once: true })
  return controller.signal
}

function assertAmapOk(payload: AmapJsonResponse): void {
  if (payload.status === '1' || payload.errcode === 0) return
  const infocode = String(payload.infocode || payload.errcode || '')
  const info = String(payload.info || payload.errmsg || '高德地图请求失败')
  if (infocode === '10021') throw new AmapRateLimitedError(info)
  if (infocode === '10001' || infocode === '10002' || infocode === '10003' || infocode === '10007') {
    throw new MapPlannerError('amap_auth_failed', `高德地图鉴权失败：${info}`)
  }
  throw new MapPlannerError('network_failed', `高德地图请求失败：${infocode || 'unknown'} ${info}`)
}

function parseRoutePath(rawPath: unknown, mode: TransportMode): RouteSummary {
  const path = asRecord(rawPath)
  const steps = Array.isArray(path.steps) ? path.steps : []
  const parsedSteps: RouteStep[] = steps.map((rawStep) => {
    const step = asRecord(rawStep)
    return {
      instruction: asString(step.instruction) || asString(step.action) || '',
      distanceM: asNumber(step.distance),
      durationSec: asNumber(step.duration),
      polyline: asString(step.polyline),
    }
  })
  const polyline = parsedSteps.map((step) => step.polyline).filter(Boolean).join(';')
  return {
    transportMode: mode,
    distanceM: asNumber(path.distance),
    durationSec: asNumber(path.duration),
    polyline: asString(path.polyline) || polyline,
    steps: parsedSteps,
  }
}

export class AmapClient implements RoutePlannerClient {
  private readonly baseUrl: string
  private readonly cache = new MapRequestCache()
  private readonly startedAt = Date.now()
  private readonly currentMetrics = createMetrics()
  private readonly limiter: MapRateLimiter

  constructor(
    private readonly config: AmapRuntimeConfig,
    private readonly options: { signal?: AbortSignal; maxRequests?: number } = {},
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl)
    this.limiter = new MapRateLimiter(this.currentMetrics, {
      maxRequests: options.maxRequests ?? 20,
      signal: options.signal,
    })
  }

  async geocode(address: string, city?: string): Promise<PlaceCandidate[]> {
    const endpoint = '/v3/geocode/geo'
    const params = { address, city, output: 'JSON' }
    return this.cached(endpoint, params, async () => {
      const payload = await this.requestJson(endpoint, params, 'geocode')
      return (payload.geocodes || [])
        .map((item) => readPoi(item, 'geocode'))
        .filter((item): item is PlaceCandidate => Boolean(item))
    })
  }

  async placeText(keyword: string, city?: string): Promise<PlaceCandidate[]> {
    const endpoint = '/v3/place/text'
    const params = { keywords: keyword, city, output: 'JSON', offset: 10, page: 1 }
    return this.cached(endpoint, params, async () => {
      const payload = await this.requestJson(endpoint, params, 'place_around')
      return (payload.pois || [])
        .map((item) => readPoi(item, 'place_text'))
        .filter((item): item is PlaceCandidate => Boolean(item))
    })
  }

  async placeAround(params: { keyword: string; location: string; radiusM: number; limit: number }): Promise<PlaceCandidate[]> {
    const endpoint = '/v3/place/around'
    const requestParams = {
      keywords: params.keyword,
      location: params.location,
      radius: params.radiusM,
      offset: params.limit,
      page: 1,
      output: 'JSON',
    }
    return this.cached(endpoint, requestParams, async () => {
      const payload = await this.requestJson(endpoint, requestParams, 'place_around')
      return (payload.pois || [])
        .map((item) => readPoi(item, 'place_around'))
        .filter((item): item is PlaceCandidate => Boolean(item))
    })
  }

  async direction(params: { origin: PlaceCandidate; destination: PlaceCandidate; mode: TransportMode }): Promise<RouteSummary> {
    const endpoint = params.mode === 'bicycling'
      ? '/v4/direction/bicycling'
      : `/v3/direction/${params.mode}`
    const requestParams = {
      origin: params.origin.location,
      destination: params.destination.location,
      output: 'JSON',
    }
    return this.cached(endpoint, requestParams, async () => {
      const payload = await this.requestJson(endpoint, requestParams, 'direction')
      const paths = params.mode === 'bicycling'
        ? payload.data?.paths || []
        : payload.route?.paths || []
      const path = paths[0]
      if (!path) {
        throw new MapPlannerError('route_not_found', '高德地图未返回可用路线。')
      }
      return parseRoutePath(path, params.mode)
    })
  }

  async distanceMatrix(points: PlaceCandidate[], mode: TransportMode): Promise<number[][]> {
    const matrix = points.map(() => points.map(() => 0))
    const distanceType = mode === 'walking' ? 3 : 1
    for (let destinationIndex = 1; destinationIndex < points.length; destinationIndex += 1) {
      const destination = points[destinationIndex]!
      const origins = points.map((point) => point.location).join('|')
      const endpoint = '/v3/distance'
      const requestParams = {
        origins,
        destination: destination.location,
        type: distanceType,
        output: 'JSON',
      }
      const payload = await this.cached(endpoint, requestParams, () =>
        this.requestJson(endpoint, requestParams, 'distance'))
      const results = Array.isArray(payload.results) ? payload.results : []
      for (const result of results) {
        const record = asRecord(result)
        const originId = Math.max(0, asNumber(record.origin_id) - 1)
        if (originId < points.length) {
          matrix[originId]![destinationIndex] = asNumber(record.duration) || asNumber(record.distance)
        }
      }
    }
    return matrix
  }

  async staticMap(params: {
    points: PlaceCandidate[]
    route: RouteSummary
    recommendations: AlongRouteRecommendation[]
  }): Promise<Uint8Array> {
    const markerPoints = [
      ...params.points,
      ...params.recommendations.map((recommendation) => recommendation.place),
    ]
    const markers = markerPoints
      .map((point, index) => `mid,0xFF4D4F,${index + 1}:${point.location}`)
      .join(';')
    const endpoint = '/v3/staticmap'
    const requestParams = {
      markers,
      size: '900*520',
      scale: 2,
      output: 'PNG',
    }
    const key = cacheKey(endpoint, requestParams)
    const cached = this.cache.get<Uint8Array>(key)
    if (cached) return cached
    const image = await this.limiter.run('staticmap', async () => {
      const url = this.buildUrl(endpoint, requestParams)
      const response = await fetch(url, {
        method: 'GET',
        signal: combineSignals(this.options.signal, 10_000),
      })
      if (!response.ok) {
        throw new MapPlannerError('network_failed', `静态地图请求失败：HTTP ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    })
    return this.cache.set(key, image)
  }

  metrics(): MapMetrics {
    return {
      apiCalls: { ...this.currentMetrics.apiCalls },
      elapsedMs: Date.now() - this.startedAt,
      cacheHits: this.cache.hitCount,
    }
  }

  destroy(): void {
    this.cache.clear()
  }

  private async cached<T>(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    load: () => Promise<T>,
  ): Promise<T> {
    const key = cacheKey(endpoint, params)
    const cached = this.cache.get<T>(key)
    if (cached) return cached
    const value = await load()
    return this.cache.set(key, value)
  }

  private async requestJson(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    kind: ApiCallKind,
  ): Promise<AmapJsonResponse> {
    try {
      return await this.limiter.run(kind, async () => {
        const response = await fetch(this.buildUrl(endpoint, params), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: combineSignals(this.options.signal, 10_000),
        })
        if (!response.ok) {
          throw new MapPlannerError('network_failed', `高德地图请求失败：HTTP ${response.status}`)
        }
        const payload = await response.json() as AmapJsonResponse
        assertAmapOk(payload)
        return payload
      })
    } catch (error) {
      if (error instanceof MapPlannerError || error instanceof AmapRateLimitedError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new MapPlannerError('network_failed', error instanceof Error ? error.message : String(error))
    }
  }

  private buildUrl(endpoint: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(endpoint, this.baseUrl)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
    url.searchParams.set('key', this.config.apiKey)
    return url.toString()
  }
}
