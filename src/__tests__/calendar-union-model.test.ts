import test from 'node:test'
import assert from 'node:assert/strict'
import { occurrences, type CalEvent, type Calendar } from '../shared/calendar/model'
import { parseIsoDate } from '../shared/calendar/dates'
import { expand } from '../shared/calendar/rrule'
import { importIcs, exportIcs } from '../shared/calendar/ics'
import { planCalendarMutation } from '../shared/calendar/commands'

const start = Date.parse('2026-10-28T13:00:00Z')
const calendar: Calendar = { id: 'local', accountId: 'local', name: 'Local', color: '#4CA8DF', visible: true }
const event = (patch: Partial<CalEvent> = {}): CalEvent => ({ id: 'event', uid: 'event@test', calendarId: 'local', title: 'Meeting', start, end: start + 3600000, allDay: false, timeZone: 'America/New_York', status: 'confirmed', transparency: 'opaque', createdAt: start, updatedAt: start, revision: 1, ...patch })
const apply = (events: CalEvent[], command: Parameters<typeof planCalendarMutation>[1]) => {
  const delta = planCalendarMutation({ events, calendars: [calendar] }, command)
  return [...events.filter(e => !delta.remove.includes(e.id) && !delta.put.some(p => p.id === e.id)), ...delta.put]
}

test('recurring wall time is stable through DST and subdaily frequencies stay subdaily', () => {
  assert.deepEqual(expand({ rule: 'FREQ=WEEKLY;COUNT=3', dtstart: start, allDay: false, timeZone: 'America/New_York' }, start, start + 21 * 86400000), [start, start + 7 * 86400000 + 3600000, start + 14 * 86400000 + 3600000])
  assert.deepEqual(expand({ rule: 'FREQ=HOURLY;COUNT=3', dtstart: start, allDay: false, timeZone: 'UTC' }, start, start + 3 * 3600000), [start, start + 3600000, start + 7200000])
})

test('window includes overlapping and moved-in occurrences exactly once', () => {
  const parent = event({ rrule: 'FREQ=DAILY;COUNT=2', start: Date.parse('2026-10-28T23:30:00Z'), end: Date.parse('2026-10-29T01:30:00Z'), timeZone: 'UTC' })
  const moved = event({ id: 'override', recurringEventId: 'event', originalStart: parent.start, start: Date.parse('2026-11-03T09:00:00Z'), end: Date.parse('2026-11-03T10:00:00Z') })
  assert.equal(occurrences([parent], parseIsoDate('2026-10-29'), parseIsoDate('2026-10-30'), 'UTC').length, 2)
  const found = occurrences([parent, moved], parseIsoDate('2026-11-03'), parseIsoDate('2026-11-04'), 'UTC')
  assert.equal(found.length, 1)
  assert.equal(found[0].event.id, 'override')
})

test('following edit preserves remaining count and batch instance deletion merges exclusions', () => {
  const parent = event({ timeZone: 'UTC', rrule: 'FREQ=DAILY;COUNT=3' })
  const split = apply([parent], { type: 'update', key: `event|${start + 86400000}`, patch: { title: 'Changed' }, scope: 'following' })
  assert.equal(occurrences(split, parseIsoDate('2026-10-28'), parseIsoDate('2026-12-01'), 'UTC').length, 3)
  const deleted = apply([parent], { type: 'delete', keys: [`event|${start}`, `event|${start + 86400000}`], scope: 'this' })
  assert.equal(occurrences(deleted, parseIsoDate('2026-10-28'), parseIsoDate('2026-11-05'), 'UTC').length, 1)
})

test('ICS round trip preserves timezone, dates, exceptions, attendees and reminders', () => {
  const parent = event({ rrule: 'FREQ=WEEKLY;COUNT=3', rdates: [start + 2 * 86400000], exdates: [start], attendees: [{ email: 'a@example.test', name: 'A; B', rsvp: 'accepted' }], reminders: [{ minutes: 15, method: 'notification' }] })
  const raw = exportIcs([parent])
  const parsed = importIcs(raw, 'local', 'UTC')
  assert.equal(parsed.warnings.length, 0)
  assert.equal(parsed.events[0].timeZone, parent.timeZone)
  assert.deepEqual(parsed.events[0].rdates, parent.rdates)
  assert.deepEqual(parsed.events[0].attendees, parent.attendees)
  assert.deepEqual(parsed.events[0].reminders, parent.reminders)
  const window = [parseIsoDate('2026-10-28'), parseIsoDate('2026-11-20')] as const
  assert.deepEqual(occurrences(parsed.events, ...window, 'UTC').map(x => x.start), occurrences([parent], ...window, 'UTC').map(x => x.start))
})

