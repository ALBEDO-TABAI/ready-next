import { registerCalendarZone } from '../../../shared/calendar/custom-zone'
import type { CalEvent } from '../../../shared/calendar/model'
import { isoDate, parseIsoDate } from '../../../shared/calendar/dates'
import { dayOf, startOfDayMs, systemTimeZone } from '../../../shared/calendar/tz'
import type { CalendarEvent } from '../database/records'

export type CalendarRow = Record<string, unknown>
const array = <T>(raw: unknown): T[] | undefined => raw == null ? undefined : (typeof raw === 'string' ? JSON.parse(raw) : raw) as T[]
export const originalToSeconds = (v: string | number): number => typeof v === 'string' ? parseIsoDate(v) * 86400 : Math.floor(v / 1000)
export const originalFromSeconds = (v: number, allDay: boolean): string | number => allDay ? isoDate(v / 86400) : v * 1000

export function decodeCalendarRow(row: CalendarRow): CalEvent {
  if(row.time_zone_definition)registerCalendarZone(String(row.time_zone_definition))
  if(row.end_time_zone_definition)registerCalendarZone(String(row.end_time_zone_definition))
  return {
    sourceId: row.source_id?String(row.source_id):undefined, id: String(row.id), uid: String(row.ics_uid || `${row.id}@ready.local`), calendarId: String(row.calendar_id), title: String(row.title),
    description: row.description == null ? undefined : String(row.description), location: row.location == null ? undefined : String(row.location),
    allDay: !!row.all_day, start: row.all_day ? String(row.start_date) : Number(row.start_time) * 1000, end: row.all_day ? String(row.end_date) : Number(row.end_time) * 1000,
    timeZone: row.start_tz ? String(row.start_tz) : systemTimeZone(), endTimeZone: row.end_tz ? String(row.end_tz) : undefined,
    timeZoneDefinition:row.time_zone_definition?String(row.time_zone_definition):undefined,endTimeZoneDefinition:row.end_time_zone_definition?String(row.end_time_zone_definition):undefined,
    rrule: row.recurrence_rule ? String(row.recurrence_rule) : undefined, rdates: array(row.rdates), exdates: array(row.exdates),
    reminders: array<{ offsetMinutes: number; method: 'notification' | 'sound' | 'email' }>(row.reminders)?.map(r => ({ minutes: -r.offsetMinutes, method: r.method })),
    url: row.url ? String(row.url) : undefined, conferenceUrl: row.conference_url ? String(row.conference_url) : undefined, color: row.color ? String(row.color) : undefined,
    status: (row.status || 'confirmed') as CalEvent['status'], transparency: (row.transparency || 'opaque') as CalEvent['transparency'], visibility: (row.visibility || 'default') as CalEvent['visibility'],
    attendees: array(row.attendees), sequence: Number(row.sequence || 0), revision: Number(row.revision || 1),
    createdAt: Number(row.created_at) * 1000, updatedAt: Number(row.updated_at) * 1000,
  }
}
export function encodeCalendarEvent(e: CalEvent): CalendarRow {
  return {
    id:e.id,calendar_id:e.calendarId,title:e.title,description:e.description ?? null,location:e.location ?? null,
    all_day:e.allDay ? 1:0,start_time:e.allDay ? null:Math.floor(Number(e.start)/1000),end_time:e.allDay ? null:Math.floor(Number(e.end)/1000),start_date:e.allDay?e.start:null,end_date:e.allDay?e.end:null,
    start_tz:e.timeZone || null,end_tz:e.endTimeZone || null,ics_uid:e.uid,recurrence_rule:e.rrule || null,
    reminders:e.reminders?.length?JSON.stringify(e.reminders.map(r=>({offsetMinutes:-r.minutes,method:r.method}))):null,
    exdates:e.exdates?.length?JSON.stringify(e.exdates):null,
    rdates:e.rdates?.length?JSON.stringify(e.rdates):null,attendees:e.attendees?.length?JSON.stringify(e.attendees):null,
    time_zone_definition:e.timeZoneDefinition||null,end_time_zone_definition:e.endTimeZoneDefinition||null,
    url:e.url || null,conference_url:e.conferenceUrl || null,color:e.color || null,status:e.status,transparency:e.transparency,visibility:e.visibility || 'default',sequence:e.sequence || 0,
    created_at:Math.floor(e.createdAt/1000),updated_at:Math.floor(e.updatedAt/1000),
  }
}

/** Existing product wire uses seconds; dates are projected, never duplicated in storage. */
export function calendarEventToRecord(e: CalEvent, sourceId: string | null = e.sourceId || null): CalendarEvent {
  const row = encodeCalendarEvent(e)
  return { ...row, start_time: e.allDay ? startOfDayMs(parseIsoDate(String(e.start)),e.timeZone || 'UTC')/1000 : Number(e.start)/1000,
    end_time:e.allDay?startOfDayMs(parseIsoDate(String(e.end)),e.timeZone || 'UTC')/1000:Number(e.end)/1000,
    reminders:e.reminders?.filter(r=>r.method!=='email').map(r=>({offsetMinutes:-r.minutes,method:r.method})) || null,
    source_id:sourceId,revision:e.revision || 1,exdates:e.exdates,attendees:e.attendees,rdates:e.rdates,
  } as unknown as CalendarEvent
}

export function calendarRecordToEvent(row: CalendarEvent): CalEvent {
  const value = row as unknown as CalendarRow
  const tz = row.start_tz || systemTimeZone()
  return decodeCalendarRow({ ...value,
    start_date: value.start_date || (row.all_day ? isoDate(dayOf(row.start_time*1000,tz)) : null),
    end_date: value.end_date || (row.all_day ? isoDate(dayOf(Math.max(row.start_time,row.end_time-1)*1000,tz)+1) : null),
    reminders: row.reminders,
  })
}
