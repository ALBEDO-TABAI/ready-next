import type { ChatAttachment } from './types'
import { useDocTabs } from '../../stores/useDocTabs'
import { collectDocumentWidgets } from '../../../shared/document-widget-parse'

export interface DocumentWidgetTargetContext {
  documentTitle: string
  documentPath: string | null
  tabId?: string | null
  widgetTitle: string
  widgetId?: string | null
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
    tabId: context.tabId || undefined,
    widgetTitle: context.widgetTitle,
    widgetId: context.widgetId || undefined,
    widgetCode: context.widgetCode,
    widgetMode: context.widgetMode || undefined,
    excerpt: context.widgetCode.slice(0, 2000),
  }
}

/**
 * Re-read the target widget from the live doc store so cross-round prompts
 * reference the latest widget code, not the snapshot captured at click time.
 * Returns null only when the tab is open but the widget has been removed —
 * in that case the attachment is truly stale and must be dropped. If the tab
 * is missing entirely (e.g., test scaffolding, cross-surface attachment), the
 * original attachment is returned unchanged.
 */
export function refreshDocumentWidgetTargetSnapshot(attachment: ChatAttachment): ChatAttachment | null {
  if (attachment.source !== 'document-widget-target') return attachment
  const tabId = attachment.tabId
  if (!tabId) return attachment
  const tab = useDocTabs.getState().tabs.find((item) => item.id === tabId)
  if (!tab) return attachment
  const records = collectDocumentWidgets(tab.content)
  const byId = attachment.widgetId
    ? records.find((record) => record.id === attachment.widgetId)
    : null
  const byTitle = !byId && attachment.widgetTitle
    ? records.find((record) => record.title === attachment.widgetTitle
      || record.title.toLowerCase() === attachment.widgetTitle!.toLowerCase())
    : null
  const match = byId || byTitle
  if (!match) return null
  if (match.widgetCode === attachment.widgetCode) return attachment
  return {
    ...attachment,
    widgetTitle: match.title,
    widgetId: match.id,
    widgetCode: match.widgetCode,
    widgetMode: match.mode,
    size: match.widgetCode.length,
    excerpt: match.widgetCode.slice(0, 2000),
  }
}
