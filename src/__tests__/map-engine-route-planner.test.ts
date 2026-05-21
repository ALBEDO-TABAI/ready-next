import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { RoutePlanner, buildMarkdown } from '../main/modules/map-engine'
import { writeMapArtifacts } from '../main/modules/map-engine/artifact-writer'
import { MapPlannerError, type MapMetrics, type PlaceCandidate, type RoutePlannerClient, type RouteSummary, type TransportMode } from '../main/modules/map-engine/types'
import { MapPlanRouteSchema } from '../main/modules/tools/schemas/map-schemas'

const metrics: MapMetrics = {
  apiCalls: {
    geocode: 0,
    direction: 0,
    place_around: 0,
    distance: 0,
    staticmap: 0,
  },
  elapsedMs: 12,
  cacheHits: 0,
}

function place(name: string, location: string): PlaceCandidate {
  return { id: name, name, location, source: 'geocode' }
}

function route(origin: PlaceCandidate, destination: PlaceCandidate, mode: TransportMode, durationSec = 600): RouteSummary {
  return {
    transportMode: mode,
    distanceM: durationSec * 10,
    durationSec,
    polyline: `${origin.location};${destination.location}`,
    steps: [
      {
        instruction: `${origin.name} -> ${destination.name}`,
        distanceM: durationSec * 10,
        durationSec,
        polyline: `${origin.location};${destination.location}`,
      },
    ],
  }
}

class FakeMapClient implements RoutePlannerClient {
  readonly places = new Map<string, PlaceCandidate[]>()
  aroundPlaces: PlaceCandidate[] = []
  matrix: number[][] = []
  directions: Array<[string, string]> = []

  async geocode(address: string): Promise<PlaceCandidate[]> {
    metrics.apiCalls.geocode += 1
    return this.places.get(address) || []
  }

  async placeText(keyword: string): Promise<PlaceCandidate[]> {
    return this.places.get(keyword) || []
  }

  async placeAround(): Promise<PlaceCandidate[]> {
    metrics.apiCalls.place_around += 1
    return this.aroundPlaces
  }

  async direction(params: { origin: PlaceCandidate; destination: PlaceCandidate; mode: TransportMode }): Promise<RouteSummary> {
    metrics.apiCalls.direction += 1
    this.directions.push([params.origin.name, params.destination.name])
    const duration = Math.max(60, Math.round(Math.abs(Number(params.origin.location.split(',')[0]) - Number(params.destination.location.split(',')[0])) * 600))
    return route(params.origin, params.destination, params.mode, duration || 600)
  }

  async distanceMatrix(): Promise<number[][]> {
    metrics.apiCalls.distance += 1
    return this.matrix
  }

  async staticMap(): Promise<Uint8Array> {
    metrics.apiCalls.staticmap += 1
    return new Uint8Array([137, 80, 78, 71])
  }

  metrics(): MapMetrics {
    return metrics
  }

  destroy(): void {}
}

test('RoutePlanner returns ambiguous place candidates without inventing clarification options', async () => {
  const client = new FakeMapClient()
  client.places.set('人民广场', [
    place('人民广场 A', '1,1'),
    place('人民广场 B', '2,2'),
  ])
  client.places.set('外滩', [place('外滩', '3,3')])
  const planner = new RoutePlanner(client)
  const input = MapPlanRouteSchema.parse({ origin: '人民广场', destination: '外滩' })

  await assert.rejects(
    () => planner.plan(input, 'plan-1'),
    (error) => {
      assert.equal(error instanceof MapPlannerError, true)
      assert.equal((error as MapPlannerError).errorKind, 'place_ambiguous')
      assert.equal((error as MapPlannerError).candidates?.length, 2)
      assert.equal('clarificationOptions' in (error as MapPlannerError), false)
      return true
    },
  )
})

test('RoutePlanner computes exact waypoint order for small multi-point plans', async () => {
  const client = new FakeMapClient()
  client.places.set('O', [place('O', '0,0')])
  client.places.set('A', [place('A', '1,0')])
  client.places.set('B', [place('B', '2,0')])
  client.places.set('C', [place('C', '3,0')])
  client.places.set('D', [place('D', '4,0')])
  client.matrix = [
    [0, 5, 1, 5, 5],
    [5, 0, 5, 1, 5],
    [5, 1, 0, 5, 5],
    [5, 5, 5, 0, 1],
    [5, 5, 5, 5, 0],
  ]
  const planner = new RoutePlanner(client)
  const input = MapPlanRouteSchema.parse({
    origin: 'O',
    destination: 'D',
    waypoints: ['A', 'B', 'C'],
  })
  const result = await planner.plan(input, 'plan-2')

  assert.deepEqual(result.waypointOrder, [1, 0, 2])
})

