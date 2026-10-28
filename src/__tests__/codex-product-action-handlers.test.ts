import { planCalendarMutation } from '../shared/calendar/commands'
import { occurrences, type CalEvent } from '../shared/calendar/model'
import { validateCalendarEvent } from '../shared/calendar/validation'
import { calendarRecordToEvent, calendarEventToRecord } from '../main/modules/calendar-engine/calendar-row-codec'
import { dayOf } from '../shared/calendar/tz'
import assert from 'node:assert/strict'
import test from 'node:test'

import { persistableCalendarEventId } from '../shared/calendar-event-identity'
import {
  createProductionProductActionHandlers,
} from '../main/modules/agent-control/codex-runtime/codex-product-action-handlers'
import { CodexProductActionError } from '../main/modules/agent-control/codex-runtime/codex-product-action-requester'
import type { DatabaseManager } from '../main/modules/database'
import { flatDomainStores } from './helpers/flat-domain-stores'

function fakeDb(overrides?: Record<string, unknown>): DatabaseManager {
  const events = new Map<string, CalEvent>()
  const base = {
    getRSSStats: () => ({ totalItems: 3, unreadItems: 1 }),
    getRSSSources: () => [{ id: 'src-1', name: '科技' }],
    getRSSItemsByIds: (ids: string[]) => ids.includes('item-1')
      ? [{ id: 'item-1', source_id: 'src-1', title: '标题', link: 'https://example.com', summary: '摘要' }]
      : [],
    snapshot:()=>({events:[...events.values()],calendars:[{id:'cal-1',accountId:'local',name:'Local',color:'#4488CC',visible:true,primary:true}]}),
    listOccurrences:(start:number,end:number)=>occurrences([...events.values()],dayOf(start*1000,'UTC'),dayOf(end*1000,'UTC')+1,'UTC').filter(o=>o.end>start*1000&&o.start<end*1000),
    mutate:(command:Parameters<typeof planCalendarMutation>[1],versions:Record<string,number>)=>{
      const delta=planCalendarMutation(base.snapshot(),command)
      for(const e of delta.put){if(events.has(e.id))assert.equal(versions[e.id],events.get(e.id)!.revision);events.set(e.id,validateCalendarEvent({...e,revision:(events.get(e.id)?.revision||0)+1}))}
      delta.remove.forEach(id=>events.delete(id))
      return {snapshot:base.snapshot(),undo:{put:[],remove:delta.put.map(e=>e.id)},versions:{},changedIds:delta.put.map(e=>e.id)}
    },
    getCalendarSources:()=>[{id:'cal-1'}],
    createCalendarEvent:(input:Record<string,unknown>)=>{const id='event-created';events.set(id,calendarRecordToEvent({created_at:1,updated_at:1,start_tz:'UTC',...input,id} as never));return id},
    getCalendarEventById:(id:string)=>{const event=events.get(id);return event?calendarEventToRecord(event):null},
    ...overrides,
  }
  return flatDomainStores(base) as unknown as DatabaseManager
}

function handlers(overrides?: {
  db?: DatabaseManager
  rss?: Partial<Parameters<typeof createProductionProductActionHandlers>[0]['rss']>
  renderer?: (payload: { tool: string }) => Promise<Record<string, unknown>>
  targets?: Parameters<typeof createProductionProductActionHandlers>[0]['targets']
  listed?: string[]
}) {
  const rendererCalls: string[] = []
  const listed: string[] = [...(overrides?.listed || [])]
  let revisions:Record<string,number>=Object.fromEntries(listed.map(id=>[id,1]))
  const dispatch = createProductionProductActionHandlers({
    database: overrides?.db || fakeDb(),
    rss: {
      async fetchUpdates() {
        return { success: true, data: { fetched: 2, errors: [] } }
      },
      async addSource() {
        return { ok: true, data: { id: 'src-new' } }
      },
      async analyzeItem() {
        return { ok: true, summary: '分析已启动', status: 'queued' }
      },
      ...overrides?.rss,
    },
    requestRendererToolAction: async (payload) => {
      rendererCalls.push(payload.tool)
      if (overrides?.renderer) return overrides.renderer(payload)
      return { ok: true, summary: payload.tool }
    },
    targets: overrides?.targets,
    sessionId: 'session',
    runId: 'run',
    codexThreadId: 'thread',
    codexTurnId: 'turn',
    codexCallId: 'call',
    readyActionId: 'action',
    actionIdentityDigest: 'digest',
    abortSignal: new AbortController().signal,
    recordListedCalendarEventIds: (ids) => {
      listed.splice(0, listed.length, ...ids)
    },
    listedCalendarEventIds: () => listed,
    recordListedCalendarRevisions: value=>{revisions=value},
    listedCalendarRevisions:()=>revisions,
  }).dispatch
  return { dispatch, rendererCalls, listed }
}

test('calendar create notifies the scheduler hook after durable write', async () => {
  const mutated: string[] = []
  const renderer: string[] = []
  const created = await createProductionProductActionHandlers({
    database: fakeDb(),
    rss: {
      async fetchUpdates() { return { success: true, data: {} } },
      async addSource() { return { ok: true } },
      async analyzeItem() { return { ok: true } },
    },
    requestRendererToolAction: async (payload) => {
      renderer.push(payload.tool)
      return { ok: true }
    },
    onCalendarMutated: (eventId) => { mutated.push(eventId) },
    sessionId: 's',
    runId: 'r',
    codexThreadId: 't',
    codexTurnId: 'u',
    codexCallId: 'c',
    readyActionId: 'a',
    actionIdentityDigest: 'd',
    abortSignal: new AbortController().signal,
  }).dispatch('calendar.createEvent', {
    title: '会',
    startTime: '2026-08-15T13:00:00Z',
    endTime: '2026-08-15T14:00:00Z',
  })
  assert.equal(created.ok, true)
  assert.deepEqual(mutated, [created.eventId])
  assert.deepEqual(renderer, [])
})

