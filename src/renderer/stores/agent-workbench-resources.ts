import { persistableCalendarEventId } from '../../shared/calendar-event-identity'
import type { SendScopedResourceSelection } from '../../shared/ipc-contracts/agent-runtime'
import { useCalendarSession } from './useCalendarSession'
import { useMode } from './useMode'
import { useRSSSession } from './useRSSSession'

export function collectWorkbenchSurfaceResources(): SendScopedResourceSelection[] {
  const mode = useMode.getState()
  const resources: SendScopedResourceSelection[] = []
  if (mode.workbenchMode === 'rss' || mode.splitMode === 'rss') {
    const rss = useRSSSession.getState()
    if (rss.selectedItemId) {
      resources.push({
        kind: 'rss_item',
        id: `rss-item-${rss.selectedItemId}`,
        name: rss.selectedItemTitle || 'RSS 条目',
        itemId: rss.selectedItemId,
      })
    }
    if (rss.selectedSourceId) {
      resources.push({
        kind: 'rss_source',
        id: `rss-source-${rss.selectedSourceId}`,
        name: 'RSS 订阅源',
        sourceId: rss.selectedSourceId,
      })
    }
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
    const persistableEventId = persistableCalendarEventId(calendar.selectedEventId)
    if (persistableEventId) {
      resources.push({
        kind: 'calendar_event',
        id: `calendar-event-${persistableEventId}`,
        name: calendar.selectedEventTitle || '日程',
        eventId: persistableEventId,
      })
    }
  }
  return resources
}
