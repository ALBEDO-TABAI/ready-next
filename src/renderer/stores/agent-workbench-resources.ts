import { rssQueryKey } from '../modules/rss/workspace-query'
import type { SendScopedResourceSelection } from '../../shared/ipc-contracts/agent-runtime'
import { useCalendarSession } from './useCalendarSession'
import { useMode } from './useMode'
import { useRSSSession } from './useRSSSession'

export function collectWorkbenchSurfaceResources(): SendScopedResourceSelection[] {
  const mode = useMode.getState()
  const resources: SendScopedResourceSelection[] = []
  if (mode.workbenchMode === 'rss' || mode.splitMode === 'rss') {
    const rss = useRSSSession.getState()
    let reference: import('../../shared/rss-reference').RSSReference | null = null
    if (rss.digestVisible) {
      if (rss.selectedDigestId) reference = { kind: 'digest', read: { reportId: rss.selectedDigestId, offset: 0, limit: 20 } }
    } else if (rss.selectedItemId && rss.selectedItemExpectedRevision) {
      reference = rss.selectedExcerpt
        ? { kind: 'excerpt', read: { format: 'reading-v1', itemId: rss.selectedItemId, expectedRevision: rss.selectedItemExpectedRevision, range: rss.selectedExcerpt, offset: 0, length: 12000 } }
        : { kind: 'article', read: { itemId: rss.selectedItemId, expectedRevision: rss.selectedItemExpectedRevision, offset: 0, length: 12000 } }
    } else if (rss.view && rssQueryKey(rss.view.query) === rssQueryKey(rss.query)) reference = { kind: 'query', query: { ...rss.view.query, expectedRevision: rss.view.revision, cursor: undefined } }
    if (reference) resources.push({ kind: 'rss_reference', id: crypto.randomUUID(), name: rss.selectedItemTitle || '当前 RSS 资料', reference, origin: 'workbench' })
  }
  if (mode.workbenchMode === 'calendar' || mode.splitMode === 'calendar') {
    const calendar = useCalendarSession.getState()
    if (calendar.visibleRangeStart && calendar.visibleRangeEnd) {
      resources.push({
        kind: 'calendar_window',
        id: `calendar-window-${calendar.visibleRangeStart}-${calendar.visibleRangeEnd}`,
        name: '当前日历窗口',
        start: calendar.visibleRangeStart,
        end: calendar.visibleRangeEnd,
      })
    }
    const selectedEventId = calendar.selectedEventId?.trim()
    if (selectedEventId) {
      resources.push({
        kind: 'calendar_event',
        id: `calendar-event-${selectedEventId}`,
        name: calendar.selectedEventTitle || '日程',
        eventId: selectedEventId,
      })
    }
  }
  return resources
}
