import { isRecurring } from '../../../../shared/calendar/model'
import type { DatabaseManager } from '../../database'
import type { Reminder } from '../../../../shared/calendar-types'
import { persistableCalendarEventId } from '../../../../shared/calendar-event-identity'
import { calendarEventFromInput, calendarPatchFromInput, calendarSeconds } from '../../calendar-engine/calendar-input'
import { originalFromSeconds, originalToSeconds } from '../../calendar-engine/calendar-row-codec'
import { isoDate } from '../../../../shared/calendar/dates'
import type { RecurrenceScope } from '../../../../shared/calendar/commands'
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
  getAnalysisResult(input: {
    jobId?: string
    itemId?: string
    analysisType?: 'copy' | 'visual'
  }): Promise<Record<string, unknown>>
}

export type CodexProductPetPort = {
  showStickyNote(input: Record<string, unknown>): Promise<Record<string, unknown>>
  dismissStickyNote(id: string): Promise<Record<string, unknown>>
  clearStickyNotes(): Promise<Record<string, unknown>>
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
  pet: CodexProductPetPort
  requestRendererToolAction: RendererToolActionRequester
  documentRequester?: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  rssReferences?: import('../../../../shared/rss-reference').RSSReferenceResource[]
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
  waitForRssAnalysisResult?: boolean
  recordListedCalendarEventIds?: (eventIds: readonly string[]) => void
  listedCalendarEventIds?: () => readonly string[]
  recordListedCalendarRevisions?: (versions: Record<string, number>) => void
  listedCalendarRevisions?: () => Record<string, number>
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
        const stats = input.database.rss.getRSSStats()
        const errors = result.data?.errors || []
        return {
          ok: true,
          summary: errors.length > 0
            ? `RSS 已刷新，${errors.length} 个订阅源失败。`
            : `RSS 已刷新。共 ${stats.totalItems} 条，未读 ${stats.unreadItems} 条。`,
          status: errors.length > 0 ? 'completed_with_warnings' : 'completed',
          fetched: result.data?.fetched ?? 0,
          totalItems: stats.totalItems,
          unreadItems: stats.unreadItems,
          errors,
        }
      }

      if (action === 'pet.showStickyNote') {
        return input.pet.showStickyNote(args)
      }
      if (action === 'pet.dismissStickyNote') {
        const id = String(args.id || '').trim()
        if (!id) throw new CodexProductActionError('product_action_pet_note_missing')
        return input.pet.dismissStickyNote(id)
      }
      if (action === 'pet.clearStickyNotes') {
        return input.pet.clearStickyNotes()
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
          ? input.database.rss.getRSSSources().find((source) => source.id === sourceId) || null
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
        const references = input.rssReferences || []
        const query = references.find((entry) => entry.reference.kind === 'query')
        if (query?.reference.kind === 'query') {
          const view = input.database.rss.content.query(query.reference.query)
          return { ok: true, summary: '已读取本轮冻结的 RSS 筛选范围。', references, query: view.query, revision: view.revision, totalItems: view.total, unreadItems: view.unreadTotal, lastFetchAt: view.lastFetchAt }
        }
        const stats = input.database.rss.getRSSStats()
        return {
          ok: true,
          summary: targets.rssItemId
            ? `RSS 会话已捕获：当前条目 ${targets.rssItemId}。`
            : targets.rssSourceId
              ? `RSS 会话已捕获：当前订阅源 ${targets.rssSourceId}。`
              : 'RSS 会话已捕获：当前未选中订阅源或条目。',
          references, statsScope: 'all_saved_items',
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
        const items = input.database.rss.getRSSItemsByIds([itemId])
        if (items.length !== 1) throw new CodexProductActionError('product_action_rss_item_unavailable')
        const item = items[0]
        if (action === 'rss.analyzeItem') {
          const analysisType = String(args.analysisType || '').trim().toLowerCase()
          if (analysisType !== 'copy' && analysisType !== 'visual') {
            return { ok: false, errorKind: 'rss_analyze_invalid', summary: 'analysisType 必须为 copy 或 visual' }
          }
          const source = input.database.rss.getRSSSources().find((candidate) => candidate.id === item.source_id)
          const started = await input.rss.analyzeItem({
            itemId,
            analysisType,
            title: item.title,
            link: item.link,
            summary: item.summary || undefined,
            source: source?.name,
          })
          if (!input.waitForRssAnalysisResult || started.ok === false) return started
          const jobId = typeof started.jobId === 'string' ? started.jobId : ''
          if (!jobId) return { ok: false, errorKind: 'rss_analysis_job_missing', summary: '分析任务未返回 jobId。' }
          return input.rss.getAnalysisResult({ jobId, itemId })
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

      if (action === 'rss.getAnalysisResult') {
        const requestedItemId = String(args.itemId || '').trim()
        if (targets.rssItemId && requestedItemId && requestedItemId !== targets.rssItemId) {
          throw new CodexProductActionError('product_action_rss_item_conflict')
        }
        const requestedAnalysisType = String(args.analysisType || '').trim().toLowerCase()
        if (requestedAnalysisType && requestedAnalysisType !== 'copy' && requestedAnalysisType !== 'visual') {
          return { ok: false, errorKind: 'rss_analyze_invalid', summary: 'analysisType 必须为 copy 或 visual' }
        }
        return input.rss.getAnalysisResult({
          jobId: String(args.jobId || '').trim() || undefined,
          itemId: requestedItemId || targets.rssItemId || undefined,
          analysisType: requestedAnalysisType
            ? requestedAnalysisType as 'copy' | 'visual'
            : undefined,
        })
      }

      if (action === 'calendar.listWindow' || action === 'calendar.captureSession') {
        const window = resolveCalendarWindow(args, targets.calendarWindow)
        const events = listCalendarWindowEvents(input.database, window)
        input.recordListedCalendarEventIds?.(uniqueParentEventIds(events))
        input.recordListedCalendarRevisions?.(Object.fromEntries(events.flatMap(e=>[[e.id,e.revision],[e.instanceId,e.revision]])))
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
        const readback = input.database.calendar.getCalendarEventById(created.id)
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
        const parentId = persistableCalendarEventId(eventId)!
        const snapshot = input.database.calendar.snapshot()
        const event = snapshot.events.find(e=>e.id===parentId)
        if(!event)throw new CodexProductActionError('product_action_calendar_event_missing')
        const scope = typeof args.scope==='string' && ['this','following','all'].includes(args.scope) ? args.scope as RecurrenceScope : undefined
        if(isRecurring(event) && !scope)throw new CodexProductActionError('product_action_calendar_scope_required')
        let origin=eventId.includes('#')?Number(eventId.slice(eventId.indexOf('#')+1)):undefined
        if(args.occurrenceStart!==undefined)origin=calendarSeconds(args.occurrenceStart)
        if(isRecurring(event) && scope!=='all' && origin===undefined)throw new CodexProductActionError('product_action_calendar_occurrence_required')
        if(origin!==undefined){
          const exact=`${parentId}#${origin}`
          if(targets.calendarEventId!==exact && !(input.listedCalendarEventIds?.()||[]).includes(exact))throw new CodexProductActionError('product_action_calendar_event_not_in_receipt')
        }
        const key=origin===undefined?parentId:`${parentId}|${originalFromSeconds(origin,event.allDay)}`
        const versions=Object.fromEntries(snapshot.events.map(e=>[e.id,e.revision||1]))
        const expected=args.expectedRevision ?? input.listedCalendarRevisions?.()[eventId] ?? input.listedCalendarRevisions?.()[parentId]
        if(typeof expected!=='number')throw new CodexProductActionError('product_action_calendar_revision_required')
        versions[parentId]=expected
        if(action==='calendar.deleteEvent'){
          input.database.calendar.mutate({type:'delete',keys:[key],scope},versions)
          afterCalendarMutation(input,parentId)
          return {ok:true,summary:'日程已按指定范围删除',eventId:parentId,scope:scope||'single'}
        }
        const receipt=input.database.calendar.mutate({type:'update',key,scope,patch:calendarPatchFromInput(args,event)},versions)
        const instanceId=scope==='this'&&isRecurring(event)?`${parentId}#${origin}`:null
        const savedId=instanceId?receipt.snapshot.events.find(e=>e.recurringEventId===parentId&&e.originalStart===originalFromSeconds(origin!,event.allDay))?.id:scope==='following'&&isRecurring(event)?receipt.undo.remove.find(id=>receipt.snapshot.events.some(e=>e.id===id&&!e.recurringEventId)):parentId
        const readback = savedId ? input.database.calendar.getCalendarEventById(savedId) : null
        if (!readback) {
          return { ok: false, errorKind: 'calendar_update_readback_failed', summary: '更新后读回失败' }
        }
        afterCalendarMutation(input, parentId)
        return { ok: true, summary: `事件已更新：${readback.title}`, eventId: instanceId || readback.id, scope: scope || 'single' }
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

function listCalendarWindowEvents(database:DatabaseManager,window:{start:string;end:string;calendarId?:string}) {
  const parents=new Map(database.calendar.snapshot().events.map(e=>[e.id,e]))
  return database.calendar.listOccurrences(Date.parse(window.start)/1000,Date.parse(window.end)/1000)
    .filter(o=>!window.calendarId||o.event.calendarId===window.calendarId).map(o=>{
      const event=o.event,parent=o.seriesId||event.id,original=originalToSeconds(event.originalStart??(o.allDay?isoDate(o.startDay):o.start))
      return {id:parent,instanceId:o.seriesId?`${parent}#${original}`:parent,instanceOf:parent,occurrenceStart:original,
        title:event.title,description:event.description||null,location:event.location||null,calendarId:event.calendarId,
        startTime:o.start/1000,endTime:o.end/1000,allDay:event.allDay,startDate:o.allDay?isoDate(o.startDay):null,endDate:o.allDay?isoDate(o.endDay+1):null,
        startTz:event.timeZone,endTz:event.endTimeZone||null,recurrenceRule:parents.get(parent)?.rrule||null,
        reminders:event.reminders?.map(r=>({offsetMinutes:-r.minutes,method:r.method}))||[],
        attendees:event.attendees||[],url:event.url||null,conferenceUrl:event.conferenceUrl||null,status:event.status,transparency:event.transparency,visibility:event.visibility||'default',color:event.color||null,revision:parents.get(parent)?.revision||1}
    })
}

export { persistableCalendarEventId }

function uniqueParentEventIds(events:ReadonlyArray<{id:string;instanceId?:string;instanceOf:string}>):string[]{return [...new Set(events.map(e=>e.instanceId||e.id))]}
function resolveWritableCalendarEventId(input:{requestedId:string;typedEventId?:string|null;listedEventIds:readonly string[]}):string {
  const requested=input.requestedId.trim(),typed=input.typedEventId?.trim()
  if(typed){
    if(requested&&(persistableCalendarEventId(requested)!==persistableCalendarEventId(typed)||(requested.includes('#')&&typed.includes('#')&&requested!==typed)))throw new CodexProductActionError('product_action_calendar_event_conflict')
    return requested||typed
  }
  if(requested){
    if(!input.listedEventIds.includes(requested)&&!( !requested.includes('#') && input.listedEventIds.some(id=>persistableCalendarEventId(id)===requested)))throw new CodexProductActionError('product_action_calendar_event_not_in_receipt')
    return requested
  }
  if(input.listedEventIds.length!==1)throw new CodexProductActionError('product_action_calendar_event_missing')
  return input.listedEventIds[0]
}

function createCalendarEventFromArgs(database:DatabaseManager,args:Record<string,unknown>):{id:string}{
  const snapshot=database.calendar.snapshot()
  const calendarId=typeof args.calendarId==='string'&&args.calendarId.trim()?args.calendarId:snapshot.calendars.find(c=>c.primary&&!c.readOnly)?.id||snapshot.calendars.find(c=>!c.readOnly)?.id
  if(!calendarId)throw new CodexProductActionError('product_action_calendar_missing')
  if(args.reminders!==undefined)parseReminders(args.reminders)
  const event=calendarEventFromInput(args,calendarId)
  database.calendar.mutate({type:'create',event},{})
  return {id:event.id}
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

}

function parseReminders(value: unknown): Reminder[] | undefined {
  if (value === undefined) return undefined
  try {
    return parseRemindersInput(value)
  } catch {
    throw new CodexProductActionError('product_action_calendar_reminders_invalid')
  }
}
