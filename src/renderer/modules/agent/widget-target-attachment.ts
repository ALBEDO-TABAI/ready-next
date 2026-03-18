import type { ChatAttachment } from './types'

export interface DocumentWidgetTargetContext {
  documentTitle: string
  documentPath: string | null
  widgetTitle: string
  widgetCode: string
  widgetMode?: string | null
}

export function buildWidgetTargetUpdatePrompt(widgetTitle: string): string {
  return `更新当前文档里的 ${widgetTitle} widget：`
}

export function createDocumentWidgetTargetAttachment(context: DocumentWidgetTargetContext): ChatAttachment {
  const normalizedPath = context.documentPath || `document-widget://${encodeURIComponent(context.widgetTitle)}`
  return {
    id: `attach-doc-widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `更新 ${context.widgetTitle}`,
    path: normalizedPath,
    type: 'text',
    size: context.widgetCode.length,
    ext: '.md',
    source: 'document-widget-target',
    title: context.widgetTitle,
    documentTitle: context.documentTitle,
    widgetTitle: context.widgetTitle,
    widgetCode: context.widgetCode,
    widgetMode: context.widgetMode || undefined,
    excerpt: context.widgetCode.slice(0, 2000),
  }
}