test('RoutePlanner accepts coordinate strings without geocoding them as addresses', async () => {
  metrics.apiCalls.geocode = 0
  const client = new FakeMapClient()
  client.matrix = [
    [0, 1],
    [1, 0],
  ]
  const planner = new RoutePlanner(client)
  const input = MapPlanRouteSchema.parse({
    origin: '104.052203,30.668360',
    destination: '104.051813,30.661877',
    transportMode: 'walking',
  })

  const result = await planner.plan(input, 'plan-coordinate-string')

  assert.equal(result.origin.location, '104.052203,30.668360')
  assert.equal(result.origin.source, 'input')
  assert.equal(result.destination.location, '104.051813,30.661877')
  assert.equal(metrics.apiCalls.geocode, 0)
})

test('RoutePlanner keeps large waypoint plans inside request budget by avoiding segment directions', async () => {
  const client = new FakeMapClient()
  client.places.set('O', [place('O', '0,0')])
  client.places.set('D', [place('D', '10,0')])
  const waypoints = Array.from({ length: 9 }, (_, index) => `P${index + 1}`)
  for (const [index, name] of waypoints.entries()) {
    client.places.set(name, [place(name, `${index + 1},0`)])
  }
  const size = waypoints.length + 2
  client.matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? 0 : Math.abs(column - row) + 1))
  const planner = new RoutePlanner(client)
  const input = MapPlanRouteSchema.parse({
    origin: 'O',
    destination: 'D',
    waypoints,
  })
  const result = await planner.plan(input, 'plan-large')

  assert.equal(client.directions.length, 1)
  assert.equal(result.warnings.some((warning) => warning.includes('近似算法')), true)
  assert.equal(result.selectedRoute.steps.length, 0)
})

test('RoutePlanner ranks along-route recommendations by detour and writes key-free artifacts', async () => {
  const client = new FakeMapClient()
  client.places.set('O', [place('O', '0,0')])
  client.places.set('D', [place('D', '10,0')])
  client.aroundPlaces = [
    { ...place('咖啡 A', '2,0'), address: 'A 路', rating: '4.8' },
    { ...place('咖啡 B', '8,0'), address: 'B 路' },
  ]
  const planner = new RoutePlanner(client)
  const input = MapPlanRouteSchema.parse({
    origin: 'O',
    destination: 'D',
    alongRouteSearch: {
      keyword: '咖啡',
      samplePoints: 1,
      maxCandidates: 2,
      maxRecommendations: 1,
    },
  })
  const plannerResult = await planner.plan(input, 'plan-3')

  assert.equal(plannerResult.recommendations.length, 1)
  assert.match(plannerResult.documentDraftMarkdown, /## 调试信息/)

  const outputsRoot = await mkdtemp(join(tmpdir(), 'ready-map-test-'))
  try {
    const artifacts = await writeMapArtifacts({
      outputsRoot,
      plannerResult,
      client,
      includeStaticMap: true,
    })
    const markdown = await readFile(artifacts.artifacts.markdownPath, 'utf8')
    const json = await readFile(artifacts.artifacts.jsonPath, 'utf8')

    assert.match(markdown, /# 行程路线方案/)
    assert.match(json, /"ok"/)
    const leakedKeyParam = new RegExp(['key', '='].join(''), 'i')
    assert.doesNotMatch(markdown, leakedKeyParam)
    assert.doesNotMatch(json, leakedKeyParam)
  } finally {
    await rm(outputsRoot, { recursive: true, force: true })
  }
})

test('buildMarkdown uses 未返回 for missing POI optional fields', () => {
  const origin = place('O', '0,0')
  const destination = place('D', '1,0')
  const recommendationRoute = route(origin, destination, 'driving')
  const markdown = buildMarkdown({
    input: MapPlanRouteSchema.parse({ origin: 'O', destination: 'D', alongRouteSearch: { keyword: '咖啡' } }),
    origin,
    destination,
    baselineRoute: recommendationRoute,
    selectedRoute: recommendationRoute,
    recommendations: [{
      place: place('咖啡', '0.5,0'),
      route: recommendationRoute,
      detourDistanceM: 0,
      detourDurationSec: 0,
      reason: '基本顺路',
    }],
    warnings: [],
    metrics,
  })

  assert.match(markdown, /评分：未返回/)
  assert.match(markdown, /人均：未返回/)
})
