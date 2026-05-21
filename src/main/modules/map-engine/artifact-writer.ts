import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  MapArtifacts,
  RoutePlannerClient,
  RoutePlannerResult,
} from './types'
import { buildMarkdown } from './route-planner'

export async function writeMapArtifacts(params: {
  outputsRoot: string
  plannerResult: RoutePlannerResult
  client: RoutePlannerClient
  includeStaticMap: boolean
}): Promise<{ artifacts: MapArtifacts; markdown: string; mapImagePath?: string; warnings: string[] }> {
  const warnings = [...params.plannerResult.warnings]
  const outputDir = join(params.outputsRoot, 'map-planner', params.plannerResult.planId)
  await mkdir(outputDir, { recursive: true })

  let mapImagePath: string | undefined
  if (params.includeStaticMap) {
    try {
      const image = await params.client.staticMap({
        points: [
          params.plannerResult.origin,
          ...params.plannerResult.waypoints,
          params.plannerResult.destination,
        ],
        route: params.plannerResult.selectedRoute,
        recommendations: params.plannerResult.recommendations,
      })
      mapImagePath = join(outputDir, 'route-map.png')
      await writeFile(mapImagePath, image)
    } catch (error) {
      warnings.push(`静态地图生成失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const widgetSpec = {
    ...params.plannerResult.widgetSpec,
    mapImagePath,
  }
  const metrics = params.client.metrics()
  const markdown = buildMarkdown({
    input: params.plannerResult.input,
    origin: params.plannerResult.origin,
    destination: params.plannerResult.destination,
    baselineRoute: params.plannerResult.baselineRoute,
    selectedRoute: params.plannerResult.selectedRoute,
    recommendations: params.plannerResult.recommendations,
    waypointOrder: params.plannerResult.waypointOrder,
    warnings,
    metrics,
  })
  const markdownPath = join(outputDir, 'route-plan.md')
  const jsonPath = join(outputDir, 'route-plan.json')
  await writeFile(markdownPath, markdown, 'utf8')
  await writeFile(jsonPath, JSON.stringify({
    ok: true,
    ...params.plannerResult,
    widgetSpec,
    documentDraftMarkdown: markdown,
    artifacts: {
      jsonPath,
      markdownPath,
      mapImagePath,
    },
    metrics,
    warnings,
  }, null, 2), 'utf8')

  return {
    artifacts: {
      jsonPath,
      markdownPath,
      mapImagePath,
    },
    markdown,
    mapImagePath,
    warnings,
  }
}
