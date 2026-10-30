import { CalendarLinkTargetSchema, sameCalendarLink, type CalendarEventLink, type CalendarLinkReplacement } from './event-links'
import { toReadyUri, type ReadyRef } from '../ready-ref'
import { occurrences, newId, isRecurring, type CalEvent, type Calendar, type Occurrence } from './model'
import { isoDate, parseIsoDate } from './dates'
import { dayOf, fromWall, toWall } from './tz'
import { expand, parseRRule, stringifyRRule } from './rrule'

export type RecurrenceScope = 'this' | 'following' | 'all'
export type CalendarCommand =
  | { type: 'link'; key: string; target: ReadyRef; purpose?: 'related' | 'meeting-note' }
  | { type: 'unlink'; key: string; linkId: string }
  | { type: 'create'; event: CalEvent }
  | { type: 'update'; key: string; patch: Partial<CalEvent>; scope?: RecurrenceScope }
  | { type: 'delete'; keys: string[]; scope?: RecurrenceScope }
  | { type: 'duplicate'; keys: string[]; calendarId?: string }
export interface CalendarSnapshot { links?: CalendarEventLink[]; events: CalEvent[]; calendars: Calendar[]; prefs?: Record<string, unknown> | null }
export interface CalendarDelta { links?: CalendarLinkReplacement[]; put: CalEvent[]; remove: string[] }
const value = (v: number | string) => typeof v === 'string' ? parseIsoDate(v) : v
const wallStamp=(ms:number,zone:string)=>{const w=toWall(ms,zone);return Date.UTC(w.y,w.m-1,w.d,w.h,w.mi,w.s)}
const fromStamp=(ms:number,zone:string)=>{const d=new Date(ms);return fromWall({y:d.getUTCFullYear(),m:d.getUTCMonth()+1,d:d.getUTCDate(),h:d.getUTCHours(),mi:d.getUTCMinutes(),s:d.getUTCSeconds()},zone)}

/** A whole-series time edit replaces time overrides, while retaining their other content. */
function retimeSeries(parent:CalEvent,origin:number|string,patch:Partial<CalEvent>){
  const oldZone=parent.timeZone||'UTC',zone=patch.timeZone||oldZone,allDay=patch.allDay??parent.allDay
  const oldDay=(v:number|string)=>typeof v==='string'?value(v):dayOf(v,oldZone)
  const baseDay=oldDay(parent.start),originDay=oldDay(origin)
  if(allDay!==parent.allDay&&(patch.start===undefined||patch.end===undefined))throw new Error('切换全天状态需要完整起止时间')
  let start=parent.start
  if(patch.start!==undefined){
    if(allDay)start=isoDate(value(patch.start)-(originDay-baseDay))
    else {const distance=parent.allDay?(originDay-baseDay)*86400000:wallStamp(Number(origin),oldZone)-wallStamp(Number(parent.start),oldZone);start=fromStamp(wallStamp(Number(patch.start),zone)-distance,zone)}
  }
  const map=(v:number|string):number|string=>{
    if(allDay)return isoDate(value(start)+oldDay(v)-baseDay)
    const distance=parent.allDay?(oldDay(v)-baseDay)*86400000:wallStamp(Number(v),oldZone)-wallStamp(Number(parent.start),oldZone)
    return fromStamp(wallStamp(Number(start),zone)+distance,zone)
  }
  const duration=patch.end===undefined?value(parent.end)-value(parent.start):value(patch.end)-value(patch.start??map(origin))
  const end=allDay?isoDate(value(start)+duration):Number(start)+duration
  const event={...parent,...patch,start,end,allDay,timeZone:zone,exdates:'exdates'in patch?patch.exdates:parent.exdates?.map(map),rdates:'rdates'in patch?patch.rdates:parent.rdates?.map(map)}
  const {start:_start,end:_end,rrule:_rule,exdates:_ex,rdates:_rd,id:_id,uid:_uid,revision:_revision,...fields}=patch
  const timing='start'in patch||'end'in patch||'allDay'in patch
  const child=(e:CalEvent):CalEvent=>{
    const originalStart=map(e.originalStart!)
    let childStart=e.start,childEnd=e.end
    if(timing){childStart=originalStart;childEnd=allDay?isoDate(value(childStart)+duration):Number(childStart)+duration}
    else if(e.allDay===parent.allDay){childStart=map(e.start);childEnd=map(e.end)}
    return {...e,...fields,allDay:timing?allDay:e.allDay,originalStart,start:childStart,end:childEnd,rrule:undefined,exdates:undefined,rdates:undefined}
  }
  return {event,child,map}
}
export function splitOccurrenceKey(key: string): [string, string | undefined] {
  const i = key.indexOf('|'); return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)]
}
export function findCalendarOccurrence(events: CalEvent[], key: string, zone = 'UTC'): Occurrence | undefined {
  const [id, original] = splitOccurrenceKey(key), parent = events.find(e => e.id === id)
  if (!parent) return undefined
  const related = events.filter(e => e.id === id || e.recurringEventId === id)
  const override = related.find(e => e.recurringEventId === id && String(e.originalStart) === original)
  const target = override || parent
  const at = original === undefined ? target.start : override?.start ?? (parent.allDay ? original : Number(original))
  const day = typeof at === 'string' ? parseIsoDate(at) : dayOf(at, zone)
  const found = occurrences(related, day - 1, day + 2, zone)
  return original === undefined ? found.find(o => o.event.id === id) : found.find(o => o.key === key)
}

