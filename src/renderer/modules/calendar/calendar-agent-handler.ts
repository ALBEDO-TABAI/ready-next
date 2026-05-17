import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * Structural subset of `ElectronCalendarAPI` that this agent handler
 * needs. We mirror the optional-args shape that preload exposes so
 * `window.electronAPI?.calendar` can be passed directly without a cast.
 * The fields listed here are the ones L0 added to the LLM tool schema
 * but that were silently dropped by the handler pre-fix.
 */
/**
 * Structural subset of `ElectronCalendarAPI` that this agent handler
 * needs. The optional fields mirror `CalendarCreateEventInput` in
 * `electron.d.ts` so `window.electronAPI?.calendar` is assignable here
 * without an unsafe cast — L0 added the location / allDay / reminders /
 * recurrenceRule fields and pre-fix the handler dropped all of them.
 */
interface CalendarApi {
  getEvents: (start: Date, end: Date) => Promise<{ success?: boolean; error?: string; data?: unknown[] }>
  createEvent: (payload: {
    title: string
    startTime: Date | number | string
    endTime: Date | number | string
    calendarId: string
    description?: string
    location?: string
    allDay?: boolean
    reminders?: Reminder[] | null
    recurrenceRule?: string | null
    startTz?: string | null
    endTz?: string | null
    // `[key: string]: unknown` mirrors electron.d.ts so callers may pass
    // additional fields without TS narrowing them out.
    [key: string]: unknown
  }) => Promise<{ success?: boolean; error?: string; data?: { id?: string } }>
  // `updateEvent` accepts the renderer-view `Partial<CalendarEvent>` plus
  // the wider preload-side payload. The cast in callers below narrows
  // back to the exact preload-input shape where needed.
  updateEvent: (id: string, payload: Partial<CalendarEvent> | Record<string, unknown>) => Promise<{ success?: boolean; error?: string }>
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
  // Snapshot shape for `calendar.captureSession`. The agent uses this to
  // see "what's currently on the calendar"; pre-fix the snapshot was
  // missing every L0-L4 field added after the initial schema (location /
  // reminders / recurrenceRule / instance-of), so the model could create
  // an event with reminders + RRULE and then read back its own creation
  // and not see them — the "agent creates complete events but cannot see
  // them in the session" failure mode flagged in audit.
  //
  // **Deliberately OMITTED**: `startTz / endTz`. The L4 timezone work is
  // explicitly degraded to "display-layer timezone only; event-level
  // timezone NOT complete" (see `rrule-engine.ts` top docstring). Until
  // event-level tz is real — i.e. EventModal can edit a per-event tz AND
  // rrule expansion honors it for DST correctness — surfacing tz to the
  // agent would invite the model to set / read a value the rest of the
  // app cannot uphold. The locked behavior is enforced by
  // `calendar-agent-snapshot-shape.test.ts`; bringing tz into the
  // snapshot must update that test FIRST, then close the L4 gap.
  const serializeEvent = (event: CalendarEvent) => ({
    id: event.id,
    title: event.title,
    startTime: event.startTime.toISOString(),
    endTime: event.endTime.toISOString(),
    calendarId: event.calendarId,
    color: event.color,
    description: event.description ?? null,
    location: event.location ?? null,
    allDay: event.allDay ?? false,
    reminders: Array.isArray(event.reminders) ? event.reminders : null,
    recurrenceRule: event.recurrenceRule ?? null,
    /** When non-null, identifies this row as an expanded recurring
     *  instance whose parent event lives at `instanceOf`. */
    instanceOf: event.instanceOf ?? null,
    occurrenceStart: typeof event.occurrenceStart === 'number'
      ? event.occurrenceStart
      : null,
    overrideKind: event.overrideKind ?? null,
    contentType: event.contentType ?? null,
    platform: event.platform ?? null,
    publishStatus: event.publishStatus ?? null,
  })

  const computeConflicts = (eventId: string | null, startTime: Date, endTime: Date) => {
    return deps.getEvents().filter((event) => {
      if (eventId && event.id === eventId) return false
      return startTime < event.endTime && endTime > event.startTime
    })
  }

  return async ({ action, args }) => {
    if (action === 'calendar.captureSession') {
      const { start, end } = deps.getDateRange(deps.currentDate, deps.viewType)
      const events = deps.getEvents()
      const visibleEvents = events.filter((event) => event.startTime < end && event.endTime > start)
      return {
        intent: 'capture_calendar_session',
        ownerResourceId: deps.editingEvent?.id || null,
        summary: deps.editingEvent
          ? `日程会话已捕获：当前选中事件为 ${deps.editingEvent.title}。`
          : `日程会话已捕获：当前视图范围 ${start.toLocaleDateString()} - ${end.toLocaleDateString()}；已加载 ${events.length} 个事件，当前视图 ${visibleEvents.length} 个。`,
        selectedEventId: deps.editingEvent?.id ?? null,
        visibleRange: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        totalEvents: events.length,
        visibleEventCount: visibleEvents.length,
        events: events.map(serializeEvent),
        visibleEvents: visibleEvents.map(serializeEvent),
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
      // L0 expanded the LLM schema to include location / allDay / reminders /
      // recurrenceRule but the handler was still forwarding only the original
      // 5 fields, so models would "successfully create" an event while the
      // location / reminders / recurrence vanished silently. Forward every
      // schema-blessed field; preload re-validates with zod at the IPC
      // boundary so loose typing here cannot corrupt the DB.
      const remindersArg = Array.isArray(args.reminders)
        ? (args.reminders as Reminder[])
        : undefined
      const recurrenceArg = typeof args.recurrenceRule === 'string' && args.recurrenceRule.trim().length > 0
        ? args.recurrenceRule
        : undefined
      const result = await deps.calendarApi?.createEvent({
        title,
        startTime,
        endTime,
        calendarId,
        description: typeof args.description === 'string' ? args.description : undefined,
        location: typeof args.location === 'string' ? args.location : undefined,
        allDay: typeof args.allDay === 'boolean' ? args.allDay : undefined,
        reminders: remindersArg,
        recurrenceRule: recurrenceArg,
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
      // Same fix as createEvent above: forward every schema-blessed field
      // so an "update reminders" or "change location" tool call actually
      // reaches the DB rather than being silently dropped at the handler.
      // `Partial<CalendarEvent>` is the renderer view-event type (Date /
      // camelCase); the IPC layer's preload helper accepts a wider shape
      // (reminders / recurrenceRule / allDay) so we cast via Record below.
      const updatePayloadView: Partial<CalendarEvent> = {
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(nextStart ? { startTime: nextStart } : {}),
        ...(nextEnd ? { endTime: nextEnd } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(typeof args.location === 'string' ? { location: args.location } : {}),
        ...(typeof args.allDay === 'boolean' ? { allDay: args.allDay } : {}),
        ...(Array.isArray(args.reminders) ? { reminders: args.reminders as Reminder[] } : {}),
        ...(typeof args.recurrenceRule === 'string'
          ? { recurrenceRule: args.recurrenceRule.trim() || null }
          : {}),
      }
      const result = await deps.calendarApi?.updateEvent(id, updatePayloadView)
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
