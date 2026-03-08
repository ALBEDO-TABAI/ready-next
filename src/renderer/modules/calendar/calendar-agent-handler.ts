import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'

interface CalendarApi {
  getEvents: (start: Date, end: Date) => Promise<{ success?: boolean; error?: string; data?: unknown[] }>
  createEvent: (payload: {
    title: string
    startTime: Date
    endTime: Date
    calendarId: string
    description?: string
  }) => Promise<{ success?: boolean; error?: string; data?: { id?: string } }>
  updateEvent: (id: string, payload: Partial<CalendarEvent>) => Promise<{ success?: boolean; error?: string }>
  deleteEvent: (id: string) => Promise<{ success?: boolean; error?: string }>
}

export interface CalendarAgentHandlerDeps {
  currentDate: Date
  viewType: ViewType
  editingEvent: CalendarEvent | null
  sources: CalendarSource[]
  getEvents: () => CalendarEvent[]
  loadCalendarData: (force?: boolean) => Promise<void>
  setConflictState: (payload: { hasConflict?: boolean; reason?: string | null }) => void
  markSessionMutation: () => void
  getDateRange: (date: Date, view: ViewType) => { start: Date; end: Date }
  calendarApi: CalendarApi | undefined
}

export function createCalendarAgentHandler(deps: CalendarAgentHandlerDeps): ModuleAgentActionHandler {
  const computeConflicts = (eventId: string | null, startTime: Date, endTime: Date) => {
    return deps.getEvents().filter((event) => {
      if (eventId && event.id === eventId) return false
      return startTime < event.endTime && endTime > event.startTime
    })
  }

  return async ({ action, args }) => {
    if (action === 'calendar.captureSession') {
      const { start, end } = deps.getDateRange(deps.currentDate, deps.viewType)
      return {
        intent: 'capture_calendar_session',
        ownerResourceId: deps.editingEvent?.id || null,
        summary: deps.editingEvent
          ? `日程会话已捕获：当前选中事件为 ${deps.editingEvent.title}。`
          : `日程会话已捕获：当前视图范围 ${start.toLocaleDateString()} - ${end.toLocaleDateString()}。`,
        selectedEventId: deps.editingEvent?.id ?? null,
        visibleRange: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
      }
    }

    if (action === 'calendar.listWindow') {
      const start = new Date(String(args.start || ''))
      const end = new Date(String(args.end || ''))
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error('calendar.listWindow 需要有效的 start/end ISO 时间')
      }
      const result = await deps.calendarApi?.getEvents(start, end)
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '读取日程窗口失败')
      }
      return {
        intent: 'list_calendar_window',
        summary: `已读取 ${start.toLocaleString()} 到 ${end.toLocaleString()} 的日程窗口，共 ${(result.data as Array<unknown>).length} 个事件。`,
        events: result.data,
      }
    }

    if (action === 'calendar.createEvent') {
      const title = String(args.title || '').trim()
      const startTime = new Date(String(args.startTime || ''))
      const endTime = new Date(String(args.endTime || ''))
      if (!title || Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        throw new Error('calendar.createEvent 缺少有效的 title/startTime/endTime')
      }
      const conflicts = computeConflicts(null, startTime, endTime)
      if (conflicts.length > 0) {
        deps.setConflictState({
          hasConflict: true,
          reason: `与 ${conflicts[0].title} 等 ${conflicts.length} 个事件冲突`,
        })
      } else {
        deps.setConflictState({ hasConflict: false, reason: null })
      }
      const calendarId = typeof args.calendarId === 'string' ? args.calendarId : deps.sources[0]?.id
      if (!calendarId) {
        throw new Error('calendar.createEvent 缺少可用的 calendarId')
      }
      const result = await deps.calendarApi?.createEvent({
        title,
        startTime,
        endTime,
        calendarId,
        description: typeof args.description === 'string' ? args.description : undefined,
      })
      if (!result?.success || !result.data?.id) {
        throw new Error(result?.error || '创建事件失败')
      }
      deps.markSessionMutation()
      await deps.loadCalendarData(true)
      return {
        intent: 'create_calendar_event',
        ownerResourceId: String(result.data.id),
        summary: conflicts.length > 0 ? '事件已创建，但与现有安排存在冲突。' : `事件已创建：${title}`,
      }
    }

    if (action === 'calendar.updateEvent') {
      const id = String(args.id || '').trim()
      if (!id) throw new Error('calendar.updateEvent 缺少 id')
      const nextStart = args.startTime ? new Date(String(args.startTime)) : null
      const nextEnd = args.endTime ? new Date(String(args.endTime)) : null
      if ((nextStart && Number.isNaN(nextStart.getTime())) || (nextEnd && Number.isNaN(nextEnd.getTime()))) {
        throw new Error('calendar.updateEvent 提供了无效的时间')
      }
      if (nextStart && nextEnd) {
        const conflicts = computeConflicts(id, nextStart, nextEnd)
        deps.setConflictState(
          conflicts.length > 0
            ? { hasConflict: true, reason: `与 ${conflicts[0].title} 等 ${conflicts.length} 个事件冲突` }
            : { hasConflict: false, reason: null },
        )
      }
      const updatePayload: Partial<CalendarEvent> = {
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(nextStart ? { startTime: nextStart } : {}),
        ...(nextEnd ? { endTime: nextEnd } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      }
      const result = await deps.calendarApi?.updateEvent(id, updatePayload)
      if (!result?.success) {
        throw new Error(result?.error || '更新事件失败')
      }
      deps.markSessionMutation()
      await deps.loadCalendarData(true)
      return {
        intent: 'update_calendar_event',
        ownerResourceId: id,
        summary: `事件已更新：${id}`,
      }
    }

    if (action === 'calendar.deleteEvent') {
      const id = String(args.id || '').trim()
      if (!id) throw new Error('calendar.deleteEvent 缺少 id')
      const result = await deps.calendarApi?.deleteEvent(id)
      if (!result?.success) {
        throw new Error(result?.error || '删除事件失败')
      }
      deps.markSessionMutation()
      await deps.loadCalendarData(true)
      return {
        intent: 'delete_calendar_event',
        ownerResourceId: id,
        summary: `事件已删除：${id}`,
      }
    }

    throw new Error(`Unsupported calendar agent action: ${action}`)
  }
}