/** Pure command planning, called by Main against its current persisted snapshot. */
export function planCalendarMutation(snapshot: CalendarSnapshot, command: CalendarCommand): CalendarDelta {
  const events = new Map(snapshot.events.map(e => [e.id, e]))
  let links = [...(snapshot.links || [])]
  const puts = new Map<string, CalEvent>(), removed = new Set<string>()
  const writable = (id: string) => {
    const calendar = snapshot.calendars.find(c => c.id === id)
    if (!calendar) throw new Error('日历不存在')
    if (calendar.readOnly || calendar.syncUrl) throw new Error('订阅日历为只读，请先复制到本地日历')
  }
  const put = (event: CalEvent) => { writable(event.calendarId); const next = { ...event, updatedAt: Date.now() }; puts.set(event.id, next); events.set(event.id, next); removed.delete(event.id) }
  const remove = (id: string) => { puts.delete(id); events.delete(id); removed.add(id) }
  const occurrence = (key: string) => {
    const found = findCalendarOccurrence([...events.values()], key)
    if (!found) throw new Error('日程已变化或不存在，请刷新后重试')
    return found
  }
  const detach = (o: Occurrence, calendarId = o.event.calendarId): CalEvent => {
    const { rrule, exdates, rdates, recurringEventId, originalStart, ...rest } = o.event
    const id = newId('event')
    return { ...rest, id, uid: `${id}@ready.local`, revision: 0, calendarId, start: o.allDay ? isoDate(o.startDay) : o.start, end: o.allDay ? isoDate(o.endDay + 1) : o.end }
  }
  if (command.type === 'link' || command.type === 'unlink') {
    const o = occurrence(command.key), parent = events.get(o.seriesId || o.event.id)!
    writable(parent.calendarId)
    const original = splitOccurrenceKey(command.key)[1]
    const originalStart = original === undefined ? undefined : parent.allDay ? original : Number(original)
    if (command.type === 'link') {
      const target = CalendarLinkTargetSchema.parse(command.target)
      const link: CalendarEventLink = { id: newId('link'), eventId: parent.id, originalStart, target, purpose: command.purpose || 'related' }
      if (!links.some(existing => sameCalendarLink(existing, link))) {
        if (link.purpose === 'meeting-note' && links.some(existing => existing.eventId === parent.id && existing.originalStart === originalStart && existing.purpose === 'meeting-note')) throw new Error('该日程已有会议笔记')
        links.push(link)
      }
    } else {
      const existing = links.find(link => link.id === command.linkId)
      if (!existing || existing.eventId !== parent.id || existing.originalStart !== originalStart) throw new Error('关联已变化或不属于当前实例')
      links = links.filter(link => link.id !== command.linkId)
    }
    put(parent)
  } else if (command.type === 'create') {
    if (events.has(command.event.id)) throw new Error('事件标识已存在')
    put(command.event)
  } else if (command.type === 'duplicate') {
    for (const key of command.keys) {const o=occurrence(key),source=snapshot.calendars.find(c=>c.id===o.event.calendarId);const target=command.calendarId||(source?.readOnly?snapshot.calendars.find(c=>c.primary&&!c.readOnly)?.id||snapshot.calendars.find(c=>!c.readOnly)?.id:o.event.calendarId);if(!target)throw new Error('请先创建本地日历');put(detach(o,target))}
  } else {
    for (const key of command.type === 'delete' ? command.keys : [command.key]) {
      const o = occurrence(key), parent = events.get(o.seriesId || o.event.id)!
      writable(parent.calendarId)
      const patch = command.type === 'update' ? command.patch : null
      if (!isRecurring(parent)) {
        if (patch) put({ ...parent, ...patch, id: parent.id, uid: parent.uid })
        else remove(parent.id)
        continue
      }
      const scope = command.scope
      if (!scope) throw new Error('重复日程必须明确选择修改范围')
      const original = splitOccurrenceKey(key)[1] ?? String(parent.start)
      const origin: number | string = parent.allDay ? original : Number(original)
      const related = [...events.values()].filter(e => e.recurringEventId === parent.id)
      if (scope === 'this') {
        if (!patch) links = links.filter(link => link.eventId !== parent.id || link.originalStart !== origin)
        if(patch&&('rrule'in patch||'rdates'in patch||'exdates'in patch))throw new Error('重复规则需要选择整个系列或后续范围')
        if (!patch) {
          put({ ...parent, exdates: [...new Set([...(parent.exdates || []), origin])] })
          related.filter(e => String(e.originalStart) === String(origin)).forEach(e => remove(e.id))
        } else {
          const existing = related.find(e => String(e.originalStart) === String(origin))
          put({ ...detach(o), ...existing, ...patch, id: existing?.id || newId('override'), uid: parent.uid, recurringEventId: parent.id, originalStart: origin, rrule: undefined, exdates: undefined, rdates: undefined })
        }
        continue
      }
      if (scope === 'all') {
        if (!patch) { related.forEach(e => remove(e.id)); remove(parent.id); continue }
        const change=retimeSeries(parent,origin,patch)
        links = links.map(link => link.eventId === parent.id && link.originalStart !== undefined ? {...link, originalStart: isRecurring(change.event) ? change.map(link.originalStart) : undefined} : link)
        if(!isRecurring(change.event)){related.forEach(e=>remove(e.id));change.event.exdates=undefined}
        else related.forEach(e=>put(change.child(e)))
        put({...change.event,id:parent.id,uid:parent.uid})
        continue
      }
      const cutoff = value(origin), rule = parseRRule(parent.rrule || 'FREQ=DAILY;COUNT=1')
      const truncated = stringifyRRule({ ...rule, count: undefined, until: cutoff - (parent.allDay ? 1 : 1000), untilIsDate: parent.allDay })
      if (cutoff <= value(parent.start)) remove(parent.id)
      else put({ ...parent, rrule: parent.rrule ? truncated : undefined, exdates: parent.exdates?.filter(x => value(x) < cutoff), rdates: parent.rdates?.filter(x => value(x) < cutoff) })
      const following = related.filter(e => value(e.originalStart!) >= cutoff)
      following.forEach(e => remove(e.id))
      const movedLinks = links.filter(link => link.eventId === parent.id && link.originalStart !== undefined && value(link.originalStart) >= cutoff)
      links = links.filter(link => !movedLinks.includes(link))
      if (patch) {
        const used = rule.count === undefined ? 0 : expand({ rule: parent.rrule || 'FREQ=DAILY;COUNT=1', dtstart: value(parent.start), allDay: parent.allDay, timeZone: parent.timeZone }, value(parent.start), cutoff, Math.max(20000, rule.count)).length
        const id = newId('event'),duration=value(parent.end)-value(parent.start)
        const base:CalEvent={...parent,id,uid:`${id}@ready.local`,revision:0,start:origin,end:parent.allDay?isoDate(value(origin)+duration):value(origin)+duration,
          rrule:parent.rrule?stringifyRRule({...rule,count:rule.count===undefined?undefined:Math.max(1,rule.count-used)}):undefined,
          exdates:parent.exdates?.filter(x=>value(x)>=cutoff),rdates:parent.rdates?.filter(x=>value(x)>=cutoff),createdAt:Date.now()}
        const change=retimeSeries(base,origin,patch)
        links.push(...movedLinks.map(link => ({...link, eventId: id, originalStart: isRecurring(change.event) ? change.map(link.originalStart!) : undefined})))
        put(change.event)
        if(isRecurring(change.event))for(const child of following)put({...change.child(child),recurringEventId:id,uid:change.event.uid})

      }
    }
  }
  links = links.filter(link => events.has(link.eventId) && (link.originalStart === undefined ||
    findCalendarOccurrence([...events.values()], `${link.eventId}|${link.originalStart}`)))
  const linkEvents = new Set([...(snapshot.links || []), ...links].map(link => link.eventId))
  const replacements = [...linkEvents].flatMap(eventId => {
    const before = (snapshot.links || []).filter(link => link.eventId === eventId), after = links.filter(link => link.eventId === eventId)
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ eventId, links: after }]
  })
  return { put: [...puts.values()], remove: [...removed], ...(replacements.length ? {links: replacements} : {}) }
}

export interface CalendarMutationReceipt { snapshot: CalendarSnapshot; undo: CalendarDelta; versions: Record<string, number>; changedIds: string[] }

export function rebaseCalendarHistory(stack:CalendarMutationReceipt[],result:CalendarMutationReceipt){
  const content=(e:CalEvent|undefined)=>{if(!e)return '';const {revision,updatedAt,...value}=e;return JSON.stringify(value)};
  for(const entry of stack)for(const id of Object.keys(entry.versions)){
    const current=result.snapshot.events.find(e=>e.id===id),expected=entry.snapshot.events.find(e=>e.id===id);
    if(content(current)===content(expected)&&JSON.stringify((result.snapshot.links||[]).filter(l=>l.eventId===id).map(l=>[l.id,l.originalStart,toReadyUri(l.target),l.purpose]))===JSON.stringify((entry.snapshot.links||[]).filter(l=>l.eventId===id).map(l=>[l.id,l.originalStart,toReadyUri(l.target),l.purpose])))entry.versions[id]=current?.revision||0;
  }
}
