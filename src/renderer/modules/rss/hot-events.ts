import type { RSSEventSummary } from '../../../shared/rss-events'

export const RSS_HOT_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * 当前热点：近 48 小时内、至少两个来源报道的事件，按来源数、报道数、最近时间排序。
 * 只用已保存的事件归组事实，不编造热度分。
 */
export function rankHotEvents(events: readonly RSSEventSummary[], now: number, limit = 5): RSSEventSummary[] {
  return events
    .filter((event) => event.sourceCount >= 2 && event.latestAt >= now - RSS_HOT_WINDOW_MS)
    .sort((a, b) => b.sourceCount - a.sourceCount || b.memberCount - a.memberCount || b.latestAt - a.latestAt || a.id.localeCompare(b.id))
    .slice(0, limit)
}
