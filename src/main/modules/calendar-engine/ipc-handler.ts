import { ipcMain } from 'electron'
import { CalendarRepository } from '../repositories/calendar-repository'

// --- Unified Response Helpers ---

interface CalendarResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

function createSuccessResponse<T>(data: T, isMock: boolean): CalendarResponse<T> {
  return { success: true, mock: isMock, data }
}

function createErrorResponse(error: string): CalendarResponse<never> {
  return { success: false, mock: false, error }
}

// --- Mock Data ---

const mockSources = [
  { id: 'work', name: '工作日程', color: '#5B8DEF', type: 'local', enabled: true },
  { id: 'content', name: '内容创作', color: '#E97A2B', type: 'local', enabled: true },
  { id: 'holiday', name: '节假日', color: '#34D399', type: 'local', enabled: true },
  { id: 'personal', name: '个人', color: '#8B5CF6', type: 'local', enabled: true }
]

const mockEvents = [
  {
    id: '1',
    calendarId: 'work',
    title: '团队周会',
    description: '每周进度同步',
    startTime: new Date(Date.now() + 3600000).toISOString(),
    endTime: new Date(Date.now() + 7200000).toISOString(),
    allDay: false
  },
  {
    id: '2',
    calendarId: 'content',
    title: '视频发布',
    description: '本周短视频发布',
    startTime: new Date(Date.now() + 86400000).toISOString(),
    endTime: new Date(Date.now() + 90000000).toISOString(),
    allDay: false
  },
  {
    id: '3',
    calendarId: 'work',
    title: '内容策划',
    description: '下月选题规划',
    startTime: new Date(Date.now() - 3600000).toISOString(),
    endTime: new Date(Date.now()).toISOString(),
    allDay: false
  }
]

// --- Helper: convert incoming date (string | number | Date) to Unix seconds ---

function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number') {
    // If already in seconds range (< year 10000 in ms), use as-is;
    // otherwise assume milliseconds
    return value > 1e12 ? Math.floor(value / 1000) : value
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    if (isNaN(d.getTime())) throw new Error(`Invalid date string: ${value}`)
    return Math.floor(d.getTime() / 1000)
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000)
  }
  throw new Error(`Cannot convert to date: ${String(value)}`)
}

// --- IPC Setup ---

export function setupCalendarIPC(useMock = false): void {
  const repository = new CalendarRepository()

  // Get all calendar sources
  ipcMain.handle('calendar:getSources', async () => {
    if (useMock) {
      return createSuccessResponse(mockSources, true)
    }

    try {
      const sources = repository.getSources()
      return createSuccessResponse(sources, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Get events in date range
  ipcMain.handle('calendar:getEvents', async (_, { start, end }: { start: unknown; end: unknown }) => {
    if (useMock) {
      return createSuccessResponse(mockEvents, true)
    }

    try {
      const startTs = toUnixSeconds(start)
      const endTs = toUnixSeconds(end)

      const events = repository.getEvents(startTs, endTs)
      return createSuccessResponse(events, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Create event
  ipcMain.handle('calendar:createEvent', async (_, event: {
    calendarId: string
    title: string
    description?: string
    location?: string
    startTime: unknown
    endTime: unknown
    allDay?: boolean
  }) => {
    if (useMock) {
      return createSuccessResponse({ id: `event-${Date.now()}` }, true)
    }

    try {
      const id = repository.createEvent({
        calendar_id: event.calendarId,
        title: event.title,
        description: event.description || null,
        location: event.location || null,
        start_time: toUnixSeconds(event.startTime),
        end_time: toUnixSeconds(event.endTime),
        all_day: event.allDay ? 1 : 0
      })
      return createSuccessResponse({ id }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Update event — supports partial updates for all fields
  ipcMain.handle('calendar:updateEvent', async (_, { id, event }: { id: string; event: Record<string, unknown> }) => {
    if (useMock) {
      return createSuccessResponse({ updated: true }, true)
    }

    try {
      // Build the update object, converting field names from camelCase to snake_case
      const updates: Record<string, unknown> = {}
      if (event.title !== undefined) updates.title = event.title
      if (event.description !== undefined) updates.description = event.description
      if (event.location !== undefined) updates.location = event.location
      if (event.calendarId !== undefined) updates.calendar_id = event.calendarId
      if (event.allDay !== undefined) updates.all_day = event.allDay ? 1 : 0
      if (event.startTime !== undefined) updates.start_time = toUnixSeconds(event.startTime)
      if (event.endTime !== undefined) updates.end_time = toUnixSeconds(event.endTime)

      repository.updateEvent(id, updates)
      return createSuccessResponse({ updated: true }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })

  // Delete event
  ipcMain.handle('calendar:deleteEvent', async (_, id: string) => {
    if (useMock) {
      return createSuccessResponse({ deleted: true }, true)
    }

    try {
      repository.deleteEvent(id)
      return createSuccessResponse({ deleted: true }, false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage)
    }
  })
}
