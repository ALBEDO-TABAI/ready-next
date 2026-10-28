import test from 'node:test'
import assert from 'node:assert/strict'
import { importIcs,exportIcs } from '../shared/calendar/ics'
const wrap=(body:string[])=>['BEGIN:VCALENDAR','VERSION:2.0',...body,'END:VCALENDAR'].join('\r\n')
const event=(fields:string[])=>['BEGIN:VEVENT','UID:import@test',...fields,'END:VEVENT']
test('imports UTC event identity, escaped text and dates without millisecond confusion',()=>{
  const result=importIcs(wrap(event(['DTSTART:20261028T090000Z','DTEND:20261028T100000Z','SUMMARY:Hello\\, world','DESCRIPTION:Line 1\\nLine 2','LOCATION:Room A'])),'local','UTC')
  assert.equal(result.warnings.length,0)
  assert.equal(result.events[0].uid,'import@test');assert.equal(result.events[0].title,'Hello, world');assert.equal(result.events[0].start,Date.parse('2026-10-28T09:00Z'));assert.equal(result.events[0].description,'Line 1\nLine 2')
})
test('all-day end is exclusive and omitted ends use the next date',()=>{
  const result=importIcs(wrap(event(['DTSTART;VALUE=DATE:20261028','SUMMARY:Day'])),'local','Asia/Tokyo')
  assert.equal(result.events[0].start,'2026-10-28');assert.equal(result.events[0].end,'2026-10-29');assert.equal(result.events[0].allDay,true)
})
test('IANA TZID and optional end time are resolved deterministically',()=>{
  const result=importIcs(wrap(event(['DTSTART;TZID=America/New_York:20261104T090000','SUMMARY:New York'])),'local','UTC')
  assert.equal(result.events[0].start,Date.parse('2026-11-04T14:00Z'));assert.equal(result.events[0].end,result.events[0].start)
})
test('untitled events remain valid, missing starts or identities are explicit warnings',()=>{
  assert.equal(importIcs(wrap(event(['DTSTART:20261028T090000Z'])),'local','UTC').events[0].title,'')
  assert.equal(importIcs(wrap(event(['SUMMARY:Broken'])),'local','UTC').warnings.length,1)
  assert.equal(importIcs(wrap(['BEGIN:VEVENT','DTSTART:20261028T090000Z','END:VEVENT']),'local','UTC').warnings.length,1)
})
test('structurally incomplete feeds are rejected and empty complete feeds are valid',()=>{
  for(const raw of ['', 'BEGIN:VEVENT\r\nEND:VEVENT', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR'])assert.throws(()=>importIcs(raw,'local','UTC'))
  assert.equal(importIcs(wrap([]),'local','UTC').events.length,0)
})
test('CSS calendar and event colors normalize to the stored color contract',()=>{
  const result=importIcs(wrap(['COLOR:blue',...event(['DTSTART:20261028T090000Z','COLOR:red'])]),'local','UTC')
  assert.equal(result.calendarColor,'#0000ff');assert.equal(result.events[0].color,'#ff0000');assert.match(exportIcs(result.events),/COLOR:#ff0000/)
})
