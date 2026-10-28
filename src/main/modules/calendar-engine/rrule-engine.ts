import type { CalendarEvent } from '../database/records'
import { occurrences, isRecurring, type CalEvent } from '../../../shared/calendar/model'
import { dayOf, systemTimeZone } from '../../../shared/calendar/tz'
import { isoDate } from '../../../shared/calendar/dates'
import { calendarEventToRecord, calendarRecordToEvent, originalFromSeconds, originalToSeconds } from './calendar-row-codec'

export interface EventInstance extends Omit<CalendarEvent,'id'> {
  id:string
  syntheticId:string
  instanceOf:string
  occurrenceStart:number
  overrideKind:'single'|'cancelled'|null
}
export interface EventOverride {
  parentEventId:string
  occurrenceStart:number
  kind:'single'|'cancelled'
  patch:Partial<CalendarEvent>|null
}

/** Product-wire projection over the shared civil-time engine; no second recurrence implementation. */
export function expandRecurringEvent(event:CalendarEvent,windowStartUnix:number,windowEndUnix:number,overrides:ReadonlyArray<EventOverride>):EventInstance[]{
  const zone=event.start_tz||systemTimeZone(),parent=calendarRecordToEvent(event)
  const list:CalEvent[]=[parent]
  for(const override of overrides){
    if(override.parentEventId!==event.id)continue
    const original=originalFromSeconds(override.occurrenceStart,parent.allDay)
    if(override.kind==='cancelled'){parent.exdates=[...(parent.exdates||[]),original];continue}
    const duration=event.end_time-event.start_time
    const child=calendarRecordToEvent({...event,start_time:override.occurrenceStart,end_time:override.occurrenceStart+duration,...override.patch})
    list.push({...child,id:`${event.id}#${override.occurrenceStart}`,rrule:undefined,exdates:undefined,rdates:undefined,recurringEventId:event.id,originalStart:original})
  }
  return occurrences(list,dayOf(windowStartUnix*1000,zone)-1,dayOf(windowEndUnix*1000,zone)+2,zone)
    .filter(o=>o.end>windowStartUnix*1000&&o.start<windowEndUnix*1000)
    .map(o=>{
      const original=originalToSeconds(o.event.originalStart??(o.allDay?isoDate(o.startDay):o.start))
      const record=calendarEventToRecord(o.event)
      return {...record,syntheticId:isRecurring(parent)?`${parent.id}#${original}`:parent.id,id:isRecurring(parent)?`${parent.id}#${original}`:parent.id,instanceOf:parent.id,occurrenceStart:original,overrideKind:o.event.recurringEventId?'single':null,start_time:o.start/1000,end_time:o.end/1000,recurrence_rule:event.recurrence_rule}
    })
}
export function expandEventList(events:ReadonlyArray<CalendarEvent>,start:number,end:number,overridesByParent:ReadonlyMap<string,EventOverride[]>=new Map()):EventInstance[]{
  return events.flatMap(event=>expandRecurringEvent(event,start,end,overridesByParent.get(event.id)||[])).sort((a,b)=>a.start_time-b.start_time)
}
