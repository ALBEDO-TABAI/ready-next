import { calendarRecordToEvent } from '../../calendar-engine/calendar-row-codec'
import { createHash } from 'node:crypto'

import { persistableCalendarEventId } from '../../../../shared/calendar-event-identity'
import type {
  CodexCurrentDocumentAnchor,
  SendScopedRequest,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { DatabaseManager } from '../../database'
import { resolveTrustedBrowserReference } from '../runtime-core/trusted-browser-environment'
import type { CodexResolvedInlineResource } from './codex-explicit-resources'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'

export type CodexRendererToolActionRequester = (payload: {
  agent?: string
  sessionId: string
  runId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  actionIdentityDigest: string
  tool: string
  args: Record<string, unknown>
  abortSignal: AbortSignal
}) => Promise<Record<string, unknown>>

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function trustedBrowserReferenceInput(
  reference: Awaited<ReturnType<typeof resolveTrustedBrowserReference>>,
): CodexResolvedInlineResource | null {
  if (!reference) return null
  const context = reference.context
  const text = [
    '用户明确引用的网页（由 Ready 主进程现场读取）：',
    `标题：${context.title || '(无标题)'}`,
    `链接：${context.url}`,
    context.heading ? `主标题：${context.heading}` : null,
    context.selection ? `页面选中文本：${context.selection}` : null,
    context.excerpt ? `页面正文摘录：${context.excerpt}` : null,
  ].filter(Boolean).join('\n')
  return {
    name: context.title || context.url,
    path: context.url,
    text,
    digest: sha256(JSON.stringify({
      pageRef: reference.environment.browserPageRef,
      context,
    })),
  }
}

export function trustedCalendarReferenceInput(event: NonNullable<ReturnType<DatabaseManager['calendar']['getCalendarEventById']>>): CodexResolvedInlineResource {
  const details = calendarRecordToEvent(event)
  const canonical = {
    id: event.id,
    calendarId: event.calendar_id,
    title: event.title,
    description: event.description,
    location: event.location,
    startTime: event.start_time,
    endTime: event.end_time,
    allDay: event.all_day === 1,
    recurrenceRule: event.recurrence_rule,
    startTimezone: event.start_tz,
    endTimezone: event.end_tz,
    updatedAt: event.updated_at,
    revision: details.revision,
    conferenceUrl: details.conferenceUrl,
    url: details.url,
    attendees: details.attendees,
    reminders: details.reminders,
    status: details.status,
    transparency: details.transparency,
    visibility: details.visibility,
    startDate: details.allDay ? details.start : null,
    endDate: details.allDay ? details.end : null,
  }
  return {
    name: event.title || '日程',
    path: `calendar-event://${event.id}`,
    text: [
      '用户明确引用的日程（由 Ready 主进程现场读取）：',
      `标题：${event.title || '(无标题日程)'}`,
      `开始：${new Date(event.start_time * 1000).toISOString()}`,
      `结束：${new Date(event.end_time * 1000).toISOString()}`,
      `全天：${event.all_day === 1 ? '是' : '否'}`,
      event.location ? `地点：${event.location}` : null,
      event.description ? `备注：${event.description}` : null,
    ].filter(Boolean).join('\n'),
    digest: sha256(JSON.stringify(canonical)),
  }
}

export function trustedRssItemInput(item: NonNullable<ReturnType<DatabaseManager['rss']['getRSSItemsByIds']>[number]>): CodexResolvedInlineResource {
  const summary = String(item.summary || '').slice(0, 1200)
  return {
    name: item.title || 'RSS 条目',
    path: item.link || null,
    text: [
      '用户明确引用的 RSS 条目（由 Ready 主进程现场读取）：',
      `标题：${item.title || '(无标题)'}`,
      item.source_id ? `来源：${item.source_id}` : null,
      item.link ? `链接：${item.link}` : null,
      summary ? `摘要：${summary}` : null,
    ].filter(Boolean).join('\n'),
    digest: sha256(JSON.stringify({
      id: item.id,
      title: item.title,
      link: item.link,
      summary,
      publishedAt: item.published_at,
    })),
  }
}

export function trustedRssSourceInput(source: NonNullable<ReturnType<DatabaseManager['rss']['getRSSSources']>[number]>): CodexResolvedInlineResource {
  return {
    name: source.name || 'RSS 源',
    path: source.url,
    text: [
      '用户明确引用的 RSS 订阅源（由 Ready 主进程现场读取）：',
      `名称：${source.name}`,
      `地址：${source.url}`,
    ].join('\n'),
    digest: sha256(JSON.stringify({ id: source.id, url: source.url, name: source.name })),
  }
}

export function extractProductSurfaceTargets(
  resources: NonNullable<SendScopedRequest['resources']>,
): PreparedCodexProductRun['productSurfaceTargets'] {
  const rssItem = resources.find((resource) => resource.kind === 'rss_item')
  const rssSource = resources.find((resource) => resource.kind === 'rss_source')
  const articleRefs = resources.flatMap((resource) => resource.kind === 'rss_reference' && ['article', 'excerpt'].includes(resource.reference.kind) ? [resource.reference] : [])
  const referencedItemIds = [...new Set(articleRefs.map((reference) => reference.kind === 'article' || reference.kind === 'excerpt' ? reference.read.itemId : null))]
  const calendarEvent = resources.find((resource) => resource.kind === 'calendar_event')
  const calendarWindow = resources.find((resource) => resource.kind === 'calendar_window')
  const widget = resources.find((resource) => resource.kind === 'widget_target')
  const targets = {
    rssItemId: rssItem && rssItem.kind === 'rss_item' ? rssItem.itemId : referencedItemIds.length === 1 ? referencedItemIds[0] : null,
    rssSourceId: rssSource && rssSource.kind === 'rss_source' ? rssSource.sourceId : null,
    calendarEventId: calendarEvent && calendarEvent.kind === 'calendar_event'
      ? calendarEvent.eventId
      : null,
    calendarWindow: calendarWindow && calendarWindow.kind === 'calendar_window'
      ? {
          start: calendarWindow.start,
          end: calendarWindow.end,
          ...(calendarWindow.calendarId ? { calendarId: calendarWindow.calendarId } : {}),
        }
      : null,
    widgetId: widget && widget.kind === 'widget_target' ? widget.widgetId : null,
  }
  return Object.values(targets).some((value) => value !== null) ? targets : undefined
}

export function assertWidgetTargetsMatchAnchor(
  resources: NonNullable<SendScopedRequest['resources']>,
  anchor: CodexCurrentDocumentAnchor | null,
): void {
  for (const resource of resources) {
    if (resource.kind !== 'widget_target') continue
    if (!anchor) throw new Error('codex_widget_target_requires_current_document')
    if (
      resource.logicalResourceId !== anchor.logicalResourceId
      || resource.tabId !== anchor.tabId
      || resource.currentVersion !== anchor.currentVersion
      || resource.currentDigest !== anchor.currentDigest
      || resource.policyEpoch !== anchor.policyEpoch
      || resource.incarnationKey !== anchor.incarnationKey
      || !resource.widgetId
    ) {
      throw new Error('codex_widget_target_anchor_mismatch')
    }
  }
}