test('in-flight RSS fetch is not a completed refresh', async () => {
  const { dispatch } = handlers({
    rss: {
      async fetchUpdates() {
        return { success: true, data: { fetched: 1, running: true } }
      },
    },
  })
  const result = await dispatch('rss.fetchUpdates', {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'rss_fetch_in_progress')
})

test('rss.analyzeItem stays on Main and does not call the renderer bridge', async () => {
  let analyzed = 0
  const { dispatch, rendererCalls } = handlers({
    targets: { rssItemId: 'item-1' },
    rss: {
      async analyzeItem(input) {
        analyzed += 1
        assert.equal(input.itemId, 'item-1')
        assert.equal(input.analysisType, 'copy')
        return { ok: true, summary: '分析已启动', status: 'queued' }
      },
    },
  })
  const result = await dispatch('rss.analyzeItem', { analysisType: 'copy' })
  assert.equal(result.ok, true)
  assert.equal(analyzed, 1)
  assert.deepEqual(rendererCalls, [])
})

test('calendar list uses the shared occurrence reader and records its exact identities', async () => {
  let queried=false
  const event:CalEvent={id:'evt-1',uid:'evt-1@test',calendarId:'cal-1',title:'One',start:Date.parse('2026-08-12T09:00Z'),end:Date.parse('2026-08-12T10:00Z'),allDay:false,timeZone:'UTC',status:'confirmed',transparency:'opaque',createdAt:1,updatedAt:1,revision:1}
  const db=fakeDb({snapshot:()=>({events:[event],calendars:[]}),listOccurrences:()=>{queried=true;return occurrences([event],dayOf(Number(event.start),'UTC'),dayOf(Number(event.start),'UTC')+1,'UTC')}})
  const {dispatch,listed}=handlers({db})
  assert.equal((await dispatch('calendar.listWindow',{start:'2026-08-10',end:'2026-08-16'})).ok,true)
  assert.equal(queried,true);assert.deepEqual(listed,['evt-1'])
})

test('calendar list rejects oversized model windows', async () => {
  const { dispatch } = handlers()
  await assert.rejects(
    () => dispatch('calendar.listWindow', { start: '2026-01-01', end: '2028-01-02' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'codex_calendar_window_span_invalid',
  )
})

test('calendar update injects the typed event id and rejects conflicts', async () => {
  const db = fakeDb()
  db.calendar.createCalendarEvent({
    calendar_id: 'cal-1',
    title: '原',
    start_time: 1,
    end_time: 2,
  })
  const { dispatch } = handlers({
    db,
    targets: { calendarEventId: 'event-created' },
  })
  const updated = await dispatch('calendar.updateEvent', { title: '新标题', expectedRevision: 1 })
  assert.equal(updated.ok, true)
  assert.equal(updated.eventId, 'event-created')
  await assert.rejects(
    () => dispatch('calendar.updateEvent', { id: 'other' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_event_conflict',
  )
})

test('calendar update without a typed target only accepts a unique list receipt', async () => {
  const db = fakeDb()
  db.calendar.createCalendarEvent({
    calendar_id: 'cal-1',
    title: '唯一',
    start_time: 1,
    end_time: 2,
  })
  const { dispatch } = handlers({ db, listed: ['event-created'] })
  const updated = await dispatch('calendar.updateEvent', { title: '改名' })
  assert.equal(updated.ok, true)
  await assert.rejects(
    () => dispatch('calendar.deleteEvent', { id: 'guessed' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_event_not_in_receipt',
  )
})

test('unread synthetic instances cannot borrow a parent write receipt', async () => {
  assert.equal(persistableCalendarEventId('parent#1710000000'),'parent')
  const {dispatch}=handlers({listed:['event-created']})
  await assert.rejects(()=>dispatch('calendar.updateEvent',{id:'event-created#1710000000',title:'No',scope:'this'}),(error:unknown)=>error instanceof CodexProductActionError&&error.code==='product_action_calendar_event_not_in_receipt')
})

test('malformed reminders fail closed instead of wiping the event', async () => {
  const { dispatch } = handlers()
  await assert.rejects(
    () => dispatch('calendar.createEvent', {
      title: '会',
      startTime: '2026-08-15T13:00:00Z',
      endTime: '2026-08-15T14:00:00Z',
      reminders: [{ offsetMinutes: 1.5, method: 'notification' }],
    }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_reminders_invalid',
  )
})

test('calendar create persists reminders and reads them back', async () => {
  const db = fakeDb()
  const { dispatch } = handlers({ db })
  const created = await dispatch('calendar.createEvent', {
    title: '带提醒的会',
    startTime: '2026-08-15T13:00:00Z',
    endTime: '2026-08-15T14:00:00Z',
    reminders: [{ offsetMinutes: -15, method: 'notification' }],
  })
  assert.equal(created.ok, true)
  assert.deepEqual(created.reminders, [{ offsetMinutes: -15, method: 'notification' }])
})
