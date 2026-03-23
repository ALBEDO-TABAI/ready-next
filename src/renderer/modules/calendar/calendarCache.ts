import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'

export interface CalendarModeCache {
  events: CalendarEvent[]
  sources: CalendarSource[]
  currentDate: Date
  selectedDate: Date | null
  viewType: ViewType
  isMock: boolean
  dataLoaded: boolean
}

export const DEFAULT_SOURCES: CalendarSource[] = [
  { id: 'work', name: '工作日程', color: '#5B8DEF', enabled: true },
  { id: 'content', name: '内容创作', color: '#E97A2B', enabled: true },
  { id: 'holiday', name: '节假日', color: '#34D399', enabled: true },
  { id: 'personal', name: '个人', color: '#8B5CF6', enabled: false },
]

let cachedState: CalendarModeCache | null = null

export function readCalendarModeCache(): CalendarModeCache | null {
  return cachedState
}

export function persistCalendarModeCache(state: CalendarModeCache) {
  cachedState = state
}
