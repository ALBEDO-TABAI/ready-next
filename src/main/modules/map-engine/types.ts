import type { MapPlanRouteInput } from '../tools/schemas/map-schemas'

export type TransportMode = 'driving' | 'walking' | 'bicycling'
export type MapErrorKind =
  | 'amap_not_configured'
  | 'amap_auth_failed'
  | 'amap_rate_limited'
  | 'place_ambiguous'
  | 'place_not_found'
  | 'route_not_found'
  | 'poi_not_found'
  | 'unsupported_transport_mode'
  | 'network_failed'

export interface MapMetrics {
  apiCalls: {
    geocode: number
    direction: number
    place_around: number
    distance: number
    staticmap: number
  }
  elapsedMs: number
  cacheHits: number
}

export interface PlaceCandidate {
  id?: string
  name: string
  address?: string
  location: string
  city?: string
  district?: string
  rating?: string
  cost?: string
  source: 'input' | 'geocode' | 'place_text' | 'place_around'
}

export interface RouteStep {
  instruction: string
  distanceM: number
  durationSec: number
  polyline: string
}

export interface RouteSummary {
  transportMode: TransportMode
  distanceM: number
  durationSec: number
  polyline: string
  steps: RouteStep[]
  segments?: RouteSummary[]
}

export interface AlongRouteRecommendation {
  place: PlaceCandidate
  route: RouteSummary
  detourDistanceM: number
  detourDurationSec: number
  reason: string
}

export interface MapRouteWidgetSpec {
  type: 'map_route_static'
  title: string
  mapImagePath?: string
  markers: Array<{ label: string; location: string; kind: 'origin' | 'destination' | 'waypoint' | 'recommendation' }>
  recommendations: Array<{
    name: string
    address?: string
    detourDurationSec: number
    detourDistanceM: number
    reason: string
  }>
}

export interface MapArtifacts {
  jsonPath: string
  markdownPath: string
  mapImagePath?: string
}

export interface MapPlanSuccess {
  ok: true
  planId: string
  origin: PlaceCandidate
  destination: PlaceCandidate
  baselineRoute: RouteSummary
  selectedRoute: RouteSummary
  recommendations: AlongRouteRecommendation[]
  waypointOrder?: number[]
  documentDraftMarkdown: string
  widgetSpec: MapRouteWidgetSpec
  artifacts: MapArtifacts
  metrics: MapMetrics
  warnings: string[]
}

export interface MapPlanFailure {
  ok: false
  errorKind: MapErrorKind
  message: string
  candidates?: PlaceCandidate[]
  metrics?: MapMetrics
}

export type MapPlanRouteResult = MapPlanSuccess | MapPlanFailure

export interface AmapRuntimeConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
}

export interface PlanMapRouteOptions {
  amapConfig: AmapRuntimeConfig
  outputsRoot: string
  signal?: AbortSignal
  sessionId?: string
  requestModuleToolAction?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

export interface RoutePlannerClient {
  geocode(address: string, city?: string): Promise<PlaceCandidate[]>
  placeText(keyword: string, city?: string): Promise<PlaceCandidate[]>
  placeAround(params: { keyword: string; location: string; radiusM: number; limit: number }): Promise<PlaceCandidate[]>
  direction(params: { origin: PlaceCandidate; destination: PlaceCandidate; mode: TransportMode }): Promise<RouteSummary>
  distanceMatrix(points: PlaceCandidate[], mode: TransportMode): Promise<number[][]>
  staticMap(params: {
    points: PlaceCandidate[]
    route: RouteSummary
    recommendations: AlongRouteRecommendation[]
  }): Promise<Uint8Array>
  metrics(): MapMetrics
  destroy(): void
}

export interface RoutePlannerResult {
  input: MapPlanRouteInput
  planId: string
  origin: PlaceCandidate
  destination: PlaceCandidate
  waypoints: PlaceCandidate[]
  baselineRoute: RouteSummary
  selectedRoute: RouteSummary
  recommendations: AlongRouteRecommendation[]
  waypointOrder?: number[]
  widgetSpec: MapRouteWidgetSpec
  documentDraftMarkdown: string
  warnings: string[]
}

export class MapPlannerError extends Error {
  constructor(
    public readonly errorKind: MapErrorKind,
    message: string,
    public readonly candidates?: PlaceCandidate[],
  ) {
    super(message)
    this.name = 'MapPlannerError'
  }
}
