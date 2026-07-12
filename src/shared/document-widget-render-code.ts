import { compileDocumentWidgetSpec, type DocumentWidgetComponentSpec } from './document-widget-openui'
import { compileWidgetSkeletonSpec, type WidgetSkeletonSpec } from './document-widget-skeletons'
import type {
  DocumentWidgetComponentSpecSummary,
  DocumentWidgetSkeletonSpecSummary,
} from './document-widget-parse'

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

export function resolveDocumentWidgetRenderCode(
  input: ResolveDocumentWidgetRenderCodeInput,
): ResolvedDocumentWidgetRenderCode {
  try {
    if (input.skeletonSpec?.skeleton) {
      const compiled = compileWidgetSkeletonSpec(input.skeletonSpec as WidgetSkeletonSpec)
      return { widgetCode: compiled.widgetCode, source: 'skeleton_spec', error: null }
    }
    if (input.componentSpec?.component) {
      const compiled = compileDocumentWidgetSpec(input.componentSpec as DocumentWidgetComponentSpec)
      return { widgetCode: compiled.widgetCode, source: 'component_spec', error: null }
    }
  } catch (error) {
    return {
      widgetCode: input.widgetCode,
      source: 'stored_widget_code',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return { widgetCode: input.widgetCode, source: 'stored_widget_code', error: null }
}
