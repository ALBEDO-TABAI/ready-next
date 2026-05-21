import { randomUUID } from 'node:crypto'

import { AmapClient } from './amap-client'
import { writeMapArtifacts } from './artifact-writer'
import { RoutePlanner } from './route-planner'
import {
  MapPlannerError,
  type MapMetrics,
  type MapPlanRouteResult,
  type PlanMapRouteOptions,
} from './types'
import type { MapPlanRouteInput } from '../tools/schemas/map-schemas'

function emptyMetrics(): MapMetrics {
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

async function presentArtifact(params: {
  requestModuleToolAction?: PlanMapRouteOptions['requestModuleToolAction']
  path?: string
  reason: string
  sessionId?: string
  warnings: string[]
}): Promise<void> {
  if (!params.requestModuleToolAction || !params.path) return
  try {
    await params.requestModuleToolAction('renderer:present-file', {
      path: params.path,
      reason: params.reason,
      sessionId: params.sessionId ?? null,
    })
  } catch (error) {
    params.warnings.push(`artifact 呈现失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function planMapRoute(
  input: MapPlanRouteInput,
  options: PlanMapRouteOptions,
): Promise<MapPlanRouteResult> {
  if (!options.amapConfig.enabled || !options.amapConfig.apiKey) {
    const message = options.amapConfig.apiKey && !options.amapConfig.enabled
      ? '高德地图 API Key 已保存，但服务还没启用。请在 Ready 设置页的外部服务中打开“高德地图”的启用开关并保存。'
      : '高德地图 API Key 还没配置。请在 Ready 设置页的外部服务中启用“高德地图”并填写新 key。'
    return {
      ok: false,
      errorKind: 'amap_not_configured',
      message,
      metrics: emptyMetrics(),
    }
  }

  const planId = `map-${randomUUID()}`
  const client = new AmapClient(options.amapConfig, {
    signal: options.signal,
    maxRequests: 20,
  })
  try {
    const planner = new RoutePlanner(client)
    const planned = await planner.plan(input, planId)
    const artifacts = await writeMapArtifacts({
      outputsRoot: options.outputsRoot,
      plannerResult: planned,
      client,
      includeStaticMap: input.output?.includeStaticMap !== false,
    })
    const widgetSpec = {
      ...planned.widgetSpec,
      mapImagePath: artifacts.mapImagePath,
    }
    await presentArtifact({
      requestModuleToolAction: options.requestModuleToolAction,
      path: artifacts.artifacts.markdownPath,
      reason: '地图行程规划 Markdown',
      sessionId: options.sessionId,
      warnings: artifacts.warnings,
    })
    await presentArtifact({
      requestModuleToolAction: options.requestModuleToolAction,
      path: artifacts.artifacts.mapImagePath,
      reason: '地图静态标注图',
      sessionId: options.sessionId,
      warnings: artifacts.warnings,
    })

    return {
      ok: true,
      planId,
      origin: planned.origin,
      destination: planned.destination,
      baselineRoute: planned.baselineRoute,
      selectedRoute: planned.selectedRoute,
      recommendations: planned.recommendations,
      waypointOrder: planned.waypointOrder,
      documentDraftMarkdown: artifacts.markdown,
      widgetSpec,
      artifacts: artifacts.artifacts,
      metrics: client.metrics(),
      warnings: artifacts.warnings,
    }
  } catch (error) {
    const metrics = client.metrics()
    if (error instanceof MapPlannerError) {
      return {
        ok: false,
        errorKind: error.errorKind,
        message: error.message,
        candidates: error.candidates,
        metrics,
      }
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    return {
      ok: false,
      errorKind: 'network_failed',
      message: error instanceof Error ? error.message : String(error),
      metrics,
    }
  } finally {
    client.destroy()
  }
}

export * from './types'
export { AmapClient } from './amap-client'
export { RoutePlanner, buildMarkdown } from './route-planner'
