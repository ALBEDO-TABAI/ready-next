import { compileDocumentWidgetSpec, type DocumentWidgetComponentSpec } from './document-widget-openui'
import { compileWidgetSkeletonSpec, type WidgetSkeletonSpec } from './document-widget-skeletons'
import type {
  DocumentWidgetComponentSpecSummary,
  DocumentWidgetSkeletonSpecSummary,
} from './document-widget-parse'
import { BoundedLruCache } from './bounded-lru'
import { recordDocumentPerformanceCounter } from './document-performance-diagnostics'

export interface ResolveDocumentWidgetRenderCodeInput {
  widgetCode: string
  skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
  componentSpec?: DocumentWidgetComponentSpecSummary | null
}

export interface ResolvedDocumentWidgetRenderCode {
  widgetCode: string
  source: 'skeleton_spec' | 'component_spec' | 'stored_widget_code'
  error: string | null
}

const renderCodeCache = new BoundedLruCache<string, ResolvedDocumentWidgetRenderCode>(128)
let renderCodeCompileCount = 0

function getRenderCodeCacheKey(input: ResolveDocumentWidgetRenderCodeInput): string {
  return JSON.stringify([input.widgetCode, input.skeletonSpec || null, input.componentSpec || null])
}

export function resolveDocumentWidgetRenderCode(
  input: ResolveDocumentWidgetRenderCodeInput,
): ResolvedDocumentWidgetRenderCode {
  const cacheKey = getRenderCodeCacheKey(input)
  const cached = renderCodeCache.get(cacheKey)
  if (cached) return cached
  let result: ResolvedDocumentWidgetRenderCode
  try {
    if (input.skeletonSpec?.skeleton) {
      const compiled = compileWidgetSkeletonSpec(input.skeletonSpec as WidgetSkeletonSpec)
      result = { widgetCode: compiled.widgetCode, source: 'skeleton_spec', error: null }
    } else if (input.componentSpec?.component) {
      const compiled = compileDocumentWidgetSpec(input.componentSpec as DocumentWidgetComponentSpec)
      result = { widgetCode: compiled.widgetCode, source: 'component_spec', error: null }
    } else {
      result = { widgetCode: input.widgetCode, source: 'stored_widget_code', error: null }
    }
  } catch (error) {
    result = {
      widgetCode: input.widgetCode,
      source: 'stored_widget_code',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  recordDocumentPerformanceCounter('widgetCompiles')
  renderCodeCompileCount += 1
  renderCodeCache.set(cacheKey, result)
  return result
}

export function __resetDocumentWidgetRenderCodeCacheForTests(): void {
  renderCodeCache.clear()
  renderCodeCompileCount = 0
}

export function __getDocumentWidgetRenderCodeCacheStatsForTests(): { size: number; compileCount: number } {
  return { size: renderCodeCache.size, compileCount: renderCodeCompileCount }
}