test('editing read-only subscriptions and ambiguous recurring scope is rejected', () => {
  const snapshot = { events: [event({ rrule: 'FREQ=DAILY' })], calendars: [{ ...calendar, readOnly: true }] }
  assert.throws(() => planCalendarMutation(snapshot, { type: 'update', key: `event|${start}`, patch: { title: 'No' }, scope: 'this' }), /只读|read.only/i)
  assert.throws(() => planCalendarMutation({ ...snapshot, calendars: [calendar] }, { type: 'delete', keys: [`event|${start}`] }), /范围|scope/i)
})

test('embedded VTIMEZONE rules survive import and export across daylight-saving changes', () => {
  const raw = ['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VTIMEZONE','TZID:Custom/Eastern','BEGIN:DAYLIGHT','DTSTART:19700308T020000','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','DTSTART:19701101T020000','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE','BEGIN:VEVENT','UID:custom@test','DTSTART;TZID=Custom/Eastern:20261028T090000','DTEND;TZID=Custom/Eastern:20261028T100000','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:Custom zone','END:VEVENT','END:VCALENDAR'].join('\r\n')
  const imported = importIcs(raw,'local','UTC')
  assert.equal(imported.warnings.length,0)
  const expected = ['2026-10-28T13:00:00.000Z','2026-11-04T14:00:00.000Z','2026-11-11T14:00:00.000Z']
  const times = (events:CalEvent[]) => occurrences(events,parseIsoDate('2026-10-28'),parseIsoDate('2026-11-20'),'UTC').map(o=>new Date(o.start).toISOString())
  assert.deepEqual(times(imported.events),expected)
  const exported = exportIcs(imported.events)
  assert.match(exported,/BEGIN:VTIMEZONE/)
  assert.deepEqual(times(importIcs(exported,'local','UTC').events),expected)
})

test('whole-series all-day conversion preserves exception text and cancelled dates', () => {
  const parent=event({timeZone:'UTC',rrule:'FREQ=DAILY;COUNT=3',exdates:[start+86400000]})
  const child=event({id:'child',title:'Special notes',timeZone:'UTC',recurringEventId:'event',originalStart:start+2*86400000,start:start+2*86400000+3600000,end:start+2*86400000+7200000})
  const changed=apply([parent,child],{type:'update',key:`event|${start}`,scope:'all',patch:{allDay:true,start:'2026-10-28',end:'2026-10-29'}})
  const list=occurrences(changed,parseIsoDate('2026-10-28'),parseIsoDate('2026-11-02'),'UTC')
  assert.equal(list.length,2);assert.ok(list.every(o=>o.allDay));assert.equal(list[1].event.title,'Special notes')
})

test('following text edit on a moved exception keeps the original cadence', () => {
  const parent=event({timeZone:'UTC',rrule:'FREQ=DAILY;COUNT=3'})
  const child=event({id:'child',timeZone:'UTC',recurringEventId:'event',originalStart:start+86400000,start:start+2*86400000+7200000,end:start+2*86400000+10800000})
  const changed=apply([parent,child],{type:'update',key:`event|${start+86400000}`,scope:'following',patch:{title:'Next'}})
  const list=occurrences(changed,parseIsoDate('2026-10-28'),parseIsoDate('2026-11-03'),'UTC')
  assert.deepEqual(list.map(o=>o.start),[start,start+2*86400000,start+2*86400000+7200000])
  assert.ok(list.slice(1).every(o=>o.event.title==='Next'))
})

test('RDATE without RRULE still supports scoped deletion', () => {
  const parent=event({timeZone:'UTC',rdates:[start+2*86400000]})
  const changed=apply([parent],{type:'delete',keys:[`event|${start+2*86400000}`],scope:'this'})
  assert.equal(occurrences(changed,parseIsoDate('2026-10-28'),parseIsoDate('2026-11-03'),'UTC').length,1)
})

test('date-only UNTIL includes the chosen final day and invalid intervals are rejected',()=>{
  assert.equal(expand({rule:'FREQ=DAILY;UNTIL=20261030',dtstart:start,allDay:false,timeZone:'UTC'},start,start+7*86400000).length,3)
  for(const rule of ['FREQ=DAILY;INTERVAL=0','FREQ=DAILY;COUNT=-1','FREQ=WEEKLY;INTERVAL=1.5'])assert.throws(()=>expand({rule,dtstart:start,allDay:false,timeZone:'UTC'},start,start+86400000),/正整数/)
})
