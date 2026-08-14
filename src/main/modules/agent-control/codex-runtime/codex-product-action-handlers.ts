import type { DatabaseManager } from '../../database'
import type { Reminder } from '../../../../shared/calendar-types'
import { persistableCalendarEventId } from '../../../../shared/calendar-event-identity'
import { expandEventList } from '../../calendar-engine/rrule-engine'
import { parseRemindersInput } from '../../calendar-engine/reminder-codec'
import { validateCodexCalendarWindow } from './codex-explicit-resources'
import { CodexProductActionError } from './codex-product-action-requester'

export type CodexProductRssPorts = {
  fetchUpdates(): Promise<{
    success: boolean
    error?: string
    data?: { fetched?: number; errors?: string[]; running?: boolean }
  }>
  addSource(input: { name: string; url: string }): Promise<{
    ok: boolean
    error?: string
    data?: { id?: string; warning?: string }
  }>
  analyzeItem(input: {
    itemId: string
    analysisType: 'copy' | 'visual'
    title: string
    link: string
    summary?: string
    source?: string
  }): Promise<Record<string, unknown>>
}

type RendererToolActionRequester = (payload: {
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

export type CodexProductSurfaceTargets = {
  rssItemId?: string | null
  rssSourceId?: string | null
  calendarEventId?: string | null
  calendarWindow?: { start: string; end: string; calendarId?: string } | null
  widgetId?: string | null
}

export function createProductionProductActionHandlers(input: {
  database: DatabaseManager
  rss: CodexProductRssPorts
  requestRendererToolAction: RendererToolActionRequester
  documentRequester?: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  targets?: CodexProductSurfaceTargets
  agent?: string
  sessionId: string
  runId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  actionIdentityDigest: string
  abortSignal: AbortSignal
  recordListedCalendarEventIds?: (eventIds: readonly string[]) => void
  listedCalendarEventIds?: () => readonly string[]
  onCalendarMutated?: (eventId: string) => void
}): { dispatch(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> } {
  const targets = input.targets || {}
  return {
    async dispatch(action, args) {
      if (action.startsWith('document.')) {
        if (!input.documentRequester) {
          throw new CodexProductActionError('product_action_document_anchor_missing')
        }
        const nextArgs = { ...args }
        if (
          (action === 'document.updateWidget' || action === 'document.removeWidget')
          && targets.widgetId
        ) {
          const requested = String(nextArgs.widgetId || nextArgs.id || '').trim()
          if (requested && requested !== targets.widgetId) {
            throw new CodexProductActionError('product_action_widget_target_conflict')
          }
          if (!requested) nextArgs.widgetId = targets.widgetId
        }
        return input.documentRequester(action, nextArgs)
      }

      if (action === 'rss.fetchUpdates') {
        const result = await input.rss.fetchUpdates()
        if (!result.success) {
          return {
            ok: false,
            errorKind: 'rss_fetch_failed',
            summary: result.error || 'RSS 刷新失败',
            errors: result.data?.errors || [],
          }
        }
        if (result.data?.running === true) {
          return {
            ok: false,
            errorKind: 'rss_fetch_in_progress',
            summary: 'RSS 刷新仍在进行，不能当作已完成。',
            fetched: result.data.fetched ?? 0,
            errors: result.data.errors || [],
          }
        }
        const stats = input.database.getRSSStats()
        return {
          ok: true,
          summary: `RSS 已刷新。共 ${stats.totalItems} 条，未读 ${stats.unreadItems} 条。`,
          fetched: result.data?.fetched ?? 0,
          totalItems: stats.totalItems,
          unreadItems: stats.unreadItems,
          errors: result.data?.errors || [],
        }
      }

      if (action === 'rss.addSource') {
        const name = String(args.name || '').trim()
        const url = String(args.url || '').trim()
        if (!name || !url) {
          return { ok: false, errorKind: 'rss_add_source_invalid', summary: '缺少 name 或 url' }
        }
        const added = await input.rss.addSource({ name, url })
        if (!added.ok) {
          return { ok: false, errorKind: 'rss_add_source_failed', summary: added.error || '添加失败' }
        }
        const sourceId = added.data?.id
        const readback = sourceId
          ? input.database.getRSSSources().find((source) => source.id === sourceId) || null
          : null
        return {
          ok: true,
          summary: added.data?.warning === 'source_exists'
            ? `RSS 源已存在：${readback?.name || name}`
            : `已添加 RSS 源：${readback?.name || name}`,
          sourceId,
          status: added.data?.warning === 'source_exists' ? 'already_exists' : 'added',
        }
      }

      if (action === 'rss.captureSession') {
        const stats = input.database.getRSSStats()
        return {
          ok: true,
          summary: targets.rssItemId
            ? `RSS 会话已捕获：当前条目 ${targets.rssItemId}。`
            : targets.rssSourceId
              ? `RSS 会话已捕获：当前订阅源 ${targets.rssSourceId}。`
              : 'RSS 会话已捕获：当前未选中订阅源或条目。',
          selectedItemId: targets.rssItemId || null,
          selectedSourceId: targets.rssSourceId || null,
          totalItems: stats.totalItems,
          unreadItems: stats.unreadItems,
        }
      }

      if (action === 'rss.selectItem' || action === 'rss.analyzeItem') {
        const requested = String(args.itemId || '').trim()
        if (targets.rssItemId && requested && requested !== targets.rssItemId) {
          throw new CodexProductActionError('product_action_rss_item_conflict')
        }
        const itemId = requested || targets.rssItemId
        if (!itemId) throw new CodexProductActionError('product_action_rss_item_missing')
        const items = input.database.getRSSItemsByIds([itemId])
        if (items.length !== 1) throw new CodexProductActionError('product_action_rss_item_unavailable')
        const item = items[0]
        if (action === 'rss.analyzeItem') {
          const analysisType = String(args.analysisType || '').trim().toLowerCase()
          if (analysisType !== 'copy' && analysisType !== 'visual') {
            return { ok: false, errorKind: 'rss_analyze_invalid', summary: 'analysisType 必须为 copy 或 visual' }
          }
          const source = input.database.getRSSSources().find((candidate) => candidate.id === item.source_id)
          return input.rss.analyzeItem({
            itemId,
            analysisType,
            title: item.title,
            link: item.link,
            summary: item.summary || undefined,
            source: source?.name,
          })
        }
        return input.requestRendererToolAction({
          agent: input.agent,
          sessionId: input.sessionId,
          runId: input.runId,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexCallId: input.codexCallId,
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          tool: action,
          args: { ...args, itemId },
          abortSignal: input.abortSignal,
        })
      }

      if (action === 'calendar.listWindow' || action === 'calendar.captureSession') {
        const window = resolveCalendarWindow(args, targets.calendarWindow)
        const events = listCalendarWindowEvents(input.database, window)
        input.recordListedCalendarEventIds?.(uniqueParentEventIds(events))
        return {
          ok: true,
          summary: `已读取日程窗口，共 ${events.length} 个事件。`,
          start: window.start,
          end: window.end,
          events,
        }
      }

      if (action === 'calendar.createEvent') {
        const created = createCalendarEventFromArgs(input.database, args)
        const readback = input.database.getCalendarEventById(created.id)
        if (!readback) {
          return { ok: false, errorKind: 'calendar_create_readback_failed', summary: '事件已写但读回失败' }
        }
        afterCalendarMutation(input, created.id)
        return {
          ok: true,
          summary: `事件已创建：${readback.title}`,
          eventId: readback.id,
          title: readback.title,
          reminders: readback.reminders,
          recurrenceRule: readback.recurrence_rule,
        }
      }

      if (action === 'calendar.updateEvent' || action === 'calendar.deleteEvent') {
        const eventId = resolveWritableCalendarEventId({
          requestedId: String(args.id || '').trim(),
          typedEventId: targets.calendarEventId,
          listedEventIds: input.listedCalendarEventIds?.() || [],
        })
        if (action === 'calendar.deleteEvent') {
          input.database.deleteCalendarEvent(eventId)
          const gone = input.database.getCalendarEventById(eventId)
          if (gone) {
            return { ok: false, errorKind: 'calendar_delete_readback_failed', summary: '删除后仍能读到事件' }
          }
          afterCalendarMutation(input, eventId)
          return { ok: true, summary: `事件已删除：${eventId}`, eventId }
        }
        updateCalendarEventFromArgs(input.database, eventId, args)
        const readback = input.database.getCalendarEventById(eventId)
        if (!readback) {
          return { ok: false, errorKind: 'calendar_update_readback_failed', summary: '更新后读回失败' }
        }
        afterCalendarMutation(input, eventId)
        return { ok: true, summary: `事件已更新：${readback.title}`, eventId }
      }

      if (
        action === 'tagForge.checkRevision'
        || action === 'tagForge.applyContent'
        || action === 'renderer:present-file'
      ) {
        return input.requestRendererToolAction({
          agent: input.agent,
          sessionId: input.sessionId,
          runId: input.runId,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexCallId: input.codexCallId,
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          tool: action,
          args,
          abortSignal: input.abortSignal,
        })
      }

      throw new CodexProductActionError('product_action_unmapped')
    },
  }
}

function resolveCalendarWindow(
  args: Record<string, unknown>,
  typed: { start: string; end: string; calendarId?: string } | null | undefined,
): { start: string; end: string; calendarId?: string } {
  const start = String(args.start || typed?.start || '').trim()
  const end = String(args.end || typed?.end || '').trim()
  if (!start || !end) throw new CodexProductActionError('product_action_calendar_window_missing')
  const calendarId = typeof args.calendarId === 'string' && args.calendarId.trim()
    ? args.calendarId.trim()
    : typed?.calendarId
  try {
    return validateCodexCalendarWindow({ start, end, ...(calendarId ? { calendarId } : {}) })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'codex_calendar_window_invalid'
    throw new CodexProductActionError(
      code.startsWith('codex_calendar_window_') ? code : 'codex_calendar_window_invalid',
    )
  }
}

function listCalendarWindowEvents(
  database: DatabaseManager,
  window: { start: string; end: string; calendarId?: string },
): Array<{
  id: string
  title: string
  startTime: number
  endTime: number
  calendarId: string
  instanceOf: string
}> {
  const start = Math.floor(Date.parse(window.start) / 1000)
  const end = Math.floor(Date.parse(window.end) / 1000)
  const nonRecurring = database.getNonRecurringEventsInWindow(start, end)
  const { events: recurringParents, overridesByParent } = database.getRecurringEventsAndOverrides(start, end)
  const expanded = expandEventList(recurringParents, start, end, overridesByParent)
  return [...nonRecurring.map((event) => ({
    id: event.id,
    instanceId: event.id,
    title: event.title,
    startTime: event.start_time,
    endTime: event.end_time,
    calendarId: event.calendar_id,
    instanceOf: event.id,
  })), ...expanded.map((event) => ({
    id: persistableCalendarEventId(event.instanceOf || event.id) || event.id,
    instanceId: event.id,
    title: event.title,
    startTime: event.start_time,
    endTime: event.end_time,
    calendarId: event.calendar_id,
    instanceOf: persistableCalendarEventId(event.instanceOf || event.id) || event.id,
  }))].filter((event) => !window.calendarId || event.calendarId === window.calendarId)
}

export { persistableCalendarEventId }

function uniqueParentEventIds(
  events: ReadonlyArray<{ id: string; instanceOf: string }>,
): string[] {
  return [...new Set(events.map((event) => persistableCalendarEventId(event.instanceOf || event.id)).filter((id): id is string => Boolean(id)))]
}

function resolveWritableCalendarEventId(input: {
  requestedId: string
  typedEventId?: string | null
  listedEventIds: readonly string[]
}): string {
  const requested = persistableCalendarEventId(input.requestedId)
  const typed = persistableCalendarEventId(input.typedEventId)
  if (typed) {
    if (requested && requested !== typed) {
      throw new CodexProductActionError('product_action_calendar_event_conflict')
    }
    return typed
  }
  if (requested) {
    if (!input.listedEventIds.includes(requested)) {
      throw new CodexProductActionError('product_action_calendar_event_not_in_receipt')
    }
    return requested
  }
  if (input.listedEventIds.length !== 1) {
    throw new CodexProductActionError('product_action_calendar_event_missing')
  }
  return input.listedEventIds[0]
}

function createCalendarEventFromArgs(database: DatabaseManager, args: Record<string, unknown>): { id: string } {
  const title = String(args.title || '').trim()
  const startTime = Date.parse(String(args.startTime || ''))
  const endTime = Date.parse(String(args.endTime || ''))
  if (!title || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new CodexProductActionError('product_action_calendar_create_invalid')
  }
  const sources = database.getCalendarSources()
  const calendarId = typeof args.calendarId === 'string' && args.calendarId.trim()
    ? args.calendarId.trim()
    : sources[0]?.id
  if (!calendarId) throw new CodexProductActionError('product_action_calendar_missing')
  const reminders = parseReminders(args.reminders)
  const id = database.createCalendarEvent({
    calendar_id: calendarId,
    title,
    description: typeof args.description === 'string' ? args.description : null,
    location: typeof args.location === 'string' ? args.location : null,
    start_time: Math.floor(startTime / 1000),
    end_time: Math.floor(endTime / 1000),
    all_day: args.allDay === true ? 1 : 0,
    recurrence_rule: typeof args.recurrenceRule === 'string' ? args.recurrenceRule : null,
    ...(reminders !== undefined ? { reminders } : {}),
    start_tz: typeof args.startTz === 'string' ? args.startTz : null,
    end_tz: typeof args.endTz === 'string' ? args.endTz : null,
  })
  return { id }
}

function updateCalendarEventFromArgs(
  database: DatabaseManager,
  eventId: string,
  args: Record<string, unknown>,
): void {
  const updates: {
    title?: string
    description?: string | null
    location?: string | null
    start_time?: number
    end_time?: number
    all_day?: number
    recurrence_rule?: string | null
    reminders?: Reminder[] | null
    start_tz?: string | null
    end_tz?: string | null
  } = {}
  if (typeof args.title === 'string' && args.title.trim()) updates.title = args.title.trim()
  if (typeof args.description === 'string') updates.description = args.description
  if (typeof args.location === 'string') updates.location = args.location
  if (args.startTime) {
    const startTime = Date.parse(String(args.startTime))
    if (!Number.isFinite(startTime)) throw new CodexProductActionError('product_action_calendar_update_invalid')
    updates.start_time = Math.floor(startTime / 1000)
  }
  if (args.endTime) {
    const endTime = Date.parse(String(args.endTime))
    if (!Number.isFinite(endTime)) throw new CodexProductActionError('product_action_calendar_update_invalid')
    updates.end_time = Math.floor(endTime / 1000)
  }
  if (typeof args.allDay === 'boolean') updates.all_day = args.allDay ? 1 : 0
  if (typeof args.recurrenceRule === 'string') updates.recurrence_rule = args.recurrenceRule
  const reminders = parseReminders(args.reminders)
  if (reminders !== undefined) updates.reminders = reminders
  if (typeof args.startTz === 'string') updates.start_tz = args.startTz
  if (typeof args.endTz === 'string') updates.end_tz = args.endTz
  database.updateCalendarEvent(eventId, updates)
}

function afterCalendarMutation(
  input: {
    onCalendarMutated?: (eventId: string) => void
    requestRendererToolAction: RendererToolActionRequester
    agent?: string
    sessionId: string
    runId: string
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyActionId: string
    actionIdentityDigest: string
    abortSignal: AbortSignal
  },
  eventId: string,
): void {
  input.onCalendarMutated?.(eventId)
  void input.requestRendererToolAction({
    agent: input.agent,
    sessionId: input.sessionId,
    runId: input.runId,
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
    codexCallId: input.codexCallId,
    readyActionId: input.readyActionId,
    actionIdentityDigest: input.actionIdentityDigest,
    tool: 'calendar.reloadWindow',
    args: { eventId },
    abortSignal: input.abortSignal,
  }).catch(() => { /* view refresh must not stall the write result */ })
}

function parseReminders(value: unknown): Reminder[] | undefined {
  if (value === undefined) return undefined
  try {
    return parseRemindersInput(value)
  } catch {
    throw new CodexProductActionError('product_action_calendar_reminders_invalid')
  }
}
